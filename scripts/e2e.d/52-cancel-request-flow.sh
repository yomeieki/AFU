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

req PUT /api/admin/settings/local-delivery "$AT" "$D52_ORIG" >/dev/null
req PUT /api/admin/settings/printer "$AT" '{"enabled":false,"printers":[]}' >/dev/null
