echo "== 65. 分类内商品排序：拖拽（手动）/ 按近 30 天销量（2026-09-17 分类内排序设计）=="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sql；$AT/$UT/$LPID。变量一律 P65_ 前缀。
# 自建 LOCAL 分类 P65_CAT（sortOrder 97，不复用既有分类——同 §63 的理由：改排序方式/拖拽
# 会影响该分类下全部商品的可见顺序，混进已有分类会让其它段落的断言看运气）。

echo "-- 前置：新建分类 + 商品 A/B/C（价 ¥10/¥20/¥30） --"
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E-排序分类","sortOrder":97,"channel":"LOCAL"}')
P65_CAT=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P65_CAT" ]] && ok "创建 LOCAL 分类 #$P65_CAT" || fail "创建 LOCAL 分类" "$R"

R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$P65_CAT,\"name\":\"E2E-SORT-A$RANDOM\",\"price\":1000,\"stock\":99,\"netWeightG\":300}")
P65_A=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P65_A" ]] && ok "创建商品 A #$P65_A" || fail "创建商品 A" "$R"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$P65_CAT,\"name\":\"E2E-SORT-B$RANDOM\",\"price\":2000,\"stock\":99,\"netWeightG\":300}")
P65_B=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P65_B" ]] && ok "创建商品 B #$P65_B" || fail "创建商品 B" "$R"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$P65_CAT,\"name\":\"E2E-SORT-C$RANDOM\",\"price\":3000,\"stock\":99,\"netWeightG\":300}")
P65_C=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P65_C" ]] && ok "创建商品 C #$P65_C" || fail "创建商品 C" "$R"

echo "-- ① 初始顺序 = 录入顺序 [A,B,C]，公开列表带 categoryId/sortOrder，不带 isRecommended/createdAt --"
R=$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")
assert_eq "初始顺序 [A,B,C]" "$(jq -c '.data.list | map(.id)' <<<"$R")" "[$P65_A,$P65_B,$P65_C]"
assert_eq "每项 categoryId 都是本分类" "$(jq -r "[.data.list[].categoryId] | unique | length==1 and .[0]==$P65_CAT" <<<"$R")" "true"
assert_eq "首项（A）sortOrder=0（新建取本分类最大值+1，空分类为 0）" "$(jq -r '.data.list[0].sortOrder' <<<"$R")" "0"
assert_eq "不带 isRecommended" "$(jq -r '[.data.list[] | has("isRecommended")] | any' <<<"$R")" "false"
assert_eq "不带 createdAt" "$(jq -r '[.data.list[] | has("createdAt")] | any' <<<"$R")" "false"

echo "-- ② 拖拽保存合法乱序 [C,A,B]：公开/后台顺序都变，sortOrder 写成下标 --"
R=$(req POST "/api/admin/categories/$P65_CAT/product-order" "$AT" "{\"ids\":[$P65_C,$P65_A,$P65_B]}")
assert_eq "拖拽保存 code 0" "$(code "$R")" "0"
assert_eq "updated=3" "$(jq -r '.data.updated' <<<"$R")" "3"
assert_eq "公开列表顺序 [C,A,B]" "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_C,$P65_A,$P65_B]"
R=$(req GET "/api/admin/products?categoryId=$P65_CAT&pageSize=200" "$AT")
assert_eq "后台列表顺序 [C,A,B]" "$(jq -c '.data.list | map(.id)' <<<"$R")" "[$P65_C,$P65_A,$P65_B]"
assert_eq "后台列表 sortOrder=[0,1,2]" "$(jq -c '.data.list | map(.sortOrder)' <<<"$R")" "[0,1,2]"

echo "-- ③ 三种非法 ids 都 40001，顺序不变 --"
R=$(req POST "/api/admin/categories/$P65_CAT/product-order" "$AT" "{\"ids\":[$P65_C,$P65_A]}")
assert_eq "缺 B → 40001" "$(code "$R")" "40001"
R=$(req POST "/api/admin/categories/$P65_CAT/product-order" "$AT" "{\"ids\":[$P65_C,$P65_A,$P65_B,$LPID]}")
assert_eq "多一个跨分类 id(\$LPID) → 40001" "$(code "$R")" "40001"
R=$(req POST "/api/admin/categories/$P65_CAT/product-order" "$AT" "{\"ids\":[$P65_C,$P65_C,$P65_A]}")
assert_eq "重复 id → 40001" "$(code "$R")" "40001"
assert_eq "顺序仍是 [C,A,B]（未被非法请求改动）" "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_C,$P65_A,$P65_B]"

echo "-- ④ 新建 D：排到本分类最后（sortOrder=3），公开列表末位是 D --"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$P65_CAT,\"name\":\"E2E-SORT-D$RANDOM\",\"price\":4000,\"stock\":99,\"netWeightG\":300}")
P65_D=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P65_D" ]] && ok "创建商品 D #$P65_D" || fail "创建商品 D" "$R"
assert_eq "D 的 sortOrder=3（之前最大值 2 + 1）" "$(jq -r '.data.sortOrder' <<<"$R")" "3"
assert_eq "公开列表末位是 D" "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_C,$P65_A,$P65_B,$P65_D]"

echo "-- ⑤ 推荐置顶：A 打推荐，公开列表 A 最前，其余 [C,B,D] --"
R=$(req PUT "/api/admin/products/$P65_A" "$AT" '{"isRecommended":1}')
assert_eq "PUT isRecommended=1 code 0" "$(code "$R")" "0"
assert_eq "公开列表 [A,C,B,D]" "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_A,$P65_C,$P65_B,$P65_D]"

echo "-- ⑥ 为 B 下 2 份、为 D 下 1 份自取单并支付（照 §63 p63_put 的开通写法自行设置一次）--"
P65_ORIG_LS=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
p65_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p65_put '.pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1
  | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"NONE",value:0} | .pickup.autoCompleteAfterMin=120
  | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=20 | .peak.windows=[]
  | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .pickup.paused=null' >/dev/null
P65_SLOT=$(req GET /api/local/pickup-slots | jq -r '[.data.days[].slots[]][0].startAt')
[[ -n "$P65_SLOT" && "$P65_SLOT" != "null" ]] && ok "拿到自取时段 $P65_SLOT" || fail "没有可选时段"

R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P65_B,\"quantity\":2},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P65_SLOT\",\"pickupContact\":{\"phone\":\"13800006501\"}}")
assert_eq "B 下单 code 0" "$(code "$R")" "0"
P65_OB=$(jq -r .data.orderId <<<"$R")
R=$(req POST "/api/orders/$P65_OB/pay" "$UT"); assert_eq "B 单支付 code 0" "$(code "$R")" "0"

R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P65_D,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P65_SLOT\",\"pickupContact\":{\"phone\":\"13800006502\"}}")
assert_eq "D 下单 code 0" "$(code "$R")" "0"
P65_OD=$(jq -r .data.orderId <<<"$R")
R=$(req POST "/api/orders/$P65_OD/pay" "$UT"); assert_eq "D 单支付 code 0" "$(code "$R")" "0"

echo "-- 切 SALES_30D：A 推荐仍最前，其余按销量降序 [B,D,C]（B 2 件 > D 1 件 > C 0 件）--"
R=$(req PUT "/api/admin/categories/$P65_CAT" "$AT" '{"productSortMode":"SALES_30D"}')
assert_eq "切 SALES_30D code 0" "$(code "$R")" "0"
assert_eq "公开列表 [A,B,D,C]" "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_A,$P65_B,$P65_D,$P65_C]"
R=$(req GET "/api/admin/products?categoryId=$P65_CAT&pageSize=200" "$AT")
assert_eq "后台列表 B 的 sales30d=2" "$(jq -r "[.data.list[] | select(.id==$P65_B)][0].sales30d" <<<"$R")" "2"
assert_eq "后台列表 C 的 sales30d=0" "$(jq -r "[.data.list[] | select(.id==$P65_C)][0].sales30d" <<<"$R")" "0"

echo "-- ⑦ 把 B 的单标记测试单，切一次 mode 清缓存：B 销量归零，锁定 [A,D,C,B]（REAL_ORDERS 口径）--"
sql "UPDATE orders SET is_test=1 WHERE id=$P65_OB;"
req PUT "/api/admin/categories/$P65_CAT" "$AT" '{"productSortMode":"MANUAL"}' >/dev/null
R=$(req PUT "/api/admin/categories/$P65_CAT" "$AT" '{"productSortMode":"SALES_30D"}')
assert_eq "再切回 SALES_30D code 0" "$(code "$R")" "0"
assert_eq "公开列表 [A,D,C,B]（B 标测试单后销量记 0，与 C 同为 0 时按 sortOrder：C=0 先于 B=2）" \
  "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_A,$P65_D,$P65_C,$P65_B]"

echo "-- ⑧ 切回 MANUAL：手动顺序仍在库里，恢复为 [A,C,B,D] --"
R=$(req PUT "/api/admin/categories/$P65_CAT" "$AT" '{"productSortMode":"MANUAL"}')
assert_eq "切回 MANUAL code 0" "$(code "$R")" "0"
assert_eq "公开列表 [A,C,B,D]" "$(jq -c '.data.list | map(.id)' <<<"$(req GET "/api/products?channel=LOCAL&categoryId=$P65_CAT&pageSize=50" "")")" "[$P65_A,$P65_C,$P65_B,$P65_D]"

echo "-- 收尾：四道菜软删、分类下架、恢复同城设置、标记测试单 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P65_ORIG_LS" >/dev/null
for pid in $P65_A $P65_B $P65_C $P65_D; do req DELETE "/api/admin/products/$pid" "$AT" >/dev/null; done
req PUT "/api/admin/categories/$P65_CAT" "$AT" '{"status":0}' >/dev/null
sql "UPDATE orders SET is_test=1 WHERE id IN ($P65_OB,$P65_OD);"
