echo "== 79. 到店自取「尽快取」：可用性 / 下单 / 付款重算（mock + 真实回调）/ 取消 / 催单 / 工作台 / 小票 =="
# plans/2026-09-28-pickup-asap.md 测试用例 B1–B20。复用 e2e.sh 的 req/code/ok/fail/assert_eq/sched/sql/PJOBS/lquote；
# $UT/$AT/$LCAT/$LADDR/$ADDR。变量一律 P79_ 前缀，函数 p79_ 前缀；收尾把同城设置、打印机设置恢复成进来时的样子。
# 时刻看真实时钟：营业时段钉成 00:00–23:59、备餐 10 + 缓冲 5（P+B=15）、高峰清空。上海 23:20 以后「尽快取」会因
# 本段来不及（TOO_LATE）不可用，整段打印醒目的 SKIP 并跳过——这样的运行不算本分片通过。
# 时间差一律在 SQL 里用 TIMESTAMPDIFF 算，不在 shell 里换时区；库里 DATETIME 存的是 UTC。
P79_P=10; P79_B=5; P79_PB=$((P79_P + P79_B))
p79_nowmin() { echo $(( 10#$(TZ=Asia/Shanghai date +%H) * 60 + 10#$(TZ=Asia/Shanghai date +%M) )); }
p79_hm() { local m=$1; (( m < 0 )) && m=0; (( m > 1439 )) && m=1439; printf '%02d:%02d' $((m / 60)) $((m % 60)); }

if (( $(p79_nowmin) >= 23 * 60 + 20 )); then
  echo "  ⚠⚠⚠ SKIP 79：上海时间已过 23:20，「尽快取」必然 TOO_LATE，本分片整段跳过（这样的运行不算 79 通过，请换个时间重跑）"
else

P79_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
P79_ORIG_PRINTER=$(req GET /api/admin/settings/printer "$AT" | jq -c .data)
p79_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p79_ord() { req GET "/api/admin/orders/$1" "$AT"; }
p79_det() { req GET "/api/orders/$1" "$UT"; }
P79_BASE='.pickup.enabled=true | .pickup.paused=null | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1 | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"NONE",value:0} | .pickup.autoCompleteAfterMin=120 | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=10 | .peak.windows=[] | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .selfCancelLeadMin=120 | .packing.enabled=false'
# 此刻不在任何营业段的营业时间：凌晨 2 点以后用「00:00 到 一小时前」，更早用「一小时后到两小时后」
p79_closed_hours() {
  local n; n=$(p79_nowmin)
  if (( n >= 120 )); then echo "[{start:\"00:00\",end:\"$(p79_hm $((n - 60)))\"}]"; else echo "[{start:\"$(p79_hm $((n + 60)))\",end:\"$(p79_hm $((n + 120)))\"}]"; fi
}
p79_asap_req() { req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupMode\":\"ASAP\",\"pickupContact\":{\"phone\":\"${1:-13800007901}\"}}"; }
# p79_new_asap [phone] → P79_NEW（orderId）；失败当场记 fail（不放进 $( ) 里，fail 计数才回得到主 shell）
p79_new_asap() {
  local r; r=$(p79_asap_req "${1:-}"); P79_NEW=$(jq -r '.data.orderId // empty' <<<"$r")
  [[ -n "$P79_NEW" ]] || fail "p79_new_asap 下单失败" "$r"
  P79_IDS="$P79_IDS,${P79_NEW:-0}"
}
p79_new_sched() {  # 预约口径（不传 pickupMode）下一单，第 $1 格 → P79_NEW
  local slot r
  slot=$(req GET /api/local/pickup-slots | jq -r "[.data.days[].slots[]][$1].startAt")
  r=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$slot\",\"pickupContact\":{\"phone\":\"${2:-13800007902}\"}}")
  P79_NEW=$(jq -r '.data.orderId // empty' <<<"$r")
  [[ -n "$P79_NEW" ]] || fail "p79_new_sched 下单失败（slot=$slot）" "$r"
  P79_IDS="$P79_IDS,${P79_NEW:-0}"
}
p79_pay() { req POST "/api/orders/$1/pay" "$UT"; }
p79_col() { sql "SELECT $2 FROM orders WHERE id=$1;"; }
p79_raw_at() { sql "SELECT IFNULL(DATE_FORMAT(pickup_at,'%Y-%m-%d %H:%i:%s.%f'),'NULL') FROM orders WHERE id=$1;"; }
p79_iso_at() { sql "SELECT DATE_FORMAT(pickup_at,'%Y-%m-%dT%H:%i:%s.000Z') FROM orders WHERE id=$1;"; }
p79_hm_at() { sql "SELECT DATE_FORMAT(DATE_ADD(pickup_at, INTERVAL 8 HOUR),'%H:%i') FROM orders WHERE id=$1;"; }
p79_paid_diff() { sql "SELECT TIMESTAMPDIFF(SECOND, paid_at, pickup_at) FROM orders WHERE id=$1;"; }
p79_whole_min() { sql "SELECT SECOND(pickup_at)=0 AND MICROSECOND(pickup_at)=0 FROM orders WHERE id=$1;"; }
# p79_in desc value lo hi：lo ≤ value ≤ hi
p79_in() { local v; v=$(num "$2"); if (( v >= $3 && v <= $4 )); then ok "$1（$v ∈ [$3,$4]）"; else fail "$1" "期望 [$3,$4] 实际 [$2]"; fi; }
p79_new_ticket() { PJOBS "$1" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content // ""'; }
p79_new_ticket_count() { PJOBS "$1" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | length'; }
p79_iso2s() { jq -rn --arg t "$1" '$t | sub("\\.[0-9]+Z$";"Z") | fromdate'; }
P79_IDS="0"

# 自己的一件同城商品：库存给足，不跟别的分片抢 $LPID 的 50 件库存
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E尽快取凉菜\",\"price\":1200,\"stock\":999,\"netWeightG\":300}")
P79_PID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$P79_PID" ]] && ok "79 建同城商品 #$P79_PID" || fail "79 建同城商品" "$R"
# 出票断言要一台启用的 mock 打印机（同 62 ⑪ 的写法）
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"P79-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null

echo "-- B1 pickup-slots / meta 的 asap 结构；营业中可用，打烊 CLOSED、未开通 DISABLED、暂停 PAUSED、休业 HOLIDAY --"
R=$(p79_put "$P79_BASE"); assert_eq "B1 设置钉成 00:00–23:59、P=10 B=5 code 0" "$(code "$R")" "0"
R=$(req GET /api/local/pickup-slots)
assert_eq "B1 pickup-slots.asap 四个键齐全" "$(jq -r '.data.asap | keys | sort | join(",")' <<<"$R")" "available,minutes,readyAt,reason"
assert_eq "B1 营业中 available=true" "$(jq -r '.data.asap.available' <<<"$R")" "true"
assert_eq "B1 reason=null" "$(jq -r '.data.asap.reason' <<<"$R")" "null"
assert_eq "B1 minutes = P+B" "$(jq -r '.data.asap.minutes' <<<"$R")" "$P79_PB"
assert_eq "B1 原有字段 blocked/days 仍在" "$(jq -r '(.data.blocked == null) and (.data.days | type == "array")' <<<"$R")" "true"
P79_GAP=$(( $(p79_iso2s "$(jq -r '.data.asap.readyAt' <<<"$R")") - $(date +%s) - P79_PB * 60 ))
p79_in "B1 readyAt 与 now+minutes 相差不到 2 分钟" "${P79_GAP#-}" 0 119
R=$(req GET /api/local/meta)
assert_eq "B1 meta.pickup.asap 结构齐全且可用" "$(jq -r '.data.pickup.asap | [(keys|sort|join(",")), .available] | map(tostring) | join("|")' <<<"$R")" "available,minutes,readyAt,reason|true"
assert_eq "B1 meta.pickup 原有字段 earliestPickupWhen 仍在" "$(jq -r '.data.pickup | has("earliestPickupWhen") and has("earliestPickupText")' <<<"$R")" "true"
p79_put ".businessHours=$(p79_closed_hours)" >/dev/null
R=$(req GET /api/local/pickup-slots)
assert_eq "B1 营业时段不含此刻 → available=false、reason=CLOSED、readyAt/minutes=null" "$(jq -r '.data.asap | [.available, .reason, .readyAt, .minutes] | map(tostring) | join(",")' <<<"$R")" "false,CLOSED,null,null"
assert_eq "B1 meta 同样 CLOSED" "$(req GET /api/local/meta | jq -r '.data.pickup.asap.reason')" "CLOSED"
p79_put "$P79_BASE | .pickup.enabled=false" >/dev/null
assert_eq "B1 未开通 → DISABLED" "$(req GET /api/local/pickup-slots | jq -r '.data.asap.reason')" "DISABLED"
p79_put "$P79_BASE | .pickup.paused={until:null,reason:\"后厨忙\"}" >/dev/null
assert_eq "B1 自取暂停 → PAUSED" "$(req GET /api/local/pickup-slots | jq -r '.data.asap.reason')" "PAUSED"
P79_TODAY=$(TZ=Asia/Shanghai date +%F)
p79_put "$P79_BASE | .holiday={until:\"$P79_TODAY\",reason:\"盘点\"}" >/dev/null
assert_eq "B1 今天休业 → HOLIDAY" "$(req GET /api/local/pickup-slots | jq -r '.data.asap.reason')" "HOLIDAY"
p79_put "$P79_BASE" >/dev/null

echo "-- B2 下单 pickupMode:ASAP、不带 pickupAt：pickupAsap=true，付款前 pickupAt = 服务端算的 readyAt，落库 pickup_asap=1 --"
P79_PRE=$(p79_iso2s "$(req GET /api/local/pickup-slots | jq -r '.data.asap.readyAt')")
R=$(p79_asap_req)
assert_eq "B2 尽快取下单 code 0" "$(code "$R")" "0"
P79_O2=$(jq -r '.data.orderId // empty' <<<"$R"); P79_IDS="$P79_IDS,${P79_O2:-0}"
assert_eq "B2 返回 pickupAsap=true" "$(jq -r '.data.pickupAsap' <<<"$R")" "true"
P79_GAP=$(( $(p79_iso2s "$(jq -r '.data.pickupAt' <<<"$R")") - P79_PRE ))
p79_in "B2 付款前 pickupAt 与下单前查到的 readyAt 相差 ≤1 分钟" "${P79_GAP#-}" 0 60
assert_eq "B2 落库 pickup_asap=1" "$(p79_col "$P79_O2" pickup_asap)" "1"
assert_eq "B2 落库 pickup_at 与返回一致" "$(p79_iso_at "$P79_O2")" "$(jq -r '.data.pickupAt' <<<"$R")"
assert_eq "B2 详情 pickup.asap=true、待付款可取消" "$(p79_det "$P79_O2" | jq -r '[.data.pickup.asap, .data.canSelfCancel] | map(tostring) | join(",")')" "true,true"

echo "-- B3 ASAP 带 pickupAt 40001；不在营业段 42285 且库存与券都没动；未开通/暂停/休业仍是 42280 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupMode\":\"ASAP\",\"pickupAt\":\"2030-01-01T04:00:00.000Z\",\"pickupContact\":{\"phone\":\"13800007901\"}}")
assert_eq "B3 ASAP 同时带 pickupAt → 40001" "$(code "$R")" "40001"
P79_TID=$(req POST /api/admin/coupon-templates "$AT" '{"name":"E2E尽快取券","amount":100,"threshold":0,"channel":"LOCAL","validDays":30,"source":"CAMPAIGN"}' | jq -r '.data.id // empty')
P79_CID=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":${P79_TID:-0}}" | jq -r '.data.id // empty')
[[ -n "$P79_CID" ]] && ok "B3 领到一张同城券 #$P79_CID" || fail "B3 领券失败（tid=$P79_TID）"
p79_put ".businessHours=$(p79_closed_hours)" >/dev/null
P79_STOCK0=$(sql "SELECT stock FROM products WHERE id=$P79_PID;")
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupMode\":\"ASAP\",\"pickupContact\":{\"phone\":\"13800007901\"},\"couponId\":${P79_CID:-0}}")
assert_eq "B3 不在营业段 → 42285" "$(code "$R")" "42285"
[[ "$(jq -r .message <<<"$R")" == *"营业时间"* ]] && ok "B3 42285 文案按 reason（CLOSED）" || fail "B3 42285 文案不对" "$R"
assert_eq "B3 库存没扣" "$(sql "SELECT stock FROM products WHERE id=$P79_PID;")" "$P79_STOCK0"
assert_eq "B3 券没动（仍 UNUSED、未挂单）" "$(sql "SELECT CONCAT(status,'/',IFNULL(order_id,'-')) FROM user_coupons WHERE id=${P79_CID:-0};")" "UNUSED/-"
for P79_K in 'enabled=false' 'paused={until:null,reason:"忙"}' "holiday"; do
  case "$P79_K" in
    holiday) p79_put "$P79_BASE | .holiday={until:\"$P79_TODAY\",reason:\"盘点\"}" >/dev/null ;;
    *) p79_put "$P79_BASE | .pickup.$P79_K" >/dev/null ;;
  esac
  assert_eq "B3 $P79_K 时尽快取下单仍是 42280" "$(code "$(p79_asap_req)")" "42280"
done
p79_put "$P79_BASE" >/dev/null

echo "-- B4 老客户端兼容：不传 pickupMode 只传 pickupAt 走预约口径；非 PICKUP 带 pickupMode 40001 --"
p79_new_sched 3; P79_S4=$P79_NEW
assert_eq "B4 预约口径下单落库 pickup_asap=0" "$(p79_col "${P79_S4:-0}" pickup_asap)" "0"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:07:00.000Z\",\"pickupContact\":{\"phone\":\"13800007902\"}}")
assert_eq "B4 非整格 → 42281 码与文案不变" "$(jq -r '[.code, .message] | map(tostring) | join("|")' <<<"$R")" "42281|该时段已不可选，请重新选择取餐时间"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupContact\":{\"phone\":\"13800007902\"}}")
assert_eq "B4 不传 pickupMode 也不传 pickupAt → 40001 老文案逐字不变" "$(jq -r '[.code, .message] | map(tostring) | join("|")' <<<"$R")" "40001|参数错误：请选择取餐时间并填写取餐人手机号"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\",\"pickupMode\":\"ASAP\"}")
assert_eq "B4 EXPRESS 带 pickupMode → 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"pickupMode\":\"SCHEDULED\"}")
assert_eq "B4 LOCAL 带 pickupMode → 40001" "$(code "$R")" "40001"

echo "-- B5 付款后未接单：可秒退、没有申请取消；PUT /cancel → 退款 + CANCEL 票 --"
p79_new_asap; P79_O5=$P79_NEW
p79_pay "$P79_O5" >/dev/null
R=$(p79_det "$P79_O5")
assert_eq "B5 canSelfCancel=true、canRequestCancel=false、pickup.asap=true" "$(jq -r '[.data.canSelfCancel, .data.canRequestCancel, .data.pickup.asap] | map(tostring) | join(",")' <<<"$R")" "true,false,true"
R=$(req PUT "/api/orders/$P79_O5/cancel" "$UT")
assert_eq "B5 接单前自助取消 code 0" "$(code "$R")" "0"
[[ "$(p79_col "$P79_O5" status)" =~ ^(REFUNDING|REFUNDED)$ ]] && ok "B5 → REFUNDING/REFUNDED" || fail "B5 取消后状态不对" "$(p79_col "$P79_O5" status)"
sleep 0.5
[[ "$(PJOBS "$P79_O5" | jq -r '[.data.list[] | select(.kind=="CANCEL")] | length')" -ge 1 ]] && ok "B5 出了 CANCEL 票" || fail "B5 没出 CANCEL 票" "$(PJOBS "$P79_O5")"
R=$(req POST "/api/orders/$P79_O5/cancel-request" "$UT" '{}')
assert_eq "B5 尽快单没有申请取消（42229）" "$(code "$R")" "42229"

echo "-- B6 付款后已接单：不能取消、也不能申请取消；约定时刻挪到哪里结论都不变 --"
p79_new_asap; P79_O6=$P79_NEW
p79_pay "$P79_O6" >/dev/null
assert_eq "B6 通用 accept code 0" "$(code "$(req POST "/api/admin/orders/$P79_O6/accept" "$AT")")" "0"
for P79_SHIFT in "" "DATE_SUB(NOW(3), INTERVAL 30 MINUTE)" "DATE_ADD(NOW(3), INTERVAL 3 HOUR)"; do
  [[ -n "$P79_SHIFT" ]] && sql "UPDATE orders SET pickup_at=$P79_SHIFT WHERE id=$P79_O6;"
  P79_TAG=${P79_SHIFT:-原值}
  assert_eq "B6[$P79_TAG] canSelfCancel=false、canRequestCancel=false" "$(p79_det "$P79_O6" | jq -r '[.data.canSelfCancel, .data.canRequestCancel] | map(tostring) | join(",")')" "false,false"
  R=$(req PUT "/api/orders/$P79_O6/cancel" "$UT")
  assert_eq "B6[$P79_TAG] PUT /cancel → 42204" "$(code "$R")" "42204"
  assert_eq "B6[$P79_TAG] 订单仍 PREPARING" "$(p79_col "$P79_O6" status)" "PREPARING"
  R=$(req POST "/api/orders/$P79_O6/cancel-request" "$UT" '{"note":"不要了"}')
  assert_eq "B6[$P79_TAG] cancel-request → 42229" "$(code "$R")" "42229"
  assert_eq "B6[$P79_TAG] cancel_requested_at 仍为 NULL" "$(p79_col "$P79_O6" "cancel_requested_at IS NULL")" "1"
done
[[ "$(jq -r .message <<<"$(req PUT "/api/orders/$P79_O6/cancel" "$UT")")" == *"已接单"* ]] && ok "B6 42204 文案说明已接单" || fail "B6 42204 文案不对"

echo "-- B8 店家后台主动退款不受影响：已接单的尽快单 POST /admin/orders/:id/refund code 0 --"
P79_AMT6=$(p79_col "$P79_O6" actual_amount)
R=$(req POST "/api/admin/orders/$P79_O6/refund" "$AT" "{\"amount\":$P79_AMT6,\"reason\":\"e2e 尽快单缺货\"}")
assert_eq "B8 后台退款 code 0" "$(code "$R")" "0"

echo "-- B7 并发：同一张 PAID 尽快单同时 PUT /cancel 与 accept，恰好一个成功且结果自洽 --"
p79_new_asap; P79_O7=$P79_NEW
p79_pay "$P79_O7" >/dev/null
P79_T1=$(mktemp); P79_T2=$(mktemp)
req PUT "/api/orders/$P79_O7/cancel" "$UT" > "$P79_T1" &
req POST "/api/admin/orders/$P79_O7/accept" "$AT" > "$P79_T2" &
wait
sleep 0.4
P79_C1=$(jq -r .code < "$P79_T1"); P79_C2=$(jq -r .code < "$P79_T2"); rm -f "$P79_T1" "$P79_T2"
assert_eq "B7 恰好一个成功（cancel=$P79_C1 accept=$P79_C2）" "$([[ "$P79_C1" == 0 ]] && echo 1 || echo 0)$([[ "$P79_C2" == 0 ]] && echo 1 || echo 0)" "$([[ "$P79_C1" == 0 ]] && echo 10 || echo 01)"
P79_ST7=$(p79_col "$P79_O7" status)
if [[ "$P79_C1" == 0 ]]; then
  [[ "$P79_ST7" =~ ^(REFUNDING|REFUNDED)$ ]] && ok "B7 取消赢：$P79_ST7" || fail "B7 取消赢但状态 $P79_ST7"
  assert_eq "B7 取消赢：accepted_at 为 NULL" "$(p79_col "$P79_O7" "accepted_at IS NULL")" "1"
else
  assert_eq "B7 接单赢：PREPARING" "$P79_ST7" "PREPARING"
  assert_eq "B7 接单赢：没有退款行" "$(sql "SELECT COUNT(*) FROM refunds WHERE order_id=$P79_O7;")" "0"
fi

echo "-- B9 催单：尽快单付款 + 15 分钟就催（与同城立即单同一口径，不看开始备餐时刻）--"
p79_new_asap; P79_O9=$P79_NEW
p79_pay "$P79_O9" >/dev/null
# 取餐时刻挪到 3 小时后：若按预约口径（开始备餐 − 15 分钟）就不会催，能区分两种实现
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE), pickup_at=DATE_ADD(NOW(3), INTERVAL 3 HOUR) WHERE id=$P79_O9;"
sched '{}' >/dev/null
assert_eq "B9 付款 10 分钟未催" "$(p79_col "$P79_O9" "accept_reminded_at IS NULL")" "1"
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 16 MINUTE) WHERE id=$P79_O9;"
sched '{}' >/dev/null
assert_eq "B9 付款 16 分钟已催（取餐还在 3 小时后也照催）" "$(p79_col "$P79_O9" "accept_reminded_at IS NOT NULL")" "1"

echo "-- B10 过时未取提醒与自动完成沿用现有规则 --"
p79_new_asap; P79_O10=$P79_NEW
p79_pay "$P79_O10" >/dev/null
req POST "/api/admin/orders/$P79_O10/accept" "$AT" >/dev/null
req POST "/api/admin/orders/$P79_O10/pickup-ready" "$AT" >/dev/null
assert_eq "B10 待取餐 SHIPPED" "$(p79_col "$P79_O10" status)" "SHIPPED"
sql "UPDATE orders SET pickup_at=DATE_SUB(NOW(3), INTERVAL 40 MINUTE) WHERE id=$P79_O10;"
sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":120}' >/dev/null
assert_eq "B10 过时未取已打标" "$(p79_col "$P79_O10" "pickup_reminded_at IS NOT NULL")" "1"
assert_eq "B10 120 分钟未到仍 SHIPPED" "$(p79_col "$P79_O10" status)" "SHIPPED"
sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":30}' >/dev/null
assert_eq "B10 超过自动完成时长 → COMPLETED" "$(p79_col "$P79_O10" status)" "COMPLETED"

echo "-- B11 工作台：尽快单卡片 pickup.asap=true；pending 列尽快单排在更早付款的预约自取单前 --"
p79_new_sched 3 13800007911; P79_S11=$P79_NEW
p79_pay "${P79_S11:-0}" >/dev/null
sleep 1
p79_new_asap 13800007912; P79_O11=$P79_NEW
p79_pay "$P79_O11" >/dev/null
R=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT")
assert_eq "B11 尽快单卡片 pickup.asap=true" "$(jq -r ".data.columns.pending[] | select(.orderId==$P79_O11) | .pickup.asap" <<<"$R")" "true"
assert_eq "B11 预约自取卡片 pickup.asap=false" "$(jq -r ".data.columns.pending[] | select(.orderId==${P79_S11:-0}) | .pickup.asap" <<<"$R")" "false"
assert_eq "B11 尽快单 slotLabel「尽快取 约 HH:mm」" "$(jq -r ".data.columns.pending[] | select(.orderId==$P79_O11) | .pickup.slotLabel" <<<"$R")" "尽快取 约 $(p79_hm_at "$P79_O11")"
P79_IA=$(jq -r --argjson id "$P79_O11" '.data.columns.pending | map(.orderId) | index($id) // -1' <<<"$R")
P79_IS=$(jq -r --argjson id "${P79_S11:-0}" '.data.columns.pending | map(.orderId) | index($id) // -1' <<<"$R")
[[ "$P79_IA" -ge 0 && "$P79_IS" -ge 0 && "$P79_IA" -lt "$P79_IS" ]] && ok "B11 尽快单（#$P79_IA）排在预约自取单（#$P79_IS）前" || fail "B11 排序不对" "asap=$P79_IA sched=$P79_IS"

echo "-- B12 NEW_ORDER 票：「尽快取 约 HH:mm」= 付款后库里的 pickup_at，不盖明日单戳 --"
sleep 0.5
P79_T=$(p79_new_ticket "$P79_O11")
[[ "$P79_T" == *"<B>尽快取 约 $(p79_hm_at "$P79_O11")</B>"* ]] && ok "B12 票面放大行「尽快取 约 $(p79_hm_at "$P79_O11")」" || fail "B12 票面没有尽快取行" "$P79_T"
[[ "$P79_T" != *"【明日单】"* && "$P79_T" != *"取餐 "*"月"* ]] && ok "B12 不盖明日单戳、不出日期行" || fail "B12 票面带了戳或日期行" "$P79_T"

echo "-- B13 预约自取回归：pickup.asap=false，取消两条结论与 62 同一情形一致 --"
p79_new_sched 3 13800007913; P79_S13=$P79_NEW
p79_pay "${P79_S13:-0}" >/dev/null
assert_eq "B13 预约单 pickup.asap=false" "$(p79_det "${P79_S13:-0}" | jq -r '.data.pickup.asap')" "false"
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 90 MINUTE) WHERE id=${P79_S13:-0};"
assert_eq "B13 距取餐不足两小时：false,true（同 62 ⑥⑦）" "$(p79_det "${P79_S13:-0}" | jq -r '[.data.canSelfCancel, .data.canRequestCancel] | map(tostring) | join(",")')" "false,true"
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 3 HOUR) WHERE id=${P79_S13:-0};"
assert_eq "B13 距取餐三小时：true,false" "$(p79_det "${P79_S13:-0}" | jq -r '[.data.canSelfCancel, .data.canRequestCancel] | map(tostring) | join(",")')" "true,false"
assert_eq "B13 三小时外自助取消 code 0（timed 分支照旧）" "$(code "$(req PUT "/api/orders/${P79_S13:-0}/cancel" "$UT")")" "0"

echo "-- B14 mock 付款推后：拖到很晚才付款，pickup_at = 付款 + P+B（整分），详情/工作台/票面三处一致 --"
p79_new_asap; P79_O14=$P79_NEW
sql "UPDATE orders SET pickup_at=DATE_SUB(pickup_at, INTERVAL 10 MINUTE) WHERE id=$P79_O14;"
R=$(p79_pay "$P79_O14"); assert_eq "B14 mock 付款 code 0" "$(code "$R")" "0"
assert_eq "B14 mock /pay 响应体键不变（mode/paidAt/status）" "$(jq -r '.data | keys | sort | join(",")' <<<"$R")" "mode,paidAt,status"
p79_in "B14 TIMESTAMPDIFF(paid_at, pickup_at)" "$(p79_paid_diff "$P79_O14")" $((P79_PB * 60)) $((P79_PB * 60 + 59))
assert_eq "B14 pickup_at 是整分" "$(p79_whole_min "$P79_O14")" "1"
P79_ISO=$(p79_iso_at "$P79_O14")
assert_eq "B14 详情 pickup.pickupAt = 新值" "$(p79_det "$P79_O14" | jq -r '.data.pickup.pickupAt')" "$P79_ISO"
assert_eq "B14 工作台卡片 pickup.pickupAt = 新值" "$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT" | jq -r ".data.columns.pending[] | select(.orderId==$P79_O14) | .pickup.pickupAt")" "$P79_ISO"
sleep 0.5
[[ "$(p79_new_ticket "$P79_O14")" == *"<B>尽快取 约 $(p79_hm_at "$P79_O14")</B>"* ]] && ok "B14 NEW_ORDER 票面 HH:mm = 新值" || fail "B14 票面时刻不对" "$(p79_new_ticket "$P79_O14")"

echo "-- B15 mock 付款不回退：付款前 pickup_at 在 3 小时后 → 付款后逐字不变 --"
p79_new_asap; P79_O15=$P79_NEW
sql "UPDATE orders SET pickup_at=DATE_ADD(DATE_FORMAT(NOW(),'%Y-%m-%d %H:%i:00'), INTERVAL 180 MINUTE) WHERE id=$P79_O15;"
P79_RAW=$(p79_raw_at "$P79_O15")
p79_pay "$P79_O15" >/dev/null
assert_eq "B15 付款后 PAID" "$(p79_col "$P79_O15" status)" "PAID"
assert_eq "B15 pickup_at 逐字不变" "$(p79_raw_at "$P79_O15")" "$P79_RAW"

echo "-- B17 mock 幂等：已付款的尽快单再 /pay → 42203，pickup_at/paid_at 不变 --"
P79_RAW=$(p79_raw_at "$P79_O14"); P79_PAID=$(p79_col "$P79_O14" "DATE_FORMAT(paid_at,'%Y-%m-%d %H:%i:%s.%f')")
assert_eq "B17 再付 42203" "$(code "$(p79_pay "$P79_O14")")" "42203"
assert_eq "B17 pickup_at 不变" "$(p79_raw_at "$P79_O14")" "$P79_RAW"
assert_eq "B17 paid_at 不变" "$(p79_col "$P79_O14" "DATE_FORMAT(paid_at,'%Y-%m-%d %H:%i:%s.%f')")" "$P79_PAID"

echo "-- B16 mock 付款的高峰判定：高峰覆盖「现在 + P + B」、上限 40 → pickup_at = 付款 + 40 + B --"
p79_new_asap; P79_O16=$P79_NEW
P79_N=$(p79_nowmin)
p79_put ".peak.windows=[{start:\"$(p79_hm $((P79_N + P79_PB - 5)))\",end:\"$(p79_hm $((P79_N + P79_PB + 25)))\"}] | .peak.prepMinMinutes=35 | .peak.prepMaxMinutes=40" >/dev/null
p79_pay "$P79_O16" >/dev/null
p79_in "B16 TIMESTAMPDIFF(paid_at, pickup_at) 按高峰上限" "$(p79_paid_diff "$P79_O16")" $(((40 + P79_B) * 60)) $(((40 + P79_B) * 60 + 59))
p79_put "$P79_BASE" >/dev/null

echo "-- B18 零影响：预约自取、同城立即单、同城预约单 mock 付款都不动 pickup_at / scheduled_at --"
p79_new_sched 3 13800007918; P79_S18=$P79_NEW
P79_RAW=$(p79_raw_at "${P79_S18:-0}")
p79_pay "${P79_S18:-0}" >/dev/null
assert_eq "B18 预约自取付款后 pickup_at 逐字不变" "$(p79_raw_at "${P79_S18:-0}")" "$P79_RAW"
assert_eq "B18 预约自取 pickup_asap=0、PAID" "$(p79_col "${P79_S18:-0}" "CONCAT(pickup_asap,'/',status)")" "0/PAID"
P79_LOCAL_IDS="0"
lquote "$LADDR" 2400
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
P79_L1=$(jq -r '.data.orderId // empty' <<<"$R"); [[ -n "$P79_L1" ]] && ok "B18 同城立即单 #$P79_L1" || fail "B18 同城立即单下单失败" "$R"
P79_LOCAL_IDS="$P79_LOCAL_IDS,${P79_L1:-0}"
p79_pay "${P79_L1:-0}" >/dev/null
assert_eq "B18 同城立即单付款后 pickup_at/scheduled_at 仍为 NULL、PAID" "$(p79_col "${P79_L1:-0}" "CONCAT(pickup_at IS NULL,'/',scheduled_at IS NULL,'/',status)")" "1/1/PAID"
p79_put '.schedule.enabled=true | .schedule.slotMinutes=30 | .schedule.daysAhead=1' >/dev/null
lquote "$LADDR" 2400
P79_LSLOT=$(req GET "/api/local/delivery-slots?distanceM=$LQDIST" | jq -r '[.data.days[].slots[]][2].startAt')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P79_PID,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"$P79_LSLOT\"}")
P79_L2=$(jq -r '.data.orderId // empty' <<<"$R"); [[ -n "$P79_L2" ]] && ok "B18 同城预约单 #$P79_L2" || fail "B18 同城预约单下单失败（slot=$P79_LSLOT）" "$R"
P79_LOCAL_IDS="$P79_LOCAL_IDS,${P79_L2:-0}"
P79_SCHED_RAW=$(p79_col "${P79_L2:-0}" "DATE_FORMAT(scheduled_at,'%Y-%m-%d %H:%i:%s.%f')")
p79_pay "${P79_L2:-0}" >/dev/null
assert_eq "B18 同城预约单付款后 scheduled_at 逐字不变" "$(p79_col "${P79_L2:-0}" "DATE_FORMAT(scheduled_at,'%Y-%m-%d %H:%i:%s.%f')")" "$P79_SCHED_RAW"
assert_eq "B18 同城预约单 pickup_at 仍为 NULL、PAID" "$(p79_col "${P79_L2:-0}" "CONCAT(pickup_at IS NULL,'/',status)")" "1/PAID"
# 这两张同城单只用来验零影响：立刻收掉，免得后面的定时任务去给它们呼叫骑手
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 79 收尾' WHERE id IN ($P79_LOCAL_IDS) AND status='PAID';"
p79_put "$P79_BASE | .schedule.enabled=$(jq -c '.schedule.enabled' <<<"$P79_ORIG")" >/dev/null

echo "-- B19 真实支付回调（POST /api/wechat/pay/notify，AES-256-GCM 加密 resource）--"
if [[ -z "${WECHAT_PAY_API_V3_KEY:-}" ]]; then
  echo "  ⚠⚠⚠ SKIP 79-B19：本 shell 没有 WECHAT_PAY_API_V3_KEY，真实回调段整段跳过（这样的运行不算 79 通过；起服务与跑 e2e 的 shell 都要 export 同一个 32 字节 key）"
else
  # p79_st offsetSec → "ISO(+08:00) UTC(YYYY-MM-DD HH:MM:SS)"，整秒
  p79_st() { node -e 'const d=new Date(Date.now()+Number(process.argv[1])*1000);d.setMilliseconds(0);const sh=new Date(d.getTime()+8*3600e3);console.log(sh.toISOString().slice(0,19)+"+08:00 "+d.toISOString().slice(0,19).replace("T","_"))' -- "$1"; }
  # p79_notify_body orderId amountFen successTimeIso → 回调原文（JSON 字符串）
  p79_notify_body() {
    node -e '
const c=require("crypto");const [key,oid,amt,st]=process.argv.slice(1);
const nonce="e2e79nonce12", ad="transaction", ts=Date.now();
const plain=JSON.stringify({out_trade_no:"order_"+oid+"_"+ts,transaction_id:"4200079"+oid+ts,trade_state:"SUCCESS",success_time:st,amount:{total:Number(amt)}});
const ci=c.createCipheriv("aes-256-gcm",Buffer.from(key,"utf8"),nonce);ci.setAAD(Buffer.from(ad,"utf8"));
const enc=Buffer.concat([ci.update(plain,"utf8"),ci.final(),ci.getAuthTag()]).toString("base64");
process.stdout.write(JSON.stringify({id:"EV79-"+oid+"-"+ts,event_type:"TRANSACTION.SUCCESS",resource_type:"encrypt-resource",resource:{algorithm:"AEAD_AES_256_GCM",ciphertext:enc,nonce:nonce,associated_data:ad}}));
' -- "$WECHAT_PAY_API_V3_KEY" "$1" "$2" "$3"
  }
  # p79_notify body → "HTTP码|应答 code"
  p79_notify() { local r; r=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/wechat/pay/notify" -H 'Content-Type: application/json' --data-binary "$1"); echo "$(tail -1 <<<"$r")|$(head -1 <<<"$r" | jq -r '.code')"; }
  p79_pay_utc() { sql "SELECT DATE_FORMAT($2,'%Y-%m-%d_%H:%i:%s') FROM $1;"; }

  # (a1) 回调晚到：success_time = 现在 − 5 分钟，锚点应取服务器处理时刻
  p79_new_asap; P79_O19A=$P79_NEW
  sql "UPDATE orders SET pickup_at=DATE_SUB(pickup_at, INTERVAL 20 MINUTE) WHERE id=$P79_O19A;"
  read -r P79_STI P79_STU <<<"$(p79_st -300)"
  P79_BODY_A=$(p79_notify_body "$P79_O19A" "$(p79_col "$P79_O19A" actual_amount)" "$P79_STI")
  assert_eq "B19a1 回调应答 200 SUCCESS" "$(p79_notify "$P79_BODY_A")" "200|SUCCESS"
  assert_eq "B19a1 订单 PAID" "$(p79_col "$P79_O19A" status)" "PAID"
  assert_eq "B19a1 orders.paid_at = success_time（paidAt 语义没变）" "$(p79_pay_utc "orders WHERE id=$P79_O19A" paid_at)" "$P79_STU"
  assert_eq "B19a1 payments.paid_at = success_time" "$(p79_pay_utc "payments WHERE order_id=$P79_O19A" paid_at)" "$P79_STU"
  p79_in "B19a1 TIMESTAMPDIFF(payments.updated_at, pickup_at) ≈ P+B（锚点=处理时刻）" "$(sql "SELECT TIMESTAMPDIFF(SECOND, p.updated_at, o.pickup_at) FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=$P79_O19A;")" $((P79_PB * 60 - 1)) $((P79_PB * 60 + 61))
  p79_in "B19a1 TIMESTAMPDIFF(paid_at, pickup_at) ≥ P+B+4 分钟（排除「锚点用 success_time」）" "$(p79_paid_diff "$P79_O19A")" $((P79_PB * 60 + 240)) 99999
  assert_eq "B19a1 pickup_at 是整分" "$(p79_whole_min "$P79_O19A")" "1"
  sleep 0.5
  [[ "$(p79_new_ticket "$P79_O19A")" == *"<B>尽快取 约 $(p79_hm_at "$P79_O19A")</B>"* ]] && ok "B19a1 NEW_ORDER 票面 HH:mm = 新 pickup_at" || fail "B19a1 票面时刻不对" "$(p79_new_ticket "$P79_O19A")"

  # (b) 原样重推 (a1)：应答 SUCCESS、什么都不变、不多出票
  P79_RAW=$(p79_raw_at "$P79_O19A"); P79_PAID=$(p79_pay_utc "orders WHERE id=$P79_O19A" paid_at); P79_NT=$(p79_new_ticket_count "$P79_O19A")
  assert_eq "B19b 重推应答 200 SUCCESS" "$(p79_notify "$P79_BODY_A")" "200|SUCCESS"
  sleep 0.5
  assert_eq "B19b 重推后 pickup_at 逐字不变" "$(p79_raw_at "$P79_O19A")" "$P79_RAW"
  assert_eq "B19b 重推后 paid_at 不变" "$(p79_pay_utc "orders WHERE id=$P79_O19A" paid_at)" "$P79_PAID"
  assert_eq "B19b NEW_ORDER 票没有多出一张" "$(p79_new_ticket_count "$P79_O19A")" "$P79_NT"

  # (a2) success_time 晚于处理时刻（服务器慢于微信）：锚点取 success_time
  p79_new_asap; P79_O19B=$P79_NEW
  sql "UPDATE orders SET pickup_at=DATE_SUB(pickup_at, INTERVAL 20 MINUTE) WHERE id=$P79_O19B;"
  read -r P79_STI P79_STU <<<"$(p79_st 180)"
  assert_eq "B19a2 回调应答 200 SUCCESS" "$(p79_notify "$(p79_notify_body "$P79_O19B" "$(p79_col "$P79_O19B" actual_amount)" "$P79_STI")")" "200|SUCCESS"
  assert_eq "B19a2 orders.paid_at = success_time（未来 3 分钟）" "$(p79_pay_utc "orders WHERE id=$P79_O19B" paid_at)" "$P79_STU"
  p79_in "B19a2 TIMESTAMPDIFF(paid_at, pickup_at) = P+B（锚点=success_time）" "$(p79_paid_diff "$P79_O19B")" $((P79_PB * 60)) $((P79_PB * 60 + 59))
  p79_in "B19a2 TIMESTAMPDIFF(payments.updated_at, pickup_at) ≥ P+B+2 分钟（排除「锚点只用处理时刻」）" "$(sql "SELECT TIMESTAMPDIFF(SECOND, p.updated_at, o.pickup_at) FROM orders o JOIN payments p ON p.order_id=o.id WHERE o.id=$P79_O19B;")" $((P79_PB * 60 + 120)) 99999

  # (c) 不回退：付款前 pickup_at 已在 3 小时后
  p79_new_asap; P79_O19C=$P79_NEW
  sql "UPDATE orders SET pickup_at=DATE_ADD(DATE_FORMAT(NOW(),'%Y-%m-%d %H:%i:00'), INTERVAL 180 MINUTE) WHERE id=$P79_O19C;"
  P79_RAW=$(p79_raw_at "$P79_O19C")
  read -r P79_STI P79_STU <<<"$(p79_st 0)"
  assert_eq "B19c 回调应答 200 SUCCESS" "$(p79_notify "$(p79_notify_body "$P79_O19C" "$(p79_col "$P79_O19C" actual_amount)" "$P79_STI")")" "200|SUCCESS"
  assert_eq "B19c PAID 且 pickup_at 逐字不变" "$(p79_col "$P79_O19C" status)|$(p79_raw_at "$P79_O19C")" "PAID|$P79_RAW"

  # (d) 取消后才到的付款：走自动退款，不重算
  p79_new_asap; P79_O19D=$P79_NEW
  assert_eq "B19d 待付款取消 code 0" "$(code "$(req PUT "/api/orders/$P79_O19D/cancel" "$UT")")" "0"
  P79_RAW=$(p79_raw_at "$P79_O19D")
  read -r P79_STI P79_STU <<<"$(p79_st 0)"
  assert_eq "B19d 回调应答 200 SUCCESS" "$(p79_notify "$(p79_notify_body "$P79_O19D" "$(p79_col "$P79_O19D" actual_amount)" "$P79_STI")")" "200|SUCCESS"
  sleep 0.5
  [[ "$(p79_col "$P79_O19D" status)" =~ ^(REFUNDING|REFUNDED)$ ]] && ok "B19d 取消后付款 → 自动退款（$(p79_col "$P79_O19D" status)）" || fail "B19d 状态不对" "$(p79_col "$P79_O19D" status)"
  assert_eq "B19d pickup_at 与取消前逐字相等（不重算）" "$(p79_raw_at "$P79_O19D")" "$P79_RAW"

  # (e) 预约自取单走真实回调：pickup_at 逐字不变
  p79_new_sched 3 13800007919; P79_S19=$P79_NEW
  P79_RAW=$(p79_raw_at "${P79_S19:-0}")
  read -r P79_STI P79_STU <<<"$(p79_st 0)"
  assert_eq "B19e 回调应答 200 SUCCESS" "$(p79_notify "$(p79_notify_body "${P79_S19:-0}" "$(p79_col "${P79_S19:-0}" actual_amount)" "$P79_STI")")" "200|SUCCESS"
  assert_eq "B19e 预约自取 PAID、pickup_asap=0、pickup_at 逐字不变" "$(p79_col "${P79_S19:-0}" "CONCAT(status,'/',pickup_asap)")|$(p79_raw_at "${P79_S19:-0}")" "PAID/0|$P79_RAW"
fi

echo "-- B20 付款时已不满足尽快条件（Q3=A 照收照做）：暂停 / 今天休业 / 营业时段不含此刻，mock 付款照常成功并重算 --"
for P79_K in paused holiday closed; do
  p79_put "$P79_BASE" >/dev/null
  p79_new_asap; P79_O20=$P79_NEW
  sql "UPDATE orders SET pickup_at=DATE_SUB(pickup_at, INTERVAL 10 MINUTE) WHERE id=$P79_O20;"
  case "$P79_K" in
    paused) p79_put "$P79_BASE | .pickup.paused={until:null,reason:\"忙\"}" >/dev/null ;;
    holiday) p79_put "$P79_BASE | .holiday={until:\"$P79_TODAY\",reason:\"盘点\"}" >/dev/null ;;
    closed) p79_put "$P79_BASE | .businessHours=$(p79_closed_hours)" >/dev/null ;;
  esac
  R=$(p79_pay "$P79_O20")
  assert_eq "B20[$P79_K] mock 付款 code 0" "$(code "$R")" "0"
  assert_eq "B20[$P79_K] PAID" "$(p79_col "$P79_O20" status)" "PAID"
  p79_in "B20[$P79_K] pickup_at 按 B14 公式重算" "$(p79_paid_diff "$P79_O20")" $((P79_PB * 60)) $((P79_PB * 60 + 59))
  sleep 0.5
  [[ "$(p79_new_ticket_count "$P79_O20")" -ge 1 ]] && ok "B20[$P79_K] 出了 NEW_ORDER 票" || fail "B20[$P79_K] 没出票"
done
p79_put "$P79_BASE" >/dev/null

echo "-- 收尾：恢复同城与打印机设置、收掉本段仍在履约中的单、停用券模板、删本段商品 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P79_ORIG" >/dev/null
req PUT /api/admin/settings/printer "$AT" "$P79_ORIG_PRINTER" >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
P79_ALL="$P79_IDS,${P79_O2:-0},${P79_O19A:-0},${P79_O19B:-0},${P79_O19C:-0},${P79_O19D:-0},${P79_S19:-0}"
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 79 收尾' WHERE id IN ($P79_ALL) AND status IN ('PENDING_PAYMENT','PAID','PREPARING','SHIPPED');"
sql "DELETE FROM print_jobs WHERE order_id IN ($P79_ALL,$P79_LOCAL_IDS);"
[[ -n "${P79_TID:-}" ]] && req PUT "/api/admin/coupon-templates/$P79_TID" "$AT" '{"status":"OFF"}' >/dev/null 2>&1
[[ -n "${P79_PID:-}" ]] && req DELETE "/api/admin/products/$P79_PID" "$AT" >/dev/null
assert_eq "收尾：同城设置已恢复" "$(req GET /api/admin/settings/local-delivery "$AT" | jq -c '.data | del(.version)')" "$(jq -c 'del(.version)' <<<"$P79_ORIG")"

fi
