echo "== 43. 每日任务批量循环（H 组：H9）=="
# 本文件复用 §36 定义的 sql()/m1_login()（同一个 shell，本文件被 e2e.sh 尾部的 source
# 循环拉进来，函数与变量仍在作用域内）。
#
# 复现 H9：滚动续期让一个用户的全部在世行共用同一个到期日，到期那一刻可能一次产生远超
# 单批上限（默认 200）的候选行。
#
# 第二轮复核点名：原用例只插 5 行、靠 dailyTaskBatchLimit:2 把「一大批」压缩到 5 行数据上
# 复现——但 dailyTaskBatchLimit 这个 override 本身就是 H9 这次新加的字段，修复前的
# runMemberDailyTask 签名是 fn: () => Promise<number>，压根不认这个参数，传了也被无视，
# 直接走内部默认 200，一批就把 5 条全部处理完，跟修复后的结果一模一样——这条用例在修复前的
# 代码上照样通过，证明不了 bug 曾经存在。改法：插 >200（205）条真正同时到期的行、不传
# override（走真实默认批量 200），断言一轮 tick 就能把 205 条全部处理完；旧代码（不循环、
# 处理完一批就 patchCronState 收工）一次只能处理 200 条，剩下的 5 条要等到「明天」，能被
# 真实分辨新旧代码。
#
# 另外，断言全部按 user_id 过滤，不用 run-scheduler 返回的全库 .data.expirePoints 精确等号：
# expirePointsBatch 是全库扫描，不分用户，若拿全库计数去卡精确值，任何人在这条用例跑之前
# 往表里插了一条到期行（哪怕跟 H9 毫无关系），这条断言都会挂，而失败信息会误导去查 H9。

H43_TAG=$RANDOM
IFS=$'\t' read -r H43_TOKEN H43_UID < <(m1_login "a${H43_TAG}H9daily")
[[ -n "$H43_TOKEN" && -n "$H43_UID" ]] && ok "H9 测试用户登录" || fail "H9 测试用户登录失败"

# 一次性插 205 条「昨天到期、remaining=10」的 EARN 行（单条多行 VALUES INSERT，避免 205 次
# docker exec 拖慢用例）；ref_id 全局唯一，满足 @@unique([type,refType,refId])。
H43_N=205
H43_VALUES=""
for i in $(seq 1 "$H43_N"); do
  [[ -n "$H43_VALUES" ]] && H43_VALUES+=","
  H43_VALUES+="($H43_UID,'EARN',10,$((i*10)),10,'ORDER','h9test-${H43_TAG}-$i',DATE_SUB(NOW(), INTERVAL 1 DAY),NOW())"
done
sql "INSERT INTO points_ledgers (user_id, type, delta, balance_after, remaining, ref_type, ref_id, expires_at, created_at) VALUES $H43_VALUES;"
sql "UPDATE users SET points_balance = points_balance + $((H43_N * 10)) WHERE id=$H43_UID;"

H43_LIVE_ROWS_BEFORE=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$H43_UID AND type='EARN' AND remaining=10;")
assert_eq "H9 前置：$H43_N 条在世 EARN 行已插入" "$H43_LIVE_ROWS_BEFORE" "$H43_N"
BAL_BEFORE=$(sql "SELECT points_balance FROM users WHERE id=$H43_UID;")
assert_eq "H9 前置：余额已同步 +$((H43_N * 10))" "$BAL_BEFORE" "$((H43_N * 10))"

CRON_BEFORE=$(sql "SELECT value FROM settings WHERE setting_key='member_cron_state';")
LAST_EXPIRE_BEFORE=$(jq -r '.lastExpirePointsAt // empty' <<<"$CRON_BEFORE")

# 第一次：forceDailyMemberTasks 绕过日切门槛；不传 dailyTaskBatchLimit，走真实默认批量 200——
# 205 条候选需要循环 2 轮（200+5）才能全部处理完，不能只处理 200 条就把 lastExpirePointsAt 记上。
H43_R1=$(req POST /api/admin/system/run-scheduler "$AT" '{"forceDailyMemberTasks":true}')
assert_eq "H9-1：run-scheduler 请求成功" "$(code "$H43_R1")" "0"

H43_LIVE_ROWS_AFTER=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$H43_UID AND type='EARN' AND remaining=0;")
assert_eq "H9-1：本用户 $H43_N 条全部 remaining=0（一次 tick 内循环处理完，不是只处理一批 200 条就收工）" "$H43_LIVE_ROWS_AFTER" "$H43_N"
EXPIRE_ROWS=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$H43_UID AND type='EXPIRE';")
assert_eq "H9-1：本用户 EXPIRE 流水恰好 $H43_N 条" "$EXPIRE_ROWS" "$H43_N"
BAL_AFTER=$(sql "SELECT points_balance FROM users WHERE id=$H43_UID;")
assert_eq "H9-1：本用户余额回落到 0（旧代码一轮只处理 200 条，会剩 $((H43_N - 200))×10=$(((H43_N - 200) * 10)) 分未扣）" "$BAL_AFTER" "0"

CRON_AFTER1=$(sql "SELECT value FROM settings WHERE setting_key='member_cron_state';")
LAST_EXPIRE_AFTER1=$(jq -r '.lastExpirePointsAt // empty' <<<"$CRON_AFTER1")
[[ -n "$LAST_EXPIRE_AFTER1" && "$LAST_EXPIRE_AFTER1" != "$LAST_EXPIRE_BEFORE" ]] \
  && ok "H9-1：member_cron_state.lastExpirePointsAt 已推进" \
  || fail "H9-1：member_cron_state.lastExpirePointsAt 未推进" "before=$LAST_EXPIRE_BEFORE after=$LAST_EXPIRE_AFTER1"

# 第二次：不传 forceDailyMemberTasks，走正常的「今天已经跑过就不再跑」日切门槛——
# 既验证「没有新的到期行时处理 0 条」，也验证 H9 的循环改造没有破坏这道日切门槛：
# 同一天内 lastExpirePointsAt 只应该被写这一轮之前的那一次，这次短路直接返回不应该再写。
H43_R2=$(req POST /api/admin/system/run-scheduler "$AT" '{}')
assert_eq "H9-2：run-scheduler 请求成功" "$(code "$H43_R2")" "0"
assert_eq "H9-2：同一天内再跑一次，0 条处理（日切门槛短路）" "$(jq -r .data.expirePoints <<<"$H43_R2")" "0"

CRON_AFTER2=$(sql "SELECT value FROM settings WHERE setting_key='member_cron_state';")
LAST_EXPIRE_AFTER2=$(jq -r '.lastExpirePointsAt // empty' <<<"$CRON_AFTER2")
assert_eq "H9-2：member_cron_state.lastExpirePointsAt 只被写了一次（本次未再写）" "$LAST_EXPIRE_AFTER2" "$LAST_EXPIRE_AFTER1"
