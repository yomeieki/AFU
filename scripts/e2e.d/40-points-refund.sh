echo "== 40. 退款 × 积分（A 组：B7/H1/B5/B1/H7/M5/M13）=="
# 本文件复用 §36 定义的 sql()/m1_login()/m1_completed_order()/PID/ADDR/UT（同一个 shell，
# 本文件被 e2e.sh 尾部的 source 循环拉进来，函数与变量仍在作用域内）。
# 备份/还原全局会员设置与打印机设置，避免影响本轮之后的段落与其他并行联调。
ORIG_MEMBER_SETTINGS_40=$(req GET /api/admin/settings/member "$AT" | jq -c .data)
ORIG_PRINTER_SETTINGS_40=$(req GET /api/admin/settings/printer "$AT" | jq -c .data)

req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":1,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null

A40_TAG=$RANDOM

echo "-- B7：滚动续期只增不减（补发旧单 / 调短有效期都不能把到期日往前拽）--"
IFS=$'\t' read -r A40A A40A_UID < <(m1_login "a${A40_TAG}A_refund")
[[ -n "$A40A" ]] && ok "B7 测试用户 A 登录" || fail "B7 测试用户 A 登录失败"
A40A_ADDR=$(req POST /api/addresses "$A40A" '{"receiverName":"A40会员A","receiverPhone":"13900000001","province":"四川省","city":"自贡市","district":"自流井区","detail":"A40测试地址A","isDefault":1}' | jq -r .data.id)

# B7-1：今天完成并结算一单（A1），再造一张 6 天前完成、从未结算的旧单（A0），
# 用 settleMissedPointsAfterMin:0 的 7 天回溯窗口把它捡回来补发。
A40_O_A1=$(m1_completed_order "$A40A" "$A40A_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
EXP_A1_BEFORE=$(sql "SELECT expires_at FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_A1' AND type='EARN';")
[[ -n "$EXP_A1_BEFORE" ]] && ok "B7-1：A1 已结算，到期日=$EXP_A1_BEFORE" || fail "B7-1：A1 结算失败，取不到到期日"

A40_O_A0=$(m1_completed_order "$A40A" "$A40A_ADDR" 10000)
sql "UPDATE orders SET completed_at=DATE_SUB(NOW(), INTERVAL 6 DAY) WHERE id=$A40_O_A0;"
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
EXP_A1_AFTER=$(sql "SELECT expires_at FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_A1' AND type='EARN';")
EXP_A0=$(sql "SELECT expires_at FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_A0' AND type='EARN';")
assert_eq "B7-1：补发 6 天前的旧单后，A1 的到期日不变（不被往前拽）" "$EXP_A1_AFTER" "$EXP_A1_BEFORE"
assert_eq "B7-1：旧单(A0)新建的 EARN 行到期日 == A1（全账户同一天过期）" "$EXP_A0" "$EXP_A1_BEFORE"

# B7-2：调短 validDays 到 90 后再消费一单，旧行不能被拉近，新行也要贴着旧行的更晚日期走
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":1,"validDays":90},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null
A40_O_A2=$(m1_completed_order "$A40A" "$A40A_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
EXP_A1_AFTER2=$(sql "SELECT expires_at FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_A1' AND type='EARN';")
EXP_A2=$(sql "SELECT expires_at FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_A2' AND type='EARN';")
assert_eq "B7-2：调短 validDays=90 后，旧行到期日仍未被拉近" "$EXP_A1_AFTER2" "$EXP_A1_BEFORE"
assert_eq "B7-2：新行到期日 == max(now+90, 旧行到期日) == 旧行到期日（旧行更晚）" "$EXP_A2" "$EXP_A1_BEFORE"
A40_SUMMARY=$(req GET /api/member/summary "$A40A")
assert_eq "B7-2：/member/summary 余额 = 三单之和 300" "$(jq -r .data.pointsBalance <<<"$A40_SUMMARY")" "300"
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":1,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null

echo "-- B5：退款扣回按累计目标摊，与 earnRatePerYuan 无关（修复前逐笔 floor 会少扣/多扣）--"
IFS=$'\t' read -r A40B A40B_UID < <(m1_login "a${A40_TAG}B_refund")
[[ -n "$A40B" ]] && ok "B5 测试用户 B 登录" || fail "B5 测试用户 B 登录失败"
A40B_ADDR=$(req POST /api/addresses "$A40B" '{"receiverName":"A40会员B","receiverPhone":"13900000002","province":"四川省","city":"自贡市","district":"自流井区","detail":"A40测试地址B","isDefault":1}' | jq -r .data.id)

# B5-1：rate=1 时结算得 100 分，随后把 rate 改成 100（新单才生效，不影响本单的 pointsBase/pointsEarned），
# 退 ¥1 应扣 1 分——如果按当前比例（清单原修法之前的 bug）会扣光整单 100 分。
A40_O_B1=$(m1_completed_order "$A40B" "$A40B_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
EARNED_B1=$(sql "SELECT points_earned FROM orders WHERE id=$A40_O_B1;")
assert_eq "B5 前置：B1 单结算得 100 分" "$EARNED_B1" "100"
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":100,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null
R=$(req POST "/api/admin/orders/$A40_O_B1/refund" "$AT" '{"amount":100,"reason":"B5-1退1元"}')
assert_eq "B5-1：退 ¥1 请求成功" "$(code "$R")" "0"
REFUND_ID_B1=$(jq -r .data.refund.id <<<"$R")
DELTA_B1=$(sql "SELECT delta FROM points_ledgers WHERE type='REFUND_DEDUCT' AND ref_type='REFUND' AND ref_id='$REFUND_ID_B1';")
BAL_AFTER_B1=$(sql "SELECT points_balance FROM users WHERE id=$A40B_UID;")
assert_eq "B5-1：rate 改成 100 后，退 ¥1 只扣 1 分（不是扣光 100 分）" "$DELTA_B1" "-1"
assert_eq "B5-1：余额剩 99" "$BAL_AFTER_B1" "99"

# B5-2：分三次退 ¥33/33/33（与 B5-1 的 ¥1 合计打满 ¥100），累计扣回必须恰好补满到 100，
# 不能像逐笔 floor 那样永远差 1 分。
R=$(req POST "/api/admin/orders/$A40_O_B1/refund" "$AT" '{"amount":3300,"reason":"B5-2退33元(1/3)"}')
assert_eq "B5-2：第 1 次退 ¥33 成功" "$(code "$R")" "0"
BAL_1=$(sql "SELECT points_balance FROM users WHERE id=$A40B_UID;")
R=$(req POST "/api/admin/orders/$A40_O_B1/refund" "$AT" '{"amount":3300,"reason":"B5-2退33元(2/3)"}')
assert_eq "B5-2：第 2 次退 ¥33 成功" "$(code "$R")" "0"
BAL_2=$(sql "SELECT points_balance FROM users WHERE id=$A40B_UID;")
R=$(req POST "/api/admin/orders/$A40_O_B1/refund" "$AT" '{"amount":3300,"reason":"B5-2退33元(3/3，退满)"}')
assert_eq "B5-2：第 3 次退 ¥33 成功（该单已退满 ¥100）" "$(code "$R")" "0"
BAL_3=$(sql "SELECT points_balance FROM users WHERE id=$A40B_UID;")
assert_eq "B5-2：三次部分退款序列 99→66→33→0（累计口径，逐笔 floor 会停在 1）" "$BAL_1:$BAL_2:$BAL_3" "66:33:0"

# B5-3：结算之前先部分退款，pointsBase 要用锁后读到的 actualAmount-refundedAmount，
# 而不是 actualAmount 本身——否则退款前发生的退款会被算漏，摊出来的比例偏高。
# 把 rate 从 B5-1/B5-2 用的 100 改回 1，不然本段（以及之后的 H1/M5/H7 段）会按 100 结算，算错。
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":1,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null
IFS=$'\t' read -r A40C A40C_UID < <(m1_login "a${A40_TAG}C_refund")
[[ -n "$A40C" ]] && ok "B5-3 测试用户 C 登录" || fail "B5-3 测试用户 C 登录失败"
A40C_ADDR=$(req POST /api/addresses "$A40C" '{"receiverName":"A40会员C","receiverPhone":"13900000003","province":"四川省","city":"自贡市","district":"自流井区","detail":"A40测试地址C","isDefault":1}' | jq -r .data.id)
A40_O_C1=$(m1_completed_order "$A40C" "$A40C_ADDR" 10000)  # COMPLETED，但故意不先结算
R=$(req POST "/api/admin/orders/$A40_O_C1/refund" "$AT" '{"amount":4000,"reason":"B5-3结算前先退40元"}')
assert_eq "B5-3：结算前先退 ¥40 成功" "$(code "$R")" "0"
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
PBASE_C1=$(sql "SELECT points_base FROM orders WHERE id=$A40_O_C1;")
PEARN_C1=$(sql "SELECT points_earned FROM orders WHERE id=$A40_O_C1;")
assert_eq "B5-3：pointsBase = 实付100元-已退40元 = 6000分" "$PBASE_C1" "6000"
assert_eq "B5-3：pointsEarned 按 6000 分基数算，得 60 分" "$PEARN_C1" "60"
R=$(req POST "/api/admin/orders/$A40_O_C1/refund" "$AT" '{"amount":6000,"reason":"B5-3退完剩下的60元"}')
assert_eq "B5-3：退完剩下 ¥60 成功（该单退满）" "$(code "$R")" "0"
BAL_C_FINAL=$(sql "SELECT points_balance FROM users WHERE id=$A40C_UID;")
assert_eq "B5-3：退满后累计扣回恰好 60，余额清零" "$BAL_C_FINAL" "0"

echo "-- H1：settle 与部分退款并发（真实竞争在 bash e2e 里无法可靠复现，见报告说明；这里跑串行替代）--"
# 串行替代（计划 §3 A 组表格 H1-1 原样）：settle 之后绕开退款接口直接改 refunded_amount，
# 确认 pointsSettledAt 已置位的单不会被兜底任务重新扫描、不会重发流水——
# 这条验的是「已结算」守卫的幂等性，不是并发互斥本身；真正的并发互斥（FOR UPDATE 锁顺序）
# 只能靠 opus 代码复核确认，理由见报告正文。
IFS=$'\t' read -r A40D A40D_UID < <(m1_login "a${A40_TAG}D_h1")
[[ -n "$A40D" ]] && ok "H1 测试用户 D 登录" || fail "H1 测试用户 D 登录失败"
A40D_ADDR=$(req POST /api/addresses "$A40D" '{"receiverName":"A40会员D","receiverPhone":"13900000004","province":"四川省","city":"自贡市","district":"自流井区","detail":"A40测试地址D","isDefault":1}' | jq -r .data.id)
A40_O_D1=$(m1_completed_order "$A40D" "$A40D_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
LEDGER_D1_BEFORE=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_D1';")
sql "UPDATE orders SET refunded_amount=5000 WHERE id=$A40_O_D1;"  # 绕开退款流程直接改字段，模拟"回调已经改过refundedAmount"
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
LEDGER_D1_AFTER=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_D1';")
assert_eq "H1-1：pointsSettledAt 已置位的单，refundedAmount 被绕过流程改动后重扫不会重发流水" "$LEDGER_D1_AFTER" "$LEDGER_D1_BEFORE"

echo "-- M5：退款扣回只从在世行扣，不碰到期未清扫的死行 --"
IFS=$'\t' read -r A40E A40E_UID < <(m1_login "a${A40_TAG}E_m5")
[[ -n "$A40E" ]] && ok "M5 测试用户 E 登录" || fail "M5 测试用户 E 登录失败"
A40E_ADDR=$(req POST /api/addresses "$A40E" '{"receiverName":"A40会员E","receiverPhone":"13900000005","province":"四川省","city":"自贡市","district":"自流井区","detail":"A40测试地址E","isDefault":1}' | jq -r .data.id)
A40_O_E1=$(m1_completed_order "$A40E" "$A40E_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
# 把 E1 自己那条 EARN 行手工改成"昨天到期"，制造一条已死但未被 expirePointsBatch 清扫的行
sql "UPDATE points_ledgers SET expires_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE ref_type='ORDER' AND ref_id='$A40_O_E1' AND type='EARN';"
A40_O_E2=$(m1_completed_order "$A40E" "$A40E_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
REM_E1_BEFORE=$(sql "SELECT remaining FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_E1' AND type='EARN';")
assert_eq "M5 前置：E1 那行 remaining 仍是 100（只是到期未清扫，没被清零）" "$REM_E1_BEFORE" "100"
# 对 E1（自己的 EARN 行已死）发起退款：修复前会优先扣 E1 自己那条死行；
# 修复后应该跳过死行，改从 E2 的在世行扣。
R=$(req POST "/api/admin/orders/$A40_O_E1/refund" "$AT" '{"amount":5000,"reason":"M5退50元"}')
assert_eq "M5：对 E1（自己 EARN 行已死）退 ¥50 成功" "$(code "$R")" "0"
REM_E1_AFTER=$(sql "SELECT remaining FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_E1' AND type='EARN';")
REM_E2_AFTER=$(sql "SELECT remaining FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$A40_O_E2' AND type='EARN';")
assert_eq "M5：E1 自己那条到期死行 remaining 不变（100，没被扣）" "$REM_E1_AFTER" "$REM_E1_BEFORE"
assert_eq "M5：扣的是 E2 的在世行（100→50）" "$REM_E2_AFTER" "50"

echo "-- H7：/member/summary 余额不含已到期但未清扫的积分 --"
IFS=$'\t' read -r A40F A40F_UID < <(m1_login "a${A40_TAG}F_h7")
[[ -n "$A40F" ]] && ok "H7 测试用户 F 登录" || fail "H7 测试用户 F 登录失败"
A40F_ADDR=$(req POST /api/addresses "$A40F" '{"receiverName":"A40会员F","receiverPhone":"13900000006","province":"四川省","city":"自贡市","district":"自流井区","detail":"A40测试地址F","isDefault":1}' | jq -r .data.id)
A40_O_F1=$(m1_completed_order "$A40F" "$A40F_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
BAL_F_RAW_BEFORE=$(sql "SELECT points_balance FROM users WHERE id=$A40F_UID;")
assert_eq "H7 前置：F 的冗余列 points_balance=100" "$BAL_F_RAW_BEFORE" "100"
# 不跑 expirePoints，只手工把这条在世行的 expires_at 改到昨天——模拟"到期但还没被每日任务清扫"的窗口
sql "UPDATE points_ledgers SET expires_at=DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE ref_type='ORDER' AND ref_id='$A40_O_F1' AND type='EARN';"
SUMMARY_F=$(req GET /api/member/summary "$A40F")
assert_eq "H7：summary.pointsBalance 已排除到期未清扫的分（不是冗余列的 100，是 0）" "$(jq -r .data.pointsBalance <<<"$SUMMARY_F")" "0"
R=$(req POST /api/member/points/redeem "$A40F" "{\"templateId\":$TPL_DRAIN}")
assert_eq "H7：redeem 认为余额不足，返回 42250（与 summary 显示口径一致）" "$(code "$R")" "42250"
req POST /api/admin/system/run-scheduler "$AT" '{"forceDailyMemberTasks":true}' >/dev/null
SUMMARY_F2=$(req GET /api/member/summary "$A40F")
assert_eq "H7：跑完 expirePoints 后 pointsBalance 仍是 0（不变）" "$(jq -r .data.pointsBalance <<<"$SUMMARY_F2")" "0"

req PUT /api/admin/settings/member "$AT" "$ORIG_MEMBER_SETTINGS_40" >/dev/null

echo "-- B1：CANCEL 出票下沉进 finalizeRefundSuccess（覆盖后台一键退款/售后同意；不动自助取消/拒单的既有出票调用点）--"
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"E2E-A40","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
PJOBS_A40() { req GET "/api/admin/print-jobs?orderId=$1" "$AT"; }

# B1-1：后台「退款」Tab 全额退款，订单在 PREPARING（未走过退款回调/自助取消/拒单——这几条
# 早就各自出过 CANCEL 票的路径），修复前这条路径永远不出 CANCEL 票。
B1_O1=$(pay_new_order "$PID" "$ADDR")
[[ -n "$B1_O1" ]] && ok "B1-1 造单并支付 #$B1_O1" || fail "B1-1 造单失败"
req POST "/api/admin/orders/$B1_O1/accept" "$AT" >/dev/null
sleep 0.3
B1_O1_AMOUNT=$(req GET "/api/admin/orders/$B1_O1" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$B1_O1/refund" "$AT" "{\"amount\":$B1_O1_AMOUNT,\"reason\":\"B1-1后台全额退款\"}")
assert_eq "B1-1：后台全额退款成功" "$(code "$R")" "0"
sleep 0.3
assert_eq "B1-1：后台退款 Tab 全额退款 → CANCEL 恰好 1 条（修复前是 0 条，厨房白做一单）" \
  "$(jq -r '[.data.list[] | select(.kind=="CANCEL")] | length' <<<"$(PJOBS_A40 "$B1_O1")")" "1"

# B1-2：售后路径，订单 SHIPPED 后顾客申请售后，后台同意全额
B1_O2=$(pay_new_order "$PID" "$ADDR")
req POST "/api/admin/orders/$B1_O2/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"SF'"$RANDOM"'"}' >/dev/null
B1_O2_AMOUNT=$(req GET "/api/admin/orders/$B1_O2" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/orders/$B1_O2/after-sale" "$UT" '{"reason":"DAMAGED","description":"E2E B1-2"}')
assert_eq "B1-2：顾客申请售后成功" "$(code "$R")" "0"
AS_ID_B1_2=$(jq -r .data.id <<<"$R")
R=$(req POST "/api/admin/after-sales/$AS_ID_B1_2/approve" "$AT" "{\"amount\":$B1_O2_AMOUNT}")
assert_eq "B1-2：后台同意售后全额退款成功" "$(code "$R")" "0"
sleep 0.3
assert_eq "B1-2：售后同意全额 → CANCEL 恰好 1 条" \
  "$(jq -r '[.data.list[] | select(.kind=="CANCEL")] | length' <<<"$(PJOBS_A40 "$B1_O2")")" "1"

# B1-3：部分退款（不打满）不该出 CANCEL——厨房不该把"退了一部分"误读成"这单不用做了"
B1_O3=$(pay_new_order "$PID" "$ADDR")
req POST "/api/admin/orders/$B1_O3/accept" "$AT" >/dev/null
sleep 0.3
R=$(req POST "/api/admin/orders/$B1_O3/refund" "$AT" '{"amount":1,"reason":"B1-3部分退款(1分钱)"}')
assert_eq "B1-3：部分退款(1分钱)成功" "$(code "$R")" "0"
sleep 0.3
assert_eq "B1-3：部分退款不出 CANCEL（0 条）" \
  "$(jq -r '[.data.list[] | select(.kind=="CANCEL")] | length' <<<"$(PJOBS_A40 "$B1_O3")")" "0"

# B1-4：顾客自助取消（orders.ts:625 先出一次 CANCEL 票，mock 秒退触发 finalizeRefundSuccess 又出一次）
# ——dedupeKey(seq=0) 必须把两次合并成 1 条，不能重复出票。
B1_O4=$(pay_new_order "$PID" "$ADDR")
R=$(req PUT "/api/orders/$B1_O4/cancel" "$UT")
assert_eq "B1-4：顾客自助取消成功（mock 秒退 → REFUNDED）" "$(jq -r '.data.status' <<<"$R")" "REFUNDED"
sleep 0.3
assert_eq "B1-4：自助取消 + finalizeRefundSuccess 双源出票，dedupe 后仍恰好 1 条（无重复）" \
  "$(jq -r '[.data.list[] | select(.kind=="CANCEL")] | length' <<<"$(PJOBS_A40 "$B1_O4")")" "1"

# M13（expirePointsBatch 的 CAS where 补 expiresAt<now，防止把刚被 extendLivePoints 续期救回的
# 行错误清零）：第二轮复核点名——这里原来放的是一句无条件 `ok`，PASS 计数 +1，什么都没验。
# 亚秒级竞争（候选 findMany 快照之后、per-row 事务提交之前被并发续期）在 bash 里没有能注入
# 延迟的钩子，真的造不出来，删掉这条假断言；M13 的 CAS where 子句本身已经在复核报告里由人工
# 代码审查核实过（见 docs/superpowers/notes/2026-09-05-review-round2.md「确认真修到了的」一节），
# 这里不再补一条自欺欺人的 e2e。

# 收尾：还原打印机/会员设置、删掉本段创建的测试地址
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req PUT /api/admin/settings/printer "$AT" "$ORIG_PRINTER_SETTINGS_40" >/dev/null
req PUT /api/admin/settings/member "$AT" "$ORIG_MEMBER_SETTINGS_40" >/dev/null
req DELETE "/api/addresses/$A40A_ADDR" "$A40A" >/dev/null
req DELETE "/api/addresses/$A40B_ADDR" "$A40B" >/dev/null
req DELETE "/api/addresses/$A40C_ADDR" "$A40C" >/dev/null
req DELETE "/api/addresses/$A40D_ADDR" "$A40D" >/dev/null
req DELETE "/api/addresses/$A40E_ADDR" "$A40E" >/dev/null
req DELETE "/api/addresses/$A40F_ADDR" "$A40F" >/dev/null
