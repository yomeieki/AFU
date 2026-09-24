echo "== 75. 用户管理：累计消费口径 + GET /:id + 订单弹窗 deliveryType/加载更多（2026-09-24） =="
# 需求：用户列表新增「累计消费」spendFen（Σ(actual−refunded)，只算 paid_at 非空且非测试单的订单，
# 见 routes/admin/users.ts 的 spendByUserIds）与排序 sort=spend；新增 GET /admin/users/:id（订单弹窗
# 按 URL 重开用）；GET /:id/orders 补 deliveryType。本段不依赖 §70/§48 的任何变量（分片按文件名序
# source，§70 在本文件之前跑过，但按规划要求本文件不借用它定义的函数），只用主体 req/code/ok/fail/
# assert_eq/num/sql 与 $AT/$PID。变量一律 U75_ 前缀。
U75_TAG=$RANDOM$RANDOM

u75_enc() { jq -rn --arg v "$1" '$v|@uri'; }
u75_addr() { # $1=token $2=receiverName $3=receiverPhone → echo addressId
  local r
  r=$(req POST /api/addresses "$1" "{\"receiverName\":\"$2\",\"receiverPhone\":\"$3\",\"province\":\"四川省\",\"city\":\"成都市\",\"district\":\"武侯区\",\"detail\":\"测试路1号\",\"isDefault\":1}")
  jq -r '.data.id // empty' <<<"$r"
}
u75_order() { # $1=token $2=addressId → echo orderId（EXPRESS，不支付，每单 1 件同一商品 $PID）
  local r cid
  r=$(req POST /api/cart "$1" "{\"productId\":$PID,\"quantity\":1}")
  cid=$(jq -r '.data.id // empty' <<<"$r"); [[ -n "$cid" ]] || { echo ""; return; }
  r=$(req POST /api/orders "$1" "{\"cartItemIds\":[$cid],\"addressId\":$2,\"deliveryType\":\"EXPRESS\"}")
  jq -r '.data.orderId // .data.id // empty' <<<"$r"
}
u75_pay() { req POST "/api/orders/$2/pay" "$1"; } # $1=token $2=orderId → 响应 JSON

echo "-- 造三个账号：U（下 6 单）、V（下 1 单）、W（无单）；创建顺序 U → V → W --"
R=$(req POST /api/auth/wechat-login "" "{\"code\":\"u75u$U75_TAG\"}")
U75_UT=$(jq -r '.data.token // empty' <<<"$R"); U75_UID=$(jq -r '.data.userId // empty' <<<"$R")
[[ -n "$U75_UT" && -n "$U75_UID" ]] && ok "U 登录 #$U75_UID" || fail "U 登录失败" "$R"

R=$(req POST /api/auth/wechat-login "" "{\"code\":\"u75v$U75_TAG\"}")
U75_VT=$(jq -r '.data.token // empty' <<<"$R"); U75_VID=$(jq -r '.data.userId // empty' <<<"$R")
[[ -n "$U75_VT" && -n "$U75_VID" ]] && ok "V 登录 #$U75_VID" || fail "V 登录失败" "$R"

R=$(req POST /api/auth/wechat-login "" "{\"code\":\"u75w$U75_TAG\"}")
U75_WT=$(jq -r '.data.token // empty' <<<"$R"); U75_WID=$(jq -r '.data.userId // empty' <<<"$R")
[[ -n "$U75_WT" && -n "$U75_WID" ]] && ok "W 登录 #$U75_WID" || fail "W 登录失败" "$R"

sql "UPDATE users SET nickname='U75客${U75_TAG}W' WHERE id=$U75_WID;"

U75_ADDR_U=$(u75_addr "$U75_UT" "U75客${U75_TAG}U" "138$(printf '%08d' $(( (RANDOM*32768+RANDOM) % 100000000 )))")
[[ -n "$U75_ADDR_U" ]] && ok "U 建地址 #$U75_ADDR_U" || fail "U 建地址失败"
U75_ADDR_V=$(u75_addr "$U75_VT" "U75客${U75_TAG}V" "139$(printf '%08d' $(( (RANDOM*32768+RANDOM) % 100000000 )))")
[[ -n "$U75_ADDR_V" ]] && ok "V 建地址 #$U75_ADDR_V" || fail "V 建地址失败"

echo "-- U 的 6 张单：O3 全额记入、O4 部分退、O5 全额退、O6 测试单、O2 未付取消、O1 未付（段末再取消，最后建）--"
U75_O3=$(u75_order "$U75_UT" "$U75_ADDR_U")
[[ -n "$U75_O3" ]] && ok "O3 下单 #$U75_O3" || fail "O3 下单失败"
R=$(u75_pay "$U75_UT" "$U75_O3")
assert_eq "O3 支付成功" "$(jq -r .data.mode <<<"$R")" "mock"

U75_O4=$(u75_order "$U75_UT" "$U75_ADDR_U")
[[ -n "$U75_O4" ]] && ok "O4 下单 #$U75_O4" || fail "O4 下单失败"
R=$(u75_pay "$U75_UT" "$U75_O4")
assert_eq "O4 支付成功" "$(jq -r .data.mode <<<"$R")" "mock"
R=$(req POST "/api/admin/orders/$U75_O4/refund" "$AT" '{"amount":1,"reason":"e2e部分退1分"}')
assert_eq "O4 部分退款 1 分 code 0" "$(code "$R")" "0"

U75_O5=$(u75_order "$U75_UT" "$U75_ADDR_U")
[[ -n "$U75_O5" ]] && ok "O5 下单 #$U75_O5" || fail "O5 下单失败"
R=$(u75_pay "$U75_UT" "$U75_O5")
assert_eq "O5 支付成功" "$(jq -r .data.mode <<<"$R")" "mock"
U75_REM5=$(req GET "/api/admin/orders/$U75_O5" "$AT" | jq -r '.data.remainingRefundable')
R=$(req POST "/api/admin/orders/$U75_O5/refund" "$AT" "{\"amount\":$U75_REM5,\"reason\":\"e2e全额退\"}")
assert_eq "O5 全额退款 code 0" "$(code "$R")" "0"

U75_O6=$(u75_order "$U75_UT" "$U75_ADDR_U")
[[ -n "$U75_O6" ]] && ok "O6 下单 #$U75_O6" || fail "O6 下单失败"
R=$(u75_pay "$U75_UT" "$U75_O6")
assert_eq "O6 支付成功" "$(jq -r .data.mode <<<"$R")" "mock"
R=$(req PATCH "/api/admin/orders/$U75_O6/test-flag" "$AT" '{"isTest":true}')
assert_eq "O6 标测试单 code 0" "$(code "$R")" "0"

U75_O2=$(u75_order "$U75_UT" "$U75_ADDR_U")
[[ -n "$U75_O2" ]] && ok "O2 下单 #$U75_O2（不支付）" || fail "O2 下单失败"
R=$(req PUT "/api/orders/$U75_O2/cancel" "$U75_UT")
assert_eq "O2 顾客取消 code 0" "$(code "$R")" "0"

U75_O1=$(u75_order "$U75_UT" "$U75_ADDR_U")
[[ -n "$U75_O1" ]] && ok "O1 下单 #$U75_O1（最后建，暂不支付）" || fail "O1 下单失败"

echo "-- V 的单：OV 全额记入 --"
U75_OV=$(u75_order "$U75_VT" "$U75_ADDR_V")
[[ -n "$U75_OV" ]] && ok "OV 下单 #$U75_OV" || fail "OV 下单失败"
R=$(u75_pay "$U75_VT" "$U75_OV")
assert_eq "OV 支付成功" "$(jq -r .data.mode <<<"$R")" "mock"

echo "-- 前置：金额口径构造是否成立 --"
U75_P=$(sql "SELECT actual_amount FROM orders WHERE id=$U75_O3;")
U75_ALL_AMTS=$(sql "SELECT GROUP_CONCAT(DISTINCT actual_amount) FROM orders WHERE id IN ($U75_O3,$U75_O4,$U75_O5,$U75_O6,$U75_O2,$U75_O1,$U75_OV);")
assert_eq "前置：各单实付相等（都等于 O3 的 actual_amount=$U75_P）" "$U75_ALL_AMTS" "$U75_P"
assert_eq "前置：O4 refunded_amount=1" "$(sql "SELECT refunded_amount FROM orders WHERE id=$U75_O4;")" "1"
assert_eq "前置：O5 refunded_amount=actual_amount（全额退）" "$(sql "SELECT (refunded_amount=actual_amount) FROM orders WHERE id=$U75_O5;")" "1"
assert_eq "前置：O6 is_test=1" "$(sql "SELECT is_test FROM orders WHERE id=$U75_O6;")" "1"
assert_eq "前置：O1 状态 PENDING_PAYMENT" "$(sql "SELECT status FROM orders WHERE id=$U75_O1;")" "PENDING_PAYMENT"
assert_eq "前置：O2 状态 CANCELLED" "$(sql "SELECT status FROM orders WHERE id=$U75_O2;")" "CANCELLED"

U75_SPEND_U=$((2*U75_P - 1))
U75_SPEND_V=$U75_P
U75_O1_NO=$(sql "SELECT order_no FROM orders WHERE id=$U75_O1;")

echo "-- 关键词命中 U/V/W 三人，默认序 [W,V,U]（W 最后建账号，createdAt 最新）--"
U75_KW="U75客${U75_TAG}"
U75_KW_ENC=$(u75_enc "$U75_KW")
R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC" "$AT")
assert_eq "list[].id = [W,V,U]" "$(jq -c '[.data.list[].id]' <<<"$R")" "[$U75_WID,$U75_VID,$U75_UID]"
assert_eq "total=3" "$(jq -r .data.total <<<"$R")" "3"
assert_eq "每行都有 spendFen 键" "$(jq -r '[.data.list[] | has("spendFen")] | all' <<<"$R")" "true"
assert_eq "W spendFen=0" "$(jq -r --argjson uid "$U75_WID" '.data.list[] | select(.id==$uid) | .spendFen' <<<"$R")" "0"
assert_eq "V spendFen=P" "$(jq -r --argjson uid "$U75_VID" '.data.list[] | select(.id==$uid) | .spendFen' <<<"$R")" "$U75_SPEND_V"
assert_eq "U spendFen=2P-1" "$(jq -r --argjson uid "$U75_UID" '.data.list[] | select(.id==$uid) | .spendFen' <<<"$R")" "$U75_SPEND_U"
assert_eq "U orderCount=6（含测试单/未付/已取消）" "$(jq -r --argjson uid "$U75_UID" '.data.list[] | select(.id==$uid) | .orderCount' <<<"$R")" "6"
assert_eq "U latestOrder.orderNo = O1（最近建的一单，未付款不影响 latestOrder 口径）" \
  "$(jq -r --argjson uid "$U75_UID" '.data.list[] | select(.id==$uid) | .latestOrder.orderNo' <<<"$R")" "$U75_O1_NO"
assert_eq "U latestOrder.status = PENDING_PAYMENT" \
  "$(jq -r --argjson uid "$U75_UID" '.data.list[] | select(.id==$uid) | .latestOrder.status' <<<"$R")" "PENDING_PAYMENT"

echo "-- sort=spend：按累计消费降序 [U,V,W]；hasOrders=1 过滤掉 W --"
R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC&sort=spend" "$AT")
assert_eq "sort=spend → [U,V,W]" "$(jq -c '[.data.list[].id]' <<<"$R")" "[$U75_UID,$U75_VID,$U75_WID]"
assert_eq "sort=spend total=3" "$(jq -r .data.total <<<"$R")" "3"

R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC&sort=spend&hasOrders=1" "$AT")
assert_eq "sort=spend&hasOrders=1 → [U,V]" "$(jq -c '[.data.list[].id]' <<<"$R")" "[$U75_UID,$U75_VID]"
assert_eq "sort=spend&hasOrders=1 total=2" "$(jq -r .data.total <<<"$R")" "2"

echo "-- sort=spend 分页：pageSize=1，page=2/3/4 --"
R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC&sort=spend&pageSize=1&page=2" "$AT")
assert_eq "page=2 → [V]" "$(jq -c '[.data.list[].id]' <<<"$R")" "[$U75_VID]"
assert_eq "page=2 total=3" "$(jq -r .data.total <<<"$R")" "3"
R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC&sort=spend&pageSize=1&page=3" "$AT")
assert_eq "page=3 → [W]" "$(jq -c '[.data.list[].id]' <<<"$R")" "[$U75_WID]"
R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC&sort=spend&pageSize=1&page=4" "$AT")
assert_eq "page=4 → []" "$(jq -c '[.data.list[].id]' <<<"$R")" "[]"

echo "-- sort=bogus：等同默认序（只认字面量 spend）--"
R=$(req GET "/api/admin/users?keyword=$U75_KW_ENC&sort=bogus" "$AT")
assert_eq "sort=bogus → [W,V,U]" "$(jq -c '[.data.list[].id]' <<<"$R")" "[$U75_WID,$U75_VID,$U75_UID]"

echo "-- GET /api/admin/users/:id --"
R=$(req GET "/api/admin/users/$U75_UID" "$AT")
assert_eq "code 0" "$(code "$R")" "0"
assert_eq "data.id=U" "$(jq -r .data.id <<<"$R")" "$U75_UID"
assert_eq "data.spendFen=2P-1" "$(jq -r .data.spendFen <<<"$R")" "$U75_SPEND_U"
assert_eq "data.orderCount=6" "$(jq -r .data.orderCount <<<"$R")" "6"
assert_eq "data.latestOrder.orderNo=O1" "$(jq -r .data.latestOrder.orderNo <<<"$R")" "$U75_O1_NO"
assert_eq "data 含 availableCoupons 键" "$(jq -r '.data | has("availableCoupons")' <<<"$R")" "true"
assert_eq "data 含 pointsBalance 键" "$(jq -r '.data | has("pointsBalance")' <<<"$R")" "true"
assert_eq "不存在的用户 → 40401" "$(code "$(req GET "/api/admin/users/99999999" "$AT")")" "40401"
assert_eq "非法 id → 40001" "$(code "$(req GET "/api/admin/users/abc" "$AT")")" "40001"

echo "-- GET /api/admin/users/:id/orders：deliveryType 与「加载更多」分页契约 --"
R=$(req GET "/api/admin/users/$U75_UID/orders" "$AT")
assert_eq "total=6" "$(jq -r .data.total <<<"$R")" "6"
assert_eq "每行都有 deliveryType=EXPRESS" "$(jq -r '[.data.list[] | (has("deliveryType") and .deliveryType=="EXPRESS")] | all' <<<"$R")" "true"
R=$(req GET "/api/admin/users/$U75_UID/orders?pageSize=2&page=3" "$AT")
assert_eq "pageSize=2&page=3 → 2 行（第 5、6 单）" "$(jq -r '.data.list | length' <<<"$R")" "2"
R=$(req GET "/api/admin/users/$U75_UID/orders?pageSize=2&page=4" "$AT")
assert_eq "pageSize=2&page=4 → 0 行（到底）" "$(jq -r '.data.list | length' <<<"$R")" "0"

echo "-- 收尾：O1 是唯一停在待付款的单，取消掉 --"
req PUT "/api/orders/$U75_O1/cancel" "$U75_UT" >/dev/null
