echo "== 74. 库存预警：按规格判定 + 即时/每日推送（2026-09-24） =="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sched/sql/num；$AT/$LCAT/$ECAT。变量一律 P74_/Q74_/X74_ 前缀。
# 74 不依赖 73（local-address-dedup）是否存在：本段开头的「冲刷」一轮本来就是为了把任何前序
# 分片留下的售罄单位先推掉，两者共用的只有 e2e.sh 里已列出的公共 helper。
p74_local_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p74_stock() { req PUT "/api/admin/products/$1/stock" "$AT" "$2"; }
# req() 不做 URL 编码，直接把中文关键词拼进路径在这台机器上会让 curl 静默失败（空输出，
# 不是空数组）——这里单独用 curl -G --data-urlencode 走查询参数编码（同 e2e.sh:211 处理
# 「E2E测试」姓名搜索的写法），避免把与本功能无关的编码问题混进断言。
p74_kw() { curl -s -G "$BASE/api/admin/products" --data-urlencode "keyword=$1" -H "Authorization: Bearer $AT"; }

echo "-- 74.0 设置 --"
R=$(req PUT /api/admin/settings/low-stock "$AT" '{"lowThreshold":3,"pushBelow":2}')
assert_eq "设置门槛 {3,2} code 0" "$(code "$R")" "0"
R=$(req PUT /api/admin/settings/low-stock "$AT" '{"lowThreshold":3,"pushBelow":5}')
assert_eq "非法门槛（pushBelow>lowThreshold）40001" "$(code "$R")" "40001"

echo "-- 74.1 造数 + 冲刷 --"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E库存预警商品\",\"price\":1000,\"specDimensions\":[{\"name\":\"辣度\",\"values\":[\"微辣\",\"中辣\",\"白味\"]}],\"skus\":[{\"specText\":\"微辣\",\"specValues\":[\"微辣\"],\"price\":1000,\"stock\":10},{\"specText\":\"中辣\",\"specValues\":[\"中辣\"],\"price\":1000,\"stock\":10},{\"specText\":\"白味\",\"specValues\":[\"白味\"],\"price\":1000,\"stock\":10}]}")
P74_PID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P74_PID" ]] && ok "创建多规格商品 #$P74_PID" || fail "创建多规格商品" "$R"
P74_A=$(jq -r '.data.skus[] | select(.specText=="微辣") | .id' <<<"$R")
P74_B=$(jq -r '.data.skus[] | select(.specText=="中辣") | .id' <<<"$R")
P74_C=$(jq -r '.data.skus[] | select(.specText=="白味") | .id' <<<"$R")
[[ -n "$P74_A" && -n "$P74_B" && -n "$P74_C" ]] && ok "拿到三个 skuId ($P74_A/$P74_B/$P74_C)" || fail "拿 skuId" "$R"

R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$ECAT,\"name\":\"E2E库存预警邮寄商品\",\"price\":1200,\"stock\":10}")
Q74_PID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$Q74_PID" ]] && ok "创建无规格商品 #$Q74_PID" || fail "创建无规格商品" "$R"

# 只为 74.2 的「别的商品的 skuId 打在 P74 上」这条负向用例造一个对照商品，74.8 收尾一并删除
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E库存预警对照商品\",\"price\":800,\"specDimensions\":[{\"name\":\"规格\",\"values\":[\"单一\"]}],\"skus\":[{\"specText\":\"单一\",\"specValues\":[\"单一\"],\"price\":800,\"stock\":10}]}")
X74_PID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$X74_PID" ]] && ok "创建对照商品 #$X74_PID" || fail "创建对照商品" "$R"
X74_SKU=$(jq -r '.data.skus[0].id // empty' <<<"$R")

sched '{}' >/dev/null   # 冲刷：把别的分段留下的售罄单位先推掉，不断言数值（新商品此刻库存都是 10，不受影响）

echo "-- 74.2 改库存接口 --"
R=$(p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":1}")
assert_eq "改规格库存 code 0" "$(code "$R")" "0"
assert_eq "data.stock=1" "$(jq -r .data.stock <<<"$R")" "1"
assert_eq "data.productStock=21" "$(jq -r .data.productStock <<<"$R")" "21"
assert_eq "sql products.stock=21" "$(sql "SELECT stock FROM products WHERE id=$P74_PID;")" "21"
R=$(p74_stock "$P74_PID" '{"stock":1}')
assert_eq "不带 skuId 打在多规格商品 40001" "$(code "$R")" "40001"
R=$(p74_stock "$Q74_PID" "{\"skuId\":$P74_A,\"stock\":1}")
assert_eq "带 skuId 打在无规格商品 40001" "$(code "$R")" "40001"
R=$(p74_stock "$P74_PID" "{\"skuId\":$X74_SKU,\"stock\":1}")
assert_eq "别的商品的 skuId 打在 P74 上 40401" "$(code "$R")" "40401"
R=$(p74_stock "$P74_PID" '{"stock":-1}')
assert_eq "负数库存 40001" "$(code "$R")" "40001"

echo "-- 74.3 列表与角标 --"
R=$(req GET /api/admin/products/low-stock "$AT")
assert_eq "low-stock 里 P74 的 A 为 LOW" "$(jq -r ".data.groups[] | select(.productId==$P74_PID) | .units[] | select(.skuId==$P74_A) | .level" <<<"$R")" "LOW"
R=$(req GET /api/admin/orders/pending-count "$AT")
P74_LSC=$(num "$(jq -r .data.lowStockCount <<<"$R")")
[[ "$P74_LSC" -ge 1 ]] && ok "pending-count.lowStockCount ≥1 ($P74_LSC)" || fail "pending-count.lowStockCount" "$R"
assert_eq "pending-count.lowStockThreshold=3" "$(jq -r .data.lowStockThreshold <<<"$R")" "3"
R=$(p74_kw "E2E库存预警商品")
assert_eq "keyword 列表 P74 stockAlert={0,1}" "$(jq -c '.data.list[0].stockAlert' <<<"$R")" '{"out":0,"low":1}'

echo "-- 74.4 推送去重（sched 返回值即 lowStockScan 条数） --"
R=$(sched '{}'); assert_eq "A=1 → 1" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "1"
R=$(sched '{}'); assert_eq "再 sched（A 仍 1）→ 0" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":0}" >/dev/null
R=$(sched '{}'); assert_eq "A=0 → 1" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "1"
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":1}" >/dev/null
R=$(sched '{}'); assert_eq "A=1（从 OUT 回落，不算补货）→ 0" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":0}" >/dev/null
R=$(sched '{}'); assert_eq "A=0（仍 OUT）→ 0" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":5}" >/dev/null
R=$(sched '{}'); assert_eq "A=5（≥pushBelow 重置）→ 0" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":0}" >/dev/null
R=$(sched '{}'); assert_eq "A=0（直接跌到 0 只推一条）→ 1" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "1"
p74_stock "$P74_PID" "{\"skuId\":$P74_B,\"stock\":1}" >/dev/null
p74_stock "$P74_PID" "{\"skuId\":$P74_C,\"stock\":0}" >/dev/null
R=$(sched '{}'); assert_eq "B=1 且 C=0 同时 → 2" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "2"
# 此时 A=0、B=1、C=0，状态里三者已是 OUT/LOW/OUT

echo "-- 74.5 只统计在架；下架不清状态；只有补货到 ≥pushBelow 才重置 --"
P74_PC_BEFORE=$(num "$(req GET /api/admin/orders/pending-count "$AT" | jq -r .data.lowStockCount)")
R=$(req PUT "/api/admin/products/$P74_PID" "$AT" '{"status":"OFF_SHELF"}')
assert_eq "下架 code 0" "$(code "$R")" "0"
R=$(req GET /api/admin/products/low-stock "$AT")
assert_eq "low-stock 不含下架商品 P74" "$(jq -r ".data.groups[] | select(.productId==$P74_PID) | .productId" <<<"$R")" ""
R=$(p74_kw "E2E库存预警商品")
assert_eq "keyword 列表下架后 stockAlert={0,0}" "$(jq -c '.data.list[0].stockAlert' <<<"$R")" '{"out":0,"low":0}'
P74_PC_AFTER=$(num "$(req GET /api/admin/orders/pending-count "$AT" | jq -r .data.lowStockCount)")
[[ "$((P74_PC_BEFORE - P74_PC_AFTER))" -eq 3 ]] && ok "pending-count.lowStockCount 下架后少 3（$P74_PC_BEFORE→$P74_PC_AFTER）" || fail "pending-count.lowStockCount 下架后未按预期减少" "before=$P74_PC_BEFORE after=$P74_PC_AFTER"
R=$(sched '{}'); assert_eq "下架期间 sched=0（不推、状态原样保留）" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
R=$(req PUT "/api/admin/products/$P74_PID" "$AT" '{"status":"ON_SHELF"}')
assert_eq "上架 code 0" "$(code "$R")" "0"
R=$(sched '{}'); assert_eq "上架后 sched=0（下架再上架不再推）" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
req PUT "/api/admin/products/$P74_PID" "$AT" '{"status":"OFF_SHELF"}' >/dev/null
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":5}" >/dev/null
req PUT "/api/admin/products/$P74_PID" "$AT" '{"status":"ON_SHELF"}' >/dev/null
R=$(sched '{}'); assert_eq "补货到 ≥pushBelow 只重置不推 → 0" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "0"
p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":0}" >/dev/null
R=$(sched '{}'); assert_eq "重置后再卖空会推 → 1" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "1"
# 收尾状态：A=OUT、B=LOW、C=OUT

echo "-- 74.6 无规格商品 --"
R=$(p74_stock "$Q74_PID" '{"stock":0}')
assert_eq "无规格商品改库存 code 0" "$(code "$R")" "0"
assert_eq "productStock=0" "$(jq -r .data.productStock <<<"$R")" "0"
R=$(req GET /api/admin/products/low-stock "$AT")
assert_eq "low-stock 里 Q74 hasSkus=false" "$(jq -r ".data.groups[] | select(.productId==$Q74_PID) | .hasSkus" <<<"$R")" "false"
assert_eq "low-stock 里 Q74 单位 skuId=null" "$(jq -r ".data.groups[] | select(.productId==$Q74_PID) | .units[0].skuId" <<<"$R")" "null"
assert_eq "low-stock 里 Q74 level=OUT" "$(jq -r ".data.groups[] | select(.productId==$Q74_PID) | .units[0].level" <<<"$R")" "OUT"
R=$(p74_kw "E2E库存预警邮寄商品")
assert_eq "keyword 列表 Q74 stockAlert={1,0}" "$(jq -c '.data.list[0].stockAlert' <<<"$R")" '{"out":1,"low":0}'

echo "-- 74.9 休业：每日汇总不推、即时推送照常 --"
p74_local_put '.holiday={until:null,reason:"e2e休业"}' >/dev/null
R=$(sched '{"forceLowStockDaily":true}')
assert_eq "休业中 force 每日汇总仍 0" "$(num "$(jq -r .data.lowStockDaily <<<"$R")")" "0"
p74_stock "$P74_PID" "{\"skuId\":$P74_B,\"stock\":0}" >/dev/null   # B 从 1(LOW) 改到 0(OUT)
R=$(sched '{}')
assert_eq "休业日即时推送照常：B→0 推 1 条" "$(num "$(jq -r .data.lowStockScan <<<"$R")")" "1"
p74_local_put '.holiday=null' >/dev/null
R=$(sched '{"forceLowStockDaily":true}')
P74_LSD0=$(num "$(jq -r .data.lowStockDaily <<<"$R")")
[[ "$P74_LSD0" -ge 1 ]] && ok "恢复照推：force 每日汇总 ≥1 ($P74_LSD0)" || fail "恢复后每日汇总未推" "$R"

echo "-- 74.7 每日汇总：日切与 force --"
R=$(sched '{}')
assert_eq "紧接着不 force：当天已发 → 0" "$(num "$(jq -r .data.lowStockDaily <<<"$R")")" "0"
R=$(sched '{"forceLowStockDaily":true}')
P74_LSD1=$(num "$(jq -r .data.lowStockDaily <<<"$R")")
[[ "$P74_LSD1" -ge 1 ]] && ok "force 绕过日切，仍 ≥1 ($P74_LSD1)" || fail "force 未绕过日切" "$R"

echo "-- 74.8/74.10 收尾：删除清理 + 复位设置 --"
R=$(sql "SELECT value FROM settings WHERE setting_key='low_stock_alert_state';")
[[ "$R" == *"sku:$P74_A"* ]] && ok "删除前状态含 sku:$P74_A" || fail "删除前状态应含 sku:$P74_A" "$R"
req DELETE "/api/admin/products/$P74_PID" "$AT" >/dev/null
req DELETE "/api/admin/products/$Q74_PID" "$AT" >/dev/null
req DELETE "/api/admin/products/$X74_PID" "$AT" >/dev/null
sched '{}' >/dev/null
R=$(sql "SELECT value FROM settings WHERE setting_key='low_stock_alert_state';")
[[ "$R" != *"sku:$P74_A"* && "$R" != *"sku:$P74_B"* && "$R" != *"sku:$P74_C"* ]] && ok "删除 P74 后状态不再含它的三个 sku" || fail "删除后状态仍含 P74 的 sku" "$R"
[[ "$R" != *"product:$Q74_PID"* ]] && ok "删除 Q74 后状态不再含 product:$Q74_PID" || fail "删除后状态仍含 Q74" "$R"
req PUT /api/admin/settings/low-stock "$AT" '{"lowThreshold":3,"pushBelow":2}' >/dev/null
sched '{}' >/dev/null
