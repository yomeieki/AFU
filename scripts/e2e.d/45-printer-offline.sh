echo "== 45. 离线语义（D2：H5/H5b/M11，取代原 H5 修法）=="
# 权威依据：docs/superpowers/notes/2026-09-05-review-findings.md「✅ 实验 E1 已完成...结果是乙」
# ——2026-09-05 真机实测（SN 222601993）证实打印机离线时 Open_printMsg 仍返回成功（票排进飞鹅
# 云端队列），print() 不会失败，H5 描述的「重试 3 次→FAILED→恢复补打」在真实世界里不会发生。
# 变量全部加 D45_ 前缀，避免跟 e2e.sh 主体或其它分片的全局变量撞车（前面有组在这里踩过 R1/R2
# 撞车导致收尾 rm -f 报 "File name too long" 的坑）。

echo "-- A：离线期间下单不推 FAILED，票进 mock 云端队列；恢复且 waiting>0 → clearQueue + 从本地表补发 --"
# 第二轮复核点名：「物理只收到 1 次 print」这条断言原来能过，纯粹因为 mock 自己永远不会凭空
# 制造第二次 print()——哪怕 recoverFromOfflineQueue 少了 R5/R7 的 queryJob-before-resend 检查，
# 物理也只会收到 1 次，断言测不出这条检查到底存在不存在。
# 这里改用 mock 的 `_markMockCloudJobPrinted`（见 mock.ts 注释）模拟 R7 的真实竞态：打印机在我们
# queryQueueInfo/clearQueue 这两次外呼之间的空档，已经自己把这张票物理吐出去了——cloudQueue 里
# waiting 依然汇报 >0（我们还没观测到清零），但这条具体的作业其实已经打印完成。
# 踩过的坑：一开始想用「恢复即整队列吐出」（_setMockAutoFlushOnRecover）测这条，但那个开关会在
# 状态切换的同时把 cloudQueue 整个清空——recoverFromOfflineQueue 一进来看到 waiting===0 就直接
# return 了（见 index.ts:860），根本走不到 queryJob-before-resend 那段代码，测出来的是「没触发
# 补发」而不是「触发了补发但被 queryJob 拦下来」，测不出东西；revert 掉 R5/R7 检查重跑一遍
# 断言照样是绿的（因为压根没走到那段代码），才发现这条路子是死的。改用只标记单条作业「已打印」、
# 不清空 cloudQueue 的 `_markMockCloudJobPrinted`，才能让 recoverFromOfflineQueue 真正跑到
# queryJob 那一步。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-A","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-A","state":"OFFLINE"}' >/dev/null
D45_A_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
# 这条断言只区分「新旧 mock」，不区分「新旧应用代码」——旧应用代码在新 mock（OFFLINE 不再抛
# CAPACITY，而是入队返回成功）下同样会得到 SENT，不代表旧代码当年真的不会把这单推成 FAILED
# （那是针对旧 mock 抛 CAPACITY 时的行为）。留着当回归护栏：以后如果谁把「打印机离线」重新
# 当成同步失败处理，这条会挂。
assert_eq "A：离线期间下发的作业不是 FAILED（回归护栏，非旧代码 bug 复现——理由见上方注释）" \
  "$(PJOBS "$D45_A_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "A：mock 云端队列里堆了 1 条（票排进了飞鹅队列，不在我们表里能挑）" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=D45-A' "$AT" | jq -r .data.waiting)" "1"
D45_A_PJID=$(PJOBS "$D45_A_OID" | jq -r '.data.list[0].providerJobId')
[[ -n "$D45_A_PJID" && "$D45_A_PJID" != "null" ]] && ok "A：拿到本地记录的 providerJobId=$D45_A_PJID" || fail "A：没拿到 providerJobId"
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 仍离线，只是建立 healthTrack（不触发恢复）
# 模拟 R7 竞态：飞鹅那边已经把这张票物理吐出去了，但 waiting 依然汇报 >0（我们还没观测到清零）
req POST /api/admin/system/printer-mock/mark-cloud-job-printed "$AT" "{\"providerJobId\":\"$D45_A_PJID\"}" >/dev/null
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-A","state":"ONLINE"}' >/dev/null
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # 恢复：waiting 仍 >0，会走到补发逻辑；应先 queryJob 确认已打印，跳过重发
sleep 0.2
assert_eq "A：恢复后 mock 云端队列清空（clearQueue 已调用）" \
  "$(req GET '/api/admin/system/printer-mock/queue?sn=D45-A' "$AT" | jq -r .data.waiting)" "0"
assert_eq "A：queryJob 前置检查确认已打印，该单改判 PRINTED（不是又重新走一遍 attemptSend 得到 SENT）" \
  "$(PJOBS "$D45_A_OID" | jq -r '.data.list[0].status')" "PRINTED"
assert_eq "A：打印机物理只收到 1 次真正的 print()（那 1 次是打印机自己吐出来的，不是 attemptSend 重发的；缺 queryJob 前置检查会因为无条件重发而变成 2 次）" \
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

echo "-- C：pm2 重启后 healthTrack 对这台打印机完全没有记录、且第一次轮询直接是 ONLINE（R9），恢复仍能正确补打 --"
# 第二轮复核点名：原来的用例在「模拟重启清空 healthTrack」之后，中间又多跑了一轮「仍离线」的
# run-scheduler——那一轮会把 track.wasOffline 重新置成 true，等于自己把刚清空的记忆又建了
# 回去，最终触发恢复靠的是普通的 wasOffline 分支（跟 A 测的是同一条路径），根本没测到 R9 专门
# 要处理的 isFirstSeen 分支。真实 pm2 restart 场景是：内存里的 healthTrack Map 整个被清空
# （不是被设成某个中性值——mock 的 /health-track 接口只能 set 不能整条删除某个 sn，没法真的
# 复现「这个 sn 在 map 里彻底不存在」），且进程重启后对这台打印机的第一次轮询完全可能直接就是
# ONLINE（打印机自己先恢复了，或者重启期间它一直没坏）。这里改用 /reset（连 healthTrack 一起
# 整个清空，包括 D45-C 从未被写入过）+ 全程不跑「仍离线」那一轮，让 D45-C 在恢复之后才第一次
# 被 printerHealthTask 检查到——这才是 R9 的 isFirstSeen 分支真正生效的场景。
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"D45-C","channels":["LOCAL","EXPRESS"],"copies":1}],"offlineAlertMin":5,"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null   # 连 healthTrack 一起清空——D45-C 在这之后还没被 printerHealthTask 检查过一次
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-C","state":"OFFLINE"}' >/dev/null
D45_C_OID=$(pay_new_order "$PID" "$ADDR")
sleep 0.2
# 刻意不在这里跑 run-scheduler——一旦跑过一次，healthTrack 就会建立起「曾经离线」的记忆，
# 之后测的就只是普通的「离线又恢复」（跟 A 一样），不是 R9 要防的「healthTrack 里对这台打印机
# 彻底没有任何记录、第一次轮询就直接是 ONLINE」这个更窄的场景。
req POST /api/admin/system/printer-mock/state "$AT" '{"sn":"D45-C","state":"ONLINE"}' >/dev/null   # 重启期间/重启前，打印机已经自行恢复上线
req POST /api/admin/system/run-scheduler "$AT" '{}' >/dev/null   # D45-C 有史以来第一次被 printerHealthTask 检查到，直接是 ONLINE（R9：isFirstSeen）
sleep 0.2
assert_eq "C：healthTrack 全无记录、第一次轮询即 ONLINE，仍正确补打，最终 SENT" "$(PJOBS "$D45_C_OID" | jq -r '.data.list[0].status')" "SENT"
assert_eq "C：打印机物理收到 1 次真正的 print()（旧代码在 isFirstSeen 场景下 wasOffline/alerted 全新落地都是 false，两条恢复路径一条都不触发，物理是 0 次——云端排队的票和本地记录都永远没人再理）" \
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
