echo "== 70. 用户管理：手机号/姓名兜底显示、订单收货人搜索、只看下过单的 =="
# 需求：用户管理页手机号列一直是「-」、昵称一直是「用户 #id」——users.phone/nickname/avatarUrl
# 从登录起就没被写入过（登录只建 openid 行，见 routes/auth.ts）。真正有值的是订单收货人快照
# orders.receiver_name/receiver_phone。改法（不改小程序、不接微信手机号授权）：
#   1. GET /api/admin/users 每行附带该用户「最近一单」（latestOrder，createdAt 最新，
#      不排除任何状态，含未付款/已取消/测试单）的 orderNo/receiverName/receiverPhone/status/createdAt。
#   2. keyword 除原有 nickname/phone 外，同时匹配该用户任一订单的收货人姓名/手机号（子串匹配，
#      天然支持尾号模糊搜索）。
#   3. 新增 hasOrders=1：只留下过单的用户（口径与 orderCount 列一致：orders 表任一状态记录 ≥1）。
# 本段验证服务端契约；前端展示（手机号来源标注、默认勾选、卡片视图）见 apps/admin/src/pages/Users.tsx
# 人工走查，不在这里覆盖。复用主体 req/code/ok/fail/assert_eq/num/sql 与 $AT/$PID。变量一律 U70_ 前缀。
U70_TAG=$RANDOM$RANDOM

# keyword 里含中文时必须先 percent-encode 再拼 URL——curl 会把 URL 参数里的原始多字节
# UTF-8 字节原样塞进请求行，这不是合法的 HTTP request-line，Node 的 http 解析器会在
# 还没到 Express 路由前就直接回 400（无响应体），jq 在空字符串上解析失败，表现成一堆
# 莫名其妙的断言失败（实测：本文件最初版本的 ⑤⑥⑧ 全军覆没，curl -v 才看出是 400）。
# 手机号/尾号是纯数字，不受影响；但凡 keyword 可能含中文，一律过这个函数。
urlenc() { jq -rn --arg v "$1" '$v|@uri'; }

u70_addr() { # $1=token $2=receiverName $3=receiverPhone → echo addressId
  local r
  r=$(req POST /api/addresses "$1" "{\"receiverName\":\"$2\",\"receiverPhone\":\"$3\",\"province\":\"四川省\",\"city\":\"成都市\",\"district\":\"武侯区\",\"detail\":\"测试路1号\",\"isDefault\":1}")
  jq -r '.data.id // empty' <<<"$r"
}
u70_order() { # $1=token $2=addressId → echo orderId（EXPRESS，不支付）
  local r cid
  r=$(req POST /api/cart "$1" "{\"productId\":$PID,\"quantity\":1}")
  cid=$(jq -r '.data.id // empty' <<<"$r"); [[ -n "$cid" ]] || { echo ""; return; }
  r=$(req POST /api/orders "$1" "{\"cartItemIds\":[$cid],\"addressId\":$2,\"deliveryType\":\"EXPRESS\"}")
  jq -r '.data.orderId // .data.id // empty' <<<"$r"
}
u70_find() { # $1=keyword（原文，函数内部负责 encode）→ 该用户是否在 list 里（pageSize=50，只用于尾号/姓名这类不保证 total=1 的场景）
  jq --argjson uid "$U70_UID" '[.data.list[].id] | index($uid) != null' <<<"$(req GET "/api/admin/users?keyword=$(urlenc "$1")&pageSize=50" "$AT")"
}

echo "-- ① 基线：造一个新用户，不带筛选 total+1，hasOrders=1 的 total 不变（还没下单）--"
T_ALL0=$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?pageSize=1" "$AT")")")
T_HAS0=$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?hasOrders=1&pageSize=1" "$AT")")")

R=$(req POST /api/auth/wechat-login "" "{\"code\":\"u$U70_TAG\"}")
U70_UT=$(jq -r '.data.token // empty' <<<"$R")
U70_UID=$(jq -r '.data.userId // empty' <<<"$R")
[[ -n "$U70_UT" && -n "$U70_UID" ]] && ok "① 新用户 mock 登录 #$U70_UID" || { fail "① 新用户 mock 登录失败" "$R"; }

assert_eq "① 不带筛选：total = T_ALL0+1" \
  "$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?pageSize=1" "$AT")")")" "$((T_ALL0+1))"
assert_eq "① hasOrders=1：total 不变" \
  "$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?hasOrders=1&pageSize=1" "$AT")")")" "$T_HAS0"

echo "-- ② 还没下单：keyword=手机号&hasOrders=1 命中 0（不是「查不到号码」，是「这人没下过单」）--"
U70_P1="138$(printf '%08d' $(( (RANDOM*32768+RANDOM) % 100000000 )))"
assert_eq "② keyword=P1&hasOrders=1 → total=0" \
  "$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?keyword=$U70_P1&hasOrders=1" "$AT")")")" "0"

echo "-- ③ 建地址、加购、下单（不支付）：latestOrder 生效 --"
U70_ADDR_A=$(u70_addr "$U70_UT" "U70客A$U70_TAG" "$U70_P1")
[[ -n "$U70_ADDR_A" ]] && ok "③ 建地址 A #$U70_ADDR_A" || fail "③ 建地址 A 失败"
U70_OA=$(u70_order "$U70_UT" "$U70_ADDR_A")
[[ -n "$U70_OA" ]] && ok "③ 下单 A #$U70_OA（不支付）" || fail "③ 下单 A 失败"

R=$(req GET "/api/admin/users?keyword=$U70_P1" "$AT")
assert_eq "③ keyword=P1 → total=1" "$(num "$(jq -r .data.total <<<"$R")")" "1"
assert_eq "③ list[0].id = 该用户" "$(jq -r '.data.list[0].id' <<<"$R")" "$U70_UID"
assert_eq "③ latestOrder.receiverPhone = P1" "$(jq -r '.data.list[0].latestOrder.receiverPhone' <<<"$R")" "$U70_P1"
assert_eq "③ latestOrder.receiverName = U70客A<TAG>" "$(jq -r '.data.list[0].latestOrder.receiverName' <<<"$R")" "U70客A$U70_TAG"
assert_eq "③ latestOrder.status = PENDING_PAYMENT（不排状态）" "$(jq -r '.data.list[0].latestOrder.status' <<<"$R")" "PENDING_PAYMENT"
assert_eq "③ orderCount = 1" "$(num "$(jq -r '.data.list[0].orderCount' <<<"$R")")" "1"
assert_eq "③ hasOrders=1：total = T_HAS0+1" \
  "$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?hasOrders=1&pageSize=1" "$AT")")")" "$((T_HAS0+1))"

echo "-- ④ 尾号模糊搜索（contains 天然支持子串）--"
U70_P1_TAIL=${U70_P1: -4}
[[ "$(u70_find "$U70_P1_TAIL")" == "true" ]] && ok "④ 尾号 $U70_P1_TAIL 搜索命中该用户" || fail "④ 尾号搜索未命中"

echo "-- ⑤ 收货人姓名搜索 --"
[[ "$(u70_find "U70客A$U70_TAG")" == "true" ]] && ok "⑤ 收货人姓名搜索命中该用户" || fail "⑤ 姓名搜索未命中"

echo "-- ⑥ 支付单 A，再建单 B：latestOrder 换成更新的一单，orderCount=2，旧姓名仍搜得到 --"
R=$(req POST "/api/orders/$U70_OA/pay" "$U70_UT")
[[ "$(jq -r .data.mode <<<"$R")" == "mock" ]] && ok "⑥ 单 A 支付成功" || fail "⑥ 单 A 支付失败" "$R"

U70_P2="139$(printf '%08d' $(( (RANDOM*32768+RANDOM) % 100000000 )))"
U70_ADDR_B=$(u70_addr "$U70_UT" "U70客B$U70_TAG" "$U70_P2")
[[ -n "$U70_ADDR_B" ]] && ok "⑥ 建地址 B #$U70_ADDR_B" || fail "⑥ 建地址 B 失败"
U70_OB=$(u70_order "$U70_UT" "$U70_ADDR_B")
[[ -n "$U70_OB" ]] && ok "⑥ 下单 B #$U70_OB（不支付）" || fail "⑥ 下单 B 失败"

R=$(req GET "/api/admin/users?keyword=$U70_P1" "$AT")
assert_eq "⑥ keyword=旧单 P1 仍能查到该用户（OR 匹配该用户任一订单）" "$(num "$(jq -r .data.total <<<"$R")")" "1"
assert_eq "⑥ latestOrder 已换成单 B 的收货人手机号" "$(jq -r '.data.list[0].latestOrder.receiverPhone' <<<"$R")" "$U70_P2"
assert_eq "⑥ orderCount = 2" "$(num "$(jq -r '.data.list[0].orderCount' <<<"$R")")" "2"
[[ "$(u70_find "U70客A$U70_TAG")" == "true" ]] && ok "⑥ 老收货人姓名仍能搜到该用户" || fail "⑥ 老姓名搜不到了"

echo "-- ⑦ 用户自助取消单 B：latestOrder.status → CANCELLED（仍是「最近一单」，不排状态）--"
R=$(req PUT "/api/orders/$U70_OB/cancel" "$U70_UT")
assert_eq "⑦ 取消 code 0" "$(code "$R")" "0"
R=$(req GET "/api/admin/users?keyword=$U70_P2" "$AT")
assert_eq "⑦ latestOrder.receiverPhone 仍是 P2" "$(jq -r '.data.list[0].latestOrder.receiverPhone' <<<"$R")" "$U70_P2"
assert_eq "⑦ latestOrder.status = CANCELLED" "$(jq -r '.data.list[0].latestOrder.status' <<<"$R")" "CANCELLED"

echo "-- ⑫ latestOrder 批量取值不是「嵌套 take:1」而是窗口函数，用 4 张新单再钉一遍最新单口径 --"
# 复核 R1：验证「批量取每个用户最近一单」在同一个用户名下订单变多之后仍然只挑最新一条——
# 嵌套 select 那种写法在行数多起来后可能因为客户端裁剪逻辑跑偏而选错（本条正是复核抓到的场景）。
# C→D→E→F 依次建地址、下单、（下完即取消），F 是最新的一单。
for L in C D E F; do
  U70_P_L="137$(printf '%08d' $(( (RANDOM*32768+RANDOM) % 100000000 )))"
  U70_ADDR_L=$(u70_addr "$U70_UT" "U70客$L$U70_TAG" "$U70_P_L")
  [[ -n "$U70_ADDR_L" ]] || fail "⑫ 建地址 $L 失败"
  U70_O_L=$(u70_order "$U70_UT" "$U70_ADDR_L")
  [[ -n "$U70_O_L" ]] || fail "⑫ 下单 $L 失败"
  R=$(req PUT "/api/orders/$U70_O_L/cancel" "$U70_UT")
  [[ "$(code "$R")" == "0" ]] || fail "⑫ 取消单 $L 失败" "$R"
done
ok "⑫ C–F 四张单已建并取消"

R=$(req GET "/api/admin/users?keyword=$U70_P1" "$AT")
assert_eq "⑫ orderCount = 6（A+B+C+D+E+F）" "$(num "$(jq -r '.data.list[0].orderCount' <<<"$R")")" "6"
assert_eq "⑫ latestOrder.receiverName = U70客F<TAG>（最新一张）" "$(jq -r '.data.list[0].latestOrder.receiverName' <<<"$R")" "U70客F$U70_TAG"
assert_eq "⑫ latestOrder.status = CANCELLED" "$(jq -r '.data.list[0].latestOrder.status' <<<"$R")" "CANCELLED"

R=$(req GET "/api/admin/users?keyword=$U70_P1&hasOrders=1" "$AT")
assert_eq "⑫ hasOrders=1 同结果：total=1" "$(num "$(jq -r .data.total <<<"$R")")" "1"
assert_eq "⑫ hasOrders=1 同结果：latestOrder.receiverName = U70客F<TAG>" "$(jq -r '.data.list[0].latestOrder.receiverName' <<<"$R")" "U70客F$U70_TAG"

[[ "$(u70_find "U70客A$U70_TAG")" == "true" ]] && ok "⑫ 最早那张单（A）的收货人姓名仍能搜到该用户" || fail "⑫ 老姓名（A）搜不到了"

echo "-- ⑧ 昵称搜索（既有口径不受影响）--"
sql "UPDATE users SET nickname='U70昵称$U70_TAG' WHERE id=$U70_UID;"
assert_eq "⑧ 昵称搜索命中" "$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?keyword=$(urlenc "U70昵称$U70_TAG")" "$AT")")")" "1"

echo "-- ⑨ hasOrders=1：不会混进 orderCount<1 的行 --"
R=$(req GET "/api/admin/users?hasOrders=1&pageSize=50" "$AT")
assert_eq "⑨ hasOrders=1 无 orderCount<1 的行" "$(jq -r '[.data.list[] | select((.orderCount // 0) < 1)] | length' <<<"$R")" "0"

echo "-- ⑩ hasOrders=0 显式传 = 不传 --"
U70_CUR_ALL=$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?pageSize=1" "$AT")")")
assert_eq "⑩ hasOrders=0 显式传 = 不传" \
  "$(num "$(jq -r .data.total <<<"$(req GET "/api/admin/users?hasOrders=0&pageSize=1" "$AT")")")" "$U70_CUR_ALL"

echo "-- ⑪ 不带筛选：列表每行都有 latestOrder 键（值可以是 null）--"
R=$(req GET "/api/admin/users?pageSize=50" "$AT")
[[ "$(jq -r '[.data.list[] | has("latestOrder")] | all' <<<"$R")" == "true" ]] \
  && ok "⑪ 每行都带 latestOrder 键" || fail "⑪ latestOrder 键缺失" "$R"

# 收尾：单 A 已被支付（终态之一），单 B、C、D、E、F 均已被取消——六张单没有一张停在待付款，
# 不用额外清理。
