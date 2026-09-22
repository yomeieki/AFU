echo "== 68. 退款状态自动补查（pay-mock 五种结果 + 幂等 + 限量 + 阈值）=="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/sched/make_paid_order/order_status/latest_refund/sql 与 $AT。
# 变量一律 RR68_ 前缀。前置：WECHAT_PAY_MOCK=true（pay-mock 控制面仅在此模式挂载）。

req POST /api/admin/system/pay-mock/reset "$AT" >/dev/null

# RR68_stuck <full|partial> [status=PROCESSING] —— 造一笔卡在指定状态的退款行，echo "orderId<TAB>outRefundNo"
rr68_stuck() {
  local kind=$1 status=${2:-PROCESSING} O ONO OTN AMT TOTAL ORN
  O=$(make_paid_order); [[ -n "$O" ]] || { echo ""; return; }
  if [[ "$kind" == "full" ]]; then
    sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e68' WHERE id=$O;"
  fi
  ONO=$(sql "SELECT order_no FROM orders WHERE id=$O;")
  # mock 支付（routes/orders.ts :pay 的 useMockPay 分支）不写 payments.out_trade_no（本来就是 NULL）；
  # reconcileRefund/reconcileStuckRefunds 从不读这一列，这里随便给个占位值即可，避免把
  # mysql 批处理模式下 NULL 的字面文本 "NULL" 插进一个本该是 NULL 的列。
  OTN="order_${O}_e2e68"
  TOTAL=$(sql "SELECT actual_amount FROM orders WHERE id=$O;")
  if [[ "$kind" == "full" ]]; then AMT="$TOTAL"; else AMT=100; fi
  ORN="refund_${O}_e2e68_$RANDOM$RANDOM"
  sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
       VALUES ($O, '$ONO', '$OTN', '$ORN', $AMT, $TOTAL, '$status', 'WECHAT', $O, NOW(3), NOW(3));"
  printf '%s\t%s\n' "$O" "$ORN"
}
# RR68_q <outRefundNo> <directiveJson>
rr68_q() { req POST /api/admin/system/pay-mock/refund-query "$AT" "{\"outRefundNo\":\"$1\",\"directive\":$2}" >/dev/null; }
# RR68_calls —— 已记录的 queryRefund 调用条数
rr68_calls() { req GET "/api/admin/system/pay-mock/calls?op=queryRefund" "$AT" | jq '.data | length'; }
# rr68_attn <orderId> —— 该单是否在「退款待处理」列表里（伪状态 REFUND_ATTENTION，全渠道），输出 1/0
rr68_attn() { req GET "/api/admin/orders?status=REFUND_ATTENTION&deliveryType=ALL&pageSize=50" "$AT" | jq --argjson id "$1" '[.data.list[].id] | index($id) != null | if . then 1 else 0 end'; }
# rr68_attn_count —— pending-count 里的 refundAttentionCount
rr68_attn_count() { req GET /api/admin/orders/pending-count "$AT" | jq -r .data.refundAttentionCount; }
# RR68_sched —— 三个阈值全传 0（立刻命中），断言响应带 refundReconcile 键
rr68_sched() {
  local r v
  r=$(sched '{"refundReconcileAfterMin":0,"refundReconcileIntervalMin":0,"refundReconcileAbnormalIntervalMin":0}')
  v=$(jq -r '.data.refundReconcile' <<<"$r")
  [[ "$v" != "null" && -n "$v" ]] && ok "① run-scheduler 命中 refundReconcile 任务（本轮推进 $v 条）" || fail "① run-scheduler 未见 refundReconcile 键" "$r"
}

echo "-- 68.1 无指令：仍 PROCESSING，reconcile_count=1，calls +1，订单仍 REFUNDING --"
RR68_O1_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O1 RR68_RN1 <<<"$RR68_O1_TMP"
[[ -n "$RR68_O1" ]] && ok "68.1 造单 #$RR68_O1" || fail "68.1 造单失败"
RR68_C0=$(rr68_calls)
rr68_sched
assert_eq "68.1 退款仍 PROCESSING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN1';")" "PROCESSING"
assert_eq "68.1 reconcile_count=1" "$(sql "SELECT reconcile_count FROM refunds WHERE out_refund_no='$RR68_RN1';")" "1"
assert_eq "68.1 calls +1" "$((RR68_C0+1))" "$(rr68_calls)"
assert_eq "68.1 订单仍 REFUNDING" "$(order_status $RR68_O1)" "REFUNDING"
# 「退款待处理」等价性（R3）：退款还在微信走（PROCESSING）→ 不算要人出手；关闭后 → 算
assert_eq "68.1 PROCESSING 中不进「退款待处理」" "$(rr68_attn $RR68_O1)" "0"
RR68_ATTN_BEFORE=$(rr68_attn_count)
assert_eq "68.1 并列传 REFUNDING,REFUND_ATTENTION → 40001" "$(code "$(req GET "/api/admin/orders?status=REFUNDING,REFUND_ATTENTION" "$AT")")" "40001"
# 本用例故意让这笔一直停在 PROCESSING（验证「无指令」的安全默认），但 rr68_sched 每次都会
# 扫全表（intervalMin 恒传 0）——留着不关，后面用例里任何一次 rr68_sched 都会把它也捎带查一遍，
# 把那些用例自己的「rr68_calls 不增/恰好 +1」断言带偏。这里在验完之后立刻收尾，后面同理。
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no='$RR68_RN1';"
assert_eq "68.1 退款 CLOSED 后进「退款待处理」" "$(rr68_attn $RR68_O1)" "1"
assert_eq "68.1 pending-count.refundAttentionCount 同口径 +1" "$((RR68_ATTN_BEFORE+1))" "$(rr68_attn_count)"
# 没有任何退款记录的 REFUNDING 单（取消后迟到付款、自动退款发起前抛错的形态）也要进
RR68_O1N=$(make_paid_order)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e68 无退款记录' WHERE id=$RR68_O1N;"
assert_eq "68.1 无退款记录的 REFUNDING 单进「退款待处理」" "$(rr68_attn $RR68_O1N)" "1"
# 留在 REFUNDING（与 68.1 主单同样的收尾口径）：补查只扫 refunds 表，这张没有退款行的单不会被捎带

echo "-- 68.2 全额 SUCCESS：终态 SUCCESS，订单 REFUNDED，再补查不重复累加 --"
RR68_O2_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O2 RR68_RN2 <<<"$RR68_O2_TMP"
[[ -n "$RR68_O2" ]] && ok "68.2 造单 #$RR68_O2" || fail "68.2 造单失败"
RR68_AMT2=$(sql "SELECT actual_amount FROM orders WHERE id=$RR68_O2;")
rr68_q "$RR68_RN2" "{\"kind\":\"ok\",\"status\":\"SUCCESS\",\"amount\":$RR68_AMT2}"
rr68_sched
assert_eq "68.2 退款 SUCCESS" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN2';")" "SUCCESS"
assert_eq "68.2 active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RR68_RN2';")" "1"
assert_eq "68.2 订单 REFUNDED" "$(order_status $RR68_O2)" "REFUNDED"
assert_eq "68.2 refunded_amount = actual_amount" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RR68_O2;")" "$RR68_AMT2"
assert_eq "68.2 latest_refund SUCCESS" "$(latest_refund $(sql "SELECT order_no FROM orders WHERE id=$RR68_O2;"))" "SUCCESS"
RR68_C2=$(rr68_calls)
rr68_sched
assert_eq "68.2 再补查 refunded_amount 不变" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RR68_O2;")" "$RR68_AMT2"
assert_eq "68.2 已终态不再计入 calls" "$RR68_C2" "$(rr68_calls)"

echo "-- 68.3 部分 SUCCESS：订单仍 PAID，剩余可退款正确 --"
RR68_O3_TMP=$(rr68_stuck partial PROCESSING)
IFS=$'\t' read -r RR68_O3 RR68_RN3 <<<"$RR68_O3_TMP"
[[ -n "$RR68_O3" ]] && ok "68.3 造单 #$RR68_O3" || fail "68.3 造单失败"
rr68_q "$RR68_RN3" '{"kind":"ok","status":"SUCCESS","amount":100}'
rr68_sched
assert_eq "68.3 订单仍 PAID" "$(order_status $RR68_O3)" "PAID"
assert_eq "68.3 refunded_amount=100" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RR68_O3;")" "100"
RR68_AMT3=$(sql "SELECT actual_amount FROM orders WHERE id=$RR68_O3;")
RR68_R=$(req POST "/api/admin/orders/$RR68_O3/refund" "$AT" "{\"amount\":$((RR68_AMT3-100))}")
assert_eq "68.3 退剩余部分 code 0" "$(code "$RR68_R")" "0"
assert_eq "68.3 mode mock" "$(jq -r .data.mode <<<"$RR68_R")" "mock"
assert_eq "68.3 订单 REFUNDED（可退余额算对）" "$(order_status $RR68_O3)" "REFUNDED"

echo "-- 68.4 CLOSED：释放在途位，可重新发起 --"
RR68_O4_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O4 RR68_RN4 <<<"$RR68_O4_TMP"
[[ -n "$RR68_O4" ]] && ok "68.4 造单 #$RR68_O4" || fail "68.4 造单失败"
rr68_q "$RR68_RN4" '{"kind":"ok","status":"CLOSED"}'
rr68_sched
assert_eq "68.4 退款 CLOSED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN4';")" "CLOSED"
assert_eq "68.4 active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RR68_RN4';")" "1"
assert_eq "68.4 订单仍 REFUNDING" "$(order_status $RR68_O4)" "REFUNDING"
RR68_AMT4=$(sql "SELECT actual_amount FROM orders WHERE id=$RR68_O4;")
RR68_R=$(req POST "/api/admin/orders/$RR68_O4/refund" "$AT" "{\"amount\":$RR68_AMT4}")
assert_eq "68.4 CLOSED 后重新发起 code 0" "$(code "$RR68_R")" "0"
assert_eq "68.4 mode mock" "$(jq -r .data.mode <<<"$RR68_R")" "mock"
assert_eq "68.4 订单 REFUNDED（在途位确实释放）" "$(order_status $RR68_O4)" "REFUNDED"

echo "-- 68.5 ABNORMAL：占位不释放，人工处理后微信推 SUCCESS 仍可完成 --"
RR68_O5_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O5 RR68_RN5 <<<"$RR68_O5_TMP"
[[ -n "$RR68_O5" ]] && ok "68.5 造单 #$RR68_O5" || fail "68.5 造单失败"
rr68_q "$RR68_RN5" '{"kind":"ok","status":"ABNORMAL"}'
rr68_sched
assert_eq "68.5 退款 ABNORMAL" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN5';")" "ABNORMAL"
assert_eq "68.5 active_order_id 仍占位" "$(sql "SELECT active_order_id FROM refunds WHERE out_refund_no='$RR68_RN5';")" "$RR68_O5"
RR68_AMT5=$(sql "SELECT actual_amount FROM orders WHERE id=$RR68_O5;")
rr68_q "$RR68_RN5" "{\"kind\":\"ok\",\"status\":\"SUCCESS\",\"amount\":$RR68_AMT5}"
# ABNORMAL 复查间隔默认 60 分钟，用专门覆盖键把它也压到 0 才会立刻再查
req POST /api/admin/system/run-scheduler "$AT" '{"refundReconcileAfterMin":0,"refundReconcileIntervalMin":0,"refundReconcileAbnormalIntervalMin":0}' >/dev/null
assert_eq "68.5 人工处理后微信推 SUCCESS → 终态 SUCCESS" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN5';")" "SUCCESS"
assert_eq "68.5 订单 REFUNDED" "$(order_status $RR68_O5)" "REFUNDED"

echo "-- 68.6 查询失败/超时：不改状态，reconcile_last_error 记录，count 累加 --"
RR68_O6_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O6 RR68_RN6 <<<"$RR68_O6_TMP"
[[ -n "$RR68_O6" ]] && ok "68.6 造单 #$RR68_O6" || fail "68.6 造单失败"
rr68_q "$RR68_RN6" '{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}'
rr68_sched
assert_eq "68.6 error 后仍 PROCESSING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN6';")" "PROCESSING"
[[ -n "$(sql "SELECT reconcile_last_error FROM refunds WHERE out_refund_no='$RR68_RN6';")" ]] && ok "68.6 reconcile_last_error 非空" || fail "68.6 reconcile_last_error 为空"
assert_eq "68.6 reconcile_count=1" "$(sql "SELECT reconcile_count FROM refunds WHERE out_refund_no='$RR68_RN6';")" "1"
rr68_q "$RR68_RN6" '{"kind":"timeout"}'
rr68_sched
assert_eq "68.6 timeout 后仍 PROCESSING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN6';")" "PROCESSING"
assert_eq "68.6 reconcile_count=2" "$(sql "SELECT reconcile_count FROM refunds WHERE out_refund_no='$RR68_RN6';")" "2"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no='$RR68_RN6';"

echo "-- 68.7 not_found：PENDING → FAILED 释放在途位；PROCESSING → ABNORMAL（2026-09-22 起，进「退款待处理」），记录「查无」 --"
RR68_O7_TMP=$(rr68_stuck full PENDING)
IFS=$'\t' read -r RR68_O7 RR68_RN7 <<<"$RR68_O7_TMP"
[[ -n "$RR68_O7" ]] && ok "68.7 造单 #$RR68_O7（PENDING）" || fail "68.7 造单失败"
rr68_q "$RR68_RN7" '{"kind":"not_found"}'
rr68_sched
assert_eq "68.7 PENDING 查无 → FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN7';")" "FAILED"
assert_eq "68.7 error_code=RECONCILE_NOT_FOUND" "$(sql "SELECT error_code FROM refunds WHERE out_refund_no='$RR68_RN7';")" "RECONCILE_NOT_FOUND"
assert_eq "68.7 active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RR68_RN7';")" "1"

RR68_O7B_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O7B RR68_RN7B <<<"$RR68_O7B_TMP"
[[ -n "$RR68_O7B" ]] && ok "68.7 造单 #$RR68_O7B（PROCESSING）" || fail "68.7 造单失败"
rr68_q "$RR68_RN7B" '{"kind":"not_found"}'
rr68_sched
assert_eq "68.7 PROCESSING 查无 → ABNORMAL" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN7B';")" "ABNORMAL"
assert_eq "68.7 订单仍 REFUNDING" "$(order_status $RR68_O7B)" "REFUNDING"
assert_eq "68.7 ABNORMAL 后进「退款待处理」" "$(rr68_attn $RR68_O7B)" "1"
RR68_ERR7B=$(sql "SELECT reconcile_last_error FROM refunds WHERE out_refund_no='$RR68_RN7B';")
[[ "$RR68_ERR7B" == *"查无"* ]] && ok "68.7 reconcile_last_error 含「查无」" || fail "68.7 reconcile_last_error 未含「查无」" "$RR68_ERR7B"
# ABNORMAL 行再查到查无：守卫不中，状态不变，不重复推进
RR68_C7B=$(rr68_calls)
rr68_q "$RR68_RN7B" '{"kind":"not_found"}'
rr68_sched
assert_eq "68.7 ABNORMAL 再查无 → 仍 ABNORMAL" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN7B';")" "ABNORMAL"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no='$RR68_RN7B';"

echo "-- 68.8 金额不符：标 ABNORMAL（2026-09-22 起），refunded_amount 不变，记录「金额」 --"
RR68_O8_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O8 RR68_RN8 <<<"$RR68_O8_TMP"
[[ -n "$RR68_O8" ]] && ok "68.8 造单 #$RR68_O8" || fail "68.8 造单失败"
rr68_q "$RR68_RN8" '{"kind":"ok","status":"SUCCESS","amount":999999}'
rr68_sched
assert_eq "68.8 金额不符 → ABNORMAL" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RR68_RN8';")" "ABNORMAL"
assert_eq "68.8 ABNORMAL 后进「退款待处理」" "$(rr68_attn $RR68_O8)" "1"
assert_eq "68.8 refunded_amount=0" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RR68_O8;")" "0"
RR68_ERR8=$(sql "SELECT reconcile_last_error FROM refunds WHERE out_refund_no='$RR68_RN8';")
[[ "$RR68_ERR8" == *"金额"* ]] && ok "68.8 reconcile_last_error 含「金额」" || fail "68.8 reconcile_last_error 未含「金额」" "$RR68_ERR8"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no='$RR68_RN8';"

echo "-- 68.9 年龄阈值 / 复查间隔 --"
RR68_O9_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O9 RR68_RN9 <<<"$RR68_O9_TMP"
[[ -n "$RR68_O9" ]] && ok "68.9 造单 #$RR68_O9" || fail "68.9 造单失败"
RR68_C9A=$(rr68_calls)
sched '{"refundReconcileAfterMin":5}' >/dev/null
assert_eq "68.9 刚造的行未满 afterMin，不应被查" "$RR68_C9A" "$(rr68_calls)"
# 立刻查一次让它有 reconcile_checked_at，再验证「间隔内不重查」
rr68_sched
RR68_C9B=$(rr68_calls)
sched '{"refundReconcileAfterMin":0}' >/dev/null   # intervalMin 缺省走 config 默认 5 分钟
assert_eq "68.9 刚查过的行在间隔内不重查" "$RR68_C9B" "$(rr68_calls)"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no='$RR68_RN9';"

echo "-- 68.10 每轮限量 --"
RR68_O10A_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O10A RR68_RN10A <<<"$RR68_O10A_TMP"
RR68_O10B_TMP=$(rr68_stuck full PROCESSING)
IFS=$'\t' read -r RR68_O10B RR68_RN10B <<<"$RR68_O10B_TMP"
[[ -n "$RR68_O10A" && -n "$RR68_O10B" ]] && ok "68.10 造两笔待查" || fail "68.10 造单失败"
RR68_C10=$(rr68_calls)
req POST /api/admin/system/run-scheduler "$AT" '{"refundReconcileAfterMin":0,"refundReconcileIntervalMin":0,"refundReconcileBatch":1}' >/dev/null
assert_eq "68.10 batch=1 只查一条" "$((RR68_C10+1))" "$(rr68_calls)"
req POST /api/admin/system/run-scheduler "$AT" '{"refundReconcileAfterMin":0,"refundReconcileIntervalMin":0,"refundReconcileBatch":1}' >/dev/null
assert_eq "68.10 再跑一次又查一条" "$((RR68_C10+2))" "$(rr68_calls)"

echo "-- 68.11 /status 与 run-scheduler 响应带新字段 --"
RR68_STATUS=$(req GET /api/admin/system/status "$AT")
assert_eq "68.11 status.order.refundReconcile.afterMin 存在" "$(jq -r 'if (.data.order.refundReconcile.afterMin|type)=="number" then "yes" else "no" end' <<<"$RR68_STATUS")" "yes"
assert_eq "68.11 status.timezone.ok" "$(jq -r '.data.timezone.ok' <<<"$RR68_STATUS")" "true"
assert_eq "68.11 status.timezone.name" "$(jq -r '.data.timezone.name' <<<"$RR68_STATUS")" "Asia/Shanghai"
RR68_SCHED_KEYS=$(sched '{}')
assert_eq "68.11 run-scheduler 响应带 refundReconcile 键" "$(jq -r 'if (.data|has("refundReconcile")) then "yes" else "no" end' <<<"$RR68_SCHED_KEYS")" "yes"

echo "-- 68.12 收尾：把仍在途的行强制关闭，避免拖累下一轮 --"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL
     WHERE out_refund_no LIKE 'refund_%_e2e68_%' AND status IN ('PENDING','PROCESSING','ABNORMAL');"
req POST /api/admin/system/pay-mock/reset "$AT" >/dev/null
