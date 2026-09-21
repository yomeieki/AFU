【工序】规划 【模型】Fable 【等级】L
定级依据：§2.2 第 2 条——数据迁移（orders/deliveries 加列）+ 关键一致性逻辑（updateMany 条件写、呼叫占位与 readyAt 不变量）。
完整方案：docs/superpowers/plans/2026-09-21-scheduled-delivery-batch1-server.md（含每个 Task 的代码与步骤）；原始需求：docs/superpowers/specs/2026-09-21-scheduled-delivery-design.md。

## 验收标准
1. `cd apps/server && npx tsc --noEmit` → 零错误
2. `cd apps/server && npx ts-node --transpile-only scripts/selftest-schedule.ts` → 「全部通过 N」，N ≥ 14，退出码 0；须覆盖：六个倒推时刻取值、高峰取大者、开始备餐早于开门的格不出、暂停三种形态、休业、DISABLED、isValidDeliverySlot 精确命中、phase 七态、scheduleView null 分支
3. `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts` → 通过数与改动前一致（公共模块未改自取行为）
4. `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts` → 全部通过，含新增 3 条 schedule/selfCancelLeadMin 断言
5. `bash scripts/e2e.sh`（干净库 food_shop_e2e，SCHEDULER_DISABLED=true）→ 末行「失败 0」；§69 全部 ✔；§62 仍全绿（自取取消截止已改两小时口径）
6. `grep -rn "scheduledAt" apps/server/src --include=*.ts -l` → 每个文件都在授权范围内
7. `GET /api/local/meta` → delivery 节多 scheduleEnabled/slotMinutes/selfCancelLeadMin/earliestScheduleText，老字段全部仍在（e2e §69 ② 断言）
8. docs/api.md 附录 M 列出全部新端点、新参数、42290–42292、五条任务、四列

## 实现方向
1. orders 加 4 列 + 索引，deliveries 加 call_origin（prisma/schema.prisma、migrations/20260922000000_order_scheduled）
2. 设置节 schedule + selfCancelLeadMin（services/local-settings.ts、scripts/selftest-local-settings.ts）
3. 公共时段模块 services/slots.ts；倒推时间轴 services/delivery/schedule.ts；pickup.ts 改薄壳；scripts/selftest-schedule.ts
4. 公开时段接口与 meta（routes/local.ts）；下单/详情/取消窗口（routes/orders.ts）
5. 管理端：接单不重算、/ready、/call?force、callOrigin（routes/admin/delivery.ts、services/delivery/orchestrator.ts）
6. 五条定时任务 services/delivery/schedule-tasks.ts；现有任务排除预约单（tasks.ts、scheduler.ts）；repeatAnnounce 锚点（ticket/index.ts）；order-notify 两处
7. 小票：PREP/READY_DUE（ticket/printer.ts、content.ts、index.ts）
8. 来单推送、工作台快照、管理端列表/详情（order-notify.ts、routes/wechat-notify.ts、routes/admin/workbench.ts、routes/admin/orders.ts）
9. e2e §69 + §62 断言同步（scripts/e2e.d/69-scheduled-delivery.sh、62-pickup.sh）
10. docs/api.md 附录 M

## 授权范围
（见 /tmp/food-shop-sched-aZAT/allow.txt，25 条）

## 禁止修改
（见 /tmp/food-shop-sched-aZAT/deny.txt）

## 上报条件
- 需要改授权范围外的任何文件（尤其 services/refund.ts、services/cancel-request.ts、routes/admin/system.ts、services/delivery/callback.ts）
- tsc 报错落在计划没有列出的文件里
- selftest-pickup.ts 在 Task 3 之后任何一条由绿转红
- e2e §40–§68 任一段由绿转红
- 42290–42292 已被占用，或 Prisma 迁移在本地库失败
- callRider 内对 readyAt 的写入与 escalateSoloCalls 升级路径冲突

## 待用户决定
- 无（S1–S9 已由店主拍板；两条技术歧义已由规划者按计划「未决歧义」默认处理）
