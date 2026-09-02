#!/usr/bin/env bash
# 后端 API 全链路回归（本机 mock 模式）
# 前置：后端以 PORT=3100 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true 启动，MySQL 已 seed（admin/admin123456）
# 用法：bash scripts/e2e.sh            （BASE 默认 http://localhost:3100）
#       BASE=http://localhost:3000 bash scripts/e2e.sh
set -uo pipefail

BASE="${BASE:-http://localhost:3100}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123456}"
PASS=0; FAIL=0

for cmd in curl jq; do command -v $cmd >/dev/null || { echo "需要 $cmd"; exit 1; }; done

ok()   { PASS=$((PASS+1)); echo "  ✔ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✘ $1"; [[ -n "${2:-}" ]] && echo "      $2"; }
assert_eq() { # desc actual expected
  if [[ "$2" == "$3" ]]; then ok "$1"; else fail "$1" "期望 [$3] 实际 [$2]"; fi
}
# req METHOD PATH [TOKEN] [JSON]
req() {
  local m=$1 p=$2 t=${3:-} d=${4:-}
  curl -s -X "$m" "$BASE$p" -H 'Content-Type: application/json' ${t:+-H "Authorization: Bearer $t"} ${d:+-d "$d"}
}
code() { jq -r '.code' <<<"$1"; }

echo "== 0. 健康检查 =="
H=$(curl -s -w '\n%{http_code}' "$BASE/health"); HB=$(head -1 <<<"$H"); HC=$(tail -1 <<<"$H")
assert_eq "GET /health 200" "$HC" "200"
assert_eq "/health db=ok" "$(jq -r .db <<<"$HB")" "ok"

echo "== 1. 管理员登录 =="
R=$(req POST /api/admin/login "" "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}")
AT=$(jq -r '.data.token // empty' <<<"$R")
[[ -n "$AT" ]] && ok "admin 登录" || { fail "admin 登录" "$R"; echo "无法继续"; exit 1; }

echo "== 2. 图片上传 =="
PNG=$(mktemp).png
base64 -d <<<'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' > "$PNG"
R=$(curl -s -X POST "$BASE/api/admin/upload" -H "Authorization: Bearer $AT" -F "file=@$PNG;type=image/png")
URL=$(jq -r '.data.url // empty' <<<"$R")
[[ -n "$URL" ]] && ok "上传返回 URL ($(jq -r .data.storage <<<"$R"))" || fail "上传" "$R"
if [[ -n "$URL" ]]; then
  UC=$(curl -s -o /dev/null -w '%{http_code}' -I "$URL"); assert_eq "上传 URL 可访问 (HEAD)" "$UC" "200"
fi

echo "== 3. 系统状态字段 =="
R=$(req GET /api/admin/system/status "$AT")
assert_eq "system/status code" "$(code "$R")" "0"
for k in pay.verifyMode pay.refundNotifyUrlSet cos.enabled notify.systemAlertWecomSet; do
  v=$(jq -r ".data.$k" <<<"$R"); [[ "$v" != "null" ]] && ok "字段 $k=$v" || fail "字段 $k 缺失"
done

echo "== 4. 用户 mock 登录 + 地址 =="
R=$(req POST /api/auth/wechat-login "" '{"code":"e2e_test_code"}')
UT=$(jq -r '.data.token // empty' <<<"$R")
[[ -n "$UT" ]] && ok "用户登录" || { fail "用户登录" "$R"; exit 1; }
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E测试","receiverPhone":"13800000000","province":"四川省","city":"成都市","district":"武侯区","detail":"测试路1号","isDefault":1}')
ADDR=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$ADDR" ]] && ok "创建地址 #$ADDR" || fail "创建地址" "$R"

echo "== 5. 选商品（无 SKU、有库存）=="
R=$(req GET "/api/products?pageSize=50" "$UT")
PID=$(jq -r '[.data.list[] | select((.stock // 0) > 5) | select(.hasSkus != true)] | .[0].id // empty' <<<"$R")
[[ -n "$PID" ]] && ok "商品 #$PID" || { fail "找不到可用无 SKU 商品" "$(jq -c '.data.list[0:3]' <<<"$R")"; exit 1; }

make_paid_order() { # 返回 orderId；下单 + mock 支付
  local r cid oid
  r=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}")
  cid=$(jq -r '.data.id // empty' <<<"$r"); [[ -n "$cid" ]] || { echo "" ; return; }
  r=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$cid],\"addressId\":$ADDR,\"deliveryType\":\"LOCAL\"}")
  oid=$(jq -r '.data.orderId // .data.id // empty' <<<"$r"); [[ -n "$oid" ]] || { echo ""; return; }
  r=$(req POST "/api/orders/$oid/pay" "$UT")
  [[ "$(jq -r .data.mode <<<"$r")" == "mock" ]] || { echo ""; return; }
  echo "$oid"
}
order_status() { req GET "/api/admin/orders/$1" "$AT" | jq -r .data.status; }
latest_refund() { req GET "/api/admin/orders?orderNo=$1" "$AT" | jq -r '.data.list[0].latestRefund.status // "none"'; }

echo "== 6. 下单 → mock 支付 → 接单 → 退款（金额校验 + 成功）=="
O1=$(make_paid_order); [[ -n "$O1" ]] && ok "订单 #$O1 已支付" || { fail "下单/支付"; exit 1; }
assert_eq "状态 PAID" "$(order_status $O1)" "PAID"
R=$(req POST "/api/admin/orders/$O1/accept" "$AT"); assert_eq "接单 → PREPARING" "$(jq -r .data.status <<<"$R")" "PREPARING"
AMT=$(req GET "/api/admin/orders/$O1" "$AT" | jq -r .data.actualAmount)
ONO=$(req GET "/api/admin/orders/$O1" "$AT" | jq -r .data.orderNo)
R=$(req POST "/api/admin/orders/$O1/refund" "$AT" "{\"amount\":$((AMT+1))}")
assert_eq "错金额被拒 42206" "$(code "$R")" "42206"
R=$(req POST "/api/admin/orders/$O1/refund" "$AT" "{\"amount\":$AMT,\"reason\":\"e2e\"}")
assert_eq "正确金额退款 code 0" "$(code "$R")" "0"
assert_eq "mode=mock" "$(jq -r .data.mode <<<"$R")" "mock"
assert_eq "订单 → REFUNDED" "$(order_status $O1)" "REFUNDED"
assert_eq "Refund SUCCESS" "$(latest_refund $ONO)" "SUCCESS"
R=$(req POST "/api/admin/orders/$O1/refund" "$AT" "{\"amount\":$AMT}")
[[ "$(code "$R")" != "0" ]] && ok "已退款订单再退被拒 ($(code "$R"))" || fail "已退款订单重复退款未被拒"

echo "== 7. 用户自助取消（PAID 未接单）→ REFUNDING → 后台发起退款 =="
O2=$(make_paid_order); [[ -n "$O2" ]] && ok "订单 #$O2 已支付" || { fail "下单/支付"; exit 1; }
R=$(req PUT "/api/orders/$O2/cancel" "$UT"); assert_eq "用户取消 → REFUNDING" "$(jq -r .data.status <<<"$R")" "REFUNDING"
AMT2=$(req GET "/api/admin/orders/$O2" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$O2/refund" "$AT" "{\"amount\":$AMT2}")
assert_eq "REFUNDING 订单发起退款 code 0" "$(code "$R")" "0"
assert_eq "订单 → REFUNDED" "$(order_status $O2)" "REFUNDED"

echo "== 8. 并发双击退款：一成一败 =="
O3=$(make_paid_order); [[ -n "$O3" ]] && ok "订单 #$O3 已支付" || { fail "下单/支付"; exit 1; }
AMT3=$(req GET "/api/admin/orders/$O3" "$AT" | jq -r .data.actualAmount)
R1=$(mktemp); R2=$(mktemp)
req POST "/api/admin/orders/$O3/refund" "$AT" "{\"amount\":$AMT3}" > "$R1" &
req POST "/api/admin/orders/$O3/refund" "$AT" "{\"amount\":$AMT3}" > "$R2" &
wait
C1=$(code "$(cat $R1)"); C2=$(code "$(cat $R2)")
if { [[ "$C1" == "0" && "$C2" != "0" ]] || [[ "$C2" == "0" && "$C1" != "0" ]]; }; then ok "并发一成一败 ($C1 / $C2)"; else fail "并发保护" "$C1 / $C2"; fi
assert_eq "订单 → REFUNDED" "$(order_status $O3)" "REFUNDED"

echo "== 9. 人工兜底 refund-complete =="
O4=$(make_paid_order); [[ -n "$O4" ]] && ok "订单 #$O4 已支付" || { fail "下单/支付"; exit 1; }
req PUT "/api/orders/$O4/cancel" "$UT" >/dev/null
R=$(req POST "/api/admin/orders/$O4/refund-complete" "$AT"); assert_eq "手动标记 → REFUNDED" "$(jq -r .data.status <<<"$R")" "REFUNDED"
R=$(req POST "/api/admin/orders/$O4/refund-complete" "$AT"); assert_eq "重复标记被拒 42204" "$(code "$R")" "42204"

echo "== 10. pending-count 字段 =="
R=$(req GET /api/admin/orders/pending-count "$AT")
[[ "$(jq -r .data.refundingCount <<<"$R")" != "null" ]] && ok "refundingCount 存在" || fail "refundingCount 缺失"

echo "== 11. 清理 =="
req DELETE "/api/addresses/$ADDR" "$UT" >/dev/null && ok "删除测试地址"
rm -f "$PNG" "$R1" "$R2"

echo ""
echo "================ 通过 $PASS / 失败 $FAIL ================"
[[ $FAIL -eq 0 ]]
