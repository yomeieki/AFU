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

G3_R5_ALL_SENT=1
for oid in "${G3_R5_PRE_OIDS[@]}" "$G3_R5_DURING_OID"; do
  [[ "$(PJOBS "$oid" | jq -r '.data.list[0].status')" == "SENT" ]] || G3_R5_ALL_SENT=0
done
assert_eq "R5：6 单最终都还是 SENT，没有任何一单的状态被误改" "$G3_R5_ALL_SENT" "1"

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
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"G3-R8","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：应该跳过这条 GAVE_UP 僵尸行
sleep 0.2
G3_R8_ROW=$(PJOBS "$G3_R8_OID" | jq -c '.data.list[0]')
assert_eq "R8：GAVE_UP 僵尸行恢复检测后原样保持 SENT（旧写法会武断改判 FAILED）" "$(jq -r .status <<<"$G3_R8_ROW")" "SENT"
assert_eq "R8：lastError 仍是 CONFIRM:GAVE_UP，没被覆盖成 STALE:DROPPED" "$(jq -r .lastError <<<"$G3_R8_ROW")" "CONFIRM:GAVE_UP"
assert_eq "R8：打印机物理只有最初那 1 次真实印出，恢复检测没有让它被重印第 2 次" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=G3-R8" "$AT" | jq -r '.data | length')" "1"

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
