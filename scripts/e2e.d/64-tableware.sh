echo "== 64. 结算页餐具选择：四面透传、校验、旧版前缀兼容、tableware-last、小票两联（2026-09-14 餐具选择设计）=="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sql/PJOBS/lquote；$UT/$AT/$LADDR/$LCAT。变量一律 P64_ 前缀。
# 自建同城商品（不复用 $LPID——理由同 §63/§49）。
P64_ORIG_LS=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
p64_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }

echo "-- 前置：开通自取并钉死营业时段/起送线，关打包费（本段不验打包费）；自建同城商品 --"
p64_put '.pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1
  | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"NONE",value:0} | .pickup.autoCompleteAfterMin=120
  | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=20 | .peak.windows=[]
  | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .pickup.paused=null
  | .fee.minOrderAmount=0 | .fee.freeShipTiers=[] | .enabled=true | .paused=null
  | .packing.enabled=false' >/dev/null
P64_SLOT=$(req GET /api/local/pickup-slots | jq -r '[.data.days[].slots[]][0].startAt')
[[ -n "$P64_SLOT" && "$P64_SLOT" != "null" ]] && ok "拿到自取时段 $P64_SLOT" || fail "没有可选时段"

R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E-TABLEWARE-A$RANDOM\",\"price\":2000,\"stock\":99,\"netWeightG\":300}")
P64_PA=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P64_PA" ]] && ok "创建同城商品 #$P64_PA（¥20）" || fail "创建同城商品" "$R"

# 四面取数写法（①②④每种模式都要过）：下单响应 / 顾客详情 / 后台列表（带渠道参数）/ 工作台卡片（付款后、fresh=1）
p64_check_four() { # $1=orderId $2=admin列表 deliveryType 参数值 $3=期望 mode $4=期望 count（字面量 null 或数字） $5=场景标签
  local id=$1 dt=$2 wantMode=$3 wantCount=$4 label=$5
  local det; det=$(req GET "/api/orders/$id" "$UT")
  assert_eq "$label 顾客详情 tablewareMode" "$(jq -r .data.tablewareMode <<<"$det")" "$wantMode"
  assert_eq "$label 顾客详情 tablewareCount" "$(jq -r .data.tablewareCount <<<"$det")" "$wantCount"
  local row; row=$(req GET "/api/admin/orders?deliveryType=$dt&pageSize=50" "$AT" | jq -c "[.data.list[] | select(.id==$id)][0]")
  assert_eq "$label 后台列表 tablewareMode" "$(jq -r .tablewareMode <<<"$row")" "$wantMode"
  assert_eq "$label 后台列表 tablewareCount" "$(jq -r .tablewareCount <<<"$row")" "$wantCount"
  req POST "/api/orders/$id/pay" "$UT" >/dev/null
  local card; card=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT" | jq -c "[.data.columns[][] | select(.orderId==$id)][0]")
  [[ "$card" != "null" && -n "$card" ]] && ok "$label 工作台卡片存在" || fail "$label 工作台卡片不存在（遍历全部列后仍未找到）" "$card"
  assert_eq "$label 卡片 tableware.mode" "$(jq -r .tableware.mode <<<"$card")" "$wantMode"
  assert_eq "$label 卡片 tableware.count" "$(jq -r .tableware.count <<<"$card")" "$wantCount"
}

echo "-- ① 自取单 tableware:{mode:NONE} --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010001\"},\"tableware\":{\"mode\":\"NONE\"}}")
assert_eq "① 下单 code 0" "$(code "$R")" "0"
P64_O1=$(jq -r .data.orderId <<<"$R")
assert_eq "① 下单响应 tablewareMode=NONE" "$(jq -r .data.tablewareMode <<<"$R")" "NONE"
assert_eq "① 下单响应 tablewareCount=null" "$(jq -r .data.tablewareCount <<<"$R")" "null"
p64_check_four "$P64_O1" PICKUP NONE null "①"

echo "-- ② 自取单 tableware:{mode:COUNT,count:3} --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010002\"},\"tableware\":{\"mode\":\"COUNT\",\"count\":3}}")
assert_eq "② 下单 code 0" "$(code "$R")" "0"
P64_O2=$(jq -r .data.orderId <<<"$R")
assert_eq "② 下单响应 tablewareMode=COUNT" "$(jq -r .data.tablewareMode <<<"$R")" "COUNT"
assert_eq "② 下单响应 tablewareCount=3" "$(jq -r .data.tablewareCount <<<"$R")" "3"
p64_check_four "$P64_O2" PICKUP COUNT 3 "②"

echo "-- ③ 校验：mode=COUNT 缺 count / count=0 / count=11 / BY_MEAL 带 count / mode=XX → 均 40001 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010003\"},\"tableware\":{\"mode\":\"COUNT\"}}")
assert_eq "③ mode=COUNT 缺 count → 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010003\"},\"tableware\":{\"mode\":\"COUNT\",\"count\":0}}")
assert_eq "③ count=0 → 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010003\"},\"tableware\":{\"mode\":\"COUNT\",\"count\":11}}")
assert_eq "③ count=11 → 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010003\"},\"tableware\":{\"mode\":\"BY_MEAL\",\"count\":2}}")
assert_eq "③ BY_MEAL 带 count → 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010003\"},\"tableware\":{\"mode\":\"XX\"}}")
assert_eq "③ mode=XX → 40001" "$(code "$R")" "40001"

echo "-- ④ 同城外送单（照 §63 ④ 的 lquote/LQTOKEN 写法）带 {mode:BY_MEAL} --"
lquote "$LADDR" 2000
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"tableware\":{\"mode\":\"BY_MEAL\"}}")
assert_eq "④ 同城外送下单 code 0" "$(code "$R")" "0"
P64_O4=$(jq -r .data.orderId <<<"$R")
assert_eq "④ 下单响应 tablewareMode=BY_MEAL" "$(jq -r .data.tablewareMode <<<"$R")" "BY_MEAL"
assert_eq "④ 下单响应 tablewareCount=null" "$(jq -r .data.tablewareCount <<<"$R")" "null"
p64_check_four "$P64_O4" LOCAL BY_MEAL null "④"

echo "-- ⑤ 旧版前缀兼容：不带 tableware，remark 为「[需要餐具] 一二三四五六七八九十一二三四」（前缀7字+14字，共21字） --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010005\"},\"remark\":\"[需要餐具] 一二三四五六七八九十一二三四\"}")
assert_eq "⑤ 下单 code 0" "$(code "$R")" "0"
P64_O5=$(jq -r .data.orderId <<<"$R")
assert_eq "⑤ 落库 remark 剥掉前缀" "$(sql "SELECT remark FROM orders WHERE id=$P64_O5;")" "一二三四五六七八九十一二三四"
assert_eq "⑤ 落库 tableware_mode=BY_MEAL" "$(sql "SELECT tableware_mode FROM orders WHERE id=$P64_O5;")" "BY_MEAL"

echo "-- ⑥ 不带 tableware、备注无前缀的自取单 → tablewareMode=null --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010006\"}}")
assert_eq "⑥ 下单 code 0" "$(code "$R")" "0"
P64_O6=$(jq -r .data.orderId <<<"$R")
assert_eq "⑥ tablewareMode=null" "$(jq -r .data.tablewareMode <<<"$R")" "null"

echo "-- ⑦ 邮寄单带 tableware:{mode:NONE} → 两列 null（EXPRESS 带了也忽略） --"
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}")
P64_CE=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$P64_CE],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\",\"tableware\":{\"mode\":\"NONE\"}}")
assert_eq "⑦ 邮寄下单 code 0" "$(code "$R")" "0"
P64_O7=$(jq -r .data.orderId <<<"$R")
assert_eq "⑦ 邮寄单 tablewareMode=null" "$(jq -r .data.tablewareMode <<<"$R")" "null"
assert_eq "⑦ 邮寄单 tablewareCount=null" "$(jq -r .data.tablewareCount <<<"$R")" "null"

echo "-- ⑧ GET /api/orders/tableware-last：应取最近一张同城/自取且有值的单（⑤ BY_MEAL），邮寄单有值也不采信 --"
# ④ 与 ⑤ 都是 BY_MEAL、⑦ 两列本来就是 null，原样查分不清取的是哪张、也验不到 deliveryType 过滤：
# 临时把 ④ 改成 NONE、⑦ 改成 COUNT/9，⑧ 仍返回 BY_MEAL 才证明取的是 ⑤ 且邮寄单有值也不采信；断言完恢复
sql "UPDATE orders SET tableware_mode='NONE' WHERE id=$P64_O4;"
sql "UPDATE orders SET tableware_mode='COUNT', tableware_count=9 WHERE id=$P64_O7;"
R=$(req GET /api/orders/tableware-last "$UT")
assert_eq "⑧ tableware-last mode=BY_MEAL（来自⑤，不是④/⑦）" "$(jq -r .data.mode <<<"$R")" "BY_MEAL"
assert_eq "⑧ tableware-last count=null" "$(jq -r .data.count <<<"$R")" "null"
sql "UPDATE orders SET tableware_mode='BY_MEAL' WHERE id=$P64_O4;"
sql "UPDATE orders SET tableware_mode=NULL, tableware_count=NULL WHERE id=$P64_O7;"

echo "-- ⑨ 小票：付款一张 COUNT/3 自取单，NEW_ORDER 两联各印一次「餐具：3 份」；付款一张 NONE 单，票面含「无需餐具」 --"
P64_ORIG_PRINTER=$(req GET /api/admin/settings/printer "$AT" | jq -c .data)
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"P64-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null

R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010009\"},\"tableware\":{\"mode\":\"COUNT\",\"count\":3}}")
P64_O9A=$(jq -r .data.orderId <<<"$R")
req POST "/api/orders/$P64_O9A/pay" "$UT" >/dev/null
sleep 0.5
P64_T1=$(PJOBS "$P64_O9A" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
P64_CNT=$(grep -o "餐具：3 份" <<<"$P64_T1" | wc -l | tr -d ' ')
assert_eq "⑨ COUNT/3 小票两联各印一次「餐具：3 份」" "$P64_CNT" "2"

R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P64_PA,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P64_SLOT\",\"pickupContact\":{\"phone\":\"13800010010\"},\"tableware\":{\"mode\":\"NONE\"}}")
P64_O9B=$(jq -r .data.orderId <<<"$R")
req POST "/api/orders/$P64_O9B/pay" "$UT" >/dev/null
sleep 0.5
P64_T2=$(PJOBS "$P64_O9B" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$P64_T2" == *"无需餐具"* ]] && ok "⑨ NONE 单票面含「无需餐具」" || fail "⑨ NONE 单票面没印无需餐具" "$P64_T2"

echo "-- 收尾：恢复本段改过的同城设置与打印机设置；本段 PAID 未接单的单标记取消；清打印作业；标记测试单 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P64_ORIG_LS" >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req PUT /api/admin/settings/printer "$AT" "$P64_ORIG_PRINTER" >/dev/null
req PUT "/api/admin/products/$P64_PA" "$AT" '{"status":"OFF_SHELF"}' >/dev/null
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 收尾' WHERE id IN ($P64_O1,$P64_O2,$P64_O4,$P64_O9A,$P64_O9B) AND status='PAID';"
sql "DELETE FROM print_jobs WHERE order_id IN ($P64_O1,$P64_O2,$P64_O4,$P64_O5,$P64_O6,$P64_O7,$P64_O9A,$P64_O9B);"
sql "UPDATE orders SET is_test=1 WHERE id IN ($P64_O1,$P64_O2,$P64_O4,$P64_O5,$P64_O6,$P64_O7,$P64_O9A,$P64_O9B);"
