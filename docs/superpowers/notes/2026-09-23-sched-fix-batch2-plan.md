【工序】规划 【模型】Claude Fable 5.1 【等级】M

> **定级提示（§2.2 第 2 条，规划者标注「需升 L」）**：S1 的修法必须动 `orchestrator.ts` 两处一致性逻辑——`cancelDelivery` 的落库事务（取消费已真实扣付之后的那段事务）与 `callRider` 占位后的原子复核条件（`stillValid`）。这两处是并发防线与资金路径，属于「关键一致性逻辑」。建议编排者升 L（复核换 Opus、新会话）。方案本身按 M 写全，升级不需要改方案内容。
>
> BASE：ad316faefd6929fccede401a0af815120b9fa340（worktree 干净，`git status --porcelain` 为空；本机基线：`apps/server` tsc 0 错、`apps/admin` npm test 135/0、`scripts/selftest-schedule.ts` 17/0——均为本次实际运行结果）。
> 本批**零 schema 变更、零迁移**。任何步骤发现必须加列/改列，按「上报条件」停下。

---

## 0. 结论速览（S1–S10 逐条）

| 项 | 处置 | 一句话修法 |
|---|---|---|
| S1 人工取消后 60 秒内被自动重呼 | **必修** | 店员取消配送 = 撤回「已备好」：`cancelDelivery`（ADMIN 来源）同事务把预约单 `readyAt` 清空；`callRider` 的调度器自动呼叫在占位后原子复核 `readyAt` 仍非空。店员「已备好 / 立即呼叫 / 自己送」三键照常可用 |
| S2 已接单预约单每 5 分钟查价 | **必修** | `refreshStaleQuotes` 候选加 `scheduledAt: null`；呼叫前 `resolveCallProviders` 现查一次即可 |
| S3 「立即呼叫」弹窗迟到仍写「早于约定」 | **必修** | 文案抽成纯函数 `callNowConfirmText`，按 `etaIfCallNow` 与 `scheduledAt` 比较分「早于 / 已晚于约 N 分钟」 |
| S4 该呼叫却没呼出去卡片不变色 | **必修** | 服务端 `schedulePhase` 增加「有无在途配送单」输入：已备好 + 到点 + 无在途单 + 过 2 分钟宽限 → `CALL_DUE`；`autoCallScheduled` 对熔断/总开关关/非运力类失败按单发企微告警（10 分钟限频） |
| S5 总开关关掉后不呼叫且无告警 | **必修（与 S4 同源）** | 同上：`autoCallScheduled` 关着时仍扫到点的单并告警，不再静默 `return 0` |
| S6 最早时段单来单票后紧接备餐票 | **纳入** | `printPrepTickets`：`paidAt ≥ ticketAt` 的单只打标 + 企微，不再补出 PREP 票（来单票已含全部信息） |
| S7 票面 `<B>` 行超 16 列折断 | **纳入** | 三处放大行改排：送达日期普通字号 + 时段单独放大；备餐票时刻行拆两行；催备好小条去空格。自取票是否同修见待用户决定 |
| S8 「全部」+「尽快」把自取单算进去 | **纳入** | 服务端 `schedule=ASAP` 等价 `{ scheduledAt: null, deliveryType: 'LOCAL' }` |
| S9 后台只有 HH:mm 没日期 | **部分纳入** | 折叠组头 / WAITING·TICKETED 胶囊 / 倒计时条 / 详情三时刻：非当天加 `M-DD` 前缀（新纯函数 `fmtHHmmOrDate`）。倒计时条点击跳转（`scheduleBar.orderId` 未用）**不纳入** |
| S10 休业最后一天时段接口与下单矛盾 | **不纳入** | 与自取既有行为一致，改动要同时动自取与下单门禁，是独立的语义决定；记后续 |

---

## 验收标准

每条都要在最新代码上实际运行；「通过」必须附命令与输出末尾。所有命令在 worktree `/Users/yumingyi/food-shop/.claude/worktrees/sched-fix-batch2` 下执行（node_modules 解析到主仓，**不得运行 `prisma generate` / `prisma migrate dev`**）。

1. `cd apps/server && npx tsc --noEmit; echo exit=$?` → `exit=0`（基线 0）。
2. `cd apps/admin && npx tsc --noEmit; echo exit=$?` → `exit=0`。
3. `node scripts/check-admin-timezone.mjs; echo exit=$?` → `exit=0`（`utils/time.ts` 是唯一白名单文件，新增函数放它里面才能过）。
4. `cd apps/admin && npm test` → `fail 0`，`pass ≥ 135 + 新增`。新增测试必须覆盖（缺一条即不通过）：
   - `schedule.test.ts`：`callNowConfirmText` 三态——(a) `now < callAt − tolerance` → 以「早于该呼叫时刻（HH:mm），」开头且含「早于顾客约定的 HH:mm」；(b) `now ≥ callAt` 且 `etaIfCallNow > scheduledAt` → 含「已晚于顾客约定的 HH:mm 约 N 分钟」且**不含**「早于」；(c) `now ≥ callAt − tolerance` 且 `etaIfCallNow ≤ scheduledAt` → 含「早于顾客约定的」且不含「早于该呼叫时刻」。
   - `schedule.test.ts`：`scheduleCapsule` 在 `phase='CALL_DUE'` 且 `readyAt` 非空 → `{ text: '该呼叫未呼出 · 晚 N 分', cls: 'wb__wait--warn' }`；`readyAt` 为空 → 原文案「应已备好 · 晚 N 分」不变。
   - `schedule.test.ts`：`scheduleCapsule` WAITING/TICKETED 与 `scheduleBarText` 在 `prepStartAt` 不是上海当天时 → 文案里时刻形如 `M-DD HH:mm`（如 `9-23 11:16`）；当天仍是 `HH:mm`。
   - `time.test.ts`：`fmtHHmmOrDate(v, now)`：同上海日 → `HH:mm`；跨日 → `M-DD HH:mm`；无效输入 → `'--'`；跨零点用例（北京 23:30 与次日 00:30）必须判为不同日。
5. `cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-schedule.ts` → 「全部通过 N」，N ≥ 17 + 新增。新增断言（缺一条即不通过）：
   - `schedulePhase(tl, { readyAt, pickedUp:false, hasActiveDelivery:true }, callAt−10min)` → `'CALLED'`（提前呼出的单不再显示「等自动呼叫」）。
   - `schedulePhase(tl, { readyAt, pickedUp:false, hasActiveDelivery:false }, callAt+1min)` → `'READY_WAITING'`（两分钟宽限内，心跳还没轮到）。
   - `schedulePhase(tl, { readyAt, pickedUp:false, hasActiveDelivery:false }, callAt+2min)` → `'CALL_DUE'`。
   - `schedulePhase(tl, { readyAt, pickedUp:false, hasActiveDelivery:true }, callAt+4min)` → `'CALLED'`（原第 106 行用例改为显式传 `hasActiveDelivery:true`，不得删掉）。
   - `schedulePhase(tl, { readyAt:null, pickedUp:false, hasActiveDelivery:false }, callAt+4min)` → `'CALL_DUE'`（原口径不变）。
   - `scheduleView(..., now, pickedUp, hasActiveDelivery)` 第 5 参缺省 `false` 时原有断言全部不变。
6. `cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-ticket-schedule.ts`（新文件）→ 全部通过。必须覆盖：
   - `renderOrderTicket` 预约来单票（`scheduleSlotLabel='10月22日（周四）12:00–12:30'`、`schedulePrepStart='11:16'`、`scheduleCall='11:36'`）：所有 `<B>…</B>` 段显示宽度 ≤ 16（宽度规则：码点 > 0xff 记 2，否则 1）；票面含普通行 `送达 10月22日（周四）` 与放大行 `<B>12:00–12:30</B>`；厨房联同样含这两行；仍含 `开始备餐 11:16 · 呼叫骑手 11:36`。
   - `renderOrderTicket` 备餐票（`prep:{unaccepted:true}`）：含 `<B>11:16 开始备餐</B>` 与 `<B>11:36 前备好</B>` 两行，含 `<CB>[未接单]</CB>`，所有 `<B>` 段 ≤ 16。
   - `renderReadyDueTicket({ call:'11:36', … })`：含 `<B>应于11:36前备好</B>`，所有 `<B>` 段 ≤ 16。
   - 反例：把 33 列的老写法字符串直接喂给宽度函数应得 33（证明宽度函数本身能证伪）。
7. 全量 e2e（本批专用库与端口）：
   - 建库：`docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "CREATE DATABASE IF NOT EXISTS food_shop_e2e_b2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_e2e_b2.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"`；迁移与 seed 同 food_shop_e2e 配方（`DATABASE_URL=mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e_b2 npx prisma migrate deploy` + `… npx prisma db seed`，在 `apps/server` 下；**只准 migrate deploy，不准 migrate dev**）。
   - 起服务（launch.json `api-e2e-3106` 改端口与库名）：`cd apps/server && TZ=Asia/Shanghai PORT=3107 DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e_b2" WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true npx ts-node-dev --respawn --transpile-only src/app.ts`（3107 当前空闲，已 lsof 核实）。
   - `TZ=Asia/Shanghai BASE=http://localhost:3107 DB_NAME=food_shop_e2e_b2 bash scripts/e2e.sh` → 末尾 `FAIL=0`，`PASS ≥ 2275 + 新增条数`；既有 §69 全部断言原样通过（不得改其期望值）；新增 `scripts/e2e.d/72-scheduled-fix-batch2.sh` 的断言清单见「实现方向 §E」，每条都要在输出里看到 ✔。
8. 人工检查（无法命令判定的两项，执行者用 admin dev server 对着 3107 走一遍并截图/描述）：
   - S3：预约单到点未备好（`CALL_DUE`）点「立即呼叫」→ 弹窗正文写「现在呼叫预计 HH:mm 送达，已晚于顾客约定的 HH:mm 约 N 分钟」，不再出现「早于顾客约定」。
   - S4：已备好、到点 2 分钟以上、无在途单的预约卡（e2e §72 ⑤ 造出的单）→ 卡片橙色、胶囊「该呼叫未呼出 · 晚 N 分」、按钮只有「立即呼叫」「自己送」。

---

## 实现方向

### A. S1 店员取消配送 = 撤回「已备好」（预计涉及：`apps/server/src/services/delivery/orchestrator.ts`、`tasks.ts`、`routes/admin/delivery.ts`、`docs/api.md`）

现状核实（本次读代码）：`readyAt` 全仓只有三处写入（`routes/admin/delivery.ts:157`、`orchestrator.ts:245`、`:574`），无清空；`cancelDelivery`（`orchestrator.ts:462-511`）只改配送单 + `activeOrderId: null`，订单仍 PREPARING；`autoCallScheduled`（`schedule-tasks.ts:120-124`）条件立刻再次满足。工作台取消弹窗文案（`Workbench.tsx:597`）承诺「你可以重新呼叫或改自己送」。

1. `cancelDelivery` 入参加 `source?: 'ADMIN' | 'SCHEDULER'`（缺省 `'ADMIN'`，与 `callRider` 同名同义）。`tasks.ts:332` 升级路径显式传 `source: 'SCHEDULER'`（升级是「撤 D-1 立刻建 D-2」，店员没有表达过「不要骑手」，`readyAt` 必须保留）。`routes/admin/delivery.ts:317` 不传即 ADMIN。
2. 在 `cancelDelivery` 的 `$transaction` 里、`rollbackOrderAfterCancel` **之后**（SHIPPED 回退 PREPARING 也要覆盖）增加一条条件写：
   `source === 'ADMIN'` 时 `tx.order.updateMany({ where: { id: orderId, deliveryType: 'LOCAL', scheduledAt: { not: null }, status: 'PREPARING', readyAt: { not: null } }, data: { readyAt: null } })`。立即单（`scheduledAt` 空）恒不命中，零影响。命中 1 行时事件文案追加「【已撤回「已备好」，到点不再自动呼叫】」（`recordDeliveryEvent` 的 `statusDesc`）。
3. `callRider`：`source === 'SCHEDULER' && input.origin === 'SCHEDULED_AUTO'` 时（只有 `autoCallScheduled` 这一处这样调）：
   - 跳过 `:244-246` 的 `readyAt` 预写（调度器不得替店员「重新表达已备好」）；
   - `:254` 的 `stillValid` 计数条件追加 `readyAt: { not: null }`。这样「心跳已加载候选 → 店员取消提交 → 心跳走到呼叫」这段毫秒级窗口里，占位建好后原子复核会发现 `readyAt` 已空，按既有 RACE 形状释放占位并抛 42204，绝不外呼。`ready` 端点走的是 `source:'ADMIN'` + `origin:'SCHEDULED_AUTO'`，不受影响（它刚写完 `readyAt`）。
4. 连带影响（**必须写进代码注释与 `docs/api.md` 1140 行那一格**）：
   - `schedulePhase`：取消后 `readyAt` 空 → `now ≥ callAt` 时 `CALL_DUE`（橙、按钮「已备好 / 立即呼叫 / 自己送」）；`now < callAt`（提前呼叫后又取消）→ `PREPPING/TICKETED`，到点走催备好流程。三键路径核实：`/ready` 在 `readyAt` 空且 `now ≥ callAt` 时写 `readyAt` 并立即 `callRider`（`delivery.ts:154-169`）；`/call?force` 经 `scheduledCallGuard`（`now ≥ callAt − tolerance` 放行）→ `callRider` `:244` 重写 `readyAt`；`/self-deliver` `:574` 重写 `readyAt`。
   - 提醒任务：`remindScheduledNotReady` 会把这张单当「应已备好未确认」催（企微 + READY_DUE 小条，每 `readyRemindEveryMin` 一张、封顶后告警一次）。这是取消之后唯一在 LATE 之前的提醒，文案略不准（见待用户决定 D2）。`remindScheduledLate`（`schedule-tasks.ts:142`）文案分支会落到「未备好、未呼叫骑手」，不改。
   - 顾客端：`routes/orders.ts:114/142` 以 `readyAt` 为「已备好后关闭取消」的依据，清空后：过了 `selfCancelUntil` 的单重新允许「申请取消」（店员需驳回或退款，与「无在途单、订单悬置」的事实相符）；只有在提前呼叫又取消、且仍早于 `selfCancelUntil` 的极端情况才会重新允许秒退。
   - 票据：无影响（`prepTicketAt`、PrintJob 均不看 `readyAt`）。
   - 骑手方撤单（回调 720，`callback.ts`）**不走** `cancelDelivery`、不清 `readyAt`：骑手放鸽子由系统到点自动重呼，这是有意的区分，e2e §72 ② 用它做对照。
5. `docs/api.md`：`POST /:id/delivery/cancel` 一格补一句「预约单：店员取消即撤回「已备好」（`readyAt` 置空），系统不再自动呼叫；重新呼叫走「已备好 / 立即呼叫」，改自送走 `self-deliver`。调度器自动升级的取消不清」。

### B. S2 报价保鲜排除预约单（预计涉及：`tasks.ts:206-216`、`docs/api.md`）

`refreshStaleQuotes` 的 `where` 加 `scheduledAt: null`，jsdoc 补一句理由：预约单从接单到呼叫可能隔十几小时，每 5 分钟把收件人姓名电话发给运力方毫无用处；呼叫前 `resolveCallProviders`（`orchestrator.ts:170-182`）见快照过期会同步现查一次。接单时那一次 `kickOffQuote`（`delivery.ts:99`）**不改**（见待用户决定 D4）。`docs/api.md` 的 `localQuoteRefresh` 任务说明（若有）同步注明「不含预约单」。

### C. S3 「立即呼叫」确认文案（预计涉及：`apps/admin/src/utils/schedule.ts`、`schedule.test.ts`、`pages/Workbench.tsx:1924-1928`）

`utils/schedule.ts` 新增纯函数 `callNowConfirmText(sc: ScheduleInfo, now: number): string`：
- `eta = Date.parse(sc.etaIfCallNow)`、`sched = Date.parse(sc.scheduledAt)`；
- 前缀：`isBeforeCallWindow(sc, now)` 为真时 `早于该呼叫时刻（${fmtHHmm(sc.callAt)}），`，否则空；
- `eta ≤ sched` → `${前缀}现在呼叫预计 ${fmtHHmm(eta)} 送达，早于顾客约定的 ${fmtHHmm(sched)}。`；
- `eta > sched` → `${前缀}现在呼叫预计 ${fmtHHmm(eta)} 送达，已晚于顾客约定的 ${fmtHHmm(sched)} 约 ${Math.ceil((eta − sched)/60000)} 分钟。`
- `Workbench.tsx:1926` 改为 `${callNowConfirmText(sc, now)}向快递100 发单，骑手会来店里取货。`；`utils/*.ts` 不得 import `.tsx`（既有约束）。`etaIfCallNow` 来自快照（≤10 秒旧），不在前端重算。

### D. S4 + S5 「该呼叫却没呼出去」可见且有告警（预计涉及：`services/delivery/schedule.ts`、`schedule-tasks.ts`、`routes/admin/workbench.ts:195`、`routes/admin/orders.ts:313`、`routes/orders.ts:896`、`scripts/selftest-schedule.ts`、`apps/admin/src/utils/schedule.ts` + 测试、`docs/api.md`）

1. `schedule.ts`：新增常量 `CALL_GRACE_MS = 2 * MIN`（两跳心跳；到点后 2 分钟内没呼出去属正常排队，不点亮）。`schedulePhase(tl, o: { readyAt; pickedUp; hasActiveDelivery: boolean }, now)`：
   ```
   if (!o.pickedUp && t > scheduledAt) return 'LATE'
   if (o.readyAt) {
     if (o.hasActiveDelivery) return 'CALLED'
     return t < callAt + CALL_GRACE_MS ? 'READY_WAITING' : 'CALL_DUE'
   }
   （其余四态不变）
   ```
   `scheduleView(s, order, now, pickedUp = false, hasActiveDelivery = false)` 透传。**phase 枚举不加新值**：小程序（本批禁改）读 `schedule.phase`，全仓 grep 未见小程序使用 `phase` 字段，但不加新值是零风险选择。
2. 三处调用补第 5 参：
   - `workbench.ts:195`：`!!d`（`byOrder` 对未完成单只含在途单；已完成单补回的是最后一张，done 列胶囊本就返回 null，无影响）。
   - `routes/admin/orders.ts:313`：详情前多查一次 `prisma.delivery.findFirst({ where: { activeOrderId: id }, select: { pickedUpAt: true } })`（仅同城预约单才查），同时把 `pickedUp` 一并传对（现在缺省 false）。
   - `routes/orders.ts:896`：已有 `d`（按 id 倒序最后一张），`hasActiveDelivery = !!d && d.activeOrderId === id`。
3. 后台：`scheduleCapsule` 的 `CALL_DUE` 分支按 `sc.readyAt` 分文案：非空 → `该呼叫未呼出 · 晚 ${minOver(sc.callAt, now)} 分`（cls 仍 warn）；空 → 原文案。`scheduleUrgency` 不改（CALL_DUE 已是 warn）。`Workbench.tsx:1213` 的 `etaTextIfCallNow` 已对 CALL_DUE 显示，`:1212` 「骑手 未呼叫」此时正确。按钮矩阵（`:1909-1929`）不改：`readyAt` 非空自然只剩「立即呼叫」「自己送」。
4. `autoCallScheduled` 改造（返回值口径改为「本轮动作数 = 成功呼叫 + 发出的告警」，与 `tasks.ts` 其它任务一致，jsdoc 写明；既有 e2e §69 ⑦ 的 `=0`/`≥1` 断言不受影响，已核对该时点无其它到点候选）：
   ```
   const s = await getLocalSettings()
   const blocked = !s.enabled ? '同城配送总开关已关闭' : isCircuitTripped() ? '快递100 余额不足已熔断' : null
   for (const o of 候选（查询条件不变：PREPARING、readyAt 非空、cancelRequestedAt 空）) {
     tl / now ≥ callAt / 无在途单 三道过滤不变
     if (blocked) { notifyLocalDeliveryAlert('预约单到点未能自动呼叫', [tail(o), `${blocked}，系统不会自动呼叫骑手`, `约定 ${slotLabel} 送达，请到工作台「立即呼叫」或「自己送」，或先恢复开关/熔断`], { key: `sched-uncalled:${o.id}`, windowMs: 10 * MIN }); n++; continue }
     try { callRider(...); n++ }
     catch (e) {
       const code = e instanceof AppError ? e.code : null
       // 42225 = 运力方失败，callRider 内部已按类型告警（CAPACITY/BALANCE/CONFIG/BUSINESS），不重复
       if (code !== 42225) notifyLocalDeliveryAlert('预约单自动呼叫失败', [tail(o), message, '请到工作台「立即呼叫」或「自己送」'], { key: `sched-uncalled:${o.id}`, windowMs: 10 * MIN }); n++ 仅在发了告警时
       console.warn 保留
     }
   }
   ```
   注意：`schedule.enabled=false` 且库里无预约单时候选为空 → 依旧完全静默（既有约束）。`notifyLocalDeliveryAlert` 在未配 webhook 时直接 return（e2e 环境），任务无法感知去重，所以计数按「意图发告警」计——jsdoc 写清。
5. `docs/api.md` 2203 行 `schedAutoCall` 一格补「熔断/总开关关/非运力类失败时按单企微告警（10 分钟限频）；phase 在到点 2 分钟后仍无在途单时回落 `CALL_DUE`」。

### E. S6 付款已过出票时刻的单不再补备餐票（预计涉及：`schedule-tasks.ts:39-56`）

`printPrepTickets` 循环里、打标之后：`if (o.paidAt && o.paidAt.getTime() >= tl.ticketAt.getTime())` → 不 `enqueueOrderTicket('PREP')`，企微「预约单该开始备餐了」照发（文案不变），`n++`。jsdoc 写明：来单票在付款时已印「送达 / 开始备餐 / 呼叫骑手」与厨房联，此时再补一张只是让后厨拿到两张同单票。`paidAt` 为空的 PAID 单（理论不存在）按原逻辑出票。

### F. S7 票面放大行 ≤ 16 列（预计涉及：`services/slots.ts:89-95`、`services/ticket/content.ts:317,358,414,486`、`services/ticket/index.ts:229-233,333-335`、新 `scripts/selftest-ticket-schedule.ts`）

宽度事实（`content.ts:109` `BIG_LINE_WIDTH = 16`，真机实测）：`<B>送达 10月22日（周四）12:00–12:30</B>` 按 `charWidth` 规则为 33 列（`–` U+2013 记 2）；`<B>应于 11:36 前备好</B>` 17 列；`<B>11:16 开始备餐 · 11:36 前备好</B>` 30 列。

1. `slots.ts` `ticketLabel` 返回值增加 `date`（`10月22日（周四）`）与 `time`（`12:00–12:30`）两个字段，`text` 保持不变（其它调用不受影响）。
2. `ticket/index.ts` 的 `ScheduleForTicket` / `toTicketInput` 新增透传 `scheduleSlotDate`、`scheduleSlotTime`（`content.ts` 的 `TicketOrderInput` 同步加两个可选字段；`scheduleSlotLabel` 保留给其它地方）。
3. `content.ts`：
   - `:358` 配送联与 `:414` 厨房联：`<B>送达 ${slotLabel}</B>` → 两行 `送达 ${date}`（普通字号）+ `<B>${time}</B>`（12 列）。
   - `:317` 备餐票时刻行 → `<B>${prepStart} 开始备餐</B>` + `<B>${call} 前备好</B>`。
   - `:486` READY_DUE → `<B>应于${call}前备好</B>`（15 列）。
   - 导出 `strWidth`（或新增 `bigSegmentsWidth(ticket)` 工具）供 selftest 用；不改 `assemble` 的折行与补白逻辑。
4. 自取票 `<B>取餐 ${pickupSlotLabel}</B>`（`:341`）**不改**，除非待用户决定 D3 选「一起修」（届时同样拆成普通日期行 + 放大时段行，`pickupTicketLabel` 同法加 `date/time`）。

### G. S8 「尽快」只算同城外送（预计涉及：`routes/admin/orders.ts:147`、`docs/api.md:2191`）

`sc === 'ASAP' ? { scheduledAt: null, deliveryType: 'LOCAL' }`。`channel=LOCAL`（LOCAL+PICKUP）叠加后只剩 LOCAL；`deliveryType=PICKUP&schedule=ASAP` 结果为空（前端 `LocalOrders.tsx:124` 切自取时已删 `sched`，不会发这种组合）。前端不改。

### H. S9 跨日时刻加日期前缀（预计涉及：`apps/admin/src/utils/time.ts` + `time.test.ts`、`utils/schedule.ts:47-49,87-92` + 测试、`pages/Workbench.tsx:2558`、`components/orders/detail/DetailDelivery.tsx:36-38`）

- `time.ts` 新增 `fmtHHmmOrDate(v, now = new Date())`：`sameDayKey(v, now)` → `fmtHHmm`，否则 `fmtMonthDayTime`（`M-DD HH:mm`），无效 → `'--'`。放在 `time.ts` 里是为了过 `check-admin-timezone.mjs` 白名单。
- `scheduleCapsule` WAITING/TICKETED 的 `fmtHHmm(sc.prepStartAt)` → `fmtHHmmOrDate(sc.prepStartAt, now)`；`scheduleBarText` 同理（签名已有 `now`）；`Workbench.tsx:2558` 折叠组头「最近 … 开始备餐」同理；`DetailDelivery.tsx:36-38` 三个时刻用 `fmtHHmmOrDate(x, Date.now())`。`scheduleFieldsLine`（`slotLabel` 已自带「今天/明天/日期」）与 PREPPING/CALL_DUE/READY_WAITING 胶囊（必然当天）不改。
- 倒计时条点击（`Workbench.tsx:2473-2479`）不改。

### I. e2e 新段 `scripts/e2e.d/72-scheduled-fix-batch2.sh`（预计涉及：新文件；`69-scheduled-delivery.sh` 只在确需时微调，不得改其既有期望值）

复用 §69 的 `s69_put/s69_ord/s69_det/s69_sc/s69_pin/s69_new` 与 e2e.sh 的 `req/code/ok/fail/assert_eq/sched/sql/PJOBS/snap/mk_local_paid/kd_cb/dstat`；变量一律 `S72_` 前缀。开头保存 `S72_ORIG` 设置并按 §69 ② 重新开通预约（§69 收尾已把设置还原），显式 `.callStrategy={"mode":"SOLO_LOWEST","cheapestN":3,"escalateAfterMin":0}`、`.enabled=true`，`kd100-mock/reset`、`kd100-circuit/reset`；结尾按 §69 收尾同法还原设置、取消未完成单、清作业、恢复打印机设置。每段断言：

- **① S1 店员取消不再自动重呼、三键可用**：O1=`s69_new 3` → accept → `s69_pin O1 callAt -1` → `POST /ready` 返回 `code 0, called=true`；`call_origin=SCHEDULED_AUTO`、`ready_at IS NOT NULL`。queue `precancelOrder`/`cancelOrder` 各一条 `{kind:ok,cancelFeeFen:0}` → `POST /delivery/cancel` code 0 → `dstat=CANCELLED`；**`ready_at IS NULL`=1**；`s69_sc phase=CALL_DUE`；配送单事件最后一条含「已撤回」。`sched '{}'` 两次 → `SELECT COUNT(*) FROM deliveries WHERE order_id=O1` 恒为 1（**不再自动呼叫**）。`POST /call {"force":true}` → code 0、`deliveryNo=D{O1}-2`、`ready_at IS NOT NULL`、count=2。再 queue 两条 fee 0 → cancel → `ready_at IS NULL`。`POST /self-deliver {"name":"店员","phone":"13800000000"}` → code 0、订单 `SHIPPED`、`ready_at IS NOT NULL`、count=3、最后一张 `provider=SELF`。
- **② 对照：骑手方撤单（720）不清 readyAt，系统到点自动重呼**：O2 同上到 `called=true`；取 `providerTaskId` 与 `calledProviders[0]`（默认 SOLO 只呼一家）；`kd_cb D{O2}-1 taskId 720 '骑手取消订单' '<now>' '王骑手' '13900001111' <provider>` → 200；`dstat=CANCELLED`；**`ready_at IS NOT NULL`=1**；`sched '{}'` → count=2，最新一张 `status=CALLING`、`call_origin=SCHEDULED_AUTO`。
- **③ 对照：调度器自动升级的取消不清 readyAt**：O3 同上到 D-1 CALLING（策略 SOLO）；queue precancel/cancel fee 0；`sleep 1`；`sched '{"escalateAfterMin":0.01}'` → `localEscalate ≥ 1`；最新一张是 `D{O3}-2`、`CALLING`；`ready_at IS NOT NULL`=1；D-1 `CANCELLED`。
- **④ S2**：O4=`s69_new 3` → accept → `sleep 0.5` → `sql UPDATE orders SET quoted_at=NULL WHERE id=O4`；A1=`mk_local_paid` → accept → `sleep 0.5` → 同样置空；`sched '{"quoteRefreshMin":0}'` → **O4 `quoted_at IS NULL`=1**，A1 `quoted_at IS NOT NULL`=1（对照证明任务本身在跑）。
- **⑤ S5/S4 总开关关**：O5=`s69_new 3` → accept → `s69_pin O5 callAt 30` → `/ready` `called=false`；`s69_put '.enabled=false'`；`s69_pin O5 callAt -3`（越过 2 分钟宽限、`scheduledAt` 仍在未来）；`sched '{}'` → `schedAutoCall ≥ 1`（告警计数）且 **deliveries count=0**；`s69_sc phase=CALL_DUE`（管理端详情 `s69_ord … .data.schedule.phase` 同为 `CALL_DUE`）；`snap` 里该卡 `local.schedule.phase=CALL_DUE` 且 `local.delivery=null`。`s69_put '.enabled=true'` → `sched` → count=1、`call_origin=SCHEDULED_AUTO`、phase=`CALLED`。
- **⑥ S4 熔断**：O6=`s69_new 3` → accept → `s69_pin O6 callAt -3` → queue `createOrder {kind:error,code:"30004"}` → `/ready` → `code 42225`、`ready_at IS NOT NULL`、count=1 且最新 `FAILED`；`GET /admin/system/status .kd100.circuitTripped=true`；`sched '{}'` → `schedAutoCall ≥ 1`、count 仍 1；`POST /kd100-circuit/reset` → `sched` → count=2、最新 `CALLING`。
- **⑦ S4 非运力类失败也告警**：O7=`s69_new 3` → accept → `s69_pin O7 callAt 30` → `/ready` `called=false`；`sql SELECT receiver_lat_e6` 存下；`UPDATE … SET receiver_lat_e6=NULL`；`s69_pin O7 callAt -3`；`sched` → `schedAutoCall ≥ 1`、count=0；还原坐标；`sched` → count=1。
- **⑧ S6**：打印机设置 `S69-P`、`printer-mock/reset`；O8=`s69_new 3`；`sleep 0.5`；`s69_pin O8 ticketAt -1`（`paid_at` 不动 = 刚才，晚于 ticketAt）；`sched` → `schedPrepTicket ≥ 1`、`prep_ticket_at IS NOT NULL`、**PREP 作业 0 张**、NEW_ORDER 作业 1 张；再 `sched` → `schedPrepTicket=0`。（`paidAt < ticketAt` 出 PREP 的对照已在 §69 ⑧。）
- **⑨ S7**：O8 的 NEW_ORDER 内容：`jq '[match("<B>([^<]*)</B>";"g").captures[0].string | explode | map(if . > 255 then 2 else 1 end) | add] | max'` ≤ 16；含 `送达 ` 普通行与 `<B>HH:mm–HH:mm</B>` 行。O9=`s69_new 3` → `s69_pin O9 ticketAt -1` → `sql paid_at=NOW-60min` → `sched` → PREP 内容同法 ≤ 16，含 `开始备餐</B>` 与 `前备好</B>`；accept O9 → `s69_pin O9 callAt -1` → `sched` → READY_DUE 内容 ≤ 16，含 `<B>应于`。
- **⑩ S8**：前置 `sql SELECT COUNT(*) FROM orders WHERE delivery_type='PICKUP'` ≥ 1（§62 已造）；`GET /admin/orders?channel=LOCAL&schedule=ASAP&pageSize=100&<与 LocalOrders 同样的日期参数或不传>` → `[.data.list[]|select(.deliveryType=="PICKUP")]|length=0`；对照 `GET /admin/orders?channel=LOCAL&pageSize=100` → PICKUP 条数 ≥ 1（若默认日期范围挡住，执行者按 `orderDateQuery` 的参数补 `range`，并在输出说明）。

---

## 授权范围

```
apps/server/src/services/delivery/schedule-tasks.ts
apps/server/src/services/delivery/schedule.ts
apps/server/src/services/delivery/orchestrator.ts
apps/server/src/services/delivery/tasks.ts
apps/server/src/services/slots.ts
apps/server/src/services/ticket/content.ts
apps/server/src/services/ticket/index.ts
apps/server/src/routes/admin/workbench.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/delivery.ts
apps/server/src/routes/orders.ts
apps/server/scripts/selftest-schedule.ts
apps/server/scripts/selftest-ticket-schedule.ts
apps/admin/src/utils/schedule.ts
apps/admin/src/utils/schedule.test.ts
apps/admin/src/utils/time.ts
apps/admin/src/utils/time.test.ts
apps/admin/src/pages/Workbench.tsx
apps/admin/src/components/orders/detail/DetailDelivery.tsx
apps/admin/src/types.ts
scripts/e2e.d/72-scheduled-fix-batch2.sh
scripts/e2e.d/69-scheduled-delivery.sh
docs/api.md
```

（`apps/admin/src/types.ts` 只允许为 `ScheduleInfo`/卡片类型补可选字段注释，不得改 `SchedulePhase` 枚举值；`69-scheduled-delivery.sh` 只允许改注释或在收尾补清理，不得改既有断言期望。）

## 禁止修改

```
apps/miniapp/**
tests/miniapp/**
tools/miniapp-preview/**
apps/server/prisma/**
apps/server/src/services/refund*.ts
apps/server/src/services/refund/**
apps/server/src/routes/wechat-notify.ts
apps/server/src/routes/admin/pay-mock.ts
apps/server/src/services/delivery/callback.ts
apps/server/src/services/scheduler.ts
apps/server/src/services/local-settings.ts
apps/server/src/services/notify.ts
apps/server/src/services/order-notify.ts
apps/server/src/services/cancel-request.ts
apps/server/src/services/pickup.ts
apps/server/src/routes/admin/system.ts
apps/server/src/routes/admin/kd100-mock.ts
apps/server/src/routes/admin/printer.ts
apps/admin/src/utils/order-actions.ts
apps/admin/src/pages/LocalOrders.tsx
scripts/e2e.sh
scripts/deploy.sh
scripts/check-admin-timezone.mjs
.claude/**
.agent/**
docs/superpowers/**
package.json
package-lock.json
apps/*/package.json
apps/*/package-lock.json
.claude/launch.json
```

## 上报条件

执行者遇到以下任一情形必须停下、写进「上报」栏，不得自行绕过：

- 任何一步发现需要新增/修改 Prisma 列、索引或迁移（例如想用新列表达「已人工介入」）——本批期望零迁移；`prisma generate` / `migrate dev` 一律不得运行。
- `apps/server` `tsc` 出现与本批改动无关的 Prisma 类型错误（可能是主仓共享 client 过期）——不得跑 `generate`，原样上报。
- 需要改动禁止清单里的文件才能完成（典型：想改 `callback.ts` 的 720 语义、想改 `scheduler.ts` 任务顺序、想改 `notify.ts` 去重行为、想让 e2e 主文件 `e2e.sh` 配合）。
- e2e 基线：不改代码先跑一遍 §1–§71 若 `FAIL≠0`（基线 2275/0），先上报再动手；执行中任何**既有**断言变红且不能用本方案解释的，上报，不得改期望值。
- §72 ② 的 720 回调路径若因并呼家数/`calledProviders` 不为单家而走「多家并呼撤单不终态化」分支——调整 e2e 设置（`SOLO_LOWEST`）仍不行时上报，不得改 `callback.ts`。
- `schedulePhase` 增加输入后若发现除三处（workbench / admin 详情 / 顾客详情）之外还有第四处调用而无法拿到在途单信息。
- 小程序侧任何需要配合改动的地方（本批禁改，第三批并行）。
- 「待用户决定」中任一项在开工时仍未拿到答复——受影响部分暂停，其余继续。
- 定级：本方案已标「需升 L」；若编排者未升级即分派，执行者照做，但在输出首栏注明「规划者建议升 L，按 M 执行」。

## 待用户决定

- **D1（S1 修法，业务语义）**：店员在工作台「取消呼叫 / 取消配送」是否等于**撤回「已备好」**（`readyAt` 清空，卡片回到橙色 `CALL_DUE`、按钮「已备好 / 立即呼叫 / 自己送」，系统不再自动呼叫；顾客端相应重新允许「申请取消」）？
  - 选 A（**建议**）：如上，零迁移，与取消弹窗文案「订单退回备餐中，你可以重新呼叫或改自己送」一致。
  - 选 B：保留 `readyAt`，另加一列记「人工介入」——需要迁移，本批不做，改为上报升级。
- **D2（S1 连带，业务语义）**：店员取消后若订单一直悬置，`remindScheduledNotReady` 会按「预约单应已备好未确认」催（企微 + 小条，每 3 分钟一张、封顶告警一次），文案不完全准确但它是 LATE 之前唯一的提醒。
  - 选 A（**建议**）：保留，不改文案（店员取消后 60 秒内做了后续动作就不会触发）。
  - 选 B：对「已有过配送单」的预约单不再催，只剩约定时刻 +10 分钟的 LATE 告警。
- **D3（S7 范围）**：自取票 `<B>取餐 9月12日（周六）12:00–12:30</B>`（生产在用）是否同批改成「日期普通字号 + 时段放大」？
  - 选 A（**建议**）：本批不动自取票（生产在用，且未收到店主反馈折行难看）。
  - 选 B：一起改，同法（`pickupTicketLabel` 加 `date/time`，`content.ts:341` 拆两行），并把 `apps/server/src/services/pickup.ts` 从禁止清单挪进授权范围。
- **D4（S2 范围）**：接单那一刻的一次 `kickOffQuote`（`delivery.ts:99`）对预约单也会把收件人信息发给运力方一次。
  - 选 A（**建议**）：不改——只此一次，且让「立即呼叫」弹窗有报价可看。
  - 选 B：预约单接单时也不预取，弹窗报价靠店员点刷新 / 呼叫时现查。
- **D5（S6 纳入确认，票据行为）**：付款时已过出票时刻（约三分之一最早时段单）的预约单，到点不再补第二张「开始备餐」全票，只发企微「该开始备餐了」并打标——后厨只拿到付款那张来单票。
  - 选 A（**建议**）：纳入。
  - 选 B：维持现状（两张）。
- 其余（S9 日期前缀纳入、S9 倒计时条点击不纳入、S10 不纳入、S4 两分钟宽限常数、S8 服务端修法）为纯技术或展示选择，规划者已定，不需用户决定；如店主对 S9/S10 另有口径，编排者转达即可。

---

## §J 复核裁决（2026-09-23，对 HEAD cfeec3a；裁决者 Fable，本人亲自核实）

核实动作：读 `schedule.ts:118-126`、`routes/orders.ts:855-865`、`routes/admin/orders.ts:314-324`、`schedule-tasks.ts:132-170`、`orchestrator.ts:257`、`content.ts`/`index.ts`/`slots.ts` 全部 diff、`selftest-ticket-schedule.ts` 全文、`e2e.d/72` 85-215 行、`docs/api.md` diff；实跑 `selftest-pickup.ts`（✘ 小票取餐文案）与 `selftest-member.ts`（✘ 自取小票，67 passed）。

### R6：成立（规划缺口）
依据：`content.ts:374` `<B>地址 …</B>` 是既有设计（注释「放大后会折成 2–3 行，这是有意的」），`strWidth('地址 自流井区丹桂40栋底楼')=25`；验收第 6 条与 §E⑨「所有 `<B>` 段 ≤16」在预约来单票上恒不成立。
处理（替换验收第 6 条与 §E⑨ 口径）：
- 只对 **S7 改写/新增的段**做 ≤16 断言，且必须按**内容**定位（不是「随便找一段」）：来单票配送联与厨房联各含 `<B>HH:mm–HH:mm</B>`；备餐票含 `<B>HH:mm 开始备餐</B>` 与 `<B>HH:mm 前备好</B>`；催备好小条含 `<B>应于HH:mm前备好</B>`；自取票取餐联含 `<B>HH:mm–HH:mm</B>`。
- 增加**负向断言**（证伪老写法回归）：真实票面与 selftest 票面都**不得**含 `<B>送达 `、`<B>取餐 `、`<B>应于 `（带空格）、` 开始备餐 · `（合成行）四种老形态（R9 的回落例外：只有在 `*SlotDate/*SlotTime` 缺失时才允许出现，见 R9）。
- `selftest-ticket-schedule.ts` 与 `e2e.d/72` ⑨ 按上述两条改；`assertScheduleBigSegmentsWithin` 的注释保留。执行者输出的「偏离方案」栏补登记此项。

### R7：成立（规划缺口）
依据：`schedule.ts:123` `if (o.hasActiveDelivery) return 'CALLED'`；已送达单 `markDelivered` 释放 `activeOrderId`（`orchestrator.ts:582`）。顾客详情 `routes/orders.ts:860-865`：`d` 取最后一张（DELIVERED，`pickedUpAt` 非空）→ `pickedUp=true, hasActiveDelivery=false` → `readyAt` 非空、`t ≥ callAt+2min` → 返回 `CALL_DUE`（改前 `CALLED`）。管理端详情 `routes/admin/orders.ts:314-316` 按 `activeOrderId` 查 → 送达后为 null → `pickedUp=false, hasActiveDelivery=false` → 约定前 `CALL_DUE`、约定后 `LATE`。当前无消费方读该值不改变「接口语义倒退」的事实。
处理：
- `schedule.ts` `schedulePhase`：`if (o.hasActiveDelivery || o.pickedUp) return 'CALLED'`（骑手已取货/已送达的单不可能「该呼叫未呼出」）。
- `routes/admin/orders.ts`：改成与顾客详情同一取法——`prisma.delivery.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' }, select: { pickedUpAt: true, activeOrderId: true } })`，`pickedUp = !!d?.pickedUpAt`，`hasActiveDelivery = !!d && d.activeOrderId === id`。
- `selftest-schedule.ts` 新增：`schedulePhase(tl, { readyAt, pickedUp:true, hasActiveDelivery:false }, callAt+4min)` → `'CALLED'`；`(…, scheduledAt+1min)` → `'CALLED'`。
- `e2e.d/72` ①末尾（自己送之后）追加：`POST /delivered` → 顾客详情 `s69_sc phase=CALLED`、管理端详情 `s69_ord .data.schedule.phase=CALLED`（同时给 R3 的详情 CALLED 分支一个真实覆盖）。

### R8：成立（纳入本轮，两处小改）
依据：`schedule-tasks.ts:153-165` 对非 42225 一律发「预约单自动呼叫失败…请到工作台「立即呼叫」或「自己送」」；`orchestrator.ts` 抛 42204 的三条路径（`:225` 状态非 PREPARING、`:227` 有取消申请、`:256` 占位后复核 RACE——S1 新加的 `readyAt` 条件正是走这一条）都是「订单状态刚被人改过、下一跳自会重评」的情形，此时催店员去呼叫与店员/顾客刚做的决定相反。`orchestrator.ts:257` 回调地址超长用 42225 抛出、其前无任何告警，被排除后每一跳都静默。
处理：
- `autoCallScheduled` catch：`code === 42204` 与 `42225` 都不发企微（只 `console.warn`）；其余（42223/42226/42228/42232 等）照发。jsdoc 写明 42204 = 状态变化类，属自愈。
- `orchestrator.ts:257` 回调地址超长：抛之前 `notifySystemAlert('快递100 配置类错误', [`回调地址超长（${len}>50）…`], { key: 'kd100-config:CALLBACK_URL' })`（与 `:375` CONFIG 类同一渠道与键前缀），确定性配置错误不得静默。
- `docs/api.md:2203` 「非 42225」改「非 42204/42225」。
- 验证：e2e ⑦（42223）继续为回归；42204 竞态与回调地址超长不可在 e2e 稳定复现，由复核者按 diff 核对，执行者输出注明「未运行」。

### R9：成立
依据：`content.ts:360-361,380,437` 在 `pickupSlotDate/Time`、`scheduleSlotDate/Time` 缺失时印「取餐 」/「送达 」+ 空 `<B></B>`；`selftest-member.ts:343-352` 的输入只传 `pickupSlotLabel`，实跑 ✘。
处理（同时给出 R1 推荐修法）：
- `content.ts`：两个 `*SlotDate && *SlotTime` 都非空才拆行；否则**回落老写法**（`<B>取餐 ${pickupSlotLabel}</B>` / `<B>送达 ${scheduleSlotLabel}</B>`，厨房联同）。回落后 `selftest-member.ts:353` 断言原样通过，该文件不改、不进 allow。
- `slots.ts`：**撤回 `ticketLabel` 返回值的形状变更**（恢复 `{ text, stamp }`，与 `selftest-pickup.ts:101-103` 的 `deepStrictEqual` 逐字节一致），另加导出 `ticketLabelParts(at, slotMinutes, now?) : { date: string; time: string }`（内部与 `ticketLabel` 共用 `cnDate`/`hhmm`）。`ticket/index.ts` 对自取与预约都改用 `ticketLabelParts` 取 `date/time`（`pickup.ts` 是 deny，`pickupTicketLabel` 别名不动；index.ts 直接 `import { ticketLabelParts } from '../slots'`）。`selftest-pickup.ts` 不改、不进 allow。
- 不推荐「改两份自测的期望」（要扩 allow、且等于把老调用方的空 `<B></B>` 缺陷固化）。
- `selftest-ticket-schedule.ts` 新增两条：只传 `pickupSlotLabel` → 票面含 `<B>取餐 9月12日（周六）12:00–12:30</B>` 且不含 `<B></B>`；只传 `scheduleSlotLabel` → 含 `<B>送达 …</B>` 且不含 `<B></B>`。
- 验收新增：`TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-pickup.ts` 与 `scripts/selftest-member.ts` 全部通过（本机基线：改前两者各 ✘ 1）。
- allow.txt：**不需要调整**（若编排者改选「改期望」路线，则需追加 `apps/server/scripts/selftest-pickup.ts`；`selftest-member.ts` 任一路线都不需要）。

### R10：成立
依据：`docs/api.md` diff 只改了 1140/2191/2203 三格；方案 A.4「顾客端重新允许申请取消、会触发催备好」、§B「报价保鲜排除预约单」、§D.5「到点 2 分钟宽限后回落 CALL_DUE」均未落文档（2206 行任务排除清单未加 `refreshStaleQuotes`）。`apps/admin/src/utils/schedule.ts:113` `eta <= sched` 在恰好相等时写「早于」。
处理：
- `docs/api.md:1140` 一格补：「取消后顾客端按 `readyAt` 为空重新允许「申请取消」（过了 `selfCancelUntil`）；订单悬置时会被 `remindScheduledNotReady` 按「应已备好未确认」催（店主决定 D2 选 A）」。
- `docs/api.md:2206` 任务排除清单加 `refreshStaleQuotes`。
- `docs/api.md` 预约 phase 说明处（2156 附近或 2203 行）补：「已备好但无在途配送单：`callAt+2 分钟`宽限后 phase 回落 `CALL_DUE`；有在途单或骑手已取货恒 `CALLED`」。
- `callNowConfirmText`：`eta < sched` → 「早于」；`eta > sched` → 「已晚于 … 约 N 分钟」（N≥1）；`eta === sched` → 「与顾客约定的 HH:mm 相同。」。`schedule.test.ts` 补相等边界用例。

### 与 R1–R5 的关系
R9 的修法直接消解 R1（两份自测不改即通过）；R7 的 e2e 追加同时覆盖 R3 的详情侧；其余不冲突。allow.txt 无需变更。
