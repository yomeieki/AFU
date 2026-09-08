echo "== 60. 邮寄守卫：有预约不能手填发货/退款/拒单；顾客取消窗口；同意=先取消预约再退款；定时提醒与对账 =="
# 依赖 §59 的 $X59_KEEP_O4（ACCEPTED，京东）。变量 X60_ 前缀。
X60_ORIG=$(req GET /api/admin/settings/express "$AT" | jq -c .data)
req PUT /api/admin/settings/express "$AT" "$(jq -c '.acceptGraceMin=10' <<<"$X60_ORIG")" >/dev/null

echo "-- ① 活跃预约：/ship 42264、全额退款 42263、拒单 42263 --"
X60_O=$X59_KEEP_O4
R=$(req POST "/api/admin/orders/$X60_O/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"X"}'); assert_eq "手填发货被拦 42264" "$(code "$R")" "42264"
X60_AMT=$(req GET "/api/admin/orders/$X60_O" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$X60_O/refund" "$AT" "{\"amount\":$X60_AMT,\"reason\":\"e2e\"}"); assert_eq "全额退款被拦 42263" "$(code "$R")" "42263"
R=$(req POST "/api/admin/orders/$X60_O/reject" "$AT" '{"reason":"OTHER","note":"e2e"}'); assert_eq "拒单被拦 42263" "$(code "$R")" "42263"
R=$(req POST "/api/admin/orders/$X60_O/refund" "$AT" '{"amount":1,"reason":"e2e 部分"}'); assert_eq "部分退款不受影响 code 0" "$(code "$R")" "0"
req POST "/api/admin/express/orders/$X60_O/booking/cancel" "$AT" '{}' >/dev/null
R=$(req POST "/api/admin/orders/$X60_O/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"X60"}'); assert_eq "取消预约后可手填发货" "$(code "$R")" "0"

echo "-- ② 顾客取消窗口（EXPRESS）：接单前秒退不变；接单后 10 分钟内可申请；窗口 0 关闭 --"
X60_O2=$(make_paid_order)
R=$(req POST "/api/orders/$X60_O2/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "未接单不能申请 42229" "$(code "$R")" "42229"
req POST "/api/admin/orders/$X60_O2/accept" "$AT" >/dev/null
R=$(req GET "/api/orders/$X60_O2" "$UT")
assert_eq "详情 canRequestCancel=true" "$(jq -r .data.canRequestCancel <<<"$R")" "true"
assert_eq "详情 cancelGraceMin=10" "$(jq -r .data.cancelGraceMin <<<"$R")" "10"
assert_eq "expressBooking 为 null（未预约）" "$(jq -r .data.expressBooking <<<"$R")" "null"
req POST "/api/admin/express/orders/$X60_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"11:00"}' >/dev/null
R=$(req GET "/api/orders/$X60_O2" "$UT")
assert_eq "顾客端看到 expressBooking.status BOOKED" "$(jq -r .data.expressBooking.status <<<"$R")" "BOOKED"
assert_eq "顾客端不给手机号字段" "$(jq -r '.data.expressBooking | has("courierMobile")' <<<"$R")" "false"
R=$(req POST "/api/orders/$X60_O2/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "接单后窗口内申请 code 0" "$(code "$R")" "0"
assert_eq "快照预约状态 BOOKED" "$(sql "SELECT cancel_request_delivery_status FROM orders WHERE id=$X60_O2;")" "BOOKED"
R=$(req POST "/api/admin/express/orders/$X60_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}'); assert_eq "有取消申请时预约被拦 42266（取消申请检查先于已有预约）" "$(code "$R")" "42266"

echo "-- ③ 驳回：清标记、留驳回痕迹；再申请可以 --"
R=$(req POST "/api/admin/express/orders/$X60_O2/cancel-request/reject" "$AT"); assert_eq "驳回 code 0" "$(code "$R")" "0"
assert_eq "驳回痕迹 MANUAL" "$(sql "SELECT cancel_request_rejected_by FROM orders WHERE id=$X60_O2;")" "MANUAL"
R=$(req POST "/api/orders/$X60_O2/cancel-request" "$UT" '{}'); assert_eq "窗口内再申请 code 0" "$(code "$R")" "0"

echo "-- ④ 同意：先取消预约再全额退款；预约取消失败则不退款 --"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"cancel","directive":{"kind":"error","code":"500","message":"订单已揽收，无法取消"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X60_O2/cancel-request/approve" "$AT"); assert_eq "预约取消失败 → 42267" "$(code "$R")" "42267"
assert_eq "未退款：订单仍 PREPARING" "$(order_status $X60_O2)" "PREPARING"
R=$(req POST "/api/admin/express/orders/$X60_O2/cancel-request/approve" "$AT"); assert_eq "再同意 code 0" "$(code "$R")" "0"
assert_eq "预约 CANCELLED by CUSTOMER" "$(req GET "/api/admin/express/orders/$X60_O2/booking" "$AT" | jq -r '.data.booking.cancelledBy')" "CUSTOMER"
assert_eq "订单 REFUNDED（mock 即时）" "$(order_status $X60_O2)" "REFUNDED"

echo "-- ⑤ 窗口 0 = 关闭 --"
req PUT /api/admin/settings/express "$AT" "$(jq -c '.acceptGraceMin=0' <<<"$X60_ORIG")" >/dev/null
X60_O3=$(make_paid_order); req POST "/api/admin/orders/$X60_O3/accept" "$AT" >/dev/null
R=$(req POST "/api/orders/$X60_O3/cancel-request" "$UT" '{}'); assert_eq "窗口关闭 42229" "$(code "$R")" "42229"
req PUT /api/admin/settings/express "$AT" "$(jq -c '.acceptGraceMin=10' <<<"$X60_ORIG")" >/dev/null

echo "-- ⑥ 超时自动驳回（EXPRESS 也走）--"
X60_O4=$(make_paid_order); req POST "/api/admin/orders/$X60_O4/accept" "$AT" >/dev/null
req POST "/api/orders/$X60_O4/cancel-request" "$UT" '{}' >/dev/null
R=$(sched '{"cancelAutoRejectMin":0}')
assert_eq "自动驳回痕迹 AUTO" "$(sql "SELECT cancel_request_rejected_by FROM orders WHERE id=$X60_O4;")" "AUTO"

echo "-- ⑦ 定时提醒：预约后无人接单、时段结束未取件、UNKNOWN 对账 --"
X60_O5=$(make_paid_order); req POST "/api/admin/orders/$X60_O5/accept" "$AT" >/dev/null
req POST "/api/admin/express/orders/$X60_O5/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
R=$(sched '{"expressUnacceptedHours":0}'); assert_eq "无人接单提醒 1 条" "$(jq -r '.data.expressUnaccepted // -1' <<<"$R")" "1"
R=$(sched '{"expressUnacceptedHours":0}'); assert_eq "只提醒一次" "$(jq -r '.data.expressUnaccepted // -1' <<<"$R")" "0"
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE active_order_id=$X60_O5;"
R=$(sched '{"expressUnpickedMin":0}'); assert_eq "时段过未取件提醒 1 条" "$(jq -r '.data.expressUnpicked // -1' <<<"$R")" "1"
req POST "/api/admin/express/orders/$X60_O5/booking/cancel" "$AT" '{}' >/dev/null
X60_O6=$(make_paid_order); req POST "/api/admin/orders/$X60_O6/accept" "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"timeout"}}' >/dev/null
req POST "/api/admin/express/orders/$X60_O6/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressUnknownMin":0}'); assert_eq "对账查不到：仍 UNKNOWN（不自动作废）" "$(req GET "/api/admin/express/orders/$X60_O6/booking" "$AT" | jq -r .data.booking.status)" "UNKNOWN"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":0,"taskId":"T-RC","kdOrderId":"O-RC","kuaidinum":"JD-RC"}}' >/dev/null
R=$(sched '{"expressUnknownMin":0}'); assert_eq "对账查到：认领 BOOKED" "$(req GET "/api/admin/express/orders/$X60_O6/booking" "$AT" | jq -r .data.booking.status)" "BOOKED"
assert_eq "认领补单号" "$(req GET "/api/admin/express/orders/$X60_O6/booking" "$AT" | jq -r .data.booking.kuaidinum)" "JD-RC"
req POST "/api/admin/express/orders/$X60_O6/booking/cancel" "$AT" '{}' >/dev/null

req PUT /api/admin/settings/express "$AT" "$X60_ORIG" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
