echo "== 47. 出票 · 复核第二轮（组三：R5/R8/R9/UNKNOWN；R4/R7/M4/M10 见报告的独立脚本验证）=="
# 往轮残留隔离（2026-09-08 查实的「时红时绿」根因，与 §45 同一处理）：
# 恢复补发按 printerSn 捞时间窗内的作业，而本段每轮复用同一批 SN（G3-*），
# printer-mock/reset 只清 mock 不清 print_jobs——上几轮的行会被这一轮的恢复再打一遍，
# 「物理收到 N 次」就多出前几轮的张数（实测 +5 = 上一轮 R5 的 5 单）。
# 挪出时间窗（而不是只改状态：另有「FAILED 补打」路径会把 FAILED 再打回 SENT）。
sql "UPDATE print_jobs SET created_at = DATE_SUB(created_at, INTERVAL 2 DAY), status = IF(status IN ('PENDING','SENT'),'FAILED',status), last_error = IF(status IN ('PENDING','SENT'),'STALE:DROPPED',last_error) WHERE printer_sn LIKE 'G3-%' AND created_at > DATE_SUB(NOW(3), INTERVAL 1 DAY);"
assert_eq "47 前置：往轮残留的 G3-* 作业已挪出补发窗口" "$(sql "SELECT COUNT(*) FROM print_jobs WHERE printer_sn LIKE 'G3-%' AND created_at > DATE_SUB(NOW(3), INTERVAL 1 DAY);")" "0"
# 变量全部加 G3_ 前缀，避免跟主脚本/其它分片的全局变量撞车（45 的教训：R1/R2 裸用会撞车）。
#
# R4（SENDING 孤儿回收窗口 15s→60s + 状态机回写落空即告警）、R7（mock 的「恢复即吐出」开关 +
# 竞态防护）、M4（processQueue 整轮墙钟预算）、M10（feie.ts _mapFeieError 是纯函数，mock 模式下
# 永远走不到，且它涉及的时序/纯函数验证用真实 wall-clock 秒级延迟，不适合塞进这个追求快速的
# e2e.sh）——这四条都用独立脚本（直接 import 生产代码，不经 HTTP）做了确定性的前后对比，
# 结果见本次交付报告，不在这里重复。

echo "-- R5：恢复补发只挑「这次离线期间」的行，不会把离线之前就已正常发出、还没确认的行也重发一遍 --"
# ⚠️ `repeat.maxTimes:0` 是这一段能稳定下来的前提，不是可有可无的装饰（2026-09-06 查偶发红）。
# 本段把打印机配成**只有 G3-R5 一台**，而 `repeatAnnounce`（未接单重复播报）扫的是**全库**
# `status='PAID'` 的历史残留单（orders 表从不清，审计库攒了两千多条），选中后
# `enqueueOrderTicket(REPEAT)` 把票路由到「当前配置的打印机」——也就是 G3-R5。于是**任何一次
# 落在下面这个离线窗口里的 scheduler tick**，都会往 G3-R5 的 mock 云端队列里塞几张跟本段毫无
# 关系的催单票：`waiting` 不再是 1，恢复后它们还各自补发一次，物理也不再是 6 ——
# 正是偶发失败的那两条断言（其余 5 条照常绿，这个特征可用来认症状）。
# 而「哪一次 tick 落在窗口里」由两个与本段无关的时钟决定，所以是偶发而不是必现：
#   ① e2e 自己的显式 tick —— e2e.sh:1409 特意把 repeat-min-wait 设成 0 主动播报一次，
#      若它在 R5 前约 40 秒把 everyMin=2 分钟的冷却刷掉就绿，冷却恰好在这 40 秒里到期就红
#      （实测某轮：§35 那次 75s 被挡、R5 这次 117s——差 3 秒没过线、紧接着 P7a 那次 120s 整）；
#   ② 服务端自己的 60s 心跳（services/scheduler.ts 的 TICK_MS），落进这 8 秒窗口就红
#      （实测某轮它落在 §44，5 张催单票就记在 D44-DUAL 头上，差 12 秒没落到 R5）。
# 从前这行不写 `repeat`，sanitize 填的是默认值（expressAfterMin=10 / everyMin=2 / maxTimes=5），
# 等于把本段的成败押在上面那两个时钟的相位上。maxTimes:0 让 `announceCount >= maxTimes` 恒成立，
# repeatAnnounce 走不到 enqueueOrderTicket，两个时钟怎么落都不会有票混进 G3-R5。
# 断言一个字没放松（仍是 waiting==1、物理==6）——关掉的是与本段无关的噪声源，不是被测的性质。
# 最小复现（一单不下，只把残留单的催单冷却清零再跑一轮调度）：不带这个 repeat 块 waiting 0→4，
# 带上 0→0。同一类隐患也在 R7-MAJ / R5-GAP（同样「单台打印机 + 断言精确物理张数」），只是它们
# 排在 P7a 之后、冷却刚被刷新，暂时轮不到它们接住；要一起钉死就照抄这个 repeat 块。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-R5","channels":["LOCAL","EXPRESS"],"copies":1}],"repeat":{"localAfterMin":60,"expressAfterMin":60,"everyMin":60,"maxTimes":0,"reprint":false},"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R5","state":"ONLINE"}' >/dev/null

G3_R5_PRE_OIDS=()
for i in 1 2 3 4 5; do
  oid=$(pay_new_order "$PID" "$ADDR")
  G3_R5_PRE_OIDS+=("$oid")
done
sleep 0.2
G3_R5_PRE_OK=1
for oid in "${G3_R5_PRE_OIDS[@]}"; do
  [[ "$(PJOBS "$oid" | jq -r '.data.list[0].status')" == "SENT" ]] || G3_R5_PRE_OK=0
done
assert_eq "R5 前置：离线之前的 5 单都已正常 SENT" "$G3_R5_PRE_OK" "1"

# 关键：这 5 单的 sentAt 必须清楚地早于「离线开始」的判定时刻——不然 sentAt>=offlineSince 的
# 边界会因为下单和下面探测离线之间只差几百毫秒而判不清楚（真机场景这个间隔通常是几分钟量级，
# 这里用一次真实 sleep 撑开安全边际，比代码里的缓冲窗口 RECENT_SENT_BUFFER_MS=5s 更宽松）。
sleep 6

req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R5","state":"OFFLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 建立 offlineSince/wasOffline（仍离线）
G3_R5_DURING_OID=$(pay_new_order "$PID" "$ADDR")   # 离线期间下的这一单，排进 mock 云端队列
sleep 0.2
assert_eq "R5：离线期间下的这一单也是 SENT（排进了云端队列，不是 FAILED）" \
  "$(PJOBS "$G3_R5_DURING_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "R5：mock 云端队列里有 1 条积压" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=G3-R5' "$AT" | jq -r .data.waiting)" "1"

req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R5","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：应只补发第 6 单，不碰前 5 单
sleep 0.2

G3_R5_PHYS=$(req GET "/api/admin/system/printer-mock/jobs?sn=G3-R5" "$AT" | jq -r '.data | length')
assert_eq "R5：打印机物理只多收到这 1 次真正的 print()，总计 6 次（旧实现会把前 5 单也判进补发窗口，物理变成 11 次）" \
  "$G3_R5_PHYS" "6"

# 期望：离线**之前**那 5 单被 queryJob 确认已打印 → PRINTED（这是比停在 SENT 更准确的终态，
# 2026-09-06 去掉 sentAt 过滤后才走得到这条路径）；离线**期间**那单被重发 → SENT。
# 真正要守住的性质是「一单都没被重印、一单都没变成 FAILED」——物理次数上面那条已经锁死了，
# 这里只锁「没有任何一单掉进 FAILED」。
G3_R5_PRE_PRINTED=0
for oid in "${G3_R5_PRE_OIDS[@]}"; do
  [[ "$(PJOBS "$oid" | jq -r '.data.list[0].status')" == "PRINTED" ]] && G3_R5_PRE_PRINTED=$((G3_R5_PRE_PRINTED+1))
done
assert_eq "R5：离线前那 5 单被 queryJob 确认成 PRINTED（不是停在 SENT 无人问津）" "$G3_R5_PRE_PRINTED" "5"
assert_eq "R5：离线期间那单被补发后是 SENT" \
  "$(PJOBS "$G3_R5_DURING_OID" | jq -r '.data.list[0].status')" "SENT"
G3_R5_ANY_FAILED=0
for oid in "${G3_R5_PRE_OIDS[@]}" "$G3_R5_DURING_OID"; do
  [[ "$(PJOBS "$oid" | jq -r '.data.list[0].status')" == "FAILED" ]] && G3_R5_ANY_FAILED=1
done
assert_eq "R5：没有任何一单掉进 FAILED" "$G3_R5_ANY_FAILED" "0"

echo "-- P7a：催单绑营业时间——邮寄非营业时段不催且不烧次数，同城照常催 --"
# PO 2026-09-06 定：同城打烊后继续催（钱已收，19:58 进来的单不能因为 20:00 一到就没人管）；
# 邮寄非营业时间一律不催（深夜没人在店里）。营业时间复用同城那一套（店就一个）。
# ⚠️ 关键性质：邮寄被跳过时**不能推进 announceCount** —— 否则打烊那几小时把 maxTimes
# 空烧完，第二天开门反而一次都不催，正好是这个门控要避免的相反效果。
P7A_ORIG_LOCAL=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-BIZ","channels":["LOCAL","EXPRESS"],"copies":1}],"repeat":{"localAfterMin":1,"expressAfterMin":1,"everyMin":1,"maxTimes":5,"reprint":false},"offlineAlertMin":30,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
# 把营业时段设成一个绝不包含"现在"的窗口 → 店处于打烊状态
req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.businessHours=[{"start":"03:00","end":"03:01"}]' <<<"$P7A_ORIG_LOCAL")" >/dev/null

P7A_EXPRESS_OID=$(pay_new_order "$PID" "$ADDR")
[[ -n "$P7A_EXPRESS_OID" ]] && ok "P7a：前置——邮寄单已下单支付 #$P7A_EXPRESS_OID" || fail "P7a：下单失败"
sleep 0.2
# ⚠️ paid_at 必须老过**库里所有残留 PAID 单**，不是「够老就行」。
# repeatAnnounce 的候选是 `orderBy paidAt asc take 100`，而开发库反复跑 e2e 会攒下上千条
# 残留 PAID 单（2026-09-06 实测 1508 条，第 100 老的是当天上午）。付款时间只往回推 30 分钟
# 的话，这一单根本进不了扫描窗口 —— 于是「不催」的断言会因为「压根没被扫到」而假绿，
# 看起来门控生效了，其实门控一次都没被触达。用一个远早于任何残留的时间点钉死。
# （同一个坑咬过飞鹅接线那一轮，它当时把一条断言弱化成了「任务不抛异常」。）
sql "UPDATE orders SET paid_at = '2026-08-01 00:00:00.000' WHERE id=$P7A_EXPRESS_OID;"
# ⚠️ 自检：sql() 把 stderr 重定向到 /dev/null，UPDATE 写错了会**静默失败**。
# 不验这一条的话，下面「不催」的断言会因为「等待时间根本没到」而假绿——
# 看起来门控生效了，其实门控压根没被触达。（2026-09-06 本人第一版就踩了这个坑。）
assert_eq "P7a：前置——paid_at 已推到远早于所有残留单（catch sql() 静默失败）" \
  "$(sql "SELECT IF(paid_at < '2026-08-02','yes','no') FROM orders WHERE id=$P7A_EXPRESS_OID;")" "yes"
assert_eq "P7a：前置——该单确实排进了 repeatAnnounce 的扫描窗口（最老 100 条）" \
  "$(sql "SELECT IF((SELECT COUNT(*) FROM orders WHERE status='PAID' AND paid_at < (SELECT paid_at FROM orders WHERE id=$P7A_EXPRESS_OID)) < 100,'yes','no');")" "yes"
assert_eq "P7a：前置——该单是 EXPRESS（门控只对邮寄生效）" \
  "$(sql "SELECT delivery_type FROM orders WHERE id=$P7A_EXPRESS_OID;")" "EXPRESS"
assert_eq "P7a：前置——催单首次延迟已设成 1 分钟" \
  "$(req GET /api/admin/settings/printer "$AT" | jq -r .data.repeat.expressAfterMin)" "1"
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.3
assert_eq "P7a：打烊时邮寄单不催" \
  "$(sql "SELECT announce_count FROM orders WHERE id=$P7A_EXPRESS_OID;")" "0"
assert_eq "P7a：也没有留下 REPEAT 作业" \
  "$(sql "SELECT COUNT(*) FROM print_jobs WHERE order_id=$P7A_EXPRESS_OID AND kind='REPEAT';")" "0"
# 再跑几轮，确认次数没有被空烧
for _ in 1 2 3; do req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null; sleep 0.1; done
assert_eq "P7a：连跑多轮后 announceCount 仍是 0（没有空烧 maxTimes）" \
  "$(sql "SELECT announce_count FROM orders WHERE id=$P7A_EXPRESS_OID;")" "0"

# 开门 → 同一单应该开始催
req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.businessHours=[{"start":"00:00","end":"23:59"}]' <<<"$P7A_ORIG_LOCAL")" >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.3
assert_eq "P7a：开门后同一单开始催（次数没被之前的打烊时段吃掉）" \
  "$(sql "SELECT announce_count FROM orders WHERE id=$P7A_EXPRESS_OID;")" "1"

req PUT /api/admin/settings/local-delivery "$AT" "$P7A_ORIG_LOCAL" >/dev/null

echo "-- B1-ORDER：先清队列补发、再补打 FAILED，且预算耗尽时绝不「删了不补」--"
# 终审发现的第 7 例「两个各自正确的改动叠加」：
#   ① prevBad 分支先跑 retryRecoveredPrinterJobs，它发出去的票当场进飞鹅云端队列 → waiting≥1
#   ② recoverFromOfflineQueue 看到 waiting>0 就 clearQueue，把**自己刚发出去的票**删掉
#   ③ 补发循环这时预算已烧光，第一次迭代就 break
#   ④ printerHealthTask 结尾清空 wasOffline/wasBad → 下一轮不再进这个分支
#   结果：票被删了、补不回来、零告警。
# 修法是「顺序调换 + 预算不够就整个跳过」。这里锁住可观测的那一半：
# 一条 FAILED 作业在恢复后被补打出来，且没有被随后的清队列吞掉。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-ORD","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":30,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[10,10,10]}' >/dev/null
# 先造一条 FAILED：ABNORMAL 让 print() 真失败，耗尽重试
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-ORD","state":"ABNORMAL"}' >/dev/null
G3_ORD_OID=$(pay_new_order "$PID" "$ADDR")
for _ in 1 2 3 4; do sleep 0.15; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null; done
sleep 0.3
assert_eq "B1-ORDER：前置——该作业已耗尽重试成 FAILED" \
  "$(PJOBS "$G3_ORD_OID" | jq -r '.data.list[0].status')" "FAILED"
# 再制造一次「离线 → 有积压 → 恢复」，让两条恢复路径在同一轮里都被触发
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-ORD","state":"OFFLINE"}' >/dev/null
G3_ORD_QUEUED=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 建立 wasOffline/wasBad
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-ORD","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：先清队列补发，再补打 FAILED
sleep 0.5
assert_eq "B1-ORDER：离线期间那单被补发（没被 clearQueue 吞掉）" \
  "$(PJOBS "$G3_ORD_QUEUED" | jq -r '.data.list[0].status')" "SENT"
assert_eq "B1-ORDER：FAILED 那单被补打出来（补打发生在清队列之后，不会被删）" \
  "$(PJOBS "$G3_ORD_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "B1-ORDER：云端队列已清空" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=G3-ORD' "$AT" | jq -r .data.waiting)" "0"
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[5000,30000,120000]}' >/dev/null

echo "-- R7-MAJORITY：恢复时飞鹅已经自己把队列吐完（waiting=0），我们不该再动它 --"
# 真机实测：通电 74s 后打印机在线时，队列里那张票**已经自己吐出来了**、waiting 归 0。
# 而我们的健康检测是 60s 轮询 —— 绝大多数情况下我们观测到的就是 waiting=0，
# recoverFromOfflineQueue 一进来就 return，整套 clearQueue + 补发一行都不执行。
# mock 默认不模拟这个瞬间（刻意简化），导致上面 R5/R8 那些用例全部押在 waiting>0 这条
# **少数**路径上，多数路径覆盖为零。这里用 /auto-flush 把多数路径也变成可测。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-MAJ","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/auto-flush "$AT" '{"sn":"G3-MAJ","enabled":true}' >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-MAJ","state":"OFFLINE"}' >/dev/null
G3_MAJ_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
assert_eq "R7-MAJ：离线期间那单进了云端队列" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=G3-MAJ' "$AT" | jq -r .data.waiting)" "1"
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 建立 wasOffline
# 切 ONLINE 的同时飞鹅自己把队列吐完（真机行为），我们的轮询晚一步才看到
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-MAJ","state":"ONLINE"}' >/dev/null
assert_eq "R7-MAJ：飞鹅已自行吐完，waiting 归 0" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=G3-MAJ' "$AT" | jq -r .data.waiting)" "0"
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复检测：应当什么都不做
sleep 0.3
# 关键：票已经出去了，不能被再印一遍
assert_eq "R7-MAJ：物理只印 1 次（飞鹅吐的那次），恢复检测没有重复补发" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=G3-MAJ" "$AT" | jq -r '.data | length')" "1"
# 已知的现实后果，用断言把它钉住而不是留在报告里：waiting=0 时我们提前 return，
# 那条行不会被 queryJob 确认，只能等 processQueue 的 SENT 确认循环去推进（3 分钟后）。
assert_eq "R7-MAJ：该行仍是 SENT（多数路径下恢复检测不参与确认，由 SENT 确认循环负责）" \
  "$(PJOBS "$G3_MAJ_OID" | jq -r '.data.list[0].status')" "SENT"
req POST /api/admin/system/printer-mock/auto-flush "$AT" '{"sn":"G3-MAJ","enabled":false}' >/dev/null

echo "-- R5-GAP：真实断线与我们探测到之间的空档，票不能被 clearQueue 删掉又不补发 --"
# `offlineSince` 是**健康检测轮询探测到坏状态**的时刻，不是打印机真正断线的时刻。
# scheduler 心跳 60s，所以两者之间天然有 0–60 秒的空档。这段空档里下的单：
#   print() 成功（飞鹅云端排队）→ 行是 SENT，sentAt 落在 offlineSince **之前**
#   恢复时 clearQueue 把它从飞鹅侧删掉，若补发窗口又把它排除 → **票被我们删了还不补**，
#   永久停在 SENT，24h 后打上 CONFIRM:GAVE_UP 再也没人碰 → 静默丢单。
# 下面用 sleep 6 模拟这个探测延迟（只要超过任何「秒级缓冲」即可）。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-GAP","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-GAP","state":"OFFLINE"}' >/dev/null
G3_GAP_OID=$(pay_new_order "$PID" "$ADDR")     # 真实断线之后、我们探测到之前下的单
sleep 6                                          # 探测延迟
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 这一刻才 offlineSince=now
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-GAP","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：清队列 + 补发
sleep 0.3
assert_eq "R5-GAP：探测空档里的票被补发出来（不是被 clearQueue 删掉就没了）" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=G3-GAP" "$AT" | jq -r '.data | length')" "1"
assert_eq "R5-GAP：云端队列已清空" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=G3-GAP' "$AT" | jq -r .data.waiting)" "0"

echo "-- R8：恢复检测不会把 M4 的 GAVE_UP 僵尸行武断改判成 FAILED/STALE:DROPPED --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-R8","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R8","state":"ONLINE"}' >/dev/null
G3_R8_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
G3_R8_ID=$(PJOBS "$G3_R8_OID" | jq -r '.data.list[0].id')
# 模拟 M4 的 GAVE_UP 僵尸行：SENT 超过 24h 还没确认，created_at 顺带拉到 40 分钟前（超过 30 分钟窗口）
sql "update print_jobs set created_at=DATE_SUB(NOW(3), INTERVAL 40 MINUTE), last_error='CONFIRM:GAVE_UP' where id=$G3_R8_ID;"

req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R8","state":"OFFLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 建立 wasOffline（仍离线）
# ⚠️ 这一单不能省：recoverFromOfflineQueue 开头有 `if (waiting <= 0) return`，
# 而 GAVE_UP 那条僵尸行是打印机在线时下的、票直接进了 mock 的 jobs、cloudQueue 是空的。
# 不在离线期间补一单把 waiting 顶上去，整段 stale 查询（R8 的 OR 排除子句就在那里）
# 根本不会被执行——2026-09-06 实测：把那条 OR 子句整行删掉，下面两条断言照样全绿，
# 也就是说它们原本证明能力为零。补这一单之后才真正有区分度。
G3_R8_QUEUED=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R8","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：应该跳过这条 GAVE_UP 僵尸行
sleep 0.2
G3_R8_ROW=$(PJOBS "$G3_R8_OID" | jq -c '.data.list[0]')
assert_eq "R8：GAVE_UP 僵尸行恢复检测后原样保持 SENT（旧写法会武断改判 FAILED）" "$(jq -r .status <<<"$G3_R8_ROW")" "SENT"
assert_eq "R8：lastError 仍是 CONFIRM:GAVE_UP，没被覆盖成 STALE:DROPPED" "$(jq -r .lastError <<<"$G3_R8_ROW")" "CONFIRM:GAVE_UP"
# 期望 2 而不是 1：① 最初那单（打印机在线时直接印出）② 离线期间那单（入云端队列，
# 恢复时被合法补发）。**关键是没有第 3 次**——那条 GAVE_UP 僵尸行没有被重印。
# 如果 R8 的 OR 排除子句被删掉，僵尸行会被判成 STALE:DROPPED（上面两条先转红），
# 这一条也会跟着变（实测 2026-09-06：删掉 OR 子句后三条全红）。
assert_eq "R8：物理印出 2 次（最初 + 离线补发），僵尸行没有被重印成第 3 次" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=G3-R8" "$AT" | jq -r '.data | length')" "2"

echo "-- R9-a：补打 FAILED 作业跟 alerted 解耦——ABNORMAL(缺纸/开盖) 从未触发过告警也照样补打 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-R9A","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":30,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[50,50,50]}' >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R9A","state":"ABNORMAL"}' >/dev/null
G3_R9A_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # attempts 2（仍 ABNORMAL，offlineAlertMin=30 分钟远未触发）
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # attempts 3
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # attempts 4 → FAILED（4 次发送耗尽）
sleep 0.2
assert_eq "R9-a 前置：4 次发送耗尽后 FAILED，且 alerted 全程未触发（offlineAlertMin=30 分钟）" \
  "$(PJOBS "$G3_R9A_OID" | jq -r '.data.list[0].status')" "FAILED"

req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R9A","state":"ONLINE"}' >/dev/null   # 换纸/合盖，恢复
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：alerted 从未 true，旧写法这里什么都不做
sleep 0.2
assert_eq "R9-a：即使从未告警过，ABNORMAL 恢复后 FAILED 作业照样被自动补打成 SENT（旧写法会永远停在 FAILED）" \
  "$(PJOBS "$G3_R9A_OID" | jq -r '.data.list[0].status')" "SENT"

echo "-- R9-b：pm2 重启（healthTrack 清空）后第一次轮询恰好是 ONLINE，仍能补打此前遗留的 FAILED 作业 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-R9B","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":30,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[50,50,50]}' >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R9B","state":"ABNORMAL"}' >/dev/null
G3_R9B_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.3; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.2
assert_eq "R9-b 前置：同样耗尽到 FAILED" "$(PJOBS "$G3_R9B_OID" | jq -r '.data.list[0].status')" "FAILED"

# 模拟 pm2 restart：healthTrack 被清空（进程内 Map，重启即丢），同时打印机自身已经修好了——
# printer-mock/reset 顺带把 mock 的 forcedState 也清空，默认状态正是 ONLINE，恰好对应
# 「重启时故障早已排除、第一次轮询直接看到 ONLINE」这个真实场景。不碰 DB，FAILED 的这一行还在。
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 重启后第一次轮询：ONLINE，track 缺失
sleep 0.2
assert_eq "R9-b：重启后首次轮询即 ONLINE，仍按「可能刚恢复」处理一次，FAILED 作业被补打成 SENT（旧写法两条恢复路径一条都不走，永远停在 FAILED）" \
  "$(PJOBS "$G3_R9B_OID" | jq -r '.data.list[0].status')" "SENT"

echo "-- UNKNOWN：跟工作台 summarizePrinterStatus 的口径统一，归入 bad，不会被当成「已恢复」而清空离线计时 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-UNKNOWN","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":1,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
# 直接注入「90 秒前就已经进入异常」的既有计时（跳过真实等 1 分钟），alerted 尚未触发
req POST /api/admin/system/printer-mock/health-track "$AT" '{"sn":"G3-UNKNOWN","offlineSinceMsAgo":90000,"alerted":false}' >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-UNKNOWN","state":"UNKNOWN"}' >/dev/null
R=$(req POST /api/admin/system/run-scheduler "$AT" '{}')
G3_UNKNOWN_HEALTH=$(jq -r '.data.printerHealth // 0' <<<"$R")
assert_eq "UNKNOWN：归入 bad 后，已持续 90s 超过 offlineAlertMin=1 分钟，本轮应触发告警（printerHealth 累计数>=1；旧口径把 UNKNOWN 当成「良好」，这里恒为 0）" \
  "$([[ "$G3_UNKNOWN_HEALTH" -ge 1 ]] && echo yes || echo no)" "yes"

# 复位，避免影响后续可能重跑的分片/联调
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req PUT /api/admin/settings/printer "$AT" '{"enabled":false,"printers":[]}' >/dev/null
