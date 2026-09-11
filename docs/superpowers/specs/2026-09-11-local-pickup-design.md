# 同城「到店自取」设计（含营业时间统一）

**日期：** 2026-09-11
**状态：** 待店主确认
**工序：** 00 规划 · fable。改动等级 **L**（跨小程序/服务端/后台三端，加订单列，动退款与订单状态流），链路 `fable → sonnet → opus → fable → haiku`。
**分支：** `claude/local-pickup`（worktree `.claude/worktrees/local-pickup`）
**基线：** main `39823e9`

## 0. 一句话

在同城渠道里加第二种履约方式「到店自取」：菜单、购物车与外送共用，顾客在主页/分类页顶部的「外送 / 自取」栏切换；自取选取餐时段、填手机号、享自取优惠、不收运费；店员在工作台接单 → 已备好 → 已取走；顺带修掉「开门前显示午间休息」并把营业时间收成一处。

## 1. 已拍板的产品决策（改动需重新确认）

| # | 决策 | 结论（店主 2026-09-11） |
|---|---|---|
| P1 | 自取的位置 | 同城渠道下的一种履约方式，不是封面第三入口。菜单与外送共用 |
| P2 | 切换控件 | 主页与分类页，在「店名 + 状态胶囊 + 规则行」页头之下、分类区之上**单开一栏**「外送 / 自取」 |
| P3 | 取餐时间 | 顾客选时段。最早一档 = 现在 + 接单缓冲 + 备餐时长，向上取整到时段粒度 |
| P4 | 预约范围 | 当天 + 明天；时段只落在营业时间内 |
| P5 | 价格 | 运费 0；自取优惠可配（折扣或立减）；自取起送门槛可配 |
| P6 | 优惠叠加 | 小计 → 自取优惠 → 券 → 实付。券门槛看**原小计**，券面额封顶到「小计 − 自取优惠」 |
| P7 | 认单 | 手机尾号，与全店一致。结算页填取餐人手机号并记住上次 |
| P8 | 状态流 | 复用 `PAID → PREPARING → SHIPPED（待取餐）→ COMPLETED`，不加新状态 |
| P9 | 完成判定 | 店员点「已取走」；取餐时间过后 N 分钟未点则自动完成并提醒店员 |
| P10 | 取消 | 接单前且未到「开始备餐时刻」可自助秒退；接单后只能申请取消，店员决定；已备好后走售后 |
| P11 | 通知 | 新申请「取餐提醒」订阅模板；按场景分组授权（自取页：取餐 + 退款） |
| P12 | 休业总开关 | 新增 `holiday`，同时停外送与自取，带恢复日期；不影响邮寄 |
| P13 | 营业时间 | 全店只有一份，编辑入口挪到「店铺设置」；小程序「关于」页改读服务端 |
| P14 | 技术路线 | `deliveryType` 加第三个值 `PICKUP`；商品渠道仍是 `LOCAL` |

## 2. 自取与外送逐项差异

| 参数 | 外送 | 自取 |
|---|---|---|
| 同城总开关 `enabled` | 管外送 | 不管。**语义收窄为「外送开关」**，字段名不改 |
| 同城入口是否显示 | — | 外送或自取任一开着就显示；两个都关显示「即将开通」 |
| 暂停接单 | `paused` | 独立 `pickup.paused` |
| 休业 `holiday` | 停 | 停 |
| 营业时段 | 营业外禁止下单 | 营业外**可以下单**，只是时段必须落在营业时间内 |
| 备餐时长 / 高峰 | 按下单时刻 | 按**取餐时刻**是否在高峰取值 |
| 起送门槛 | `fee.minOrderAmount` | `pickup.minOrderAmountFen` |
| 运费、满免、报价凭证、绕路系数 | 用 | 全部跳过，`shippingFee = 0`，不收 `quoteToken` |
| 件数/重量上限 `limits` | 用 | 跳过 |
| 门店坐标 | 必填 | 不必填，只用于顾客端导航 |
| 收货地址 | 必填且要定位 | 不要；只要取餐人姓名（可空）与手机号 |
| 接单后取消窗口 `acceptGraceMin` | 用 | 不用（见 P10） |
| 快递100 熔断/余额/小费 | 用 | 无关 |
| 未接单催单时刻 | 付款 + 15 分钟 | max(付款 + 15 分钟, 开始备餐时刻 − 15 分钟) |
| 库存 | 下单即扣 | 下单即扣（明天的单占今天库存，有意；按日库存列入二期） |

「开始备餐时刻」统一定义为 `pickupAt − 备餐时长(按 pickupAt 取高峰/平时) − acceptBufferMin`，服务端一个函数 `prepStartAt(settings, pickupAt)`，取消、催单、工作台倒计时都用它。

## 3. 数据模型

### 3.1 订单表 `orders` 新增 4 列（一次 Prisma 迁移，老数据零影响）

| 列 | 类型 | 含义 |
|---|---|---|
| `pickup_at` | DateTime? | 顾客选的时段起点 |
| `pickup_discount_amount` | Int default 0 | 自取优惠（分） |
| `pickup_ready_at` | DateTime? | 店员点「已备好」的时刻 |
| `pickup_reminded_at` | DateTime? | 「过时未取」提醒只发一次的标记 |

`deliveryType` 列结构不改，多一个值 `PICKUP`。服务端把它收窄成联合类型 `'EXPRESS' | 'LOCAL' | 'PICKUP'`，凡是 `=== 'LOCAL' ? A : B` 的二分支由 `tsc` 报出来逐个改三分支。

自取单的地址列写法：`receiverName / receiverPhone` = 取餐人；`receiverProvince / City / District / Detail / FullAddress` = **门店地址快照**（取餐地点）。这样 7 个非空列不用改可空，门店搬家后老单仍查得出当时在哪取。同城快照列（坐标、距离、预计送达）与 `Shipment` 一律不写。

### 3.2 设置（`Setting` key `local_delivery`，无表结构变化）

```
enabled            外送开关（语义收窄）
paused             外送暂停（不变）
holiday: { until: 'YYYY-MM-DD' | null, reason: string } | null   // 新增，外送 + 自取
pickup: {                                                          // 新增
  enabled: false
  paused: { until: string | null, reason: string } | null
  slotMinutes: 30
  acceptBufferMin: 5
  daysAhead: 1                 // 0 = 只当天，1 = 当天 + 明天
  minOrderAmountFen: 0
  discount: { type: 'NONE' | 'PERCENT' | 'FIXED', value: 0 }
                               // PERCENT: value=95 表示 9.5 折；FIXED: value 为分
  autoCompleteAfterMin: 120
  unpickedRemindAfterMin: 30
}
```

读取时缺省补默认值（`pickup.enabled=false`、`holiday=null`），老设置一读进来就完整，不需要数据迁移。`holiday.until` 含当天恢复：`today > until` 即自动恢复，`until` 为 null 表示手动恢复。

开关层级从大到小：休业 → 暂停（各自）→ 开通（各自）→ 营业时段。

### 3.3 取餐人记忆

不加表。`GET /api/orders/pickup-contact` 返回该用户最近一张 `PICKUP` 单的 `receiverName / receiverPhone`；没有则返回 null。

## 4. 服务端

### 4.1 公开元数据 `GET /api/local/meta`

在现有字段之上加两节；老字段保留一版给老客户端：

```
delivery: { enabled, paused, isOpen, closedKind, nextOpenText }
pickup:   { enabled, paused, minOrderAmountFen, discount, discountText, slotMinutes,
            store: { name, phone, address, latE6, lngE6 } }
holiday:  { until, reason } | null
businessHours: [...]          // 已有，「关于」页改读它
```

### 4.2 时段接口 `GET /api/local/pickup-slots`（公开）

```
{ days: [ { date, label: '今天'|'明天', slots: [ { startAt, endAt, label: '12:00–12:30' } ] } ],
  earliestAt, slotMinutes,
  blocked: null | { kind: 'HOLIDAY'|'PAUSED'|'DISABLED', text } }
```

生成逻辑是 `services/pickup.ts` 的纯函数 `buildPickupSlots(settings, now)`，不碰数据库：

- 天：今天起 `daysAhead + 1` 天；落在 `holiday` 内的整天去掉。
- 每个营业窗口从起点每 `slotMinutes` 切一格，最后一格的 `endAt ≤` 窗口终点。
- 一格可选：`startAt − prep(startAt) − acceptBufferMin ≥ now`，`prep` 按 `startAt` 是否在高峰窗口取 `peak.prepMaxMinutes` 或 `prepMinutes`。不可选的格子**不返回**。
- 今天一格都没有时 `days[0].slots` 为空数组照样返回，页面据此默认切明天。
- `blocked` 非空时 `days` 为空。

### 4.3 下单 `POST /api/orders`

Schema 变化：
- `deliveryType` 枚举加 `PICKUP`。
- `addressId` 改可选；refine：`EXPRESS/LOCAL` 必填，`PICKUP` 必须不传。
- 新增 `pickupAt`（ISO）与 `pickupContact: { name?: string(≤32), phone: string }`，`PICKUP` 时必填；手机号 `^1\d{10}$`；`name` 空则落「顾客」。

校验顺序（PICKUP 分支，替换 LOCAL 那段）：
1. `pickup.enabled`，否则 42280「到店自取暂未开通」
2. 非休业，否则 42280「休息中，X 日恢复」
3. 非自取暂停，否则 42280「自取暂停接单：原因」
4. `pickupAt` 必须等于 `buildPickupSlots(settings, now)` 里某格的 `startAt`，否则 42281「该时段已不可选，请重新选择」
5. 起送门槛按券前小计，否则 42282「到店自取满 ¥X 起」

计价：
```
pickupDiscount = type==='PERCENT' ? subtotal − round(subtotal × value / 100)
               : type==='FIXED'   ? min(value, subtotal) : 0
券门槛 = checkCouponUsable(原 subtotal)
券面额 = min(券面额, subtotal − pickupDiscount)
actualAmount = subtotal − pickupDiscount − 券 + 0
```
`services/member/pricing.ts` 的 `computeCheckout` 加可选入参 `pickupDiscount`（默认 0），`loadCouponForOrder` 加可选封顶参数。0 元照旧 42251 拒。

落库：`deliveryType='PICKUP'`、`shippingFee=0`、`pickupAt`、`pickupDiscountAmount`、取餐人与门店地址快照。幂等键 `clientRequestId` 照旧。`orderCreatedView` 多回 `pickupAt`。

### 4.4 状态流与端点

| 步骤 | 端点 | 前置 | 效果 |
|---|---|---|---|
| 接单 | 复用 `POST /admin/orders/:id/accept` | PAID | → PREPARING，写 `acceptedAt`。不走 `/admin/delivery/:id/accept`（那条会查骑手报价） |
| 已备好 | 新 `POST /admin/orders/:id/pickup-ready` | PREPARING 且 PICKUP | → SHIPPED，写 `pickupReadyAt`；发「取餐提醒」订阅消息；若有未处理取消申请，视同驳回（`cancelRequestRejectedBy='MANUAL'`）并告知顾客 |
| 已取走 | 新 `POST /admin/orders/:id/picked-up` | SHIPPED 且 PICKUP | → COMPLETED，写 `completedAt`；积分结算照旧 |
| 填单号发货 `/ship`、标记完成 `/complete`、同城 `/delivery/:id/accept`、`/call`、`/self-deliver`、`/delivered` | 现有 | — | `/ship`、`/complete` 为 42284；同城看板四条路由沿用既有 42204 |

条件更新（`updateMany where {id, status, deliveryType:'PICKUP'}`）沿用仓库既有的状态流转写法。

### 4.5 顾客取消

- 自助取消 `POST /orders/:id/cancel`：PICKUP 要求 `status='PAID'` 且 `now < prepStartAt`；否则 42229，文案引导「请申请取消」。已付款取消走现有全额退款路径。
- 申请取消 `POST /orders/:id/cancel-request`：PICKUP 在 `PAID`（已过开始备餐时刻）或 `PREPARING` 时可申请；`SHIPPED` 后关闭入口。`cancelWindowOf` 对 PICKUP 返回「开」直到 `pickupReadyAt`。
- 店员同意：全额退，没有配送单要撤。**不自动驳回**；5 分钟未处理提醒一次（复用 `cancelRequestRemindedAt`）。
- 退款服务里「先撤配送单」「活跃预约守卫」等分支按 `deliveryType` 三分支核对，PICKUP 不落入邮寄或同城任一侧。

### 4.6 定时任务（`scheduler.ts` 现有 60 秒一轮）

| 任务 | 条件 | 动作 |
|---|---|---|
| 未接单催单（改） | PICKUP：`now ≥ max(paidAt+15min, prepStartAt−15min)` 且未催过 | 企微催单，写 `acceptRemindedAt` |
| 过时未取提醒（新） | SHIPPED 且 PICKUP 且 `now ≥ pickupAt + unpickedRemindAfterMin` 且 `pickupRemindedAt` 空 | 推送一次，写 `pickupRemindedAt` |
| 自动完成（新） | SHIPPED 且 PICKUP 且 `now ≥ pickupAt + autoCompleteAfterMin` | → COMPLETED，推送「按超时自动完成」 |
| 发货 7 天自动完成（不变） | 按 `Shipment.shippedAt` | PICKUP 无 Shipment 行，天然不碰 |
| 未接单重复播报（不变） | — | 店员接单即停 |

### 4.7 订单列表过滤

`GET /orders` 与 `GET /admin/orders` 的 `deliveryType` 参数接受 `PICKUP`；新增 `channel=LOCAL` 表示 `LOCAL + PICKUP` 两类一起返回。

### 4.8 订阅消息

- 新环境变量 `SUBSCRIBE_PICKUP_TEMPLATE_ID`；`config.subscribe.pickupTemplateId`。
- `/orders/meta` 与订单详情的 `subscribeTemplateIds` 保留，另加 `subscribeTemplates: { express: [发货, 退款], local: [配送, 退款], pickup: [取餐, 退款] }`，空 ID 自动剔除，每组 ≤ 3。
- 「已备好」时发；模板字段用映射表填，换模板只改映射；ID 为空只记 warn 不阻塞。
- `deliveryLabel` 里已有的 `PICKUP: '到店自取'` 保留。

### 4.9 错误码（新开 42280–42284，写入 `docs/api.md`）

| 码 | 含义 |
|---|---|
| 42280 | 到店自取不可用（未开通 / 休业 / 暂停，文案区分） |
| 42281 | 取餐时段不可选 |
| 42282 | 未达自取起送门槛 |
| 42283 | （预留）取餐人手机号无效——当前由 zod 校验以 40001 报，码值保留不占用 |
| 42284 | 操作与自取订单状态不符（发货/完成/呼叫等误操作） |

### 4.10 营业时间修复与统一

- `closedKind`：BREAK 当且仅当「存在一段 `end ≤ now`」且「存在一段 `start > now`」；开门前返回 CLOSED。
- `nextOpenText`：开门前返回「今天 10:00 营业」；两段之间「午间休息，17:00 继续营业」；打烊后「明天 10:00 营业」。
- 存储不动（`local_delivery.businessHours`）。后台编辑卡片从「同城设置」挪到「店铺设置」，标题「营业时间（全店统一）」，说明同时管外送下单、自取时段、来单催单、小程序「关于」页；同城设置原位置留链接。
- 小程序「关于」页改读 `/local/meta.businessHours`，`config/shop.js` 的字符串只作接口失败兜底。
- 高峰时段留在同城设置。

## 5. 小程序

### 5.1 模式上下文

`utils/channel.js` 旁加 `localMode: 'DELIVERY' | 'PICKUP'`，权威值 `app.globalData.localMode`，storage 只做恢复，归一化同渠道。默认 DELIVERY；进同城时外送关而自取开则落 PICKUP。切 tab 不改模式；切到邮寄不清它。`app.enterLocalChannel()` 的许可改为「外送或自取任一开通即可进」。

### 5.2 切换栏 `local-mode-bar`（新组件）

位置：主页与分类页，页头组件之下、分类区之上，通栏独立一栏。页头组件 `local-store-header` 不放它。

- 状态胶囊随当前模式：外送看 `delivery`，自取看 `pickup.paused`；休业时两标签置灰，胶囊「休息中 · X 日恢复」。
- 规则行随模式：外送「配送范围 / 起送 / 运费」；自取「自取享 9.5 折 · 满 ¥15 起 · 门店地址 ›」，「›」打开 `wx.openLocation`（无坐标则不可点）。
- 某一边未开通或暂停：标签仍可点，第三行显示原因并给「改用自取 / 改用外送」；两边都不可用才给「去全国邮寄」。
- 自取模式下营业时间外不显示打烊阻塞，只提示「现在可预约明天的取餐时段」。

### 5.3 购物车

LOCAL 购物车两模式共用，件数与角标不分。购物车条与购物车页按钮文案「去结算 · 外送 / 去结算 · 自取」；起送差额按模式取各自门槛。自取跳 `pages/local/pickup`，外送照旧 `pages/local/confirm`。

### 5.4 自取结算页 `pages/local/pickup`（新页面）

顺序：
1. 页级通知（休业 / 自取暂停 / 未开通）
2. 取餐门店卡：店名、地址、导航、电话
3. 取餐时间卡：默认最早一格；底部弹层「今天 / 明天」+ 时段格子；今天为空默认切明天并提示
4. 取餐人卡：姓名（可空）、手机号（必填）；首次用 `pickup-contact` 预填。不做一键取微信手机号
5. 商品明细（结构复用同城结算页）
6. 优惠券与积分赠品（复用 `checkout-benefits`，传原小计）
7. 备注（20 字，无「需要餐具」）
8. 金额明细：商品金额 / 自取优惠 / 优惠券 / 积分赠品 / 应付
9. 协议提示 + 固定底栏

按钮状态机 `utils/pickup-checkout-state.js`（纯函数），优先级：阻塞 → 未选时段 → 时段失效 → 手机号无效 → 未达起送 → 优惠重算中 → 提交中 → 可提交。时段失效判定：`onShow` 与每次开弹层重拉时段，已选格不在最新列表即清空并提示；服务端 42281 同样处理。

订阅授权只请求 `subscribeTemplates.pickup`。提交 `createOrder({ deliveryType:'PICKUP', cartItemIds, pickupAt, pickupContact, couponId, gifts, remark, clientRequestId })`，成功后清幂等键、跳详情、拉起支付。

### 5.5 订单列表与详情

- 列表：同城渠道下用 `channel=LOCAL` 一次拿两类；卡片标签多「自取」。
- `order-status-tag` 加 `deliveryType` 属性：PICKUP 的 SHIPPED →「待取餐」，COMPLETED →「已取餐」。
- 详情 PICKUP 分支：顶部「尾号 1234 · 今天 12:00–12:30 取」；门店卡（地址、导航、电话）；时间线「已付款 → 商家接单 → 已备好 → 已取餐」；不轮询骑手、无地图、无确认收货。按钮：可自助退时「取消订单」，只能申请时「申请取消」，已备好后只剩「申请售后」。

### 5.6 「关于」页

营业时间改读 `/local/meta.businessHours`。

## 6. 后台

### 6.1 工作台

- 卡片渠道加 `PICKUP`，排序同城 < 自取 < 邮寄；标签「自取」；主信息「尾号 1234 · 今天 12:30 取」。
- 明天的单默认收进折叠分组「明日自取」，到开始备餐时刻自动进正常列。
- 按钮：PAID「接单」；PREPARING「已备好」+ 倒计时「距取餐 25 分钟」；SHIPPED「已取走」；过时未取卡片橙色并标「已过取餐时间 40 分钟」。
- 不显示呼叫骑手、自己送、加小费、骑手位置；熔断横幅文案改「外送呼叫已暂停」，对自取卡不显示。
- 取消申请块复用；同意 = 全额退。
- 「暂停接单」改四选一弹窗：外送 / 自取 / 全部（今天）/ 休业至某日；恢复同处。
- 今日统计条加「自取 N 单」。

### 6.2 其他页

- 同城设置：加「到店自取」卡片（§3.2 字段）与「休业」卡片；营业时间卡片挪走留链接。
- 店铺设置：接收营业时间卡片。
- 同城订单列表：渠道筛选「外送 / 自取 / 全部」；抽屉显示取餐时间、备好、取走时刻。
- 经营概览：总览渠道拆分加「自取」；同城 tab 只统计外送。

## 7. 打印与通知

### 7.1 云打印

自取单双联（厨房联 + 取餐联）：
- 票头 `<CB>到店自取</CB>` / `<CB>尾号1234</CB>` / `<B>取餐 今天 12:30–13:00</B>`（明天写「明天 09-12 12:30」）。
- 取餐联不印地址、距离、预计送达；印取餐人姓名与脱敏电话；金额区在合计与券之间加「自取优惠 −¥x.xx」。
- 重复打印与语音播报照旧，播报文案「到店自取新订单」。

### 7.2 店员推送

来单「🏪 自取新订单」带取餐时间；新增「过时未取」「已自动完成」；取消申请推送加自取措辞。

## 8. 测试

### 8.1 服务端 selftest（纯函数）
`buildPickupSlots`：开门前 / 两段之间 / 打烊后 / 休业日 / 高峰取上界 / 今天空明天有 / 末格不越打烊 / daysAhead=0。`computeCheckout`：PERCENT、FIXED、券封顶、0 元拒。`closedKind` 与 `nextOpenText` 三时刻。`prepStartAt`。

### 8.2 e2e 新段 §62
未开通拒单 → 开通 → 尽快格与明天格各下一单 → 起送门槛 → 优惠与券金额断言 → 接单 → 已备好（订阅消息 mock 命中、模板分组）→ 已取走 → 积分结算；`/ship`、`/complete`、同城 accept/call 对 PICKUP 42284；自助取消在 prepStartAt 前后；申请取消 → 同意全额退；过时未取提醒一次；自动完成；休业与自取暂停各自拦截不误伤外送；`channel=LOCAL` 同时返回两类；`pickup-contact` 回最近一单。

### 8.3 回归
§40–§61 全量 0 失败；两端 `tsc`；小程序单测。

### 8.4 小程序单测
`pickup-checkout-state`、`local-mode`、时段弹层纯逻辑、`order-status-tag` PICKUP 文案。

### 8.5 手工验收
切换栏两模式；休业 / 暂停三种页头；时段弹层今天空切明天；结算页各按钮状态；下单支付；详情取消按钮随时间变化；工作台接单到已取走；小票双联；订阅消息真机收到。

## 9. 迁移与上线

1. Prisma 迁移只加 4 个可空/默认列，可与代码同一次部署（仍遵守「先迁移再切代码」）。
2. 设置 JSON 缺省补齐，不需数据迁移。
3. 生产 `.env` 加 `SUBSCRIBE_PICKUP_TEMPLATE_ID`；为空不阻塞。
4. 部署后自取默认关；店主在后台开并配好折扣/门槛后顾客端才出现「自取」。

店主要做：选取餐类订阅模板并给 ID；后台配营业时间、自取折扣、门槛、粒度；真机走验收清单。

## 10. 明确不做（二期）

一键取微信手机号、取餐码/二维码核销、按日库存、自取独立菜单、休业影响邮寄、短信通知。

## 11. 影响面（`deliveryType` 三分支审计清单）

服务端：`routes/orders.ts`、`utils/channel.ts`、`routes/admin/{workbench,orders,delivery,products}.ts`、`routes/admin/stats/{shared,overview,express}.ts`、`services/{refund,cancel-request,subscribe-message,scheduler}.ts`、`services/delivery/{quote,orchestrator,callback,tasks,express-booking,express-callback}.ts`、`services/ticket/{index,content}.ts`、`services/order-notify.ts`。
后台：`types.ts`、`api/admin.ts`、`pages/{Workbench,LocalOrders,Orders,LocalSettings,ShopSettings,Dashboard}.tsx`。
小程序：`utils/{channel,express-track}.js`、`api/order.js`、`pages/order/{list,detail,confirm}`、`pages/user/index.js`、`pages/local/*`、`pages/index`、`pages/product/list`、`pages/cart`、`pages/about`、`components/{local-store-header,local-cart-bar,order-status-tag}`。
