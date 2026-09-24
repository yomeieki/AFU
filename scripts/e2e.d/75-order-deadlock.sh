echo "== 75. 同商品并发下单死锁——固定锁序 + 整事务重试（2026-09-24） =="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq；$AT/$BASE/$DB_NAME。变量一律 S75_ 前缀。
# 放在 74 之后（不依赖 74：74 收尾已把 low-stock 相关设置复位，本段自建全部商品/用户/
# 地址，与其它分片除了共用同一个后端/DB 之外互不相干）。跑的是
# scripts/stress-order-deadlock.sh 里方案验收标准第 4 条的 7 个标准场景，NORD/ROUNDS
# 都沿用方案原值（不为了缩短耗时而调小），实测本机合计约 1 分钟量级，在验收要求的
# ≤3 分钟预算内。压测脚本本身会在结尾做不变量校验（products.stock == SUM(sku)、
# sales_count == 已下单件数、成功响应数 == 落库订单数、sku 不超卖），这里只需要断言
# 它的 RESULT/退出码/（f 场景）SUMMARY。
S75_PIDS=""
S75_STRESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/stress-order-deadlock.sh"

# 跑一个标准场景：$1=场景名（对应验收标准第 4 条的 a-g）$2..=传给压测脚本的 NAME=VALUE
s75_run() {
  local name="$1"; shift
  S75_LAST_OUT=$(env "$@" BASE="$BASE" DB_NAME="$DB_NAME" bash "$S75_STRESS" 2>&1)
  S75_LAST_RC=$?
  local pline pid1 pid2 result
  pline=$(grep -m1 '^product P=' <<<"$S75_LAST_OUT")
  pid1=$(sed -E 's/^product P=([0-9]+).*/\1/' <<<"$pline")
  pid2=$(sed -E 's/.*; Q=([0-9]+).*/\1/' <<<"$pline")
  [[ "$pid1" =~ ^[0-9]+$ ]] && S75_PIDS="$S75_PIDS $pid1"
  [[ "$pid2" =~ ^[0-9]+$ ]] && S75_PIDS="$S75_PIDS $pid2"
  result=$(grep -m1 '^RESULT ' <<<"$S75_LAST_OUT")
  assert_eq "75.$name RESULT" "$result" "RESULT 50001=0 invariant_bad=0"
  assert_eq "75.$name 退出码" "$S75_LAST_RC" "0"
}

echo "-- 75.a NORD=30 ROUNDS=3 → 90 success --"
s75_run a NORD=30 ROUNDS=3
assert_eq "75.a success=90" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "90"

echo "-- 75.b NORD=2 ROUNDS=60 → 120 success --"
s75_run b NORD=2 ROUNDS=60
assert_eq "75.b success=120" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "120"

echo "-- 75.c NORD=20 ROUNDS=2 MULTI=1（同商品两规格一单）→ 40 success --"
s75_run c NORD=20 ROUNDS=2 MULTI=1
assert_eq "75.c success=40" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "40"

echo "-- 75.d NORD=20 ROUNDS=2 MULTI=2（跨商品锁序）→ 40 success --"
s75_run d NORD=20 ROUNDS=2 MULTI=2
assert_eq "75.d success=40" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "40"

echo "-- 75.e NORD=20 ROUNDS=2 NPUT=10（下单与后台改库存并发）→ 40 success --"
s75_run e NORD=20 ROUNDS=2 NPUT=10
assert_eq "75.e success=40" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "40"

echo "-- 75.f NORD=30 ROUNDS=1 STOCK=5 → 15 success + 15×42201 --"
s75_run f NORD=30 ROUNDS=1 STOCK=5
assert_eq "75.f success=15" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "15"
assert_eq "75.f e42201=15" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*e42201=([0-9]+).*/\1/')" "15"

echo "-- 75.g NORD=20 ROUNDS=2 SAMEUSER=1（同一用户并发、不带积分）→ 40 success --"
s75_run g NORD=20 ROUNDS=2 SAMEUSER=1
assert_eq "75.g success=40" "$(grep -m1 '^SUMMARY ' <<<"$S75_LAST_OUT" | sed -E 's/.*success=([0-9]+).*/\1/')" "40"

echo "-- 75.收尾：软删本段创建的全部商品 --"
S75_DELFAIL=0
for pid in $S75_PIDS; do
  R=$(req DELETE "/api/admin/products/$pid" "$AT")
  [[ "$(code "$R")" == "0" ]] || S75_DELFAIL=$((S75_DELFAIL+1))
done
assert_eq "75.收尾：本段创建的商品全部软删成功" "$S75_DELFAIL" "0"
