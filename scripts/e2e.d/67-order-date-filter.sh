echo "== 67. 订单列表日期筛选（上海自然日，按下单时间）与 latestDelivery =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/mk_local_paid/sql 与 $AT。
# 变量一律 D67_ 前缀。

D67_OID=$(mk_local_paid); [[ -n "$D67_OID" ]] && ok "造同城单 #$D67_OID" || fail "D67 造单失败"
# 把下单时间改到「北京 2026-09-18 00:30」（= UTC 2026-09-17 16:30），验证跨自然日边界。
sql "UPDATE orders SET created_at='2026-09-17 16:30:00.000' WHERE id=$D67_OID;"
D67_NO=$(sql "SELECT order_no FROM orders WHERE id=$D67_OID;")
[[ -n "$D67_NO" ]] && ok "取到订单号 $D67_NO" || fail "D67 取订单号失败"

D67_R1=$(req GET "/api/admin/orders?channel=LOCAL&keyword=$D67_NO&startDate=2026-09-18&endDate=2026-09-18" "$AT")
assert_eq "① 北京 09-18 当天区间命中该单" "$(jq -r '.data.total' <<<"$D67_R1")" "1"

D67_R2=$(req GET "/api/admin/orders?channel=LOCAL&keyword=$D67_NO&startDate=2026-09-17&endDate=2026-09-17" "$AT")
assert_eq "② 凌晨单不属于前一个自然日" "$(jq -r '.data.total' <<<"$D67_R2")" "0"

D67_R3=$(req GET "/api/admin/orders?channel=LOCAL&keyword=$D67_NO&startDate=2026-09-18" "$AT")
assert_eq "③ 只给起（09-18 起）命中" "$(jq -r '.data.total' <<<"$D67_R3")" "1"

D67_R4=$(req GET "/api/admin/orders?channel=LOCAL&keyword=$D67_NO&endDate=2026-09-17" "$AT")
assert_eq "④ 只给止（09-17 止）不命中" "$(jq -r '.data.total' <<<"$D67_R4")" "0"

assert_eq "⑤ 非法日历日 40001" "$(code "$(req GET "/api/admin/orders?channel=LOCAL&startDate=2026-02-30" "$AT")")" "40001"
assert_eq "⑥ 起晚于止 40001" "$(code "$(req GET "/api/admin/orders?channel=LOCAL&startDate=2026-09-18&endDate=2026-09-17" "$AT")")" "40001"
assert_eq "⑦ 格式非法（斜杠）40001" "$(code "$(req GET "/api/admin/orders?channel=LOCAL&startDate=2026/09/18" "$AT")")" "40001"

D67_R5=$(req GET "/api/admin/orders?channel=LOCAL&keyword=$D67_NO" "$AT")
assert_eq "⑧ 不带日期：默认全部，该单仍在" "$(jq -r '.data.total' <<<"$D67_R5")" "1"
[[ "$(jq -r '.data.list[0] | has("latestDelivery")' <<<"$D67_R5")" == "true" ]] \
  && ok "⑨ 列表第一条含 latestDelivery 键" \
  || fail "⑨ latestDelivery 键缺失" "$D67_R5"

# 收尾：别让这张单的凌晨时间戳影响后面分片的「今日」统计
sql "UPDATE orders SET created_at=NOW(3) WHERE id=$D67_OID;"
