echo "== 51. 配送可见性：报价/中标/实扣/骑手位置/成本合计 =="
# 批次 2 的服务端契约。工作台是 React，这里锁的是**它渲染所依赖的那几个字段**——
# 首单暴露的问题全是「数据早就在库里，接口没给或前端丢掉了」，所以护栏该立在接口这一层。
# 变量一律 D51_ 前缀（同 44/50 的约定）。

D51_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
d51_dlv() { req GET "/api/admin/local/orders/$1/delivery" "$AT"; }
# 门店坐标（29.341126, 104.779018）正北约 1.1 km 的点——首单那次免费查价的探测点，
# 用它当骑手位置，算出来的距离就有实测参照。
D51_COURIER='{"latE6":29351126,"lngE6":104779018}'

echo "-- ① GET /delivery 把报价快照与成本合计交给前端（此前服务端返回了、前端丢掉了）--"
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
for _ in 1 2 3; do
  req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"price","directive":{"kind":"ok","quotes":[{"provider":"dadatongcheng","feeFen":1623,"distanceM":8979},{"provider":"shansongtongcheng","feeFen":2332,"distanceM":8700}]}}' >/dev/null
done
D51_O1=$(mk_local_paid)
req POST "/api/admin/local/orders/$D51_O1/accept" "$AT" >/dev/null
sleep 0.5
R=$(d51_dlv "$D51_O1")
assert_eq "接单后就能拿到报价快照" "$(jq -r '.data.quote.snapshot != null' <<<"$R")" "true"
assert_eq "快照里两家都在" "$(jq -r '.data.quote.snapshot.quotes | length' <<<"$R")" "2"
assert_eq "服务端算好 stale（前端不必复刻 5 分钟阈值）" "$(jq -r '.data.quote.stale' <<<"$R")" "false"
assert_eq "costFen 字段存在（未呼叫时为 0）" "$(jq -r '.data.costFen' <<<"$R")" "0"

echo "-- ② 呼叫后：中标/呼叫方式/各家预扣 三个字段都下发 --"
req POST "/api/admin/local/orders/$D51_O1/call" "$AT" >/dev/null
R=$(d51_dlv "$D51_O1")
D51_D1=$(jq -r '.data.delivery.deliveryNo' <<<"$R")
D51_T1=$(jq -r '.data.delivery.providerTaskId' <<<"$R")
# 这四个字段是工作台抽屉「运力 / 呼叫方式 / 各家报价 / 中标」四行的数据源。
# 少任何一个，那一行就只能显示「--」——首单时店员看不到是闪送接的单，根因就是它。
assert_eq "下发 callStrategy" "$(jq -r '.data.delivery.callStrategy != null' <<<"$R")" "true"
assert_eq "下发 calledProviders" "$(jq -r '.data.delivery.calledProviders != null' <<<"$R")" "true"
assert_eq "下发 orderFees（下单那一刻各家的真预扣）" "$(jq -r '.data.delivery.orderFees != null' <<<"$R")" "true"
assert_eq "下发 quoteSnapshot" "$(jq -r '.data.delivery.quoteSnapshot != null' <<<"$R")" "true"
assert_eq "下发 providerOrderId（queryCourier 认的就是它，不是 taskId）" "$(jq -r '.data.delivery.providerOrderId != null' <<<"$R")" "true"
# ⚠️ callbackSalt 是未鉴权回调路由验签的唯一防线，绝不能随 select 退化漏出去
assert_eq "callbackSalt 没有漏给前端" "$(jq -r '.data.delivery | has("callbackSalt")' <<<"$R")" "false"
D51_QUOTED=$(jq -r '.data.delivery.quotedFee' <<<"$R")
assert_eq "呼叫后 costFen = 下单预扣（尚无实扣、无小费取消费）" "$(jq -r '.data.costFen' <<<"$R")" "$D51_QUOTED"

echo "-- ③ 骑手位置：管理端也接上了（此前只有顾客端接，且传错参数从没成功过）--"
R=$(req GET "/api/admin/local/orders/$D51_O1/courier" "$AT")
assert_eq "未接单时 code 0（不报错，前端整块隐藏）" "$(code "$R")" "0"
assert_eq "未接单时无位置" "$(jq -r '.data.location' <<<"$R")" "null"
# 让骑手接单，再给一对坐标
assert_eq "回调 100 http 200" "$(kd_cb "$D51_D1" "$D51_T1" 100 '骑手已接单' '2026-09-08 13:00:00')" "200"
req POST /api/admin/system/kd100-mock/queue "$AT" "{\"op\":\"queryCourier\",\"directive\":{\"kind\":\"ok\",\"courier\":$D51_COURIER}}" >/dev/null
R=$(req GET "/api/admin/local/orders/$D51_O1/courier" "$AT")
assert_eq "拿到骑手坐标" "$(jq -r '.data.location.latE6' <<<"$R")" "29351126"
assert_eq "取货前看的是「距店多远」" "$(jq -r '.data.phase' <<<"$R")" "TO_STORE"
[[ "$(jq -r '.data.toStoreM' <<<"$R")" -gt 0 ]] && ok "算出了距店距离" || fail "距店距离缺失" "$R"
[[ "$(jq -r '.data.etaMinutes' <<<"$R")" -gt 0 ]] && ok "算出了预计到店分钟数" || fail "ETA 缺失" "$R"
assert_eq "带上位置取数时间（店员要知道这是几分钟前的）" "$(jq -r '.data.fetchedAt != null' <<<"$R")" "true"
# queryCourier 必须传 orderId——只传 taskId 会被快递100 拒 30001，而失败被 catch 吞成
# location:null，页面只是不显示卡片、不报错，于是从上线起半个月没人发现（修于 806c2a3）。
# 这条断言就是那个坑的回归护栏。
assert_eq "查位置传的是 orderId 而不是只有 taskId" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="queryCourier")] | last | .input.orderId != null')" "true"
# 20 秒进程内缓存：连打两次不该再打一次外部接口
D51_QCN=$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="queryCourier")] | length')
req GET "/api/admin/local/orders/$D51_O1/courier" "$AT" >/dev/null
assert_eq "20 秒缓存：再查一次不重复打运力方" \
  "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[] | select(.op=="queryCourier")] | length')" "$D51_QCN"

echo "-- ④ 取货后：phase 切到「距顾客多远」--"
assert_eq "回调 310 http 200" "$(kd_cb "$D51_D1" "$D51_T1" 310 '骑手已取货' '2026-09-08 13:05:00')" "200"
# 不用等缓存过期：缓存里只有坐标，phase/距离/ETA 每次都按**当前**配送单状态重算。
# （这本身也值得锁住——把 phase 一起缓存进去的话，取货后店员会有 20 秒看到「距店多远」。）
R=$(req GET "/api/admin/local/orders/$D51_O1/courier" "$AT")
assert_eq "取货后看的是「距顾客多远」" "$(jq -r '.data.phase' <<<"$R")" "TO_RECEIVER"
[[ "$(jq -r '.data.toReceiverM' <<<"$R")" != "null" ]] && ok "算出了距顾客距离" || fail "距顾客距离缺失" "$R"

echo "-- ⑤ 实扣认领后，costFen 跟着走实扣口径 --"
R=$(d51_dlv "$D51_O1")
D51_ACTUAL=$(jq -r '.data.delivery.actualFee' <<<"$R")
# 本单是 SOLO（只呼了达达），而回调说闪送中标 —— orderFees 里没有闪送，于是走
# quoteSnapshot 兜底认领。这条顺带锁住了那条兜底路径（真实场景：店员手动改呼了别家）。
[[ "$D51_ACTUAL" != "null" && "$D51_ACTUAL" != "0" ]] && ok "实扣已认领（${D51_ACTUAL} 分，来自报价快照兜底）" || fail "实扣未认领" "$R"
assert_eq "costFen 用实扣而不是下单预扣" "$(jq -r '.data.costFen' <<<"$R")" "$D51_ACTUAL"

echo "-- ⑥ 升级留下的已取消配送单，它的取消费也要计进成本合计 --"
# 这正是「只看最近一张配送单」会漏掉的那笔钱：自动升级 = 撤 D-1 建 D-2，
# D-1 上的取消费是真花出去的。
# 直接写库造一笔取消费当夹具——比真跑一次升级便宜得多，而这里要锁的只是**求和口径**
# （升级流程本身在 50-call-strategy.sh 里已经端到端跑过）。
sql "UPDATE deliveries SET cancel_fee=200 WHERE delivery_no='$D51_D1'" >/dev/null
R=$(d51_dlv "$D51_O1")
assert_eq "成本合计含取消费" "$(jq -r '.data.costFen' <<<"$R")" "$((D51_ACTUAL + 200))"

echo "-- ⑦ 顾客端骑手位置接口的响应契约不变（与管理端共用取数，但只给 location）--"
R=$(req GET "/api/orders/$D51_O1/courier" "$UT")
assert_eq "顾客端 code 0" "$(code "$R")" "0"
assert_eq "顾客端只有 location 一个字段（不漏 fetchedAt/距离给顾客）" \
  "$(jq -r '.data | keys | join(",")' <<<"$R")" "location"

req PUT /api/admin/settings/local-delivery "$AT" "$D51_ORIG" >/dev/null
