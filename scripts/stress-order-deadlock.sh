#!/bin/bash
# 同商品并发下单死锁——压测/验收脚本（2026-09-24）
# 固化自编排者的复现脚本，见 docs/superpowers/plans/2026-09-24-order-deadlock.md 实现方向 5。
#
# 用法：
#   BASE=http://localhost:3142 DB_NAME=food_shop_dlk NORD=30 ROUNDS=3 bash scripts/stress-order-deadlock.sh
#
# 参数（均可用环境变量覆盖，括号内为默认值）：
#   BASE(http://localhost:3100)  后端地址
#   DB_NAME(food_shop_sc)        直连 MySQL 校验用的库名（账号固定为 foodshop_user，与
#                                 scripts/e2e.sh 的 sql() 同账号，不用 root）
#   ADMIN_USER(admin) ADMIN_PASS(admin123456)
#   NORD(30)    并发用户数（每轮每个用户各发一次下单请求）
#   ROUNDS(3)   轮数，每轮 wait 全部并发请求完成再开下一轮
#   NPUT(0)     每轮额外并发多少个 PUT /api/admin/products/:id/stock（场景 e：下单与后台
#               改库存并发）
#   MULTI(0)    0=单行直购；1=同商品两规格一单（场景 c）；2=两商品各一件、一半用户反序
#               加购（场景 d，跨商品锁序）
#   STOCK(1000) 每个 sku 的初始库存；故意设小可以验证「成功或 42201，绝不超卖」（场景 f）
#   SAMEUSER(0) 1=NORD 个并发槽全部用同一个已登录用户（不传 clientRequestId，仍是 NORD
#               笔不同订单）——验证同一用户并发下单、不带积分时不受影响（场景 g）
#   NCART(0)    另起 NCART 个用户，每轮与 NORD 个下单并发地对同一 sku（sku A）
#               POST /api/cart 后立刻 DELETE /api/cart/:id（场景 h，L 级复核 R1：验证加购
#               与下单锁序已对齐、不再互相死锁）
#   OUT         输出目录，默认 mktemp -d
#
# 8 个标准场景（见方案验收标准第 4 条 + 修订 1）：
#   a NORD=30 ROUNDS=3                     → 90 success
#   b NORD=2  ROUNDS=60                     → 120 success
#   c NORD=20 ROUNDS=2 MULTI=1              → 40 success
#   d NORD=20 ROUNDS=2 MULTI=2              → 40 success
#   e NORD=20 ROUNDS=2 NPUT=10              → 40 success，puts 全 0
#   f NORD=30 ROUNDS=1 STOCK=5              → 15 success + 15×42201，sku 终值全 0 不为负
#   g NORD=20 ROUNDS=2 SAMEUSER=1           → 40 success
#   h NORD=10 ROUNDS=10 NCART=10            → 100 订单 success、100 加购 success
# a–h 全部要求服务端日志 `grep -c '下单遇死锁' == 0`（R1 选项 A：加购锁序已对齐，不应
# 再靠重试兜住）。
#
# 退出码：0=全部符合预期（RESULT 50001=0 invariant_bad=0 且无非 {0,42201} 的响应码、
# 落库订单数与成功响应数一致、NCART>0 时加购全部成功）；1=任一不符（含改坏验证矩阵里
# 故意打红的场景）。
set -u
SP=$(cd "$(dirname "$0")" && pwd)
BASE=${BASE:-http://localhost:3100}; DB_NAME=${DB_NAME:-food_shop_sc}
ADMIN_USER=${ADMIN_USER:-admin}; ADMIN_PASS=${ADMIN_PASS:-admin123456}
ROUNDS=${ROUNDS:-3}; NORD=${NORD:-30}; NPUT=${NPUT:-0}; MULTI=${MULTI:-0}; STOCK=${STOCK:-1000}; SAMEUSER=${SAMEUSER:-0}; NCART=${NCART:-0}
OUT=${OUT:-$(mktemp -d)}; mkdir -p "$OUT"

Q() { docker exec -i food-shop-mysql mysql --default-character-set=utf8mb4 -N -ufoodshop_user -pfoodshop_password "$DB_NAME" -e "$1" 2>/dev/null; }
req() { curl -s -X "$1" "$BASE$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}; }

AT=$(req POST /api/admin/login "" "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | jq -r '.data.token // empty')
[[ -n "$AT" ]] || { echo "admin 登录失败"; exit 1; }

# R6（L 级复核，建议级采纳）：脚本会把运费改成 0 元起送/包邮，方便造单，但从没改回去过——
# 干净库跑没问题，若在已有数据的库上跑就会永久改动店铺的运费设置。开工前存一份原值，
# 用 trap 保证无论正常结束还是任何 exit 1 路径都会还原，不需要每个 exit 点各写一遍。
S_ORIG=$(req GET /api/admin/settings/shipping "$AT" | jq -c .data)
restore_shipping() { [[ -n "${S_ORIG:-}" && "$S_ORIG" != "null" ]] && req PUT /api/admin/settings/shipping "$AT" "$S_ORIG" >/dev/null; }
trap restore_shipping EXIT
req PUT /api/admin/settings/shipping "$AT" '{"fee":0,"freeThreshold":0,"minOrderAmount":0}' >/dev/null

CAT=$(Q "SELECT id FROM categories WHERE channel='EXPRESS' ORDER BY id LIMIT 1"); CAT=${CAT:-1}
mk() { req POST /api/admin/products "$AT" "{\"categoryId\":$CAT,\"name\":\"DL并发$1-$$\",\"price\":100,\"specDimensions\":[{\"name\":\"味\",\"values\":[\"甲\",\"乙\",\"丙\"]}],\"skus\":[{\"specText\":\"甲\",\"specValues\":[\"甲\"],\"price\":100,\"stock\":$STOCK},{\"specText\":\"乙\",\"specValues\":[\"乙\"],\"price\":100,\"stock\":$STOCK},{\"specText\":\"丙\",\"specValues\":[\"丙\"],\"price\":100,\"stock\":$STOCK}]}"; }
R=$(mk P); P=$(jq -r .data.id <<<"$R"); A=$(jq -r '.data.skus[0].id' <<<"$R"); B=$(jq -r '.data.skus[1].id' <<<"$R"); C=$(jq -r '.data.skus[2].id' <<<"$R")
R=$(mk Q); P2=$(jq -r .data.id <<<"$R"); A2=$(jq -r '.data.skus[0].id' <<<"$R")
[[ "$P" =~ ^[0-9]+$ && "$P2" =~ ^[0-9]+$ ]] || { echo "建商品失败: $R"; exit 1; }
echo "product P=$P skus A=$A B=$B C=$C ; Q=$P2 skuA=$A2 ; MULTI=$MULTI NORD=$NORD ROUNDS=$ROUNDS NPUT=$NPUT STOCK=$STOCK SAMEUSER=$SAMEUSER NCART=$NCART"

declare -a UTS ADDRS
# ⚠️ mock 登录（routes/auth.ts）用 `code.slice(0, 8)` 派生 openid——只要 code 前 8 个字符
# 相同就是同一个用户。早期版本用 `dl_${P}_u$i` 拼 code，P（商品 id）一旦到两位数，
# `dl_14_u1` 与 `dl_14_u10` 前 8 字符都截断成 `dl_14_u1`，会把本该不同的两个并发用户
# 悄悄合并成一个——MULTI 场景下购物车按 (user,product,sku) upsert 合并数量，这个合并会
# 让同一行的 quantity 越攒越大，下单后 order_items.quantity != 1，把「同一商品不同用户
# 并发下单」悄悄退化成「少数用户重复下单」，且报出与本次改动无关的 40001。
# 这里用「6 位随机十六进制 + 2 位下标」拼成恰好 8 字符的 code，NORD ≤ 99 时对每次脚本
# 运行内的所有下标两两不同；6 位随机前缀让不同脚本运行之间大概率也不复用同一用户
# （不强依赖这一点：即使复用，clear_cart 与逐次新建地址也能保证脚本本身的正确性）。
RUNTAG=$(printf '%06x' $(( (RANDOM * 32768 + RANDOM) % 16777216 )))
if [[ "$SAMEUSER" == "1" ]]; then
  UT0=$(req POST /api/auth/wechat-login "" "{\"code\":\"${RUNTAG}sm\"}" | jq -r .data.token)
  AD0=$(req POST /api/addresses "$UT0" '{"receiverName":"DL","receiverPhone":"13800000000","province":"四川省","city":"成都市","district":"武侯区","detail":"测试路1号","isDefault":1}' | jq -r .data.id)
  for i in $(seq 1 $NORD); do UTS[$i]=$UT0; ADDRS[$i]=$AD0; done
else
  for i in $(seq 1 $NORD); do
    UT=$(req POST /api/auth/wechat-login "" "{\"code\":\"${RUNTAG}$(printf '%02d' $i)\"}" | jq -r .data.token)
    AD=$(req POST /api/addresses "$UT" '{"receiverName":"DL","receiverPhone":"13800000000","province":"四川省","city":"成都市","district":"武侯区","detail":"测试路1号","isDefault":1}' | jq -r .data.id)
    UTS[$i]=$UT; ADDRS[$i]=$AD
  done
fi

# NCART（场景 h，R1）：另一批只加购/不下单的用户，用独立 RUNTAG2 避免与上面 NORD 用户的
# 8 字符 openid 前缀撞车（两个 24 位随机数各自独立，撞车概率可忽略；即使撞了也只是复用
# 同一个真实用户，不影响脚本自身正确性）。加购目标固定为 sku A——与场景 e 的 NPUT 目标
# 及 i%3==1 的直购订单共享同一行，制造真实的「加购 vs 下单」并发。
declare -a CUTS
if [[ "$NCART" -gt 0 ]]; then
  RUNTAG2=$(printf '%06x' $(( (RANDOM * 32768 + RANDOM) % 16777216 )))
  for k in $(seq 1 $NCART); do
    CUTS[$k]=$(req POST /api/auth/wechat-login "" "{\"code\":\"${RUNTAG2}$(printf '%02d' $k)\"}" | jq -r .data.token)
  done
fi

: > $OUT/orders.txt; : > $OUT/puts.txt; : > $OUT/debug.txt; : > $OUT/carts.txt
# MULTI 模式先清空该用户购物车——上一轮若有失败订单残留购物车项，这一轮加购会把行加在
# 已有行旁边，cartItemIds 引用的行数与预期不符（基线里出现的「40001 购物车商品不存在」
# 正是这类残留导致）。
clear_cart() {
  local ut=$1 ids cid
  ids=$(req GET /api/cart "$ut" | jq -r '.data.items[].id // empty')
  for cid in $ids; do req DELETE "/api/cart/$cid" "$ut" >/dev/null; done
}
for r in $(seq 1 $ROUNDS); do
  for i in $(seq 1 $NORD); do
    (
      UT=${UTS[$i]}; AD=${ADDRS[$i]}
      if [[ "$MULTI" == "1" ]]; then
        clear_cart "$UT"
        c1=$(req POST /api/cart "$UT" "{\"productId\":$P,\"skuId\":$B,\"quantity\":1}" | jq -r '.data.id // empty')
        c2=$(req POST /api/cart "$UT" "{\"productId\":$P,\"skuId\":$A,\"quantity\":1}" | jq -r '.data.id // empty')
        o=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$c1,$c2],\"addressId\":$AD}")
        [[ "$(jq -r .code <<<"$o")" == 400* ]] && echo "u$i c1=$c1 c2=$c2 $o" >> $OUT/debug.txt
      elif [[ "$MULTI" == "2" ]]; then
        clear_cart "$UT"
        if (( i % 2 )); then F="$P:$A"; S2="$P2:$A2"; else F="$P2:$A2"; S2="$P:$A"; fi
        c1=$(req POST /api/cart "$UT" "{\"productId\":${F%%:*},\"skuId\":${F##*:},\"quantity\":1}" | jq -r '.data.id // empty')
        c2=$(req POST /api/cart "$UT" "{\"productId\":${S2%%:*},\"skuId\":${S2##*:},\"quantity\":1}" | jq -r '.data.id // empty')
        o=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$c1,$c2],\"addressId\":$AD}")
        [[ "$(jq -r .code <<<"$o")" == 400* ]] && echo "u$i c1=$c1 c2=$c2 $o" >> $OUT/debug.txt
      else
        case $((i % 3)) in 0) S=$A;; 1) S=$B;; 2) S=$C;; esac
        o=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$P,\"skuId\":$S,\"quantity\":1},\"addressId\":$AD}")
      fi
      echo "$(jq -r '.code' <<<"$o") $(jq -r '.message' <<<"$o")" >> $OUT/orders.txt
    ) &
  done
  for ((j=1;j<=NPUT;j++)); do
    ( v=$((500 + RANDOM % 400)); o=$(req PUT /api/admin/products/$P/stock "$AT" "{\"skuId\":$A,\"stock\":$v}"); echo "$(jq -r '.code' <<<"$o") $(jq -r '.message' <<<"$o")" >> $OUT/puts.txt ) &
  done
  for ((k=1;k<=NCART;k++)); do
    (
      ct=${CUTS[$k]}
      o=$(req POST /api/cart "$ct" "{\"productId\":$P,\"skuId\":$A,\"quantity\":1}")
      cc=$(jq -r '.code' <<<"$o"); cid=$(jq -r '.data.id // empty' <<<"$o")
      cd="skip"
      if [[ -n "$cid" ]]; then
        d=$(req DELETE "/api/cart/$cid" "$ct")
        cd=$(jq -r '.code' <<<"$d")
      fi
      echo "$cc $cd" >> $OUT/carts.txt
    ) &
  done
  wait
done

echo "== orders result codes =="; sort $OUT/orders.txt | uniq -c
[[ "$NPUT" -gt 0 ]] && { echo "== puts result codes =="; sort $OUT/puts.txt | uniq -c; }
[[ "$NCART" -gt 0 ]] && { echo "== carts result codes =="; sort $OUT/carts.txt | uniq -c; }

N50001=$(grep -c '^50001 ' $OUT/orders.txt); NOK=$(grep -c '^0 ' $OUT/orders.txt); N42201=$(grep -c '^42201 ' $OUT/orders.txt)
TOTAL=$(wc -l < $OUT/orders.txt | tr -d ' ')
NOTHER=$((TOTAL - N50001 - NOK - N42201))
NPUTOTHER=0
[[ "$NPUT" -gt 0 ]] && NPUTOTHER=$(grep -vc '^0 ' $OUT/puts.txt)
NCARTOK=0; NCARTOTHER=0
if [[ "$NCART" -gt 0 ]]; then
  NCARTOK=$(grep -c '^0 0$' $OUT/carts.txt)
  NCARTOTHER=$(grep -vc '^0 0$' $OUT/carts.txt)
fi

BAD=0
for PP in $P $P2; do
  PS=$(Q "SELECT stock FROM products WHERE id=$PP"); SS=$(Q "SELECT SUM(stock) FROM product_skus WHERE product_id=$PP")
  SOLD=$(Q "SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi WHERE oi.product_id=$PP")
  SALES=$(Q "SELECT sales_count FROM products WHERE id=$PP")
  echo "product#$PP stock=$PS SUM(sku)=$SS sales_count=$SALES order_items_qty=$SOLD"
  [[ "$PS" == "$SS" ]] || { echo "  ✗ 不变量破坏 products.stock != SUM(sku)"; BAD=1; }
  [[ "$SALES" == "$SOLD" ]] || { echo "  ✗ sales_count != 已下单件数"; BAD=1; }
done
for S in $A $B $C $A2; do
  SK=$(Q "SELECT stock FROM product_skus WHERE id=$S"); N=$(Q "SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE sku_id=$S")
  [[ "$NPUT" -gt 0 && "$S" == "$A" ]] && continue
  [[ $((STOCK - N)) == "$SK" ]] || { echo "  ✗ sku#$S stock=$SK 期望 $((STOCK-N))"; BAD=1; }
  (( SK >= 0 )) || { echo "  ✗ sku#$S 超卖 $SK"; BAD=1; }
done
NORDERS=$(Q "SELECT COUNT(*) FROM orders o WHERE EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id=o.id AND oi.product_id IN ($P,$P2))")
echo "orders_in_db=$NORDERS success_responses=$NOK"
[[ "$NORDERS" == "$NOK" ]] || { echo "  ✗ 成功响应数与落库订单数不一致"; BAD=1; }
[[ "$NPUTOTHER" -gt 0 ]] && { echo "  ✗ 后台改库存出现非 0 响应码（$NPUTOTHER 次）"; BAD=1; }
[[ "$NCARTOTHER" -gt 0 ]] && { echo "  ✗ 加购/删购出现非 0 响应码（$NCARTOTHER 次）"; BAD=1; }
[[ -s $OUT/debug.txt ]] && head -3 $OUT/debug.txt
echo "RESULT 50001=$N50001 invariant_bad=$BAD"
echo "SUMMARY success=$NOK e42201=$N42201 other=$NOTHER carts=$NCARTOK"
[[ "$NOTHER" -gt 0 || "$N50001" -gt 0 || "$BAD" == "1" || "$NORDERS" != "$NOK" ]] && exit 1
exit 0
