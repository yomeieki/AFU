echo "== 43. 每日任务批量循环（H 组：H9）=="
# 本文件复用 §36 定义的 sql()/m1_login()（同一个 shell，本文件被 e2e.sh 尾部的 source
# 循环拉进来，函数与变量仍在作用域内）。
#
# 复现 H9：滚动续期让一个用户的全部在世行共用同一个到期日，到期那一刻可能一次产生远超
# 单批上限的候选行。用 dailyTaskBatchLimit:2 把「一大批」压缩到 5 行/批 2 就能在几行数据
# 上复现，不用真的插 200+ 行；断言循环会跑够轮数把 5 行全部处理完，而不是处理 2 行就收工。

H43_TAG=$RANDOM
IFS=$'\t' read -r H43_TOKEN H43_UID < <(m1_login "a${H43_TAG}H9daily")
[[ -n "$H43_TOKEN" && -n "$H43_UID" ]] && ok "H9 测试用户登录" || fail "H9 测试用户登录失败"

# 手工插 5 条「昨天到期、remaining=10」的 EARN 行（ref_id 全局唯一，满足 @@unique([type,refType,refId])），
# 并把用户余额同步加上 50（5×10），模拟这 5 笔分是之前正常入账、只是恰好共用同一个到期日。
for i in 1 2 3 4 5; do
  sql "INSERT INTO points_ledgers (user_id, type, delta, balance_after, remaining, ref_type, ref_id, expires_at, created_at)
       VALUES ($H43_UID, 'EARN', 10, $((i*10)), 10, 'ORDER', 'h9test-${H43_TAG}-$i', DATE_SUB(NOW(), INTERVAL 1 DAY), NOW());"
done
sql "UPDATE users SET points_balance = points_balance + 50 WHERE id=$H43_UID;"

H43_LIVE_ROWS_BEFORE=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$H43_UID AND type='EARN' AND remaining=10;")
assert_eq "H9 前置：5 条在世 EARN 行已插入" "$H43_LIVE_ROWS_BEFORE" "5"
BAL_BEFORE=$(sql "SELECT points_balance FROM users WHERE id=$H43_UID;")
assert_eq "H9 前置：余额已同步 +50" "$BAL_BEFORE" "50"

CRON_BEFORE=$(sql "SELECT value FROM settings WHERE setting_key='member_cron_state';")
LAST_EXPIRE_BEFORE=$(jq -r '.lastExpirePointsAt // empty' <<<"$CRON_BEFORE")

# 第一次：forceDailyMemberTasks 绕过日切门槛，dailyTaskBatchLimit:2 把批量压到 2——
# 5 条候选需要循环 3 轮（2+2+1）才能全部处理完，不能只处理 2 条就把 lastExpirePointsAt 记上。
H43_R1=$(req POST /api/admin/system/run-scheduler "$AT" '{"forceDailyMemberTasks":true,"dailyTaskBatchLimit":2}')
assert_eq "H9-1：run-scheduler 请求成功" "$(code "$H43_R1")" "0"
assert_eq "H9-1：一次 tick 内循环处理完全部 5 条（不是只处理一批 2 条）" "$(jq -r .data.expirePoints <<<"$H43_R1")" "5"

H43_LIVE_ROWS_AFTER=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$H43_UID AND type='EARN' AND remaining=0;")
assert_eq "H9-1：5 条全部 remaining=0" "$H43_LIVE_ROWS_AFTER" "5"
EXPIRE_ROWS=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE user_id=$H43_UID AND type='EXPIRE';")
assert_eq "H9-1：EXPIRE 流水恰好 5 条" "$EXPIRE_ROWS" "5"
BAL_AFTER=$(sql "SELECT points_balance FROM users WHERE id=$H43_UID;")
assert_eq "H9-1：余额回落 50（50-50=0）" "$BAL_AFTER" "0"

CRON_AFTER1=$(sql "SELECT value FROM settings WHERE setting_key='member_cron_state';")
LAST_EXPIRE_AFTER1=$(jq -r '.lastExpirePointsAt // empty' <<<"$CRON_AFTER1")
[[ -n "$LAST_EXPIRE_AFTER1" && "$LAST_EXPIRE_AFTER1" != "$LAST_EXPIRE_BEFORE" ]] \
  && ok "H9-1：member_cron_state.lastExpirePointsAt 已推进" \
  || fail "H9-1：member_cron_state.lastExpirePointsAt 未推进" "before=$LAST_EXPIRE_BEFORE after=$LAST_EXPIRE_AFTER1"

# 第二次：不传 forceDailyMemberTasks，走正常的「今天已经跑过就不再跑」日切门槛——
# 既验证「没有新的到期行时处理 0 条」，也验证 H9 的循环改造没有破坏这道日切门槛：
# 同一天内 lastExpirePointsAt 只应该被写这一轮之前的那一次，这次短路直接返回不应该再写。
H43_R2=$(req POST /api/admin/system/run-scheduler "$AT" '{"dailyTaskBatchLimit":2}')
assert_eq "H9-2：run-scheduler 请求成功" "$(code "$H43_R2")" "0"
assert_eq "H9-2：同一天内再跑一次，0 条处理（日切门槛短路）" "$(jq -r .data.expirePoints <<<"$H43_R2")" "0"

CRON_AFTER2=$(sql "SELECT value FROM settings WHERE setting_key='member_cron_state';")
LAST_EXPIRE_AFTER2=$(jq -r '.lastExpirePointsAt // empty' <<<"$CRON_AFTER2")
assert_eq "H9-2：member_cron_state.lastExpirePointsAt 只被写了一次（本次未再写）" "$LAST_EXPIRE_AFTER2" "$LAST_EXPIRE_AFTER1"
