echo "== 62. 到店自取：设置 / 时段 / 下单计价 / 取消 / 状态流 / 定时任务 =="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sched/sql/PJOBS；$UT/$AT/$LPID（同城商品）。变量一律 P62_ 前缀。
# 时段生成看真实时钟：营业时段钉成 00:00–23:59、daysAhead=1，任何时刻至少明天有格。
# 备餐 20 + 缓冲 5，最早格 = 现在 + 25 分钟向上取整到半点，所以「尽快格」的 prepStartAt 一定在未来 ≤ 30 分钟内。
P62_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
p62_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p62_ord() { req GET "/api/admin/orders/$1" "$AT"; }
P62_PRICE=$(req GET "/api/products/$LPID" "$UT" | jq -r '.data.price')

echo "-- ① 未开通：时段 blocked=DISABLED，下单 42280 --"
p62_put '.pickup.enabled=false | .holiday=null' >/dev/null
assert_eq "未开通 blocked=DISABLED" "$(req GET /api/local/pickup-slots | jq -r '.data.blocked.kind')" "DISABLED"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:00:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "未开通下单 42280" "$(code "$R")" "42280"

echo "-- ② 开通：meta 分节、时段有格、外送开关独立 --"
R=$(p62_put '.pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1 | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"PERCENT",value:95} | .pickup.autoCompleteAfterMin=120 | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=20 | .peak.windows=[] | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .pickup.paused=null')
assert_eq "开通自取 code 0" "$(code "$R")" "0"
R=$(req GET /api/local/meta)
assert_eq "meta.pickup.enabled=true" "$(jq -r '.data.pickup.enabled' <<<"$R")" "true"
assert_eq "meta.pickup.discountText=自取享 9.5 折" "$(jq -r '.data.pickup.discountText' <<<"$R")" "自取享 9.5 折"
assert_eq "meta.delivery.enabled 与老字段 enabled 一致" "$(jq -r '.data.delivery.enabled' <<<"$R")" "$(jq -r '.data.enabled' <<<"$R")"
[[ "$(jq -r '.data.businessHours | length' <<<"$R")" -ge 1 ]] && ok "老字段 businessHours 仍下发" || fail "老字段 businessHours 丢了"
R=$(req GET /api/local/pickup-slots)
assert_eq "时段 blocked=null" "$(jq -r '.data.blocked' <<<"$R")" "null"
P62_SLOT=$(jq -r '[.data.days[].slots[]][0].startAt' <<<"$R")
P62_SLOT2=$(jq -r '[.data.days[].slots[]][3].startAt' <<<"$R")
[[ "$P62_SLOT" != "null" && -n "$P62_SLOT" ]] && ok "拿到最早格 $P62_SLOT" || fail "没有可选时段" "$R"
assert_eq "earliestAt = 第一格" "$(jq -r '.data.earliestAt' <<<"$R")" "$P62_SLOT"

echo "-- ③ 下单：手机号校验、非整格 42281、计价（9.5 折 + 运费 0）、门店地址快照 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"123\"}}")
assert_eq "手机号无效 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:07:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "非整格时段 42281" "$(code "$R")" "42281"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"addressId\":1,\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "自取带 addressId 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"name\":\"张三\",\"phone\":\"13800001234\"}}")
assert_eq "自取下单 code 0" "$(code "$R")" "0"
P62_O1=$(jq -r .data.orderId <<<"$R")
P62_DISC=$(( P62_PRICE - (P62_PRICE * 95 + 50) / 100 ))   # round(price×0.95)：整数四舍五入
assert_eq "pickupDiscountAmount = 5%" "$(jq -r .data.pickupDiscountAmount <<<"$R")" "$P62_DISC"
assert_eq "shippingFee=0" "$(jq -r .data.shippingFee <<<"$R")" "0"
assert_eq "actualAmount = 小计 − 自取优惠" "$(jq -r .data.actualAmount <<<"$R")" "$((P62_PRICE - P62_DISC))"
assert_eq "subscribeTemplates.pickup 是数组" "$(jq -r '.data.subscribeTemplates.pickup | type' <<<"$R")" "array"
assert_eq "落库 delivery_type=PICKUP" "$(sql "SELECT delivery_type FROM orders WHERE id=$P62_O1;")" "PICKUP"
assert_eq "落库 pickup_at 非空" "$(sql "SELECT pickup_at IS NOT NULL FROM orders WHERE id=$P62_O1;")" "1"
assert_eq "取餐人姓名" "$(sql "SELECT receiver_name FROM orders WHERE id=$P62_O1;")" "张三"
[[ "$(sql "SELECT receiver_full_address FROM orders WHERE id=$P62_O1;")" == *"自贡"* ]] && ok "地址列是门店地址快照" || fail "地址列不是门店地址"
assert_eq "pickup-contact 回最近一单" "$(req GET /api/orders/pickup-contact "$UT" | jq -r '.data.phone')" "13800001234"

echo "-- ④ 起送门槛 42282；券叠加：门槛看原小计、面额封顶到小计−自取优惠 --"
p62_put ".pickup.minOrderAmountFen=$((P62_PRICE+1))" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "未达自取起送 42282" "$(code "$R")" "42282"
p62_put '.pickup.minOrderAmountFen=0' >/dev/null
# 一张面额 = 原小计 的券：门槛=原小计（刚好可用），面额本应抵到 0，自取单要封顶到 小计−自取优惠，实付 = 0 → 42251 拒
P62_TID=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E自取大券\",\"amount\":$P62_PRICE,\"threshold\":$P62_PRICE,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P62_CID=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P62_TID}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"},\"couponId\":$P62_CID}")
assert_eq "券把实付减到 0 → 42251" "$(code "$R")" "42251"
# 面额 = 自取优惠 + 100 的券：封顶后仍是原面额（未超过 小计−自取优惠），实付 = 小计 − 自取优惠 − 面额
P62_TID2=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E自取小券\",\"amount\":$((P62_DISC+100)),\"threshold\":$P62_PRICE,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P62_CID2=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P62_TID2}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"},\"couponId\":$P62_CID2}")
assert_eq "用券下单 code 0（门槛按原小计判）" "$(code "$R")" "0"
P62_O2=$(jq -r .data.orderId <<<"$R")
assert_eq "实付 = 小计 − 自取优惠 − 券" "$(jq -r .data.actualAmount <<<"$R")" "$((P62_PRICE - P62_DISC - P62_DISC - 100))"

echo "-- ⑤ 列表 channel=LOCAL 同时返回外送与自取；deliveryType=PICKUP 只回自取 --"
R=$(req GET "/api/orders?channel=LOCAL&pageSize=50" "$UT")
[[ "$(jq -r "[.data.list[] | select(.id==$P62_O1)] | length" <<<"$R")" == "1" ]] && ok "channel=LOCAL 含自取单" || fail "channel=LOCAL 不含自取单"
[[ "$(jq -r '[.data.list[] | select(.deliveryType=="LOCAL")] | length' <<<"$R")" -ge 1 ]] && ok "channel=LOCAL 含外送单" || fail "channel=LOCAL 不含外送单"
R=$(req GET "/api/orders?deliveryType=PICKUP&pageSize=50" "$UT")
assert_eq "deliveryType=PICKUP 全是自取" "$(jq -r '[.data.list[] | select(.deliveryType!="PICKUP")] | length' <<<"$R")" "0"

echo "-- ⑥ 详情 pickup 节；自助取消：未付款可取消；付款后未到开始备餐可秒退 --"
R=$(req GET "/api/orders/$P62_O1" "$UT")
assert_eq "详情 pickup.slotLabel 非空" "$(jq -r '.data.pickup.slotLabel | length > 0' <<<"$R")" "true"
assert_eq "详情 pickup.store.name" "$(jq -r '.data.pickup.store.name | length > 0' <<<"$R")" "true"
assert_eq "待付款 canSelfCancel=true" "$(jq -r '.data.canSelfCancel' <<<"$R")" "true"
req POST "/api/orders/$P62_O2/pay" "$UT" >/dev/null
assert_eq "O2 已付款" "$(p62_ord "$P62_O2" | jq -r .data.status)" "PAID"
R=$(req PUT "/api/orders/$P62_O2/cancel" "$UT")
assert_eq "付款后、开始备餐前自助取消 code 0" "$(code "$R")" "0"
assert_eq "O2 → REFUNDED（mock 即时）" "$(p62_ord "$P62_O2" | jq -r .data.status)" "REFUNDED"

echo "-- ⑦ 已到开始备餐时刻：自助取消 42229、可申请取消（PAID 也行）；接单后仍可申请 --"
req POST "/api/orders/$P62_O1/pay" "$UT" >/dev/null
sql "UPDATE orders SET pickup_at=DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id=$P62_O1;"
R=$(req PUT "/api/orders/$P62_O1/cancel" "$UT")
assert_eq "已过开始备餐时刻自助取消 42229" "$(code "$R")" "42229"
assert_eq "此时 canSelfCancel=false、canRequestCancel=true" "$(req GET "/api/orders/$P62_O1" "$UT" | jq -r '[.data.canSelfCancel,.data.canRequestCancel] | join(",")')" "false,true"
R=$(req POST "/api/orders/$P62_O1/cancel-request" "$UT" '{"note":"临时有事"}')
assert_eq "PAID 状态申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/orders/$P62_O1/cancel-request" "$UT" '{}')
assert_eq "重复申请 42229" "$(code "$R")" "42229"

echo "-- ⑦b 补测：确认收货对自取 42284；休业/自取暂停各自 42280 且时段 blocked；channel=EXPRESS 与非法值；取餐人空名 --"
R=$(req PUT "/api/orders/$P62_O1/confirm" "$UT")
assert_eq "顾客确认收货对自取 42284" "$(code "$R")" "42284"
P62_TODAY=$(date +%F)
p62_put ".holiday={until:\"$P62_TODAY\",reason:\"盘点\"}" >/dev/null
R=$(req GET /api/local/pickup-slots)
assert_eq "休业：今天没有格（明天仍可能有）" "$(jq -r "[.data.days[] | select(.date==\"$P62_TODAY\")] | length" <<<"$R")" "0"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "休业下单 42280" "$(code "$R")" "42280"
[[ "$(jq -r .message <<<"$R")" == *"休息"* ]] && ok "休业文案含「休息」" || fail "休业文案不对" "$R"
p62_put '.holiday=null | .pickup.paused={until:null,reason:"后厨忙"}' >/dev/null
assert_eq "自取暂停 blocked=PAUSED" "$(req GET /api/local/pickup-slots | jq -r '.data.blocked.kind')" "PAUSED"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "自取暂停下单 42280" "$(code "$R")" "42280"
assert_eq "自取暂停不影响外送开关" "$(req GET /api/local/meta | jq -r '.data.delivery.enabled')" "$(jq -r '.enabled' <<<"$P62_ORIG")"
p62_put '.pickup.paused=null' >/dev/null
R=$(req GET "/api/orders?channel=EXPRESS&pageSize=50" "$UT")
assert_eq "channel=EXPRESS 全是邮寄" "$(jq -r '[.data.list[] | select(.deliveryType!="EXPRESS")] | length' <<<"$R")" "0"
R=$(req GET "/api/orders?channel=FOO" "$UT")
[[ "$(code "$R")" != "0" ]] && ok "非法 channel 报错不静默" || fail "非法 channel 被静默放过" "$R"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
P62_O7=$(jq -r .data.orderId <<<"$R")
assert_eq "不填姓名落库为「顾客」" "$(sql "SELECT receiver_name FROM orders WHERE id=$P62_O7;")" "顾客"
assert_eq "pickup-contact 把「顾客」映射成空串" "$(req GET /api/orders/pickup-contact "$UT" | jq -r '.data.name')" ""
assert_eq "地址快照：省" "$(sql "SELECT receiver_province FROM orders WHERE id=$P62_O7;")" "$(jq -r '.store.province' <<<"$P62_ORIG")"
assert_eq "地址快照：同城坐标列为空" "$(sql "SELECT receiver_lat_e6 IS NULL AND distance_m IS NULL FROM orders WHERE id=$P62_O7;")" "1"
assert_eq "无 Shipment 行" "$(sql "SELECT COUNT(*) FROM shipments WHERE order_id=$P62_O7;")" "0"
req PUT "/api/orders/$P62_O7/cancel" "$UT" >/dev/null
