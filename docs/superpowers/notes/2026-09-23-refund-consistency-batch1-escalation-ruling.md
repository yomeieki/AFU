【工序】裁决 【模型】Claude Fable 5.1 【等级】L

# 升级轮综合裁决（HEAD 9693039，BASE fe9a501）

裁决者为全新会话，未参与规划与前两轮复核。以下每条依据均为本会话亲自打开代码 / 亲自跑命令所得；所有命令在 worktree 根目录 `/Users/yumingyi/food-shop/.claude/worktrees/jolly-visvesvaraya-4c32f4` 起算，对 `food_shop_e2e` 只做了 SELECT（含 `SELECT … FOR UPDATE` 锁定读，事务一律 ROLLBACK）。本裁决不改 plan.md、不写仓库文件。

---

### R12：成立

**依据（逐条核实）**

1. 锁内重验只会报 42205 / 42204，不会报 42206。
   `apps/server/src/services/refund.ts:172-181`（HEAD 9693039）：
   ```
   172  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
   173  const lockedOrder = await tx.order.findUniqueOrThrow({ … include:{ refunds:{ select:{ status:true } } } })
   177  if (lockedOrder.refunds.some(ACTIVE)) throw new AppError(42205, '该订单已有退款处理中')
   180  if (remainingRefundable(lockedOrder) !== remaining) throw new AppError(42204, '订单退款额已变化，请刷新后重试')
   ```
   42206 只有事务外两处：`refund.ts:102`（`remaining <= 0`）、`:103-105`（`amount > remaining`）。

2. selftest「顺序构造」（`apps/server/scripts/selftest-refund-reconcile.ts:967-984`）：先 `prisma.order.update({ refundedAmount: 100 })` 再调 `initiateRefund`，事务外 `:102` 读到 remaining=0 → 42206，永远走不到 `:172`。执行者注释 `:970-973` 自认「改动前也会被 remaining<=0 挡住」。断言 `[42204, 42206].includes(code)` 对改动前后都绿。**不能证伪。**

3. selftest「真并发」（`:985-1034`）：Y 不 await 先发 `order.findUnique`（`:102` 之前的快照读），随后 X 完整跑一遍。两笔的事务 A 都要插入 `activeOrderId = order.id` 的行；`refunds_active_order_id_key` 唯一索引（`prisma/migrations/20260902100000_add_refund/migration.sql:27`）在改动前就让后插入者等待先插入者提交、再撞 P2002 → `:257` 抛 42205。结果「一成一败、sum ≤ 200」在改动前后一致。改动前唯一变红的时序是「Y 的事务 A 开始于 X 的 finalize 提交之后」——Y 的快照读比 X 先发出、之后只剩 `delivery.findFirst` 一个 await 就进事务，而 X 要走完事务 A + 外呼桩 + 条件写 + finalize 事务（≥6 条语句），这个时序在本机几乎不会出现。断言 `xOk||yOk`、失败码 ∈ {42205,42204,42206}、`sum<=200` 对两种胜负都成立。**不能稳定证伪。**

4. e2e 71.5(a)(b)（`scripts/e2e.d/71-refund-consistency.sh:496-540`）：两处断言的期望值都是 `42206`（`:515`、`:540`）。(a) 是 resolve 提交**之后**再顺序 POST 全额 A，事务外 `:103` 读到 remaining=A-100 < A → 42206；(b) 同理（回调落账后 remaining=0 → `:102` 42206）。`:511-513` 注释「锁内重验命中点」不成立：锁内命中报的是 42204。**验证的是事务外检查，不是 R9 的改动。**

5. 方案 §8 R9 自己写的 selftest 构造（plan.md「用 `prisma.$transaction` 在另一连接里 `SELECT … FOR UPDATE` 锁住 orders 行并把 refundedAmount 改成 actual 后提交 → initiateRefund 抛 42204/42206」）：T 在 `initiateRefund` 调用之前就已提交，事务外快照读到的 refundedAmount 已是 actual → `:102` 42206，同样走不到锁内。**这是规划缺口，方案条目本身就不能证伪；执行者偏离原构造是对的，但替代构造同样不证伪。**

6. 复核者建议的「另一连接先持锁、initiateRefund 卡在事务 A 首句、T 改余额后提交」构造，本会话亲自验证了其依赖的三条 InnoDB 事实（`docker exec food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop_e2e`，全部 SELECT，事务 ROLLBACK）：
   - `SELECT @@version, @@transaction_isolation, @@innodb_lock_wait_timeout, @@performance_schema` → `8.0.46  REPEATABLE-READ  50  1`。
   - T 持 `SELECT id FROM orders WHERE id=330 FOR UPDATE` 期间，另一会话普通 `SELECT id,status FROM orders WHERE id=330` **0.003s 返回**（RR 下一致性非锁定读不被 X 锁阻塞）——所以 `initiateRefund:96-133` 的事务外读不会被 T 挡住、拿到的是 T 改动前的旧快照。
   - 第三会话 `SELECT … FOR UPDATE` 同一行时，`performance_schema.data_lock_waits ⋈ data_locks` 立即可见一行：`orders  PRIMARY  RECORD  X,REC_NOT_GAP  WAITING  330  X,REC_NOT_GAP`；`information_schema.INNODB_TRX` 同时显示 `LOCK WAIT | SELECT id FROM orders WHERE id=330 FOR UPDATE`。`foodshop_user` 拥有全局 SELECT + PROCESS（`SHOW GRANTS` 实测），selftest 的 DATABASE_URL 与 e2e 的 `sql()` 助手（`scripts/e2e.sh:1723`）都能读这两张表。两会话结束后 `data_lock_waits` 回到 0。
   - Prisma 5.22.0 交互事务默认 `maxWait ?? 2e3`、`timeout ?? 5e3`（`/Users/yumingyi/food-shop/node_modules/@prisma/client/runtime/library.js` 实测 grep；`apps/server/src/utils/prisma.ts:3` 是 `new PrismaClient()` 无自定义 transactionOptions）。因此**持锁时间必须 < 5 s**，否则 initiateRefund 报 P2028 而不是 42204，测试会因超时而非逻辑而红。
   - 改动前代码必然变红的依据：`git show fe9a501:apps/server/src/services/refund.ts` 第 144-195 行的事务 A 在 `tx.refund.create`（:195）之前**没有任何** `FOR UPDATE` / `findUniqueOrThrow` / `$queryRaw`（grep 为空）；部分退款且订单 PAID 时 `:145 if (isFull && !fromRefunding)` 不进，第一条触碰 orders 的语句就是 insert 本身——`refunds_order_id_fkey`（migration.sql:34）使 InnoDB 在插入子行时对父行加共享记录锁（MySQL 8.0 手册 InnoDB Locking：「If a FOREIGN KEY constraint is defined on a table, any insert … that requires the constraint condition to be checked sets shared record-level locks on the records that it looks at」），因此改动前 insert 会等 T，但 **T 提交后 insert 照样成功**（余额校验早已在事务外用旧快照通过），退款行建出、随后外呼桩返回 SUCCESS、finalize 落账。断言「抛 42204 且 refunds 无新行」在改动前必红两条。

**处理（修订后的方案条目；取代 plan.md §8 R9 中「selftest 新增事务 A 用例」一句与「e2e 新增 71.5」一句；验收标准只加不减）**

#### (A) selftest：`apps/server/scripts/selftest-refund-reconcile.ts`，替换现有「用例 R9（真并发…）」，保留「用例 R9（顺序构造…）」但改名

- 「用例 R9（顺序构造…）」改名为「用例 R9-0（事务外快照已过期 → 42206，改动前后一致，仅盖『不建新行』不变量）」，断言不变。它不算 R9 的证伪用例，注释里删掉「锁内重验命中」字样。
- 删除「用例 R9（真并发：两笔部分退款合计超过实付…）」（不能稳定证伪，且在极端时序下对改动后的代码也可能因 P2028 而偶发红）。
- 新增 **「用例 R9-1（另一连接先锁 orders 行 → initiateRefund 卡在事务 A 首句 → 锁内重验命中 42204，不建行）」**，构造步骤（必须逐条照做）：
  1. `const order = await makeOrder({ actualAmount: 200, status: 'PAID', paymentType: 'WECHAT' })`（LOCAL 单，`:96-133` 的事务外检查全部走快照读）。`resetCounters()`。
  2. `createRefundStub` 设为立即返回 `{ status:'SUCCESS', refund_id:'wxr-…', out_refund_no: p.outRefundNo, amount:{refund:p.amount,total:p.total} }`（与现有真并发用例相同）——目的：改动前代码走到外呼时不因「stub 未设置」抛普通 Error，而是完整建出一条 SUCCESS 行，让资损可见。
  3. 用 **selftest 自己的 `prisma`**（与业务代码 `utils/prisma.ts` 单例是两个 PrismaClient、两条独立连接）开交互事务 T：`prisma.$transaction(async (tx) => { … }, { maxWait: 5000, timeout: 10000 })`。T 内第一句：`await tx.$queryRaw\`SELECT id FROM orders WHERE id = ${order.id} FOR UPDATE\``。
  4. T 拿到锁后（仍在 T 的回调内），**不 await** 地启动 `const p = refundMod.initiateRefund({ orderId: order.id, amount: 100, operator: 'R9-1' }).then(v => ({ ok: v }), e => ({ err: e }))`。
  5. T 内轮询等待锁等待出现：每 50 ms 执行一次 `prisma.$queryRaw<{ n: bigint }[]>\`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID WHERE r.OBJECT_SCHEMA = DATABASE() AND r.OBJECT_NAME = 'orders' AND r.LOCK_DATA = ${String(order.id)}\``（用非事务的 `prisma`，走另一条池连接），直到 `n ≥ 1`；上限 **2000 ms**。超过上限：T 直接 `throw new Error('R9-1 前置失败：2s 内未观察到 initiateRefund 对 orders 行的锁等待（不是被测逻辑的问题）')`——让用例红在「时序未成立」而不是静默绿。
     - 判定不是时序偶然的依据：`n ≥ 1` 意味着 initiateRefund 的事务 A **此刻正阻塞在 orders 行上**，且其事务外读已完成（否则它不会进事务）；改动后阻塞的是 `:172` 的 `FOR UPDATE`（`LOCK_MODE='X,REC_NOT_GAP'`），改动前阻塞的是 insert 的外键共享锁（`LOCK_MODE='S,REC_NOT_GAP'`）——两种都被上面这条计数查询覆盖，所以该等待检测对改动前后都成立，用例红绿只取决于第 7 步的结果。可选加一条 `assert.ok(lockMode.startsWith('X'), '…')` 把 LOCK_MODE 也查出来，作为「确实卡在 FOR UPDATE」的加强证据（非必需）。
  6. 观察到等待后，T 内 `await tx.order.update({ where: { id: order.id }, data: { refundedAmount: 200 } })`（T 已持 X 锁，不会自阻塞），随后 T 回调返回 → 提交。整个 T 从拿锁到提交 ≤ ~2.1 s，远小于 initiateRefund 事务 A 的 Prisma `timeout` 5 s，也远小于 `innodb_lock_wait_timeout` 50 s。
  7. `const r = await p`。断言：
     - `assert.ok('err' in r, '应抛错')`；`assert.strictEqual(r.err.code, 42204)`；`assert.ok(r.err.message.includes('退款额已变化'))`——**只接受 42204**，不接受 42206（42206 = 时序滑到 T 提交之后、走了事务外检查，属前置失败）也不接受 42205。
     - `assert.strictEqual(await prisma.refund.count({ where: { orderId: order.id } }), 0, '锁内重验命中，不得建出任何退款行')`。
     - `assert.strictEqual((await prisma.order.findUniqueOrThrow({ where:{ id: order.id } })).refundedAmount, 200)`（T 的改动在、initiateRefund 没有反向影响）。
     - `assert.strictEqual(refundResultCalls.length, 0)`；`assert.strictEqual(alertCalls.length, 0)`。
  8. 改动前必红的依据（见上「依据 6」）：改动前 `initiateRefund` 在 T 提交后插入成功 → `'ok' in r`（第一条断言红）、`refund.count === 1` 且 status SUCCESS（第二条红）。
- 期望脚本末行 `通过 N / 失败 0`，N = 现 42 − 1（删真并发）+ 1（新 R9-1）= 42；脚本头注释「覆盖」清单同步。

#### (B) e2e：`scripts/e2e.d/71-refund-consistency.sh` 71.5

- 71.5(a)(b) **保留**（作为「resolve/晚到落账之后余额已减」的顺序回归），但：小节标题改为「71.5 余额收口后的顺序再退（事务外检查）」；`:511-513` 注释与 `:515`/`:540` 断言文案删掉「锁内 remaining 已减」「锁内重验」字样，改为「事务外检查 42206」。断言值不变。
- 新增 **71.5(c) R9：另一连接持锁期间发起 → 锁内重验 42204**，步骤：
  1. `RC71_O5C=$(rc71_mk)`；`RC71_AMT5C` 取 actualAmount（>100）。
  2. 后台起持锁事务（用 e2e 已有的 root 或 foodshop_user 连接皆可，**不能**用单次 `sql()`，因为它每次调用是独立会话）：
     ```bash
     docker exec food-shop-mysql mysql -ufoodshop_user -pfoodshop_password "$DB_NAME" -N \
       -e "START TRANSACTION; SELECT id FROM orders WHERE id=$RC71_O5C FOR UPDATE; \
           SELECT SLEEP(2.5); UPDATE orders SET refunded_amount=$RC71_AMT5C WHERE id=$RC71_O5C; COMMIT;" \
       >/dev/null 2>&1 &
     RC71_TPID5C=$!
     ```
     持锁 2.5 s < Prisma 事务 timeout 5 s。
  3. 轮询确认 T 已持锁（每 0.1 s，上限 1.5 s）：`sql "SELECT COUNT(*) FROM performance_schema.data_locks WHERE OBJECT_NAME='orders' AND LOCK_TYPE='RECORD' AND LOCK_MODE LIKE 'X%' AND LOCK_DATA='$RC71_O5C';"` ≥ 1。未达到 → `fail "71.5c 前置：T 未在 1.5s 内持锁"` 并 `wait $RC71_TPID5C` 后跳过本小节其余断言（不得让后续断言在错误前提下跑）。
  4. 后台发起退款：`( req POST "/api/admin/orders/$RC71_O5C/refund" "$AT" '{"amount":100,"reason":"71.5c"}' > "$RC71_TMP5C" ) &`（`RC71_TMP5C=$(mktemp)`），记 `RC71_RPID5C=$!`。
  5. 轮询确认请求已阻塞在 orders 行（每 0.1 s，上限 1.5 s）：`sql "SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE r.OBJECT_NAME='orders' AND r.LOCK_DATA='$RC71_O5C';"` ≥ 1 → `ok "71.5c 观察到锁等待（事务外检查已通过、事务 A 阻塞在 orders 行）"`；未达到 → `fail "71.5c 前置：1.5s 内未观察到锁等待（时序未成立，非被测逻辑）"`。
  6. `wait $RC71_RPID5C; wait $RC71_TPID5C`；`RC71_R=$(cat "$RC71_TMP5C")`。断言：
     - `assert_eq "71.5c 锁内重验命中 → 42204" "$(code "$RC71_R")" "42204"`（**严格 42204**；出现 42206 表示请求在 T 提交后才到，属前置失败，应连同第 5 步的 fail 一起看）。
     - `assert_eq "71.5c 未建出退款行" "$(sql "SELECT COUNT(*) FROM refunds WHERE order_id=$RC71_O5C;")" "0"`。
     - `assert_eq "71.5c 订单仍 PAID" "$(order_status $RC71_O5C)" "PAID"`。
     - `assert_eq "71.5c refunded_amount 为 T 写入值" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O5C;")" "$RC71_AMT5C"`。
  7. 改动前必红的依据：mock 模式下改动前的 `initiateRefund` 在 T 提交后 insert 成功 → 走 `mode==='MOCK'` 秒成功 → 响应 code 0、refunds 有 1 行 SUCCESS（两条断言红）。
  8. 收尾：`rm -f "$RC71_TMP5C"`；该单已是 refunded_amount=A 且无退款行，不产生在途行，分片收尾断言不受影响。
- 环境约束：e2e.sh 是 `set -uo pipefail`（无 `-e`），后台 `&` + `wait` 可用；`req()`（e2e.sh:33）的 curl 无超时，2.5 s 阻塞不会被客户端掐断。
- 验收第 5 条 N 的下限相应 +6（71.5c 新增 ok/assert 共 6 条：持锁前置 1、锁等待 1、四条断言）。

#### (C) 复核者核对项（新增）
- `grep -n "42204" apps/server/scripts/selftest-refund-reconcile.ts` 必须命中 R9-1 的严格相等断言；`grep -n "data_lock_waits" apps/server/scripts/selftest-refund-reconcile.ts scripts/e2e.d/71-refund-consistency.sh` 各 ≥ 1。
- 复核者须做一次**反向验证**（只读、不提交）：临时把 `refund.ts:172-181` 整段注释掉（本地工作区，不提交），跑 selftest 与 e2e 71 分片，确认 R9-1 与 71.5c 变红且红在 42204/行数断言上，随后 `git checkout -- apps/server/src/services/refund.ts` 复原。这是 §1.2 要求的「实际运行」证据，交付报告须附输出。

#### (D) 不放宽项
- 71.5(a)(b) 与 R9-0 保留，只改文案；不删除任何既有断言。
- 42204 的锁内文案「订单退款额已变化，请刷新后重试」不改。

---

### R13：纳入（仅注释；行为不改）

依据：`refund.ts:156`「命中了 outRefundNo 唯一索引复用回来的已有退款」、`:252-260` P2002 分支注释、`scripts/e2e.d/71-refund-consistency.sh:121-127`「唯一索引去重命中的是『事务 A 提交前的真并发』窗口」——三处都描述「同键真并发靠 outRefundNo 去重返回同一笔」。改动后事务 A 首句 `FOR UPDATE`（`:172`）把同单的两个事务 A 串行化，后到者在 `:177` 看到先到者刚插入的 PENDING 行即报 42205，到不了 `:236` 的 create，P2002-idempotent 分支只剩「同键行已是终态（activeOrderId 为 NULL）」一种情形才会命中。注释与代码不符，会误导后续维护者。

处理（修订条目）：
- `refund.ts:156` 与 `:252-260` 注释改为：「同键请求在事务 A 被 `FOR UPDATE` 串行化：后到者在锁内看到先到者的在途行即报 42205；只有同键行已是终态（SUCCESS/CLOSED/FAILED，activeOrderId 为 NULL）时才会撞 outRefundNo 唯一索引，此时复用该行返回，不再二次外呼。」
- `71-refund-consistency.sh:121-127` 注释同口径改写。
- 「锁内发现同键在途行时直接返回这一行」是功能变更（改 42205 拒绝为幂等返回），本轮不做，记后续建议；当前 42205 拒绝不会造成重复退款，不是资金安全必要项。
- 验收：`grep -n "真并发窗口靠\|事务 A 提交前的真并发" apps/server/src/services/refund.ts scripts/e2e.d/71-refund-consistency.sh` 为 0。

### R14：不纳入本轮（记后续建议，优先级高）

依据：`grep -rn reconcileLastError apps/admin/src` 只命中 `types.ts:133` 与 `ResolveAbnormalRefundModal.tsx:58`；`DetailRefunds.tsx` 未渲染该字段——复核者事实成立。但「详情页展示 reconcileLastError」是新增后台展示，属功能扩展；R9 已保证晚到成功**必落账 + 留痕 + 6h 键告警**，钱没有多退，展示与否不改变资金结果，不构成资金安全必要。`later` 判定把店员之后另做的无关部分退款也标「疑似重复」——这是告警措辞偏保守（宁可多让人核对一次），不是漏报。

后续建议（下一批）：`DetailRefunds.tsx` 退款记录行展示 `reconcileLastError`（至少 late-success 三种文案）；`later` 判定可加「后续行 createdAt 晚于原行 successTime」等条件收窄误报。

### R7：不纳入本轮（记后续建议，沿用）

依据：`refund.ts:444-458` amountOverride 金额校验（42206）位于 `:520` 条件写（守卫 `status = expectStatus`，不命中返回 applied:false → 路由层 42204）之前；两个店员同时对同一 ABNORMAL 行做 D2 时，输家可能先撞 42206 而非 42204。只是提示码/文案差异，事务回滚、不落账、无资金影响；调换顺序是逻辑改动而非注释/文案改动，不属本轮零风险纳入范围。

---

## 授权范围变化
无新增文件。本轮修复只触及 `apps/server/src/services/refund.ts`（注释）、`apps/server/scripts/selftest-refund-reconcile.ts`、`scripts/e2e.d/71-refund-consistency.sh`（三者均在 allow.txt）。deny.txt 不变。

## 待用户决定
无。本裁决不涉及业务语义、兼容性取舍、授权范围变化、不可逆操作。

## 裁决者说明
- 本 worktree 无 `node_modules`（`apps/server/node_modules`、根 `node_modules` 皆不存在），执行者的 tsc/selftest 实际解析到主仓 `/Users/yumingyi/food-shop/node_modules`（Prisma 5.22.0）。对本轮结论无影响，交付时按 memory「worktree 共用 Prisma client」注意事项处理。
- 未运行 selftest/e2e 全量（裁决者不写代码，且现有用例对 R12 的结论已由代码推演 + InnoDB 实测锁定；复核者按 (C) 做反向验证）。
