# 全国邮寄接快递100 · 三批次衔接审核 + 目标达成审核方案（2026-09-09）

> 审核对象：main `527bf2e`（批次一报价 / 批次二预约取件 / 批次三轨迹签收对账），已于 2026-09-09 11:18 部署到生产。
> 审核方式：opus 对三批之间的 10 条接缝做代码级对抗审计（只看接缝，不重审各批内部），控制方按 spec E1–E11 与 e2e 覆盖整理成验收方案。
> 目标来源：`docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md` §0 一句话目标与 §1 E1–E11。

## 一、结论先行

| 项 | 结论 |
|---|---|
| 目标达成度 | E1–E11 共 11 条决策：**10 条已实现，1 条（E7 签收自动完成）部分实现** |
| 三批衔接 | 10 条接缝：7 条 OK，2 条 RISK，**1 条 GAP（Critical）** |
| 自动化门禁 | e2e §56–§61 共 218 条断言、全量 1480/0（干净库）；tsc 两端、selftest、admin/miniapp 单测全绿 |
| 生产状态 | 代码已上线；**计费模式仍是 TABLE 且兜底表为 0**（店主待执行 `/home/ubuntu/express-quote-mode.sql` 或在新版邮寄设置页保存） |
| 阻断上线的问题 | 无。Critical 是「快递100 漏推 10 直推 13」这一小概率路径，需补一处即可 |

## 二、三批衔接审核（10 条接缝）

| # | 接缝 | 结论 | 一句话 |
|---|---|---|---|
| 1 | 报价 → 下单 → 预约的金额链 | OK | 快照复用要求「2 小时内 + 重量相同」，TABLE 单靠 `ignoreMode` 现查仍能预约；预约重量与报价重量同源 |
| 2 | 设置的单一真相 | RISK | 无模块级缓存副本；但旧接口 `PUT /admin/settings/shipping` 会静默把全店切回 TABLE 一口价（本次线上「显示 0 元」正是它造成的） |
| 3 | 订单状态机贯穿三批 | **GAP（Critical）** | 状态回调直接推 `13` 而预约未到 PICKED 时，预约变 DELIVERED、订单永久卡 PREPARING，无任何告警 |
| 4 | Shipment 双写 | OK | 终态守卫 + `activeOrderId===orderId` 双保险；取消预约→手填发货→迟到回调不会覆盖 |
| 5 | 顾客端契约跨批 | OK | 小程序读的字段服务端全发；老邮寄单三张卡正确降级 |
| 6 | 工作台/后台跨批 | OK | 「填单号发货」受活跃预约门控；成本行读批次二三的费用列 |
| 7 | 定时任务集合 | RISK（Minor） | `expressUnpicked` 与 `expressStale` 同一 tick 对同一预约各发一条近义告警 |
| 8 | 回调面 | OK | 同 salt/同限流/同 ack；nginx 独立 location；启动自检覆盖更长的 `/track` |
| 9 | 错误码与文案 | OK（文档两处缺） | 42260–42270 各定义一次、全部在用；`42210`（邮寄起送）与 `42225`（回调地址超长）用了但邮寄章节未列 |
| 10 | E1–E11 达成度 | 10/11 | 见第三节 |

### 2.1 Critical — 接缝 3：`13` 直达时订单卡死

- 现象：`KD_EXPRESS_STATUS_MAP['13']` 是 rank 100，`canTransition('BOOKED'|'ACCEPTED','DELIVERED')` 为真。快递100 漏推 `10` 直接推 `13` 时，`express-callback.ts` 把预约推到 DELIVERED、`activeOrderId` 置空，但订单联动是 `where status='SHIPPED'`，0 行。
- 后果：订单永远 PREPARING；`Shipment.shippedAt` 不写、发货通知不发；7 天自动完成（只认 SHIPPED）、`reconcileExpressStale`（只扫 BOOKED/ACCEPTED/PICKED）、未取件提醒都够不到；顾客端物流卡「已取件」与订单状态「备货中」自相矛盾；工作台卡片留在备货中列并给出「预约取件」按钮，店员可能再下一单。
- 为什么三条签收路径只有它漏了：轨迹签收（`express-track.ts`）与对账（`express-booking-tasks.ts`）都做了「先补 10 再 13」，回调本身没做；e2e §59 的 `13` 断言永远排在 `10` 之后，覆盖不到。
- 修法：把「DELIVERED 且 `statusRank < PICKED` 时先按 `10` 走一遍」下沉到 `applyProviderStatus`，三个调用方共用；`reconcileExpressStale` 加一支「预约终态但订单仍 PAID/PREPARING」的兜底查询 + 一次性告警；e2e §59 加「BOOKED 直推 13」用例。

### 2.2 Important — 接缝 2：旧接口 `PUT /admin/settings/shipping`

- `applyLegacyShipping` 强制 `mode=TABLE`、把每组首重价覆盖成同一个一口价、续重清 0、包邮线覆盖成同一条，且无告警。
- 现存调用方：admin 前端 `api/admin.ts` 两个死导出（无引用）；`scripts/e2e.sh` 6 处（非生产）；服务端首次读取的迁移（有意）。任何一个没刷新的旧管理端标签页都能打到它——2026-09-09 11:24 的线上事件即是。
- 修法：删 admin 死导出；`PUT /shipping` 改为非生产才挂载，或写入前发系统告警；`docs/api.md:1597`「批次二后计划删除」改口。

### 2.3 Minor 清单（合并处理）

| 接缝 | 问题 | 修法 |
|---|---|---|
| 1 | 快照保鲜以 `order.createdAt` 为基准，实际报价可能早 30 分钟 | 快照记 `quotedAt`，`getBookingQuotes` 用它判 2 小时 |
| 1 | 只有 1 家回价退兜底时快照仍存那 1 条，预约弹窗首屏只显示一家有价 | 复用条件加「有价家数 ≥ minQuoteCount」 |
| 1 | 快照 quotes 类型断言含 `defPriceFen` 但实际不存 | 给快照 quotes 定义窄类型 |
| 4 | `express-booking.ts` 两处 Shipment upsert 无 `activeOrderId` 守卫（靠上下文保证） | 加 where 条件 |
| 5 | PAID（未接单）也显示「商家备货中」物流卡 | 阶段文案白名单去掉 PAID |
| 5 | 预约卡里的 `shipment.remark` 行恒不显示（预约路径不写 remark） | 删该行 |
| 7 | 未取件提醒与对账无进展提醒同一 tick 双发 | `remindExpressUnpicked` 候选加 `staleRemindedAt: null`，或删掉前者 |
| 7 | UNKNOWN 认领后同一 tick 对账再查一次 detail | 可忽略 |
| 8 | 42225 文案用字符数、比较用字节数；启动自检假设订单号 ≤ 6 位；回调限流 120/min 状态+轨迹共用 | 文案改字节；上界改 `E9999999999-999`；限流提到 300 并观测 |
| 9 | `42210`、`42225` 未列入 api.md 邮寄章节 | 补两行；`42225` 语义与同城不同，宜换空位码 |

## 三、目标达成度（spec E1–E11）

| 决策 | 状态 | 实现处 | 自动化覆盖 |
|---|---|---|---|
| E1 中位数 + 加价 + 向上取整，回价不足退兜底表 | 实现 | `express-quote.ts`（median/roundUp/table） | §56、selftest-express-quote 16 条 |
| E2 重量 = Σ净重×数量 + 包装附加重，缺净重用默认 | 实现 | `calcPackageWeightKg`；默认 800 g / 300 g | §56、§58（改重量重查价） |
| E3 全部家报价、最便宜默认选中并标注、店员可改 | 实现 | `ExpressBookingModal.tsx`；服务端 `ignoreMode` 九家 | §58；工作台走查 |
| E4 时段每次手选、预填最近可约、一单一约 | 实现 | `validateSlot/suggestSlot`；`activeOrderId @unique` + 42265 | §58、selftest-express-booking |
| E5 省级不寄送名单，顾客端禁止下单 | 实现 | `RegionGroup.blocked`；三处拦截 42260 | §56、§57 |
| E6 分组满额包邮，与不寄送共用分组表 | 实现 | `freeShipMinFen` + `findRegionGroup`，按券前小计 | §56、§57 |
| E7 结算页运费 / 详情预约·接单·取件 / 轨迹时间线 / 签收自动完成 | **部分** | 前三项完整；签收自动完成在「回调直推 13」路径有洞（2.1） | §57、§59、§61；miniapp 单测 79 |
| E8 接单后 N 分钟顾客可申请取消 | 实现 | `acceptGraceMin`、`cancelWindowOf`、自动驳回 | §60 |
| E9 退款政策沿用；活跃预约先取消 | 实现 | 42263/42264；同意取消先撤约再退款 | §60 |
| E10 货物名「食品」；不保价不面单 | 实现 | `pickup.cargoName`；`_buildBookParam` 无保价/面单字段 | selftest-kd100-express |
| E11 路子 A 独立搭，只共用签名/请求/超时 | 实现 | 独立设置/报价/表/路由/状态机；共用 `kd100-client.ts` | 同城 §40–§53 全绿、同城文件零 diff |

e2e 断言分布：§56 报价 25、§57 下单 22、§58 预约 38、§59 回调 34、§60 守卫 33、§61 轨迹 66。

## 四、目标达成审核方案（验收怎么做）

分三层，前两层已在本次完成并全绿，第三层要店主在生产上按顺序点。

### 4.1 自动化层（每次合并前，已通过）

- `apps/server` / `apps/admin` `tsc --noEmit`；五个 selftest（kd100 6、kd100-express 6、express-settings 10、express-quote 16、express-booking 21）；admin `npm test` 12 + build；miniapp 单测 79；`check-channel-consistency`；ES5 闸门。
- 干净库 e2e `SCHEDULER_DISABLED=true` 全量：当前 1480/0。同城 §40–§53 与邮寄 §56–§61 同一份门禁，断言数只增不减。

### 4.2 代码审计层（本次完成）

- 每任务 opus 复核 + 每批终审 + 本次三批接缝审计。结论见第二节；待修项已按严重度排列。

### 4.3 生产验收层（店主执行，按 E1–E11 逐条打勾）

前置：① 执行 `/home/ubuntu/express-quote-mode.sql` 或在新版邮寄设置页把计费模式切 QUOTE、兜底表填非 0 并保存；② 后台标签页强制刷新，确认有「计费模式」下拉框；③ 微信开发者工具或体验版指向生产。

| 步骤 | 验证的决策 | 操作 | 期望 |
|---|---|---|---|
| 1 | E1/E2 | 结算页选四川地址、再选江苏地址、再把同一商品数量 ×3 | 三次运费都不为 0，省外 > 省内，数量增加后运费上升或不变（首重内不变） |
| 2 | E5 | 选新疆地址 | 页面提示「该地区暂不支持邮寄」，付款按钮禁用 |
| 3 | E6 | 四川地址把小计凑到 ≥ 包邮线 | 运费行显示「已包邮」，合计不含运费 |
| 4 | E11 | 切到同城渠道下一单 | 同城运费与流程与改动前完全一致 |
| 5 | E3/E4 | 邮寄单付款 → 后台接单 → 工作台「预约取件」 | 弹窗按价排序、最便宜标「最低」且默认选中、顺丰灰显（账号未配价）、时段预填、确认文案含预扣金额 |
| 6 | E4 | 09:00–09:00 点确认 | 提示「取件时段至少 1 小时」，确认禁用 |
| 7 | E8 | 顾客端在接单后 10 分钟内点「申请取消」 | 工作台卡片出现「顾客要退菜」徽标，有「同意退款 / 驳回」；超 10 分钟入口消失 |
| 8 | E9 | 有活跃预约时后台点全额退款 | 报 42263「请先取消预约再退款」；部分退款放行 |
| 9 | E9 | 同意顾客取消申请 | 预约变 CANCELLED、订单退款；顾客端显示退款 |
| 10 | E7 | 真快递员接单、上门取件（真单，花预扣运费） | 卡片「快递员已接单 · 姓名」→ 取件后订单自动「已发货」、顾客收到发货通知、抽屉成本行有预扣 |
| 11 | E7 | 等轨迹推送 | 顾客端「物流轨迹」最新在上；抽屉「最新轨迹 · 共 N 条」 |
| 12 | E7 | 等签收 | 订单自动「已完成」，顾客端物流卡「已签收」；「确认收货」按钮消失 |
| 13 | E7 兜底 | 取件后把 `express_bookings.picked_at` 改到 11 天前（只对测试单） | 30 分钟内对账任务查单；仍无结论只提醒一次 |
| 14 | 回调面 | 按 `docs/deployment.md` 伪回调演练（状态 + 轨迹两条 curl，只对测试单） | HTTP 200 固定 ack，抽屉状态/最新轨迹变化；`/api/kd-express/` 响应无 gzip |
| 15 | 成本 | 收到 15 结算后看抽屉成本行 | 预扣/实扣/计费重三数齐全；实扣/预扣 > 1.2 时店员群收到一次告警 |
| 16 | 收尾 | 测试单标 `isTest`（`docs/ops-test-orders.md`） | 经营概览不计入 |

每一步截图留档到 `docs/local-delivery-run-log.md` 同款的邮寄跑单日志（建议新建 `docs/express-shipping-run-log.md`）。

### 4.4 外部依赖（不在代码内、影响验收范围）

- 顺丰在当前快递100 账号「当前线路未设置价格」，需商务开通；开通后自动进入报价列表。
- 快递100 测试环境 key 未申请，§12.6 的测试平台推状态验证只能用生产真单替代。
- `detail` 按 `thirdOrderId` 查询是否可用未在真实环境验证；UNKNOWN 对账若查不到走人工核对路径。

## 五、建议的下一步（批次四·收尾）

1. Critical：`applyProviderStatus` 内置「13 直达先补 10」+ 对账兜底「预约终态但订单仍备货」+ e2e §59 新用例。
2. Important：下线 `PUT /admin/settings/shipping` 写侧（非生产保留给 e2e）+ 删 admin 死导出 + 文档改口。
3. Minor 批处理：第 2.3 节清单。
4. 验收：店主按 4.3 表跑一遍真单并留档。

以上 1–3 预计一个小批次（一个 SDD 任务组、一次终审），不动同城，不加迁移。

## 六、整改状态（批次四）

> 实施计划：`docs/superpowers/plans/2026-09-09-express-shipping-batch4-closeout.md`。Task 1（Critical，`a897e78`）、Task 2（Important + Minor 批处理 + 文档，本提交）。

### Critical（第 2.1 节）

- **已修（`a897e78`）**：`applyProviderStatus` 内置「13 直达而预约未到 PICKED 时先按 10 走一遍」，三条签收路径（回调/轨迹/对账）共用一处；`reconcileExpressStale` 加「预约已签收但订单仍 PAID/PREPARING」兜底支路，只告警一次不改单；e2e §59 新增⑩、§61 新增⑦b/⑦c；selftest 加一条断言。

### Important（第 2.2 节）

- **已修（本提交）**：`PUT /api/admin/settings/shipping` 写侧改为 `!config.isProduction` 才挂载，生产只保留 GET 兼容视图；删 `apps/admin/src/api/admin.ts` 的 `getShippingSettings`/`updateShippingSettings` 两个死导出，随之 `apps/admin/src/types.ts` 的 `ShippingSettings` 类型（唯一引用点消失）一并删除；`docs/api.md:1597` 措辞改为「写侧仅非生产环境挂载（e2e 用），生产只保留 GET 兼容视图」。

### Minor 批处理（第 2.3 节，逐条）

| # | 问题 | 状态 | 说明 |
|---|---|---|---|
| 1 | 快照保鲜以 `order.createdAt` 为基准，实际报价可能早 30 分钟 | 未修（按 Q3 默认改口） | 不改快照结构记 `quotedAt`，改为缩短 `BOOKING_QUOTE_STALE_MS` 到 90 分钟收窄误差窗口 |
| 1 | 只有 1 家回价时快照仍存那 1 条，预约弹窗首屏只显示一家有价 | 已修（本提交） | `getBookingQuotes` 复用条件加「有价家数 `snap.quotes.filter(priceFen>0).length >= s.fee.minQuoteCount`」，家数不够就现查 |
| 1 | 快照 quotes 类型断言含 `defPriceFen` 但实际不存 | 未修 | 不在本批白名单（`express-booking.ts` 仅限改 `BOOKING_QUOTE_STALE_MS`/复用条件/42225 文案三处），类型收窄留给下一次改动该文件时顺手做 |
| 4 | `express-booking.ts` 两处 Shipment upsert 无 `activeOrderId` 守卫（靠上下文保证） | 未修 | 同上，不在本批白名单内；现状靠调用上下文保证正确，风险未升级，留待下次触碰该文件时一并加 |
| 5 | PAID（未接单）也显示「商家备货中」物流卡 | **不改**（Q5 默认） | spec §4.2 明确写 PAID/PREPARING 都显示，审核建议与 spec 冲突，以 spec 为准 |
| 5 | 预约卡里的 `shipment.remark` 行恒不显示（预约路径不写 remark） | 已修（本提交） | 删 `apps/miniapp/pages/order/detail.wxml` 预约卡（`order.showExpressStage`）内的三行 |
| 7 | 未取件提醒与对账无进展提醒同一 tick 双发 | 已修（`a897e78`，按 Q2 默认） | 保留两条任务；`reconcileStaleBooking` 对已发过未取件提醒的预约不再发对账无进展提醒（打标照旧，只抑制通知，避免与 §61 既有断言冲突） |
| 7 | UNKNOWN 认领后同一 tick 对账再查一次 detail | 未修（可忽略） | 审核原文已判定「可忽略」，本批未处理 |
| 8 | 42225 文案用字符数、比较用字节数；启动自检假设订单号 ≤ 6 位；回调限流 120/min 状态+轨迹共用 | 已修（本提交，按 Q4 默认） | 文案改 `Buffer.byteLength`；`worstKdExpressUrl` 上界改 `E9999999999-999`（订单号十位、序号三位）；`kdExpressCallbackLimiter` 限流上调到 300/min |
| 9 | `42210`、`42225` 未列入 api.md 邮寄章节 | 已修（本提交，按 Q6 默认） | `docs/api.md` 邮寄错误码表补两行；`42225` 不换码（客户端契约不动，只补文档） |

### 未决歧义 Q1–Q6 的默认（均已按默认执行，未有人工改判）

| # | 默认 | 落地 |
|---|---|---|
| Q1 | 只检测 + 一次性告警，不自动改订单状态 | `reconcileStaleBooking` DELIVERED 分支只打 `staleRemindedAt`、发告警，不动 `orders.status`（`a897e78`） |
| Q2 | 保留两条任务，对账方对已发过未取件提醒的预约不再发无进展提醒 | 同上，打标不变、只抑制通知（`a897e78`） |
| Q3 | 缩短 `BOOKING_QUOTE_STALE_MS` 到 90 分钟，不改快照结构 | 本提交 |
| Q4 | 回调限流上调到 300/min，状态+轨迹共用一桶 | 本提交 |
| Q5 | 不改 PAID 卡片文案，spec 说了算 | 本批未改 |
| Q6 | `42225` 不换码，只补文档 | 本提交 |
