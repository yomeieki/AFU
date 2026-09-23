echo "== 71. 退款资金一致性修复（P1-P4，2026-09-23）=="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/sched/make_paid_order/order_status/latest_refund/sql 与 $AT/$UT，
# 以及 68 分片里已定义的 rr68_q/rr68_sched/rr68_attn/rr68_attn_ch/rr68_calls（68 先于本文件被 source）。
# 变量一律 RC71_ 前缀；不改动 68 分片的既有断言。

req POST /api/admin/system/pay-mock/reset "$AT" >/dev/null

# rc71_create <orderId> <directiveJson> —— 排一条 createRefund 指令
rc71_create() { req POST /api/admin/system/pay-mock/refund-create "$AT" "{\"orderId\":$1,\"directive\":$2}" >/dev/null; }
# rc71_calls <op> —— 已记录的调用条数（createRefund|queryRefund）
rc71_calls() { req GET "/api/admin/system/pay-mock/calls?op=$1" "$AT" | jq '.data | length'; }
# rc71_attn <orderId> —— 该单是否在「退款待处理」列表里（全渠道）
rc71_attn() { req GET "/api/admin/orders?status=REFUND_ATTENTION&deliveryType=ALL&pageSize=50" "$AT" | jq --argjson id "$1" '[.data.list[].id] | index($id) != null | if . then 1 else 0 end'; }
# rc71_resolve <orderId> <refundId> <jsonBody>
rc71_resolve() { req POST "/api/admin/orders/$1/refunds/$2/resolve-abnormal" "$AT" "$3"; }
# rc71_refund_id <outRefundNo>
rc71_refund_id() { sql "SELECT id FROM refunds WHERE out_refund_no='$1';"; }

echo "-- 71.1 P2 回调抢先（同步回写不得把 SUCCESS 改回 PROCESSING）--"
RC71_O1=$(make_paid_order); [[ -n "$RC71_O1" ]] && ok "71.1 造单 #$RC71_O1" || fail "71.1 造单失败"
rc71_create "$RC71_O1" '{"kind":"ok","status":"PROCESSING","preemptNotify":{"status":"SUCCESS"}}'
RC71_CALLS_BEFORE=$(rc71_calls createRefund)
RC71_R=$(req POST "/api/admin/orders/$RC71_O1/refund" "$AT" '{"amount":100,"reason":"71.1"}')
assert_eq "71.1 响应 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.1 响应 refund.status SUCCESS" "$(jq -r .data.refund.status <<<"$RC71_R")" "SUCCESS"
RC71_RN1=$(jq -r .data.refund.outRefundNo <<<"$RC71_R")
assert_eq "71.1 退款行 SUCCESS/占位释放/落了响应" "$(sql "SELECT CONCAT(status,' ',active_order_id IS NULL,' ',wx_response_data IS NOT NULL) FROM refunds WHERE out_refund_no='$RC71_RN1';")" "SUCCESS 1 1"
assert_eq "71.1 订单 refunded_amount=100（不是 200，这就是 P2 的判定点）" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O1;")" "100"
assert_eq "71.1 订单仍 PAID" "$(order_status $RC71_O1)" "PAID"
assert_eq "71.1 createRefund 调用 +1" "$((RC71_CALLS_BEFORE+1))" "$(rc71_calls createRefund)"

echo "-- 71.1 反向：同步返回 SUCCESS，但回调已抢先推进 CLOSED → 不 dispatch --"
RC71_O1B=$(make_paid_order); [[ -n "$RC71_O1B" ]] && ok "71.1 反向造单 #$RC71_O1B" || fail "71.1 反向造单失败"
rc71_create "$RC71_O1B" '{"kind":"ok","status":"SUCCESS","preemptNotify":{"status":"CLOSED"}}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O1B/refund" "$AT" '{"amount":100}')
assert_eq "71.1 反向 code 0" "$(code "$RC71_R")" "0"
RC71_RN1B=$(jq -r .data.refund.outRefundNo <<<"$RC71_R")
assert_eq "71.1 反向：退款 CLOSED（回调已经赢了）" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN1B';")" "CLOSED"
assert_eq "71.1 反向：active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RC71_RN1B';")" "1"
assert_eq "71.1 反向：refunded_amount=0（同步 SUCCESS 分支未被 dispatch）" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O1B;")" "0"
assert_eq "71.1 反向：订单仍 PAID" "$(order_status $RC71_O1B)" "PAID"

echo "-- 71.2 P3 结果未知不标 FAILED --"
echo "-- 71.2(a) 全额超时 → 50202 PENDING，之后补查 SUCCESS → 终态 --"
RC71_O2A=$(make_paid_order); [[ -n "$RC71_O2A" ]] && ok "71.2a 造单 #$RC71_O2A" || fail "71.2a 造单失败"
RC71_AMT2A=$(req GET "/api/admin/orders/$RC71_O2A" "$AT" | jq -r .data.actualAmount)
rc71_create "$RC71_O2A" '{"kind":"timeout"}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2A/refund" "$AT" "{\"amount\":$RC71_AMT2A}")
assert_eq "71.2a 响应 code 50202" "$(code "$RC71_R")" "50202"
[[ "$(jq -r .message <<<"$RC71_R")" == *"结果未知"* ]] && ok "71.2a message 含「结果未知」" || fail "71.2a message" "$RC71_R"
RC71_RN2A=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2A ORDER BY id DESC LIMIT 1;")
assert_eq "71.2a 行仍 PENDING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2A';")" "PENDING"
assert_eq "71.2a active_order_id 占位" "$(sql "SELECT active_order_id FROM refunds WHERE out_refund_no='$RC71_RN2A';")" "$RC71_O2A"
RC71_ERR2A=$(sql "SELECT error_code FROM refunds WHERE out_refund_no='$RC71_RN2A';")
[[ "$RC71_ERR2A" == UNCERTAIN_* ]] && ok "71.2a error_code 以 UNCERTAIN_ 开头" || fail "71.2a error_code" "$RC71_ERR2A"
assert_eq "71.2a 订单仍 REFUNDING" "$(order_status $RC71_O2A)" "REFUNDING"
assert_eq "71.2a 在途不进「退款待处理」" "$(rc71_attn $RC71_O2A)" "0"
RC71_R2=$(req POST "/api/admin/orders/$RC71_O2A/refund" "$AT" "{\"amount\":$RC71_AMT2A}")
assert_eq "71.2a 再次发起（新请求）被拒 42205" "$(code "$RC71_R2")" "42205"
rr68_q "$RC71_RN2A" "{\"kind\":\"ok\",\"status\":\"SUCCESS\",\"amount\":$RC71_AMT2A}"
rr68_sched
assert_eq "71.2a 补查后 SUCCESS" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2A';")" "SUCCESS"
assert_eq "71.2a 订单 REFUNDED" "$(order_status $RC71_O2A)" "REFUNDED"
assert_eq "71.2a refunded_amount=实付" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O2A;")" "$RC71_AMT2A"

echo "-- 71.2(b) 部分超时 + 补查查无 → FAILED，之后可再退 --"
RC71_O2B=$(make_paid_order); [[ -n "$RC71_O2B" ]] && ok "71.2b 造单 #$RC71_O2B" || fail "71.2b 造单失败"
rc71_create "$RC71_O2B" '{"kind":"timeout"}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2B/refund" "$AT" '{"amount":100}')
assert_eq "71.2b 响应 code 50202" "$(code "$RC71_R")" "50202"
RC71_RN2B=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2B ORDER BY id DESC LIMIT 1;")
rr68_q "$RC71_RN2B" '{"kind":"not_found"}'
rr68_sched
assert_eq "71.2b 补查查无 → FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2B';")" "FAILED"
assert_eq "71.2b active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RC71_RN2B';")" "1"
RC71_R=$(req POST "/api/admin/orders/$RC71_O2B/refund" "$AT" '{"amount":100}')
assert_eq "71.2b 再退（无指令，走 MOCK 秒成功）code 0" "$(code "$RC71_R")" "0"
assert_eq "71.2b refunded_amount=100" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O2B;")" "100"

echo "-- 71.2(c) 明确拒绝（4xx）仍 FAILED --"
RC71_O2C=$(make_paid_order); [[ -n "$RC71_O2C" ]] && ok "71.2c 造单 #$RC71_O2C" || fail "71.2c 造单失败"
rc71_create "$RC71_O2C" '{"kind":"error","code":"NOT_ENOUGH","httpStatus":403}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2C/refund" "$AT" '{"amount":100}')
assert_eq "71.2c 响应 code 50201" "$(code "$RC71_R")" "50201"
RC71_RN2C=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2C ORDER BY id DESC LIMIT 1;")
assert_eq "71.2c 行 FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2C';")" "FAILED"
assert_eq "71.2c error_code=NOT_ENOUGH" "$(sql "SELECT error_code FROM refunds WHERE out_refund_no='$RC71_RN2C';")" "NOT_ENOUGH"
assert_eq "71.2c active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RC71_RN2C';")" "1"

echo "-- 71.2(d) 5xx 属未知，保留 PENDING --"
RC71_O2D=$(make_paid_order); [[ -n "$RC71_O2D" ]] && ok "71.2d 造单 #$RC71_O2D" || fail "71.2d 造单失败"
rc71_create "$RC71_O2D" '{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2D/refund" "$AT" '{"amount":100}')
assert_eq "71.2d 响应 code 50202" "$(code "$RC71_R")" "50202"
RC71_RN2D=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2D ORDER BY id DESC LIMIT 1;")
assert_eq "71.2d 行仍 PENDING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2D';")" "PENDING"
assert_eq "71.2d active_order_id 占位" "$(sql "SELECT active_order_id FROM refunds WHERE out_refund_no='$RC71_RN2D';")" "$RC71_O2D"

echo "-- 71.2(e) 幂等重放：同一 idempotencyKey 不二次外呼 --"
RC71_O2E=$(make_paid_order); [[ -n "$RC71_O2E" ]] && ok "71.2e 造单 #$RC71_O2E" || fail "71.2e 造单失败"
rc71_create "$RC71_O2E" '{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}'
RC71_CALLS_E0=$(rc71_calls createRefund)
RC71_R=$(req POST "/api/admin/orders/$RC71_O2E/refund" "$AT" '{"amount":100,"idempotencyKey":"k71e-selftest"}')
assert_eq "71.2e 首发 code 50202" "$(code "$RC71_R")" "50202"
RC71_R2=$(req POST "/api/admin/orders/$RC71_O2E/refund" "$AT" '{"amount":100,"idempotencyKey":"k71e-selftest"}')
assert_eq "71.2e 重放 code 0" "$(code "$RC71_R2")" "0"
assert_eq "71.2e 重放返回 refund.status PENDING" "$(jq -r .data.refund.status <<<"$RC71_R2")" "PENDING"
assert_eq "71.2e createRefund 调用不变（未二次外呼）" "$RC71_CALLS_E0" "$(rc71_calls createRefund)"
RC71_RN2E=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2E ORDER BY id DESC LIMIT 1;")
rr68_q "$RC71_RN2E" '{"kind":"not_found"}'
rr68_sched
assert_eq "71.2e 收尾：补查查无 → FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2E';")" "FAILED"

echo "-- 71.3 P1 人工出口（只对 ABNORMAL 行）--"
RC71_O3=$(make_paid_order); [[ -n "$RC71_O3" ]] && ok "71.3 造单 #$RC71_O3" || fail "71.3 造单失败"
RC71_AMT3=$(req GET "/api/admin/orders/$RC71_O3" "$AT" | jq -r .data.actualAmount)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71' WHERE id=$RC71_O3;"
RC71_ORN3="refund_${RC71_O3}_e2e71_$RANDOM$RANDOM"
RC71_ONO3=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3, '$RC71_ONO3', 'order_${RC71_O3}_e2e71', '$RC71_ORN3', $RC71_AMT3, $RC71_AMT3, 'PROCESSING', 'WECHAT', $RC71_O3, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3" '{"kind":"not_found"}'
rr68_sched
assert_eq "71.3 造出 ABNORMAL 行" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_ORN3';")" "ABNORMAL"
RC71_RID3=$(rc71_refund_id "$RC71_ORN3")

echo "-- 71.3 守卫断言 --"
RC71_O3B=$(make_paid_order); [[ -n "$RC71_O3B" ]] && ok "71.3 造对照单 #$RC71_O3B" || fail "71.3 造对照单失败"
# 先验一条 PROCESSING 行不可被核实（用另一张单造一条 PROCESSING）
RC71_ORN3P="refund_${RC71_O3B}_e2e71p_$RANDOM"
RC71_ONO3B=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3B;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3B, '$RC71_ONO3B', 'order_${RC71_O3B}_e2e71p', '$RC71_ORN3P', 100, 100, 'PROCESSING', 'WECHAT', $RC71_O3B, NOW(3), NOW(3));"
RC71_RIDP=$(rc71_refund_id "$RC71_ORN3P")
RC71_R=$(rc71_resolve "$RC71_O3B" "$RC71_RIDP" '{"result":"SUCCESS","verifiedAmount":100,"note":"测试核实说明"}')
assert_eq "71.3 对 PROCESSING 行调用 → 42204" "$(code "$RC71_R")" "42204"
assert_eq "71.3 PROCESSING 行状态不变" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RIDP;")" "PROCESSING"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE id=$RC71_RIDP;"

RC71_R=$(rc71_resolve "$RC71_O3B" "$RC71_RID3" '{"result":"SUCCESS","verifiedAmount":100,"note":"测试核实说明"}')
assert_eq "71.3 refundId 不属于该订单 → 40401" "$(code "$RC71_R")" "40401"

RC71_R=$(rc71_resolve "$RC71_O3" "$RC71_RID3" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$RC71_AMT3,\"note\":\"短\"}")
assert_eq "71.3 note 少于 4 字 → 40001" "$(code "$RC71_R")" "40001"

RC71_R=$(rc71_resolve "$RC71_O3" "$RC71_RID3" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$((RC71_AMT3+100000)),\"note\":\"超额测试\"}")
assert_eq "71.3 verifiedAmount 超过可退余额 → 42206" "$(code "$RC71_R")" "42206"
assert_eq "71.3 超额未落库，行仍 ABNORMAL" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3;")" "ABNORMAL"

echo "-- 71.3 主路径（全额 ABNORMAL → SUCCESS）--"
RC71_R=$(rc71_resolve "$RC71_O3" "$RC71_RID3" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$RC71_AMT3,\"note\":\"商户平台退款单已核对\"}")
assert_eq "71.3 主路径 code 0" "$(code "$RC71_R")" "0"
RC71_CHECK3=$(sql "SELECT CONCAT(status,' ',active_order_id IS NULL,' ',manual_resolved_by,' ',manual_resolve_note IS NOT NULL,' ',manual_resolved_at IS NOT NULL,' ',wx_notify_data LIKE '%manual-verified%') FROM refunds WHERE id=$RC71_RID3;")
assert_eq "71.3 行 SUCCESS+释放+留痕三列+manual标记" "$RC71_CHECK3" "SUCCESS 1 admin 1 1 1"
assert_eq "71.3 订单 REFUNDED" "$(order_status $RC71_O3)" "REFUNDED"
assert_eq "71.3 refunded_amount=实付" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3;")" "$RC71_AMT3"
assert_eq "71.3 payment REFUNDED" "$(sql "SELECT status FROM payments WHERE order_id=$RC71_O3;")" "REFUNDED"
assert_eq "71.3 不再进「退款待处理」" "$(rc71_attn $RC71_O3)" "0"
RC71_R=$(rc71_resolve "$RC71_O3" "$RC71_RID3" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$RC71_AMT3,\"note\":\"再核一次\"}")
assert_eq "71.3 已不是 ABNORMAL 再调 → 42204" "$(code "$RC71_R")" "42204"

echo "-- 71.3 部分 ABNORMAL：核实后释放，可再退剩余 --"
RC71_O3C=$(make_paid_order); [[ -n "$RC71_O3C" ]] && ok "71.3 造部分单 #$RC71_O3C" || fail "71.3 造单失败"
RC71_AMT3C=$(req GET "/api/admin/orders/$RC71_O3C" "$AT" | jq -r .data.actualAmount)
RC71_ORN3C="refund_${RC71_O3C}_e2e71c_$RANDOM"
RC71_ONO3C=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3C;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3C, '$RC71_ONO3C', 'order_${RC71_O3C}_e2e71c', '$RC71_ORN3C', 100, $RC71_AMT3C, 'PROCESSING', 'WECHAT', $RC71_O3C, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3C" '{"kind":"not_found"}'
rr68_sched
RC71_RID3C=$(rc71_refund_id "$RC71_ORN3C")
assert_eq "71.3 部分单造出 ABNORMAL" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3C;")" "ABNORMAL"
RC71_R=$(rc71_resolve "$RC71_O3C" "$RC71_RID3C" '{"result":"SUCCESS","verifiedAmount":100,"note":"部分核实成功"}')
assert_eq "71.3 部分核实 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 订单仍 PAID" "$(order_status $RC71_O3C)" "PAID"
assert_eq "71.3 refunded_amount=100" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3C;")" "100"
RC71_REMAIN3C=$(req GET "/api/admin/orders/$RC71_O3C" "$AT" | jq -r .data.remainingRefundable)
assert_eq "71.3 remainingRefundable=实付-100" "$RC71_REMAIN3C" "$((RC71_AMT3C-100))"
RC71_R=$(req POST "/api/admin/orders/$RC71_O3C/refund" "$AT" "{\"amount\":$RC71_REMAIN3C}")
assert_eq "71.3 再退剩余 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 订单 REFUNDED（在途位确实释放）" "$(order_status $RC71_O3C)" "REFUNDED"

echo "-- 71.3 D1：核实为未退款 → CLOSED，释放可重新发起 --"
RC71_O3D=$(make_paid_order); [[ -n "$RC71_O3D" ]] && ok "71.3 D1 造单 #$RC71_O3D" || fail "71.3 D1 造单失败"
RC71_AMT3D=$(req GET "/api/admin/orders/$RC71_O3D" "$AT" | jq -r .data.actualAmount)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71d' WHERE id=$RC71_O3D;"
RC71_ORN3D="refund_${RC71_O3D}_e2e71d_$RANDOM"
RC71_ONO3D=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3D;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3D, '$RC71_ONO3D', 'order_${RC71_O3D}_e2e71d', '$RC71_ORN3D', $RC71_AMT3D, $RC71_AMT3D, 'PROCESSING', 'WECHAT', $RC71_O3D, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3D" '{"kind":"not_found"}'
rr68_sched
RC71_RID3D=$(rc71_refund_id "$RC71_ORN3D")
RC71_R=$(rc71_resolve "$RC71_O3D" "$RC71_RID3D" "{\"result\":\"CLOSED\",\"verifiedAmount\":$RC71_AMT3D,\"note\":\"商户平台查无此退款，未退\"}")
assert_eq "71.3 D1 code 0" "$(code "$RC71_R")" "0"
RC71_CHECK3D=$(sql "SELECT CONCAT(status,' ',active_order_id IS NULL,' ',manual_resolved_by IS NOT NULL) FROM refunds WHERE id=$RC71_RID3D;")
assert_eq "71.3 D1 行 CLOSED+释放+已留痕" "$RC71_CHECK3D" "CLOSED 1 1"
assert_eq "71.3 D1 订单仍 REFUNDING" "$(order_status $RC71_O3D)" "REFUNDING"
assert_eq "71.3 D1 refunded_amount=0" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3D;")" "0"
assert_eq "71.3 D1 进「退款待处理」" "$(rc71_attn $RC71_O3D)" "1"
RC71_R=$(req POST "/api/admin/orders/$RC71_O3D/refund" "$AT" "{\"amount\":$RC71_AMT3D}")
assert_eq "71.3 D1 释放后重新发起 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D1 订单 REFUNDED" "$(order_status $RC71_O3D)" "REFUNDED"

echo "-- 71.3 D2：实退金额与记录不符时按实退落账 --"
RC71_O3E=$(make_paid_order); [[ -n "$RC71_O3E" ]] && ok "71.3 D2 造单 #$RC71_O3E" || fail "71.3 D2 造单失败"
RC71_AMT3E=$(req GET "/api/admin/orders/$RC71_O3E" "$AT" | jq -r .data.actualAmount)
RC71_ORN3E="refund_${RC71_O3E}_e2e71e_$RANDOM"
RC71_ONO3E=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3E;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3E, '$RC71_ONO3E', 'order_${RC71_O3E}_e2e71e', '$RC71_ORN3E', 100, $RC71_AMT3E, 'PROCESSING', 'WECHAT', $RC71_O3E, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3E" '{"kind":"ok","status":"SUCCESS","amount":999999999}'
rr68_sched
RC71_RID3E=$(rc71_refund_id "$RC71_ORN3E")
assert_eq "71.3 D2 造出 ABNORMAL" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3E;")" "ABNORMAL"
RC71_R=$(rc71_resolve "$RC71_O3E" "$RC71_RID3E" '{"result":"SUCCESS","verifiedAmount":80,"note":"实退与记录不符，已核对"}')
assert_eq "71.3 D2 实退金额 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D2 行 amount 改为实退 80" "$(sql "SELECT amount FROM refunds WHERE id=$RC71_RID3E;")" "80"
assert_eq "71.3 D2 refunded_amount=80" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3E;")" "80"
RC71_NOTE3E=$(sql "SELECT manual_resolve_note FROM refunds WHERE id=$RC71_RID3E;")
[[ "$RC71_NOTE3E" == *"原记录"* && "$RC71_NOTE3E" == *"实退"* ]] && ok "71.3 D2 说明含原记录→实退前缀" || fail "71.3 D2 说明前缀" "$RC71_NOTE3E"

echo "-- 71.4 P4「退款待处理」口径 --"
echo "-- 71.4 部分退款 ABNORMAL（订单 PAID）进页签 --"
RC71_O4=$(make_paid_order); [[ -n "$RC71_O4" ]] && ok "71.4 造单 #$RC71_O4" || fail "71.4 造单失败"
RC71_ATTN_EX_BEFORE=$(req GET /api/admin/orders/pending-count "$AT" | jq -r .data.refundAttentionByChannel.EXPRESS)
RC71_ORN4="refund_${RC71_O4}_e2e71f_$RANDOM"
RC71_ONO4=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O4;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O4, '$RC71_ONO4', 'order_${RC71_O4}_e2e71f', '$RC71_ORN4', 100, 100, 'PROCESSING', 'WECHAT', $RC71_O4, NOW(3), NOW(3));"
rr68_q "$RC71_ORN4" '{"kind":"not_found"}'
rr68_sched
assert_eq "71.4 部分 ABNORMAL 进页签" "$(rc71_attn $RC71_O4)" "1"
assert_eq "71.4 refundAttentionByChannel.EXPRESS +1" "$((RC71_ATTN_EX_BEFORE+1))" "$(req GET /api/admin/orders/pending-count "$AT" | jq -r .data.refundAttentionByChannel.EXPRESS)"
RC71_LIST4=$(req GET "/api/admin/orders?status=REFUND_ATTENTION&deliveryType=ALL&pageSize=50" "$AT" | jq --argjson id "$RC71_O4" '.data.list[] | select(.id==$id)')
assert_eq "71.4 列表项 latestRefund.status=ABNORMAL" "$(jq -r .latestRefund.status <<<"$RC71_LIST4")" "ABNORMAL"
[[ "$(jq -r .latestRefund.reconcileLastError <<<"$RC71_LIST4")" != "null" ]] && ok "71.4 列表项带 reconcileLastError" || fail "71.4 reconcileLastError 缺失"
RC71_RID4=$(rc71_refund_id "$RC71_ORN4")
rc71_resolve "$RC71_O4" "$RC71_RID4" '{"result":"CLOSED","verifiedAmount":100,"note":"核实未退款释放"}' >/dev/null
assert_eq "71.4 核实后退出页签" "$(rc71_attn $RC71_O4)" "0"

echo "-- 71.4 keyword 与 REFUND_ATTENTION 不互相覆盖 --"
RC71_O4B=$(make_paid_order); [[ -n "$RC71_O4B" ]] && ok "71.4 造单 #$RC71_O4B" || fail "71.4 造单失败"
RC71_ONO4B=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O4B;")
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71 keyword' WHERE id=$RC71_O4B;"
RC71_LIST4B=$(req GET "/api/admin/orders?status=REFUND_ATTENTION&keyword=$RC71_ONO4B" "$AT")
assert_eq "71.4 keyword+REFUND_ATTENTION 命中恰好该单" "$(jq -r '.data.total' <<<"$RC71_LIST4B")" "1"
RC71_LIST4C=$(req GET "/api/admin/orders?status=REFUND_ATTENTION&keyword=不存在的号e2e71xyz" "$AT")
assert_eq "71.4 keyword 不匹配 → 空" "$(jq -r '.data.total' <<<"$RC71_LIST4C")" "0"

echo "-- 71.4 售后 APPROVED 卡住（同步失败/异步 CLOSED）进页签，重新退款收口 --"
RC71_O4D=$(make_paid_order); [[ -n "$RC71_O4D" ]] && ok "71.4 造发货单 #$RC71_O4D" || fail "71.4 造单失败"
req POST "/api/admin/orders/$RC71_O4D/ship" "$AT" '{"expressCompany":"其他：e2e71","expressNo":"E2E71AS"}' >/dev/null
RC71_ASR=$(req POST "/api/orders/$RC71_O4D/after-sale" "$UT" "{\"reason\":\"SHORTAGE\",\"description\":\"e2e71 少发\",\"images\":[\"$URL\"]}")
RC71_AS4=$(jq -r '.data.id // empty' <<<"$RC71_ASR"); [[ -n "$RC71_AS4" ]] && ok "71.4 售后单 #$RC71_AS4" || fail "71.4 创建售后单" "$RC71_ASR"
rc71_create "$RC71_O4D" '{"kind":"ok","status":"PROCESSING"}'
RC71_R=$(req POST "/api/admin/after-sales/$RC71_AS4/approve" "$AT" '{"amount":100,"reply":"71.4"}')
assert_eq "71.4 同意售后 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.4 售后 APPROVED" "$(jq -r .data.afterSale.status <<<"$RC71_R")" "APPROVED"
assert_eq "71.4 退款 PROCESSING" "$(jq -r .data.refund.status <<<"$RC71_R")" "PROCESSING"
assert_eq "71.4 在途不进页签" "$(rc71_attn $RC71_O4D)" "0"
RC71_RN4D=$(jq -r .data.refund.outRefundNo <<<"$RC71_R")
rr68_q "$RC71_RN4D" '{"kind":"ok","status":"CLOSED"}'
rr68_sched
assert_eq "71.4 退款 CLOSED 后进页签（新口径）" "$(rc71_attn $RC71_O4D)" "1"
RC71_APPROVED_LIST=$(req GET "/api/admin/after-sales?status=APPROVED" "$AT")
RC71_AS4_ITEM=$(jq --argjson id "$RC71_AS4" '.data.list[] | select(.id==$id)' <<<"$RC71_APPROVED_LIST")
assert_eq "71.4 售后列表 order.latestRefund.status=CLOSED" "$(jq -r '.order.latestRefund.status' <<<"$RC71_AS4_ITEM")" "CLOSED"
RC71_R=$(req POST "/api/admin/after-sales/$RC71_AS4/approve" "$AT" '{"amount":100,"reply":"重新退"}')
assert_eq "71.4 重新退款 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.4 售后 → DONE" "$(jq -r .data.afterSale.status <<<"$RC71_R")" "DONE"
RC71_NEW_RID=$(jq -r .data.afterSale.refundId <<<"$RC71_R")
[[ "$RC71_NEW_RID" != "null" && -n "$RC71_NEW_RID" ]] && ok "71.4 售后 refund_id 指向新那笔" || fail "71.4 refund_id" "$RC71_R"
assert_eq "71.4 收口后退出页签" "$(rc71_attn $RC71_O4D)" "0"

echo "-- 71.4 既有口径保持：无售后单的部分退款 CLOSED 不进 --"
RC71_O4E=$(make_paid_order); [[ -n "$RC71_O4E" ]] && ok "71.4 造单 #$RC71_O4E" || fail "71.4 造单失败"
RC71_R=$(req POST "/api/admin/orders/$RC71_O4E/refund" "$AT" '{"amount":100,"reason":"71.4e"}')
assert_eq "71.4e 部分退款 code 0" "$(code "$RC71_R")" "0"
RC71_RN4E=$(jq -r .data.refund.outRefundNo <<<"$RC71_R")
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL WHERE out_refund_no='$RC71_RN4E';"
assert_eq "71.4e 无售后单的部分退款 CLOSED 不进页签" "$(rc71_attn $RC71_O4E)" "0"

echo "-- 71 分片收尾：把在途行推到终态，清空 pay-mock --"
sql "UPDATE refunds SET status='CLOSED', active_order_id=NULL
     WHERE out_refund_no LIKE 'refund_%_e2e71%' AND status IN ('PENDING','PROCESSING','ABNORMAL');"
req POST /api/admin/system/pay-mock/reset "$AT" >/dev/null
assert_eq "71 收尾：createRefund 调用计数已清零" "$(rc71_calls createRefund)" "0"
assert_eq "71 收尾：queryRefund 调用计数已清零" "$(rc71_calls queryRefund)" "0"
