# 经营概览重做：总览 · 同城配送 · 全国邮寄

日期：2026-09-08 · 状态：已与店主定稿（结构选 A：一页三 tab）

## 1. 目标

把后台「经营概览」(`/dashboard`) 从 5 个不分渠道的数字，重做成**按业务分板块**的经营看板：

- 顶部一个统一的**时间范围**，三个 tab：**总览 · 同城配送 · 全国邮寄**。
- 每个关键数字带「较上期」对比。
- 同城板块回答「运费这块是赚是亏、送得快不快、哪家运力好用」；邮寄板块回答「有没有积压、发货快不快、货都发去哪」。
- 顺手修掉现有两处口径 bug（见 §3.2）。

不做：不加表、不加迁移、不做导出、不做多店。

## 2. 现状与问题

`apps/admin/src/pages/Dashboard.tsx`（124 行）读 `GET /admin/stats` 与 `/admin/stats/trend`：今日单数/销售额、总单数/在售商品/分类、近 7 天柱图、热销 Top5。

口径 bug：

1. 「今日销售额」只算 `status ∈ {PAID, SHIPPED, COMPLETED}`，**漏 `PREPARING`**——同城单大半天都在这个状态，白天数字偏低。
2. 趋势图按 `status != CANCELLED`，**把未付款单算进去了**。

## 3. 统一口径

### 3.1 时间范围

- 查询参数 `startDate`/`endDate`（`YYYY-MM-DD`，含端），**按上海自然日**，沿用 `routes/admin/scan-stats.ts` 的 `parseRange` 做法与 `utils/local-day.ts` 分桶。
- 前端快捷项：今日 / 昨日 / 近 7 天 / 近 30 天 / 自定义（两个 `type=date`）。日期键用 `utils/time.ts` 的 `todayKey/shiftDayKey`（浏览器时区无关）。
- 自定义区间上限 92 天，超出 40001。
- **上期** = 紧挨着本期之前、等长的区间（近 7 天 → 再往前 7 天；今日 → 昨日）。

### 3.2 订单口径（三个板块共用）

- **参与统计的订单**：`REAL_ORDERS`（排除测试单）且 `paidAt ∈ [start, endExclusive)`。**按付款日归属**，不按下单日；状态不限（付过款就算，退款单也算进单数，退款额另计）。与工作台「今日单数/营业额」口径一致（`routes/admin/workbench.ts:136`）。
- **实收** = Σ `actualAmount`（顾客实付，含运费、已扣券）。
- **退款** = Σ `refundedAmount`（按订单付款日归属，不按退款日）。**退款率** = 退款 / 实收。
- **客单价** = 实收 / 订单数。
- 渠道 = `deliveryType ∈ {LOCAL, EXPRESS}`。
- 老接口 `GET /admin/stats`、`/admin/stats/trend` **保留**（e2e §33 与工作台仍在用），但改到同一口径：`today.*` 与趋势都按 `paidAt` 归属、只算已付款单。§33 的断言（造一张已付单 → 各口径 −1）在新口径下依然成立。

### 3.3 同城专用口径

- **顾客付运费** = Σ `order.shippingFee`（同城单）。
- **免运费单** = `shippingFee = 0` 的同城单；占比 = 免运费单 / 同城单数。
- **付给骑手**，按配送单（`deliveries`，`orderId` 属于本期同城单，一单多次呼叫全部计入）：
  - 配送费 = Σ (`status = DELIVERED` 的 `actualFee ?? quotedFee`)
  - 小费 = Σ `tipFee`（任何状态）
  - 取消费 = Σ `cancelFee`（`status = CANCELLED`）
  - 合计 = 三者之和；**运费差额** = 顾客付运费 − 合计（负数 = 补贴）。
- **时效**（只算本期付款且 `status = COMPLETED` 的同城单，取该单 `status = DELIVERED` 的那张配送单；最多取 2000 单，JS 侧算中位数与 P90）：
  | 阶段 | 起 | 止 |
  |---|---|---|
  | 接单→呼叫 | `order.acceptedAt` | `delivery.calledAt` |
  | 呼叫→骑手接单 | `delivery.calledAt` | `delivery.acceptedAt` |
  | 骑手接单→取货 | `delivery.acceptedAt` | `delivery.pickedUpAt` |
  | 取货→送达 | `delivery.pickedUpAt` | `delivery.deliveredAt` |
  | 下单→送达（合计） | `order.paidAt` | `delivery.deliveredAt` |
  任一端为空的单在该阶段跳过（分母按有效样本数）。
- **承运商表**：`status = DELIVERED` 的配送单按 `provider` 分组：单量、均价（`actualFee ?? quotedFee` 均值）、**呼叫→取货**均时长（`calledAt → pickedUpAt`，直接对应后台的「呼叫到骑手取货」设置，店主拿它校准）。中文名用 `apps/admin/src/utils/providers.ts`。
- **呼叫阶梯**：按本期同城单，取该单**所有配送单**的 `callStrategy`（去掉 `_HELD` 后缀）：含 `ALL` → 「全呼」；否则含 `CHEAPEST` → 「3 家并呼」；否则（`SOLO`/`MANUAL`）→ 「第一级成交」；没有配送单 → 不计。
- **距离分布**：`order.distanceM` 分 ≤2 km / 2–5 km / >5 km / 未知。均距 = 有值单的均值。
- **取消**：取消申请数 = `cancelRequestedAt IS NOT NULL`；配送中取消 = 配送单 `status = CANCELLED` 张数。

### 3.4 邮寄专用口径

- **运费收入** = Σ `shippingFee`（邮寄单）。
- **待发货积压**（**实时**，不受时间范围影响，卡片上注明「当前」）：`deliveryType = EXPRESS` 且 `status ∈ {PAID, PREPARING}` 的订单数；最久 = `now − min(paidAt)` 按小时；附该单号。
- **发货时效**：本期付款且有 `shipment.shippedAt` 的邮寄单，`paidAt → shippedAt` 的中位数 / P90（小时）；样本数。
- **快递公司分布**：`shipment.expressCompany` 分组计数（空 → 「未填」）。
- **收件地 Top 5**：`receiverProvince` 分组计数。
- **退款/售后**：本期邮寄单的退款额、退款单数（`refundedAmount > 0`）、售后单数（`after_sales` 关联本期邮寄单）。

### 3.5 总览专用口径

- **渠道占比**：两渠道各自单数、实收。
- **日趋势**：按上海自然日分桶，每天两渠道各自 `orderCount`、`revenueFen`（补齐空日）。区间 ≤ 31 天按日；32–92 天也按日（前端柱子变细即可，不做按周）。
- **时段分布**：24 个桶，本期订单按 `paidAt` 的上海小时数计数（`HOUR()` 分桶已有 `localDayPartsSql`，取 `h`）。
- **热销 Top 5**：从 `order_items` 聚合（不再读 `Product.salesCount`，因此测试单自动排除）：按本期订单的 `productId` 分组，`Σ quantity`、`Σ subtotal`，排除 `isGift`；可按渠道过滤（`channel=ALL|LOCAL|EXPRESS`）。显示商品名取最近一条 `productName` 快照。
- **顾客**：本期下单的去重用户数；**新客** = 该用户**历史第一张已付单**落在本期；**老客** = 其余；**复购率** = 老客 / 去重用户数。

### 3.6 「较上期」

每个 KPI 返回 `prev` 同结构；前端算 `(cur − prev) / prev`，`prev = 0` 显示「—」。实收/单数上升绿、下降红；退款相反。

## 4. 接口

三个新接口，挂在现有 `routes/admin/stats.ts` 下（文件会变大，**拆成** `routes/admin/stats/index.ts` + `overview.ts` + `local.ts` + `express.ts` + `shared.ts`；`shared.ts` 放 `parseRange`、`prevRange`、`paidOrdersWhere(range, channel?)`、`percentile`、`median`）。全部 `REAL_ORDERS`/`realOrdersSql()`。

```
GET /api/admin/stats/overview?startDate&endDate&channel=ALL|LOCAL|EXPRESS
{
  range: { startDate, endDate, prevStartDate, prevEndDate },
  kpi:  { revenueFen, refundFen, orderCount, avgOrderFen,
          prev: { revenueFen, refundFen, orderCount, avgOrderFen } },
  channels: { LOCAL: { orderCount, revenueFen }, EXPRESS: { orderCount, revenueFen } },
  trend: [ { date, LOCAL: { orderCount, revenueFen }, EXPRESS: { orderCount, revenueFen } } ],
  hourly: number[24],
  customers: { users, newUsers, returningUsers, repeatRate },   // repeatRate 0–1，users=0 时 null
  hotProducts: [ { productId, name, qty, revenueFen } ]         // 受 channel 影响；其余字段不受
}

GET /api/admin/stats/local?startDate&endDate
{
  range,
  kpi: { orderCount, revenueFen, avgDistanceM, freeShipCount, freeShipRate,
         prev: { orderCount, revenueFen, avgDistanceM, freeShipCount, freeShipRate } },
  freight: { customerPaidFen, deliveryFen, tipFen, cancelFen, riderTotalFen, netFen,
             prev: { customerPaidFen, riderTotalFen, netFen } },
  timing: { stages: [ { key, label, medianMin, p90Min, n } ] },  // 5 行，见 §3.3
  providers: [ { provider, count, avgFeeFen, avgPickupMin } ],
  ladder: { first, cheapestN, all },
  distance: [ { label, count } ],                                // ≤2km / 2–5km / >5km / 未知
  cancels: { requested, deliveryCancelled }
}

GET /api/admin/stats/express?startDate&endDate
{
  range,
  kpi: { orderCount, revenueFen, shippingFeeFen, prev: {…} },
  backlog: { count, oldestHours, oldestOrderNo },               // 实时
  shipTiming: { medianHours, p90Hours, n },
  companies: [ { name, count } ],
  regions: [ { province, count } ],                             // Top 5
  afterSales: { refundCount, refundFen, afterSaleCount }
}
```

金额一律**分**；时长一律整数分钟/小时；没有样本的分位数返回 `null`。参数非法 40001（zod）。

## 5. 前端

### 5.1 结构

`apps/admin/src/pages/Dashboard.tsx` 重写为壳：范围选择 + tab 条 + 渲染当前 tab。新目录 `apps/admin/src/components/dashboard/`：

| 文件 | 职责 |
|---|---|
| `RangePicker.tsx` | 快捷按钮 + 自定义两个日期框；值 `{startDate,endDate}`；自定义超 92 天就地提示 |
| `KpiCard.tsx` | 标签 / 主值 / 副行 / 较上期箭头（`deltaTone: 'up-good' \| 'up-bad'`） |
| `StackedBars.tsx` | 手写 SVG 堆叠柱（1–2 个 series，各自颜色，hover 显示每层数值）；不动现有 `TrendChart`（扫码统计在用） |
| `OverviewTab.tsx` / `LocalTab.tsx` / `ExpressTab.tsx` | 各自拉接口、渲染 |
| `SimpleTable.tsx` | 承运商 / 快递公司 / 地区这类两三列小表（或直接用 `ui/Table`，由实现者定） |

- tab 与范围写进 URL：`/dashboard?tab=local&start=…&end=…`（`useSearchParams`），刷新不丢；默认 `tab=overview`、近 7 天。
- tab 条样式沿用 `ui/ChannelTabs.tsx` 的 `border-b-2 border-brand-500` 风格，做成本页自己的三段（不要改 `ChannelTabs`，它是双渠道语义）。
- 手机（≤700px，用 `Workbench.tsx` 里的 `useIsPhone` **抽到** `apps/admin/src/hooks/useIsPhone.ts` 共用）：KPI 两列、表格外层 `overflow-x-auto`、图表 `w-full`。
- 加载/失败态照 `ScanStats.tsx`：`loadFailed` 显示「数据加载失败」+ 重试按钮，**不要**把失败渲染成一排 0。
- 切换范围或 tab 时只重拉当前 tab 的接口。

### 5.2 各 tab 内容

**总览**
1. KPI ×4：实收（副行「退款后 ¥」）· 订单数 · 客单价 · 退款额（副行「退款率」，`up-bad`）
2. 渠道占比：一条双色横条 + 两侧文字「同城 N 单 ¥X · 邮寄 N 单 ¥Y」
3. 日趋势：堆叠柱（同城/邮寄），y 轴金额；hover 显示当日两渠道单数+金额
4. 两栏（手机上下）：下单时段分布（24 柱，单系列）· 热销 Top 5（右上角小切换 全部/同城/邮寄）
5. 顾客一行：去重顾客 N · 新客 N · 老客 N · 复购率 X%

**同城配送**
1. KPI ×4：单量 · 实收 · 均距 · 免运费单（副行占比）
2. 运费账（一张卡，三行加一条合计线）：顾客付运费 / 付给骑手（括号拆配送费+小费+取消费）/ **运费差额**（负数红色「补贴」，正数绿色「盈余」）+ 较上期
3. 时效表：5 行 × 中位/最慢(P90)/样本数
4. 承运商表：运力 · 单量 · 均价 · 呼叫→取货均时
5. 一行三小块：呼叫阶梯（第一级 / 3 家 / 全呼）· 距离分布 · 取消（申请 N · 配送中取消 N）

**全国邮寄**
1. KPI ×3：单量 · 实收 · 运费收入
2. **待发货预警卡**（醒目：有积压时琥珀底）：「当前待发货 N 单，最久已等 X 小时（#单号）」；无积压显示绿色「无积压」
3. 发货时效：中位 / 最慢 / 样本数
4. 两栏：快递公司分布 · 收件地 Top 5
5. 退款/售后一行

### 5.3 类型与 API

`apps/admin/src/types.ts` 新增 `OverviewStats` / `LocalStats` / `ExpressStats`；`api/admin.ts` 新增 `getOverviewStats(params)` / `getLocalStats(params)` / `getExpressStats(params)`。旧 `Stats`/`getStats`/`getSalesTrend` 若无其他引用可删（e2e 直接打 HTTP，不经前端）。

## 6. 测试

- **e2e** 新增 `scripts/e2e.d/54-dashboard-stats.sh`（在 `e2e.sh` 尾部 source 处登记），用 `food_shop_audit` 库、现有 helper（`make_paid_order`、`mk_local_paid`、`kd_cb` 走 mock 回调到 DELIVERED、`pay_new_order`）：
  1. 参数校验：`startDate` 格式错 / 区间 > 92 天 → 40001。
  2. 造一张已付邮寄单：`overview.kpi.orderCount` +1、`channels.EXPRESS.orderCount` +1、`express.backlog.count` +1、`hotProducts` 含该商品且 `qty` +购买数；`hourly` 24 桶之和 == `kpi.orderCount`。
  3. 造一张同城单走到 DELIVERED（mock 回调），完成订单：`local.kpi.orderCount` +1、`freight.customerPaidFen` +该单运费、`freight.deliveryFen` +配送单 `actualFee ?? quotedFee`、`timing.stages[*].n` 至少一行 +1、`providers` 含该运力、`ladder` 三项之和 +1。
  4. 标记其中一单 `isTest=true` → 三个接口各自数字回落（§33 同款基线差值法），取消标记后回来。
  5. 老接口 `/admin/stats` 在新口径下：造一张**未付款**单，`today.orderCount` 与 `trend` 今日**不变**（这就是修 bug 2 的证据）。
- **前端**：`npm run build --workspace=apps/admin`（含 `check-admin-timezone.mjs` 门禁与 tsc）；浏览器里走一遍三个 tab、切范围、手机宽度。
- 全量 `scripts/e2e.sh` 必须全绿（现基线 1199/0）。

## 7. 分步与交付

一次交付，但按下面顺序提交，每步可独立回滚：

1. `stats/shared.ts` + 老接口改口径（e2e §33 仍绿）
2. `overview` 接口 + 总览 tab + 壳（RangePicker/tabs/URL）
3. `local` 接口 + 同城 tab
4. `express` 接口 + 邮寄 tab
5. e2e §54 + 文档（`docs/api.md` 补三个接口；`docs/design/` 不必新增）

## 8. 风险

- 分位数在 JS 侧算，`take: 2000` 封顶；本店日单量两位数，92 天也远不到。
- 老接口改口径会让工作台以外的老截图对不上——是修 bug 的预期结果，与 §33 注释同理。
- `hotProducts` 从冗余列改为聚合后，与商品页的「销量」列可能不一致（那列仍是 `salesCount`），文案上写「本期售出」以示区别。
