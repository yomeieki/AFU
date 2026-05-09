#!/usr/bin/env bash
# MySQL 数据库备份脚本，备份文件上传至腾讯云 COS
# 用法：bash scripts/backup.sh
# 建议通过 crontab 每日凌晨执行：
#   0 2 * * * /www/food-shop/scripts/backup.sh >> /var/log/food-shop-backup.log 2>&1

set -euo pipefail

# ── 配置（从环境变量读取，确保 .env 已加载或变量已导出）──────────────────────
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-foodshop_user}"
DB_PASS="${DB_PASS:-}"
DB_NAME="${DB_NAME:-food_shop}"

COS_BUCKET="${COS_BUCKET:-}"
COS_REGION="${COS_REGION:-ap-guangzhou}"
COS_BACKUP_PATH="backups/mysql"

# ── 执行备份 ────────────────────────────────────────────────────────────────
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="/tmp/food_shop_${TIMESTAMP}.sql.gz"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting backup → ${BACKUP_FILE}"

mysqldump \
  -h "${DB_HOST}" \
  -P "${DB_PORT}" \
  -u "${DB_USER}" \
  -p"${DB_PASS}" \
  --single-transaction \
  --routines \
  --triggers \
  "${DB_NAME}" | gzip > "${BACKUP_FILE}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Dump complete ($(du -sh "${BACKUP_FILE}" | cut -f1))"

# ── 上传到 COS（需已安装 coscli）────────────────────────────────────────────
# 安装：https://cloud.tencent.com/document/product/436/63143
if command -v coscli &>/dev/null && [[ -n "${COS_BUCKET}" ]]; then
  DEST="cos://${COS_BUCKET}/${COS_BACKUP_PATH}/food_shop_${TIMESTAMP}.sql.gz"
  coscli cp "${BACKUP_FILE}" "${DEST}" --region "${COS_REGION}"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Uploaded to ${DEST}"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: coscli not found or COS_BUCKET not set, skipping upload"
fi

# ── 清理本地临时文件 ────────────────────────────────────────────────────────
rm -f "${BACKUP_FILE}"

# ── 保留 COS 上最近 30 天的备份（可选，需要 coscli 支持） ──────────────────
# coscli rm "cos://${COS_BUCKET}/${COS_BACKUP_PATH}/" \
#   --recursive --include "food_shop_$(date -d '30 days ago' +%Y%m%d).*"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup complete"
