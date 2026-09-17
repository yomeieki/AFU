echo "== 66. 全店自动满减：设置块、取档/封顶、只读接口、下单链路、退款口径（2026-09-17 设计）=="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sql/lquote()；$AT/$UT/$LADDR/$ADDR/$LCAT/$ECAT。
# 变量一律 P66_ 前缀。自建商品 A（LOCAL，¥30）/E（EXPRESS，¥30）——不复用 $LPID/$EPID，理由同
# §49/§63：它们被广泛用于其它段落，本段反复改价/改设置会让后续段落的红绿取决于跑没跑过本段。
#
# ⚠️ lquote 的结果不要在 $(...) 子 shell 里接（见 §49 注释）：它把 $LQTOKEN/$LQFEE/$LQDIST
# 写进当前 shell 的全局变量，子 shell 里调用只会让这三个变量在子 shell 退出后消失。
P66_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
p66_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p66_ord() { req GET "/api/admin/orders/$1" "$AT"; }

echo "-- 前置：满减两档 [满50减5, 满100减12]，三渠道全勾；自取 9.5 折；关打包费；同城/邮寄各建一个测试商品 --"
R=$(p66_put '.promotion={enabled:true,name:"E2E满减",startAt:null,endAt:null,channels:{LOCAL:true,PICKUP:true,EXPRESS:true},tiers:[{minFen:5000,cutFen:500},{minFen:10000,cutFen:1200}]}
  | .packing.enabled=false
  | .fee={baseFee:300,baseKm:3,perKmFee:100,freeShipTiers:[],minOrderAmount:0,mode:"TABLE",quoteMarkupFen:250,quoteNearKm:2,quoteNearMarkupFen:150,roundToFen:50}
  | .store.latE6=29339000 | .store.lngE6=104778000 | .radiusKm=5
  | .enabled=true | .paused=null | .holiday=null | .businessHours=[{start:"00:00",end:"23:59"}]
  | .pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1
  | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"PERCENT",value:95} | .pickup.paused=null
  | .prepMinutes=20 | .peak.windows=[]')
assert_eq "前置整包保存 code 0" "$(code "$R")" "0"

R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E-PROMO-A$RANDOM\",\"price\":3000,\"stock\":99,\"netWeightG\":300}")
P66_A=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P66_A" ]] && ok "创建同城商品 A #$P66_A（¥30）" || fail "创建商品 A" "$R"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$ECAT,\"name\":\"E2E-PROMO-E$RANDOM\",\"price\":3000,\"stock\":99,\"netWeightG\":300}")
P66_E=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P66_E" ]] && ok "创建邮寄商品 E #$P66_E（¥30）" || fail "创建商品 E" "$R"
P66_SLOT=$(req GET /api/local/pickup-slots | jq -r '[.data.days[].slots[]][0].startAt')
[[ -n "$P66_SLOT" && "$P66_SLOT" != "null" ]] && ok "拿到自取时段 $P66_SLOT" || fail "没有可选时段"

echo "-- ① meta 与预览：两档、三个 subtotal 断点 --"
R=$(req GET /api/local/meta)
assert_eq "meta.promotion.active=true" "$(jq -r '.data.promotion.active' <<<"$R")" "true"
assert_eq "meta.promotion.tiers 两档" "$(jq -r '.data.promotion.tiers | length' <<<"$R")" "2"
R=$(req GET "/api/local/promo-preview?deliveryType=LOCAL&subtotal=3000")
assert_eq "3000：discountFen=0" "$(jq -r .data.discountFen <<<"$R")" "0"
assert_eq "3000：nextTierGapFen=2000" "$(jq -r .data.nextTierGapFen <<<"$R")" "2000"
R=$(req GET "/api/local/promo-preview?deliveryType=LOCAL&subtotal=6000")
assert_eq "6000：discountFen=500" "$(jq -r .data.discountFen <<<"$R")" "500"
assert_eq "6000：nextTierGapFen=4000" "$(jq -r .data.nextTierGapFen <<<"$R")" "4000"
R=$(req GET "/api/local/promo-preview?deliveryType=LOCAL&subtotal=12000")
assert_eq "12000：discountFen=1200" "$(jq -r .data.discountFen <<<"$R")" "1200"
assert_eq "12000：nextTierGapFen=null" "$(jq -r .data.nextTierGapFen <<<"$R")" "null"

echo "-- ② 同城单 A×2=6000：quote 与下单都命中 500，四处响应透传 --"
lquote "$LADDR" 6000
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$LADDR,\"subtotal\":6000}")
assert_eq "quote 响应 promoDiscountFen=500" "$(jq -r .data.promoDiscountFen <<<"$R")" "500"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
assert_eq "下单 code 0" "$(code "$R")" "0"
P66_O1=$(jq -r .data.orderId <<<"$R")
assert_eq "promoDiscountAmount=500" "$(jq -r .data.promoDiscountAmount <<<"$R")" "500"
assert_eq "shippingFee=运费" "$(jq -r .data.shippingFee <<<"$R")" "$LQFEE"
assert_eq "actualAmount = 6000 − 500 + 运费" "$(jq -r .data.actualAmount <<<"$R")" "$((6000 - 500 + LQFEE))"
assert_eq "后台详情 promoDiscountAmount=500" "$(p66_ord "$P66_O1" | jq -r .data.promoDiscountAmount)" "500"
assert_eq "顾客详情 promoDiscountAmount=500" "$(req GET "/api/orders/$P66_O1" "$UT" | jq -r .data.promoDiscountAmount)" "500"
assert_eq "顾客列表 promoDiscountAmount=500" "$(req GET "/api/orders?deliveryType=LOCAL&pageSize=50" "$UT" | jq -r "[.data.list[] | select(.id==$P66_O1)][0].promoDiscountAmount")" "500"
assert_eq "后台列表 promoDiscountAmount=500" "$(req GET "/api/admin/orders?deliveryType=LOCAL&pageSize=50" "$AT" | jq -r "[.data.list[] | select(.id==$P66_O1)][0].promoDiscountAmount")" "500"

echo "-- ③ 自取单 A×2：pickupDiscount 300（9.5折）+ promoDiscount 500，actualAmount 5200 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P66_SLOT\",\"pickupContact\":{\"phone\":\"13800009901\"}}")
assert_eq "自取下单 code 0" "$(code "$R")" "0"
P66_O2=$(jq -r .data.orderId <<<"$R")
assert_eq "pickupDiscountAmount=300" "$(jq -r .data.pickupDiscountAmount <<<"$R")" "300"
assert_eq "promoDiscountAmount=500" "$(jq -r .data.promoDiscountAmount <<<"$R")" "500"
assert_eq "actualAmount=5200" "$(jq -r .data.actualAmount <<<"$R")" "5200"

echo "-- ④ 邮寄单 E×2：promoDiscountAmount 500，shippingFee 0（TABLE 0 元），actualAmount 5500 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$P66_E,\"quantity\":2}}")
assert_eq "express quote promoDiscountFen=500" "$(jq -r .data.promoDiscountFen <<<"$R")" "500"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_E,\"quantity\":2},\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
assert_eq "邮寄下单 code 0" "$(code "$R")" "0"
P66_O3=$(jq -r .data.orderId <<<"$R")
assert_eq "promoDiscountAmount=500" "$(jq -r .data.promoDiscountAmount <<<"$R")" "500"
assert_eq "shippingFee=0" "$(jq -r .data.shippingFee <<<"$R")" "0"
assert_eq "actualAmount=5500" "$(jq -r .data.actualAmount <<<"$R")" "5500"

echo "-- ⑤ 券叠加（同城 A×2）：discountAmount 封顶到 6000−500=5500 剩下的量（面额6000门槛6000）→ 5500 --"
P66_TID=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E-PROMO-COUPON$RANDOM\",\"amount\":6000,\"threshold\":6000,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P66_CID=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P66_TID}" | jq -r '.data.id')
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"couponId\":$P66_CID}")
assert_eq "券叠加下单 code 0" "$(code "$R")" "0"
P66_O4=$(jq -r .data.orderId <<<"$R")
assert_eq "discountAmount=5500（封顶到 6000−500）" "$(jq -r .data.discountAmount <<<"$R")" "5500"
assert_eq "promoDiscountAmount=500" "$(jq -r .data.promoDiscountAmount <<<"$R")" "500"
assert_eq "actualAmount=运费（未跌到 0，不会 42251）" "$(jq -r .data.actualAmount <<<"$R")" "$LQFEE"

echo "-- ⑥ 起送与免运费按减前小计判：满 6000 起送/免运，A×2=6000 仍可下且免运，满减照算 --"
p66_put '.fee.minOrderAmount=6000 | .fee.freeShipTiers=[{minAmountFen:6000,maxKm:5}]' >/dev/null
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
assert_eq "起送线=小计仍可下单 code 0（不是 42210）" "$(code "$R")" "0"
P66_O5=$(jq -r .data.orderId <<<"$R")
assert_eq "免运费 shippingFee=0" "$(jq -r .data.shippingFee <<<"$R")" "0"
assert_eq "promoDiscountAmount=500（起送/免运不影响满减）" "$(jq -r .data.promoDiscountAmount <<<"$R")" "500"
assert_eq "actualAmount=5500" "$(jq -r .data.actualAmount <<<"$R")" "5500"
p66_put '.fee.minOrderAmount=0 | .fee.freeShipTiers=[]' >/dev/null

echo "-- ⑦ 封顶：自取立减 5000 时满减降为 200（不超过小计）；立减 5800 时实付 0 → 42251 --"
p66_put '.pickup.discount={type:"FIXED",value:5000}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P66_SLOT\",\"pickupContact\":{\"phone\":\"13800009902\"}}")
assert_eq "立减5000 下单 code 0" "$(code "$R")" "0"
P66_O6=$(jq -r .data.orderId <<<"$R")
assert_eq "pickupDiscountAmount=5000" "$(jq -r .data.pickupDiscountAmount <<<"$R")" "5000"
assert_eq "promoDiscountAmount 封顶为 200" "$(jq -r .data.promoDiscountAmount <<<"$R")" "200"
assert_eq "actualAmount=500" "$(jq -r .data.actualAmount <<<"$R")" "500"
p66_put '.pickup.discount={type:"FIXED",value:5800}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P66_SLOT\",\"pickupContact\":{\"phone\":\"13800009903\"}}")
assert_eq "立减5800 实付 0 → 42251" "$(code "$R")" "42251"
p66_put '.pickup.discount={type:"PERCENT",value:95}' >/dev/null

echo "-- ⑧ 渠道未勾：PICKUP 关掉后自取不再减，同城不受影响 --"
p66_put '.promotion.channels.PICKUP=false' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P66_SLOT\",\"pickupContact\":{\"phone\":\"13800009904\"}}")
assert_eq "自取下单 code 0" "$(code "$R")" "0"
P66_O7=$(jq -r .data.orderId <<<"$R")
assert_eq "PICKUP 未勾选 → promoDiscountAmount=0" "$(jq -r .data.promoDiscountAmount <<<"$R")" "0"
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
P66_O8=$(jq -r .data.orderId <<<"$R")
assert_eq "LOCAL 仍勾选 → promoDiscountAmount=500" "$(jq -r .data.promoDiscountAmount <<<"$R")" "500"
p66_put '.promotion.channels.PICKUP=true' >/dev/null

echo "-- ⑨ 停用 / 过期 / 未开始：三种情形下同城单都不减，且保存即生效 --"
R=$(p66_put '.promotion.enabled=false'); assert_eq "停用保存 code 0" "$(code "$R")" "0"
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
P66_O9=$(jq -r .data.orderId <<<"$R")
assert_eq "停用 → promoDiscountAmount=0" "$(jq -r .data.promoDiscountAmount <<<"$R")" "0"
R=$(p66_put '.promotion.enabled=true | .promotion.endAt="2020-01-01T00:00:00+08:00"'); assert_eq "已过期保存 code 0" "$(code "$R")" "0"
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
P66_O10=$(jq -r .data.orderId <<<"$R")
assert_eq "已过期 → promoDiscountAmount=0" "$(jq -r .data.promoDiscountAmount <<<"$R")" "0"
R=$(p66_put '.promotion.endAt=null | .promotion.startAt="2030-01-01T00:00:00+08:00"'); assert_eq "未开始保存 code 0" "$(code "$R")" "0"
lquote "$LADDR" 6000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P66_A,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
P66_O11=$(jq -r .data.orderId <<<"$R")
assert_eq "未开始 → promoDiscountAmount=0" "$(jq -r .data.promoDiscountAmount <<<"$R")" "0"
p66_put '.promotion.startAt=null' >/dev/null

echo "-- ⑩ 部分退款不改满减：O1 支付后部分退 ¥1，满减行与实付不变 --"
req POST "/api/orders/$P66_O1/pay" "$UT" >/dev/null
req POST "/api/admin/orders/$P66_O1/accept" "$AT" >/dev/null
P66_AMT1=$(p66_ord "$P66_O1" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$P66_O1/refund" "$AT" '{"amount":100,"reason":"e2e 满减部分退款"}')
assert_eq "部分退款 code 0" "$(code "$R")" "0"
assert_eq "退款后 promoDiscountAmount 仍 500" "$(p66_ord "$P66_O1" | jq -r .data.promoDiscountAmount)" "500"
assert_eq "退款后 actualAmount 不变" "$(p66_ord "$P66_O1" | jq -r .data.actualAmount)" "$P66_AMT1"
assert_eq "refundedAmount=100" "$(p66_ord "$P66_O1" | jq -r .data.refundedAmount)" "100"
assert_eq "remainingRefundable = actualAmount − 100" "$(p66_ord "$P66_O1" | jq -r .data.remainingRefundable)" "$((P66_AMT1 - 100))"

echo "-- ⑪ 校验：亏本档拒；日期格式拒；整包保存不带 promotion 键不会关掉活动 --"
CUR=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.promotion.tiers=[{minFen:5000,cutFen:5000}]' <<<"$CUR")")
assert_eq "亏本档 code 40001" "$(code "$R")" "40001"
[[ "$(jq -r .message <<<"$R")" == *"亏本"* ]] && ok "message 含「亏本」" || fail "message 未含亏本" "$R"
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.promotion.endAt="2026/10/08"' <<<"$CUR")")
assert_eq "日期格式错 code 40001" "$(code "$R")" "40001"
[[ "$(jq -r .message <<<"$R")" == *"格式不正确"* ]] && ok "message 含「格式不正确」" || fail "message 未含格式不正确" "$R"
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c 'del(.promotion)' <<<"$CUR")")
assert_eq "不带 promotion 键整包保存 code 0" "$(code "$R")" "0"
assert_eq "活动没被静默关掉，enabled 仍 true" "$(jq -r .data.promotion.enabled <<<"$R")" "true"

echo "-- 收尾：恢复原设置、清理待付款单、下架测试商品、清打印作业 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P66_ORIG" >/dev/null
for o in $P66_O2 $P66_O3 $P66_O4 $P66_O5 $P66_O6 $P66_O7 $P66_O8 $P66_O9 $P66_O10 $P66_O11; do
  req PUT "/api/orders/$o/cancel" "$UT" >/dev/null 2>&1 || true
done
# O1 已支付且部分退款过，客户端自助取消对它不适用，直接改库收尾（同 §63 的收尾写法）
sql "UPDATE orders SET status='CANCELLED' WHERE id=$P66_O1 AND status IN ('PAID','PREPARING');"
req DELETE "/api/admin/products/$P66_A" "$AT" >/dev/null
req DELETE "/api/admin/products/$P66_E" "$AT" >/dev/null
for t in ${P66_TID:-}; do req PUT "/api/admin/coupon-templates/$t" "$AT" '{"status":"OFF"}' >/dev/null 2>&1 || true; done
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
sql "DELETE FROM print_jobs WHERE order_id IN ($P66_O1,$P66_O2,$P66_O3,$P66_O4,$P66_O5,$P66_O6,$P66_O7,$P66_O8,$P66_O9,$P66_O10,$P66_O11);"
sql "UPDATE orders SET is_test=1 WHERE id IN ($P66_O1,$P66_O2,$P66_O3,$P66_O4,$P66_O5,$P66_O6,$P66_O7,$P66_O8,$P66_O9,$P66_O10,$P66_O11);"
assert_eq "本段没有留下待付款单" "$(sql "SELECT COUNT(*) FROM orders WHERE user_id=(SELECT user_id FROM orders WHERE id=$P66_O1) AND status='PENDING_PAYMENT';")" "0"
