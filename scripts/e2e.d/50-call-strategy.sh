echo "== 50. 呼叫策略：只呼最低价 + 3 分钟升级并呼 + actualFee 认领 =="
# 复用 e2e.sh 主体定义的 req/code/ok/fail/assert_eq/mk_local_paid/kd_cb（本文件在 e2e.sh 尾部被
# source 进来，同一个 shell）。变量一律 D50_ 前缀，避免与主体或其它分片撞车。
#
# 这一组测的是 2026-09-06 首单实测暴露出来的两笔钱：
#   ① 并呼让最贵的抢到 —— 达达报 ¥16.23、闪送 ¥23.32 抢到，一单多付 ¥7.09；
#   ② 并呼按家数倍数占余额 —— 那一单冻结 ¥75.08 只花 ¥23.32，100 元余额同时只挂得下 1 单。
# 两条都由「默认只呼最低价」这一个改动解决，所以下面每条断言都盯着「到底呼了谁」。

D50_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
d50_put_settings() {  # $1 = jq 表达式，在当前设置上改一改再整包写回（服务端 PUT 是整包覆盖）
  local cur next
  cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
  next=$(jq -c "$1" <<<"$cur")
  req PUT /api/admin/settings/local-delivery "$AT" "$next" >/dev/null
}
d50_dlv() { req GET "/api/admin/local/orders/$1/delivery" "$AT"; }
# 四家真实报价，最低是达达 ¥16.23 —— 直接用首单那一组数，断言读起来就是那笔账
D50_QUOTES='{"kind":"ok","quotes":[{"provider":"dadatongcheng","feeFen":1623,"distanceM":8979},{"provider":"shunfengtongcheng","feeFen":1738,"distanceM":8979},{"provider":"fengniaotongcheng","feeFen":1815,"distanceM":8940},{"provider":"shansongtongcheng","feeFen":2332,"distanceM":8700}]}'
d50_queue_price() {  # 连排几条同样的 price 指令：接单时的 kickOffQuote 与呼叫前的同步查价
                     # 都会各吃掉一条，后台 60 秒保鲜任务若插进来还会再偷一条。
  local i
  for i in 1 2 3; do
    req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"price\",\"directive\":$D50_QUOTES}" >/dev/null
  done
}
# 前面几十段用例留下了一地 CALLING 的配送单，默认策略下它们全是 SOLO——升级任务会把它们
# 一并扫走（这是**正确**的生产行为：真有一张 3 分钟没人接的单就该升级），于是
# 「命中 1 单」这类精确条数断言必然被带偏，本段排的 mock 指令也会被别的单吃掉。
# 把除本单以外的在途单挪出扫描范围，让这一段只面对自己造的那张单。
d50_only() { sql "UPDATE deliveries SET call_strategy='ALL' WHERE status='CALLING' AND delivery_no <> '$1'"; }

d50_put_settings '.callStrategy = {"mode":"SOLO_LOWEST","escalateAfterMin":3}'
assert_eq "设置里落下 SOLO_LOWEST" "$(req GET /api/admin/settings/local-delivery "$AT" | jq -r .data.callStrategy.mode)" "SOLO_LOWEST"

echo "-- ① 只呼最低价：四家报价里只呼达达一家 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
d50_queue_price
# createOrder 回 ¥16.23：真实 batchOrder 对被呼的每一家各返一条预扣，只呼一家就只有一条
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"ok","quotedFeeFen":1623}}' >/dev/null
D50_O1=$(mk_local_paid)
req POST "/api/admin/local/orders/$D50_O1/accept" "$AT" >/dev/null
sleep 0.5   # 等 kickOffQuote 落库，让「快照新鲜 → 不再同步查价」这条常规路径真的被走到
R=$(req POST "/api/admin/local/orders/$D50_O1/call" "$AT")
assert_eq "只呼最低价 呼叫 code 0" "$(code "$R")" "0"
D50_D1=$(jq -r .data.deliveryNo <<<"$R")
R=$(d50_dlv "$D50_O1")
assert_eq "只呼了达达一家" "$(jq -c '.data.delivery.calledProviders' <<<"$R")" '["dadatongcheng"]'
assert_eq "策略标记为 SOLO" "$(jq -r '.data.delivery.callStrategy' <<<"$R")" "SOLO"
assert_eq "quotedFee = 达达报价 1623（不是四家的 Math.min 巧合）" "$(jq -r '.data.delivery.quotedFee' <<<"$R")" "1623"
assert_eq "orderFees 只有一条（并呼才会是多条）" "$(jq -r '.data.delivery.orderFees | length' <<<"$R")" "1"
assert_eq "orderFees 那一条就是达达" "$(jq -r '.data.delivery.orderFees[0].provider' <<<"$R")" "dadatongcheng"
assert_eq "运力列表真的传进了下单参数" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -c '[.data[] | select(.op=="createOrder")] | last | .input.providers')" '["dadatongcheng"]'
# 事件文案要让店员一眼看出「只呼了谁、多少钱、接下来会自动发生什么」
[[ "$(jq -r '[.data.events[] | select(.source=="API")] | last | .statusDesc' <<<"$R")" == *"只呼最低价 达达 ¥16.23"* ]] \
  && ok "时间线首条写明只呼最低价与金额" \
  || fail "事件文案没写清呼了谁" "$(jq -r '[.data.events[] | select(.source=="API")] | last | .statusDesc' <<<"$R")"

echo "-- ② 无人接单到点 → 取消 D-1、并呼建 D-2 --"
# 预估取消费必须为 0 才自动撤：mock 默认回 ¥2（会走 SOLO_HELD 分支，见 ④），这里显式压成 0。
# 真实情况下未接单的单撤销本就不要钱，¥2 对应的是「骑手已经接了」。
d50_only "$D50_D1"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
sleep 1   # escalateAfterMin=0.01 分钟 = 600 毫秒，要让 calledAt 真的落到窗口外
# ⚠️ 传 0 是**关掉**自动升级（与 autoCallDelayMin 同一套约定），要立刻命中得传 0.01
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "升级任务命中 1 单" "$(jq -r '.data.localEscalate' <<<"$R")" "1"
R=$(d50_dlv "$D50_O1")
D50_D2=$(jq -r '.data.delivery.deliveryNo' <<<"$R")
[[ "$D50_D2" != "$D50_D1" ]] && ok "建了新配送单 $D50_D2（不是在原单上追加）" || fail "没有新建配送单" "$D50_D2"
assert_eq "D-2 在途待抢单" "$(jq -r '.data.delivery.status' <<<"$R")" "CALLING"
assert_eq "D-2 策略是并呼" "$(jq -r '.data.delivery.callStrategy' <<<"$R")" "ALL"
D50_ALLPROV=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c '.data.kd100.providers')
assert_eq "D-2 呼了设置里的全部运力" "$(jq -c '.data.delivery.calledProviders' <<<"$R")" "$D50_ALLPROV"
# D-1 已终态：activeOrderId 唯一索引规定一单只能有一张在途单，所以升级只能「撤旧建新」
D50_D1ROW=$(sql "SELECT status, cancel_reason FROM deliveries WHERE delivery_no='$D50_D1'")
[[ "$D50_D1ROW" == *"CANCELLED"* ]] && ok "D-1 已取消" || fail "D-1 未取消" "$D50_D1ROW"
[[ "$D50_D1ROW" == *"自动升级"* ]] && ok "D-1 取消原因写明是自动升级" || fail "取消原因没写清" "$D50_D1ROW"
assert_eq "外呼顺序 precancel → cancel → createOrder" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="precancelOrder" or .op=="cancelOrder" or .op=="createOrder")] | .[-3:] | map(.op) | join(">")')" \
  "precancelOrder>cancelOrder>createOrder"

echo "-- ③ 同一单不会被反复升级 --"
# D-2 是 ALL，不在扫描范围（只扫 callStrategy='SOLO'）；漏了这条守卫就会每分钟撤一次单
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "再跑一轮不再命中" "$(jq -r '.data.localEscalate' <<<"$R")" "0"
assert_eq "D-2 仍在途未被动过" "$(d50_dlv "$D50_O1" | jq -r '.data.delivery.deliveryNo')" "$D50_D2"

echo "-- ⑤ 回调 100 认领实扣：中标运力那一笔预扣写进 actualFee --"
# kd_cb 固定带 kuaidicom=shansongtongcheng，而 D-2 是并呼全表，闪送就在 orderFees 里
D50_T2=$(d50_dlv "$D50_O1" | jq -r '.data.delivery.providerTaskId')
D50_SSFEE=$(d50_dlv "$D50_O1" | jq -r '.data.delivery.orderFees[] | select(.provider=="shansongtongcheng") | .feeFen')
assert_eq "回调 100 http 200" "$(kd_cb "$D50_D2" "$D50_T2" 100 '骑手已接单' '2026-09-08 12:00:00')" "200"
R=$(d50_dlv "$D50_O1")
assert_eq "中标运力落库" "$(jq -r '.data.delivery.courierCompany' <<<"$R")" "shansongtongcheng"
assert_eq "actualFee = 中标运力那一笔预扣" "$(jq -r '.data.delivery.actualFee' <<<"$R")" "$D50_SSFEE"
# 写一次为准：后续 230/310 再来也不许改（快递100 按预扣实扣，重写只会让对账口径漂移）
assert_eq "回调 230 http 200" "$(kd_cb "$D50_D2" "$D50_T2" 230 '骑手已到店' '2026-09-08 12:03:00')" "200"
assert_eq "actualFee 不被后续回调改写" "$(d50_dlv "$D50_O1" | jq -r '.data.delivery.actualFee')" "$D50_SSFEE"

echo "-- ④ 预估取消费 > 0 → 放弃自动升级（SOLO_HELD），不撤单 --"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
d50_queue_price
D50_O2=$(mk_local_paid)
req POST "/api/admin/local/orders/$D50_O2/accept" "$AT" >/dev/null
sleep 0.5
req POST "/api/admin/local/orders/$D50_O2/call" "$AT" >/dev/null
D50_D3=$(d50_dlv "$D50_O2" | jq -r '.data.delivery.deliveryNo')
d50_only "$D50_D3"
# mock 默认 precancel 回 ¥2 —— 正是「骑手已经接了单」的情形，撤单要真花钱
sleep 1
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "计入 1 次（放弃也算处理过，否则会每分钟重复告警）" "$(jq -r '.data.localEscalate' <<<"$R")" "1"
R=$(d50_dlv "$D50_O2")
assert_eq "标记为 SOLO_HELD" "$(jq -r '.data.delivery.callStrategy' <<<"$R")" "SOLO_HELD"
assert_eq "原配送单没被撤（还是同一张）" "$(jq -r '.data.delivery.deliveryNo' <<<"$R")" "$D50_D3"
assert_eq "原配送单仍是待抢单" "$(jq -r '.data.delivery.status' <<<"$R")" "CALLING"
[[ "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="cancelOrder")] | length')" == "0" ]] \
  && ok "没有发出任何撤单请求" || fail "不该撤单却撤了" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -c '[.data[].op]')"
# SOLO_HELD 让该行离开扫描：不然每分钟一次 precancel + 一次告警，店员会被刷屏
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "SOLO_HELD 后不再重复处理" "$(jq -r '.data.localEscalate' <<<"$R")" "0"

echo "-- ⑦ 熔断态下不升级（撤了旧单却呼不出新单，比不升级更糟）--"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
d50_queue_price
D50_O3=$(mk_local_paid)
req POST "/api/admin/local/orders/$D50_O3/accept" "$AT" >/dev/null
sleep 0.5
req POST "/api/admin/local/orders/$D50_O3/call" "$AT" >/dev/null
D50_D4=$(d50_dlv "$D50_O3" | jq -r '.data.delivery.deliveryNo')
d50_only "$D50_D4"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
# 用一次余额不足的呼叫把熔断打开（30004 → BALANCE → tripCircuit）
D50_O4=$(mk_local_paid)
req POST "/api/admin/local/orders/$D50_O4/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30004"}}' >/dev/null
req POST "/api/admin/local/orders/$D50_O4/call" "$AT" >/dev/null 2>&1 || true
assert_eq "熔断已触发" "$(req GET /api/admin/system/status "$AT" | jq -r .data.kd100.circuitTripped)" "true"
sleep 1
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "熔断时升级任务直接跳过" "$(jq -r '.data.localEscalate' <<<"$R")" "0"
R=$(d50_dlv "$D50_O3")
assert_eq "熔断时原单原封不动仍待抢单" "$(jq -r '.data.delivery.status' <<<"$R")" "CALLING"
assert_eq "熔断时原单没被换成新单" "$(jq -r '.data.delivery.deliveryNo' <<<"$R")" "$D50_D4"
req POST /api/admin/system/kd100-circuit/reset "$AT" >/dev/null

echo "-- ⑧ 顾客已申请取消的单不升级（撤了旧单必然重呼失败，会把店员引向反方向）--"
# 复查抓出来的：callRider 对 cancelRequestedAt 是硬拦截（42204），而 cancelDelivery 不拦。
# 不排除的话顺序会变成「先把 D-1 撤了 → 重呼必然失败 → 发一条『请手动呼叫骑手』的告警」，
# 而顾客其实是想取消。顾客可取消窗口（默认 5 分钟）与 3 分钟升级窗口高度重叠，不是罕见路径。
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
d50_queue_price
D50_O6=$(mk_local_paid)
req POST "/api/admin/local/orders/$D50_O6/accept" "$AT" >/dev/null
sleep 0.5
req POST "/api/admin/local/orders/$D50_O6/call" "$AT" >/dev/null
D50_D6=$(d50_dlv "$D50_O6" | jq -r '.data.delivery.deliveryNo')
d50_only "$D50_D6"
sql "UPDATE orders SET cancel_requested_at = UTC_TIMESTAMP(3) WHERE id = $D50_O6" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"precancelOrder","directive":{"kind":"ok","cancelFeeFen":0}}' >/dev/null
sleep 1
R=$(sched '{"escalateAfterMin":0.01}')
assert_eq "有待处理取消申请时不升级" "$(jq -r '.data.localEscalate' <<<"$R")" "0"
R=$(d50_dlv "$D50_O6")
assert_eq "原配送单原封不动" "$(jq -r '.data.delivery.deliveryNo' <<<"$R")" "$D50_D6"
assert_eq "原配送单仍待抢单（没被撤）" "$(jq -r '.data.delivery.status' <<<"$R")" "CALLING"
[[ "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="cancelOrder")] | length')" == "0" ]] \
  && ok "没有发出撤单请求" || fail "不该撤单却撤了" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -c '[.data[].op]')"
sql "UPDATE orders SET cancel_requested_at = NULL WHERE id = $D50_O6" >/dev/null

echo "-- ⑥ 切回 ALL：行为与策略上线前一致（这是不必部署就能关掉策略的开关）--"
d50_put_settings '.callStrategy = {"mode":"ALL","escalateAfterMin":3}'
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
d50_queue_price
D50_O5=$(mk_local_paid)
req POST "/api/admin/local/orders/$D50_O5/accept" "$AT" >/dev/null
sleep 0.5
R=$(req POST "/api/admin/local/orders/$D50_O5/call" "$AT")
assert_eq "ALL 模式呼叫 code 0" "$(code "$R")" "0"
R=$(d50_dlv "$D50_O5")
assert_eq "ALL 模式呼设置里的全部运力" "$(jq -c '.data.delivery.calledProviders' <<<"$R")" "$D50_ALLPROV"
assert_eq "ALL 模式策略标记为 ALL" "$(jq -r '.data.delivery.callStrategy' <<<"$R")" "ALL"
assert_eq "ALL 模式 orderFees 每家一条" "$(jq -r '.data.delivery.orderFees | length' <<<"$R")" "$(jq -r 'length' <<<"$D50_ALLPROV")"

# 还原：这一组改过全局设置，不还原会污染后面（以及重跑时的）用例
req PUT /api/admin/settings/local-delivery "$AT" "$D50_ORIG" >/dev/null
assert_eq "设置已还原" "$(req GET /api/admin/settings/local-delivery "$AT" | jq -r .data.callStrategy.mode)" "$(jq -r '.callStrategy.mode // "SOLO_LOWEST"' <<<"$D50_ORIG")"
