echo "== 72. 预约送达修复批次二：S1 取消=撤回已备好 / S2 报价保鲜排除预约单 / S4+S5 该呼叫却没呼出去可见化+告警 / S6 不重复出票 / S7 票面拆行 / S8 尽快筛选排除自取单 =="
# 复用 §69 的 s69_put/s69_ord/s69_det/s69_sc/s69_pin/s69_new 与 e2e.sh 的
# req/code/ok/fail/assert_eq/sched/sql/PJOBS/snap/mk_local_paid/kd_cb/dstat；$UT/$AT/$LPID/$LADDR。
# 变量一律 S72_ 前缀（本文件自己的局部变量除外，如 O1..O9/A1，与 §69 的 S69_O1 等区分开）。
S72_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
S72_PRINTER_BEFORE=$(req GET /api/admin/settings/printer "$AT" | jq -c .data)
# §69 收尾已把设置还原成它开始前的样子，这里按 §69 ② 同法重新开通预约，并显式钉死
# callStrategy（SOLO_LOWEST + escalateAfterMin=0）：本文件大多数步骤都不需要自动升级，
# 留着非零值会让别的 sched '{}' 调用意外触发 escalateSoloCalls 干扰计数。
s69_put '.schedule.enabled=true | .enabled=true | .paused=null | .holiday=null | .businessHours=[{start:"00:00",end:"23:59"}] | .peak.windows=[] | .schedule={enabled:true,slotMinutes:30,daysAhead:1,acceptBufferMin:5,prepMinutes:20,prepTicketLeadMin:15,readyRemindEveryMin:3,readyRemindMaxTimes:3,callToleranceMin:5} | .selfCancelLeadMin=120 | .prepMinutes=20 | .autoCallDelayMin=0 | .callStrategy={mode:"SOLO_LOWEST",cheapestN:3,escalateAfterMin:0}' >/dev/null
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
req POST /api/admin/system/kd100-circuit/reset "$AT" >/dev/null
S72_IDS=""
# 宽度校验（S7）：按 charWidth 规则（码点 > 0xff 记 2，否则 1）算每个 <B>…</B> 段的显示宽度，
# 取全票最大值。与 content.ts 的 strWidth 独立实现——用不同语言各写一遍，才有互相印证的意义。
s72_bigwidth() {
  jq -Rr '[match("<B>([^<]*)</B>";"g").captures[0].string | explode | map(if . > 255 then 2 else 1 end) | add] | if length==0 then 0 else max end' <<<"$1"
}

echo "-- ① S1：店员取消不再自动重呼；已备好/立即呼叫/自己送三键仍可用 --"
O1=$(s69_new 3); S72_IDS="$S72_IDS,$O1"
req POST "/api/admin/local/orders/$O1/accept" "$AT" >/dev/null
s69_pin "$O1" callAt -1
R=$(req POST "/api/admin/local/orders/$O1/ready" "$AT")
assert_eq "①O1 到点立即呼 code 0" "$(code "$R")" "0"
assert_eq "①O1 called=true" "$(jq -r .data.called <<<"$R")" "true"
assert_eq "①O1 call_origin=SCHEDULED_AUTO" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$O1 ORDER BY id DESC LIMIT 1;")" "SCHEDULED_AUTO"
assert_eq "①O1 ready_at 非空" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$O1;")" "1"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$O1/delivery/cancel" "$AT")
assert_eq "①O1 取消配送 code 0" "$(code "$R")" "0"
assert_eq "①O1 取消后 CANCELLED" "$(dstat "$O1")" "CANCELLED"
assert_eq "①O1 ready_at 已清空（撤回已备好）" "$(sql "SELECT ready_at IS NULL FROM orders WHERE id=$O1;")" "1"
assert_eq "①O1 phase=CALL_DUE" "$(s69_sc "$O1" | jq -r .phase)" "CALL_DUE"
R=$(req GET "/api/admin/local/orders/$O1/delivery" "$AT")
[[ "$(jq -r '.data.events[-1].statusDesc' <<<"$R")" == *"已撤回"* ]] && ok "①O1 配送单事件最后一条含「已撤回」" || fail "①O1 事件文案不含已撤回" "$R"
sched '{}' >/dev/null; sched '{}' >/dev/null
assert_eq "①O1 两轮心跳后仍只 1 张配送单（不再自动重呼）" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O1;")" "1"
R=$(req POST "/api/admin/local/orders/$O1/call" "$AT" '{"force":true}')
assert_eq "①O1 店员「立即呼叫」code 0" "$(code "$R")" "0"
assert_eq "①O1 deliveryNo=D${O1}-2" "$(jq -r .data.deliveryNo <<<"$R")" "D${O1}-2"
assert_eq "①O1 重新呼叫后 ready_at 非空" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$O1;")" "1"
assert_eq "①O1 count=2" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O1;")" "2"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$O1/delivery/cancel" "$AT")
assert_eq "①O1 再次取消 code 0" "$(code "$R")" "0"
assert_eq "①O1 再次取消后 ready_at 又清空" "$(sql "SELECT ready_at IS NULL FROM orders WHERE id=$O1;")" "1"
R=$(req POST "/api/admin/local/orders/$O1/self-deliver" "$AT" '{"name":"店员","phone":"13800000000"}')
assert_eq "①O1 自己送 code 0" "$(code "$R")" "0"
assert_eq "①O1 自己送后订单 SHIPPED" "$(sql "SELECT status FROM orders WHERE id=$O1;")" "SHIPPED"
assert_eq "①O1 自己送后 ready_at 非空" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$O1;")" "1"
assert_eq "①O1 count=3" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O1;")" "3"
assert_eq "①O1 最后一张 provider=SELF" "$(sql "SELECT provider FROM deliveries WHERE order_id=$O1 ORDER BY id DESC LIMIT 1;")" "SELF"
# 复核裁决 R7：骑手已取货/已送达后即使 activeOrderId 被释放（hasActiveDelivery=false）也要恒 CALLED，
# 不能因为「无在途单」回落 CALL_DUE——给顾客详情与管理端详情各一个真实覆盖（管理端此前完全没查
# pickedUpAt，这里是它在本批的唯一送达后覆盖）。
R=$(req POST "/api/admin/local/orders/$O1/delivered" "$AT")
assert_eq "①O1 标记已送达 code 0" "$(code "$R")" "0"
assert_eq "①O1 送达后顾客详情 phase=CALLED" "$(s69_sc "$O1" | jq -r .phase)" "CALLED"
assert_eq "①O1 送达后管理端详情 phase=CALLED" "$(s69_ord "$O1" | jq -r .data.schedule.phase)" "CALLED"

echo "-- ② 对照：骑手方撤单（720 回调）不清 readyAt，系统到点自动重呼 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
O2=$(s69_new 3); S72_IDS="$S72_IDS,$O2"
req POST "/api/admin/local/orders/$O2/accept" "$AT" >/dev/null
s69_pin "$O2" callAt -1
R=$(req POST "/api/admin/local/orders/$O2/ready" "$AT")
assert_eq "②O2 到点立即呼 called=true" "$(jq -r .data.called <<<"$R")" "true"
R=$(req GET "/api/admin/local/orders/$O2/delivery" "$AT")
O2_TASK=$(jq -r .data.delivery.providerTaskId <<<"$R")
O2_PROVIDER=$(jq -r '.data.delivery.calledProviders[0]' <<<"$R")   # 默认 SOLO 只呼一家
S72_NOW=$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S')
assert_eq "②O2 720 回调 http 200" "$(kd_cb "D${O2}-1" "$O2_TASK" 720 '骑手取消订单' "$S72_NOW" '王骑手' '13900001111' "$O2_PROVIDER")" "200"
assert_eq "②O2 720 后 CANCELLED" "$(dstat "$O2")" "CANCELLED"
assert_eq "②O2 720（骑手方撤单）不清 ready_at" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$O2;")" "1"
sched '{}' >/dev/null
assert_eq "②O2 到点后系统自动重呼，count=2" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O2;")" "2"
assert_eq "②O2 最新一张 CALLING" "$(sql "SELECT status FROM deliveries WHERE order_id=$O2 ORDER BY id DESC LIMIT 1;")" "CALLING"
assert_eq "②O2 最新一张 call_origin=SCHEDULED_AUTO" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$O2 ORDER BY id DESC LIMIT 1;")" "SCHEDULED_AUTO"
# O2 断言到此结束，但它的 D-2 仍是 CALLING（SOLO 策略）——直接退场，否则 ③ 的
# escalateAfterMin 覆盖是全局阈值，O2 这张也会一起被 escalateSoloCalls 扫到，
# 抢走本该给 O3 的 precancelOrder/cancelOrder mock 指令，让 ③ 的断言变得不确定。
sql "UPDATE deliveries SET status='CANCELLED', active_order_id=NULL, cancelled_at=NOW(3) WHERE order_id=$O2 AND active_order_id IS NOT NULL;"
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e ②收尾' WHERE id=$O2 AND status IN ('PAID','PREPARING');"

echo "-- ③ 对照：调度器自动升级（escalateSoloCalls 撤 D-1 建 D-2）不清 readyAt --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
O3=$(s69_new 3); S72_IDS="$S72_IDS,$O3"
req POST "/api/admin/local/orders/$O3/accept" "$AT" >/dev/null
s69_pin "$O3" callAt -1
req POST "/api/admin/local/orders/$O3/ready" "$AT" >/dev/null
assert_eq "③O3 D-1 CALLING" "$(sql "SELECT status FROM deliveries WHERE order_id=$O3 ORDER BY id DESC LIMIT 1;")" "CALLING"
assert_eq "③O3 D-1 策略 SOLO" "$(sql "SELECT call_strategy FROM deliveries WHERE order_id=$O3 ORDER BY id DESC LIMIT 1;")" "SOLO"
# 复核裁决 R2：只断言「升级后 ready_at 非空」没有证伪力——升级时 D-2 的 callRider 走的是
# source:'SCHEDULER' 但不带 origin:'SCHEDULED_AUTO'（escalateSoloCalls 没传），所以
# schedulerAuto 恒为 false，readyAt 预写分支只看 !order.readyAt：哪怕 S1 的撤回逻辑真的有
# 问题、readyAt 曾被清空，这次 D-2 呼叫也会把它重新写回非空，「非空」这个结论会被无声掩盖。
# 改成记录升级前的精确时间戳，升级后断言原样未变——这才是「没被任何一次呼叫重写过」的证据。
S72_O3_READY0=$(sql "SELECT ready_at FROM orders WHERE id=$O3;")
# escalateAfterMin 覆盖是全局阈值，会扫到整库所有 CALLING 的配送单，不只 O3 这一张——
# 实测踩到 scripts/e2e.d/50-call-strategy.sh 反复用同一个覆盖键，跑完后库里仍留着别的
# CALLING/SOLO 配送单，抢先消费掉下面为 O3 排的 precancelOrder/cancelOrder mock 指令，
# 让 O3 拿到默认的 ¥2 取消费、走进 HELD 分支而不是真正升级。这里只清场，不改它们的业务结论
# （早前测试的断言都已经跑完），只取消 O3 之外所有仍在 CALLING 的配送单，把这次 tick 的候选
# 收窄到只有 O3 一张。
sql "UPDATE deliveries SET status='CANCELLED', active_order_id=NULL, cancelled_at=NOW(3) WHERE status='CALLING' AND order_id<>$O3;"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
sleep 1
R=$(sched '{"escalateAfterMin":0.01}')
[[ "$(jq -r '.data.localEscalate // -1' <<<"$R")" -ge 1 ]] && ok "③O3 自动升级 localEscalate≥1" || fail "③O3 没有自动升级" "$R"
assert_eq "③O3 最新一张是 D${O3}-2" "$(sql "SELECT delivery_no FROM deliveries WHERE order_id=$O3 ORDER BY id DESC LIMIT 1;")" "D${O3}-2"
assert_eq "③O3 D-2 CALLING" "$(sql "SELECT status FROM deliveries WHERE order_id=$O3 ORDER BY id DESC LIMIT 1;")" "CALLING"
assert_eq "③O3 自动升级（撤 D-1 建 D-2）ready_at 保持不变（=升级前时间戳，未被任何一次呼叫重写）" "$(sql "SELECT ready_at FROM orders WHERE id=$O3;")" "$S72_O3_READY0"
assert_eq "③O3 D-1 已 CANCELLED" "$(sql "SELECT status FROM deliveries WHERE order_id=$O3 AND delivery_no='D${O3}-1';")" "CANCELLED"

echo "-- ④ S2：呼叫前保鲜排除预约单；立即单不受影响（对照证明任务本身在跑） --"
O4=$(s69_new 3); S72_IDS="$S72_IDS,$O4"
req POST "/api/admin/local/orders/$O4/accept" "$AT" >/dev/null
sleep 0.5
sql "UPDATE orders SET quoted_at=NULL WHERE id=$O4;"
A1=$(mk_local_paid); S72_IDS="$S72_IDS,$A1"
req POST "/api/admin/local/orders/$A1/accept" "$AT" >/dev/null
sleep 0.5
sql "UPDATE orders SET quoted_at=NULL WHERE id=$A1;"
sched '{"quoteRefreshMin":0}' >/dev/null
assert_eq "④O4（预约单）quoted_at 仍为空——任务不摸预约单" "$(sql "SELECT quoted_at IS NULL FROM orders WHERE id=$O4;")" "1"
assert_eq "④A1（立即单，对照）quoted_at 已回填" "$(sql "SELECT quoted_at IS NOT NULL FROM orders WHERE id=$A1;")" "1"

echo "-- ⑤ S4+S5：同城总开关关闭时，到点的已备好预约单不呼叫但有告警，phase 回落 CALL_DUE --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
O5=$(s69_new 3); S72_IDS="$S72_IDS,$O5"
req POST "/api/admin/local/orders/$O5/accept" "$AT" >/dev/null
s69_pin "$O5" callAt 30
R=$(req POST "/api/admin/local/orders/$O5/ready" "$AT")
assert_eq "⑤O5 提前备好 called=false" "$(jq -r .data.called <<<"$R")" "false"
s69_put '.enabled=false' >/dev/null
s69_pin "$O5" callAt -3
R=$(sched '{}')
[[ "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" -ge 1 ]] && ok "⑤O5 总开关关闭时 schedAutoCall≥1（告警计数）" || fail "⑤O5 没有告警计数" "$R"
assert_eq "⑤O5 总开关关闭时不发起呼叫" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O5;")" "0"
assert_eq "⑤O5 phase=CALL_DUE（顾客端详情）" "$(s69_sc "$O5" | jq -r .phase)" "CALL_DUE"
assert_eq "⑤O5 phase=CALL_DUE（管理端详情）" "$(s69_ord "$O5" | jq -r .data.schedule.phase)" "CALL_DUE"
R=$(snap)
S72_CARD5=$(jq -c ".data.columns.preparing[] | select(.orderId==$O5)" <<<"$R")
assert_eq "⑤O5 工作台卡片 phase=CALL_DUE" "$(jq -r '.local.schedule.phase' <<<"$S72_CARD5")" "CALL_DUE"
assert_eq "⑤O5 工作台卡片 local.delivery=null" "$(jq -r '.local.delivery' <<<"$S72_CARD5")" "null"
s69_put '.enabled=true' >/dev/null
R=$(sched '{}')
assert_eq "⑤O5 恢复总开关后 count=1" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O5;")" "1"
assert_eq "⑤O5 恢复后 call_origin=SCHEDULED_AUTO" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$O5 ORDER BY id DESC LIMIT 1;")" "SCHEDULED_AUTO"
assert_eq "⑤O5 恢复后 phase=CALLED" "$(s69_sc "$O5" | jq -r .phase)" "CALLED"
# 复核裁决 R3：工作台快照（routes/admin/workbench.ts:197 的 !!d）与管理端详情的 phase=CALLED
# 分支此前没有 e2e 覆盖——呼出之后各补一条。
R=$(snap)
S72_CARD5B=$(jq -c ".data.columns.waitingCourier[] | select(.orderId==$O5)" <<<"$R")
assert_eq "⑤O5 恢复呼出后工作台卡片 phase=CALLED" "$(jq -r '.local.schedule.phase' <<<"$S72_CARD5B")" "CALLED"
assert_eq "⑤O5 恢复呼出后管理端详情 phase=CALLED" "$(s69_ord "$O5" | jq -r .data.schedule.phase)" "CALLED"

echo "-- ⑥ S4：熔断期间到点仍有告警，不再静默；解除熔断后自动补呼 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
req POST /api/admin/system/kd100-circuit/reset "$AT" >/dev/null
O6=$(s69_new 3); S72_IDS="$S72_IDS,$O6"
req POST "/api/admin/local/orders/$O6/accept" "$AT" >/dev/null
s69_pin "$O6" callAt -3
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30004"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$O6/ready" "$AT")
assert_eq "⑥O6 熔断触发 42225" "$(code "$R")" "42225"
assert_eq "⑥O6 ready_at 非空（半状态不回滚）" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$O6;")" "1"
assert_eq "⑥O6 count=1" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O6;")" "1"
assert_eq "⑥O6 最新 FAILED" "$(sql "SELECT status FROM deliveries WHERE order_id=$O6 ORDER BY id DESC LIMIT 1;")" "FAILED"
assert_eq "⑥ 熔断可见于系统状态" "$(req GET /api/admin/system/status "$AT" | jq -r .data.kd100.circuitTripped)" "true"
R=$(sched '{}')
[[ "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" -ge 1 ]] && ok "⑥O6 熔断期间仍有告警 schedAutoCall≥1" || fail "⑥O6 熔断期间没有告警" "$R"
assert_eq "⑥O6 熔断期间不重复外呼，count 仍 1" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O6;")" "1"
req POST /api/admin/system/kd100-circuit/reset "$AT" >/dev/null
R=$(sched '{}')
assert_eq "⑥O6 解除熔断后 count=2" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O6;")" "2"
assert_eq "⑥O6 解除后最新 CALLING" "$(sql "SELECT status FROM deliveries WHERE order_id=$O6 ORDER BY id DESC LIMIT 1;")" "CALLING"

echo "-- ⑦ S4：非运力类失败（缺收货坐标）同样告警，不是只有熔断才管 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
O7=$(s69_new 3); S72_IDS="$S72_IDS,$O7"
req POST "/api/admin/local/orders/$O7/accept" "$AT" >/dev/null
s69_pin "$O7" callAt 30
R=$(req POST "/api/admin/local/orders/$O7/ready" "$AT")
assert_eq "⑦O7 提前备好 called=false" "$(jq -r .data.called <<<"$R")" "false"
S72_O7_LAT=$(sql "SELECT receiver_lat_e6 FROM orders WHERE id=$O7;")
sql "UPDATE orders SET receiver_lat_e6=NULL WHERE id=$O7;"
s69_pin "$O7" callAt -3
R=$(sched '{}')
[[ "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" -ge 1 ]] && ok "⑦O7 缺坐标失败也告警 schedAutoCall≥1" || fail "⑦O7 没有告警" "$R"
assert_eq "⑦O7 未发起任何配送单" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O7;")" "0"
sql "UPDATE orders SET receiver_lat_e6=$S72_O7_LAT WHERE id=$O7;"
R=$(sched '{}')
assert_eq "⑦O7 还原坐标后 count=1" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$O7;")" "1"

echo "-- ⑧ S6：付款时已过出票时刻的预约单，到点不再补打第二张 PREP 全票 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"S69-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
O8=$(s69_new 3); S72_IDS="$S72_IDS,$O8"
sleep 0.5
s69_pin "$O8" ticketAt -1   # paid_at 不动 = 刚才，晚于（新）ticketAt
R=$(sched '{}')
[[ "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" -ge 1 ]] && ok "⑧O8 到点 schedPrepTicket≥1" || fail "⑧O8 没打标" "$R"
assert_eq "⑧O8 prep_ticket_at 已写" "$(sql "SELECT prep_ticket_at IS NOT NULL FROM orders WHERE id=$O8;")" "1"
sleep 0.5
assert_eq "⑧O8 PREP 作业 0 张（付款已过出票时刻，不补打）" "$(PJOBS "$O8" | jq -r '[.data.list[] | select(.kind=="PREP")] | length')" "0"
assert_eq "⑧O8 NEW_ORDER 作业 1 张（来单票已含全部信息）" "$(PJOBS "$O8" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | length')" "1"
R=$(sched '{}')
assert_eq "⑧O8 第二轮不重复打标" "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" "0"

echo "-- ⑨ S7：预约票新增的放大行（时段/开始备餐/前备好/应于）全部 ≤16 列（真机 BIG_LINE_WIDTH，SN 222601993 实测） --"
# 只挑本批新拆出来的那几段核宽度：收货人姓名/地址那两条 <B> 行是既有设计（PO 2026-09-06 定，
# 允许放大后折成 2–3 行，见 content.ts 收货人地址段注释），不是本批改动范围，混进「全票扫描」
# 会把无关的既有宽行也判成新断言的失败，没有区分度——单测 selftest-ticket-schedule.ts 已经
# 用同样的收窄方式验证过，这里对真实来单票/备餐票内容做同法核对。
s72_extract_big() { grep -oE "$2" <<<"$1" | head -1; }   # $1=票面内容 $2=grep -E 正则（含 <B>…</B> 整段）
# R6（复核裁决）：负向断言——证伪没有回归到四种老形态（带空格整段塞一条 <B>，或用 · 合成行）
s72_assert_no_old_forms() {
  local ticket="$1" label="$2"
  [[ "$ticket" != *'<B>送达 '* ]] && ok "$label 不含老写法 <B>送达 …</B>" || fail "$label 回归了老写法 <B>送达 …</B>" "$ticket"
  [[ "$ticket" != *'<B>取餐 '* ]] && ok "$label 不含老写法 <B>取餐 …</B>" || fail "$label 回归了老写法 <B>取餐 …</B>" "$ticket"
  [[ "$ticket" != *'<B>应于 '* ]] && ok "$label 不含带空格的老写法 <B>应于 …</B>" || fail "$label 回归了带空格的老写法 <B>应于 …</B>" "$ticket"
  [[ "$ticket" != *' 开始备餐 · '* ]] && ok "$label 不含合成的备餐票时刻行（· 拼接）" || fail "$label 回归了合成的备餐票时刻行" "$ticket"
}

S72_O8_NEW=$(PJOBS "$O8" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$S72_O8_NEW" == *"送达 "* ]] && ok "⑨O8 含普通字号的送达日期行" || fail "⑨O8 缺送达行" "$S72_O8_NEW"
S72_O8_TIME=$(s72_extract_big "$S72_O8_NEW" '<B>[0-9]{2}:[0-9]{2}–[0-9]{2}:[0-9]{2}</B>')
[[ -n "$S72_O8_TIME" ]] && ok "⑨O8 含放大的时段行" || fail "⑨O8 缺放大时段行" "$S72_O8_NEW"
[[ "$(s72_bigwidth "$S72_O8_TIME")" -le 16 ]] && ok "⑨O8 放大时段行 ≤16 列" || fail "⑨O8 放大时段行超宽" "$S72_O8_TIME"
s72_assert_no_old_forms "$S72_O8_NEW" "⑨O8 来单票"

O9=$(s69_new 3); S72_IDS="$S72_IDS,$O9"
s69_pin "$O9" ticketAt -1
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 60 MINUTE) WHERE id=$O9;"   # 付款早于出票时刻，走正常出 PREP 路径（对照见 §69 ⑧）
sched '{}' >/dev/null
sleep 0.5
S72_O9_PREP=$(PJOBS "$O9" | jq -r '[.data.list[] | select(.kind=="PREP")] | last | .content')
S72_O9_PREPLINE=$(s72_extract_big "$S72_O9_PREP" '<B>[0-9]{2}:[0-9]{2} 开始备餐</B>')
S72_O9_CALLLINE=$(s72_extract_big "$S72_O9_PREP" '<B>[0-9]{2}:[0-9]{2} 前备好</B>')
[[ -n "$S72_O9_PREPLINE" ]] && ok "⑨O9 含独立的「开始备餐」放大行" || fail "⑨O9 缺开始备餐放大行" "$S72_O9_PREP"
[[ -n "$S72_O9_CALLLINE" ]] && ok "⑨O9 含独立的「前备好」放大行" || fail "⑨O9 缺前备好放大行" "$S72_O9_PREP"
[[ "$(s72_bigwidth "$S72_O9_PREPLINE")" -le 16 && "$(s72_bigwidth "$S72_O9_CALLLINE")" -le 16 ]] && ok "⑨O9 「开始备餐」「前备好」放大行均 ≤16 列" || fail "⑨O9 放大行超宽" "$S72_O9_PREPLINE / $S72_O9_CALLLINE"
s72_assert_no_old_forms "$S72_O9_PREP" "⑨O9 备餐票"
req POST "/api/admin/local/orders/$O9/accept" "$AT" >/dev/null
s69_pin "$O9" callAt -1
sched '{}' >/dev/null
sleep 0.5
S72_O9_RD=$(PJOBS "$O9" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | last | .content')
S72_O9_RDLINE=$(s72_extract_big "$S72_O9_RD" '<B>应于[0-9]{2}:[0-9]{2}前备好</B>')
[[ -n "$S72_O9_RDLINE" ]] && ok "⑨O9 含「应于」放大行" || fail "⑨O9 缺应于放大行" "$S72_O9_RD"
[[ "$(s72_bigwidth "$S72_O9_RDLINE")" -le 16 ]] && ok "⑨O9 「应于」放大行 ≤16 列" || fail "⑨O9 「应于」放大行超宽" "$S72_O9_RDLINE"
s72_assert_no_old_forms "$S72_O9_RD" "⑨O9 催备好小条"

echo "-- ⑩ S8：GET /admin/orders?schedule=ASAP 不再把自取单（PICKUP）算作尽快 --"
S72_PICKUP_TOTAL=$(sql "SELECT COUNT(*) FROM orders WHERE delivery_type='PICKUP';")
[[ "$S72_PICKUP_TOTAL" -ge 1 ]] && ok "⑩ 前置：库中已有自取单（§62 造的）" || fail "⑩ 前置：库中没有自取单，无法验证过滤是否生效"
R=$(req GET "/api/admin/orders?channel=LOCAL&schedule=ASAP&pageSize=100" "$AT")
assert_eq "⑩ schedule=ASAP 不含自取单" "$(jq -r '[.data.list[]|select(.deliveryType=="PICKUP")]|length' <<<"$R")" "0"
R=$(req GET "/api/admin/orders?channel=LOCAL&pageSize=100" "$AT")
S72_PICKUP_IN_LOCAL=$(jq -r '[.data.list[]|select(.deliveryType=="PICKUP")]|length' <<<"$R")
[[ "$S72_PICKUP_IN_LOCAL" -ge 1 ]] && ok "⑩ 对照：channel=LOCAL 不加 schedule 时含自取单（证明是过滤生效而非本来就没有）" || fail "⑩ 对照失败：channel=LOCAL 里也没有自取单" "$R"

echo "-- 收尾：恢复设置、清作业、取消/收尾未完成单 --"
req PUT /api/admin/settings/local-delivery "$AT" "$S72_ORIG" >/dev/null
req PUT /api/admin/settings/printer "$AT" "$S72_PRINTER_BEFORE" >/dev/null
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
req POST /api/admin/system/kd100-circuit/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
S72_IDS=${S72_IDS#,}
sql "DELETE FROM print_jobs WHERE order_id IN ($S72_IDS);"
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 收尾' WHERE id IN ($S72_IDS) AND status IN ('PAID','PREPARING');"
sql "UPDATE orders SET status='COMPLETED', completed_at=NOW(3) WHERE id IN ($S72_IDS) AND status='SHIPPED';"
sql "UPDATE deliveries SET status='CANCELLED', active_order_id=NULL, cancelled_at=NOW(3) WHERE order_id IN ($S72_IDS) AND active_order_id IS NOT NULL;"
