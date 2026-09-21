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
R=$(p62_put '.pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1 | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"PERCENT",value:95} | .pickup.autoCompleteAfterMin=120 | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=20 | .peak.windows=[] | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .pickup.paused=null | .packing.enabled=false')
# .packing.enabled=false：本段验自取优惠与券的封顶公式，打包费（§63 单独验）会让「券把实付减到 0 → 42251」这条永远打不到 0；收尾恢复 ORIG。
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
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"123\"}}")
assert_eq "手机号无效 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:07:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "非整格时段 42281" "$(code "$R")" "42281"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"addressId\":1,\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "自取带 addressId 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"name\":\"张三\",\"phone\":\"13800001234\"}}")
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
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "未达自取起送 42282" "$(code "$R")" "42282"
p62_put '.pickup.minOrderAmountFen=0' >/dev/null
# 一张面额 = 原小计 的券：门槛=原小计（刚好可用），面额本应抵到 0，自取单要封顶到 小计−自取优惠，实付 = 0 → 42251 拒
P62_TID=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E自取大券\",\"amount\":$P62_PRICE,\"threshold\":$P62_PRICE,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P62_CID=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P62_TID}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800001234\"},\"couponId\":$P62_CID}")
assert_eq "券把实付减到 0 → 42251" "$(code "$R")" "42251"
# 面额 = 自取优惠 + 100 的券：封顶后仍是原面额（未超过 小计−自取优惠），实付 = 小计 − 自取优惠 − 面额
P62_TID2=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E自取小券\",\"amount\":$((P62_DISC+100)),\"threshold\":$P62_PRICE,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P62_CID2=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P62_TID2}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800001234\"},\"couponId\":$P62_CID2}")
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
# O2 建单时用的 P62_SLOT2（第 4 格）相对「现在」的偏移量约 115–145 分钟，天然跨在两小时自助取消截止两侧，
# 随脚本跑到这里已流逝的时间而漂移——钉到 90 分钟后确定性地落进「距取餐不足两小时」一侧。
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 90 MINUTE) WHERE id=$P62_O2;"
R=$(req PUT "/api/orders/$P62_O2/cancel" "$UT")
assert_eq "付款后、距取餐不足两小时自助取消 42229（2026-09-21 起）" "$(code "$R")" "42229"
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 3 HOUR) WHERE id=$P62_O2;"
R=$(req PUT "/api/orders/$P62_O2/cancel" "$UT")
assert_eq "钉到 3 小时后：自助取消 code 0" "$(code "$R")" "0"
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
P62_TODAY=$(TZ=Asia/Shanghai date +%F)
p62_put ".holiday={until:\"$P62_TODAY\",reason:\"盘点\"}" >/dev/null
R=$(req GET /api/local/pickup-slots)
assert_eq "休业：今天没有格（明天仍可能有）" "$(jq -r "[.data.days[] | select(.date==\"$P62_TODAY\")] | length" <<<"$R")" "0"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "休业下单 42280" "$(code "$R")" "42280"
[[ "$(jq -r .message <<<"$R")" == *"休息"* ]] && ok "休业文案含「休息」" || fail "休业文案不对" "$R"
p62_put '.holiday=null | .pickup.paused={until:null,reason:"后厨忙"}' >/dev/null
assert_eq "自取暂停 blocked=PAUSED" "$(req GET /api/local/pickup-slots | jq -r '.data.blocked.kind')" "PAUSED"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "自取暂停下单 42280" "$(code "$R")" "42280"
assert_eq "自取暂停不影响外送开关" "$(req GET /api/local/meta | jq -r '.data.delivery.enabled')" "$(jq -r '.enabled' <<<"$P62_ORIG")"
p62_put '.pickup.paused=null' >/dev/null
R=$(req GET "/api/orders?channel=EXPRESS&pageSize=50" "$UT")
assert_eq "channel=EXPRESS 全是邮寄" "$(jq -r '[.data.list[] | select(.deliveryType!="EXPRESS")] | length' <<<"$R")" "0"
R=$(req GET "/api/orders?channel=FOO" "$UT")
[[ "$(code "$R")" != "0" ]] && ok "非法 channel 报错不静默" || fail "非法 channel 被静默放过" "$R"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
P62_O7=$(jq -r .data.orderId <<<"$R")
assert_eq "不填姓名落库为「顾客」" "$(sql "SELECT receiver_name FROM orders WHERE id=$P62_O7;")" "顾客"
assert_eq "pickup-contact 把「顾客」映射成空串" "$(req GET /api/orders/pickup-contact "$UT" | jq -r '.data.name')" ""
assert_eq "地址快照：省" "$(sql "SELECT receiver_province FROM orders WHERE id=$P62_O7;")" "$(jq -r '.store.province' <<<"$P62_ORIG")"
assert_eq "地址快照：同城坐标列为空" "$(sql "SELECT receiver_lat_e6 IS NULL AND distance_m IS NULL FROM orders WHERE id=$P62_O7;")" "1"
assert_eq "无 Shipment 行" "$(sql "SELECT COUNT(*) FROM shipments WHERE order_id=$P62_O7;")" "0"
req PUT "/api/orders/$P62_O7/cancel" "$UT" >/dev/null

echo "-- ⑧ 状态流：接单（通用 accept）→ 已备好（视同驳回取消申请）→ 已取走；同城 accept 拒 --"
R=$(req POST "/api/admin/local/orders/$P62_O1/accept" "$AT")
assert_eq "同城看板 accept 拒自取 42204" "$(code "$R")" "42204"
R=$(req POST "/api/admin/orders/$P62_O1/picked-up" "$AT")
assert_eq "PAID 点已取走 42204" "$(code "$R")" "42204"
R=$(req POST "/api/admin/orders/$P62_O1/accept" "$AT")
assert_eq "接单 code 0" "$(code "$R")" "0"
assert_eq "→ PREPARING" "$(p62_ord "$P62_O1" | jq -r .data.status)" "PREPARING"
R=$(req POST "/api/admin/orders/$P62_O1/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"SF1"}')
assert_eq "自取单填单号发货 42284" "$(code "$R")" "42284"
R=$(req POST "/api/admin/orders/$P62_O1/pickup-ready" "$AT")
assert_eq "已备好 code 0" "$(code "$R")" "0"
assert_eq "→ SHIPPED（待取餐）" "$(p62_ord "$P62_O1" | jq -r .data.status)" "SHIPPED"
assert_eq "pickup_ready_at 已写" "$(sql "SELECT pickup_ready_at IS NOT NULL FROM orders WHERE id=$P62_O1;")" "1"
assert_eq "备好视同驳回：cancel_requested_at 清空" "$(sql "SELECT cancel_requested_at IS NULL FROM orders WHERE id=$P62_O1;")" "1"
assert_eq "驳回痕迹 MANUAL" "$(sql "SELECT cancel_request_rejected_by FROM orders WHERE id=$P62_O1;")" "MANUAL"
R=$(req POST "/api/admin/orders/$P62_O1/complete" "$AT")
assert_eq "自取单「标记完成」42284" "$(code "$R")" "42284"
R=$(req PUT "/api/orders/$P62_O1/confirm" "$UT")
assert_eq "顾客确认收货对自取 42284" "$(code "$R")" "42284"
assert_eq "待取餐后 canRequestCancel=false" "$(req GET "/api/orders/$P62_O1" "$UT" | jq -r '.data.canRequestCancel')" "false"
R=$(req POST "/api/admin/orders/$P62_O1/picked-up" "$AT")
assert_eq "已取走 code 0" "$(code "$R")" "0"
assert_eq "→ COMPLETED" "$(p62_ord "$P62_O1" | jq -r .data.status)" "COMPLETED"

echo "-- ⑨ 工作台快照：自取卡带 pickup 节且排在同城之后、邮寄之前 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800005678\"}}")
P62_O3=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O3/pay" "$UT" >/dev/null
R=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT")
P62_CARD=$(jq -c ".data.columns.pending[] | select(.orderId==$P62_O3)" <<<"$R")
[[ -n "$P62_CARD" ]] && ok "自取单在 pending 列" || fail "自取单不在 pending 列" "$R"
assert_eq "卡片 channel=PICKUP" "$(jq -r .channel <<<"$P62_CARD")" "PICKUP"
assert_eq "卡片 pickup.slotLabel 非空" "$(jq -r '.pickup.slotLabel | length > 0' <<<"$P62_CARD")" "true"
assert_eq "卡片 pickup.prepStartAt 非空" "$(jq -r '.pickup.prepStartAt != null' <<<"$P62_CARD")" "true"
assert_eq "卡片 local=null、express=null" "$(jq -r '[.local,.express] | map(. == null) | all' <<<"$P62_CARD")" "true"
assert_eq "快照顶层 pickupEnabled=true" "$(jq -r '.data.pickupEnabled' <<<"$R")" "true"
P62_RANKS=$(jq -r '.data.columns.pending | map(.channel) | map(if .=="LOCAL" then 0 elif .=="PICKUP" then 1 else 2 end) | . == sort' <<<"$R")
assert_eq "pending 列排序 同城 < 自取 < 邮寄" "$P62_RANKS" "true"

echo "-- ⑩ 取消申请：同意 = 全额退并清标记；驳回留痕；admin 列表 channel=LOCAL 含自取 --"
req POST "/api/admin/orders/$P62_O3/accept" "$AT" >/dev/null
# P62_SLOT2（第 4 格）相对当前时刻的偏移落在约 115–145 分钟，会跨在两小时自助取消截止（selfCancelLeadMin=120，
# 2026-09-21 起自取共用）两侧、随脚本跑到这里时已流逝的时间而漂移——钉到 90 分钟后确定性地落进「已超自助取消窗口，
# 需走申请取消」一侧（canRequestCancel=true），不然本段会随时钟偶发红/绿。
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 90 MINUTE) WHERE id=$P62_O3;"
R=$(req POST "/api/orders/$P62_O3/cancel-request" "$UT" '{"note":"不要了"}')
assert_eq "接单后申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/orders/$P62_O3/cancel-request/reject" "$AT")
assert_eq "驳回 code 0" "$(code "$R")" "0"
assert_eq "驳回后 cancelRequestRejectedBy=MANUAL" "$(jq -r .data.cancelRequestRejectedBy <<<"$R")" "MANUAL"
R=$(req POST "/api/orders/$P62_O3/cancel-request" "$UT" '{"note":"再申请一次"}')
assert_eq "驳回后可再申请 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/orders/$P62_O3/cancel-request/approve" "$AT")
assert_eq "同意 code 0" "$(code "$R")" "0"
assert_eq "同意 isFull=true" "$(jq -r .data.isFull <<<"$R")" "true"
assert_eq "O3 → REFUNDED" "$(p62_ord "$P62_O3" | jq -r .data.status)" "REFUNDED"
assert_eq "同意后标记清空" "$(sql "SELECT cancel_requested_at IS NULL FROM orders WHERE id=$P62_O3;")" "1"
R=$(req GET "/api/admin/orders?channel=LOCAL&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$P62_O3)] | length" <<<"$R")" == "1" ]] && ok "admin 列表 channel=LOCAL 含自取" || fail "admin 列表 channel=LOCAL 不含自取"
[[ "$(req GET /api/admin/orders/pending-count "$AT" | jq -r '.data.localPendingCount')" -ge 0 ]] && ok "pending-count 仍可用" || fail "pending-count 挂了"

echo "-- ⑪ 小票：自取单出票票头「到店自取」、印取餐时间与自取优惠、不印运费 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"P62-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800009999\"}}")
P62_O4=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O4/pay" "$UT" >/dev/null
sleep 0.5
P62_T=$(PJOBS "$P62_O4" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$P62_T" == *"到店自取"* ]] && ok "票头 到店自取" || fail "票头不对" "$P62_T"
[[ "$P62_T" == *"<B>取餐 "* ]] && ok "印取餐时间" || fail "没印取餐时间" "$P62_T"
[[ "$P62_T" == *"自取优惠：−"* ]] && ok "印自取优惠" || fail "没印自取优惠" "$P62_T"
[[ "$P62_T" != *"运费："* ]] && ok "不印运费" || fail "自取票印了运费" "$P62_T"
[[ "$P62_T" == *"尾号9999"* ]] && ok "尾号正确" || fail "尾号不对" "$P62_T"
[[ "$P62_T" == *"厨房联"* ]] && ok "有厨房联" || fail "没有厨房联" "$P62_T"

echo "-- ⑫ 催单基准：明天的自取单付款 15 分钟后不催；开始备餐前 15 分钟才催 --"
P62_TOMORROW=$(req GET /api/local/pickup-slots | jq -r '[.data.days[] | select(.label=="明天") | .slots[]][0].startAt')
[[ -n "$P62_TOMORROW" && "$P62_TOMORROW" != "null" ]] && ok "拿到明天的格" || fail "明天没有格"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_TOMORROW\",\"pickupContact\":{\"phone\":\"13800002222\"}}")
P62_O5=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O5/pay" "$UT" >/dev/null
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE id=$P62_O5;"
# 钉到 20 小时后：开始备餐−15 分钟 ≈ 19.5 小时后，不受跑脚本的时刻影响
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 20 HOUR) WHERE id=$P62_O5;"
sched '{}' >/dev/null
assert_eq "明天的单付款 20 分钟未催" "$(sql "SELECT accept_reminded_at IS NULL FROM orders WHERE id=$P62_O5;")" "1"
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 30 MINUTE) WHERE id=$P62_O5;"   # 开始备餐 = 30−25 = 5 分钟后，−15 已过
R=$(sched '{}')
[[ "$(jq -r '.data.pickupUnaccepted // -1' <<<"$R")" -ge 1 ]] && ok "到点催单 pickupUnaccepted≥1" || fail "没催" "$R"
assert_eq "accept_reminded_at 已写" "$(sql "SELECT accept_reminded_at IS NOT NULL FROM orders WHERE id=$P62_O5;")" "1"
assert_eq "通用催单任务没重复催自取单（仍只有一次标记）" "$(sql "SELECT COUNT(*) FROM orders WHERE id=$P62_O5 AND accept_reminded_at IS NOT NULL;")" "1"

echo "-- ⑬ 过时未取提醒一次 → 自动完成；自取单不被取消申请自动驳回任务碰 --"
req POST "/api/admin/orders/$P62_O5/accept" "$AT" >/dev/null
req POST "/api/admin/orders/$P62_O5/pickup-ready" "$AT" >/dev/null
assert_eq "O5 待取餐" "$(p62_ord "$P62_O5" | jq -r .data.status)" "SHIPPED"
sql "UPDATE orders SET pickup_at=DATE_SUB(NOW(3), INTERVAL 40 MINUTE) WHERE id=$P62_O5;"
R=$(sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":120}')
[[ "$(jq -r '.data.pickupUnpicked // -1' <<<"$R")" -ge 1 ]] && ok "过时未取提醒 ≥1" || fail "未提醒" "$R"
assert_eq "仍是 SHIPPED（120 分钟未到）" "$(p62_ord "$P62_O5" | jq -r .data.status)" "SHIPPED"
R=$(sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":120}')
assert_eq "第二轮不重复提醒" "$(jq -r '.data.pickupUnpicked // -1' <<<"$R")" "0"
R=$(sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":30}')
[[ "$(jq -r '.data.pickupAutoComplete // -1' <<<"$R")" -ge 1 ]] && ok "自动完成 ≥1" || fail "未自动完成" "$R"
assert_eq "O5 → COMPLETED" "$(p62_ord "$P62_O5" | jq -r .data.status)" "COMPLETED"
# 自动驳回任务：造一张 PREPARING 且申请取消、接单已超 10 分钟的自取单，跑一轮，申请必须还在
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_TOMORROW\",\"pickupContact\":{\"phone\":\"13800003333\"}}")
P62_O6=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O6/pay" "$UT" >/dev/null
req POST "/api/admin/orders/$P62_O6/accept" "$AT" >/dev/null
req POST "/api/orders/$P62_O6/cancel-request" "$UT" '{"note":"不要了"}' >/dev/null
sql "UPDATE orders SET accepted_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id=$P62_O6;"
sched '{"cancelAutoRejectMin":1}' >/dev/null
assert_eq "自取单的取消申请不被自动驳回" "$(sql "SELECT cancel_requested_at IS NOT NULL FROM orders WHERE id=$P62_O6;")" "1"
req POST "/api/admin/orders/$P62_O6/cancel-request/approve" "$AT" >/dev/null

echo "-- 收尾：恢复同城设置、停用本段券模板、清本段打印作业 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P62_ORIG" >/dev/null
for t in ${P62_TID:-} ${P62_TID2:-}; do req PUT "/api/admin/coupon-templates/$t" "$AT" '{"status":"OFF"}' >/dev/null 2>&1 || true; done
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
sql "DELETE FROM print_jobs WHERE order_id IN ($P62_O1,$P62_O3,$P62_O4,$P62_O5,$P62_O6);"
# O4 只用来验小票，仍是 PAID：取消掉，免得下一轮的「未接单重复播报」一直催它
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 收尾' WHERE id=$P62_O4 AND status='PAID';"
