# 退款状态自动补查 + 服务端固定北京时间 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## 0. 给执行方的说明（先读）

- 本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **L**（动退款资金链路的状态流转、加数据库列、改进程级时区、改部署脚本/PM2 配置）。
- 工序链：**00 规划 · fable（本文件）→ 01 执行 · sonnet → 02 独立复核 · opus（新会话，只给「§1 需求 + 最终 diff + §6 验收标准」，不给执行过程、不给本文件的推理段）→ 03 回判 · fable（逐条判 成立 / 误判 / 需澄清）→ 修补轮（sonnet 修完**必须再过一次 opus**）→ 04 机械核对 · haiku（只跑 §6 的命令、比对 §5 改动清单与 diff 的文件集合是否落在 §7 白名单内，不调模型判断）**。
- 各工序只做本职：规划不写码、执行不改方案（偏离要逐条写进回报）、复核不提交修复。**每次交接第一行声明「当前工序 0X · 模型」。**
- **验收标准只在本文件 §6 定义，后续工序不得新增或放宽。**
- 合并到 main 由统筹方在链路走完后执行；**部署生产由店主决定**。执行方不合并、不部署、**不 ssh / 不 scp 生产机**（生产是统筹方的事）。
- 本文件自包含：需求、已查实的代码事实（带 文件:行）、分步改动、验收、白名单、上报条件、环境配方全部在此，不引用任何对话。
- 仓库与分支：worktree `/Users/yumingyi/food-shop/.claude/worktrees/refund-tz`，分支 `claude/refund-reconcile-tz`，基线 main `a3b76c2`。**只在这个目录工作，不 cd 到主检出，不裸 `git stash`，不 `npm install`**（依赖向上解析到主仓 `node_modules`；本 worktree 里 `apps/server/.env` 不存在，需要 env 的命令一律在命令行显式传，见 §9）。
- Prisma client 与其它 worktree 共用：`npx prisma generate` 同一时刻只能有一个 agent 跑，跑之前先确认没有别的 agent 在 generate（本批 T2 加列后必须 generate 一次，之后不要反复 generate）。
- 长命令一律带 `timeout`，全量 e2e（约 10 分钟）用后台执行 + 有上限的轮询，不要傻等；**先提交再做回退验证**（§6.6），回退验证只改工作区、验完 `git checkout -- <file>`，不提交。
- 提交信息用中文，署名 `Co-Authored-By: Claude Sonnet <noreply@anthropic.com>`（执行方用自己的真实模型名）。

---

## 1. 需求（店主 2026-09-21 拍板：「把这两项一起做了，然后合并」）

**A. 退款状态自动补查。** 微信退款回调丢失时，订单不再永远卡在「退款中」。系统定时去问微信这笔退款到底成没成，按结果走**既有**的状态流转（成功 → 已退款；关闭 → 释放在途位可重试；异常 → 标异常并告警；仍处理中 → 下轮再查；查询失败 → 记日志下轮再试）。连续多轮没结果要通知店主。每轮限量。必须与回调路径**幂等且互斥**：回调若后到不得重复记账。

**B. 服务端固定北京时间。** 换服务器 / PM2 配置变成 UTC 时，所有「按上海自然日」的逻辑（经营概览、扫码统计、订单日期筛选、自取时段、营业时间、会员每日任务日切）不能错 8 小时且不能静默。要有启动自检。

**范围**：只动 `apps/server`（源码、脚本、prisma 迁移）、`scripts/`（e2e、deploy）、`docs/`、`.env.example`、`apps/server/ecosystem.config.js`。**不动小程序、不动后台前端。**

---

## 2. 已查实的代码事实（2026-09-21 在本 worktree 逐一核过）

### 2.1 退款服务 `apps/server/src/services/refund.ts`

- `ACTIVE_REFUND_STATUSES = ['PENDING','PROCESSING','ABNORMAL']`（:26）——在途态占 `Refund.activeOrderId`（唯一索引，`prisma/schema.prisma:444`），同一订单同时只能有一笔在途退款。
- `remainingRefundable = max(0, actualAmount − refundedAmount)`（:44-46）。
- `initiateRefund`（:81-298）：事务 A 建 `Refund(status='PENDING', activeOrderId=orderId)`（:195-210）；**MOCK 模式直接 `finalizeRefundSuccess`**（:249-252），永远不会停在 PROCESSING；WECHAT 模式调 `createRefund`（:256-263），同步返回后**先写 PROCESSING**（:268-276，注释 :264-267 明说「SUCCESS 只允许由 finalizeRefundSuccess 一处写入」），再按同步 `status` 分派 SUCCESS→`finalizeRefundSuccess` / ABNORMAL→`markRefundAbnormal` / CLOSED→`markRefundClosed`（:277-288）；抛错 → `markRefundFailed`（:289-295）。
- `finalizeRefundSuccess`（:324-430）**已具备幂等与互斥**：事务头两句 `SELECT … FOR UPDATE`（refunds → orders，:341-343）；条件写 `updateMany({ where: { id, status: { not: 'SUCCESS' } } })` 判 `count`，输掉的返回 `alreadyDone: true` 直接退出（:361-362）；金额累加是一条原子 SQL `LEAST(refunded_amount + amount, actual_amount)`（:369）；累计退完才把订单 `REFUNDING → REFUNDED`（条件写，:375-385）；售后单 DONE（:386-391）、积分扣回同事务（:395-402）；通知与出票在事务外、只在 `!alreadyDone` 时发（:406-429）。**结论：补查 SUCCESS 路径复用它即天然幂等，回调后到会在 :361 处 count=0 退出，不会重复累加。**
- `markRefundAbnormal`（:433-443）与 `markRefundClosed`（:446-456）用的是**无条件** `prisma.refund.update`，`markRefundFailed`（:459-472）同样无条件。它们没有「已 SUCCESS 则不动」的守卫：若补查读到的快照是 PROCESSING、查询返回 CLOSED/ABNORMAL，而在这几十毫秒里回调已把该行翻成 SUCCESS，无条件写会把 SUCCESS **改回** CLOSED/ABNORMAL（`refundedAmount` 已累加、订单已 REFUNDED，退款单却显示未成功）。**这是补查引入的新竞态，必须在本批堵上（§3.1 第 4 条）。**

### 2.2 回调入口 `apps/server/src/routes/wechat-notify.ts`

- `wechatRefundNotifyHandler`（:334-391）：按 `out_refund_no` 找退款单（:344），找不到 ack 忽略（:345-350）；**已 SUCCESS 直接 ack**（:353-356）；金额比对 `data.amount.refund !== refund.amount` → 告警 + FAIL（:359-365）；按事件分派 `finalizeRefundSuccess(rawField:'wxNotifyData')` / `markRefundAbnormal` / `markRefundClosed`（:368-383）。补查必须与这三条路径一致。
- 挂载在 `express.json()` 之前（`apps/server/src/app.ts:45`）。

### 2.3 微信支付客户端 `apps/server/src/services/wechat-pay.ts`

- 统一超时 `fetchWechatPay`（:35-45，15 秒 :27）；签名 `generateWxPayAuthorization(method, url, body)`（:47-67），签名串 `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`（:61），GET 时 `body` 传空串即符合微信 v3 规范（结尾两个 `\n`）。
- `RefundResult`（:183-192）已包含 `status: 'SUCCESS'|'CLOSED'|'PROCESSING'|'ABNORMAL'`、`success_time`、`amount.refund`、`refund_id`、`channel`——**查询单笔退款的响应形状与它相同**，可直接复用。
- `WechatRefundError(code, message, httpStatus)`（:195-204）。`createRefund`（:215-239）非 2xx 或无 `refund_id` 即抛它。
- **没有查询单笔退款的函数**。微信 v3：`GET https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/{out_refund_no}`，200 返回同 `RefundResult`；查无此单返回 HTTP 404、`code: "RESOURCE_NOT_EXISTS"`。
- 文件不 import `config`，只读 `process.env`；mock 分支现在都在调用方（`refund.ts:130` 按 `config.mock.pay` 决定 mode）。本批沿用：`wechat-pay.ts` 只放真实实现，mock 放独立文件，由补查服务按 `config.mock.pay` 选。

### 2.4 定时任务 `apps/server/src/services/scheduler.ts`

- 60 秒心跳（`TICK_MS` :35），`SCHEDULER_DISABLED=true` 关（:43-46，`config.schedulerEnabled` 见 `config.ts:191`）；`running` 守卫（:97）；任务表 `tasks: [name, fn][]`（:100-140），每个任务独立 try/catch，失败 `notifySystemAlert('定时任务 X 失败', …, { key: 'scheduler:X' })`（:142-149）；`BATCH = 100`（:37）。
- `SchedulerOverrides`（:54-93）是 e2e 的阈值覆盖口，经 `POST /api/admin/system/run-scheduler`（`routes/admin/system.ts:99-138`，非生产，`num(v) = v >= 0 ? v : undefined` :104，**0 是合法值**）透传。
- 现成的「对账」范式：`services/delivery/express-booking-tasks.ts` `reconcileExpressStale`（:110-132）——**先 CAS 占坑再查**（`updateMany where staleCheckedAt = 旧值` :126-128），并发双 tick 只有一个能查；`reconcileExpressUnknown`（:77-98）——次数封顶 + 到阈值一次性告警。

### 2.5 告警通道 `apps/server/src/services/notify.ts`

- `notifySystemAlert(title, lines, { key, windowMs })`（:116-）：投给 `SYSTEM_ALERT_WECOM_WEBHOOK`（回退订单群 webhook）与 PushPlus（不带 topic，只给老板本人），同 key 在 `windowMs`（默认 5 分钟 :13）内只发一次。**补查告警走它，不新开通道。**
- `notifyRefundResult(order, refund, 'SUCCESS'|'ABNORMAL'|'CLOSED')`（`services/order-notify.ts:174-`）是给店员群的退款结果推送，三个 mark/finalize 已各自调用，补查复用时不用再调。

### 2.6 mock 控制面范式

- 只在 mock 模式挂载：`routes/admin/index.ts:42-44` `if (config.mock.express) router.use('/system/express-mock', expressMockRouter)`——生产这组路由**不存在**。
- 指令队列实现 `services/delivery/express-mock.ts:26-40`：`queues: Map<op, Directive[]>`、`calls[]` 记录、`take()` 出队、无指令时按默认成功。路由模板 `routes/admin/express-mock.ts`（`/reset`、`/queue`、`/calls?op=`）。
- 本批的 `WECHAT_PAY_MOCK=true` 现在只影响 `refund.ts:130` 的 mode 与 `routes/orders.ts:1116-1175` 的 mock 支付；**没有** pay-mock 控制面，需新建（T1）。

### 2.7 数据模型 `apps/server/prisma/schema.prisma`

- `model Refund`（:422-459）：`status VarChar(16)`（:434，注释列出 PENDING/PROCESSING/SUCCESS/ABNORMAL/CLOSED/FAILED），`activeOrderId Int? @unique`（:444），`wxResponseData`/`wxNotifyData Text`（:448-449），`errorCode/errorMessage`（:446-447），`@@index([status])`（:457）。**没有**「上次补查时间 / 次数」列。
- `refunds` 表 DDL（`prisma/migrations/20260902100000_add_refund/migration.sql:22-23`）：`created_at DEFAULT CURRENT_TIMESTAMP(3)`，`updated_at NOT NULL` **无默认**——e2e 用 SQL 直插退款行时两列都要显式给。
- 最近一次加列迁移 `20260919000000_order_promo_discount/migration.sql`：单条 `ALTER TABLE … ADD COLUMN … DEFAULT 0`，本批照此型。本机 MySQL `8.0.46`；MySQL ≥ 8.0.12 末尾加列（无生成列/无自增）默认 `ALGORITHM=INSTANT`，只改元数据。生产 `refunds` 表 18 行（2026-09-18 只读核实：WECHAT/SUCCESS 15、FAILED 3、人工补记 0），即便走 COPY 也是瞬时。
- `Order.refundedAmount Int @default(0)`（:260）。`Setting`（:555-561）是 `member/cron-state.ts` 存「每日一次」状态的地方，本批**不用**它（补查状态按行记，不是全局一次性任务）。

### 2.8 时区现状与实测

- 仓库里**没有任何地方**设置 `process.env.TZ`（全仓 grep 只命中注释：`services/local-settings.ts:342`、`scripts/selftest-promotion.ts:152`）。
- 按**进程本地时区**算的实现：`utils/local-day.ts` `localDayKey`（:64-66）、`parseLocalDayStart`（:89-94，`new Date(\`${key}T00:00:00\`)`）、`localDayBounds`（:101-119）；`services/member/cron-state.ts` `isSameLocalDay`（:40-42）。
- 显式钉 `Asia/Shanghai` 的实现（不受进程 TZ 影响）：`services/pickup.ts:27`、`services/order-no.ts:38`、`services/local-settings.ts:699,776`、`services/ticket/content.ts:169`、`services/notify.ts:78`、`services/order-notify.ts:36`、`services/subscribe-message.ts:49`；后台构建闸门 `scripts/check-admin-timezone.mjs`。所以「错 8 小时」的面只在前一类，但它们正是经营概览 / 扫码统计 / 订单日期筛选 / 会员日切。
- 自测守卫：`apps/server/scripts/selftest-local-day.ts:12-15` 要求 `getTimezoneOffset() === -480`，靠命令行 `TZ=Asia/Shanghai` 前缀满足；`scripts/e2e.sh:2064` 读的是 **e2e 客户端**本机的偏移（用来构造跨日边界的行），与服务端无关。
- 启动顺序：`app.ts:1` 第一句 `import { config } from './config'`；`config.ts:1` 第一句 `import 'dotenv/config'`，随后 zod 校验（:5-107），`isProduction`（:110），生产额外校验用 `process.exit(1)`（:118-163）。**在 `config.ts` 里、dotenv 之后立刻钉 TZ，就在任何业务 `Date` 之前**（`config.ts` 自己的其余 import 只有 `zod`）。
- **Node 运行时改 TZ 实测（本机 v25.9.0，2026-09-21）**：`TZ=Asia/Tokyo node -e …` 里 `process.env.TZ='Asia/Shanghai'` 后 `getTimezoneOffset()` 立刻从 −540 变 −480，**先前创建的 Date 对象**的 `getHours()` 也随之变化，`Intl.DateTimeFormat().resolvedOptions().timeZone` 变成 `Asia/Shanghai`。**赋一个不存在的时区名（`Not/AZone`）会静默回落到 UTC（偏移 0），`process.env.TZ` 仍是那个错名**——所以「钉死」之后必须再自检偏移，服务器缺 tzdata 时就是这一种失败。Node ≥ 13 支持运行时改 TZ；生产 `deploy.sh:52-53` 要求 Node ≥ 18。
- 生产事实（2026-09-18 统筹方只读核实）：`timedatectl` = Asia/Shanghai，`food-shop-server` 进程未设 TZ、继承系统，**目前正确**。

### 2.9 部署与 PM2

- `apps/server/ecosystem.config.js`：`exec_mode: 'fork'`、`instances: 1`（:8-9），`env_production: { NODE_ENV:'production', PORT:3000 }`（:10-13），`max_restarts: 10, restart_delay: 5000`（:18-19）。**没有 TZ。**
- `scripts/deploy.sh:263` `pm2 reload food-shop-server --update-env`（进程已存在时）；首次 `pm2 start ecosystem.config.js --env production`（:265）。`pm2 reload <进程名>` **不会重读 ecosystem 文件**，改 ecosystem 的 env 要 `pm2 reload ecosystem.config.js --env production --update-env`（或 delete 后 start）。
- **fork 模式下 `pm2 reload` 等于 restart**（零停机重载只有 cluster 模式有）：旧进程被杀、新进程启动；新进程若启动即 `exit(1)`，PM2 按 `restart_delay` 5 秒重试至 `max_restarts` 10 次后 `errored`，期间服务不可用；`deploy.sh:268-312` 在 reload 后 `sleep 2` + `sleep 1` 做 `/health` 探测，失败即 `exit 1` 并提示 `pm2 logs`。**不存在「自检失败 PM2 保留旧进程」这回事**——回滚只能 `DEPLOY_REF=<上一版> bash deploy.sh`（§11）。

### 2.10 测试基础设施

- e2e：`scripts/e2e.sh`（helper：`req` :32-35、`sched` :46-57、`make_paid_order` :104-113（EXPRESS 单 + mock 支付）、`order_status`/`latest_refund` :114-115、`sql()` :1726、分片加载 `for f in e2e.d/*.sh; source` :2011）；分片 `scripts/e2e.d/40…67-*.sh`，新分片编号 **68**；分片变量加统一前缀（67 用 `D67_`）。既有退款用例：§6-§9（:120-164，含 `refund-complete` 已退完再标记被拒 42204）、`e2e.d/46`。
- 前置：后端 `WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true`（`.claude/launch.json` `api-3100` 同款）。**`SCHEDULER_DISABLED=true` 下 `startScheduler` 不起心跳，但 `runSchedulerTick` 仍可由 run-scheduler 手工触发**——新任务挂进 `tasks` 表即自动获得 e2e 隔离，不需要额外开关。
- 纯函数自测：`apps/server/scripts/selftest-*.ts`，`cd apps/server && npx ts-node --transpile-only scripts/x.ts`，`t(name, fn)` 计数、失败 `process.exitCode = 1`（模板 `selftest-promotion.ts:26-36`）。DB 集成自测模板：`selftest-wechat-notify.ts:188-219`（`prisma.user.findFirst()` 取用户、`prisma.order.create` 造 REFUNDING 单 + WECHAT 支付、`prisma.refund.create` 造 PENDING 退款）。
- 类型检查：`apps/server/tsconfig.json` 只 include `src/**/*`；`npx tsc --noEmit -p apps/server`。脚本目录不进 tsc，靠 ts-node 跑通。
- 本地 MySQL：docker 容器 `food-shop-mysql`（root `foodshop_root_password`；应用 `foodshop_user`/`foodshop_password`；本机无 mysql 客户端，一律 `docker exec`）。本机 3000/3113 被占，本批后端用 **3123**。
- 文档：`docs/api.md`（3.5 退款 :828-851；附录 A 速查表 :963-1000，`run-scheduler` 行 :990；附录 C 的 mock 控制面写法 :1183-1213；末尾附录 K 到 :2059）；`docs/deployment.md`（四、环境变量 :75-236；六、后续更新部署 :258-363；九、回滚 :481-514；十二、常用运维命令 :538-564；十三、监控与告警 :565-）；`docs/staff-guide.md:48`（「微信处理中」超过 10 分钟 → 手动标记完成）；`.env.example:111-115`（订单生命周期块，`SCHEDULER_DISABLED` 在 :115）。

### 2.11 与统筹方口述不符 / 需修正之处（以代码为准）

1. 「`finalizeRefundSuccess` ~324、`markRefundAbnormal` ~433、`markRefundClosed` ~446、`markRefundFailed` ~459」：行号全部核实一致。但**三个 mark\* 都是无条件 `update`**，统筹方的「按回调 refund_status 分派到三条路径即可复用」在 CLOSED/ABNORMAL 两条上**不满足互斥**（§2.1 末条），本批要把它们改成条件写。
2. 「`SCHEDULER_DISABLED` 下不跑；或提供可单独调用的纯函数 + 路由触发」：二者现成——`runSchedulerTick` 任务表 + `run-scheduler` 路由就是那条路，不需要新路由；纯函数 `reconcileRefund` 另外导出供 DB 自测直接调。
3. 「查是否有 `ecosystem.config.*`」：有，`apps/server/ecosystem.config.js`，无 TZ；且 `deploy.sh` 的 reload 方式不会读它（§2.9）。
4. 「`pm2 reload` 零停机、自检失败 PM2 会保留旧进程吗」：**不会**，fork 模式 reload = restart（§2.9）。
5. 「后台『手动标记退款完成』只在邮寄列表有按钮」：服务端 `POST /admin/orders/:id/refund-complete`（`routes/admin/orders.ts:562-573`）本身对所有渠道可用、只校验 `REFUNDING`，界面入口的事不在本批范围（不动后台前端）。补查上线后它仍保留作最后兜底。
6. 微信查询接口的 404：统筹方只说了四种 `status`；实际还有「查无此单」（HTTP 404 `RESOURCE_NOT_EXISTS`），对 PENDING 行（发起阶段进程中断、微信侧根本没建单）这是唯一能释放 `activeOrderId` 的信号，本批纳入（§3.1 第 3 条）。

---

## 3. 设计决策

### 3.1 退款补查

1. **扫描范围**（`reconcileStuckRefunds`）：
   - `status IN ('PENDING','PROCESSING')` 且 `createdAt < now − afterMin` 且（`reconcileCheckedAt IS NULL` 或 `< now − intervalMin`）；
   - `status = 'ABNORMAL'` 且（`reconcileCheckedAt IS NULL` 或 `< now − abnormalIntervalMin`）——ABNORMAL 是在途态（占 `activeOrderId`），店主在商户平台人工处理后微信会推 SUCCESS/CLOSED 回调，回调丢了同样卡死；低频（默认 60 分钟）轮询兜住。
   - `orderBy createdAt asc`，`take batch`（默认 20）。不按 `mode` 过滤：MOCK 退款从不停在 PROCESSING（§2.1），mock 服务器上 e2e 直插的行 mode 写 `WECHAT`。
2. **单笔流程**（`reconcileRefund(refundId, query)`，导出供自测）：
   1. 读行；`status ∉ ACTIVE_REFUND_STATUSES` → `SKIPPED`。
   2. **CAS 占坑**：`updateMany({ where: { id, reconcileCheckedAt: 旧值 }, data: { reconcileCheckedAt: now, reconcileCount: { increment: 1 } } })`，count=0 → `SKIPPED`（与 `express-booking-tasks.ts:126-128` 同范式，挡并发 tick / 手工触发撞心跳）。
   3. `query(outRefundNo)`；抛错 → 写 `reconcileLastError`（截 255）、`console.warn`、返回 `QUERY_FAILED`，**不改状态**。
   4. `not_found`：`status === 'PENDING'` → `markRefundFailed(id, 'RECONCILE_NOT_FOUND', '微信侧查无此退款单（发起阶段中断）')`（既有函数：FAILED + 释放 `activeOrderId` + 告警「微信退款发起失败」，后台可重试）；`PROCESSING/ABNORMAL` 查无此单不合理（当初拿到过 `refund_id`）→ 只写 `reconcileLastError` + `notifySystemAlert('退款补查：微信查无此单', …, { key: \`refund-reconcile-notfound:${id}\` })`，返回 `NOT_FOUND`。
   5. `found`：若响应带 `amount` 且 `amount.refund !== refund.amount` → 写 `reconcileLastError`、`notifySystemAlert('退款补查金额不一致', …, { key: \`refund-reconcile-mismatch:${id}\` })`，返回 `AMOUNT_MISMATCH`，**不改状态**（与 `wechat-notify.ts:359-365` 同口径）。否则按 `status`：
      - `SUCCESS` → `finalizeRefundSuccess({ refundId, wxRefundId: r.refund_id, successTime: r.success_time ? new Date(r.success_time) : new Date(), channel: r.channel, rawData: JSON.stringify({ source: 'reconcile-query', ...r }), rawField: 'wxNotifyData' })`。**不传 `operator`**（会覆盖发起人）。
      - `CLOSED` → `markRefundClosed(id, rawData)`；`ABNORMAL` → `markRefundAbnormal(id, rawData)`；`PROCESSING` → 返回 `PROCESSING`。
   6. 返回值：`'SUCCESS'|'CLOSED'|'ABNORMAL'|'FAILED'|'NOT_FOUND'|'PROCESSING'|'AMOUNT_MISMATCH'|'QUERY_FAILED'|'SKIPPED'`。任务返回「状态推进条数」= SUCCESS/CLOSED/ABNORMAL/FAILED 之和。
3. **幂等与互斥证明**：
   - SUCCESS：`finalizeRefundSuccess` 头两句 FOR UPDATE（`refund.ts:341-343`）串行化回调与补查；条件写 `status ≠ SUCCESS`（:361-362）保证只有一方累加；金额 `LEAST(refunded_amount + amount, actual_amount)`（:369）以实付封顶。回调后到时 `wechat-notify.ts:353-356` 已 SUCCESS 直接 ack，即使绕过也在 :361 处 count=0。
   - CLOSED/ABNORMAL/FAILED：**本批把三个 mark\* 改成条件写**——`markRefundClosed`：`updateMany where status in ACTIVE_REFUND_STATUSES`；`markRefundAbnormal`：`where status in ['PENDING','PROCESSING']`（已 ABNORMAL 再报 ABNORMAL 不重复告警）；`markRefundFailed`：`where status in ['PENDING','PROCESSING']`。count=0 时**直接 return，不通知不告警**。既有调用点（`refund.ts:285-292`、`wechat-notify.ts:380-382`）的调用时刻状态都在各自守卫集合内，行为不变；回调重推 ABNORMAL 时此前会重复告警（5 分钟窗口外），改后不再重复——记入回报即可。
   - 并发 tick：步骤 2 的 CAS 占坑。
4. **告警**：`PENDING/PROCESSING` 行在一次 `reconcileRefund` 后仍未终态（返回 `PROCESSING`/`QUERY_FAILED`）且 `reconcileCount（已含本次） >= alertAfter`（默认 6，即约 30 分钟）→ `notifySystemAlert('退款长时间未到账', ['订单 ${orderNo}', '退款单 ${outRefundNo} · ¥X', '已自动核对 N 次仍未成功（最近：处理中 / 查询失败: …）', '可到微信商户平台查退款记录；确认已退成功但后台未变，再用「手动标记完成」'], { key: \`refund-reconcile-stuck:${id}\`, windowMs: 6h })`。同 key 6 小时内只发一次，之后仍卡着每 6 小时提醒一次。ABNORMAL 行**不发**此告警（`markRefundAbnormal` 已告警且本就要人工处理）。不设「停止轮询」封顶：5 分钟一次的单行查询代价可忽略，而停止轮询会让最终到账的单再次卡死。
5. **配置**（`config.ts` zod + `config.refundReconcile`）：`REFUND_RECONCILE_AFTER_MIN`（int ≥1，默认 5；既作年龄阈值也作复查间隔）、`REFUND_RECONCILE_ALERT_AFTER`（int ≥1，默认 6）、`REFUND_RECONCILE_BATCH`（int 1–100，默认 20）。ABNORMAL 复查间隔常量 60 分钟，不进 env。`SchedulerOverrides` 新增 `refundReconcileAfterMin`、`refundReconcileIntervalMin`、`refundReconcileAbnormalIntervalMin`、`refundReconcileAlertAfter`、`refundReconcileBatch`（都可为 0），`run-scheduler` 路由透传。
6. **mock**：`services/wechat-pay-mock.ts` 指令队列，按 `outRefundNo` 键（`'*'` 通配）；指令 `{ kind:'ok', status, amount?, refundId?, successTime? } | { kind:'not_found' } | { kind:'error', code, message?, httpStatus? } | { kind:'timeout' }`；无指令默认 `{ kind:'ok', status:'PROCESSING' }`（安全：不改状态）；`calls[]` 记录 `{ op:'queryRefund', outRefundNo, at }`。控制面 `routes/admin/pay-mock.ts`：`POST /reset`、`POST /refund-query { outRefundNo?, directive }`、`GET /calls?op=queryRefund`；`routes/admin/index.ts` 加 `if (config.mock.pay) router.use('/system/pay-mock', payMockRouter)`。`mock 'ok'` 不带 `amount` 时返回的对象也不带 `amount`（补查只在 `amount` 存在时比对，与回调一致）。
7. **新列**（迁移 `20260921000000_refund_reconcile`）：`reconcile_checked_at DATETIME(3) NULL`、`reconcile_count INT NOT NULL DEFAULT 0`、`reconcile_last_error VARCHAR(255) NULL`。旧行默认 NULL/0/NULL = 「从未补查」。回滚只回代码（多出的列不影响旧版）。
8. **不做**：不改退款金额计算；不改 `initiateRefund`；不改后台/小程序；不新增查询轨迹表。

### 3.2 服务端时区：双保险

1. **进程级钉死**（`apps/server/src/utils/timezone.ts`，纯函数，不 import 任何业务模块）：
   - `pinTimezone(env = process.env): { previous: string | undefined; overridden: boolean }`——无条件 `env.TZ = 'Asia/Shanghai'`（**覆盖**而不是「缺省才填」：目标是「换服务器 / PM2 写成 UTC 也不错」，缺省填法在 PM2 显式给 `TZ=UTC` 时就失效了）。
   - `checkTimezone(now = new Date()): { ok: boolean; offsetMin: number; resolved: string }`——`ok = now.getTimezoneOffset() === -480 && resolved === 'Asia/Shanghai'`（`resolved` 取 `Intl.DateTimeFormat().resolvedOptions().timeZone`）。
   - `enforceTimezone({ isProduction, log = console, exit = process.exit }): TimezoneReport`——`!ok` 时：生产 `log.error('[timezone] 进程时区不是 Asia/Shanghai（offset=…, resolved=…, env.TZ=…）：多半是服务器缺 tzdata 或 Node 不支持运行时改 TZ，服务拒绝启动')` + `exit(1)`；非生产只 `log.warn`。`overridden` 时无论环境都 `log.warn('[timezone] 环境 TZ=<previous> 已被覆盖为 Asia/Shanghai')`。`exit`/`log` 可注入是为了自测不真退出。
   - `config.ts`：`import 'dotenv/config'` 之后 `import { pinTimezone, enforceTimezone } from './utils/timezone'`，在 `envSchema` 之前立刻 `const tzPin = pinTimezone()`；在 `isProduction` 算出后（:110 之后、生产 mock 校验之前）`const tz = enforceTimezone({ isProduction })`；`config` 对象加 `timezone: { name: 'Asia/Shanghai', offsetMin, previousEnvTz: tzPin.previous ?? null, overridden }`。
   - `app.ts` 启动日志加一行 `[server] timezone: Asia/Shanghai (offset -480)`；生产 boot 告警（:95-98）行里追加 `时区 Asia/Shanghai` 与（若 overridden）`（环境 TZ=<previous> 已覆盖）`。
   - `GET /api/admin/system/status`（`routes/admin/system.ts:16-97`）加 `timezone: { name, offsetMin, ok, overriddenFrom }`——后台前端不动，只是多一个只读字段，方便上线后核对。
2. **部署层**：`ecosystem.config.js` `env_production` 加 `TZ: 'Asia/Shanghai'`；`deploy.sh:263` 改为 `pm2 reload ecosystem.config.js --env production --update-env`（让 ecosystem 的改动随部署生效，fork 模式行为与原来的 reload 一致 = restart）。
3. **脚本前缀**：`selftest-local-day.ts` 等脚本不经过 `config.ts`，**保留** `TZ=Asia/Shanghai` 命令行前缀与 :12-15 的守卫（双重保护、也不改任何脚本）；`.claude/launch.json` 不动（启动命令进 `app.ts` → `config.ts` 已钉）。e2e 服务端启动命令可以不再带 `TZ=`，§9 配方仍带着以示无害。
4. **为什么不选「只告警不拒绝」**：钉死之后，自检失败只剩「服务器缺 tzdata / Node 不支持」两种部署环境问题，此时所有自然日逻辑都会错 8 小时；生产带错上线比停 5 分钟修 tzdata 更糟，且 `deploy.sh` 的健康检查会当场红。列为 §4 第 6 条待店主确认。

---

## 4. 待店主确认（执行方按默认值做，不等答复；店主改口时由统筹方裁定后进修补轮）

| # | 事项 | 默认 |
|---|---|---|
| 1 | 补查年龄阈值 / 复查间隔 | 5 分钟（`REFUND_RECONCILE_AFTER_MIN=5`） |
| 2 | 连续几次没结果通知店主 | 6 次（≈30 分钟），之后每 6 小时再提醒一次 |
| 3 | 告警走哪个通道 | 既有 `notifySystemAlert`（企微系统告警 webhook → 回退订单群；PushPlus 只给老板）；不新开 |
| 4 | ABNORMAL 行是否也轮询 | 是，每 60 分钟一次，不发「长时间未到账」告警 |
| 5 | PENDING 行微信查无此单 | 标 FAILED 释放在途位（后台可重试） |
| 6 | 时区自检失败 | 生产**拒绝启动**（非生产只警告）；环境 TZ 被覆盖只警告不拒绝 |
| 7 | `deploy.sh` 改为从 ecosystem 文件 reload | 改（回滚 `DEPLOY_REF` 即可） |
| 8 | 每轮限量 | 20 笔 |

---

## 5. 分步改动清单

每个 T 一个提交（T4 可与 T3 合并提交）。每步完成后在回报里写「与方案的偏离」。

### T1 · `queryRefund` 真实实现 + mock + 控制面 + 自测

- [ ] `apps/server/src/services/wechat-pay.ts`：新增
  ```ts
  export type RefundQueryResult = { kind: 'found'; refund: RefundResult } | { kind: 'not_found' }
  export async function queryRefund(outRefundNo: string): Promise<RefundQueryResult>
  ```
  `GET https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/${encodeURIComponent(outRefundNo)}`，`generateWxPayAuthorization('GET', apiUrl, '')`，`fetchWechatPay`（沿用 15 秒超时），headers `Accept: application/json` + `Authorization`。200 且 `refund_id` 存在 → `found`；HTTP 404 且 `code === 'RESOURCE_NOT_EXISTS'` → `not_found`；其它非 2xx → `throw new WechatRefundError(code ?? HTTP_x, message, status)`；网络/超时由 `fetchWechatPay` 抛普通 Error。放在 `createRefund` 之后，注释写明用途「退款补查」。
- [ ] 新建 `apps/server/src/services/wechat-pay-mock.ts`：按 §3.1 第 6 条实现 `queueRefundQueryDirective(d, outRefundNo = '*')`、`mockQueryRefund(outRefundNo): Promise<RefundQueryResult>`（先取该 `outRefundNo` 的队列，空则取 `'*'`，再空用默认 PROCESSING；`timeout` 抛 `Error('微信支付请求超时（mock）')`，`error` 抛 `WechatRefundError`）、`getPayMockCalls(op?)`、`resetPayMock()`。文件头注释说明零 setTimeout、指令驱动、默认安全。
- [ ] 新建 `apps/server/src/routes/admin/pay-mock.ts`（模板 `routes/admin/express-mock.ts`）：`POST /reset`、`POST /refund-query`（校验 `directive.kind` ∈ ok/not_found/error/timeout；`ok.status` ∈ 四值；`amount` 若给必须是非负整数；`error.code` 必须非空字符串）、`GET /calls?op=queryRefund`。
- [ ] `apps/server/src/routes/admin/index.ts`：`import payMockRouter from './pay-mock'`；在 :44 后加 `if (config.mock.pay) router.use('/system/pay-mock', payMockRouter)`。
- [ ] 新建 `apps/server/scripts/selftest-wechat-pay-query.ts`（无 DB）：① `generateWxPayAuthorization('GET', url, '')` 的签名串以 `\n\n` 结尾（用与 `selftest-wechat-notify.ts` 同法生成临时 RSA 私钥写到 `.selftest/`，设 `WECHAT_PAY_PRIVATE_KEY_PATH`，用公钥验 `Authorization` 头里的 signature 对应的 message）；② monkeypatch `global.fetch`：200 体 → `found`；404 + `RESOURCE_NOT_EXISTS` → `not_found`；500 → 抛 `WechatRefundError` 且 `httpStatus===500`；`AbortSignal.timeout` 触发（fetch 抛 `name:'TimeoutError'`）→ 抛错且 message 含「超时」；③ mock：无指令 → PROCESSING；按 `outRefundNo` 指令优先于 `'*'`；指令出队后再次调用回到默认；`calls` 记录条数正确。
- [ ] 提交：`feat(server): T1 微信查询单笔退款 queryRefund + pay-mock 控制面 + 自测`

### T2 · 迁移 + 补查纯函数 + mark* 条件写 + DB 自测

- [ ] `apps/server/prisma/schema.prisma` `model Refund` 在 `successTime` 之后加：
  ```prisma
  // 退款补查（2026-09-21）：上次向微信查询的时间 / 累计查询次数 / 最近一次查询失败或金额不符的原因
  reconcileCheckedAt DateTime? @map("reconcile_checked_at")
  reconcileCount     Int       @default(0) @map("reconcile_count")
  reconcileLastError String?   @map("reconcile_last_error") @db.VarChar(255)
  ```
- [ ] 新建 `apps/server/prisma/migrations/20260921000000_refund_reconcile/migration.sql`：
  ```sql
  -- 退款补查（2026-09-21）：三列全部可空/有默认，旧行 = 从未补查。纯加列，MySQL ≥ 8.0.12 走 INSTANT；回滚只回代码不回库。
  ALTER TABLE `refunds`
    ADD COLUMN `reconcile_checked_at` DATETIME(3) NULL,
    ADD COLUMN `reconcile_count` INT NOT NULL DEFAULT 0,
    ADD COLUMN `reconcile_last_error` VARCHAR(255) NULL;
  ```
  然后 `npx prisma migrate deploy`（对本批专用库，§9）→ `npx prisma generate`（确认无其它 agent 在 generate）→ `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL"` 零差异（§9 给 shadow 库）。
- [ ] `apps/server/src/services/refund.ts`：
  - `markRefundAbnormal` / `markRefundClosed` / `markRefundFailed` 改为「条件 `updateMany` 判 count → count=0 直接 return → `findUniqueOrThrow` 取更新后的行 → 通知/告警」，守卫集合按 §3.1 第 3 条；每个函数注释写明「守卫理由：补查与回调可能同时到，已 SUCCESS 的行不得被改回」。返回类型保持 `Promise<void>`。
  - `finalizeRefundSuccess` **不改**（已满足）。
- [ ] 新建 `apps/server/src/services/refund-reconcile.ts`：
  ```ts
  export type ReconcileOutcome = 'SUCCESS'|'CLOSED'|'ABNORMAL'|'FAILED'|'NOT_FOUND'|'PROCESSING'|'AMOUNT_MISMATCH'|'QUERY_FAILED'|'SKIPPED'
  export type RefundQuery = (outRefundNo: string) => Promise<RefundQueryResult>
  export function defaultRefundQuery(): RefundQuery   // config.mock.pay ? mockQueryRefund : queryRefund
  export async function reconcileRefund(refundId: number, query: RefundQuery = defaultRefundQuery()): Promise<ReconcileOutcome>
  export interface ReconcileStuckOptions { afterMin?: number; intervalMin?: number; abnormalIntervalMin?: number; alertAfter?: number; batch?: number; query?: RefundQuery }
  export async function reconcileStuckRefunds(opts: ReconcileStuckOptions = {}): Promise<number>
  ```
  按 §3.1 第 1、2、4 条实现；缺省值取 `config.refundReconcile`。`reconcileStuckRefunds` 对每行单独 try/catch（一行抛错不影响其余，`console.error` + 继续）。告警文案与 key 照 §3.1 第 4 条。文件头注释：为什么按行记状态而不用 cron-state、为什么不设停止封顶、与回调的互斥依据（引用 `refund.ts` 的 FOR UPDATE 与条件写行号）。
- [ ] `apps/server/src/config.ts`：zod 加 `REFUND_RECONCILE_AFTER_MIN`（`z.coerce.number().int().min(1).default(5)`）、`REFUND_RECONCILE_ALERT_AFTER`（`int().min(1).default(6)`）、`REFUND_RECONCILE_BATCH`（`int().min(1).max(100).default(20)`）；`config.refundReconcile = { afterMin, alertAfter, batch }`。
- [ ] 新建 `apps/server/scripts/selftest-refund-reconcile.ts`（**需 DB**，运行方式见 §9；文件头写清需要 `DATABASE_URL`、`JWT_SECRET`、`ADMIN_JWT_SECRET`、`WECHAT_PAY_MOCK=true`）。造数据照 `selftest-wechat-notify.ts:188-219`（订单 REFUNDING、payment WECHAT/SUCCESS、退款 PROCESSING/WECHAT/`activeOrderId`），每个用例独立造单，用 `stamp` 保证唯一；结束时删除自己造的退款/支付/订单行。用例：
  1. **幂等**：query 桩返回 SUCCESS（amount=100）→ `reconcileRefund` 返回 `'SUCCESS'`；断言 refund SUCCESS、`activeOrderId` null、`order.refundedAmount === 100`、订单 REFUNDED、payment REFUNDED；再直接调 `finalizeRefundSuccess({ refundId })`（模拟回调后到）→ `refundedAmount` 仍 100；再 `reconcileRefund` → `'SKIPPED'`；`reconcileCount === 1`。
  2. **部分退款**：`actualAmount 300`、退款 100，SUCCESS → `refundedAmount 100`、订单状态仍 `PAID`（造单时 status 'PAID'）。
  3. **互斥（陈旧快照）**：先把一笔退款经用例 1 的路径推到 SUCCESS，再直接调 `markRefundClosed(id)` 与 `markRefundAbnormal(id)` 与 `markRefundFailed(id,'X','y')` → 三次之后行仍 SUCCESS、`activeOrderId` 仍 null、`refundedAmount` 不变；同时 monkeypatch `require('../src/services/notify').notifySystemAlert` 为计数桩，断言三次都**没有**告警。
  4. **并发占坑**：query 桩 `await new Promise(r => setTimeout(r, 50))` 后返回 PROCESSING，`Promise.all([reconcileRefund(id, q), reconcileRefund(id, q)])` → 结果恰为一个 `'PROCESSING'` 一个 `'SKIPPED'`，桩被调用 1 次，`reconcileCount === 1`。
  5. **CLOSED**：→ `'CLOSED'`，refund CLOSED、`activeOrderId` null、订单仍 REFUNDING；`notifySystemAlert` 桩收到 key `refund-closed:<id>`。
  6. **ABNORMAL**：→ `'ABNORMAL'`，`activeOrderId` 仍 = orderId；再 query ABNORMAL 一次 → 仍 `'ABNORMAL'` 但告警桩**不**新增（守卫 count=0）。
  7. **查询失败**：桩抛 `Error('boom')` → `'QUERY_FAILED'`，状态 PROCESSING 不变，`reconcileLastError === 'boom'`，`reconcileCount === 1`。
  8. **not_found**：PENDING 行 → `'FAILED'`，`errorCode === 'RECONCILE_NOT_FOUND'`、`activeOrderId` null；PROCESSING 行 → `'NOT_FOUND'`，状态不变，告警桩 key `refund-reconcile-notfound:<id>`。
  9. **金额不符**：桩 SUCCESS 但 amount 999 → `'AMOUNT_MISMATCH'`，状态不变、`refundedAmount 0`、告警桩 key `refund-reconcile-mismatch:<id>`。
  10. **扫描与告警**：三笔 PROCESSING（createdAt 各回拨 10 分钟；用 `prisma.refund.update` 改 `createdAt`），`reconcileStuckRefunds({ afterMin: 5, intervalMin: 5, batch: 2, alertAfter: 1, query: PROCESSING 桩 })` → 桩调用 2 次（限量）、两行 `reconcileCount 1`、告警桩收到 2 条 key `refund-reconcile-stuck:<id>`；紧接着再跑一次同参 → 桩只多 1 次（第三行；前两行在 5 分钟间隔内不重查）；`intervalMin: 0` 再跑 → 三行都被查。`afterMin: 5` 下 `createdAt = now` 的行不被扫。ABNORMAL 行：`abnormalIntervalMin: 0` 才被查，默认 60 不查（刚查过的）。
- [ ] 提交：`feat(server): T2 退款补查纯函数 reconcileRefund/reconcileStuckRefunds、mark* 条件写、refunds 加三列`

### T3 · scheduler 接线

- [ ] `apps/server/src/services/scheduler.ts`：`SchedulerOverrides` 加五个键（§3.1 第 5 条，带注释说明 e2e 传 0 的语义）；任务表在 `expireCoupons` 之后加 `['refundReconcile', () => reconcileStuckRefunds({ afterMin: overrides.refundReconcileAfterMin, intervalMin: overrides.refundReconcileIntervalMin, abnormalIntervalMin: overrides.refundReconcileAbnormalIntervalMin, alertAfter: overrides.refundReconcileAlertAfter, batch: overrides.refundReconcileBatch })]`；文件头任务列表注释补一条。
- [ ] `apps/server/src/routes/admin/system.ts` `run-scheduler`：透传五个 `num(body.xxx)`；`/status` 的 `order` 块加 `refundReconcile: { afterMin, alertAfter, batch }`。
- [ ] 提交：`feat(server): T3 退款补查接入 60s 心跳与 run-scheduler 覆盖键`

### T4 · e2e 分片 `scripts/e2e.d/68-refund-reconcile.sh`

- [ ] 变量前缀 `RR68_`。开头 `req POST /api/admin/system/pay-mock/reset "$AT" >/dev/null`。helper：
  - `rr68_stuck <full|partial> [status=PROCESSING]`：`O=$(make_paid_order)`；full 时 `sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e68' WHERE id=$O;"`；金额 full=`actualAmount`、partial=100；`sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at) VALUES (…, 'refund_${O}_e2e68_$RANDOM', …, '$status', 'WECHAT', $O, NOW(3), NOW(3));"`；echo `orderId<TAB>outRefundNo`。
  - `rr68_q <outRefundNo> <directiveJson>`：`POST /api/admin/system/pay-mock/refund-query`。
  - `rr68_calls`：`GET …/pay-mock/calls?op=queryRefund | jq length`。
  - `rr68_sched`：`sched '{"refundReconcileAfterMin":0,"refundReconcileIntervalMin":0,"refundReconcileAbnormalIntervalMin":0}'`（沿用 e2e.sh:46-57 的重试 helper）；断言 `.data.refundReconcile` 非 null。
- [ ] 用例（每条 assert 带编号文案）：
  1. 无指令：`rr68_sched` → 退款仍 PROCESSING、`reconcile_count=1`、`rr68_calls` +1、订单仍 REFUNDING。
  2. 全额 SUCCESS：指令 `{"kind":"ok","status":"SUCCESS"}` → 退款 SUCCESS、`active_order_id` NULL、订单 REFUNDED、`refunded_amount = actual_amount`、payment REFUNDED、`latest_refund` = SUCCESS；再 `rr68_sched` → `refunded_amount` 不变、`rr68_calls` 不增；`POST /admin/orders/$O/refund-complete` → 42204（与 e2e.sh:164 同）。
  3. 部分 SUCCESS：订单仍 PAID、`refunded_amount=100`；随后 `POST /admin/orders/$O/refund {"amount": actual-100}` mock 成功 → REFUNDED（可退余额正确）。
  4. CLOSED：退款 CLOSED、`active_order_id` NULL、订单仍 REFUNDING；随后 `POST /admin/orders/$O/refund {"amount": actual}` → code 0、mode mock、订单 REFUNDED（在途位确实释放）。
  5. ABNORMAL：退款 ABNORMAL、`active_order_id = O`；再排 SUCCESS + `rr68_sched` → SUCCESS、订单 REFUNDED。
  6. error 500：`{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}` → 仍 PROCESSING、`reconcile_last_error` 非空、`reconcile_count=1`；timeout 同理（count=2）。
  7. not_found：PENDING 行 → FAILED、`error_code='RECONCILE_NOT_FOUND'`、`active_order_id` NULL；PROCESSING 行 → 仍 PROCESSING、`reconcile_last_error` 含「查无」。
  8. 金额不符：`{"kind":"ok","status":"SUCCESS","amount":999}` → 仍 PROCESSING、`refunded_amount=0`、`reconcile_last_error` 含「金额」。
  9. 年龄阈值：新造行 + `sched '{"refundReconcileAfterMin":5}'`（其它默认）→ `rr68_calls` 不增；间隔：刚查过的行 + `sched '{"refundReconcileAfterMin":0}'`（intervalMin 缺省 5）→ 不增。
  10. 限量：两笔 PROCESSING + `sched '{…,"refundReconcileBatch":1}'` → calls +1；再一次 → +1。
  11. `GET /api/admin/system/status` 含 `order.refundReconcile.afterMin` 与 `timezone.ok=true`（T5 之后才有 `timezone`，T4 先写好断言，T5 完成后一起绿）。
  12. 收尾：`rr68_stuck` 造出的行不需要删（终态；下轮 `make_paid_order` 造新单），但**必须**把仍在途的行（用例 1/6/7/8/9/10 留下的 PROCESSING/PENDING）`sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no LIKE 'refund_%_e2e68_%' AND status IN ('PENDING','PROCESSING','ABNORMAL');"`，否则下一轮跑 e2e（或本地带心跳的服务）会一直查它们；`pay-mock/reset`。
- [ ] `scripts/e2e.sh` 头注释（:3-4）补一句：退款补查分片 68 依赖 `WECHAT_PAY_MOCK=true` 的 pay-mock 控制面。
- [ ] 提交：`test(e2e): T4 退款补查分片 68（五种结果 + 幂等 + 限量 + 阈值）`

### T5 · 时区钉死 + 自检 + 部署配置

- [ ] 新建 `apps/server/src/utils/timezone.ts`（§3.2 第 1 条三函数 + 常量 `TARGET_TZ='Asia/Shanghai'`、`TARGET_OFFSET_MIN=-480`；文件头注释引用 §2.8 的实测：赋错名会静默回 UTC，所以必须自检）。
- [ ] `apps/server/src/config.ts`：按 §3.2 第 1 条接入（pin 在 zod 之前，enforce 在 `isProduction` 之后、生产 mock 校验之前）；`config.timezone` 字段。
- [ ] `apps/server/src/app.ts`：启动日志与 boot 告警加时区行。
- [ ] `apps/server/src/routes/admin/system.ts` `/status` 加 `timezone` 块。
- [ ] `apps/server/ecosystem.config.js` `env_production` 加 `TZ: 'Asia/Shanghai'`，加注释「进程内 config.ts 已钉死，这里是第二道保险」。
- [ ] `scripts/deploy.sh:263` 改为 `pm2 reload ecosystem.config.js --env production --update-env`，上方注释写明原因（`pm2 reload <name>` 不读 ecosystem；fork 模式 reload=restart；自检失败会走到 :312 健康检查红）。
- [ ] 新建 `apps/server/scripts/selftest-timezone.ts`（无 DB；**运行时故意用 `TZ=Asia/Tokyo` 前缀**）：① 进程启动时 offset −540；`pinTimezone()` 返回 `{ previous:'Asia/Tokyo', overridden:true }` 且之后 `checkTimezone().ok === true`、`offsetMin === -480`、`resolved === 'Asia/Shanghai'`；② `process.env.TZ = 'Etc/UTC'` 后 `checkTimezone().ok === false`；`enforceTimezone({ isProduction: true, exit: 桩, log: 桩 })` → exit 桩收到 1、error 桩文案含「拒绝启动」；`enforceTimezone({ isProduction: false, … })` → exit 桩未调用、warn 桩收到；③ `process.env.TZ = 'Not/AZone'` → `checkTimezone().ok === false`（静默回 UTC 也能抓到）；④ 恢复 `pinTimezone()` 后 `parseLocalDayStart('2026-09-18')!.toISOString() === '2026-09-17T16:00:00.000Z'`（与 `selftest-local-day.ts:30-34` 同断言，证明 local-day 跟着进程时区走）。
- [ ] 提交：`feat(server): T5 进程钉死 Asia/Shanghai + 启动自检 + PM2/deploy 配置`

### T6 · 文档

- [ ] `docs/api.md`：
  - 3.5 `refund-complete`（:847-849）段末补「2026-09-21 起有自动补查（附录 L），此接口只作最后兜底」。
  - 附录 A 管理端表（:990 附近）加 `POST /api/admin/system/pay-mock/*`（仅 `WECHAT_PAY_MOCK=true`）与 `run-scheduler` 新键一句。
  - 新增 **附录 L：退款状态自动补查与服务端时区（2026-09-21）**：扫描范围/状态机表（查询结果 × 当前状态 → 动作）、幂等与互斥依据（引用 `refund.ts` 行号）、三列含义、env 三键、`run-scheduler` 五个覆盖键、pay-mock 控制面三个端点与指令形状、`/status` 新增 `order.refundReconcile` 与 `timezone`、`refunds` 行在既有接口响应里多出的三个字段（`GET /admin/orders/:id` 的 `refunds[]`）。
- [ ] `docs/deployment.md`：
  - 四、环境变量：`.env` 样例块「服务器」段后加三键（默认值 + 含义）；
  - 六、后续更新部署：说明 reload 改从 ecosystem 文件、`TZ` 在 ecosystem 里；
  - 九、回滚：加「时区自检拒绝启动时的处置」（症状：`pm2 logs` 出现 `[timezone] … 拒绝启动`；处置：`sudo apt install tzdata` / `timedatectl set-timezone Asia/Shanghai` 后 `pm2 restart`；或 `DEPLOY_REF=<上一版>` 回滚，回滚后旧版**不自检**，时区仍可能错着）；
  - 十二、常用运维命令：加 `curl -s localhost:3000/api/admin/system/status`（需 token）看 `timezone.ok`、`pm2 env <id> | grep TZ`；
  - 十三、监控与告警：告警表加「退款长时间未到账」「退款补查金额不一致」「退款补查：微信查无此单」三行（key、窗口、处置）。
- [ ] `docs/staff-guide.md:48` 改为：「显示『微信处理中』时不用管：系统从退款发起 5 分钟后开始，每 5 分钟自动去微信核对一次，核对到已退成功会自动变成『已退款』并推送『退款已到账』；微信那边关闭了会提示『可在后台重试退款』。**超过半小时**还没结果老板会收到『退款长时间未到账』告警，这时再到商户平台看退款记录；确认微信已退成功但后台没变，才点『手动标记完成』（邮寄列表）。」
- [ ] `.env.example:111-115` 块后加三键（注释掉、写默认值）。
- [ ] 提交：`docs: T6 退款补查与时区（api.md 附录 L、deployment.md、staff-guide.md、.env.example）`

---

## 6. 验收标准（04 机械核对只跑这里的命令；02 复核按这里判）

以下命令都在 worktree 根执行，环境变量见 §9。

### 6.1 静态

- [ ] `npx tsc --noEmit -p apps/server` 零错误。
- [ ] `git diff --name-only a3b76c2..HEAD` 的文件集合 ⊆ §7 白名单。
- [ ] `grep -rn "process.env.TZ" apps/server/src` 只命中 `utils/timezone.ts`（pin 只有一处）。
- [ ] `grep -n "status: 'SUCCESS'" apps/server/src/services/refund*.ts` 里写 SUCCESS 的只有 `finalizeRefundSuccess`（`refund.ts`）一处；`refund-reconcile.ts` 不直接写 `status`。
- [ ] `grep -c "prisma.refund.update(" apps/server/src/services/refund.ts` = 1（只剩 `initiateRefund` :268 那次预写 PROCESSING；三个 mark\* 都改成了 `updateMany`）。

### 6.2 自测（全部退出码 0）

- [ ] `cd apps/server && npx ts-node --transpile-only scripts/selftest-wechat-pay-query.ts`
- [ ] `cd apps/server && TZ=Asia/Tokyo npx ts-node --transpile-only scripts/selftest-timezone.ts`
- [ ] `cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-day.ts`（既有，不得变红）
- [ ] `cd apps/server && TZ=Asia/Shanghai WECHAT_PAY_MOCK=true DATABASE_URL=<§9 库> JWT_SECRET=<≥16> ADMIN_JWT_SECRET=<≥16> npx ts-node --transpile-only scripts/selftest-refund-reconcile.ts`
- [ ] `cd apps/server && npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/selftest-wechat-notify.ts`（既有单元模式，不得变红）
- [ ] 启动行为：`cd apps/server && TZ=Asia/Tokyo NODE_ENV=development PORT=3123 … npx ts-node --transpile-only src/app.ts` 的前 20 行日志含 `[timezone] 环境 TZ=Asia/Tokyo 已被覆盖为 Asia/Shanghai` 与 `[server] timezone: Asia/Shanghai (offset -480)`（用 `timeout 20` 起、`sleep 8` 后 curl `/health` 再 kill）。

### 6.3 迁移

- [ ] `cd apps/server && npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_URL" --exit-code`：退出码 0（零差异）。
- [ ] 迁移 SQL 只含 `ALTER TABLE refunds ADD COLUMN ×3`，无 DROP/MODIFY。

### 6.4 e2e（干净库全量）

- [ ] 按 §9 配方在 `food_shop_rtz` 上 `DB_NAME=food_shop_rtz BASE=http://localhost:3123 bash scripts/e2e.sh`：**不新增红**（基线 main `a3b76c2` 的已知偶发见 §9 末；对比方法：把失败行文案与 §9 已知偶发清单逐条比，不在清单里的红即算新增）；分片 68 全绿。
- [ ] 分片 68 里的**金额不变性**断言必须存在且绿：用例 2 的 `refunded_amount = actual_amount` 且第二轮不变；用例 3 的 `refunded_amount = 100` 且订单仍 PAID；用例 8 的 `refunded_amount = 0`。

### 6.5 行为

- [ ] `GET /api/admin/system/status` 响应含 `order.refundReconcile.{afterMin,alertAfter,batch}` 与 `timezone.{name,offsetMin,ok,overriddenFrom}`；生产路由树里**不存在** `/api/admin/system/pay-mock/*`（用 `WECHAT_PAY_MOCK` 未设的开发启动验证：**带 admin token** `POST /api/admin/system/pay-mock/reset` 返回 404；不带 token 拿到的是 401，与「路由不存在」无法区分，不算验过）。
- [ ] `run-scheduler` 响应含 `refundReconcile` 键。

### 6.6 回退验证（先提交，再在工作区临时改、跑、`git checkout --` 复原；结果写进回报，四处都要做）

- [ ] R1 去掉幂等守卫：`refund.ts:361` 的 `status: { not: 'SUCCESS' }` 临时删掉 → `selftest-refund-reconcile.ts` 用例 1「回调后到 refundedAmount 仍 100」**变红**（翻倍或超额）。
- [ ] R2 去掉互斥：`markRefundClosed` 临时改回无条件 `prisma.refund.update` → 用例 3 **变红**（SUCCESS 被改成 CLOSED）。
- [ ] R3 去掉占坑：`reconcileRefund` 的 CAS `where` 临时去掉 `reconcileCheckedAt: 旧值` → 用例 4 **变红**（桩被调 2 次）。
- [ ] R4 去掉 TZ 自检：`enforceTimezone` 里临时把 `!ok` 分支注释掉 → `selftest-timezone.ts` ② **变红**（exit 桩未被调用）。

### 6.7 上线后必须人工核的项（统筹方 / 店主做，执行方不做）

1. 部署后 `pm2 logs food-shop-server --lines 50` 看到 `[server] timezone: Asia/Shanghai (offset -480)`，**没有**「已被覆盖」警告（生产系统本就是上海时区）；后台登录后 `GET /api/admin/system/status` 的 `timezone.ok=true`（以日志与 `/status` 为准；`pm2 env $(pm2 id food-shop-server) | grep TZ` 只作参考——`pm2 reload --update-env` 对在线进程刷 env 依 PM2 版本而异，即使没刷上，进程内 pin 也保证行为正确）。
2. 观察一轮心跳：部署后 2 分钟内 `pm2 logs` 无 `定时任务 refundReconcile 失败` 告警；`SELECT COUNT(*) FROM refunds WHERE status IN ('PENDING','PROCESSING','ABNORMAL')` 在生产为 0（当前事实），任务空转。
3. **真实小额退款复现补查**（可选，店主同意才做）：用 `docs/ops-test-orders.md` 的测试单流程下一笔 ¥0.30 单并支付；在 nginx 上临时把 `location /api/wechat/pay/refund-notify` 改成 `return 503;`（先备份配置，`nginx -t && nginx -s reload`）；后台一键退款 → 退款单停在 PROCESSING（微信回调被 503 拒绝，微信会重试但都被拒）；等 5–6 分钟后看该行 `reconcile_count ≥ 1` 且状态翻成 SUCCESS、订单 REFUNDED、店员群收到「退款已到账」；随后恢复 nginx 配置 `nginx -s reload`；之后微信重推回调到达时应 ack 且 `refunded_amount` 不变（比对 `SELECT refunded_amount, actual_amount FROM orders WHERE id=…`）。整个过程微信重试窗口很长（首轮几分钟内多次），不会丢；若 30 分钟内没恢复 nginx，老板会先收到「退款长时间未到账」告警——那是预期。
4. 告警链路：把测试单的告警 key 与 `docs/deployment.md` 十三 表格对一遍，确认企微/PushPlus 收到的文案是本批新加的三种之一。

---

## 7. 白名单（精确到文件；新建标 ＋）

```
apps/server/src/services/wechat-pay.ts
＋apps/server/src/services/wechat-pay-mock.ts
＋apps/server/src/services/refund-reconcile.ts
apps/server/src/services/refund.ts                 （只允许改 markRefundAbnormal / markRefundClosed / markRefundFailed 三个函数；finalizeRefundSuccess、initiateRefund 不动）
apps/server/src/services/scheduler.ts
＋apps/server/src/routes/admin/pay-mock.ts
apps/server/src/routes/admin/index.ts
apps/server/src/routes/admin/system.ts
apps/server/src/config.ts
apps/server/src/app.ts
＋apps/server/src/utils/timezone.ts
apps/server/prisma/schema.prisma
＋apps/server/prisma/migrations/20260921000000_refund_reconcile/migration.sql
＋apps/server/scripts/selftest-wechat-pay-query.ts
＋apps/server/scripts/selftest-refund-reconcile.ts
＋apps/server/scripts/selftest-timezone.ts
apps/server/ecosystem.config.js
scripts/deploy.sh                                   （只允许改 :263 那一行及其上方注释）
scripts/e2e.sh                                      （只允许改头部注释 :3-4）
＋scripts/e2e.d/68-refund-reconcile.sh
.env.example
docs/api.md
docs/deployment.md
docs/staff-guide.md
docs/superpowers/plans/2026-09-21-refund-reconcile-and-tz.md   （执行方只允许在末尾追加「执行记录」段）
```

白名单外**零改动**。特别不许动：`apps/miniapp/**`、`apps/admin/**`、`apps/server/src/routes/wechat-notify.ts`、`apps/server/src/routes/orders.ts`、`apps/server/src/routes/admin/orders.ts`、`apps/server/src/utils/local-day.ts`、`apps/server/src/services/member/**`、`apps/server/scripts/selftest-local-day.ts`、`.claude/launch.json`、`package.json`/`package-lock.json`。

---

## 8. 上报触发条件（命中即停、回报、等统筹方裁定）

1. 需要改退款金额的任何计算（`remainingRefundable`、`LEAST(...)`、`deductPointsOnRefund` 的入参）。
2. `finalizeRefundSuccess` 无法按 §3.1 第 2.5 条原样复用（例如它的签名不够、或复用后自测 1/2 无法绿）。
3. 三个 mark\* 改条件写后，既有调用点（`refund.ts:285-292`、`wechat-notify.ts:380-382`、`routes/admin/orders.ts`）任一处需要跟着改。
4. `prisma migrate diff` 非零差异，或迁移里需要 DROP/MODIFY/回填数据。
5. Node 运行时改 `process.env.TZ` 在本机不生效（`selftest-timezone.ts` ① 红）——此时改为「PM2 注入 + 自检拒绝」单保险，需重规划。
6. 干净库 e2e 出现 §9 清单之外的红，且重跑一次仍红；或因 60s 心跳抢跑（本批服务端必须 `SCHEDULER_DISABLED=true`，若仍出现，报）。
7. 需要改小程序 / 后台前端才能完成任何一条验收。
8. 白名单外改动，或白名单内但注明「只允许改 X」的文件需要改 X 以外的部分。
9. `npx prisma generate` 与别的 agent 撞车（tsc 出现与本批无关的 Prisma 类型错误）——停下等，不要反复 generate。
10. `.env.example` 或 `docs/` 之外发现需要改的**生产**配置（nginx、systemd、crontab）。
11. 执行时间：单条命令超过 10 分钟仍无输出；全量 e2e 超过 25 分钟未结束。

---

## 9. 环境配方（执行方照抄）

```bash
cd /Users/yumingyi/food-shop/.claude/worktrees/refund-tz
git log --oneline -1            # 应为 a3b76c2 或其后本批提交

# 1) 本批专用库 + shadow 库（不要用 food_shop / food_shop_e2e）
docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "
DROP DATABASE IF EXISTS food_shop_rtz; CREATE DATABASE food_shop_rtz CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
DROP DATABASE IF EXISTS food_shop_rtz_shadow; CREATE DATABASE food_shop_rtz_shadow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON food_shop_rtz.* TO 'foodshop_user'@'%'; GRANT ALL ON food_shop_rtz_shadow.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"
export DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_rtz"
export SHADOW_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_rtz_shadow"
export JWT_SECRET=e2e_jwt_secret_0123456789 ADMIN_JWT_SECRET=e2e_admin_secret_0123456789

# 2) 迁移 + seed（T2 之后再跑一次 migrate deploy 把新迁移打上；generate 只在 T2 加列后跑一次，先确认没别的 agent 在跑）
(cd apps/server && npx prisma migrate deploy && npx prisma db seed)
(cd apps/server && npx prisma generate)

# 3) 起后端（3123；SCHEDULER_DISABLED=true 必带；TZ 前缀保留作双重保护）
cd apps/server && TZ=Asia/Shanghai PORT=3123 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true \
  LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true \
  npx ts-node-dev --respawn --transpile-only src/app.ts     # 用 run_in_background 起，起完 curl :3123/health

# 4) e2e（约 10 分钟，后台跑 + 轮询日志，别傻等）
cd /Users/yumingyi/food-shop/.claude/worktrees/refund-tz
DB_NAME=food_shop_rtz BASE=http://localhost:3123 bash scripts/e2e.sh > /tmp/e2e-rtz.log 2>&1
tail -3 /tmp/e2e-rtz.log; grep '✘' /tmp/e2e-rtz.log
```

- 跑 e2e 前确认主仓 `node_modules/.prisma/client/index.d.ts` 含 `reconcileCheckedAt`（`grep -c reconcileCheckedAt …`），否则是 generate 没生效或被别的 agent 覆盖。
- **已知偶发（基线，不算新增红）**：`e2e.d/42` B4-1 同用户 5 并发领券偶发 0 成功；`e2e.d/45` 打印机 4 条依赖执行顺序；真并发 pay+cancel 在服务端日志留 3 条「write conflict or a deadlock」但断言绿；§38 E 在本机偏移为 0 时跳过。执行前先在基线 `a3b76c2` 跑一次全量取本机基线红清单（同一台机、同一配方），写进回报。

---

## 10. 回滚说明（写进 deployment.md 九，也给统筹方）

- 代码：`DEPLOY_REF=<上一版 sha> bash /home/ubuntu/deploy.sh`。迁移是纯加列，回滚代码后三列闲置、无害。
- 时区自检把服务挡在门外时（`pm2 logs` 出现 `[timezone] … 拒绝启动`，`pm2 status` 为 errored）：先修环境（`timedatectl set-timezone Asia/Shanghai`、`ls /usr/share/zoneinfo/Asia/Shanghai` 存在、必要时 `apt install tzdata`），`pm2 restart food-shop-server`；修不了再 `DEPLOY_REF` 回滚——**回滚后旧版不自检，时区可能仍是错的**，要尽快修环境。
- `deploy.sh` reload 方式改回：把 :263 改回 `pm2 reload food-shop-server --update-env`；ecosystem 里的 `TZ` 留着无害。
- 补查任务想临时关：没有独立开关，`SCHEDULER_DISABLED=true` 会连其它任务一起关，不建议；真要关就回滚代码。

---

## 11. 给 02 复核（opus）的输入清单

只给：§1 需求、§3 设计决策、§6 验收标准、最终 `git diff a3b76c2..HEAD`。**不给** §2 推理、不给执行对话。复核输出每条标 [阻断/需改/建议] 并指明违反 §6 哪一条。

## 10. 统筹裁定（2026-09-21，01 在 T2 上报后）

**上报成立，责任在 00 规划**：`initiateRefund`（`services/refund.ts:268-276`）在微信同步返回 ABNORMAL/CLOSED 时**先把 `status` 直接写成目标值**，再调 `markRefundAbnormal/markRefundClosed` 只为触发通知；§3.1 把这两个函数改成「status 在 PENDING/PROCESSING（或 ACTIVE）内才写」后，这两处调用会命中 0 行直接返回，店员群与老板告警**每次必失**——确定性回归，不是竞态。§2.11 第 1 条「既有调用点状态都在守卫集合内」对 `refund.ts` 自身调用点判断错误。

**裁定：白名单放开 `initiateRefund` 的 `:268-288` 这一段，且只做下面这一种改法**（状态流转只在 mark*/finalize 一处发生，与 SUCCESS 分支既有做法一致）：
1. `:273` 的 `status: result.status === 'SUCCESS' ? 'PROCESSING' : result.status` 改为 **恒写 `'PROCESSING'`**（`wxRefundId/channel/wxResponseData` 照写）。注释同步改写：三种非 FAILED 结果都先落 PROCESSING，再由 `finalizeRefundSuccess / markRefundAbnormal / markRefundClosed` 完成到终态的**唯一一次**转移并发通知。
2. `:284-288` 的分派保持不变（现在 mark* 会命中 PROCESSING 行，条件写生效，通知照发）。
3. `catch` 里 `markRefundFailed` 分支不动（行仍 PENDING，守卫匹配）。
4. **不得**放宽 mark* 守卫来「兼容已是目标状态」——那会破坏补查幂等（`selftest-refund-reconcile.ts` 用例 6）。

**验收补（进 §6-A，04 也要核）**：
- 新增自测用例（放 `selftest-refund-reconcile.ts` 或现有退款自测）：mock `createRefund` 同步返回 ABNORMAL → 行终态 ABNORMAL、`notifyRefundResult` 与 `notifySystemAlert` **各恰好一次**；同步返回 CLOSED → 终态 CLOSED、通知各一次；同步返回 SUCCESS → 与改前逐字节一致（PROCESSING → finalize → SUCCESS）；`createRefund` 抛错 → FAILED、通知一次。四条都要「改坏验证」：把 `:273` 改回原写法 → ABNORMAL/CLOSED 两条用例必须红（通知 0 次）。
- `wechat-notify.ts:380-382` 回调路径与 `routes/admin/orders.ts` 调用点：用例证明行为不变（回调 ABNORMAL/CLOSED 到达时行是 PROCESSING → 命中 → 通知一次；回调重复到达 → 命中 0 行 → 不重复通知）。
- 回退验证 R1–R4 照旧。

**其它**：T2 迁移文件按原设计重新创建；执行结束前在本 worktree `npx prisma generate` 一次，使共享 client 与最终 schema 一致（上报里提到的三字段残留由此消掉）。主仓 `apps/server` 下那个 `ts-node-dev` 进程不是本批的，**不要碰**。

---

## 12. 执行记录（01 · sonnet，2026-09-21，统筹裁定后续做完）

分支 `claude/refund-reconcile-tz`，基线 main `a3b76c2`。六个提交：

| T | sha | 内容 |
|---|---|---|
| T1 | `38c2da0` | `queryRefund` + pay-mock 控制面 + 自测（17/17） |
| T2 | `4680230` | `reconcileRefund`/`reconcileStuckRefunds` + mark* 条件写 + `initiateRefund` 按统筹裁定改法 + `refunds` 加三列 + 自测（17/17，含统筹裁定补的 6 例） |
| T3 | `1de1c4c` | scheduler 接线（5 个覆盖键 + 任务表） |
| T4 | `ecd1cd8` | e2e 分片 68（69 条断言） |
| T5 | `8b1c434` | 进程钉死时区 + 启动自检 + PM2/deploy 配置 + 自测（9/9） |
| T6 | `f9b190b` | 文档（api.md 附录 L、deployment.md、staff-guide.md、.env.example） |

**A 类验收**：`tsc --noEmit` 全程零错误；`git diff --name-only a3b76c2..HEAD` 全部落在 §7 白名单；`grep "status: 'SUCCESS'"` 只命中 `finalizeRefundSuccess` 一处；`grep -c "prisma.refund.update("` = 1；`migrate diff --exit-code` 零差异（多次复核）；干净库 `food_shop_rtz` 全量 e2e **1886 通过 / 0 失败**（含分片 68 自身 69 条），**零红**（比「无新增红」的验收标准更强，未出现方案 §9 列出的任何已知偶发）。

**回退验证 R1–R5**：R1（`finalizeRefundSuccess` 去幂等守卫）→ 用例 1 的部分退款重放校验变红（200≠100，改成用不封顶的部分退款场景才能可靠抓到——全额退款场景会被 `LEAST()` 封顶掩盖，已在自测文件头注释记录这个坑）；R2（`markRefundClosed` 去互斥守卫）→ 用例 3 变红（SUCCESS 被改写成 CLOSED）；R3（`reconcileRefund` 去 CAS）→ 用例 4 变红（应 SKIPPED 的一路也变成 PROCESSING）；R4（`enforceTimezone` 去自检分支）→ `selftest-timezone.ts` ②③ 变红（exit 未被调用、无 warn）；R5（`initiateRefund:277` 改回统筹裁定前的写法）→ 用例 11/12（ABNORMAL/CLOSED）变红、用例 13/14（SUCCESS/FAILED）保持绿——四处 + 统筹裁定补的一处均按预期先红后绿。

**T2 上报的后续**：统筹裁定 `477b9ad` 采纳，`initiateRefund` 的 `:268-288` 段已按裁定改法落地（同步返回统一先落 `PROCESSING`，终态转移与通知下沉到 `finalizeRefundSuccess`/`markRefundAbnormal`/`markRefundClosed` 各自发生恰好一次）；未放宽 mark* 守卫。

**T4 排查记录**（未改变方案设计，纯执行期 bug）：分片 68 首次全量跑出 51 处红，根因是分片自身的 bash 语义坑——`IFS=$'\t' read -r a b <<<"$(fn)"` 这个写法里，临时 `IFS` 赋值会泄漏进 `$(fn)` 的求值期间；若 `fn`（这里是 `rr68_stuck`）内部经 `make_paid_order` 调用了认证请求，`req()` 里 `${t:+-H "Authorization: Bearer $t"}` 的空格分词会因为 `IFS` 缺空格而失效，`-H` 与值粘成一个 argv，curl 把它当带前导空格的 header 发出，触发 HTTP 折叠头语法，Node 的 `http` 解析器直接吐 400、不进 Express——故障表现是「shard 68 里所有认证请求返回空 body」。用一个隔离测试脚本单独跑分片 68（在同一 DB/server 上，不跑全量）+ 对比既有 `m1_login`（同样用 `IFS=$'\t' read < <(...)`，但内部只有匿名登录一次认证调用，且认证调用都写在 `read` 之外的独立语句里）才定位到。修法：把 12 处 `IFS=$'\t' read -r a b <<<"$(rr68_stuck …)"` 都拆成两条语句（先落 plain 变量，再单独一行 `IFS=$'\t' read`），与 `m1_login` 的既有写法一致。另有次生问题一并修掉：mock 支付不写 `payments.out_trade_no`（插入退款行时避免把 mysql 批处理模式下 NULL 的字面文本 "NULL" 当字符串插进本该是 NULL 的列）、NULL 判断统一改用 `col IS NULL` 而非裸 `SELECT col` 比较空串、`rr68_sched`（`intervalMin` 恒传 0，扫全表）需要每个让退款行停在非终态的用例结束时立即强制关闭该行，否则会被同批后续用例的 `rr68_sched` 捎带查一遍、污染那些用例自己的 `calls` 计数断言（原方案的 §5 T4 第 12 点只要求在分片末尾统一收尾，实测发现同批内部也需要）。

**未做的**：baseline（a3b76c2）对照跑 —— 未执行。理由：跑 baseline 需要在临时 worktree 里对 a3b76c2 的 schema 跑 `prisma generate`，会覆盖共享的 `node_modules/@prisma/client`（多个 worktree 共用同一份，参见仓库既有教训「worktree 共用 Prisma client」），有干扰其它并行 agent 的风险；而本分支自身的全量 e2e 已经是 **0 失败**（比「与 baseline 比对无新增红」这条验收标准更强的结果，逻辑上蕴含它），故未做这一步、只在此说明未做及理由，供统筹方判断是否需要补做。

**偏离**：
1. §6.1 静态检查「`grep -rn "process.env.TZ" apps/server/src` 只命中 `utils/timezone.ts`」实测命中两处：`utils/timezone.ts`（本批新增，pin 逻辑本身）与 `services/local-settings.ts:342`（**方案 §2.8 已核实的既有代码事实**，一条注释里提到这个字符串，非本批引入，`local-settings.ts` 不在白名单内不可改）。验收标准原文没有把这条既有注释算进去，按代码事实执行方无法让 grep 只命中一处；已如实记录，不影响功能正确性。
2. T4 分片 68 与既有回归对比未做「逐字节对齐 §9 已知偶发清单」（因为本次跑出的是 0 失败，没有红需要比对；§9 清单本身在本次运行里一条都没触发，这一情况方案里未预设，按「零红即满足」处理）。

**上线后必须人工核的项**（方案 §6.7，原样列出，执行方未做，供统筹方/店主留存）：
1. 部署后 `pm2 logs food-shop-server --lines 50` 看到 `[server] timezone: Asia/Shanghai (offset -480)`，没有「已被覆盖」警告；后台登录后 `GET /api/admin/system/status` 的 `timezone.ok=true`（以日志与 `/status` 为准；`pm2 env $(pm2 id food-shop-server) | grep TZ` 只作参考——`pm2 reload --update-env` 对在线进程刷 env 依 PM2 版本而异，即使没刷上，进程内 pin 也保证行为正确）。
2. 观察一轮心跳：部署后 2 分钟内 `pm2 logs` 无「定时任务 refundReconcile 失败」告警；`SELECT COUNT(*) FROM refunds WHERE status IN ('PENDING','PROCESSING','ABNORMAL')` 在生产为 0（当前事实），任务空转。
3. 真实小额退款复现补查（可选，店主同意才做）：下一笔 ¥0.30 测试单并支付；nginx 临时把 `/api/wechat/pay/refund-notify` 改 `return 503`；后台一键退款 → 停在 PROCESSING；等 5-6 分钟看 `reconcile_count ≥ 1` 且翻 SUCCESS、订单 REFUNDED、店员群收到「退款已到账」；恢复 nginx；微信重推回调应 ack 且 `refunded_amount` 不变。
4. 告警链路：把测试单的告警 key 与 `docs/deployment.md` 十三节表格对一遍，确认企微/PushPlus 收到的文案是本批新加的三种之一。

**收尾**：临时库 `food_shop_rtz`/`food_shop_rtz_shadow` 已删；`.selftest/` 下生成的临时密钥文件已 gitignore；起过的服务进程已停；`git status --porcelain` 干净；未合并、未部署。

## 13. 03 回判（fable，2026-09-21，02 opus 复核后）

02 结论「修完再合」：1 条需改 + 6 条建议。逐条回判：

| # | 02 发现 | 回判 | 处置 |
|---|---|---|---|
| 1 | [需改] `refund-reconcile.ts:92`/`:105` 两条告警没配 `windowMs`，落默认 5 分钟；对应状态永不自愈、每 5–6 分钟重查 ⇒ 每笔约 10 条/小时告警轰炸 | **成立**（我核过 `notify.ts:13` 默认 5 分钟、`:216` 同文件已配 6h） | 修补轮 F1 |
| 2 | [建议] `:207` detail 按 `fresh.status` 判，PENDING 行会被报成「查询失败: 」；且 `fresh` 已被并发推成 SUCCESS 时仍发「未到账」 | **成立**，且 PENDING 行正是补查最该救的一类 | 修补轮 F2 |
| 3 | [建议] ABNORMAL 行重查仍 ABNORMAL 时 mark* 命中 0 行，但仍计 `advanced` | **成立** | 修补轮 F3 |
| 4 | [建议] `local-settings.ts:342` 注释「仓库里没有任何地方固定 process.env.TZ」已过时 | **成立** | 修补轮 F4（白名单放开这一段注释，只改注释） |
| 5 | [建议] batch 20 × 15s 超时最坏 300s 拖住整轮心跳 | 成立但生产在途退款为 0、与既有 `reconcileExpressStale` 同范式 | **不进本批**，记后续计划 |
| 6 | [建议] e2e 68.11 注释承诺 timezone 断言没写；§6.5「不带 token 404」判据不严谨 | **成立** | 修补轮 F5；§6.5 已由统筹改文 |
| 7 | [建议] §6.7-1 `pm2 env` 可能假红 | **成立** | §6.7 与 §12 复印件已由统筹改文；`docs/deployment.md` 十二节同步一句（F6） |

### 修补轮清单（01 · sonnet，基线 `a6990af`，全部做完一次提交）

- **F1** `apps/server/src/services/refund-reconcile.ts:92`、`:105` 两处 `notifySystemAlert` 的 opts 补 `windowMs: ALERT_WINDOW_MS`（文件内已有的 6h 常量）。`docs/deployment.md:621-622` 限频列改「每退款单 6 小时一次」；`docs/api.md:2090`「限频窗口同 notifySystemAlert 默认 5 分钟」改「6 小时窗口内只发一次（与「退款长时间未到账」同）」。
- **F2** `refund-reconcile.ts:206-207`：跳过条件改为 `!fresh || fresh.reconcileCount < alertAfter || !['PENDING','PROCESSING'].includes(fresh.status)`（ABNORMAL 与所有终态都跳过）；`detail` 改按本轮 `outcome` 判：`outcome === 'PROCESSING' ? '微信侧仍处理中' : `查询失败: ${fresh.reconcileLastError ?? ''}``。
- **F3** `reconcileRefund` 在 `switch` 之后（返回 SUCCESS/CLOSED/ABNORMAL/FAILED 之前）重读一次 `status`，与函数开头拿到的 `refund.status` 相同则返回 `'SKIPPED'`（说明 mark*/finalize 命中 0 行，没有推进）。**不改** `finalizeRefundSuccess`/mark* 的签名。同步改 `reconcileRefund` 头注释。
- **F4** `apps/server/src/services/local-settings.ts:342` 一段注释改写为：进程时区已由 `utils/timezone.ts` 钉死 Asia/Shanghai，但这条校验仍保留——不让金额生效时刻依赖任何进程配置。只改注释，**不动**正则与逻辑。
- **F5** `scripts/e2e.d/68-refund-reconcile.sh` 68.11 补两条：`assert_eq "68.11 status.timezone.ok" "$(jq -r '.data.timezone.ok' <<<"$RR68_STATUS")" "true"`、`assert_eq "68.11 status.timezone.name" "$(jq -r '.data.timezone.name' <<<"$RR68_STATUS")" "Asia/Shanghai"`；注释去掉「T5 完成后才有意义」。
- **F6** `docs/deployment.md` 十二节 `pm2 env … | grep TZ` 那行后加一句：只作参考，以 `[server] timezone` 日志与 `/status` 的 `timezone.ok` 为准。

### 修补轮验收（02 二审 opus 与 04 haiku 都按这里）

- 自测新增/改动：`selftest-refund-reconcile.ts` 加三条用例：(a) ABNORMAL 行、微信仍返回 ABNORMAL → `reconcileRefund` 返回 `'SKIPPED'`、`reconcileStuckRefunds` 返回值不计入；(b) PENDING 行、微信返回 PROCESSING、`reconcileCount ≥ alertAfter` → 「退款长时间未到账」detail 含「微信侧仍处理中」、不含「查询失败」；(c) 行已 SUCCESS 但 `outcome === 'PROCESSING'`（并发场景，直接把行置 SUCCESS 再调 `reconcileStuckRefunds`）→ 不发「未到账」告警。**改坏验证**：F2 的跳过条件改回旧写法 → (c) 变红；F3 的重读去掉 → (a) 变红。
- 告警窗口：自测里对 `notifySystemAlert` 的桩记录 opts，断言 `refund-reconcile-notfound:*` 与 `refund-reconcile-mismatch:*` 两个 key 的 `windowMs === 6*60*60*1000`（用例 8/9 就地补断言即可）。改坏验证：去掉 F1 的一处 `windowMs` → 对应断言变红。
- 既有：`npx tsc --noEmit -p apps/server` 零错；五个自测脚本全绿；分片 68 单独跑全绿（不必全量 e2e，改动不触及其它分片；但 68.11 新断言必须在实跑输出里看到）。
- `git diff --name-only a6990af..HEAD` 只允许：`refund-reconcile.ts`、`local-settings.ts`、`selftest-refund-reconcile.ts`、`68-refund-reconcile.sh`、`docs/deployment.md`、`docs/api.md`、本方案文件（执行记录追加）。
- 不进本批（记后续计划）：补查 batch 默认值与最坏耗时。

---

## 14. 修补轮执行记录（01 · sonnet）

分支 `claude/refund-reconcile-tz`，基线 `a6990af`。提交 `b5a0b27`（`fix(server): 修补轮 F1–F6`）。

**F1–F6 改动**：
- F1：`apps/server/src/services/refund-reconcile.ts:113`（`refund-reconcile-notfound:*`）、`:124-125`（`refund-reconcile-mismatch:*`）两处 `notifySystemAlert` 补 `windowMs: ALERT_WINDOW_MS`（6 小时，文件内既有常量）；`docs/deployment.md:621-622` 限频列改「每退款单 6 小时一次」；`docs/api.md:2090` 措辞改「6 小时窗口内只发一次（与「退款长时间未到账」同）」。
- F2：`refund-reconcile.ts:225` 跳过条件改为 `!fresh || fresh.reconcileCount < alertAfter || !['PENDING','PROCESSING'].includes(fresh.status)`；`:229` detail 改按本轮 `outcome`（而非 `fresh.status`）判 `outcome === 'PROCESSING' ? '微信侧仍处理中' : 查询失败: ...`。
- F3：新增 `outcomeAfterMark(refundId, priorStatus, outcome)`（`refund-reconcile.ts:59-63`），在调用 `finalizeRefundSuccess`/`markRefundClosed`/`markRefundAbnormal`/`markRefundFailed` 之后重读一次 `status`：与调用前的 `refund.status` 相同则改报 `'SKIPPED'`（说明 mark*/finalize 命中 0 行，没有真正推进）。四处调用点：`:106`（FAILED，not_found+PENDING 分支）、`:142`（SUCCESS）、`:145`（CLOSED）、`:148`（ABNORMAL）；`reconcileRefund` 头注释（`:73-79`）同步改写。副作用：既有用例 6（`selftest-refund-reconcile.ts`）的断言依赖这个 bug（第二次查到仍 ABNORMAL 时旧代码错误返回 `'ABNORMAL'`），已同步改成断言 `'SKIPPED'`（`:364`）。
- F4：`apps/server/src/services/local-settings.ts:341-344` 注释改写——进程时区已由 `utils/timezone.ts` 钉死 Asia/Shanghai，这条格式校验仍保留作为「金额生效时刻」不依赖进程配置的最后一道防线；只改注释，正则（`ISO_DATETIME`）与逻辑未动。
- F5：`scripts/e2e.d/68-refund-reconcile.sh:189-193`（68.11）补两条断言 `status.timezone.ok`/`status.timezone.name`，去掉「T5 完成后才有意义」的过时说明。
- F6：`docs/deployment.md` 十二节 `pm2 env … | grep TZ` 代码块后加一段说明：只作参考，以 `[server] timezone` 日志与 `/status` 的 `timezone.ok` 为准。

**先红后绿**（三条新用例 + windowMs 断言，`apps/server/scripts/selftest-refund-reconcile.ts`）：
- 新增用例 17（对应验收 (a)）：ABNORMAL 行重查仍 ABNORMAL → `reconcileRefund` 返回 `'SKIPPED'`，`reconcileStuckRefunds` 的 `advanced` 不计入。
- 新增用例 18（对应验收 (b)）：PENDING 行本轮查得 PROCESSING、`reconcileCount` 达阈值 →「退款长时间未到账」detail 含「微信侧仍处理中」、不含「查询失败」；顺带断言 `r.status` 仍是 `'PENDING'`（证明旧 bug 的根因——PROCESSING 结果从不改 DB 的 status 字段）。
- 新增用例 19（对应验收 (c)）：`reconcileStuckRefunds` 的 `query` 桩在返回 PROCESSING 前先把该行直接 UPDATE 成 SUCCESS（模拟并发回调），验证不发「未到账」告警。
- windowMs 断言就地补进既有用例 8（PROCESSING→NOT_FOUND）与用例 9（AMOUNT_MISMATCH），并扩展 `notifySystemAlert` 桩记录结构为 `{title, key, windowMs, lines}`（原来只记 `{title, key}`，`lines` 是本轮新增，供用例 18 检查 detail 文案）。
- 先红：改代码前，先在 F1-F6 落地后跑一遍确认全绿（因为是同一次改动一起做的，没有单独跑「改代码前」的红）；随后按下面「改坏验证」逐项人为改回旧写法，实测各自变红，间接证明了「先红后绿」——用第一次全跑（未改 `WECHAT_PAY_MOCK`，见下）踩到的用例 6 意外变红（细节见「偏离」）也印证了 F3 语义变化的真实性。

**改坏验证**（四处，每处：临时改 → 跑 selftest → 见红 → `git checkout --` 复原 → 再跑绿；均在已提交 `b5a0b27` 之上操作，`checkout --` 复原到该提交而非基线）：
1. F1-a：去掉 `refund-reconcile-notfound` 那处 `windowMs` → 用例 8（PROCESSING→NOT_FOUND）断言「F1：查无此单告警应带 6 小时限频窗口」变红（`actual undefined` vs `expected 21600000`）→ 复原 → 绿。
2. F1-b：去掉 `refund-reconcile-mismatch` 那处 `windowMs` → 用例 9 断言「F1：金额不一致告警应带 6 小时限频窗口」变红（同上）→ 复原 → 绿。
3. F2：跳过条件改回旧写法 `!fresh || fresh.status === 'ABNORMAL' || fresh.reconcileCount < alertAfter`，detail 改回按 `fresh.status` 判 → 用例 18（detail 应含「微信侧仍处理中」，实际含「查询失败: 」）与用例 19（「行已被并发推成 SUCCESS，不应再发」，实际收到了该告警）**均**变红 → 复原 → 绿。
4. F3：`outcomeAfterMark` 改成直接 `return outcome`（去掉重读判断）→ 用例 6（`'ABNORMAL'` vs 期望 `'SKIPPED'`）与用例 17（同）均变红 → 复原 → 绿。

（回报里统筹方原话「四处改坏验证」与清单里明列的 F1/F2/F3 三条对不上——F1 本身有两个 `windowMs` 落点、两条独立断言，按「一条断言对应一处改坏」拆成 F1-a/F1-b，凑成四处，与 F2/F3 各一处一起覆盖了全部新增断言与改动点。）

**验收命令输出摘要**：
- `npx tsc --noEmit -p apps/server`：零错误（改完 F1-F6 后一次性过；中途踩过一次注释内 `mark*/finalize` 里的 `*/` 提前闭合 JSDoc 注释导致的连锁语法错误，已改写成 `mark* / finalize` 修掉，非既有代码问题，是本轮新写注释引入又在同一轮修掉）。
- `selftest-refund-reconcile.ts`（`TZ=Asia/Shanghai DATABASE_URL=food_shop_rtz2 JWT_SECRET=... ADMIN_JWT_SECRET=... npx ts-node --transpile-only scripts/selftest-refund-reconcile.ts`，**不带** `WECHAT_PAY_MOCK=true`——文件头注释明确要求不设，见「偏离」第 1 条）：`通过 20 / 失败 0`。
- `selftest-timezone.ts`（`TZ=Asia/Tokyo`）：`9 例通过`。
- `selftest-wechat-pay-query.ts`：`通过 17 / 失败 0`。
- `selftest-local-day.ts`（`TZ=Asia/Shanghai`，既有，未变红）：`9 例通过`。
- `selftest-wechat-notify.ts`（`--compiler-options '{"module":"CommonJS"}'`，既有，未变红）：`通过 12 / 失败 0`。
- 分片 68：一次性库 `food_shop_rtz2`/`food_shop_rtz2_shadow`（`prisma migrate deploy` 打上 25 个迁移含本批 `20260921000000_refund_reconcile`；`prisma db seed`；未跑 `prisma generate`——共享 `.prisma/client` 已含 `reconcileCheckedAt` 等三列，`grep -c` 命中 34 处，判定无需重跑）；服务端 3125 端口（`SCHEDULER_DISABLED=true EXPRESS_PROVIDER_MOCK=true WECHAT_PAY_MOCK=true` 等 mock 齐全）；因 `scripts/e2e.sh` 没有单分片过滤参数，写了一个一次性 wrapper（复刻 `e2e.sh` 里分片 68 依赖的最小前置：健康检查、admin 登录、user 登录+地址、选商品、`make_paid_order`/`order_status`/`latest_refund`/`req`/`code`/`ok`/`fail`/`assert_eq`/`sched`/`sql`，逐字抄自 `e2e.sh` 对应行，未手改语义），只 `source scripts/e2e.d/68-refund-reconcile.sh`：`通过 77 / 失败 0`，含 68.11 两条新断言（`status.timezone.ok`=true、`status.timezone.name`=Asia/Shanghai）与 §6.4 要求的三处金额不变性断言（68.2 `refunded_amount = actual_amount` 且再补查不变、68.3 `refunded_amount=100` 且订单仍 PAID、68.8 `refunded_amount=0`）。

**白名单比对**：`git diff --name-only a6990af..HEAD` = `apps/server/scripts/selftest-refund-reconcile.ts`、`apps/server/src/services/local-settings.ts`、`apps/server/src/services/refund-reconcile.ts`、`docs/api.md`、`docs/deployment.md`、`docs/superpowers/plans/2026-09-21-refund-reconcile-and-tz.md`、`scripts/e2e.d/68-refund-reconcile.sh`。逐一核对：前六个在 §13 回判清单内（`local-settings.ts` 由 F4 明确放开、限于注释）；`docs/superpowers/plans/...` 是本次追加执行记录。零白名单外改动。

**偏离**：
1. 首次跑 `selftest-refund-reconcile.ts` 时误照抄了 §6.2（T1 阶段旧验收命令）里的 `WECHAT_PAY_MOCK=true`，导致用例 11-14（`initiateRefund` 同步返回四态）全部变红（`config.mock.pay=true` 时 `initiateRefund` 直接走 MOCK 分支，永远到不了真正调用 `createRefund` 的 WECHAT 分支）——文件自己的头注释（写于 T2 之后）已经明确说明「不要设 `WECHAT_PAY_MOCK=true`」，§6.2 是更早写的、已被文件自身文档取代，去掉这个环境变量后问题消失，非代码 bug。回报里如实记录，供统筹方判断是否要点 §6.2 措辞。
2. 用例 6（既有）的第二个断言随 F3 一起改了（`'ABNORMAL'`→`'SKIPPED'`），因为它验证的正是 F3 修的那个 bug、原断言依赖旧行为——这不在 F1-F6 清单逐条列出的改动范围内，但属于「F3 语义变化后既有测试必然同步」的直接后果，且 `selftest-refund-reconcile.ts` 本就在白名单内。如与统筹方预期不符，可回退这处断言改动单独讨论。
3. §13 措辞「四处改坏验证」与清单里明列的 F1/F2/F3 三条存在数量对不上，按「F1 拆成两处（两个独立 windowMs 落点、两条独立断言）+ F2 一处 + F3 一处 = 四处」执行，覆盖了全部新增/改动断言，未跳过任何一条应验证的点。

**清理**：一次性库 `food_shop_rtz2`/`food_shop_rtz2_shadow` 已 DROP；3125 端口服务已停；`git status --porcelain` 为空。
