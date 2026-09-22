【工序】执行 【模型】Sonnet 【等级】M
状态：完成

## 背景

处理 `docs/superpowers/notes/2026-09-22-scheduled-delivery-batch1-review.md` 中标为「建议」的 R3、R4、R7、R8、R10 五条（R9 是上线顺序约束，不改代码，不在本次范围）。方案见规划者产物（Opus 降级担任，方案原文存于编排者 TASK_DIR）。BASE = `715842d182df8ba65db1a20555c74f379ad5eef6`。

## 改动文件

- `apps/server/src/routes/admin/delivery.ts` —— R4：`POST /:id/ready` 在写 `readyAt` 之前加 `distanceM===null` 守卫，抛 42292，文案给出「立即呼叫」「自己送」两条出路。
- `apps/server/src/services/ticket/index.ts` —— R10：`toTicketInput` 的 `scheduledAt` 只在 `schedule` 非 null 时透传，`schedule` 为 null（即 `distanceM` 缺失）时回落为 null，避免 `content.ts` 的 `isScheduled` 误判走预约分支印空字段。
- `apps/server/src/services/delivery/schedule-tasks.ts` —— R7：`READY_DUE` 的 seq 从「该单 PrintJob 总行数 + 1」改为按 `printerSn` 分组取各组计数最大值 + 1；同时更正与实现不符的旧注释。
- `apps/server/src/routes/admin/workbench.ts` —— R8：`sortColumn` 把 `prepStartAt` 两行比较包进 `if (!newestFirst)`，done 列（`newestFirst=true`）不再被预约单排序打乱；顺带导出 `sortColumn`/`SortableCard` 供自测直接导入。
- `apps/server/src/routes/orders.ts` —— R3：`PUT /:id/cancel` 的 timed 分支与 `POST /:id/cancel-request` 两个端点，都在原有判断之前先识别「`pickupAt` 缺失」或「预约单 `distanceM` 缺失」两种数据异常情形，统一抛 42229「订单数据异常，请联系商家协商退款」（文案沿用 `git show 94e54aa:apps/server/src/routes/orders.ts` 原文），不再落进互相矛盾的两条文案。
- `apps/server/scripts/selftest-schedule.ts` —— 新增 3 条断言覆盖 R8（done 列 newestFirst 生效；非 done 列原口径不回归；非预约卡片零影响）。
- `scripts/e2e.d/69-scheduled-delivery.sh` —— 新增 ⑭ R4、⑮ R10、⑯ R7 三段，R7 段自行保存并恢复打印机设置。
- `scripts/e2e.d/62-pickup.sh` —— 新增 ⑭ R3 段，自带收尾（清打印作业、订单转 CANCELLED）。
- `docs/api.md` —— 附录 M 的 `POST /admin/local/orders/:id/ready` 条目与 42292 错误码说明补上 `distanceM` 缺失的新错误情形。

## 验证

1. `cd apps/server && npx tsc --noEmit` → 零错误（无输出）。
2. `cd apps/server && npx ts-node --transpile-only scripts/selftest-schedule.ts` → 「全部通过 17」（BASE 14 + 新增 3 条，覆盖 R8 两个方向）。
3. `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts` → 「全部通过 14」（与改前一致，无回归）。
4. e2e：干净、独立库 `food_shop_e2e_r3r4r7r8r10`（迁移+seed）、`PORT=3105`、`SCHEDULER_DISABLED=true`、`WECHAT_LOGIN_MOCK=true`、`WECHAT_PAY_MOCK=true`、`WECHAT_QRCODE_MOCK=true`、`LOCAL_DELIVERY_PROVIDER_MOCK=true`、`PRINTER_PROVIDER_MOCK=true`、`EXPRESS_PROVIDER_MOCK=true`、`TZ=Asia/Shanghai`；
   `DATABASE_URL=mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e_r3r4r7r8r10 BASE=http://localhost:3105 DB_NAME=food_shop_e2e_r3r4r7r8r10 TZ=Asia/Shanghai bash scripts/e2e.sh`
   → `================ 通过 2004 / 失败 1 ================`。§69 段 `✘` 计数 0；§62 段 `✘` 计数 1（见下「上报」，与本次五条无关的既有用例）。

## 偏离方案

- 无实质偏离。`sortColumn`/`SortableCard` 按方案授权（同文件、不改语义）导出以便 selftest 直接导入验证，避免走 e2e 备选路径。
- 验收标准第 4 条给的命令是 `DB_NAME=food_shop_e2e ...`；实跑时改用独立库名 `food_shop_e2e_r3r4r7r8r10`，原因见下「上报」第二条（`food_shop_e2e` 这个库名在本环境被并发会话共用，曾在两次探测中发现它被其他会话 DROP/重建，行数从 2000+ 落回 20）。除库名外命令其余部分与验收标准一致。

## 上报

1. **本次五条改动本身零问题**：§69 全段 `✘=0`，含新增的 R4/R7/R10 三个断言块与既有 99 条全部通过；§62 新增的 R3 断言块（5 条）全部通过。`tsc`/两个 selftest 均干净。
2. **e2e 末行不是「失败 0」，但剩下的 1 条失败与本次五条无关，是既有用例的既有问题**：
   - `scripts/e2e.d/62-pickup.sh` ⑬「自取单的取消申请不被自动驳回」——此用例不在本次授权范围内、未被本次改动触碰。它造一张 `pickupAt` = 明天首格的自取单，直接调用 `POST /orders/:id/cancel-request`。`cancelWindowOf` 的 PICKUP 分支（`orders.ts:135-143`，未改）只有在 `now >= pickupAt − selfCancelLeadMin(120min)` 时才允许申请取消；明天首格通常在 ~22–24 小时之外，远超 120 分钟，这次实跑时（北京时间 00:3x，明天首格算出是次日 00:00，距今约 23.5 小时）该调用会先一步被拒（走的是未改的原有文案分支，不是本次新加的「数据异常」分支——本次新分支只在 `pickupAt` 缺失时触发，这里 `pickupAt` 非空），导致 `cancel_requested_at` 从未写入，断言随之落空。这是一个跟时钟相关的既有用例缺陷（只有在本地时间落在大约 22:00–24:00 北京时间的窗口内才会偶然通过），与 R3（判的是 `pickupAt`/`distanceM` **缺失**这一种数据异常）无关，我未改动、也未在授权范围内（62-pickup.sh 虽在 allow.txt，但这条用例的时间窗口设计属于既有实现，改它超出本次「建议」范围）。已用连续 3 次干净库跑复现同一现象（含两次同一独立库名），排除了并发/脏库干扰。
   - `check-points-consistency.mjs`（e2e.sh:2555）在未显式导出 `DATABASE_URL` 时会退回读取 `apps/server/.env`（本 worktree 里指向 `food_shop_r5`，一个无关的既有开发库），与 `DB_NAME` 驱动的 `sql()` 不是同一个库；第一、二次实跑因为没给 `bash scripts/e2e.sh` 这层 shell 导出 `DATABASE_URL`，该检查误判了 `food_shop_r5` 里的历史脏数据（用户 #293），报「积分账本不一致」。第四次实跑补上 `DATABASE_URL` 环境变量后该检查通过（`✔ 所有用户的 pointsBalance 与积分账本一致`），确认与本次五条改动、与本次 e2e 测试数据都无关，是既有脚本调用约定上的一个环境陷阱（不在授权范围内，未修改 `check-points-consistency.mjs`/`e2e.sh`）。
3. **`DB_NAME=food_shop_e2e` 这个库名在本环境被其他并发会话共用**：验证过程中两次发现该库被外部 DROP/重建（行数从预期的数百行回落到刚 seed 完的 20 行），因此改用独立库名 `food_shop_e2e_r3r4r7r8r10` 跑最终验证，避免误判。这是本环境的并发使用情况，不是代码问题。
