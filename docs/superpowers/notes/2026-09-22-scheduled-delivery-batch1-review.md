# 预约送达批次一（服务端）复核记录 · Opus 新会话

## 第一轮（6dde37e..d11abd0）
【工序】复核 【模型】Opus 5 (1M context) 【等级】L

结论：存在阻断项

复核范围：`6dde37e..d11abd0`（方案 Task 1–5）。Task 6–10 未实现，不在本次范围。
说明：我只收到了原始需求、方案、既有约束、diff、未跟踪清单与执行者「验证」栏 +「偏离方案」栏，**未**收到执行阶段的对话或执行者的设计解释。执行者输出中出现的一处编排者旁注（Task 2「裁决改为断言回落默认值」）我按事实核对了提交 `76a3ebe` / `0737874` 与当前测试文本，不采信其解释性叙述。

## 问题

### R1 [阻断/需改] 预约单秒退与「呼叫骑手」之间缺一道在途配送单守卫；方案所依赖的不变量不是原子成立的
位置：
- `apps/server/src/routes/orders.ts:1042-1058`（`PUT /orders/:id/cancel` 的 timed 秒退分支，条件写在 `:1049`）
- `apps/server/src/services/delivery/orchestrator.ts:279-282`（`callRider` 占位创建之后才写 `readyAt`）

触发条件：一张预约单处于 `PREPARING`、`now < selfCancelUntil`（顾客侧「取消订单」按钮仍在），店员同一时刻点「立即呼叫（force）」或「已备好」到点即呼。`callRider` 的三步 **不在同一事务里**：
1. `prisma.delivery.create(... activeOrderId: orderId ...)`（`orchestrator.ts:246-262`）—— 此刻已经有在途配送单；
2. `prisma.order.count(... status: 'PREPARING' ...)` 原子复核（`orchestrator.ts:273`）；
3. `prisma.order.updateMany({ where: { id: orderId, readyAt: null }, data: { readyAt } })`（`orchestrator.ts:281`）。

1 与 3 之间存在「有在途配送单但 `readyAt` 仍为 null」的窗口；进程在这两步之间崩溃时，这个状态会**持久**留下，不只是毫秒级竞态。

在该窗口内顾客的 `PUT /orders/:id/cancel` 走 timed 分支，其条件写是
`where: { id, status: { in: ['PAID','PREPARING'] }, readyAt: null, pickupReadyAt: null }`（`orders.ts:1049`），**不判有无在途配送单**，于是成功把订单翻成 `REFUNDING` 并 `rollbackOrderStock`。随后同一请求里的 `initiateRefund` 命中 42221（`services/refund.ts:108-112`：`deliveryType==='LOCAL'` 且存在 `activeOrderId=orderId` 的 Delivery），抛错后被 `orders.ts:1092-1097` 的 catch 吞掉，只发一条 `notifyRefundRequest` 店员通知。结果：**订单停在 REFUNDING、库存已回滚、退款没发起，而外呼在第 3 步之后继续执行，骑手单已经发出去**，需要人工收拾。

同段还有一个更小的问题：`orchestrator.ts:281` 的 `updateMany` 只判 `readyAt: null`，**没有 status 条件**，订单在第 2 步之后被翻成 `REFUNDING` 时仍会把 `readyAt` 写上去。

依据：
- 方案 Task 4 Step 7 原文：「`services/refund.ts` **不用改**：……42221「有在途配送单」守卫由不变量「有在途单 ⇒ readyAt 非空」保证不会命中（readyAt 非空时上面的条件写已经落空）」。该不变量在 `callRider` 中不是原子成立的（上面三步的顺序即证）。`selfDeliver`（`orchestrator.ts:557-571`）是在事务内写 `readyAt` 的，所以它没有这个洞；`callRider` 有。
- 仓库里已有现成范式可抄：`services/refund.ts:146-149` 的
  `const guard = { id: orderId, deliveries: { none: { activeOrderId: { not: null } } } }`，
  其注释原文即写明「这是 callRider 那侧原子复核的另一半……两侧不可能同时得手」。本次新增的 timed 秒退分支是**第一条**把 PREPARING 的 LOCAL 单翻成 REFUNDING 的顾客侧路径（改前顾客侧只能在 `PAID && !acceptedAt` 下秒退，而 `callRider` 要求 `PREPARING`，两者互斥），却没有带上这半道守卫。
- 影响面与等级：本任务定级依据即「关键一致性逻辑（事务、锁、幂等、并发）」，且落在退款/呼叫这条钱的链路上。

修复方向（均在授权范围内，不需动 `refund.ts`）：`orders.ts:1049` 的 where 补 `deliveries: { none: { activeOrderId: { not: null } } }`；`orchestrator.ts:281` 的 where 补 `status: 'PREPARING'`，或把 `readyAt` 并进占位创建那一笔事务里一起落。

### R2 [阻断/需改] `/ready` 写 `readyAt` 的 `updateMany` 没有判 `count`，违反方案 Global Constraints
位置：`apps/server/src/routes/admin/delivery.ts:146-148`

触发条件：店员点「已备好」的同一瞬间，顾客走 R1 那条秒退（或店员在别处改了状态），订单离开 `PREPARING`。`if (!o.readyAt) await prisma.order.updateMany({ where: { id, status: 'PREPARING', readyAt: null }, data: { readyAt } })` 命中 0 行，代码不看返回值继续往下走：若 `now < callAt`，端点照常 `success(res, { readyAt, called: false, callAt })` 返回 200，店员看到「已备好」已记录，而库里 `readyAt` 仍是 null。

依据：方案 Global Constraints 原文「状态流转一律 `updateMany` 带条件判 `count`，不用无条件 `update`」。同一文件里 `doAccept`（`delivery.ts:55-65`）、`orders.ts` 两个秒退分支、`selfDeliver` 都判了 `count`，只有这一处没判。实际损害有限（此时订单确实已不可备好），但这是本次方案明文列出的硬约束，且返回给店员的是一个假的成功。

### R3 [建议] `pickupAt` / `distanceM` 缺失时两个端点文案互相矛盾，顾客被卡成死循环
位置：`apps/server/src/routes/orders.ts:1045` 与 `apps/server/src/routes/orders.ts:922-927`

触发条件：`deliveryType='PICKUP'` 且 `pickupAt` 为 null，或 `deliveryType='LOCAL'` 且 `scheduledAt` 非空但 `distanceM` 为 null（数据异常，正常下单路径不产生）。
- `PUT /:id/cancel`：`canSelfCancelOf` 对这两种情况返回 false（`orders.ts:106`、`orders.ts:111`），统一抛「已临近约定时间，请改为『申请取消』由商家确认」；
- 顾客照做去 `POST /:id/cancel-request`：`cancelWindowOf` 同样因缺字段返回 closed，抛「当前可直接取消订单，无需申请」。

两条文案互相指向对方，顾客没有出路。改前的代码对这一种情况有专门文案与专门注释（BASE 版 `orders.ts` 该段：「`pickupAt` 缺失（不该发生，但别信数据完整性）……」→「订单数据异常，请联系商家协商退款」），本次合并分支时丢掉了。安全性没有退化（缺字段仍然拒绝秒退，不会掉进秒退分支），只是文案退化。

### R4 [建议] `distanceM` 为 null 的预约单点「已备好」后无人呼叫且无提示
位置：`apps/server/src/routes/admin/delivery.ts:149-159`

触发条件：预约单 `distanceM` 为 null。`const tl = o.distanceM === null ? null : scheduleTimeline(...)`，于是 `if (tl && ...)` 永远为假，端点返回 `{ readyAt, called: false, callAt: null }`，店员看到「已备好，等系统到点呼叫」，但按同一口径（`scheduleTimeline` 需要 `distanceM`）Task 6 的 `autoCallScheduled` 也算不出 `callAt`，这单会一直挂着。建议 `tl === null` 时要么直接呼叫、要么明确报错，不要静默返回 `called:false`。

### R5 [建议] 本段 diff 不可单独部署
位置：`apps/server/src/services/delivery/tasks.ts`（本段未改）

在 `d11abd0` 这个提交点上，现有任务 `autoCallRiders` / `remindLocalUncalled` / `autoRejectStaleCancelRequests` 还没有加 `scheduledAt: null` 过滤（方案 Task 6）。预约单一被接单，就会在 `acceptedAt + autoCallDelayMin` 被 `autoCallRiders` 自动呼叫，远早于 `callAt`，整条「到点才呼」的语义失效。已核实后续提交 `2f5197a` 已在同一分支落地 Task 6（不在本次复核范围），此条只是提醒：交付/部署必须以含 Task 6 的提交为准，不能把 `6dde37e..d11abd0` 单独上线。

## 已核实

验证命令（在当前工作树上运行；`git diff --stat d11abd0 HEAD` 显示其后只多了 Task 6 的 6 个文件，**Task 1–5 的 13 个文件自 `d11abd0` 起一字未改**，三个 selftest 只 import Task 1–5 的模块，结果对 `d11abd0` 成立）：

- `cd apps/server && npx tsc --noEmit` → 无输出，退出码 0（A1 ✓）
- `npx ts-node --transpile-only scripts/selftest-schedule.ts` → 「全部通过 14」，退出码 0（A2 ✓，N ≥ 14）。逐条核对覆盖面：六个倒推时刻取值、高峰取 `max(schedule.prepMinutes, peak.prepMaxMinutes)`、`schedule.prepMinutes` 更大时以它为准、开始备餐早于开门的格不出、暂停三形态（until 空 / until 有值 / 全停 → PAUSED）、休业（单日 / 全休）、DISABLED、`isValidDeliverySlot` 精确命中（含非整格、过期格）、phase 七态、`scheduleView` 两条 null 分支 —— 与验收标准 A2 要求的清单逐项对上。
- `npx ts-node --transpile-only scripts/selftest-pickup.ts` → 「全部通过 14」（A3 ✓）。测试文件本身未在本次 diff 中改动，故通过数与改前同源可比。
- `npx ts-node --transpile-only scripts/selftest-local-settings.ts` → 「全部通过 35」（A4 ✓），末尾三条为本次新增：默认值齐全、越界回落默认值、开通预约缺营业时间报错。第 2 条的断言口径（回落默认值而非夹取）经规划者裁决修正，已落在 `76a3ebe` / `0737874`，与 `local-settings.ts` 的 `int()` helper 及同文件 `perItemFen` 用例同口径 —— 属于修正错误的验收标准，不是放宽。
- `git grep -ln "scheduledAt" d11abd0 -- 'apps/server/src/**/*.ts'` → 4 个文件（`routes/admin/delivery.ts`、`routes/orders.ts`、`services/delivery/orchestrator.ts`、`services/delivery/schedule.ts`），全部在 `allow.txt` 内（A6 ✓）。
- 授权范围：本次 diff 共改 13 个文件，逐个比对 `allow.txt` 全部命中；`deny.txt` 的 `apps/admin/**`、`apps/miniapp/**`、`services/refund.ts`、`services/cancel-request.ts`、`routes/admin/system.ts`、`services/delivery/callback.ts`、`services/delivery/kd100.ts`、`scripts/e2e.sh`、`.env*` 及既有迁移目录一个都没被碰。新迁移目录 `20260922000000_order_scheduled` 不落在 `2026090*` / `2026091*` / `20260921*` 三条 deny glob 内。未跟踪文件清单为空，与 `untracked.txt` 一致。

代码层核实：

- **老路径逐字节不变**：`canSelfCancelOf` 对 EXPRESS 与 LOCAL 立即单等价于改前（改前：`status!=='PAID'||acceptedAt → false`，`deliveryType!=='PICKUP' → true`；改后：早返回 + 末行 `status==='PAID' && !acceptedAt`，真值表相同）；`cancelWindowOf` 对 EXPRESS / LOCAL 立即单落到原来的 `acceptGraceMin` 分支，未改；`PUT /cancel` 的 `else if (status==='PAID' && !acceptedAt)` 分支逻辑原样（只删了一行注释）。`POST /orders` 的 LOCAL 立即单分支在 `scheduled === null` 时四道校验的顺序与条件与改前一致。
- **`buildPickupSlots` 行为一致性**：改前 `slotsOfDay` 的可选判定是 `prepStartAt(s, startAt) < now → skip`，其中 `prepStartAt = pickupAt − (pickupPrepMinutes + pickup.acceptBufferMin)`；改后 `buildSlotDays` 用 `startAt − leadMinutesOf(startAt)*MIN < now`，`leadMinutesOf = pickupPrepMinutes + pickup.acceptBufferMin` —— 同一公式。`allHoliday` 等价于改前的 `days.length === 0`。`pickupSlotLabel`/`pickupTicketLabel` 改为 re-export，函数体与签名逐字相同。`PickupSlot`/`PickupDay` 改为类型别名，导出名与结构不变。
- **接单不重算 `estimatedDeliveryAt`**：`doAccept`（`delivery.ts:50-57`）对 `scheduledAt` 非空的单把 `estimatedDeliveryAt` 置 null，而落库那行是 `...(estimatedDeliveryAt ? { estimatedDeliveryAt } : {})`（BASE 就有，本次未改），因此**不会**把下单时写入的 `scheduledAt` 覆盖成 null。全仓 `estimatedDeliveryAt` 的写入点只有 `orders.ts:471`（下单）与 `delivery.ts:56`（接单）两处，没有第三处会为预约单重算。
- **`refund.ts` 确实不需要改**：通读 `initiateRefund`（`refund.ts:80-135`），只有 `REFUNDABLE_STATUSES`（含 `PREPARING`）、`fromRefunding` 全额、42221 在途配送单、42263 在途取件四道门，**不存在** spec §4.6 所说的「同城单 PREPARING 不允许秒退」守卫。`STOCK_HELD_STATUSES = ['PAID','PREPARING']`，PREPARING 秒退回滚库存的口径也对。方案差异裁定（把 spec 的「唯一要动 refund.ts 的地方」判为不需要动）经核实成立 —— 但见 R1：42221 这道门反而是本次新路径的暴露点。
- **错误码**：`42290`–`42292` 在 `apps/server/src` 下除本次新增的三处外无其他占用；`42293/42294` 未占用。
- **迁移**：`20260922000000_order_scheduled/migration.sql` 纯加 4 个可空列 + 1 个可空列 + 1 个索引，无 NOT NULL、无默认值回填、无数据改写，符合「回滚代码不需回滚库」。索引名 `orders_delivery_type_scheduled_at_idx` 与 Prisma 对 `@@index([deliveryType, scheduledAt])` 的默认命名一致（比照仓库既有 `orders_status_points_settled_at_completed_at_idx`、`categories_channel_status_sort_order_idx`），不会产生 schema drift。`Delivery.callOrigin VarChar(16)` 容得下 `SCHEDULED_AUTO`(14) 与 `MANUAL_EARLY`(12)。
- **端点可达性与鉴权**：`/ready` 挂在 `router.use('/local/orders', deliveryRouter)`（`routes/admin/index.ts:47`），位于 `verifyAdminToken`（`:32`）之后，实际路径 `POST /api/admin/local/orders/:id/ready`，与方案一致；`/delivery-slots` 与既有公开的 `/pickup-slots` 同一 router，公开无鉴权，符合 spec §4.2「公开」。
- **`/call` 守卫**：`scheduledCallGuard` 对非 LOCAL / 非预约 / `distanceM` 为 null 一律返回 `undefined` 放行，立即单链路零改动；`accept-and-call` 对预约单前置 42292，`callSchema` 只**新增**可选 `force`，老调用方不传即保持原行为。
- **`slotFilter` 的暂停语义**：`pausedUntil === null → date !== today`（当天全停、明天照出）、否则 `start >= pausedUntil`，与 spec §4.1 一致；`blocked=PAUSED` 只在「暂停且一格都排不出」时给出，`allHoliday` 优先，三种 blocked 的优先级 DISABLED → HOLIDAY → PAUSED 与 pickup 一致。
- **`earliestScheduleText` 的保守性**：用 `radiusKm * 1000` 作距离，而 `radiusKm` 本身是绕路后的口径（`local-settings.ts:1135` 用 `radiusKm / detourFactor` 反推直线半径，`billableDistanceM` = 直线 × `detourFactor`），故它确实是配送范围内的最坏路上时间，文案不会偏乐观。实测 `earliestScheduleText` 单次约 1.1 ms（100 次 118 ms，两段营业时间 × 2 天），`schedule.enabled=false` 时为 0 ms（提前返回），`/meta` 热路径的额外开销可接受。
- **`estimateArrival` 与预约单**：`subscribe-message.ts:193-205` 取 `max(now + 路上, estimatedDeliveryAt)`，预约单的 `estimatedDeliveryAt = scheduledAt`，「配送中」订阅消息的 ETA 不会比约定时刻更早，符合 spec §4.9。
- **`canSelfCancelOf` / `cancelWindowOf` 的四个调用点**（`orders.ts:890`、`:897`、`:922`、`:1045`）全部传整行 Prisma 订单对象，字段齐备，没有漏 select 的调用点（`tsc` 亦覆盖）。
- **顾客详情 `schedule` 节**：`pickedUp` 在 LOCAL 分支之前声明、分支内由最新一条 Delivery 的 `pickedUpAt` 赋值，`schedulePhase` 的 `LATE` 分支因此能正确让路给已取餐的单（selftest 第 12 条覆盖了 `pickedUp: true → CALLED`）。
- **spec §4.6 表格逐格对照**：立即单 / 邮寄不变 ✓；预约单 `canSelfCancelOf`「`now < selfCancelUntil`，PAID/PREPARING 均可，`readyAt` 空」✓；自取同口径且看 `pickupReadyAt` ✓；`cancelWindowOf` 两侧 ✓。唯一未逐字实现的是表格里「**无在途配送单**」这个条件 —— 实现靠「有在途单 ⇒ `readyAt` 非空」的不变量间接满足，而该不变量有洞，即 R1。

## 无法核实

- **验收标准 A5（`bash scripts/e2e.sh` 末行「失败 0」、§69 全 ✔、§62 仍全绿）**：按任务约束未跑 e2e（会写库），且 §69 属方案 Task 9、尚未实现。特别提示：本次把自取的自助取消截止从「开始备餐时刻（≈取餐前 25 分）」改成「取餐前 `selfCancelLeadMin`（默认 120 分）」，且 PICKUP 在 PREPARING 下也可秒退 —— §62 的现有断言几乎必然需要同步改，这一点在 Task 9 合入前无法判定是否做对。
- **验收标准 A7（`GET /api/local/meta` 实测）**：只做了代码层核实（`publicLocalMeta` 的 `delivery` 节新增 `scheduleEnabled` / `slotMinutes` / `selfCancelLeadMin`，`routes/local.ts` 以 `{ ...meta.delivery, earliestScheduleText }` 补第四个字段，老字段由展开保留），未起服务实发请求。
- **验收标准 A8（`docs/api.md` 附录 M）**：方案 Task 10，未实现，本次 diff 不含 `docs/api.md`。
- **Prisma 迁移在真实库上的执行结果**：按任务约束未跑 `prisma migrate` / `generate`。SQL 只做静态审阅。
- **方案差异裁定 ③④⑤⑥ 的落地效果**：③（`remindLocalUncalled` 排除预约单、`remindAcceptedStuck` 不改）、④（催备好按时间封顶）、⑤（超时告警改为限频窗口 60 分钟，与 spec 原文「只告警一次」不同，属可感知的运营语义变化，建议交付时向店主点一句）、⑥（第七态 `CALLED`，其纯函数部分已由 selftest 第 12 条覆盖）均落在 Task 6–8，本次范围内无法核实。
- **Task 1 执行者的「验证」栏为空**（材料里注明未按栏目书写）：其 diff 只含 `schema.prisma` 与迁移 SQL，我按上文做了静态核实，但没有该 Task 自身的运行证据。

## 第二轮与第三轮（6dde37e..667c089）
【工序】复核 【模型】Opus 5 (1M context) 【等级】L

结论：存在阻断项（仅 R6 一条，docs 层，改动量两行）

复核范围：完整 diff `6dde37e..2daefa5`（14 个提交，27 个文件），重点在自上轮 `d11abd0` 以来的新增部分（Task 6–10 + 修复提交 `2d8e561`）。R3/R4/R5 已由编排者记为「建议不安排修改」，本轮不重复。
说明：我收到的是原始需求、方案、既有约束、两份 diff、未跟踪清单（空）与执行者「验证 / 偏离方案 / 对复核问题的回应」三栏，**未**收到执行阶段的对话。执行者在「回应」栏对 R1/R2 的修法叙述我不采信其结论，只按 `2d8e561` 的实际代码独立判定（见下）。

## 问题

### R1 [已解决] 预约单秒退与「呼叫骑手」之间缺在途配送单守卫
位置：`apps/server/src/services/delivery/orchestrator.ts:240-246`、`apps/server/src/routes/orders.ts:1050`

核实结论：**已解决**，两侧都补上了，且补法与我给的方向一致。

- `callRider` 里写 `readyAt` 的 `updateMany` 已从「占位 `delivery.create` 之后 + 原子复核之后」（原 `:279-282`）挪到**占位创建之前**（`:240-246`，紧跟 `quotedAtForDelivery`、在 `// 占位事务` 注释之前），where 也从 `{ id, readyAt: null }` 补成 `{ id: orderId, status: 'PREPARING', readyAt: null }`。我按新顺序重走了两条交错：
  - 秒退事务在 readyAt 写入**之前**提交 → readyAt 的 `updateMany` 因 `status: 'PREPARING'` 落空（不再在 REFUNDING 上误写），随后 `delivery.create` 虽能建行，但 `:281` 的原子复核 `stillValid` 读到非 PREPARING → 占位被置 FAILED 并释放、抛 42204，**不会外呼**；
  - 秒退事务在 readyAt 写入**之后**尝试 → `orders.ts:1050` 的条件写因 `readyAt: null` 落空，秒退失败并报 42204，也不会翻成 REFUNDING。
  上轮那条「REFUNDING + 库存已回滚 + 骑手单已发出」的路径不再可达。
- `PUT /orders/:id/cancel` 的 timed 秒退分支条件写已补 `deliveries: { none: { activeOrderId: { not: null } } }`（`orders.ts:1050`），写法与 `services/refund.ts:149` 的既有范式逐字一致，覆盖「delivery 行已建但本进程尚未走到原子复核」这一更窄的中间态。
- 未动 `services/refund.ts`（deny 清单内）✓。

修复引入的新问题：无实质问题。只有一处很窄的行为变化值得记录、不构成需改：readyAt 现在写在 `callbackUrl.length > 50 → 42225`（`orchestrator.ts:252`）与 `delivery.create` 的 P2002 → 42228 这两个抛点**之前**，所以这两种失败会留下「readyAt 已写但没有配送单」。42225 是部署期配置问题（域名过长，生产已固定）；42228 意味着本就已有在途单、readyAt 按不变量早已非空。两者都不产生新的可达坏状态，且与方案原文「呼叫失败也保留 readyAt——店员表达过『好了』」一致。

### R2 [已解决] `/ready` 写 `readyAt` 的 `updateMany` 未判 count
位置：`apps/server/src/routes/admin/delivery.ts:148-157`

核实结论：**已解决**。现在是

```
const moved = await prisma.order.updateMany({ where: { id, status: 'PREPARING', readyAt: null }, data: { readyAt } })
if (moved.count === 0) {
  const now = await prisma.order.findUnique({ where: { id }, select: { status: true } })
  throw new AppError(42204, `订单状态为 ${now?.status ?? o.status}，仅备餐中订单可标记已备好`)
}
```

判了 count、命中 0 行时重读真实状态再报错，与同文件 `doAccept`（`:59-65`）的竞态文案范式一致，不再有「返回 200 但库里 readyAt 仍为 null」的假成功。符合方案 Global Constraints「状态流转一律 updateMany 带条件判 count」。修复未引入新问题：`o.readyAt` 非空时仍走幂等分支直接复用原时刻，不进这段。

### R6 [阻断/需改] `docs/api.md` 附录 M 插入位置把「服务端固定北京时间」附录的末段挤到了附录 M 名下
位置：`docs/api.md`（`2daefa5` 版文件末尾；新段落 `## 附录 M：同城预约送达（2026-09-21）` 之后紧跟到文件结尾）

触发条件：任何人阅读附录 M。附录 M 整块被插在**上一节的最后一段之前**，导致原属「服务端固定北京时间」一节的收尾段

> `GET /api/admin/system/status` 新增 `timezone: { name, offsetMin, ok, overriddenFrom }`……启动日志新增一行 `[server] timezone: Asia/Shanghai (offset -480)`……

现在出现在附录 M 的「### 错误码」表格**下面**，读起来像是预约送达附录的一部分；而时区那一节则丢了自己的收尾段。

依据：`git show 6dde37e:docs/api.md | tail -6` 与 `git show 2daefa5:docs/api.md | tail -20` 对照可见该段位置改变；`git diff` 的 hunk 头 `@@ -2107,4 +2107,69 @@` 也显示新增块插在该段之前。这是本次 diff 引入的文档结构错误，且验收标准 A8 正是对附录 M 的检查。修法：把 `## 附录 M …` 整块移到那一段之后（纯文档，两行位置调整，不涉及代码）。

### R7 [建议] READY_DUE 小条的「第 N 次提醒」在配置 ≥2 台 LOCAL 打印机时会成倍跳号
位置：`apps/server/src/services/delivery/schedule-tasks.ts:106`

触发条件：`printers` 里有 2 台及以上 channel 含 `LOCAL` 的打印机。`seq = (await prisma.printJob.count({ where: { orderId, kind: 'READY_DUE' } })) + 1`，而 `enqueueOrderTicket` 对**每台打印机各建一行 PrintJob**（`ticket/index.ts:356-372` 的 `for (const printer of printers)`）。两台机时，第 1 次提醒后 count=2，第 2 次算出 `seq=3`、第 3 次 `seq=5`，票面印「第 3 次 / 第 5 次提醒」而实际是第 2 / 第 3 次。

影响有限：封顶是按时间算的（`callAt + every × max`，计划差异④），不依赖这个计数，所以「封顶 5 张」不会因此失效；dedupeKey 仍唯一，不会漏打或重打。只是票面数字失真。当前生产只有一台飞鹅机（SN 222601993），不触发。若要修，改成按「本单已发生的提醒轮次」计（例如用 `distinct` 或按 `printerSn` 过滤）即可。
（顺带：同行注释「打印机关着时恒为 1，无副作用」与实现不符——未配置打印机时 `enqueueOrderTicket` 仍会建一行 SKIPPED（`ticket/index.ts:341-350`），count 照常递增，所以那种情况下 seq 反而是对的。注释可一并更正。）

### R8 [建议] 「已完成」列的排序被预约单打乱：`newestFirst` 对预约单失效
位置：`apps/server/src/routes/admin/workbench.ts:140-149`（`sortColumn`）与 `:206`（`sortColumn(cols.done, true)`）

触发条件：`cols.done` 里出现预约单。新加的这两行排在 `newestFirst` 判断**之前**：

```
const sa = a.local?.schedule?.prepStartAt ?? null, sb = b.local?.schedule?.prepStartAt ?? null
if (sa && sb) return sa.localeCompare(sb)
if (sa !== sb) return sa ? -1 : 1
```

于是在「已完成」列里：两张预约单之间按 `prepStartAt` **升序**（最旧在上），与该列「新在上」的既定口径相反；任一预约单恒排在同渠道立即单之前，而不是按完成时间。spec §6.1 的排序规则本意是给待接单/备餐中那几列的（「同渠道内预约单按 prepStartAt 升序排在立即单之前」），done 列不在其语义内。非预约单之间的相对顺序完全不变（两者 `sa`/`sb` 均为 null，直接落到原来的 `waitSince` 比较），所以现有自取/邮寄/立即单的排序没有回归。修法：`sortColumn` 里在 `newestFirst` 为真时跳过这两行。

### R9 [建议] WAITING 预约单被移出 `pending`/`preparing`，属于「改现有字段内容」；服务端先于后台前端上线且开关被打开时这些单在现行工作台上看不见
位置：`apps/server/src/routes/admin/workbench.ts:190`

触发条件：`schedule.enabled` 被打开、而 `apps/admin`（批次一后半）尚未上线。`if (sc?.phase === 'WAITING' && (status PAID|PREPARING) && !d) { cols.scheduled.push(...); continue }` 会把出票前的预约单从 `columns.pending` / `columns.preparing` 里摘走，放进新的 `columns.scheduled`。现行后台前端不认识 `scheduled` 这一列，这些单在工作台上既不在待接单列、也不在备餐中列，等于「消失」，直到 `ticketAt` 到点才重新出现。

这与方案 Global Constraints「工作台快照与管理端接口只**加字段**不改现有字段」在字面上冲突——新增 `columns.scheduled`、`scheduleEnabled`、`scheduleBar` 和卡片 `local.schedule` 都是加字段（合规），但把订单从既有列里摘走改变了既有字段的内容。spec §6.1 明确要求 WAITING 收进折叠分组，所以实现是对的，需要的是**上线顺序约束**：`schedule.enabled` 必须等后台前端（batch1b）上线之后才打开。开关默认关，正常流程不会踩到；建议写进交付报告的「店主要做」。

### R10 [建议] `scheduledAt` 非空但 `distanceM` 为 null 时，来单票/备餐票会印出两行空白字段
位置：`apps/server/src/services/ticket/index.ts:327-334`（`schedule` 为 null）与 `apps/server/src/services/ticket/content.ts:312、357-359`

触发条件：与上轮 R4 同一根因（预约单 `distanceM` 为 null，正常下单路径不产生）。`enqueueOrderTicket` 里 `schedule` 需要 `order.distanceM !== null` 才计算，为 null 时传 null；但 `toTicketInput` 仍无条件写入 `scheduledAt: order.scheduledAt`，于是 `content.ts` 的 `isScheduled = isLocal && !!o.scheduledAt` 为真，票面走预约分支印出

```
<B>送达 </B>
开始备餐  · 呼叫骑手 
```

且原来的「预计送达：…」行被这个分支挡掉。厨房联也会多一行 `<B>送达 </B>`。既然 R4 已按建议处理，这条一并归到同一处「`distanceM` 为 null 的预约单」收口里决定即可：要么在 `content.ts` 用 `isScheduled = isLocal && !!o.scheduledAt && !!o.scheduleSlotLabel`，要么从源头保证预约单必有 `distanceM`。

## 已核实

本轮亲自运行（工作树 HEAD = `2daefa5`，`git status --porcelain` 为空，与材料一致）：

- `cd apps/server && npx tsc --noEmit` → 无输出、零错误（A1 ✓）
- `npx ts-node --transpile-only scripts/selftest-schedule.ts` → 「全部通过 14」（A2 ✓，N ≥ 14）
- `npx ts-node --transpile-only scripts/selftest-pickup.ts` → 「全部通过 14」（A3 ✓，与 BASE 同一份未改动的测试文件）
- `npx ts-node --transpile-only scripts/selftest-local-settings.ts` → 「全部通过 35」（A4 ✓）
- `git grep -ln "scheduledAt" 2daefa5 -- 'apps/server/src/**/*.ts'` → 12 个文件，逐个比对 `allow.txt` **全部在白名单内**（A6 ✓）：`routes/{orders,local? — 无,wechat-notify,admin/delivery,admin/orders,admin/workbench}.ts`、`services/{scheduler,order-notify? — 无}.ts`、`services/delivery/{orchestrator,schedule,schedule-tasks,tasks}.ts`、`services/ticket/{content,index}.ts`。
- `git diff --name-only 6dde37e 2daefa5` → 27 个文件。其中 25 个在 `allow.txt` 内（含 `scripts/e2e.d/69-scheduled-delivery.sh`、`scripts/e2e.d/62-pickup.sh`、`docs/api.md`）。`deny.txt` 零命中：`apps/admin/**`、`apps/miniapp/**`、`services/refund.ts`、`services/cancel-request.ts`、`routes/admin/system.ts`、`services/delivery/{callback,kd100}.ts`、`scripts/e2e.sh`、`.env*`、`2026090*/2026091*/20260921*` 迁移目录均未被碰。

**范围提示（不是代码问题，但编排者跑 §2.5 范围检查时会命中）**：另外 2 个文件不在 `allow.txt` 里——`.agent/agent-protocol.md`（提交 `7dbc53a`「存入店主 2026-09-21 版多 agent 开发协议」）与 `docs/superpowers/plans/2026-09-21-scheduled-delivery-batch1-server.md`（提交 `0737874`「Task 2 裁决」）。两者都是流程/方案产物，按提交信息归属于编排者与规划者，不是执行者的实现改动；上轮给我的 diff 里被过滤掉了，这轮在完整 diff 中可见。交付报告里说明一下即可，不需要执行者撤回。

代码层核实（Task 6–10 新模块）：

- **五条任务的打标条件写**：`printPrepTickets` 先 `updateMany({ where: { id, prepTicketAt: null } })` 判 `count===0 → continue` 再动作 ✓；`remindScheduledNotReady` 两个分支都用 `{ id, readyAt: null, scheduleRemindedAt: <上次读到的值> }` 做乐观锁并判 count ✓。`remindScheduledUnaccepted` 用的是批量 `updateMany({ id: { in: … }, acceptRemindedAt: null })` 且不比对 count——与仓库既有的 `scheduler.ts:255-259` `remindUnacceptedOrders` **同一范式**（后者连 `acceptRemindedAt: null` 的再条件都没有），属沿用既有口径，不记为问题。
- **`remindScheduledNotReady` 的时间封顶与 `scheduleRemindedAt` 用法**：`exhaustAt = callAt + readyRemindEveryMin × readyRemindMaxTimes`；未到耗尽点时 `now - last >= every` 才出下一张；到耗尽点后用「`last >= exhaustAt`」判定告警是否已发过，发过即 `continue`，所以耗尽告警恰好一次、之后不再出小条。计划差异④（按时间封顶而非数 PrintJob 行）在实现里落实到位，与打印机关着时 PrintJob 可能不建行的前提自洽。
- **`repeatAnnounce` 锚点改动不影响老渠道**：`let anchor = order.paidAt.getTime()` 是默认值，只有 `deliveryType === 'LOCAL' && scheduledAt && localSettings` 三条同时成立才改写，`waitedMs = now - anchor` 对自取/邮寄/同城立即单与改前逐字相同（改前是 `now - order.paidAt.getTime()`）。自取那条既有的 `prepStartAt − 15 分钟` 门控位置与逻辑未动。预约单分支 `anchor = max(paidAt, acceptDueAt − localAfterMin)` 使首次播报恰好落在 `acceptDueAt`，并让票面「已等待 N 分钟」从接单截止起算而不是付款起算。`localSettings` 读失败时退回付款时刻，与紧邻的自取分支同一容错口径。
- **三种票的去重 seq**：`buildDedupeKey(orderId, kind, seq, sn)`（`ticket/index.ts:141`）。`PREP` 被加进了 `baseSeq = 0` 的常量分支（`:323`），去重键恒定 → 重复入队被唯一索引挡掉，与 §69 ⑧「PREP 作业只一张」的断言一致；`READY_DUE` 走显式 `opts.seq`，每次不同 → 每张小条都能落库（见 R7 的跳号说明）。`PrintJobKind` 联合类型已加两个字面量（`printer.ts:18`），历史 `RESUME` 等旧值保留未动。`isCancelKind` 只认 CANCEL/CANCEL_REQUEST，新 kind 不受 `printCancel` 开关影响 ✓。
- **工作台 `sortColumn` 与 `scheduled` 列归类**：`CHANNEL_RANK` 优先级未变；非预约卡片两侧 `prepStartAt` 均为 null，`sa !== sb` 为假，直接落到原 `waitSince` 比较，现有排序无回归（done 列的例外见 R8）。`WAITING && (PAID|PREPARING) && !d` 才进 `scheduled` 列，其余四列的 `toCard` 只多传了一个 `sc` 参数、既有字段一个没改。`scheduleBar` 从 `scheduled+pending+preparing` 中筛 `phase ∈ {WAITING, TICKETED}`、按 `prepStartAt` 取最近一张并给 `count`，与 spec §6.1 一致。`loadOrders` 用 `include` 无顶层 `select`，新列天然可读到。
- **现有任务排除预约单**：`tasks.ts` 三处 where 各加 `scheduledAt: null`（`remindLocalUncalled:100`、`autoRejectStaleCancelRequests:169`、`autoCallRiders:367`），`scheduler.ts:250` 的 `remindUnacceptedOrders` 加 `scheduledAt: null`。计划差异③「`remindAcceptedStuck` 不改」核实成立：该任务看的是配送单已被骑手接单之后的状态，与呼叫前的预约无关。
- **`autoCallScheduled` 失败不设上限**：与既有 `autoCallRiders`（`tasks.ts:374-382`）逐条对齐——同样是每轮 try/catch、`console.warn` 后跳过、不打标不退避。属沿用范式，不记为问题。它刻意不判 `isOpenNow`（已付款的预约单到点就得发出去）也不判 `schedule.enabled`（中途关开关不能把在途单卡死），两处取舍都正确。
- **`notifyLocalDeliveryAlert` 的 `windowMs` 透传**：`order-notify.ts:145-152` 新增可选 `windowMs` 并传给既有的 `shouldSendAlert(key, windowMs = ALERT_WINDOW_MS)`（`services/notify.ts:99`，签名本来就带这个参数，未改 notify.ts）。不传的既有调用点行为不变 ✓。`remindScheduledLate` 用 `{ key: 'sched-late:<id>', windowMs: 60 分钟 }` 落实计划差异⑤。
- **Task 8 的两条推送路径口径一致**：`routes/orders.ts` 的 mock 支付路径与 `routes/wechat-notify.ts` 的真实回调路径都算 `scheduleSlotLabel` 并传进 `notifyOrderPaid`，标题分支 `order.scheduleSlotLabel ? '📅 同城预约单 · … 送达' : '🛵 同城新订单'`（`order-notify.ts:54`）。执行者在 `wechat-notify.ts` 用的别名导入（`slotLabel as computeScheduleSlotLabel`）确实是为了躲开同文件既有局部变量 `slotLabel` 的遮蔽，不改任何对外字段名或文案——我比对了两处生成的标题字符串，一致。
- **`GET /admin/orders` 的 `schedule` 筛选**：`z.enum(['SCHEDULED','ASAP'])`，不传不过滤，`orderListSelect` 只**加**了 `scheduledAt/readyAt/prepTicketAt` 三个字段 ✓。
- **e2e §69 对照方案 §7.2 的行为清单**：逐条落实且有断言——未开通拒单（①，含非 LOCAL 传 `scheduledAt` → 40001）、开通、营业中约今天格与打烊时约明天格各一单（③④）、42291 非整格（③）、立即单不受影响（③ 落库 `scheduled_at IS NULL` + ④ 打烊仍 42222）、两小时外秒退与两小时内转申请取消（⑤）、已呼叫后 42229（⑥）、接单不改 `estimated_delivery_at`（⑥，用改前快照逐字比对）、接单并呼叫 42292（⑥）、过早呼叫 42292 与 `force` → `call_origin=MANUAL_EARLY` + `ready_at` 非空（⑥）、PREP 在 `ticketAt` 入队且只一张 + 第二轮 `schedPrepTicket=0`（⑧）、`acceptDueAt` 前不催不播报（`announce_count=0`、`accept_reminded_at IS NULL`）、之后才催并开始计数（⑧⑨）、已备好早于 `callAt` 不发单（`schedAutoCall=0` 且 `deliveries` 计数为 0）、到点自动呼 `SCHEDULED_AUTO`（⑦）、READY_DUE 每 3 分钟一张 + 耗尽后告警一次且不再出小条、再跑一轮不重复（⑩）、超时告警（⑪）、自取秒退截止改两小时（§62 ⑥）。**七个 phase 全部被断言覆盖**：WAITING/TICKETED/PREPPING（⑫）、READY_WAITING/CALLED（⑦）、CALL_DUE（⑩）、LATE（⑪）。另有方案清单之外的 ⑬「现有任务不碰预约单」（`autoCallRiders` 不呼、`remindLocalUncalled` 不催、`autoRejectStaleCancelRequests` 不自动驳回），正是计划差异③ 的验证。
- **§69 的时钟处理是真验证不是跑通**：`s69_pin` 从**详情接口返回的 schedule 节**反推 `scheduledAt` 与目标时刻的分钟差，再用 SQL 把 `scheduled_at` 钉到「让目标时刻 = now + 偏移」，没有在脚本里手算路上时间/备餐时长——也就是说断言校验的是服务端自己算出的时刻，而不是脚本与服务端各算一遍再比对。营业时段钉成 `00:00–23:59`、`daysAhead=1`，任何真实时钟下至少明天有格。收尾恢复设置、清 print_jobs、把未完结单置 CANCELLED 并释放 `active_order_id`，不污染后续段。所用 helper（`req/code/ok/fail/assert_eq/sched/sql/PJOBS/snap/lquote/mk_local_paid/col_has/LQDIST`）我逐个在 `scripts/e2e.sh` 里确认存在（`col_has` 在 `:1255`、`LQDIST` 在 `:539`、`snap` 在 `:1254`、`PJOBS` 在 `:1570`、`sched` 在 `:47`）。
- **§62 的改动确实只是口径同步 + 去抖，没有削弱断言**：`git diff 6dde37e 2daefa5 -- scripts/e2e.d/62-pickup.sh` 全文只有 3 处 `sql "UPDATE orders SET pickup_at=…"` 钉点与配套注释、1 条断言被**替换成两条**（原「付款后、开始备餐前自助取消 code 0」→ 现「距取餐不足两小时自助取消 42229」+「钉到 3 小时后自助取消 code 0」）。没有任何断言被删除或放宽，覆盖面反而比改前多一条。⑦ 段把 `pickup_at` 钉到 1 分钟前，在新口径下同样落在「窗口已关」一侧，原断言仍成立（只是该段标题「已到开始备餐时刻」现在是过时措辞，属文案，不记为问题）。
- **A8 内容完整性**：附录 M 覆盖 4 个新列 + `call_origin`、`schedule` 全部 9 个字段与 `selfCancelLeadMin` 的默认值与范围、12 条接口变化（含 `GET /api/local/delivery-slots`、`POST /admin/local/orders/:id/ready`、`GET /admin/orders` 的 `schedule` 参数、快照新增字段）、五条任务及其触发条件、现有任务排除预约单与 `repeatAnnounce` 锚点、两个新 `PrintJob.kind`、42290–42292 三个错误码。内容满足 A8 要求，只有插入位置有问题（R6）。

## 无法核实

- **验收标准 A5（`bash scripts/e2e.sh` 末行「失败 0」）**：按本轮任务约束我没有跑 e2e（会写库）。采信的是编排者以「命令 + 原始输出」形式转给我的事实：`DB_NAME=food_shop_e2e TZ=Asia/Shanghai bash scripts/e2e.sh` 在 `2d8e561` 上输出 `================ 通过 1986 / 失败 0 ================`，`§62`/`§69` 两段 `grep -c ✘` 均为 0。需要注意两点：(a) 该轮跑在 `2d8e561`，此后只多了 `2daefa5`（纯 `docs/api.md`），不影响 e2e 结论；(b) 需要 `TZ=Asia/Shanghai` 才能得到 0 失败——本机是 JST，脚本里 `date +%F` 在 JST 00:00–09:00 与服务端钉死的北京时间不同日，会让 §33/§54/§38 共 25 条「今日」口径断言假红。这是既有脚本的环境依赖（`scripts/e2e.sh` 在 deny 清单内、本次未改），但它意味着**验收标准 A5 的命令本身缺一个 `TZ=Asia/Shanghai`**，建议编排者在交付报告里把完整命令写清楚，免得下次复跑又踩。
- **R1 修复的并发回归**：两处守卫防的都是毫秒级交错，e2e 无法构造。§69 ⑥ 的「已呼叫后自助取消 42229」实际是被 `readyAt` 非空挡住的，**不会**走到新加的 `deliveries: { none: … }` 条件，所以这道守卫本身没有自动化覆盖。我只能靠代码路径推演确认它正确（见 R1）。
- **票面真机效果与语音**：执行者用临时脚本渲染的三段票面（预约来单票 / PREP / READY_DUE）我只能看文本，`<CB>`/`<B>`/`<CUT>` 在飞鹅真机上的实际排版、切刀位置与语音播报需按 spec §7.4 做真机验收。§69 ⑧⑩ 的断言只检查了关键字（「预约配送」「<B>送达 」「开始备餐 」「呼叫骑手 」「[未接单]」）与作业张数，没有断言 READY_DUE 的票面文案。
- **后台前端（batch1b）**：`columns.scheduled`、`scheduleBar`、卡片 `local.schedule`、`callOrigin` 的消费端不在本批，工作台六/七态的实际观感、倒计时条、「立即呼叫」二次确认都无法核实（另见 R9 的上线顺序提示）。
- **「超时告警只发一次」的限频窗口**：§69 ⑪ 只断言了 `schedLate >= 1`，没有验证 60 分钟窗口内不重复。`shouldSendAlert` 的记录是进程内存 Map，重启即失效，这点也没有覆盖。
- **Prisma 迁移在真实库上的执行**：按约束未跑 `prisma migrate` / `generate`；迁移 SQL 自上轮起一字未改，本轮仍只做静态审阅（上轮已核实索引命名与 Prisma 默认一致、纯加可空列）。

---

## 第三轮

【工序】复核 【模型】Opus 5 (1M context) 【等级】L

结论：无阻断项

复核范围：只看 `2daefa5..667c089`（一个提交 `667c089`「docs(api): 修复附录 M 错位插入导致服务端时区说明被挤到文末」，`docs/api.md` +2/−2），按编排者指定只判定 R6 是否已解决、修复是否引入新问题。R7–R10 已记为「建议不安排修改」，状态不变，本轮不重复。
说明：执行者报告我只读了「验证」与「对复核问题的回应」两栏，其结论不采信，下面的判定全部来自我自己跑的命令。

## 问题

### R6 [已解决] `docs/api.md` 附录 M 错位，把时区附录的末段挤到附录 M 名下
位置：`docs/api.md:2110`（段落现位置）、`docs/api.md:2112`（`## 附录 M` 标题）

核实结论：**已解决**，且修得干净。

最有力的一条证据是把本轮结果直接对回 BASE：

```
$ git diff 6dde37e 667c089 -- docs/api.md | grep '^@@'
@@ -2108,3 +2108,68 @@ actualAmount   = subtotal − pickupDiscount − promoDiscount − couponDiscoun
$ git diff 6dde37e 667c089 -- docs/api.md | grep '^-' | grep -v '^---' | wc -l
       0
$ git diff 6dde37e 667c089 -- docs/api.md | grep '^+' | grep -v '^+++' | wc -l
      65
```

**单一 hunk、0 行删除、65 行纯新增**。也就是说整个批次对 `docs/api.md` 的改动现在是纯追加：附录 L 原有的任何一行都没有被移动、改写或丢失，附录 M 整块接在文件末尾。上一轮 R6 报的「时区说明段被挤到附录 M 的错误码表之下」在 BASE 对比里已经不可能成立——真出现位移，这里必然同时有减行和加行。

结构与格式也逐行确认过（`awk` 打行号 + 空行标记）：

```
2105:[BLANK]
2106:[### 服务端固定北京时间]
2107:[BLANK]
2108:[进程启动时（`config.ts`，`dotenv` …]
2109:[BLANK]
2110:[`GET /api/admin/system/status` 新增 `timezone: …]
2111:[BLANK]
2112:[## 附录 M：同城预约送达（2026-09-21）]
2113:[BLANK]
```

时区说明段回到了「### 服务端固定北京时间」一节内、紧跟「PM2 侧 …… 作第二道保险。」之后；新的 `## 附录 M` 前后都有空行，Markdown 的标题/段落分隔正确，不会把标题渲染进上一段。行号与编排者提供的 `grep` 事实（2062 / 2106 / 2110 / 2112）完全一致。

文件收尾：`tail -c 1 docs/api.md | od -c` → `\n`，最后一行内容是附录 M 错误码表的 `| 42292 | … |`，没有留下多余空行、也没有丢掉结尾换行。

修复引入的新问题：无。

- `git diff --name-only 2daefa5 667c089` → 只有 `docs/api.md` 一个文件。
- 该文件不参与编译、不被任何运行时读取，所以第二轮已核实的 tsc（零错误）、三个 selftest（schedule 14 / pickup 14 / local-settings 35）与编排者转来的 e2e（`通过 1986 / 失败 0`，跑在 `2d8e561`）结论全部继续成立，无需重跑——本轮没有任何一行代码变化。
- 附录 M 正文未被本次提交触碰（diff 里对它只有上下文行），第二轮对 A8 内容完整性的核实（4 个新列 + `call_origin`、`schedule` 九个字段与 `selfCancelLeadMin` 的默认值与范围、12 条接口变化、五条任务、两个新 `PrintJob.kind`、42290–42292）保持有效。

## 已核实

- `git log --oneline -1` → `667c089`；`git status --porcelain` 为空（工作树干净，与材料一致）。
- `git diff --name-only 2daefa5 667c089` → `docs/api.md`，仅此一个文件。
- `git diff 6dde37e 667c089 -- docs/api.md` → 单 hunk、0 删除、65 新增（见上）。
- `docs/api.md` 第 2105–2113 行的标题/空行/段落结构；文件末字节为换行。
- 授权范围：`docs/api.md` 在 `allow.txt` 内；`deny.txt` 零命中。本轮未新增任何文件，未跟踪文件清单仍为空。

## 无法核实

- 无（本轮改动范围只有一个 Markdown 段落的位置，已全部亲自核对）。

（承上：R7、R8、R9、R10 仍为未修改的「建议」，R1、R2 保持已解决；第二轮「无法核实」栏里的项目——A5 未由我亲跑、R1 并发修复无自动化覆盖、飞鹅真机票面与语音、后台前端 batch1b、超时告警 60 分钟限频未断言、迁移未在真实库执行——本轮没有变化，仍然有效。）
