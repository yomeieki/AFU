echo "== 42. 领券并发（C 组：B4、M7、M6）=="
# 复用 §36 已定义的 sql()/m1_login()/m1_completed_order()（同一 shell，本文件在
# e2e.sh §36 之后被 source）。
#
# 既有的并发用例（e2e.sh:1591「限量券并发不超发」）测的是 totalLimit 且用了两个不同
# 用户——perUserLimit 那条防线在这个用例里完全没被触发。B4 的真实漏洞是：同一用户
# 并发领同一张「不限总量、每人限领 1」的券，旧实现下 claimCampaign 的 updateMany
# 只在 totalLimit != null 时才有数量条件，perUserLimit 又是快照 count()，两条防线对
# 「同一用户 + 不限总量」这个组合都不构成保护，5 个并发请求会 5 个都成功。

# mock 登录的 openid = code 前 8 位。原来 c${RANDOM}E_… 只有 32768 个取值，多轮共用一库时
# 撞上上一轮同名用户就会带着旧积分（2026-09-08 实测 +80 分）。区分字母放最前、随机位
# 用 7 位十六进制（2^28），8 位内不再撞。
C4_TAG=$(printf '%07x' $(( (RANDOM << 15) | RANDOM )))
IFS=$'\t' read -r C4_D C4_D_UID < <(m1_login "D${C4_TAG}_couponD")
IFS=$'\t' read -r C4_E C4_E_UID < <(m1_login "E${C4_TAG}_couponE")
IFS=$'\t' read -r C4_F C4_F_UID < <(m1_login "F${C4_TAG}_couponF")
[[ -n "$C4_D" && -n "$C4_E" && -n "$C4_F" ]] && ok "C 组测试用户 D/E/F 登录" || fail "C 组测试用户登录失败"

echo "-- 准备积分：走正常下单结算，不手工造账本行（手工 INSERT 容易漏列，见报告）--"
ORIG_MEMBER_SETTINGS_42=$(req GET /api/admin/settings/member "$AT" | jq -c .data)
req PUT /api/admin/settings/member "$AT" '{"points":{"enabled":true,"earnRatePerYuan":1,"validDays":365},"newcomer":{"templateId":null},"rulesText":""}' >/dev/null
C4_E_ADDR=$(req POST /api/addresses "$C4_E" '{"receiverName":"C4E","receiverPhone":"13800000091","province":"四川省","city":"自贡市","district":"自流井区","detail":"C4E测试地址","isDefault":1}' | jq -r .data.id)
C4_F_ADDR=$(req POST /api/addresses "$C4_F" '{"receiverName":"C4F","receiverPhone":"13800000092","province":"四川省","city":"自贡市","district":"自流井区","detail":"C4F测试地址","isDefault":1}' | jq -r .data.id)
C4_E_O=$(m1_completed_order "$C4_E" "$C4_E_ADDR" 10000)
C4_F_O=$(m1_completed_order "$C4_F" "$C4_F_ADDR" 10000)
req POST /api/admin/system/run-scheduler "$AT" '{"settleMissedPointsAfterMin":0}' >/dev/null
C4_E_BAL0=$(sql "SELECT points_balance FROM users WHERE id=$C4_E_UID;")
C4_F_BAL0=$(sql "SELECT points_balance FROM users WHERE id=$C4_F_UID;")
assert_eq "C4-E 结算得 100 分（实付 100 元，rate=1）" "$C4_E_BAL0" "100"
assert_eq "C4-F 结算得 100 分" "$C4_F_BAL0" "100"

echo "-- B4-1：同一用户并发领取「不限总量、每人限领 1」的 CAMPAIGN 券 --"
sql "INSERT INTO coupon_templates (name, amount, threshold, channel, valid_days, source, total_limit, per_user_limit, status, created_at, updated_at) VALUES ('E2E同用户并发CAMPAIGN', 100, 0, 'ALL', 30, 'CAMPAIGN', NULL, 1, 'ON', NOW(), NOW());"
TPL_B4_CAMPAIGN=$(sql "SELECT id FROM coupon_templates WHERE name='E2E同用户并发CAMPAIGN' ORDER BY id DESC LIMIT 1;")
[[ -n "$TPL_B4_CAMPAIGN" ]] && ok "B4-1 模板造数据完成" || fail "B4-1 模板造数据失败"

for i in 1 2 3 4 5; do
  req POST /api/member/coupons/claim "$C4_D" "{\"templateId\":$TPL_B4_CAMPAIGN}" > "/tmp/e2e_b4_1_$i.json" &
done
wait
B4_1_OK=0; B4_1_DENY=0
for i in 1 2 3 4 5; do
  c=$(jq -r .code "/tmp/e2e_b4_1_$i.json" 2>/dev/null)
  if [[ "$c" == "0" ]]; then B4_1_OK=$((B4_1_OK+1)); elif [[ "$c" == "42253" ]]; then B4_1_DENY=$((B4_1_DENY+1)); fi
done
assert_eq "B4-1：同一用户 5 个并发请求，恰好 1 个成功" "$B4_1_OK" "1"
assert_eq "B4-1：其余 4 个均因超限被拒（42253）" "$B4_1_DENY" "4"
B4_1_DB=$(sql "SELECT COUNT(*) FROM user_coupons WHERE user_id=$C4_D_UID AND template_id=$TPL_B4_CAMPAIGN;")
assert_eq "B4-1：数据库里恰好发出 1 张（不是并发下的 5 张）" "$B4_1_DB" "1"
rm -f /tmp/e2e_b4_1_*.json

echo "-- B4-2：同一用户并发兑换「每人限领 1」的 POINTS 券 --"
sql "INSERT INTO coupon_templates (name, amount, threshold, channel, valid_days, source, points_cost, per_user_limit, status, created_at, updated_at) VALUES ('E2E同用户并发POINTS', 100, 0, 'ALL', 30, 'POINTS', 10, 1, 'ON', NOW(), NOW());"
TPL_B4_POINTS=$(sql "SELECT id FROM coupon_templates WHERE name='E2E同用户并发POINTS' ORDER BY id DESC LIMIT 1;")
[[ -n "$TPL_B4_POINTS" ]] && ok "B4-2 模板造数据完成" || fail "B4-2 模板造数据失败"

for i in 1 2 3 4 5; do
  req POST /api/member/points/redeem "$C4_E" "{\"templateId\":$TPL_B4_POINTS}" > "/tmp/e2e_b4_2_$i.json" &
done
wait
B4_2_OK=0; B4_2_DENY=0
for i in 1 2 3 4 5; do
  c=$(jq -r .code "/tmp/e2e_b4_2_$i.json" 2>/dev/null)
  if [[ "$c" == "0" ]]; then B4_2_OK=$((B4_2_OK+1)); elif [[ "$c" == "42253" ]]; then B4_2_DENY=$((B4_2_DENY+1)); fi
done
assert_eq "B4-2：同一用户 5 个并发兑换请求，恰好 1 个成功" "$B4_2_OK" "1"
assert_eq "B4-2：其余 4 个均因超限被拒（42253）" "$B4_2_DENY" "4"
B4_2_BAL=$(sql "SELECT points_balance FROM users WHERE id=$C4_E_UID;")
assert_eq "B4-2：积分只被扣一次（100-10=90）" "$B4_2_BAL" "90"
B4_2_DB=$(sql "SELECT COUNT(*) FROM user_coupons WHERE user_id=$C4_E_UID AND template_id=$TPL_B4_POINTS;")
assert_eq "B4-2：数据库里恰好发出 1 张" "$B4_2_DB" "1"
rm -f /tmp/e2e_b4_2_*.json

echo "-- M7-1：POINTS 模板带 totalLimit，两个不同用户各兑一次 --"
sql "INSERT INTO coupon_templates (name, amount, threshold, channel, valid_days, source, points_cost, total_limit, status, created_at, updated_at) VALUES ('E2E总量限量POINTS', 100, 0, 'ALL', 30, 'POINTS', 10, 1, 'ON', NOW(), NOW());"
TPL_M7=$(sql "SELECT id FROM coupon_templates WHERE name='E2E总量限量POINTS' ORDER BY id DESC LIMIT 1;")
[[ -n "$TPL_M7" ]] && ok "M7-1 模板造数据完成（totalLimit=1）" || fail "M7-1 模板造数据失败"
R=$(req POST /api/member/points/redeem "$C4_E" "{\"templateId\":$TPL_M7}")
assert_eq "M7-1：第一个用户兑换成功" "$(code "$R")" "0"
C4_R2=$(req POST /api/member/points/redeem "$C4_F" "{\"templateId\":$TPL_M7}")
assert_eq "M7-1：第二个用户被挡（totalLimit 已用完，42253）" "$(code "$C4_R2")" "42253"
M7_ISSUED=$(sql "SELECT issued_count FROM coupon_templates WHERE id=$TPL_M7;")
assert_eq "M7-1：issuedCount 精确等于 1（未超发）" "$M7_ISSUED" "1"

echo "-- M6-1：领取/兑换的响应体不能带内部字段 --"
sql "INSERT INTO coupon_templates (name, amount, threshold, channel, valid_days, source, total_limit, per_user_limit, status, created_at, updated_at) VALUES ('E2E白名单校验CAMPAIGN', 100, 0, 'ALL', 30, 'CAMPAIGN', NULL, NULL, 'ON', NOW(), NOW());"
TPL_M6_CAMPAIGN=$(sql "SELECT id FROM coupon_templates WHERE name='E2E白名单校验CAMPAIGN' ORDER BY id DESC LIMIT 1;")
R=$(req POST /api/member/coupons/claim "$C4_F" "{\"templateId\":$TPL_M6_CAMPAIGN}")
assert_eq "M6-1：领取成功（供响应白名单检查）" "$(code "$R")" "0"
assert_eq "M6-1：claim 响应不含 issuedBy/remark/sourceRef/templateId/userId" \
  "$(jq -r '(.data|has("issuedBy")) or (.data|has("remark")) or (.data|has("sourceRef")) or (.data|has("templateId")) or (.data|has("userId"))' <<<"$R")" "false"

sql "INSERT INTO coupon_templates (name, amount, threshold, channel, valid_days, source, points_cost, status, created_at, updated_at) VALUES ('E2E白名单校验POINTS', 100, 0, 'ALL', 30, 'POINTS', 10, 'ON', NOW(), NOW());"
TPL_M6_POINTS=$(sql "SELECT id FROM coupon_templates WHERE name='E2E白名单校验POINTS' ORDER BY id DESC LIMIT 1;")
C4_R2B=$(req POST /api/member/points/redeem "$C4_F" "{\"templateId\":$TPL_M6_POINTS}")
assert_eq "M6-1：兑换成功（供响应白名单检查）" "$(code "$C4_R2B")" "0"
assert_eq "M6-1：redeem 响应不含 issuedBy/remark/sourceRef/templateId/userId" \
  "$(jq -r '(.data|has("issuedBy")) or (.data|has("remark")) or (.data|has("sourceRef")) or (.data|has("templateId")) or (.data|has("userId"))' <<<"$C4_R2B")" "false"

req DELETE "/api/addresses/$C4_E_ADDR" "$C4_E" >/dev/null
req DELETE "/api/addresses/$C4_F_ADDR" "$C4_F" >/dev/null
req PUT /api/admin/settings/member "$AT" "$ORIG_MEMBER_SETTINGS_42" >/dev/null
