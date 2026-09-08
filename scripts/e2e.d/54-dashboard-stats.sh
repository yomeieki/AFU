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
