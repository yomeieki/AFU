echo "== 78. 呼叫方式改简化弹窗 + 等待锚点不清零 + 一单多张配送单的历史展示 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/sched/sql/mk_local_paid（本文件在 e2e.sh 尾部被
# source 进来，同一个 shell）。变量一律 S78_ 前缀。
#
# 覆盖 wb-escalation-display 方案 B 部分（验收 9-15）：
#   ① 等待锚点从第一次呼叫算、自动升级/店员取消重呼都不清零（用户 2026-09-26 决定）；
#   ② GET :id/delivery 的 history 字段——全部配送单摘要 + 全部事件，自动升级链路归属；
#   ③ 旧数据（升级取消事件文案还是老的「商家取消」）在展示层被改写，库里原值不动。

req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
S78_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
s78_put_settings() {  # $1 = jq 表达式，在当前设置上改一改再整包写回（服务端 PUT 是整包覆盖）
  local cur next
  cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
  next=$(jq -c "$1" <<<"$cur")
  req PUT /api/admin/settings/local-delivery "$AT" "$next" >/dev/null
}
s78_dlv() { req GET "/api/admin/local/orders/$1/delivery" "$AT"; }
# 把「本单以外」所有还在待抢单的配送单挪出 escalateSoloCalls 的扫描范围（同 50-call-strategy.sh
# 的 d50_only 手法）：前面几十段用例会留下一地 CALLING 的单，不隔离的话 sched 里排的
# precancel/cancel mock 指令可能被别的单先吃掉，把本段的断言带偏。
s78_only() { sql "UPDATE deliveries SET call_strategy='ALL' WHERE status='CALLING' AND delivery_no <> '$1'"; }
s78_wait_since() {  # $1 orderId → echo 工作台快照里该单（不论在哪一列）的 waitSince
  req GET "/api/admin/workbench/snapshot?fresh=1" "$AT" | jq -r --argjson o "$1" \
    '(.data.columns.waitingCourier + .data.columns.preparing + .data.columns.pending) | .[] | select(.orderId==$o) | .waitSince'
}

# 达达最低价四家报价——直接照抄 50-call-strategy.sh 的 D50_QUOTES 形状，断言读起来是同一笔账
S78_QUOTES='{"kind":"ok","quotes":[{"provider":"dadatongcheng","feeFen":1623,"distanceM":8979},{"provider":"shunfengtongcheng","feeFen":1738,"distanceM":8979},{"provider":"fengniaotongcheng","feeFen":1815,"distanceM":8940},{"provider":"shansongtongcheng","feeFen":2332,"distanceM":8700}]}'
s78_queue_price() { local i; for i in 1 2 3; do req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"price\",\"directive\":$S78_QUOTES}" >/dev/null; done; }

s78_put_settings '.callStrategy = {"mode":"SOLO_LOWEST","cheapestN":3,"escalateAfterMin":3}'
assert_eq "78：设置落下 SOLO_LOWEST/cheapestN 3/escalateAfterMin 3" \
  "$(req GET /api/admin/settings/local-delivery "$AT" | jq -c '{m:.data.callStrategy.mode,n:.data.callStrategy.cheapestN,e:.data.callStrategy.escalateAfterMin}')" \
  '{"m":"SOLO_LOWEST","n":3,"e":3}'

echo "-- ① O1：只呼达达，升级前锚点 = calledAt，卡片字段集不变 --"
s78_queue_price
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok","quotedFeeFen":1623}}' >/dev/null
S78_O1=$(mk_local_paid); [[ -n "$S78_O1" ]] && ok "78：同城单 #$S78_O1 已支付" || fail "78：造单失败"
req POST "/api/admin/local/orders/$S78_O1/accept" "$AT" >/dev/null
sleep 0.5
R=$(req POST "/api/admin/local/orders/$S78_O1/call" "$AT")
assert_eq "78：呼叫 code 0" "$(code "$R")" "0"
S78_D1=$(jq -r .data.deliveryNo <<<"$R")

# 验收 9：快照锚点 = calledAt（第一次呼叫，此时链上只有 D-1，两者本该相等）
S78_ANCHOR=$(s78_wait_since "$S78_O1")
S78_D1_CALLEDAT=$(s78_dlv "$S78_O1" | jq -r .data.delivery.calledAt)
assert_eq "78-9：升级前快照锚点 = D-1 calledAt" "$S78_ANCHOR" "$S78_D1_CALLEDAT"
[[ -n "$S78_ANCHOR" && "$S78_ANCHOR" != "null" ]] && ok "78-9：锚点非空" || fail "78-9：锚点为空" "$S78_ANCHOR"

# 验收 10：卡片 .local 字段集不因本次改动而变（服务端只换了 waitSince 的算法，不改 toCard 输出形状）
S78_LOCAL_KEYS=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT" | jq -c --argjson o "$S78_O1" \
  '[.data.columns.waitingCourier[] | select(.orderId==$o)][0].local | keys | sort')
assert_eq "78-10：卡片 .local 字段集与 BASE 一致" "$S78_LOCAL_KEYS" \
  '["acceptedAt","cancelRejected","cancelRequested","delivery","distanceM","estimatedDeliveryAt","schedule"]'

echo "-- ② 触发自动升级：D-1 → 取消（SCHEDULER）→ D-2（CHEAPEST 并呼最便宜 3 家）--"
s78_only "$S78_D1"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
sleep 1   # escalateAfterMin=0.01 分钟 = 600ms，要让 calledAt 真落到窗口外；顺带保证锚点先后差 ≥1s
R=$(sched '{"escalateAfterMin":0.01}')
[[ "$(jq -r '.data.localEscalate // -1' <<<"$R")" -ge 1 ]] && ok "78-11：升级任务命中 ≥1 单" || fail "78-11：升级任务未命中" "$R"

R=$(s78_dlv "$S78_O1")
S78_D2=$(jq -r .data.delivery.deliveryNo <<<"$R")
assert_eq "78-11：新配送单号 D<O1>-2" "$S78_D2" "D${S78_O1}-2"
assert_eq "78-11：D-2 策略 CHEAPEST" "$(jq -r .data.delivery.callStrategy <<<"$R")" "CHEAPEST"
assert_eq "78-11：history.deliveries 长度 2" "$(jq -r '.data.history.deliveries | length' <<<"$R")" "2"
assert_eq "78-11：history.deliveries[0] 是 D-1" "$(jq -r '.data.history.deliveries[0].deliveryNo' <<<"$R")" "$S78_D1"
assert_eq "78-11：history.deliveries[0].status CANCELLED" "$(jq -r '.data.history.deliveries[0].status' <<<"$R")" "CANCELLED"
assert_eq "78-11：history.deliveries[1] 是 D-2" "$(jq -r '.data.history.deliveries[1].deliveryNo' <<<"$R")" "$S78_D2"
assert_eq "78-11：D-2.escalatedFrom.fromDeliveryNo = D-1" "$(jq -r '.data.history.deliveries[1].escalatedFrom.fromDeliveryNo' <<<"$R")" "$S78_D1"
assert_eq "78-11：D-1.escalatedFrom = null" "$(jq -r '.data.history.deliveries[0].escalatedFrom' <<<"$R")" "null"

S78_D1_EVCOUNT=$(jq -r --arg d "$S78_D1" '[.data.history.events[] | select(.deliveryNo==$d)] | length' <<<"$R")
S78_D2_EVCOUNT=$(jq -r --arg d "$S78_D2" '[.data.history.events[] | select(.deliveryNo==$d)] | length' <<<"$R")
[[ "$S78_D1_EVCOUNT" -ge 1 ]] && ok "78-11：history.events 含 D-1 事件 ≥1 条" || fail "78-11：D-1 事件缺失" "$R"
[[ "$S78_D2_EVCOUNT" -ge 1 ]] && ok "78-11：history.events 含 D-2 事件 ≥1 条" || fail "78-11：D-2 事件缺失" "$R"
assert_eq "78-11：每条事件都带 deliveryNo/displayDesc 字段" \
  "$(jq -r '[.data.history.events[] | (has("deliveryNo") and has("displayDesc"))] | all' <<<"$R")" "true"
assert_eq "78-11：events 按 createdAt 单调非降" \
  "$(jq -r '[.data.history.events[].createdAt] as $a | ($a == ($a|sort))' <<<"$R")" "true"

S78_D1_CANCEL_EV=$(jq -c '[.data.history.events[] | select(.deliverySeq==1 and .operator=="scheduler")][0]' <<<"$R")
assert_eq "78-11：D-1 取消事件 source=SCHEDULER" "$(jq -r .source <<<"$S78_D1_CANCEL_EV")" "SCHEDULER"
assert_eq "78-11：D-1 取消事件 operator=scheduler" "$(jq -r .operator <<<"$S78_D1_CANCEL_EV")" "scheduler"
S78_D1_CANCEL_DESC=$(jq -r .statusDesc <<<"$S78_D1_CANCEL_EV")
[[ "$S78_D1_CANCEL_DESC" == "达达 0.01 分钟无人接，已自动取消（取消费 ¥0.00），改为并呼最便宜 3 家"* ]] \
  && ok "78-11：D-1 取消事件文案是新版自动升级说明" \
  || fail "78-11：D-1 取消事件文案不对" "$S78_D1_CANCEL_DESC"
assert_eq "78-11：displayDesc 与 statusDesc 相同（新事件不需要改写）" \
  "$(jq -r .displayDesc <<<"$S78_D1_CANCEL_EV")" "$S78_D1_CANCEL_DESC"
assert_eq "78-11：history.events 里没有旧版「商家取消」开头的行" \
  "$(jq -r '[.data.history.events[] | select(.statusDesc | startswith("商家取消"))] | length' <<<"$R")" "0"

# 旧字段兼容：`.data.events`/`.data.delivery` 只看最新一张单（D-2），语义逐字不变——
# DeliveryEvent 模型本身没有 deliveryNo 列，`.data.events` 不下发这个字段（`.data.history.events`
# 才有），这里改用「条数与 history 里 D-2 那部分一致」来验证「仍只含 D-2 的事件」这件事。
assert_eq "78-11：旧 events 字段条数 = history 里 D-2 的事件条数" \
  "$(jq -r '.data.events | length' <<<"$R")" "$S78_D2_EVCOUNT"
assert_eq "78-11：旧 events 字段不含 deliveryNo（未新增字段，兼容旧消费者）" \
  "$(jq -r '[.data.events[] | has("deliveryNo")] | any' <<<"$R")" "false"
assert_eq "78-11：costFen = D-2 quotedFee（D-1 released、cancelFee 0，口径未变）" \
  "$(jq -r '.data.costFen' <<<"$R")" "$(jq -r '.data.delivery.quotedFee' <<<"$R")"

echo "-- ③ 升级后锚点不清零：仍是升级前那个值，且与 D-2 calledAt 不同 --"
S78_ANCHOR2=$(s78_wait_since "$S78_O1")
assert_eq "78-12：升级后快照锚点仍等于升级前锚点（不清零）" "$S78_ANCHOR2" "$S78_ANCHOR"
S78_D2_CALLEDAT=$(jq -r .data.delivery.calledAt <<<"$R")
[[ "$S78_ANCHOR2" != "$S78_D2_CALLEDAT" ]] && ok "78-12：锚点不等于 D-2 calledAt" || fail "78-12：锚点被 D-2 抢先" "$S78_ANCHOR2 == $S78_D2_CALLEDAT"

echo "-- ④ 历史「商家取消」行改写：库里原值不动，displayDesc 改写成人话 --"
S78_D1_ID=$(sql "SELECT id FROM deliveries WHERE delivery_no='$S78_D1'")
S78_EVT_ID=$(sql "SELECT id FROM delivery_events WHERE delivery_id=$S78_D1_ID AND status_desc LIKE '%已自动取消%' ORDER BY id DESC LIMIT 1")
sql "UPDATE delivery_events SET status_desc='商家取消（取消费 0.00 元）', source='ADMIN' WHERE id=$S78_EVT_ID"
R=$(s78_dlv "$S78_O1")
S78_LEGACY_EV=$(jq -c --argjson id "$S78_EVT_ID" '.data.history.events[] | select(.id==$id)' <<<"$R")
assert_eq "78-13：库里 statusDesc 原文不变" "$(jq -r .statusDesc <<<"$S78_LEGACY_EV")" "商家取消（取消费 0.00 元）"
S78_LEGACY_DISPLAY=$(jq -r .displayDesc <<<"$S78_LEGACY_EV")
[[ "$S78_LEGACY_DISPLAY" == "达达 0.01 分钟无人接，已自动取消（取消费 ¥0.00），改为并呼最便宜 3 家"* ]] \
  && ok "78-13：displayDesc 改写成新版自动升级说明" \
  || fail "78-13：displayDesc 没有改写" "$S78_LEGACY_DISPLAY"

echo "-- ⑤ 反例：店员手动取消→重呼，不该被误判为自动升级 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
s78_queue_price
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok","quotedFeeFen":1623}}' >/dev/null
S78_O2=$(mk_local_paid); req POST "/api/admin/local/orders/$S78_O2/accept" "$AT" >/dev/null
sleep 0.5
req POST "/api/admin/local/orders/$S78_O2/call" "$AT" >/dev/null
S78_O2_D1=$(s78_dlv "$S78_O2" | jq -r .data.delivery.deliveryNo)
s78_only "$S78_O2_D1"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
sleep 1   # 与 D-1 calledAt 拉开 ≥1s，供下面「锚点不清零」的等值比较有意义
R=$(req POST "/api/admin/local/orders/$S78_O2/delivery/cancel" "$AT" '{"reason":"商家取消"}')
assert_eq "78-14：手动取消 code 0" "$(code "$R")" "0"
req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"createOrder\",\"directive\":{\"kind\":\"ok\",\"quotedFeeFen\":1623}}" >/dev/null
R=$(req POST "/api/admin/local/orders/$S78_O2/call" "$AT")
assert_eq "78-14：重呼 code 0" "$(code "$R")" "0"

R=$(s78_dlv "$S78_O2")
S78_O2_D1CANCEL_EV=$(jq -c '.data.history.events[] | select(.deliverySeq==1 and (.statusDesc // "" | startswith("商家取消")))' <<<"$R")
S78_O2_D1CANCEL_DESC=$(jq -r .statusDesc <<<"$S78_O2_D1CANCEL_EV")
[[ "$S78_O2_D1CANCEL_DESC" == "商家取消（取消费 0.00 元）"* ]] \
  && ok "78-14：D-1 取消事件文案仍是「商家取消」（未被误判为自动升级）" \
  || fail "78-14：D-1 取消事件文案不对" "$S78_O2_D1CANCEL_DESC"
assert_eq "78-14：displayDesc 与 statusDesc 相同（不该被改写）" "$(jq -r .displayDesc <<<"$S78_O2_D1CANCEL_EV")" "$S78_O2_D1CANCEL_DESC"
assert_eq "78-14：D-1 取消事件 source=ADMIN（店员手动，不是调度器）" "$(jq -r .source <<<"$S78_O2_D1CANCEL_EV")" "ADMIN"
assert_eq "78-14：D-2.escalatedFrom = null（店员重呼不算自动升级）" "$(jq -r '.data.history.deliveries[1].escalatedFrom' <<<"$R")" "null"

S78_O2_D1_CALLEDAT=$(jq -r '.data.history.deliveries[0].calledAt' <<<"$R")
S78_O2_ANCHOR=$(s78_wait_since "$S78_O2")
assert_eq "78-14：快照锚点 = D-1 calledAt（不是 D-2 的，用户决定：一律从第一次呼叫算）" "$S78_O2_ANCHOR" "$S78_O2_D1_CALLEDAT"

echo "-- ⑥ 反例：SOLO_HELD（预估取消费 > 0，放弃自动升级）不产生第二张单 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
s78_queue_price
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok","quotedFeeFen":1623}}' >/dev/null
S78_O3=$(mk_local_paid); req POST "/api/admin/local/orders/$S78_O3/accept" "$AT" >/dev/null
sleep 0.5
req POST "/api/admin/local/orders/$S78_O3/call" "$AT" >/dev/null
S78_O3_D1=$(s78_dlv "$S78_O3" | jq -r .data.delivery.deliveryNo)
s78_only "$S78_O3_D1"
# 不排 precancelOrder 指令：mock 默认回 ¥2（骑手已接单的情形），走 SOLO_HELD 分支，不撤单
sleep 1
sched '{"escalateAfterMin":0.01}' >/dev/null
R=$(s78_dlv "$S78_O3")
assert_eq "78-15：策略变为 SOLO_HELD（放弃自动升级，原单没撤）" "$(jq -r .data.delivery.callStrategy <<<"$R")" "SOLO_HELD"
assert_eq "78-15：仍是同一张单" "$(jq -r .data.delivery.deliveryNo <<<"$R")" "$S78_O3_D1"
assert_eq "78-15：history.deliveries 长度 1" "$(jq -r '.data.history.deliveries | length' <<<"$R")" "1"
assert_eq "78-15：escalatedFrom = null" "$(jq -r '.data.history.deliveries[0].escalatedFrom' <<<"$R")" "null"
S78_O3_D1_CALLEDAT=$(jq -r .data.delivery.calledAt <<<"$R")
assert_eq "78-15：快照锚点 = D-1 calledAt" "$(s78_wait_since "$S78_O3")" "$S78_O3_D1_CALLEDAT"

echo "-- 收尾：复原设置、清空 mock 队列 --"
req PUT /api/admin/settings/local-delivery "$AT" "$S78_ORIG" >/dev/null
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
