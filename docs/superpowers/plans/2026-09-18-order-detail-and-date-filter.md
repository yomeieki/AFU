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
| A3 | `npm test --workspace=apps/admin` | 全绿；且输出里出现 `order-date-range.test.ts`、`order-list.test.ts`、`order-detail.test.ts`、`time.test.ts`、`navigation.test.ts` 五个文件名，`# fail 0` |
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
