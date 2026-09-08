echo "== 57. 邮寄下单：凭证校验 / 老客户端现算 / 包邮起送 / 不寄送 / 快照落库 =="
# 依赖 56 段留下的 $X54_KEEP_BJ $X54_KEEP_XJ $X54_KEEP_S $X54_KEEP_FEE（中位数价）$X54_KEEP_TFEE（兜底价）$X54_KEEP_WT（重量×10）。变量一律 X55_ 前缀。
X55_ORIG=$(req GET /api/admin/settings/express "$AT" | jq -c .data)
req PUT /api/admin/settings/express "$AT" "$X54_KEEP_S" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
X55_PRICE=$(req GET "/api/products/$PID" "$UT" | jq -r '.data.price')
# 让四川不包邮：0 = 该组永不包邮（注意 sanitize 对越界值静默回落默认，别用 99999900 这种值）
X55_S2=$(jq -c '.regionGroups |= map(if .name=="四川" then .freeShipMinFen=0 else . end)' <<<"$X54_KEEP_S")
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null
X55_IDS=() # 本段成功创建的 PENDING_PAYMENT 单，收尾只取消这些（不要碰其他段落/其他并发跑的单）

echo "-- ① 带凭证下单：运费 = 凭证 $X54_KEEP_FEE，快照落库 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK=$(jq -r .data.quoteToken <<<"$R")
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK\"}")
assert_eq "下单 code 0" "$(code "$R")" "0"
X55_O1=$(jq -r .data.orderId <<<"$R")
X55_IDS+=("$X55_O1")
assert_eq "shippingFee=凭证价" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_FEE"
assert_eq "actualAmount = 小计 + 运费" "$(jq -r .data.actualAmount <<<"$R")" "$((X55_PRICE+X54_KEEP_FEE))"
assert_eq "订单快照：分组=四川" "$(sql "SELECT express_region_group FROM orders WHERE id=$X55_O1;")" "四川"
assert_eq "订单快照：重量（克）" "$(sql "SELECT express_weight_g FROM orders WHERE id=$X55_O1;")" "$((X54_KEEP_WT*100))"
[[ "$(sql "SELECT JSON_LENGTH(express_quote_snapshot, '$.quotes') FROM orders WHERE id=$X55_O1;")" == "9" ]] && ok "订单快照：9 家报价" || fail "快照 quotes 不是 9 家"

echo "-- ② 凭证与清单不符 42261（数量改 2） --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":2},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK\"}")
assert_eq "清单不符 42261" "$(code "$R")" "42261"
echo "-- ③ 凭证与地址不符 42261 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$X54_KEEP_BJ,\"quoteToken\":\"$X55_TOK\"}")
assert_eq "地址不符 42261" "$(code "$R")" "42261"
echo "-- ④ 凭证被篡改 42261 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"${X55_TOK}x\"}")
assert_eq "篡改 42261" "$(code "$R")" "42261"

echo "-- ④b 地址原地改动（PUT 同 id 换详细地址，省市区不变）后旧凭证失效 42261 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK_AH=$(jq -r .data.quoteToken <<<"$R")
R=$(req PUT "/api/addresses/$ADDR" "$UT" '{"receiverName":"E2E测试","receiverPhone":"13800000000","province":"四川省","city":"成都市","district":"武侯区","detail":"测试路2号","isDefault":1}')
assert_eq "原地改地址 code 0" "$(code "$R")" "0"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK_AH\"}")
assert_eq "地址内容变了但 id 没变 → 旧凭证失效 42261" "$(code "$R")" "42261"
R=$(req PUT "/api/addresses/$ADDR" "$UT" '{"receiverName":"E2E测试","receiverPhone":"13800000000","province":"四川省","city":"成都市","district":"武侯区","detail":"测试路1号","isDefault":1}')
assert_eq "改回地址 code 0" "$(code "$R")" "0"

echo "-- ⑤ 老客户端不带凭证：服务端现算，运费同样 $X54_KEEP_FEE --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
assert_eq "不带凭证下单 code 0" "$(code "$R")" "0"
X55_IDS+=("$(jq -r .data.orderId <<<"$R")")
assert_eq "现算运费=凭证价" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_FEE"

echo "-- ⑥ QUOTE 锁价：报价后店主把加价改成 ¥50，旧凭证仍按原价成交 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK2=$(jq -r .data.quoteToken <<<"$R")
req PUT /api/admin/settings/express "$AT" "$(jq -c '.fee.markupFen=5000' <<<"$X55_S2")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK2\"}")
assert_eq "锁价成交" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_FEE"
X55_IDS+=("$(jq -r .data.orderId <<<"$R")")
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null

echo "-- ⑦ 包邮按当前设置与真实小计判：报价时不包邮，下单前把四川门槛降到单价 → 运费 0 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK3=$(jq -r .data.quoteToken <<<"$R")
req PUT /api/admin/settings/express "$AT" "$(jq -c --argjson p "$X55_PRICE" '.regionGroups |= map(if .name=="四川" then .freeShipMinFen=$p else . end)' <<<"$X55_S2")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK3\"}")
assert_eq "包邮线降到单价 → 运费 0" "$(jq -r .data.shippingFee <<<"$R")" "0"
X55_IDS+=("$(jq -r .data.orderId <<<"$R")")
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null

echo "-- ⑧ 起送不足 42210；不寄送 42260 --"
# minOrderAmountFen 上限 10_000_000（sanitizeExpressSettings），超出即被静默回落默认值——
# 用 9999900（¥99999，逼近上限但合法）而不是 99999900，否则设置写入被悄悄丢弃，起送线形同虚设。
req PUT /api/admin/settings/express "$AT" "$(jq -c '.minOrderAmountFen=9999900' <<<"$X55_S2")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
assert_eq "起送不足 42210" "$(code "$R")" "42210"
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$X54_KEEP_XJ}")
assert_eq "不寄送 42260" "$(code "$R")" "42260"

echo "-- ⑨ 查价超时 → TABLE 兜底价成交 $X54_KEEP_TFEE，快照 feeSource=TABLE --"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
assert_eq "兜底价" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_TFEE"
X55_O9=$(jq -r .data.orderId <<<"$R")
X55_IDS+=("$X55_O9")
assert_eq "快照 feeSource=TABLE" "$(sql "SELECT JSON_UNQUOTE(JSON_EXTRACT(express_quote_snapshot,'$.feeSource')) FROM orders WHERE id=$X55_O9;")" "TABLE"

echo "-- ⑩ /orders/meta 兼容视图来自「其他」组 --"
R=$(req GET /api/orders/meta "$UT")
assert_eq "meta.shipping.fee = 其他组兜底首重 1200" "$(jq -r .data.shipping.fee <<<"$R")" "1200"
assert_eq "meta.shipping.freeThreshold = 其他组 19900" "$(jq -r .data.shipping.freeThreshold <<<"$R")" "19900"

echo "-- ⑪ 同城单不受影响：LOCAL 下单路径没读邮寄设置（沿用 §8 那张 LADDR 单的断言即可，这里只确认接口还活着） --"
R=$(req GET /api/local/meta ""); assert_eq "/local/meta 仍 200" "$(code "$R")" "0"

# 收尾：把本段造的 PENDING_PAYMENT 单取消（只按 X55_IDS 收集到的订单号，不用条件扫表——
# 扫表会连带取消其他段落/并发跑的邮寄单），地址删除，设置恢复
X55_ID_LIST=$(IFS=,; echo "${X55_IDS[*]}")
sql "UPDATE orders SET status='CANCELLED' WHERE id IN ($X55_ID_LIST);"
req DELETE "/api/addresses/$X54_KEEP_BJ" "$UT" >/dev/null; req DELETE "/api/addresses/$X54_KEEP_XJ" "$UT" >/dev/null
req PUT /api/admin/settings/express "$AT" "$X55_ORIG" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
