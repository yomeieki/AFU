#!/usr/bin/env bash
# 每日备份：MySQL 数据库 + uploads 图片目录 → 本地持久目录 + 腾讯云 COS
# 用法：bash scripts/backup.sh
# crontab 每日凌晨执行：
#   0 2 * * * /www/food-shop/scripts/backup.sh >> /var/log/food-shop-backup.log 2>&1

set -euo pipefail

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
COS_BACKUP_PATH="backups"

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
mkdir -p "${BACKUP_DIR}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ── 1. 数据库备份 ───────────────────────────────────────────────────────────
DB_FILE="${BACKUP_DIR}/food_shop_${TIMESTAMP}.sql.gz"
log "Dumping database → ${DB_FILE}"
mysqldump \
  -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" \
  --single-transaction --routines --triggers \
  "${DB_NAME}" | gzip > "${DB_FILE}"
log "DB dump complete ($(du -sh "${DB_FILE}" | cut -f1))"

# ── 2. uploads 图片备份（商品/Banner 图，本地盘存储时必须一起备）──────────────
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
if command -v coscli &>/dev/null && [[ -n "${COS_BUCKET}" ]]; then
  UPLOAD_OK=true
  for f in "${DB_FILE}" ${UPLOADS_FILE:+"${UPLOADS_FILE}"}; do
    DEST="cos://${COS_BUCKET}/${COS_BACKUP_PATH}/$(basename "$f")"
    if coscli cp "$f" "${DEST}" --region "${COS_REGION}"; then
      log "Uploaded ${DEST}"
    else
      UPLOAD_OK=false
      log "ERROR: upload failed for $f (本地副本已保留：$f)"
    fi
  done
  $UPLOAD_OK || log "WARN: 部分上传失败，请检查 coscli 配置"
else
  log "WARN: coscli not found or COS_BUCKET not set, 仅保留本地备份"
fi

# ── 4. 本地保留策略：清理超过 N 天的备份 ─────────────────────────────────────
find "${BACKUP_DIR}" -name '*.gz' -mtime "+${LOCAL_KEEP_DAYS}" -delete
log "Local retention: kept last ${LOCAL_KEEP_DAYS} days ($(ls "${BACKUP_DIR}" | wc -l | tr -d ' ') files)"

# COS 端保留策略：请在 COS 控制台给 bucket 配置「生命周期规则」（如 30 天后删除
# backups/ 前缀对象），比脚本删除可靠且不依赖本机时钟/权限。

log "Backup complete"
