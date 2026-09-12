# §54 经营概览三接口（overview / local / express）与老接口的新口径。
# 口径见 docs/superpowers/specs/2026-09-08-dashboard-redesign-design.md §3。
# 全部走「记基线 → 造单 → 比差值」，与 §33 同款：只断言 code 0 证明不了口径接上了。
# 所有进算术 / [[ -ge ]] 的数字都过 num()：接口 500 时 jq 吐 "null"，不过闸的话 set -u 会把整个脚本掐死
# （§30 踩过，见 e2e.sh 顶部注释），这里只会红一条。
echo "== 54. 经营概览：三接口与统一付款日口径 =="
S54=$(date +%F)
d54() { req GET "/api/admin/stats/$1?startDate=$S54&endDate=$S54" "$AT"; }
n54() { num "$(jq -r "$2" <<<"$1")"; }   # n54 JSON JQ_EXPR → 整数或 -1
# macOS 是 date -v，Linux 是 date -d；两边都试
day_ago() { date -v-"$1"d +%F 2>/dev/null || date -d "$1 days ago" +%F; }

# ── A. 老接口：未付款单不进「今日单数」与趋势（原来按 created_at + status!=CANCELLED 会算进去） ──
A_TODAY=$(n54 "$(req GET /api/admin/stats "$AT")" '.data.today.orderCount')
A_TREND=$(n54 "$(req GET "/api/admin/stats/trend?days=7" "$AT")" "[.data.list[]|select(.date==\"$S54\")][0].orderCount // 0")
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); C54=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$C54],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
UNPAID54=$(jq -r '.data.orderId // .data.id // empty' <<<"$R")
[[ -n "$UNPAID54" ]] && ok "造一张未付款单 #$UNPAID54" || fail "造未付款单" "$R"
assert_eq "A① 未付款单不进今日单数" "$(n54 "$(req GET /api/admin/stats "$AT")" '.data.today.orderCount')" "$A_TODAY"
assert_eq "A② 未付款单不进趋势图" "$(n54 "$(req GET "/api/admin/stats/trend?days=7" "$AT")" "[.data.list[]|select(.date==\"$S54\")][0].orderCount // 0")" "$A_TREND"
req PUT "/api/orders/$UNPAID54/cancel" "$UT" >/dev/null   # 不留待付款单给后面的段

# ── B. overview：造一张已付邮寄单，各口径 +1 ──
B0=$(d54 overview); D0=$(d54 express)
assert_eq "B 参数：startDate 格式错 40001" "$(code "$(req GET '/api/admin/stats/overview?startDate=2026/09/08' "$AT")")" "40001"
assert_eq "B 参数：区间 >92 天 40001" "$(code "$(req GET '/api/admin/stats/overview?startDate=2026-01-01&endDate=2026-06-30' "$AT")")" "40001"
assert_eq "B 参数：默认区间 code 0" "$(code "$(req GET /api/admin/stats/overview "$AT")")" "0"
B_CNT=$(n54 "$B0" .data.kpi.orderCount); B_REV=$(n54 "$B0" .data.kpi.revenueFen)
B_EXP=$(n54 "$B0" .data.channels.EXPRESS.orderCount)
B_HOT=$(n54 "$B0" "[.data.hotProducts[]|select(.productId==$PID)][0].qty // 0")
B_USERS=$(n54 "$B0" .data.customers.users)
B_HOT_L=$(n54 "$(req GET "/api/admin/stats/overview?startDate=$S54&endDate=$S54&channel=LOCAL" "$AT")" "[.data.hotProducts[]|select(.productId==$PID)][0].qty // 0")
D_SHIP0=$(n54 "$D0" .data.kpi.shippingFeeFen)
BO=$(make_paid_order); [[ -n "$BO" ]] && ok "B 造已付邮寄单 #$BO" || fail "B 造单"
R=$(req GET "/api/admin/orders/$BO" "$AT")
BO_AMT=$(n54 "$R" .data.actualAmount); BO_SHIP=$(n54 "$R" .data.shippingFee); BO_PROV=$(jq -r '.data.receiverProvince // ""' <<<"$R")
D_PROV0=$(n54 "$D0" "[.data.regions[]|select(.province==\"$BO_PROV\")][0].count // 0")
B1=$(d54 overview)
assert_eq "B① 单数 +1" "$(n54 "$B1" .data.kpi.orderCount)" "$((B_CNT+1))"
assert_eq "B② 实收 +实付" "$(n54 "$B1" .data.kpi.revenueFen)" "$((B_REV+BO_AMT))"
assert_eq "B③ 邮寄渠道 +1" "$(n54 "$B1" .data.channels.EXPRESS.orderCount)" "$((B_EXP+1))"
# 三个渠道都要加上：自取（PICKUP）是 6d6a5d9 后加进趋势的，只加两个渠道会差掉当天的自取单
assert_eq "B④ 趋势今日 = 三渠道之和 = kpi 单数" "$(n54 "$B1" "[.data.trend[]|select(.date==\"$S54\")][0] | (.LOCAL.orderCount + .EXPRESS.orderCount + (.PICKUP.orderCount // 0))")" "$((B_CNT+1))"
assert_eq "B⑤ 24 小时桶之和 = kpi 单数" "$(n54 "$B1" '.data.hourly | add')" "$((B_CNT+1))"
assert_eq "B⑥ 热销榜该商品 qty +1（按 order_items 聚合）" "$(n54 "$B1" "[.data.hotProducts[]|select(.productId==$PID)][0].qty // 0")" "$((B_HOT+1))"
# 服务端用 Math.round(revenueFen/orderCount)（四舍五入），bash 的 `/` 是截断——
# 除不尽时两者可能差 1，用整数四舍五入公式 (num + den/2) / den 对齐，不是放宽断言。
B7_REV=$((B_REV+BO_AMT)); B7_CNT=$((B_CNT+1))
assert_eq "B⑦ 客单价 = 实收/单数（四舍五入）" "$(n54 "$B1" .data.kpi.avgOrderFen)" "$(( (B7_REV + B7_CNT/2) / B7_CNT ))"
# e2e 用户在前面几十段里早就付过款，今天再下单必须算老客；「老客 = 顾客 − 新客」在服务端是恒等式，断言它没有意义
[[ "$(n54 "$B1" .data.customers.returningUsers)" -ge 1 ]] && ok "B⑧ 有历史订单的用户算老客" || fail "B⑧ 老客" "$(jq -c .data.customers <<<"$B1")"
[[ "$(n54 "$B1" .data.customers.users)" -ge "$B_USERS" ]] && ok "B⑨ 顾客数不减少" || fail "B⑨ 顾客数" "$B1"
assert_eq "B⑩ channel=LOCAL 的热销榜不受邮寄单影响" "$(n54 "$(req GET "/api/admin/stats/overview?startDate=$S54&endDate=$S54&channel=LOCAL" "$AT")" "[.data.hotProducts[]|select(.productId==$PID)][0].qty // 0")" "$B_HOT_L"

# ── C. local：同城单走到送达，运费账 / 时效 / 承运商 / 阶梯都要动 ──
C0=$(d54 local)
C_CNT=$(n54 "$C0" .data.kpi.orderCount); C_PAID=$(n54 "$C0" .data.freight.customerPaidFen)
C_DEL=$(n54 "$C0" .data.freight.deliveryFen); C_RT=$(n54 "$C0" .data.freight.riderTotalFen)
C_TOTN=$(n54 "$C0" '[.data.timing.stages[]|select(.key=="total")][0].n')
C_LAD=$(n54 "$C0" '.data.ladder | (.first + .cheapestN + .all)')
C_SS=$(n54 "$C0" '[.data.providers[]|select(.provider=="shansongtongcheng")][0].count // 0')
CO=$(mk_local_paid); [[ -n "$CO" ]] && ok "C 造已付同城单 #$CO" || fail "C 造单"
req POST "/api/admin/local/orders/$CO/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CO/call" "$AT"); CD=$(jq -r .data.deliveryNo <<<"$R")
CT=$(req GET "/api/admin/local/orders/$CO/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
NOW54=$(date '+%F %H:%M')
kd_cb "$CD" "$CT" 100 '骑手已接单' "$NOW54:01" >/dev/null
kd_cb "$CD" "$CT" 310 '骑手已取货' "$NOW54:02" >/dev/null
kd_cb "$CD" "$CT" 520 '已送达' "$NOW54:03" >/dev/null
assert_eq "C 前置：订单已 COMPLETED" "$(order_status $CO)" "COMPLETED"
CO_SHIP=$(n54 "$(req GET "/api/admin/orders/$CO" "$AT")" .data.shippingFee)
CO_FEE=$(n54 "$(req GET "/api/admin/local/orders/$CO/delivery" "$AT")" '.data.delivery | (.actualFee // .quotedFee)')
C1=$(d54 local)
assert_eq "C① 同城单数 +1" "$(n54 "$C1" .data.kpi.orderCount)" "$((C_CNT+1))"
assert_eq "C② 顾客付运费 +本单运费" "$(n54 "$C1" .data.freight.customerPaidFen)" "$((C_PAID+CO_SHIP))"
assert_eq "C③ 付给骑手·配送费 +本单实扣" "$(n54 "$C1" .data.freight.deliveryFen)" "$((C_DEL+CO_FEE))"
# 期望值全部用造单前的基线 + 本单独立读到的两个数算，不从同一响应里抄
assert_eq "C④ 运费差额 = (基线顾客付 + 本单运费) − (基线骑手合计 + 本单实扣)" "$(n54 "$C1" .data.freight.netFen)" "$(( (C_PAID+CO_SHIP) - (C_RT+CO_FEE) ))"
assert_eq "C⑤ 时效 total 样本 +1" "$(n54 "$C1" '[.data.timing.stages[]|select(.key=="total")][0].n')" "$((C_TOTN+1))"
assert_eq "C⑥ 时效 5 个阶段齐全" "$(n54 "$C1" '.data.timing.stages | length')" "5"
assert_eq "C⑦ 承运商 闪送 +1" "$(n54 "$C1" '[.data.providers[]|select(.provider=="shansongtongcheng")][0].count // 0')" "$((C_SS+1))"
assert_eq "C⑧ 呼叫阶梯三项之和 +1" "$(n54 "$C1" '.data.ladder | (.first + .cheapestN + .all)')" "$((C_LAD+1))"
assert_eq "C⑨ 距离分布之和 = 同城单数" "$(n54 "$C1" '[.data.distance[].count] | add')" "$((C_CNT+1))"

# ── D. express：B 段那张邮寄单还没发货 → 待发货积压里有它 ──
D1=$(d54 express)
[[ "$(n54 "$D1" .data.kpi.orderCount)" -ge 1 ]] && ok "D① 邮寄单数含 B 段那单" || fail "D① 邮寄单数" "$D1"
[[ "$(n54 "$D1" .data.backlog.count)" -ge 1 ]] && ok "D② 待发货积压 ≥1" || fail "D② 积压" "$D1"
assert_eq "D③ 积压最久单有单号" "$(jq -r '.data.backlog.oldestOrderNo | type' <<<"$D1")" "string"
assert_eq "D④ 运费收入 +本单运费" "$(n54 "$D1" .data.kpi.shippingFeeFen)" "$((D_SHIP0+BO_SHIP))"
assert_eq "D⑤ 收件地 Top 里本单省份 +1" "$(n54 "$D1" "[.data.regions[]|select(.province==\"$BO_PROV\")][0].count // 0")" "$((D_PROV0+1))"

# ── E. 测试单隔离：三接口都必须真的变小（§33 同款） ──
E_O=$(n54 "$(d54 overview)" .data.kpi.orderCount); E_L=$(n54 "$(d54 local)" .data.kpi.orderCount); E_E=$(n54 "$(d54 express)" .data.kpi.orderCount)
req PATCH "/api/admin/orders/$BO/test-flag" "$AT" '{"isTest":true}' >/dev/null
req PATCH "/api/admin/orders/$CO/test-flag" "$AT" '{"isTest":true}' >/dev/null
assert_eq "E① overview −2" "$(n54 "$(d54 overview)" .data.kpi.orderCount)" "$((E_O-2))"
assert_eq "E② local −1" "$(n54 "$(d54 local)" .data.kpi.orderCount)" "$((E_L-1))"
assert_eq "E③ express −1" "$(n54 "$(d54 express)" .data.kpi.orderCount)" "$((E_E-1))"
assert_eq "E④ 热销榜不含测试单（回到 B 段前）" "$(n54 "$(d54 overview)" "[.data.hotProducts[]|select(.productId==$PID)][0].qty // 0")" "$B_HOT"
req PATCH "/api/admin/orders/$BO/test-flag" "$AT" '{"isTest":false}' >/dev/null
req PATCH "/api/admin/orders/$CO/test-flag" "$AT" '{"isTest":false}' >/dev/null
assert_eq "E⑤ 取消标记后 overview 回来" "$(n54 "$(d54 overview)" .data.kpi.orderCount)" "$E_O"

# ── F. 上期区间：每张卡的「较上期」箭头都靠它，算错一天整页方向都反 ──
assert_eq "F① 今日的上期 = 昨日" "$(jq -r '.data.range | .prevStartDate + "/" + .prevEndDate' <<<"$(d54 overview)")" "$(day_ago 1)/$(day_ago 1)"
R=$(req GET "/api/admin/stats/overview?startDate=$(day_ago 6)&endDate=$S54" "$AT")
assert_eq "F② 近 7 天的上期 = 再往前 7 天" "$(jq -r '.data.range | .prevStartDate + "/" + .prevEndDate' <<<"$R")" "$(day_ago 13)/$(day_ago 7)"
