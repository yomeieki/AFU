#!/usr/bin/env bash
# 生产部署脚本（在服务器上执行）
# 前置：git clone 仓库到 REPO_DIR，apps/server/.env 已配置
# 用法：bash /www/food-shop/scripts/deploy.sh
# 首次部署：bash /www/food-shop/scripts/deploy.sh --seed

set -euo pipefail

# [2/9] 会 git reset --hard 覆盖本仓库，包括这个脚本自己。bash 是按字节偏移边读边
# 执行的，运行中被替换会导致执行错乱（且症状诡异、极难排查）。先把自己复制到临时
# 文件再接管执行。
if [[ "${DEPLOY_SELF_COPY:-}" != "1" ]]; then
  _self="$(mktemp)"
  cp "$0" "${_self}"
  chmod +x "${_self}"
  DEPLOY_SELF_COPY=1 exec "${_self}" "$@"
fi
trap 'rm -f "$0"' EXIT

SEED="${1:-}"
REPO_DIR="/www/food-shop"
SERVER_DIR="${REPO_DIR}/apps/server"
ADMIN_DIST_DIR="/www/food-shop-admin/dist"
BACKUP_DIR="/www/backups/pre-deploy"
LOG_DIR="/var/log/pm2"

echo "=========================================="
echo " food-shop 部署脚本"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# ── [1/9] 预检 ───────────────────────────────────────────────────────────────
echo "[1/9] 预检..."
for cmd in node npm pm2 nginx git mysqldump; do
  command -v "$cmd" >/dev/null || { echo "ERROR: $cmd not found"; exit 1; }
done
node -e "process.exit(+process.versions.node.split('.')[0] < 18 ? 1 : 0)" \
  || { echo "ERROR: Node.js >= 18 required, got $(node -v)"; exit 1; }
echo "  node: $(node -v)  npm: $(npm -v)  pm2: $(pm2 -v)"
[[ -f "${SERVER_DIR}/.env" ]] || { echo "ERROR: ${SERVER_DIR}/.env not found"; exit 1; }
echo "  .env: ok"

# 生产环境图片必须走 COS（config.ts 启动时强制校验）。在这里提前拦截，
# 避免走到 [8/9] 重启后才因缺配置崩溃、导致服务已经停掉。
env_val() { grep -E "^$1=" "${SERVER_DIR}/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'"'"'"; }
if [[ "$(env_val NODE_ENV)" == "production" ]]; then
  MISSING=""
  for k in COS_SECRET_ID COS_SECRET_KEY COS_BUCKET COS_REGION; do
    [[ -n "$(env_val "$k")" ]] || MISSING="${MISSING} ${k}"
  done
  if [[ -n "${MISSING}" ]]; then
    echo "ERROR: 生产环境缺少 COS 配置：${MISSING# }"
    echo "       新版后端的图片上传只走对象存储，缺配置会拒绝启动。"
    echo "       请先在 ${SERVER_DIR}/.env 补齐（子账号密钥，仅授权图片桶）后重试部署。"
    exit 1
  fi
  echo "  COS: ok"
fi

# ── [2/9] 拉取最新代码 ────────────────────────────────────────────────────────
# 正常路径就是直接 git fetch，不需要任何额外开关。
#
# SKIP_FETCH=1 是应急通道，只在 GitHub 从本机连不上时才用（国内机器偶发：
# GnuTLS recv error / 443 超时）。它跳过 fetch，直接用本地已有的 origin/main——
# 所以必须先从一台能连 GitHub 的机器把 ref 推过来，否则部署的是旧代码：
#   git push ubuntu@<服务器>:/www/food-shop <sha>:refs/remotes/origin/main
#   SKIP_FETCH=1 bash scripts/deploy.sh
# 用完即弃：下一次正常部署不要再带这个变量，让 fetch 把 origin/main 拉回真值。
echo "[2/9] 拉取最新代码..."
cd "${REPO_DIR}"
if [[ "${SKIP_FETCH:-0}" == "1" ]]; then
  echo "  SKIP_FETCH=1，跳过 git fetch，使用本地 origin/main"
else
  git fetch origin
fi
BEFORE=$(git rev-parse --short HEAD)
git reset --hard origin/main
AFTER=$(git rev-parse --short HEAD)
echo "  ${BEFORE} → ${AFTER}"
if [[ "${BEFORE}" == "${AFTER}" ]]; then
  echo "  （代码无变化）"
fi

# ── [3/9] 安装依赖（monorepo 根目录，构建需 devDependencies）──────────────────
echo "[3/9] 安装依赖..."
npm install --no-fund --no-audit

# ── [4/9] 迁移前备份数据库 ────────────────────────────────────────────────────
echo "[4/9] 迁移前备份数据库..."
mkdir -p "${BACKUP_DIR}"
# 从 .env 解析 DATABASE_URL（mysql://user:pass@host:port/db）
DB_URL=$(grep -E '^DATABASE_URL=' "${SERVER_DIR}/.env" | cut -d= -f2- | tr -d '"')
DB_USER=$(echo "$DB_URL" | sed -E 's|mysql://([^:]+):.*|\1|')
DB_PASS=$(echo "$DB_URL" | sed -E 's|mysql://[^:]+:([^@]+)@.*|\1|')
DB_HOST=$(echo "$DB_URL" | sed -E 's|.*@([^:/]+).*|\1|')
DB_PORT=$(echo "$DB_URL" | sed -E 's|.*@[^:]+:([0-9]+)/.*|\1|')
DB_NAME=$(echo "$DB_URL" | sed -E 's|.*/([^?]+).*|\1|')
PRE_BACKUP="${BACKUP_DIR}/pre_deploy_$(date +%Y%m%d_%H%M%S).sql.gz"
mysqldump -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" \
  --single-transaction --no-tablespaces "${DB_NAME}" | gzip > "${PRE_BACKUP}"
echo "  备份完成：${PRE_BACKUP} ($(du -sh "${PRE_BACKUP}" | cut -f1))"
# 只保留最近 10 份迁移前备份
ls -t "${BACKUP_DIR}"/pre_deploy_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f

# ── [5/9] 构建后端（先 generate 再 build，顺序不可反）─────────────────────────
echo "[5/9] 构建后端..."
cd "${SERVER_DIR}"
npx prisma generate
npm run build
echo "  dist/app.js: $(du -sh dist/app.js | cut -f1)"

# ── [6/9] 数据库迁移 ─────────────────────────────────────────────────────────
echo "[6/9] 执行数据库迁移..."
if ! npm run db:migrate:deploy; then
  echo "=========================================="
  echo " ERROR: 迁移失败！服务未重启，数据库可用备份恢复："
  echo "   gunzip < ${PRE_BACKUP} | mysql -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p ${DB_NAME}"
  echo "=========================================="
  exit 1
fi
echo "  迁移完成"
if [[ "${SEED}" == "--seed" ]]; then
  echo "[6b] 导入初始数据（seed）..."
  npm run db:seed
fi

# ── [7/9] 构建并发布管理后台 ──────────────────────────────────────────────────
echo "[7/9] 构建管理后台..."
cd "${REPO_DIR}"
npm run build:admin
mkdir -p "${ADMIN_DIST_DIR}"
rsync -a --delete "${REPO_DIR}/apps/admin/dist/" "${ADMIN_DIST_DIR}/"
echo "  已发布到 ${ADMIN_DIST_DIR}"

# ── [8/9] 重启后端（PM2）────────────────────────────────────────────────────
echo "[8/9] 重启后端服务（PM2）..."
mkdir -p "${LOG_DIR}"
cd "${SERVER_DIR}"
if pm2 describe food-shop-server >/dev/null 2>&1; then
  pm2 reload food-shop-server --update-env
else
  pm2 start ecosystem.config.js --env production
  pm2 save
fi
sleep 2
pm2 show food-shop-server | grep -E "status|restart|uptime" || true

# ── [8b] 日志轮转（幂等）：防 /var/log/pm2 撑爆磁盘 ───────────────────────────
if ! pm2 ls 2>/dev/null | grep -q pm2-logrotate; then
  echo "  安装 pm2-logrotate..."
  pm2 install pm2-logrotate >/dev/null
fi
pm2 set pm2-logrotate:max_size 20M >/dev/null
pm2 set pm2-logrotate:retain 14 >/dev/null
pm2 set pm2-logrotate:compress true >/dev/null
pm2 set pm2-logrotate:rotateInterval '0 0 * * *' >/dev/null
echo "  pm2-logrotate: 20M × 14 份，每日 0 点轮转"

# ── [9/9] 重载 Nginx + 健康检查 ──────────────────────────────────────────────
echo "[9/9] 重载 Nginx..."
# 以普通用户跑 nginx -t 读不到 /etc/letsencrypt 下的证书（Permission denied），
# 会静默失败。原先无论成败都打印 "Nginx reloaded"，等于骗人。
NGINX="nginx"
if [[ "${EUID}" -ne 0 ]]; then
  if sudo -n true 2>/dev/null; then
    NGINX="sudo nginx"
  else
    NGINX=""
    echo "  WARN: 非 root 且无免密 sudo，跳过 nginx 重载"
    echo "        如本次改了 nginx 配置，请手动执行：sudo nginx -t && sudo nginx -s reload"
  fi
fi
if [[ -n "${NGINX}" ]]; then
  if ${NGINX} -t; then
    ${NGINX} -s reload
    echo "  Nginx: 已重载"
  else
    echo "  ERROR: nginx 配置检查未通过，未重载。"
    echo "         后端已是新版本，但 nginx 仍在用旧配置——请立即排查上面的报错。"
    exit 1
  fi
fi

APP_PORT=$(grep -E '^PORT=' "${SERVER_DIR}/.env" | cut -d= -f2- | tr -d '"' || true)
APP_PORT="${APP_PORT:-3000}"
echo ""
echo "健康检查（:${APP_PORT}）..."
sleep 1
if curl -sf "http://127.0.0.1:${APP_PORT}/health" >/dev/null; then
  echo "  API: ok"
else
  echo "  ERROR: 健康检查失败！排查：pm2 logs food-shop-server"
  exit 1
fi

echo ""
echo "=========================================="
echo " 部署完成 $(date '+%Y-%m-%d %H:%M:%S')  版本：${AFTER}"
echo " 后端日志：pm2 logs food-shop-server"
echo " 回滚代码：cd ${REPO_DIR} && git reset --hard ${BEFORE} && bash scripts/deploy.sh"
echo " 恢复数据库：gunzip < ${PRE_BACKUP} | mysql -u ${DB_USER} -p ${DB_NAME}"
echo "=========================================="
