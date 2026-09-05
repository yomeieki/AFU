#!/usr/bin/env bash
# 每日备份：MySQL 数据库 + uploads 图片目录 → 本地持久目录 + 腾讯云 COS
# 用法：bash scripts/backup.sh
#
# 数据库密码与告警 webhook 会自动从 apps/server/.env 读取（ENV_FILE 可覆盖路径），
# 因此 crontab 里不需要出现任何密钥，只写非敏感的 COS 目标即可：
#   0 2 * * * COS_BUCKET=xxx COS_REGION=ap-shanghai COS_BACKUP_PATH=food-shop /www/food-shop/scripts/backup.sh >> /var/log/food-shop-backup.log 2>&1
#
# 注意：COS_BUCKET 必须是**私有**桶，切勿指向存放商品图片的公有读桶。

set -euo pipefail

# coscli 装在 /usr/local/bin，cron 默认 PATH 不含该路径，需显式设置
PATH=/usr/local/bin:/usr/bin:/bin

# ── 配置（环境变量可覆盖）────────────────────────────────────────────────────
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-foodshop_user}"
DB_PASS="${DB_PASS:-}"
DB_NAME="${DB_NAME:-food_shop}"

UPLOADS_DIR="${UPLOADS_DIR:-/www/food-shop/apps/server/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/www/backups/daily}"   # 持久目录（勿用 /tmp，重启即失）
LOCAL_KEEP_DAYS="${LOCAL_KEEP_DAYS:-7}"

COS_BUCKET="${COS_BUCKET:-}"
COS_REGION="${COS_REGION:-ap-guangzhou}"
# 桶内前缀：多个项目共用同一备份桶时用它隔离
COS_BACKUP_PATH="${COS_BACKUP_PATH:-backups}"

# 告警通道（都可选）：失败告警 + 完成摘要
#   ALERT_WEBHOOK      企微群机器人
#   ALERT_PUSHPLUS     PushPlus token（一对一推给本人，不进店员群）
ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
ALERT_PUSHPLUS="${ALERT_PUSHPLUS:-}"

# ── 敏感值从 .env 兜底读取，避免写进 crontab ────────────────────────────────
ENV_FILE="${ENV_FILE:-/www/food-shop/apps/server/.env}"
env_get() {  # env_get KEY —— 取值并去掉引号；文件不存在或键缺失则返回空
  [[ -f "${ENV_FILE}" ]] || return 0
  # || true：pipefail 下 grep 未命中会返回 1，不能让它中断脚本
  grep -E "^$1=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' || true
}
if [[ -z "${DB_PASS}" ]]; then
  # 从 DATABASE_URL 解析：mysql://user:pass@host:port/db
  DB_URL="$(env_get DATABASE_URL)"
  if [[ -n "${DB_URL}" ]]; then
    DB_PASS="$(sed -E 's|mysql://[^:]+:([^@]+)@.*|\1|' <<< "${DB_URL}")"
    # 用户名未被显式覆盖时也一并取自 DATABASE_URL（|| true：set -e 下条件为假不算失败）
    [[ "${DB_USER}" == "foodshop_user" ]] && DB_USER="$(sed -E 's|mysql://([^:]+):.*|\1|' <<< "${DB_URL}")" || true
  fi
fi
if [[ -z "${ALERT_WEBHOOK}" ]]; then
  ALERT_WEBHOOK="$(env_get SYSTEM_ALERT_WECOM_WEBHOOK)"
  [[ -n "${ALERT_WEBHOOK}" ]] || ALERT_WEBHOOK="$(env_get ORDER_NOTIFY_WECOM_WEBHOOK)"
fi
if [[ -z "${ALERT_PUSHPLUS}" ]]; then
  ALERT_PUSHPLUS="$(env_get SYSTEM_ALERT_PUSHPLUS_TOKEN)"
  [[ -n "${ALERT_PUSHPLUS}" ]] || ALERT_PUSHPLUS="$(env_get ORDER_NOTIFY_PUSHPLUS_TOKEN)"
fi

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
mkdir -p "${BACKUP_DIR}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

alert() {
  local text="$1"
  # JSON 字符串里不能出现裸换行，也不能出现未转义的双引号——
  # 完成摘要是多行的，不转义会被两边的接口直接判为非法 JSON 丢弃。
  local safe="${text//\\/\\\\}"
  safe="${safe//\"/\\\"}"
  safe="${safe//$'\n'/\\n}"
  if [[ -n "${ALERT_WEBHOOK}" ]]; then
    local payload
    payload=$(printf '{"msgtype":"text","text":{"content":"【阿福凉菜-备份】%s\\n%s"}}' "$(hostname)" "${safe}")
    curl -s -m 10 -H 'Content-Type: application/json' -d "${payload}" "${ALERT_WEBHOOK}" >/dev/null || true
  fi
  if [[ -n "${ALERT_PUSHPLUS}" ]]; then
    # 不传 topic：备份结果只推给账号本人，不打扰店员群
    local pp
    pp=$(printf '{"token":"%s","title":"【阿福凉菜-备份】%s","content":"%s","template":"txt"}' \
      "${ALERT_PUSHPLUS}" "$(hostname)" "${safe}")
    curl -s -m 10 -H 'Content-Type: application/json' -d "${pp}" https://www.pushplus.plus/send >/dev/null || true
  fi
}

CURRENT_STEP="init"
trap 'log "ERROR at step [${CURRENT_STEP}] line ${LINENO}"; alert "❌ 备份失败：步骤 ${CURRENT_STEP}（行 ${LINENO}），请查看 /var/log/food-shop-backup.log"' ERR

# ── 1. 数据库备份 ───────────────────────────────────────────────────────────
CURRENT_STEP="mysqldump"
DB_FILE="${BACKUP_DIR}/food_shop_${TIMESTAMP}.sql.gz"
log "Dumping database → ${DB_FILE}"
# --no-tablespaces：MySQL 8 下普通用户无 PROCESS 权限，不加会报错刷屏
mysqldump \
  -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" \
  --single-transaction --routines --triggers --no-tablespaces \
  "${DB_NAME}" | gzip > "${DB_FILE}"
log "DB dump complete ($(du -sh "${DB_FILE}" | cut -f1))"

# ── 2. uploads 图片备份（存量本地图片；新图已在 COS，迁移完成后此步可移除）────
CURRENT_STEP="uploads-tar"
UPLOADS_FILE=""
if [[ -d "${UPLOADS_DIR}" ]]; then
  UPLOADS_FILE="${BACKUP_DIR}/uploads_${TIMESTAMP}.tar.gz"
  tar -czf "${UPLOADS_FILE}" -C "$(dirname "${UPLOADS_DIR}")" "$(basename "${UPLOADS_DIR}")"
  log "Uploads archive complete ($(du -sh "${UPLOADS_FILE}" | cut -f1))"
else
  log "WARN: uploads dir not found (${UPLOADS_DIR}), skipping"
fi

# ── 3. 上传到 COS（失败不删本地；本地由保留策略清理）─────────────────────────
# coscli 安装：https://cloud.tencent.com/document/product/436/63143
CURRENT_STEP="cos-upload"
COS_RESULT="skip"
if [[ -n "${COS_BUCKET}" ]]; then
  # COS_BUCKET 已设置，必须成功上传
  if ! command -v coscli &>/dev/null; then
    log "ERROR: COS_BUCKET is set but coscli not found in PATH"
    alert "❌ 异地备份未执行：coscli 未在系统 PATH 中找到。请安装 coscli 或检查 PATH 配置。"
    exit 1
  fi
  UPLOAD_OK=true
  COS_RESULT="ok"
  for f in "${DB_FILE}" ${UPLOADS_FILE:+"${UPLOADS_FILE}"}; do
    DEST="cos://${COS_BUCKET}/${COS_BACKUP_PATH}/$(basename "$f")"
    if coscli cp "$f" "${DEST}" -e "cos.${COS_REGION}.myqcloud.com"; then
      log "Uploaded ${DEST}"
    else
      UPLOAD_OK=false
      COS_RESULT="failed"
      log "ERROR: upload failed for $f (本地副本已保留：$f)"
    fi
  done
  if ! $UPLOAD_OK; then
    log "WARN: 部分上传失败，请检查 coscli 配置"
    alert "⚠️ COS 上传失败（本地副本已保留于 ${BACKUP_DIR}），请检查 coscli 配置"
  fi
else
  log "INFO: COS_BUCKET not set, 仅保留本地备份"
fi

# ── 4. 本地保留策略：清理超过 N 天的备份 ─────────────────────────────────────
CURRENT_STEP="retention"
find "${BACKUP_DIR}" -name '*.gz' -mtime "+${LOCAL_KEEP_DAYS}" -delete
log "Local retention: kept last ${LOCAL_KEEP_DAYS} days ($(ls "${BACKUP_DIR}" | wc -l | tr -d ' ') files)"

# COS 端保留策略：请在 COS 控制台给 bucket 配置「生命周期规则」（如 30 天后删除
# backups/ 前缀对象），比脚本删除可靠且不依赖本机时钟/权限。

LOCAL_COUNT=$(ls "${BACKUP_DIR}" | wc -l | tr -d ' ')
log "Backup complete"
alert "✅ 备份完成 ${TIMESTAMP}
DB：$(du -sh "${DB_FILE}" | cut -f1)　uploads：${UPLOADS_FILE:+$(du -sh "${UPLOADS_FILE}" | cut -f1)}${UPLOADS_FILE:-无}
COS 上传：${COS_RESULT}　本地保留：${LOCAL_COUNT} 个文件（${LOCAL_KEEP_DAYS} 天）"
