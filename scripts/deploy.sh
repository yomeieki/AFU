#!/usr/bin/env bash
# 生产部署脚本（在服务器上执行）
# 用法：bash scripts/deploy.sh
# 首次部署：bash scripts/deploy.sh --seed

set -euo pipefail

SEED="${1:-}"
SERVER_DIR="/www/food-shop-server"
ADMIN_DIR="/www/food-shop-admin/dist"
LOG_DIR="/var/log/pm2"

echo "=========================================="
echo " food-shop 部署脚本"
echo " $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# ── 预检 ─────────────────────────────────────────────────────────────────────
echo "[1/7] 预检..."

command -v node   >/dev/null || { echo "ERROR: node not found"; exit 1; }
command -v npm    >/dev/null || { echo "ERROR: npm not found"; exit 1; }
command -v pm2    >/dev/null || { echo "ERROR: pm2 not found (npm install -g pm2)"; exit 1; }
command -v nginx  >/dev/null || { echo "ERROR: nginx not found"; exit 1; }

NODE_VER=$(node -e "process.exit(+process.versions.node.split('.')[0] < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "WARN: Node.js >= 18 required")
echo "  node: $(node -v)  npm: $(npm -v)  pm2: $(pm2 -v)"

[[ -f "${SERVER_DIR}/.env" ]] || { echo "ERROR: ${SERVER_DIR}/.env not found"; exit 1; }
echo "  .env: ok"

# ── 安装依赖 ──────────────────────────────────────────────────────────────────
echo "[2/7] 安装后端依赖..."
cd "${SERVER_DIR}"
npm install --omit=dev

# ── 编译 TypeScript ───────────────────────────────────────────────────────────
echo "[3/7] 编译 TypeScript..."
npm run build
echo "  dist/app.js: $(du -sh dist/app.js 2>/dev/null | cut -f1)"

# ── 数据库迁移 ────────────────────────────────────────────────────────────────
echo "[4/7] 执行数据库迁移..."
npm run db:migrate:deploy
echo "  迁移完成"

# ── 初始数据（首次部署时加 --seed 参数）──────────────────────────────────────
if [[ "${SEED}" == "--seed" ]]; then
  echo "[4b] 导入初始数据（seed）..."
  npm run db:seed
fi

# ── 生成 Prisma Client ────────────────────────────────────────────────────────
echo "[5/7] 生成 Prisma Client..."
npx prisma generate

# ── 重启 / 启动后端服务 ───────────────────────────────────────────────────────
echo "[6/7] 重启后端服务（PM2）..."
mkdir -p "${LOG_DIR}"
if pm2 describe food-shop-server >/dev/null 2>&1; then
  pm2 reload food-shop-server --update-env
else
  pm2 start ecosystem.config.js --env production
  pm2 save
fi
sleep 2
pm2 show food-shop-server | grep -E "status|restart|uptime"

# ── 重载 Nginx ────────────────────────────────────────────────────────────────
echo "[7/7] 重载 Nginx..."
nginx -t && nginx -s reload
echo "  Nginx reloaded"

# ── 健康检查 ──────────────────────────────────────────────────────────────────
echo ""
echo "健康检查..."
sleep 1
curl -sf http://127.0.0.1:3000/health | python3 -c "import json,sys; d=json.load(sys.stdin); print('  API:', d['status'])" \
  || echo "  WARN: health check failed, check pm2 logs"

echo ""
echo "=========================================="
echo " 部署完成 $(date '+%Y-%m-%d %H:%M:%S')"
echo " 后端日志：pm2 logs food-shop-server"
echo " 错误日志：${LOG_DIR}/food-shop-server-error.log"
echo "=========================================="
