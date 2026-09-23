【工序】规划 【模型】Claude Fable 5.1 【等级】L

# 第一批：退款资金一致性修复 —— 方案

BASE：fe9a5015a1d19358a958db2de04d26dafc1076d2（= main = 生产）。worktree：/Users/yumingyi/food-shop/.claude/worktrees/jolly-visvesvaraya-4c32f4。

## 0. 规划前核实结论（只读调查，均已亲自打开代码/跑命令）

| 项 | 结论 | 依据 |
|---|---|---|
| P4 推演成立 | `REFUND_ATTENTION_WHERE` 硬编码 `status:'REFUNDING'`；售后面板只对 `a.status==='PENDING'` 画按钮；服务端 approve 只接受 PENDING；顾客端 42208 在有 PENDING/APPROVED 售后单时拒绝再申请。于是「售后同意→部分退款 PROCESSING→CLOSED/ABNORMAL」的单：不进页签、售后面板无入口、顾客不能再申请，三面卡死 | `apps/server/src/routes/admin/orders.ts:201-204`、`apps/admin/src/components/AfterSalePanel.tsx:159`、`apps/server/src/routes/admin/after-sales.ts:83`、`apps/server/src/routes/orders.ts:1144-1149` |
| wechat-pay.ts 错误分类 | `createRefund` 只在「非 2xx 或无 refund_id」时抛 `WechatRefundError(code, message, httpStatus)`；超时/网络/JSON 解析失败抛普通 `Error`（`fetchWechatPay` 把 TimeoutError 转成普通 Error）。因此 `e instanceof WechatRefundError && 400≤httpStatus<500` 是「微信明确拒绝」的唯一可靠信号；5xx（SYSTEM_ERROR）与普通 Error 都属结果未知 | `apps/server/src/services/wechat-pay.ts:35-45,194-204,234-238` |
| pay-mock 能力不够 | 现有 mock 只覆盖 `queryRefund`；`initiateRefund` 在 `config.mock.pay` 下于 `refund.ts:249-252` 直接 `finalizeRefundSuccess` 秒成功，永远到不了 :254-300 的 WECHAT 分支。P2/P3 的 e2e 必须扩展 mock（见 §2 T1） | `apps/server/src/services/wechat-pay-mock.ts`、`apps/server/src/routes/admin/pay-mock.ts`、`refund.ts:130,249` |
| 权限体系 | `req.adminRole` 只在 JWT 里带着，全仓无任何路由按它做门控（`grep -rn adminRole apps/server/src` 只命中 auth.ts 赋值与 auth 路由回显）。新接口只能与 `/refund` 同级：登录即可 | `apps/server/src/middlewares/auth.ts:47`、`routes/admin/auth.ts` |
| 留痕字段 | Refund 表没有可放「人工核实人/时间/说明」的干净字段；`wxNotifyData` 已被补查复用写 `{source:'reconcile-query'}` JSON。需要加 3 个可空列（纯加列，可回滚只回代码） | `apps/server/prisma/schema.prisma:432-473`、`refund-reconcile.ts:137` |
| 列表 where 拼接隐患 | 列表接口 `where` 用对象展开拼装，`keyword` 分支也在顶层写 `OR`；P4 把 `REFUND_ATTENTION_WHERE` 改成 `OR` 后，两者展开会互相覆盖 | `routes/admin/orders.ts:146-161` |
| 本机 e2e 库 | food_shop_e2e：refunds 表 CLOSED 8 / FAILED 2 / SUCCESS 45，无在途行；users 21；after_sales DONE 2 / REJECTED 1。selftest 可直接对它跑 | `docker exec … mysql -N -e "SELECT status,COUNT(*) FROM food_shop_e2e.refunds GROUP BY status"` |
| high-risk.txt / check-scope.sh | BASE 中不存在（`ls .agent` 只有 agent-protocol.md）| 交付时写「未运行范围检查」 |

## 1. 验收标准

所有命令在 worktree 根目录起算；e2e 与 selftest 只许对本机 `food_shop_e2e` 跑。

1. `cd apps/server && npx prisma validate && npx prisma generate` → 退出码 0。
2. `cd apps/server && DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e" npx prisma migrate deploy` → 输出含新迁移目录名 `refund_manual_resolve` 且 `All migrations have been successfully applied`（或已应用无待迁移）。随后 `docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -N -e "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='food_shop_e2e' AND TABLE_NAME='refunds' AND COLUMN_NAME LIKE 'manual_%' ORDER BY 1"` → 恰好三行 `manual_resolve_note` / `manual_resolved_at` / `manual_resolved_by`。
3. `cd apps/server && npx tsc --noEmit` → 无输出，退出码 0。
4. `cd apps/admin && npx tsc --noEmit && npm test` → tsc 无输出；`npm test` 汇总 `fail 0`，`pass` ≥ 131 + 新增用例数；新增用例必须覆盖：`canResolveAbnormalRefund`（latestRefund ABNORMAL → true；PENDING/PROCESSING/SUCCESS/CLOSED/FAILED/无记录 → false，与订单状态无关）、`canApproveAfterSaleRefund` 对 APPROVED 售后 + 无在途退款 → true、APPROVED + 在途（PENDING/PROCESSING/ABNORMAL）→ false（若 §6 D3 选 B，则 APPROVED 仍走同一规则）。
5. 全量 e2e：先按「干净库配方」起 `api-e2e-3106`（`.claude/launch.json`，SCHEDULER_DISABLED=true、全 mock；起服务前完成第 2 条迁移），再 `TZ=Asia/Shanghai BASE=http://localhost:3106 DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tee /tmp/refund-fix-RqUw/e2e.log` → 末行 `通过 N / 失败 0`，N ≥ 2049 + 新增断言数；`grep -c '✘' e2e.log` 为 0；且 `grep '== 71\.' e2e.log` 能看到下列每个小节标题。新增分片 `scripts/e2e.d/71-refund-consistency.sh` 必须包含以下断言（编号即 ok/fail 文案前缀，缺一不可；断言值用 `sql`/接口回读，不许只断 HTTP code）：

   **71.1 P2 回调抢先（同步回写不得把 SUCCESS 改回 PROCESSING）**
   - 造数：`O=$(make_paid_order)`（actual_amount 记为 A，A>100）；`POST /api/admin/system/pay-mock/refund-create {"orderId":O,"directive":{"kind":"ok","status":"PROCESSING","preemptNotify":{"status":"SUCCESS"}}}`；`POST /api/admin/orders/O/refund {"amount":100,"reason":"71.1"}`。
   - `preemptNotify` 语义（见 T1）：mock 的 createRefund 在**返回之前**对该 outRefundNo 执行一次「回调已到达」= `finalizeRefundSuccess`，模拟微信回调抢在 `refund.ts:273` 落库之前完成。
   - 断言：响应 code 0，`.data.refund.status == SUCCESS`；`sql "SELECT status,active_order_id IS NULL,wx_response_data IS NOT NULL FROM refunds WHERE order_id=O"` → `SUCCESS 1 1`；`sql "SELECT refunded_amount FROM orders WHERE id=O"` → `100`（**不是 200**：这就是 P2 的判定点，部分退款让 LEAST 封顶失效，重复累加必被抓到）；订单状态仍 PAID；`GET /api/admin/system/pay-mock/calls?op=createRefund` 计数 +1。
   - 反向：同样造数但 `preemptNotify:{"status":"CLOSED"}` 且 `status:"SUCCESS"`（同步返回 SUCCESS、回调抢先 CLOSED）→ 退款行 `CLOSED`、`active_order_id IS NULL`=1、`refunded_amount=0`、订单 PAID；证明 count=0 时同步 SUCCESS 分支**没有**被 dispatch。

   **71.2 P3 结果未知不标 FAILED**
   - (a) 全额：`refund-create {"orderId":O,"directive":{"kind":"timeout"}}` → `POST /refund {amount:A}` → 响应 code `50202`（HTTP 502），message 含「结果未知」；`refunds.status=PENDING`、`active_order_id=O`、`error_code LIKE 'UNCERTAIN%'`；订单 `REFUNDING`；`?status=REFUND_ATTENTION` 不含 O（在途不算要人出手）；再次 `POST /refund {amount:A}`（新请求、不带幂等键）→ `42205`。然后 `refund-query O.outRefundNo {"kind":"ok","status":"SUCCESS","amount":A}` + `rr68_sched` 同款调用（三阈值 0）→ `SUCCESS`、订单 `REFUNDED`、`refunded_amount=A`。
   - (b) 部分 + 查无：`timeout` 指令 → `POST /refund {amount:100}` → 50202；`refund-query … {"kind":"not_found"}` + sched → `FAILED`、`error_code=RECONCILE_NOT_FOUND`、`active_order_id IS NULL`；再 `POST /refund {amount:100}`（无指令，走原 MOCK 秒成功）→ code 0、`refunded_amount=100`。
   - (c) 明确拒绝仍 FAILED：`{"kind":"error","code":"NOT_ENOUGH","httpStatus":403}` → `50201`、`status=FAILED`、`error_code=NOT_ENOUGH`、`active_order_id IS NULL`。
   - (d) 5xx 属未知：`{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}` → `50202`、`status=PENDING`、`active_order_id=O`。
   - (e) 幂等重放：对 (d) 的单，用**同一 idempotencyKey** 再 `POST /refund {amount, idempotencyKey:"k71e-…"}`（首发也带同一键）→ code 0、`.data.refund.status==PENDING`、`calls?op=createRefund` 计数不变（不二次外呼）。
   - 收尾：(d)(e) 留下的 PENDING 行用 `refund-query not_found + sched` 推成 FAILED（不许直接 SQL 改状态，顺带再验一次 (b) 路径）。

   **71.3 P1 人工出口（只对 ABNORMAL 行）**
   - 造 ABNORMAL：沿用 68 的 `rr68_stuck full PROCESSING` + `refund-query not_found` + sched（68.7b 形态），取 refundId `RID=$(sql "SELECT id FROM refunds WHERE out_refund_no='…'")`。
   - 守卫断言（每条一个独立造数或复用同一行，按顺序）：
     - 对一条 **PROCESSING** 行调 `POST /api/admin/orders/O/refunds/RID/resolve-abnormal {"result":"SUCCESS","verifiedAmount":A,"note":"商户平台已核对"}` → `42204`，行状态不变。
     - refundId 不属于该订单（用别的订单 id）→ `40401`。
     - 缺 `note` / `note` 少于 4 字 → `40001`（zod）。
     - `verifiedAmount` > 可退余额 → `42206`；`verifiedAmount ≠ refund.amount` 时按 §6 D2：选 A → 走 71.3 末尾的实退金额用例；选 B → `42206`。
   - 主路径（全额 ABNORMAL）：`resolve-abnormal {"result":"SUCCESS","verifiedAmount":A,"note":"商户平台退款单 500…已核对"}` → code 0；`sql "SELECT status,active_order_id IS NULL,manual_resolved_by,manual_resolve_note IS NOT NULL,manual_resolved_at IS NOT NULL,wx_notify_data LIKE '%manual-verified%' FROM refunds WHERE id=RID"` → `SUCCESS 1 admin 1 1 1`；`orders.status=REFUNDED`、`refunded_amount=A`、`payments.status=REFUNDED`；`GET /api/admin/print-jobs?orderId=O` 中 `kind=="CANCEL"` 恰好 1 条（走了 finalizeRefundSuccess 的出票，且与 initiateRefund 那次去重——本单是 SQL 直插的 REFUNDING，此前未出过票，所以恰好 1）；`?status=REFUND_ATTENTION` 不再含 O；再次同样调用 → `42204`（已不是 ABNORMAL）。
   - 部分 ABNORMAL（`rr68_stuck partial PROCESSING` → not_found → ABNORMAL，订单 PAID）：resolve SUCCESS `verifiedAmount:100` → 行 SUCCESS、订单仍 `PAID`、`refunded_amount=100`、`remainingRefundable=A-100`（`GET /api/admin/orders/O`）、之后 `POST /refund {amount:A-100}` → code 0、订单 REFUNDED（证明在途位已释放、余额算对）。
   - 若 D1 选 A：ABNORMAL（全额）→ `resolve-abnormal {"result":"CLOSED","verifiedAmount":A,"note":"商户平台查无此退款，未退"}` → code 0；行 `CLOSED`、`active_order_id IS NULL`、manual 三列已写、订单仍 `REFUNDING`、`refunded_amount=0`；`?status=REFUND_ATTENTION` 含 O；`POST /refund {amount:A}` → code 0、订单 REFUNDED。
   - 若 D2 选 A：ABNORMAL 行 amount=300（`rr68_stuck` 改 AMT=300 或直插）→ `resolve SUCCESS verifiedAmount:200 note:"实退 2 元"` → 行 `amount=200`、`SUCCESS`、`refunded_amount=200`、`manual_resolve_note` 含「原记录 300」（服务端自动前缀）；`verifiedAmount: A+1` → 42206 且行仍 ABNORMAL。

   **71.4 P4「退款待处理」口径**
   - 部分退款 ABNORMAL（订单 PAID）→ `rr68_attn O`=1、`refundAttentionByChannel.EXPRESS` +1、列表项 `latestRefund.status==ABNORMAL` 且 `latestRefund.reconcileLastError` 非空；resolve 后 → 0。
   - `?status=REFUND_ATTENTION&keyword=<O 的订单号>` → 列表恰含 O（锁住 OR 与 keyword 不互相覆盖）；`?status=REFUND_ATTENTION&keyword=不存在的号` → 空。
   - 售后 APPROVED 卡住：按 e2e.sh §13 的方式造 SHIPPED 单 + 顾客 `POST /api/orders/O/after-sale`，取 AS；`refund-create {"orderId":O,"directive":{"kind":"ok","status":"PROCESSING"}}`；`POST /api/admin/after-sales/AS/approve {"amount":100,"reply":"71.4"}` → code 0、`afterSale.status==APPROVED`、`refund.status==PROCESSING`；`rr68_attn O`=0；`refund-query <outRefundNo> {"kind":"ok","status":"CLOSED"}` + sched → 退款 CLOSED、售后仍 APPROVED、`rr68_attn O`=**1**（新口径）；`GET /api/admin/after-sales?status=APPROVED` 含 AS 且 `order.latestRefund.status==CLOSED`；再 `POST /after-sales/AS/approve {"amount":100,"reply":"重新退"}`（无指令，MOCK 秒成功）→ code 0、`afterSale.status==DONE`、`refund_id` 指向新行、`rr68_attn O`=0；顾客 `POST /api/orders/O/after-sale` 此时不再 42208（售后已 DONE）——只在 SHIPPED 仍可申请时断言，否则跳过并写明。
   - 若 D3 选 A：另造一单同上到「售后 APPROVED + 退款 CLOSED」，改从订单页入口 `POST /api/admin/orders/O/refund {"amount":100}` → 售后单 `DONE` 且 `refund_id` = 新退款 id、`rr68_attn O`=0。选 B：断言售后仍 APPROVED、`rr68_attn O`=1，列表项带 `afterSale.status==APPROVED`。
   - 既有 68.7「PAID + FAILED 不进」保持；新增「PAID + CLOSED、无售后单 → 不进」（D5 选推荐项时）；「REFUNDING + 无退款记录 → 进」保持（68.1 已有）。
   - 若 D4 选 A：`rr68_stuck full PROCESSING` + `refund-query {"kind":"ok","status":"CLOSED","amount":999999}` + sched → `CLOSED`、`active_order_id IS NULL`、`reconcile_last_error` 含「金额」（仍记录）、告警键 `refund-reconcile-mismatch` 的行为按 T5 说明；选 B → `ABNORMAL`（68.8 现状）。
   - 分片收尾：把本分片留下的在途行全部推到终态（优先走接口/补查，不得留 PENDING/PROCESSING/ABNORMAL），`pay-mock/reset`，并断言 `calls?op=createRefund` 与 `?op=queryRefund` 清零、`GET /api/admin/system/pay-mock/pending` 若实现则为空（否则以 reset 为准）。
   - 分片开头必须 `pay-mock/reset`；所有变量 `RC71_` 前缀；不得改动 68 分片的断言。

6. 补查自测脚本（P5）：
   ```
   cd apps/server && TZ=Asia/Shanghai \
     DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e" \
     JWT_SECRET=selftest_jwt_secret_0123456789 ADMIN_JWT_SECRET=selftest_admin_secret_0123456789 \
     npx ts-node --transpile-only scripts/selftest-refund-reconcile.ts
   ```
   前提：不设 `WECHAT_PAY_MOCK`（脚本头注释已说明原因；`.env` 若含该键，命令行显式 `WECHAT_PAY_MOCK=false` 覆盖）；e2e 服务可以开着但**不能正在跑 e2e**（用例 10 扫全表）。期望：每个用例行以 `✔` 开头，末行 `================ 通过 N / 失败 0 ================`，退出码 0，N ≥ 19 + 新增数。必须改/加的用例：
   - 用例 8（PROCESSING 查无）：断言 outcome `'ABNORMAL'`、status `ABNORMAL`、`active_order_id` 仍占位、告警键 `refund-reconcile-notfound:<id>` 带 6h 窗口、`refund-abnormal:<id>` 告警恰好 1 次。
   - 用例 9（金额不符 SUCCESS）：outcome `'ABNORMAL'`、status `ABNORMAL`、`refundedAmount=0`；若 D4 选 A，追加「CLOSED + 金额不符 → outcome CLOSED、status CLOSED、activeOrderId null」。
   - 用例 14：改用 4xx（`NOT_ENOUGH`, 403）→ FAILED；新增 5xx（`SYSTEM_ERROR`, 500）→ 抛 AppError code 50202、行 PENDING、activeOrderId 占位、`errorCode` 以 `UNCERTAIN_` 开头、告警键 `refund-uncertain:<id>` 1 次。
   - 新增 P3：stub 抛普通 `Error('微信支付请求超时')` → 同 5xx 断言；随后 `reconcileRefund(id, not_found)` → FAILED。
   - 新增 P2：stub 在返回 `{status:'PROCESSING'}` 前先 `await refundMod.finalizeRefundSuccess({refundId})`（stub 可通过 `prisma.refund.findUnique({where:{outRefundNo: params.outRefundNo}})` 拿 id）→ initiateRefund 返回 `refund.status==='SUCCESS'`，订单 `refundedAmount` 恰好一次（用 1000 中退 100），`refundResultCalls` SUCCESS 恰好 1，`wxResponseData` 非空；反向 stub 先 `markRefundClosed` 再返回 `SUCCESS` → 行 CLOSED、`refundedAmount=0`、SUCCESS 通知 0 次。
   - 新增 `markRefundFailed` 守卫收窄：对 PROCESSING 行调用 → count 0、状态不变、无告警。
   - 新增 P1：ABNORMAL 行 `finalizeRefundSuccess({refundId, expectStatus:'ABNORMAL', manual:{by:'selftest',note:'n',at:new Date()}})` 返回 `{applied:true}`、三列已写、订单 REFUNDED；再次调用 `{applied:false}`；对 PROCESSING 行传 `expectStatus:'ABNORMAL'` → `{applied:false}` 且行仍 PROCESSING、无通知。若 D1 选 A：`markRefundClosed(id, raw, {expectStatus:'ABNORMAL', manual})` 同样一正一反。若 D2 选 A：`amountOverride` 一正（300→200）一反（超余额抛 42206 且状态不变、`refundedAmount` 不变）。
   - 脚本头注释的「覆盖」清单同步更新。
7. 人工检查（浏览器，`admin` 指向 3106 的 dev server，登录 admin/admin123456）：用 71.3 的方式留一条 ABNORMAL 单（跑完 e2e 后单独造）→ 邮寄订单页「退款待处理」页签：该行显示「退款异常」提示与「已在商户平台核实」按钮；点击 → 第一步显示退款单号/金额/异常原因、结果单选、实退金额、说明必填；「下一步」→ 红色确认框要求重输金额、按钮在不一致时禁用；确认 → toast、行从页签消失、详情页「退款记录」显示「人工核实：admin · 时间 · 说明」。同城订单页与订单详情页各截一张有该按钮的图。判定标准：三处都能点到同一个弹窗；PROCESSING/CLOSED/FAILED 行不出现该按钮。
8. 文档：`docs/api.md` 新增接口条目与 50202、`?status=REFUND_ATTENTION` 口径、pay-mock 新端点；`docs/order-flow.md` 状态表 REFUNDING→REFUNDED 加「人工核实（仅 ABNORMAL）」；`docs/staff-guide.md` §四「退款待处理」段改写（包含部分退款异常单、售后退款关闭单、结果未知提示语与「已在商户平台核实」按钮用法）。判定：`grep -n "resolve-abnormal" docs/api.md`、`grep -n "50202" docs/api.md`、`grep -n "已在商户平台核实" docs/staff-guide.md` 各 ≥1 处。

## 2. 实现方向

### T1 扩展支付 mock（P2/P3/P4 e2e 的前提）
预计涉及：`apps/server/src/services/wechat-pay-mock.ts`、`apps/server/src/routes/admin/pay-mock.ts`、`apps/server/src/services/refund.ts`。
- `wechat-pay-mock.ts` 新增 createRefund 指令队列，按 **orderId** 键（`'*'` 通配；e2e 在 POST /refund 之前就知道 orderId，而 outRefundNo 要到事务 A 之后才有）：
  ```ts
  type RefundCreateDirective =
    | { kind: 'ok'; status: 'SUCCESS'|'CLOSED'|'PROCESSING'|'ABNORMAL'; amount?: number; refundId?: string; successTime?: string;
        preemptNotify?: { status: 'SUCCESS'|'CLOSED'|'ABNORMAL' } }
    | { kind: 'error'; code: string; message?: string; httpStatus?: number }
    | { kind: 'timeout' }
  queueRefundCreateDirective(d, orderId='*'); hasRefundCreateDirective(orderId): boolean（只看不取）
  mockCreateRefund(orderId, params: RefundParams): Promise<RefundResult>（取指令、记 calls[{op:'createRefund',…}]）
  applyMockRefundNotify(outRefundNo, status): Promise<void>
  ```
  - `timeout` → `throw new Error('微信支付请求超时（mock）')`（与 `fetchWechatPay` 同形状）；`error` → `throw new WechatRefundError(code, msg, httpStatus ?? 500)`；`ok` → 返回 `{ refund_id, out_refund_no, status, success_time, amount:{refund: amount ?? params.amount, total: params.total} }`。
  - `preemptNotify`：在返回**之前** `await applyMockRefundNotify(params.outRefundNo, preemptNotify.status)`。`applyMockRefundNotify` 用**函数内** `await import('./refund')`（避免 refund.ts ↔ wechat-pay-mock.ts 模块级循环引用）按 status 调 `finalizeRefundSuccess({refundId, wxRefundId:'mock_notify_…', rawData: JSON.stringify({source:'mock-notify'}), rawField:'wxNotifyData'})` / `markRefundClosed(id, raw)` / `markRefundAbnormal(id, raw)`——与 `routes/wechat-notify.ts:381-396` 的 dispatch 完全同形，只是跳过验签/解密。行 id 由 `prisma.refund.findUnique({where:{outRefundNo}})` 取得。
  - `getPayMockCalls(op)` 扩成 `'queryRefund' | 'createRefund'`；`resetPayMock` 同时清两条队列。
- `pay-mock.ts` 新增：`POST /refund-create {orderId?, directive}`（校验同 refund-query 的风格：kind 白名单、status 四值、amount 非负整数、preemptNotify.status 三值）；`POST /refund-notify {outRefundNo, status}`（直接 `applyMockRefundNotify`，供需要在两次请求之间插回调的用例）；`GET /calls?op=createRefund`。
- `refund.ts` `initiateRefund`：
  ```ts
  const simulateWechat = mode === 'MOCK' && hasRefundCreateDirective(orderId)   // 无指令 → 与现在逐字节一致
  if (mode === 'MOCK' && !simulateWechat) { …原 :249-252 不动… }
  if (!simulateWechat) validatePayConfig()
  const create = simulateWechat ? (p) => mockCreateRefund(orderId, p) : createRefund
  ```
  模拟路径下 Refund.mode 仍写 `'MOCK'`（诚实：钱没真动），`result.mode` 仍 `'mock'`；`:131` 那条「模拟支付订单无法发起微信退款」只看 `mode==='WECHAT'`，不受影响。
- 记得 `config.mock.pay===false`（生产）时 `hasRefundCreateDirective` 永远不会被查（短路在 `mode==='MOCK'` 之后），生产零影响。

### T2 P2：同步回写改条件写，count=0 不再 dispatch
预计涉及：`apps/server/src/services/refund.ts:264-293`。
- `prisma.refund.update({where:{id}})` → `prisma.refund.updateMany({ where: { id: refund.id, status: 'PENDING' }, data: { wxRefundId, status:'PROCESSING', channel, wxResponseData } })`。
- `count === 0`：只补写 `wxResponseData`（`update({where:{id}, data:{wxResponseData}})`，不碰 status/wxRefundId/channel——wxRefundId 有唯一索引，回调已写过同值，重写无害但没必要），`console.info('[refund] 同步回写落空：回调已抢先推进到 <当前状态>')`，**跳过** :282-293 的 SUCCESS/ABNORMAL/CLOSED 分支，直接 `reload` 返回。
- 互斥依据：见 §3 状态写者表。行离开 PENDING 之后只有 finalize/mark* 能再动它，:273 永远写不回 PROCESSING。

### T3 P3：只有微信明确拒绝才 FAILED；结果未知保留在途
预计涉及：`apps/server/src/services/refund.ts:254-300, 482-504`、`apps/server/src/routes/wechat-notify.ts:229-236`、`apps/server/src/middlewares/error.ts`（只读，确认 AppError(code,msg,http) 形状）。
- try/catch 收窄到**只包 `create(...)` 一句**。分类函数（放 refund.ts 内、可导出供 selftest）：
  `isDefiniteRefundRejection(e) = e instanceof WechatRefundError && e.httpStatus >= 400 && e.httpStatus < 500`。
  - 明确拒绝：`markRefundFailed(refund.id, e.code, e.message)` + `throw new AppError(50201, …)`（与现在一致）。
  - 未知（普通 Error、5xx、`HTTP_2xx` 无 refund_id）：`prisma.refund.updateMany({ where:{ id, status:'PENDING' }, data:{ errorCode: ('UNCERTAIN_' + code).slice(0,64), errorMessage: msg.slice(0,255) } })`（不改 status、不释放 activeOrderId）；`notifySystemAlert('微信退款结果未知，系统将自动核对', [订单, 金额, 错误, '5 分钟后开始每 5 分钟向微信查询；查无此单会自动释放并可重试，请勿在商户平台重复退款'], { key:`refund-uncertain:${refund.id}` })`；`throw new AppError(50202, '微信退款结果未知：' + msg + '。退款单已保留，系统将自动向微信核对，请勿重复发起', 502)`。
- createRefund 之后的 DB 操作（条件写、finalize/mark*）移出 try：若抛错，包一层 `catch → notifySystemAlert('微信已受理退款，本地记录失败', …, {key:`refund-local-fail:${id}`}) ; throw new AppError(50202, '微信已受理退款，但本地记录失败：…，系统将自动核对', 502)`——行留在 PENDING/PROCESSING 交补查。
- `markRefundFailed` 守卫收窄为 `status: 'PENDING'`（PROCESSING 已拿到 refund_id，结局只能是 SUCCESS/CLOSED/ABNORMAL；补查的 not_found→FAILED 本就只对 PENDING）。函数头注释同步改。
- `refund.ts:79` 函数注释与 :298 注释更新（50201 = 明确失败可重试；50202 = 在途待核对）。
- `wechat-notify.ts:229-236` 迟到付款自动退款的 catch：`err instanceof AppError && err.code===50202` 时告警标题改「取消订单收到付款，自动退款结果未知（系统将自动核对）」，其余不变。
- 前端不改 RefundDialog（店主决定）：50202 的 message 由现有 `serverMessage` 路径原样 toast，已足够。

### T4 P1：ABNORMAL 行的窄口径人工出口
预计涉及：`apps/server/prisma/schema.prisma`、新迁移 `apps/server/prisma/migrations/20260923000000_refund_manual_resolve/migration.sql`、`apps/server/src/services/refund.ts`（finalizeRefundSuccess / markRefundClosed 签名）、`apps/server/src/routes/admin/orders.ts`、admin 端 7 个文件。
- 迁移（纯加列，回滚只回代码）：
  ```sql
  ALTER TABLE `refunds`
    ADD COLUMN `manual_resolved_by` VARCHAR(64) NULL,
    ADD COLUMN `manual_resolved_at` DATETIME(3) NULL,
    ADD COLUMN `manual_resolve_note` VARCHAR(120) NULL;
  ```
  Prisma 字段 `manualResolvedBy / manualResolvedAt / manualResolveNote`。
- `finalizeRefundSuccess(input)` 增加可选 `expectStatus?: 'ABNORMAL'`、`amountOverride?: number`（D2 选 A 才实现）、`manual?: { by: string; note: string; at: Date }`，返回值改为 `Promise<{ applied: boolean }>`（现有调用方全部忽略返回值，兼容）：
  - 条件写的 where：`{ id, status: input.expectStatus ?? { not: 'SUCCESS' } }`——人工路径只允许从 ABNORMAL 翻；与回调/补查同一把 FOR UPDATE、同一条 updateMany，谁先拿到锁谁赢，输家 count=0 → `applied:false`。
  - `manual` 三列并入同一条 updateMany 的 data（原子，不会出现「留痕写了、状态没翻」）。
  - D2 选 A 时：锁后重读 order，校验 `0 < amountOverride ≤ actualAmount - refundedAmount` 否则 `throw new AppError(42206,…)`（事务回滚、状态不变）；`data.amount = amountOverride`；后续 `LEAST(refunded_amount + X, …)`、`deductPointsOnRefund(…, {amount: X})` 一律用 `updated.amount`（cond write 之后重读的行），不再用 cond write 之前读到的 `refund.amount`。
  - 不传 `operator`（保留发起人），人工信息走三列 + `rawData`。
- `markRefundClosed(refundId, rawData?, opts?: { expectStatus?: 'ABNORMAL'; manual?: … })` 同样返回 `{applied}`；where 为 `status: opts.expectStatus ?? { in: ACTIVE }`。（D1 选 B 则不改此函数。）
- 路由 `POST /api/admin/orders/:id/refunds/:refundId/resolve-abnormal`（`routes/admin/orders.ts`，放在 `/:id/refund` 附近；权限 = 与 `/refund` 相同，登录管理员即可——全仓无角色门控，见 §0）：
  - zod：`{ result: z.enum(['SUCCESS','CLOSED'])（D1 选 B 则只 'SUCCESS'）, verifiedAmount: z.number().int().positive(), note: z.string().trim().min(4).max(100) }`。
  - 读 refund（`findUnique({where:{id: refundId}})`），`!refund || refund.orderId !== id` → 40401「退款单不存在」；`refund.status !== 'ABNORMAL'` → 42204「退款单当前状态为 X，仅「退款异常」可人工核实」（这是接口层的快速拒绝，真正的互斥仍靠 finalize/markClosed 里的条件写）。
  - `result==='SUCCESS'`：`verifiedAmount > remainingRefundable(order)` → 42206；D2 选 B 且 `verifiedAmount !== refund.amount` → 42206「实退金额与记录不符（记录 ¥X），请联系开发核对」；`note` 最终写库值：D2 选 A 且金额不同时自动前缀 `原记录 ¥X → 实退 ¥Y；`（总长仍 ≤120）。调 `finalizeRefundSuccess({ refundId, expectStatus:'ABNORMAL', amountOverride?, rawData: JSON.stringify({source:'manual-verified', result, operator: req.adminUsername, note, verifiedAmount, at}), rawField:'wxNotifyData', manual:{by: req.adminUsername ?? 'admin', note, at} })`；`!applied` → 42204「退款状态已变化，请刷新后重试」。
  - `result==='CLOSED'`（D1 A）：`verifiedAmount` 须等于 `refund.amount`（这里只是让店员再对一次单号金额，不改金额）；`markRefundClosed(refundId, rawData, {expectStatus:'ABNORMAL', manual})`；`!applied` → 42204。
  - 响应：`{ refund: 重读行, order: 重读订单 }`。
  - 不要另写任何金额/状态/积分/出票逻辑：finalize 自带 refundedAmount 封顶、payment→REFUNDED、售后→DONE、deductPointsOnRefund、CANCEL 票、通知。
- 列表/详情返回：`orderListSelect.refunds.select` 与 after-sales 的 `refunds.select` 加 `reconcileLastError`（弹窗展示异常原因）；详情 `refunds` 是整行，自动带三列。
- admin 端：
  - `types.ts`：`RefundSummary` 加 `reconcileLastError: string | null`；`RefundRecord` 加 `manualResolvedBy/manualResolvedAt/manualResolveNote`。
  - `api/admin.ts`：`resolveAbnormalRefund(orderId, refundId, { result, verifiedAmount, note })`。
  - `utils/order-actions.ts`：`canResolveAbnormalRefund(o: { latestRefund?: {status} | null }) = latestRefund?.status === 'ABNORMAL'`（与订单状态无关——P4 让非 REFUNDING 单也进页签）；`refundingHint` 保持。测试加进 `order-actions.test.ts`。
  - 新组件 `components/ResolveAbnormalRefundModal.tsx`（照 RefundDialog 的两步结构，不复用它——那个弹窗店主已决定不动）：props `{ order: Pick<Order,'id'|'orderNo'|'remainingRefundable'|'latestRefund'>, onClose, onDone }`。第一步：退款单号、金额、异常原因（`latestRefund.reconcileLastError ?? errorMessage ?? '微信返回退款异常'`）、一段说明「请先在微信商户平台 → 交易中心 → 退款查询里按退款单号核对，再选择结果」、结果单选「微信已退款成功 → 记为已退款」/（D1 A）「微信未退款 → 释放，可重新发起」、实退金额（预填记录金额；D2 B 时只读）、说明必填（≥4 字）。第二步：红色确认框，文案「确认后系统将按 ¥X 记为已退款、扣回对应积分并通知顾客，此操作不可撤销；若微信其实未退，会造成重复退款」（CLOSED 则「将释放该退款占位，之后重新发起会再退一次钱；请确认商户平台确实没有这笔退款」），必须重输金额一致才能提交，提交中禁用遮罩/Esc。成功 toast「已按人工核实结果处理」。
  - `pages/Orders.tsx` `renderRefundActions`：REFUNDING 与非 REFUNDING 两个分支里，`canResolveAbnormalRefund(order)` 为真时都画按钮「已在商户平台核实」（danger 样式）并保留「退款异常」提示；页面持有一份 `resolveTarget` state + 弹窗，onDone 刷新列表与计数。`pages/LocalOrders.tsx` 同样（两处：`canRefund` 分支与 `status==='REFUNDING'` 分支）。`components/orders/detail/DetailActions.tsx` 加 `onResolveAbnormal` prop 画同一按钮；`pages/OrderDetail.tsx` 持有弹窗（与 RefundDialog 同一理由：fixed 底栏是新的层叠上下文）。`DetailRefunds.tsx`：有 `manualResolvedBy` 的行多一行小字「人工核实：{by} · {fmtMonthDayTime(at)} · {note}」。

### T5 P4：「退款待处理」新口径 + 售后重新退款
预计涉及：`apps/server/src/routes/admin/orders.ts`（REFUND_ATTENTION_WHERE、列表 where 组装）、`apps/server/src/routes/admin/after-sales.ts`、`apps/server/src/services/refund.ts`（D3）、`apps/server/src/services/refund-reconcile.ts`（D4）、`apps/admin/src/components/AfterSalePanel.tsx`、`apps/admin/src/utils/order-actions.ts`。
- 常量改为（仍只定义一处，列表与三个 count 共用）：
  ```ts
  const IN_FLIGHT = ['PENDING', 'PROCESSING'] as const
  export const REFUND_ATTENTION_WHERE: Prisma.OrderWhereInput = { OR: [
    { status: 'REFUNDING', refunds: { none: { status: { in: [...IN_FLIGHT] } } } },        // 原口径：全额退款卡住/无退款记录
    { refunds: { some: { status: 'ABNORMAL' } } },                                          // 任何订单状态下的退款异常（含部分退款）
    { afterSales: { some: { status: 'APPROVED' } }, refunds: { none: { status: { in: [...IN_FLIGHT] } } } }, // 售后已同意但退款没在路上（CLOSED/FAILED）
  ] }
  ```
  D5 采用推荐项（无售后单的部分退款 CLOSED 不进）时不再加分支；若店主要求进，需改成两步（先 raw SQL 求「最近一笔为 CLOSED」的 order_id 集合再 `id in`），执行者遇到该情况按上报条件停下。
- 列表 where 组装（:146-161）改为显式 `AND: [ statusWhere, attentionWhere, dtWhere, createdAtWhere, scWhere, keywordWhere ].filter(非空)`，杜绝顶层 `OR` 互相覆盖；三个 count 用 `{ AND: [REFUND_ATTENTION_WHERE, { deliveryType… }] }`。注释里的「命中四种」改为新口径。
- after-sales `approve`：允许 `status==='PENDING'`，或 `status==='APPROVED'` 且该订单无在途退款（`refunds.some(ACTIVE)` 为空——`initiateRefund` 也会以 42205 兜底）；否则 42204。后面的 `afterSale.updateMany` where 改 `status: { in: ['PENDING','APPROVED'] }`。列表 `orderSummarySelect.refunds.select` 加 `id, reconcileLastError`。
- `AfterSalePanel.tsx`：按钮条件改 `a.status==='PENDING' || (a.status==='APPROVED' && !hasActiveRefund(a.order))`，APPROVED 时文案「重新退款」；`拒绝` 仍只 PENDING；传给 RefundDialog 的 `latestRefund` 改传 `a.order.latestRefund`（现在写死 null）。`canApproveAfterSaleRefund` 本身已覆盖 REFUNDING/在途判断，不必改签名；只加测试。
- D3 选 A：`finalizeRefundSuccess` 事务内 :391-396 改为：`refund.afterSaleId` 有值 → 原样；无值 → `tx.afterSale.updateMany({ where: { orderId: refund.orderId, status: 'APPROVED' }, data: { status:'DONE', refundId: refund.id, handledAt } })`。选 B：不改，订单列表项已带 `afterSale`，两个订单页对 `afterSale?.status==='APPROVED' && !hasActiveRefund` 的行显示灰字「售后退款未完成，去售后页签重新退款」。
- D4 选 A：`refund-reconcile.ts:122-135` 把 `r.status==='CLOSED'` 的判断提到金额比对之前（CLOSED = 未退款、无资金变动，先 `markRefundClosed` 再照旧记录 `reconcileLastError`「金额不一致」并保留 mismatch 告警）；选 B 不动。文件头注释同步。
- `docs/staff-guide.md:48` 「空的就没事」这句要改成能自圆其说的新口径描述。

### T6 P5：selftest 对齐
预计涉及：`apps/server/scripts/selftest-refund-reconcile.ts`。用例改动见 §1 第 6 条；`createRefundStub` 的 monkeypatch 方式（`require('../src/services/wechat-pay').createRefund = …`）在 T3 收窄 try 之后仍成立，因为 `initiateRefund` 仍通过模块对象调用 `createRefund`——执行者要确认 T1 引入 `const create = simulateWechat ? … : createRefund` 时**不要**把 `createRefund` 解构成模块顶层常量（那会让 monkeypatch 失效），保持在函数内引用 `wechatPay.createRefund` 或按现有 import 用法在调用点引用。

### T7 文档
`docs/api.md`（接口条目、错误码表加 50202、REFUND_ATTENTION 口径、附录 L pay-mock 新端点）、`docs/order-flow.md:137` 状态表、`docs/staff-guide.md` §四。不改其它文档。

## 3. 状态写者与互斥依据（执行者与复核者都按此表核对）

| 写者 | 语句形态 | where 守卫（status） | 目标 | 输掉时（count=0）的行为 |
|---|---|---|---|---|
| initiateRefund 事务 A | `refund.create`（activeOrderId 唯一索引） | — | PENDING | P2002 → 幂等命中复用 / 42205 |
| initiateRefund 同步回写 :273（T2） | `updateMany` | `= 'PENDING'` | PROCESSING | 只补写 wxResponseData，**不 dispatch** |
| initiateRefund 未知错误记录（T3） | `updateMany` | `= 'PENDING'` | 不改 status，只写 errorCode/Message | 静默 |
| initiateRefund 事务 A 头句（裁决 R9 新增） | `SELECT id FROM orders … FOR UPDATE` + 锁内重读 refunds/refundedAmount | 锁内再判：有 ACTIVE 行 → 42205；余额与锁外快照不一致 → 42204 | （占位，不写） | 抛错，事务回滚 |
| finalizeRefundSuccess | `FOR UPDATE refunds→orders` + `updateMany` | **`≠ 'SUCCESS'`**（裁决 R9：恢复为「非 SUCCESS 皆可」，CLOSED/FAILED 行收到微信 SUCCESS 按微信结果落账；R6 的「收紧」撤销）；人工路径 `= 'ABNORMAL'` | SUCCESS + activeOrderId=null | `applied:false`，无副作用。**行原是 CLOSED/FAILED 且非人工调用时照常落账，但额外：锁内查同单 id 更大的 ACTIVE/SUCCESS 行 → 有则告警「疑似重复退款」，无则告警「终态后微信推成功已自动落账」；行带 manualResolvedBy → 告警「人工核实被微信推翻」；wxNotifyData 追加不覆盖**（见 §8 R9/R10） |
| markRefundAbnormal | `updateMany` | `in (PENDING, PROCESSING)` | ABNORMAL（保留占位） | 不通知 |
| markRefundClosed | `updateMany` | `in (PENDING, PROCESSING, ABNORMAL)`；人工路径 `= 'ABNORMAL'` | CLOSED + activeOrderId=null | `applied:false`，不通知 |
| markRefundFailed（T3 收窄） | `updateMany` | `= 'PENDING'` | FAILED + activeOrderId=null | 不通知 |
| reconcileRefund CAS | `updateMany` | `reconcileCheckedAt = 读到的旧值` | 占坑 | SKIPPED |

合法迁移：PENDING→{PROCESSING, SUCCESS, ABNORMAL, CLOSED, FAILED}；PROCESSING→{SUCCESS, ABNORMAL, CLOSED}；ABNORMAL→{SUCCESS, CLOSED}；**CLOSED/FAILED→SUCCESS 只允许由微信 SUCCESS 信号触发且必带告警（裁决 R9）**；SUCCESS 不可再改。每个写者都是**单条**条件 UPDATE，任意两个并发写者对同一行最多一个命中；所有副作用（累加 refundedAmount、积分、出票、通知、after-sale DONE）只挂在命中的那一次上。P2 修的正是「:273 无条件写」这唯一一个不守表的写者；P1 的 `applied` 返回值让接口层能诚实地把「输了」报成 42204 而不是 200。

## 4. 授权范围
```
apps/server/src/services/refund.ts
apps/server/src/services/refund-reconcile.ts
apps/server/src/services/wechat-pay-mock.ts
apps/server/src/services/wechat-pay.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/after-sales.ts
apps/server/src/routes/admin/pay-mock.ts
apps/server/src/routes/wechat-notify.ts
apps/server/src/routes/orders.ts
apps/server/prisma/schema.prisma
apps/server/prisma/migrations/20260923*_refund_manual_resolve/migration.sql
apps/server/scripts/selftest-refund-reconcile.ts
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/utils/order-actions.ts
apps/admin/src/utils/order-actions.test.ts
apps/admin/src/utils/order-detail.ts
apps/admin/src/components/ResolveAbnormalRefundModal.tsx
apps/admin/src/components/AfterSalePanel.tsx
apps/admin/src/components/orders/detail/DetailActions.tsx
apps/admin/src/components/orders/detail/DetailRefunds.tsx
apps/admin/src/pages/Orders.tsx
apps/admin/src/pages/LocalOrders.tsx
apps/admin/src/pages/OrderDetail.tsx
scripts/e2e.d/71-refund-consistency.sh
scripts/e2e.d/68-refund-reconcile.sh
docs/api.md
docs/order-flow.md
docs/staff-guide.md
```
（68 分片只许改收尾/注释以配合 71，不许删改其既有断言；`wechat-pay.ts` 只许加纯函数/类型，不许改请求逻辑；**`routes/orders.ts` 只许改顾客自助取消里 `initiateRefund` 的 catch 块（裁决 R5，约 :1104-1108），不得动该文件其它任何行**。）

## 5. 禁止修改
```
apps/admin/src/components/RefundDialog.tsx
apps/admin/src/components/CancelAndRefundModal.tsx
apps/server/src/services/member/**
apps/server/src/services/ticket/**
apps/server/src/services/delivery/**
apps/server/src/services/scheduler.ts
apps/server/src/services/order-notify.ts
apps/server/src/services/subscribe-message.ts
apps/server/src/routes/admin/system.ts
apps/server/src/routes/admin/index.ts
apps/server/src/config.ts
apps/server/src/app.ts
apps/server/src/middlewares/**
apps/server/prisma/migrations/2026050*/**
apps/server/prisma/migrations/2026070*/**
apps/server/prisma/migrations/2026082*/**
apps/server/prisma/migrations/2026090*/**
apps/server/prisma/migrations/2026091*/**
apps/server/prisma/migrations/2026092[12]*/**
apps/server/prisma/migrations/migration_lock.toml
apps/server/prisma/seed*
apps/miniapp/**
scripts/e2e.sh
scripts/deploy*
.claude/**
.agent/**
docs/superpowers/**
```
以及授权范围之外的一切文件。

## 6. 上报条件
- 需要改动禁止清单或授权范围之外的文件（含发现 `middlewares/error.ts` 的 AppError 形状不支持 50202 需改）。
- 全量 e2e 基线（fe9a501 为 2049/0）在**未加 71 分片**时因本次改动出现任何红——说明 T1 的「无指令逐字节一致」被破坏，停下上报，不得改旧断言。
- selftest 用例 1–7、10–13、15–19 中任何一条因本次改动变红（这些用例描述的行为本批不该变）。
- 实现 T4 时发现 `finalizeRefundSuccess` 的 FOR UPDATE 顺序或事务边界需要调整（不止加参数/返回值）。
- D5 若店主要求「无售后单的部分退款 CLOSED 也进页签」——需要 raw SQL 两步查询，超出本方案，停下回规划。
- 发现 Prisma 版本对 `updateMany` 返回 count 或迁移 INSTANT 加列有异常。
- 任何生产操作、任何对 food_shop_e2e 以外数据库的写入。

## 7. 待用户决定
- **D1 人工出口是否允许「核实未退 → 转 CLOSED 释放占位可重试」**。A（建议）允许：「查无此单」型 ABNORMAL 若微信确实没建单，60 分钟复查永远查无，不给这个出口就永远卡死（activeOrderId 占位，连部分退款都发不了）；风险是店员看错，释放后重发会二次退款——靠说明必填、二次确认、留痕三列、告警兜住。B 不允许：这类单只能运维改库；接口与弹窗只有 SUCCESS 一个结果。
- **D2 金额不符型 ABNORMAL，人工确认成功时是否允许按微信实退金额落账（≠记录金额）**。A（建议）允许：0 < 实退 ≤ 可退余额，在 finalize 同一条条件写里改 amount，留痕自动记「原记录 ¥X → 实退 ¥Y」；这是「金额不符」型 ABNORMAL 唯一能在后台收口的办法。B 只允许等额：不等则 42206，该类单只能运维改库（生产至今 0 例）。
- **D3 订单上任一笔退款成功时，是否把该订单 APPROVED 的售后单一并置 DONE**（即使这笔退款不是从售后面板发起、没带 afterSaleId）。A（建议）是：否则店员从订单页「再退款」收口后，售后单永远 APPROVED、订单永远挂在「退款待处理」、顾客永远 42208 不能再申请售后。B 否：只能从售后面板「重新退款」收口，订单页对此类单显示灰字提示。
- **D4 微信查询返回 CLOSED 但金额与记录不符时，是否直接按 CLOSED 释放**。A（建议）是：CLOSED = 微信未退款、无资金变动，金额差异只是请求记录不一致，照记 reconcileLastError 并告警但不再卡人；B 否：维持现在标 ABNORMAL 让人核对。
- **D5「退款待处理」新口径**：进页签 = ①REFUNDING 且无在途退款（原口径）②任何状态下有 ABNORMAL 退款 ③售后已同意（APPROVED）但退款没在路上。**不进** = 店员自己从订单页发起的部分退款异步 CLOSED、且没有售后单（告警已推送、订单页「再退款」按钮可用）。若店主要求这种也进，Prisma where 表达不了「最近一笔是 CLOSED」，要改成 raw SQL 两步查询，本批不做。请确认按此口径。
- **D2 补充（裁决 R4，2026-09-23）**：人工实退金额的上限在「≤ 可退余额」之外再加一条——**订单不在 REFUNDING 时，实退金额必须 < 可退余额（不得把余额一次退空）**。理由：部分退款行按「全部余额」落账会让 `refunded_amount = actual_amount`、payment 变 REFUNDED，而订单仍是 PAID/SHIPPED（`finalizeRefundSuccess` 只把 REFUNDING 翻成 REFUNDED），可接单发货、库存不回滚、无 CANCEL 票、不进页签。这比店主 D2 原意「按微信实退金额落账」略窄；若店主要求这种情形也能落账，需要 finalize 在非 REFUNDING 订单上做完整的「转 REFUNDED + 未出库回滚库存」流程，超出本批，请另立需求。
- **D6 结果未知（50202）后是否立刻再查一次微信以缩短等待**。建议本批不做：请求链路只保留一次外呼（网络故障时再查也会超时，店员要等 30s），店员看到「结果未知、系统将自动核对」提示后 5–6 分钟内补查会给出结局；可作为后续项。若店主觉得等 5 分钟不可接受，则在 T3 未知分支后加一次 `queryRefund`（not_found → 立即 FAILED 可重试；found → 按结果 dispatch；再失败 → 保持 PENDING）。

## 8. 裁决修订（2026-09-23，复核 Opus 对 HEAD d6a7e5e 提出的 R4/R5/R6）

【工序】裁决 【模型】Claude Fable 5.1 【等级】L

### R4：成立
依据：`apps/server/src/services/refund.ts`（HEAD d6a7e5e）`finalizeRefundSuccess` 中 override 校验只有 `effectiveAmount <= 0 || effectiveAmount > remaining` → 42206，随后 `if (order.refundedAmount >= order.actualAmount) { order.updateMany({ where: { id, status: 'REFUNDING' } … }); payment.updateMany(→REFUNDED) }`——订单翻转带 `status:'REFUNDING'` 守卫，payment 翻转不带；`routes/admin/orders.ts` resolve 路由同样只校 `verifiedAmount > remaining`；`ResolveAbnormalRefundModal.tsx:44` `amountFen <= order.remainingRefundable`。改动前这一不变量成立的原因：`initiateRefund:96` 把 `amount === remaining` 定义为全额并先把订单翻成 REFUNDING，部分退款行的 amount 恒 < remaining；D2 的 override 是第一个能让部分行累加到 actual_amount 的写者。
处理（修订方案条目）：
- `refund.ts finalizeRefundSuccess`：override 校验改为「`0 < x ≤ remaining`，且 `orderBefore.status !== 'REFUNDING' ⇒ x < remaining`」，违反时 `throw new AppError(42206, '实退金额等于全部可退余额，但订单不在退款中（当前 X）；部分退款行不能把余额一次退空')`，事务回滚、行仍 ABNORMAL。校验必须在 FOR UPDATE 之后用锁内快照做（现有位置不变）。
- `routes/admin/orders.ts` resolve 路由：同一条规则做事务外预检（友好报错），最终以 finalize 内的为准。
- `ResolveAbnormalRefundModal.tsx`：`amountValid` 对 SUCCESS 增加 `order.status === 'REFUNDING' || amountFen < order.remainingRefundable`，输入框下提示「非退款中订单不能把余额一次退空」。组件 props 需带 `status`。
- 待用户决定：见 §7「D2 补充」。
新增/修改验收断言：
- e2e 71.3（D2 段）：部分 ABNORMAL（订单 PAID，记录 100，实付 A）→ `verifiedAmount: A` → `42206`；SQL 行仍 `ABNORMAL`、`refunded_amount=0`、`payments.status=SUCCESS`、订单 `PAID`。同一行 `verifiedAmount: A-1`（>记录、<余额）→ code 0、`refunded_amount=A-1`、订单仍 `PAID`、`payments.status=SUCCESS`（未达上限不翻 payment）。全额 ABNORMAL（订单 REFUNDING，记录 A）→ `verifiedAmount: A-100` → code 0、`refunded_amount=A-100`、订单仍 `REFUNDING`、`rc71_attn`=1（无在途退款）、再 `POST /refund {amount:100}` → REFUNDED。
- selftest：新增用例——PAID 订单 actual 1000、ABNORMAL 行 amount 100，`finalizeRefundSuccess({expectStatus:'ABNORMAL', amountOverride:1000, manual})` → 抛 AppError code 42206，行仍 ABNORMAL、`refundedAmount=0`、payment 仍 SUCCESS、`alertCalls`/`refundResultCalls` 均为 0；`amountOverride:999` → `applied:true`、`refundedAmount=999`、订单 PAID、payment SUCCESS。REFUNDING 订单 ABNORMAL 行 amount 1000 → `amountOverride:900` → applied、`refundedAmount=900`、订单仍 REFUNDING。

### R5：成立
依据：`apps/server/src/routes/orders.ts:1104-1108` catch 不看错误码，一律 `notifyRefundRequest(latest)`；`services/order-notify.ts:76-80` 文案「自动退款未成功，需人工重试…点击「重试退款」」；同时 `refund.ts:300-304` 已发「微信退款结果未知…请勿在商户平台重复退款」。两条推送一前一后到同一群。此外 50202 时行是 PENDING，后台三处页面按 `hasActiveRefund` 根本不画「重试退款」，第一条推送指向一个不存在的按钮。对照：`wechat-notify.ts:249-258` 迟到付款路径已按 T3 区分 50202，只有自助取消这一处漏了（方案 T3 只点名了 wechat-notify）。
处理（修订方案条目，最小修法，只动一个文件的一个 catch 块）：
- `apps/server/src/routes/orders.ts` 自助取消 `initiateRefund` 的 catch：
  ```ts
  } catch (e) {
    if (e instanceof AppError && e.code === 50202) {
      // 结果未知：行仍 PENDING 占位，refund.ts 已发「结果未知、请勿重复退款」告警并交补查；
      // 此时后台没有「重试退款」按钮，再推「需人工重试」只会引人去商户平台手工退 → 重复退款
      console.warn('[orders] 自助退款结果未知，交补查:', e.message)
    } else {
      console.warn('[orders] 自助退款自动发起失败:', (e as Error).message)
      const latest = await prisma.order.findUniqueOrThrow({ where: { id } })
      notifyRefundRequest(latest)
    }
  }
  ```
  `AppError` 该文件已 import（:8）。`autoRefunded` 保持 false（小程序 `pages/order/detail.js:691` 据此显示「已申请退款，商家将尽快处理」，对「结果未知」是合适的措辞）。`order-notify.ts` 不改。
- 授权范围：新增 `apps/server/src/routes/orders.ts`（限该 catch 块，已写进 §4 说明），从 §5 禁止清单移除。
新增验收断言：
- e2e 71.2 新增 (f)：顾客自助取消路径——`make_paid_order` 后不接单，`refund-create {"orderId":O,"directive":{"kind":"timeout"}}`，顾客 `PUT /api/orders/O/cancel`（e2e.sh:137 的自助取消形态，须在接单前）→ HTTP 200、`.data.autoRefunded==false`；SQL 行 `PENDING`、`active_order_id=O`、订单 `REFUNDING`；随后 `refund-query … SUCCESS amount=A` + sched → `REFUNDED`。（推送本身 e2e 观察不到，行为断言以「行仍在途、订单进 REFUNDING、补查能收口」为准。）
- selftest：不加（该路径在路由层，selftest 只覆盖 services）。
- 复核者人工核对项：`grep -n "notifyRefundRequest" apps/server/src/routes/orders.ts` 的调用点必须在 `code !== 50202` 分支内。

### R6：成立（守卫收紧部分已被 R9 撤销，仅保留「必带告警 + 留痕」；以 §8 R9 为准）
依据：`refund.ts` finalize 条件写 `where: { id, status: input.expectStatus ?? { not: 'SUCCESS' } }`——默认允许 CLOSED→SUCCESS、FAILED→SUCCESS；`wechat-notify.ts:366-369` 只对 `SUCCESS` 短路；`refund-reconcile.ts:193-206` 不扫 CLOSED/FAILED，因此这两种终态只会被**回调**触发。方案 §3 写的「SUCCESS/CLOSED/FAILED 终态不可再改」与代码不符，是规划缺口。D1 场景（人工 ABNORMAL→CLOSED → 重新发起新行 SUCCESS → 微信推原行 REFUND.SUCCESS）下：原行翻 SUCCESS、`LEAST` 把第二笔 A 封顶成 0 增量（账面少记一笔真实退出去的钱）、`deductPointsOnRefund` 再跑一次（`calcRefundDeduct` 以 alreadyDeducted 封顶，通常扣 0，但仍写一条 REFUND_DEDUCT 流水尝试）、只发普通「退款已到账」通知——恰恰是最需要告警的重复退款信号被静默吸收。
「既有合法场景」核实：微信侧 CLOSED（退款关闭）是终态，同一 out_refund_no 不会再变 SUCCESS，商户平台「重新发起」产生的是新单；本地 CLOSED 只来自微信 CLOSED（回调/补查）、同步返回 CLOSED、D1 人工。FAILED 只来自明确 4xx 拒绝与 PENDING 查无。全仓无任何测试或代码路径依赖 CLOSED/FAILED→SUCCESS（selftest 用例 3 只断言 SUCCESS 行不被 mark* 改回；e2e 68.4 是 CLOSED 后发起**新**行）。收紧不破坏任何已有行为。
处理（修订方案条目）：
- `refund.ts finalizeRefundSuccess`：默认守卫改为 `status: { in: [...ACTIVE_REFUND_STATUSES] }`（PENDING/PROCESSING/ABNORMAL）；人工路径仍 `= 'ABNORMAL'`。`moved.count === 0` 分支：若 `!input.expectStatus`（回调/补查/mock 来源）且锁内读到的 `refund.status ∈ {CLOSED, FAILED}` → 在同一事务内 `tx.refund.updateMany({ where: { id, status: { in: ['CLOSED','FAILED'] } }, data: { ...(input.rawData ? { [input.rawField ?? 'wxNotifyData']: input.rawData } : {}), reconcileLastError: '终态后收到微信 SUCCESS 信号，疑似重复退款' } })` 留痕，事务外 `notifySystemAlert('退款终态后收到成功信号（疑似重复退款）', [订单, 退款单, `本地状态 ${refund.status}`, '请到微信商户平台核对该单是否被退了两次'], { key: `refund-late-success:${refund.id}`, windowMs: 6h })`；返回 `{ applied: false }`。已是 SUCCESS 的行（重推）保持静默。
- `wechat-notify.ts` 退款回调：不改分支结构（finalize 返回 false 即已告警），只把 :365 注释改成「已 SUCCESS 直接 ack；CLOSED/FAILED 交 finalize 记录+告警后 ack」。金额不符仍先于此检查（保持 replyFail）。
- 方案 §3 表已同步（finalize 行）。文件头注释里的状态表同步。
新增验收断言：
- e2e 71.3（D1 段末尾追加）：D1 转 CLOSED → `POST /refund {amount:A}`（无指令）→ 订单 REFUNDED、`refunded_amount=A` → `POST /api/admin/system/pay-mock/refund-notify {"outRefundNo":"<原 ABNORMAL 那行的单号>","status":"SUCCESS"}` → 原行仍 `CLOSED`、`active_order_id IS NULL`、`reconcile_last_error` 含「疑似重复退款」、`wx_notify_data` 含 `mock-notify`；`refunded_amount` 仍 `A`；`SELECT COUNT(*) FROM points_ledgers WHERE ref_type='REFUND' AND ref_id='<原行 id>'` = 0；订单仍 REFUNDED。
- e2e 71.2(c) 追加：FAILED 行 → `refund-notify {status:SUCCESS}` → 仍 `FAILED`、`refunded_amount` 不变、`reconcile_last_error` 含「疑似重复退款」。
- selftest 新增：CLOSED 行 `finalizeRefundSuccess({refundId, rawData:'late'})` → `{applied:false}`、状态 CLOSED、`refundedAmount` 不变、`reconcileLastError` 含「疑似重复退款」、`alertCalls` 含 key `refund-late-success:<id>` 且 windowMs 6h、`refundResultCalls` 0；FAILED 行同样；人工 `expectStatus:'ABNORMAL'` 对 CLOSED 行 → `{applied:false}` 且**无** late-success 告警；SUCCESS 行再次 finalize → `{applied:false}` 且无任何告警（用例 1/3 已覆盖，保持）。
- 复核者核对：`grep -n "not: 'SUCCESS'" apps/server/src/services/refund.ts` 应为 0 处。

### 三条修订涉及的授权范围变化
- 新增：`apps/server/src/routes/orders.ts`（仅自助取消 `initiateRefund` 的 catch 块）。
- 其余（`refund.ts`、`routes/admin/orders.ts`、`ResolveAbnormalRefundModal.tsx`、`wechat-notify.ts`、`selftest-refund-reconcile.ts`、`scripts/e2e.d/71-refund-consistency.sh`、`docs/api.md`）原本就在授权范围内。

### R9：成立（第二轮复核，HEAD f914c05）
依据：`refund.ts:462-485` finalize 默认守卫 `status in ACTIVE_REFUND_STATUSES`，CLOSED/FAILED 行收到 SUCCESS 只留痕告警不落账；`routes/admin/orders.ts` resolve 路由 `refund.status !== 'ABNORMAL' → 42204`；`order-actions.ts:66` 对 REFUNDING 且无在途的单画「重试退款」；`REFUND_ATTENTION_WHERE` 第一支把它列进页签。场景「D1 人工转 CLOSED（或 PENDING 查无→FAILED）→ 尚未重新发起 → 微信推原笔 REFUND.SUCCESS」下，唯一可点的是重试 → 第二笔真实退款；告警文案「核对是否退了两次」此时错误。§8 R6 只推演了「已重新发起」一种情况，属规划缺口。
并发核实（决定方向的关键事实）：`refunds.order_id` 有外键（`20260902100000_add_refund/migration.sql:34`），InnoDB 插入子行会对父行 `orders` 加 S 锁；而 `initiateRefund` 事务 A 在 `fromRefunding` 或部分退款路径**不锁 orders 行**（`refund.ts:145` 只在 `isFull && !fromRefunding` 时 updateMany），`remaining`/ACTIVE 检查全部来自事务外快照（`:85-105`）。因此不论选 (a)(b)(c)，「晚到 SUCCESS 落账」与「店员同时点重试」都存在毫秒级窗口：重试的 insert 等 finalize 提交后照样成功，随后真的去微信再退一笔。要闭合这个窗口，必须让事务 A 先锁 orders 行、锁内重验——这同时修掉 initiateRefund 既有的 TOCTOU（两笔部分退款并发只靠 activeOrderId 唯一索引挡，X 刚 SUCCESS 释放的一瞬 Y 可越过余额检查）。
方向判定：微信的 SUCCESS 是事实，本地 CLOSED/FAILED 是推断（D1 是人的推断、PENDING 查无是补查的推断）。(a) 转回 ABNORMAL 让人再点一次，60 分钟后补查照样自动 finalize，只是多一段误导性的「退款异常」界面；(b) 再开一个「补记成功」出口是给系统已经知道的事实开人工入口。采纳 (c) 的骨架但不做「有后续行就不落账」的分支：**一律按微信结果落账（与 R6 之前一致，finalize 全套副作用），按「是否已有后续 ACTIVE/SUCCESS 退款行」「是否人工核实过」分文案告警**。理由：后续行已 SUCCESS 时 (c) 让账面少记一笔真退出去的钱，而落账 + LEAST 封顶至少对部分退款是真实的（全额时封顶在 actual_amount，告警会点明「实退两笔」）；后续行还在途时 (c) 留 CLOSED 同样少记，且那笔在途的也拦不住。撤销 R6 的守卫收紧，保留 R6 的「必带告警」。
处理（修订方案条目）：
- `refund.ts initiateRefund` 事务 A：第一句 `await tx.$queryRaw\`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE\``；随后锁内 `tx.order.findUniqueOrThrow({ where:{id}, include:{ refunds:{ select:{status:true} } } })` 重验：有 ACTIVE 行 → `AppError(42205)`；`remainingRefundable(锁内 order) !== remaining`（锁外算的）→ `AppError(42204, '订单退款额已变化，请刷新后重试')`。既有的 `updateMany`/`rollbackOrderStock`/`refund.create` 顺序不变。加锁顺序 orders→（products 回滚）→ refunds 插入，与 finalize 的 refunds(X 行)→orders 不构成环（事务 A 不锁任何已有 refunds 行；插入的唯一索引锁只与另一条插入/回填 activeOrderId 冲突）；与 settlePoints 的 orders→points_ledgers→users 同向。
- `refund.ts finalizeRefundSuccess`：默认守卫恢复 `status: { not: 'SUCCESS' }`；人工路径仍 `expectStatus:'ABNORMAL'`。在条件写**之前**（锁内）若 `!input.expectStatus && refund.status ∈ {CLOSED, FAILED}`：`later = await tx.refund.findFirst({ where:{ orderId: refund.orderId, id:{ gt: refund.id }, status:{ in:[...ACTIVE_REFUND_STATUSES,'SUCCESS'] } }, select:{ id:true, outRefundNo:true, status:true, amount:true } })`；`data.reconcileLastError = later ? '终态后微信推成功，且已有后续退款（疑似重复退款）' : refund.manualResolvedBy ? '人工核实为未退款后微信推成功，已按微信结果落账' : '终态后微信推成功，已按微信结果落账'`；rawData 按 R10 规则追加；其余落账流程不变（LEAST、REFUNDING→REFUNDED、payment、售后、积分、出票、顾客通知）。事务外：`notifySystemAlert(later ? '疑似重复退款：终态退款单收到微信成功' : '终态退款单收到微信成功，已自动落账', [订单, `原退款单 ${outRefundNo} ¥X 本地原状态 ${CLOSED|FAILED}`, later ? `后续退款单 ${later.outRefundNo}（${later.status}）¥Y，请到商户平台核对是否退了两笔，如是需与顾客协商追回` : '无需操作', manual ? `曾由 ${manualResolvedBy} 人工核实为未退款：${manualResolveNote}` : ''], { key:`refund-late-success:${id}`, windowMs: 6h })`。删除 f914c05 的 `lateSuccess` 分支（count=0 且非 SUCCESS 的情形在新守卫下只剩「已是 SUCCESS」= 幂等重推，静默）。
- `routes/admin/orders.ts` resolve 路由不改（仍只收 ABNORMAL）；`order-actions.ts` 不改。
- `refund-reconcile.ts:17`、`refund.ts:374/391/465`、`docs/api.md:2124` 注释/文档按最终守卫（`≠ SUCCESS`，CLOSED/FAILED 晚到成功自动落账并告警）改正（R8 纳入）。
新增/修改验收断言：
- e2e 71.3 D1 段末尾改为两个用例：(i) 转 CLOSED **未重新发起** → `pay-mock/refund-notify {原单号, SUCCESS}` → 原行 `SUCCESS`、`active_order_id IS NULL`、`manual_resolved_by='admin'` 仍在、`reconcile_last_error` 含「人工核实」、`wx_notify_data` 同时含 `manual-verified` 与 `mock-notify`（追加不覆盖，R10）；订单 `REFUNDED`、`refunded_amount=A`、`payments=REFUNDED`、`print-jobs` CANCEL 恰 1 条、`rc71_attn`=0；随后 `POST /refund {amount:A}` → `42206`（已全额退款）。(ii) 转 CLOSED → 重新发起成功（REFUNDED, refunded_amount=A）→ `refund-notify {原单号, SUCCESS}` → 原行 `SUCCESS`、`reconcile_last_error` 含「疑似重复退款」、`refunded_amount` 仍 `A`（LEAST 封顶）、订单仍 REFUNDED、`points_ledgers` 对原行 ref_id 计数 0（累计已到上限扣 0）。
- e2e 71.2(c) 改：FAILED 行（NOT_ENOUGH）→ `refund-notify SUCCESS` → 行 `SUCCESS`、`refunded_amount` 累加、`reconcile_last_error` 含「已按微信结果落账」（FAILED 行没有后续行）。
- e2e 新增 71.5（事务 A 锁内重验）：部分 ABNORMAL 行 X（记录 100，订单 PAID，实付 A）→ resolve SUCCESS → `POST /refund {amount: A}` → `42206`（锁内 remaining 已减）；REFUNDING 单 X CLOSED（D1）→ `refund-notify SUCCESS` 落账 REFUNDED → `POST /refund {amount:A}` → `42206`。
- selftest：R6 那组用例改为：CLOSED 行 `finalizeRefundSuccess({refundId, rawData:'late'})` → `{applied:true}`、status SUCCESS、`refundedAmount` 累加、`reconcileLastError` 含「已按微信结果落账」、`alertCalls` 含 `refund-late-success:<id>` 且 title 不含「疑似」、`refundResultCalls` SUCCESS 1；同单先造一条 id 更大的 PENDING 行 Y 再对 X 调 finalize → applied、alert title 含「疑似重复退款」且 lines 含 Y 的 outRefundNo；X 带 `manualResolvedBy` → lines 含「人工核实」且 wxNotifyData 含原 manual 串与 'late'；FAILED 行同 (i)；SUCCESS 行再次 finalize → `{applied:false}` 且 `alertCalls` 0；人工 `expectStatus:'ABNORMAL'` 对 CLOSED 行 → `{applied:false}` 无告警（不变）。新增事务 A 用例：`initiateRefund` 前用 `prisma.$transaction` 在另一连接里 `SELECT … FOR UPDATE` 锁住 orders 行并把 `refundedAmount` 改成 actual 后提交 → `initiateRefund` 抛 42204/42206（锁内重验命中），refunds 表无新行。
- 复核核对：`grep -n "in: \[...ACTIVE_REFUND_STATUSES\]" refund.ts` 不再出现在 finalize 的条件写；`grep -n "FOR UPDATE" refund.ts` 至少 3 处（事务 A 头句 + finalize 两句）。
- 待用户决定：无新增（微信 SUCCESS 自动落账与 fe9a501 生产现状一致，D1 语义「释放可重试」不变；告知店主：人工核实为「未退」后若微信推来成功，系统会按微信结果记为已退款并推送「人工核实被微信推翻」告警）。

### R8：纳入
`refund.ts:374`「默认的非 SUCCESS 皆可」与 `:391`、`refund-reconcile.ts:17`「条件写 status≠SUCCESS」在 R9 恢复守卫后重新成立，但 `:465` 那段「R6 收紧」注释与 `docs/api.md:2124` 需改成 R9 口径（CLOSED/FAILED 晚到成功自动落账 + 告警；事务 A 锁内重验）。验收：`grep -n "R6，2026-09-23 裁决收紧" refund.ts` 为 0；`docs/api.md` 互斥段含「FOR UPDATE」「锁内重验」「refund-late-success」三词。

### R10：纳入
`finalizeRefundSuccess` 写 rawData 时：若 `refund.manualResolvedBy` 非空且现有 `wxNotifyData` 以 `{"source":"manual-verified"` 开头，则 `data.wxNotifyData = 现值 + '\n---late-wechat-success---\n' + rawData`（TEXT 列，追加不覆盖）；其它情形照旧覆盖。验收见 R9 断言 (i)「同时含 manual-verified 与 mock-notify」；selftest 同上。

### R11：纳入
selftest `用例 R4（REFUNDING 订单，amountOverride=全部余额）` 改为真正的等额：actual 1000、`refundedAmount 0`、ABNORMAL 行 amount 100、`amountOverride:1000` → `{applied:true}`、`refundedAmount=1000`、订单 `REFUNDED`、payment `REFUNDED`；原 900 的用例保留改名「REFUNDING 订单 override 小于余额 → 仍 REFUNDING」。e2e 71.3 D2 段补一条：REFUNDING 全额 ABNORMAL 行（记录 A）先用 SQL 把 amount 改为 100 造「记录小于余额」，`verifiedAmount: A` → code 0、订单 `REFUNDED`、`refunded_amount=A`。
