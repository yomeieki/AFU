echo "== 69. 同城预约送达：设置 / 时段 / 下单 / 取消窗口 / 已备好与呼叫 / 定时任务 / 小票 / 工作台 =="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sched/sql/PJOBS/snap/lquote/mk_local_paid；$UT/$AT/$LPID/$LADDR。变量一律 S69_ 前缀。
# 时段看真实时钟：营业时段钉成 00:00–23:59、daysAhead=1，任何时刻至少明天有格。
# 时刻推进不靠 override 键，靠 SQL 改 scheduled_at；偏移量从详情 schedule 节反推（s69_pin），不手算路上时间。
S69_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
s69_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
s69_ord() { req GET "/api/admin/orders/$1" "$AT"; }
s69_det() { req GET "/api/orders/$1" "$UT"; }
s69_sc() { s69_det "$1" | jq -c '.data.schedule'; }
# s69_pin orderId field offsetMin：把 scheduled_at 钉到「让 <field> = now + offsetMin」
s69_pin() {
  local diff
  diff=$(s69_sc "$1" | jq -r --arg f "$2" '((.scheduledAt|sub("\\.[0-9]+Z$";"Z")|fromdate) - (.[$f]|sub("\\.[0-9]+Z$";"Z")|fromdate)) / 60 | floor')
  sql "UPDATE orders SET scheduled_at=DATE_ADD(NOW(3), INTERVAL $((diff + $3)) MINUTE) WHERE id=$1;"
}
# s69_new slotIndex → echo orderId（已付款）；空串 = 失败（已记 fail）
s69_new() {
  local slot r oid
  lquote "$LADDR" 2400
  slot=$(req GET "/api/local/delivery-slots?distanceM=$LQDIST" | jq -r "[.data.days[].slots[]][$1].startAt")
  [[ -n "$slot" && "$slot" != "null" ]] || { fail "s69_new 没拿到第 $1 格"; echo ""; return; }
  r=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"$slot\"}")
  oid=$(jq -r '.data.orderId // empty' <<<"$r"); [[ -n "$oid" ]] || { fail "s69_new 下单失败" "$r"; echo ""; return; }
  req POST "/api/orders/$oid/pay" "$UT" >/dev/null; echo "$oid"
}
S69_IDS=""

echo "-- ① 未开通：时段 blocked=DISABLED，带 scheduledAt 下单 42290，非 LOCAL 带 scheduledAt 40001 --"
s69_put '.schedule.enabled=false | .enabled=true | .paused=null | .holiday=null | .businessHours=[{start:"00:00",end:"23:59"}] | .peak.windows=[]' >/dev/null
lquote "$LADDR" 2400
assert_eq "未开通 blocked=DISABLED" "$(req GET "/api/local/delivery-slots?distanceM=$LQDIST" | jq -r '.data.blocked.kind')" "DISABLED"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"2030-01-01T04:00:00.000Z\"}")
assert_eq "未开通带 scheduledAt 下单 42290" "$(code "$R")" "42290"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:00:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"},\"scheduledAt\":\"2030-01-01T04:00:00.000Z\"}")
assert_eq "非 LOCAL 带 scheduledAt 40001" "$(code "$R")" "40001"

echo "-- ② 开通：时段有格、meta 字段、距离缺参 40001 --"
R=$(s69_put '.schedule={enabled:true,slotMinutes:30,daysAhead:1,acceptBufferMin:5,prepMinutes:20,prepTicketLeadMin:15,readyRemindEveryMin:3,readyRemindMaxTimes:3,callToleranceMin:5} | .selfCancelLeadMin=120 | .prepMinutes=20 | .autoCallDelayMin=0')
assert_eq "开通预约 code 0" "$(code "$R")" "0"
R=$(req GET "/api/local/delivery-slots?distanceM=$LQDIST")
assert_eq "时段 blocked=null" "$(jq -r '.data.blocked' <<<"$R")" "null"
S69_SLOT0=$(jq -r '[.data.days[].slots[]][0].startAt' <<<"$R")
[[ -n "$S69_SLOT0" && "$S69_SLOT0" != "null" ]] && ok "拿到最早格 $S69_SLOT0" || fail "没有可选时段" "$R"
assert_eq "earliestAt = 第一格" "$(jq -r '.data.earliestAt' <<<"$R")" "$S69_SLOT0"
assert_eq "缺 distanceM 40001" "$(code "$(req GET /api/local/delivery-slots)")" "40001"
R=$(req GET /api/local/meta)
assert_eq "meta.delivery.scheduleEnabled=true" "$(jq -r '.data.delivery.scheduleEnabled' <<<"$R")" "true"
assert_eq "meta.delivery.earliestScheduleText 非空" "$(jq -r '.data.delivery.earliestScheduleText | length > 0' <<<"$R")" "true"
assert_eq "meta.delivery.selfCancelLeadMin=120" "$(jq -r '.data.delivery.selfCancelLeadMin' <<<"$R")" "120"
[[ "$(jq -r '.data.enabled' <<<"$R")" == "true" ]] && ok "老字段 enabled 仍在" || fail "老字段 enabled 丢了"

echo "-- ③ 下单：非整格 42291；预约单落库 scheduled_at 且 estimated_delivery_at 等于它；立即单不受影响 --"
lquote "$LADDR" 2400
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"2030-01-01T04:07:00.000Z\"}")
assert_eq "非整格 42291" "$(code "$R")" "42291"
S69_O1=$(s69_new 2); S69_IDS="$S69_IDS,$S69_O1"
[[ -n "$S69_O1" ]] && ok "预约单 #$S69_O1 已付款" || fail "造预约单失败"
assert_eq "回传 scheduledAt 非空" "$(s69_det "$S69_O1" | jq -r '.data.scheduledAt != null')" "true"
assert_eq "落库 scheduled_at = estimated_delivery_at" "$(sql "SELECT scheduled_at = estimated_delivery_at FROM orders WHERE id=$S69_O1;")" "1"
S69_ASAP=$(mk_local_paid); S69_IDS="$S69_IDS,$S69_ASAP"
[[ -n "$S69_ASAP" ]] && ok "立即单 #$S69_ASAP 照常" || fail "立即单造单失败"
assert_eq "立即单 scheduled_at 为空" "$(sql "SELECT scheduled_at IS NULL FROM orders WHERE id=$S69_ASAP;")" "1"

echo "-- ④ 打烊：营业时段不含现在 → 立即单 42222、预约单 code 0 --"
S69_H=$(TZ=Asia/Shanghai date +%H); S69_H=$((10#$S69_H))
if (( S69_H <= 17 )); then S69_BH="{start:\"$(printf %02d $((S69_H+2))):00\",end:\"$(printf %02d $((S69_H+5))):00\"}"; else S69_BH='{start:"01:00",end:"06:00"}'; fi
s69_put ".businessHours=[$S69_BH]" >/dev/null
lquote "$LADDR" 2400
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
assert_eq "打烊立即单 42222" "$(code "$R")" "42222"
S69_O2=$(s69_new 0); S69_IDS="$S69_IDS,$S69_O2"
[[ -n "$S69_O2" ]] && ok "打烊时预约单 #$S69_O2 成功" || fail "打烊时预约单失败"
s69_put '.businessHours=[{start:"00:00",end:"23:59"}]' >/dev/null

echo "-- ⑤ 详情 schedule 节；两小时外秒退；两小时内 42229 转申请取消（PAID 也可申请）--"
R=$(s69_sc "$S69_O2")
for f in scheduledAt callAt prepStartAt acceptDueAt ticketAt selfCancelUntil phase etaIfCallNow; do
  [[ "$(jq -r ".$f // empty" <<<"$R")" != "" ]] && ok "schedule.$f 非空" || fail "schedule.$f 缺失" "$R"
done
s69_pin "$S69_O2" selfCancelUntil 30
assert_eq "两小时外 canSelfCancel=true" "$(s69_det "$S69_O2" | jq -r '.data.canSelfCancel')" "true"
R=$(req PUT "/api/orders/$S69_O2/cancel" "$UT")
assert_eq "两小时外秒退 code 0" "$(code "$R")" "0"
assert_eq "O2 → REFUNDED" "$(s69_ord "$S69_O2" | jq -r .data.status)" "REFUNDED"
s69_pin "$S69_O1" selfCancelUntil -1
assert_eq "两小时内 canSelfCancel=false、canRequestCancel=true" "$(s69_det "$S69_O1" | jq -r '[.data.canSelfCancel,.data.canRequestCancel]|join(",")')" "false,true"
R=$(req PUT "/api/orders/$S69_O1/cancel" "$UT")
assert_eq "两小时内秒退 42229" "$(code "$R")" "42229"
R=$(req POST "/api/orders/$S69_O1/cancel-request" "$UT" '{"note":"改天再订"}')
assert_eq "PAID 预约单申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/local/orders/$S69_O1/cancel-request/reject" "$AT")
assert_eq "驳回 code 0" "$(code "$R")" "0"

echo "-- ⑥ 接单不重算送达；接单并呼叫 42292；过早呼叫 42292；force 呼叫 → MANUAL_EARLY + ready_at --"
s69_pin "$S69_O1" callAt 60
S69_EST=$(sql "SELECT estimated_delivery_at FROM orders WHERE id=$S69_O1;")
R=$(req POST "/api/admin/local/orders/$S69_O1/accept-and-call" "$AT")
assert_eq "接单并呼叫对预约单 42292" "$(code "$R")" "42292"
R=$(req POST "/api/admin/local/orders/$S69_O1/accept" "$AT")
assert_eq "接单 code 0" "$(code "$R")" "0"
assert_eq "接单不改 estimated_delivery_at" "$(sql "SELECT estimated_delivery_at FROM orders WHERE id=$S69_O1;")" "$S69_EST"
R=$(req POST "/api/admin/local/orders/$S69_O1/call" "$AT")
assert_eq "早于呼叫窗口 42292" "$(code "$R")" "42292"
R=$(req POST "/api/admin/local/orders/$S69_O1/call" "$AT" '{"force":true}')
assert_eq "force 呼叫 code 0" "$(code "$R")" "0"
assert_eq "call_origin=MANUAL_EARLY" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$S69_O1 ORDER BY id DESC LIMIT 1;")" "MANUAL_EARLY"
assert_eq "呼叫即写 ready_at" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$S69_O1;")" "1"
assert_eq "已呼叫后 canRequestCancel=false" "$(s69_det "$S69_O1" | jq -r '.data.canRequestCancel')" "false"
R=$(req PUT "/api/orders/$S69_O1/cancel" "$UT")
assert_eq "已备好/已呼叫后自助取消 42229" "$(code "$R")" "42229"

echo "-- ⑦ 已备好：立即单 42292、PAID 42204；早备好等到点（schedAutoCall），到点自动呼 SCHEDULED_AUTO --"
R=$(req POST "/api/admin/local/orders/$S69_ASAP/ready" "$AT")
assert_eq "立即单点已备好 42292" "$(code "$R")" "42292"
S69_O3=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O3"
R=$(req POST "/api/admin/local/orders/$S69_O3/ready" "$AT")
assert_eq "PAID 点已备好 42204" "$(code "$R")" "42204"
req POST "/api/admin/local/orders/$S69_O3/accept" "$AT" >/dev/null
s69_pin "$S69_O3" callAt 30
R=$(req POST "/api/admin/local/orders/$S69_O3/ready" "$AT")
assert_eq "早备好 code 0 called=false" "$(jq -r '[.code, .data.called]|join(",")' <<<"$R")" "0,false"
assert_eq "ready_at 已写" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$S69_O3;")" "1"
assert_eq "phase=READY_WAITING" "$(s69_sc "$S69_O3" | jq -r .phase)" "READY_WAITING"
R=$(sched '{}'); assert_eq "未到点 schedAutoCall=0" "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" "0"
assert_eq "未到点无配送单" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$S69_O3;")" "0"
s69_pin "$S69_O3" callAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" -ge 1 ]] && ok "到点 schedAutoCall≥1" || fail "到点没自动呼" "$R"
assert_eq "call_origin=SCHEDULED_AUTO" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$S69_O3 ORDER BY id DESC LIMIT 1;")" "SCHEDULED_AUTO"
assert_eq "phase=CALLED" "$(s69_sc "$S69_O3" | jq -r .phase)" "CALLED"
R=$(req POST "/api/admin/local/orders/$S69_O3/ready" "$AT")
assert_eq "已有在途单再点已备好 42228" "$(code "$R")" "42228"

echo "-- ⑧ 备餐票：ticketAt 到点出 PREP（只一张）+ 来单票版式；重复播报在 acceptDueAt 前不计数 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"S69-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
S69_O4=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O4"
sleep 0.5
S69_T=$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$S69_T" == *"预约配送"* ]] && ok "来单票票头 预约配送" || fail "来单票票头不对" "$S69_T"
[[ "$S69_T" == *"<B>送达 "* ]] && ok "来单票印送达时段" || fail "没印送达" "$S69_T"
[[ "$S69_T" == *"开始备餐 "* && "$S69_T" == *"呼叫骑手 "* ]] && ok "来单票印两个倒推时刻" || fail "没印倒推时刻" "$S69_T"
s69_pin "$S69_O4" ticketAt 30
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 60 MINUTE) WHERE id=$S69_O4;"
R=$(sched '{}')
assert_eq "未到出票时刻 schedPrepTicket=0" "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" "0"
assert_eq "接单截止前不重复播报 announce_count=0" "$(sql "SELECT announce_count FROM orders WHERE id=$S69_O4;")" "0"
assert_eq "接单截止前不催单" "$(sql "SELECT accept_reminded_at IS NULL FROM orders WHERE id=$S69_O4;")" "1"
s69_pin "$S69_O4" ticketAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" -ge 1 ]] && ok "到点 schedPrepTicket≥1" || fail "没出备餐票" "$R"
assert_eq "prep_ticket_at 已写" "$(sql "SELECT prep_ticket_at IS NOT NULL FROM orders WHERE id=$S69_O4;")" "1"
sleep 0.5
S69_P=$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="PREP")] | last | .content')
[[ "$S69_P" == *"开始备餐"* && "$S69_P" == *"前备好"* ]] && ok "备餐票版式" || fail "备餐票版式不对" "$S69_P"
[[ "$S69_P" == *"[未接单]"* ]] && ok "未接单警示" || fail "缺未接单警示" "$S69_P"
R=$(sched '{}'); assert_eq "第二轮不重复出备餐票" "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" "0"
assert_eq "PREP 作业只一张" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="PREP")] | length')" "1"

echo "-- ⑨ 催单锚在接单截止；通用催单不碰预约单 --"
s69_pin "$S69_O4" acceptDueAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedUnaccepted // -1' <<<"$R")" -ge 1 ]] && ok "到接单截止 schedUnaccepted≥1" || fail "没催" "$R"
assert_eq "accept_reminded_at 已写" "$(sql "SELECT accept_reminded_at IS NOT NULL FROM orders WHERE id=$S69_O4;")" "1"
R=$(sched '{}'); assert_eq "第二轮不重复催" "$(jq -r '.data.schedUnaccepted // -1' <<<"$R")" "0"
sched '{}' >/dev/null
[[ "$(sql "SELECT announce_count FROM orders WHERE id=$S69_O4;")" -ge 1 ]] && ok "接单截止后重复播报开始计数" || fail "接单截止后仍未播报"

echo "-- ⑩ 催备好：callAt 到点小条 + 首次企微；间隔内不重复；耗尽后告警一次不再出小条 --"
req POST "/api/admin/local/orders/$S69_O4/accept" "$AT" >/dev/null
s69_pin "$S69_O4" callAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedNotReady // -1' <<<"$R")" -ge 1 ]] && ok "到点 schedNotReady≥1" || fail "没催备好" "$R"
assert_eq "schedule_reminded_at 已写" "$(sql "SELECT schedule_reminded_at IS NOT NULL FROM orders WHERE id=$S69_O4;")" "1"
sleep 0.5
assert_eq "READY_DUE 作业 1 张" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | length')" "1"
R=$(sched '{}'); assert_eq "3 分钟内不重复" "$(jq -r '.data.schedNotReady // -1' <<<"$R")" "0"
sql "UPDATE orders SET schedule_reminded_at=DATE_SUB(NOW(3), INTERVAL 4 MINUTE) WHERE id=$S69_O4;"
R=$(sched '{}'); [[ "$(jq -r '.data.schedNotReady // -1' <<<"$R")" -ge 1 ]] && ok "过 3 分钟再出一张" || fail "第二张没出" "$R"
sleep 0.5
assert_eq "READY_DUE 作业 2 张" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | length')" "2"
s69_pin "$S69_O4" callAt -10   # 3×3=9 分钟已耗尽；只退 10 分钟是为了 scheduledAt 仍在未来（不被判 LATE）
sql "UPDATE orders SET schedule_reminded_at=DATE_SUB(NOW(3), INTERVAL 9 MINUTE) WHERE id=$S69_O4;"
R=$(sched '{}'); [[ "$(jq -r '.data.schedNotReady // -1' <<<"$R")" -ge 1 ]] && ok "耗尽告警一次" || fail "耗尽未告警" "$R"
assert_eq "耗尽后不再出小条（仍 2 张）" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | length')" "2"
R=$(sched '{}'); assert_eq "耗尽告警不重复" "$(jq -r '.data.schedNotReady // -1' <<<"$R")" "0"
assert_eq "phase=CALL_DUE" "$(s69_sc "$S69_O4" | jq -r .phase)" "CALL_DUE"
R=$(req POST "/api/admin/local/orders/$S69_O4/ready" "$AT")
assert_eq "过点后点已备好立即呼 called=true" "$(jq -r '[.code, .data.called]|join(",")' <<<"$R")" "0,true"

echo "-- ⑪ 超时告警：过约定时刻 11 分钟未取餐 → schedLate≥1 --"
S69_O5=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O5"
req POST "/api/admin/local/orders/$S69_O5/accept" "$AT" >/dev/null
s69_pin "$S69_O5" scheduledAt -11
R=$(sched '{}'); [[ "$(jq -r '.data.schedLate // -1' <<<"$R")" -ge 1 ]] && ok "超时告警 schedLate≥1" || fail "超时未告警" "$R"
assert_eq "phase=LATE" "$(s69_sc "$S69_O5" | jq -r .phase)" "LATE"

echo "-- ⑫ 工作台：WAITING 进 scheduled 列；TICKETED 进 pending；预约单排在立即单前；scheduleBar --"
S69_O6=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O6"
s69_pin "$S69_O6" ticketAt 60
R=$(snap)
assert_eq "WAITING 在 scheduled 列" "$(col_has scheduled "$S69_O6" "$R")" "true"
assert_eq "WAITING 不在 pending 列" "$(col_has pending "$S69_O6" "$R")" "false"
assert_eq "scheduleBar 非空且 count≥1" "$(jq -r '.data.scheduleBar != null and .data.scheduleBar.count >= 1' <<<"$R")" "true"
assert_eq "快照顶层 scheduleEnabled=true" "$(jq -r '.data.scheduleEnabled' <<<"$R")" "true"
s69_pin "$S69_O6" ticketAt -1
R=$(snap)
assert_eq "TICKETED 进 pending 列" "$(col_has pending "$S69_O6" "$R")" "true"
S69_CARD=$(jq -c ".data.columns.pending[] | select(.orderId==$S69_O6)" <<<"$R")
assert_eq "卡片 local.schedule.phase=TICKETED" "$(jq -r '.local.schedule.phase' <<<"$S69_CARD")" "TICKETED"
assert_eq "卡片 etaIfCallNow 非空" "$(jq -r '.local.schedule.etaIfCallNow != null' <<<"$S69_CARD")" "true"
S69_ASAP2=$(mk_local_paid); S69_IDS="$S69_IDS,$S69_ASAP2"
R=$(snap)
S69_IS=$(jq -r ".data.columns.pending | map(.orderId) | index($S69_O6)" <<<"$R"); S69_IA=$(jq -r ".data.columns.pending | map(.orderId) | index($S69_ASAP2)" <<<"$R")
[[ "$S69_IS" != "null" && "$S69_IA" != "null" && "$S69_IS" -lt "$S69_IA" ]] && ok "预约单排在同渠道立即单之前" || fail "排序不对 sched=$S69_IS asap=$S69_IA"
s69_pin "$S69_O6" prepStartAt -1
assert_eq "phase=PREPPING" "$(s69_sc "$S69_O6" | jq -r .phase)" "PREPPING"
R=$(req GET "/api/admin/orders?deliveryType=LOCAL&schedule=SCHEDULED&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$S69_O6)] | length" <<<"$R")" == "1" ]] && ok "列表 schedule=SCHEDULED 含预约单" || fail "列表筛选不含预约单"
[[ "$(jq -r "[.data.list[] | select(.id==$S69_ASAP2)] | length" <<<"$R")" == "0" ]] && ok "列表 schedule=SCHEDULED 不含立即单" || fail "列表筛选混入立即单"
assert_eq "管理端详情 schedule 节" "$(s69_ord "$S69_O6" | jq -r '.data.schedule.phase')" "PREPPING"

echo "-- ⑬ 现有任务不碰预约单：接单后 N 分钟自动呼叫、取消申请自动驳回 --"
S69_O7=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O7"
req POST "/api/admin/local/orders/$S69_O7/accept" "$AT" >/dev/null
sql "UPDATE orders SET accepted_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id=$S69_O7;"
s69_pin "$S69_O7" callAt 60
sched '{"autoCallDelayMin":0.01,"localUncalledMin":1}' >/dev/null
assert_eq "autoCallRiders 不呼预约单" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$S69_O7;")" "0"
assert_eq "remindLocalUncalled 不催预约单" "$(sql "SELECT local_uncalled_reminded_at IS NULL FROM orders WHERE id=$S69_O7;")" "1"
s69_pin "$S69_O7" selfCancelUntil -1
req POST "/api/orders/$S69_O7/cancel-request" "$UT" '{"note":"不要了"}' >/dev/null
sched '{"cancelAutoRejectMin":1}' >/dev/null
assert_eq "预约单的取消申请不被自动驳回" "$(sql "SELECT cancel_requested_at IS NOT NULL FROM orders WHERE id=$S69_O7;")" "1"
req POST "/api/admin/local/orders/$S69_O7/cancel-request/reject" "$AT" >/dev/null

echo "-- 收尾：恢复设置、清作业、取消未完成单 --"
req PUT /api/admin/settings/local-delivery "$AT" "$S69_ORIG" >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
S69_IDS=${S69_IDS#,}
sql "DELETE FROM print_jobs WHERE order_id IN ($S69_IDS);"
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 收尾' WHERE id IN ($S69_IDS) AND status IN ('PAID','PREPARING');"
sql "UPDATE deliveries SET status='CANCELLED', active_order_id=NULL, cancelled_at=NOW(3) WHERE order_id IN ($S69_IDS) AND active_order_id IS NOT NULL;"
