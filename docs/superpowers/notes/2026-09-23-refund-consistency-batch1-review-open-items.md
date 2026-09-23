# 两轮再复核后仍未关闭的问题（复核者 Opus 5.5 原文，HEAD 9693039）

已关闭：首轮 R1–R6（第二轮确认）、R8/R9/R10/R11（第三轮确认）。R7 为建议，未修。

### R12 [需改]（新）
位置：
- `apps/server/scripts/selftest-refund-reconcile.ts:967-1034`
- `scripts/e2e.d/71-refund-consistency.sh` 的 71.5(a)(b)
- `refund.ts:172-182`
触发条件：把事务 A 的 `FOR UPDATE` 和锁内重验整段删掉，selftest 和 e2e 都几乎必然保持全绿。
依据：
- selftest「顺序构造」：先提交了 refundedAmount，再调 `initiateRefund`。事务外的「已全额退款」检查（42206）先拦住了，根本走不到锁内。执行者的注释里也承认这一点。
- selftest「真并发」：Y 的订单读取先发出，之后 Y 和 X 几乎同时进入事务 A。改动前，两个事务都插入 `activeOrderId = 同一订单` 的行，唯一索引让后插入的那个等待，再撞 P2002 报 42205，合计金额 ≤ 实付，断言照样绿。只有在「Y 的事务 A 恰好晚于 X 的 finalize 提交」时，改动前的代码才会变红，这个时序概率很低。
- e2e 71.5(a)(b)：两条断言期望的都是 42206，这个码来自事务外的 `amount > remaining` 检查。锁内重验失败报的是 42204，不可能报 42206。所以 71.5 验证的是事务外检查，注释说的「锁内重验命中点」不成立。
- 建议的确定性构造：
  1. 在另一个连接开事务 T，执行 `SELECT … FROM orders WHERE id=? FOR UPDATE`；
  2. 不 await，启动 `initiateRefund` 部分退款。它的事务外读是快照读，不会被锁住；它的事务 A 会卡在第一句；
  3. 等到 `performance_schema.data_lock_waits` 出现等待（或 sleep 约 300ms）；
  4. T 把 refundedAmount 改掉后提交；
  5. 断言 `initiateRefund` 报 42204，且没有新建退款行。
  改动前的代码在插入时虽然也会因外键共享锁等 T，但 T 提交后会照样插入成功，断言变红，所以这个构造能证伪。
- 方案 §8 原文里写的构造（T 在调用 `initiateRefund` 之前就提交）同样会先被事务外检查挡住，也证伪不了。执行者偏离了原构造是对的，但替代方案同样证伪不了。

### R13 [建议]（新）
位置：`refund.ts:156`、`:252-260` 的注释；`scripts/e2e.d/71-refund-consistency.sh:121-127` 的注释
触发条件：同一幂等键的两个请求真并发。
依据：事务 A 串行化以后，第二个请求在锁内看到第一个请求的 PENDING 行，直接报 42205；只有已存在的同键行是终态时才还能走到 P2002 幂等命中。上面三处注释还写着「真并发窗口靠 outRefundNo 去重、返回同一笔」，已经不成立。前端 RefundDialog.tsx:85 有 submitting 防重复提交，不同弹窗实例幂等键也不同，实际影响只是提示文案。建议改注释，或者在锁内发现同键的在途行时直接返回这一行。

### R14 [建议]（新）
位置：`apps/admin/src/components/orders/detail/DetailRefunds.tsx`（不展示 reconcileLastError）；`refund.ts:490-492`
触发条件：后续行已 SUCCESS 时，原行晚到的 SUCCESS 被 LEAST 封顶，订单 refunded_amount 看不出第二笔；告警 6 小时限频，推送被刷掉后后台没有任何「疑似重复退款」的持久标记。`later` 判定只看「同单、id 更大、在途或 SUCCESS」，店员之后另做的无关部分退款也会被标「疑似重复退款」。
依据：详情页退款记录只显示 errorMessage 和人工核实行，没有 reconcileLastError。建议详情页展示 reconcileLastError，至少展示 late-success 那几种文案。

### R7 [建议]（沿用）
`refund.ts:443-462` 金额校验仍排在条件写的状态守卫之前（并发 D2 时提示 42206 而非 42204）。
