# 需要 SCHEDULER_DISABLED=true 启动后端：心跳里的 reconcileExpressUnknown 会消费 mock 的 detail 指令
echo "== 59. 邮寄预约回调：验签/去重/乱序/接单/取件→已发货/结算/签收→完成/失败/取消 =="
# 复用主体 helper 与 §58 留下的 $X58_KEEP_O2（BOOKED，极兔）。变量 X59_ 前缀。
X59_CB=/tmp/e2e-xcb.json
x59_cb() { # bookingNo status [extraDataJson] → HTTP 码；响应体在 $X59_CB
  local bn="$1" st="$2" extra="${3:-{\}}" salt param sign
  salt=$(req GET "/api/admin/system/express-mock/salt/$bn" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg s "$st" --argjson x "$extra" '{status:($s|tonumber), kuaidinum:($x.kuaidinum // null), data:({status:($s|tonumber), orderId:"KDX-1"} + $x)}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$X59_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$bn" --data-urlencode "param=$param" --data-urlencode "sign=$sign"
}
x59_bk() { req GET "/api/admin/express/orders/$1/booking" "$AT"; }
X59_O=$X58_KEEP_O2
X59_BN=$(x59_bk "$X59_O" | jq -r .data.booking.bookingNo)
assert_eq "起点 BOOKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "BOOKED"

echo "-- ① 验签失败 → 200 ack 但状态不变；未知 bookingNo → 200 --"
X59_P='{"status":1,"data":{"status":1}}'
HTTPC=$(curl -s -o "$X59_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$X59_BN" --data-urlencode "param=$X59_P" --data-urlencode "sign=DEADBEEF")
assert_eq "验签失败 HTTP 200" "$HTTPC" "200"; assert_eq "仍 BOOKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "BOOKED"
HTTPC=$(curl -s -o "$X59_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/E999999-9" --data-urlencode "param=$X59_P" --data-urlencode "sign=DEADBEEF"); assert_eq "未知单号 200" "$HTTPC" "200"

echo "-- ② 1 已接单 → ACCEPTED + 快递员；重复推送去重；乱序 0 不回退 --"
HTTPC=$(x59_cb "$X59_BN" 1 '{"courierName":"张师傅","courierMobile":"13811112222"}'); assert_eq "回调 1 HTTP 200" "$HTTPC" "200"
assert_eq "ack 形状 result=true" "$(jq -r .result "$X59_CB")" "true"
R=$(x59_bk "$X59_O"); assert_eq "ACCEPTED" "$(jq -r .data.booking.status <<<"$R")" "ACCEPTED"; assert_eq "快递员" "$(jq -r .data.booking.courierName <<<"$R")" "张师傅"
X59_EV=$(jq -r '.data.events|length' <<<"$R")
x59_cb "$X59_BN" 1 '{"courierName":"张师傅","courierMobile":"13811112222"}' >/dev/null
assert_eq "同一条重推：事件数不变" "$(x59_bk "$X59_O" | jq -r '.data.events|length')" "$X59_EV"
x59_cb "$X59_BN" 0 '{"kuaidinum":"JT-LATE"}' >/dev/null
assert_eq "乱序 0 不回退" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "ACCEPTED"
assert_eq "订单仍 PREPARING" "$(order_status $X59_O)" "PREPARING"

echo "-- ③ 10 已取件 → PICKED，订单 SHIPPED，Shipment 写单号+shippedAt --"
x59_cb "$X59_BN" 10 '{"kuaidinum":"JT9990001"}' >/dev/null
R=$(x59_bk "$X59_O"); assert_eq "PICKED" "$(jq -r .data.booking.status <<<"$R")" "PICKED"; assert_eq "单号回填" "$(jq -r .data.booking.kuaidinum <<<"$R")" "JT9990001"
assert_eq "订单 SHIPPED" "$(order_status $X59_O)" "SHIPPED"
assert_eq "Shipment 公司/单号/发货时间" "$(sql "SELECT CONCAT(express_company,'|',express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X59_O;")" "极兔速递|JT9990001|SET"
x59_cb "$X59_BN" 9 '{}' >/dev/null
assert_eq "取件后收到取消回调：忽略，仍 PICKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "PICKED"
assert_eq "取件后订单仍 SHIPPED" "$(order_status $X59_O)" "SHIPPED"

echo "-- ④ 15 结算 → 实扣/计费重；155 更新；synPay 被调；成本告警只一次 --"
x59_cb "$X59_BN" 15 '{"weight":"2.0","freight":"12.50","defPrice":"16.00","feeDetails":[{"feeType":"freight","amount":"12.50"}]}' >/dev/null
R=$(x59_bk "$X59_O"); assert_eq "settledFeeFen 1250" "$(jq -r .data.booking.settledFeeFen <<<"$R")" "1250"; assert_eq "billedWeightG 2000" "$(jq -r .data.booking.billedWeightG <<<"$R")" "2000"
assert_eq "synPay 调了 1 次" "$(req GET "/api/admin/system/express-mock/calls?op=synPay" "$AT" | jq -r '.data|length')" "1"
x59_cb "$X59_BN" 155 '{"weight":"2.5","freight":"13.80"}' >/dev/null
assert_eq "155 更新实扣 1380" "$(x59_bk "$X59_O" | jq -r .data.booking.settledFeeFen)" "1380"
assert_eq "状态仍 PICKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "PICKED"

echo "-- ⑤ 101/400 只留痕；13 签收 → DELIVERED，订单 COMPLETED --"
x59_cb "$X59_BN" 101 '{}' >/dev/null; x59_cb "$X59_BN" 400 '{}' >/dev/null
assert_eq "运输/派送中不改状态" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "PICKED"
x59_cb "$X59_BN" 13 '{}' >/dev/null
assert_eq "DELIVERED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "DELIVERED"
assert_eq "订单 COMPLETED" "$(order_status $X59_O)" "COMPLETED"
assert_eq "不再活跃" "$(x59_bk "$X59_O" | jq -r .data.active)" "false"

echo "-- ⑥ 揽货失败 11 → FAILED 回备货中可重约；快递100 侧取消 9 → CANCELLED --"
X59_O3=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X59_O3/book" "$AT" '{"kuaidicom":"zhongtong","dayType":"明天"}' >/dev/null
X59_BN3=$(x59_bk "$X59_O3" | jq -r .data.booking.bookingNo)
x59_cb "$X59_BN3" 11 '{"message":"揽货失败：联系不上寄件人"}' >/dev/null
R=$(x59_bk "$X59_O3"); assert_eq "FAILED" "$(jq -r .data.booking.status <<<"$R")" "FAILED"; assert_eq "不活跃" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "订单仍 PREPARING" "$(order_status $X59_O3)" "PREPARING"
R=$(req POST "/api/admin/express/orders/$X59_O3/book" "$AT" '{"kuaidicom":"zhongtong","dayType":"明天"}'); assert_eq "失败后重约 code 0" "$(code "$R")" "0"
X59_BN4=$(jq -r .data.bookingNo <<<"$R")
x59_cb "$X59_BN4" 99 '{}' >/dev/null
R=$(x59_bk "$X59_O3"); assert_eq "99 → CANCELLED" "$(jq -r .data.booking.status <<<"$R")" "CANCELLED"; assert_eq "cancelledBy KD100" "$(jq -r .data.booking.cancelledBy <<<"$R")" "KD100"

echo "-- ⑦ 韵达异步：回调 0 补单号写 Shipment；610 → FAILED --"
R=$(req POST "/api/admin/express/orders/$X59_O3/book" "$AT" '{"kuaidicom":"yunda","dayType":"明天"}'); X59_BN5=$(jq -r .data.bookingNo <<<"$R")
assert_eq "韵达下单单号空" "$(jq -r .data.kuaidinum <<<"$R")" "null"
x59_cb "$X59_BN5" 0 '{"kuaidinum":"YD0007"}' >/dev/null
assert_eq "回调 0 补单号" "$(x59_bk "$X59_O3" | jq -r .data.booking.kuaidinum)" "YD0007"
assert_eq "Shipment 单号 YD0007 未发货" "$(sql "SELECT CONCAT(express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X59_O3;")" "YD0007|NULL"
x59_cb "$X59_BN5" 610 '{"message":"下单失败"}' >/dev/null
assert_eq "610 → FAILED" "$(x59_bk "$X59_O3" | jq -r .data.booking.status)" "FAILED"

echo "-- ⑧ UNKNOWN 占位被回调认领 --"
X59_O4=$(x58_paid_preparing)
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"timeout"}}' >/dev/null
req POST "/api/admin/express/orders/$X59_O4/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X59_BN6=$(x59_bk "$X59_O4" | jq -r .data.booking.bookingNo)
x59_cb "$X59_BN6" 1 '{"taskId":"T-CLAIM","courierName":"王师傅"}' >/dev/null
R=$(x59_bk "$X59_O4"); assert_eq "UNKNOWN 被 1 认领为 ACCEPTED" "$(jq -r .data.booking.status <<<"$R")" "ACCEPTED"
assert_eq "taskId 认领" "$(sql "SELECT task_id FROM express_bookings WHERE booking_no='$X59_BN6';")" "T-CLAIM"

echo "-- ⑨ 未知状态码 → 留痕 + 200 --"
HTTPC=$(x59_cb "$X59_BN6" 777 '{}'); assert_eq "未知状态 200" "$HTTPC" "200"
assert_eq "状态不变 ACCEPTED" "$(x59_bk "$X59_O4" | jq -r .data.booking.status)" "ACCEPTED"
echo "-- ⑩ 漏推 10 直推 13：先补取件（订单 SHIPPED + Shipment + 发货通知）再签收 → COMPLETED --"
X59_O5=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X59_O5/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X59_BN7=$(x59_bk "$X59_O5" | jq -r .data.booking.bookingNo)
assert_eq "起点 BOOKED" "$(x59_bk "$X59_O5" | jq -r .data.booking.status)" "BOOKED"
HTTPC=$(x59_cb "$X59_BN7" 13 '{"kuaidinum":"JD-DIRECT-13"}'); assert_eq "直推 13 HTTP 200" "$HTTPC" "200"
R=$(x59_bk "$X59_O5")
assert_eq "预约 DELIVERED" "$(jq -r .data.booking.status <<<"$R")" "DELIVERED"
assert_eq "pickedAt 已补" "$(jq -r '.data.booking.pickedAt != null' <<<"$R")" "true"
assert_eq "不再活跃" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "订单 COMPLETED（经过 SHIPPED）" "$(order_status $X59_O5)" "COMPLETED"
assert_eq "Shipment 单号+发货时间" "$(sql "SELECT CONCAT(express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X59_O5;")" "JD-DIRECT-13|SET"
assert_eq "completedAt 有值" "$(sql "SELECT IF(completed_at IS NULL,'NULL','SET') FROM orders WHERE id=$X59_O5;")" "SET"
assert_eq "补记取件只留痕一次（provider_status=10）" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X59_BN7' AND e.provider_status=10;")" "1"
assert_eq "签收留痕一次（provider_status=13）" "$(sql "SELECT COUNT(*) FROM express_booking_events e JOIN express_bookings b ON b.id=e.booking_id WHERE b.booking_no='$X59_BN7' AND e.provider_status=13;")" "1"

X59_KEEP_O4=$X59_O4   # ACCEPTED，留给 §60 退款前置用
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
