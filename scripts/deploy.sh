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
# 没走到「迁移成功、换上新产物」就退出（预检失败、build 失败、迁移失败），磁盘上必须还是
# 部署前的 dist/ + Prisma Client：旧进程虽然还在内存里跑旧代码，但 PM2 之后任何一次自发
# 重启（max_memory_restart、机器重启、pm2 resurrect）都会从磁盘重新加载——新代码打老库，
# 所有带新列的查询 Unknown column，全站 500 且 /health（只 SELECT 1）照样绿。
ARTIFACTS_SWAPPED=0
restore_artifacts() {
  [[ -n "${SERVER_DIR:-}" ]] && rm -rf "${SERVER_DIR}/dist.next"
  if [[ -n "${PRISMA_CLIENT_BAK:-}" && -d "${PRISMA_CLIENT_BAK}" ]]; then
    rm -rf "${PRISMA_CLIENT_DIR}"
    mkdir -p "${PRISMA_CLIENT_DIR}"
    cp -a "${PRISMA_CLIENT_BAK}/." "${PRISMA_CLIENT_DIR}/"
    rm -rf "${PRISMA_CLIENT_BAK}"
  fi
  return 0
}
trap 'rm -f "$0"; [[ "${ARTIFACTS_SWAPPED}" == "1" ]] || restore_artifacts' EXIT

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
# SKIP_FETCH=1：跳过 git fetch，直接用本地已有的 origin/main。
# 用在 GitHub 从本机连不上的时候（国内机器常态：GnuTLS recv error / 443 超时），
# 此时可从一台能连 GitHub 的机器把 ref 推过来：
#   git push ubuntu@<服务器>:/www/food-shop <sha>:refs/remotes/origin/main
# 然后 SKIP_FETCH=1 bash scripts/deploy.sh
#
# DEPLOY_REF=<sha>：部署指定提交（回滚专用），不 fetch、不看 origin/main。
# 以前的回滚提示是「git reset --hard <旧版> && bash deploy.sh」——但这一步无条件
# reset 到 origin/main，会把刚回滚掉的坏版本原样装回去，回滚等于空操作。
echo "[2/9] 拉取最新代码..."
cd "${REPO_DIR}"
if [[ -n "${DEPLOY_REF:-}" ]]; then
  git rev-parse --verify --quiet "${DEPLOY_REF}^{commit}" >/dev/null \
    || { echo "ERROR: DEPLOY_REF=${DEPLOY_REF} 不是本仓库已有的提交（先 git fetch 或从别的机器 push 过来）"; exit 1; }
  TARGET_REF="${DEPLOY_REF}"
  echo "  DEPLOY_REF=${DEPLOY_REF}，跳过 git fetch，部署该提交"
else
  TARGET_REF="origin/main"
  if [[ "${SKIP_FETCH:-0}" == "1" ]]; then
    echo "  SKIP_FETCH=1，跳过 git fetch，使用本地 origin/main"
  else
    git fetch origin
  fi
fi
BEFORE=$(git rev-parse --short HEAD)
git reset --hard "${TARGET_REF}"
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
# 产物不直接写 dist/：编译到 dist.next/，[6/9] 迁移成功后再换上；Prisma Client 是
# prisma generate 原地覆盖的，没法指定输出目录，所以先快照、失败时拷回。
echo "[5/9] 构建后端..."
cd "${SERVER_DIR}"
PRISMA_CLIENT_DIR="$(node -p "require('path').dirname(require.resolve('.prisma/client/index.js'))" 2>/dev/null || true)"
PRISMA_CLIENT_BAK=""
if [[ -n "${PRISMA_CLIENT_DIR}" && -d "${PRISMA_CLIENT_DIR}" ]]; then
  PRISMA_CLIENT_BAK="$(mktemp -d)"
  cp -a "${PRISMA_CLIENT_DIR}/." "${PRISMA_CLIENT_BAK}/"
else
  echo "  （未找到已生成的 Prisma Client，应为首次部署，跳过快照）"
fi
npx prisma generate
rm -rf dist.next
# package.json 的 build 就是 tsc；tsconfig 的 outDir 是 dist，这里用命令行覆盖到 dist.next
npm run build -- --outDir dist.next
echo "  dist.next/app.js: $(du -sh dist.next/app.js | cut -f1)（迁移成功后换到 dist/）"

# ── [6/9] 数据库迁移 ─────────────────────────────────────────────────────────
echo "[6/9] 执行数据库迁移..."
if ! npm run db:migrate:deploy; then
  # MySQL 的 DDL 不可回滚：一个迁移里多条 CREATE TABLE / CREATE INDEX / ADD FOREIGN KEY，
  # 失败点在建表之后时新表已经落库。只灌回 dump 不会删它们（mysqldump 只 DROP/CREATE 备份里
  # 有的表），下次 migrate deploy 重跑该迁移会在 CREATE TABLE 撞 1050，Prisma 写入一条
  # finished_at IS NULL 的失败记录，此后每次部署都直接 P3009 退出——所以恢复必须三步都做。
  #
  # B2：新表探测直接读迁移文件里的 CREATE TABLE 语句，不再对比 SHOW TABLES 与备份——旧写法
  # 对比「库里有、备份里没有」的表，前提是迁移已经建出新表；但迁移的前几条语句完全可能是
  # ALTER TABLE，任一条失败时库里可能一张新表都没有，这种「探测出空」与「本次迁移压根不
  # 建表」两种情况从对比结果上无法区分——之前的兜底是在探测为空时打印上一批次硬编码的表名
  # （连同它们的 DROP 命令），运维照做会把探测为空但其实有真实数据的表一起删掉。直接读迁移
  # 文件本身没有这个歧义：CREATE TABLE 语句要么在文件里要么不在，与迁移实际执行到哪一步、
  # 库里当前有没有这张表都无关。
  #
  # R2（第二轮复核）：只探测「最后一个迁移目录」不够——生产落后多个版本时，本次会一次性
  # 应用好几个从未跑过的迁移，失败点可能落在中间那一个，`tail -1` 拿到的最后一个目录读出
  # 空毫无意义（甚至可能压根不是失败那个）。改成探测「本次全部 pending 迁移」：用
  # `_prisma_migrations` 里已成功完成（`finished_at IS NOT NULL`）的最大 migration_name
  # 做下界（目录名是时间戳前缀，字符串排序等价于时间先后），把晚于它的迁移文件全部纳入
  # CREATE TABLE 探测范围。查不到数据库（mysql 客户端缺失，或连接/查询失败）时不能瞎猜——
  # 猜错下界要么漏报真实新表要么把旧表当新表，都会导致运维删错东西；此时唯一安全的做法是
  # 明确告诉运维「探测不完整，需要自己核对」，而不是像旧版那样打印一批硬编码的表名（那正是
  # B2 要消灭的东西）。
  LAST_APPLIED=""
  MYSQL_QUERY_OK=0
  if command -v mysql >/dev/null 2>&1; then
    if LAST_APPLIED=$(mysql -h "${DB_HOST}" -P "${DB_PORT}" -u "${DB_USER}" -p"${DB_PASS}" -N -e \
        "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1" \
        "${DB_NAME}" 2>/dev/null); then
      MYSQL_QUERY_OK=1
    fi
  fi
  PENDING_MIG_DIRS=()
  DEGRADED_PROBE=0
  if [[ "${MYSQL_QUERY_OK}" == "1" ]]; then
    # LAST_APPLIED 为空是合法结果（首次部署、_prisma_migrations 还没有任何成功记录）——
    # 此时全部迁移目录都算 pending，不当成查询失败处理。
    for d in prisma/migrations/*/; do
      name="$(basename "${d}")"
      if [[ -z "${LAST_APPLIED}" || "${name}" > "${LAST_APPLIED}" ]]; then
        PENDING_MIG_DIRS+=("${d}")
      fi
    done
  else
    # 降级：连不上库/没有 mysql 客户端，没法确定「本次 pending 迁移」的下界。退化为只看
    # 最后一个目录（旧行为的探测范围，不是旧行为「编造表名」的做法），并在提示里明说这是
    # 降级模式、探测范围可能不全，运维需要自己核对 prisma/migrations 下本次实际新增的目录。
    DEGRADED_PROBE=1
    PENDING_MIG_DIRS=("$(ls -d prisma/migrations/*/ | sort | tail -1)")
  fi
  MYSQL_CLI="mysql -h ${DB_HOST} -P ${DB_PORT} -u ${DB_USER} -p ${DB_NAME}"
  NEW_TABLES=""
  if [[ ${#PENDING_MIG_DIRS[@]} -gt 0 ]]; then
    # grep 在全部文件都无 CREATE TABLE 命中时返回 1；pipefail 下会让整条管道判失败——这正是
    # R1 的坑：本次要恢复的迁移一条 CREATE TABLE 都没有是必然会发生的情况，不能让这里的探测
    # 失败反过来炸掉下面的恢复指引输出（备份路径、③ 清失败记录的命令）。`|| true` 兜底。
    NEW_TABLES=$(grep -ho 'CREATE TABLE `[^`]*`' "${PENDING_MIG_DIRS[@]/%/migration.sql}" 2>/dev/null \
      | sed 's/CREATE TABLE //' | paste -sd, - || true)
  fi
  PENDING_MIG_LIST="${PENDING_MIG_DIRS[*]}"
  restore_artifacts
  echo "=========================================="
  echo " ERROR: 迁移失败！服务未重启，旧进程仍在跑旧代码；磁盘上的 dist/ 与 Prisma Client 已还原为部署前版本。"
  echo " 恢复数据库请按顺序做完三步（少做 ②③ 下次部署会 P3009 卡死）："
  echo "   ① 灌回迁移前备份："
  echo "      gunzip < ${PRE_BACKUP} | ${MYSQL_CLI}"
  if [[ -n "${NEW_TABLES}" ]]; then
    echo "   ② 删掉本次迁移新建的表（读自 ${PENDING_MIG_LIST} 的 CREATE TABLE）：${NEW_TABLES}"
    echo "      ${MYSQL_CLI} -e 'SET FOREIGN_KEY_CHECKS=0; DROP TABLE IF EXISTS ${NEW_TABLES}; SET FOREIGN_KEY_CHECKS=1;'"
  elif [[ "${DEGRADED_PROBE}" == "1" ]]; then
    echo "   ② 无法连接数据库确定本次全部 pending 迁移（mysql 客户端缺失或连接失败），只探测了"
    echo "      最后一个迁移目录（${PENDING_MIG_LIST}）且未发现建表语句——这不代表本次一定不建表。"
    echo "      请人工核对 ${BEFORE}..${AFTER} 之间 prisma/migrations 下新增的全部目录，确认是否有表要删。"
  else
    echo "   ② 本次 pending 迁移（${PENDING_MIG_LIST}）均不建表，跳过——①已经灌回备份，没有新表要删。"
  fi
  echo "   ③ 清掉 Prisma 的失败记录（① 恢复了 _prisma_migrations 时此步为空操作，照跑无害）："
  echo "      ${MYSQL_CLI} -e 'DELETE FROM _prisma_migrations WHERE finished_at IS NULL'"
  echo " 之后：修好原因重跑 bash scripts/deploy.sh；或先回代码 DEPLOY_REF=${BEFORE} bash scripts/deploy.sh"
  echo "=========================================="
  exit 1
fi
echo "  迁移完成"
# 迁移成功，换上新产物。用 rename 而不是 rm -rf dist && mv：不留「dist 不存在」的窗口。
rm -rf dist.prev
[[ -d dist ]] && mv dist dist.prev
mv dist.next dist
rm -rf dist.prev
if [[ -n "${PRISMA_CLIENT_BAK}" ]]; then
  rm -rf "${PRISMA_CLIENT_BAK}"
fi
ARTIFACTS_SWAPPED=1
echo "  dist/app.js: $(du -sh dist/app.js | cut -f1)"
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
echo " 回滚代码：cd ${REPO_DIR} && DEPLOY_REF=${BEFORE} bash scripts/deploy.sh"
echo " 恢复数据库：gunzip < ${PRE_BACKUP} | mysql -u ${DB_USER} -p ${DB_NAME}"
echo "=========================================="
