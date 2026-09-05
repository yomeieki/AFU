echo "== 45. 离线语义（D2：H5/H5b/M11，取代原 H5 修法）=="
# 权威依据：docs/superpowers/notes/2026-09-05-review-findings.md「✅ 实验 E1 已完成...结果是乙」
# ——2026-09-05 真机实测（SN 222601993）证实打印机离线时 Open_printMsg 仍返回成功（票排进飞鹅
# 云端队列），print() 不会失败，H5 描述的「重试 3 次→FAILED→恢复补打」在真实世界里不会发生。
# 变量全部加 D45_ 前缀，避免跟 e2e.sh 主体或其它分片的全局变量撞车（前面有组在这里踩过 R1/R2
# 撞车导致收尾 rm -f 报 "File name too long" 的坑）。

echo "-- A：离线期间下单不推 FAILED，票进 mock 云端队列；恢复且 waiting>0 → clearQueue + 从本地表补发，物理只印 1 次 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-A","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-A","state":"OFFLINE"}' >/dev/null
D45_A_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
assert_eq "A：离线期间下发的作业不是 FAILED（修复前 H5 字面修法会推成 FAILED）" \
  "$(PJOBS "$D45_A_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "A：mock 云端队列里堆了 1 条（票排进了飞鹅队列，不在我们表里能挑）" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=D45-A' "$AT" | jq -r .data.waiting)" "1"
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 仍离线，只是建立 healthTrack（不触发恢复）
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-A","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：应清空云端队列 + 从本地记录补发
sleep 0.2
assert_eq "A：恢复后 mock 云端队列清空（clearQueue 已调用）" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=D45-A' "$AT" | jq -r .data.waiting)" "0"
assert_eq "A：该单最终仍是 SENT（等待下一轮确认，没被判失败）" \
  "$(PJOBS "$D45_A_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "A：打印机物理只收到 1 次真正的 print()（云端排队的旧项被 clearQueue 丢弃，不是又多印一次）" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=D45-A" "$AT" | jq -r '.data | length')" "1"

echo "-- B：30 分钟前的旧单，恢复时不补打，标 FAILED/STALE:DROPPED，且始终没被真正打印过 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-B","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-B","state":"OFFLINE"}' >/dev/null
D45_B_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
D45_B_ID=$(PJOBS "$D45_B_OID" | jq -r '.data.list[0].id')
sql "update print_jobs set created_at=DATE_SUB(NOW(3), INTERVAL 40 MINUTE) where id=$D45_B_ID;"
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 仍离线，建立 healthTrack 的 wasOffline
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-B","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：检测到 wasOffline，应清队列+按窗口甄别
sleep 0.2
D45_B_ROW=$(PJOBS "$D45_B_OID" | jq -c '.data.list[0]')
assert_eq "B：30 分钟前的旧单恢复时不补打，标 FAILED" "$(jq -r .status <<<"$D45_B_ROW")" "FAILED"
assert_eq "B：lastError=STALE:DROPPED（不是新故障，不占告警配额）" "$(jq -r .lastError <<<"$D45_B_ROW")" "STALE:DROPPED"
assert_eq "B：打印机自始至终没有真正收到过这条" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=D45-B" "$AT" | jq -r '.data | length')" "0"

echo "-- C：healthTrack 被清空（模拟 pm2 restart，H5 当年的原始 bug 场景）后，恢复仍能正确补打 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-C","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-C","state":"OFFLINE"}' >/dev/null
D45_C_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 建立 healthTrack（仍离线）
# 模拟进程重启：healthTrack 被清空，但 mock 打印机自身的在线状态、云端队列都不受影响
req POST /api/admin/system/printer-mock/health-track "$AT" '{"sn":"D45-C","offlineSinceMsAgo":null,"alerted":false}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 重启后第一次轮询：仍离线，重新建立起「曾经离线」的记忆
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-C","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：即便中途 healthTrack 被清空过，仍应正确补打
sleep 0.2
assert_eq "C：healthTrack 清空后恢复仍正确补打，最终 SENT" "$(PJOBS "$D45_C_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "C：打印机物理收到 1 次真正的 print()" \
  "$(req GET "/api/admin/system/printer-mock/jobs?sn=D45-C" "$AT" | jq -r '.data | length')" "1"

echo "-- D：M11 TIMEOUT 最多重试 1 次（在线才重试），第 2 次仍超时 → FAILED --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-D","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[50,50,50]}' >/dev/null
req POST /api/admin/system/printer-mock/fail "$AT" '{"sn":"D45-D","kind":"TIMEOUT","message":"D45 mock 首发超时"}' >/dev/null
D45_D_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
assert_eq "D：首次超时（在线）安排 1 次重试，PENDING(attempts=1)" \
  "$(PJOBS "$D45_D_OID" | jq -r '.data.list[0] | "\(.status):\(.attempts)"')" "PENDING:1"
req POST /api/admin/system/printer-mock/fail "$AT" '{"sn":"D45-D","kind":"TIMEOUT","message":"D45 mock 重试仍超时"}' >/dev/null
sleep 0.2; req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null
sleep 0.2
assert_eq "D：第 2 次仍超时 → FAILED(attempts=2)，不是 CAPACITY/BUSINESS 那套 4 次上限" \
  "$(PJOBS "$D45_D_OID" | jq -r '.data.list[0] | "\(.status):\(.attempts)"')" "FAILED:2"
req POST /api/admin/system/printer-mock/retry-delays "$AT" '{"delays":[5000,30000,120000]}' >/dev/null

echo "-- E：TIMEOUT 且当前无法确认打印机在线 → 更保守，直接 FAILED，不安排那 1 次重试 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-E","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-E","state":"OFFLINE"}' >/dev/null
req POST /api/admin/system/printer-mock/fail "$AT" '{"sn":"D45-E","kind":"TIMEOUT","message":"D45 mock 首发超时且打印机确认离线"}' >/dev/null
D45_E_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
assert_eq "E：确认不在线 → 首次超时即 FAILED(attempts=1)，不浪费那 1 次重试机会" \
  "$(PJOBS "$D45_E_OID" | jq -r '.data.list[0] | "\(.status):\(.attempts)"')" "FAILED:1"
