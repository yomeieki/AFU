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
  r=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$cid],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
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

echo "== 7. 用户自助取消（PAID 未接单）→ 秒退（无需店员审核）；已接单不可自助 =="
O2=$(make_paid_order); [[ -n "$O2" ]] && ok "订单 #$O2 已支付" || { fail "下单/支付"; exit 1; }
ST_BEFORE=$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)
R=$(req PUT "/api/orders/$O2/cancel" "$UT")
assert_eq "用户取消 → 自动退款 autoRefunded=true" "$(jq -r .data.autoRefunded <<<"$R")" "true"
assert_eq "订单 → REFUNDED（mock 即时）" "$(order_status $O2)" "REFUNDED"
assert_eq "库存回滚 +1" "$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)" "$((ST_BEFORE+1))"
R=$(req POST "/api/admin/orders/$O2/refund" "$AT" "{\"amount\":1}"); [[ "$(code "$R")" != "0" ]] && ok "已退完不可再退 ($(code "$R"))" || fail "已退完仍可退"
O2B=$(make_paid_order); [[ -n "$O2B" ]] && ok "订单 #$O2B 已支付" || { fail "下单/支付"; exit 1; }
req POST "/api/admin/orders/$O2B/accept" "$AT" >/dev/null
R=$(req PUT "/api/orders/$O2B/cancel" "$UT"); assert_eq "已接单后自助取消被拒 42204" "$(code "$R")" "42204"
assert_eq "订单仍 PREPARING" "$(order_status $O2B)" "PREPARING"

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

echo "== 9. 人工兜底 refund-complete（仅退款中订单）=="
O4=$(make_paid_order); [[ -n "$O4" ]] && ok "订单 #$O4 已支付" || { fail "下单/支付"; exit 1; }
req PUT "/api/orders/$O4/cancel" "$UT" >/dev/null
R=$(req POST "/api/admin/orders/$O4/refund-complete" "$AT"); assert_eq "已自动退完的订单再标记被拒 42204" "$(code "$R")" "42204"

echo "== 10. pending-count 字段 =="
R=$(req GET /api/admin/orders/pending-count "$AT")
[[ "$(jq -r .data.refundingCount <<<"$R")" != "null" ]] && ok "refundingCount 存在" || fail "refundingCount 缺失"

echo "== 12. 部分退款：订单状态不变、余额校验、退完转 REFUNDED =="
O5=$(make_paid_order); [[ -n "$O5" ]] && ok "订单 #$O5 已支付" || { fail "下单/支付"; exit 1; }
AMT5=$(req GET "/api/admin/orders/$O5" "$AT" | jq -r .data.actualAmount)
PART=$((AMT5-1))
R=$(req POST "/api/admin/orders/$O5/refund" "$AT" "{\"amount\":$PART,\"reason\":\"协商退款\"}")
assert_eq "部分退款 code 0" "$(code "$R")" "0"
assert_eq "部分退款 isFull=false" "$(jq -r .data.isFull <<<"$R")" "false"
assert_eq "订单仍 PAID" "$(order_status $O5)" "PAID"
assert_eq "refundedAmount 累计" "$(req GET "/api/admin/orders/$O5" "$AT" | jq -r .data.refundedAmount)" "$PART"
R=$(req POST "/api/admin/orders/$O5/refund" "$AT" "{\"amount\":2}")
assert_eq "超过可退余额被拒 42206" "$(code "$R")" "42206"
R=$(req POST "/api/admin/orders/$O5/refund" "$AT" "{\"amount\":1}")
assert_eq "退完剩余 isFull=true" "$(jq -r .data.isFull <<<"$R")" "true"
assert_eq "订单 → REFUNDED" "$(order_status $O5)" "REFUNDED"

echo "== 13. 发货 → 顾客申请售后 → 后台同意（部分）/ 拒绝；标记完成；已完成订单可退 =="
O6=$(make_paid_order); [[ -n "$O6" ]] && ok "订单 #$O6 已支付" || { fail "下单/支付"; exit 1; }
R=$(req POST "/api/admin/orders/$O6/ship" "$AT" '{"expressCompany":"其他：同城跑腿","expressNo":"E2E123"}')
assert_eq "发货 → SHIPPED" "$(jq -r .data.order.status <<<"$R")" "SHIPPED"
R=$(req GET "/api/orders/$O6" "$UT"); assert_eq "顾客端 canApplyAfterSale=true" "$(jq -r .data.canApplyAfterSale <<<"$R")" "true"
R=$(req POST "/api/orders/$O6/after-sale" "$UT" '{"reason":"OTHER"}'); assert_eq "其他原因缺说明被拒" "$(code "$R")" "40001"
R=$(req POST "/api/orders/$O6/after-sale" "$UT" "{\"reason\":\"SHORTAGE\",\"description\":\"少了一份\",\"images\":[\"$URL\"]}")
AS1=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$AS1" ]] && ok "售后单 #$AS1 创建" || fail "创建售后单" "$R"
R=$(req POST "/api/orders/$O6/after-sale" "$UT" '{"reason":"DAMAGED"}'); assert_eq "重复申请被拒 42208" "$(code "$R")" "42208"
R=$(req GET "/api/admin/orders/pending-count" "$AT"); [[ "$(jq -r .data.afterSaleCount <<<"$R")" -ge 1 ]] && ok "afterSaleCount ≥1" || fail "afterSaleCount"
R=$(req GET "/api/admin/after-sales?status=PENDING" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$AS1)] | length" <<<"$R")" == "1" ]] && ok "售后列表含 #$AS1（reasonLabel=$(jq -r ".data.list[] | select(.id==$AS1) | .reasonLabel" <<<"$R")）" || fail "售后列表"
R=$(req POST "/api/admin/after-sales/$AS1/approve" "$AT" '{"amount":1,"reply":"已退 0.01"}')
assert_eq "同意售后 code 0" "$(code "$R")" "0"
assert_eq "售后单 → DONE（mock 即时到账）" "$(jq -r .data.afterSale.status <<<"$R")" "DONE"
assert_eq "订单仍 SHIPPED" "$(order_status $O6)" "SHIPPED"
R=$(req GET "/api/orders/$O6" "$UT")
assert_eq "顾客端 refundedAmount=1" "$(jq -r .data.refundedAmount <<<"$R")" "1"
assert_eq "顾客端 afterSale.status=DONE" "$(jq -r .data.afterSale.status <<<"$R")" "DONE"
R=$(req POST "/api/orders/$O6/after-sale" "$UT" '{"reason":"DAMAGED","description":"坏了"}')
AS2=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$AS2" ]] && ok "第二次售后 #$AS2" || fail "第二次售后" "$R"
R=$(req POST "/api/admin/after-sales/$AS2/reject" "$AT" '{}'); assert_eq "拒绝须填回复" "$(code "$R")" "40001"
R=$(req POST "/api/admin/after-sales/$AS2/reject" "$AT" '{"reply":"照片看不出问题"}'); assert_eq "拒绝 → REJECTED" "$(jq -r .data.status <<<"$R")" "REJECTED"
R=$(req POST "/api/admin/orders/$O6/complete" "$AT"); assert_eq "标记完成 → COMPLETED" "$(jq -r .data.status <<<"$R")" "COMPLETED"
R=$(req POST "/api/admin/orders/$O6/refund" "$AT" '{"amount":1,"reason":"缺货"}'); assert_eq "已完成订单可部分退款" "$(code "$R")" "0"
assert_eq "订单仍 COMPLETED" "$(order_status $O6)" "COMPLETED"

echo "== 14. 后台 keyword 搜索（手机号/姓名）=="
R=$(req GET "/api/admin/orders?keyword=13800000000" "$AT"); [[ "$(jq -r .data.total <<<"$R")" -ge 1 ]] && ok "按手机号搜到 $(jq -r .data.total <<<"$R") 单" || fail "手机号搜索"
R=$(curl -s -G "$BASE/api/admin/orders" --data-urlencode "keyword=E2E测试" -H "Authorization: Bearer $AT"); [[ "$(jq -r .data.total <<<"$R")" -ge 1 ]] && ok "按姓名搜到" || fail "姓名搜索"
[[ "$(jq -r '.data.list[0].remark' <<<"$R")" != "" ]] && ok "列表含 remark 字段" || fail "remark 字段缺失"

echo "== 15. 立即购买 directItem（不经购物车）=="
CB=$(req GET /api/cart "$UT" | jq -r '.data.items | length')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":2},\"addressId\":$ADDR}")
O7=$(jq -r '.data.orderId // empty' <<<"$R"); [[ -n "$O7" ]] && ok "直购下单 #$O7" || fail "直购下单" "$R"
[[ "$(jq -r .data.payExpireAt <<<"$R")" != "null" ]] && ok "返回 payExpireAt" || fail "payExpireAt 缺失"
CA=$(req GET /api/cart "$UT" | jq -r '.data.items | length'); assert_eq "购物车未受影响" "$CA" "$CB"
R=$(req POST /api/orders "$UT" "{\"addressId\":$ADDR}"); [[ "$(code "$R")" != "0" ]] && ok "二者皆无被拒" || fail "二者皆无未被拒"

echo "== 16. 定时任务：超时取消回滚库存 / 催单 / 自动收货 =="
ST0=$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)
R=$(req POST "/api/admin/system/run-scheduler" "$AT" '{"payTimeoutMin":0}')
assert_eq "run-scheduler code 0" "$(code "$R")" "0"
[[ "$(jq -r .data.cancelExpired <<<"$R")" -ge 1 ]] && ok "超时取消 $(jq -r .data.cancelExpired <<<"$R") 单" || fail "超时取消数" "$R"
assert_eq "直购单 → CANCELLED" "$(order_status $O7)" "CANCELLED"
ST1=$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock); assert_eq "库存回滚 +2" "$ST1" "$((ST0+2))"
R=$(req POST "/api/orders/$O7/pay" "$UT"); assert_eq "已取消订单不可支付" "$(code "$R")" "42204"
O8=$(make_paid_order); [[ -n "$O8" ]] && ok "订单 #$O8 已支付（待接单）" || { fail "下单/支付"; exit 1; }
R=$(req POST "/api/admin/system/run-scheduler" "$AT" '{"remindAfterMin":0}')
[[ "$(jq -r .data.remindUnaccepted <<<"$R")" -ge 1 ]] && ok "催单 $(jq -r .data.remindUnaccepted <<<"$R") 单" || fail "催单数" "$R"
[[ "$(req GET "/api/admin/orders/$O8" "$AT" | jq -r .data.acceptRemindedAt)" != "null" ]] && ok "acceptRemindedAt 已写" || fail "acceptRemindedAt"
R=$(req POST "/api/admin/system/run-scheduler" "$AT" '{"remindAfterMin":0}'); assert_eq "不重复催单" "$(jq -r .data.remindUnaccepted <<<"$R")" "0"
req POST "/api/admin/orders/$O8/ship" "$AT" '{"expressCompany":"顺丰速运","expressNo":"SF1"}' >/dev/null
R=$(req POST "/api/admin/system/run-scheduler" "$AT" '{"autoCompleteDays":0}')
[[ "$(jq -r .data.autoComplete <<<"$R")" -ge 1 ]] && ok "自动收货 $(jq -r .data.autoComplete <<<"$R") 单" || fail "自动收货数" "$R"
assert_eq "订单 → COMPLETED" "$(order_status $O8)" "COMPLETED"

echo "== 17. web-view 一次性换码 =="
R=$(req POST "/api/admin/webview-code" "$AT"); WC=$(jq -r '.data.code // empty' <<<"$R")
[[ -n "$WC" ]] && ok "取得 code" || fail "webview-code" "$R"
R=$(req POST "/api/admin/login/webview" "" "{\"code\":\"$WC\"}"); [[ -n "$(jq -r '.data.token // empty' <<<"$R")" ]] && ok "code 换 token" || fail "换 token" "$R"
R=$(req POST "/api/admin/login/webview" "" "{\"code\":\"$WC\"}"); assert_eq "code 单次使用" "$(code "$R")" "40103"

echo "== 18. 顾客上传 =="
R=$(curl -s -X POST "$BASE/api/upload" -H "Authorization: Bearer $UT" -F "file=@$PNG;type=image/png")
[[ -n "$(jq -r '.data.url // empty' <<<"$R")" ]] && ok "顾客上传返回 URL" || fail "顾客上传" "$R"

echo "== 19. 渠道：分类/商品 =="
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E同城分类","channel":"LOCAL","sortOrder":99}')
LCAT=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$LCAT" ]] && ok "创建 LOCAL 分类 #$LCAT" || fail "创建 LOCAL 分类" "$R"
assert_eq "分类 channel=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E邮寄分类","sortOrder":98}')
ECAT=$(jq -r '.data.id // empty' <<<"$R"); assert_eq "默认 channel=EXPRESS" "$(jq -r .data.channel <<<"$R")" "EXPRESS"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E凉拌黄瓜\",\"price\":1200,\"stock\":50,\"netWeightG\":300}")
LPID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$LPID" ]] && ok "创建同城商品 #$LPID" || fail "创建同城商品" "$R"
assert_eq "商品 channel 随分类=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"
assert_eq "netWeightG=300" "$(jq -r .data.netWeightG <<<"$R")" "300"
R=$(req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$ECAT}")
assert_eq "换分类后 channel 跟随=EXPRESS" "$(jq -r .data.channel <<<"$R")" "EXPRESS"
req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$LCAT}" >/dev/null
R=$(req GET "/api/admin/products?channel=LOCAL&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "1" ]] && ok "admin 列表按 channel=LOCAL 过滤含该商品" || fail "admin 列表 channel 过滤" "$R"
R=$(req GET "/api/admin/products?channel=EXPRESS&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "0" ]] && ok "EXPRESS 列表不含同城商品" || fail "EXPRESS 列表泄漏同城商品"
R=$(req GET "/api/admin/categories?channel=LOCAL" "$AT")
[[ "$(jq -r "[.data[] | select(.id==$LCAT)] | length" <<<"$R")" == "1" ]] && ok "admin 分类按 channel 过滤" || fail "admin 分类 channel 过滤" "$R"
R=$(req PUT "/api/admin/categories/$LCAT" "$AT" '{"channel":"EXPRESS"}')
assert_eq "分类改渠道级联 code 0" "$(code "$R")" "0"
assert_eq "级联后商品 channel=EXPRESS" "$(req GET "/api/admin/products?keyword=E2E" "$AT" | jq -r '.data.list[0].channel')" "EXPRESS"
req PUT "/api/admin/categories/$LCAT" "$AT" '{"channel":"LOCAL"}' >/dev/null
R=$(req POST /api/admin/products/batch-status "$AT" '{"status":"OFF_SHELF","channel":"LOCAL"}')
assert_eq "按渠道批量下架 code 0" "$(code "$R")" "0"
assert_eq "同城商品已下架" "$(req GET "/api/admin/products?keyword=E2E" "$AT" | jq -r '.data.list[0].status')" "OFF_SHELF"
assert_eq "邮寄商品未受影响" "$(req GET "/api/products/$PID" "$UT" | jq -r .data.status)" "ON_SHELF"
req POST /api/admin/products/batch-status "$AT" '{"status":"ON_SHELF","channel":"LOCAL"}' >/dev/null

R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$ECAT,\"name\":\"E2E邮寄商品\",\"price\":1200,\"stock\":50}")
EPID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$EPID" ]] && ok "创建邮寄商品 #$EPID" || fail "创建邮寄商品" "$R"
assert_eq "邮寄商品 channel=EXPRESS" "$(jq -r .data.channel <<<"$R")" "EXPRESS"

R=$(req POST /api/cart "$UT" "{\"productId\":$EPID,\"quantity\":1}")
ECID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$ECID" ]] && ok "邮寄商品加购" || fail "邮寄商品加购" "$R"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$ECID],\"addressId\":$ADDR}")
EOID=$(jq -r '.data.orderId // .data.id // empty' <<<"$R"); [[ -n "$EOID" ]] && ok "创建待付款邮寄订单 #$EOID" || fail "创建待付款邮寄订单" "$R"
assert_eq "待付款订单 status=PENDING_PAYMENT" "$(jq -r .data.status <<<"$R")" "PENDING_PAYMENT"
R=$(req GET "/api/orders/$EOID" "$UT")
assert_eq "待付款订单 deliveryType 默认=EXPRESS" "$(jq -r .data.deliveryType <<<"$R")" "EXPRESS"

R=$(req PUT "/api/admin/categories/$ECAT" "$AT" '{"channel":"LOCAL"}')
assert_eq "分类下有待付款订单不可改渠道 42231" "$(code "$R")" "42231"
R=$(req GET /api/admin/categories "$AT")
assert_eq "42231 后分类 channel 未变=EXPRESS" "$(jq -r ".data[] | select(.id==$ECAT) | .channel" <<<"$R")" "EXPRESS"

req PUT "/api/orders/$EOID/cancel" "$UT" >/dev/null

R=$(req PUT "/api/admin/categories/$LCAT" "$AT" '{"channel":"LOCAL"}')
assert_eq "同渠道短路 code 0" "$(code "$R")" "0"
R=$(req GET "/api/admin/products?keyword=E2E&pageSize=50" "$AT")
assert_eq "同渠道短路后商品 channel 未变=LOCAL" "$(jq -r "[.data.list[] | select(.id==$LPID)][0].channel" <<<"$R")" "LOCAL"

echo "== 20. 渠道：公开接口/购物车 =="
R=$(req GET "/api/categories" "$UT"); [[ "$(jq -r "[.data[] | select(.id==$LCAT)] | length" <<<"$R")" == "0" ]] && ok "公开分类默认不含 LOCAL" || fail "公开分类泄漏 LOCAL" "$R"
R=$(req GET "/api/categories?channel=LOCAL" "$UT"); [[ "$(jq -r "[.data[] | select(.id==$LCAT)] | length" <<<"$R")" == "1" ]] && ok "公开分类 channel=LOCAL 含同城分类" || fail "公开分类 LOCAL 过滤" "$R"
R=$(req GET "/api/products?pageSize=50" "$UT"); [[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "0" ]] && ok "公开商品默认不含同城商品" || fail "公开商品泄漏同城商品"
R=$(req GET "/api/products?channel=LOCAL&pageSize=50" "$UT"); [[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "1" ]] && ok "公开商品 channel=LOCAL 含同城商品" || fail "公开商品 LOCAL 过滤" "$R"
assert_eq "商品详情返回 channel" "$(req GET "/api/products/$LPID" "$UT" | jq -r .data.channel)" "LOCAL"
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); LCID=$(jq -r '.data.id // empty' <<<"$R")
[[ -n "$LCID" ]] && ok "同城商品加购 #$LCID" || fail "同城加购" "$R"
assert_eq "加购返回 channel=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"
R=$(req GET /api/cart "$UT"); [[ "$(jq -r "[.data.items[] | select(.id==$LCID)] | length" <<<"$R")" == "0" ]] && ok "默认购物车不含同城行" || fail "默认购物车混入同城行" "$R"
R=$(req GET "/api/cart?channel=LOCAL" "$UT"); [[ "$(jq -r "[.data.items[] | select(.id==$LCID)] | length" <<<"$R")" == "1" ]] && ok "同城购物车含该行" || fail "同城购物车" "$R"
assert_eq "同城购物车小计=2400" "$(jq -r .data.totalAmount <<<"$R")" "2400"

echo "== 21. 同城设置/报价 =="
# enabled 初值与 version 初值都是持久化状态，重复跑 e2e 时不为默认值：
# 这里改成相对断言（记录旧 version，断言新 version = 旧值+1；enabled 断言保存开启后的值），
# 而不是假设库里还是刚建库的初始状态。
R=$(req GET /api/admin/settings/local-delivery "$AT"); assert_eq "读取同城设置 code 0" "$(code "$R")" "0"
OLDVER=$(jq -r '.data.version' <<<"$R")
LS=$(jq -c '.data | .store.latE6=29339000 | .store.lngE6=104778000 | .radiusKm=5 | .fee={baseFee:300,baseKm:3,perKmFee:100,freeThreshold:8000,minOrderAmount:2000} | .businessHours=[{start:"00:00",end:"23:59"}] | .enabled=true' <<<"$R")
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$LS"); assert_eq "保存并开启 code 0" "$(code "$R")" "0"
assert_eq "保存并开启后 enabled=true" "$(jq -r '.data.enabled' <<<"$R")" "true"
assert_eq "version 递增 1" "$(jq -r '.data.version' <<<"$R")" "$((OLDVER + 1))"
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.businessHours=[{start:"18:00",end:"01:00"}]' <<<"$LS")"); assert_eq "跨零点被拒 40001" "$(code "$R")" "40001"
R=$(req PATCH /api/admin/settings/local-delivery/store-location "$AT" '{"latE6":29339500,"lngE6":104778500}'); assert_eq "PATCH 门店坐标" "$(jq -r .data.store.latE6 <<<"$R")" "29339500"
R=$(req GET /api/local/meta ""); assert_eq "公开 meta isOpen=true" "$(jq -r .data.isOpen <<<"$R")" "true"
assert_eq "meta 不泄漏 tip" "$(jq -r '.data.tip // "absent"' <<<"$R")" "absent"
R=$(req POST /api/local/quote "" '{"latE6":29350000,"lngE6":104790000,"subtotal":3000}'); assert_eq "匿名坐标报价 code 0" "$(code "$R")" "0"
assert_eq "范围内" "$(jq -r .data.inRange <<<"$R")" "true"
QFEE=$(jq -r .data.fee <<<"$R"); [[ "$QFEE" =~ ^[0-9]+$ ]] && ok "fee=$QFEE" || fail "fee 非整数" "$R"
QTOKEN=$(jq -r '.data.quoteToken // empty' <<<"$R"); [[ -n "$QTOKEN" ]] && ok "返回 quoteToken" || fail "quoteToken 缺失"
R=$(req POST /api/local/quote "" '{"latE6":29600000,"lngE6":105100000,"subtotal":3000}'); assert_eq "超范围 inRange=false" "$(jq -r .data.inRange <<<"$R")" "false"
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$ADDR}"); assert_eq "旧地址无坐标 42223" "$(code "$R")" "42223"
R=$(req POST /api/admin/settings/local-delivery/pause "$AT" '{"reason":"暴雨暂停"}'); assert_eq "暂停 code 0" "$(code "$R")" "0"
assert_eq "meta 暂停后 isOpen=false" "$(req GET /api/local/meta "" | jq -r .data.isOpen)" "false"
R=$(req DELETE /api/admin/settings/local-delivery/pause "$AT"); assert_eq "恢复后 isOpen=true" "$(req GET /api/local/meta "" | jq -r .data.isOpen)" "true"
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E同城","receiverPhone":"13800000001","province":"四川省","city":"自贡市","district":"高新区","detail":"丹桂大街1号 3栋2单元","latE6":29350000,"lngE6":104790000,"poiName":"丹桂小区"}')
LADDR=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$LADDR" ]] && ok "创建带坐标地址 #$LADDR" || fail "创建带坐标地址" "$R"
assert_eq "poiName 落库" "$(jq -r .data.poiName <<<"$R")" "丹桂小区"
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E半坐标","receiverPhone":"13800000002","province":"四川省","city":"自贡市","district":"高新区","detail":"x","latE6":29350000}'); assert_eq "坐标不成对 40001" "$(code "$R")" "40001"
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$LADDR,\"subtotal\":3000}"); assert_eq "按地址报价 code 0" "$(code "$R")" "0"
QTOKEN=$(jq -r .data.quoteToken <<<"$R"); QFEE=$(jq -r .data.fee <<<"$R")
# 坐标必须成对（合并态校验）：PUT 只带一个键时要与库内已有值合并后判断，而不是只看请求体自身
R=$(req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":null}'); assert_eq "已有坐标地址仅清纬度 40001" "$(code "$R")" "40001"
R=$(req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":29360000}'); assert_eq "已有坐标地址合法更新纬度 code 0" "$(code "$R")" "0"
R=$(req GET /api/addresses "$UT")
assert_eq "更新后 latE6 生效" "$(jq -r "[.data[] | select(.id==$LADDR)][0].latE6" <<<"$R")" "29360000"
assert_eq "更新后 lngE6 保持不变（未被误伤）" "$(jq -r "[.data[] | select(.id==$LADDR)][0].lngE6" <<<"$R")" "104790000"
R=$(req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":29350000}'); assert_eq "地址坐标改回原值 code 0" "$(code "$R")" "0"
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E无坐标","receiverPhone":"13800000003","province":"四川省","city":"自贡市","district":"高新区","detail":"z"}')
NADDR=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$NADDR" ]] && ok "创建无坐标地址 #$NADDR" || fail "创建无坐标地址" "$R"
R=$(req PUT "/api/addresses/$NADDR" "$UT" '{"latE6":29350000}'); assert_eq "无坐标地址仅传纬度 40001" "$(code "$R")" "40001"
echo "== 22. 同城下单 =="
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); LCID2=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID2],\"addressId\":$LADDR,\"deliveryType\":\"EXPRESS\"}"); assert_eq "同城商品走邮寄被拒 42224" "$(code "$R")" "42224"
R=$(req POST /api/cart "$UT" "{\"productId\":$EPID,\"quantity\":1}"); ECID2=$(jq -r '.data.id // empty' <<<"$R")
[[ -n "$ECID2" ]] && ok "邮寄商品再加购 #$ECID2" || fail "邮寄商品再加购" "$R"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$ECID2],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\"}"); assert_eq "邮寄商品配同城被拒 42224" "$(code "$R")" "42224"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID2],\"addressId\":$ADDR,\"deliveryType\":\"LOCAL\"}"); assert_eq "无坐标地址下同城单 42223" "$(code "$R")" "42223"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID2],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$QTOKEN\"}")
LO1=$(jq -r '.data.orderId // empty' <<<"$R"); [[ -n "$LO1" ]] && ok "同城下单 #$LO1" || fail "同城下单" "$R"
assert_eq "运费=报价 fee" "$(jq -r .data.shippingFee <<<"$R")" "$QFEE"
R=$(req GET "/api/orders/$LO1" "$UT")
assert_eq "订单 deliveryType=LOCAL" "$(jq -r .data.deliveryType <<<"$R")" "LOCAL"
[[ "$(jq -r .data.distanceM <<<"$R")" -gt 0 ]] && ok "distanceM 已快照" || fail "distanceM" "$R"
[[ "$(jq -r .data.estimatedDeliveryAt <<<"$R")" != "null" ]] && ok "estimatedDeliveryAt 已写" || fail "estimatedDeliveryAt"
assert_eq "shipment 为空（LOCAL 不写 Shipment）" "$(jq -r .data.shipment <<<"$R")" "null"
# 全局邮寄运费被设成 9999 也不影响同城运费
req PUT /api/admin/settings/shipping "$AT" '{"fee":999900,"freeThreshold":0,"minOrderAmount":0}' >/dev/null
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); LCID3=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID3],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\"}")
LO2=$(jq -r '.data.orderId // empty' <<<"$R"); [[ "$(jq -r .data.shippingFee <<<"$R")" -lt 999900 ]] && ok "LOCAL 运费与全局邮寄运费无关" || fail "LOCAL 叠加了全局运费" "$R"
req PUT /api/admin/settings/shipping "$AT" '{"fee":0,"freeThreshold":0,"minOrderAmount":0}' >/dev/null
# 支付 → 邮寄端点守卫 → 取消申请窗口
req POST "/api/orders/$LO1/pay" "$UT" >/dev/null
R=$(req POST "/api/admin/orders/$LO1/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"X"}'); assert_eq "LOCAL 单不可走邮寄发货 42204" "$(code "$R")" "42204"
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "未接单不能申请取消(应走秒退) 42229" "$(code "$R")" "42229"
R=$(req POST "/api/admin/orders/$LO1/accept" "$AT"); assert_eq "邮寄接单端点拒绝 LOCAL 42204" "$(code "$R")" "42204"
req POST "/api/admin/local/orders/$LO1/accept" "$AT" >/dev/null
R=$(req GET "/api/orders/$LO1" "$UT"); assert_eq "窗口内 canRequestCancel=true" "$(jq -r .data.canRequestCancel <<<"$R")" "true"
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{}'); assert_eq "重复申请 42229" "$(code "$R")" "42229"
[[ "$(jq -r .message <<<"$R")" == *"已提交过"* ]] && ok "重复申请提示区分于超窗口" || fail "重复申请提示未区分" "$R"
docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop_sc -e "update orders set cancel_requested_at=NULL, accepted_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE) where id=$LO1;" 2>/dev/null
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{}'); assert_eq "超窗口 42229" "$(code "$R")" "42229"
R=$(req GET "/api/admin/orders?pageSize=50" "$AT"); [[ "$(jq -r "[.data.list[] | select(.id==$LO1)] | length" <<<"$R")" == "0" ]] && ok "后台订单列表默认不含同城单" || fail "后台列表混入同城单"
R=$(req GET "/api/admin/orders?deliveryType=LOCAL&pageSize=50" "$AT"); [[ "$(jq -r "[.data.list[] | select(.id==$LO1)] | length" <<<"$R")" == "1" ]] && ok "deliveryType=LOCAL 可查到" || fail "LOCAL 筛选" "$R"
R=$(req GET /api/admin/orders/pending-count "$AT"); [[ "$(jq -r .data.localPendingCount <<<"$R")" -ge 1 ]] && ok "localPendingCount≥1" || fail "localPendingCount" "$R"

# —— quoteToken 与 LOCAL 下单拒绝路径（下单端点自己判一遍，/local/quote 判过不算）——
# 只断言「运费=报价 fee」是恒真的：重算值本来就等于报价值，token 被完整校验或被完全忽略都会通过。
# 下面几条才真的能区分。
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); QC1=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E另一地址","receiverPhone":"13800000004","province":"四川省","city":"自贡市","district":"高新区","detail":"另一处 1 号","latE6":29352000,"lngE6":104792000}')
ADDR2=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$QC1],\"addressId\":$ADDR2,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$QTOKEN\"}")
LO3=$(jq -r '.data.orderId // empty' <<<"$R")
QR2=$(req POST /api/local/quote "$UT" "{\"addressId\":$ADDR2,\"subtotal\":2400}")
assert_eq "token 与 addressId 不符时按重算值收费" "$(req GET "/api/orders/$LO3" "$UT" | jq -r .data.shippingFee)" "$(jq -r .data.fee <<<"$QR2")"

# 调高基础运费后用旧 token 下单 → 重算更贵，必须 42227
LSNAP=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c '.data')
req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.fee.baseFee=99900' <<<"$LSNAP")" >/dev/null
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); QC2=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$QC2],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$QTOKEN\"}")
assert_eq "重算贵于 token → 42227" "$(code "$R")" "42227"
req PUT /api/admin/settings/local-delivery "$AT" "$LSNAP" >/dev/null

# 超出配送半径 → 42220（注意不是 /local/quote 的 inRange，而是下单端点自己拒）
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E远地址","receiverPhone":"13800000005","province":"四川省","city":"自贡市","district":"高新区","detail":"很远的地方","latE6":29600000,"lngE6":105100000}')
FADDR=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$QC2],\"addressId\":$FADDR,\"deliveryType\":\"LOCAL\"}")
assert_eq "超出配送范围下单 42220" "$(code "$R")" "42220"

# 非营业时间 → 42222
req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.businessHours=[{start:"03:00",end:"03:01"}]' <<<"$LSNAP")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$QC2],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\"}")
assert_eq "非营业时间下单 42222" "$(code "$R")" "42222"
# 顺带：非法营业时段（中文冒号）必须被拒，不能被 sanitize 静默吞掉后返回成功
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.businessHours=[{start:"09：00",end:"20:00"}]' <<<"$LSNAP")")
assert_eq "非法营业时段被拒 40001" "$(code "$R")" "40001"
[[ "$(jq -r .message <<<"$R")" == *"格式不正确"* ]] && ok "非法时段错误信息指出格式问题" || fail "非法时段错误信息不明确" "$R"
req PUT /api/admin/settings/local-delivery "$AT" "$LSNAP" >/dev/null
assert_eq "营业时段已恢复" "$(req GET /api/local/meta "" | jq -r .data.isOpen)" "true"

# 改了文字地址却没重新选点 → 坐标一并清空（防止 M2 骑手被派到旧地址）
R=$(req PUT "/api/addresses/$LADDR" "$UT" '{"detail":"改成了完全不同的门牌 9 栋"}')
assert_eq "只改文字地址 code 0" "$(code "$R")" "0"
R=$(req GET /api/addresses "$UT")
assert_eq "改文字后 latE6 被清空" "$(jq -r "[.data[] | select(.id==$LADDR)][0].latE6" <<<"$R")" "null"
assert_eq "改文字后 lngE6 被清空" "$(jq -r "[.data[] | select(.id==$LADDR)][0].lngE6" <<<"$R")" "null"
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$LADDR}"); assert_eq "坐标清空后报价 42223" "$(code "$R")" "42223"

# 商品换分类跨渠道，同样要走待付款订单守卫（不能只在「分类改渠道」入口把关）
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); QC3=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$QC3],\"addressId\":$ADDR2,\"deliveryType\":\"LOCAL\"}")
LO4=$(jq -r '.data.orderId // empty' <<<"$R")
R=$(req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$ECAT}")
assert_eq "商品跨渠道换分类被待付款订单挡住 42231" "$(code "$R")" "42231"
# 把该用户所有待付款单一并取消——本段之前的若干断言也会留下含 $LPID 的待付款单，
# 逐个列举容易漏（漏一个这条断言就会莫名其妙地失败）。
for o in $(req GET "/api/orders?status=PENDING_PAYMENT&pageSize=50" "$UT" | jq -r '.data.list[].id'); do
  req PUT "/api/orders/$o/cancel" "$UT" >/dev/null
done
R=$(req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$ECAT}"); assert_eq "取消待付款后可换渠道 code 0" "$(code "$R")" "0"
req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$LCAT}" >/dev/null

echo "== 23. 部分更新不重置未传字段（zod .partial() 不剥离 .default() 回归）=="
CATID=$(req GET /api/admin/categories "$AT" | jq -r '.data[0].id // empty')
[[ -n "$CATID" ]] && ok "取得分类 #$CATID" || { fail "取分类"; }
# 23a. 商品：创建时显式指定非默认值，随后只 PUT stock
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$CATID,\"name\":\"E2E部分更新回归\",\"price\":100,\"stock\":50,\"unit\":\"盒\",\"status\":\"OFF_SHELF\",\"isRecommended\":1}")
NPID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$NPID" ]] && ok "创建商品 #$NPID" || fail "创建商品" "$R"
assert_eq "创建后 status=OFF_SHELF" "$(jq -r .data.status <<<"$R")" "OFF_SHELF"
R=$(req PUT "/api/admin/products/$NPID" "$AT" '{"stock":30}')
assert_eq "只传 stock 的 PUT code 0" "$(code "$R")" "0"
assert_eq "stock → 30" "$(jq -r .data.stock <<<"$R")" "30"
assert_eq "status 仍 OFF_SHELF（未被重置为 ON_SHELF）" "$(jq -r .data.status <<<"$R")" "OFF_SHELF"
assert_eq "isRecommended 仍 1（未被清零）" "$(jq -r .data.isRecommended <<<"$R")" "1"
assert_eq "unit 仍 盒（未被重置为 份）" "$(jq -r .data.unit <<<"$R")" "盒"
# 再从列表读回，确认是落库结果而非响应体假象
R=$(req GET "/api/admin/products?categoryId=$CATID&pageSize=50" "$AT")
P=$(jq -c ".data.list[] | select(.id==$NPID)" <<<"$R")
assert_eq "落库 status=OFF_SHELF" "$(jq -r .status <<<"$P")" "OFF_SHELF"
assert_eq "落库 isRecommended=1" "$(jq -r .isRecommended <<<"$P")" "1"
assert_eq "落库 unit=盒" "$(jq -r .unit <<<"$P")" "盒"
assert_eq "落库 stock=30" "$(jq -r .stock <<<"$P")" "30"
# 23b. 创建路径的默认值必须保留
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$CATID,\"name\":\"E2E默认值商品\",\"price\":100}")
DPID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$DPID" ]] && ok "创建缺省商品 #$DPID" || fail "创建缺省商品" "$R"
assert_eq "默认 stock=0" "$(jq -r .data.stock <<<"$R")" "0"
assert_eq "默认 unit=份" "$(jq -r .data.unit <<<"$R")" "份"
assert_eq "默认 status=ON_SHELF" "$(jq -r .data.status <<<"$R")" "ON_SHELF"
assert_eq "默认 isRecommended=0" "$(jq -r .data.isRecommended <<<"$R")" "0"
# 23c. 分类：只 PUT name，sortOrder/status 不能被重置
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E回归分类","sortOrder":77,"status":0}')
NCID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$NCID" ]] && ok "创建分类 #$NCID" || fail "创建分类" "$R"
R=$(req PUT "/api/admin/categories/$NCID" "$AT" '{"name":"E2E回归分类改名"}')
assert_eq "只传 name 的 PUT code 0" "$(code "$R")" "0"
assert_eq "name 已更新" "$(jq -r .data.name <<<"$R")" "E2E回归分类改名"
assert_eq "sortOrder 仍 77（未被重置为 0）" "$(jq -r .data.sortOrder <<<"$R")" "77"
assert_eq "status 仍 0（未被重置为 1）" "$(jq -r .data.status <<<"$R")" "0"
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E默认值分类"}')
DCID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$DCID" ]] && ok "创建缺省分类 #$DCID" || fail "创建缺省分类" "$R"
assert_eq "默认 sortOrder=0" "$(jq -r .data.sortOrder <<<"$R")" "0"
assert_eq "默认 status=1" "$(jq -r .data.status <<<"$R")" "1"
# 23d. 地址：只改详细地址，isDefault 不能被清零
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E默认地址","receiverPhone":"13800000001","province":"四川省","city":"成都市","district":"武侯区","detail":"回归路1号","isDefault":1}')
ADDR2=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$ADDR2" ]] && ok "创建默认地址 #$ADDR2" || fail "创建默认地址" "$R"
R=$(req PUT "/api/addresses/$ADDR2" "$UT" '{"detail":"回归路2号"}')
assert_eq "只传 detail 的 PUT code 0" "$(code "$R")" "0"
assert_eq "detail 已更新" "$(jq -r .data.detail <<<"$R")" "回归路2号"
assert_eq "isDefault 仍 1（未被清零）" "$(jq -r .data.isDefault <<<"$R")" "1"
# 23 清理
[[ -n "$NPID" ]] && req DELETE "/api/admin/products/$NPID" "$AT" >/dev/null
[[ -n "$DPID" ]] && req DELETE "/api/admin/products/$DPID" "$AT" >/dev/null
[[ -n "$NCID" ]] && req DELETE "/api/admin/categories/$NCID" "$AT" >/dev/null
[[ -n "$DCID" ]] && req DELETE "/api/admin/categories/$DCID" "$AT" >/dev/null
[[ -n "$ADDR2" ]] && req DELETE "/api/addresses/$ADDR2" "$UT" >/dev/null

echo "== 25. 同城运力 mock 基建 =="
R=$(req POST /api/admin/system/kd100-mock/reset "$AT"); assert_eq "mock reset code 0" "$(code "$R")" "0"
R=$(req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30005"}}')
assert_eq "queue code 0" "$(code "$R")" "0"
R=$(req GET /api/admin/system/kd100-mock/calls "$AT"); assert_eq "calls 初始为空数组" "$(jq -r '.data | length' <<<"$R")" "0"
R=$(req GET /api/admin/system/kd100-mock/salt/D999999-1 "$AT"); assert_eq "未知单号 salt 404" "$(code "$R")" "40401"

echo "== 26. 呼叫骑手三分支 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
# 第 22 段的「改文字清坐标」断言清掉了 $LADDR 的坐标，同城下单要重新报价必须先恢复；
# 顺手把库存加足——26-31 段要造十几笔单，50 件不保险
req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":29350000,"lngE6":104790000}' >/dev/null
req PUT "/api/admin/products/$LPID" "$AT" '{"stock":500}' >/dev/null
mk_local_paid() {  # 造一笔已支付同城单，echo orderId
  local r cid oid
  r=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); cid=$(jq -r '.data.id // empty' <<<"$r")
  r=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$cid],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\"}")
  oid=$(jq -r '.data.orderId // empty' <<<"$r"); [[ -n "$oid" ]] || { echo ""; return; }
  req POST "/api/orders/$oid/pay" "$UT" >/dev/null; echo "$oid"
}
DLO1=$(mk_local_paid); [[ -n "$DLO1" ]] && ok "同城单 #$DLO1 已支付" || fail "造单失败"
R=$(req POST "/api/admin/local/orders/$DLO1/call" "$AT"); assert_eq "未接单不能呼叫 42204" "$(code "$R")" "42204"
R=$(req POST "/api/admin/local/orders/$DLO1/accept" "$AT"); assert_eq "同城接单 code 0" "$(code "$R")" "0"
assert_eq "接单后 PREPARING" "$(req GET "/api/admin/orders/$DLO1" "$AT" | jq -r .data.status)" "PREPARING"
# —— 分支①成功：CALLING + taskId + quotedFee
R=$(req POST "/api/admin/local/orders/$DLO1/call" "$AT"); assert_eq "呼叫成功 code 0" "$(code "$R")" "0"
assert_eq "返回 status=CALLING" "$(jq -r .data.status <<<"$R")" "CALLING"
DNO1=$(jq -r .data.deliveryNo <<<"$R"); [[ "$DNO1" == D${DLO1}-1 ]] && ok "deliveryNo=D${DLO1}-1" || fail "deliveryNo 格式" "$DNO1"
R=$(req GET "/api/admin/local/orders/$DLO1/delivery" "$AT")
assert_eq "落库 CALLING" "$(jq -r .data.delivery.status <<<"$R")" "CALLING"
assert_eq "quotedFee=500" "$(jq -r .data.delivery.quotedFee <<<"$R")" "500"
[[ "$(jq -r .data.delivery.providerTaskId <<<"$R")" == MOCKTASK-* ]] && ok "taskId 已写" || fail "taskId"
R=$(req POST "/api/admin/local/orders/$DLO1/call" "$AT"); assert_eq "重复呼叫 42228" "$(code "$R")" "42228"
# mock 记录了 callbackUrl 拼装
R=$(req GET /api/admin/system/kd100-mock/calls "$AT")
[[ "$(jq -r '.data[-1].input.callbackUrl' <<<"$R")" == */api/kd/D${DLO1}-1 ]] && ok "callbackUrl 含 deliveryNo" || fail "callbackUrl" "$R"
# —— 分支②超时：UNKNOWN 占位不释放；作废后可重呼且 seq 递增
DLO2=$(mk_local_paid); req POST "/api/admin/local/orders/$DLO2/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO2/call" "$AT"); assert_eq "超时返回 UNKNOWN" "$(jq -r .data.status <<<"$R")" "UNKNOWN"
R=$(req POST "/api/admin/local/orders/$DLO2/call" "$AT"); assert_eq "UNKNOWN 占位期间再呼 42228" "$(code "$R")" "42228"
R=$(req POST "/api/admin/local/orders/$DLO2/delivery/void" "$AT"); assert_eq "作废 code 0" "$(code "$R")" "0"
R=$(req GET "/api/admin/local/orders/$DLO2/delivery" "$AT"); assert_eq "作废后 FAILED" "$(jq -r .data.delivery.status <<<"$R")" "FAILED"
R=$(req POST "/api/admin/local/orders/$DLO2/call" "$AT"); assert_eq "作废后重呼 code 0" "$(code "$R")" "0"
assert_eq "重呼单号 seq=2" "$(jq -r .data.deliveryNo <<<"$R")" "D${DLO2}-2"
# —— 分支③明确失败：30005 ADMIN 不重试→42225；30004 熔断→42232→恢复
DLO3=$(mk_local_paid); req POST "/api/admin/local/orders/$DLO3/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30005"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "30005 手动呼叫不重试 42225" "$(code "$R")" "42225"
assert_eq "ADMIN 来源只外呼一次" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[]|select(.op=="createOrder")]|length')" "1"
R=$(req GET "/api/admin/local/orders/$DLO3/delivery" "$AT"); assert_eq "失败后 FAILED" "$(jq -r .data.delivery.status <<<"$R")" "FAILED"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30004"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "30004 → 42225" "$(code "$R")" "42225"
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "熔断后直接拒 42232" "$(code "$R")" "42232"
assert_eq "熔断可见于 status" "$(req GET /api/admin/system/status "$AT" | jq -r .data.kd100.circuitTripped)" "true"
R=$(req POST /api/admin/system/kd100-circuit/reset "$AT"); assert_eq "恢复 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "恢复后可呼 code 0" "$(code "$R")" "0"
# —— 落库失败必须释放占位（否则该订单永久不可再呼）
DLO4=$(mk_local_paid); req POST "/api/admin/local/orders/$DLO4/accept" "$AT" >/dev/null
DUPT=$(req GET "/api/admin/local/orders/$DLO1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"createOrder\",\"directive\":{\"kind\":\"ok\",\"taskId\":\"$DUPT\"}}" >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO4/call" "$AT"); assert_eq "落库失败返 42225" "$(code "$R")" "42225"
R=$(req GET "/api/admin/local/orders/$DLO4/delivery" "$AT")
assert_eq "落库失败后置 FAILED" "$(jq -r .data.delivery.status <<<"$R")" "FAILED"
assert_eq "落库失败后释放占位" "$(jq -r .data.delivery.activeOrderId <<<"$R")" "null"
R=$(req POST "/api/admin/local/orders/$DLO4/call" "$AT"); assert_eq "释放后可重呼 code 0" "$(code "$R")" "0"

echo "== 27. 回调状态机 =="
req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":29350000,"lngE6":104790000}' >/dev/null   # 恢复第22段清掉的坐标
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
md5hex() { if command -v md5sum >/dev/null 2>&1; then printf '%s' "$1" | md5sum | cut -d' ' -f1; else printf '%s' "$1" | md5 -q; fi; }
KDCB_BODY=/tmp/e2e-kdcb.json
kd_cb() { # deliveryNo taskId status desc updateTime [courierName] [courierMobile] → echo HTTP 状态码，响应体在 $KDCB_BODY
  local dno="$1" task="$2" st="$3" desc="$4" ut="$5" cn="${6:-王骑手}" cm="${7:-13900001111}"
  local salt param sign
  salt=$(req GET "/api/admin/system/kd100-mock/salt/$dno" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg t "$task" --arg s "$st" --arg d "$desc" --arg u "$ut" --arg cn "$cn" --arg cm "$cm" \
    '{taskId:$t,status:$s,statusDesc:$d,updateTime:$u,courierName:$cn,courierMobile:$cm,kuaidicom:"shansongtongcheng"}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$KDCB_BODY" -w '%{http_code}' -X POST "$BASE/api/kd/$dno" \
    --data-urlencode "param=$param" --data-urlencode "sign=$sign" --data-urlencode "taskId=$task"
}
dstat() { req GET "/api/admin/local/orders/$1/delivery" "$AT" | jq -r .data.delivery.status; }
# —— 正向剧本：0→100→310→520，Order 联动 PREPARING→SHIPPED→COMPLETED
CBO1=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO1/call" "$AT"); CBD1=$(jq -r .data.deliveryNo <<<"$R")
CBT1=$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
assert_eq "cb 100 http 200" "$(kd_cb "$CBD1" "$CBT1" 100 '骑手已接单' '2026-09-04 12:00:00')" "200"
assert_eq "cb 100 应答 result=true" "$(jq -r .result "$KDCB_BODY")" "true"
assert_eq "100→ACCEPTED" "$(dstat $CBO1)" "ACCEPTED"
R=$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT")
assert_eq "骑手姓名已写" "$(jq -r .data.delivery.courierName <<<"$R")" "王骑手"
assert_eq "订单仍 PREPARING（100 不动订单）" "$(req GET "/api/admin/orders/$CBO1" "$AT" | jq -r .data.status)" "PREPARING"
EVN1=$(jq -r '.data.events | length' <<<"$R")
assert_eq "重复 100（同 updateTime）http 200" "$(kd_cb "$CBD1" "$CBT1" 100 '骑手已接单' '2026-09-04 12:00:00')" "200"
assert_eq "重复回调不新增事件" "$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT" | jq -r '.data.events | length')" "$EVN1"
assert_eq "cb 310 http 200" "$(kd_cb "$CBD1" "$CBT1" 310 '骑手已取货' '2026-09-04 12:05:00')" "200"
assert_eq "310→DELIVERING" "$(dstat $CBO1)" "DELIVERING"
assert_eq "订单 →SHIPPED" "$(req GET "/api/admin/orders/$CBO1" "$AT" | jq -r .data.status)" "SHIPPED"
assert_eq "迟到乱序 210 http 200" "$(kd_cb "$CBD1" "$CBT1" 210 '迟到的赶来取货' '2026-09-04 12:03:00')" "200"
assert_eq "rank 单调：迟到包不回退" "$(dstat $CBO1)" "DELIVERING"
assert_eq "cb 520 http 200" "$(kd_cb "$CBD1" "$CBT1" 520 '已送达' '2026-09-04 12:20:00')" "200"
assert_eq "520→DELIVERED" "$(dstat $CBO1)" "DELIVERED"
assert_eq "订单 →COMPLETED" "$(req GET "/api/admin/orders/$CBO1" "$AT" | jq -r .data.status)" "COMPLETED"
assert_eq "终态释放占位（activeOrderId=null）" "$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT" | jq -r .data.delivery.activeOrderId)" "null"
# —— 防线：验签失败 / 查不到单 / 未知状态，一律 200 且不动状态
CBO2=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO2/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO2/call" "$AT"); CBD2=$(jq -r .data.deliveryNo <<<"$R")
CBT2=$(req GET "/api/admin/local/orders/$CBO2/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
P=$(jq -cn --arg t "$CBT2" '{taskId:$t,status:"100",statusDesc:"x",updateTime:"2026-09-04 12:00:00"}')
HTTPC=$(curl -s -o "$KDCB_BODY" -w '%{http_code}' -X POST "$BASE/api/kd/$CBD2" --data-urlencode "param=$P" --data-urlencode "sign=DEADBEEF" --data-urlencode "taskId=$CBT2")
assert_eq "错签名 http 200" "$HTTPC" "200"
assert_eq "错签名不动状态" "$(dstat $CBO2)" "CALLING"
assert_eq "查不到单 http 200" "$(kd_cb "D999999-9" "T-NONE" 100 x '2026-09-04 12:00:00' 2>/dev/null || echo 200)" "200"
assert_eq "未知状态 999 http 200" "$(kd_cb "$CBD2" "$CBT2" 999 '外星状态' '2026-09-04 12:01:00')" "200"
assert_eq "未知状态不动状态机" "$(dstat $CBO2)" "CALLING"
# —— 入库失败返 500（N5）：providerStatus 超出 Int 列范围 → 事件落库抛错 → 500 让快递100 重推
assert_eq "入库失败 http 500" "$(kd_cb "$CBD2" "$CBT2" 99999999999999999999 '溢出' '2026-09-04 12:02:00')" "500"
assert_eq "500 应答 result=false" "$(jq -r .result "$KDCB_BODY")" "false"
# —— 并呼假撤单：taskId 不匹配的 720 不得终态化；随后真 100 正常推进
assert_eq "陌生 taskId 的 720 http 200" "$(kd_cb "$CBD2" "OTHER-TASK" 720 '未中标运力撤单' '2026-09-04 12:03:00')" "200"
assert_eq "假撤单不终态化" "$(dstat $CBO2)" "CALLING"
assert_eq "真 100 http 200" "$(kd_cb "$CBD2" "$CBT2" 100 '骑手已接单' '2026-09-04 12:04:00')" "200"
assert_eq "推进 ACCEPTED" "$(dstat $CBO2)" "ACCEPTED"
# —— N8：515 改派后收到 100，允许 rank 回拨、换新骑手
assert_eq "cb 515 http 200" "$(kd_cb "$CBD2" "$CBT2" 515 '骑手改派中' '2026-09-04 12:05:00')" "200"
assert_eq "515→REASSIGNING" "$(dstat $CBO2)" "REASSIGNING"
assert_eq "改派后新 100 http 200" "$(kd_cb "$CBD2" "$CBT2" 100 '新骑手接单' '2026-09-04 12:06:00' '李骑手' '13922223333')" "200"
assert_eq "REASSIGNING→ACCEPTED（rank 回拨特例）" "$(dstat $CBO2)" "ACCEPTED"
assert_eq "换成新骑手" "$(req GET "/api/admin/local/orders/$CBO2/delivery" "$AT" | jq -r .data.delivery.courierName)" "李骑手"
# —— 720 匹配 taskId：终态化 + SHIPPED 回退 PREPARING（三重护栏都通过时）
assert_eq "cb 310 http 200" "$(kd_cb "$CBD2" "$CBT2" 310 '骑手已取货' '2026-09-04 12:07:00')" "200"
assert_eq "订单 →SHIPPED" "$(req GET "/api/admin/orders/$CBO2" "$AT" | jq -r .data.status)" "SHIPPED"
# 真已是 SHIPPED 的 LOCAL 单，邮寄端点 complete 必须仍拒（不是巧合命中「非 SHIPPED」分支的假阳性）
R=$(req POST "/api/admin/orders/$CBO2/complete" "$AT"); assert_eq "已 SHIPPED 的 LOCAL 单邮寄 complete 仍拒 42204" "$(code "$R")" "42204"
assert_eq "complete 被拒后订单仍 SHIPPED（未被误置 COMPLETED）" "$(req GET "/api/admin/orders/$CBO2" "$AT" | jq -r .data.status)" "SHIPPED"
assert_eq "匹配 taskId 的 720 http 200" "$(kd_cb "$CBD2" "$CBT2" 720 '骑手取消订单' '2026-09-04 12:08:00')" "200"
assert_eq "720→CANCELLED" "$(dstat $CBO2)" "CANCELLED"
assert_eq "订单回退 PREPARING" "$(req GET "/api/admin/orders/$CBO2" "$AT" | jq -r .data.status)" "PREPARING"
assert_eq "720 释放占位" "$(req GET "/api/admin/local/orders/$CBO2/delivery" "$AT" | jq -r .data.delivery.activeOrderId)" "null"
# —— UNKNOWN 认领：超时占位单收到回调即认领 taskId 并推进
CBO3=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO3/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO3/call" "$AT"); CBD3=$(jq -r .data.deliveryNo <<<"$R")
assert_eq "占位 UNKNOWN" "$(dstat $CBO3)" "UNKNOWN"
# taskId 必须每轮唯一：providerTaskId 是唯一索引，写死字面量会让第二轮 e2e 撞 P2002（连跑不幂等）
LATET="LATE-TASK-$CBO3"
assert_eq "迟到回调认领 http 200" "$(kd_cb "$CBD3" "$LATET" 0 '并呼抢单中' '2026-09-04 12:10:00')" "200"
assert_eq "UNKNOWN→CALLING（认领成功）" "$(dstat $CBO3)" "CALLING"
assert_eq "认领写入 taskId" "$(req GET "/api/admin/local/orders/$CBO3/delivery" "$AT" | jq -r .data.delivery.providerTaskId)" "$LATET"
# —— 缺 updateTime 时用 rawBody 摘要去重：同内容两次只 +1 事件；换内容再 +1（不误合并）
CBO4=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO4/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO4/call" "$AT"); CBD4=$(jq -r .data.deliveryNo <<<"$R")
CBT4=$(req GET "/api/admin/local/orders/$CBO4/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
EVN4=$(req GET "/api/admin/local/orders/$CBO4/delivery" "$AT" | jq -r '.data.events | length')
assert_eq "缺 updateTime 首次回调 http 200" "$(kd_cb "$CBD4" "$CBT4" 100 '骑手已接单-无时间戳' '')" "200"
EVN4A=$(req GET "/api/admin/local/orders/$CBO4/delivery" "$AT" | jq -r '.data.events | length')
assert_eq "首次回调事件数 +1" "$EVN4A" "$((EVN4+1))"
assert_eq "缺 updateTime 重复回调（同内容）http 200" "$(kd_cb "$CBD4" "$CBT4" 100 '骑手已接单-无时间戳' '')" "200"
assert_eq "同内容用 rawBody 摘要去重，事件数不增" "$(req GET "/api/admin/local/orders/$CBO4/delivery" "$AT" | jq -r '.data.events | length')" "$EVN4A"
assert_eq "缺 updateTime 换内容回调 http 200" "$(kd_cb "$CBD4" "$CBT4" 100 '骑手已接单-换个描述' '')" "200"
assert_eq "换内容不会被误合并，事件数 +1" "$(req GET "/api/admin/local/orders/$CBO4/delivery" "$AT" | jq -r '.data.events | length')" "$((EVN4A+1))"
# —— 缺字段（statusDesc/courierName/courierMobile/kuaidicom 均不传）仍 200，且状态机照常推进
salt4=$(req GET "/api/admin/system/kd100-mock/salt/$CBD4" "$AT" | jq -r '.data.salt // empty')
PMIN=$(jq -cn --arg t "$CBT4" '{taskId:$t,status:"310",updateTime:"2026-09-04 12:10:00"}')
SIGNMIN=$(md5hex "${PMIN}${salt4}" | tr 'a-f' 'A-F')
HTTPMIN=$(curl -s -o "$KDCB_BODY" -w '%{http_code}' -X POST "$BASE/api/kd/$CBD4" --data-urlencode "param=$PMIN" --data-urlencode "sign=$SIGNMIN" --data-urlencode "taskId=$CBT4")
assert_eq "缺字段（仅 taskId/status/updateTime）回调 http 200" "$HTTPMIN" "200"
assert_eq "缺字段回调仍推进状态机 →DELIVERING" "$(dstat $CBO4)" "DELIVERING"

echo "== 28. 配送单操作与资金联动 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
OPO1=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO1/call" "$AT"); OPD1=$(jq -r .data.deliveryNo <<<"$R")
OPT1=$(req GET "/api/admin/local/orders/$OPO1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
# —— 加小费（CALLING 才能加；上限来自设置 tip.maxPerCall=2000/maxPerOrder=5000）
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/tip" "$AT" '{"amount":500}'); assert_eq "加小费 code 0" "$(code "$R")" "0"
assert_eq "tipFee 累加 500" "$(jq -r .data.tipFeeFen <<<"$R")" "500"
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/tip" "$AT" '{"amount":2100}'); assert_eq "超单次上限 42235" "$(code "$R")" "42235"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"addTip","directive":{"kind":"error","code":"50000"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/tip" "$AT" '{"amount":500}'); assert_eq "运力拒绝加小费 42236" "$(code "$R")" "42236"
# —— 42221：有在途配送单不准退款（admin 退款入口 amount 必填，取整单金额）
OPAMT=$(req GET "/api/admin/orders/$OPO1" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$OPO1/refund" "$AT" "{\"amount\":$OPAMT,\"reason\":\"e2e 测 42221\"}")
assert_eq "在途配送单挡退款 42221" "$(code "$R")" "42221"
# —— 预估取消费 + 取消：CALLING 阶段取消，订单留在 PREPARING 可重呼
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/precancel" "$AT"); assert_eq "precancel code 0" "$(code "$R")" "0"
assert_eq "预估取消费 200" "$(jq -r .data.cancelFeeFen <<<"$R")" "200"
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/cancel" "$AT" '{"reason":"e2e 取消"}'); assert_eq "取消 code 0" "$(code "$R")" "0"
assert_eq "取消后 CANCELLED" "$(dstat $OPO1)" "CANCELLED"
assert_eq "订单留在 PREPARING" "$(req GET "/api/admin/orders/$OPO1" "$AT" | jq -r .data.status)" "PREPARING"
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/cancel" "$AT"); assert_eq "无在途单再取消 42233" "$(code "$R")" "42233"
# 取消后退款可通过（资金联动闭环）
R=$(req POST "/api/admin/orders/$OPO1/refund" "$AT" "{\"amount\":$OPAMT,\"reason\":\"e2e 拒后退款\"}"); assert_eq "取消配送后退款 code 0" "$(code "$R")" "0"
assert_eq "订单 → REFUNDED" "$(req GET "/api/admin/orders/$OPO1" "$AT" | jq -r .data.status)" "REFUNDED"
# —— 取消超时（42238）：状态必须原地不动
OPO2=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO2/accept" "$AT" >/dev/null
req POST "/api/admin/local/orders/$OPO2/call" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO2/delivery/cancel" "$AT"); assert_eq "取消超时 42238" "$(code "$R")" "42238"
assert_eq "超时后仍 CALLING（未误终态化）" "$(dstat $OPO2)" "CALLING"
req POST "/api/admin/local/orders/$OPO2/delivery/cancel" "$AT" >/dev/null   # 清场：真取消
# —— 自己送 + 标记送达
OPO3=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO3/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO3/self-deliver" "$AT" '{"name":"阿福","phone":"15309003232"}')
assert_eq "自己送 code 0" "$(code "$R")" "0"
assert_eq "订单 →SHIPPED" "$(req GET "/api/admin/orders/$OPO3" "$AT" | jq -r .data.status)" "SHIPPED"
R=$(req GET "/api/admin/local/orders/$OPO3/delivery" "$AT")
assert_eq "SELF 配送单 DELIVERING" "$(jq -r .data.delivery.status <<<"$R")" "DELIVERING"
assert_eq "provider=SELF" "$(jq -r .data.delivery.provider <<<"$R")" "SELF"
R=$(req POST "/api/admin/local/orders/$OPO3/delivered" "$AT"); assert_eq "标记送达 code 0" "$(code "$R")" "0"
assert_eq "订单 →COMPLETED" "$(req GET "/api/admin/orders/$OPO3" "$AT" | jq -r .data.status)" "COMPLETED"
assert_eq "配送单 →DELIVERED" "$(dstat $OPO3)" "DELIVERED"
R=$(req POST "/api/admin/local/orders/$OPO3/delivered" "$AT"); assert_eq "重复标记送达 42233" "$(code "$R")" "42233"
# 有在途单时不准自己送（复用 OPO2：清场取消后订单仍是已接单 PREPARING，重新呼叫即可；
# 复用即够用，无需再新建一单——非生产环境限流已放宽（payLimiter 500/分钟），不再受它约束）
OPO4=$OPO2
req POST "/api/admin/local/orders/$OPO4/call" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO4/self-deliver" "$AT" '{"name":"阿福","phone":"15309003232"}')
assert_eq "在途单挡自己送 42228" "$(code "$R")" "42228"
# —— 顾客端可见性：白名单字段 + 位置接口 + 取消申请快照
OPT4=$(req GET "/api/admin/local/orders/$OPO4/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
OPD4=$(req GET "/api/admin/local/orders/$OPO4/delivery" "$AT" | jq -r .data.delivery.deliveryNo)
kd_cb "$OPD4" "$OPT4" 100 '骑手已接单' '2026-09-04 13:00:00' '赵骑手' '13933334444' >/dev/null
R=$(req GET "/api/orders/$OPO4" "$UT")
assert_eq "顾客可见骑手姓名" "$(jq -r .data.delivery.courierName <<<"$R")" "赵骑手"
assert_eq "顾客可见状态标签" "$(jq -r .data.delivery.statusLabel <<<"$R")" "骑手已接单"
assert_eq "salt 不外泄" "$(jq -r '.data.delivery | has("callbackSalt")' <<<"$R")" "false"
assert_eq "费用不外泄" "$(jq -r '.data.delivery | has("quotedFee")' <<<"$R")" "false"
R=$(req GET "/api/orders/$OPO4/courier" "$UT"); assert_eq "位置接口 code 0" "$(code "$R")" "0"
assert_eq "mock 无位置 → null" "$(jq -r .data.location <<<"$R")" "null"
R=$(req POST "/api/orders/$OPO4/cancel-request" "$UT" '{"note":"e2e 快照"}'); assert_eq "取消申请 code 0" "$(code "$R")" "0"
assert_eq "快照真实配送状态" "$(req GET "/api/admin/orders/$OPO4" "$AT" | jq -r .data.cancelRequestDeliveryStatus)" "ACCEPTED"
req POST "/api/admin/local/orders/$OPO4/delivery/cancel" "$AT" >/dev/null   # 清场
# —— 探测接口（门店坐标已在第 21 段设置）
R=$(req POST /api/admin/settings/local-delivery/probe "$AT" '{"latE6":29350000,"lngE6":104790000}')
assert_eq "探测 code 0" "$(code "$R")" "0"
assert_eq "mock 报价 500" "$(jq -r .data.feeFen <<<"$R")" "500"

echo "== 29. 拒单 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
# —— 参数校验
RJ1=$(mk_local_paid); req POST "/api/admin/local/orders/$RJ1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"OTHER"}'); assert_eq "其他原因不填说明 40001" "$(code "$R")" "40001"
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"SOLD_OUT"}'); assert_eq "售罄不勾菜 40001" "$(code "$R")" "40001"
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" "{\"reason\":\"SOLD_OUT\",\"soldOutProductIds\":[999999]}")
assert_eq "勾选非本单商品 40001" "$(code "$R")" "40001"
# —— 42221：在途配送单先拦
req POST "/api/admin/local/orders/$RJ1/call" "$AT" >/dev/null
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"OUT_OF_RANGE"}'); assert_eq "在途配送单挡拒单 42221" "$(code "$R")" "42221"
req POST "/api/admin/local/orders/$RJ1/delivery/cancel" "$AT" >/dev/null
# —— 售罄拒单：REFUNDED + 顾客可见文案 + 联动下架
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" "{\"reason\":\"SOLD_OUT\",\"soldOutProductIds\":[$LPID]}")
assert_eq "售罄拒单 code 0" "$(code "$R")" "0"
assert_eq "联动下架 1 件" "$(jq -r .data.offShelfCount <<<"$R")" "1"
assert_eq "订单 → REFUNDED（N4）" "$(req GET "/api/admin/orders/$RJ1" "$AT" | jq -r .data.status)" "REFUNDED"
R=$(req GET "/api/orders/$RJ1" "$UT")
[[ "$(jq -r .data.cancelReason <<<"$R")" == 商家拒单：菜品售罄* ]] && ok "顾客可见拒单原因" || fail "cancelReason" "$R"
assert_eq "商品已下架" "$(req GET "/api/products/$LPID" "$UT" | jq -r .data.status)" "OFF_SHELF"
req PUT "/api/admin/products/$LPID" "$AT" '{"status":"ON_SHELF"}' >/dev/null   # 恢复上架供后续段使用
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"OUT_OF_RANGE"}'); assert_eq "重复拒单被挡（已终态）" "$(code "$R")" "42204"
# —— 邮寄单也能拒（N3）：造一笔 EXPRESS 已支付单
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); RJC=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$RJC],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
RJ2=$(jq -r '.data.orderId // empty' <<<"$R"); req POST "/api/orders/$RJ2/pay" "$UT" >/dev/null
R=$(req POST "/api/admin/orders/$RJ2/reject" "$AT" '{"reason":"OTHER","note":"e2e 邮寄拒单"}')
assert_eq "邮寄单拒单 code 0" "$(code "$R")" "0"
assert_eq "邮寄单 → REFUNDED" "$(req GET "/api/admin/orders/$RJ2" "$AT" | jq -r .data.status)" "REFUNDED"
[[ "$(jq -r .data.cancelReason <<<"$R")" == *其他原因（e2e\ 邮寄拒单）* ]] && ok "OTHER 拼入说明" || fail "OTHER 文案" "$R"
# —— 待付款单拒单：走取消不走退款，库存回滚
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); RJC3=$(jq -r '.data.id // empty' <<<"$R")
ST0=$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$RJC3],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
RJ3=$(jq -r '.data.orderId // empty' <<<"$R")
R=$(req POST "/api/admin/orders/$RJ3/reject" "$AT" '{"reason":"PAST_ACCEPT_TIME"}')
assert_eq "待付款拒单 code 0" "$(code "$R")" "0"
assert_eq "待付款 → CANCELLED（不退款）" "$(req GET "/api/admin/orders/$RJ3" "$AT" | jq -r .data.status)" "CANCELLED"
assert_eq "退款对象为 null" "$(jq -r .data.refund <<<"$R")" "null"
assert_eq "库存回滚" "$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)" "$ST0"

echo "== 30. 同城定时任务 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
sched() { req POST /api/admin/system/run-scheduler "$AT" "$1"; }
SCH1=$(mk_local_paid); req POST "/api/admin/local/orders/$SCH1/accept" "$AT" >/dev/null
# 备餐超时未呼叫（每单一次）
R=$(sched '{"localUncalledMin":0}'); [[ "$(jq -r .data.localUncalled <<<"$R")" -ge 1 ]] && ok "localUncalled ≥1" || fail "localUncalled" "$R"
R=$(sched '{"localUncalledMin":0}'); assert_eq "localUncalled 第二跑归零（每单一次）" "$(jq -r .data.localUncalled <<<"$R")" "0"
# 自动呼叫（override 开启；settings 默认 0=手动。用 0.01 分钟=600ms 而非 0，
# 因为 autoCallRiders 现在无条件以 delay<=0 作为手动模式的门槛——见下方手动模式断言。
# 实测 accept 到这里的自然间隔仅约 60ms，远不够 600ms 阈值，故显式 sleep 1s 垫够间隔）
sleep 1
R=$(sched '{"autoCallDelayMin":0.01}')
[[ "$(jq -r .data.localAutoCall <<<"$R")" -ge 1 ]] && ok "autoCall ≥1" || fail "autoCall" "$R"
assert_eq "SCH1 被自动呼叫 → CALLING" "$(dstat $SCH1)" "CALLING"
R=$(sched '{"autoCallDelayMin":0.01}'); assert_eq "已有在途单不重呼" "$(jq -r .data.localAutoCall <<<"$R")" "0"
# 有 cancelRequest 的候选不参与自动呼叫（即便超过延迟时长、无在途配送单也不能呼）
SCHCR=$(mk_local_paid); req POST "/api/admin/local/orders/$SCHCR/accept" "$AT" >/dev/null
req POST "/api/orders/$SCHCR/cancel-request" "$UT" '{"note":"e2e 呼叫前取消"}' >/dev/null
sleep 1
sched '{"autoCallDelayMin":0.01}' >/dev/null
assert_eq "有 cancelRequest 的候选未被自动呼叫（无配送单）" "$(req GET "/api/admin/local/orders/$SCHCR/delivery" "$AT" | jq -r .data.delivery)" "null"
# 待抢单超时（每单一次）
R=$(sched '{"callTimeoutMin":0}'); [[ "$(jq -r .data.localCallTimeout <<<"$R")" -ge 1 ]] && ok "callTimeout ≥1" || fail "callTimeout" "$R"
R=$(sched '{"callTimeoutMin":0}'); assert_eq "callTimeout 第二跑归零" "$(jq -r .data.localCallTimeout <<<"$R")" "0"
# 接单后卡住 → 配送中超时
SCT1=$(req GET "/api/admin/local/orders/$SCH1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
SCD1=$(req GET "/api/admin/local/orders/$SCH1/delivery" "$AT" | jq -r .data.delivery.deliveryNo)
kd_cb "$SCD1" "$SCT1" 100 '骑手已接单' '2026-09-04 14:00:00' >/dev/null
R=$(sched '{"acceptedStuckMin":0}'); [[ "$(jq -r .data.localAcceptedStuck <<<"$R")" -ge 1 ]] && ok "acceptedStuck ≥1" || fail "acceptedStuck" "$R"
R=$(sched '{"acceptedStuckMin":0}'); assert_eq "acceptedStuck 第二跑归零" "$(jq -r .data.localAcceptedStuck <<<"$R")" "0"
kd_cb "$SCD1" "$SCT1" 310 '骑手已取货' '2026-09-04 14:05:00' >/dev/null
R=$(sched '{"deliveringTimeoutMin":0}'); [[ "$(jq -r .data.localDelivering <<<"$R")" -ge 1 ]] && ok "delivering ≥1" || fail "delivering" "$R"
R=$(sched '{"deliveringTimeoutMin":0}'); assert_eq "delivering 第二跑归零" "$(jq -r .data.localDelivering <<<"$R")" "0"
kd_cb "$SCD1" "$SCT1" 520 '已送达' '2026-09-04 14:30:00' >/dev/null   # 收尾到终态
# UNKNOWN 幽灵单提醒
SCH2=$(mk_local_paid); req POST "/api/admin/local/orders/$SCH2/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout"}}' >/dev/null
req POST "/api/admin/local/orders/$SCH2/call" "$AT" >/dev/null
R=$(sched '{"unknownStuckMin":0}'); [[ "$(jq -r .data.localUnknown <<<"$R")" -ge 1 ]] && ok "unknown ≥1" || fail "unknown" "$R"
R=$(sched '{"unknownStuckMin":0}'); assert_eq "unknown 第二跑归零" "$(jq -r .data.localUnknown <<<"$R")" "0"
req POST "/api/admin/local/orders/$SCH2/delivery/void" "$AT" >/dev/null
# 取消申请挂起提醒
SCH3=$(mk_local_paid); req POST "/api/admin/local/orders/$SCH3/accept" "$AT" >/dev/null
req POST "/api/orders/$SCH3/cancel-request" "$UT" '{"note":"e2e 挂起"}' >/dev/null
R=$(sched '{"cancelRequestPendingMin":0}'); [[ "$(jq -r .data.localCancelReq <<<"$R")" -ge 1 ]] && ok "cancelReq ≥1" || fail "cancelReq" "$R"
R=$(sched '{"cancelRequestPendingMin":0}'); assert_eq "cancelReq 第二跑归零" "$(jq -r .data.localCancelReq <<<"$R")" "0"
# housekeeping 存在且不炸
R=$(sched '{}'); [[ "$(jq -r '.data | has("localHousekeeping")' <<<"$R")" == "true" ]] && ok "housekeeping 已注册" || fail "housekeeping" "$R"
# 手动模式（不传 override）不自动呼叫：settings.autoCallDelayMin 全程未被改写，默认即 0；
# 此刻 SCH2 是 PREPARING 且无在途单的合格候选，若手动模式的门被绕过这条会变红
assert_eq "手动模式（不传 override）不自动呼叫" "$(jq -r .data.localAutoCall <<<"$R")" "0"

echo "== 11. 清理 =="
for a in ${ADDR2:-} ${FADDR:-}; do req DELETE "/api/addresses/$a" "$UT" >/dev/null; done
req DELETE "/api/addresses/$ADDR" "$UT" >/dev/null && ok "删除测试地址"
[[ -n "${LADDR:-}" ]] && req DELETE "/api/addresses/$LADDR" "$UT" >/dev/null
[[ -n "${NADDR:-}" ]] && req DELETE "/api/addresses/$NADDR" "$UT" >/dev/null
rm -f "$PNG" "$R1" "$R2"
[[ -n "${LPID:-}" ]] && req DELETE "/api/admin/products/$LPID" "$AT" >/dev/null
[[ -n "${EPID:-}" ]] && req DELETE "/api/admin/products/$EPID" "$AT" >/dev/null
[[ -n "${LCAT:-}" ]] && req DELETE "/api/admin/categories/$LCAT" "$AT" >/dev/null
[[ -n "${ECAT:-}" ]] && req DELETE "/api/admin/categories/$ECAT" "$AT" >/dev/null
[[ -n "${LCID:-}" ]] && req DELETE "/api/cart/$LCID" "$UT" >/dev/null
for o in ${LO1:-} ${LO2:-}; do docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop_sc -e "update orders set status='CANCELLED' where id=$o and status in ('PENDING_PAYMENT','PAID','PREPARING');" 2>/dev/null; done
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null 2>&1 || true

echo "== 24. 渠道一致性 =="
node scripts/check-channel-consistency.mjs && ok "product.channel = category.channel" || fail "渠道不一致"

echo ""
echo "================ 通过 $PASS / 失败 $FAIL ================"
[[ $FAIL -eq 0 ]]
