echo "== 44. 出票核心（D 组：H2/B6/M1/H6）=="
# 复用 §35 定义的 PJOBS()/pay_new_order()、§36 定义的 sql()（同一个 shell，本文件在 e2e.sh
# 尾部被 source 进来，函数与变量仍在作用域内）；变量全部加 D44_ 前缀，避免跟 e2e.sh 主体或
# 其它分片的全局变量撞车（前一组在这里踩过 R1/R2 撞车导致收尾 rm 报 "File name too long" 的坑）。
ORIG_PRINTER_SETTINGS_44=$(req GET /api/admin/settings/printer "$AT" | jq -c .data)

echo "-- H2：备注含 <CUT>/<QR> 的订单，票面不含控制标签，且只剩末尾一个 <CUT> --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D44-H2","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"remark\":\"<CUT>前置切纸<QR>x</QR>\"}")
D44_H2_OID=$(jq -r '.data.orderId // .data.id // empty' <<<"$R")
[[ -n "$D44_H2_OID" ]] && ok "H2：下单成功 #$D44_H2_OID" || fail "H2：下单失败" "$R"
req POST "/api/orders/$D44_H2_OID/pay" "$UT" >/dev/null
sleep 0.3
D44_H2_CONTENT=$(PJOBS "$D44_H2_OID" | jq -r '.data.list[0].content')
D44_H2_CUTCOUNT=$(grep -o '<CUT>' <<<"$D44_H2_CONTENT" | wc -l | tr -d ' ')
assert_eq "H2：票面只剩末尾一个 <CUT>（备注注入的提前切纸已被剥掉）" "$D44_H2_CUTCOUNT" "1"
[[ "$D44_H2_CONTENT" != *"<QR>"* ]] && ok "H2：票面不含 <QR> 控制标签" || fail "H2：票面仍含 <QR>" "$D44_H2_CONTENT"
# esc() 只剥 <>，标签名本身作为普通文字保留（<CUT>→CUT、<QR>x</QR>→QRx/QR），
# 所以原始备注 "<CUT>前置切纸<QR>x</QR>" 剥完是 "CUT前置切纸QRx/QR"——断言含有意义的原文，
# 不要求标签名字也消失（那是转义的语义，不是本次要做的"剥除"）。
[[ "$D44_H2_CONTENT" == *"前置切纸"* ]] && ok "H2：备注文字本身保留（只剥尖括号不删内容）" || fail "H2：备注内容丢失" "$D44_H2_CONTENT"

# ── 切纸补白（2026-09-06 真机标定后补的回归护栏）───────────────────────────────
# 背景：FP-V58-WHC 的切刀在打印头下游约 5.5 行，`<CUT>` 就地切会把票尾拦腰截断。
# 真机标定切点稳定落在第 6 行补白中间，所以 assemble() 补 7 行。这个缺陷跑了两轮复核 +
# 一次生产部署都没被发现，因为**测试只看内容对不对，从不看内容后面有没有补白**。
#
# 两条断言各自能独立失败：
#   1. 补白行数不对（改小了、或被谁"顺手清理"掉）
#   2. 补白用了空字符串——连续 <BR> 会被飞鹅折叠，等于没补（第一次标定就栽在这里，
#      补 0/2/4/6 行四段表现完全一样）。所以必须断言补白里**有空格**，不能只数 <BR>。
D44_PAD_TAIL='<BR> <BR> <BR> <BR> <BR> <BR> <BR> <BR><CUT>'
[[ "$D44_H2_CONTENT" == *"$D44_PAD_TAIL" ]] \
  && ok "切纸补白：票面以 7 行空格补白 + <CUT> 结尾（切刀超前约 5.5 行）" \
  || fail "切纸补白：票尾补白缺失或行数不对，真机上会被拦腰切断" "...${D44_H2_CONTENT: -80}"
[[ "$D44_H2_CONTENT" != *"<BR><BR>"* ]] \
  && ok "切纸补白：没有连续 <BR>（空补白会被飞鹅折叠，等于没补）" \
  || fail "切纸补白：出现连续 <BR>，补白行是空的、会被折叠掉" "...${D44_H2_CONTENT: -80}"

echo "-- 同城双联：一次打印两段（配送联 + 厨房联），厨房联不含地址与金额 --"
# PO 2026-09-06 定：同城出双联。**邮寄仍是单联**——上面 H2 那单走的是邮寄，已断言只有 1 个 <CUT>，
# 两条合起来才说明「按渠道区分」真的生效，只测一边测不出来。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D44-DUAL","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
D44_DUAL_OID=$(mk_local_paid)
if [[ -n "$D44_DUAL_OID" ]]; then
  sleep 0.3
  D44_DUAL=$(PJOBS "$D44_DUAL_OID" | jq -r '.data.list[0].content')
  D44_DUAL_CUTS=$(grep -o '<CUT>' <<<"$D44_DUAL" | wc -l | tr -d ' ')
  assert_eq "同城双联：票面有 2 个 <CUT>（配送联 + 厨房联）" "$D44_DUAL_CUTS" "2"

  # 用第一个 <CUT> 切开两段分别断言——只在整票上 grep 分不出信息到底落在哪一联，
  # 而「厨房联不能有地址金额」正是这次改动的全部意义所在。
  D44_DELIV=${D44_DUAL%%<CUT>*}
  D44_KITCH=${D44_DUAL#*<CUT>}
  [[ "$D44_DELIV" == *"<CB>同城配送</CB>"* ]] && ok "同城双联：第一联是配送联" || fail "同城双联：第一联标题不对" "${D44_DELIV:0:120}"
  [[ "$D44_KITCH" == *"<CB>厨房联</CB>"* ]] && ok "同城双联：第二联是厨房联" || fail "同城双联：第二联标题不对" "${D44_KITCH:0:120}"
  [[ "$D44_DELIV" == *"地址："* ]] && ok "配送联：有地址（骑手要用）" || fail "配送联：缺地址" "${D44_DELIV:0:200}"
  [[ "$D44_DELIV" == *"实付："* ]] && ok "配送联：有实付金额" || fail "配送联：缺实付" "${D44_DELIV:0:200}"
  [[ "$D44_KITCH" != *"地址："* ]] && ok "厨房联：**不含地址**（顾客住址不进后厨）" || fail "厨房联：仍含地址" "$D44_KITCH"
  [[ "$D44_KITCH" != *"实付："* ]] && ok "厨房联：**不含金额**" || fail "厨房联：仍含金额" "$D44_KITCH"
  # ⚠️ 断言用**号码数字本身**，不要用「电话：」这种标签文字：2026-09-06 把标签从「电话：」
  # 改成「电话 」（放大后 16 列，冒号那一格会把行挤爆），旧断言当场变成永远通过的空断言。
  # 判据要盯真正不该出现的东西——号码，而不是它旁边的字。
  D44_TESTPHONE=$(sql "SELECT receiver_phone FROM orders WHERE id=$D44_DUAL_OID;")
  [[ -n "$D44_TESTPHONE" && "$D44_KITCH" != *"$D44_TESTPHONE"* ]] \
    && ok "厨房联：不含顾客电话（按号码本身断言，$D44_TESTPHONE）" \
    || fail "厨房联：仍含顾客完整号码" "$D44_KITCH"

  # 配送联的电话必须是脱敏的：票会贴在袋子上流出去，最后进垃圾桶
  [[ "$D44_DELIV" != *"$D44_TESTPHONE"* ]] \
    && ok "配送联：不含完整手机号（已脱敏）" \
    || fail "配送联：印了完整手机号，票流出去等于泄露顾客号码" "$D44_DELIV"
  [[ "$D44_DELIV" == *"****"* ]] \
    && ok "配送联：有 **** 掩码（不是整段电话都没印）" \
    || fail "配送联：既没有完整号也没有掩码，电话行可能整个丢了" "$D44_DELIV"
  # 前后 3/4 位要留着——店员靠这几位跟后台核对是不是同一单
  [[ "$D44_DELIV" == *"${D44_TESTPHONE:0:3}****${D44_TESTPHONE: -4}"* ]] \
    && ok "配送联：掩码保留前 3 后 4（${D44_TESTPHONE:0:3}****${D44_TESTPHONE: -4}）" \
    || fail "配送联：掩码格式不是前3后4" "$D44_DELIV"
  # 两联各自都要有补白——只补一联的话，被切断的就是厨房联
  D44_DUAL_PADS=$(grep -o '<BR> <BR> <BR> <BR> <BR> <BR> <BR> <BR><CUT>' <<<"$D44_DUAL" | wc -l | tr -d ' ')
  assert_eq "同城双联：两联各自都有切纸补白（只补一联会让厨房联被切断）" "$D44_DUAL_PADS" "2"
  # PO 2026-09-06：票面不再显示今日订单数
  [[ "$D44_DUAL" != *"今日第"* ]] && ok "票面不显示「今日第 N 单」" || fail "票面仍有「今日第 N 单」" "$D44_DUAL"
else
  fail "同城双联：造同城单失败，本组断言未执行" "mk_local_paid 返回空"
fi

echo "-- 商品规格不再被静默截断（长规格独占一行）--"
# 修复前：formatItemLine 把「名称+规格」硬压进 22 列，超出部分直接丢弃且不加省略号。
# 真机复现过「500克/切片/微辣」与「500克/切片/微辣/真空装」打出来一模一样 → 打包发错货。
if [[ -n "$D44_DUAL_OID" ]]; then
  sql "UPDATE order_items SET spec_text='500克/切片/微辣/真空装/加赠调料包' WHERE order_id=$D44_DUAL_OID;"
  # 前置自检 ①：sql() 把 stderr 丢进 /dev/null，UPDATE 写错列名/语法会**静默失败**，
  # 后面那条断言就会在「规格压根没被改长」的前提下轻松通过——本次会话已被这个坑咬过一次。
  #
  # 用 CHAR_LENGTH 而不是 `LIKE '%加赠调料包%'`：后者走**同一条管道**回读，客户端字符集错时
  # 查询串和存储值一起变成乱码、反而匹配上，自检照样绿（2026-09-06 实测踩过）。
  # 字符数是独立判据——latin1 误存时一个汉字会变成 3 个字符，长度立刻从 20 膨胀到 44。
  D44_SPEC_LEN=$(sql "SELECT CHAR_LENGTH(spec_text) FROM order_items WHERE order_id=$D44_DUAL_OID LIMIT 1;")
  assert_eq "长规格：前置——规格写进去了且未被字符集损坏（CHAR_LENGTH=20）" "${D44_SPEC_LEN:-0}" "20"
  R=$(req POST "/api/admin/orders/$D44_DUAL_OID/reprint" "$AT")
  sleep 0.3
  D44_SPEC=$(PJOBS "$D44_DUAL_OID" | jq -r '[.data.list[] | select(.kind=="REPRINT")][0].content')
  # 断言前先把折行接回去：长规格会被 wrapByWidth 拆到多行（`…加赠调<BR>  料包)`），
  # 直接按连续子串找「加赠调料包」会假失败——这是**渲染正确但断言写错**，2026-09-06 踩过。
  # 判据用**完整规格串**而不是末尾几个字：中间任何一段被吞掉都要能红。
  D44_SPEC_FLAT=${D44_SPEC//<BR>  /}
  [[ "$D44_SPEC_FLAT" == *"(500克/切片/微辣/真空装/加赠调料包)"* ]] \
    && ok "长规格完整保留（接回折行后与原文逐字一致）" \
    || fail "长规格被截断——两个不同 SKU 会打成一样，打包会发错货" "$D44_SPEC_FLAT"
fi
# 收尾：把本组留下的在途作业跑完再进下一组。B6 是竞态用例（固定 sleep 卡时序），
# 上一组遗留的 PENDING/SENDING 行会被它那次 run-scheduler 一并扫到，挤占同一轮的处理时间——
# 跨用例残留正是这类偶发红的常见来源。不断言，只清场。
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.5

echo "-- B6：立即发送与定时兜扫的竞争，同一 PrintJob 只应被物理发送一次 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D44-B6","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/delay "$AT" '{"sn":"D44-B6","ms":1200}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
D44_B6_OID=$(jq -r '.data.orderId // .data.id // empty' <<<"$R")
[[ -n "$D44_B6_OID" ]] && ok "B6：下单成功 #$D44_B6_OID" || fail "B6：下单失败" "$R"
req POST "/api/orders/$D44_B6_OID/pay" "$UT" >/dev/null   # 触发 enqueueOrderTicket 立即发送，mock print() 会睡 1.2s
sleep 0.3
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 旧实现：此时行仍是 PENDING，兜扫会再发一次；新实现：行已被认领成 SENDING，兜扫查不到它
sleep 1.5
D44_B6_JOBCOUNT=$(req GET "/api/admin/print-jobs?orderId=$D44_B6_OID" "$AT" | jq -r '.data.list | length')
D44_B6_MOCKCOUNT=$(req GET "/api/admin/system/printer-mock/jobs?sn=D44-B6" "$AT" | jq -r '.data | length')
assert_eq "B6：只有 1 条 PrintJob 记录" "$D44_B6_JOBCOUNT" "1"
assert_eq "B6：打印机物理只收到 1 次 print()（修复前这里是 2，厨房会做两份）" "$D44_B6_MOCKCOUNT" "1"
req POST /api/admin/system/printer-mock/delay "$AT" '{"sn":"D44-B6","ms":0}' >/dev/null

echo "-- M1：copies=2 的打印机，作业失败重试后仍然是 2 联 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D44-M1","channels":["LOCAL","EXPRESS"],"copies":2}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[50,50,50]}' >/dev/null
req POST /api/admin/system/printer-mock/fail "$AT" '{"sn":"D44-M1","kind":"CAPACITY","message":"D44 mock 首发强制失败一次"}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
D44_M1_OID=$(jq -r '.data.orderId // .data.id // empty' <<<"$R")
[[ -n "$D44_M1_OID" ]] && ok "M1：下单成功 #$D44_M1_OID" || fail "M1：下单失败" "$R"
req POST "/api/orders/$D44_M1_OID/pay" "$UT" >/dev/null
sleep 0.2
assert_eq "M1：首发被强制失败，PENDING(attempts=1)" "$(PJOBS "$D44_M1_OID" | jq -r '.data.list[0] | "\(.status):\(.attempts)"')" "PENDING:1"
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.3
D44_M1_ROW=$(PJOBS "$D44_M1_OID" | jq -c '.data.list[0]')
assert_eq "M1：重试成功后 status=SENT" "$(jq -r .status <<<"$D44_M1_ROW")" "SENT"
assert_eq "M1：PrintJob.copies 仍是 2（不是硬编码的 1）" "$(jq -r .copies <<<"$D44_M1_ROW")" "2"
assert_eq "M1：mock 实际收到的打印份数也是 2" "$(req GET "/api/admin/system/printer-mock/jobs?sn=D44-M1" "$AT" | jq -r '.data[0].copies')" "2"
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[5000,30000,120000]}' >/dev/null

echo "-- H6：申请取消 → 驳回 → 再申请，第二次仍能出票 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D44-H6","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
D44_H6_OID=$(mk_local_paid)
[[ -n "$D44_H6_OID" ]] && ok "H6：造一笔同城已支付单 #$D44_H6_OID" || fail "H6：造单失败（mk_local_paid 返回空）"
req POST "/api/admin/local/orders/$D44_H6_OID/accept" "$AT" >/dev/null
R=$(req POST "/api/orders/$D44_H6_OID/cancel-request" "$UT" '{"note":"D44 第一次申请"}')
assert_eq "H6：第一次申请取消 code 0" "$(code "$R")" "0"
sleep 0.3
R=$(req POST "/api/admin/local/orders/$D44_H6_OID/cancel-request/reject" "$AT")
assert_eq "H6：驳回 code 0" "$(code "$R")" "0"
sleep 0.3
R=$(req POST "/api/orders/$D44_H6_OID/cancel-request" "$UT" '{"note":"D44 第二次申请"}')
assert_eq "H6：驳回后可再次申请，code 0" "$(code "$R")" "0"
sleep 0.3
D44_H6_JOBS=$(PJOBS "$D44_H6_OID")
# 修复前：两次申请都是固定 seq=0 的 CANCEL，第二次会被 dedupe 吞掉，这里应为 1（漏出一张）
assert_eq "H6：两次申请各出一张 CANCEL_REQUEST（不被 dedupe 吞掉）" "$(jq -r '[.data.list[] | select(.kind=="CANCEL_REQUEST")] | length' <<<"$D44_H6_JOBS")" "2"
assert_eq "H6：驳回出一张 RESUME" "$(jq -r '[.data.list[] | select(.kind=="RESUME")] | length' <<<"$D44_H6_JOBS")" "1"
assert_eq "H6：全程还没有真正的 CANCEL（没同意退款）" "$(jq -r '[.data.list[] | select(.kind=="CANCEL")] | length' <<<"$D44_H6_JOBS")" "0"

# 复位：不让本段状态影响下一轮重跑时其它段（尤其是 §35 自己）的前置假设
req PUT /api/admin/settings/printer "$AT" "$ORIG_PRINTER_SETTINGS_44" >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
