echo "== 47. 出票 · 复核第二轮（组三：R5/R8/R9/UNKNOWN；R4/R7/M4/M10 见报告的独立脚本验证）=="
# 变量全部加 G3_ 前缀，避免跟主脚本/其它分片的全局变量撞车（45 的教训：R1/R2 裸用会撞车）。
#
# R4（SENDING 孤儿回收窗口 15s→60s + 状态机回写落空即告警）、R7（mock 的「恢复即吐出」开关 +
# 竞态防护）、M4（processQueue 整轮墙钟预算）、M10（feie.ts _mapFeieError 是纯函数，mock 模式下
# 永远走不到，且它涉及的时序/纯函数验证用真实 wall-clock 秒级延迟，不适合塞进这个追求快速的
# e2e.sh）——这四条都用独立脚本（直接 import 生产代码，不经 HTTP）做了确定性的前后对比，
# 结果见本次交付报告，不在这里重复。

echo "-- R5：恢复补发只挑「这次离线期间」的行，不会把离线之前就已正常发出、还没确认的行也重发一遍 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"G3-R5","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
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
