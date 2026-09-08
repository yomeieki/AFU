echo "== 56. 邮寄报价：分组/中位数/包邮/不寄送/兜底/凭证 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq 与 $AT/$UT/$PID/$ADDR（四川省成都市）。变量一律 X54_ 前缀。
X54_ORIG=$(req GET /api/admin/settings/express "$AT" | jq -c .data)
# 明确切到 QUOTE 口径 + 默认分组（e2e 开头把它复位成了 TABLE/0 元——那是 e2e.sh §1 写的是
# 兼容 shim `PUT /api/admin/settings/shipping`（老的一口价键），不是直接写邮寄设置的新存储；
# shim 落到同一份底层设置上，效果上等于把邮寄设置也复位了）
X54_S=$(jq -c '.fee.mode="QUOTE" | .fee.markupFen=0 | .fee.roundToFen=50 | .fee.minQuoteCount=2 | .minOrderAmountFen=0
  | .weight.packagingG=800 | .weight.defaultItemG=300
  | .pricingPool=["jtexpress","yuantong","shentong","yunda","zhongtong","jd"]
  | .regionGroups=[
      {name:"四川",provinces:["四川省"],freeShipMinFen:9900,tableFirstFen:800,tableOverPerKgFen:150,blocked:false},
      {name:"其他",provinces:[],freeShipMinFen:19900,tableFirstFen:1200,tableOverPerKgFen:300,blocked:false},
      {name:"不寄送",provinces:["新疆维吾尔自治区"],freeShipMinFen:0,tableFirstFen:0,tableOverPerKgFen:0,blocked:true}]' <<<"$X54_ORIG")
R=$(req PUT /api/admin/settings/express "$AT" "$X54_S"); assert_eq "邮寄设置切 QUOTE code 0" "$(code "$R")" "0"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null

X54_BJ=$(req POST /api/addresses "$UT" '{"receiverName":"E2E北京","receiverPhone":"13800000054","province":"北京市","city":"北京市","district":"朝阳区","detail":"建国路93号"}' | jq -r '.data.id // empty')
X54_XJ=$(req POST /api/addresses "$UT" '{"receiverName":"E2E新疆","receiverPhone":"13800000055","province":"新疆维吾尔自治区","city":"乌鲁木齐市","district":"天山区","detail":"人民路1号"}' | jq -r '.data.id // empty')
[[ -n "$X54_BJ" && -n "$X54_XJ" ]] && ok "造北京/新疆地址" || fail "造地址失败"
X54_PRICE=$(req GET "/api/products/$PID" "$UT" | jq -r '.data.price')
# 期望值按商品真实净重算（种子商品可能填了净重，不能写死 1.1 kg）：
#   重量(0.1kg 整数) = ceil((净重×数量 + 800)/100)；ceil 公斤 = ceil(重量/10)
#   mock 各家价 = 首重价 + 130×(ceil 公斤 − 1)；定价名单 6 家中位数 = 708 + 续重 → 向上取五毛
#   兜底表（四川组）= 800 + 150×(ceil 公斤 − 1)
X54_NW=$(sql "SELECT COALESCE(net_weight_g,300) FROM products WHERE id=$PID;")
x54_wt()   { echo $(( ($X54_NW * $1 + 800 + 99) / 100 )); }            # 单位 0.1 kg
x54_ceil() { echo $(( ($(x54_wt $1) + 9) / 10 )); }                     # 向上整公斤
x54_fee()  { local o=$(( ($(x54_ceil $1) - 1) * 130 )); echo $(( ((708 + o + 49) / 50) * 50 )); }
x54_tfee() { echo $(( 800 + 150 * ($(x54_ceil $1) - 1) )); }
X54_FEE1=$(x54_fee 1); X54_TFEE1=$(x54_tfee 1); X54_WT1=$(x54_wt 1)

echo "-- ① 四川：定价名单 6 家中位数（含 mock 续重）→ $X54_FEE1；重量 $(x54_wt 1)/10 kg --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "报价 code 0" "$(code "$R")" "0"
assert_eq "groupName=四川" "$(jq -r .data.groupName <<<"$R")" "四川"
assert_eq "feeSource=QUOTE" "$(jq -r .data.feeSource <<<"$R")" "QUOTE"
assert_eq "weightKg（×10）" "$(jq -r '.data.weightKg*10|round' <<<"$R")" "$X54_WT1"
if [[ "$X54_PRICE" -ge 9900 ]]; then
  assert_eq "小计≥99 → 包邮 fee=0" "$(jq -r .data.feeFen <<<"$R")" "0"
  assert_eq "quotedFeeFen 仍是中位数价" "$(jq -r .data.quotedFeeFen <<<"$R")" "$X54_FEE1"
else
  assert_eq "fee=中位数价 $X54_FEE1" "$(jq -r .data.feeFen <<<"$R")" "$X54_FEE1"
  assert_eq "freeShip=false" "$(jq -r .data.freeShip <<<"$R")" "false"
fi
X54_TOK=$(jq -r '.data.quoteToken // empty' <<<"$R"); [[ -n "$X54_TOK" ]] && ok "签发 quoteToken" || fail "缺 quoteToken" "$R"
assert_eq "回价 9 家（含无价的顺丰）" "$(jq -r .data.quoteCount <<<"$R")" "9"
assert_eq "响应体不含各家成本价" "$(jq -r '.data.quotes // "absent"' <<<"$R")" "absent"
assert_eq "mock 被调 1 次" "$(req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "1"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "同地址同重量 15 分钟内复用缓存，mock 仍 1 次" "$(req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "1"

echo "-- ② 数量 2 → 重量变、缓存 key 变，mock 第 2 次 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":2}}")
assert_eq "weightKg（×10）随数量变" "$(jq -r '.data.weightKg*10|round' <<<"$R")" "$(x54_wt 2)"
assert_eq "mock 2 次" "$(req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "2"

echo "-- ③ 北京落「其他」组 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$X54_BJ,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "groupName=其他" "$(jq -r .data.groupName <<<"$R")" "其他"
assert_eq "freeShipMinFen=19900" "$(jq -r .data.freeShipMinFen <<<"$R")" "19900"

echo "-- ④ 新疆不寄送 42260 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$X54_XJ,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "不寄送 42260" "$(code "$R")" "42260"

echo "-- ⑤ 查价超时 → TABLE 兜底 $X54_TFEE1 --"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "超时仍 code 0" "$(code "$R")" "0"
assert_eq "feeSource=TABLE" "$(jq -r .data.feeSource <<<"$R")" "TABLE"
assert_eq "quotedFeeFen=兜底 $X54_TFEE1" "$(jq -r .data.quotedFeeFen <<<"$R")" "$X54_TFEE1"
assert_eq "兜底不写缓存：再报一次 mock 又被调" "$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}" >/dev/null; req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "2"

echo "-- ⑥ 只回 1 家 < minQuoteCount → TABLE --"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"directive":{"kind":"ok","quotes":[{"kuaidicom":"jd","serviceType":"特惠送","priceFen":1130,"defPriceFen":1500}]}}' >/dev/null
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "回价不足 → TABLE" "$(jq -r .data.feeSource <<<"$R")" "TABLE"

echo "-- ⑦ 参数错误 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR}"); [[ "$(code "$R")" != "0" ]] && ok "缺商品被拒 ($(code "$R"))" || fail "缺商品未被拒"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":999999,\"directItem\":{\"productId\":$PID,\"quantity\":1}}"); assert_eq "地址不存在 40401" "$(code "$R")" "40401"
R=$(req POST /api/express/quote "" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}"); [[ "$(code "$R")" == "40101" || "$(code "$R")" == "401" ]] && ok "未登录被拒" || fail "未登录未被拒" "$R"

# 收尾：地址留给 57 用；设置恢复原样
X54_KEEP_BJ=$X54_BJ; X54_KEEP_XJ=$X54_XJ; X54_KEEP_S=$X54_S; X54_KEEP_FEE=$X54_FEE1; X54_KEEP_TFEE=$X54_TFEE1; X54_KEEP_WT=$X54_WT1
req PUT /api/admin/settings/express "$AT" "$X54_ORIG" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
