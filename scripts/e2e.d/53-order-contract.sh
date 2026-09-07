echo "== 53. 订单契约：报价过期时刻 / 渠道过滤 / 幂等下单 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/mk_local_paid/sql 与 $AT/$UT/$PID/$ADDR/$LPID/$LADDR。
# 变量一律 D53_ 前缀。
#
# 这一段守的是双渠道导航改版依赖的三条服务端契约：
#   ① /local/quote 随报价下发 quoteExpiresAt——客户端不再自己写死一个 TTL。
#      原来小程序写「超过 10 分钟算陈旧」而服务端签 15 分钟，中间 5 分钟里
#      页面以为还新鲜、服务端已经准备拒了。
#   ② GET /orders 支持按渠道过滤——「我的订单」默认只看当前渠道。
#      必须服务端过滤：客户端分页后再筛会漏单（第 1 页 20 条里可能一条同城都没有）。
#   ③ POST /orders 幂等——同一个 clientRequestId 重复提交返回同一张单。
#      治的是「服务端已创建、客户端超时没收到」那一类重复下单。

echo "-- ① /local/quote 下发 quoteExpiresAt --"
D53_Q=$(req POST /api/local/quote "$UT" "{\"addressId\":$LADDR,\"subtotal\":5000}")
D53_EXP=$(jq -r '.data.quoteExpiresAt // "null"' <<<"$D53_Q")
D53_TOK=$(jq -r '.data.quoteToken // "null"' <<<"$D53_Q")
if [[ "$D53_EXP" =~ ^20[0-9]{2}-[0-9]{2}-[0-9]{2}T ]]; then ok "带 addressId 的报价返回 ISO 过期时刻（$D53_EXP）"
else fail "带 addressId 的报价应返回 quoteExpiresAt" "$D53_EXP"; fi
[[ "$D53_TOK" != "null" ]] && ok "同一次报价同时签发了 quoteToken" || fail "应同时签发 quoteToken" "$D53_TOK"

# 过期时刻必须落在「现在 + 15 分钟」附近；允许 60 秒的网络与时钟抖动。
# 这条断言真正在守的是「token 里的 e 与下发的 quoteExpiresAt 出自同一个 issuedAt」——
# 两边各取一次 new Date() 的话这里看不出来，但边界上会出现页面与服务端判定不一致。
# `date -j -u` 把输入按 UTC 解读——ISO 串本来就是 UTC，这样不必再自己算时区偏移。
# （原来用 `date +%z | sed` 取偏移：`+0800` 变成 `08`，bash 当八进制，直接报
#  「09: value too great for base」把这条断言静默跳过了。别再走那条路。）
D53_NOW=$(date -u +%s)
D53_EXP_S=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "${D53_EXP%.*}" +%s 2>/dev/null || echo 0)
if [[ "$D53_EXP_S" != "0" ]]; then
  D53_DELTA=$(( D53_EXP_S - D53_NOW - 900 ))
  [[ "${D53_DELTA#-}" -le 60 ]] && ok "过期时刻 ≈ 现在 + 15 分钟（偏差 ${D53_DELTA}s）" \
    || fail "过期时刻不是现在+15分钟" "偏差 ${D53_DELTA}s（exp=$D53_EXP_S now=$D53_NOW）"
else
  fail "quoteExpiresAt 解析失败" "$D53_EXP"
fi

# 匿名报价（只给坐标、不给 addressId）不签 token，因此也不该给过期时刻——
# 给一个悬空的时刻等于让客户端去判一张不存在的凭证还新不新鲜。
D53_ANON=$(req POST /api/local/quote "" '{"latE6":29350000,"lngE6":104790000,"subtotal":5000}')
assert_eq "匿名报价不签 token" "$(jq -r '.data.quoteToken' <<<"$D53_ANON")" "null"
assert_eq "匿名报价的 quoteExpiresAt 也是 null" "$(jq -r '.data.quoteExpiresAt' <<<"$D53_ANON")" "null"

echo "-- ② GET /orders 按渠道过滤 --"
# 先确保两个渠道各有至少一张单
D53_LOCAL_ID=$(mk_local_paid)
D53_EXP_R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
D53_EXPRESS_ID=$(jq -r '.data.orderId // empty' <<<"$D53_EXP_R")
[[ -n "$D53_EXPRESS_ID" ]] && ok "造一张邮寄单 #$D53_EXPRESS_ID" || fail "造邮寄单失败" "$D53_EXP_R"

D53_L=$(req GET "/api/orders?deliveryType=LOCAL&pageSize=50" "$UT")
assert_eq "deliveryType=LOCAL：每一行都是 LOCAL" \
  "$(jq -r '[.data.list[].deliveryType] | unique | join(",")' <<<"$D53_L")" "LOCAL"
assert_eq "deliveryType=LOCAL：包含刚造的同城单" \
  "$(jq --argjson id "${D53_LOCAL_ID:-0}" '[.data.list[] | select(.id == $id)] | length' <<<"$D53_L")" "1"

D53_E=$(req GET "/api/orders?deliveryType=EXPRESS&pageSize=50" "$UT")
assert_eq "deliveryType=EXPRESS：每一行都是 EXPRESS" \
  "$(jq -r '[.data.list[].deliveryType] | unique | join(",")' <<<"$D53_E")" "EXPRESS"
assert_eq "deliveryType=EXPRESS：包含刚造的邮寄单" \
  "$(jq --argjson id "${D53_EXPRESS_ID:-0}" '[.data.list[] | select(.id == $id)] | length' <<<"$D53_E")" "1"

# 不传 deliveryType 仍返回全部——不能因为加了过滤就改变既有行为。
D53_ALL=$(req GET "/api/orders?pageSize=50" "$UT")
assert_eq "不传 deliveryType 时两个渠道都在" \
  "$(jq -r '[.data.list[].deliveryType] | unique | sort | join(",")' <<<"$D53_ALL")" "EXPRESS,LOCAL"

# 非法值必须报错，**不能静默回退成「全部」**：那样前端拼错参数会看不出来，
# 顾客在「同城」tab 里看到邮寄单，而没有任何人收到信号。
D53_BAD_HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/orders?deliveryType=OTHER" -H "Authorization: Bearer $UT")
assert_eq "deliveryType=OTHER 返回 HTTP 400" "$D53_BAD_HTTP" "400"
assert_eq "deliveryType 传空串按不传处理（前端可能拼出 &deliveryType=）" \
  "$(req GET "/api/orders?deliveryType=&pageSize=50" "$UT" | jq -r '[.data.list[].deliveryType] | unique | sort | join(",")')" "EXPRESS,LOCAL"

echo "-- ③ clientRequestId 幂等下单 --"
# 必须是**合法 UUID**：服务端用 zod 的 .uuid() 校验（列宽 VARCHAR(36) 正好一个 UUID）。
# 随手拼个 "e2e-时间戳-随机数" 会被 400 拒掉，而那看起来像是幂等没实现。
d53_uuid() { uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || printf '%08x-%04x-4%03x-a%03x-%012x' \
  $RANDOM$RANDOM $RANDOM $RANDOM $RANDOM $RANDOM$RANDOM$RANDOM; }
D53_RID=$(d53_uuid)
D53_RID2=$(d53_uuid)
D53_STOCK0=$(req GET "/api/products/$PID" | jq -r '.data.stock')
D53_BODY="{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"clientRequestId\":\"$D53_RID\"}"
D53_R1=$(req POST /api/orders "$UT" "$D53_BODY")
D53_R2=$(req POST /api/orders "$UT" "$D53_BODY")
D53_ID1=$(jq -r '.data.orderId // empty' <<<"$D53_R1")
D53_ID2=$(jq -r '.data.orderId // empty' <<<"$D53_R2")
assert_eq "同一个 clientRequestId 两次提交返回同一张单" "$D53_ID2" "$D53_ID1"
assert_eq "重试返回的订单号也一致（返回体逐字段相同）" \
  "$(jq -r '.data.orderNo' <<<"$D53_R2")" "$(jq -r '.data.orderNo' <<<"$D53_R1")"
D53_STOCK1=$(req GET "/api/products/$PID" | jq -r '.data.stock')
assert_eq "库存只扣一次（$D53_STOCK0 → $D53_STOCK1）" "$((D53_STOCK0 - D53_STOCK1))" "1"
assert_eq "库里确实只有一张单挂这个 clientRequestId" \
  "$(sql "SELECT COUNT(*) FROM orders WHERE client_request_id='$D53_RID'")" "1"

# 换一个 id 就是一张新单——幂等不能宽到「同样的商品同样的地址就算重复」。
D53_R3=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"clientRequestId\":\"$D53_RID2\"}")
D53_ID3=$(jq -r '.data.orderId // empty' <<<"$D53_R3")
[[ -n "$D53_ID3" && "$D53_ID3" != "$D53_ID1" ]] && ok "换一个 clientRequestId 得到新单 #$D53_ID3" \
  || fail "换 id 应当创建新单" "$D53_R3"

# 不传 clientRequestId 的老客户端行为必须逐字节不变——邮寄结算页与本脚本大半处下单都不传。
D53_R4=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
D53_R5=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
D53_ID4=$(jq -r '.data.orderId // empty' <<<"$D53_R4")
D53_ID5=$(jq -r '.data.orderId // empty' <<<"$D53_R5")
[[ -n "$D53_ID4" && -n "$D53_ID5" && "$D53_ID4" != "$D53_ID5" ]] \
  && ok "不传 clientRequestId 时两次下单是两张单（老行为不变）" \
  || fail "不传 clientRequestId 的行为被改变了" "$D53_R4 / $D53_R5"
assert_eq "不传时该列为 NULL（唯一索引允许多行 NULL）" \
  "$(sql "SELECT COUNT(*) FROM orders WHERE id IN ($D53_ID4,$D53_ID5) AND client_request_id IS NULL")" "2"

# 非 UUID 一律拒收。列宽是 VARCHAR(36)，正好一个 UUID；放行任意字符串的话，
# 超长值会在写库时被 MySQL 截断（非严格模式下静默截断），两个不同的 id 截成同一个，
# 幂等就会把两张本该独立的单认成同一张。
D53_BADID='{"directItem":{"productId":'"$PID"',"quantity":1},"addressId":'"$ADDR"',"clientRequestId":"not-a-uuid"}'
assert_eq "非 UUID 的 clientRequestId 被 zod 拒掉（HTTP 400）" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/orders" \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $UT" -d "$D53_BADID")" "400"

# 幂等只在同一个用户内生效：唯一索引是 (user_id, client_request_id)。
# 不加 user_id 的话，A 拿 B 的 id 提交就会命中 B 的单、读到 B 的订单号与金额——是越权，不只是重复下单。
D53_U2=$(req POST /api/auth/wechat-login "" '{"code":"d53u2-'"$RANDOM$RANDOM"'"}' | jq -r '.data.token // empty')
if [[ -n "$D53_U2" ]]; then
  D53_A2=$(req POST /api/addresses "$D53_U2" '{"receiverName":"D53乙","receiverPhone":"13800000053","province":"四川省","city":"自贡市","district":"自流井区","detail":"D53 乙地址"}' | jq -r '.data.id // empty')
  D53_R6=$(req POST /api/orders "$D53_U2" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$D53_A2,\"clientRequestId\":\"$D53_RID\"}")
  D53_ID6=$(jq -r '.data.orderId // empty' <<<"$D53_R6")
  [[ -n "$D53_ID6" && "$D53_ID6" != "$D53_ID1" ]] \
    && ok "另一个用户用同样的 clientRequestId 得到自己的新单（幂等按用户隔离）" \
    || fail "幂等键跨用户串了——是越权" "甲单=$D53_ID1 乙单=$D53_ID6 $D53_R6"
  sql "DELETE FROM addresses WHERE id=$D53_A2;" 2>/dev/null || true
fi

echo "-- ④ 收尾：不把待付款单留给下一轮 --"
# 本段一共造了 5 张不付款的邮寄单（幂等首单、换 id 的新单、两张不带 id 的、乙用户那张）。
# 留着的话，**下一轮的 §16 会红在一个跟本段毫无关系的地方**：那一段用
# `payTimeoutMin=0` 把库里所有待付款单一起取消，再断言「库存正好回滚 +2」——
# 多几张残单就多回滚几件，实测差过 7 件。跨轮污染最难查就难在这里。
#
# 只把状态从「待付款」摘出来即可（库存回滚逻辑本段不负责验证，§16 才验）。
D53_UID=$(sql "SELECT user_id FROM orders WHERE id=${D53_ID1:-0}")
if [[ -n "$D53_UID" && "$D53_UID" =~ ^[0-9]+$ ]]; then
  sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(), cancel_reason='e2e-53 收尾'
       WHERE user_id=$D53_UID AND status='PENDING_PAYMENT' AND client_request_id IS NOT NULL;"
fi
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(), cancel_reason='e2e-53 收尾'
     WHERE id IN (${D53_ID3:-0}, ${D53_ID4:-0}, ${D53_ID5:-0}, ${D53_ID6:-0}, ${D53_EXPRESS_ID:-0})
       AND status='PENDING_PAYMENT';"
assert_eq "收尾自检：本段没有留下待付款单" \
  "$(sql "SELECT COUNT(*) FROM orders WHERE id IN (${D53_ID1:-0}, ${D53_ID3:-0}, ${D53_ID4:-0}, ${D53_ID5:-0}, ${D53_ID6:-0}, ${D53_EXPRESS_ID:-0}) AND status='PENDING_PAYMENT';")" "0"
