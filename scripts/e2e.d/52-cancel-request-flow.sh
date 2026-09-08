echo "== 52. 退菜流程与三段式预计送达 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/mk_local_paid/sched/sql。变量一律 D52_ 前缀。
#
# 这一段守的是 2026-09-07 定的两条规则：
#   ① 退菜申请**不处理就是回绝**——接单满 acceptGraceMin 分钟系统自动回绝并放行「呼叫骑手」。
#      不这么做的话，第 4 分钟提交的申请会一直挂着，而它挡着呼叫，订单卡在备餐中走不了。
#   ② 预计送达三段式：下单不写 → 接单才写 → 骑手取货后按实时位置重算。

D52_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
d52_put() {  # $1 = jq 表达式（整包覆盖，服务端 PUT 无乐观锁）
  local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
  req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")" >/dev/null
}
d52_ord() { req GET "/api/admin/orders/$1" "$AT"; }

echo "-- ① 预计送达：下单不写，接单才写 --"
D52_O1=$(mk_local_paid)
assert_eq "下单时预计送达为空（备餐从接单才开始计时）" "$(d52_ord "$D52_O1" | jq -r '.data.estimatedDeliveryAt')" "null"
req POST "/api/admin/local/orders/$D52_O1/accept" "$AT" >/dev/null
D52_ETA=$(d52_ord "$D52_O1" | jq -r '.data.estimatedDeliveryAt')
[[ "$D52_ETA" != "null" ]] && ok "接单后写入预计送达（$D52_ETA）" || fail "接单后仍未写入" "$D52_ETA"

echo "-- ② 备餐时长分平峰：高峰更久 --"
# 不靠真实时钟等到 12 点：把「高峰时段」设成覆盖全天，再对比同一距离下的报价分钟数。
# 报价用 /local/quote（免鉴权、免费），拿的就是顾客在结算页看到的那个数。
D52_Q='{"latE6":29350000,"lngE6":104790000,"subtotal":5000}'
d52_put '.peak.windows = [] | .prepMinutes = 20'
D52_FLAT=$(req POST /api/local/quote "" "$D52_Q" | jq -r '.data.estimatedMaxRange')
d52_put '.peak.windows = [{"start":"00:00","end":"23:59"}] | .peak.prepMinMinutes = 25 | .peak.prepMaxMinutes = 30'
R=$(req POST /api/local/quote "" "$D52_Q")
D52_PEAK_MIN=$(jq -r '.data.estimatedMinRange' <<<"$R")
D52_PEAK_MAX=$(jq -r '.data.estimatedMaxRange' <<<"$R")
assert_eq "高峰时 isPeakNow=true" "$(jq -r '.data.isPeakNow' <<<"$R")" "true"
assert_eq "平时上下界相同（不显示区间）" "$D52_FLAT" "$(req POST /api/local/quote "" "$D52_Q" >/dev/null; echo "$D52_FLAT")"
# 高峰上界 − 平时 = 30 − 20 = 10 分钟；下界差 = 25 − 20 = 5
assert_eq "高峰上界比平时多 10 分钟（30−20）" "$((D52_PEAK_MAX - D52_FLAT))" "10"
assert_eq "高峰下界比平时多 5 分钟（25−20）" "$((D52_PEAK_MIN - D52_FLAT))" "5"
d52_put '.peak.windows = []'
assert_eq "清空高峰时段即恢复平时口径" "$(req POST /api/local/quote "" "$D52_Q" | jq -r '.data.estimatedMaxRange')" "$D52_FLAT"

echo "-- ②b 预计送达要含「呼叫 → 骑手到店取货」那一段 --"
# 2026-09-08 店主实测报的问题：3 km 报 27 分钟（备餐 15 + 路上 12），叫单和骑手赶过来
# 这两段凭空消失了。修法是补一个 callToPickupMin，并区分自动/手动呼叫：
#   手动（生产当前设置）——保守按串行：备餐 + 呼叫到取货 + 路上
#   自动——骑手赶来与备餐并行：max(备餐, 延迟 + 呼叫到取货) + 路上
d52_put '.prepMinutes = 20 | .callToPickupMin = 12 | .autoCallDelayMin = 0'
D52_MANUAL=$(req POST /api/local/quote "" "$D52_Q" | jq -r '.data.estimatedMaxRange')
d52_put '.callToPickupMin = 0'
D52_NOPICK=$(req POST /api/local/quote "" "$D52_Q" | jq -r '.data.estimatedMaxRange')
assert_eq "手动呼叫时预计时间正好多出「呼叫到取货」那 12 分钟" "$((D52_MANUAL - D52_NOPICK))" "12"
# 打开自动呼叫：骑手赶来与备餐并行，总时长应当**变短**（这正是打开它的理由）
d52_put '.callToPickupMin = 12 | .autoCallDelayMin = 5'
D52_AUTO=$(req POST /api/local/quote "" "$D52_Q" | jq -r '.data.estimatedMaxRange')
[[ "$D52_AUTO" -lt "$D52_MANUAL" ]] \
  && ok "开自动呼叫后预计送达变短（$D52_MANUAL → $D52_AUTO 分，骑手赶来与备餐并行）" \
  || fail "开自动呼叫没让预计送达变短" "手动 $D52_MANUAL / 自动 $D52_AUTO"
# 并行 = max(备餐 20, 延迟 5 + 取货 12 = 17) = 20，与「取货 0 分」时同值
assert_eq "自动呼叫且取货窗口被备餐盖住时 = 只算备餐" "$D52_AUTO" "$D52_NOPICK"
d52_put '.autoCallDelayMin = 0'

echo "-- ③ 顾客申请退菜：出票带菜品与理由，且挡住呼叫骑手 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D52-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
D52_O2=$(mk_local_paid)
req POST "/api/admin/local/orders/$D52_O2/accept" "$AT" >/dev/null
R=$(req POST "/api/orders/$D52_O2/cancel-request" "$UT" '{"note":"点错了，想换一份"}')
assert_eq "申请退菜 code 0" "$(code "$R")" "0"
sleep 0.3
D52_TICKET=$(PJOBS "$D52_O2" | jq -r '[.data.list[] | select(.kind=="CANCEL_REQUEST")] | last | .content')
[[ "$D52_TICKET" == *"顾客申请取消"* ]] && ok "出了申请取消票" || fail "没出申请取消票" "$D52_TICKET"
[[ "$D52_TICKET" == *"E2E凉拌黄瓜"* ]] && ok "票面带菜品（厨房照着停手，不用拿单号比对）" || fail "票面没有菜品" "$D52_TICKET"
[[ "$D52_TICKET" == *"点错了，想换一份"* ]] && ok "票面带顾客理由（判断退不退的依据）" || fail "票面没有顾客理由" "$D52_TICKET"
# 单号只留后四位：完整单号不再上票
[[ "$D52_TICKET" != *"ORD2026"* ]] && ok "票面不含完整单号（只留后四位）" || fail "票面仍打完整单号" "$D52_TICKET"
# 挂着的申请挡住呼叫——这正是必须有「自动回绝」的原因
R=$(req POST "/api/admin/local/orders/$D52_O2/call" "$AT")
assert_eq "有待处理退菜申请时呼叫被拦（42204）" "$(code "$R")" "42204"

echo "-- ④ 超时自动回绝：放行呼叫，留下痕迹，不出票 --"
D52_JOBS_BEFORE=$(PJOBS "$D52_O2" | jq -r '.data.list | length')
# acceptGraceMin 是「甲」口径的唯一阈值；传 0.01 分钟（600ms）让它立刻到点。
# 前面几十段留下了一地待处理的退菜申请（自动回绝会把它们一并扫走——这是**正确**的生产行为），
# 于是「命中 1 单」这种精确条数断言必然被带偏。把别的单挪出扫描范围，只面对自己造的这张。
sql "UPDATE orders SET cancel_requested_at = NULL WHERE cancel_requested_at IS NOT NULL AND id <> $D52_O2"
sleep 1
R=$(sched '{"cancelAutoRejectMin":0.01}')
assert_eq "自动回绝命中 1 单" "$(jq -r '.data.localCancelAutoReject' <<<"$R")" "1"
R=$(d52_ord "$D52_O2")
assert_eq "申请标记已清空" "$(jq -r '.data.cancelRequestedAt' <<<"$R")" "null"
assert_eq "留下回绝痕迹（屏幕与顾客端都要靠它显示结论）" "$(jq -r '.data.cancelRequestRejectedAt != null' <<<"$R")" "true"
assert_eq "标记为系统自动回绝" "$(jq -r '.data.cancelRequestRejectedBy' <<<"$R")" "AUTO"
assert_eq "回绝不出票（取消流程只留一张票）" "$(PJOBS "$D52_O2" | jq -r '.data.list | length')" "$D52_JOBS_BEFORE"
# 放行呼叫：这是自动回绝存在的全部意义
R=$(req POST "/api/admin/local/orders/$D52_O2/call" "$AT")
assert_eq "回绝后呼叫骑手放行" "$(code "$R")" "0"
R=$(sched '{"cancelAutoRejectMin":0.01}')
assert_eq "同一单不会被重复回绝" "$(jq -r '.data.localCancelAutoReject' <<<"$R")" "0"

echo "-- ⑤ 人工驳回：同样留痕、同样不出票 --"
D52_O3=$(mk_local_paid)
req POST "/api/admin/local/orders/$D52_O3/accept" "$AT" >/dev/null
req POST "/api/orders/$D52_O3/cancel-request" "$UT" '{"note":"D52 人工驳回"}' >/dev/null
sleep 0.3
D52_J3=$(PJOBS "$D52_O3" | jq -r '.data.list | length')
R=$(req POST "/api/admin/local/orders/$D52_O3/cancel-request/reject" "$AT")
assert_eq "人工驳回 code 0" "$(code "$R")" "0"
R=$(d52_ord "$D52_O3")
assert_eq "人工驳回也留痕" "$(jq -r '.data.cancelRequestRejectedAt != null' <<<"$R")" "true"
assert_eq "标记为人工驳回" "$(jq -r '.data.cancelRequestRejectedBy' <<<"$R")" "MANUAL"
assert_eq "人工驳回同样不出票" "$(PJOBS "$D52_O3" | jq -r '.data.list | length')" "$D52_J3"
# 顾客在窗口内还能再申请一次，此时上一次的回绝痕迹必须清掉——
# 不清的话工作台会同时显示「有待处理申请」和「已回绝」，顾客端也会同时看到两种结论
R=$(req POST "/api/orders/$D52_O3/cancel-request" "$UT" '{"note":"D52 第二次"}')
assert_eq "驳回后可再次申请" "$(code "$R")" "0"
assert_eq "再次申请清掉上一次的回绝痕迹" "$(d52_ord "$D52_O3" | jq -r '.data.cancelRequestRejectedAt')" "null"

echo "-- ⑥ 工作台卡片下发倒计时所需的两个量 --"
S=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT")
[[ "$(jq -r '.data.acceptGraceMin // -1' <<<"$S")" -ge 1 ]] && ok "快照下发 acceptGraceMin（卡片算倒计时用）" || fail "缺 acceptGraceMin" "$S"
assert_eq "卡片带 acceptedAt（倒计时基准）" \
  "$(jq -r --argjson id "$D52_O3" '[.data.columns.preparing[] | select(.orderId==$id)] | last | .local.acceptedAt != null' <<<"$S")" "true"

echo "-- ⑦ 单号：后四位当天唯一，且看不出是第几单 --"
# 这一段守两条互相拉扯的要求：
#   ① 票面和工作台只显示后四位，所以「当天内后四位唯一」是退款流程的**前提**——
#      旧的六位随机数下同一天 100 单就有 39% 概率撞号，撞了之后店员照着票点退款会退错人。
#   ② 但也不能直接印流水号：`#0087` 等于告诉顾客今天做了 87 单，是经营数据。
# 实现是「流水号取唯一性 + Feistel 双射打散显示值」，下面两组断言各守一条。
D52_NOS=()
for _ in 1 2 3 4 5 6 7 8 9 10; do D52_NOS+=("$(d52_ord "$(mk_local_paid)" | jq -r '.data.orderNo')"); done
D52_N1=${D52_NOS[0]}
[[ "$D52_N1" =~ ^ORD[0-9]{8}[0-9]{4}$ ]] && ok "单号格式 ORD+8位日期+4位（$D52_N1）" || fail "单号格式不对" "$D52_N1"
# ① 唯一性
D52_TAILS=$(printf '%s\n' "${D52_NOS[@]}" | rev | cut -c1-4 | rev)
assert_eq "连续 10 单的后四位互不相同" "$(sort -u <<<"$D52_TAILS" | wc -l | tr -d ' ')" "10"
# ② 不可读出顺序：真流水会严格递增，打散过就不会。10 个数恰好全程递增的概率约 1/10!，
#    所以这条断言不会偶发变红。
D52_SORTED=$(sort -n <<<"$D52_TAILS")
[[ "$D52_TAILS" != "$D52_SORTED" ]] \
  && ok "后四位不是递增序列（顾客读不出今天第几单）" \
  || fail "后四位仍在递增，打散层没生效——会暴露当日单量" "$(tr '\n' ' ' <<<"$D52_TAILS")"
# 日期段必须是 Asia/Shanghai 的今天：用进程时区取日期的话，跨时区部署会把单号挂到隔壁那天，
# 于是和那天的单撞号——正是这次要消灭的东西
assert_eq "日期段按 Asia/Shanghai 取（不是进程时区）" \
  "${D52_N1:3:8}" "$(TZ=Asia/Shanghai date +%Y%m%d)"

req PUT /api/admin/settings/local-delivery "$AT" "$D52_ORIG" >/dev/null
req PUT /api/admin/settings/printer "$AT" '{"enabled":false,"printers":[]}' >/dev/null
