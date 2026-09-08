# §54 经营概览三接口（overview / local / express）与老接口的新口径。
# 口径见 docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md §3。
# 全部走「记基线 → 造单 → 比差值」，与 §33 同款：只断言 code 0 证明不了口径接上了。
echo "== 54. 经营概览：三接口与统一付款日口径 =="
S54=$(date +%F)
d54() { req GET "/api/admin/stats/$1?startDate=$S54&endDate=$S54" "$AT"; }

# ── A. 老接口：未付款单不进「今日单数」与趋势（原来按 created_at + status!=CANCELLED 会算进去） ──
A_TODAY=$(req GET /api/admin/stats "$AT" | jq -r '.data.today.orderCount')
A_TREND=$(req GET "/api/admin/stats/trend?days=7" "$AT" | jq -r --arg d "$S54" '[.data.list[]|select(.date==$d)][0].orderCount // 0')
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); C54=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$C54],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
UNPAID54=$(jq -r '.data.orderId // .data.id // empty' <<<"$R")
[[ -n "$UNPAID54" ]] && ok "造一张未付款单 #$UNPAID54" || fail "造未付款单" "$R"
assert_eq "A① 未付款单不进今日单数" "$(req GET /api/admin/stats "$AT" | jq -r '.data.today.orderCount')" "$A_TODAY"
assert_eq "A② 未付款单不进趋势图" "$(req GET "/api/admin/stats/trend?days=7" "$AT" | jq -r --arg d "$S54" '[.data.list[]|select(.date==$d)][0].orderCount // 0')" "$A_TREND"
req PUT "/api/orders/$UNPAID54/cancel" "$UT" >/dev/null   # 不留待付款单给后面的段

# ── B. overview：造一张已付邮寄单，各口径 +1 ──
B0=$(d54 overview)
assert_eq "B 参数：startDate 格式错 40001" "$(code "$(req GET '/api/admin/stats/overview?startDate=2026/09/08' "$AT")")" "40001"
assert_eq "B 参数：区间 >92 天 40001" "$(code "$(req GET '/api/admin/stats/overview?startDate=2026-01-01&endDate=2026-06-30' "$AT")")" "40001"
assert_eq "B 参数：默认区间 code 0" "$(code "$(req GET /api/admin/stats/overview "$AT")")" "0"
B_CNT=$(jq -r .data.kpi.orderCount <<<"$B0"); B_REV=$(jq -r .data.kpi.revenueFen <<<"$B0")
B_EXP=$(jq -r .data.channels.EXPRESS.orderCount <<<"$B0")
B_HOT=$(jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0' <<<"$B0")
B_USERS=$(jq -r .data.customers.users <<<"$B0")
B_HOT_L=$(req GET "/api/admin/stats/overview?startDate=$S54&endDate=$S54&channel=LOCAL" "$AT" | jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0')
BO=$(make_paid_order); [[ -n "$BO" ]] && ok "B 造已付邮寄单 #$BO" || fail "B 造单"
BO_AMT=$(req GET "/api/admin/orders/$BO" "$AT" | jq -r .data.actualAmount)
B1=$(d54 overview)
assert_eq "B① 单数 +1" "$(jq -r .data.kpi.orderCount <<<"$B1")" "$((B_CNT+1))"
assert_eq "B② 实收 +实付" "$(jq -r .data.kpi.revenueFen <<<"$B1")" "$((B_REV+BO_AMT))"
assert_eq "B③ 邮寄渠道 +1" "$(jq -r .data.channels.EXPRESS.orderCount <<<"$B1")" "$((B_EXP+1))"
assert_eq "B④ 趋势今日 = 两渠道之和 = kpi 单数" "$(jq -r --arg d "$S54" '[.data.trend[]|select(.date==$d)][0] | (.LOCAL.orderCount + .EXPRESS.orderCount)' <<<"$B1")" "$((B_CNT+1))"
assert_eq "B⑤ 24 小时桶之和 = kpi 单数" "$(jq -r '.data.hourly | add' <<<"$B1")" "$((B_CNT+1))"
assert_eq "B⑥ 热销榜该商品 qty +1（按 order_items 聚合）" "$(jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0' <<<"$B1")" "$((B_HOT+1))"
# 服务端用 Math.round(revenueFen/orderCount)（四舍五入），bash 的 `/` 是截断——
# 除不尽时两者可能差 1，用整数四舍五入公式 (num + den/2) / den 对齐，不是放宽断言。
B7_REV=$((B_REV+BO_AMT)); B7_CNT=$((B_CNT+1))
assert_eq "B⑦ 客单价 = 实收/单数（四舍五入）" "$(jq -r .data.kpi.avgOrderFen <<<"$B1")" "$(( (B7_REV + B7_CNT/2) / B7_CNT ))"
assert_eq "B⑧ 顾客数 = 新客 + 老客" "$(jq -r '.data.customers | (.newUsers + .returningUsers)' <<<"$B1")" "$(jq -r .data.customers.users <<<"$B1")"
[[ "$(jq -r .data.customers.users <<<"$B1")" -ge "$B_USERS" ]] && ok "B⑨ 顾客数不减少" || fail "B⑨ 顾客数" "$B1"
assert_eq "B⑩ channel=LOCAL 的热销榜不受邮寄单影响" "$(req GET "/api/admin/stats/overview?startDate=$S54&endDate=$S54&channel=LOCAL" "$AT" | jq -r --argjson p "$PID" '[.data.hotProducts[]|select(.productId==$p)][0].qty // 0')" "$B_HOT_L"

