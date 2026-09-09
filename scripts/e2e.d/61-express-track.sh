# 需要 SCHEDULER_DISABLED=true 启动后端（同 §59/§60）。变量 X61_ 前缀。依赖 §58 的 x58_paid_preparing、§59 的 x59_cb / x59_bk。
echo "== 61. 邮寄轨迹：订阅参数/推送落库最新在上/覆盖/去重/验签/签收→完成/先补取件/取消单忽略/顾客契约 =="
X61_CB=/tmp/e2e-xtrack.json
x61_track() { # bookingNo status ischeck state itemsJson → HTTP 码；响应体在 $X61_CB
  local bn="$1" st="$2" chk="$3" state="$4" items="$5" salt param sign
  salt=$(req GET "/api/admin/system/express-mock/salt/$bn" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg s "$st" --arg c "$chk" --arg st2 "$state" --argjson d "$items" '{status:$s, billstatus:"got", message:"", lastResult:{message:"ok", nu:"JD-TRK-61", ischeck:$c, com:"jd", state:$st2, data:$d}}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$X61_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$bn/track" --data-urlencode "param=$param" --data-urlencode "sign=$sign"
}
x61_cust() { req GET "/api/orders/$1" "$UT"; }
X61_I1='[{"context":"【自贡市】已揽收","ftime":"2026-09-10 10:00:00"}]'
X61_I2='[{"context":"【自贡市】已揽收","ftime":"2026-09-10 10:00:00"},{"context":"【成都市】运输中","ftime":"2026-09-10 12:00:00","areaName":"成都"}]'

echo "-- ① 下单参数带 op=1 与 pollCallBackUrl --"
X61_O=$(x58_paid_preparing)
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST "/api/admin/express/orders/$X61_O/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN=$(x59_bk "$X61_O" | jq -r .data.booking.bookingNo)
R=$(req GET "/api/admin/system/express-mock/calls?op=book" "$AT")
assert_eq "book 入参 pollCallbackUrl 指向 /track" "$(jq -r '.data[-1].input.pollCallbackUrl' <<<"$R" | sed "s|.*/api/kd-express/||")" "$X61_BN/track"
assert_eq "顾客契约：无轨迹时 track=null" "$(x61_cust "$X61_O" | jq -c .data.track)" "null"
x59_cb "$X61_BN" 10 '{"kuaidinum":"JD-TRK-61"}' >/dev/null
assert_eq "起点 PICKED" "$(x59_bk "$X61_O" | jq -r .data.booking.status)" "PICKED"

echo "-- ② 推送落库：最新在上；第二次整体覆盖不是追加；重推去重；验签失败不写 --"
HTTPC=$(x61_track "$X61_BN" polling 0 0 "$X61_I1"); assert_eq "轨迹推送 HTTP 200" "$HTTPC" "200"
assert_eq "ack result=true" "$(jq -r .result "$X61_CB")" "true"
R=$(x61_cust "$X61_O"); assert_eq "顾客 track 1 条" "$(jq -r '.data.track.items|length' <<<"$R")" "1"; assert_eq "未签收" "$(jq -r .data.track.signed <<<"$R")" "false"
x61_track "$X61_BN" polling 0 0 "$X61_I2" >/dev/null
R=$(x61_cust "$X61_O"); assert_eq "覆盖后 2 条（不是 3）" "$(jq -r '.data.track.items|length' <<<"$R")" "2"
assert_eq "最新在上" "$(jq -r '.data.track.items[0].context' <<<"$R")" "【成都市】运输中"
assert_eq "顾客契约：条目只有 context/ftime" "$(jq -c '.data.track.items[0]|keys' <<<"$R")" '["context","ftime"]'
R=$(x59_bk "$X61_O"); assert_eq "抽屉最新轨迹" "$(jq -r .data.booking.latestTrack.context <<<"$R")" "【成都市】运输中"; assert_eq "trackCount 2" "$(jq -r .data.booking.trackCount <<<"$R")" "2"; assert_eq "trackStatus polling" "$(jq -r .data.booking.trackStatus <<<"$R")" "polling"
X61_EV=$(jq -r '.data.events|length' <<<"$R")
x61_track "$X61_BN" polling 0 0 "$X61_I2" >/dev/null
assert_eq "同一条重推：事件数不变" "$(x59_bk "$X61_O" | jq -r '.data.events|length')" "$X61_EV"
HTTPC=$(curl -s -o "$X61_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$X61_BN/track" --data-urlencode 'param={"status":"polling","lastResult":{"ischeck":"1","data":[]}}' --data-urlencode "sign=DEADBEEF")
assert_eq "验签失败 HTTP 200" "$HTTPC" "200"; assert_eq "验签失败不签收仍 PICKED" "$(x59_bk "$X61_O" | jq -r .data.booking.status)" "PICKED"
assert_eq "验签失败不覆盖轨迹" "$(x61_cust "$X61_O" | jq -r '.data.track.items|length')" "2"
HTTPC=$(curl -s -o "$X61_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/E999999-9/track" --data-urlencode 'param={}' --data-urlencode "sign=DEADBEEF"); assert_eq "未知单号 200" "$HTTPC" "200"

echo "-- ③ 签收：ischeck=1 → DELIVERED、订单 COMPLETED、completedAt 有值；签收后尾随推送仍落 JSON --"
x61_track "$X61_BN" shutdown 1 3 '[{"context":"已签收，签收人：本人","ftime":"2026-09-11 09:00:00"},{"context":"【成都市】运输中","ftime":"2026-09-10 12:00:00"}]' >/dev/null
R=$(x59_bk "$X61_O"); assert_eq "DELIVERED" "$(jq -r .data.booking.status <<<"$R")" "DELIVERED"; assert_eq "不再活跃" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "订单 COMPLETED" "$(order_status $X61_O)" "COMPLETED"
assert_eq "completedAt 有值" "$(sql "SELECT IF(completed_at IS NULL,'NULL','SET') FROM orders WHERE id=$X61_O;")" "SET"
R=$(x61_cust "$X61_O"); assert_eq "顾客 signed=true" "$(jq -r .data.track.signed <<<"$R")" "true"; assert_eq "顾客 expressBooking DELIVERED" "$(jq -r .data.expressBooking.status <<<"$R")" "DELIVERED"
x61_track "$X61_BN" shutdown 1 3 '[{"context":"已签收，签收人：本人（补）","ftime":"2026-09-11 09:00:01"}]' >/dev/null
assert_eq "签收后尾随推送仍更新轨迹" "$(x61_cust "$X61_O" | jq -r '.data.track.items[0].context')" "已签收，签收人：本人（补）"
assert_eq "尾随推送不改状态" "$(x59_bk "$X61_O" | jq -r .data.booking.status)" "DELIVERED"

echo "-- ④ 10 没推到就先来签收：先补 PICKED（订单 SHIPPED + Shipment）再 DELIVERED --"
X61_O2=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN2=$(x59_bk "$X61_O2" | jq -r .data.booking.bookingNo)
x61_track "$X61_BN2" shutdown 1 3 '[{"context":"已签收","ftime":"2026-09-11 09:00:00"}]' >/dev/null
R=$(x59_bk "$X61_O2"); assert_eq "BOOKED 直接签收 → DELIVERED" "$(jq -r .data.booking.status <<<"$R")" "DELIVERED"
assert_eq "pickedAt 也补上了" "$(jq -r '.data.booking.pickedAt != null' <<<"$R")" "true"
assert_eq "订单 COMPLETED（经过 SHIPPED）" "$(order_status $X61_O2)" "COMPLETED"
assert_eq "Shipment 单号取轨迹 nu、有 shippedAt" "$(sql "SELECT CONCAT(express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X61_O2;")" "JD-TRK-61|SET"

echo "-- ⑤ abort 只留痕不改状态；取消的预约来轨迹只留痕不写 JSON --"
X61_O3=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O3/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN3=$(x59_bk "$X61_O3" | jq -r .data.booking.bookingNo)
HTTPC=$(x61_track "$X61_BN3" abort 0 0 '[]'); assert_eq "abort HTTP 200" "$HTTPC" "200"
R=$(x59_bk "$X61_O3"); assert_eq "abort 不改状态" "$(jq -r .data.booking.status <<<"$R")" "BOOKED"; assert_eq "abort 留痕事件" "$(jq -r '[.data.events[]|select(.source=="TRACK")]|length' <<<"$R")" "1"
req POST "/api/admin/express/orders/$X61_O3/booking/cancel" "$AT" '{}' >/dev/null
x61_track "$X61_BN3" polling 0 0 "$X61_I1" >/dev/null
assert_eq "取消后来轨迹：顾客 track 仍 null" "$(x61_cust "$X61_O3" | jq -c .data.track)" "null"
assert_eq "取消后来轨迹：只留痕" "$(x59_bk "$X61_O3" | jq -r '[.data.events[]|select(.source=="TRACK")]|length')" "2"

echo "-- ⑤b abort 且条目为空不清空已有轨迹 --"
X61_O3B=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O3B/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN3B=$(x59_bk "$X61_O3B" | jq -r .data.booking.bookingNo)
x61_track "$X61_BN3B" polling 0 0 "$X61_I1" >/dev/null
x61_track "$X61_BN3B" abort 0 0 '[]' >/dev/null
assert_eq "abort 空条目不清空轨迹" "$(x61_cust "$X61_O3B" | jq -r '.data.track.items|length')" "1"
req POST "/api/admin/express/orders/$X61_O3B/booking/cancel" "$AT" '{}' >/dev/null

echo "-- ⑥ 老邮寄单（手填单号）契约不变：expressBooking/track 都是 null --"
X61_O4=$(x58_paid_preparing)
req POST "/api/admin/orders/$X61_O4/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"SF-OLD-61"}' >/dev/null
R=$(x61_cust "$X61_O4"); assert_eq "老单 expressBooking=null" "$(jq -c .data.expressBooking <<<"$R")" "null"; assert_eq "老单 track=null" "$(jq -c .data.track <<<"$R")" "null"
assert_eq "老单 Shipment 照旧" "$(jq -r .data.shipment.expressNo <<<"$R")" "SF-OLD-61"
echo "-- ⑦ 对账：时段过期未取件 → detail 补 10；取件超 10 天 → detail 补 13；查不到只提醒一次、间隔内不重查 --"
X61_O5=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O5/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN5=$(x59_bk "$X61_O5" | jq -r .data.booking.bookingNo)
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "时段未过：不查单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "时段未过：detail 未被调" "$(req GET "/api/admin/system/express-mock/calls?op=detail" "$AT" | jq -r '.data|length')" "0"
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN5';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":10,"kuaidinum":"JD-ST-61"}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "过期查单：推进 1 单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "1"
R=$(x59_bk "$X61_O5"); assert_eq "detail 10 → PICKED" "$(jq -r .data.booking.status <<<"$R")" "PICKED"; assert_eq "补单号" "$(jq -r .data.booking.kuaidinum <<<"$R")" "JD-ST-61"
assert_eq "订单 SHIPPED" "$(order_status $X61_O5)" "SHIPPED"
assert_eq "对账事件留痕 SYSTEM" "$(jq -r '[.data.events[]|select(.source=="SYSTEM" and (.statusDesc|test("对账")))]|length' <<<"$R")" "1"
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "PICKED 未满 10 天：不查" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
sql "UPDATE express_bookings SET picked_at=DATE_SUB(NOW(), INTERVAL 11 DAY), stale_checked_at=NULL WHERE booking_no='$X61_BN5';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":13}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "取件超期查单：推进 1 单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "1"
assert_eq "detail 13 → DELIVERED" "$(x59_bk "$X61_O5" | jq -r .data.booking.status)" "DELIVERED"
assert_eq "订单 COMPLETED" "$(order_status $X61_O5)" "COMPLETED"
# 查不到：提醒一次、计次；间隔 30 分钟内不重查
X61_O6=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O6/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN6=$(x59_bk "$X61_O6" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN6';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "查不到：不推进" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "查不到：仍 BOOKED" "$(x59_bk "$X61_O6" | jq -r .data.booking.status)" "BOOKED"
assert_eq "查不到：提醒已打标" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN6';")" "SET"
X61_REM=$(sql "SELECT stale_reminded_at FROM express_bookings WHERE booking_no='$X61_BN6';")
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}')
assert_eq "第二轮：计次 2" "$(sql "SELECT stale_tries FROM express_bookings WHERE booking_no='$X61_BN6';")" "2"
assert_eq "第二轮：提醒时间不变（只一次）" "$(sql "SELECT stale_reminded_at FROM express_bookings WHERE booking_no='$X61_BN6';")" "$X61_REM"
X61_DET=$(req GET "/api/admin/system/express-mock/calls?op=detail" "$AT" | jq -r '.data|length')
R=$(sched '{"expressStaleIntervalMin":30}')
assert_eq "30 分钟内不重查（detail 调用数不变）" "$(req GET "/api/admin/system/express-mock/calls?op=detail" "$AT" | jq -r '.data|length')" "$X61_DET"
req POST "/api/admin/express/orders/$X61_O6/booking/cancel" "$AT" '{}' >/dev/null
# 快照直接跳到「已签收」（BOOKED 未经 10 揽收回调）：不能被 applyProviderStatus 的回调流假设坑了——
# 得先补一步 10（订单联动/Shipment/发货通知）再套真实的 13，否则订单卡在 PREPARING、Shipment 缺 shippedAt
X61_O7=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O7/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN7=$(x59_bk "$X61_O7" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN7';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":13,"kuaidinum":"JD-ST-13"}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "快照直接跳签收：推进 1 单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "1"
assert_eq "BOOKED 快照 13 → DELIVERED（补记取件）" "$(x59_bk "$X61_O7" | jq -r .data.booking.status)" "DELIVERED"
assert_eq "补记 pickedAt" "$(sql "SELECT IF(picked_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN7';")" "SET"
assert_eq "订单直接 COMPLETED" "$(order_status $X61_O7)" "COMPLETED"
assert_eq "Shipment 补单号" "$(sql "SELECT express_no FROM shipments WHERE order_id=$X61_O7;")" "JD-ST-13"
assert_eq "Shipment 补 shipped_at" "$(sql "SELECT IF(shipped_at IS NULL,'NULL','SET') FROM shipments WHERE order_id=$X61_O7;")" "SET"
# 快照是「在途/派送中」（101/400，IGNORE）：同样先补 10，第二步 101 本身不动状态，但已经算「有进展」不再提醒
X61_O8=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O8/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN8=$(x59_bk "$X61_O8" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN8';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":101}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "快照在途 101：推进 1 单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "1"
assert_eq "BOOKED 快照 101 → PICKED（补记取件）" "$(x59_bk "$X61_O8" | jq -r .data.booking.status)" "PICKED"
assert_eq "订单 SHIPPED" "$(order_status $X61_O8)" "SHIPPED"
assert_eq "有进展不占提醒名额" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN8';")" "NULL"
# detail 超时（ERROR）不算「无结论」：不占用一次性提醒名额、也不误判成查无进展；下一轮真的查不到才补提醒
X61_O9=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O9/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN9=$(x59_bk "$X61_O9" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN9';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"timeout"}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "detail 超时：不算推进" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "detail 超时：计次 1" "$(sql "SELECT stale_tries FROM express_bookings WHERE booking_no='$X61_BN9';")" "1"
assert_eq "detail 超时：不占用提醒名额" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN9';")" "NULL"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "查不到：这次才计入无结论" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "查不到后提醒补打标" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN9';")" "SET"
req POST "/api/admin/express/orders/$X61_O9/booking/cancel" "$AT" '{}' >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null

X61_KEEP_O=$X61_O   # DELIVERED，留给 §62/工作台走查
