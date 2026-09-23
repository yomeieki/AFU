echo "== 71. 退款资金一致性修复（P1-P6，2026-09-23）=="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/sched/make_paid_order/order_status/latest_refund/sql 与 $AT/$UT/$URL，
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

# R3（复核）：收尾要能断言「本分片名下订单不留任何在途退款行」，且不许用 SQL 兜底改状态。
# make_paid_order 在 $(...) 子 shell 里执行，直接改全局变量不会回传给父 shell（e2e.sh 自己也
# 因为这个坑用文件而不是变量传递失败计数，见文件头 MK_LOCAL_PAID_FAIL_FILE）——这里同样用文件
# 记录本分片造过的每一个订单 id。
RC71_ORDERS_FILE=$(mktemp)
rc71_mk() {
  local o
  o=$(make_paid_order)
  [[ -n "$o" ]] && echo "$o" >> "$RC71_ORDERS_FILE"
  echo "$o"
}

echo "-- 71.1 P2 回调抢先（同步回写不得把 SUCCESS 改回 PROCESSING）--"
RC71_O1=$(rc71_mk); [[ -n "$RC71_O1" ]] && ok "71.1 造单 #$RC71_O1" || fail "71.1 造单失败"
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
RC71_O1B=$(rc71_mk); [[ -n "$RC71_O1B" ]] && ok "71.1 反向造单 #$RC71_O1B" || fail "71.1 反向造单失败"
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
RC71_O2A=$(rc71_mk); [[ -n "$RC71_O2A" ]] && ok "71.2a 造单 #$RC71_O2A" || fail "71.2a 造单失败"
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
RC71_O2B=$(rc71_mk); [[ -n "$RC71_O2B" ]] && ok "71.2b 造单 #$RC71_O2B" || fail "71.2b 造单失败"
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
RC71_O2C=$(rc71_mk); [[ -n "$RC71_O2C" ]] && ok "71.2c 造单 #$RC71_O2C" || fail "71.2c 造单失败"
rc71_create "$RC71_O2C" '{"kind":"error","code":"NOT_ENOUGH","httpStatus":403}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2C/refund" "$AT" '{"amount":100}')
assert_eq "71.2c 响应 code 50201" "$(code "$RC71_R")" "50201"
RC71_RN2C=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2C ORDER BY id DESC LIMIT 1;")
assert_eq "71.2c 行 FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2C';")" "FAILED"
assert_eq "71.2c error_code=NOT_ENOUGH" "$(sql "SELECT error_code FROM refunds WHERE out_refund_no='$RC71_RN2C';")" "NOT_ENOUGH"
assert_eq "71.2c active_order_id NULL" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE out_refund_no='$RC71_RN2C';")" "1"
echo "-- 71.2(c) R9：FAILED 终态后微信回调晚到 SUCCESS，无后续行 → 按微信结果落账（不再是「疑似重复」）--"
RC71_R=$(req POST /api/admin/system/pay-mock/refund-notify "$AT" "{\"outRefundNo\":\"$RC71_RN2C\",\"status\":\"SUCCESS\"}")
assert_eq "71.2c R9：回调 ack code 0" "$(code "$RC71_R")" "0"
RC71_CHECK2C=$(sql "SELECT CONCAT(status,' ',reconcile_last_error LIKE '%已按微信结果落账%') FROM refunds WHERE out_refund_no='$RC71_RN2C';")
assert_eq "71.2c R9：FAILED 行翻成 SUCCESS，留痕「已按微信结果落账」" "$RC71_CHECK2C" "SUCCESS 1"
assert_eq "71.2c R9：refunded_amount 累加为 100" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O2C;")" "100"

echo "-- 71.2(d) 5xx 属未知，保留 PENDING，随后收口为 FAILED（R3：不留在途残留）--"
RC71_O2D=$(rc71_mk); [[ -n "$RC71_O2D" ]] && ok "71.2d 造单 #$RC71_O2D" || fail "71.2d 造单失败"
rc71_create "$RC71_O2D" '{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2D/refund" "$AT" '{"amount":100}')
assert_eq "71.2d 响应 code 50202" "$(code "$RC71_R")" "50202"
RC71_RN2D=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2D ORDER BY id DESC LIMIT 1;")
assert_eq "71.2d 行仍 PENDING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2D';")" "PENDING"
assert_eq "71.2d active_order_id 占位" "$(sql "SELECT active_order_id FROM refunds WHERE out_refund_no='$RC71_RN2D';")" "$RC71_O2D"
rr68_q "$RC71_RN2D" '{"kind":"not_found"}'
rr68_sched
assert_eq "71.2d 收尾：补查查无 → FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2D';")" "FAILED"

echo "-- 71.2(e) 幂等重放：结果未知后顺序重放不二次外呼、不建第二笔 --"
# 注（R13，升级轮裁决更新）：事务 A 首句 FOR UPDATE 把同单的两个事务 A 串行化——后到者在
# 锁内看到先到者刚插入的在途行就报 42205，走不到 outRefundNo 唯一索引那一步；只有同键行已是
# 终态（SUCCESS/CLOSED/FAILED，activeOrderId 为 NULL）时才会撞索引、复用返回。本用例的两次
# POST 是**顺序**发起：第一次返回时事务 A 早已提交，refund 行已经是 PENDING（在途），
# 订单级 42205 守卫（order.refunds.some(ACTIVE)）会先一步拦住第二次请求——不管
# idempotencyKey 是否相同。这与「不确定结果时不重复外呼、不生成第二笔退款」的安全目标是
# 一致的：只是安全网从「幂等去重返回同一笔」换成了「显式拒绝」。
RC71_O2E=$(rc71_mk); [[ -n "$RC71_O2E" ]] && ok "71.2e 造单 #$RC71_O2E" || fail "71.2e 造单失败"
rc71_create "$RC71_O2E" '{"kind":"error","code":"SYSTEM_ERROR","httpStatus":500}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O2E/refund" "$AT" '{"amount":100,"idempotencyKey":"k71e-selftest"}')
assert_eq "71.2e 首发 code 50202" "$(code "$RC71_R")" "50202"
RC71_CALLS_E1=$(rc71_calls createRefund)
RC71_ROWS_E1=$(sql "SELECT COUNT(*) FROM refunds WHERE order_id=$RC71_O2E;")
RC71_R2=$(req POST "/api/admin/orders/$RC71_O2E/refund" "$AT" '{"amount":100,"idempotencyKey":"k71e-selftest"}')
assert_eq "71.2e 顺序重放被 42205 拦住（订单已有在途退款）" "$(code "$RC71_R2")" "42205"
assert_eq "71.2e createRefund 调用不变（未二次外呼）" "$RC71_CALLS_E1" "$(rc71_calls createRefund)"
assert_eq "71.2e 未建第二笔退款行" "$RC71_ROWS_E1" "$(sql "SELECT COUNT(*) FROM refunds WHERE order_id=$RC71_O2E;")"
RC71_RN2E=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2E ORDER BY id DESC LIMIT 1;")
rr68_q "$RC71_RN2E" '{"kind":"not_found"}'
rr68_sched
assert_eq "71.2e 收尾：补查查无 → FAILED" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2E';")" "FAILED"

echo "-- 71.2(f) R5：顾客自助取消遇结果未知，不再推「需人工重试」（后台也没有对应按钮）--"
RC71_O2F=$(rc71_mk); [[ -n "$RC71_O2F" ]] && ok "71.2f 造单 #$RC71_O2F" || fail "71.2f 造单失败"
rc71_create "$RC71_O2F" '{"kind":"timeout"}'
RC71_R=$(req PUT "/api/orders/$RC71_O2F/cancel" "$UT")
assert_eq "71.2f 响应 code 0（路由内部吞掉了 50202，不透传给顾客）" "$(code "$RC71_R")" "0"
assert_eq "71.2f autoRefunded=false" "$(jq -r .data.autoRefunded <<<"$RC71_R")" "false"
RC71_RN2F=$(sql "SELECT out_refund_no FROM refunds WHERE order_id=$RC71_O2F ORDER BY id DESC LIMIT 1;")
assert_eq "71.2f 行 PENDING" "$(sql "SELECT status FROM refunds WHERE out_refund_no='$RC71_RN2F';")" "PENDING"
assert_eq "71.2f active_order_id 占位" "$(sql "SELECT active_order_id FROM refunds WHERE out_refund_no='$RC71_RN2F';")" "$RC71_O2F"
assert_eq "71.2f 订单 REFUNDING" "$(order_status $RC71_O2F)" "REFUNDING"
RC71_AMT2F=$(sql "SELECT actual_amount FROM orders WHERE id=$RC71_O2F;")
rr68_q "$RC71_RN2F" "{\"kind\":\"ok\",\"status\":\"SUCCESS\",\"amount\":$RC71_AMT2F}"
rr68_sched
assert_eq "71.2f 补查后 REFUNDED" "$(order_status $RC71_O2F)" "REFUNDED"

echo "-- 71.3 P1 人工出口（只对 ABNORMAL 行）--"
RC71_O3=$(rc71_mk); [[ -n "$RC71_O3" ]] && ok "71.3 造单 #$RC71_O3" || fail "71.3 造单失败"
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
RC71_O3B=$(rc71_mk); [[ -n "$RC71_O3B" ]] && ok "71.3 造对照单 #$RC71_O3B" || fail "71.3 造对照单失败"
# 先验一条 PROCESSING 行不可被核实（用另一张单造一条 PROCESSING）
RC71_ORN3P="refund_${RC71_O3B}_e2e71p_$RANDOM"
RC71_ONO3B=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3B;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3B, '$RC71_ONO3B', 'order_${RC71_O3B}_e2e71p', '$RC71_ORN3P', 100, 100, 'PROCESSING', 'WECHAT', $RC71_O3B, NOW(3), NOW(3));"
RC71_RIDP=$(rc71_refund_id "$RC71_ORN3P")
RC71_R=$(rc71_resolve "$RC71_O3B" "$RC71_RIDP" '{"result":"SUCCESS","verifiedAmount":100,"note":"测试核实说明"}')
assert_eq "71.3 对 PROCESSING 行调用 → 42204" "$(code "$RC71_R")" "42204"
assert_eq "71.3 PROCESSING 行状态不变" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RIDP;")" "PROCESSING"
# R3：不用 SQL 强改状态处理这条对照行，改走真实补查流程把它收口成 CLOSED。
rr68_q "$RC71_ORN3P" '{"kind":"ok","status":"CLOSED"}'
rr68_sched
assert_eq "71.3 对照行经真实补查收口为 CLOSED（非 SQL）" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RIDP;")" "CLOSED"

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
RC71_PJ=$(req GET "/api/admin/print-jobs?orderId=$RC71_O3" "$AT" | jq '[.data.list[] | select(.kind=="CANCEL")] | length')
assert_eq "71.3 出票：print-jobs 中 CANCEL 恰好 1 条（本单是 SQL 直插 REFUNDING，此前未出过票）" "$RC71_PJ" "1"
RC71_R=$(rc71_resolve "$RC71_O3" "$RC71_RID3" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$RC71_AMT3,\"note\":\"再核一次\"}")
assert_eq "71.3 已不是 ABNORMAL 再调 → 42204" "$(code "$RC71_R")" "42204"

echo "-- 71.3 R6：终态（SUCCESS）后回调重推同样是 SUCCESS，保持静默（幂等重推，非重复退款信号）--"
RC71_R=$(req POST /api/admin/system/pay-mock/refund-notify "$AT" "{\"outRefundNo\":\"$RC71_ORN3\",\"status\":\"SUCCESS\"}")
assert_eq "71.3 R6：SUCCESS 行重推 SUCCESS，ack code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 R6：refunded_amount 不再变化" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3;")" "$RC71_AMT3"

echo "-- 71.3 部分 ABNORMAL：核实后释放，可再退剩余 --"
RC71_O3C=$(rc71_mk); [[ -n "$RC71_O3C" ]] && ok "71.3 造部分单 #$RC71_O3C" || fail "71.3 造单失败"
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
RC71_O3D=$(rc71_mk); [[ -n "$RC71_O3D" ]] && ok "71.3 D1 造单 #$RC71_O3D" || fail "71.3 D1 造单失败"
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

echo "-- 71.3 D1(i) R9：CLOSED 未重新发起，回调晚到 SUCCESS → 按微信结果落账（人工核实留痕保留，wxNotifyData 追加）--"
RC71_R=$(req POST /api/admin/system/pay-mock/refund-notify "$AT" "{\"outRefundNo\":\"$RC71_ORN3D\",\"status\":\"SUCCESS\"}")
assert_eq "71.3 D1(i) 回调 ack code 0" "$(code "$RC71_R")" "0"
RC71_CHECK3D_I=$(sql "SELECT CONCAT(status,' ',active_order_id IS NULL,' ',manual_resolved_by,' ',reconcile_last_error LIKE '%人工核实%',' ',wx_notify_data LIKE '%manual-verified%',' ',wx_notify_data LIKE '%mock-notify%') FROM refunds WHERE id=$RC71_RID3D;")
assert_eq "71.3 D1(i) 行 SUCCESS+释放+manual 留痕仍在+人工核实文案+两段 wxNotifyData 都在（R10 追加不覆盖）" "$RC71_CHECK3D_I" "SUCCESS 1 admin 1 1 1"
assert_eq "71.3 D1(i) 订单 REFUNDED" "$(order_status $RC71_O3D)" "REFUNDED"
assert_eq "71.3 D1(i) refunded_amount=A" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3D;")" "$RC71_AMT3D"
assert_eq "71.3 D1(i) payments REFUNDED" "$(sql "SELECT status FROM payments WHERE order_id=$RC71_O3D;")" "REFUNDED"
RC71_PJ_D1=$(req GET "/api/admin/print-jobs?orderId=$RC71_O3D" "$AT" | jq '[.data.list[] | select(.kind=="CANCEL")] | length')
assert_eq "71.3 D1(i) print-jobs CANCEL 恰好 1 条" "$RC71_PJ_D1" "1"
assert_eq "71.3 D1(i) 不再进「退款待处理」" "$(rc71_attn $RC71_O3D)" "0"
RC71_R=$(req POST "/api/admin/orders/$RC71_O3D/refund" "$AT" "{\"amount\":$RC71_AMT3D}")
assert_eq "71.3 D1(i) 已全额退款再退 → 42206" "$(code "$RC71_R")" "42206"

echo "-- 71.3 D1(ii) R9：CLOSED 后已重新发起成功，原行回调晚到 SUCCESS → 仍留痕疑似重复退款，LEAST 封顶 --"
RC71_O3D2=$(rc71_mk); [[ -n "$RC71_O3D2" ]] && ok "71.3 D1(ii) 造单 #$RC71_O3D2" || fail "71.3 D1(ii) 造单失败"
RC71_AMT3D2=$(req GET "/api/admin/orders/$RC71_O3D2" "$AT" | jq -r .data.actualAmount)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71d2' WHERE id=$RC71_O3D2;"
RC71_ORN3D2="refund_${RC71_O3D2}_e2e71d2_$RANDOM"
RC71_ONO3D2=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3D2;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3D2, '$RC71_ONO3D2', 'order_${RC71_O3D2}_e2e71d2', '$RC71_ORN3D2', $RC71_AMT3D2, $RC71_AMT3D2, 'PROCESSING', 'WECHAT', $RC71_O3D2, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3D2" '{"kind":"not_found"}'
rr68_sched
RC71_RID3D2=$(rc71_refund_id "$RC71_ORN3D2")
RC71_R=$(rc71_resolve "$RC71_O3D2" "$RC71_RID3D2" "{\"result\":\"CLOSED\",\"verifiedAmount\":$RC71_AMT3D2,\"note\":\"商户平台查无此退款，未退\"}")
assert_eq "71.3 D1(ii) 释放 code 0" "$(code "$RC71_R")" "0"
RC71_R=$(req POST "/api/admin/orders/$RC71_O3D2/refund" "$AT" "{\"amount\":$RC71_AMT3D2}")
assert_eq "71.3 D1(ii) 释放后重新发起 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D1(ii) 重新发起后订单 REFUNDED" "$(order_status $RC71_O3D2)" "REFUNDED"
assert_eq "71.3 D1(ii) refunded_amount=A" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3D2;")" "$RC71_AMT3D2"
RC71_R=$(req POST /api/admin/system/pay-mock/refund-notify "$AT" "{\"outRefundNo\":\"$RC71_ORN3D2\",\"status\":\"SUCCESS\"}")
assert_eq "71.3 D1(ii) 原行回调晚到 ack code 0" "$(code "$RC71_R")" "0"
RC71_CHECK3D2=$(sql "SELECT CONCAT(status,' ',reconcile_last_error LIKE '%疑似重复退款%') FROM refunds WHERE id=$RC71_RID3D2;")
assert_eq "71.3 D1(ii) 原行翻 SUCCESS，留痕疑似重复退款" "$RC71_CHECK3D2" "SUCCESS 1"
assert_eq "71.3 D1(ii) refunded_amount 仍是 A（LEAST 封顶，不因原行再累加）" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3D2;")" "$RC71_AMT3D2"
assert_eq "71.3 D1(ii) 订单仍 REFUNDED" "$(order_status $RC71_O3D2)" "REFUNDED"
RC71_PLEDGER=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE ref_type='REFUND' AND ref_id=$RC71_RID3D2;")
assert_eq "71.3 D1(ii) 原行没有再产生一条积分扣回流水（已到上限扣 0 也不留痕）" "$RC71_PLEDGER" "0"

echo "-- 71.3 D2：实退金额与记录不符时按实退落账 --"
RC71_O3E=$(rc71_mk); [[ -n "$RC71_O3E" ]] && ok "71.3 D2 造单 #$RC71_O3E" || fail "71.3 D2 造单失败"
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

echo "-- 71.3 D2（R4 裁决收紧）：订单不在 REFUNDING 时不能把余额一次退空 --"
RC71_O3F=$(rc71_mk); [[ -n "$RC71_O3F" ]] && ok "71.3 D2R4 造单 #$RC71_O3F" || fail "71.3 D2R4 造单失败"
RC71_AMT3F=$(req GET "/api/admin/orders/$RC71_O3F" "$AT" | jq -r .data.actualAmount)
RC71_ORN3F="refund_${RC71_O3F}_e2e71g_$RANDOM"
RC71_ONO3F=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3F;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3F, '$RC71_ONO3F', 'order_${RC71_O3F}_e2e71g', '$RC71_ORN3F', 100, $RC71_AMT3F, 'PROCESSING', 'WECHAT', $RC71_O3F, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3F" '{"kind":"not_found"}'
rr68_sched
RC71_RID3F=$(rc71_refund_id "$RC71_ORN3F")
assert_eq "71.3 D2R4 造出 ABNORMAL（订单仍 PAID）" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3F;")" "ABNORMAL"
assert_eq "71.3 D2R4 订单 PAID" "$(order_status $RC71_O3F)" "PAID"
RC71_R=$(rc71_resolve "$RC71_O3F" "$RC71_RID3F" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$RC71_AMT3F,\"note\":\"一次退空测试\"}")
assert_eq "71.3 D2R4 实退=全部余额但订单非 REFUNDING → 42206" "$(code "$RC71_R")" "42206"
assert_eq "71.3 D2R4 行仍 ABNORMAL" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3F;")" "ABNORMAL"
assert_eq "71.3 D2R4 refunded_amount=0" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3F;")" "0"
assert_eq "71.3 D2R4 payments 仍 SUCCESS（未被拽去 REFUNDED）" "$(sql "SELECT status FROM payments WHERE order_id=$RC71_O3F;")" "SUCCESS"
RC71_R=$(rc71_resolve "$RC71_O3F" "$RC71_RID3F" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$((RC71_AMT3F-1)),\"note\":\"差一分不退空\"}")
assert_eq "71.3 D2R4 实退<余额（差一分）→ code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D2R4 refunded_amount=余额-1" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3F;")" "$((RC71_AMT3F-1))"
assert_eq "71.3 D2R4 订单仍 PAID" "$(order_status $RC71_O3F)" "PAID"
assert_eq "71.3 D2R4 payments 仍 SUCCESS（未达上限不翻）" "$(sql "SELECT status FROM payments WHERE order_id=$RC71_O3F;")" "SUCCESS"

echo "-- 71.3 D2（R4 裁决）：REFUNDING 订单允许把余额一次退空 --"
RC71_O3G=$(rc71_mk); [[ -n "$RC71_O3G" ]] && ok "71.3 D2R4b 造单 #$RC71_O3G" || fail "71.3 D2R4b 造单失败"
RC71_AMT3G=$(req GET "/api/admin/orders/$RC71_O3G" "$AT" | jq -r .data.actualAmount)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71g' WHERE id=$RC71_O3G;"
RC71_ORN3G="refund_${RC71_O3G}_e2e71h_$RANDOM"
RC71_ONO3G=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3G;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3G, '$RC71_ONO3G', 'order_${RC71_O3G}_e2e71h', '$RC71_ORN3G', $RC71_AMT3G, $RC71_AMT3G, 'PROCESSING', 'WECHAT', $RC71_O3G, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3G" '{"kind":"not_found"}'
rr68_sched
RC71_RID3G=$(rc71_refund_id "$RC71_ORN3G")
assert_eq "71.3 D2R4b 造出 ABNORMAL（订单 REFUNDING）" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3G;")" "ABNORMAL"
RC71_R=$(rc71_resolve "$RC71_O3G" "$RC71_RID3G" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$((RC71_AMT3G-100)),\"note\":\"退款中订单部分实退\"}")
assert_eq "71.3 D2R4b REFUNDING 订单实退<全额 → code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D2R4b refunded_amount=A-100" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3G;")" "$((RC71_AMT3G-100))"
assert_eq "71.3 D2R4b 订单仍 REFUNDING" "$(order_status $RC71_O3G)" "REFUNDING"
assert_eq "71.3 D2R4b 进「退款待处理」（无在途退款）" "$(rc71_attn $RC71_O3G)" "1"
RC71_R=$(req POST "/api/admin/orders/$RC71_O3G/refund" "$AT" '{"amount":100}')
assert_eq "71.3 D2R4b 补足剩余 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D2R4b 订单 REFUNDED" "$(order_status $RC71_O3G)" "REFUNDED"

echo "-- 71.3 D2（R11）：REFUNDING 全额 ABNORMAL 行，记录金额小于余额，真等额 override → REFUNDED --"
RC71_O3H=$(rc71_mk); [[ -n "$RC71_O3H" ]] && ok "71.3 D2R11 造单 #$RC71_O3H" || fail "71.3 D2R11 造单失败"
RC71_AMT3H=$(req GET "/api/admin/orders/$RC71_O3H" "$AT" | jq -r .data.actualAmount)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71h2' WHERE id=$RC71_O3H;"
RC71_ORN3H="refund_${RC71_O3H}_e2e71h2_$RANDOM"
RC71_ONO3H=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O3H;")
# 记录金额（100）故意小于订单实付（RC71_AMT3H），模拟「记录小于余额」的历史脏数据；
# 全额 ABNORMAL 的原意是「这笔占了订单全部余额」，记录金额本身写错不影响 D2 override 逻辑——
# override 校验只看 verifiedAmount 与锁内 remaining 的关系，不看 refund.amount 原值。
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O3H, '$RC71_ONO3H', 'order_${RC71_O3H}_e2e71h2', '$RC71_ORN3H', 100, $RC71_AMT3H, 'PROCESSING', 'WECHAT', $RC71_O3H, NOW(3), NOW(3));"
rr68_q "$RC71_ORN3H" '{"kind":"not_found"}'
rr68_sched
RC71_RID3H=$(rc71_refund_id "$RC71_ORN3H")
assert_eq "71.3 D2R11 造出 ABNORMAL（记录 100 < 实付）" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID3H;")" "ABNORMAL"
RC71_R=$(rc71_resolve "$RC71_O3H" "$RC71_RID3H" "{\"result\":\"SUCCESS\",\"verifiedAmount\":$RC71_AMT3H,\"note\":\"真等额一次退空\"}")
assert_eq "71.3 D2R11 REFUNDING 订单真等额 override → code 0" "$(code "$RC71_R")" "0"
assert_eq "71.3 D2R11 订单 REFUNDED" "$(order_status $RC71_O3H)" "REFUNDED"
assert_eq "71.3 D2R11 refunded_amount=A" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O3H;")" "$RC71_AMT3H"

echo "-- 71.4 P4「退款待处理」口径 --"
echo "-- 71.4 部分退款 ABNORMAL（订单 PAID）进页签 --"
RC71_O4=$(rc71_mk); [[ -n "$RC71_O4" ]] && ok "71.4 造单 #$RC71_O4" || fail "71.4 造单失败"
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
RC71_O4B=$(rc71_mk); [[ -n "$RC71_O4B" ]] && ok "71.4 造单 #$RC71_O4B" || fail "71.4 造单失败"
RC71_ONO4B=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O4B;")
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71 keyword' WHERE id=$RC71_O4B;"
RC71_LIST4B=$(req GET "/api/admin/orders?status=REFUND_ATTENTION&keyword=$RC71_ONO4B" "$AT")
assert_eq "71.4 keyword+REFUND_ATTENTION 命中恰好该单" "$(jq -r '.data.total' <<<"$RC71_LIST4B")" "1"
# 中文关键字必须走 --data-urlencode（同 e2e.sh §14 的既有用法）：unencoded 的 UTF-8 字节直接
# 拼进请求行，Node 的 HTTP 解析器会以 400 Bad Request（空响应体）拒绝，而不是走到路由逻辑，
# 之前直接拼字符串导致 jq 在空响应上取值得到空字符串，误判成「未按预期返回」。
RC71_LIST4C=$(curl -s -G "$BASE/api/admin/orders" --data-urlencode "status=REFUND_ATTENTION" --data-urlencode "keyword=不存在的号e2e71xyz" -H "Authorization: Bearer $AT")
assert_eq "71.4 keyword 不匹配 → 空" "$(jq -r '.data.total' <<<"$RC71_LIST4C")" "0"
# R1（复核）：上面两条断言本身无证伪力——把 orders.ts 的 AND 数组改回顶层展开，
# 「keyword 命中订单号」的 OR 会整体顶替掉 attentionWhere 的 OR，两条断言可能仍然碰巧为绿
# （前一条因为该单本来就在页签里，后一条因为关键字真的不匹配任何单）。补一张
# 「keyword 精确命中、但订单根本不在 REFUND_ATTENTION 里」的单：若 AND 被顶替回 OR，
# 这里会错误地把它也列进来（total≥1）；AND 语义下必须是 0。
RC71_O4H=$(rc71_mk); [[ -n "$RC71_O4H" ]] && ok "71.4 R1 造普通单（不退款）#$RC71_O4H" || fail "71.4 R1 造单失败"
RC71_ONO4H=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O4H;")
RC71_LIST4R1=$(req GET "/api/admin/orders?status=REFUND_ATTENTION&keyword=$RC71_ONO4H" "$AT")
assert_eq "71.4 R1：keyword 精确命中但订单不在页签里（PAID）→ total=0（证伪 AND 被 OR 顶替的回归）" "$(jq -r '.data.total' <<<"$RC71_LIST4R1")" "0"

echo "-- 71.4 售后 APPROVED 卡住（同步失败/异步 CLOSED）进页签，重新退款收口 --"
RC71_O4D=$(rc71_mk); [[ -n "$RC71_O4D" ]] && ok "71.4 造发货单 #$RC71_O4D" || fail "71.4 造单失败"
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

echo "-- 71.4 D3（复核 R2）：订单页直接退款（不带 afterSaleId）也能把 APPROVED 售后收口成 DONE --"
RC71_O4G=$(rc71_mk); [[ -n "$RC71_O4G" ]] && ok "71.4 D3 造发货单 #$RC71_O4G" || fail "71.4 D3 造单失败"
req POST "/api/admin/orders/$RC71_O4G/ship" "$AT" '{"expressCompany":"其他：e2e71d3","expressNo":"E2E71D3"}' >/dev/null
RC71_ASR2=$(req POST "/api/orders/$RC71_O4G/after-sale" "$UT" "{\"reason\":\"SHORTAGE\",\"description\":\"e2e71 D3\",\"images\":[\"$URL\"]}")
RC71_AS4G=$(jq -r '.data.id // empty' <<<"$RC71_ASR2"); [[ -n "$RC71_AS4G" ]] && ok "71.4 D3 售后单 #$RC71_AS4G" || fail "71.4 D3 创建售后单" "$RC71_ASR2"
rc71_create "$RC71_O4G" '{"kind":"ok","status":"PROCESSING"}'
RC71_R=$(req POST "/api/admin/after-sales/$RC71_AS4G/approve" "$AT" '{"amount":100,"reply":"71.4 D3"}')
assert_eq "71.4 D3 同意售后 code 0" "$(code "$RC71_R")" "0"
RC71_RN4G1=$(jq -r .data.refund.outRefundNo <<<"$RC71_R")
rr68_q "$RC71_RN4G1" '{"kind":"ok","status":"CLOSED"}'
rr68_sched
RC71_AS4G_MID=$(req GET "/api/admin/after-sales?status=APPROVED" "$AT" | jq --argjson id "$RC71_AS4G" '.data.list[] | select(.id==$id)')
assert_eq "71.4 D3 前置：售后仍 APPROVED（同步失败/异步 CLOSED 都不会自己变 DONE）" "$(jq -r .status <<<"$RC71_AS4G_MID")" "APPROVED"
RC71_AMT4G=$(req GET "/api/admin/orders/$RC71_O4G" "$AT" | jq -r .data.remainingRefundable)
# 关键：不经售后面板，直接从订单页发起退款（initiateRefund 不带 afterSaleId）——
# 这是 D3 else 分支（refund.ts finalizeRefundSuccess）唯一能被触发到的路径；此前只测过
# 「带 afterSaleId 的重新退款」（if 分支），else 分支删掉整段也不会让任何断言变红。
RC71_R=$(req POST "/api/admin/orders/$RC71_O4G/refund" "$AT" "{\"amount\":$RC71_AMT4G,\"reason\":\"71.4 D3 订单页直接退\"}")
assert_eq "71.4 D3 订单页退款 code 0" "$(code "$RC71_R")" "0"
RC71_NEWRID4G=$(jq -r .data.refund.id <<<"$RC71_R")
RC71_AS4G_AFTER=$(req GET "/api/admin/after-sales?status=DONE" "$AT" | jq --argjson id "$RC71_AS4G" '.data.list[] | select(.id==$id)')
assert_eq "71.4 D3 售后单变 DONE（不带 afterSaleId 的订单页退款也能收口）" "$(jq -r .status <<<"$RC71_AS4G_AFTER")" "DONE"
assert_eq "71.4 D3 售后单 refundId=新退款 id（不是最初经审批那笔）" "$(jq -r .refundId <<<"$RC71_AS4G_AFTER")" "$RC71_NEWRID4G"

echo "-- 71.4 D4（复核 R2）：查询 CLOSED 但金额不符 → 直接释放，不再卡人 --"
RC71_O4F=$(rc71_mk); [[ -n "$RC71_O4F" ]] && ok "71.4 D4 造单 #$RC71_O4F" || fail "71.4 D4 造单失败"
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71 d4' WHERE id=$RC71_O4F;"
RC71_AMT4F=$(sql "SELECT actual_amount FROM orders WHERE id=$RC71_O4F;")
RC71_ORN4F="refund_${RC71_O4F}_e2e71i_$RANDOM"
RC71_ONO4F=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O4F;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O4F, '$RC71_ONO4F', 'order_${RC71_O4F}_e2e71i', '$RC71_ORN4F', $RC71_AMT4F, $RC71_AMT4F, 'PROCESSING', 'WECHAT', $RC71_O4F, NOW(3), NOW(3));"
rr68_q "$RC71_ORN4F" "{\"kind\":\"ok\",\"status\":\"CLOSED\",\"amount\":999999999}"
rr68_sched
RC71_RID4F=$(rc71_refund_id "$RC71_ORN4F")
assert_eq "71.4 D4 CLOSED+金额不符 → 直接 CLOSED（不是 ABNORMAL）" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID4F;")" "CLOSED"
assert_eq "71.4 D4 active_order_id 释放" "$(sql "SELECT active_order_id IS NULL FROM refunds WHERE id=$RC71_RID4F;")" "1"
RC71_ERR4F=$(sql "SELECT reconcile_last_error FROM refunds WHERE id=$RC71_RID4F;")
[[ "$RC71_ERR4F" == *"金额"* ]] && ok "71.4 D4 reconcile_last_error 含「金额」" || fail "71.4 D4 reconcile_last_error" "$RC71_ERR4F"
assert_eq "71.4 D4 refunded_amount=0（CLOSED 无资金变动）" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O4F;")" "0"
RC71_R=$(req POST "/api/admin/orders/$RC71_O4F/refund" "$AT" "{\"amount\":$RC71_AMT4F}")
assert_eq "71.4 D4 释放后可重新发起 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.4 D4 订单 REFUNDED" "$(order_status $RC71_O4F)" "REFUNDED"

echo "-- 71.4 既有口径保持：无售后单的部分退款 CLOSED 不进 --"
RC71_O4E=$(rc71_mk); [[ -n "$RC71_O4E" ]] && ok "71.4 造单 #$RC71_O4E" || fail "71.4 造单失败"
# R3：不用 SQL 把一笔正常成功的退款硬改成 CLOSED——改用 createRefund 指令让它经真实流程终结在 CLOSED。
rc71_create "$RC71_O4E" '{"kind":"ok","status":"CLOSED"}'
RC71_R=$(req POST "/api/admin/orders/$RC71_O4E/refund" "$AT" '{"amount":100,"reason":"71.4e"}')
assert_eq "71.4e 部分退款 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.4e 退款行经真实流程终结为 CLOSED（非 SQL）" "$(jq -r .data.refund.status <<<"$RC71_R")" "CLOSED"
assert_eq "71.4e 无售后单的部分退款 CLOSED 不进页签" "$(rc71_attn $RC71_O4E)" "0"

echo "-- 71.5 余额收口后的顺序再退（事务外检查）--"
echo "-- 71.5(a) 部分 ABNORMAL 核实成功后，余额已减，原「全额」金额再退 → 42206 --"
RC71_O5A=$(rc71_mk); [[ -n "$RC71_O5A" ]] && ok "71.5a 造单 #$RC71_O5A" || fail "71.5a 造单失败"
RC71_AMT5A=$(req GET "/api/admin/orders/$RC71_O5A" "$AT" | jq -r .data.actualAmount)
RC71_ORN5A="refund_${RC71_O5A}_e2e71j_$RANDOM"
RC71_ONO5A=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O5A;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O5A, '$RC71_ONO5A', 'order_${RC71_O5A}_e2e71j', '$RC71_ORN5A', 100, $RC71_AMT5A, 'PROCESSING', 'WECHAT', $RC71_O5A, NOW(3), NOW(3));"
rr68_q "$RC71_ORN5A" '{"kind":"not_found"}'
rr68_sched
RC71_RID5A=$(rc71_refund_id "$RC71_ORN5A")
assert_eq "71.5a 造出部分 ABNORMAL（记录 100，订单 PAID）" "$(sql "SELECT status FROM refunds WHERE id=$RC71_RID5A;")" "ABNORMAL"
RC71_R=$(rc71_resolve "$RC71_O5A" "$RC71_RID5A" '{"result":"SUCCESS","verifiedAmount":100,"note":"部分核实成功"}')
assert_eq "71.5a 核实 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.5a 订单仍 PAID" "$(order_status $RC71_O5A)" "PAID"
# 事务外检查命中点：这里仍拿「核实前」算出的全额 A 去发起，而不是核实后的剩余 A-100——
# initiateRefund 顶部的事务外快照读会看到已经核实成功之后的 remaining=A-100，与传入的
# amount(A) 比对发现超额，拒绝，不建新行（不涉及事务 A 首句的锁内重验，那部分由 selftest
# 「用例 R9-1」用真锁等待单独验证）。
RC71_R=$(req POST "/api/admin/orders/$RC71_O5A/refund" "$AT" "{\"amount\":$RC71_AMT5A}")
assert_eq "71.5a 用核实前的全额再退 → 42206（事务外检查）" "$(code "$RC71_R")" "42206"
RC71_ROWS5A=$(sql "SELECT COUNT(*) FROM refunds WHERE order_id=$RC71_O5A;")
assert_eq "71.5a 未建出第二笔退款行" "$RC71_ROWS5A" "1"
RC71_R=$(req POST "/api/admin/orders/$RC71_O5A/refund" "$AT" "{\"amount\":$((RC71_AMT5A-100))}")
assert_eq "71.5a 用正确的剩余金额再退 → code 0" "$(code "$RC71_R")" "0"
assert_eq "71.5a 订单 REFUNDED" "$(order_status $RC71_O5A)" "REFUNDED"

echo "-- 71.5(b) REFUNDING 单 D1 转 CLOSED，回调晚到 SUCCESS 落账 REFUNDED 后，原金额再退 → 42206 --"
RC71_O5B=$(rc71_mk); [[ -n "$RC71_O5B" ]] && ok "71.5b 造单 #$RC71_O5B" || fail "71.5b 造单失败"
RC71_AMT5B=$(req GET "/api/admin/orders/$RC71_O5B" "$AT" | jq -r .data.actualAmount)
sql "UPDATE orders SET status='REFUNDING', cancelled_at=NOW(3), cancel_reason='e2e71j2' WHERE id=$RC71_O5B;"
RC71_ORN5B="refund_${RC71_O5B}_e2e71j2_$RANDOM"
RC71_ONO5B=$(sql "SELECT order_no FROM orders WHERE id=$RC71_O5B;")
sql "INSERT INTO refunds (order_id, order_no, out_trade_no, out_refund_no, amount, total_amount, status, mode, active_order_id, created_at, updated_at)
     VALUES ($RC71_O5B, '$RC71_ONO5B', 'order_${RC71_O5B}_e2e71j2', '$RC71_ORN5B', $RC71_AMT5B, $RC71_AMT5B, 'PROCESSING', 'WECHAT', $RC71_O5B, NOW(3), NOW(3));"
rr68_q "$RC71_ORN5B" '{"kind":"not_found"}'
rr68_sched
RC71_RID5B=$(rc71_refund_id "$RC71_ORN5B")
RC71_R=$(rc71_resolve "$RC71_O5B" "$RC71_RID5B" "{\"result\":\"CLOSED\",\"verifiedAmount\":$RC71_AMT5B,\"note\":\"商户平台查无，未退\"}")
assert_eq "71.5b D1 释放 code 0" "$(code "$RC71_R")" "0"
assert_eq "71.5b 订单仍 REFUNDING" "$(order_status $RC71_O5B)" "REFUNDING"
RC71_R=$(req POST /api/admin/system/pay-mock/refund-notify "$AT" "{\"outRefundNo\":\"$RC71_ORN5B\",\"status\":\"SUCCESS\"}")
assert_eq "71.5b 回调晚到落账 ack code 0" "$(code "$RC71_R")" "0"
assert_eq "71.5b 原行翻 SUCCESS，订单 REFUNDED" "$(order_status $RC71_O5B)" "REFUNDED"
RC71_R=$(req POST "/api/admin/orders/$RC71_O5B/refund" "$AT" "{\"amount\":$RC71_AMT5B}")
assert_eq "71.5b 已全额落账后再退同样金额 → 42206" "$(code "$RC71_R")" "42206"

echo "-- 71.5(c) R9：另一连接持锁期间发起 → 锁内重验 42204（真锁等待，不是猜时序）--"
RC71_O5C=$(rc71_mk); [[ -n "$RC71_O5C" ]] && ok "71.5c 造单 #$RC71_O5C" || fail "71.5c 造单失败"
RC71_AMT5C=$(req GET "/api/admin/orders/$RC71_O5C" "$AT" | jq -r .data.actualAmount)
# 后台持锁事务 T：START TRANSACTION + SELECT...FOR UPDATE 拿排他锁，SLEEP(2.5) 持锁
# （< Prisma 交互事务默认 timeout 5s），随后把 refunded_amount 改满再提交。
# 不能用 e2e.sh 的 sql()：那是每次调用独立开一个会话，锁不会跨调用持有。
docker exec food-shop-mysql mysql -ufoodshop_user -pfoodshop_password "$DB_NAME" -N \
  -e "START TRANSACTION; SELECT id FROM orders WHERE id=$RC71_O5C FOR UPDATE; \
      SELECT SLEEP(2.5); UPDATE orders SET refunded_amount=$RC71_AMT5C WHERE id=$RC71_O5C; COMMIT;" \
  >/dev/null 2>&1 &
RC71_TPID5C=$!

# 轮询确认 T 已经真的持有排他锁（不是假设，是查 performance_schema）
RC71_LOCKED5C=0
for _i in $(seq 1 15); do
  RC71_N=$(sql "SELECT COUNT(*) FROM performance_schema.data_locks WHERE OBJECT_NAME='orders' AND LOCK_TYPE='RECORD' AND LOCK_MODE LIKE 'X%' AND LOCK_DATA='$RC71_O5C';")
  if [[ "$RC71_N" -ge 1 ]]; then RC71_LOCKED5C=1; break; fi
  sleep 0.1
done
if [[ "$RC71_LOCKED5C" != "1" ]]; then
  fail "71.5c 前置：T 未在 1.5s 内持锁（时序未成立，非被测逻辑）"
  wait "$RC71_TPID5C" 2>/dev/null
else
  ok "71.5c T 已持排他锁"
  RC71_TMP5C=$(mktemp)
  ( req POST "/api/admin/orders/$RC71_O5C/refund" "$AT" '{"amount":100,"reason":"71.5c"}' > "$RC71_TMP5C" ) &
  RC71_RPID5C=$!

  RC71_WAITING5C=0
  for _i in $(seq 1 15); do
    RC71_N=$(sql "SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks r ON r.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE r.OBJECT_NAME='orders' AND r.LOCK_DATA='$RC71_O5C';")
    if [[ "$RC71_N" -ge 1 ]]; then RC71_WAITING5C=1; break; fi
    sleep 0.1
  done
  if [[ "$RC71_WAITING5C" != "1" ]]; then
    fail "71.5c 前置：1.5s 内未观察到锁等待（时序未成立，非被测逻辑）"
  else
    ok "71.5c 观察到锁等待（事务外检查已通过、事务 A 阻塞在 orders 行）"
  fi

  wait "$RC71_RPID5C" 2>/dev/null
  wait "$RC71_TPID5C" 2>/dev/null
  RC71_R=$(cat "$RC71_TMP5C")
  assert_eq "71.5c 锁内重验命中 → 42204" "$(code "$RC71_R")" "42204"
  assert_eq "71.5c 未建出退款行" "$(sql "SELECT COUNT(*) FROM refunds WHERE order_id=$RC71_O5C;")" "0"
  assert_eq "71.5c 订单仍 PAID" "$(order_status $RC71_O5C)" "PAID"
  assert_eq "71.5c refunded_amount 为 T 写入值" "$(sql "SELECT refunded_amount FROM orders WHERE id=$RC71_O5C;")" "$RC71_AMT5C"
  rm -f "$RC71_TMP5C"
fi

echo "-- 71 分片收尾：本分片名下订单不留任何在途退款行，全部经真实流程收口（R3：不许 SQL 兜底改状态）--"
RC71_ORDER_LIST=$(tr '\n' ',' < "$RC71_ORDERS_FILE" | sed 's/,$//')
if [[ -n "$RC71_ORDER_LIST" ]]; then
  RC71_STUCK=$(sql "SELECT COUNT(*) FROM refunds WHERE order_id IN ($RC71_ORDER_LIST) AND status IN ('PENDING','PROCESSING','ABNORMAL');")
else
  RC71_STUCK="?"
fi
assert_eq "71 收尾：不留任何在途（PENDING/PROCESSING/ABNORMAL）退款行" "$RC71_STUCK" "0"
rm -f "$RC71_ORDERS_FILE"
req POST /api/admin/system/pay-mock/reset "$AT" >/dev/null
assert_eq "71 收尾：createRefund 调用计数已清零" "$(rc71_calls createRefund)" "0"
assert_eq "71 收尾：queryRefund 调用计数已清零" "$(rc71_calls queryRefund)" "0"
