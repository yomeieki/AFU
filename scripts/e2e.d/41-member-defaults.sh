echo "== 41. 会员默认值（B 组：B3）=="

echo "-- B-3 源码级断言：DEFAULT_MEMBER_SETTINGS 与 PO 定稿一致 --"
# 缓存 60s TTL 且没有清缓存的路由，不能靠删 settings 行再 GET 来验默认值——那样验到的
# 可能还是缓存里的旧值。改为直接 require 源码里的常量。
if (cd apps/server && npx ts-node --transpile-only -e "
const s = require('./src/services/member/settings');
const d = s.DEFAULT_MEMBER_SETTINGS.points;
if (d.enabled !== false || d.earnRatePerYuan !== 100 || d.validDays !== 365) process.exit(1);
" >/tmp/e2e_b3_defaults.log 2>&1); then
  ok "B-3：DEFAULT_MEMBER_SETTINGS.points == {enabled:false, earnRatePerYuan:100, validDays:365}"
else
  fail "B-3：DEFAULT_MEMBER_SETTINGS.points 与定稿不一致" "$(cat /tmp/e2e_b3_defaults.log)"
fi
rm -f /tmp/e2e_b3_defaults.log

echo "-- B-3 行为断言：enabled=false 时 settlePoints 不发分、不落锁 --"
# 复用 §36 已定义的 sql()/m1_login()/m1_completed_order()（本文件在源码里被 source 到
# e2e.sh §36 之后，同一个 shell，函数与变量仍在作用域内）。
ORIG_MEMBER_SETTINGS_41=$(req GET /api/admin/settings/member "$AT" | jq -c .data)
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":false,"earnRatePerYuan":100,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null

B3_TAG=$RANDOM
IFS=$'\t' read -r B3_USER B3_UID < <(m1_login "b${B3_TAG}G_defaultsoff")
[[ -n "$B3_USER" ]] && ok "B-3 测试用户登录" || fail "B-3 测试用户登录失败"
B3_ADDR=$(req POST /api/addresses "$B3_USER" '{"receiverName":"B3默认关","receiverPhone":"13800000099","province":"四川省","city":"自贡市","district":"自流井区","detail":"B3测试地址","isDefault":1}' | jq -r .data.id)
B3_O=$(m1_completed_order "$B3_USER" "$B3_ADDR" 10000)
[[ -n "$B3_O" ]] && ok "B-3 造单#$B3_O 完成（实付 100 元）" || fail "B-3 造单失败"
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
B3_LEDGER=$(sql "SELECT COUNT(*) FROM points_ledgers WHERE ref_type='ORDER' AND ref_id='$B3_O';")
B3_SETTLED=$(sql "SELECT points_settled_at FROM orders WHERE id=$B3_O;")
assert_eq "B-3：关闭开关时该单不写任何积分流水" "$B3_LEDGER" "0"
[[ "$B3_SETTLED" == "NULL" ]] \
  && ok "B-3：关闭开关时 pointsSettledAt 仍为 NULL（以后打开开关，兜底任务还能补发这单）" \
  || fail "B-3：pointsSettledAt 不该在开关关闭时被落锁" "$B3_SETTLED"

req DELETE "/api/addresses/$B3_ADDR" "$B3_USER" >/dev/null
req PUT /api/admin/settings/member "$AT" "$ORIG_MEMBER_SETTINGS_41" >/dev/null
