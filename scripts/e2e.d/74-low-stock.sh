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
# R2-2（修订 2）：并发一致性测试用——后台 mysql 会话（子 shell 里跑，不阻塞主脚本）与复位。
p74_sql_bg() { ( sql "$1" >/dev/null 2>&1 ) & }
# 修订 3（R4）：墙钟毫秒时间戳，用于断言 PUT 真的在锁上等过（macOS date 无 %N）。
p74_now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
p74_reset() {
  p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":10}" >/dev/null
  p74_stock "$P74_PID" "{\"skuId\":$P74_B,\"stock\":10}" >/dev/null
  p74_stock "$P74_PID" "{\"skuId\":$P74_C,\"stock\":10}" >/dev/null
}

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

echo "-- 74.12 PUT /:id 与 POST / 响应下发 stockAlert（R2-3） --"
# 此时（承接 74.5 收尾）P74：A=0(OUT) B=1(LOW) C=0(OUT)；Q74=0(OUT)
R=$(req PUT "/api/admin/products/$P74_PID" "$AT" '{"status":"OFF_SHELF"}')
assert_eq "PUT /:id 下架响应 stockAlert={0,0}" "$(jq -c '.data.stockAlert' <<<"$R")" '{"out":0,"low":0}'
R=$(req PUT "/api/admin/products/$P74_PID" "$AT" '{"status":"ON_SHELF"}')
assert_eq "PUT /:id 上架响应 stockAlert={2,1}（A/C 售罄、B 紧张）" "$(jq -c '.data.stockAlert' <<<"$R")" '{"out":2,"low":1}'
R=$(req PUT "/api/admin/products/$Q74_PID" "$AT" '{"stock":50}')
assert_eq "PUT /:id 改库存到 50 响应 stockAlert={0,0}" "$(jq -c '.data.stockAlert' <<<"$R")" '{"out":0,"low":0}'
R=$(req PUT "/api/admin/products/$Q74_PID" "$AT" '{"stock":0}')
assert_eq "PUT /:id 改回 0 响应 stockAlert={1,0}" "$(jq -c '.data.stockAlert' <<<"$R")" '{"out":1,"low":0}'

echo "-- 74.9 休业：每日汇总不推、即时推送照常 --"
# R2-4（修订 2，R6）：先把营业时段钉成全天 00:00-23:59，应发时刻=前一天 23:30，
# 任何跑分片的钟点都已过——不然本机上午 08:30 之前跑，「当天已发」这道门根本证明不了。
P74_BH_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data.businessHours)
p74_local_put '.businessHours=[{start:"00:00",end:"23:59"}]' >/dev/null
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

echo "-- 74.11 并发一致性（R1：锁读旧值 + 相对增量 + 死锁重试，L 级复核阻断项） --"
p74_reset
R=$(sql "SELECT stock FROM products WHERE id=$P74_PID;")
assert_eq "74.11 复位后 product=30" "$R" "30"

echo "-- 74.11-a 下单事务扣减 B 期间 PUT 改 A --"
p74_sql_bg "BEGIN; UPDATE product_skus SET stock=stock-1 WHERE id=$P74_B AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P74_PID; SELECT SLEEP(2); COMMIT;"
sleep 0.7
P74_T0=$(p74_now_ms)
R=$(p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":5}")
P74_T1=$(p74_now_ms)
assert_eq "74.11-a code 0" "$(code "$R")" "0"
assert_eq "74.11-a data.stock=5" "$(jq -r .data.stock <<<"$R")" "5"
assert_eq "74.11-a data.productStock=24" "$(jq -r .data.productStock <<<"$R")" "24"
wait
P74_A_PS=$(sql "SELECT stock FROM products WHERE id=$P74_PID;")
P74_A_SS=$(sql "SELECT COALESCE(SUM(stock),0) FROM product_skus WHERE product_id=$P74_PID;")
assert_eq "74.11-a products.stock == SUM(sku)" "$P74_A_PS" "$P74_A_SS"
assert_eq "74.11-a products.stock=24" "$P74_A_PS" "24"
assert_eq "74.11-a A=5" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_A;")" "5"
assert_eq "74.11-a B=9" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_B;")" "9"
P74_ELAPSED=$((P74_T1 - P74_T0))
[[ "$P74_ELAPSED" -ge 700 ]] && ok "74.11-a PUT 耗时 ${P74_ELAPSED}ms ≥700（确实等过锁，不是巧合绿）" || fail "74.11-a PUT 耗时 ${P74_ELAPSED}ms < 700，怀疑没有真正并发" "$P74_ELAPSED"

echo "-- 74.11-b 取消回滚 B+1 期间 PUT 改 A --"
p74_reset
p74_stock "$P74_PID" "{\"skuId\":$P74_B,\"stock\":0}" >/dev/null   # 先把 B 钉成 0（此时 product=20）
p74_sql_bg "BEGIN; UPDATE product_skus SET stock=stock+1 WHERE id=$P74_B; UPDATE products SET stock=stock+1, sales_count=sales_count-1 WHERE id=$P74_PID; SELECT SLEEP(2); COMMIT;"
sleep 0.7
P74_T0=$(p74_now_ms)
R=$(p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":0}")
P74_T1=$(p74_now_ms)
assert_eq "74.11-b code 0" "$(code "$R")" "0"
wait
P74_B_PS=$(sql "SELECT stock FROM products WHERE id=$P74_PID;")
P74_B_SS=$(sql "SELECT COALESCE(SUM(stock),0) FROM product_skus WHERE product_id=$P74_PID;")
assert_eq "74.11-b products.stock == SUM(sku)" "$P74_B_PS" "$P74_B_SS"
assert_eq "74.11-b products.stock=11" "$P74_B_PS" "11"
assert_eq "74.11-b A=0" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_A;")" "0"
assert_eq "74.11-b B=1" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_B;")" "1"
P74_ELAPSED=$((P74_T1 - P74_T0))
[[ "$P74_ELAPSED" -ge 700 ]] && ok "74.11-b PUT 耗时 ${P74_ELAPSED}ms ≥700（确实等过锁，不是巧合绿）" || fail "74.11-b PUT 耗时 ${P74_ELAPSED}ms < 700，怀疑没有真正并发" "$P74_ELAPSED"

echo "-- 74.11-c 两行订单（先 B 后 A）与 PUT 改 A 互锁 → InnoDB 死锁检测 → PUT 重试后成功 --"
p74_reset
p74_sql_bg "BEGIN; UPDATE product_skus SET stock=stock-1 WHERE id=$P74_B AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P74_PID; SELECT SLEEP(1.5); UPDATE product_skus SET stock=stock-1 WHERE id=$P74_A AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P74_PID; COMMIT;"
sleep 0.7
P74_T0=$(p74_now_ms)
R=$(p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":5}")
P74_T1=$(p74_now_ms)
assert_eq "74.11-c code 0（P2034 重试后成功，不是 5xx）" "$(code "$R")" "0"
wait
P74_C_PS=$(sql "SELECT stock FROM products WHERE id=$P74_PID;")
P74_C_SS=$(sql "SELECT COALESCE(SUM(stock),0) FROM product_skus WHERE product_id=$P74_PID;")
assert_eq "74.11-c products.stock == SUM(sku)" "$P74_C_PS" "$P74_C_SS"
assert_eq "74.11-c A=5" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_A;")" "5"
P74_C_B=$(sql "SELECT stock FROM product_skus WHERE id=$P74_B;")
[[ "$P74_C_B" == "9" || "$P74_C_B" == "10" ]] && ok "74.11-c B∈{9,10}（实际 $P74_C_B，取决于死锁牺牲者是订单会话还是 PUT）" || fail "74.11-c B 值异常" "$P74_C_B"
P74_ELAPSED=$((P74_T1 - P74_T0))
[[ "$P74_ELAPSED" -ge 700 ]] && ok "74.11-c PUT 耗时 ${P74_ELAPSED}ms ≥700（确实等过锁，不是巧合绿）" || fail "74.11-c PUT 耗时 ${P74_ELAPSED}ms < 700，怀疑没有真正并发" "$P74_ELAPSED"

# 修订 3（L 级复核 R2·规划缺口）：锁序分析漏了外键 S 锁——INSERT order_items 因外键
# order_items_product_id_fkey 先给 products 行加 S 锁，单笔订单（不用跨两个规格）与改
# 库存打**同一规格**也会成环；打不同规格不成环，只是排队等锁。e/f 两步复现这两种形态。
echo "-- 74.11-e 外键 S 锁 · 同一规格（订单行与改库存打同一个 sku，单笔订单也成环，R2） --"
p74_reset
P74_OID=$(sql "SELECT MAX(id) FROM orders;")
if [[ -z "$P74_OID" || "$P74_OID" == "NULL" ]]; then
  fail "74.11-e 前置：orders 表取不到可引用的 id（分段顺序异常，需上报，不得自造 orders 行）" "P74_OID=[$P74_OID]"
else
  p74_sql_bg "BEGIN; INSERT INTO order_items (order_id,product_id,sku_id,product_name,product_price,quantity,subtotal,updated_at) VALUES ($P74_OID,$P74_PID,$P74_A,'e2e-fk-lock',1000,1,1000,NOW(3)); SELECT SLEEP(1.5); UPDATE product_skus SET stock=stock-1 WHERE id=$P74_A AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P74_PID; COMMIT;"
  sleep 0.7
  P74_T0=$(p74_now_ms)
  R=$(p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":5}")
  P74_T1=$(p74_now_ms)
  assert_eq "74.11-e code 0（外键 S 锁+同一规格也会成环，重试后成功，不是 5xx）" "$(code "$R")" "0"
  assert_eq "74.11-e data.stock=5" "$(jq -r .data.stock <<<"$R")" "5"
  wait
  P74_E_PS=$(sql "SELECT stock FROM products WHERE id=$P74_PID;")
  P74_E_SS=$(sql "SELECT COALESCE(SUM(stock),0) FROM product_skus WHERE product_id=$P74_PID;")
  assert_eq "74.11-e products.stock == SUM(sku)" "$P74_E_PS" "$P74_E_SS"
  assert_eq "74.11-e products.stock=25" "$P74_E_PS" "25"
  assert_eq "74.11-e A=5" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_A;")" "5"
  assert_eq "74.11-e B=10（无论哪一方是牺牲者，终值都相同）" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_B;")" "10"
  assert_eq "74.11-e C=10" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_C;")" "10"
  P74_ELAPSED=$((P74_T1 - P74_T0))
  [[ "$P74_ELAPSED" -ge 700 ]] && ok "74.11-e PUT 耗时 ${P74_ELAPSED}ms ≥700（确实等过锁，不是巧合绿）" || fail "74.11-e PUT 耗时 ${P74_ELAPSED}ms < 700，怀疑没有真正并发" "$P74_ELAPSED"
  sql "DELETE FROM order_items WHERE product_name='e2e-fk-lock';"
fi

echo "-- 74.11-f 外键 S 锁 · 不同规格（订单行是另一规格，不成环，只是排队等锁） --"
p74_reset
P74_OID=$(sql "SELECT MAX(id) FROM orders;")
if [[ -z "$P74_OID" || "$P74_OID" == "NULL" ]]; then
  fail "74.11-f 前置：orders 表取不到可引用的 id（分段顺序异常，需上报，不得自造 orders 行）" "P74_OID=[$P74_OID]"
else
  p74_sql_bg "BEGIN; INSERT INTO order_items (order_id,product_id,sku_id,product_name,product_price,quantity,subtotal,updated_at) VALUES ($P74_OID,$P74_PID,$P74_B,'e2e-fk-lock',1000,1,1000,NOW(3)); SELECT SLEEP(1.5); UPDATE product_skus SET stock=stock-1 WHERE id=$P74_B AND stock>=1; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$P74_PID; COMMIT;"
  sleep 0.7
  P74_T0=$(p74_now_ms)
  R=$(p74_stock "$P74_PID" "{\"skuId\":$P74_A,\"stock\":5}")
  P74_T1=$(p74_now_ms)
  assert_eq "74.11-f code 0（不同规格不成环，只是排队等订单提交后的 products 行锁）" "$(code "$R")" "0"
  wait
  P74_F_PS=$(sql "SELECT stock FROM products WHERE id=$P74_PID;")
  P74_F_SS=$(sql "SELECT COALESCE(SUM(stock),0) FROM product_skus WHERE product_id=$P74_PID;")
  assert_eq "74.11-f products.stock == SUM(sku)" "$P74_F_PS" "$P74_F_SS"
  assert_eq "74.11-f A=5" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_A;")" "5"
  assert_eq "74.11-f B=9" "$(sql "SELECT stock FROM product_skus WHERE id=$P74_B;")" "9"
  P74_ELAPSED=$((P74_T1 - P74_T0))
  [[ "$P74_ELAPSED" -ge 700 ]] && ok "74.11-f PUT 耗时 ${P74_ELAPSED}ms ≥700（确实等过锁，不是巧合绿）" || fail "74.11-f PUT 耗时 ${P74_ELAPSED}ms < 700，怀疑没有真正并发" "$P74_ELAPSED"
  sql "DELETE FROM order_items WHERE product_name='e2e-fk-lock';"
fi

echo "-- 74.11-d 无规格商品：绝对值编辑语义（无 sum 不变量，不做锁读+增量）；R4：改真并发，PUT 要真等过锁 --"
p74_stock "$Q74_PID" '{"stock":10}' >/dev/null   # 先把 Q 钉成 10
p74_sql_bg "BEGIN; UPDATE products SET stock=stock-1, sales_count=sales_count+1 WHERE id=$Q74_PID AND stock>=1; SELECT SLEEP(2); COMMIT;"
sleep 0.7
P74_T0=$(p74_now_ms)
R=$(p74_stock "$Q74_PID" '{"stock":7}')
P74_T1=$(p74_now_ms)
assert_eq "74.11-d code 0" "$(code "$R")" "0"
assert_eq "74.11-d productStock=7" "$(jq -r .data.productStock <<<"$R")" "7"
wait
assert_eq "74.11-d products.stock=7（绝对值语义）" "$(sql "SELECT stock FROM products WHERE id=$Q74_PID;")" "7"
P74_ELAPSED=$((P74_T1 - P74_T0))
[[ "$P74_ELAPSED" -ge 1000 ]] && ok "74.11-d PUT 耗时 ${P74_ELAPSED}ms ≥1000（真等过锁，不是裸 UPDATE 瞬间提交后的巧合绿）" || fail "74.11-d PUT 耗时 ${P74_ELAPSED}ms < 1000，怀疑没有真正并发" "$P74_ELAPSED"

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
p74_local_put ".businessHours=$P74_BH_ORIG" >/dev/null
sched '{}' >/dev/null
