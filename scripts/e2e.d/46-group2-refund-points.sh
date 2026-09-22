echo "== 46. 退款与积分回归（组二：R3/R6/R10/R11）=="
# 本文件复用 §36 定义的 sql()/m1_login()/m1_completed_order()（同一个 shell，本文件被
# e2e.sh 尾部的 source 循环拉进来，函数与变量仍在作用域内）。变量名统一加 G2_ 前缀，
# 避免与已有分片（40-45 用了 A/B/C/D/H 前缀）以及主脚本自身的 R1/R2 全局变量撞车。
ORIG_MEMBER_SETTINGS_46=$(req GET /api/admin/settings/member "$AT" | jq -c .data)
ORIG_PRINTER_SETTINGS_46=$(req GET /api/admin/settings/printer "$AT" | jq -c .data)
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":1,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null

G2_TAG=$RANDOM

echo "-- R3：finalizeRefundSuccess 事务头两句改锁定读（FOR UPDATE），不创建 read view --"
# 真并发竞态（两个 MySQL 会话按不同语句顺序建 read view）无法在这个单线程 bash 脚本里可靠
# 复现——这条与 H1 同类，只能靠两会话手工实验或代码复核验证。已实测过（见
# docs/superpowers/notes/2026-09-05-review-round2.md 的「一、我实测/核实过的三条」）：
# 第一句普通读时，事务内第二次读到的是并发提交前的旧快照；第一句 FOR UPDATE 时，
# 另一会话会被阻塞直到本事务提交。本次修复把 services/refund.ts 的 finalizeRefundSuccess
# 改成头两句 `SELECT ... FOR UPDATE`（refunds→orders），与 settlePoints 的
# `SELECT ... FOR UPDATE` 打头对称。这里只做一个「不改变正常行为」的弱回归：确认改造后
# 退款流程本身（含积分扣回）仍然功能正常——真正的锁序验证见报告里的两会话实验复述。
# （R3 的复现结论见 docs/superpowers/notes/2026-09-05-review-round2.md；
#   原来这里是一条无条件 ok，只给 PASS 计数 +1、什么都没验，已删）

echo "-- R3 弱回归：finalizeRefundSuccess 改造后，退款仍正确扣回积分（功能不退化）--"
IFS=$'\t' read -r G2R3_TOKEN G2R3_UID < <(m1_login "a${G2_TAG}G2R3")
[[ -n "$G2R3_TOKEN" ]] && ok "R3 回归用户登录" || fail "R3 回归用户登录失败"
G2R3_ADDR=$(req POST /api/addresses "$G2R3_TOKEN" '{"receiverName":"G2R3","receiverPhone":"13900001001","province":"四川省","city":"自贡市","district":"自流井区","detail":"G2R3测试地址","isDefault":1}' | jq -r .data.id)
G2R3_O1=$(m1_completed_order "$G2R3_TOKEN" "$G2R3_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
G2R3_EARNED=$(sql "SELECT points_earned FROM orders WHERE id=$G2R3_O1;")
assert_eq "R3 回归前置：结算得 100 分" "$G2R3_EARNED" "100"
R=$(req POST "/api/admin/orders/$G2R3_O1/refund" "$AT" '{"amount":10000,"reason":"R3回归全额退款"}')
assert_eq "R3 回归：全额退款请求成功" "$(code "$R")" "0"
G2R3_BAL=$(sql "SELECT points_balance FROM users WHERE id=$G2R3_UID;")
assert_eq "R3 回归：全额退款后积分扣回至 0（锁序改造未破坏既有扣回逻辑）" "$G2R3_BAL" "0"

echo "-- R6：expirePointsBatch 返回 {scanned,processed}，runMemberDailyTask 按 scanned 判断是否还有下一轮 --"
# M13 描述的「候选选出之后、自己的处理事务执行之前被 extendLivePoints 续期救回」是亚秒级竞态，
# 无法在这个单线程 bash 脚本里可靠复现（时序依赖真实并发）——已用一个独立脚本（不提交，
# monkeypatch prisma.pointsLedger.findMany 在候选选出的瞬间同步注入一次续期 UPDATE，
# 确定性复现，不依赖 wall-clock 运气）跑过端到端真实验证，结果见报告：
#   插 8 条到期候选，其中 1 条在候选选出后立即被续期救回；dailyTaskBatchLimit=5：
#   round1 scanned=5 processed=4（1 条被救回）；round2 scanned=3 processed=3；
#   端到端 runSchedulerTick 返回总处理数=7；按旧规则(processed<limit 判断退出)本该在
#   round1 后就以总数=4 收工（H9 想解决的「一天只清一批」问题原样保留）；
#   按新规则(scanned<limit)正确处理满 7 条，只留真正被救回的那 1 条给下一天扫描。
# （R6 的复现结论见 docs/superpowers/notes/2026-09-05-review-round2.md；
#   原来这里是一条无条件 ok，只给 PASS 计数 +1、什么都没验，已删）

# 这里补一个不依赖竞态、纯粹回归 H9 既有行为的断言：>limit 条到期候选、无外部干扰时，
# 一次 tick 仍能循环处理完全部候选（与 43-daily-task-loop.sh 的 H9 断言同源，
# 确认 R6 的返回形状改造没有破坏 H9 的循环退出条件）。
IFS=$'\t' read -r G2R6_TOKEN G2R6_UID < <(m1_login "a${G2_TAG}G2R6")
[[ -n "$G2R6_TOKEN" ]] && ok "R6 回归测试用户登录" || fail "R6 回归测试用户登录失败"
for i in 1 2 3 4 5 6; do
  sql "INSERT INTO points_ledgers (user_id, type, delta, balance_after, remaining, ref_type, ref_id, expires_at, created_at)
       VALUES ($G2R6_UID, 'EARN', 10, $((i*10)), 10, 'ORDER', 'g2r6-${G2_TAG}-$i', DATE_SUB(NOW(), INTERVAL 1 DAY), NOW());"
done
sql "UPDATE users SET points_balance = points_balance + 60 WHERE id=$G2R6_UID;"
# ⚠️ 这里刻意**不**断言 `.data.expirePoints`——它是 expirePointsBatch 的**全库**计数，
# 会被前面分片（如 43 插的 205 条）的残留污染。2026-09-06 实测过一次：回退 H9 的循环之后，
# 43 只处理 200 条剩下 5 条，本段的全库计数就变成 5+6=11 而不是 6，断言转红，
# 但失败文案写的是「R6 回归：一次 tick 循环处理完全部 6 条」——**把排查引到完全无关的方向**。
# 只按 user_id 过滤断言自己造的那 6 条，下面那条就够了。
req POST /api/admin/system/run-scheduler "$AT" '{"forceDailyMemberTasks":true,"dailyTaskBatchLimit":2}' >/dev/null
G2R6_LIVE_AFTER=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$G2R6_UID AND ref_id LIKE 'g2r6-${G2_TAG}-%' AND remaining=0;")
assert_eq "R6 回归：6 条全部 remaining=0" "$G2R6_LIVE_AFTER" "6"

echo "-- R10：微信同步返回 ABNORMAL 时订单停在 REFUNDING，CANCEL 票已出（挂在「决定退款」而非「钱真的退到」）--"
# e2e.sh 跑在 WECHAT_PAY_MOCK=true 的服务器上，initiateRefund 里 mode 恒为 MOCK，
# 永远走不到「微信同步返回 ABNORMAL/CLOSED」那个分支（config.mock.pay 是进程启动时定死的
# 环境变量，没有能从 HTTP 层面临时切换到真实 WECHAT 分支的开关）——这条缺陷没法通过这台
# mock 服务器的 HTTP 接口复现。已用一个独立脚本（不提交，直接 import 生产代码、强制
# config.mock.pay=false、monkeypatch global.fetch 让「微信」同步返回 ABNORMAL，走的是真实
# initiateRefund 实现而非假模拟）跑过前后对比，结果见报告：
#   造一笔 COMPLETED/WECHAT 已支付订单，发起全额退款，微信同步返回 ABNORMAL：
#   订单停在 REFUNDING、退款单状态 ABNORMAL；CANCEL 出票数——临时禁用本次新增的
#   fire-and-forget 调用（模拟修复前代码）复现为 0，恢复后为 1。
# （R10 的复现结论见 docs/superpowers/notes/2026-09-05-review-round2.md；
#   原来这里是一条无条件 ok，只给 PASS 计数 +1、什么都没验，已删）

echo "-- R10 弱回归：MOCK 模式下全额退款仍然只出恰好 1 条 CANCEL（新增的提前出票与 finalize 那次去重正常）--"
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"E2E-G2","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
G2R10_O1=$(pay_new_order "$PID" "$ADDR")
[[ -n "$G2R10_O1" ]] && ok "R10 回归造单并支付 #$G2R10_O1" || fail "R10 回归造单失败"
req POST "/api/admin/orders/$G2R10_O1/accept" "$AT" >/dev/null
sleep 0.3
G2R10_AMOUNT=$(req GET "/api/admin/orders/$G2R10_O1" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$G2R10_O1/refund" "$AT" "{\"amount\":$G2R10_AMOUNT,\"reason\":\"R10回归全额退款\"}")
assert_eq "R10 回归：全额退款成功" "$(code "$R")" "0"
sleep 0.3
assert_eq "R10 回归：MOCK 模式全额退款仍恰好 1 条 CANCEL（提前出票与 finalize 出票去重正常）" \
  "$(jq -r '[.data.list[] | select(.kind=="CANCEL")] | length' <<<"$(req GET "/api/admin/print-jobs?orderId=$G2R10_O1" "$AT")")" "1"

# R11（人工标记退款完成漏扣积分）用例已随 refund-complete 端点一起删除（2026-09-22）

# 收尾：还原打印机/会员设置、删掉本段创建的测试地址
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req PUT /api/admin/settings/printer "$AT" "$ORIG_PRINTER_SETTINGS_46" >/dev/null
req PUT /api/admin/settings/member "$AT" "$ORIG_MEMBER_SETTINGS_46" >/dev/null
req DELETE "/api/addresses/$G2R3_ADDR" "$G2R3_TOKEN" >/dev/null
