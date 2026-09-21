# 同城外送「预约送达」设计

**日期：** 2026-09-21
**状态：** 待店主复核设计文档
**工序：** 00 规划 · fable。改动等级 **L**（跨服务端/后台/小程序三端，加订单列，动取消窗口与呼叫编排），链路 `fable → sonnet → opus → fable → haiku`。
**分支：** `claude/same-city-delivery-booking-time-e9ceb6`（worktree `.claude/worktrees/mystifying-bhaskara-4424fc`）
**基线：** main `94e54aa`
**前置文档：** [同城配送 v3](2026-09-03-local-delivery-design.md)（D3「首期只做立即送」由本方案解除）、[到店自取](2026-09-11-local-pickup-design.md)（时段机制与 `prepStartAt` 的先例）。

## 0. 一句话

同城外送在「尽快送达」之外加「预约时段」：顾客选送达时段（当天 + 明天，30 分钟一格），打烊时也能约明天；系统从送达时段倒推出「该呼叫、开始备餐、接单截止、出票」四个钟点，到点出备餐票与语音提醒；店员点「已备好」后系统到点自动呼叫骑手，也可「立即呼叫」提前发单；顾客自助取消截止改为约定时刻前两小时，自取一并改。

## 1. 已拍板的产品决策（改动需重新确认）

| # | 决策 | 结论（店主 2026-09-21） |
|---|---|---|
| S1 | 范围 | 选送达时段 + 打烊时可预约明天。分两批：服务端与后台先合，小程序后合 |
| S2 | 时间轴 | 全部从顾客选的送达时段**起点**倒推：该呼叫 = 送达 − 路上 − 呼叫到取走；开始备餐 = 该呼叫 − 备餐；接单截止 = 开始备餐 − 缓冲；出票 = 开始备餐 − 提前量 |
| S3 | 接单 | 手动接单，与自取相同。所有催单/播报锚在「接单截止」而不是付款时刻，夜里下的单不会响 |
| S4 | 取消 | 约定时刻前 `selfCancelLeadMin`（默认 120 分钟）之外可自助秒退，不看是否接单；之内只能申请取消；点「已备好」或呼叫骑手后关闭入口走售后。**自取单同样改用这条规则**，严格版，付款后不另给反悔时间 |
| S5 | 呼叫 | 店员点「已备好」，系统在「已备好」与「该呼叫时刻」取晚者自动发单；「立即呼叫」为常驻备选，二次确认后跳过等待；「自己送」照常 |
| S6 | 目标点 | 倒推以时段**起点**为目标，宁可早到几分钟 |
| S7 | 提醒链 | 来单票（付款时）+ 备餐票（开始备餐前 15 分钟，可配）+ 应备好未备好每 3 分钟催一张小条 + 工作台常驻倒计时条 |
| S8 | 结算页控件 | 「尽快送达 / 预约时段」两个并排大选项；营业中默认尽快，打烊时尽快置灰、默认预约并选中最早一格 |
| S9 | 技术路线 | `Order` 加 `scheduledAt` 列，`deliveryType` 仍为 `LOCAL`；时段算法从 `pickup.ts` 抽成公共模块 |

规划者替店主定的小项（有异议随时改）：时段 30 分钟一格、当天 + 明天；送达起点须在营业时段内且开始备餐不早于该营业段开门；高峰按送达时刻判；预约单卡片不给「接单并呼叫」；功能有独立开关默认关；产能上限、快递100 预约送达下单、顾客改时段放二期。

## 2. 时间轴

以「明天 12:00–12:30 送达、距门店 3 km」为例，用当前生产参数（路上 12 分、呼叫到取走 12 分、备餐 20 分、缓冲 5 分、提前量 15 分、自助取消 120 分）：

| 时刻 | 算法 | 例子 | 系统动作 |
|---|---|---|---|
| `scheduledAt` 目标送达 | 顾客选的时段起点 | 12:00 | 写入 `estimatedDeliveryAt` |
| `callAt` 该呼叫 | 送达 − 路上 − 呼叫到取走 | 11:36 | 已备好则自动发单；未备好则催备好 |
| `prepStartAt` 开始备餐 | 该呼叫 − 备餐 | 11:16 | 工作台卡片变色、倒计时切换 |
| `acceptDueAt` 接单截止 | 开始备餐 − 缓冲 | 11:11 | 到点未接单才催单、才重复播报 |
| `ticketAt` 出票 | 开始备餐 − 提前量 | 11:01 | 打备餐票 + 语音；卡片从折叠分组进正常列 |
| `selfCancelUntil` 自助取消截止 | 送达 − `selfCancelLeadMin` | 10:00 | 之后关闭自助秒退 |

服务端一个纯函数 `scheduleTimeline(settings, scheduledAt, distanceM)` 返回以上六个时刻；工作台、定时任务、取消判定、小票全部只调它，不各自倒推。四个时刻每次都按**当时的设置**重算，店主改备餐时长或提前量，已付款的预约单立刻跟着动（与自取 `prepStartAt` 同一知情选择）。

备餐时长取 `max(schedule.prepMinutes, 高峰时 peak.prepMaxMinutes)`，按 `scheduledAt` 是否落在高峰窗口判。路上时间 `rideMinutes(distanceM)` 沿用现有骑手均速。

## 3. 数据模型

### 3.1 `orders` 新增 3 列（一次 Prisma 迁移，老数据零影响，可与代码同次部署）

| 列 | 类型 | 含义 |
|---|---|---|
| `scheduled_at` | DateTime? | 顾客选的送达时段起点。空 = 立即单。只对 `deliveryType=LOCAL` 有意义 |
| `ready_at` | DateTime? | 店员点「已备好」或「立即呼叫」或「自己送」的时刻 |
| `schedule_reminded_at` | DateTime? | 「应备好未备好」上一次提醒的时刻，控制追加小条的节奏 |

`deliveryType` 不动。`estimatedDeliveryAt` 对预约单在下单时写成 `scheduledAt`，接单时不再重算。

### 3.2 `Delivery.callStrategy` 加两个值

`SCHEDULED_AUTO`（已备好后到点自动发单）、`MANUAL_EARLY`（店员点「立即呼叫」提前发单）。现有 `SOLO / ALL / MANUAL / SOLO_HELD` 不动。

### 3.3 `PrintJob.kind` 加两种

`PREP`（备餐票，去重键 `PREP:<orderId>`）、`READY_DUE`（催备好小条，去重键 `READY_DUE:<orderId>:<seq>`）。

### 3.4 设置（`Setting` key `local_delivery`，读取时缺省补齐，无数据迁移）

```
schedule: {
  enabled: false            // 预约外送总开关
  slotMinutes: 30           // 时段粒度，15–120
  daysAhead: 1              // 0 = 只当天，1 = 当天 + 明天，0–3
  acceptBufferMin: 5        // 接单缓冲，0–30
  prepMinutes: 20           // 预约单备餐时长，默认与立即单相同，独立可调（热菜场景），0–180
  prepTicketLeadMin: 15     // 备餐票提前量，0–60
  readyRemindEveryMin: 3    // 应备好未备好的追加小条间隔，1–15
  readyRemindMaxTimes: 5    // 小条上限，耗尽后企微告警一次，1–10
  callToleranceMin: 5       // 「该呼叫时刻」前后容忍窗口，只影响卡片颜色与二次确认，0–15
}
selfCancelLeadMin: 120      // 顶层字段，自取与预约外送共用，0–720
```

不加的：呼叫到取走、骑手速度、高峰窗口沿用现有顶层值。`pickup.acceptBufferMin` 保留不动。

## 4. 服务端

### 4.1 公共时段模块 `services/slots.ts`

从 `pickup.ts` 抽出切格、可选判定、天数与休业/暂停处理：

```
buildSlots({ businessHours, holiday, paused, slotMinutes, daysAhead, now,
             leadMinutesOf: (slotStart: Date) => number,
             extraFilter?: (slotStart: Date, window: BusinessHour) => boolean })
```

- 可选判定：`slotStart − leadMinutesOf(slotStart) ≥ now`，不可选的格子不返回。
- 自取传 `lead = 备餐(按取餐时刻) + pickup.acceptBufferMin`；外送传 `lead = 路上 + 呼叫到取走 + 备餐(按送达时刻) + schedule.acceptBufferMin`。
- 外送的 `extraFilter`：`prepStartAt(slotStart) ≥ 该营业段开门时刻`，否则不出该格。送达起点落在营业段内由切格本身保证。
- 暂停：`paused.until` 之前的格子不出，之后照出；`until` 为空视为当天全停。休业日整天去掉。
- `pickup.ts` 改成薄壳调它，行为不变，现有 selftest 守住。

### 4.2 时段接口 `GET /api/local/delivery-slots?distanceM=`（公开）

返回结构与 `pickup-slots` 相同：`{ days[], earliestAt, slotMinutes, blocked }`。`distanceM` 必传（来自结算页报价）。`blocked.kind ∈ DISABLED | HOLIDAY | PAUSED`。

### 4.3 `GET /api/local/meta`

`delivery` 节加 `scheduleEnabled`、`slotMinutes`、`earliestScheduleText`（用 `radiusKm` 算最坏路上时间得到的保守最早送达文案，例「最早明天 09:35 送达」；页头没有地址时用它）。营业时间外 `closedKind` 照旧返回。

### 4.4 下单 `POST /api/orders`（LOCAL 分支）

- Schema 加 `scheduledAt`（ISO，可选）。传了即预约单；`deliveryType !== 'LOCAL'` 时传了报 40001。
- 校验顺序，插在现有「休业 → 暂停 → 营业时间」处：
  1. 休业照旧拒。
  2. 未传 `scheduledAt`：现有立即单路径，含「非营业时间拒单」。
  3. 传了：`schedule.enabled` 否则 42290；**跳过**非营业时间判定；`scheduledAt` 必须精确等于此刻用凭证里 `distanceM` 算出的某格起点，否则 42291。
- 距离取 `quoteToken.distanceM`，报价凭证机制原样，运费按下单那一刻算。
- 落库：`scheduledAt`、`estimatedDeliveryAt = scheduledAt`；其余快照与立即单相同。库存下单即扣（明天的单占今天库存，与自取同）。
- `orderCreatedView` 与详情多回 `schedule` 节（仅预约单非空）：`{ scheduledAt, slotLabel, ticketAt, prepStartAt, callAt, acceptDueAt, selfCancelUntil, readyAt }`。

### 4.5 状态流与端点

订单状态不加新值，仍 `PAID → PREPARING → SHIPPED → COMPLETED`。

| 步骤 | 端点 | 立即单 | 预约单 |
|---|---|---|---|
| 接单 | `POST /admin/delivery/:id/accept`（现有） | → PREPARING，此刻算写 `estimatedDeliveryAt` | → PREPARING，**不改** `estimatedDeliveryAt` |
| 接单并呼叫 | 现有 | 照旧 | 42292，卡片不显示 |
| 已备好 | 新 `POST /admin/delivery/:id/ready` | 42292 | PREPARING 且无在途配送单 → 写 `readyAt`；`now ≥ callAt` 则立即 `callRider`（`SCHEDULED_AUTO`），否则等定时任务 |
| 立即呼叫 | 现有 `/call` 加 `force=true` | 照旧 | 无 `force` 且 `now < callAt − callToleranceMin` → 42292「距该呼叫时刻还有 N 分钟，如需提前请用立即呼叫」；带 `force` → 写 `readyAt`（若空）并发单，`MANUAL_EARLY` |
| 自己送 | 现有 `/self-deliver` | 照旧 | 照旧，写 `readyAt`（若空） |
| 回调、送达、取消、加小费 | 现有 | 照旧 | 零改动 |

`callRider` 内部不感知预约，只多记 `callStrategy`。外呼参数不传 `orderType`，仍是即时单。

### 4.6 取消窗口

三个判定函数统一读 `selfCancelUntil = 约定时刻 − selfCancelLeadMin`（外送 `scheduledAt`，自取 `pickupAt`）：

| 函数 | 立即单（不变） | 预约单 | 自取单（本次连带改） |
|---|---|---|---|
| `canSelfCancelOf` | PAID 未接单 | `now < selfCancelUntil`，PAID 或 PREPARING 均可，`readyAt` 空且无在途配送单 | 同预约单，`pickupReadyAt` 空 |
| `cancelWindowOf` | 接单后 `acceptGraceMin` 内 | `now ≥ selfCancelUntil` 且 `readyAt` 空、无在途配送单、未申请过 | `now ≥ selfCancelUntil` 且 `pickupReadyAt` 空 |
| 之后 | 售后 | 售后 | 售后 |

`POST /orders/:id/cancel` 与 `refund.ts` 里「同城单 PREPARING 不允许秒退」的守卫放行 `scheduledAt != null && now < selfCancelUntil`（自取同理）。这是唯一要动 `refund.ts` 的地方。申请取消处理照旧；`autoRejectStaleCancelRequests` 排除预约单。

未接单到了 `prepStartAt` 仍 PAID：不自动接单，卡片红色，催单与播报持续。

### 4.7 定时任务（`scheduler.ts` 现有 60 秒一轮）

新文件 `services/delivery/schedule-tasks.ts`，仿 `pickup-tasks.ts`，全部只扫 `deliveryType=LOCAL && scheduledAt != null`：

| 任务 | 条件 | 动作 |
|---|---|---|
| `printPrepTickets` | PAID 或 PREPARING，`now ≥ ticketAt`，尚无 PREP 作业 | 入队 PREP；同时企微推送「预约单该开始备餐了」（打印机离线时是唯一通道） |
| `remindScheduledUnaccepted` | PAID，`now ≥ max(paidAt + 15 分, acceptDueAt)`，`acceptRemindedAt` 空 | 企微催单，写 `acceptRemindedAt` |
| `remindScheduledNotReady` | PREPARING，`readyAt` 空，无在途配送单，`now ≥ callAt` | 首次：企微推送 + READY_DUE；之后每 `readyRemindEveryMin` 一张，`scheduleRemindedAt` 记上次时刻；该单 READY_DUE 作业数达 `readyRemindMaxTimes` 后停，并企微告警一次 |
| `autoCallScheduled` | PREPARING，`readyAt` 非空，无在途配送单，`now ≥ callAt`，非熔断 | `callRider`（`source='SCHEDULER'`，`SCHEDULED_AUTO`）。失败按现有错误分流 |
| `remindScheduledLate` | PAID/PREPARING/SHIPPED，骑手未取餐，`now ≥ scheduledAt + 10 分`，未告警过 | 企微告警一次「预约单已超约定送达时间」。「只告警一次」用 `services/notify.ts` 现有的限频键（`scheduled-late:<orderId>`）实现，不加列 |

现有任务改动：

- `remindUnacceptedOrders`、`autoCallRiders`、`autoRejectStaleCancelRequests`：加 `scheduledAt: null` 过滤。
- `repeatAnnounce`：预约单在 `acceptDueAt` 之前 `continue` 且不推进计数，与自取那行并列。
- `remindLocalUncalled`、`remindAcceptedStuck`：预约单基准从 `acceptedAt` 换成 `callAt`。

### 4.8 小票（`services/ticket/content.ts`）

硬件事实：飞鹅语音播报由出票触发，无独立播报接口，「播报一次」= 打一张票。

| 票种 | 何时 | 内容 |
|---|---|---|
| `NEW_ORDER` 来单票 | 付款时 | 票头 `<CB>预约配送</CB>`，戳「明日单 / 9月22日单」（复用 `pickupTicketLabel` 的绝对日期规则），印「送达 9月22日（周二）12:00–12:30」与「开始备餐 11:16 · 呼叫骑手 11:36」两行，其余同现有同城票。夜里打印机没开，作业排队，现有开机补打机制补上，不额外告警 |
| `PREP` 备餐票 | `ticketAt` | 全票。票头 `<CB>开始备餐</CB>`，第一行「11:16 开始备餐 · 11:36 前备好 · 12:00 送达」，PAID 时多印「⚠ 尚未接单」。只打一次 |
| `READY_DUE` 小条 | `callAt` 后未备好 | 精简「预约单 尾号1234 应已备好，请点已备好或立即呼叫 · 12:00 送达」 |

开始备餐时刻本身不单独出票。

### 4.9 通知

企微新增四条文案：「📅 预约单」来单（付款时，不催）、「预约单该开始备餐了」、「预约单应已备好未确认」、「预约单已超约定时间」。顾客侧订阅消息不加模板，「配送中」在骑手取餐时照发。

### 4.10 错误码（新开 42290–42294，写入 `docs/api.md`）

| 码 | 含义 |
|---|---|
| 42290 | 预约配送未开通 |
| 42291 | 送达时段不可选 |
| 42292 | 操作与预约单状态不符（接单并呼叫、过早呼叫、对立即单点已备好） |
| 42293 | 预留 |
| 42294 | 预留 |

### 4.11 列表与统计

`GET /admin/orders` 与同城列表加筛选 `schedule=SCHEDULED|ASAP`。经营概览同城 tab 加「预约单 N 单，占比」，一期只计数。

## 5. 小程序

### 5.1 主页与分类页

- `local-catalog.storeStatusOf` DELIVERY 分支加一态：打烊且 `delivery.scheduleEnabled` → 胶囊「已打烊 · 可预约」蓝色调；`headNoticeOf` 返回软提示「现在下单为预约配送，最早明天 09:35 送达」（文案来自 `earliestScheduleText`），`blocking=false`。休业、暂停、未开通三态不变。
- `local-mode-bar`「外送」标签同条件下副标「可预约」。
- `local-cart-bar` 文案：打烊可预约时「去结算 · 预约外送」。

### 5.2 结算页 `pages/local/confirm`

「配送信息」卡之下新插「送达时间」卡：

- 两个并排选项「尽快送达」「预约时段」。营业中默认尽快；打烊时尽快置灰带「已打烊」，默认预约并自动选中最早一格。
- 「预约时段」展开底部弹层：从 `pickup.wxml` 的「今天/明天页签 + 时段格子」抽成组件 `components/slot-picker`，自取页改用同一组件，行为不变。
- 时段依赖报价距离：报价成功后拉 `delivery-slots`；换地址重报价则重拉并清空已选格；报价失败时预约选项禁用并提示「先获取运费」。
- 「约 25–30 分钟送达」与「备餐从商家接单开始计时」两行只在尽快时显示；预约时换成「预计 明天 12:00–12:30 送达」。
- 头条：打烊可预约时软提示「本单为预约配送」。`onShow` 与开弹层时重拉时段，已选格不在最新列表即清空并提示；服务端 42291 同样处理。

`utils/local-checkout-state.js` 加输入 `scheduleMode`、`selectedSlot`。优先级插在「打烊阻塞」之后：打烊且预约关 → 阻塞；打烊且预约开且未选格 → 「请选择送达时段」；预约且格失效 → 「时段已过，请重选」。按钮文案：尽快「立即下单 ¥xx」，预约「预约下单 ¥xx」。

提交多传 `scheduledAt`。订阅授权仍请求 `subscribeTemplates.local`。

### 5.3 订单详情与列表

- 详情：预约单顶部横幅「预约配送 · 明天 12:00–12:30 送达」（`schedule.slotLabel`）；时间线「已付款」的 `extra`：接单前「商家将在 11:11 前确认」，接单后「商家已确认，11:16 开始备餐」。按钮按 §4.6：`selfCancelUntil` 前「取消订单」，之后到已备好前「申请取消」，再后「申请售后」。骑手地图与轮询逻辑不变。
- 列表卡片标签「同城 · 预约」；`order-status-tag` 对 `scheduledAt` 非空的 PAID 显示「已预约」。

### 5.4 各处显示总表

| 位置 | 营业中 | 打烊，预约开 | 打烊，预约关 / 休业 / 暂停 |
|---|---|---|---|
| 页头胶囊 | 营业中 | 已打烊 · 可预约 | 已打烊 / 休息中 / 暂停接单（现状） |
| 页头通知 | 无 | 软提示，不阻塞 | 阻塞（现状） |
| 切换栏「外送」 | 无副标 | 副标「可预约」 | 无副标 |
| 购物车条 | 去结算 · 外送 | 去结算 · 预约外送 | 禁用（现状） |
| 送达时间卡 | 默认尽快，可切预约 | 尽快置灰，只能预约，默认最早一格 | 页面阻塞（现状） |
| 提交按钮 | 立即下单 ¥xx | 预约下单 ¥xx | 禁用 |
| 详情 | 照旧 | 横幅 + 时间线文案 | — |
| 列表标签 | 同城 | 同城 · 预约 | — |

营业中选了预约时段的单，从结算页起走「打烊，预约开」那一列的样式。

## 6. 后台

### 6.1 工作台

服务端快照给预约卡加 `schedule` 节（`scheduledAt、slotLabel、ticketAt、prepStartAt、callAt、readyAt、etaIfCallNow、phase`），`phase` 由服务端算：

| `phase` | 条件 | 卡片 |
|---|---|---|
| `WAITING` | `now < ticketAt` | 收进折叠分组「预约单」，不进五列。分组头「预约单 3 · 最近 11:01 出票」 |
| `TICKETED` | `ticketAt ≤ now < prepStartAt` | 进正常列（PAID 待接单，PREPARING 备餐中）。预约条「12:00 送达 · 11:16 开始备餐」，倒计时「距开始备餐 N 分」 |
| `PREPPING` | `prepStartAt ≤ now < callAt` | 预约条变色，倒计时「距应备好 N 分」 |
| `CALL_DUE` | `now ≥ callAt`，`readyAt` 空 | 橙色「应已备好 · 现在呼叫预计 12:0x 送达」 |
| `READY_WAITING` | `readyAt` 非空，`now < callAt` | 「已备好 · 11:36 自动呼叫」 |
| `LATE` | `now > scheduledAt`，骑手未取餐 | 红色「已超约定时间 N 分」 |

到 `prepStartAt` 仍 PAID：待接单列卡片红色「已过开始备餐时刻仍未接单」。

按钮：PAID「接单」（无「接单并呼叫」）；PREPARING 主「已备好」、次「立即呼叫」「自己送」；「立即呼叫」在 `now < callAt − callToleranceMin` 时二次确认，文案带 `etaIfCallNow`；已备好后主按钮消失，留「立即呼叫」。

排序：同渠道内预约单按 `prepStartAt` 升序排在立即单之前。

顶部常驻「预约单倒计时条」：取 `phase ∈ {WAITING, TICKETED}` 中 `prepStartAt` 最近的一张，显示「下一张预约单 11:16 开始备餐，还有 20 分钟 · 另有 2 张」，点击展开折叠分组。前端每秒走秒，随现有轮询校正。无预约单不显示。手机端单列滚动下折叠分组与倒计时条都在顶部。

### 6.2 同城设置

加「预约配送」卡片：§3.4 全部字段；顶部说明倒推公式；用当前数值算示例「3 km 的单约 12:00 送达，11:01 出票、11:16 开始备餐、11:36 呼叫」，改任何一项示例实时变。`selfCancelLeadMin` 在预约卡片与自取卡片之间单独一行，说明两者共用。

### 6.3 同城订单列表与详情

筛选「预约 / 尽快」；行内预约单显示「预约 12:00–12:30」；详情抽屉显示送达时段、六个倒推时刻、`readyAt`、呼叫来源（到点自动 / 店员提前 / 手动）。

## 7. 测试

### 7.1 服务端 selftest（纯函数）
`scheduleTimeline` 六时刻在平时/高峰/跨营业段；`buildSlots` 外送 lead 下开门前、两段之间、打烊后、休业日、暂停期间、今天空明天有、`prepStartAt` 早于开门的格子不出、`daysAhead=0`；自取经公共模块后现有 selftest 全绿。

### 7.2 e2e 新段 §63（`SCHEDULER_DISABLED=true`，用 tick 覆盖参数推时钟）
未开通拒单 → 开通 → 营业中约今天格、打烊时约明天格各一单 → 42291 → 立即单不受影响 → 两小时前秒退、两小时内申请取消、已备好后 42229 → 接单不改 `estimatedDeliveryAt` → 接单并呼叫 42292 → PREP 在 `ticketAt` 入队且只一张 → `acceptDueAt` 前不催不播报、之后催 → 已备好早于 `callAt` 不发单、到点发单 `SCHEDULED_AUTO` → `force` 呼叫 `MANUAL_EARLY` → 未备好 READY_DUE 每 3 分钟封顶 5 张后告警一次 → 超时告警一次 → 工作台 `phase` 六态 → 自取秒退截止改两小时。

### 7.3 回归
§40–§62 全量 0 失败；两端 `tsc`；小程序单测（`local-checkout-state` 预约分支、`slot-picker` 抽组件后自取页单测全绿）。

### 7.4 手工验收
真机打烊时段下单全流程；飞鹅真机看三种票版式与语音；工作台在 iPad 与手机各走六个 `phase`；设置页示例钟点与实际出票时刻一致。

## 8. 分批、迁移与上线

| 批次 | 内容 | 单独上线后可见效果 |
|---|---|---|
| 一 | 迁移 3 列、设置节、`slots.ts`、下单校验、取消窗口（含自取改两小时）、`/ready` 与 `call?force`、五条任务、三种票、工作台、设置页、列表与概览 | 顾客端无变化；**自取自助取消截止变为两小时前**，上线说明要写 |
| 二 | 小程序全部 | 过审后店主在后台开开关即对顾客可见 |

理由：提醒链先于顾客入口到位；小程序要过微信审核。

- 一次 Prisma 迁移 3 个可空列，先迁移再切代码；零 nginx 改动；后台版本横幅提示店员刷新。
- 回滚 `DEPLOY_REF` 指回上一版，新列留着无害。生产 `.env` 无新增。
- 店主要做：后台配预约参数并核对示例钟点；飞鹅真机试打三种票；小程序过审后开开关。

## 9. 明确不做（二期）

每时段产能上限；快递100 `orderType=1 + expectFinishTime` 预约送达下单（无沙箱无法验证）；顾客改时段；预约单时效达成率报表；三天以上预约；顾客侧新增订阅模板。

## 10. 影响面（`scheduledAt` 分支审计清单）

服务端：`routes/{orders,local}.ts`、`routes/admin/{workbench,delivery,orders,settings}.ts`、`routes/admin/stats/*`、`services/{local-settings,pickup,slots,refund,cancel-request,scheduler,order-notify}.ts`、`services/delivery/{orchestrator,tasks,schedule-tasks}.ts`、`services/ticket/{index,content}.ts`、`prisma/schema.prisma`、`docs/api.md`。
后台：`types.ts`、`api/admin.ts`、`pages/{Workbench,LocalSettings,LocalOrders,OrderDetail,Dashboard}.tsx`。
小程序：`utils/{local-catalog,local-checkout-state}.js`、`components/{local-store-header,local-mode-bar,local-cart-bar,slot-picker,order-status-tag}`、`pages/local/{index,confirm,pickup}`、`pages/order/{list,detail}`、`pages/product/list`。
