echo "== 49. 同城单用券（同城开通后才验得了的那一项）=="
# 为什么要单独一段：§39 只测了「LOCAL 券用在**邮寄**单 → 42251」这个**反面**。
# 正面——**券真的能在同城单上用**——从会员上线起没有任何用例覆盖过；
# 「EXPRESS 券用在同城单」这面镜子也缺着。同城 2026-09-06 才真正对顾客开放，
# 所以这是它开通之后第一次验得了的东西。
#
# 本文件在 e2e.sh §36 之后被 source，此时 §39 的 m2_coupon()/m2_login() 还没定义，
# 所以自己造。依赖的只有 §0-§16 就已存在的东西：$AT / $UT / $LADDR / $LCAT / lquote() / sql()。
#
# 断言里**一律不写运费的魔数**：期望值取自 /local/quote 返回的 fee。
# 写死数字的话，谁改一下 baseKm 或 mock 的绕路系数，这一段就会变成偶发红，
# 而它要守的不变量其实是「运费与券无关」，跟具体几块钱没关系。

L9_TAG=$RANDOM
L9_ORIG_LS=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)

# 钉死本段依赖的每个参数，跑完恢复。freeShipTiers 显式设空（关掉满额免运费）：
# 开着的话商品小计一超线运费就归零，「运费与券无关」这条断言会变成拿 0 比 0 的空断言。
L9_LS=$(jq -c '
  .store.latE6=29339000 | .store.lngE6=104778000 | .radiusKm=5 | .detourFactor=1.7
  | .fee={baseFee:300,baseKm:3,perKmFee:100,freeShipTiers:[],minOrderAmount:2000,mode:"TABLE"}
  | .businessHours=[{start:"00:00",end:"23:59"}] | .enabled=true | .paused=null | .autoCallDelayMin=0
' <<<"$L9_ORIG_LS")
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$L9_LS")
assert_eq "49 前置：同城设置已钉死并开启" "$(jq -r '.data.enabled' <<<"$R")" "true"
assert_eq "49 前置：起送线 ¥20" "$(jq -r '.data.fee.minOrderAmount' <<<"$R")" "2000"
assert_eq "49 前置：关掉满额免运费" "$(jq -r '.data.fee.freeShipTiers | length' <<<"$R")" "0"

# 自建同城商品：不复用 $LPID——它在 §5 被搬去过邮寄分类再搬回来，
# 依赖它当时的渠道状态会让本段的红绿取决于上游段落的执行顺序。
# 价格 ¥30 是挑过的：> 起送线 ¥20，且减掉 ¥15 的券之后（¥15）**低于**起送线，
# 正好能验「起送线按券前小计判」那条（见下面第 5 条）。
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E同城用券菜$L9_TAG\",\"price\":3000,\"stock\":99,\"netWeightG\":300}")
L9_PID=$(jq -r '.data.id // empty' <<<"$R")
[[ -n "$L9_PID" ]] && ok "创建同城商品 #$L9_PID（¥30）" || fail "创建同城商品" "$R"
assert_eq "该商品 channel=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"

l9_coupon() { # $1=token $2=名称 $3=面额(分) $4=门槛(分) $5=渠道 → echo user_coupon.id
  local tid
  tid=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"$2\",\"amount\":$3,\"threshold\":$4,\"channel\":\"$5\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
  req POST /api/member/coupons/claim "$1" "{\"templateId\":$tid}" | jq -r '.data.id'
}

# 每次下单都要一张新凭证（同城强制凭证，一次一张）。
# ⚠️ **结果写进 $L9_RESP，不用 echo + $( ) 接**——这是本文件第一版踩过的坑：
# 写成 `R=$(l9_order "")` 的话，命令替换会开**子 shell**，`lquote` 在里面写的 $LQFEE/$LQTOKEN
# 根本传不回父 shell，于是「运费 = 报价的 fee」这条拿的是**上游段落遗留的旧 LQFEE**
# （实测比对成了 400 vs 300，看起来像业务 bug，其实是 shell 作用域）。
# e2e.sh 里 lquote/_quote_token 拆成两个函数、注释里写的正是同一个坑。
l9_order() { # $1=couponId（空串=不用券） → 响应写进 $L9_RESP；$LQFEE/$LQTOKEN 是本次报价
  local body
  lquote "$LADDR" 3000
  body="{\"directItem\":{\"productId\":$L9_PID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\""
  [[ -n "$1" ]] && body="$body,\"couponId\":$1"
  L9_RESP=$(req POST /api/orders "$UT" "$body}")
}

echo "-- 基线：同城单不用券，实付 = 商品小计 + 运费 --"
l9_order ""; R=$L9_RESP
assert_eq "基线：下单成功" "$(code "$R")" "0"
L9_BASE_SHIP=$(jq -r '.data.shippingFee' <<<"$R")
assert_eq "基线：商品小计 ¥30" "$(jq -r '.data.totalAmount' <<<"$R")" "3000"
assert_eq "基线：运费 = 报价的 fee" "$L9_BASE_SHIP" "$LQFEE"
assert_eq "基线：实付 = 小计 + 运费" "$(jq -r '.data.actualAmount' <<<"$R")" "$((3000 + L9_BASE_SHIP))"
assert_eq "基线：无券时 discountAmount=0" "$(jq -r '.data.discountAmount // 0' <<<"$R")" "0"

echo "-- ①【本段存在的理由】LOCAL 专享券用在同城单：应该能用 --"
# §39 只证明了它在邮寄单上被拒。它在同城单上到底能不能用，此前没人验过。
L9_C_LOCAL=$(l9_coupon "$UT" "L9-同城专享$L9_TAG" 500 0 LOCAL)
[[ -n "$L9_C_LOCAL" && "$L9_C_LOCAL" != "null" ]] && ok "领到 LOCAL 券 #$L9_C_LOCAL" || fail "领 LOCAL 券失败"
l9_order "$L9_C_LOCAL"; R=$L9_RESP
assert_eq "①LOCAL 券在同城单上下单成功" "$(code "$R")" "0"
assert_eq "①抵扣 ¥5" "$(jq -r '.data.discountAmount' <<<"$R")" "500"
assert_eq "①实付 = 小计 − 券 + 运费" "$(jq -r '.data.actualAmount' <<<"$R")" "$((3000 - 500 + L9_BASE_SHIP))"
assert_eq "①券已核销" "$(sql "SELECT status FROM user_coupons WHERE id=$L9_C_LOCAL;")" "USED"

echo "-- ② ALL 券用在同城单：应该能用 --"
L9_C_ALL=$(l9_coupon "$UT" "L9-通用$L9_TAG" 500 0 ALL)
l9_order "$L9_C_ALL"; R=$L9_RESP
assert_eq "②ALL 券在同城单上下单成功" "$(code "$R")" "0"
assert_eq "②抵扣 ¥5" "$(jq -r '.data.discountAmount' <<<"$R")" "500"

echo "-- ③【缺的那面镜子】EXPRESS 专享券用在同城单：应该被拒 --"
# §39 有「LOCAL 券 → 邮寄单」，缺对称的这一条。两条都在才说明渠道判定是双向的，
# 而不是碰巧只对某一个方向生效。
L9_C_EXP=$(l9_coupon "$UT" "L9-邮寄专享$L9_TAG" 500 0 EXPRESS)
l9_order "$L9_C_EXP"; R=$L9_RESP
assert_eq "③EXPRESS 券用在同城单 → 42251" "$(code "$R")" "42251"
assert_eq "③消息说明是渠道问题（仅限全国邮寄）" "$(jq -r '.message' <<<"$R")" "该券仅限全国邮寄订单使用"
assert_eq "③被拒后券未被核销" "$(sql "SELECT status FROM user_coupons WHERE id=$L9_C_EXP;")" "UNUSED"

echo "-- ④ 运费与券无关：用一张能把小计打掉一半的券，运费一分不变 --"
# 这是最容易改错的一处：券只减商品小计，运费按距离另算。
# 若哪天有人把券作用到「小计+运费」上，这条会红。
L9_C_BIG=$(l9_coupon "$UT" "L9-半价$L9_TAG" 1500 0 ALL)
l9_order "$L9_C_BIG"; R=$L9_RESP
assert_eq "④下单成功" "$(code "$R")" "0"
assert_eq "④抵扣 ¥15" "$(jq -r '.data.discountAmount' <<<"$R")" "1500"
assert_eq "④运费仍等于报价的 fee（券没吃到运费）" "$(jq -r '.data.shippingFee' <<<"$R")" "$LQFEE"
assert_eq "④实付 = 小计 − 券 + 运费" "$(jq -r '.data.actualAmount' <<<"$R")" "$((3000 - 1500 + L9_BASE_SHIP))"

echo "-- ⑤【语义最容易被改错的一条】起送线按**券前**小计判 --"
# 上面那张 ¥15 的券把小计从 ¥30 打到 ¥15，而起送线是 ¥20。
# 若起送线改成按券后小计判，顾客就会「因为用了券而失去下单资格」——
# 这跟包邮线按券前小计判是同一个道理（顾客不该因为用券反而变差）。
# ④ 已经下单成功即证明了这一点；这里再单独把判据说白，并验反向：
#   小计本身就低于起送线时，无论用不用券都必须被 42210 拒。
assert_eq "⑤券后小计 ¥15 < 起送线 ¥20，但④已下单成功 → 按券前判" "$(code "$R")" "0"
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.fee.minOrderAmount=5000' <<<"$L9_LS")")
assert_eq "⑤前置：起送线临时提到 ¥50" "$(jq -r '.data.fee.minOrderAmount' <<<"$R")" "5000"
L9_C_X=$(l9_coupon "$UT" "L9-起送线$L9_TAG" 500 0 ALL)
l9_order "$L9_C_X"; R=$L9_RESP
assert_eq "⑤券前小计 ¥30 < 起送线 ¥50 → 42210（用券也救不了）" "$(code "$R")" "42210"
assert_eq "⑤被拒后券未被核销" "$(sql "SELECT status FROM user_coupons WHERE id=$L9_C_X;")" "UNUSED"
req PUT /api/admin/settings/local-delivery "$AT" "$L9_LS" >/dev/null

echo "-- ⑥ 结算页预览与下单判定必须一致（共用 checkCouponUsable，锁住它们不许分叉）--"
# 预览说能用、下单却被拒（或反之）是最伤顾客的一类不一致：弹层里亮着的券点下去报错。
# ⚠️ 端点是 GET /api/member/checkout-options?channel=&subtotal=（member.ts:150）。
#    不是 /api/orders/meta——那个是 GET、只返订阅消息模板与支付超时，与券无关。
L9_C_M1=$(l9_coupon "$UT" "L9-预览同城$L9_TAG" 500 0 LOCAL)
L9_C_M2=$(l9_coupon "$UT" "L9-预览邮寄$L9_TAG" 500 0 EXPRESS)
R=$(req GET "/api/member/checkout-options?channel=LOCAL&subtotal=3000" "$UT")
assert_eq "⑥checkout-options code 0" "$(code "$R")" "0"
assert_eq "⑥LOCAL 券在同城预览里 usable=true" "$(jq -r "[.data.coupons[] | select(.id==$L9_C_M1)][0].usable" <<<"$R")" "true"
assert_eq "⑥EXPRESS 券在同城预览里 usable=false" "$(jq -r "[.data.coupons[] | select(.id==$L9_C_M2)][0].usable" <<<"$R")" "false"
assert_eq "⑥不可用原因是 CHANNEL（不是门槛/过期）" "$(jq -r "[.data.coupons[] | select(.id==$L9_C_M2)][0].reason" <<<"$R")" "CHANNEL"
# 反向对称：同一张 EXPRESS 券在邮寄渠道的预览里必须是可用的，否则上面那条 false
# 可能只是「这张券哪儿都不能用」，断言就变成了空的
R=$(req GET "/api/member/checkout-options?channel=EXPRESS&subtotal=3000" "$UT")
assert_eq "⑥同一张 EXPRESS 券在邮寄预览里 usable=true" "$(jq -r "[.data.coupons[] | select(.id==$L9_C_M2)][0].usable" <<<"$R")" "true"
# 预览说 false，下单就必须真的拒——两处共用 checkCouponUsable，这条锁住它们不许分叉
l9_order "$L9_C_M2"; R=$L9_RESP
assert_eq "⑥预览说不可用 → 下单确实被拒 42251" "$(code "$R")" "42251"

echo "-- 收尾：恢复同城设置、下架测试商品 --"
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$L9_ORIG_LS")
assert_eq "49 收尾：同城设置已恢复" "$(code "$R")" "0"
assert_eq "49 收尾：起送线回到原值" "$(jq -r '.data.fee.minOrderAmount' <<<"$R")" "$(jq -r '.fee.minOrderAmount' <<<"$L9_ORIG_LS")"
req PUT "/api/admin/products/$L9_PID" "$AT" '{"status":"OFF_SHELF"}' >/dev/null
# 本段造的单全部标 isTest，免得污染统计基线（§33 的口径）
sql "UPDATE orders SET is_test=1 WHERE id IN (SELECT order_id FROM order_items WHERE product_id=$L9_PID);"
