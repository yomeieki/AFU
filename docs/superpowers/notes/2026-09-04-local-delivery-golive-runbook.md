# 同城配送上线 Runbook（合并 → 部署 → 后台配置 → 体验版 → M4 Task 6）

> **本文档的证据等级**：所有事实（生产版本、`.env` 键名存在性、路由 404、迁移内容、脚本行为）都是 2026-09-04 **实际只读核验**过的，逐条给了出处。
> 但 **A–G 各节的命令本次一律没有执行** —— 它们的正确性只到「读脚本 / 读代码得出」这一级。第一次照做时请逐条确认输出，不要把本文档当成已跑通的流程。
> **本文档不含任何密钥值**，也不要在回填时贴入密钥。

---

## 0. 为什么需要这份文档

M4 Task 6（真机真钱联调）的前置核验发现：**同城配送整条链路根本没有部署到生产**。

| 核验项 | 结果 |
|---|---|
| `curl -o /dev/null -w '%{http_code}' https://api.yuegui-hotel.online/api/local/meta` | **404**（`/api/local/quote` 同）|
| `/health` / `/api/products` | 200 / 200 —— 服务本身健康 |
| 生产机 | `162.14.114.95`（`VM-0-2-ubuntu`，腾讯云 CVM）。**不是** `~/.ssh/config` 里的 `oracle`（`140.83.54.60`）|
| 生产 `git log -1`（`/www/food-shop`）| **`ca37137`** `feat(admin): 实现商品小程序码生成 (#8)` |
| 该版本内容 | `apps/server/src/` 搜 `KD100` 零命中；`config.ts` 无 `WECHAT_TMPL_DELIVER`；无 `apps/miniapp/pages/local/` |
| `scripts/deploy.sh:74` | `git reset --hard origin/main` —— 部署只认 main |
| 同城分支 `claude/same-city-delivery-plan-2ffa20`（`914936b`）| 未合并、未 push |

⚠️ **生产 `ca37137` 比本地 `origin/main`（`b6521d3`）还多一个 commit** —— #8 是在别处合进去的，本地没有。合并前必须先把它取回本地，否则会把 #8 回退掉。

### 生产 `.env` 现状（`bash scripts/set-env.sh --list`，只输出键名与 ✔/○）

| 键 | 状态 | 影响 |
|---|---|---|
| `KD100_KEY` / `KD100_SECRET` | **✔ 已填**（12 / 32 字符，非占位）| P6 密钥侧已绿 |
| `WECHAT_TMPL_DELIVER` / `_FIELDS` | **两个键都不存在** | P8 未满足 |
| `WECHAT_TMPL_SHIP/_FIELDS`、`WECHAT_TMPL_REFUND/_FIELDS` | ✔ 已填 | release-checklist 2.6 前两项其实已做，只是没勾 |
| `LOCAL_DELIVERY_PROVIDER_MOCK` | 不存在（`undefined`）| ✅ 安全，不会触发拒绝启动 |
| `PUBLIC_BASE_URL` | ✔（31 字符、无尾斜杠）→ 最坏回调 URL **49 字符 ≤ 50** | ✅ 安全 |
| `NODE_ENV` | `production` | — |
| `WECHAT_PAY_REFUND_NOTIFY_URL` | ○ 空 | 不影响：`wechat-pay.ts:184-189` 由 `WECHAT_PAY_NOTIFY_URL` 的 `/notify`→`/refund-notify` 兜底 |

**顺手发现（不在本 runbook 范围，建议 PO 处理）**：`/www/food-shop/apps/server/` 下堆了 **19 个 `.env.bak-*`**，由 `set-env.sh:56` / `import-secrets.sh:29` 每次改动留下，**内含明文密钥**。

---

## A. 合并（本机执行）

本地 `main` = `6abd4f8`，落后生产两个 commit。**必须先把生产的 `ca37137` 取回来**：

```bash
cd /Users/yumingyi/food-shop

# ① 从生产机取回 ca37137（GitHub 连不上，服务器就是最新的源）
git fetch ubuntu@162.14.114.95:/www/food-shop main:refs/prod/main
git log --oneline -1 refs/prod/main      # 应为 ca37137

# ② 本地 main 快进到生产版本
git checkout main
git merge --ff-only refs/prod/main       # 6abd4f8 → ca37137

# ③ 合入同城分支
git merge --no-ff claude/same-city-delivery-plan-2ffa20 \
  -m "feat(local-delivery): 合入同城配送 M1-M3（GitHub 不可达，直推生产）"

NEW_SHA=$(git rev-parse HEAD); echo "$NEW_SHA"
```

> **已验证零冲突**：`git merge-tree --write-tree refs/prod/main claude/same-city-delivery-plan-2ffa20` 退出码 0、无 conflict 标记（2026-09-04 实跑）。

合并前先跑本机自测（不联网、不花钱）：

```bash
cd /Users/yumingyi/food-shop/apps/server
npx ts-node --transpile-only scripts/selftest-kd100.ts          # 注意：不带 --integration
npx ts-node --transpile-only scripts/selftest-delivery-core.ts
npx ts-node --transpile-only scripts/selftest-local-settings.ts
```

---

## B. 部署前 `.env` 预检与补齐（服务器执行）

### B1. 🔴 会让服务**拒绝启动**的两条（部署前必须确认）

| 条件 | 出处 | 当前生产状态 |
|---|---|---|
| `.env` 里 `LOCAL_DELIVERY_PROVIDER_MOCK` 必须不存在或非 `true` | `apps/server/src/config.ts:99-111` `process.exit(1)` | ✅ 不存在 |
| `${PUBLIC_BASE_URL}/api/kd/D999999-99` 必须 ≤ 50 字符 | `config.ts:127-131` `process.exit(1)` | ✅ 实测 **49**，余量 **1 个字符** |

> ⚠️ **`.env.example:157` 那行 `LOCAL_DELIVERY_PROVIDER_MOCK=true` 没有注释掉。** 整段复制 `.env.example` 到生产 = 服务拒绝启动。**不要 `cp .env.example .env`，也不要整段粘贴**，逐项用 `set-env.sh` 填。
> ⚠️ 余量只有 1 个字符：部署窗口里**不要**顺手给 `PUBLIC_BASE_URL` 加尾斜杠、也不要换更长的 API 域名。真要换域名，先把回调路径前缀从 `/api/kd/` 缩短（如 `/api/k/`）。

预检命令（只读）：

```bash
ssh ubuntu@162.14.114.95
cd /www/food-shop/apps/server
node -e '
require("dotenv").config({path:".env"});
const u=(process.env.PUBLIC_BASE_URL||"")+"/api/kd/D999999-99";
console.log("最坏回调 URL:", u.length, u.length<=50?"OK":"FAIL 服务会拒绝启动");
console.log("MOCK:", JSON.stringify(process.env.LOCAL_DELIVERY_PROVIDER_MOCK));
'
```

### B2. 🟡 静默降级的四项（部署前后填都行，但 Task 6 前必须齐）

| 键 | 缺失时的表现 |
|---|---|
| `KD100_KEY` / `KD100_SECRET` | 服务正常启动（`config.ts:186-191` 懒校验），**呼叫骑手时才抛** `Missing required env var: KD100_KEY / KD100_SECRET`。**当前已填 ✔** |
| `WECHAT_TMPL_DELIVER` / `_FIELDS` | `apps/server/src/services/subscribe-message.ts:173` 直接 `return` —— **不发推送、无日志、无告警**。Task 6 Step 5 会失败且查不出原因。**当前缺失 ✗，必须补** |

补 `WECHAT_TMPL_DELIVER` 的值来自 `docs/wechat-platform-local-delivery-setup.md:63-79`（公共模板 584，模板 ID + 5 个字段映射已在 `.env.example:132-133`）：

```bash
cd /www/food-shop
bash scripts/set-env.sh WECHAT_TMPL_DELIVER --show          # 非敏感，回显方便核对
bash scripts/set-env.sh WECHAT_TMPL_DELIVER_FIELDS --show
bash scripts/set-env.sh --list | grep TMPL_DELIVER          # 复核：两个都 ✔
pm2 restart food-shop-server                                # dotenv 只在启动时读一次
```

> 密钥类用 `bash scripts/set-env.sh <KEY>`（不带 `--show`，输入不回显、不进 shell history、不出现在 `ps`）。

---

## C. 部署（GitHub 不可达路径）

```bash
# ① 本机：先记下服务器当前值，供回滚
ssh ubuntu@162.14.114.95 'cd /www/food-shop && git rev-parse --short origin/main HEAD'
# 期望两行都是 ca37137

# ② 本机 → 服务器：直接改写服务器仓库的远程跟踪引用
git push ubuntu@162.14.114.95:/www/food-shop ${NEW_SHA}:refs/remotes/origin/main

# ③ 服务器：部署
ssh ubuntu@162.14.114.95
cd /www/food-shop
git rev-parse --short origin/main       # 应为新 SHA
SKIP_FETCH=1 bash scripts/deploy.sh     # 不带任何参数
```

两个必须照做的细节：

- **推 `refs/remotes/origin/main`，不是 `:main`。** 服务器仓库是非裸库且 checkout 在 `main` 上，推 `:main` 会被 `receive.denyCurrentBranch` 拒。`scripts/deploy.sh:60-64` 的注释设计的就是这条路。
- **绝不加 `--seed`。** `deploy.sh:20` 是 `SEED="${1:-}"`，第一个位置参数就是 seed 开关；`deploy.sh:113-116` 会跑 `db:seed`，在生产上没有任何好处（还会重置示例商品的 `deliveryType`）。

部署后立即验收：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.yuegui-hotel.online/health          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.yuegui-hotel.online/api/local/meta  # 200（原 404）—— P9 判据
```

---

## D. 数据库迁移风险评估（5 个 SQL 已逐条读完）

| 迁移 | 内容 | 破坏性 |
|---|---|---|
| `20260904000000_local_delivery` | `addresses` +3 列、`categories` +1、`orders` +10、`products` +2；新建 `deliveries` / `delivery_events` / `print_jobs` 三表；2 个索引；2 个 FK（都指向刚建的空表）| 无 |
| `20260904100000_m2_reminders` | `deliveries` +1、`orders` +2，全 NULL | 无 |
| `20260904200000_delivery_quote_snapshot` | `deliveries` +3、`orders` +2（含 2 个 JSON NULL）| 无 |
| `20260904210000_order_distance_source` | `orders` +1 VARCHAR NULL | 无 |
| `20260905000000_add_order_is_test` | `orders` +1 BOOLEAN NOT NULL DEFAULT false | 无 |

**全部 additive：无 `DROP`、无 `MODIFY`、无数据改写。** 所有 `ADD COLUMN` 都是行尾追加且可空或带 DEFAULT → MySQL 8.0.12+ 走 `ALGORITHM=INSTANT`，毫秒级不锁表；两个 `CREATE INDEX` 在只有几十行的 `categories`/`products` 上；两个 FK 校验时目标表是空的。

**结论：一次正常的 `SKIP_FETCH=1 bash scripts/deploy.sh` 是安全的，不需要维护窗口。**

- 部署前顺手核一次 `mysql -V`（`docs/deployment.md:28` 记的是 MySQL 8.0）。若是 8.0.11 及更早或 MariaDB，`ADD COLUMN` 会退化成 COPY 算法重建 `orders` 表；以这家店的订单量仍是秒级，仍不需要窗口。
- 仍建议选**营业时间外**（营业 9:00–20:00），理由不是迁移锁，而是 `deploy.sh` 的 `[7/9] rsync --delete` + `[8/9] pm2 reload` 期间管理后台会抖几秒，店员正在接单时会困惑。
- 若有人手工改过生产库结构，`prisma migrate deploy` 会在 drift 上报错并按 `deploy.sh:105-112` **中止且不重启服务** —— 这是安全的失败模式。

---

## E. 回滚（三档，默认第 2 档）

### E1. 迁移失败（`deploy.sh [6/9]` 中止）

脚本已保护：不重启服务、直接 `exit 1`，旧进程还在跑旧代码，并打印 `gunzip | mysql` 恢复命令。此时只需回代码（见 E2），数据库通常不用动。

### E2. ✅ 推荐：只回代码，不动数据库

迁移全是 additive，新列全部可空或带默认值，**`ca37137` 的旧代码对新 schema 完全兼容**（Prisma 只 select 自己 schema 里的列）。这样部署窗口内产生的真实订单不会丢。

```bash
# 本机
git push ubuntu@162.14.114.95:/www/food-shop ca37137:refs/remotes/origin/main --force
# 服务器
ssh ubuntu@162.14.114.95
cd /www/food-shop && git rev-parse --short origin/main   # ca37137
SKIP_FETCH=1 bash scripts/deploy.sh
curl -s -o /dev/null -w '%{http_code}\n' https://api.yuegui-hotel.online/health          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://api.yuegui-hotel.online/api/local/meta  # 回到 404
```

残留（可接受）：`_prisma_migrations` 多 5 行、库里多 3 张空表和一批空列。下次再部署时 `migrate deploy` 认为已应用，直接跳过，不会重复执行也不会报错。

### E3. 仅当数据库被写坏

```bash
ssh ubuntu@162.14.114.95
pm2 stop food-shop-server                                        # ① 必须先断写入
ls -t /www/backups/pre-deploy/pre_deploy_*.sql.gz | head -1      # ② 本次自动备份（deploy.sh [4/9]）
gunzip < /www/backups/pre-deploy/pre_deploy_<时间戳>.sql.gz \
  | mysql -h <DB_HOST> -P <DB_PORT> -u <DB_USER> -p <DB_NAME>    # ③ 密码交互输入
# ④ 再按 E2 回代码
```

**代价必须让店主知道**：恢复 dump = 丢掉备份点之后的**全部真实订单与支付记录**。联调那两单不值这个代价，E3 只在「结构性损坏、E2 救不回来」时用。

**Prisma 迁移不可逆**：仓库里没有任何 `down.sql`，`prisma migrate` 也不提供 revert。想真正撤掉 schema 变更只有 E3 一条路 —— 这正是 E2 作为默认策略的原因。

---

## F. 强制顺序：部署 → 后台配置 → 体验版 → Task 6

```
[C 部署]  /api/local/meta 返回 200
   │
   ▼
[D1 同城设置]  后台「同城设置」页填门店坐标 / 电话 / 地址 / ≥1 营业时段 / 半径>0，再开总开关
   │           （validateForEnable，apps/server/src/services/local-settings.ts:239-247，缺一项就拦）
   ▼
[D2 建 LOCAL 数据]  新建 channel=LOCAL 的分类 + 【内部联调】测试商品
   │                （迁移把存量 categories/products 的 channel 全默认成 'EXPRESS'，
   │                  migration.sql:7,22；seed 的「同城·」分类在生产不会建）
   ▼
[E 询价绿检]  服务器跑 selftest-kd100.ts --integration，拿到非空 quotes ← P6 的最终绿检点
   │
   ▼
[F 体验版]  开发者工具上传 → 公众平台 版本管理 → 设为体验版
   │        （首页入口由 /local/meta 的 enabled 服务端门控，apps/miniapp/pages/index/index.js:75；
   │          enabled=false 时真机显示「即将开通」且不可点，所以必须在 D1 之后上传）
   ▼
[G Task 6 开跑]
```

**每一环都是硬阻塞，顺序不能调。** 特别是 D1/D2 —— 原 M4 计划的前置表漏了这两条（已补为 P10）。

---

## G. 提审的运营风险（两份文档都没覆盖）

`docs/miniapp-release-checklist.md:143` 的「功能页面」栏要填 `pages/local/index`、`pages/local/confirm`。**审核员会真的走一遍同城下单流程并触发呼叫骑手，产生真实运费。**

- 审核期间同城**总开关不能关** —— 关了审核员看到「即将开通」，属于 checklist `:171` 表里「页面存在无法打开的功能」的典型打回理由。
- 反过来要准备好在工作台盯审核员的单。可考虑：提审前把「暂停接单 `paused`」用起来，或在补充说明里写清同城仅在营业时段可用。
- 发布是手动的（checklist `:159`）；回滚走「版本管理 → 版本回退」（`:196`）。

**提审安排在 Task 6 全绿之后**，不要并行。

---

## H. Task 6 Runbook

### H1. 前置检查表（全绿才开跑）

| # | 检查 | 命令 / 位置 | 期望 |
|---|---|---|---|
| C1 | 后端已是新版本（P9）| `curl -s -o /dev/null -w '%{http_code}\n' https://api.yuegui-hotel.online/api/local/meta` | **200** |
| C2 | 服务健康 | `curl -s https://api.yuegui-hotel.online/health` | `status:ok` |
| C3 | 密钥已配（P6）| 后台 → 系统状态；或 `GET /api/admin/system/status \| jq .data.kd100` | `keySet` ✔ `secretSet` ✔ `mock` false `callbackUrlOk` true `circuitTripped` false |
| C4 | 配送模板已配（P8）| `bash /www/food-shop/scripts/set-env.sh --list \| grep TMPL_DELIVER` | 两项都 ✔（**系统状态页看不到**，`system.ts:74-78` 缺 `deliverTemplateSet`）|
| C5 | 快递100 账户余额 | 快递100 企业版后台（**只能 PO 自己看，服务器上查不到**）| ≥ 50 元 |
| C6 | 同城设置完整并已开启（P10）| 后台 → 同城设置 | 保存无 `validateForEnable` 报错，总开关开 |
| C7 | LOCAL 分类 + 测试商品已建（P10）| 后台 → 分类/商品 | 见 `docs/ops-test-orders.md:17-26` |
| C8 | 询价通 | `cd /www/food-shop/apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts --integration` | 打出非空 `quotes` 数组 |
| C9 | 体验版已上传、真机能看到同城入口 | 真机 | 首页出现「同城配送 · N km 内送达」且可点 |
| C10 | 在营业时段内 | `/api/local/meta` 的 `isOpen` | true |
| C11 | 店主本人微信、真机、能收付款 | — | — |
| C12 | 预算与时间窗已与店主当面确认 | 见 H4 | — |

### H2. 逐步执行（Step 编号对齐 M4 计划 Task 6）

| Step | 花钱 | 要点 | **必须记录的证据** |
|---|---|---|---|
| 1 `batchPrice` 探测 | 0 | `selftest-kd100.ts --integration`（`kd100-probe.mjs` 不存在）| 完整 JSON、运力编码列表、最低 `feeFen`、`distanceM`、`discountFee` 语义结论 |
| 2 隐私弹窗全链路 | 0 | 清缓存 → 首页点「同城配送」→ **拒绝**（应 toast 且不跳转）→ 再点 → **同意** → 进同城页 → 地址编辑页点地图 → **地图真的打开** | 两轮截图 + console 有无报错。**这是 F5 `buttonId` 的唯一判据** |
| 3 F1/F3/F4 真机 | 0 | F1 连点「+」5 次按钮立刻置灰、合计不闪旧数字；F3 飞行模式下地址列表仍完整（只是没距离标签，不是空白页）；F4 订单进 `DELIVERED` 后 `/orders/:id/courier` 停止轮询 | F4 必须有 Network 截图 |
| 4 完整下单 1 单 | 💰 | 首页 → 加购测试商品 → 选地址 → 报价 → 提交 → 支付 → 工作台接单 → 呼叫骑手。接口：`accept` / `accept-and-call` / `call` / `delivery`（`apps/server/src/routes/admin/delivery.ts:26,38,58,86`）| **每个回调状态的真实 `statusDesc` 原文**（spec 里现在全是推断）、**「回调到达 → 小程序详情页刷新」的时延秒数**、骑手卡文案（验 F6：不应出现任何「骑手距您 x.x km」）|
| 5 310 订阅消息 | 0 | 随 Step 4。没收到就按序查：① C4 两个 env 是否 ✔ → ② 下单时是否真点了「允许」（一次性订阅，一次授权只发一条）→ ③ `pm2 logs food-shop-server \| grep 47003`（`courierMobile` 为空会被微信拒发，代码有兜底填店铺电话）| 推送截图 + 5 个字段的实际渲染值 |
| 6 立即取消 1 单 | 💰 含取消费 | 呼叫后**立刻** `precancel`（`delivery.ts:111`，只预估）→ 确认可接受 → `cancel`（`:120`）。同时验顾客端「申请取消」（`acceptGraceMin` 内）二次确认弹窗 → 灰条 → 店员确认 → 全额退款到账 | **`precancel` 预估 vs `deliveries.cancel_fee` 实际 vs 快递100 账单扣费，三者是否一致** —— 这是 Task 6 Done 的硬判据 |
| 7 异常态展示 | 视选项 | **原计划的「生产用后台 mock 端点」已作废**（`admin/index.ts:37` 与 `config.ts:99-111` 互斥）。7a 复用 Step 6 取消触发的异常态（推荐，0 元）／7b 边界地址触发 `510`/`515`（要店主同意）／7c 本机 mock 环境在开发者工具里看（0 元，证据低一档）| 用了哪条 + 顾客端文案是否为中性的「配送正在协调中，如超过预计时间请联系商家」|
| 7.5 清理 | 0 | 软删测试商品 + 每笔联调单打 `isTest`（见 M4 计划 Task 6 Step 7.5）| 已清理确认 |
| 8 整理记录 | 0 | `docs/superpowers/notes/2026-09-0X-m4-realdevice-log.md`，问题分「阻断顾客端体验」/「体验瑕疵」两类 | — |
| 9 提交 | 0 | 仅文档 | — |

> **阻断性 bug 另开 fix 分支处理，不要在 M4 计划内直接改** —— 混进一个未经评审的紧急修复会让本次联调的证据链失真。

### H3. 中止判据（命中任一条就停）

| 触发 | 动作 |
|---|---|
| Step 1 返回 `30001/30002/30003/30006`（`kd100.ts:26` → `CONFIG`）| 密钥或门店配置错，停，回 C3 / C6 |
| 返回 `30004`（`kd100.ts:24` → `BALANCE`）| 余额不足。充值后须 `POST /api/admin/system/kd100-circuit/reset`（`system.ts:122`）**手动解熔断** |
| 反复 `30005`（`kd100.ts:25` → `CAPACITY`）| 该时段无运力。换时间窗重来，不要靠加小费硬呼 |
| Step 4 支付成功但订单没变「待接单」| 支付回调验签问题（`docs/miniapp-release-checklist.md:106` 的「一分钱实测」从未做过）。**立即停，先原路退款**，转排查支付 |
| Step 6 `precancel` 预估取消费明显超预期（如 > 10 元）| **不要 `cancel`**，让骑手正常送达，Step 6 判据改记「未验」|
| 出现「顾客拿不到货 / 钱扣了没单」| 立即中止全部 Task 6，走退款，不要下第二单 |
| 累计真实支出超预算 1.5 倍 | 停 |

### H4. 预期真钱支出

| 项 | 金额 |
|---|---|
| Step 1 询价 | 0（`batchPrice` 只读）|
| Step 4 货款 | 起送门槛最小值（店主自买自收，实质 0）|
| Step 4 运费 | 1 单实际运费 |
| Step 6 运费 | 第 2 单运费 |
| Step 6 取消费 | 约 2 元（spec §11.5 估算）|
| **合计** | **≈ 2 单运费 + 2 元** —— 与 M4 计划一致 |

前提：快递100 账户余额 ≥ 50 元（C5）。

---

## I. 最短关键路径

**唯一的外部长尾是快递100 的余额**（密钥已在生产 `.env` 里，说明企业认证已过；余额只有 PO 能在快递100 后台确认）。

| 阶段 | 内容 | 耗时 |
|---|---|---|
| D0 上午 | A 合并 + 本机三个 selftest；B2 在服务器补 `WECHAT_TMPL_DELIVER` 两项；B1 预检 | 30 min |
| D0 傍晚（营业时段外）| C 部署；验 `/api/local/meta` 200、`/health` ok、系统状态 `kd100` 全绿 | 20 min |
| D0 傍晚 | F 的 D1 同城设置 + 开总开关；D2 建 LOCAL 分类与测试商品 | 30 min |
| D0 傍晚 | `selftest-kd100.ts --integration` → **P6 正式绿检** | 5 min |
| D1 上午 | 上传体验版（**先不提审**）→ 真机确认同城入口出现 | 20 min |
| **D1 营业时段内** | **Task 6 Step 1–9 一次坐满** | **2–3 h** |
| D2+ | G 提审 → 审核 → 发布 | 按微信节奏 |

**≈ 1.5 个工作日**，其中不可压缩的是 Task 6 本身那 2–3 小时（真实骑手接单、取餐、送达的物理时间）。

---

## J. 建议的两个小修（不在本 runbook 范围，需 PO 点头）

1. **`apps/server/src/routes/admin/system.ts:74-78` 补 `deliverTemplateSet`**，并让 `apps/admin/src/pages/SystemStatus.tsx` 渲染 `kd100` / `subscribe` 两组（现在这两组 API 返回了但前端类型里没有，页面直接丢弃）。做完 P6/P8 就能从后台页面绿检，不必再 SSH。
2. **`.env.example:157` 把 `LOCAL_DELIVERY_PROVIDER_MOCK=true` 注释掉** —— 这是会在本 runbook 描述的那次部署里咬人的雷。
