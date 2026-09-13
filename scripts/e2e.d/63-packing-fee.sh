echo "== 63. 打包费：下单接线、接口透传、小票（2026-09-13 打包费设计）=="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sql/PJOBS；$UT/$AT/$LADDR/$LCAT/$PID/$ADDR/lquote()/LQTOKEN。
# 变量一律 P63_ 前缀。自建商品 A/B（不复用 $LPID——它被广泛用于其它段落，覆盖它的 packingFeeFen
# 会让后续段落的红绿取决于本段是否先跑，参见 §49 同样的理由）。
P63_ORIG_LS=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
p63_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p63_ord() { req GET "/api/admin/orders/$1" "$AT"; }

echo "-- 前置：打包费默认开 ¥1/份；开通自取（照 §62 的参数）；自建商品 A（¥20）/B（¥15）--"
p63_put '.packing.enabled=true | .packing.perItemFen=100
  | .pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1
  | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"NONE",value:0} | .pickup.autoCompleteAfterMin=120
  | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=20 | .peak.windows=[]
  | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .pickup.paused=null
  | .paused=null | .enabled=true' >/dev/null
R=$(req GET /api/local/meta)
assert_eq "meta.packing.enabled=true" "$(jq -r '.data.packing.enabled' <<<"$R")" "true"
assert_eq "meta.packing.perItemFen=100" "$(jq -r '.data.packing.perItemFen' <<<"$R")" "100"
P63_SLOT=$(req GET /api/local/pickup-slots | jq -r '[.data.days[].slots[]][0].startAt')
[[ -n "$P63_SLOT" && "$P63_SLOT" != "null" ]] && ok "拿到自取时段 $P63_SLOT" || fail "没有可选时段"

R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E-PACK-A$RANDOM\",\"price\":2000,\"stock\":99,\"netWeightG\":300}")
P63_PA=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P63_PA" ]] && ok "创建商品 A #$P63_PA（¥20，跟随默认）" || fail "创建商品 A" "$R"
assert_eq "新建商品 packingFeeFen 未传 → null" "$(jq -r '.data.packingFeeFen' <<<"$R")" "null"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E-PACK-B$RANDOM\",\"price\":1500,\"stock\":99,\"netWeightG\":300}")
P63_PB=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P63_PB" ]] && ok "创建商品 B #$P63_PB（¥15）" || fail "创建商品 B" "$R"
R=$(req PUT "/api/admin/products/$P63_PB" "$AT" '{"packingFeeFen":0}')
assert_eq "商品 B PUT packingFeeFen=0 code 0" "$(code "$R")" "0"
assert_eq "商品 B 落库 packingFeeFen=0" "$(jq -r '.data.packingFeeFen' <<<"$R")" "0"

echo "-- 接口透传：商品详情/列表/购物车行 packingFeeFen 与 packingFeeEach --"
assert_eq "商品 A 详情 packingFeeEach=100（跟随默认）" "$(req GET "/api/products/$P63_PA" "$UT" | jq -r .data.packingFeeEach)" "100"
assert_eq "商品 B 详情 packingFeeEach=0" "$(req GET "/api/products/$P63_PB" "$UT" | jq -r .data.packingFeeEach)" "0"
R=$(req GET "/api/products?pageSize=50&channel=LOCAL" "$UT")
assert_eq "列表接口 A 也带 packingFeeEach=100" "$(jq -r "[.data.list[] | select(.id==$P63_PA)][0].packingFeeEach" <<<"$R")" "100"
assert_eq "列表接口 B 也带 packingFeeEach=0" "$(jq -r "[.data.list[] | select(.id==$P63_PB)][0].packingFeeEach" <<<"$R")" "0"
R=$(req POST /api/cart "$UT" "{\"productId\":$P63_PA,\"quantity\":1}")
P63_CA=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/cart "$UT" "{\"productId\":$P63_PB,\"quantity\":2}")
P63_CB=$(jq -r '.data.id // empty' <<<"$R")
R=$(req GET "/api/cart?channel=LOCAL" "$UT")
assert_eq "购物车行 A packingFeeEach=100" "$(jq -r "[.data.items[] | select(.productId==$P63_PA)][0].packingFeeEach" <<<"$R")" "100"
assert_eq "购物车行 B packingFeeEach=0" "$(jq -r "[.data.items[] | select(.productId==$P63_PB)][0].packingFeeEach" <<<"$R")" "0"

echo "-- ① 自取单 A×1 + B×2：packingFee=100（A 跟随默认×1 份 + B 覆盖 0×2 份），四处响应都透传 --"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$P63_CA,$P63_CB],\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P63_SLOT\",\"pickupContact\":{\"phone\":\"13800001111\"}}")
assert_eq "下单 code 0" "$(code "$R")" "0"
P63_O1=$(jq -r .data.orderId <<<"$R")
P63_SUB1=$((2000 + 1500 * 2))
assert_eq "packingFee=100" "$(jq -r .data.packingFee <<<"$R")" "100"
assert_eq "shippingFee=0（自取无运费）" "$(jq -r .data.shippingFee <<<"$R")" "0"
assert_eq "actualAmount = 小计 − 自取优惠(0) − 券(0) + 打包费" "$(jq -r .data.actualAmount <<<"$R")" "$((P63_SUB1 + 100))"
assert_eq "后台详情也带 packingFee" "$(p63_ord "$P63_O1" | jq -r .data.packingFee)" "100"
assert_eq "顾客详情也带 packingFee" "$(req GET "/api/orders/$P63_O1" "$UT" | jq -r .data.packingFee)" "100"
assert_eq "顾客列表也带 packingFee" "$(req GET "/api/orders?deliveryType=PICKUP&pageSize=50" "$UT" | jq -r "[.data.list[] | select(.id==$P63_O1)][0].packingFee")" "100"
assert_eq "后台列表也带 packingFee" "$(req GET "/api/admin/orders?deliveryType=PICKUP&pageSize=50" "$AT" | jq -r "[.data.list[] | select(.id==$P63_O1)][0].packingFee")" "100"

echo "-- ② 商品 A 覆盖 250：再下单按 250 收 --"
req PUT "/api/admin/products/$P63_PA" "$AT" '{"packingFeeFen":250}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P63_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P63_SLOT\",\"pickupContact\":{\"phone\":\"13800001111\"}}")
assert_eq "覆盖 250 后下单 code 0" "$(code "$R")" "0"
P63_O2=$(jq -r .data.orderId <<<"$R")
assert_eq "packingFee=250" "$(jq -r .data.packingFee <<<"$R")" "250"

echo "-- ③ 总开关关闭：packingFee=0；恢复后商品覆盖值仍生效 --"
p63_put '.packing.enabled=false' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P63_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P63_SLOT\",\"pickupContact\":{\"phone\":\"13800001111\"}}")
assert_eq "关闭开关下单 code 0" "$(code "$R")" "0"
P63_O3=$(jq -r .data.orderId <<<"$R")
assert_eq "packingFee=0（总开关关）" "$(jq -r .data.packingFee <<<"$R")" "0"
p63_put '.packing.enabled=true' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P63_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P63_SLOT\",\"pickupContact\":{\"phone\":\"13800001111\"}}")
assert_eq "恢复开关后下单 code 0" "$(code "$R")" "0"
P63_O3B=$(jq -r .data.orderId <<<"$R")
assert_eq "packingFee 恢复=250（商品覆盖值原样保留）" "$(jq -r .data.packingFee <<<"$R")" "250"
req PUT "/api/admin/products/$P63_PA" "$AT" '{"packingFeeFen":null}' >/dev/null
assert_eq "商品 A 覆盖值清回 null" "$(req GET "/api/products/$P63_PA" "$UT" | jq -r .data.packingFeeFen)" "null"

echo "-- ④ 同城外送单（既有 lquote/LQTOKEN 写法）：packingFee = 份数 × ¥1 --"
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P63_PA,\"quantity\":3},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
assert_eq "同城外送下单 code 0" "$(code "$R")" "0"
P63_O4=$(jq -r .data.orderId <<<"$R")
assert_eq "packingFee = 3 份 × ¥1 = 300" "$(jq -r .data.packingFee <<<"$R")" "300"
assert_eq "actualAmount = 小计 + 运费 + 打包费" "$(jq -r .data.actualAmount <<<"$R")" "$((6000 + $(jq -r .data.shippingFee <<<"$R") + 300))"

echo "-- ⑤ 邮寄单：packingFee 恒 0 --"
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":2}")
P63_CE=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$P63_CE],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
assert_eq "邮寄下单 code 0" "$(code "$R")" "0"
P63_O5=$(jq -r .data.orderId <<<"$R")
assert_eq "邮寄单 packingFee=0" "$(jq -r .data.packingFee <<<"$R")" "0"

echo "-- ⑥ 券门槛用商品小计，不算打包费：门槛=小计 仍可用 --"
P63_TID=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E-PACK-COUPON$RANDOM\",\"amount\":100,\"threshold\":2000,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P63_CID=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P63_TID}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P63_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P63_SLOT\",\"pickupContact\":{\"phone\":\"13800001111\"},\"couponId\":$P63_CID}")
assert_eq "门槛=小计（不含打包费）仍可用 code 0" "$(code "$R")" "0"
P63_O6=$(jq -r .data.orderId <<<"$R")
assert_eq "抵扣 ¥1" "$(jq -r .data.discountAmount <<<"$R")" "100"
assert_eq "packingFee=100（A 跟随默认，打包费不因用券而变）" "$(jq -r .data.packingFee <<<"$R")" "100"
assert_eq "actualAmount = 小计 − 券 + 打包费" "$(jq -r .data.actualAmount <<<"$R")" "$((2000 - 100 + 100))"

echo "-- ⑦ 全额退款：remainingRefundable 含打包费 --"
req POST "/api/orders/$P63_O1/pay" "$UT" >/dev/null
P63_AMT1=$(p63_ord "$P63_O1" | jq -r .data.actualAmount)
assert_eq "remainingRefundable = actualAmount（含打包费 ¥1.00）" "$(p63_ord "$P63_O1" | jq -r .data.remainingRefundable)" "$P63_AMT1"
req POST "/api/admin/orders/$P63_O1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/orders/$P63_O1/refund" "$AT" "{\"amount\":$P63_AMT1,\"reason\":\"e2e 打包费全额退款\"}")
assert_eq "全额退款 code 0" "$(code "$R")" "0"
assert_eq "订单 → REFUNDED" "$(p63_ord "$P63_O1" | jq -r .data.status)" "REFUNDED"
assert_eq "退款后 remainingRefundable=0" "$(p63_ord "$P63_O1" | jq -r .data.remainingRefundable)" "0"

echo "-- ⑧ 小票：配送/取餐联含「打包费：」，厨房联不含 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"P63-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P63_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P63_SLOT\",\"pickupContact\":{\"phone\":\"13800002222\"}}")
P63_O8=$(jq -r .data.orderId <<<"$R")
req POST "/api/orders/$P63_O8/pay" "$UT" >/dev/null
sleep 0.5
P63_TICKET=$(PJOBS "$P63_O8" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$P63_TICKET" == *"打包费：¥1.00"* ]] && ok "配送/取餐联印打包费 ¥1.00" || fail "小票没印打包费" "$P63_TICKET"
# 两联中间用字面量 <CUT> 分隔（不是真换行，见 content.ts 的 assemble）；取第一个 <CUT> 之后的部分才是厨房联
P63_KITCHEN="${P63_TICKET#*<CUT>}"
[[ -n "$P63_KITCHEN" && "$P63_KITCHEN" != *"打包费"* ]] && ok "厨房联不含打包费" || fail "厨房联不该含打包费" "$P63_KITCHEN"

echo "-- 收尾：恢复同城设置、下架测试商品、停用本段券模板、标记测试单、清打印作业 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P63_ORIG_LS" >/dev/null
req PUT "/api/admin/products/$P63_PA" "$AT" '{"status":"OFF_SHELF"}' >/dev/null
req PUT "/api/admin/products/$P63_PB" "$AT" '{"status":"OFF_SHELF"}' >/dev/null
for t in ${P63_TID:-}; do req PUT "/api/admin/coupon-templates/$t" "$AT" '{"status":"OFF"}' >/dev/null 2>&1 || true; done
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
sql "DELETE FROM print_jobs WHERE order_id IN ($P63_O1,$P63_O2,$P63_O3,$P63_O3B,$P63_O4,$P63_O5,$P63_O6,$P63_O8);"
sql "UPDATE orders SET is_test=1 WHERE id IN ($P63_O1,$P63_O2,$P63_O3,$P63_O3B,$P63_O4,$P63_O5,$P63_O6,$P63_O8);"
