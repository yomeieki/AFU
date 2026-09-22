【工序】交付 【模型】Fable 【等级】M
状态：BLOCKED → **合并后补记（2026-09-22）**：§62 ⑬ 的时钟依赖已由另一会话在 ece4bd0 修掉（两个窗口曾同时改同一段，本批那份已撤回），1b 以 8f4a13c 合入 main；main 上 admin tsc/test(107)/build、server tsc 均过，干净隔离库全量 e2e `================ 通过 2010 / 失败 0 ================`（TZ=Asia/Shanghai，端口 3104，库 food_shop_e2e_main）。验收标准 1–5 全部满足；唯一未满足的是 §2.5 第 4 条范围检查（脚本不存在），按协议严格读仍记 BLOCKED，代码与验收层面无遗留。
定级依据：§2.2 第 3 条——新功能的后台界面；不含迁移/认证/支付/并发一致性（呼叫与退款守卫在批次一服务端已由 Opus 复核关闭，本批只调用既有端点）。
运行模式：正常。规划由本会话（Fable）担任；执行 Sonnet 子 agent 逐 Task 串行（在独立 worktree `sched-1b-admin`、分支 `claude/scheduled-delivery-1b-admin`，基线 d5a3a91）；复核 Sonnet 新会话。
完成内容：方案 docs/superpowers/plans/2026-09-22-scheduled-delivery-batch1b-admin.md 的 Task 1–6：
- 类型与 API 调用（readyLocalOrder、callRider force、getOrders schedule）
- utils/schedule.ts 纯函数 + 单测
- 工作台：待接单列顶部「预约单」折叠组、顶栏下常驻倒计时条、七态胶囊与颜色、「已备好」「立即呼叫」按钮矩阵（预约单不给「接单并呼叫」）、抽屉倒推时刻与呼叫来源、顶栏「预约 N」
- 预约送达设置页 /settings/schedule（九项参数 + 自助取消截止 + 示例钟点），自取页只读提示
- 同城订单列表「预约 / 尽快」筛选、行内送达时段；详情页预约行、四个倒推时刻、呼叫来源
- 经营概览同城 tab「预约单」KPI（服务端 stats/local.ts 加 scheduledCount）
提交范围：d5a3a91..9189c32
验证结果：
- `cd apps/admin && npx tsc --noEmit` → 零错误（9189c32）
- `cd apps/admin && npm test` → 107 通过 / 0 失败（含 schedule.test.ts 6 条、order-list 3 条新断言）
- `cd apps/admin && npm run build` → 通过（含 check-admin-timezone.mjs）
- `cd apps/server && npx tsc --noEmit` → 零错误
- 干净库全量 e2e（`DB_NAME=food_shop_e2e TZ=Asia/Shanghai bash scripts/e2e.sh`）→ 隔离库 food_shop_e2e_1b、端口 3101：`================ 通过 1986 / 失败 1 ================`；唯一红 `scripts/e2e.d/62-pickup.sh:246`「自取单的取消申请不被自动驳回」（期望 1 实际 0）。诊断：⑬ 用「明天首格」造自取单并丢弃 cancel-request 返回值，而批次一已把自取的申请取消改为「约定前 selfCancelLeadMin=120 分钟内」（routes/orders.ts cancelWindowOf PICKUP 分支），只有在北京时间 22:00–24:00 跑才恰好在窗口内——批次一终验 23:40 跑所以绿；本次 01:00 跑必红。不是本批回归（本批未改服务端取消逻辑），也不是产品缺陷。§54 新断言「C⑩ kpi.scheduledCount 非负整数」✔。修法两行（⑬ 在申请前把 pickup_at 钉到 now+60 分钟并断言 code 0），文件不在本批 allow 清单，待授权。
- 人工检查（验收标准 5）→ 编排者在浏览器用独立库 food_shop_smoke（3102/5174）实测：工作台待接单列顶部「预约单 1」折叠组、顶栏下倒计时条「下一张预约单 01:10 开始备餐，还有 14 分钟 … 另有 1 张」、四种阶段胶囊（TICKETED「01:10 开始备餐」/ PREPPING「距应备好 18 分」/ CALL_DUE 橙色「应已备好 · 晚 3 分」/ READY_WAITING「已备好 · 01:16 自动呼叫」）、字段行与「现在呼叫预计 01:17 送达」、顶栏「预约 5」；抽屉按钮「已备好 / 立即呼叫 / 自己送 / 打给顾客」且无「接单并呼叫」；对 CALL_DUE 点「已备好」→ 确认框写明立即发单并预扣 → 卡片进等待配送员列（骑手 待抢单）；设置页九项 + 自助取消截止 + 示例「11:01 出票 · 11:11 接单截止 · 11:16 开始备餐 · 11:36 呼叫 · 12:00 送达」；同城订单「预约」筛选出 5 单、行内「预约 9-22 01:37」；概览同城 tab「预约单 5 · 占比 83.3%」；375px 手机：工作台折叠组与倒计时条正常，店铺设置子导航第五项「营业时间」被裁切需横向滑动。截图未落盘（复核者已注明）。
范围检查：未运行——`.agent/high-risk.txt` 与 `.agent/check-scope.sh` 不存在。手工核对：`git diff --name-only d5a3a91..HEAD` 全部在 allow 清单内，deny 零命中（21 个改动文件全部在 allow.txt 内（54 分片按 glob），deny 零命中）。
重要方案调整：
- Task 1 上报成立：`ColKey` 改为 `Exclude<keyof columns, 'scheduled'>`（Workbench.tsx:41），方案漏列的第四处枚举点。
- Task 4：示例钟点不用 `setHours`（时区检查脚本拦），改 `todayKey()+08:00`。
- Task 5：详情页「预约送达」行放独立段落而非自取分支内；切到自取筛选时清掉 URL 的 sched。
- 复核 R1（阻断）：抽屉换列/离开看板检测纳入 columns.scheduled，抽成纯函数 findCardColumn 并加单测；R2：设置页示例叠加高峰取大；R3：手机模式点倒计时条切到待接单页签（9189c32）。
建议（未实施）：
- 店铺设置子导航从四项变五项，375px 手机实测第五项被裁切需横向滑动（Task 4 上报 1 + 编排者实测）。
- 复核 R4：示例提示文案的边角措辞。
未解决问题及证据：① e2e §62 ⑬ 时间依赖（见验证结果）；② 范围检查未运行。复核建议 R4：示例提示文案在「预约单备餐时长 > 高峰上界」的少见配置下措辞与取值不符（数字正确），未实施。
需要用户授权的后续操作：
- 合并到 main（注意与另一会话在 `claude/same-city-delivery-booking-time-e9ceb6` 上的收口改动可能在 docs/api.md 冲突）。
- 上线：后台前端与服务端一起部署后，店主才可在「预约送达」页打开开关；小程序批次二未做，顾客端此时仍只有「尽快送达」。
- 提供 `.agent/check-scope.sh` 后补跑范围检查。
