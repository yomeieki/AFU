echo "== 77. 回调先于下单结果到达（P1/P2）+ 取消意图与幽灵活单自动撤销（P15-P20）（2026-09-24） =="
# 复用 e2e.sh 主体定义的 req/code/ok/fail/assert_eq/mk_local_paid/kd_cb/md5hex/KDCB_BODY/sched/
# sql（本文件在 e2e.sh 尾部被 source 进来，同一个 shell）。变量一律 S77_ 前缀。
#
# 本段测的是「回调先于下单同步响应到达」这个生产实测过的竞态（D33-1：taskId/orderId/calledAt/
# quotedFee/distance/orderFees 全空，无 API 事件，此前直接告警丢弃整个下单结果），以及店主 D2
# 决定的取消意图流程（店员没有快递100 企业账号，缺单号的配送单不能伪造本地取消，只能记意图
# 等单号到了自动执行真取消；5 分钟无回应自动结束；已结束的单收到在途回调要自动撤销）。
#
# 自定义回调 helper（kd_cb 不支持 param.orderId/cancelReason，不改主体 kd_cb，另写一份）。
S77_TS=$(date +%s)
s77_cb() { # deliveryNo taskId status desc updateTime orderId [cancelReason] [courierName] [courierMobile] [kuaidicom] → echo HTTP 状态码，响应体在 $KDCB_BODY
  local dno="$1" task="$2" st="$3" desc="$4" ut="$5" oid="${6:-}" creason="${7:-}" cn="${8:-王骑手}" cm="${9:-13900001111}" kc="${10:-shansongtongcheng}"
  local salt param sign
  salt=$(req GET "/api/admin/system/kd100-mock/salt/$dno" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg t "$task" --arg s "$st" --arg d "$desc" --arg u "$ut" --arg oid "$oid" --arg cr "$creason" --arg cn "$cn" --arg cm "$cm" --arg kc "$kc" \
    '{taskId:$t,status:$s,statusDesc:$d,updateTime:$u,orderId:(if $oid=="" then null else $oid end),cancelReason:(if $cr=="" then null else $cr end),courierName:$cn,courierMobile:$cm,kuaidicom:$kc}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$KDCB_BODY" -w '%{http_code}' -X POST "$BASE/api/kd/$dno" \
    --data-urlencode "param=$param" --data-urlencode "sign=$sign" --data-urlencode "taskId=$task"
}
s77_dlv() { req GET "/api/admin/local/orders/$1/delivery" "$AT"; }
s77_calls_count() { req GET /api/admin/system/kd100-mock/calls "$AT" | jq "[.data[] | select(.op==\"$1\")] | length"; }
s77_alerts() { req GET /api/admin/system/kd100-mock/alerts "$AT"; }
s77_alerts_reset() { req POST /api/admin/system/kd100-mock/alerts/reset "$AT" >/dev/null; }
s77_has_alert_key() { s77_alerts | jq -e --arg k "$1" '[.data[] | select((.key|startswith($k)) and (.suppressed|not))] | length > 0' >/dev/null; }
s77_alert_title_for_key() { s77_alerts | jq -r --arg k "$1" '[.data[] | select(.key|startswith($k))] | last | .title // empty'; }
s77_events_source() { s77_dlv "$1" | jq -c "[.data.events[] | select(.source==\"$2\")]"; }

S77_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
s77_alerts_reset

echo "-- ① 回调先于成功落库：CALLING→回调 0/100→落库时行已 ACCEPTED，结果按列回填不丢弃 --"
S77_T1="T77-$S77_TS-1"; S77_O1="O77-$S77_TS-1"
req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"createOrder\",\"directive\":{\"kind\":\"ok\",\"holdMs\":2500,\"taskId\":\"$S77_T1\",\"providerOrderId\":\"$S77_O1\",\"quotedFeeFen\":1372,\"distanceM\":7622}}" >/dev/null
S77_OID1=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID1/accept" "$AT" >/dev/null
S77_DNO1="D${S77_OID1}-1"
S77_OUT1=$(mktemp)
( req POST "/api/admin/local/orders/$S77_OID1/call" "$AT" > "$S77_OUT1" ) &
S77_PID1=$!
sleep 0.5
s77_cb "$S77_DNO1" "$S77_T1" 0 "已呼叫待抢单" "2026-09-24 10:00:00" "$S77_O1" >/dev/null
s77_cb "$S77_DNO1" "$S77_T1" 100 "骑手已接单" "2026-09-24 10:00:05" "$S77_O1" >/dev/null
wait "$S77_PID1"
S77_CALL_R1=$(cat "$S77_OUT1")
assert_eq "①/call 响应 status=ACCEPTED" "$(jq -r .data.status <<<"$S77_CALL_R1")" "ACCEPTED"
R=$(s77_dlv "$S77_OID1")
assert_eq "①providerTaskId 非空" "$(jq -r '.data.delivery.providerTaskId != null' <<<"$R")" "true"
assert_eq "①providerOrderId 非空" "$(jq -r '.data.delivery.providerOrderId != null' <<<"$R")" "true"
assert_eq "①calledAt 非空" "$(jq -r '.data.delivery.calledAt != null' <<<"$R")" "true"
assert_eq "①orderFees 非空" "$(jq -r '.data.delivery.orderFees != null and (.data.delivery.orderFees|length>0)' <<<"$R")" "true"
assert_eq "①quotedFee=1372" "$(jq -r '.data.delivery.quotedFee' <<<"$R")" "1372"
assert_eq "①providerDistanceM=7622" "$(jq -r '.data.delivery.providerDistanceM' <<<"$R")" "7622"
assert_eq "①acceptedAt 非空" "$(jq -r '.data.delivery.acceptedAt != null' <<<"$R")" "true"
assert_eq "①有 API 来源事件" "$(jq -r '[.data.events[] | select(.source=="API")] | length > 0' <<<"$R")" "true"
s77_has_alert_key "kd100-landing-race:$S77_OID1" && fail "①不该有'结果被丢弃'告警" "命中了 kd100-landing-race:$S77_OID1" || ok "①无'结果被丢弃'告警"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"queryCourier","directive":{"kind":"ok","courier":{"latE6":29339500,"lngE6":104778500}}}' >/dev/null
R=$(req GET "/api/admin/local/orders/$S77_OID1/courier" "$AT")
assert_eq "①骑手位置非空" "$(jq -r '.data.location != null' <<<"$R")" "true"
assert_eq "①phase=TO_STORE" "$(jq -r .data.phase <<<"$R")" "TO_STORE"
assert_eq "①queryCourier 传了真实 orderId" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="queryCourier")] | last | .input.orderId')" "$S77_O1"

echo "-- ①b 只回调 0 先到，行仍 CALLING，calledAt 已补录，超时提醒能命中 --"
S77_T1B="T77-$S77_TS-1b"; S77_O1B="O77-$S77_TS-1b"
req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"createOrder\",\"directive\":{\"kind\":\"ok\",\"holdMs\":2500,\"taskId\":\"$S77_T1B\",\"providerOrderId\":\"$S77_O1B\"}}" >/dev/null
S77_OID1B=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID1B/accept" "$AT" >/dev/null
S77_DNO1B="D${S77_OID1B}-1"
S77_OUT1B=$(mktemp)
( req POST "/api/admin/local/orders/$S77_OID1B/call" "$AT" > "$S77_OUT1B" ) &
S77_PID1B=$!
sleep 0.5
s77_cb "$S77_DNO1B" "$S77_T1B" 0 "已呼叫待抢单" "2026-09-24 10:01:00" "$S77_O1B" >/dev/null
wait "$S77_PID1B"
S77_CALL_R1B=$(cat "$S77_OUT1B")
assert_eq "①b /call 响应 status=CALLING" "$(jq -r .data.status <<<"$S77_CALL_R1B")" "CALLING"
sleep 0.7   # calledAt 刚补录，callTimeoutMin=0.01（600ms）阈值要等它真的"老"过阈值才会命中
sched "{\"callTimeoutMin\":0.01}" >/dev/null
R=$(s77_dlv "$S77_OID1B")
assert_eq "①b call_timeout_reminded_at 非空（calledAt 已补录，提醒任务能命中）" "$(jq -r '.data.delivery.callTimeoutRemindedAt != null' <<<"$R")" "true"

echo "-- ② 下单超时但回调先到：行不再被覆盖成 UNKNOWN，按回调状态继续 --"
S77_T2="T77-$S77_TS-2"; S77_O2="O77-$S77_TS-2"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout","holdMs":2500}}' >/dev/null
S77_OID2=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID2/accept" "$AT" >/dev/null
S77_DNO2="D${S77_OID2}-1"
S77_OUT2=$(mktemp)
( req POST "/api/admin/local/orders/$S77_OID2/call" "$AT" > "$S77_OUT2" ) &
S77_PID2=$!
sleep 0.5
s77_cb "$S77_DNO2" "$S77_T2" 0 "已呼叫待抢单" "2026-09-24 10:02:00" "$S77_O2" >/dev/null
wait "$S77_PID2"
S77_CALL_R2=$(cat "$S77_OUT2")
assert_eq "②/call 响应 status=CALLING（非 UNKNOWN）" "$(jq -r .data.status <<<"$S77_CALL_R2")" "CALLING"
R=$(s77_dlv "$S77_OID2")
assert_eq "②providerTaskId=回调值" "$(jq -r '.data.delivery.providerTaskId' <<<"$R")" "$S77_T2"
assert_eq "②providerOrderId=回调值" "$(jq -r '.data.delivery.providerOrderId' <<<"$R")" "$S77_O2"
assert_eq "②calledAt 非空" "$(jq -r '.data.delivery.calledAt != null' <<<"$R")" "true"
assert_eq "②存在含'超时'的 API 事件" "$(jq -r '[.data.events[] | select(.source=="API" and (.statusDesc|contains("超时")))] | length > 0' <<<"$R")" "true"
s77_has_alert_key "kd100-landing-race-timeout:$S77_OID2" && fail "②不该有'结果被丢弃'告警" "" || ok "②无'结果被丢弃'告警"
s77_has_alert_key "kd100-timeout:$S77_OID2" && fail "②不该有'下单响应超时'告警" "" || ok "②无'下单响应超时'告警"

echo "-- ③ 回调认领非 UNKNOWN 行的 taskId/orderId，720 cancelReason 优先取 param.cancelReason --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID3=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID3/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID3/call" "$AT")
S77_DNO3=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO3'"
S77_T3="T77-$S77_TS-3"; S77_O3="O77-$S77_TS-3"
s77_cb "$S77_DNO3" "$S77_T3" 100 "骑手已接单" "2026-09-24 10:03:00" "$S77_O3" >/dev/null
R=$(s77_dlv "$S77_OID3")
assert_eq "③回填 providerTaskId" "$(jq -r '.data.delivery.providerTaskId' <<<"$R")" "$S77_T3"
assert_eq "③回填 providerOrderId" "$(jq -r '.data.delivery.providerOrderId' <<<"$R")" "$S77_O3"
assert_eq "③status=ACCEPTED" "$(jq -r .data.delivery.status <<<"$R")" "ACCEPTED"
s77_cb "$S77_DNO3" "$S77_T3" 720 "骑手取消订单" "2026-09-24 10:03:30" "$S77_O3" "骑手原因取消" >/dev/null
R=$(s77_dlv "$S77_OID3")
assert_eq "③720 后 status=CANCELLED" "$(jq -r .data.delivery.status <<<"$R")" "CANCELLED"
assert_eq "③cancelReason 取自 param.cancelReason" "$(jq -r .data.delivery.cancelReason <<<"$R")" "骑手原因取消"

echo "-- ④ precancel/tip/cancel 三接口都传 orderId --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID4=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID4/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID4/call" "$AT")
S77_DNO4=$(jq -r .data.deliveryNo <<<"$R")
R=$(s77_dlv "$S77_OID4")
S77_TASK4=$(jq -r .data.delivery.providerTaskId <<<"$R"); S77_ORD4=$(jq -r .data.delivery.providerOrderId <<<"$R")
req POST "/api/admin/local/orders/$S77_OID4/delivery/precancel" "$AT" >/dev/null
assert_eq "④precancel 传了 taskId+orderId" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -c '[.data[] | select(.op=="precancelOrder")] | last | {t:.input.taskId,o:.input.orderId}')" \
  "$(jq -cn --arg t "$S77_TASK4" --arg o "$S77_ORD4" '{t:$t,o:$o}')"
req POST "/api/admin/local/orders/$S77_OID4/delivery/tip" "$AT" '{"amount":150}' >/dev/null
assert_eq "④addTip 传了 taskId+orderId" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -c '[.data[] | select(.op=="addTip")] | last | {t:.input.taskId,o:.input.orderId}')" \
  "$(jq -cn --arg t "$S77_TASK4" --arg o "$S77_ORD4" '{t:$t,o:$o}')"
req POST "/api/admin/local/orders/$S77_OID4/delivery/cancel" "$AT" '{"reason":"测试取消"}' >/dev/null
assert_eq "④cancel 传了 taskId+orderId" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -c '[.data[] | select(.op=="cancelOrder")] | last | {t:.input.taskId,o:.input.orderId}')" \
  "$(jq -cn --arg t "$S77_TASK4" --arg o "$S77_ORD4" '{t:$t,o:$o}')"

echo "-- ⑤ 取消意图：缺单号点取消只记意图不伪造本地取消；单号经回调到达后自动取消并记账 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID5=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID5/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID5/call" "$AT")
S77_DNO5=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO5'"
S77_PC_BEFORE=$(s77_calls_count precancelOrder)
R=$(req POST "/api/admin/local/orders/$S77_OID5/delivery/precancel" "$AT")
assert_eq "⑤缺单号 precancel code 0" "$(code "$R")" "0"
assert_eq "⑤缺单号 precancel cancelFeeFen=null" "$(jq -r .data.cancelFeeFen <<<"$R")" "null"
assert_eq "⑤precancel 未新增外呼" "$(s77_calls_count precancelOrder)" "$S77_PC_BEFORE"
S77_CC_BEFORE=$(s77_calls_count cancelOrder)
R=$(req POST "/api/admin/local/orders/$S77_OID5/delivery/cancel" "$AT" '{"reason":"店员要求取消"}')
assert_eq "⑤缺单号 cancel code 0" "$(code "$R")" "0"
assert_eq "⑤缺单号 cancel pending=true" "$(jq -r .data.pending <<<"$R")" "true"
R=$(s77_dlv "$S77_OID5")
assert_eq "⑤行仍 CALLING（未伪造终态）" "$(jq -r .data.delivery.status <<<"$R")" "CALLING"
assert_eq "⑤active_order_id 非空（未释放）" "$(jq -r '.data.delivery.activeOrderId != null' <<<"$R")" "true"
assert_eq "⑤cancel_intent_at 非空" "$(jq -r '.data.delivery.cancelIntentAt != null' <<<"$R")" "true"
assert_eq "⑤有含'店员要求取消'的 ADMIN 事件" "$(jq -r '[.data.events[] | select(.source=="ADMIN" and (.statusDesc|contains("店员要求取消")))] | length > 0' <<<"$R")" "true"
assert_eq "⑤未新增外呼" "$(s77_calls_count cancelOrder)" "$S77_CC_BEFORE"
S77_ADM_N=$(jq -r '[.data.events[] | select(.source=="ADMIN")] | length' <<<"$R")
req POST "/api/admin/local/orders/$S77_OID5/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
R=$(s77_dlv "$S77_OID5")
assert_eq "⑤重复点取消：pending 仍 true 幂等" "$(jq -r '[.data.events[] | select(.source=="ADMIN")] | length' <<<"$R")" "$S77_ADM_N"
R=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT")
assert_eq "⑤快照卡片 cancelIntentAt 非空且仍在 waitingCourier 列" \
  "$(jq -r --argjson oid "$S77_OID5" '[.data.columns.waitingCourier[] | select(.orderId==$oid)] | length == 1 and (.[0].local.delivery.cancelIntentAt != null)' <<<"$R")" "true"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":200}}' >/dev/null
S77_T5="T77-$S77_TS-5"; S77_O5="O77-$S77_TS-5"
s77_alerts_reset
s77_cb "$S77_DNO5" "$S77_T5" 100 "骑手已接单" "2026-09-24 10:05:00" "$S77_O5" >/dev/null
sleep 2
R=$(s77_dlv "$S77_OID5")
assert_eq "⑤自动取消后 status=CANCELLED" "$(jq -r .data.delivery.status <<<"$R")" "CANCELLED"
assert_eq "⑤cancel_fee=200" "$(jq -r .data.delivery.cancelFee <<<"$R")" "200"
assert_eq "⑤active_order_id 释放" "$(jq -r '.data.delivery.activeOrderId == null' <<<"$R")" "true"
assert_eq "⑤有含'已自动向快递100 取消'的事件" "$(jq -r '[.data.events[] | select(.statusDesc|contains("已自动向快递100 取消"))] | length > 0' <<<"$R")" "true"
assert_eq "⑤mock cancelOrder 恰 1 次且 orderId=回调值" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r --arg o "$S77_O5" '[.data[] | select(.op=="cancelOrder" and .input.orderId==$o)] | length')" "1"
s77_has_alert_key "dlv-cancel-lost:" && fail "⑤不该有取消相关告警" "" || ok "⑤无新增告警"

echo "-- ⑥ 取消意图 5 分钟无回调无单号 → 自动结束，释放后可立即重呼 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID6=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID6/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID6/call" "$AT")
S77_DNO6D1=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO6D1'"
req POST "/api/admin/local/orders/$S77_OID6/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
S77_CC_BEFORE6=$(s77_calls_count cancelOrder)
R=$(sched '{"cancelIntentVoidMin":0}')
assert_eq "⑥localCancelIntent>=1" "$(jq -r '(.data.localCancelIntent // -1) >= 1' <<<"$R")" "true"
R=$(sql "SELECT CONCAT(status,'|',error_code,'|',IF(active_order_id IS NULL,'NULL','SET')) FROM deliveries WHERE delivery_no='$S77_DNO6D1'")
assert_eq "⑥自动结束后 status/error_code/active_order_id 释放" "$R" "FAILED|VOIDED|NULL"
R=$(s77_dlv "$S77_OID6")
assert_eq "⑥有含'自动结束'的 SCHEDULER 事件" "$(jq -r '[.data.events[] | select(.source=="SCHEDULER" and (.statusDesc|contains("自动结束")))] | length > 0' <<<"$R")" "true"
assert_eq "⑥自动结束未外呼 cancelOrder" "$(s77_calls_count cancelOrder)" "$S77_CC_BEFORE6"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID6/call" "$AT")
assert_eq "⑥自动结束后可立即重呼 code 0" "$(code "$R")" "0"
S77_DNO6D2=$(jq -r .data.deliveryNo <<<"$R")

echo "-- ⑦ 已结束（VOIDED）的配送单收到在途回调 → 幽灵活单自动撤销 --"
S77_T7="T77-$S77_TS-7"; S77_O7="O77-$S77_TS-7"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":200}}' >/dev/null
s77_alerts_reset
S77_CC_BEFORE7=$(s77_calls_count cancelOrder)
S77_HTTP7=$(s77_cb "$S77_DNO6D1" "$S77_T7" 100 "骑手已接单" "2026-09-24 10:07:00" "$S77_O7")
assert_eq "⑦回调 HTTP 200" "$S77_HTTP7" "200"
sleep 1
R=$(sql "SELECT CONCAT(provider_task_id,'|',IF(ghost_cancel_at IS NULL,'NULL','SET'),'|',cancel_fee) FROM deliveries WHERE delivery_no='$S77_DNO6D1'")
assert_eq "⑦D-1 provider_task_id 已认领 + ghost_cancel_at 非空 + cancel_fee=200" "$R" "$S77_T7|SET|200"
# 不用 s77_dlv（按 orderId 查最近一张，这个订单已有 D-2 在途，会拿错行）：直接按 delivery_no 查事件
R=$(sql "SELECT COUNT(*) FROM delivery_events WHERE delivery_id=(SELECT id FROM deliveries WHERE delivery_no='$S77_DNO6D1') AND source='CALLBACK' AND status_desc LIKE '%已自动向快递100 撤销%'")
assert_eq "⑦CALLBACK 事件含'已自动向快递100 撤销'" "$([[ "$R" -ge 1 ]] && echo true || echo false)" "true"
assert_eq "⑦mock cancelOrder 恰新增 1 次" "$(($(s77_calls_count cancelOrder) - S77_CC_BEFORE7))" "1"
s77_has_alert_key "kd-cb-ghost-active:" && fail "⑦不该有幽灵撤销失败告警" "" || ok "⑦无幽灵撤销失败告警"
S77_CC_BEFORE7B=$(s77_calls_count cancelOrder)
s77_cb "$S77_DNO6D1" "$S77_T7" 230 "骑手已到店" "2026-09-24 10:07:30" "$S77_O7" >/dev/null
sleep 0.5
assert_eq "⑦再发 230 抢占幂等，不再外呼" "$(s77_calls_count cancelOrder)" "$S77_CC_BEFORE7B"
R=$(sql "SELECT status FROM deliveries WHERE delivery_no='$S77_DNO6D2'")
assert_eq "⑦D-2 状态不受影响（仍 CALLING）" "$R" "CALLING"

echo "-- ⑧ 已结束（FAILED 无 id）配送单自动撤销失败 → 告警 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID8=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID8/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID8/call" "$AT")
S77_DNO8=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET status='FAILED', provider_task_id=NULL, provider_order_id=NULL, active_order_id=NULL, error_code='TEST' WHERE delivery_no='$S77_DNO8'"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"error","code":"50000"}}' >/dev/null
s77_alerts_reset
S77_T8="T77-$S77_TS-8"; S77_O8="O77-$S77_TS-8"
s77_cb "$S77_DNO8" "$S77_T8" 100 "骑手已接单" "2026-09-24 10:08:00" "$S77_O8" >/dev/null
sleep 1
s77_has_alert_key "kd-cb-ghost-active:" && ok "⑧命中幽灵撤销失败告警 key" || fail "⑧未命中告警" "$(s77_alerts)"
assert_eq "⑧告警标题含'自动撤销失败'" "$(s77_alert_title_for_key "kd-cb-ghost-active:")" "已结束的配送单仍有在途回调，自动撤销失败"
R=$(sql "SELECT ghost_cancel_at IS NOT NULL FROM deliveries WHERE delivery_no='$S77_DNO8'")
assert_eq "⑧ghost_cancel_at 非空" "$R" "1"

echo "-- ⑨ 有单号但连续取消失败 → 第 5 次告警，第 6 次不再重试也不重复告警 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID9=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID9/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID9/call" "$AT")
S77_DNO9=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO9'"
req POST "/api/admin/local/orders/$S77_OID9/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
S77_T9="T77-$S77_TS-9"; S77_O9="O77-$S77_TS-9"
sql "UPDATE deliveries SET provider_task_id='$S77_T9', provider_order_id='$S77_O9' WHERE delivery_no='$S77_DNO9'"
for i in 1 2 3 4 5; do req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"error","code":"50000"}}' >/dev/null; done
S77_ALL_OK=1
for i in 1 2 3 4; do
  s77_alerts_reset
  sched '{"cancelIntentVoidMin":0}' >/dev/null
  s77_has_alert_key "dlv-cancel-intent-failed:" && { fail "⑨第 $i 次不该有人工介入告警" ""; S77_ALL_OK=0; }
  R=$(sql "SELECT CONCAT(cancel_intent_attempts,'|',IF(cancel_intent_last_error IS NULL,'NULL','SET')) FROM deliveries WHERE delivery_no='$S77_DNO9'")
  assert_eq "⑨第 $i 次 cancel_intent_attempts=$i 且 last_error 非空" "$R" "$i|SET"
done
[[ "$S77_ALL_OK" == "1" ]] && ok "⑨前 4 次均无人工介入告警"
s77_alerts_reset
sched '{"cancelIntentVoidMin":0}' >/dev/null
s77_has_alert_key "dlv-cancel-intent-failed:" && ok "⑨第 5 次命中人工介入告警" || fail "⑨第 5 次未命中告警" "$(s77_alerts)"
assert_eq "⑨告警标题含'自动取消失败，需人工处理'" "$(s77_alert_title_for_key "dlv-cancel-intent-failed:")" "配送单自动取消失败，需人工处理"
S77_CC_BEFORE9=$(s77_calls_count cancelOrder)
s77_alerts_reset
sched '{"cancelIntentVoidMin":0}' >/dev/null
assert_eq "⑨第 6 次不再外呼" "$(s77_calls_count cancelOrder)" "$S77_CC_BEFORE9"
s77_has_alert_key "dlv-cancel-intent-failed:" && fail "⑨第 6 次不该重复告警" "" || ok "⑨第 6 次不重复告警"
R=$(s77_dlv "$S77_OID9")
assert_eq "⑨行仍 CALLING（不伪终态）" "$(jq -r .data.delivery.status <<<"$R")" "CALLING"
assert_eq "⑨active_order_id 非空" "$(jq -r '.data.delivery.activeOrderId != null' <<<"$R")" "true"

echo "-- ⑩ 自动升级 precancel 失败要告警留痕；provider_order_id 缺失/意图单都不进候选（复核 R6：改成能区分做对/做错的写法，保留反例） --"
# 前面 ①b/②/⑥ 各留了一张仍在 CALLING 的配送单（②/⑥ 都是本来就该继续存在的正常状态，
# 不是 bug）——升级扫描不分青红皂白会把它们也扫进来，把这里的精确计数断言带偏。
# 沿用 shard 50 的隔离手法：把它们的 call_strategy 挪出 SOLO/MANUAL 候选范围。
s77_only() { sql "UPDATE deliveries SET call_strategy='ALL' WHERE status='CALLING' AND delivery_no <> '$1'"; }
s77_alert_count_for_key() { s77_alerts | jq --arg k "$1" '[.data[] | select((.key|startswith($k)) and (.suppressed|not))] | length'; }
s77_event_count_like() { sql "SELECT COUNT(*) FROM delivery_events WHERE delivery_id=(SELECT id FROM deliveries WHERE delivery_no='$1') AND status_desc LIKE '$2'"; }
req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.callStrategy = {"mode":"SOLO_LOWEST","escalateAfterMin":3}' <<<"$S77_ORIG")" >/dev/null

echo "   -- ⑩a precancel 失败：告警/事件记录数 0→1；反例（换成成功指令再跑一轮）记录数仍为 1，证明断言不是恒真 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID10=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID10/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID10/call" "$AT")
S77_DNO10=$(jq -r .data.deliveryNo <<<"$R")
s77_only "$S77_DNO10"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"error","code":"30001"}}' >/dev/null
s77_alerts_reset
assert_eq "⑩a 告警记录数初始为 0" "$(s77_alert_count_for_key "dlv-escalate-precancel:")" "0"
sleep 0.7   # calledAt 刚落库，escalateAfterMin=0.01（600ms）阈值同 ①b，要等它真的"老"过阈值
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "⑩a localEscalate=0（放弃升级不是撤单重呼）" "$(jq -r '.data.localEscalate // -1' <<<"$R")" "0"
assert_eq "⑩a 告警记录数 0→1" "$(s77_alert_count_for_key "dlv-escalate-precancel:")" "1"
s77_has_alert_key "kd100-config:30001" && ok "⑩a 命中 kd100-config:30001 告警" || fail "⑩a 未命中配置类告警" "$(s77_alerts)"
assert_eq "⑩a SCHEDULER 事件'预估取消费失败'记录数=1" "$(s77_event_count_like "$S77_DNO10" '%预估取消费失败%')" "1"
# 反例：这次让 precancel 真的成功（fee=0）——告警/事件记录数不该再涨，证明上面两条不是「不管发生什么都会变成 1」的假阳性
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
sched '{"escalateAfterMin":0.01}' >/dev/null
assert_eq "⑩a 反例：precancel 改成功后告警记录数仍为 1" "$(s77_alert_count_for_key "dlv-escalate-precancel:")" "1"
assert_eq "⑩a 反例：SCHEDULER 事件记录数仍为 1" "$(s77_event_count_like "$S77_DNO10" '%预估取消费失败%')" "1"

echo "   -- ⑩b 缺 orderId 的行：候选过滤应该让它完全没被碰——cancel_intent_at 不会被误写、也不会有 dlv-escalate: 告警 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID10B=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID10B/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID10B/call" "$AT")
S77_DNO10B=$(jq -r .data.deliveryNo <<<"$R")
s77_only "$S77_DNO10B"
sql "UPDATE deliveries SET provider_order_id=NULL WHERE delivery_no='$S77_DNO10B'"
assert_eq "⑩b 之前 cancel_intent_at 为 NULL" "$(sql "SELECT IF(cancel_intent_at IS NULL,'NULL','SET') FROM deliveries WHERE delivery_no='$S77_DNO10B'")" "NULL"
s77_alerts_reset
sleep 0.7
sched '{"escalateAfterMin":0.01}' >/dev/null
# 若候选过滤（providerOrderId:{not:null}）被删掉，precancelDelivery 对缺 id 行会静默回 null（不外呼），
# escalateSoloCalls 误判成「预估取消费=0」，继续走「真的升级」分支：调 cancelDelivery（这行缺 id，会走
# P15 记意图而不是真取消）再调 callRider（活跃单还占着，42228）——这两步的痕迹正是候选过滤被删掉后
# 才会出现的：cancel_intent_at 从 NULL 变 SET、多一条 dlv-escalate: 告警。用它们代替直接断言
# precancelOrder 计数（那条断言与 precancelDelivery 自己的 P15 短路无法区分，见复核 R6 RG）。
assert_eq "⑩b 缺 orderId 未被误写 cancel_intent_at（候选过滤生效）" "$(sql "SELECT IF(cancel_intent_at IS NULL,'NULL','SET') FROM deliveries WHERE delivery_no='$S77_DNO10B'")" "NULL"
s77_has_alert_key "dlv-escalate:" && fail "⑩b 不该有 dlv-escalate: 告警" "$(s77_alerts)" || ok "⑩b 无 dlv-escalate: 告警"
assert_eq "⑩b status 仍 CALLING" "$(sql "SELECT status FROM deliveries WHERE delivery_no='$S77_DNO10B'")" "CALLING"

echo "   -- ⑩c 意图单不进升级候选：用 attempts=5 让 localCancelIntent 本轮不收尾它，真正隔离出 cancelIntentAt:null 过滤的效果 --"
# 上一版用「刚记完意图」的行测，同一轮里 localCancelIntent 排在 localEscalate 之前，早把它自动取消
# 掉了——不管 escalateSoloCalls 候选里有没有排除 cancelIntentAt，这条断言都会通过（复核 R6 RF）。
# 把 cancel_intent_attempts 顶到上限，让 localCancelIntent 本轮直接跳过它（见 tasks.ts 的
# `if (d.cancelIntentAttempts < CANCEL_INTENT_MAX_ATTEMPTS)`），这样它才会带着 cancelIntentAt 活到
# localEscalate 那一步，过滤条件在不在才有得比。
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID10D=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID10D/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID10D/call" "$AT")
S77_DNO10D=$(jq -r .data.deliveryNo <<<"$R")
s77_only "$S77_DNO10D"
# 必须先把 id 清空再点取消——否则 cancelDelivery 看到两个 id 都在，会走真取消而不是记意图，
# cancel_intent_at 永远是 NULL，后面「意图单」这个前提就不成立了（这条本身就是本轮复核修复
# 之前的一次真实笔误：忘了这一步，导致行被真取消，断言只是凑巧「看起来像过了」）。
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO10D'"
req POST "/api/admin/local/orders/$S77_OID10D/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
assert_eq "⑩c 前置：cancel_intent_at 确实非空（真的记了意图，不是被真取消）" "$(sql "SELECT IF(cancel_intent_at IS NULL,'NULL','SET') FROM deliveries WHERE delivery_no='$S77_DNO10D'")" "SET"
sql "UPDATE deliveries SET provider_task_id='T77-$S77_TS-10d', provider_order_id='O77-$S77_TS-10d', cancel_intent_attempts=5 WHERE delivery_no='$S77_DNO10D'"
S77_PC_BEFORE10D=$(s77_calls_count precancelOrder)
sleep 0.7
sched '{"escalateAfterMin":0.01}' >/dev/null
assert_eq "⑩c 意图单（本轮未被 localCancelIntent 收尾）仍不进升级候选，precancel 计数不增" "$(s77_calls_count precancelOrder)" "$S77_PC_BEFORE10D"
assert_eq "⑩c 行仍 CALLING" "$(sql "SELECT status FROM deliveries WHERE delivery_no='$S77_DNO10D'")" "CALLING"

echo "-- ⑪ 意图单不能加小费 --"
R=$(req POST "/api/admin/local/orders/$S77_OID9/delivery/tip" "$AT" '{"amount":150}')
assert_eq "⑪对意图单加小费 code 42235" "$(code "$R")" "42235"

echo "-- ⑬ R3：有 taskId 无 orderId 的意图单必收尾（验收 17） --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID13=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID13/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID13/call" "$AT")
S77_DNO13=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_order_id=NULL WHERE delivery_no='$S77_DNO13'"
R=$(req POST "/api/admin/local/orders/$S77_OID13/delivery/cancel" "$AT" '{"reason":"店员要求取消"}')
assert_eq "⑬缺 orderId（有 taskId）cancel pending=true" "$(jq -r .data.pending <<<"$R")" "true"
sched '{"cancelIntentVoidMin":0}' >/dev/null
R=$(sql "SELECT CONCAT(status,'|',error_code,'|',IF(active_order_id IS NULL,'NULL','SET')) FROM deliveries WHERE delivery_no='$S77_DNO13'")
assert_eq "⑬taskId-only 自动结束：status=FAILED error_code=VOIDED_NOID active_order_id 释放" "$R" "FAILED|VOIDED_NOID|NULL"
assert_eq "⑬SCHEDULER 事件含'有 taskId 无 orderId'" "$(s77_event_count_like "$S77_DNO13" '%有 taskId 无 orderId%')" "1"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID13/call" "$AT")
assert_eq "⑬自动结束后可立即重呼 code 0" "$(code "$R")" "0"
S77_DNO13D2=$(jq -r .data.deliveryNo <<<"$R")
S77_T13="T77-$S77_TS-13"; S77_O13="O77-$S77_TS-13"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":200}}' >/dev/null
s77_cb "$S77_DNO13" "$S77_T13" 100 "骑手已接单" "2026-09-24 12:13:00" "$S77_O13" >/dev/null
sleep 1
R=$(sql "SELECT CONCAT(IF(ghost_cancel_at IS NULL,'NULL','SET'),'|',cancel_fee) FROM deliveries WHERE delivery_no='$S77_DNO13'")
assert_eq "⑬结束后收到带 orderId 的回调→幽灵撤销：ghost_cancel_at 非空 cancel_fee=200" "$R" "SET|200"
assert_eq "⑬mock cancelOrder 恰 1 次且 orderId=回调值" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r --arg o "$S77_O13" '[.data[] | select(.op=="cancelOrder" and .input.orderId==$o)] | length')" "1"

echo "-- ⑭ R4：幽灵回调缺 orderId 不烧占位（验收 18） --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID14=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID14/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID14/call" "$AT")
S77_DNO14=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET status='FAILED', provider_task_id=NULL, provider_order_id=NULL, active_order_id=NULL, error_code='VOIDED' WHERE delivery_no='$S77_DNO14'"
S77_T14="T77-$S77_TS-14"
S77_CC_BEFORE14=$(s77_calls_count cancelOrder)
s77_cb "$S77_DNO14" "$S77_T14" 100 "骑手已接单" "2026-09-24 12:14:00" "" >/dev/null   # 不带 orderId
sleep 1
assert_eq "⑭缺 orderId 的回调不抢占：ghost_cancel_at 仍 NULL" "$(sql "SELECT IF(ghost_cancel_at IS NULL,'NULL','SET') FROM deliveries WHERE delivery_no='$S77_DNO14'")" "NULL"
assert_eq "⑭未外呼 cancelOrder" "$(s77_calls_count cancelOrder)" "$S77_CC_BEFORE14"
assert_eq "⑭有 GHOSTWAIT 等待事件" "$(s77_event_count_like "$S77_DNO14" '%尚不齐全%')" "1"
S77_O14="O77-$S77_TS-14"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":150}}' >/dev/null
s77_cb "$S77_DNO14" "$S77_T14" 230 "骑手已到店" "2026-09-24 12:14:05" "$S77_O14" >/dev/null   # 这次带 orderId
sleep 1
assert_eq "⑭补全 orderId 后才抢占并外呼：ghost_cancel_at 非空" "$(sql "SELECT IF(ghost_cancel_at IS NULL,'NULL','SET') FROM deliveries WHERE delivery_no='$S77_DNO14'")" "SET"
assert_eq "⑭cancelOrder 恰新增 1 次" "$(($(s77_calls_count cancelOrder) - S77_CC_BEFORE14))" "1"

echo "-- ⑮ R2：在途租约防止重复外呼（验收 19） --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID15=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID15/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID15/call" "$AT")
S77_DNO15=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO15'"
req POST "/api/admin/local/orders/$S77_OID15/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","holdMs":2500,"cancelFeeFen":200}}' >/dev/null
S77_T15="T77-$S77_TS-15"; S77_O15="O77-$S77_TS-15"
S77_CC_BEFORE15=$(s77_calls_count cancelOrder)
s77_cb "$S77_DNO15" "$S77_T15" 100 "骑手已接单" "2026-09-24 12:15:00" "$S77_O15" >/dev/null   # 触发点①：回调认领 ids 后 after.push(executeCancelIntent)，抢到锁开始 2.5s 外呼
sleep 0.4   # 让①先抢到锁、外呼已经发出但还没返回
sched '{"cancelIntentVoidMin":0}' >/dev/null   # 触发点②：兜底调度这时候进来，应该被租约挡住，不再外呼
sleep 2.4   # 等①的外呼真正返回、finalizeCancel 提交
R=$(sql "SELECT CONCAT(status,'|',cancel_intent_attempts,'|',cancel_fee,'|',IF(cancel_intent_locked_at IS NULL,'NULL','SET')) FROM deliveries WHERE delivery_no='$S77_DNO15'")
assert_eq "⑮租约生效：status=CANCELLED attempts=1 cancel_fee=200 锁已释放" "$R" "CANCELLED|1|200|NULL"
assert_eq "⑮mock cancelOrder 恰 1 次（不是 2 次）" "$(($(s77_calls_count cancelOrder) - S77_CC_BEFORE15))" "1"
echo "   -- ⑮反例：租约过期（模拟进程崩溃）后下一次 sched 仍能再次抢占，attempts 变 2 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID15B=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID15B/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID15B/call" "$AT")
S77_DNO15B=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO15B'"
req POST "/api/admin/local/orders/$S77_OID15B/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
S77_T15B="T77-$S77_TS-15b"; S77_O15B="O77-$S77_TS-15b"
sql "UPDATE deliveries SET provider_task_id='$S77_T15B', provider_order_id='$S77_O15B', cancel_intent_attempts=1, cancel_intent_locked_at = NOW(3) - INTERVAL 2 MINUTE WHERE delivery_no='$S77_DNO15B'"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":200}}' >/dev/null
sched '{"cancelIntentVoidMin":0}' >/dev/null
R=$(sql "SELECT CONCAT(status,'|',cancel_intent_attempts) FROM deliveries WHERE delivery_no='$S77_DNO15B'")
assert_eq "⑮反例：过期租约允许再次抢占，attempts 变 2、行终态化" "$R" "CANCELLED|2"

echo "-- ⑯ R1：720 先于 cancel 同步响应到达，取消费补记不丢失（验收 20） --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID16=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID16/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID16/call" "$AT")
S77_DNO16=$(jq -r .data.deliveryNo <<<"$R")
R=$(req GET "/api/admin/local/orders/$S77_OID16/delivery" "$AT")
S77_T16=$(jq -r .data.delivery.providerTaskId <<<"$R"); S77_O16=$(jq -r .data.delivery.providerOrderId <<<"$R")
# 720 有并呼假撤单过滤（callback.ts）：呼叫阶段（statusRank<20）用「只呼了一家」判定撤单方，
# 回调的 kuaidicom 若与这家对不上就被当「未中标方撤单」直接忽略，不进主状态机——这张单还从没
# 收到过任何回调，courierCompany 是 NULL，必须传真正被呼叫的那一家，不能用 s77_cb 的默认值
# （首次踩过这个坑：默认 kuaidicom 与实际被呼叫方不一致，720 被判成"未中标"静默丢弃，
# 行从始至终没被 720 动过，最终是走了正常取消路径成功——补记事件因此缺失，现象和"竞态没赢"
# 一模一样，容易误判成时序问题，实际是回调参数本身没对上）。
S77_KC16=$(jq -r '.data.delivery.calledProviders[0]' <<<"$R")
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","holdMs":4000,"cancelFeeFen":200}}' >/dev/null
s77_alerts_reset
S77_OUT16=$(mktemp)
( req POST "/api/admin/local/orders/$S77_OID16/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' > "$S77_OUT16" ) &
S77_PID16=$!
sleep 0.5
s77_cb "$S77_DNO16" "$S77_T16" 720 "订单已取消" "2026-09-24 12:16:00" "$S77_O16" "商家取消" "王骑手" "13900001111" "$S77_KC16" >/dev/null
wait "$S77_PID16"
S77_R16=$(cat "$S77_OUT16")
assert_eq "⑯/cancel 响应 code 0" "$(code "$S77_R16")" "0"
assert_eq "⑯/cancel 响应 cancelFeeFen=200" "$(jq -r .data.cancelFeeFen <<<"$S77_R16")" "200"
R=$(sql "SELECT CONCAT(status,'|',cancel_fee) FROM deliveries WHERE delivery_no='$S77_DNO16'")
assert_eq "⑯行 CANCELLED，cancel_fee 补记为 200" "$R" "CANCELLED|200"
assert_eq "⑯有含'补记'的事件" "$(s77_event_count_like "$S77_DNO16" '%补记%')" "1"
s77_has_alert_key "dlv-cancel-lost:" && fail "⑯不该有 dlv-cancel-lost 告警" "$(s77_alerts)" || ok "⑯无 dlv-cancel-lost 告警"
assert_eq "⑯订单仍 PREPARING" "$(sql "SELECT status FROM orders WHERE id=$S77_OID16")" "PREPARING"
echo "   -- ⑯反例：520（已送达）先到，补记通道不放行，原样走丢失告警 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID16B=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID16B/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID16B/call" "$AT")
S77_DNO16B=$(jq -r .data.deliveryNo <<<"$R")
R=$(req GET "/api/admin/local/orders/$S77_OID16B/delivery" "$AT")
S77_T16B=$(jq -r .data.delivery.providerTaskId <<<"$R"); S77_O16B=$(jq -r .data.delivery.providerOrderId <<<"$R")
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","holdMs":4000,"cancelFeeFen":300}}' >/dev/null
s77_alerts_reset
S77_OUT16B=$(mktemp)
( req POST "/api/admin/local/orders/$S77_OID16B/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' > "$S77_OUT16B" ) &
S77_PID16B=$!
sleep 0.5
s77_cb "$S77_DNO16B" "$S77_T16B" 520 "已送达" "2026-09-24 12:16:30" "$S77_O16B" >/dev/null
wait "$S77_PID16B"
S77_R16B=$(cat "$S77_OUT16B")
assert_eq "⑯反例 /cancel 响应 code 42237" "$(code "$S77_R16B")" "42237"
s77_has_alert_key "dlv-cancel-lost:" && ok "⑯反例命中 dlv-cancel-lost 告警" || fail "⑯反例未命中告警" "$(s77_alerts)"
assert_eq "⑯反例行仍 DELIVERED（未被补记通道改动）" "$(sql "SELECT status FROM deliveries WHERE delivery_no='$S77_DNO16B'")" "DELIVERED"
echo "   -- ⑯c 意图路径同样验证：executeCancelIntent 外呼期间 720 先到，补记不丢失、无告警 --"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok"}}' >/dev/null
S77_OID16C=$(mk_local_paid)
req POST "/api/admin/local/orders/$S77_OID16C/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$S77_OID16C/call" "$AT")
S77_DNO16C=$(jq -r .data.deliveryNo <<<"$R")
sql "UPDATE deliveries SET provider_task_id=NULL, provider_order_id=NULL WHERE delivery_no='$S77_DNO16C'"
req POST "/api/admin/local/orders/$S77_OID16C/delivery/cancel" "$AT" '{"reason":"店员要求取消"}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","holdMs":4000,"cancelFeeFen":250}}' >/dev/null
S77_T16C="T77-$S77_TS-16c"; S77_O16C="O77-$S77_TS-16c"
s77_alerts_reset
s77_cb "$S77_DNO16C" "$S77_T16C" 100 "骑手已接单" "2026-09-24 12:16:40" "$S77_O16C" >/dev/null   # 认领 ids，触发 executeCancelIntent 开始 4s 外呼
sleep 0.5
s77_cb "$S77_DNO16C" "$S77_T16C" 720 "订单已取消" "2026-09-24 12:16:41" "$S77_O16C" "商家取消" >/dev/null   # 外呼还没返回，720 先到
sleep 4.0
R=$(sql "SELECT CONCAT(status,'|',cancel_fee) FROM deliveries WHERE delivery_no='$S77_DNO16C'")
assert_eq "⑯c 意图路径：CANCELLED，cancel_fee 补记为 250" "$R" "CANCELLED|250"
assert_eq "⑯c 有含'补记'的事件" "$(s77_event_count_like "$S77_DNO16C" '%补记%')" "1"
s77_has_alert_key "dlv-cancel-lost:" && fail "⑯c 不该有告警" "$(s77_alerts)" || ok "⑯c 无告警"

echo "-- ⑫ 无回退：恢复设置、重置 mock/alerts、造出的在途单收尾 --"
req PUT /api/admin/settings/local-delivery "$AT" "$S77_ORIG" >/dev/null
req POST "/api/admin/local/orders/$S77_OID9/delivery/cancel" "$AT" '{"reason":"收尾"}' >/dev/null
sql "UPDATE deliveries SET status='CANCELLED', active_order_id=NULL WHERE delivery_no IN ('$S77_DNO6D2','$S77_DNO10','$S77_DNO10B','$S77_DNO10D','$S77_DNO13D2') AND status NOT IN ('CANCELLED','FAILED','DELIVERED')"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
s77_alerts_reset
