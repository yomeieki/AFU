echo "== 58. 邮寄预约取件：报价/建单/重复/时段/取消/超时未知/失败 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/make_paid_order/order_status/sql 与 $AT/$UT/$PID/$ADDR。变量 X58_ 前缀。
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
x58_paid_preparing() { local o; o=$(make_paid_order); req POST "/api/admin/orders/$o/accept" "$AT" >/dev/null; echo "$o"; }
x58_bk() { req GET "/api/admin/express/orders/$1/booking" "$AT"; }

echo "-- ① 报价接口：各家价 + 预填时段 + 快递名单 --"
X58_O1=$(x58_paid_preparing)
R=$(req GET "/api/admin/express/orders/$X58_O1/quotes" "$AT")
assert_eq "quotes code 0" "$(code "$R")" "0"
assert_eq "9 家" "$(jq -r '.data.quotes|length' <<<"$R")" "9"
assert_eq "couriers 9 个" "$(jq -r '.data.couriers|length' <<<"$R")" "9"
[[ "$(jq -r '.data.suggestedSlot.dayType' <<<"$R")" =~ ^(今天|明天)$ ]] && ok "预填时段 dayType" || fail "预填时段" "$R"
assert_eq "顾客付的运费 = 订单 shippingFee" "$(jq -r .data.customerFeeFen <<<"$R")" "$(req GET "/api/admin/orders/$X58_O1" "$AT" | jq -r .data.shippingFee)"

echo "-- ② 时段校验 42269 --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"09:30"}'); assert_eq "间隔<1h 42269" "$(code "$R")" "42269"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"shunfeng","dayType":"明天"}'); assert_eq "顺丰缺时段 42269" "$(code "$R")" "42269"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"bogus","dayType":"明天"}'); assert_eq "未知快递 40001" "$(code "$R")" "40001"

echo "-- ③ 预约成功：BOOKED + 单号写入 Shipment，订单仍 PREPARING --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"11:00","weightKg":1.5,"remark":"轻拿轻放"}')
assert_eq "book code 0" "$(code "$R")" "0"
assert_eq "status BOOKED" "$(jq -r .data.status <<<"$R")" "BOOKED"
X58_BN1=$(jq -r .data.bookingNo <<<"$R"); [[ "$X58_BN1" == "E${X58_O1}-1" ]] && ok "bookingNo=E<orderId>-1" || fail "bookingNo" "$X58_BN1"
X58_NUM1=$(jq -r .data.kuaidinum <<<"$R"); [[ "$X58_NUM1" == JD* ]] && ok "京东同步返单号 $X58_NUM1" || fail "单号" "$R"
assert_eq "订单仍 PREPARING" "$(order_status $X58_O1)" "PREPARING"
assert_eq "Shipment 已写单号但 shippedAt 空" "$(sql "SELECT CONCAT(express_no, '|', IFNULL(shipped_at,'NULL')) FROM shipments WHERE order_id=$X58_O1;")" "${X58_NUM1}|NULL"
R=$(x58_bk "$X58_O1")
assert_eq "booking.active=true" "$(jq -r .data.active <<<"$R")" "true"
assert_eq "courierLabel 京东物流" "$(jq -r .data.booking.courierLabel <<<"$R")" "京东物流"
assert_eq "weightKg 1.5" "$(jq -r .data.booking.weightKg <<<"$R")" "1.5"
assert_eq "slotText 含 09:00–11:00" "$(jq -r '.data.booking.slotText|test("09:00–11:00")' <<<"$R")" "true"
assert_eq "事件 1 条（预约成功）" "$(jq -r '.data.events|length' <<<"$R")" "1"
assert_eq "mock book 收到 thirdOrderId=bookingNo" "$(req GET "/api/admin/system/express-mock/calls?op=book" "$AT" | jq -r '.data[-1].input.bookingNo')" "$X58_BN1"

echo "-- ④ 重复预约 42265；改约成功；取消成功回备货中 --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"11:00"}'); assert_eq "重复预约 42265" "$(code "$R")" "42265"
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/modify" "$AT" '{"dayType":"后天","pickupStart":"14:00","pickupEnd":"16:00"}'); assert_eq "改约 code 0" "$(code "$R")" "0"
assert_eq "改约后 dayType=后天" "$(x58_bk "$X58_O1" | jq -r .data.booking.dayType)" "后天"
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{"reason":"改天发"}'); assert_eq "取消 code 0" "$(code "$R")" "0"
R=$(x58_bk "$X58_O1")
assert_eq "取消后 CANCELLED" "$(jq -r .data.booking.status <<<"$R")" "CANCELLED"; assert_eq "active=false" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "cancelledBy STAFF" "$(jq -r .data.booking.cancelledBy <<<"$R")" "STAFF"
assert_eq "订单仍 PREPARING" "$(order_status $X58_O1)" "PREPARING"
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}'); assert_eq "没有活跃预约再取消 42267" "$(code "$R")" "42267"

echo "-- ⑤ 韵达异步：单号为空；序号 -2 --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"yunda","dayType":"明天"}')
assert_eq "韵达 book code 0" "$(code "$R")" "0"; assert_eq "单号 null" "$(jq -r .data.kuaidinum <<<"$R")" "null"; assert_eq "bookingNo -2" "$(jq -r .data.bookingNo <<<"$R")" "E${X58_O1}-2"
req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}' >/dev/null

echo "-- ⑥ 快递100 取消被拒（已揽收）→ 42267 且状态不变 --"
req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"cancel","directive":{"kind":"error","code":"500","message":"订单已揽收，无法取消"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}'); assert_eq "已揽收拒绝取消 42267" "$(code "$R")" "42267"
assert_eq "状态仍 BOOKED" "$(x58_bk "$X58_O1" | jq -r .data.booking.status)" "BOOKED"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"cancel","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}'); assert_eq "取消超时 42268" "$(code "$R")" "42268"
req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}' >/dev/null

echo "-- ⑦ 下单超时 → UNKNOWN（占活跃位），对账认领 / 人工作废 --"
X58_O2=$(x58_paid_preparing)
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}')
assert_eq "超时 code 0 且 status UNKNOWN" "$(jq -r .data.status <<<"$R")" "UNKNOWN"
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}'); assert_eq "UNKNOWN 占位时再约 42265" "$(code "$R")" "42265"
R=$(req POST "/api/admin/express/orders/$X58_O2/booking/cancel" "$AT" '{}'); assert_eq "UNKNOWN 不能直接取消 42267" "$(code "$R")" "42267"
R=$(req POST "/api/admin/express/orders/$X58_O2/booking/void" "$AT"); assert_eq "作废 code 0" "$(code "$R")" "0"
assert_eq "作废后 VOID 且不活跃" "$(x58_bk "$X58_O2" | jq -r '[.data.booking.status, (.data.active|tostring)]|join(",")')" "VOID,false"

echo "-- ⑧ 下单业务失败 → FAILED + 42270 原话，可再约 --"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"error","code":"500","message":"下单失败:该区域暂时不开放"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}')
assert_eq "业务失败 42270" "$(code "$R")" "42270"; assert_eq "带原话" "$(jq -r '.message|test("该区域暂时不开放")' <<<"$R")" "true"
assert_eq "记录为 FAILED" "$(x58_bk "$X58_O2" | jq -r .data.booking.status)" "FAILED"
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jtexpress","dayType":"明天"}'); assert_eq "失败后可再约 code 0" "$(code "$R")" "0"
X58_KEEP_O2=$X58_O2   # 留给 §59 用（BOOKED，极兔）
X58_KEEP_O1=$X58_O1   # PREPARING，无活跃预约
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
