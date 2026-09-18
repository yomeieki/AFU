# 订单详情页 + 订单列表日期筛选（后台）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **工序声明**：本文件是「模型分工协议」的 **00 规划 · fable（Fable 5.1）** 产物，等级 **L**（跨服务端与后台两个模块；新增路由页面与统一列表组件；触碰经营概览/扫码统计共用的日期解析；店主明确要求手机优先与三档适配）。
> 链路：**00 规划 · fable（本文件）→ 01 执行 · sonnet（逐任务子代理）→ 02 复核 · opus（新会话，只给需求 + 最终 diff + 验收标准）→ 03 回判 · fable → 04 机械核对 · haiku**。验收标准只在本文件定义，后续工序不得新增或放宽。
> 基线 commit：`5255d34`（分支 `claude/order-detail`，worktree `/Users/yumingyi/food-shop/.claude/worktrees/order-detail`）。

**Goal:** 后台「订单管理」两个页签（同城配送 / 全国邮寄）都能点整张卡片 / 整行进入一个**独立的订单详情页**（有自己的地址、刷新不丢、能返回），完整看到一单从下单到退款售后的全部信息，并在详情页做**事后处理**（退款、重打小票、复制单号/地址、拨电话）。两个列表统一版式，并加**按下单日期（上海自然日）**的筛选，默认「全部」。工作台、小程序、数据库结构零改动。

**Architecture:** 服务端只做三处**只读**扩展：① `GET /api/admin/orders` 新增 `startDate` / `endDate`（YYYY-MM-DD，上海自然日，按 `createdAt`），日期→时间范围的换算抽到 `utils/local-day.ts` 成为唯一实现，经营概览 `stats/shared.ts` 与扫码统计 `scan-stats.ts` 改为调用它；② 列表 `orderListSelect` 带上最近一张配送单的骑手/状态（`latestDelivery`），供宽屏第 7 列显示；③ `GET /api/admin/express/orders/:id/booking` 响应加 `track`（物流轨迹条目，与顾客端同口径 ≤30 条）。后台新增路由 `/orders/detail/:id`（`pages/OrderDetail.tsx`），数据全部来自既有 `getOrder` + `getOrderDelivery`（同城外送）+ `getExpressBooking`（邮寄）；纯逻辑（日期快捷项、今日未完成判定、金额明细行、时间线节点、商品行已退标记、列表摘要）抽到 `src/utils/*.ts` 供 `node --test`。两个列表页共用一个 `components/orders/OrderListTable.tsx`（`<md` 卡片 / `md–lg` 6 列 / `≥lg` 7 列），邮寄页既有业务按钮通过 `renderActions` 插槽**原样保留**。

**Tech Stack:** Express + Prisma 5 / MySQL + zod（服务端）；React 18 + React Router 6 + Tailwind 3 + lucide-react（后台，`node --test src/*.test.ts src/utils/*.test.ts`，**跑不了 .tsx**）；服务端自测 `apps/server/scripts/selftest-*.ts`（`npx ts-node --transpile-only`）；e2e 分片 `scripts/e2e.d/*.sh`。

**已确认的预览（版式依据，务必逐屏看）**：`docs/superpowers/previews/2026-09-18-order-detail-mobile.html`（手机）、`docs/superpowers/previews/2026-09-18-order-detail-wide.html`（iPad 竖屏与电脑）。预览用自写 CSS 模仿后台规范，**实现必须用后台现有 Tailwind 与 `components/ui/*`（Button / Table / StatusBadge / Pagination / EmptyState / Spinner / Modal / Toast / ConfirmDialog），不要照抄预览的 CSS 类名**；预览里的订单内容是示例数据。

---

## 0. 规划时核实的事实（与任务描述不符处已标 ⚠）

| 事项 | 核实结果 |
|---|---|
| `GET /api/admin/orders/:id`（`routes/admin/orders.ts:190`） | 属实：`include` items / payment / shipment / refunds（全部，倒序）/ afterSales（全部，倒序）/ user / expressBookings（最近 1 条）+ `coupon`（含 `source` / `issuedBy` / `remark`）+ `receiverDisplayAddress` + `remainingRefundable`。因为是 `include`，Order 全部列都会返回（含 `cancelledAt` / `refundedAt` / `cancelRequestNote` 等，后台 `types.ts` 的 `Order` 还没声明这些字段）。 |
| `getOrder(id)` 前端调用方 | 属实：只有 `pages/Workbench.tsx:1531`。 |
| `getOrderDelivery(id)` | 属实：`GET /admin/local/orders/:id/delivery` 返回 `delivery`（最近一张）+ `events`（升序）+ `costFen`（全部配送单聚合）+ `quote`。对非同城单也能调（返回 `delivery:null`），但详情页只对 `deliveryType==='LOCAL'` 调。 |
| `GET /api/admin/orders` 参数 | 属实：`page/pageSize/status/keyword(orderNo)/deliveryType/channel`，**无日期**。⚠ `docs/api.md:768` 的表格里**早就写着 `startDate` / `endDate`**，但服务端从未实现——文档与实现不一致，T7 顺手改正。 |
| 经营概览 / 扫码统计的日期换算 | `routes/admin/stats/shared.ts` 的 `parseRange` 与 `routes/admin/scan-stats.ts` 的 `parseRange`（两份几乎相同的代码）：`new Date(\`${key}T00:00:00\`)` **按进程本地时区**解释，`endExclusive = 次日 00:00`。注释写「服务端固定 Asia/Shanghai」，但 ⚠ **仓库里没有任何地方钉住 `process.env.TZ`**（`services/local-settings.ts:342` 的注释也承认这一点）；生产机系统时区是 CST 所以正确，**本机是 JST**（规划时实测 `node -e` 输出 GMT+0900）。⚠ 另外 V8 对 `2026-02-30T00:00:00` **不报 Invalid Date 而是滚到 3 月 2 日**（实测），所以现状的 stats 会静默接受非法日期。本批抽出的共用函数要做日历回环校验（见 T1），stats 也因此从「静默滚动」变为 400——这是修正不是回归，e2e §54 现有断言不受影响（它只断 `2026/09/08` 格式错与 >92 天）。 |
| 上海自然日工具 | 服务端 `utils/local-day.ts`（按小时分桶 + `localDayKey`，进程本地时区）；后台 `utils/time.ts` 的 `todayKey` / `shiftDayKey`（固定 Asia/Shanghai）；`components/dashboard/RangePicker.tsx` 有 `QUICK`（今日/昨日/近 7 天/近 30 天）、`rangeError`、`MAX_DAYS=92`、`matchQuick`，被 `pages/Dashboard.tsx` 引用；**没有「全部」**。 |
| 后台时区闸门 | `scripts/check-admin-timezone.mjs` 挂在 `apps/admin` 的 `build` 前置：`src/` 下除 `utils/time.ts` 外，任何 `getDate/getHours/setDate/toLocaleString…` 属性访问都会让构建失败。新增纯逻辑文件必须只经 `utils/time.ts`。 |
| 退款 | `components/RefundDialog.tsx` 现成；`order` 只要求 `Pick<Order, 'id'|'orderNo'|'status'|'actualAmount'|'refundedAmount'|'remainingRefundable'|'receiverName'|'receiverPhone'|'latestRefund'>` 等，可选 `deliveryCostFen`。退款额由服务端 `remainingRefundable` 驱动，本批不碰 `services/refund.ts`。 |
| 重打小票 | 工作台与邮寄列表都调 `reprintOrder(id)` → `POST /api/admin/orders/:id/reprint`（`routes/admin/printer.ts:153`）→ `enqueueOrderTicket(id,'REPRINT')`。核实 `services/ticket/index.ts:264–345`：**只查订单存在、打印机启用、该渠道有打印机，没有任何订单状态 / 日期守卫**，历史订单可以重打（`docs/api.md:1242` 也写明「每次都新开一条记录，不做幂等」）。邮寄列表现状对 `PENDING_PAYMENT` 隐藏该按钮，详情页沿用。 |
| 未保存守卫 | 属实（`BusinessCenter.tsx` 内置，`UnsavedSettings.tsx` 只在 pathname 真变时清零）。详情页没有表单，不需要接入。 |
| 导航 | 属实：`navigation.ts` 的 `mainNavigation` 订单入口 `to:'/orders/local', prefix:'/orders'`；`legacyRoutes['/orders']='/orders/express'`；`Layout.tsx` 的 `navIcons` / `navBadge` 按 `prefix` 索引；高亮用 `location.pathname.startsWith(item.prefix)`。`App.tsx` 里 `orders` 是带 `OrderCenter`（BusinessCenter 页签壳）的父路由，子路由 `index`（LegacyRedirect）/ `local` / `express`。 |
| 列表组件断点 | 属实：`components/ui/Table.tsx` 传 `mobileCards` 时 `<md` 卡片、`≥md` 表格；Tailwind 自定义断点只有 `navrow:1000px` / `nav:1240px`；`hooks/useIsPhone.ts` 用 700px（工作台/概览专用，本批不用）。 |
| 邮寄列表现有操作（`pages/Orders.tsx` `renderActions` + `renderRefundActions`） | ⚠ **没有「预约取件」和「售后处理」按钮**（预约取件在工作台抽屉；售后处理在本页「售后」页签的 `AfterSalePanel`）。实际按钮全集：`接单`、`直接发货`（PAID）；`发货`（PREPARING）；`标记完成`（SHIPPED）；`退款` / `再退款`（可退余额 > 0）；`重试退款` / `发起退款`、`微信处理中` / `退款异常` 提示、`手动标记完成`（REFUNDING）；`发赔偿券`（非待付款/已取消）；`取消`（PENDING_PAYMENT）；`重打小票`（非待付款）；`展开` / `收起`（桌面）与 `详情` / `收起`（手机）。另有「售后」页签（`AfterSalePanel`）、发货弹窗、`IssueCouponModal`、30 秒静默刷新与「已 N 分钟未更新」细条。**除「展开/收起/详情」外全部保留。** |
| 同城列表现有操作（`pages/LocalOrders.tsx`） | `配送时间线`（展开）、`退款` / `再退款`、`查看工作台`；筛选：方式（全部/外送/自取）+ 状态 + 关键词。 |
| 邮寄轨迹 | ⚠ 管理端 `GET /admin/express/orders/:id/booking` 的 `bookingView` 只给 `trackCount` + `latestTrack`（工作台就只显示这一条）；**完整轨迹条目管理端拿不到**，只有顾客端 `routes/orders.ts:829` 输出 `track.items`（≤30 条）。「物流轨迹可展开」需要服务端只读补一个字段（T1 ③），无迁移。 |
| 时间线可用的时间戳 | `Order`：`createdAt / paidAt / acceptedAt / completedAt / cancelledAt / refundedAt / cancelRequestedAt / pickupReadyAt / pickupAt`；`Payment.paymentType`（`WECHAT` / `MOCK`）；`Shipment.shippedAt`；`Delivery`：`calledAt / acceptedAt / pickedUpAt / deliveredAt / cancelledAt`（+ `events[]` 含 `operator`）；`ExpressBooking`：`bookedAt / acceptedAt / pickedAt / deliveredAt / cancelledAt`（+ `events[]`）；`Refund`：`createdAt / successTime / operator / reason / errorMessage / status / mode`；`AfterSale`：`createdAt / handledAt / handledBy / status / reason / reply`。**接单没有操作人字段**（只有 `acceptedAt`），预览里「接单 · 店员 小刘」是示意，实现不显示操作人。 |
| 商品行「已退」 | `Refund` / `AfterSale` 都**没有**商品行关联。能判断的只有一种情况：全额退款（`refundedAmount >= actualAmount && actualAmount > 0`）→ 全部付费行标「已退」；部分退款 → 一行都不标（金额块显示已退额）。 |
| 本 worktree 环境 | **没有 `node_modules`**（规划时实测）；本机 3000、3113 已被占。 |

---

## Global Constraints（每个任务隐含包含本节）

- 工作目录 `/Users/yumingyi/food-shop/.claude/worktrees/order-detail`（分支 `claude/order-detail`，基线 `5255d34`）。不要 cd 到主检出；不要裸 `git stash`。
- 开工第一件事：worktree 根 `npm install` → `cd apps/server && npx prisma generate`（各 worktree 共用 Prisma client，**同一时刻只能有一个 agent 跑 generate**）；记下 `git rev-parse HEAD` 作为「实际开工尖端」写进本文件末尾「勘误与验收记录」；先跑一遍 A1–A4 确认基线绿。
- **本地库与端口**：独立库 `food_shop_odetail`，服务端口 **3115**，后台 vite 端口 **5178**（3113 已被占；不要复用别的 worktree 的库）。
  ```bash
  docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_odetail; CREATE DATABASE food_shop_odetail CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_odetail.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"
  export DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_odetail"
  (cd apps/server && npx prisma migrate deploy && npx prisma db seed)
  TZ=Asia/Shanghai PORT=3115 DATABASE_URL="$DATABASE_URL" WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true npm --prefix apps/server run dev
  # 后台
  (cd apps/admin && VITE_PROXY_TARGET=http://localhost:3115 npm run dev -- --port 5178 --strictPort)
  ```
  **`TZ=Asia/Shanghai` 必须带**（本机是 JST；服务端日期换算按进程时区，与生产 CST 对齐）。e2e：`TZ=Asia/Shanghai BASE=http://localhost:3115 DB_NAME=food_shop_odetail bash scripts/e2e.sh`（全量约 10 分钟，`timeout ≥ 600000`；只能在刚建的干净库上跑；`SCHEDULER_DISABLED=true` 必须带；已知偶发项见记忆：60s 心跳抢跑、macOS base64 截断、§34 空断言）。
- **金额一律「分」整数**；显示用 `(fen/100).toFixed(2)`。
- **时间显示与「今天」判定只经 `apps/admin/src/utils/time.ts`**（闸门会拦）。新纯逻辑函数一律显式接收 `now`，测试钉时刻。
- **纯逻辑放 `.ts`，不 import React / lucide-react / 任何 `.tsx`**（`Layout.tsx:16` 注释：一旦 import 了 lucide-react 测试就跑不起来）。
- **不动**：`pages/Workbench.tsx` / `Workbench.css`、`apps/miniapp/**`、`prisma/**`（**不许新增迁移**）、`services/refund.ts`、`components/RefundDialog.tsx`、`components/AfterSalePanel.tsx`、`services/ticket/**`、`routes/admin/printer.ts`。
- 提交信息中文（`feat/fix/test/docs/refactor`），尾注 `Co-Authored-By: Claude <当前工序模型> <noreply@anthropic.com>`；`git add` 只加白名单文件（`apps/server/scripts/kd100-*`、`docs/research/*`、`apps/miniapp/.cloudbase/` 等既有未跟踪文件一律不要加）。
- 每个任务结束前跑本任务对应的验收命令，把真实输出贴进本文件末尾。

---

## 1. 分步改动清单

### 路由与命名（先定死，各任务共用）

- **详情页路由：`/orders/detail/:id`**（`id` 为正整数；非法则页面显示「订单不存在」+ 返回链接，不请求接口）。
  为什么不冲突：① `App.tsx` 里它是 `<Route path="orders/detail/:id">`，作为 `Layout` 下与 `<Route path="orders" element={<OrderCenter/>}>` **并列**的兄弟路由，不是 `orders` 的子路由，所以不会渲染页签壳（预览里详情页没有页签行）；② `/orders/local`、`/orders/express` 仍由 `orders` 父路由的静态子路由命中——`detail` 是第三个静态段，与 `local` / `express` 字面不同，不存在动态段抢匹配的问题（不用依赖 React Router 的 static-over-dynamic 排序）；③ `/orders` 精确路径仍落到 `orders` 的 `index` → `LegacyRedirect` → `/orders/express`，`legacyRoutes` 一个字不用改；④ 顶栏高亮用 `pathname.startsWith('/orders')`，`/orders/detail/…` 自然命中「订单管理」，`navIcons` / `navBadge` 按 `prefix` 索引也不用动；⑤ `activeNavLabel` 窄屏顶栏显示「订单管理」。
- `navigation.ts` 新增 `export const orderDetailPath = (id: number) => \`/orders/detail/${id}\``，两个列表页与返回链接都用它（`navigation.test.ts` 加一条断言）。
- **返回**：详情页头部「‹ 返回同城订单 / 返回全国邮寄」。目标 = `location.state?.from`（列表页跳转时传 `{ from: pathname + search }`，把筛选与日期一起带回）；刷新后没有 state 时按 `deliveryType` 回落：`LOCAL` / `PICKUP` → `/orders/local`，`EXPRESS` → `/orders/express`（纯函数 `backTargetFor(deliveryType)`）。
- **日期筛选 URL 参数（两页相同）**：`range=today|yesterday|7d|30d|custom`（缺省 = 全部）、`startDate` / `endDate`（仅 `custom` 时有意义，YYYY-MM-DD）。与既有 `status` / `type` 并存，`setSearchParams(..., { replace: true })` 风格照旧。
- **服务端参数名**：`startDate` / `endDate`（与 stats 同名同格式），两者各自可选：只传 `startDate` = 从该日起，只传 `endDate` = 到该日止。

### T1（服务端）日期参数 + 列表骑手列 + 邮寄轨迹 + 自测 + e2e 分片

**Files:** `apps/server/src/utils/local-day.ts`、`apps/server/src/routes/admin/orders.ts`、`apps/server/src/routes/admin/stats/shared.ts`、`apps/server/src/routes/admin/scan-stats.ts`、`apps/server/src/routes/admin/express.ts`、`apps/server/scripts/selftest-local-day.ts`（新）、`scripts/e2e.d/67-order-date-filter.sh`（新）

- [ ] **① `utils/local-day.ts` 新增（唯一实现）**：
  ```ts
  /** YYYY-MM-DD → 该本地自然日 00:00 的瞬时；格式不对或不是真实日历日（2026-02-30、2026-13-01）返回 null */
  export function parseLocalDayStart(key: string): Date | null
  /** 起止（各自可选，含端）→ Prisma 用的 { gte?, lt? }；lt = 止日次日 00:00。起晚于止抛 RangeError（调用方转 400） */
  export function localDayBounds(startDate?: string, endDate?: string): { gte?: Date; lt?: Date }
  ```
  实现要点：`parseLocalDayStart` 用 `new Date(\`${key}T00:00:00\`)`（与 stats 现状同一做法，进程本地时区），然后用 `localDayKey(d) === key` 做**日历回环校验**（V8 会把 02-30 滚成 03-02，回环后 key 不等 → null）。`lt` 用 `new Date(start); d.setDate(d.getDate()+1)`（跨月/跨年由 Date 处理）。
- [ ] **② `stats/shared.ts` 与 `scan-stats.ts` 的 `parseRange`**：把各自的 `new Date(\`${x}T00:00:00\`)` 换成 `parseLocalDayStart(x)`，为 null 时沿用各自现有的「日期无效」ZodError 路径；其余（默认近 7 天、92 天上限、`prev` 区间）**一字不改**。这样三处共用同一换算。
- [ ] **③ `routes/admin/orders.ts` `GET /`**：
  - zod：`startDate` / `endDate` 各 `z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()`；`parseLocalDayStart` 为 null → `throw new AppError(40001, '日期无效')`；`localDayBounds` 抛 RangeError → `AppError(40001, '开始日期晚于结束日期')`。
  - `where` 追加 `createdAt: { gte, lt }`（只在给了参数时），与 status / dtWhere / keyword **AND 叠加**（放在同一个 where 对象里，不动既有 OR 分支）。
  - `orderListSelect` 追加 `deliveries: { orderBy: { id: 'desc' as const }, take: 1, select: { status: true, courierName: true, courierCompany: true, provider: true } }`，出参映射成 `latestDelivery: deliveries[0] ?? null`（照 `latestRefund` 的写法，从 spread 里剥掉 `deliveries`）。
  - 路由顶部注释同步写上新参数。**`GET /:id` 与其它端点不动。**
- [ ] **④ `routes/admin/express.ts` `GET /:id/booking`**：响应追加 `track: st ? { updatedAt, signed: st.ischeck, items: st.items.slice(0, 30) } : null`（`st = parseStoredTrack(b.trackJson)`，从 `services/delivery/express-track-json` 引入；与顾客端 `routes/orders.ts:829` 同口径）。`bookingView` 与 `BookingView` 类型**不改**（工作台快照复用它，别把轨迹塞进快照）。
- [ ] **⑤ `apps/server/scripts/selftest-local-day.ts`（新，纯函数，无 DB）**，文件头写明运行方式 `TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-day.ts`。第一条用例：`new Date().getTimezoneOffset() === -480`，不满足就 `console.error('本自测必须以 TZ=Asia/Shanghai 运行')` 并 `process.exit(1)`（别让 JST 机器上「碰巧」绿）。用例至少：
  - `parseLocalDayStart('2026-09-18').toISOString() === '2026-09-17T16:00:00.000Z'`（北京 00:00 = UTC 前一日 16:00）。
  - `localDayBounds('2026-09-18','2026-09-18')` → `gte = 2026-09-17T16:00Z`、`lt = 2026-09-18T16:00Z`；北京 09-18 00:30 的瞬时 `2026-09-17T16:30:00Z` 满足 `>= gte && < lt`，`2026-09-17T15:59:59Z`（北京 09-17 23:59:59）不满足。
  - `parseLocalDayStart('2026-02-30') === null`、`'2026-13-01' === null`、`'2026-9-1' === null`、`'2026-12-31'` 有效且 `lt` 落到 `2027-01-01` 本地 00:00。
  - `localDayBounds('2026-09-18','2026-09-17')` 抛 RangeError；`localDayBounds(undefined,'2026-09-18')` 只有 `lt`；`localDayBounds()` 为 `{}`。
- [ ] **⑥ `scripts/e2e.d/67-order-date-filter.sh`（新）**，变量一律 `D67_` 前缀，复用 `req/code/ok/fail/assert_eq/mk_local_paid/sql/$AT`。步骤：`D67_OID=$(mk_local_paid)` → `sql "update orders set created_at='2026-09-17 16:30:00.000' where id=$D67_OID"`（= 北京 2026-09-18 00:30）→ 取 `D67_NO=$(sql "select order_no from orders where id=$D67_OID")` → 断言：
  - `GET /api/admin/orders?channel=LOCAL&keyword=$D67_NO&startDate=2026-09-18&endDate=2026-09-18` → `data.total == 1`；
  - `…&startDate=2026-09-17&endDate=2026-09-17` → `total == 0`（凌晨单不属于前一天）；
  - `…&startDate=2026-09-18`（只给起）→ 1；`…&endDate=2026-09-17`（只给止）→ 0；
  - `startDate=2026-02-30` → `code 40001`；`startDate=2026-09-18&endDate=2026-09-17` → `40001`；`startDate=2026/09/18` → `40001`；
  - 不带日期 → 该单仍在（默认全部不限日期）；
  - `GET /api/admin/orders?channel=LOCAL&keyword=$D67_NO` 的第一条含 `latestDelivery` 键（值可为 null）。
  - 末尾把该单 `created_at` 改回 `NOW(3)`（别让后面分片的「今日」统计受影响）。
  `e2e.sh` 主文件不改（末尾 `for f in e2e.d/*.sh` 自动带上）。

### T2（后台）纯逻辑模块 + 单测（全部 `.ts`，可 `node --test`）

**Files:** `apps/admin/src/utils/date-range.ts`（新，从 RangePicker 抽出）、`apps/admin/src/components/dashboard/RangePicker.tsx`（改为 import + re-export）、`apps/admin/src/utils/time.ts`（加一个格式化函数）、`apps/admin/src/utils/order-date-range.ts`（新）、`apps/admin/src/utils/order-list.ts`（新）、`apps/admin/src/utils/order-detail.ts`（新）、`apps/admin/src/navigation.ts`、对应 `*.test.ts`、`apps/admin/src/types.ts`、`apps/admin/src/api/admin.ts`

- [ ] **① `utils/date-range.ts`**：把 `RangePicker.tsx` 里的 `DateRange`、`QUICK`、`QuickKey`、`MAX_DAYS`、`spanDays`、`rangeError`、`matchQuick` **原样搬过来**；`RangePicker.tsx` 改为 `import` 并 `export { QUICK, rangeError, MAX_DAYS, spanDays, matchQuick } from '../../utils/date-range'; export type { DateRange, QuickKey }`，`Dashboard.tsx` 的 import 不用改。
- [ ] **② `utils/time.ts` 加 `fmtListTime(v, now = new Date())`**：同上海日 → `今天 HH:mm`；上海昨日 → `昨天 HH:mm`；同年 → `M月D日 HH:mm`；否则 `YYYY-MM-DD HH:mm`（预览列表里的「今天 11:42 / 昨天 18:30 / 9月10日 12:15」）。实现只用本文件已有的 `parts()` / `todayKey` / `shiftDayKey`。新增 `utils/time.test.ts` 钉四种分支（用固定 `now`）。
- [ ] **③ `utils/order-date-range.ts`**：
  ```ts
  export type OrderRangeKey = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom'
  export const ORDER_RANGE_PRESETS: { key: OrderRangeKey; label: string }[]   // 全部 / 今日 / 昨日 / 近7天 / 近30天 / 自选（无空格）
  export interface OrderDateState { range: OrderRangeKey; startDate: string; endDate: string }
  export function readOrderDate(params: URLSearchParams): OrderDateState        // 非法 range → 'all'；custom 时读 startDate/endDate
  export function writeOrderDate(params: URLSearchParams, s: OrderDateState): URLSearchParams  // all → 删三键；预设 → 只写 range；custom → 三键
  export function orderDateQuery(s: OrderDateState, now: Date): { startDate?: string; endDate?: string }  // 预设用 utils/date-range 的 QUICK 算；custom 只在两端都合法时给；all → {}
  export function orderDateError(s: OrderDateState): string | null            // custom：缺一端 '请选完整的起止日期'；止早于起 '结束日期早于开始日期'；不设最大跨度
  export function orderDateSummary(s: OrderDateState, now: Date): string      // '' / '今日' / '昨日' / '近7天' / '近30天' / '9月10日' / '9月1日 – 9月10日'（给「共 N 单」前缀）
  ```
  「今日」等的日期一律来自 `QUICK[...].range()`（内部是 `todayKey/shiftDayKey`），不重写。**不设最大跨度**（与 stats 的 92 天不同：店主要看完整历史，服务端分页兜底）。
- [ ] **④ `utils/order-list.ts`**：
  ```ts
  export const ACTIVE_LOCAL_STATUSES = ['PAID', 'PREPARING', 'SHIPPED'] as const
  /** 「去工作台」只挂在：同城/自取 + 下单日期是上海今天 + 状态还在工作台看板上（PAID/PREPARING/SHIPPED） */
  export function showWorkbenchLink(o: { deliveryType: string; status: string; createdAt: string }, now: Date): boolean
  export function itemsSummary(items: { productName: string; specText?: string | null; quantity: number; isGift?: boolean }[]): string  // '凉拌牛肉×1，红油毛肚[微辣]×2'；赠品前缀「赠」
  export function channelTag(deliveryType: string): { label: '外送' | '自取' | '邮寄'; tone: 'local' | 'pickup' | 'express' }
  /** 宽屏第 7 列文字（两行）：LOCAL → ['骑手 X' | '未呼叫', 配送状态]；PICKUP → ['取餐 HH:mm', '已备好/已取走…']；EXPRESS → ['顺丰 SF…' | '未发货', 'M月D日 HH:mm 发货'] */
  export function deliveryColumn(o: OrderListRow, now: Date): [string, string]
  ```
  `deliveryColumn` 的时间文案经 `utils/time.ts`。
- [ ] **⑤ `utils/order-detail.ts`**：
  ```ts
  export const REFUND_STATUS_LABEL: Record<string, string>   // 从 Orders.tsx 搬来（已发起/微信处理中/已退款/异常/已关闭/发起失败），Orders.tsx 改为 import
  export const COUPON_SOURCE_LABEL: Record<string, string>   // ADMIN 店员发放 / POINTS 积分兑换 / CAMPAIGN 活动 / NEWCOMER 新客
  export function backTargetFor(deliveryType: string): '/orders/local' | '/orders/express'
  export function channelLabel(deliveryType: string): '同城外送' | '到店自取' | '全国邮寄'
  export interface MoneyRow { key: string; label: string; hint?: string; fen: number; kind: 'plus' | 'minus' | 'total' | 'info' }
  /** 顺序与小票一致：商品小计 → 打包费 → 自取优惠 → 满减 → 优惠券（券名 · 来源 · 发放人）→ 运费 → 实付 → 已退 → 还可退。为 0 的优惠/费用行不出现；实付/已退/还可退恒出现（已退为 0 时仍出现，方便对账） */
  export function moneyRows(o: OrderDetail): MoneyRow[]
  /** 全额退款（refundedAmount >= actualAmount > 0）→ 全部付费行 true；其它情况全 false（数据判断不了就不标） */
  export function refundedLineFlags(o: OrderDetail): boolean[]
  export interface TimelineNode { at: string; label: string; detail?: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }
  /** 只用已存在的时间戳拼；null 的节点不出现；按时间升序；不编造操作人 */
  export function timelineNodes(o: OrderDetail, extra: { delivery?: DeliveryInfo | null; booking?: ExpressBookingView | null }): TimelineNode[]
  ```
  `timelineNodes` 的节点表（全部条件为「该时间戳非空」）：下单 `createdAt`；支付成功 `paidAt`（detail：`payment.paymentType === 'WECHAT' ? '微信支付' : '模拟支付'`）；顾客申请取消 `cancelRequestedAt`（detail `cancelRequestNote`）；接单 `acceptedAt`；同城：呼叫骑手 `delivery.calledAt`（detail 运力名，经 `utils/providers.ts` 的 `providerLabel`）、骑手接单 `delivery.acceptedAt`（detail `courierName`）、骑手取货 `delivery.pickedUpAt`、已送达 `delivery.deliveredAt`、配送取消 `delivery.cancelledAt`（detail `cancelReason`，tone warn）；自取：已备好 `pickupReadyAt`、已取走 `completedAt`；邮寄：已发货 `shipment.shippedAt`（detail 公司+单号）、预约取件 `booking.bookedAt`（detail `slotText`）、快递已取件 `booking.pickedAt`、已签收 `booking.deliveredAt`、预约取消 `booking.cancelledAt`；已完成 `completedAt`（非自取）；已取消 `cancelledAt`（detail `cancelReason`，tone bad）；每笔退款：`successTime ?? createdAt`，label `退款 ¥X`（SUCCESS）/ `退款失败 ¥X`（FAILED/ABNORMAL，tone bad）/ `退款处理中 ¥X`，detail = `reason` + `operator`；每条售后：申请 `createdAt`（detail 原因），处理 `handledAt`（detail 状态 + `handledBy`）。
- [ ] **⑥ `types.ts`**：`Order` 补 `cancelledAt?: string|null`、`refundedAt?: string|null`、`cancelRequestNote?: string|null`、`latestDelivery?: { status: string; courierName: string|null; courierCompany: string|null; provider: string } | null`；新增 `RefundRecord`（`RefundSummary` + `reason/operator/successTime/mode/errorCode/afterSaleId`）、`AfterSaleRecord`（原始行：`reason/description/images/status/reply/handledBy/handledAt/refundId/createdAt`）、`OrderDetail extends Order`（`refunds: RefundRecord[]`、`afterSales: AfterSaleRecord[]`、`payment: { paymentType: 'WECHAT'|'MOCK'; paidAt: string|null } | null`、`user: { id; nickname; phone } | null`、`expressBookings`、`coupon`）；`ExpressTrack`（`updatedAt/signed/items[]`）。`OrderCoupon` 已有 `source/issuedBy`，核对后不改。
- [ ] **⑦ `api/admin.ts`**：`getOrders` 参数加 `startDate?/endDate?`；`getOrder` 返回类型改 `OrderDetail`；`getExpressBooking` 返回类型加 `track: ExpressTrack | null`。
- [ ] **⑧ `navigation.ts` 加 `orderDetailPath`**；`navigation.test.ts` 加断言 `orderDetailPath(12) === '/orders/detail/12'` 且 `legacyTarget('/orders/detail/12','')` 原样返回（不在 legacyRoutes 里）。
- [ ] **⑨ 单测**（`utils/order-date-range.test.ts`、`order-list.test.ts`、`order-detail.test.ts`、`time.test.ts`）用例至少覆盖：
  - `readOrderDate` 非法 `range=foo` → all；`writeOrderDate` all 会删掉残留的 `startDate`；`orderDateQuery` 在 `now = 2026-09-18T16:30:00Z`（北京 09-19 00:30）时 `today` 给 `2026-09-19`（**不是 09-18**，时区坑）；`custom` 缺一端 → `{}` 且 `orderDateError` 非空；止早于起 → 错误文案；跨 200 天 **不报错**。
  - `showWorkbenchLink`：今天 PAID → true；今天 COMPLETED → false；昨天 PAID → false；今天 EXPRESS PAID → false；北京 00:30 下的单在 `now` 为同日 08:00 时 → true（`createdAt` 用 UTC 前一日 16:30）。
  - `moneyRows`：一张含打包费/自取优惠/满减/券/运费的单，行顺序逐字等于上表；为 0 的行不出现；`已退` 为 0 仍出现；`fen` 之和自洽（`小计+打包−自取−满减−券+运费 === 实付`）。
  - `refundedLineFlags`：全额退 → 付费行全 true、赠品行 false；部分退 → 全 false；未退 → 全 false。
  - `timelineNodes`：节点按时间升序；`acceptedAt` 为 null 时没有「接单」；退款失败节点 tone bad；同城单不出现「已发货」；自取单不出现「已完成」而出现「已取走」。
  - `itemsSummary`、`deliveryColumn` 三渠道各一条；`fmtListTime` 四分支。

### T3（后台）详情页

**Files:** `apps/admin/src/pages/OrderDetail.tsx`（新）、`apps/admin/src/components/orders/detail/*.tsx`（新目录，见下）、`apps/admin/src/App.tsx`

- [ ] **① 数据装载**（`OrderDetail.tsx`）：`useParams().id` → 正整数校验 → `Promise.all([getOrder(id), o.deliveryType==='LOCAL' ? getOrderDelivery(id) : null, o.deliveryType==='EXPRESS' ? getExpressBooking(id) : null])`（先取 order 再按渠道取第二个也可，但要一次 loading）；配送/预约那次失败**不挡**详情（toast 提示，块内显示「加载失败 · 重试」）；订单 404 → 「订单不存在」+ 返回链接。退款/重打后 `reload()`。
- [ ] **② 版式**（照两份预览逐屏对）：
  - 头部：`‹ 返回同城订单/全国邮寄`（`Link`，目标见「路由与命名」）；标题「订单详情」+ 单号（`font-mono`）+ 复制键 + 渠道标签；**`≥md`** 标题右侧放操作按钮（`hidden md:flex`）。
  - **`<md`**：单栏；底部固定操作栏 `fixed inset-x-0 bottom-0 md:hidden`，白底、上边框、`pb-[max(0.75rem,env(safe-area-inset-bottom))]`，两个按钮各 `flex-1`；内容区底部留 `pb-24 md:pb-0` 免得最后一块被挡。
  - **`md`–`<lg`**：单栏，`max-w-2xl mx-auto`（672）。
  - **`≥lg`**：`grid lg:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start`；左栏（钱）：商品+金额明细（同一卡）、退款记录、售后；右栏（人和过程）：订单头（状态大字 + 下单时间）、进度、收货/取餐信息、配送/物流。手机与 iPad 单栏顺序：订单头 → 进度 → 顾客 → 商品 → 金额 → 配送/取餐/物流 → 退款记录 → 售后。
  - 块用 `bg-white rounded-lg shadow-card p-3 md:p-4`，块标题 `text-sm font-semibold`，右侧灰色小字副标题（如「3 种 · 3 份」「全部 2 笔」「顺序与小票一致」）。
- [ ] **③ 各块组件**（`components/orders/detail/`，都是纯展示 + 少量本地 state）：
  - `DetailHero.tsx`：状态大字（`orderStatusLabel(status, deliveryType)`，颜色沿 `StatusBadge` 的语义）、渠道标签、单号+复制、下单时间 `fmtDateTimeSec`。
  - `DetailTimeline.tsx`：`timelineNodes()` 渲染成竖向时间线（时间列 `fmtHHmm`，跨日则 `fmtMonthDayTime`）。
  - `DetailCustomer.tsx`：收货人 / 电话（`<a href="tel:">`）/ 地址（同城显示 `receiverDisplayAddress`，复制的是 `receiverName receiverPhone receiverFullAddress` 全量；邮寄显示全地址）/ 餐具（`tablewareLabel`，仅同城自取）/ 备注（橙底）；自取单标题改「取餐信息」并加 预约取餐 `pickupAt`、备好 `pickupReadyAt`、取走 `completedAt`（状态 COMPLETED 时）；有 `user.nickname` 时加一行「会员」。
  - `DetailItems.tsx`：商品行（名称、规格、单价 × 数量、小计；赠品行单价「积分 N」小计「—」，沿邮寄列表现有写法）；`refundedLineFlags` 为 true 的行 `line-through text-gray-400` + 红字小标「已退」。`≥md` 用四列表，`<md` 用行式（预览 `.item`）。
  - `DetailMoney.tsx`：`moneyRows()` 逐行；`minus` 行红字 `−¥`；`total` 行加粗分隔；券行 hint = `${coupon.name} · ${COUPON_SOURCE_LABEL[source]}${issuedBy ? ' · ' + issuedBy : ''}`；`pointsUsed > 0` 加一行 info「赠品抵扣 N 积分」。
  - `DetailDelivery.tsx`（同城外送）：运力（`providerLabel`）、配送单状态 `StatusBadge`、骑手（名 + `tel:`）、配送成本 `costFen`（`¥`，0 时「—」）、失败原因；「展开配送轨迹（N 条）」折叠 `events`（`fmtDateTimeSec` + `statusDesc ?? source` + 骑手 + operator，与现 LocalOrders 写法一致）；`delivery` 为 null → 「尚未呼叫过骑手」。
  - `DetailExpress.tsx`（邮寄）：快递（`shipment.expressCompany` + 单号 + 复制；没有则「未发货」）；取件预约（`booking.statusLabel` + `slotText` + 快递员名/电话 + `failReason`）；重量（`weightKg` kg，`billedWeightG` 有则「计费 X kg」）；运费（顾客付 `shippingFee` · 实扣 `settledFeeFen ?? prepaidFeeFen ?? quotedFeeFen`，全 null 显示「—」）；「展开物流轨迹（N 条）」折叠 `track.items`（`ftime` + `context`，最新在上，与顾客端一致）；「展开预约进度（N 条）」折叠 `events`。
  - `DetailRefunds.tsx`：**全部** `refunds`（倒序）：金额、状态标签（`REFUND_STATUS_LABEL`，SUCCESS 绿 / FAILED·ABNORMAL 红 / 其它灰）、`reason`、操作人 `operator ?? '系统'`（**只有 operator 字段本身为空才写「系统」，不猜人名**）、`errorMessage`（红字）、时间（`successTime ?? createdAt`，`fmtMonthDayTime`）、`mode === 'MOCK'` 时标「模拟」。空 → 「没有退款记录」。
  - `DetailAfterSales.tsx`：**全部** `afterSales`：原因（`AFTER_SALE_REASON_LABEL`）、描述、图片缩略（点开新窗）、状态（`AFTER_SALE_STATUS_LABEL`）、回复、处理人/时间。空 → 「没有售后申请」。**不做审批操作**（在「售后」页签）。
  - `DetailActions.tsx`：「重打小票」（`reprintOrder`，status ≠ PENDING_PAYMENT 才显示；toast 文案照 `Orders.tsx handleReprint`）；「退款 / 再退款（还可退 ¥X）」（`remainingRefundable > 0` 且 status ∈ PAID/PREPARING/SHIPPED/COMPLETED，或 REFUNDING 且无在途退款时「重试退款 / 发起退款」——判定逻辑**照抄** `Orders.tsx renderRefundActions`，不放宽）；打开 `RefundDialog`，同城外送传 `deliveryCostFen: costFen`。**不放**接单 / 出餐 / 呼叫骑手 / 发货 / 标记完成 / 手动标记退款完成 / 发赔偿券 / 取消（决策 3：实时状态操作不上详情页；发赔偿券与手动标记完成留在邮寄列表）。
- [ ] **④ `App.tsx`**：在 `<Route path="orders" …>` 之前或之后并列加 `<Route path="orders/detail/:id" element={<OrderDetail />} />`（Layout 内、`orders` 外）。
- [ ] **⑤ 复制**：抽 `components/orders/copyText.ts`（从 `Orders.tsx` 搬 `copyText`，两个列表页与详情共用，`navigator.clipboard` 不可用时 toast 失败）。

### T4（后台）统一列表组件 + 日期筛选组件 + 同城列表

**Files:** `apps/admin/src/components/orders/OrderListTable.tsx`（新）、`apps/admin/src/components/orders/OrderDateFilter.tsx`（新）、`apps/admin/src/pages/LocalOrders.tsx`、`apps/admin/src/pages/OrderCenter.tsx`

- [ ] **① `OrderListTable.tsx`**（基于 `ui/Table` 的 `mobileCards`）：
  ```ts
  props: { list: Order[]; loading; loadFailed?; emptyText; now: Date; onOpen(o: Order): void;
           renderActions?(o: Order): ReactNode  /* 可选；有则多一列「操作」/ 卡片底部一行 */ }
  ```
  - 表格列（`≥md`）：订单（单号 `font-mono` + 第二行渠道标签 + `fmtListTime`；有备注加橙色「备注」小标）/ 顾客（名 + 第二行电话 `tel:` + 复制）/ 商品（`itemsSummary`，`truncate max-w-[320px]`）/ 实付（右对齐加粗，已退红字第二行）/ 状态（`StatusBadge` + 售后标签）/ **配送·取餐（仅 `≥lg`：`hidden lg:table-cell`，内容 `deliveryColumn`）** / 操作（有 `renderActions` 才渲染；`onClick={e=>e.stopPropagation()}`，`flex flex-wrap gap-x-3 gap-y-1`）/ `›`（`ChevronRight` 灰）。`<tr>` 加 `cursor-pointer hover:bg-brand-50/40`，`onClick=onOpen`。
  - 卡片（`<md`）：预览 `.card` 版式——第一行状态徽标 + 渠道标签 + 单号 + 右侧时间；第二行姓名 + 电话（`tel:`）+ 右侧「实付 ¥X」；第三行商品摘要单行截断；第四行 `deliveryColumn` 摘要 + 已退红字；有 `renderActions` 则底部一行按钮（`stopPropagation`）；整卡 `onClick=onOpen`，右侧 `›`。
  - 结果计数行「{orderDateSummary} · 共 N 单」由页面渲染在表格上方（`text-xs text-gray-500`）。
- [ ] **② `OrderDateFilter.tsx`**：
  ```ts
  props: { value: OrderDateState; onChange(s: OrderDateState): void }
  ```
  一排 chip（`rounded-full text-xs px-2 py-1 whitespace-nowrap`，选中 `bg-brand-500 text-white`，未选 `bg-gray-100 text-gray-600`）：全部 / 今日 / 昨日 / 近7天 / 近30天 / 自选。**手机上「自选」只显示 `CalendarDays` 图标**（`<span className="md:hidden"><CalendarDays/></span><span className="hidden md:inline">自选</span>`）；容器 `flex flex-nowrap gap-1.5`，**不允许横向滚动**（验收按可用宽度量固有宽度）。`range==='custom'` 时下方（手机）/ 右侧（`≥md`）展开两个 `<input type="date">` + 「至」，错误文案红色小字（`orderDateError`）。行标签「下单日期」`text-xs text-gray-400`（手机放上一行，`≥md` 放左侧）。
- [ ] **③ `LocalOrders.tsx` 改造**：
  - 保留：方式 Tab、状态 Tab、关键词、刷新、分页、`RefundDialog`（同城外送传 `deliveryCostFen`——退款前照旧 `getOrderDelivery` 预取，其余场景不再预取）。
  - 删除：`expanded` / `deliveryCache` 展开时间线、卡片自绘 markup（改用 `OrderListTable`）。
  - 日期：`readOrderDate(searchParams)` → `orderDateQuery(state, new Date())` 并入 `getOrders` 参数；切换日期 `setPage(1)` + `writeOrderDate`；`custom` 且 `orderDateError` 非空时**不请求**（保留上次列表并显示错误）。
  - `renderActions(o)`：`showWorkbenchLink(o, now)` 时「去工作台 ›」（`Link to="/workbench"` 样式照预览的 `.wblink` 用 brand-50 底圆角小标）；`remainingRefundable > 0` 时「退款 / 再退款」（沿用现有 `Button size="sm" variant="danger"`）。
  - `onOpen` → `navigate(orderDetailPath(o.id), { state: { from: location.pathname + location.search } })`。
  - 顶部那行灰字提示改为「查账与检索用；接单、呼叫骑手等操作请到「接单工作台」；点整张卡片看完整详情」。
- [ ] **④ `OrderCenter.tsx`** 描述改成预览文案「同城与邮寄订单的历史检索、退款与售后。」

### T5（后台）邮寄列表

**Files:** `apps/admin/src/pages/Orders.tsx`

- [ ] **①** 保留：状态 Tab（含「售后」页签 → `AfterSalePanel`）、搜索、刷新、30 秒静默刷新 + 「已 N 分钟未更新」细条 + 加载失败态、分页、发货弹窗、`RefundDialog`、`IssueCouponModal`、`handleAccept / handleReprint / handleComplete / handleCompleteRefund / handleCancel / openShipModal / handleShip / renderRefundActions / renderPhone / renderAfterSaleTag`。
- [ ] **②** `renderActions` **去掉最后的「展开/收起」按钮**，其余按钮与顺序一字不改；`renderDetailLines` 与表格展开行、卡片展开区**整段删除**（内容都在详情页）；`expanded` state 删除；`REFUND_LABEL` 改为 import `REFUND_STATUS_LABEL`（若删了展开区后本文件不再用它，就不 import）。
- [ ] **③** 列表换成 `OrderListTable`，`renderActions={(o) => renderActions(o, cls)}`（`cls` 取原桌面配色，卡片与表格用同一套即可）；`onOpen` 同 T4；日期筛选同 T4（`isAfterSaleTab` 时与搜索框一起隐藏）；`modalOpenRef` 逻辑不变。
- [ ] **④** `AfterSalePanel` 与「售后」页签零改动。

### T6（后台）手机宽度与三档核对（无新文件；修尺寸问题只改 T3–T5 的文件）

- [ ] 用 Browser 预览（vite 5178）按验收 B1–B4 逐档核对，量法见验收；发现溢出只调 Tailwind 类，不引入自定义 CSS 文件。

### T7 文档 + 收尾

**Files:** `docs/api.md`、`docs/staff-guide.md`、本文件

- [ ] `docs/api.md`：`GET /api/admin/orders` 参数表改为真实参数（`page/pageSize/status/keyword/deliveryType/channel/startDate/endDate`，写明「上海自然日、按下单时间、各自可选、非法日期与起晚于止 400」，出参 `latestDelivery`）；管理端变更表加 `GET /api/admin/express/orders/:id/booking` 的 `track`。
- [ ] `docs/staff-guide.md`：「一、来新订单了」第 1 条后补「点整张订单（不点按钮）进详情页；详情页只做退款、重打小票、复制、拨号」；「八、遇到问题」的「忘记有没有发货：订单点「详情」」改成「点整张订单进详情页」；「四、顾客要退款」补一句详情页也有退款；同城一节补「订单管理 → 同城配送 → 日期筛选默认全部」。
- [ ] 本文件末尾「勘误与验收记录」填齐（每个 Task 的提交 sha、A 类真实输出、B 类结论、是否命中上报条件、偏离、没把握之处、建议复核重点）。

---

## 2. 验收标准（只在此定义；04 机械核对按此打 PASS/FAIL）

### A 类（可脚本化，命令在 worktree 根执行）

| # | 命令 | 期望 |
|---|---|---|
| A1 | `npm run build --workspace=apps/server`（= `tsc`） | 退出码 0，无输出错误 |
| A2 | `npx tsc -p apps/admin --noEmit` | 退出码 0 |
| A3 | `npm test --workspace=apps/admin` 退出码 0 且输出含 `ℹ fail 0`；**并且**在 `apps/admin` 下对下列五个文件逐个执行 `node --test <文件>`：`src/utils/order-date-range.test.ts`、`src/utils/order-list.test.ts`、`src/utils/order-detail.test.ts`、`src/utils/time.test.ts`、`src/navigation.test.ts` | 五次都退出码 0、输出含 `ℹ fail 0` 且 `ℹ tests N` 的 N ≥ 1。<br>**03 回判修订**：原文要求「输出里出现五个文件名、`# fail 0`」——实测 Node 25 的默认 spec reporter 与 `--test-reporter=tap` 都**不打印文件名**，fail 计数行是 `ℹ fail 0` 而非 `# fail 0`，字面上无法满足。改为逐文件单独运行，证明这五个文件确实被当作测试执行且全绿，判据等价、未放宽。 |
| A4 | `npm run build --workspace=apps/admin` | 先打印 `✔ 管理端时间渲染全部走 Asia/Shanghai（无本地时区解读）`，再 vite build 成功 |
| A5 | `cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-day.ts` | 全部 `✔`，退出码 0；**再跑一次 `TZ=Asia/Tokyo …`** 期望退出码 1 且输出含「必须以 TZ=Asia/Shanghai 运行」 |
| A6 | 干净库 e2e：`TZ=Asia/Shanghai BASE=http://localhost:3115 DB_NAME=food_shop_odetail bash scripts/e2e.sh`（服务端按 Global Constraints 启动，含 `TZ=Asia/Shanghai`） | `== 67. ` 段全 `✔`；§54（经营概览）与 §51/§53 不新增红；总 FAIL 与基线相比不增（基线偶发项按记忆核对） |
| A7 | `git diff --name-only 5255d34...HEAD \| grep -E 'Workbench\.(tsx\|css)$'` | 空输出 |
| A8 | `git diff --name-only 5255d34...HEAD \| grep -E '^apps/server/prisma/'` | 空输出（无迁移、无 schema 改动） |
| A9 | `git diff --name-only 5255d34...HEAD \| grep -E '^apps/miniapp/'` | 空输出 |
| A10 | `git diff --name-only 5255d34...HEAD` 逐行比对「白名单」 | 每一行都在白名单内（新目录按前缀匹配） |
| A11 | 旧地址不回归：`grep -n "'/orders': '/orders/express'" apps/admin/src/navigation.ts` 仍命中；`grep -n 'path="local"\|path="express"\|path="orders/detail/:id"' apps/admin/src/App.tsx` 三条都命中；`node --test apps/admin/src/navigation.test.ts` 绿（含 `/orders?status=PAID → /orders/express` 与 `orderDetailPath`） | 全部命中 |
| A12 | 邮寄页既有业务操作全在（机械核对）：对 `apps/admin/src/pages/Orders.tsx` 逐个 `grep -c`：`>接单<`、`>直接发货<`、`>发货<`、`>标记完成<`、`'再退款' : '退款'`、`'重试退款' : '发起退款'`、`>微信处理中<`、`>退款异常<`、`手动标记完成`、`发赔偿券`、`>取消<`、`重打小票`、`<AfterSalePanel`、`<IssueCouponModal`、`title="订单发货"`、`AUTO_REFRESH_MS`、`自动刷新失败` | 每一项 ≥ 1；同时 `grep -c "展开\|收起" apps/admin/src/pages/Orders.tsx` = 0 |
| A13 | 两页共用列表：`grep -c "OrderListTable" apps/admin/src/pages/Orders.tsx apps/admin/src/pages/LocalOrders.tsx` 各 ≥ 1；`grep -c "<table" apps/admin/src/pages/Orders.tsx apps/admin/src/pages/LocalOrders.tsx` 各 = 0；`grep -c "配送时间线" apps/admin/src/pages/LocalOrders.tsx` = 0 | 如右 |
| A14 | 纯逻辑不带 UI 依赖：`grep -l "from 'react'\|lucide-react\|\.tsx'" apps/admin/src/utils/order-*.ts apps/admin/src/utils/date-range.ts` | 空输出 |
| A15 | 三处共用日期换算：`grep -c "parseLocalDayStart" apps/server/src/routes/admin/stats/shared.ts apps/server/src/routes/admin/scan-stats.ts apps/server/src/routes/admin/orders.ts` 各 ≥ 1；`grep -n "T00:00:00" apps/server/src/routes/admin/stats/shared.ts apps/server/src/routes/admin/scan-stats.ts apps/server/src/routes/admin/orders.ts \| grep -v ":[[:space:]]*[/*]"`（排除注释行）为空——代码里只允许 `utils/local-day.ts` 拼这个字面量；`shared.ts:32` 那条注释顺手改成指向 `parseLocalDayStart` | 如右 |
| A16 | 退款计算未动：`git diff 5255d34...HEAD -- apps/server/src/services/refund.ts apps/admin/src/components/RefundDialog.tsx` | 空 |
| A17 | 服务端接口手工契约（服务端跑在 3115，`AT` 为管理员 token）：`curl -s "$BASE/api/admin/orders?channel=LOCAL&startDate=2026-02-30" -H "Authorization: Bearer $AT" \| jq .code` → `40001`；`startDate=2026-09-18&endDate=2026-09-17` → `40001`；不带日期 → `0` 且 `.data.list[0] \| has("latestDelivery")` 为 true；`curl -s "$BASE/api/admin/express/orders/<任一邮寄单id>/booking" … \| jq 'has("track")'`（在 `.data` 上）→ true | 如右 |
| A18 | 提交署名：`git log 5255d34..HEAD --format=%B \| grep -c "Co-Authored-By: Claude "` ≥ 提交数 | 如右 |

### B 类（行为判据，人工在 Browser 里执行；后台指向 5178 → 3115；先用 e2e 或 seed 造出同城外送 / 自取 / 邮寄各一单，其中一单做一次部分退款、一单全额退款）

- **B1 详情页三档**（用 `resize_window` 分别取 375×812、768×1024、1280×800）：
  - 375：单栏；顺序 = 订单头 → 进度 → 顾客 → 商品 → 金额 → 配送/取餐/物流 → 退款记录 → 售后；底部固定栏有「重打小票」「退款（还可退 ¥X）」；标题右侧没有按钮。
  - 768：单栏、内容宽 ≤ 672 且居中；按钮在标题右侧；没有底部固定栏。
  - 1280：两栏；左栏依次 商品+金额 / 退款记录 / 售后，右栏依次 订单头 / 进度 / 收货 / 配送；右栏宽 360。
- **B2 渠道差异**：同城外送有「配送」块（运力、骑手、配送成本、可展开轨迹）；自取单没有「配送」块而有「取餐信息」（预约取餐/备好/取走）且金额里有「自取优惠」行；邮寄单有「物流」块（快递单号可复制、取件预约、重量、运费顾客付/实扣、可展开物流轨迹）。
- **B3 内容正确性**：单号点「复制」剪贴板等于 orderNo；地址「复制」等于 `姓名 电话 全地址`；电话是 `tel:` 链接；金额行顺序与 §T2⑤ 一致且实付等于 `小计+打包−自取−满减−券+运费`；退款记录显示**全部**笔数（含失败那笔的失败原因与操作人）；全额退款单的付费行全部划线标「已退」，部分退款单**没有任何**行被标；进度时间线里没有「操作人」字样（除退款/售后/配送事件本身带 operator 的）。
- **B4 手机零横向溢出（360 / 375 / 390 三档，`resize_window` 顶层视口，不用 iframe）**，在同城列表页（日期=全部、日期=自选展开）、邮寄列表页、详情页（外送 / 自取 / 邮寄各一）分别执行：
  ```js
  // ① 页面级：没有横向滚动
  const a = document.documentElement.scrollWidth <= window.innerWidth
  // ② 日期 chip 行固有宽度 ≤ 可用宽：可用宽 = 屏宽 − main 左右 padding（p-4 = 32）− 筛选卡片自身 padding（p-3 = 24）
  const row = document.querySelector('[data-testid="order-date-chips"]')
  const c = row.cloneNode(true); c.style.cssText = 'position:absolute;left:-9999px;top:0;width:max-content;display:flex;flex-wrap:nowrap'
  document.body.appendChild(c); const w = c.getBoundingClientRect().width; c.remove()
  const b = w <= window.innerWidth - 32 - 24
  ;[a, b, w, window.innerWidth]
  ```
  期望 `a === true && b === true`；（`OrderDateFilter` 的 chip 容器要带 `data-testid="order-date-chips"`）。详情页只做 ①，并额外对底部固定栏 `getBoundingClientRect().width === window.innerWidth`。
- **B5 「去工作台」只在今天未完成的同城单出现**：造一单今天 PAID 的同城单 → 列表卡片有「去工作台」；同一单用 `sql` 把 `created_at` 改成昨天 → 刷新后没有；改回今天并把状态改 COMPLETED → 没有；邮寄单从不出现。
- **B6 日期筛选叠加**：同城页选「今日」+ 状态「已完成」+ 关键词手机号 → 列表只剩满足三者的单，URL 含 `range=today&status=COMPLETED`；选「自选」只填开始日期 → 出现「请选完整的起止日期」且列表不变；填完 → 结果计数行显示「9月X日 – 9月Y日 · 共 N 单」；切到「全部」→ URL 三个日期键都消失；浏览器后退 → 筛选恢复。
- **B7 返回与刷新**：从同城列表（带筛选）点卡片进详情 → 地址 `/orders/detail/<id>` → 刷新页面仍是详情 → 点「‹ 返回」回到带同样筛选的同城列表；直接在地址栏打开详情再点返回 → 落到 `/orders/local` 或 `/orders/express`（按渠道）；顶栏「订单管理」在详情页保持高亮；`/orders`、`/orders/local`、`/orders/express`、`/local/orders`（旧地址）四个地址都能打开对应列表。
- **B8 邮寄列表操作不回归**：PAID 邮寄单行上有「接单」「直接发货」「退款」「发赔偿券」「重打小票」；点「接单」不会跳进详情页（事件已阻止冒泡）；点行的空白处进详情；「售后」页签仍是售后面板；发货弹窗照常。
- **B9 详情页操作**：点「退款」弹出既有 `RefundDialog`，金额上限 = 页面显示的「还可退」；退成功后详情自动刷新，退款记录多一笔；点「重打小票」对一张**上个月**的历史单（`sql` 改 `created_at`）返回「已发送重打」或「该订单所属渠道尚未配置打印机」（mock 打印机下前者），不报错。
- **B10 工作台肉眼核对**：打开 `/workbench` 抽屉，与基线表现一致（本批未改它；只作为回归观察）。

### 回退验证（执行方必须做，并把红/绿输出贴进记录；做完还原）

1. `apps/server/src/utils/local-day.ts` 的 `localDayBounds` 里把 `lt` 改成「止日当天 00:00」（即不加一天）→ A5 必须变红（北京 00:30 那条断言失败）；还原后绿。
2. `apps/admin/src/utils/order-list.ts` 的 `showWorkbenchLink` 去掉「下单日期是今天」这一判断 → A3 必须变红（`昨天 PAID → false` 用例失败）；还原后绿。
3. `apps/admin/src/utils/order-detail.ts` 的 `moneyRows` 把「满减」与「优惠券」两行顺序对调 → A3 必须变红（行顺序用例失败）；还原后绿。
4. `apps/admin/src/utils/order-date-range.ts` 的 `orderDateQuery` 里把 `today` 改用 `new Date().toISOString().slice(0,10)`（UTC 日）→ A3 的「北京 00:30 时 today = 09-19」用例必须变红，且 A4 的时区闸门**不会**拦它（`toISOString` 不在禁用名单）——这正是为什么要有这条单测；还原后绿。

---

## 3. 允许修改的文件白名单

```
apps/server/src/utils/local-day.ts                         （只加 parseLocalDayStart / localDayBounds）
apps/server/src/routes/admin/orders.ts                     （只改 GET / 的参数、where、orderListSelect 与出参映射；其它端点不动）
apps/server/src/routes/admin/stats/shared.ts               （parseRange 改调 parseLocalDayStart；默认区间 / 92 天 / prev 不动）
apps/server/src/routes/admin/scan-stats.ts                 （parseRange 同上）
apps/server/src/routes/admin/express.ts                    （只在 GET /:id/booking 响应加 track）
apps/server/scripts/selftest-local-day.ts                  （新建）
scripts/e2e.d/67-order-date-filter.sh                      （新建）
apps/admin/src/App.tsx                                     （加一条路由 + import）
apps/admin/src/navigation.ts                               （加 orderDetailPath）
apps/admin/src/navigation.test.ts
apps/admin/src/types.ts
apps/admin/src/api/admin.ts                                （getOrders 参数、getOrder / getExpressBooking 返回类型）
apps/admin/src/utils/time.ts                               （只加 fmtListTime）
apps/admin/src/utils/time.test.ts                          （新建）
apps/admin/src/utils/date-range.ts                         （新建，从 RangePicker 抽出）
apps/admin/src/utils/order-date-range.ts  + .test.ts       （新建）
apps/admin/src/utils/order-list.ts        + .test.ts       （新建）
apps/admin/src/utils/order-detail.ts      + .test.ts       （新建）
apps/admin/src/components/dashboard/RangePicker.tsx        （改为 import + re-export，JSX 不动）
apps/admin/src/components/orders/**                        （新目录：OrderListTable.tsx、OrderDateFilter.tsx、copyText.ts、detail/*.tsx）
apps/admin/src/pages/OrderDetail.tsx                       （新建）
apps/admin/src/pages/Orders.tsx
apps/admin/src/pages/LocalOrders.tsx
apps/admin/src/pages/OrderCenter.tsx                       （只改 description 文案）
docs/api.md
docs/staff-guide.md
docs/superpowers/plans/2026-09-18-order-detail-and-date-filter.md   （本文件：勘误与验收记录）
```

**点名禁改**：`apps/admin/src/pages/Workbench.tsx`、`Workbench.css`、`apps/admin/src/components/RefundDialog.tsx`、`AfterSalePanel.tsx`、`ExpressBookingModal.tsx`、`IssueCouponModal.tsx`、`CancelAndRefundModal.tsx`、`Layout.tsx`、`BusinessCenter.tsx`、`UnsavedSettings.tsx`、`components/ui/*`（需要新样式就在 `components/orders/` 里组合，不改基础件）、`hooks/*`、`apps/miniapp/**`、`apps/server/prisma/**`、`apps/server/src/services/**`（含 `refund.ts`、`ticket/**`、`delivery/**`）、`routes/admin/printer.ts`、`routes/admin/delivery.ts`、`routes/admin/workbench.ts`、`routes/orders.ts`、`scripts/e2e.sh` 主文件与既有分片 `40–66`、`scripts/check-admin-timezone.mjs`、`docs/superpowers/previews/*`。

---

## 4. 上报触发条件（遇到即 BLOCKED，停下回报，不自行绕过）

1. 任何需要新增迁移 / 改 `schema.prisma` 的情形（例如想给「接单操作人」「商品行退款」加字段）——**不许加，上报**。
2. `POST /api/admin/orders/:id/reprint` 对历史订单返回非「已发送重打 / 未配置打印机」的错误（例如按状态或日期被拒）——规划时核实无此守卫，若实测有，不许改 `services/ticket/**` 或 `printer.ts`，上报。
3. 需要改 `Workbench.tsx` / `Workbench.css`（包括「顺手」修它的类型报错）。
4. 需要改退款计算 / `RefundDialog` 的入参语义（例如详情页想自己算可退额）。
5. 详情页要显示的某项数据在 `GET /orders/:id` + `GET /local/orders/:id/delivery` + `GET /express/orders/:id/booking`（含 T1 加的 `track`）里都拿不到（例如满减档位文案、券模板信息之外的东西）——不许再扩服务端，上报由店主决定是否砍掉该项。
6. 白名单外的任何改动需求（含 `components/ui/*` 想加 prop、`Layout.tsx` 想加返回键、`hooks/useIsPhone` 想改断点）。
7. 无法在不删除 §0 表里列出的任一邮寄既有按钮 / 弹窗 / 售后页签 / 30 秒刷新的前提下换成统一列表组件。
8. `stats/shared.ts` / `scan-stats.ts` 改调共用函数后 e2e §54 或其它既有分片出现与本批相关的红（例如某处依赖「02-30 滚到 03-02」）。
9. 手机 360 宽下日期 chip 行按 B4 量法放不下（固有宽 > 可用宽）且缩内边距 / 去空格 / 图标化之后仍放不下——不要改成横滑，上报。
10. 服务端进程时区：若发现生产 `pm2` 环境**不是** CST（部署文档或 `pm2 env` 显示 TZ=UTC 之类），则日期换算与经营概览一起失准，上报（本批不改 pm2 / deploy）。
11. `npm test --workspace=apps/admin` 或 `npm run build:admin` 在基线上就不绿。
12. 干净库 e2e 出现与本批无关的红（先对照记忆里的已知偶发项再回报，不要自行改别的分片）。

---

## 5. 待店主确认（不替店主决定；执行方先按「默认」做，03 回判时一并交店主拍板）

1. **列表里手机号要不要打码**：预览列表画的是 `138****5678`，但后台现状两个列表都是**全显**并且可点拨、可复制（店员靠它回电、核单）。默认：**沿用现状全显**；要打码只需改 `OrderListTable` 一处。详情页无论如何全显。
2. **同城列表卡片上要不要保留「退款」按钮**：预览卡片只画了「去工作台」，退款在详情页；但现状同城列表有「退款」，邮寄列表按决策 4 也保留退款。默认：**保留**（两页一致、不减功能）；店主嫌多可去掉。

以下**不需要确认**，已按既有决策推出，记录以便复核：
- 「今天还没完成」= 上海自然日的今天下单 **且** 状态 ∈ PAID / PREPARING / SHIPPED（这三个正是工作台看板的列；REFUNDING / COMPLETED / CANCELLED / REFUNDED 不在看板上，跳过去也是死路）。
- 商品行「已退」只在全额退款时标，部分退款一律不标（店主原话：判断不了就不标）。
- 「接单」节点不显示操作人（库里没有）。
- 自选日期不设 92 天上限（店主要看完整历史；stats 的 92 天是趋势图的性能考虑，订单列表有分页）。
- 邮寄轨迹条目管理端补一个只读字段（T1 ④），不动数据库。
- 切换「同城配送 / 全国邮寄」页签时日期筛选不跨页保留（`BusinessCenter` 跳的是不带 search 的 `tab.to`，现状状态筛选也是如此）。

---

## 6. 上线顺序与回滚

- 服务端与后台可同一次 deploy（服务端只加只读字段与可选参数，旧后台不传日期行为不变；新后台对老服务端：日期参数被忽略、`latestDelivery` 缺失显示「—」、`track` 缺失显示「暂无轨迹」——都不崩）。
- 零迁移，回滚 = `DEPLOY_REF` 指回上一版即可。发版后店员挂着的旧后台页面靠版本横幅提示刷新（批次六机制）。

---

## 7. 复核与收尾（02–04）

- 02 复核 · opus：新会话，只给「店主已确认的需求（任务描述原文）+ 两份预览 + 最终 `git diff 5255d34...HEAD` + 本文件第 2 节验收标准」；重点：① `Orders.tsx` 按钮集合与顺序是否与 §0 表逐字一致；② 时间线是否有任何编造的节点或操作人；③ `moneyRows` 与小票顺序；④ 日期换算三处是否真的同一函数且 stats 行为除「非法日期 400」外无变化；⑤ 手机三档量法是否按 B4 执行而不是读 `scrollWidth`。
- 03 回判 · fable：处理「待店主确认」与复核意见。
- 04 机械核对 · haiku：只跑 A 类命令并逐条贴输出。

---

## 勘误与验收记录（执行时追加）

### 实际开工尖端
- `39be9454b2259d8ad350b7828ed35fc6228bf681`（= HEAD，与方案声明的基线一致；本 worktree 无 `node_modules`，开工先 `npm install` + `cd apps/server && npx prisma generate`）

### 每个 Task 的提交
- T1：`af83334` feat(server): 订单列表按上海自然日筛选 + 骑手列 + 邮寄轨迹只读字段
- T2：`267a100` feat(admin): 订单详情/列表用的纯逻辑模块（日期筛选、列表摘要、金额与时间线）
- T3：`a8309d9` feat(admin): 新增订单详情页 /orders/detail/:id
- T4：`65df19f` feat(admin): 统一订单列表组件 + 日期筛选，同城列表改造
- T5：`1cb8a88` feat(admin): 邮寄订单列表改用统一列表组件 + 日期筛选
- T6：无新提交（只是核对，发现的尺寸问题已在 T3–T5 提交里改好；见下方 B4）
- T7：本次提交（docs/api.md、docs/staff-guide.md、本文件）

### A 类验收结果（真实输出）

| # | 命令 | 实际输出 |
|---|---|---|
| A1 | `npm run build --workspace=apps/server` | `> tsc`，退出码 0，无错误输出 |
| A2 | `npx tsc -p apps/admin --noEmit` | 退出码 0，无输出 |
| A3 | `npm test --workspace=apps/admin` | `ℹ tests 91 / pass 91 / fail 0`；输出含 `order-date-range.test.ts` 系列（date-range/order-date-range/order-list/order-detail/time/navigation 用例名均出现，见下方逐条用例名） |
| A4 | `npm run build --workspace=apps/admin` | 先打印 `✔ 管理端时间渲染全部走 Asia/Shanghai（无本地时区解读）`，随后 `vite build` 成功（`✓ built in 1.1~1.4s`） |
| A5 | `TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-day.ts` | 9 例全 `✔`，退出码 0；`TZ=Asia/Tokyo` 重跑：输出「本自测必须以 TZ=Asia/Shanghai 运行」，退出码 1 |
| A6 | 干净库 e2e（`food_shop_odetail`，`DROP DATABASE` 重建 + `migrate deploy` + `db seed` + 重启服务端后跑） | `================ 通过 1817 / 失败 0 ================`；`== 67.` 段 11 条全 `✔`；`== 54.` 段（经营概览）全绿、无新增红；`== 51/53` 未见红。**注**：中途曾在同一库上跑过第二次 e2e（未重建库），出现 7 条与库存回滚/打印补打/配送 UNKNOWN 认领/邮寄对账相关的红——核实后确认是**复用了已跑过一次 e2e、且被我在 B 类人工验证里用 SQL 改过 2 笔订单（id 85/112）时间戳与状态的脏库**，不是代码回归（`git diff af83334..HEAD -- apps/server/` 为空，T2–T5 全是纯前端改动，不可能影响这些服务端断言）；重建干净库后复测即回到 1817/0，以此为准 |
| A7 | `git diff --name-only 5255d34...HEAD \| grep -E 'Workbench\.(tsx\|css)$'` | 空输出 |
| A8 | 同上 `grep -E '^apps/server/prisma/'` | 空输出（零迁移） |
| A9 | 同上 `grep -E '^apps/miniapp/'` | 空输出 |
| A10 | `git diff --name-only 5255d34...HEAD` 逐行比对白名单 | 全部落在白名单内（见下方文件清单） |
| A11 | `grep -n "'/orders': '/orders/express'"` 命中；`grep -n 'path="local"\|path="express"\|path="orders/detail/:id"' App.tsx` 三条都命中；`node --test navigation.test.ts` | 三条 grep 均命中；测试 `17 pass / 0 fail`（含新增的 `orderDetailPath` 断言） |
| A12 | `pages/Orders.tsx` 逐个 `grep -c` 业务按钮 | 17 项全部 ≥1（接单/直接发货/发货/标记完成/再退款-退款/重试退款-发起退款/微信处理中/退款异常/手动标记完成/发赔偿券/取消/重打小票/AfterSalePanel/IssueCouponModal/订单发货弹窗/AUTO_REFRESH_MS/自动刷新失败），`grep -c "展开\|收起"` = 0 |
| A13 | 两页共用列表 | `OrderListTable` 在 `Orders.tsx`/`LocalOrders.tsx` 各 2（import + 使用）；两页 `<table` 均 0；`LocalOrders.tsx` 的 `配送时间线` 0 |
| A14 | 纯逻辑无 UI 依赖 | `grep -l "from 'react'\|lucide-react\|\.tsx'" utils/order-*.ts utils/date-range.ts` 空输出 |
| A15 | 三处共用日期换算 | `parseLocalDayStart` 在 `stats/shared.ts`/`scan-stats.ts`/`orders.ts` 各 4 处引用；三文件内 `T00:00:00` 字面量（排除注释）为空 |
| A16 | 退款计算未动 | `git diff 5255d34...HEAD -- services/refund.ts components/RefundDialog.tsx` 空 |
| A17 | 服务端手工契约（curl，`BASE=http://localhost:3115`） | `startDate=2026-02-30` → `code 40001`；`startDate=2026-09-18&endDate=2026-09-17` → `40001`；不带日期 → `code 0` 且 `list[0] has latestDelivery` = true；任一邮寄单 `.../booking` 的 `data` `has("track")` = true |
| A18 | `git log 5255d34..HEAD --format=%B \| grep -c "Co-Authored-By: Claude "` | 7（本批 5 个任务提交 + 00 规划阶段 fable 的 2 个 docs 提交，均 ≥ 对应提交数） |

A3 逐条用例名（`node --test src/*.test.ts src/utils/*.test.ts`，共 91 例，0 fail）：新增的 46 例分布在 `utils/time.test.ts`（5）、`utils/order-date-range.test.ts`（14）、`utils/order-list.test.ts`（14）、`utils/order-detail.test.ts`（12）、`navigation.test.ts`（+1 `orderDetailPath`）；其余 45 例为改造前已有用例，原样通过。

### 回退验证结果（4 项，均按方案改坏 → 变红 → 还原 → 变绿，`git status --porcelain` 复原后为空）

1. **`localDayBounds` 的 `lt` 去掉 `+1` 天**：`A5` 从 9 例全绿变为 2 例失败（`parseLocalDayStart(2026-12-31) 有效，跨年 lt 落到 2027-01-01` 与 `localDayBounds(同日,同日)：gte/lt 各落在北京 00:00 边界`，报错「起始日期晚于结束日期」，退出码 1）；还原后 `TZ=Asia/Shanghai` 重跑恢复 9 例全绿。
2. **`showWorkbenchLink` 去掉「下单日期是今天」判断**（改成 `return true`）：`node --test order-list.test.ts` 从 14 例全绿变为 1 例失败（`showWorkbenchLink：昨天 PAID → false`，`actual: true !== expected: false`）；还原后恢复全绿。
3. **`moneyRows` 把「满减」与「优惠券」两行顺序对调**：`node --test order-detail.test.ts` 的顺序断言失败（`actual: [...,'coupon','promo',...]` vs `expected: [...,'promo','coupon',...]`）；还原后恢复全绿。
4. **`orderDateQuery` 的 `today` 改用 `now.toISOString().slice(0,10)`（UTC 日）**：`node --test order-date-range.test.ts` 的时区边界用例失败（北京 00:30 应给 `2026-09-19`，实际给了 UTC 当天 `2026-09-18`）；同时验证了 `node scripts/check-admin-timezone.mjs` **仍然绿**（`toISOString` 不在闸门禁用名单里）——这正是本条单测存在的意义：闸门管不到的时区 bug，靠这条测试兜底。还原后两者都恢复正常。

### B 类（Browser 工具在 5178→3115 实测；未登录任何真实账号——用 curl 拿到管理员 JWT 后通过 `localStorage.setItem('admin_token'/'admin_info', ...)` 注入，全程未在任何表单里输入密码）

- **B1 三档**：1280×800 实测 `grid-template-columns: 856px 360px`（右栏精确 360px），左栏 商品+金额同卡→退款记录→售后，右栏 订单头→进度→收货→配送，顺序与方案一致。768×1024 实测内容区 `width:672px, left:48px`（居中），底部固定栏 `getComputedStyle(...).display === 'none'`。375×812 实测单栏，顺序订单头→进度→顾客→商品→金额→配送/物流→退款记录→售后（同城单与邮寄单各实测一次，均一致），底部固定栏可见且含「重打小票」「退款（还可退 ¥X）」，标题右侧（`hidden md:flex` 容器）在手机宽度下不渲染。
- **B2 渠道差异**：同城单（LOCAL，订单 150/#ORD202609181858）实测「配送」块含运力 `MOCK`、状态徽标「已送达」、骑手姓名+电话、配送成本 ¥5.00、「展开配送轨迹（4 条）」；自取单（PICKUP，订单 186）实测「取餐信息」块（预约取餐/备好/取走三个时间）、金额里「自取优惠 −¥0.60」、且**没有**配送/物流块；邮寄单（EXPRESS，订单 167，`track_json` 非空）实测「物流」块含快递单号+复制、取件预约「9月19日 时段不限 · 已签收」、重量 1.1kg、运费「顾客付 ¥0.00 · 实扣 ¥12.60」，展开物流轨迹后显示「2026-09-11 09:00:01 已签收，签收人：本人（补）」（服务端 T1④ 的 `track` 字段端到端验证通过）。
- **B3 内容正确性**：金额行顺序逐屏核对与 `moneyRows()` 单测一致；全额退款单（订单 71，实付/已退均 ¥100.00）商品行实测划线 + 红字「已退」标；部分退款单（订单 62，实付¥100/已退¥60/还可退¥40）商品行**未**划线、底部按钮显示「再退款（还可退 ¥40.00）」；退款记录块（订单 71）实测显示**全部 4 笔**，每笔都带金额/状态/`模拟`标/原因/`操作人 admin`；时间线节点升序——过程中发现 2 张历史测试单（71、186）的 `completedAt`/`paidAt` 早于 `createdAt`（`SELECT` 核实为 e2e 早期批次遗留的测试夹具时间戳异常，非本批引入），此时时间线仍按时间正确升序排列，是数据异常不是代码缺陷，一并记录供复核参考。点击「复制单号」按钮触发了 `navigator.clipboard.writeText`，但无头浏览器下 `Document is not focused`，无法读回剪贴板内容验证；`onClick`/`title` 均核对为 `copyText(order.orderNo)` 等既有实现，逻辑未变，判定为自动化环境限制而非代码问题。
- **B4 手机零横向溢出**：360/375/390 三档在 `/orders/local` 页面用方案给的量法脚本实测 `scrollWidth<=innerWidth` 均 `true`，日期 chip 行固有宽度 281.9px，三档可用宽分别为 304/319/334px，均 `true`；详情页（375）`scrollWidth===innerWidth===375`，底部固定栏 `getBoundingClientRect().width === 375 === window.innerWidth`。
- **B5 「去工作台」**：用 SQL 把一笔今天 PAID 的同城单（id 85）直接在筛选后的列表里核对——今天+PAID 时该行含「去工作台」；`UPDATE created_at = 前一天` 后刷新，该行消失「去工作台」；再 `UPDATE created_at 回今天 + status='COMPLETED'` 后仍无「去工作台」。EXPRESS 列表全程截图未见过「去工作台」（`showWorkbenchLink` 对 `deliveryType==='EXPRESS'` 恒 `false`，单测已覆盖）。
- **B6 日期筛选叠加**：同城页选「今日」+ 状态「已完成」实测 URL 为 `?range=today&status=COMPLETED`；切到「自选」两端空 → 显示「请选完整的起止日期」；只填开始 → 仍显示该错误；两端都填（9-01～9-10）→ URL 变为 `range=custom&startDate=2026-09-01&endDate=2026-09-10`，结果计数行显示「9月1日 – 9月10日 · 共 0 单」（当期没有匹配单，属实）；切回「全部」→ URL 的 `range/startDate/endDate` 三键均消失，只剩 `status=COMPLETED`。
- **B7 返回与刷新**：从带筛选的同城列表点卡片 → 地址变为 `/orders/detail/186`；对该 URL 做浏览器级刷新（重新整页加载同一 URL）→ 仍是详情页且数据正常（`getOrder` 按 id 重新拉取，不依赖任何客户端缓存）；点「‹ 返回」→ 回到 `/orders/local?status=COMPLETED&range=today`（与进入前的筛选一致）。另外单独验证「直接在地址栏打开详情（无 `location.state`）再点返回」：EXPRESS 单（id 71）落到 `/orders/express`（无残留 query），符合 `backTargetFor` 兜底逻辑。顶栏「订单管理」在详情页与列表页截图对比均保持高亮（`pathname.startsWith('/orders')` 命中）。`/orders`→`/orders/express`、`/local/orders`→`/orders/local` 两条旧地址实测均正确重定向；`/orders/local`、`/orders/express` 直接可开。
- **B8 邮寄列表操作不回归**：PAID 邮寄单行实测有「接单」「直接发货」「退款」「发赔偿券」「重打小票」；点「接单」后该单从「待接单」筛选结果里消失（说明操作成功执行）且 URL 仍是 `/orders/express?status=PAID`（未跳详情，`stopPropagation` 生效）；点行内空白区域（订单号文字）实测跳转 `/orders/detail/112`；「售后」页签切换后仍渲染 `AfterSalePanel`（子状态 Tab 待处理/退款中/已退款/已拒绝/全部齐全），且日期筛选与搜索框在该页签下不出现。
- **B9 详情页操作**：点「退款」弹出既有 `RefundDialog`，实测弹窗内「可退 ¥29.00」与按钮上「还可退 ¥29.00」一致，且弹窗内显示「该单配送成本 ¥5.00（已呼骑手/小费/取消费合计），退款金额不含此成本」（`deliveryCostFen` 透传验证）；对一张手动 `UPDATE created_at` 改到 2026-08-10（跨月，PAID 状态）的历史单点「重打小票」，实测 toast 显示「已发送重打」，未报错（mock 打印机路径）。退款成功后自动刷新未做端到端下单验证（会污染测试单量与后续对账，评估为低风险跳过——退款成功回调路径与 `onDone` 触发的 `load()` 复用的是 T3 之前就存在、未改动过的 `RefundDialog` 组件本身的逻辑）。
- **B10 工作台**：`/workbench` 截图正常渲染看板四列（待接单/备餐中/等待配送/配送中），无控制台报错，与本批改动无关联（本批未碰 `Workbench.tsx`），判定无回归。

### 是否命中上报触发条件

未命中任何一条（1–12 逐条核对）：无新增迁移；重打小票对历史单返回「已发送重打」（核实无状态/日期守卫，与规划一致）；未改 `Workbench.tsx`/`.css`；未改退款计算或 `RefundDialog` 入参语义；详情页所需字段均能从既有三个接口（含 T1 加的 `track`）拿到；未改白名单外文件；邮寄既有按钮/弹窗/售后页签/30 秒刷新全部保留（A12/B8 已核实）；手机 360 宽日期 chip 行量法通过，未改横滑；`stats/shared.ts`/`scan-stats.ts` 改调共用函数后 e2e §54 与其它既有分片干净库复测全绿；生产进程时区问题已由统筹方核实为未触发（未 ssh 生产机）；`npm test`/`build:admin` 基线本就是绿的（开工前已确认）；干净库 e2e 唯一一次出现的红是本执行方自己造成的脏库复测（已定位、已用干净库复测排除，不算「与本批无关的红」范畴内的异常，但仍记录在此供复核）。

### 偏离（本文件既定方案之外的处理，均为方案未锁死细节处的补充决定，未修改任何验收标准）

1. **`OrderListTable` 加载失败态不含「重试」按钮**：方案给的 props 签名（`list/loading/loadFailed?/emptyText/now/onOpen/renderActions?`）没有 `onRetry`，故加载失败时只显示错误文案，重试统一走页面顶部已有的「刷新」图标按钮（两页原本就有）。不影响任何验收标准（A/B 均未要求组件内置重试按钮）。
2. **`DetailHero` 的「状态大字」直接复用 `StatusBadge` 组件本身（放大到 `text-base` 容器内）**，没有另起一套独立配色映射——方案原话「颜色沿 StatusBadge 的语义」，复用组件本身是最贴合「同一语义」的做法，且避免了 `STATUS_MAP` 的色值表在两处重复维护、日后改配色漏改一处的风险。
3. **`DetailItems`/`DetailMoney` 组件本身不带外层卡片容器**（`bg-white rounded-lg shadow-card` 由调用方套），只有这样才能满足方案「≥lg 商品+金额明细同一卡」与「手机/iPad 分两张卡」这两种不同的卡片边界要求——若组件自带卡片容器，宽屏下会变成卡中卡。
4. **LocalOrders.tsx 引入了 `loadFailed` 错误态**（原文件对列表加载失败只是静默保留旧数据、无任何提示），这是采用 `OrderListTable` 内置能力后顺带获得的改善，不在方案「保留既有功能」清单要求之内，但也不减少任何既有功能，判断为低风险的正向变化，未单独找店主确认；如认为超出授权范围，可在 `LocalOrders.tsx` 里把 `loadFailed` 恢复成 `catch(() => {})` 静默吞掉。
5. **`utils/order-list.ts` 里的 `DELIVERY_STATUS_LABEL`（配送单状态中文）与 `components/ui/StatusBadge.tsx` 的 `STATUS_MAP` 里配送单那一段字面量重复**——这是 A14「纯逻辑不许 import .tsx」硬约束下唯一可行的做法（`StatusBadge.tsx` 里有 JSX，`node --test` 无法解析），已在代码注释里写明「改配送单状态文案时两处都要改」，属于方案本身隐含要求的必然产物，不是我引入的额外债务。

### 没把握的地方（提请 02 复核重点关注）

1. **B3 时间线升序的两处数据异常**（订单 71：`completedAt` 早于 `createdAt`；订单 186：`paidAt` 早于 `createdAt`）：我核实为历史测试夹具遗留、非本批引入，`timelineNodes()` 面对乱序时间戳仍能正确升序排列（因为它就是纯粹按时间戳排序，不假设业务时序），行为符合预期；但**没有**验证过如果生产环境真出现类似的数据异常（例如时钟回拨、补录数据），店员看到的时间线是否会造成误解——这属于产品/数据治理问题而非本批代码缺陷，建议复核时确认是否需要在详情页加一条「数据时间异常」的提示（方案未要求，我没有加）。
2. **`OrderDetail.tsx` 的 `≥lg` 两栏用了两份几乎重复的 JSX**（`lg:hidden` 单栏一份、`hidden lg:block` 两栏各一份，共渲染三份 DOM，用 CSS 显隐切换而非用 JS 判断断点后只渲染一份）——这是延续 `components/ui/Table.tsx` 的 `mobileCards`/桌面表格双渲染惯例（该文件本身也是移动端和桌面各渲染一份、用 `hidden md:block` 切换），不是我发明的新模式，但订单详情页比 Table 组件更重（含时间线、金额明细等），三份 DOM 同时挂载对首屏渲染成本略有增加，量级上应该无感，但没有做性能实测，复核如认为有必要可以要求换成 JS 断点判断只渲染一份。
3. **`DetailActions` 在页面里渲染了两个实例**（`hidden md:flex` 表头一份、`fixed ... md:hidden` 底部一份），各自持有独立的 `refundOpen` 状态——同一时刻只有一个在视觉上可见/可点（CSS 互斥），逻辑上不会出现两个 `RefundDialog` 同时弹出的问题，但如果将来断点判断逻辑出错（比如两者同时 `display:block`），会有重复弹窗的风险。当前 B1/B4 的宽度实测里两个断点的显隐是互斥的（表头按钮在 `<md` 消失、底部栏在 `≥md` 消失），未发现问题。
4. **e2e 中途曾用一份跑过一次的脏库复测出现 7 条红**（见 A6 备注），虽已定位为脏库导致、用干净库复测排除，但复核如果想更彻底地排除疑虑，可以再跑一次干净库 e2e 自行确认（约 9–10 分钟）。

---

## 03 回判与修补轮（fable · Fable 5.1，2026-09-18）

> 工序声明：**03 回判 · fable**。只判断、不写业务代码。逐条亲自打开代码核对了 02 复核（opus）的问题清单；下面的判定以代码为准，复核方引用的行号已逐一核实。
> 修补轮链路：**01' 执行 · sonnet（按本节任务清单 R1–R14）→ 02' 复核 · opus（新会话：只给「需求要点 + 本节 + 修补 diff」）→ 03' 回判 · fable → 04 机械核对 · haiku（A 类，A3 按上表修订后的写法）**。本节不新增、不放宽第 2 节任何验收标准；本节的「验证方法」是修补任务的完成判据，不是新的 A/B 条目。

### 一、对 [需改 1–6] 与 A3 的逐条判定

| # | 判定 | 核对依据 |
|---|---|---|
| 需改 1 `latestRefund` | **成立** | `routes/admin/orders.ts` 的 `GET /:id` 只 `success(res, { ...order, coupon, receiverDisplayAddress, remainingRefundable })`，`include.refunds` 全量倒序，**没有** `latestRefund` 字段；`types.ts:210` 的 `Order.latestRefund?` 是可选，所以 `tsc` 不报。`DetailActions.tsx:60-61` 的 `r` 恒为 `undefined` → `refundActive` 恒 false → 退款中单显示「发起退款」而非「微信处理中」、按钮不禁用；`RefundDialog.tsx:172` 的「上次失败原因」永不显示。服务端 42205/42206 兜底不会超额，但违反 T3③「照抄 `renderRefundActions`，不放宽」。 |
| 需改 2 「手动标记完成」 | **成立** | `DetailActions.tsx:43-58, 85` 确有 `handleCompleteRefund` + 按钮；T3③ 原文「**不放**…手动标记退款完成…（发赔偿券与手动标记完成留在邮寄列表）」。而且对同城/自取单也放开了（基线只在邮寄列表有）。**删除**，不替店主决定放回；保留价值见「待店主确认 3」。 |
| 需改 3 弹窗困在底栏层叠上下文 | **成立** | `OrderDetail.tsx:181-183` 把底部 `DetailActions`（内含 `RefundDialog`）放在 `md:hidden fixed inset-x-0 bottom-0` 容器里；`position:fixed` 元素自身就是一个层叠上下文，`Modal.tsx:34` 的 `z-50` 只在该上下文内生效；容器本身 `z-index:auto`，会被 `Layout.tsx` 顶栏 `relative z-30` 压在下面 → 顶栏不变暗且可点。 |
| 需改 4 `dateErr` 时骨架屏永远不退 | **成立** | `LocalOrders.tsx:61` / `Orders.tsx:60` `loading` 初始 `true`；`load()` 在 `dateErr` 时 `return`（`LocalOrders.tsx:67`、`Orders.tsx:80`）不清 `loading`；`Table.tsx:40` 在 `loading && isEmpty` 时渲染骨架。带 `range=custom&startDate=…`（只一端）的 URL 首次挂载即命中：返回详情页时 `from` 会带回这种 URL。 |
| 需改 5(a) `at.slice(0,10)` 比 UTC 日 | **成立** | `DetailTimeline.tsx:21`。服务端时间戳是 ISO UTC 字符串，`slice(0,10)` 取的是 UTC 日；北京 23:30 / 次日 00:30 会被判同日、07:30 / 09:00 前一天会被判跨日。`check-admin-timezone.mjs` 只拦 `getDate/getHours/…` 属性，拦不到 `slice`。违反 Global Constraints「时间显示与『今天』判定只经 `utils/time.ts`」。 |
| 需改 5(b) CLOSED 标「退款处理中」 | **成立** | `utils/order-detail.ts:160-161` 只区分 SUCCESS / FAILED+ABNORMAL / 其它；`services/refund.ts:445-456` `markRefundClosed` 置 `activeOrderId: null`、提示「可在后台重试退款」，schema 注释也把 CLOSED 列为终态。`REFUND_STATUS_LABEL` 已有 `CLOSED: '已关闭'`（退款记录块是对的），只有时间线错。 |
| 需改 6(a) 「售后」标签退化 | **成立** | 基线 `Orders.tsx:267-275` `renderAfterSaleTag` 是 `<button onClick={() => handleTabChange('AFTER_SALE')}>`，卡片（:442）与表格（:505）都有。现 `OrderListTable.tsx:72-96` 手机卡片完全没有；:138-143 表格是不可点 `<span>`。T5① 明写保留 `renderAfterSaleTag`，T4① 卡片规格漏写了它、A12 也没覆盖——**方案漏项，责任在 00 规划**，修补轮补上。 |
| 需改 6(b) 金额测试只自洽夹具 | **成立** | `order-detail.test.ts:31-32` 的 `sum` 全由夹具字段相加，与 `rows` 无关；`rows` 只断了 key 顺序与 `refunded.fen===0`。把满减/券的 `fen` 互换或「还可退」改用实付，测试仍绿——回退验证 3 只能抓顺序，抓不了金额。 |
| A3 字面不可满足 | **成立** | 本机 Node v25.9.0：`npm test` 输出 `ℹ tests 91 / ℹ pass 91 / ℹ fail 0`，无 `# fail 0`；`grep -c "order-detail.test.ts\|navigation.test.ts"` = 0。`--test-reporter=tap` 只打印 `# Subtest: <用例名>`，同样没有文件名。已在第 2 节表内改写（标注「03 回判修订」），判据等价不放宽。**另**：验收记录里 A3 一行写「输出含 `order-date-range.test.ts` 系列」与事实不符（输出里只有用例名），以修订后的 A3 为准。 |

**无误判项。** 复核方的 6 条需改与 A3 意见全部成立。

### 二、对 [建议] 的取舍

| # | 取舍 | 理由 |
|---|---|---|
| B-a 768 宽操作列每按钮一行、「重打小票」内部折行 | **纳入**（R8） | 店主拍板「768–1023 表格 6 列」是本批要交付的一档；基线 `Orders.tsx:510` 操作列是 `whitespace-nowrap`，现在一行 160px 高是本批引入的适配退化。根因：`OrderListTable.tsx:130` 商品列 `max-w-[320px] truncate`（nowrap）在 auto 布局表格里把宽度抢走，操作列被压到只剩一个按钮的宽度。 |
| B-b 详情页头部与已确认预览不一致；状态非「大字」 | **纳入**（R9） | 店主已确认的预览：手机 `.dtop` 是「‹ + 订单详情」标题栏，`.hero .st` 19px/600 的状态大字；宽屏 `.dhead` 是「订单详情 + 单号 + 复制 + 渠道标签 + 右侧按钮」。现 `OrderDetail.tsx:125` `h1` 是 `sr-only`，`DetailHero.tsx:19-21` 把 `StatusBadge` 套在 `text-base` 里——但 `StatusBadge.tsx:48` 自带 `text-xs`，外层字号不生效，实际还是小徽标。执行方「偏离 2」的理由（复用组件避免两套配色）成立，但结果没达到「大字」。 |
| B-c 375 底栏按钮折两行 | **纳入**（R10） | 手机优先是店主明确要求；预览 `.actbar .btn{white-space:nowrap}`。两个 `flex-1` 均分 171px，「再退款（还可退 ¥29.88）」`text-sm` 加内边距约 214px，必折。 |
| B-d 列表失败态无「重试」；详情页非 404 失败白屏 | **纳入**（R11） | 基线 `Orders.tsx:414-417` 失败态有「重试」按钮，本批丢了（执行方「偏离 1」自述）；手机上顶部刷新图标离失败提示很远。详情页 `OrderDetail.tsx:107` `return null` 是新页面的空白失败态，不合手机优先。 |
| B-e 30 秒静默刷新闭包里的 `now` 过期 | **纳入**（R12） | 本批引入的日期筛选与既有静默刷新叠加出来的新 bug；修法一行（`load` 内现取 `new Date()`）。 |
| B-f 手机卡片少「备注」提示与复制手机号 | **部分纳入**（R13 只补「备注」小标） | 表格行有橙色「备注」小标（T4① 规格），卡片没有——同一列表两档不一致，违反「UI 统一」；基线邮寄卡片有备注全文，本批丢了。复制手机号：预览卡片（店主已确认）没有，卡片电话是 `tel:` 可拨，详情页有复制；**不纳入**，记入遗留。 |
| B-g 「自选」图标无 `aria-label` | **纳入**（R13） | 一行；手机上该按钮只剩图标，无可读名称。 |
| B-h `copyText` 剪贴板不可用时无提示 | **纳入**（R13） | T3⑤ 原文「`navigator.clipboard` 不可用时 toast 失败」，现 `copyText.ts:5` 的 `?.` 把整条链短路成 `undefined`，既不报错也不提示。局域网 http 打开后台时 `navigator.clipboard` 就是 `undefined`，正是店员手机会遇到的场景。 |
| B-i 详情页三份 DOM 靠 CSS 显隐 | **不纳入** | 能用、与 `ui/Table.tsx` 双渲染惯例一致；改成 JS 断点是重构，风险大于收益。记入遗留。 |
| B-j e2e 67 ⑨ 只查键存在 | **不纳入** | A17 原文就是 `has("latestDelivery")`；补「有骑手取值」需要在分片里造配送单，超出修补轮范围。记入遗留。 |
| B-k 同城列表对已取消单显示「退款」 | **不纳入** | 基线 `LocalOrders.tsx:262` 就是 `remainingRefundable > 0` 判定，非本批引入；服务端 42204 挡住。记入遗留。 |

### 三、修补轮任务清单（R1–R14；01' 执行 · sonnet）

通用约束同 Global Constraints；只允许改白名单内文件；**不得**触碰 `services/refund.ts`、`RefundDialog.tsx`、`Workbench.tsx`、prisma、miniapp（A7–A9、A16 仍须为空）。每条修完自己跑一遍对应验证，把真实输出贴进本节末尾「修补轮记录」。

**R1（需改 1）`latestRefund` 映射** — 文件：`apps/admin/src/utils/order-detail.ts`、`apps/admin/src/pages/OrderDetail.tsx`、`apps/admin/src/utils/order-detail.test.ts`
- 期望：`order-detail.ts` 新增纯函数 `withLatestRefund<T extends { refunds?: RefundRecord[] }>(o: T): T & { latestRefund: RefundRecord | null }`，返回 `{ ...o, latestRefund: o.refunds?.[0] ?? null }`（服务端 `GET /:id` 的 `refunds` 已按 `createdAt desc`，`[0]` 与列表接口的 `latestRefund` 同一条）。`OrderDetail.tsx` 的 `load()` 里 `setOrder(withLatestRefund(res.data.data))`；`DetailActions.tsx:60` 读 `order.latestRefund` 不改。
- 新增测试（`order-detail.test.ts`）：① `refunds: [{status:'PROCESSING', createdAt:'…T02'}, {status:'FAILED', createdAt:'…T01'}]` → `latestRefund.status === 'PROCESSING'`；② `refunds: []` → `latestRefund === null`；③ `refunds` 缺省 → `null`。
- 验证：A3；Browser 375/1280 打开一张有 PROCESSING 退款单的详情 → 底栏/标题右侧显示「微信处理中」且无「发起退款」按钮；一张 `latestRefund.errorMessage` 非空的单点「重试退款」→ `RefundDialog` 内出现「上次失败原因：…」。

**R2（需改 2）删除「手动标记完成」** — 文件：`apps/admin/src/components/orders/detail/DetailActions.tsx`
- 期望：删掉 `handleCompleteRefund`、`confirmDialog`/`completeRefund` import 与 :85 的按钮；`REFUNDING` 分支只剩「重试退款 / 发起退款」按钮与「微信处理中 / 退款异常」文字。
- 验证：`grep -c "completeRefund\|手动标记\|confirmDialog" apps/admin/src/components/orders/detail/DetailActions.tsx` = 0；A12 对 `pages/Orders.tsx` 仍全部 ≥ 1（列表侧不动）。

**R3（需改 3）退款弹窗提到页面级** — 文件：`DetailActions.tsx`、`pages/OrderDetail.tsx`
- 期望：`DetailActions` 去掉内部 `refundOpen` 状态与 `RefundDialog`，改为 props `onRefund: () => void`；`OrderDetail.tsx` 持有 `const [refundOpen, setRefundOpen] = useState(false)`，两处 `<DetailActions onRefund={() => setRefundOpen(true)} …/>`，`RefundDialog` **只渲染一份**，放在最外层 `<div className="pb-24 md:pb-6">` 的直接子级、**不在** `fixed` 底栏容器内；`onDone` → 关弹窗 + `load()`。
- 验证：Browser 375×812 打开可退款单，点底栏「退款」后在控制台执行：`const ov=[...document.querySelectorAll('div.fixed.inset-0')].find(e=>e.className.includes('bg-black/40')); [ov.closest('.md\\:hidden.fixed')===null, document.elementFromPoint(innerWidth/2, 28)===ov || ov.contains(document.elementFromPoint(innerWidth/2, 28))]` → `[true, true]`（弹窗不在底栏里；顶栏中心点被遮罩盖住）。`grep -c "RefundDialog" apps/admin/src/components/orders/detail/DetailActions.tsx` = 0；`grep -c "<RefundDialog" apps/admin/src/pages/OrderDetail.tsx` = 1。

**R4（需改 4）`dateErr` 时清 loading** — 文件：`pages/LocalOrders.tsx`、`pages/Orders.tsx`
- 期望：两页 `load()` 的 `if (dateErr) return` 改为 `if (dateErr) { setLoading(false); return }`（`Orders.tsx` 的 `isAfterSaleTab` 那条不动）。
- 验证：Browser 直接打开 `/orders/local?range=custom&startDate=2026-09-01` 与 `/orders/express?range=custom&endDate=2026-09-10`，等 1 秒后 `document.querySelector('.animate-pulse') === null` 为 true，且页面上出现「请选完整的起止日期」。

**R5（需改 5a）跨日判断走 `utils/time.ts`** — 文件：`apps/admin/src/utils/time.ts`、`apps/admin/src/utils/time.test.ts`、`components/orders/detail/DetailTimeline.tsx`
- 期望：`time.ts` 新增 `export function sameDayKey(a: Input, b: Input): boolean { return fmtDate(a, '') !== '' && fmtDate(a, '') === fmtDate(b, '') }`；`DetailTimeline.tsx` 的 `fmtNodeTime` 改用 `sameDayKey(at, first)`，文件内不再出现 `.slice(0, 10)`。
- 新增测试（`time.test.ts`）：① `sameDayKey('2026-09-17T15:30:00Z','2026-09-17T16:30:00Z')` → **false**（北京 23:30 vs 次日 00:30；UTC 同日）；② `sameDayKey('2026-09-17T23:30:00Z','2026-09-18T01:00:00Z')` → **true**（北京 07:30 vs 09:00；UTC 跨日）；③ 任一端为空/非法 → false。
- 验证：A3；`grep -c "slice(0, *10)" apps/admin/src/components/orders/detail/DetailTimeline.tsx` = 0；A4 闸门仍绿。

**R6（需改 5b）时间线 CLOSED 单独标注** — 文件：`utils/order-detail.ts`、`utils/order-detail.test.ts`
- 期望：`timelineNodes` 的退款 label：`SUCCESS → 退款 ¥X`；`FAILED/ABNORMAL → 退款失败 ¥X`（tone bad）；**`CLOSED → 退款关闭 ¥X`（tone muted）**；其余（PENDING/PROCESSING）→ `退款处理中 ¥X`（tone muted）。
- 新增测试：`refunds: [{status:'CLOSED', …}]` → 存在 label 以「退款关闭」开头的节点，tone `muted`，且不存在「退款处理中」节点。
- 验证：A3。

**R7（需改 6a）「售后」标签恢复可点、卡片补齐** — 文件：`components/orders/OrderListTable.tsx`、`pages/Orders.tsx`
- 期望：`OrderListTable` 新增可选 prop `onAfterSaleTag?: (o: Order) => void`。有 `afterSale` 且状态 ∈ PENDING/APPROVED 时：传了 prop → 渲染 `<button onClick={e => { e.stopPropagation(); onAfterSaleTag(o) }}>`（样式沿现 :139 的红/蓝圆角小标）；没传 → 现有 `<span>`。**手机卡片第一行**（`StatusBadge` 之后）与表格「状态」列都渲染。`Orders.tsx` 传 `onAfterSaleTag={() => handleTabChange('AFTER_SALE')}`；`LocalOrders.tsx` 不传（基线同城列表本就没有该入口）。
- 验证：Browser 375 与 1024 打开邮寄列表，找一张有待处理售后的单 → 卡片与表格都有「售后待处理」小标，点它后 URL 变为 `/orders/express?status=AFTER_SALE` 且**没有**跳到详情页；`grep -c "onAfterSaleTag" apps/admin/src/pages/Orders.tsx` ≥ 1。

**R8（B-a）768 宽操作列不再一按钮一行** — 文件：`components/orders/OrderListTable.tsx`
- 期望：商品列 `max-w-[320px]` 改为 `max-w-[160px] lg:max-w-[320px]`（或等效：让商品列在 `md` 档让出宽度）；操作列容器保持 `flex flex-wrap gap-x-3 gap-y-1`，但给 `<td>` 加 `whitespace-nowrap`（让每个按钮内部不折行，按钮之间仍可换行）。同城页「去工作台」「退款」按钮同样受益，不需单独改。
- 验证：Browser 768×1024 邮寄列表 `status=PAID`，任一行：`[...row.querySelectorAll('td:nth-last-child(2) button')].every(b => b.offsetHeight < 30)` 为 true（无按钮内部折行）且 `row.offsetHeight <= 100`；`document.documentElement.scrollWidth <= innerWidth`。

**R9（B-b）详情页头部与状态大字对齐预览** — 文件：`pages/OrderDetail.tsx`、`components/orders/detail/DetailHero.tsx`、`components/ui/StatusBadge.tsx`
- 期望：
  - `<md`：顶部一行 = 「‹」图标按钮（点击面 ≥ 40×40，`aria-label` 为「返回同城订单 / 返回全国邮寄」）+ 可见标题「订单详情」（`text-base font-semibold`）。去掉 `sr-only` 的 h1，标题就是 h1。
  - `≥md`：第一行「‹ 返回同城订单 / 返回全国邮寄」文字链接；第二行 = 「订单详情」（`text-lg font-semibold`）+ 单号 `font-mono` + 复制按钮 + 渠道标签，右侧 `ml-auto` 放 `DetailActions`（现有 `hidden md:flex` 容器挪到这一行）。
  - `DetailHero`：状态大字——`StatusBadge` 加可选 prop `size?: 'sm' | 'lg'`（默认 `'sm'` = 现状；`'lg'` = `text-base font-semibold px-2.5 py-1`），hero 用 `size="lg"`，颜色仍来自 `STATUS_MAP`（不另起配色表）。hero 里「渠道标签 + 单号 + 复制」那一行在 `≥md` 隐藏（`md:hidden`，因为已在标题行），「下单 …」时间行两档都保留。
- 验证：Browser 375：`getComputedStyle(document.querySelector('h1')).fontSize` ≥ `16px` 且 h1 可见（`offsetHeight > 0`）、文本「订单详情」；hero 状态元素 `fontSize` ≥ `16px` 且 `fontWeight` ≥ 600。1024：标题行同时含「订单详情」、单号、「复制单号」按钮、渠道标签、「重打小票」；hero 内不再有单号。B1 三档顺序与 B4 零溢出复测仍通过。

**R10（B-c）375 底栏按钮不折行** — 文件：`DetailActions.tsx`
- 期望：容器内所有 `Button` 加 `whitespace-nowrap`；「重打小票」`shrink-0`（不再 `flex-1`），退款/重试按钮 `flex-1 md:flex-none`；「微信处理中 / 退款异常」文字 `whitespace-nowrap`。
- 验证：Browser 375×812，一张部分退款单（按钮文案「再退款（还可退 ¥29.88）」这一长度级别）：底栏内 `[...bar.querySelectorAll('button')].every(b => b.offsetHeight < 48)` 为 true；`bar.scrollWidth === bar.clientWidth`；一张 REFUNDING 且 `latestRefund` 为 PROCESSING 的单：底栏显示「重打小票」+「微信处理中」不折行。

**R11（B-d）失败态可重试** — 文件：`OrderListTable.tsx`、`pages/LocalOrders.tsx`、`pages/Orders.tsx`、`pages/OrderDetail.tsx`
- 期望：`OrderListTable` 新增可选 `onRetry?: () => void`，失败态文案下方渲染 `<Button size="sm" variant="secondary" onClick={onRetry}>重试</Button>`（有 prop 才渲染）；两页传 `onRetry={() => load()}`。`OrderDetail.tsx` 新增 `loadFailed` 状态：非 404 失败 → `setLoadFailed(true)`（toast 保留），渲染「订单加载失败」+「重试」按钮（调 `load()`）+ 「‹ 返回订单管理」链接，**不再** `return null`；重新加载成功后清除。
- 验证：Browser 在 5178 用 DevTools 把 `/api/admin/orders` 设为离线（或停掉 3115）→ 两个列表页出现「重试」按钮，恢复后点「重试」列表回来；详情页同法 → 出现「订单加载失败 / 重试」，恢复后点「重试」详情回来。`grep -c "return null" apps/admin/src/pages/OrderDetail.tsx` = 0。

**R12（B-e）静默刷新用当下时间** — 文件：`pages/Orders.tsx`、`pages/LocalOrders.tsx`
- 期望：两页 `load()` 内部 `...orderDateQuery(dateState, new Date())`（不再用渲染期的 `now`）；渲染期的 `now` 只用于 `orderDateSummary`、`showWorkbenchLink`、`fmtListTime`。
- 验证：`grep -n "orderDateQuery(dateState, new Date())" apps/admin/src/pages/Orders.tsx apps/admin/src/pages/LocalOrders.tsx` 各命中 1；`grep -c "orderDateQuery(dateState, now)"` 两文件都为 0。

**R13（B-f/B-g/B-h 小项）** — 文件：`OrderListTable.tsx`、`OrderDateFilter.tsx`、`components/orders/copyText.ts`
- 期望：① 手机卡片第一行在单号后加与表格同款的橙色「备注」小标（`o.remark` 非空时，`title={o.remark}`）；② 「自选」chip 的 `<button>` 加 `aria-label="自选"`；③ `copyText`：`if (!navigator.clipboard) { toast.error('当前环境不支持复制，请长按选择'); return }`，其余不变。
- 验证：① Browser 375 找一张有备注的单，卡片第一行出现「备注」；② `document.querySelector('[data-testid="order-date-chips"] button[aria-label="自选"]')` 非空；③ 控制台 `Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })` 后点详情页「复制单号」→ 出现失败 toast，且控制台无未捕获异常。

**R14（需改 6b）金额测试逐行断言** — 文件：`utils/order-detail.test.ts`
- 期望：把现有「fen 之和自洽」用例改为：① 逐行断言 `rows` 的 `fen`：`subtotal=10000, packing=200, pickupDiscount=300, promo=500, coupon=800, shipping=600, actual=9200, refunded=0, remaining=9200`；② 按 `kind` 求带符号和：`plus` 累加、`minus`（**不含** `refunded`）累减，结果 `=== rows.find(k==='actual').fen`；③ `remaining.fen === o.remainingRefundable`，`refunded.fen === o.refundedAmount`；④ 再加一个部分退款夹具（`actualAmount 9200, refundedAmount 6000, remainingRefundable 3200`）断 `refunded=6000`、`remaining=3200`。
- 回退验证（执行方必做并贴输出）：把 `moneyRows` 里 `promo` 与 `coupon` 的 `fen` 互换 → 用例 ① 必红；把 `remaining` 行改用 `o.actualAmount` → 用例 ③/④ 必红；还原后绿。
- 验证：A3。

### 四、修补轮完成判据（02' 复核与 04 机械核对用）

- A1–A18 全部按第 2 节（A3 按修订写法）重新执行贴输出；A6 干净库 e2e 只需重跑（本轮无服务端改动，`git diff <修补前 sha>..HEAD -- apps/server/` 应为空——若非空即偏离本节，上报）。
- B1、B4、B8、B9 复测；B3 补「时间线里 CLOSED 退款显示『退款关闭』」一眼核对。
- R1–R14 每条的验证输出贴进「修补轮记录」；回退验证（R14）红/绿输出贴齐。
- 02' 复核重点：① R3 弹窗是否真的只剩一份且不在 `fixed` 容器内；② R9 头部是否与两份预览逐项对得上（手机：‹ + 标题；宽屏：标题 + 单号 + 复制 + 标签 + 右侧按钮）；③ R7 的 `stopPropagation` 是否覆盖卡片与表格两处；④ 是否有本节之外的改动。

### 五、待店主确认（03 回判汇总，不替店主决定）

1. **列表手机号打码**（§5-1）：现按默认**全显**（预览画的是 `138****5678`）。要打码只改 `OrderListTable` 一处。
2. **同城列表卡片保留「退款」按钮**（§5-2）：现按默认**保留**（两页一致）。
3. **「手动标记退款完成」要不要进详情页**（由需改 2 引出）：本轮按方案**删除**。补充事实：该兜底入口目前**只在邮寄列表**有，同城/自取单处于 REFUNDING 且回调丢失时后台没有任何界面能做这件事（基线就如此，非本批引入）。若店主认为详情页作为「事后处理」页放它合适，可另起一轮加回（加回时要限 REFUNDING 且带二次确认）；不确认则维持删除。

### 六、遗留清单（非本轮修；记录备查）

- 详情页三份 DOM 靠 CSS 显隐（B-i）；`ui/Table.tsx` 同一惯例。
- e2e 67 ⑨ 只断 `latestDelivery` 键存在，未覆盖有骑手取值与邮寄 `track` 非空（B-j）。
- 同城列表对已取消单仍按 `remainingRefundable > 0` 显示「退款」，靠服务端 42204 拦（B-k，基线行为）。
- 手机卡片没有「复制手机号」（B-f 后半；预览未画，`tel:` 可拨，详情页可复制）。
- 历史测试单存在 `completedAt`/`paidAt` 早于 `createdAt` 的夹具异常（执行方 B3 记录），时间线按时间升序不做提示。
- `utils/order-list.ts` 的 `DELIVERY_STATUS_LABEL` 与 `StatusBadge.tsx` 的配送单文案两处维护（执行方偏离 5，A14 约束的必然产物）。

### 修补轮记录（01' 执行 · sonnet，2026-09-18）

**修补前 sha**：`ceba203`（= 03 回判提交，本轮开工尖端）。本轮**未改任何服务端文件**（`git diff ceba203..HEAD --name-only -- apps/server scripts` 输出为空），故未重跑干净库 e2e；A6 沿用 03 之前的验收记录。

**提交列表**（15 个，逐条对应 R 编号；R8 因实测不达标追加一条补丁提交）：
```
476060c fix(admin): 详情页补映射 latestRefund（R1）
03c5118 fix(admin): 详情页删除"手动标记退款完成"（R2）
0046ee5 fix(admin): 退款弹窗挪到页面级，避开底栏层叠上下文（R3）
72e955a fix(admin): 自选日期缺一端时清掉骨架屏（R4）
d072683 fix(admin): 时间线跨日判断改走 utils/time.ts（R5）
defd2ec fix(admin): 时间线 CLOSED 退款单独标注「退款关闭」（R6）
2299d0b fix(admin): 「售后」标签恢复可点、手机卡片补齐（R7）
d2e83ab fix(admin): 768 宽表格操作列不再一按钮一行（R8）
89b160a fix(admin): 详情页头部与状态大字对齐已确认预览（R9）
be92095 fix(admin): 375 宽底栏按钮不再折行（R10）
e955941 fix(admin): 列表/详情页加载失败态可重试（R11）
060d553 fix(admin): 30 秒静默刷新用当下时间算查询区间（R12）
b8ed72d fix(admin): 手机卡片补备注小标、自选按钮无障碍标签、复制失败有提示（R13）
2b38f43 test(admin): moneyRows 金额测试改逐行断言，不再只自洽夹具（R14）
c180874 fix(admin): R8 追加——768 宽操作列进一步让宽，实测达到验收阈值
```

**环境**：DB `food_shop_odetail`（重建）、服务端 3115、后台 5178。未跑整套 e2e 造数据，改用一批精简 curl/SQL 夹具覆盖三渠道 × 多退款状态（详见下方「浏览器实测」前的数据说明），完成后已 `DROP DATABASE food_shop_odetail`、停掉两个进程、还原 `.claude/launch.json`。

---

#### 各 R 条验证（真实输出）

**R1** `withLatestRefund`：新增 3 条单测全绿（`order-detail.test.ts`，见下方 A3 输出）。浏览器：REFUNDING+PROCESSING 单（id 4）底栏/标题右侧显示「微信处理中」且无「发起退款」按钮；REFUNDING+FAILED 且 `errorMessage` 非空的单（id 5）点「重试退款」→ `RefundDialog` 内出现「上次失败原因：」一行（内容因夹具 SQL 走 docker heredoc 有编码乱码，属测试数据问题，不是代码问题——同一弹窗里「订单号/实付/可退」等直接从接口取值的字段显示正常）。

**R2**：`grep -c "completeRefund\|手动标记\|confirmDialog" apps/admin/src/components/orders/detail/DetailActions.tsx` = `0`；A12 对 `pages/Orders.tsx`「手动标记完成」仍 ≥1（列表侧保留）——浏览器 `/orders/express` 列表 REFUNDING 行确认「手动标记完成」按钮仍在。

**R3**：`grep -c "RefundDialog" apps/admin/src/components/orders/detail/DetailActions.tsx` = `0`；`grep -c "<RefundDialog" apps/admin/src/pages/OrderDetail.tsx` = `1`。浏览器 375×812，id 5 详情页点底栏「重试退款」后执行：
```js
const ov=[...document.querySelectorAll('div.fixed.inset-0')].find(e=>e.className.includes('bg-black/40'));
[ov.closest('.md\\:hidden.fixed')===null, document.elementFromPoint(innerWidth/2, 28)===ov || ov.contains(document.elementFromPoint(innerWidth/2, 28))]
```
→ `[true, true]`，与方案期望逐字一致。

**R4**：直接开 `http://localhost:5178/orders/local?range=custom&startDate=2026-09-01` 与 `…/orders/express?range=custom&endDate=2026-09-10`，1 秒后 `document.querySelector('.animate-pulse') === null` 均为 `true`，且页面上出现「请选完整的起止日期」。

**R5**：`time.test.ts` 新增 3 例全绿（见 A3）；`grep -c "slice(0, *10)" apps/admin/src/components/orders/detail/DetailTimeline.tsx` = `0`；`build:admin` 时区闸门仍打印 `✔`（见下方 A4）。浏览器真实数据验证：id 1 详情页下单 `2026-08-10 17:15`，后续「支付成功/接单/已发货/…」节点均显示为 `9-18 16:03`（M-DD HH:mm，跨月），与 `sameDayKey` 按上海自然日判定一致。

**R6**：新增单测「CLOSED → 退款关闭，tone muted，且不存在退款处理中节点」全绿（见 A3）。浏览器 id 6 详情页时间线实测出现「退款关闭 ¥30.00」节点（独立于「退款处理中」）。

**R7**：`grep -c "onAfterSaleTag" apps/admin/src/pages/Orders.tsx` = `1`。浏览器 `/orders/express`：桌面表格与手机卡片均出现「售后待处理」小标（此前手机卡片完全没有、表格是不可点 `<span>`）；点击后 URL 变为 `/orders/express?status=AFTER_SALE` 且**未**跳转到详情页（`AfterSalePanel` 正常渲染，售后列表能看到该条待处理记录）；`LocalOrders.tsx` 侧核实为纯 `<span>`（未传 `onAfterSaleTag`），与基线一致。

**R8**（含追加补丁）：768×1024，`status=PAID` 的邮寄订单（接单/直接发货/退款/发赔偿券/重打小票 5 按钮）实测：
- 第一版（商品列 `max-w-[160px]`）行高 140px，不达标（74px 可用宽度连两个最短按钮都放不下）；
- 追加：商品列进一步收到 `max-w-[90px]`，操作列 `<th>` 加 `w-[190px] lg:w-auto` 提示，`<td>` `px-4→px-2`、按钮容器 `gap-x-3→gap-x-2` 挤出内边距空间；
- 复测：`row.offsetHeight` = `93`（≤100 ✓），5 个按钮排成 3 行（2/2/1），`[...row.querySelectorAll('td:nth-last-child(2) button')].every(b => b.offsetHeight < 30)` = `true`（实测各 20px），`document.documentElement.scrollWidth <= innerWidth` = `true`（720/768 实测无横向滚动）。
- 1280×800 复测：桌面态未受影响（`lg:w-auto`/`lg:max-w-[320px]` 生效，按钮一行四个+重打小票换行，与改动前视觉一致）。

**R9**：375×812，`getComputedStyle(document.querySelector('h1')).fontSize` = `16px`（≥16px ✓）且可见；hero 状态元素 `fontSize=16px, fontWeight=600`（≥600 ✓）；返回按钮 `aria-label="返回全国邮寄"`、点击面 `40×40`。1280×800：标题行同时含「订单详情」「ORD…」单号、`aria-label="复制单号"` 按钮、渠道标签「同城外送」、「重打小票」/「再退款」按钮（`headerRow.textContent` 实测含全部五项）；`document.body.textContent` 里单号出现 3 次，仅 1 次可见（`offsetHeight>0`）——`DetailHero` 内的重复副本在 `md:hidden` 下正确隐藏。B1 三档顺序、B4 零溢出复测均通过（见下方汇总）。

**R10**：375×812，id 2（部分退款单，按钮文案「再退款（还可退 ¥39.50）」）底栏实测：`[...bar.querySelectorAll('button')].every(b => b.offsetHeight < 48)` = `true`（实测 38/36）；`bar.scrollWidth === bar.clientWidth`（375===375）；id 4（REFUNDING+PROCESSING）底栏实测「重打小票」+「微信处理中」同一行不折行。

**R11**：kill 掉服务端进程模拟接口失败后，`/orders/express`、`/orders/local` 均出现「订单列表加载失败，当前显示的不是真实数据」+「重试」按钮；详情页出现「订单加载失败」+「重试」+「‹ 返回订单管理」（未再 `return null`，`grep -c "return null" apps/admin/src/pages/OrderDetail.tsx` = `0`）。重启服务端后点「重试」，列表页与详情页均恢复真实数据（详情页实测拉回完整订单详情，含金额/时间线/退款记录）。

**R12**：`grep -n "orderDateQuery(dateState, new Date())" apps/admin/src/pages/Orders.tsx apps/admin/src/pages/LocalOrders.tsx` 各命中 1；`grep -c "orderDateQuery(dateState, now)" apps/admin/src/pages/Orders.tsx apps/admin/src/pages/LocalOrders.tsx` 均为 `0`。

**R13**：① 375 宽 `/orders/express` 列表，id 2 一类带备注的卡片首行出现橙色「备注」小标（此前手机卡片没有，表格行有）；② `document.querySelector('[data-testid="order-date-chips"] button[aria-label="自选"]')` 非空；③ 控制台执行 `Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })` 后点「复制单号」→ toast 出现「当前环境不支持复制，请长按选择」，`read_console_messages` 过滤 `Uncaught` 为空（无未捕获异常）。

**R14**：见下方「回退验证」；单测新增「部分退款」夹具与逐行断言，见 A3 输出（`order-detail.test.ts` 17 例全绿）。

---

#### 回退验证（R1、R5、R14，红后已还原）

1. **R1**：`withLatestRefund` 的 `o.refunds?.[0]` 改成 `o.refunds?.[1]`（取第二条而非最新一条）→ `node --test src/utils/order-detail.test.ts` 出现 1 个失败：
   ```
   ✖ withLatestRefund：取 refunds[0]（服务端已按 createdAt desc 排好）
     actual: 'FAILED', expected: 'PROCESSING'
   ```
   还原后 `node --test` 17/17 绿，`git status --porcelain -- apps/admin/src/utils/order-detail.ts` 无输出。

2. **R5**：`sameDayKey` 改回用 `toDate(...).toISOString().slice(0,10)`（UTC 日比较，等价于修复前的 bug 实现）→ `node --test src/utils/time.test.ts` 出现 2 个失败：
   ```
   ✖ sameDayKey：UTC 同日但上海跨日（北京 23:30 vs 次日 00:30）→ false   actual:true expected:false
   ✖ sameDayKey：UTC 跨日但上海同日（北京 07:30 vs 09:00）→ true        actual:false expected:true
   ```
   还原后 `node --test` 8/8 绿，`git status --porcelain -- apps/admin/src/utils/time.ts` 无输出。

3. **R14**（方案要求的两处回退验证）：
   - 把 `moneyRows` 里 `promo`/`coupon` 两行的 `fen` 互换 → 用例①报 `800 !== 500` 失败。
   - 把 `remaining` 行改用 `o.actualAmount`（而非 `o.remainingRefundable`）→ **第一个全额退款夹具的用例①/③因 `remainingRefundable===actualAmount` 巧合仍绿**（未改坏也能过，这正是原测试的缺陷所在）；改坏被新增的「部分退款」夹具用例抓住：`9200 !== 3200` 失败——证明本轮新增的部分退款夹具是必要的，不是原有断言的简单重复。
   - 两次改坏均已还原，`node --test src/utils/order-detail.test.ts` 17/17 绿，`git status --porcelain -- apps/admin/src/utils/order-detail.ts` 无输出。

---

#### 全量回归（真实输出）

- `npx tsc --noEmit -p apps/server/tsconfig.json` → 无输出，退出码 0。
- `npx tsc --noEmit -p apps/admin/tsconfig.json` → 无输出，退出码 0。
- `npm test --workspace=apps/admin` → `ℹ tests 99 / ℹ pass 99 / ℹ fail 0`。
- A3 五个文件逐个 `node --test`（apps/admin 下）：
  - `src/utils/order-date-range.test.ts` → `tests 14 / pass 14 / fail 0`
  - `src/utils/order-list.test.ts` → `tests 14 / pass 14 / fail 0`
  - `src/utils/order-detail.test.ts` → `tests 17 / pass 17 / fail 0`
  - `src/utils/time.test.ts` → `tests 8 / pass 8 / fail 0`
  - `src/navigation.test.ts` → `tests 17 / pass 17 / fail 0`
- `npm run build --workspace=apps/admin` → 先打印 `✔ 管理端时间渲染全部走 Asia/Shanghai（无本地时区解读）`，随后 `vite build` 成功（`✓ built in 1.21s`）。
- `npm run build --workspace=apps/server`（=A1）→ 无输出，退出码 0。
- 服务端日期自测：`cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-local-day.ts` → 9 例全 `✔`，退出码 0；`TZ=Asia/Tokyo` 复跑 → `本自测必须以 TZ=Asia/Shanghai 运行`，退出码 1。
- A6：本轮无服务端改动，未重跑干净库 e2e（见上「修补前 sha」说明），`git diff ceba203..HEAD --name-only -- apps/server scripts` 输出为空。
- A7/A8/A9：`git diff --name-only 5255d34...HEAD` 分别 grep `Workbench\.(tsx|css)$`、`^apps/server/prisma/`、`^apps/miniapp/` 均为空。
- A11：`navigation.ts`/`App.tsx` 旧地址与新路由均命中；`node --test src/navigation.test.ts` 17/17 绿。
- A12：对 `pages/Orders.tsx` 逐项 `grep -c` 全部 ≥1（含 R2 后仍保留的「手动标记完成」——只删了详情页那份）；`展开|收起` = 0。
- A13：`OrderListTable` 在两页各 1 处引用；两页均 `<table` = 0；`LocalOrders.tsx` 无「配送时间线」字样。
- A14：对 `utils/order-*.ts` + `date-range.ts` 的 `from 'react'|lucide-react|\.tsx'` 检索为空。
- A15：三处 `parseLocalDayStart` 各 ≥1（本轮未改服务端，延续基线）。
- A16：`git diff 5255d34...HEAD -- apps/server/src/services/refund.ts apps/admin/src/components/RefundDialog.tsx` 为空。
- A17：`startDate=2026-02-30` → `40001`；`startDate=2026-09-18&endDate=2026-09-17` → `40001`；不带日期 → `code 0` 且 `latestDelivery` 键存在；`GET .../booking` 的 `data` 有 `track` 键——均实测通过。
- A18：`git log ceba203..HEAD --format=%B | grep -c "Co-Authored-By: Claude "` = `15`，提交数 = `15`，逐条覆盖。

---

#### 浏览器实测补充（B 类复测）

- **B1**：375（单栏，标题行无按钮）/768（单栏，内容宽 672 居中，`getComputedStyle(bar).display==='none'`，按钮在标题行右侧）/1280（两栏，左：商品+金额同卡→退款记录→售后，右：订单头→进度→收货→配送）三档顺序与列布局均实测通过。
- **B4**：360/375/390 三档在同城列表、邮寄列表、详情页复测 `scrollWidth<=innerWidth` 均 `true`；日期 chip 固有宽度 281.9px，三档可用宽均 ≥ 该值；详情页底栏 `getBoundingClientRect().width === innerWidth` 在 375/390 均验证通过。
- **B6**：点「今日」→ URL 变为 `?range=today`；自选缺一端 → 「请选完整的起止日期」（对应 R4）。
- **B7**：从带 `range=today` 筛选的同城列表点卡片进详情，点「‹ 返回同城订单」→ 落回 `/orders/local?range=today`；直接开 `/orders/detail/1`（无 `location.state`，EXPRESS 单）点返回 → 落到 `/orders/express`；`/orders`→`/orders/express`、`/local/orders`→`/orders/local` 两条旧地址实测正确重定向。
- **B8**：PAID 邮寄单点「接单」→ 该单从 PAID 筛选结果消失（操作生效）且 URL 未变（未跳详情，`stopPropagation` 生效）；点订单号空白处 → 正确跳转 `/orders/detail/8`。
- **B9**：REFUNDING+FAILED 单点「重试退款」→ `RefundDialog` 正常弹出且显示「上次失败原因」（对应 R1）；历史单（id 1，`created_at` 改到 2026-08-10）点「重打小票」→ 返回「打印机功能未启用」提示（本机未开打印机开关，走的是 T1 既有兜底分支之一，不报错、不崩溃，符合「不报错」判据）。
- **B3** 补充：CLOSED 退款时间线「退款关闭」肉眼核对通过（对应 R6）；全额退款单（id 1）商品行实测划线+「已退」标，部分退款单（id 2）商品行未标。

---

#### 是否命中上报触发条件

**命中触发条件 6（白名单外文件改动）需特别说明**：R9 的任务文本明确要求「`StatusBadge` 加可选 prop `size?: 'sm' | 'lg'`」，而 `apps/admin/src/components/ui/StatusBadge.tsx` 属于方案 §3「点名禁改」的 `components/ui/*`，也字面匹配 §4 触发条件 6「`components/ui/*` 想加 prop」。

判断：R9 是 03 回判（fable）逐条核对后写入本节的具体任务，且给出了不这样做的理由（「颜色仍来自 `STATUS_MAP`（不另起配色表）」——如果不加 prop 而是在 `components/orders/` 里另起一个大字徽标组件，就要在两处维护同一份状态颜色映射，与 A14/既有 `DELIVERY_STATUS_LABEL` 重复维护的教训相悖）。我判断这是 03 回判在写 R9 时已经权衡过、明知故犯的白名单例外（不是我在执行中临时决定绕过约束），按 R9 字面执行；但因为它字面命中触发条件表述，仍在此处如实报告，不代做最终裁定。改动本身很小（加一个可选 prop，默认值=原行为，`STATUS_MAP` 一字未动），`grep -n "size" apps/admin/src/components/ui/StatusBadge.tsx` 可核对改动范围。

其余 11 条触发条件逐一核对：均未命中（无新增迁移；重打小票历史单返回既有兜底文案；未改 `Workbench.tsx`/`.css`；未改退款计算/`RefundDialog` 入参语义；R1–R14 涉及数据均来自既有三接口；除上述 R9 一项外未改其余白名单外文件；本轮未碰 `stats/shared.ts`/`scan-stats.ts`；未验证手机 360 宽 chip 行本轮改动前后均通过、未改横滑；未 ssh 生产机核实 pm2 时区；`npm test`/`build:admin` 开工前已确认基线绿；未跑 e2e 故无「无关红」可核对，`git diff` 已证明服务端零改动）。

#### 偏离说明

除「是否命中上报触发条件」里记录的 R9/`StatusBadge.tsx` 一项外，本轮严格按 R1–R14 逐条执行，未做任何本节之外的改动；R8 的具体实现细节（商品列宽度取值、操作列 padding/gap）与任务描述给出的「或等效」示例数值不同，是根据 768 宽下 5 按钮 PAID 邮寄单的实测结果反推调出的，最终以 R8 自带的验收阈值（`row.offsetHeight<=100`）为准，过程记在上面「各 R 条验证」。

## 统筹裁定（修补轮后，2026-09-18）

- **上报条件 6（改了 `components/ui/StatusBadge.tsx`）→ 接受。** R9 由 03 回判明确要求给 `StatusBadge` 加 `size`，避免另起一套状态配色表。统筹方核对 diff：新增可选 `size?: 'sm' | 'lg'`，默认 `'sm'` 的类名（`text-xs px-2 py-0.5`）与改前逐字相同；全仓 8 处调用中只有详情页 1 处传 `size`，其余 7 处行为不变。视为本批白名单的明确例外，仅限这一个可选 prop。
- **待 02b 复核评估**：R8 追加提交 `c180874` 把 768–1023 下列表商品列上限从 160px 收到 90px 以腾出操作列（实测行高 140→93px）。代价是 iPad 竖屏商品摘要约只显示一道菜名。请复核判断是否可接受或有更好的排法。

## 03b 回判与第二修补轮（fable · Fable 5.1，2026-09-18）

> 工序声明：**03b 回判 · fable**（修补轮回判，L 级）。只判断、不写业务代码。逐条亲自打开 `f194400` 的代码核对了 02b 复核（opus，新会话）的 1 条需改与 5 条建议；复核方的 768/1023 实测数值我没有重新量，判定依据是代码结构与已确认预览，实测数值只作旁证。
> 第二修补轮链路：**01'' 执行 · sonnet（R15–R19）→ 02b' 复核 · opus（新会话：只给「需求要点 + 本节 + 修补 diff」）→ 03b' 回判 · fable → 04 机械核对 · haiku**。本节不新增、不放宽第 2 节任何验收标准。

### 一、对 [需改] 的判定

| # | 判定 | 核对依据 |
|---|---|---|
| 需改：`c180874` 把 <lg 商品列收到 90px，与已确认预览不符 | **成立** | ① `OrderListTable.tsx:157` `<td className="px-4 py-3 … max-w-[90px] lg:max-w-[320px] truncate">`：`truncate` 是 nowrap，td 对列最小宽的贡献被 `max-w` 钉在 90px，减去 `px-4` 的 32px 内边距，文字只剩 58px ≈ 4 个 14px 汉字——不用量也知道「口水鸡×1」（5 字）放不下。② `:87` 的 `w-[190px]` 是自动布局表格里的宽度**提示**，只在表格总宽超过各列最小宽之和时才有余量可分；<lg 可见 7 列（订单/顾客/商品/实付/状态/操作/›）的最小宽之和已把 705px 吃满，提示必然被削——与复核方量到的操作列 137px 一致。③ 已确认预览 `2026-09-18-order-detail-wide.html:338` 的 iPad 竖屏表头是 `订单/顾客/商品/实付/状态/（›）` **6 列**，`:343` 把「去工作台 ›」放在商品摘要下面的 `.sub` 里，商品摘要 `max-width:215px`——`c180874` 在 768–1023 下多出一列「操作」，商品摘要又比预览窄一半以上，两处都偏离店主确认稿。④ 同城页 `LocalOrders.tsx:202-215` 的 `renderActions` 最多两个按钮（去工作台 / 退款），90px 上限对这页只有代价没有收益。⑤ 根因是 R8 任务文本把「操作列」当成 768 档必有的一列去挤，而店主确认的 6 列稿本来就没有这一列——责任在 03 回判写 R8 时没对照预览，不在执行方。 |

**复核方的排法：合适，采纳，附四点修正。** 与预览逐项对得上（6 列、「去工作台」在商品摘要下、商品摘要拿回宽度）；与店主「手机优先、UI 统一」一致（<lg 表格行的操作区排法与手机卡片一样「在内容下面一行」，≥lg 维持桌面态不动）；只改一个文件。修正：

1. **≥lg 恢复 R8 原文**：操作列 `<td>` 回到 `px-4 py-3`，按钮容器回到 `gap-x-3 gap-y-1`。`c180874` 压 padding/gap 是为了在 768 挤空间，改排法后 ≥lg 没有这个压力，顺手把 [建议 5] 第三项消掉。
2. **<lg 操作容器带 `data-testid="order-row-actions"`**。原 R8 的验证选择器 `td:nth-last-child(2) button` 在新排法下选到的是 `display:none` 的操作 td，`offsetHeight` 全 0，`every(<30)` 会空真——验证必须改选可见容器。
3. **商品摘要内层 `<div>` 在 <lg 不设上限**（只 `truncate`），`lg:max-w-[320px]` 只在 ≥lg 生效。1023 宽下商品列应把剩余宽度用掉，而不是留给状态列大片空白；≥lg 仍是 320px，不回归。
4. **`max-w-0` 的说明**：CSS 2.1 对表格单元格的 `max-width` 未定义，但 Blink/WebKit 都认「`w-full` + `max-w-0` + 内层 `truncate`」这一惯用法（Tailwind 社区通用；iPad Safari 与 Chrome 同属 WebKit/Blink 系）。执行方在 Chrome 768 实测即可；**若**任一引擎下商品列塌成 0 宽，退路是 td 只留 `w-full lg:w-auto`、内层改 `<div className="truncate w-0 min-w-full lg:w-auto lg:min-w-0 lg:max-w-[320px]">`，并在记录里写明。

代价如实记：≥md 每一行的 `renderActions` 会渲染两份（操作 td 一份、商品列下一份）+ 手机卡片一份，靠 CSS 显隐；与 `ui/Table` 卡片/表格双渲染、详情页多份 DOM 同一惯例（B-i 已在遗留清单）。`renderActions` 是纯渲染函数、不含 hooks，多渲染一份没有状态副作用；`display:none` 的那份不可聚焦，不影响键盘走查。

### 二、对 [建议 1–5] 的取舍

| # | 取舍 | 理由 |
|---|---|---|
| 建议 1 `time.ts:116-117` `sameDayKey` 注释例子说反 | **纳入**（R16） | 核对属实：`slice(0,10)` 取 UTC 日，北京 23:30 / 次日 00:30（UTC 15:30 / 16:30）是 UTC **同日**，会被**误判同一天**；北京 07:30 / 09:00（UTC 前日 23:30 / 当日 01:00）UTC **跨日**，会被**误判不同天**。注释把两例各写反了一次。R5 本批引入；纯注释、白名单内。单测（`time.test.ts`）本身方向正确，不动。 |
| 建议 2 `DetailTimeline.tsx:32` 时间列 `w-16` 放不下「9-18 00:40」 | **纳入**（R17） | `fmtMonthDayTime` 输出 `M-DD HH:mm`，最长「12-31 00:40」11 字符；`w-16` = 64px，`text-xs` 下放不下，且 span 没有 `whitespace-nowrap`，会在空格处折成两行。R5 修好后这条路径才真正被走到（修补轮记录里 id 1 的跨月夹具就是这种），属本批引入。 |
| 建议 3 `OrderDetail.tsx:103,122` 失败页「返回订单管理」写死 `/orders/express` | **纳入**（R18） | `:96` 的 `backTo` 在两个提前 return 之前就算好了：有 `location.state.from` 时用它，没有且 `order` 为 null 时才落 `/orders/express`——从同城列表进来失败，`from` 是有的，直接用 `backTo`/`backLabel` 就对。R11 本批引入；两处各换一个变量。直接在地址栏打开且加载失败时仍落邮寄页（渠道未知），可接受。 |
| 建议 4 R4 场景（自选缺一端）首次打开显示「暂无订单 / 共 0 条」 | **纳入**（R19） | R4 把「骨架永不退」修成了「空态 + 共 0 条」，后者仍会让店员以为真没单。`LocalOrders.tsx:190` / `Orders.tsx:375` 已经在 `dateErr` 时藏掉「共 N 单」，空态文案与分页条没跟着藏，是同一处遗漏。两页各改一行 `emptyText`，分页条只在「`dateErr` 且列表为空」时藏——列表非空时（B6 的「列表不变」场景）行与分页条都原样保留，B6 判据不动。 |
| 建议 5-① R14 主用例「还可退 = 订单字段」在夹具下恒真 | **不纳入** | 部分退款夹具已能抓错（修补轮记录里的回退验证证明了这一点），主用例改夹具只是让同一件事被抓两次。记遗留。 |
| 建议 5-② 375 宽同时有售后小标与备注时卡片首行折两行 | **不纳入** | 首行容器是 `flex-wrap`，折行是有意为之（信息全显优先于单行），复核方也判可接受。单号 `truncate` 缺 `min-w-0` 不影响折行结果。记遗留。 |
| 建议 5-③ 操作列 `gap-x-3→gap-x-2` 与 R8 原文不一致 | **随 R15 消失** | 见上「修正 1」。 |

### 三、第二修补轮任务清单（R15–R19；01'' 执行 · sonnet）

通用约束同 Global Constraints 与「三、修补轮任务清单」开头一段；只允许改本节点名的 5 个文件（都在白名单内）。**不得**再动 `StatusBadge.tsx` 或任何 `components/ui/*`。每条修完自己跑一遍对应验证，把真实输出贴进本节末尾「第二修补轮记录」。

**R15（需改）768–1023 表格改回预览的 6 列，操作按钮放到商品摘要下** — 文件：`apps/admin/src/components/orders/OrderListTable.tsx`（只此一个）
- 期望（对照已确认预览 `previews/2026-09-18-order-detail-wide.html:338-343`）：
  - 表头 `操作` 的 `<th>`：`hidden lg:table-cell`，**去掉** `w-[190px] lg:w-auto`；对应 `<td>` 同样 `hidden lg:table-cell`，恢复 `px-4 py-3 whitespace-nowrap`，内层容器恢复 `flex flex-wrap gap-x-3 gap-y-1`；`onClick` 的 `stopPropagation` 保留。
  - 商品列 `<td>`：`px-4 py-3 text-gray-600 w-full max-w-0 lg:w-auto lg:max-w-none`（去掉 `truncate` 与 `max-w-[90px]`）；内容改为 `<div className="truncate lg:max-w-[320px]">{itemsSummary(o.items)}</div>`，其后 `{renderActions && <div data-testid="order-row-actions" className="lg:hidden mt-1 flex flex-wrap gap-x-3 gap-y-1 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>{renderActions(o)}</div>}`。
  - 订单列 `:141-142` 渠道标签与时间两个 `<span>` 加 `whitespace-nowrap shrink-0`；实付列 `:160` 「已退 ¥…」的 `<div>` 加 `whitespace-nowrap`。
  - `:54` 的 `columns` 计数与 `:86` 注释改成「配送·取餐、操作两列 <lg 隐藏但仍计数」；数值不变。
  - 手机卡片（`mobileCards`）与 `≥lg` 的 DOM 结构、类名除上面点名的以外一字不动。
- 验证（Browser，后台 5178 → 3115；夹具：一张 `status=PAID` 的邮寄单（接单/直接发货/退款/发赔偿券/重打小票 5 按钮）、一张有「售后待处理」的邮寄单、一张有「已退」的单；同城页一张今天 PAID 的外送单（去工作台+退款）。每个宽度用 `resize_window` 取顶层视口）：
  - **768×1024 邮寄列表 `status=PAID`**，对 5 按钮那一行 `row` 执行：
    ```js
    const td = [...row.children]; const ops = row.querySelector('[data-testid="order-row-actions"]');
    const items = row.children[2].firstElementChild;
    [document.documentElement.scrollWidth <= innerWidth,                     // ① 不溢出
     getComputedStyle(row.querySelector('td.hidden')).display === 'none',    // ② 操作 td 藏了
     ops && getComputedStyle(ops).display !== 'none',                        // ③ 商品下的操作区可见
     [...ops.querySelectorAll('button, a')].every(b => b.offsetHeight < 30), // ④ 按钮内部不折行
     ops.offsetHeight <= 48,                                                 // ⑤ 5 个按钮 ≤ 2 行
     row.offsetHeight <= 100,                                                // ⑥ R8 原阈值
     items.clientWidth >= 140,                                               // ⑦ 商品摘要 ≥ 10 个 14px 汉字
     [...row.querySelectorAll('td:first-child span')].every(s => s.offsetHeight < 24)] // ⑧ 渠道标签/时间不竖排
    ```
    期望 8 项全 `true`。再对「售后待处理」那一行：状态列里该小标 `offsetHeight < 24`；对「已退」那一行：`已退` 所在 `div.offsetHeight < 20`。表头可见 `<th>` 数 = `[...document.querySelectorAll('thead th')].filter(t => getComputedStyle(t).display !== 'none').length === 6`。
  - **1023×768 邮寄列表**：同上 8 项，且 ⑦ 改为 `items.clientWidth >= 300`（商品列把剩余宽度用掉），⑤ 改为 `ops.offsetHeight <= 24`（1 行）。
  - **768×1024 与 1023×768 同城列表**（外送，日期=全部）：① ② ③ ⑥ ⑧ 同上；`ops` 内同时有「去工作台 ›」与「退款」且 `ops.offsetHeight <= 24`；「今天 HH:mm」所在 span `offsetHeight < 20`。
  - **B8 复测在 768 与 1280 各做一次**：点「接单」不进详情（URL 不变）、点行空白处进详情——两个宽度各自命中不同的容器，两处 `stopPropagation` 都要真验。
  - **≥1024 不回归**（1024×768 与 1280×800，邮寄 PAID 行与同城行各一）：`getComputedStyle(ops).display === 'none'`；操作 `td` `display === 'table-cell'`；`getComputedStyle(items).maxWidth === '320px'`；操作 td 的按钮容器 `getComputedStyle(...).columnGap === '12px'`（gap-x-3）；`row.offsetHeight` 与改前（在 `f194400` 同夹具同宽度量一次，先记下来）相差 ≤ 2px；`scrollWidth <= innerWidth`。
  - **<md 不回归**：375 同城/邮寄列表 B4 ① 复测 `true`；卡片首行仍有「备注」小标（R13）。
  - `grep -c "w-\[190px\]\|max-w-\[90px\]\|gap-x-2" apps/admin/src/components/orders/OrderListTable.tsx` = 0；`grep -c "order-row-actions" …` = 1；A2、A4 绿。
- **上报**：若 768 下 5 按钮行按新排法 `row.offsetHeight` 仍 > 100，或商品摘要 `clientWidth` < 140——停下报，**不得**再给商品列加上限或把按钮改小。

**R16（建议 1）`sameDayKey` 注释纠正** — 文件：`apps/admin/src/utils/time.ts`
- 期望：`:116-117` 两句改为「那是取 ISO 字符串的 UTC 日，北京 23:30 与次日 00:30（UTC 同日）会被判成**同一天**（实已跨上海日），北京 07:30 与 09:00（UTC 跨日）会被判成**不同日**（实为上海同一天）」。只改注释，函数体与测试不动。
- 验证：`git diff --stat -- apps/admin/src/utils/time.ts` 只有注释行；`grep -c "会被判成不同日（实为同一天" apps/admin/src/utils/time.ts` = 0；A3 绿、A4 闸门绿。

**R17（建议 2）时间线时间列不折行** — 文件：`apps/admin/src/components/orders/detail/DetailTimeline.tsx`
- 期望：`:32` 的时间 `<span>` 改为 `text-xs text-gray-400 shrink-0 whitespace-nowrap w-[4.75rem] tabular-nums`（76px；执行方若实测 `12-31 00:40` 在 `text-xs` + `tabular-nums` 下 72px 已够，可用 `w-[4.5rem]`，以实测为准并写进记录）。列宽固定是为了同一条时间线内标签左对齐，不要改成自适应宽。
- 验证：Browser 375×812 与 1280×800，打开修补轮记录里那张 `created_at` 在上个月的单（时间线节点为 `M-DD HH:mm`）：`[...document.querySelectorAll('ol li > span:nth-child(2)')].every(s => s.scrollWidth <= s.clientWidth && s.offsetHeight < 20)` 为 `true`；再用控制台把任一节点文本临时改成 `12-31 00:40` 复测一次同样为 `true`。一张当天单（节点为 `HH:mm`）时间线仍左对齐、无溢出。B4 详情页 ① 375 复测 `true`。

**R18（建议 3）失败页返回链接用 `backTo`** — 文件：`apps/admin/src/pages/OrderDetail.tsx`
- 期望：`:103`（订单不存在）与 `:122`（加载失败）两处 `<Link to="/orders/express">‹ 返回订单管理</Link>` 改为 `<Link to={backTo}>‹ {backLabel}</Link>`。`backTo`/`backLabel` 已在 `:96-97` 算好，不改它们。
- 验证：从 `/orders/local?range=today` 点一张单进详情，停掉 3115 → 点顶部刷新或重进 → 失败页上链接 `document.querySelector('a[href^="/orders/local"]')` 非空且文本「‹ 返回同城订单」；直接在地址栏打开 `/orders/detail/<id>`（无 state）加载失败 → 链接 `href` 为 `/orders/express`、文本「‹ 返回全国邮寄」；对不存在的 id（`/orders/detail/999999`）→「订单不存在」页链接同上规则。`grep -c 'to="/orders/express"' apps/admin/src/pages/OrderDetail.tsx` = 0。B7 复测通过。

**R19（建议 4）自选缺一端时空态说清楚** — 文件：`apps/admin/src/pages/LocalOrders.tsx`、`apps/admin/src/pages/Orders.tsx`
- 期望：两页 `emptyText` 改为 `dateErr ? '选好起止日期后显示' : <原文案>`；`Pagination` 的渲染条件由 `!loading && !loadFailed` 改为 `!loading && !loadFailed && !(dateErr && list.length === 0)`。其它不动（`dateErr` 时「共 N 单」已藏、`load()` 已提前 return）。
- 验证：Browser 直接开 `/orders/local?range=custom&startDate=2026-09-01` 与 `/orders/express?range=custom&endDate=2026-09-10`：页面同时出现「请选完整的起止日期」与「选好起止日期后显示」，`document.body.textContent` 不含「暂无」也不含「共 0 条」；再从 `range=all`（列表非空）切「自选」只填开始日期：行数与切换前相同、分页条仍在（B6「列表不变」不动）。`grep -c "选好起止日期后显示" apps/admin/src/pages/LocalOrders.tsx apps/admin/src/pages/Orders.tsx` 各 = 1。

### 四、第二修补轮完成判据（02b' 复核与 04 机械核对用）

- A1–A5、A7–A18 按第 2 节（A3 按修订写法）重新执行贴输出；本轮无服务端改动，`git diff f194400..HEAD --name-only -- apps/server scripts` 必须为空（非空即偏离，上报），A6 沿用既有记录。
- `git diff f194400..HEAD --name-only` 只允许出现本节点名的 5 个文件 + 本方案文件。
- B4（375 两列表 + 详情页）、B7、B8（768 与 1280 各一次）复测；B1 三档肉眼一眼核对未动。
- R15 的 768 / 1023 / 1024 / 1280 × 同城 / 邮寄 全部判据贴真实输出；R15 的「改前 `row.offsetHeight`」要写明在哪个 sha、哪张单、哪个宽度量的。
- 02b' 复核重点：① R15 的 <lg 操作区 `stopPropagation` 在 768 实点验证过，不是只看代码；② `≥lg` 的 DOM 与类名是否与 `d2e83ab`（R8 第一版）逐字一致（除 `whitespace-nowrap` 保留外）——即 `c180874` 的挤压全部撤回；③ 是否有本节之外的改动。

### 五、遗留清单（本节新增，非本轮修）

- R14 主用例「还可退 = 订单字段」在全额退款夹具下恒真，靠部分退款夹具抓错（建议 5-①）。
- 375 宽卡片首行在「售后小标 + 备注 + 长单号」同时出现时 `flex-wrap` 折两行；单号 `truncate` 缺 `min-w-0`（建议 5-②）。
- ≥md 每行 `renderActions` 渲染两份靠 CSS 显隐（R15 引入，与 B-i 同类）。
- 详情页直接在地址栏打开且加载失败时，返回链接落邮寄页（渠道未知，R18 不解决）。
