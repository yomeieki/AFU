【工序】交付 【模型】Fable 【等级】L
状态：BLOCKED（仅因范围检查无法运行：`.agent/check-scope.sh` 与 `.agent/high-risk.txt` 不存在；§2.5 其余三项条件全部满足，Opus 复核三轮后无阻断项）
定级依据：§2.2 第 2 条——数据迁移（orders 加 4 列 + 索引、deliveries 加 1 列）+ 关键一致性逻辑（updateMany 条件写、呼叫占位与 readyAt 不变量、并发秒退守卫）。
运行模式：正常。规划由本会话（Fable）担任而非子 agent；执行 Sonnet 子 agent 逐 Task 串行；复核 Opus 新会话（同一会话完成三轮）。Task 1 的分派发生在协议送达之前，其分派消息未带交接声明（diff 已由编排者与 Opus 复核覆盖）。
完成内容：批次一服务端全部 10 个 Task（见方案 docs/superpowers/plans/2026-09-21-scheduled-delivery-batch1-server.md）：
- 数据：orders.scheduled_at/ready_at/prep_ticket_at/schedule_reminded_at + 索引；deliveries.call_origin（迁移 20260922000000_order_scheduled）
- 设置：local_delivery.schedule 九项 + 顶层 selfCancelLeadMin（默认 120）
- 纯函数：services/slots.ts（自取与外送共用切格）、services/delivery/schedule.ts（倒推时间轴、时段、phase、scheduleView）
- 接口：GET /api/local/delivery-slots；meta.delivery 四字段；POST /api/orders 收 scheduledAt（42290/42291）；详情 schedule 节；取消窗口改约定前 selfCancelLeadMin（自取一并）；POST /admin/local/orders/:id/ready；/call 收 force；accept-and-call 对预约单 42292；GET /admin/orders?schedule=；工作台 columns.scheduled / local.schedule / scheduleBar / scheduleEnabled
- 定时任务：schedPrepTicket / schedUnaccepted / schedNotReady / schedAutoCall / schedLate；现有任务排除预约单；repeatAnnounce 锚在接单截止
- 小票：来单票预约版式、PREP 备餐票、READY_DUE 催备好小条；来单推送带送达时段
- 测试：selftest-schedule.ts（14 条）；e2e §69（99 条）；§62 同步两小时口径
- 文档：docs/api.md 附录 M
提交范围：6dde37e..667c089（含编排者提交 7dbc53a `.agent/agent-protocol.md`、0737874 方案修订）
验证结果（均在最终代码 667c089 上由编排者实际运行；e2e 在 2daefa5 上跑，其后仅改 docs/api.md）：
- `cd apps/server && npx tsc --noEmit` → 零错误
- `npx ts-node --transpile-only scripts/selftest-schedule.ts` → 全部通过 14
- `npx ts-node --transpile-only scripts/selftest-pickup.ts` → 全部通过 14（与改前一致）
- `npx ts-node --transpile-only scripts/selftest-local-settings.ts` → 全部通过 35
- 干净库 food_shop_e2e、SCHEDULER_DISABLED=true、`DB_NAME=food_shop_e2e TZ=Asia/Shanghai bash scripts/e2e.sh` → `================ 通过 1986 / 失败 0 ================`，§62 / §69 ✘ 计数均为 0（日志 /tmp/food-shop-sched-aZAT/e2e-final.log）
- A6：`grep -rl scheduledAt apps/server/src` 12 个文件全部在 allow.txt
- A7：由 §69 ② 断言覆盖（meta.delivery.scheduleEnabled/earliestScheduleText/selfCancelLeadMin，老字段仍在）
- A8：docs/api.md 附录 M 在附录 L 之后（2112 行起），列出接口/任务/错误码/数据列
范围检查：未运行——`.agent/high-risk.txt` 与 `.agent/check-scope.sh` 在 BASE（6dde37e）与 main 中都不存在。手工核对：`git diff --name-only 6dde37e..HEAD` 共 27 个文件，除编排者/规划者两个产物（.agent/agent-protocol.md、方案文件）外全部在 allow.txt，deny.txt 零命中。
重要方案调整（规划者裁决，已写回方案文件）：
- Task 2：设置字段越界回落默认值而非夹取（与 local-settings.ts 既有 `int()` 语义一致），selftest 期望值随之修正。
- 复核 R1（阻断）：callRider 写 readyAt 挪到占位 delivery.create 之前并补 status 条件；顾客秒退条件写补「无在途配送单」守卫（2d8e561）。
- 复核 R2（阻断）：/ready 的 updateMany 判 count（2d8e561）。
- 复核 R6（阻断）：附录 M 插入位置（667c089）。
- 验收 A5 须带 `TZ=Asia/Shanghai`：本机为 JST，脚本 `date +%F` 在 JST 00:00–09:00 与服务端钉死的北京时间不同日，§33/§54/§38「今日」口径会红 25 条（既有 harness 现象，不是回归）。
建议（未实施，复核 Opus 提出）：
- R3：pickupAt/distanceM 缺失时「取消」与「申请取消」文案互相指向对方（orders.ts:1045 / :922）。
- R4：distanceM 为 null 的预约单点「已备好」既不呼叫也不报错（admin/delivery.ts /ready）。
- R7：READY_DUE「第 N 次提醒」按 PrintJob 行数计，≥2 台 LOCAL 打印机时票面序号跳号（schedule-tasks.ts:106），封顶按时间算不受影响。
- R8：「已完成」列里预约单按 prepStartAt 排在 newestFirst 之前（workbench.ts sortColumn）。
- R10：distanceM 为 null 的预约单票面印出空的「送达」「开始备餐 · 呼叫骑手」行（与 R4 同根因）。
未解决问题及证据：无阻断项。R9（上线顺序）见下。
需要用户授权的后续操作：
- 合并到 main（本会话未合并、未部署）。
- 上线顺序约束（复核 R9）：服务端可先上线但 `schedule.enabled` 必须保持关闭，直到批次一后半（后台前端 Workbench/设置页）上线——否则 WAITING 阶段的预约单会从现行工作台的待接单/备餐中列消失。
- 生产迁移 20260922000000_order_scheduled（纯加列，先迁移再切代码）。
- 提供 `.agent/high-risk.txt` 与 `.agent/check-scope.sh` 后可补跑范围检查。
- 下一批：批次一后半（后台前端 + 概览计数）计划、批次二（小程序）计划。
