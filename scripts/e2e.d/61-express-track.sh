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

echo "-- ⑥ 老邮寄单（手填单号）契约不变：expressBooking/track 都是 null --"
X61_O4=$(x58_paid_preparing)
req POST "/api/admin/orders/$X61_O4/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"SF-OLD-61"}' >/dev/null
R=$(x61_cust "$X61_O4"); assert_eq "老单 expressBooking=null" "$(jq -c .data.expressBooking <<<"$R")" "null"; assert_eq "老单 track=null" "$(jq -c .data.track <<<"$R")" "null"
assert_eq "老单 Shipment 照旧" "$(jq -r .data.shipment.expressNo <<<"$R")" "SF-OLD-61"
X61_KEEP_O=$X61_O   # DELIVERED，留给 §62/工作台走查
