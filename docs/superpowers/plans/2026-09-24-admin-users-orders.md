# 后台用户管理：订单弹窗直达详情 + 共 N 单/加载更多 + 渠道标签 + 流水/券单号可点 + 累计消费/最近下单（2026-09-24）

【工序】规划 【模型】Fable 5.1 【等级】M

- worktree：`/Users/yumingyi/food-shop/.claude/worktrees/users-orders`（分支 `claude/admin-users-orders`，HEAD `db9c85a` 只比 BASE 多一份预览）
- BASE：`1dbe0102e9a1eee87a0bc5610742d282d6557769`
- 店主已确认的预览：`docs/superpowers/previews/2026-09-24-admin-users-orders.html`（**布局以它为准；渠道标签的颜色不以它为准**，见 §0.2 第 4 条）
- **最终等级：M**（§2.2 第 3 条：既有模块行为调整 + 服务端新增只读字段/汇总）。调查结论：**不命中第 2 条**——零迁移；不碰认证/权限；不碰下单、支付、退款的任何写路径（新增的服务端代码全部是 `findMany/groupBy/$queryRaw` 只读查询）；不改事务/锁/幂等逻辑；`GET /api/admin/users` 默认排序、`hasOrders` 语义、`latestOrder` 口径全部保持不变（e2e §48/§70 依赖）。
- 并行约束：另一会话在改 `apps/server/src/routes/orders.ts`（下单并发死锁，L 级）、另一执行者在改 `apps/admin/src/pages/LowStock.tsx`。本批**不得触碰这两个文件**（已入禁止清单）。

## 0. 调查结论（执行者不必重查；行号按 BASE）

### 0.1 现状与位置

| 条目 | 现状 | 位置 |
|---|---|---|
| 用户列表接口 | 分页 + keyword（昵称/phone/任一订单收货人）+ `hasOrders==='1'`；`orderBy createdAt desc`；本页用户再做 `userCoupon.groupBy` 与 `latestOrderByUserIds`（窗口函数 `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC)`）；响应行 = `{...u, orderCount, availableCoupons, latestOrder}` | `apps/server/src/routes/admin/users.ts:80-151`（select `:98-116`；券数 `:126-133`；`latestOrder :134`；组装 `:136-147`）；窗口函数 `:49-66`（**不得改回嵌套 take:1**） |
| 用户订单接口 | `GET /:id/orders`：select `id/orderNo/status/actualAmount/discountAmount/createdAt/items{productName,quantity,isGift}`，**没有 `deliveryType`**；分页 `readPage`（pageSize 上限 50） | `users.ts:154-183`（select `:163-171`）；`readPage :16-21` |
| 积分流水接口 | 行里 `refType='ORDER'` 时 `refId` = `Order.id` 的字符串；服务端联查补 `orderNo`，**不返回数字 `orderId`** | `users.ts:186-233`（联查 `:210-216`，组装 `:218-229`） |
| 券记录接口 | 行里已有 `orderId`（核销单，数字或 null）与联查出的 `orderNo`；`sourceRef` 是发赔偿券时填的**订单号字符串**，没有对应 id | `users.ts:238-262`（联查 `:254-258`，组装 `:260`） |
| 分页响应壳 | `paginate(res, list, total, page, pageSize)` → `data:{list,total,page,pageSize}`；`success(res, data)` | `apps/server/src/utils/response.ts:3-19` |
| 订单金额列 | `actualAmount`（实付，分）、`refundedAmount`（**已成功**退款累计，分，部分退款多次累加，`== actualAmount` 即全额退完）、`paidAt`（付款成功时刻）、`isTest`、`deliveryType`（`LOCAL/EXPRESS/PICKUP`） | `apps/server/prisma/schema.prisma:227-330`（`refundedAmount :259-260`、`paidAt :252`、`isTest :299`） |
| `paidAt` 何时写 | mock 支付与微信回调两条路都在状态翻成 `PAID` 的同一条 update 里写入，之后从不清空；取消后迟到的付款也会写 `paidAt` 并转 `REFUNDING` 自动全额退 | `apps/server/src/routes/orders.ts` `/:id/pay` 处理器（`:1193` 起，`data: { status: 'PAID', paidAt }`）；`apps/server/src/routes/wechat-notify.ts:213-240,306` |
| `refundedAmount` 何时加 | 只在 `finalizeRefundSuccess`（退款 SUCCESS）里累加；mock 模式下 `initiateRefund` 同步走到 SUCCESS | `apps/server/src/services/refund.ts:298-301,417-` |
| 已付款单能否变 CANCELLED | 不能：后台取消只接受 `PENDING_PAYMENT`（`routes/admin/orders.ts:779-790`），顾客取消同理（`routes/orders.ts:1033` 附近）；付了款的取消一律走退款 → `REFUNDING/REFUNDED` | 同左 |
| 统计口径常量 | `REAL_ORDERS = { isTest: false }`；文件头明令「**新增任何统计查询都必须 spread REAL_ORDERS**」 | `apps/server/src/utils/stats-scope.ts:22` |
| 经营概览的实收/退款 | `revenueFen = Σ actualAmount`（按 `paid_at` 归属、状态不限、排除测试单）；`refundFen = Σ refundedAmount` | `apps/server/src/routes/admin/stats/overview.ts:15-16,36,53`（文件名以 `command grep -rln revenueFen apps/server/src` 为准）；口径说明 `docs/api.md` §3.7 |
| orders 索引 | `[userId, status]`、`[status, createdAt]`、`[status, pointsSettledAt, completedAt]`、`[deliveryType, scheduledAt]`、`[userId, clientRequestId]` 唯一 | `schema.prisma:367-370`；迁移里的名字 `orders_user_id_status_idx` |
| 用户页 | 筛选（keyword/hasOrders/page）全在 React state，**不在 URL**，离开再回来全丢；订单弹窗 `openOrders` 固定 `pageSize: 20` 无翻页；弹窗只有表格没有手机卡片；流水的订单号是「点击复制」按钮；券记录「使用订单」是纯文本 `c.orderNo ?? c.sourceRef ?? '-'` | `apps/admin/src/pages/Users.tsx`：state `:51-85`，`load :87-100`，`openOrders :151-160`，筛选条 `:166-189`，表头 `:198-215`（`columns={9}`），手机卡片 `:216-259`，电脑行 `:261-311`，订单弹窗 `:317-375`，流水单号 `:432-451`，券「使用订单」`:546` |
| 前端类型/接口 | `AdminUser :392-411`、`UserOrder :413-420`、`UserCouponRow :955-977`、`PointsLedgerRow :1043-1059`；`getUsers :195`、`getUserOrders :198`、`getUserPointsLedger :475`、`getUserCoupons :479` | `apps/admin/src/types.ts`、`apps/admin/src/api/admin.ts` |
| 详情页地址与跳转写法 | `orderDetailPath(id) = '/orders/detail/' + id`；列表页 `navigate(orderDetailPath(o.id), { state: { from: location.pathname + location.search } })`；应用用 `BrowserRouter` | `apps/admin/src/navigation.ts:44`；`pages/LocalOrders.tsx:157`、`pages/Orders.tsx:146`；`App.tsx:45` |
| 详情页返回逻辑 | `backTo = location.state?.from ?? backTargetFor(order.deliveryType)`；**`backLabel` 只认两种**：`startsWith('/orders/local')` → 「返回同城订单」，否则「返回全国邮寄」——`from` 指向 `/users` 时会错显「返回全国邮寄」，**本批必改** | `apps/admin/src/pages/OrderDetail.tsx:98-99`；按钮 `:149,:160`；`backTargetFor` 在 `utils/order-detail.ts:30-32`，测试 `utils/order-detail.test.ts:26-33` |
| 修饰键点击 | `isModifiedLinkClick(event)`；用法见 `Layout.tsx:102`、`BusinessCenter.tsx:84`（有修饰键就交还浏览器） | `apps/admin/src/utils/link-click.ts:12-19` |
| 渠道标签 | 纯逻辑 `channelTag(deliveryType) → { label: '外送'/'自取'/'邮寄', tone: 'local'/'pickup'/'express' }`；配色表 `CHANNEL_TONE`（**模块私有**，未导出）`local: 'bg-orange-50 text-orange-700'`、`pickup: 'bg-teal-50 text-teal-700'`、`express: 'bg-blue-50 text-blue-700'`；详情页另一份同色表 `DetailHero.CHANNEL_TONE`（大写键）；工作台 CSS 变量 `--local:#e5441e / --express:#3b5bdb / --pickup:#0e7c6b`（橘红/蓝/青，与上面同一语义） | `apps/admin/src/utils/order-list.ts:22-26`；`components/orders/OrderListTable.tsx:16-20,102,142`；`components/orders/detail/DetailHero.tsx:9-13`；`pages/Workbench.css:4-5`、`Workbench.tsx:58-69` |
| 复制单号 | `copyText(text)`（无 clipboard 时提示「当前环境不支持复制」，成功/失败各有 toast）——`Users.tsx:438-444` 那段内联 clipboard 代码是它的劣化重复 | `apps/admin/src/components/orders/copyText.ts` |
| 时间格式 | `fmtMonthDayTime`（`MM-DD HH:mm`，预览里「09-24 13:10」就是它）、`fmtDateTime`、`fmtDate`；全部钉死 Asia/Shanghai；构建前置闸门 `scripts/check-admin-timezone.mjs` 禁止在 `utils/time.ts` 之外调用本地时区 Date API | `apps/admin/src/utils/time.ts:50,64,78` |
| 弹窗/表格外壳 | `Modal { title: string, width, footer, closeOnOverlay }`；`Table { head, columns, children, mobileCards }`（<md 卡片、≥md 表格） | `components/ui/Modal.tsx:6-14`；`components/ui/Table.tsx:4-20` |
| e2e | 分片在 `scripts/e2e.sh:2008` 处 `source e2e.d/*.sh`（按文件名序），**§39/§48 的 `M2_*`/`M3_*` 变量定义在分片之后**（`:2113+`、`:2286+`），分片里用不到；既有 `70-user-list-lookup.sh` 覆盖 keyword/hasOrders/latestOrder；§48（`e2e.sh:2286-2381`）覆盖列表两列、流水、券；`74-low-stock.sh` 是当前最大编号 | `scripts/e2e.sh`、`scripts/e2e.d/` |
| e2e 造数原语 | mock 登录 `POST /api/auth/wechat-login {code}` → `data.token/userId`；地址 `POST /api/addresses`；加购 `POST /api/cart`、下单 `POST /api/orders {cartItemIds, addressId, deliveryType:'EXPRESS'}` → `data.orderId/orderNo/actualAmount`；mock 支付 `POST /api/orders/:id/pay` → `data.mode=='mock'`；顾客取消 `PUT /api/orders/:id/cancel`；后台退款 `POST /api/admin/orders/:id/refund {amount, reason}`（`amount` 正整数分，mock 下同步 SUCCESS）；剩余可退 `GET /api/admin/orders/:id` → `data.remainingRefundable`；标测试单 `PATCH /api/admin/orders/:id/test-flag {"isTest":true}`；直连 SQL `sql "…"`；中文 keyword 必须 percent-encode（`70-user-list-lookup.sh` 的 `urlenc`） | `scripts/e2e.d/70-user-list-lookup.sh:24-38`；`scripts/e2e.sh:1409,1723,2270-2275` |
| API 文档 | §3.6「用户管理」只写了 `GET /admin/users` 与 `GET /admin/users/:id/orders`（后者一句「参数同订单列表」）；附录表 `:1432-1435`、`:1643-1644` | `docs/api.md:920-975` |
| 既有闸门 | admin `build` = `node ../../scripts/check-admin-timezone.mjs && tsc && vite build`；admin `test` = `node --test src/*.test.ts src/utils/*.test.ts`（纯逻辑文件不许 import `.tsx`）；server `build` = `tsc`；服务端没有单元测试框架，契约靠 e2e；无 CI、无 husky；`deploy.sh` 在生产机跑 `npm run build:admin` | `apps/admin/package.json`、`apps/server/package.json`、`scripts/deploy.sh:145,253` |
| 范围检查脚本 | `.agent/` 下只有 `agent-protocol.md`，**`high-risk.txt`/`check-scope.sh` 不存在**（编排者交付报告须写「未运行范围检查」） | `ls .agent` |
| 基线（本 worktree 实跑） | `TZ=Asia/Shanghai npx tsc --noEmit -p apps/server` → exit 0；`cd apps/admin && npx tsc --noEmit` → exit 0；`npm test --workspace=apps/admin` → 162 pass / 0 fail | — |
| node_modules | worktree 无私有 `node_modules`，Node 向上解析到主仓 `/Users/yumingyi/food-shop/node_modules`；零迁移，**不要 `prisma generate`** | — |

### 0.2 本批的口径决定（纯技术/仓库规则范围内，规划者已定；不进「待用户决定」）

1. **累计消费 `spendFen`**（店主定的口径的精确化）：
   `spendFen(user) = Σ over orders where user_id = user AND paid_at IS NOT NULL AND is_test = FALSE of (actual_amount − refunded_amount)`；没有符合条件的单 → `0`。
   - 「已付款」用 `paid_at IS NOT NULL` 而不是 `status`：付款成功那一刻两条路径都写 `paidAt` 且永不清空（§0.1），之后状态怎么走（备餐/发货/完成/退款中/已退款）都仍是「付过款的单」；未付款（`PENDING_PAYMENT`）与未付款取消（`CANCELLED`）`paid_at` 恒为 NULL，天然不算。付了款的单不可能变 `CANCELLED`（§0.1）。
   - 「减去已退款金额」用 `refunded_amount`：它只在退款 **SUCCESS** 时累加，就是「实退」；部分退款多次累加；退款在途（`REFUNDING`、Refund 行 `PENDING/PROCESSING/ABNORMAL`）期间**不扣**，退成功那一刻才扣——与店主「按实退扣除」一致，也与经营概览「实收 − 退款」同口径（§0.1 的 `revenueFen − refundFen`，均按 `paid_at` 归属、排除测试单）。
   - 取消后迟到付款的单：`paidAt` 有值、状态 `REFUNDING`、系统自动全额退；退成功前短暂计入全额，退成功后计 0。与经营概览行为一致，可接受。
   - 排除测试单（`is_test = TRUE`）：`utils/stats-scope.ts` 文件头是仓库硬规则（「新增任何统计查询都必须 spread REAL_ORDERS」），累计消费是金额统计，必须遵守。**`orderCount` 与 `latestOrder` 保持现状（含测试单、含任何状态）**，本批不动它们的口径——同一行里「订单数 3 / 累计消费 ¥0.00」对测试账号是正常现象，`docs/api.md` 要写明。
2. **最近下单 `latestOrderAt`** = 既有 `latestOrder.createdAt`（该用户 `createdAt` 最新的一张单，**不排除任何状态**，含未付款/已取消/测试单），**不新增字段、不新增查询**，前端直接取 `u.latestOrder?.createdAt`。理由：
   - 这一列回答的是「这个人最近还来没来」，未付款单同样是「来过」；店主把它和「订单数」（任一状态都算）、同一行已有的「最近一单收货人 · 日期」放在一起看，三者必须是同一张单，否则一行里会出现两个不同的「最近」。
   - 「只算已付款」需要再跑一条带 `paid_at IS NOT NULL` 的窗口函数（或改现有那条并破坏 §70 ⑦/⑫ 钉住的「不排状态」契约），成本与风险都不值。
   - 若店主日后要「最近成交」，是加一列不是改这列——留作建议。
3. **排序**：`GET /api/admin/users?sort=spend` → 按 `spendFen` 降序，并列按 `createdAt desc, id desc`（与默认序同向，保证稳定）。`sort` 只认字面量 `spend`；不传/传别的值 = 现状（`createdAt desc`），与 `hasOrders` 只认 `'1'` 同一风格。只做降序（店主只要「从高到低」）。
4. **渠道标签的文案与颜色**：文案按店主原话与已确认预览——`LOCAL→同城`、`PICKUP→自取`、`EXPRESS→邮寄`；**颜色不用预览里的蓝/紫/绿**，用后台既有的渠道色语义（订单列表、详情页、工作台三处一致：同城=橘/橙、邮寄=蓝、自取=青），即 `OrderListTable.tsx:16-20` 那张 `CHANNEL_TONE`——把它从组件私有提升为 `utils/order-list.ts` 导出的常量，`OrderListTable` 改为 import，**不得出现第三份配色表**。
5. **返回后自动重开弹窗的机制**：用户页的全部筛选状态迁到 URL 查询参数（`useSearchParams`，`replace: true`，与 `LocalOrders.tsx:60-64,120-135` 同款）；订单弹窗打开 = URL 带 `orders=<userId>`。`from = location.pathname + location.search` 于是自带 `orders=<id>`，详情页「返回」就落回带参数的 `/users`，用户页据此重开弹窗；刷新页面同样重开。参数定义见 §实现方向 5。
6. **重开弹窗时怎么拿到用户行**：新增只读端点 `GET /api/admin/users/:id`（响应 = 列表里同一行的形状，含 `orderCount/availableCoupons/latestOrder/spendFen`）。不从列表里找的原因：列表按 `createdAt desc` 分页，详情页停留期间新注册一个用户就会把目标用户挤到下一页，「按 URL 重开」必须不依赖当前页有没有这一行。
7. 头像「U」与「最近登录 -」保持现状（店主已定）。

### 0.3 `sort=spend` 的查询形态与性能依据

- 累计消费的批量计算只有一种实现（两条路径共用）：

  ```ts
  // users.ts 新增，紧挨 latestOrderByUserIds
  async function spendByUserIds(userIds: number[]): Promise<Map<number, number>> {
    if (userIds.length === 0) return new Map()
    const rows = await prisma.order.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, paidAt: { not: null }, ...REAL_ORDERS },
      _sum: { actualAmount: true, refundedAmount: true },
    })
    return new Map(rows.map((r) => [r.userId, (r._sum.actualAmount ?? 0) - (r._sum.refundedAmount ?? 0)]))
  }
  ```

  对应 SQL：`SELECT user_id, SUM(actual_amount), SUM(refunded_amount) FROM orders WHERE user_id IN (…) AND paid_at IS NOT NULL AND is_test = FALSE GROUP BY user_id`。`user_id IN (…)` + `GROUP BY user_id` 走 `orders_user_id_status_idx`（前导列 `user_id`）做 range + 分组，`paid_at/is_test` 回表过滤。
- **默认排序路径**（不传 `sort`）：现有两条查询一字不改，只在拿到本页 20 个 id 后**多一次** `spendByUserIds(本页 id)`——与既有 `userCoupon.groupBy`、`latestOrderByUserIds` 同一模式，成本恒定（一页 ≤50 个 id）。
- **`sort=spend` 路径**：Prisma 的 `where`（keyword OR / hasOrders）是唯一真值，不在原生 SQL 里复制一份（复制就会和 §70 钉住的匹配规则分叉）。做法：
  1. `prisma.user.findMany({ where, select: { id: true, createdAt: true } })` —— 命中的**全部**用户，只取两列；
  2. `spendByUserIds(全部 id)`；
  3. Node 内排序：`spend desc → createdAt desc → id desc`；`total = 命中数`；切出本页 id；
  4. `prisma.user.findMany({ where: { id: { in: 本页 id } }, select: <与默认路径完全相同的 select> })`，按第 3 步的顺序回排（用 Map，不要 `find`）。
  之后两条路径汇合到同一段「装饰」代码（券数 / latestOrder / spend）。
  - 内存与耗时上界：第 1 步每行 `{id, createdAt}` ≈ 16 字节；这家店是单店小程序，用户数以千计，1 万用户也只有 160 KB、排序毫秒级；第 2 步的 `IN` 列表长度 = 用户数，MySQL 对上万项的 IN 无压力（`max_allowed_packet` 默认 64MB）。2026-09-22 在本机 MySQL 8.0.46 用 6 万单/大客户 2 万单压过 `latestOrderByUserIds` 的窗口函数也只 30ms（记忆 `admin-users-customer-lookup-2026-09-22`），本 groupBy 比它便宜。**不建新索引、不动 schema。**
- 不采用的做法：原生 SQL 一把梭（要复制 keyword 的三路 OR，且 `orders: { some: … }` 的语义要手写 EXISTS，两处口径一旦分叉 §70 也抓不到）；Prisma `orderBy: { orders: { _sum } }`（Prisma 5.22 不支持按关系聚合排序）。

### 0.4 三处「链接进详情 + 复制」的数据来源

| 位置 | 已有 | 缺 | 本批服务端补（只读） |
|---|---|---|---|
| 订单弹窗行 | `id`、`orderNo` | `deliveryType` | `GET /:id/orders` select 加 `deliveryType: true` |
| 积分流水「关联」 | `orderNo`（联查）、`refId`（字符串） | 数字 `orderId` | 行加 `orderId: number \| null`——`refType==='ORDER'` 且联查命中时为该 `Order.id`，其余 `null`（联查没命中 = 订单已不存在，不能拿 `Number(refId)` 硬凑一个跳过去 404） |
| 券记录「使用订单」 | `orderId`（核销单）、`orderNo`、`sourceRef`（赔偿针对的单号，字符串） | `sourceRef` 对应的 id | 行加 `sourceRefOrderId: number \| null`——`sourceRef` 非空时按 `orderNo` 联查一次（一次 `findMany({ where: { orderNo: { in } } })`，不逐行） |

## 验收标准

所有命令在 worktree 根目录跑；服务端命令加 `TZ=Asia/Shanghai`；`grep` 用 `command grep`。每条命令要在报告里给出原始输出（过长截尾，保留失败部分与汇总）。

1. 【服务端类型】`TZ=Asia/Shanghai npx tsc --noEmit -p apps/server` → exit 0、无输出。
2. 【后台类型】`cd apps/admin && npx tsc --noEmit` → exit 0、无输出。
3. 【后台单测】`npm test --workspace=apps/admin` → 全部 pass、0 fail，且**必须包含**下列新用例（缺一条算未完成）：
   - `src/utils/users-query.test.ts`：`readUsersQuery`——空参数 → `{ kw: '', hasOrders: true, page: 1, sort: 'created', ordersUserId: null }`；`hasOrders=0` → `false`，`hasOrders=1`/缺省 → `true`；`page=abc`/`page=0`/`page=-2` → `1`，`page=3` → `3`；`sort=spend` → `'spend'`，`sort=xyz`/缺省 → `'created'`；`orders=12` → `12`，`orders=0`/`orders=x`/缺省 → `null`；`kw` 去首尾空白。`writeUsersQuery`——默认值**不落 URL**（`hasOrders=true`、`page=1`、`sort='created'`、`kw=''`、`ordersUserId=null` 都删键）；非默认值落键；不认识的既有键原样保留。
   - `src/utils/order-detail.test.ts` 追加 `backLabelFor`：`'/users?kw=x&orders=5'` → `'返回用户管理'`；`'/orders/local?status=PAID'` → `'返回同城订单'`；`'/orders/express'`、`'/somewhere'` → `'返回全国邮寄'`。既有 `backTargetFor/channelLabel` 断言不动。
   - `src/utils/order-list.test.ts` 追加：`CHANNEL_TONE_CLASS` 三个键 `local/pickup/express` 都是非空字符串且分别含 `orange`/`teal`/`blue`；`userOrderChannel('LOCAL')` → `{ label: '同城', cls: CHANNEL_TONE_CLASS.local }`，`'PICKUP'` → 自取/pickup，`'EXPRESS'` → 邮寄/express，未知值按 LOCAL 处理（与 `channelTag` 的兜底一致）。
   - `src/utils/money.test.ts`：`fmtYuanGrouped(0)` → `'¥0.00'`；`108640` → `'¥1,086.40'`；`123456789` → `'¥1,234,567.89'`；`5` → `'¥0.05'`；`-5` → `'-¥0.05'`。
4. 【后台构建（含时区闸门）】`npm run build --workspace=apps/admin` → 依次通过 `check-admin-timezone.mjs`、`tsc`、`vite build`，exit 0。
5. 【e2e 新分片 + §48 增补】新增 `scripts/e2e.d/75-user-spend-and-orders.sh`（75 是当前下一个空号；合并时若已被占用，改成下一个空号并在「偏离方案」写明），并在 `scripts/e2e.sh` §48 追加两条断言（见第 6 条）。分片**不能单跑**（依赖 `e2e.sh` 的 helper），验收是第 7 条全量跑里这一段全绿。分片必须覆盖下面的**金额口径构造**（变量一律 `U75_` 前缀；`PID` 用 e2e 主体的 `$PID`，下单走 `EXPRESS`；每张单 1 件同一商品，同一分钟内建，实付相等——用 `assert_eq "前置：各单实付相等"` 钉住，不相等就是前置失败，报告里要能看出来）：

   | 用户 | 单 | 操作顺序 | `actual`（分） | `refunded` | 计入累计 |
   |---|---|---|---|---|---|
   | U | O3 | 下单 → 支付 | P | 0 | **P** |
   | U | O4 | 下单 → 支付 → `refund {amount:1}` | P | 1 | **P−1** |
   | U | O5 | 下单 → 支付 → `refund {amount: remainingRefundable}`（全额） | P | P | 0 |
   | U | O6 | 下单 → 支付 → `test-flag {isTest:true}` | P | 0 | 0（测试单） |
   | U | O2 | 下单 → 顾客取消（未付） | P | 0 | 0 |
   | U | O1 | 下单，**最后建、不付款**（段末再取消） | P | 0 | 0 |
   | V | OV | 下单 → 支付 | P | 0 | **P** |
   | W | — | 无订单；`sql UPDATE users SET nickname='U75客<TAG>W'` 让 keyword 能搜到 | — | — | 0 |

   U、V 的收货人姓名分别为 `U75客<TAG>U`、`U75客<TAG>V`，`keyword=U75客<TAG>`（percent-encode）恰好命中 U、V、W 三人。创建顺序 U → V → W。**期望**：
   - `spendFen(U) = 2P − 1`；`spendFen(V) = P`；`spendFen(W) = 0`；`orderCount(U) = 6`。
   - 前置钉住：`sql SELECT refunded_amount FROM orders WHERE id=O4` = `1`；`O5` 的 `refunded_amount = actual_amount`；`O6` 的 `is_test = 1`；`O1` 状态 `PENDING_PAYMENT`、`O2` 状态 `CANCELLED`。
   - `GET /api/admin/users?keyword=…`（默认序）→ `list[].id` = `[W, V, U]`，`total = 3`，每行都有 `spendFen` 键，值分别 `0 / P / 2P−1`。
   - `GET …?keyword=…&sort=spend` → `[U, V, W]`，`total = 3`。
   - `GET …?keyword=…&sort=spend&hasOrders=1` → `[U, V]`，`total = 2`。
   - `GET …?keyword=…&sort=spend&pageSize=1&page=2` → `[V]`，`total = 3`；`page=3` → `[W]`；`page=4` → `[]`。
   - `GET …?keyword=…&sort=bogus` → 与默认序完全相同 `[W, V, U]`。
   - U 行的 `latestOrder.orderNo = O1.orderNo`、`latestOrder.status = 'PENDING_PAYMENT'`（最近下单不要求已付款）。
   - `GET /api/admin/users/<U>` → `code 0`；`data.id = U`、`data.spendFen = 2P−1`、`data.orderCount = 6`、`data.latestOrder.orderNo = O1.orderNo`、`data` 含 `availableCoupons`、`pointsBalance` 键。`GET /api/admin/users/99999999` → `40401`；`GET /api/admin/users/abc` → `40001`。
   - `GET /api/admin/users/<U>/orders` → `total = 6`，每行 `has("deliveryType")` 且值 `EXPRESS`；`?pageSize=2&page=3` → 2 行；`?pageSize=2&page=4` → 0 行（「加载更多」到底的契约）。
   - 段末 `PUT /api/orders/<O1>/cancel`（顾客 token）收尾，别留待付款单。
6. 【§48 增补】`scripts/e2e.sh` §48：在既有 `M3_LEDGER_ORDER` 断言（`:2336-2337`）后追加 `assert_eq "流水：ORDER 行带数字 orderId = Order.id" "$(jq -r '.orderId' <<<"$M3_LEDGER_ORDER")" "$M2_ORF"`；在既有 `M3_ADMIN_VIEW` 三条断言（`:2377-2379`）后追加 `assert_eq "券记录：sourceRef 对应的 sourceRefOrderId = Order.id" "$(jq -r '.sourceRefOrderId' <<<"$M3_ADMIN_VIEW")" "$M2_ORF"`（这张券是用 `orderNo=$M3_ORDNO` 发的，`$M3_ORDNO` 就是 `$M2_ORF` 的单号，`:2342`）。**只加这两行，不改 §48 任何既有断言。**
7. 【干净库全量 e2e】按「环境」一节建 `food_shop_uo` 库、起本批 API（`SCHEDULER_DISABLED=true`、`TZ=Asia/Shanghai`、`ORDER_NOTIFY_WECOM_WEBHOOK= ORDER_NOTIFY_PUSHPLUS_TOKEN= SYSTEM_ALERT_WECOM_WEBHOOK= SYSTEM_ALERT_PUSHPLUS_TOKEN=` 置空），`TZ=Asia/Shanghai BASE=http://localhost:<port> DB_NAME=food_shop_uo bash scripts/e2e.sh` → **0 fail**（已知偶发：`e2e.d/42` B4-1 并发领券、`e2e.d/45` 打印机 4 条依赖顺序——出现时重跑一次仍红才算失败，报告写明是哪条）。§48、§70、新 75 段必须全绿。
8. 【人工检查·后台页面】本地起 API + admin dev（代理到本批端口），先用脚本给一个用户造 ≥25 张单（含同城/自取/邮寄至少两种渠道；`.env` 有同城/自取设置时直接下单，没有就用 `sql UPDATE orders SET delivery_type=… WHERE id IN (…)` 改几张单的渠道——只在本批私有库里改），截图存 `docs/superpowers/notes/2026-09-24-admin-users-orders-acceptance/`（只放 PNG；文件名 `desk-*` / `375-*`）。逐条判定：
   - `desk-list.png`：列表有「累计消费」「最近下单」两列，位置在「订单数」右侧；至少三行金额不同、格式 `¥1,086.40`；最近下单是 `MM-DD HH:mm`；没下过单的用户显示 `¥0.00` 与 `-`。
   - `desk-list-sorted.png`：点「累计消费」表头 → 行按金额降序、表头有降序指示、地址栏出现 `sort=spend`、页码回到 1；再点一次恢复默认序且 `sort` 从地址栏消失。
   - `desk-modal.png`：某用户订单弹窗，标题 `<名字> 的订单 · 共 N 单`（N ≥ 21），每行订单号后有渠道小标签（≥2 种颜色可见），鼠标悬停行整行高亮、行尾有 `›`；底部有「加载更多」。
   - `desk-modal-more.png`：点「加载更多」后行数 > 20、按钮在全部加载完后消失；≤20 单的用户弹窗**没有**该按钮（另截 `desk-modal-short.png`）。
   - `desk-detail-back.png`：从弹窗任一行点进详情，详情页左上返回文案是「返回用户管理」；`Cmd/Ctrl+点击`同一行在新标签打开详情（报告写明实测结果，不必截图）。
   - `desk-return.png`：先在用户页设置好「关键词=某尾号、取消勾选只看下过单的、翻到第 2 页、按累计消费排序」四个条件再打开弹窗进详情；点「返回」后：四个条件原样保留（地址栏可见 `kw=…&hasOrders=0&page=2&sort=spend&orders=<id>`），弹窗自动重开、显示的是同一个用户。
   - `desk-refresh.png`：在上述地址直接刷新（F5）→ 弹窗仍自动重开；把地址里的 `orders=` 改成 `99999999` 刷新 → 弹窗不开、出一条「用户不存在」提示、地址栏该参数被清掉。
   - `desk-ledger.png` / `desk-coupons.png`：积分明细「关联」列的订单号是链接（点进详情、返回文案「返回用户管理」），旁边有小「复制」按钮（点后 toast 已复制）；券记录「使用订单」同样处理；没有对应 id 的（如联查不到的 `sourceRef`）显示纯文本 + 复制按钮，不是链接。
   - `375-list.png`：手机卡片第二行含 `累计 ¥x` 与 `最近下单 MM-DD HH:mm`；筛选条上有「按累计消费排序」开关，开后卡片顺序按金额降序。
   - `375-modal.png`：弹窗是一张张卡片（金额 + 渠道标签 + 状态 / 商品 · 时间 / 右侧 `›`），整卡可点，底部「加载更多」；`375-return.png`：详情返回后弹窗自动重开；页面无横向滚动。
9. 【既有测试是否要放开】**无**。核对过的依赖点：`navigation.test.ts:19-20`（`orderDetailPath` 不变）、`order-detail.test.ts:26-33`（`backTargetFor` 不变，只追加）、`user-label.test.ts`（不变）、e2e §48 `:2295-2312` 的翻页找人依赖**默认序 createdAt desc**（不变）、§70 ⑪ 每行 `latestOrder` 键（不变）、§70 ⑦/⑫ latestOrder 不排状态（不变）。执行中若发现必须改动任何一条既有断言 → 触发上报条件，不得自行放宽。
10. 【文档】`docs/api.md` §3.6：`GET /admin/users` 增 `sort=spend` 参数与 `spendFen` 字段（写清 §0.2 第 1 条的口径与「测试单不计、orderCount 仍计」）；新增 `GET /admin/users/:id` 小节；`GET /admin/users/:id/orders` 把「参数同订单列表」改成真实的字段清单（含 `deliveryType`）；`points-ledger` 行增 `orderId`；`coupons` 行增 `sourceRefOrderId`。附录表 `:1432`/`:1643` 各补一行。`docs/staff-guide.md:404-406` 「用户管理怎么找人」段落后追加 2–3 句：累计消费怎么算、最近下单含未付款单、点订单行可进详情。人工检查：`command grep -n "spendFen\|sourceRefOrderId\|GET /api/admin/users/:id" docs/api.md` 三者都命中。

## 实现方向

预计涉及的文件是估计，执行者可在授权范围内调整；行号按 BASE。

1. **服务端 `apps/server/src/routes/admin/users.ts`**
   - import `REAL_ORDERS`（`../../utils/stats-scope`）。
   - 新增 `spendByUserIds(userIds)`（§0.3 的形态，放在 `latestOrderByUserIds` 之后），注释写清口径（paid_at 非空、is_test=false、actual − refunded）与「为什么不排状态」。
   - 把列表的 `select`（`:98-116`）抽成模块常量 `USER_LIST_SELECT`，把 `:126-143` 的装饰逻辑抽成 `async function decorateUsers(list): Promise<AdminUserRow[]>`（券数 groupBy、`latestOrderByUserIds`、`spendByUserIds` 三个批量查询 + 组装 `{...u, orderCount, availableCoupons, latestOrder, spendFen}`），列表与新端点共用。**`latestOrderByUserIds` 一字不改。**
   - `GET /`：读 `sort = req.query.sort === 'spend' ? 'spend' : 'created'`。`created` 路径保持现有 `$transaction([findMany, count])` 原样；`spend` 路径按 §0.3 四步；两路都把本页 `list` 交给 `decorateUsers` 后 `paginate`。`spend` 路径里第 2 步算过的 Map 直接传给 `decorateUsers`（加一个可选参数 `spendPrecomputed?: Map`），别再算一遍。
   - 新增 `GET /:id`（放在 `/:id/orders` **之前或之后都行**，Express 按完整段匹配，`/:id` 不会吞掉 `/:id/orders`）：`requireUser(req)` → `findUnique({ where: { id }, select: USER_LIST_SELECT })` → `decorateUsers([u])[0]` → `success`。
   - `GET /:id/orders`（`:163-171`）select 加 `deliveryType: true`。
   - `GET /:id/points-ledger`（`:218-229`）行加 `orderId: r.refType === 'ORDER' && orderNoById.has(Number(r.refId)) ? Number(r.refId) : null`（联查结果已在 `orderNoById`，不加查询）。
   - `GET /:id/coupons`（`:254-260`）：收集 `sourceRef` 非空的单号 `[...new Set(list.map(c => c.sourceRef).filter(Boolean))]`，一次 `order.findMany({ where: { orderNo: { in } }, select: { id, orderNo } })`，行加 `sourceRefOrderId`。可以和既有按 `orderId` 的联查合并成一条 `findMany({ where: { OR: [{ id: { in } }, { orderNo: { in } }] } })`，两条也行，别逐行查。
2. **后台类型与 API 客户端**：`apps/admin/src/types.ts` `AdminUser` 加 `spendFen: number`（注释写口径）；`UserOrder` 加 `deliveryType: string`；`PointsLedgerRow` 加 `orderId: number | null`；`UserCouponRow` 加 `sourceRefOrderId: number | null`。`apps/admin/src/api/admin.ts`：`getUsers` 参数加 `sort?: 'spend'`；新增 `getUser(id)` → `client.get<ApiResponse<AdminUser>>('/admin/users/' + id).then(r => r.data.data)`。
3. **纯逻辑工具（都配 `node --test` 用例，不得 import `.tsx`）**
   - `apps/admin/src/utils/users-query.ts`：`UsersQuery { kw: string; hasOrders: boolean; page: number; sort: 'created' | 'spend'; ordersUserId: number | null }`；`readUsersQuery(params: URLSearchParams)`、`writeUsersQuery(params, patch: Partial<UsersQuery>)`（默认值删键，返回新 `URLSearchParams`）。键名：`kw`、`hasOrders`（只写 `0`）、`page`、`sort`、`orders`。
   - `apps/admin/src/utils/order-detail.ts`：加 `backLabelFor(backTo: string)`（§验收 3）。`OrderDetail.tsx:99` 改为 `const backLabel = backLabelFor(backTo)`，其余不动。
   - `apps/admin/src/utils/order-list.ts`：把 `OrderListTable.tsx:16-20` 的 `CHANNEL_TONE` 搬过来导出为 `CHANNEL_TONE_CLASS`（内容逐字不变），`OrderListTable.tsx` 改成 import（`:102/:142` 两处用法不变）；加 `userOrderChannel(deliveryType) → { label: '同城'|'自取'|'邮寄'; cls: string }`（tone 复用 `channelTag`）。
   - `apps/admin/src/utils/money.ts`：`fmtYuanGrouped(fen: number): string`（千分位 + 两位小数 + `¥` 前缀；负数 `-¥`）。不用 `toLocaleString`（`utils/time.ts:19` 的理由同样适用：各浏览器分隔符不一致）。
4. **`apps/admin/src/pages/Users.tsx`：筛选状态迁 URL**
   - `useSearchParams` + `readUsersQuery`；`keyword` 输入框保留一个「草稿」state（初值来自 `kw`），点「搜索」才写 `kw` 并 `page` 归 1；勾选框直接写 `hasOrders`（并 `page` 归 1）；分页写 `page`；排序写 `sort`（并 `page` 归 1）。所有写入 `setSearchParams(prev => writeUsersQuery(new URLSearchParams(prev), patch), { replace: true })`。
   - `load` 的 effect 依赖改成 `[kw, hasOrders, page, sort]`；`getUsers` 传 `sort: sort === 'spend' ? 'spend' : undefined`。
   - 删掉 `handleHasOrdersChange` 那段关于 effect 顺序的注释与实现（状态源变了，注释也就不成立了）。
5. **`Users.tsx`：订单弹窗**
   - 打开来源两种：① 行内「订单」按钮 → `setOrdersModal(u)` + 写 `orders=u.id`；② URL 变化（挂载或返回/刷新）→ `useEffect` 依赖 `ordersUserId`：非空且 `ordersModal?.id !== ordersUserId` 时 `getUser(id)` 成功 → `setOrdersModal(row)`；`40401`/失败 → `toast.error('用户不存在')` + 清掉 `orders` 参数。关闭弹窗（关闭按钮/遮罩/Esc/页脚按钮）→ `setOrdersModal(null)` + 清 `orders` 参数。
   - 弹窗数据：`ordersPage`、`ordersTotal`、`userOrders`（追加式）、`ordersMoreLoading`。首屏 `page=1,pageSize=20`；「加载更多」按钮只在 `userOrders.length < ordersTotal` 时渲染，点了取 `page+1` 追加，失败 toast 且保留已加载行；≤20 单永不出现按钮。标题：`Modal` 的 `title` 类型放宽为 `ReactNode`（`components/ui/Modal.tsx:7`，其余调用方传字符串照旧可编译），内容 `<名字> 的订单 <small>共 N 单</small>`，N 用 `ordersTotal`，首屏未到之前不显示 `共 … 单`。
   - 行/卡片：整行 `onClick`——`isModifiedLinkClick(e)` 为真 → `window.open(orderDetailPath(o.id), '_blank', 'noopener')`；否则 `navigate(orderDetailPath(o.id), { state: { from: location.pathname + location.search } })`（此时 `location.search` 已含 `orders=<id>`）。行 `className` 加 `cursor-pointer hover:bg-brand-50`（与预览的浅橙一致），末列 `›`（`lucide-react` 的 `ChevronRight`，同 `OrderListTable`）。订单号后紧跟 `<span className={\`text-xs px-1.5 py-0.5 rounded ${cls}\`}>{label}</span>`（`userOrderChannel`）。
   - 手机（<md）：表格 `hidden md:block`，卡片列表 `md:hidden`，卡片布局按预览（第一行 `¥金额 渠道 状态`，第二行 `商品摘要 · MM-DD HH:mm`，右侧 `›`）；商品摘要复用既有 `items.map(…).join('、')` 或 `utils/order-list.ts` 的 `itemsSummary`。
6. **`Users.tsx`：流水/券的订单号**
   - 流水「关联」列：`r.orderNo` 存在时——`r.orderId` 非空 → `<Link to={orderDetailPath(r.orderId)} state={{ from: location.pathname + location.search }} className="font-mono text-blue-500 hover:text-blue-700">{r.orderNo}</Link>`；为空 → `<span className="font-mono text-gray-700">{r.orderNo}</span>`；两种后面都跟一个小按钮（`Copy` 图标，`aria-label="复制订单号"`，`onClick={() => copyText(r.orderNo)}`）。删掉 `:434-447` 那段内联 clipboard 代码，改用 `components/orders/copyText.ts`。
   - 券记录「使用订单」：显示值仍是 `c.orderNo ?? c.sourceRef ?? '-'`；对应 id 取 `c.orderNo ? c.orderId : c.sourceRefOrderId`；有 id → `Link`，否则纯文本；有显示值就配复制按钮。
   - `<Link>` 自带修饰键行为（react-router 只接管无修饰键的左键），不用额外处理。
7. **`Users.tsx`：列表两列 + 排序**
   - 表头 `columns` 9 → 11；在「订单数」之后插「累计消费」「最近下单」两列（右对齐）；「累计消费」表头是 `<button type="button" aria-sort=…>`，`sort==='spend'` 时显示降序图标（`lucide-react` `ArrowDown`）并加粗；点击在 `spend` 与默认之间切换。
   - 单元格：`fmtYuanGrouped(u.spendFen)`；`fmtMonthDayTime(u.latestOrder?.createdAt, '-')`。
   - 手机卡片第二行改成 `手机号 · 订单 N · 累计 ¥x`，下一行 `最近下单 MM-DD HH:mm · 注册 YYYY-MM-DD`（预览结构）；筛选条加一个 `md:hidden` 的开关「按累计消费排序」（`checkbox` 或胶囊按钮），与表头按钮驱动同一个 `sort` 参数。
8. **`apps/admin/src/pages/OrderDetail.tsx`**：只改 `:99` 一行（用 `backLabelFor`）。不动其余逻辑。
9. **e2e**：新分片 `scripts/e2e.d/75-user-spend-and-orders.sh`（结构参照 `70-user-list-lookup.sh`：自带 `u75_enc/u75_addr/u75_order` helper，别依赖 70 里定义的函数；每条断言给中文描述），`scripts/e2e.sh` §48 加两行（验收 6）。
10. **文档**：`docs/api.md` §3.6 与附录两张表、`docs/staff-guide.md:404-406`（验收 10）。
11. **顺序建议**：1 → 2 → 3（配测试）→ 9（先把契约钉住，跑 e2e 看服务端）→ 4/5/6/7/8 → 10 → 全量验收。每完成一层跑一次对应闸门。

## 授权范围

```
apps/server/src/routes/admin/users.ts
apps/admin/src/pages/Users.tsx
apps/admin/src/pages/OrderDetail.tsx
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/utils/users-query.ts
apps/admin/src/utils/users-query.test.ts
apps/admin/src/utils/order-detail.ts
apps/admin/src/utils/order-detail.test.ts
apps/admin/src/utils/order-list.ts
apps/admin/src/utils/order-list.test.ts
apps/admin/src/utils/money.ts
apps/admin/src/utils/money.test.ts
apps/admin/src/components/orders/OrderListTable.tsx
apps/admin/src/components/ui/Modal.tsx
scripts/e2e.d/75-user-spend-and-orders.sh
scripts/e2e.sh
docs/api.md
docs/staff-guide.md
docs/superpowers/notes/2026-09-24-admin-users-orders-acceptance/**
docs/superpowers/plans/2026-09-24-admin-users-orders.md
```

限定：
- `OrderListTable.tsx` 只允许「删私有 `CHANNEL_TONE` → import `CHANNEL_TONE_CLASS`」，不改任何渲染。
- `Modal.tsx` 只允许把 `title` 放宽为 `ReactNode`（或新增可选 `subtitle`），不改交互。
- `scripts/e2e.sh` 只允许在 §48 追加验收 6 的两行。
- `OrderDetail.tsx` 只允许改 `backLabel` 那一行的取值。
- 若 e2e 分片编号 75 已被占用，允许改用下一个空号（文件名相应变化）。

## 禁止修改

```
apps/server/src/routes/orders.ts
apps/admin/src/pages/LowStock.tsx
apps/server/src/services/refund.ts
apps/server/src/services/refund-reconcile.ts
apps/server/src/services/wechat-pay*.ts
apps/server/src/routes/wechat-notify.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/after-sales.ts
apps/server/src/routes/admin/pay-mock.ts
apps/server/src/routes/auth.ts
apps/server/src/routes/admin/auth.ts
apps/server/src/middlewares/**
apps/server/src/utils/stats-scope.ts
apps/server/src/utils/response.ts
apps/server/prisma/**
apps/miniapp/**
tools/miniapp-preview/**
apps/admin/src/navigation.ts
apps/admin/src/navigation.test.ts
apps/admin/src/utils/link-click.ts
apps/admin/src/utils/user-label.ts
apps/admin/src/utils/user-label.test.ts
apps/admin/src/utils/time.ts
apps/admin/src/components/orders/detail/**
apps/admin/src/pages/Workbench.tsx
apps/admin/src/pages/Workbench.css
apps/admin/src/pages/LocalOrders.tsx
apps/admin/src/pages/Orders.tsx
scripts/e2e.d/70-user-list-lookup.sh
scripts/e2e.d/74-low-stock.sh
scripts/deploy.sh
scripts/check-*.mjs
.claude/**
.agent/**
docs/superpowers/previews/**
**/package.json
**/package-lock.json
**/.env*
```

## 上报条件

执行者遇到以下任一情形，停下受影响部分并在「上报」栏写明：

- 需要改动禁止清单里的文件，尤其 `routes/orders.ts`（另一会话在改）、`LowStock.tsx`（另一执行者在改）、任何支付/退款写路径、prisma schema/迁移、小程序。
- 需要改变 `GET /api/admin/users` 的**默认排序**、`hasOrders` 的判定、`latestOrder` 的口径或 `latestOrderByUserIds` 的实现（e2e §48/§70 依赖）。
- 需要改动任何既有测试断言或 e2e 既有断言（验收 9 列的那些以及其他）。
- 在本机库/e2e 里发现任何 `status ∉ {PENDING_PAYMENT, CANCELLED}` 但 `paid_at IS NULL` 的订单（口径前提不成立），或发现 `refunded_amount > actual_amount` 的行。
- `sort=spend` 路径在 e2e 库上单次请求超过 1 秒，或需要新建索引/迁移才能达标。
- 实现「返回后自动重开弹窗」时发现 `OrderDetail.tsx` 除 `backLabel` 外还必须改别处（如返回按钮改成 `navigate(-1)`）。
- 需要新增 npm 依赖、改 `package.json`、`prisma generate`、`npm install`。
- e2e 全量出现 §48/§70/新分片之外的红且重跑仍红（先按记忆 `e2e-fresh-db-recipe` 的已知偶发排除）。

## 待用户决定

无。

## 环境（给执行者）

- 本机 JST，服务端自测/e2e 必须 `TZ=Asia/Shanghai`；`grep` 是 ugrep 别名用 `command grep`；无 `timeout` 命令；worktree 不 `npm install`、不 `prisma generate`（零迁移，主仓 client 即可）；不裸 `git stash`；不 ssh/scp 生产机；不合并不部署。本机多会话在跑同名服务端：**只杀自己记下 PID 的进程，禁止 `pkill`/`killall` 按模式杀**；起服务前 `export` 环境变量并确认 `DATABASE_URL` 指向自己的私有库。
- worktree 里有 `apps/server/.env`（gitignored），dotenv 不覆盖已存在的环境变量，所以下面用前缀覆盖即可；空字符串也算「已设置」，通知变量置空有效。
- 私有库与端口：库名 `food_shop_uo`；API 端口用 **3145**（规划时 `lsof` 看到 3140/5000/5202/31862 已被占用，3100/3106 常被别的会话占），admin dev 端口 **5145**。
- 干净库配方（记忆 `e2e-fresh-db-recipe`）：
  1. `docker exec -i food-shop-mysql mysql -uroot -pfoodshop_root_password -e "DROP DATABASE IF EXISTS food_shop_uo; CREATE DATABASE food_shop_uo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON food_shop_uo.* TO 'foodshop_user'@'%'; FLUSH PRIVILEGES;"`
  2. `cd apps/server && DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_uo" npx prisma migrate deploy && DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_uo" npx prisma db seed`
  3. 起 API（后台运行并记下 PID）：`cd apps/server && TZ=Asia/Shanghai PORT=3145 DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_uo" WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true SCHEDULER_DISABLED=true ORDER_NOTIFY_WECOM_WEBHOOK= ORDER_NOTIFY_PUSHPLUS_TOKEN= SYSTEM_ALERT_WECOM_WEBHOOK= SYSTEM_ALERT_PUSHPLUS_TOKEN= JWT_SECRET=<≥16 位> ADMIN_JWT_SECRET=<≥16 位> npx ts-node-dev --transpile-only src/app.ts`（`.env` 里已有的密钥可不重复传；`curl localhost:3145/health` 看到 `db: ok` 再往下）。
  4. `TZ=Asia/Shanghai BASE=http://localhost:3145 DB_NAME=food_shop_uo bash scripts/e2e.sh`（全量约 10 分钟；`DB_NAME` 必须与库名一致，否则 `sql()` 静默打到别的库）。
- 后台人工检查：`cd apps/admin && VITE_PROXY_TARGET=http://localhost:3145 npm run dev -- --port 5145 --strictPort`（不要改 `.claude/launch.json`，在禁止清单里）。375 宽用浏览器工具的 mobile 预设截图。
- 给一个用户造 25+ 张单：写在 scratchpad 的临时 shell 循环（复用 e2e 的 `req/u75_order` 写法：登录 → 建地址 → 循环加购+下单+支付），不进仓库。
- 收尾：只 kill 自己记下的 API/admin dev PID；私有库可留着不删。

---

## 修订 1（2026-09-24，M 级复核 R1/R2 阻断项；R3/R4/R5/R7 顺手纳入；R6/R8 判定）

【工序】规划 【模型】Fable 5.1 【等级】M（维持——修订不触及 §2.2 第 2 条：仍零迁移、只读查询、不碰支付/退款写路径）

复核对象 HEAD `cec0678`。以下行号按 `cec0678`。

### R1-0 亲自核实（§3.2）

| 项 | 核实方式 | 结果 |
|---|---|---|
| R1 无过期保护 | 读 `apps/admin/src/pages/Users.tsx:195-205`（`loadUserOrders` 的 `.then` 无条件 `setOrdersTotal`/`setUserOrders`）、`:224-243`（重开 effect 的 `.then` 无条件 `setOrdersModal(row)`）、`:206-213`（`openOrders` 不作废在途请求）、`:535`（加载更多用 `ordersModal.id` 发请求但结果不校验） | **成立**。三条乱序路径（a 加载更多晚到、b `getUser` 晚到、c 首页晚到）都会把别人的结果写进当前弹窗；c 在 BASE 已存在，本批把「加载更多」加进来后 a 的后果更重（`ordersTotal` 被改写、列表混入他人订单）。 |
| R2 布局回退 | 本机起 `food_shop_uo`（4 个有单用户，1 人 25 单三种渠道）+ admin dev，浏览器 1024/1280/1440 实测 DOM；再把 `Users.tsx` 临时换成 BASE 版同法测量后原样恢复（`git checkout --`，`cmp` 与 HEAD 一致） | **成立**。HEAD：1024 → 表头 `th` 高 **84**（三行）、状态胶囊高 **38**（「正/常」两行）、行高 85；1280 → `th` 64（两行）、胶囊 38、行高 77；1440 → `th` 44、胶囊 38（仍折）。BASE：1024 → `th` 64、胶囊 38、行高 77（BASE 在 1024 本来就折）；**1280 → `th` 44、胶囊 18、行高 61（单行）**。即 1280 从单行退成两行、1024 从两行退成三行。我的数据下 1024 表宽 = 容器宽（976，按钮完整可见，右缘 −16px）；复核者的数据下表宽 999 > 961 把「券记录」裁掉——两种数据形态都算回退，修法必须两种都覆盖。弹窗（1280）：渠道标签 `span` 高 **39**（两行），订单号后被挤到下一行；状态胶囊 20（正常）。 |
| R3 错误一律「用户不存在」 | `Users.tsx:238-241` `.catch` 不分错误码 | 成立，纳入 |
| R4 排序无 id 兜底 / 追加不去重 | `apps/server/src/routes/admin/users.ts:249` `orderBy: { createdAt: 'desc' }`；`Users.tsx:200` `[...prev, ...list]` 无去重 | 成立，纳入 |
| R5 `StatusBadge` 未传 `deliveryType` | `Users.tsx:498,:522` | 成立，纳入（`StatusBadge.tsx:30-35` 只有传 `PICKUP` 才显示「待取餐/已取餐」） |
| R7 格式 | `utils/time.ts:78` `fmtMonthDayTime` 是 `M-DD HH:mm`；方案与预览写的 `MM-DD` 是规划笔误 | 成立，纳入（改成日期，见 R1-7） |
| R8 截图证据 | `docs/superpowers/notes/2026-09-24-admin-users-orders-acceptance/` 16 张 PNG，浏览器工具截图天然没有地址栏 | 成立，改验收方式（见 R1-8） |

### R1-1 [R1 阻断] 订单弹窗的请求过期保护——纯状态机 + 函数式更新

**做法**：把弹窗的全部状态收进一个对象，所有网络响应都带着「发出时的会话号 `seq`」回来，通过纯函数合并；`seq` 不等于当前会话号的响应**原样返回旧 state**（同一引用），React 不重渲。会话号由组件里一个 `useRef` 计数器生成（每次打开/关闭/按 URL 重开都 `+1`），纯函数只比较数字，不依赖 React。

新文件 `apps/admin/src/utils/user-orders-session.ts`（纯逻辑，不 import `.tsx`）：

- `interface OrdersSession<U, O extends { id: number }> { seq: number; user: U | null; list: O[]; total: number; page: number }`；`user === null` = 弹窗不渲染（关闭或「按 URL 重开、用户行还没回来」）。
- `initialSession`：`{ seq: 0, user: null, list: [], total: 0, page: 0 }`。
- `openSession(s, seq, user: U | null)`：返回 `{ seq, user, list: [], total: 0, page: 0 }`（`user` 传 `null` 表示按 URL 重开、等 `getUser`）。
- `closeSession(s, seq)`：返回 `{ seq, user: null, list: [], total: 0, page: 0 }`。
- `applyUserLoaded(s, { seq, user })`：`seq !== s.seq` → 返回 `s`；否则 `{ ...s, user }`。
- `applyOrdersPage(s, { seq, page, list, total })`：`seq !== s.seq` → 返回 `s`；`page === 1` → `list` 整体替换；否则追加并**按 `id` 去重**（已存在的跳过，保持原顺序）；`total`、`page` 以响应为准。
- `nextSeq` 不放这里——组件用 `useRef(0)`，`const seq = ++seqRef.current`。

组件（`Users.tsx`）改法：

- `const [session, setSession] = useState<OrdersSession<AdminUser, UserOrder>>(initialSession)`，`ordersModal` 即 `session.user`，`userOrders/ordersTotal/ordersPage` 即 `session.list/total/page`。原来的 `ordersLoading`/`ordersMoreLoading`/`ordersFailed` 三个瞬时标记**也并进 `OrdersSession`**（`loading: 'idle' | 'first' | 'more'`、`failed: boolean`），由 `openSession`（置 `loading:'first'`）、加载更多的发起（`beginMore(s, seq)` 置 `'more'`）、`applyOrdersPage`（置 `'idle'`）、`applyOrdersError(s, { seq, page })`（`page === 1` → `failed: true`，否则只复位 `loading`）统一处理——全部经纯函数判 `seq`。不要把它们留成独立 state 再在 `.then` 里靠「updater 是否同步执行」判断有没有被丢弃，React 18 不保证 updater 同步跑。
- 行内「订单」按钮：`const seq = ++seqRef.current; setSession(s => openSession(s, seq, u)); 写 URL; loadUserOrders(u.id, 1, seq)`。
- 关闭：`const seq = ++seqRef.current; setSession(s => closeSession(s, seq)); 清 URL`。
- 重开 effect（依赖 `ordersUserId`）：`null` → 若 `session.user` 非空则按关闭处理；否则若 `session.user?.id === ordersUserId` 直接返回；否则 `const seq = ++seqRef.current; setSession(s => openSession(s, seq, null)); getUser(id).then(row => { setSession(s => applyUserLoaded(s, { seq, user: row })); loadUserOrders(id, 1, seq) }).catch(按 R1-3 分流)`。
- `loadUserOrders(userId, page, seq)`：响应 `.then(res => setSession(s => applyOrdersPage(s, { seq, page, list, total })))`，`.catch(() => setSession(s => applyOrdersError(s, { seq, page })))`。「加载更多」按钮传当前 `session.seq`。
- 行点击/详情跳转逻辑不变。

**测试** `apps/admin/src/utils/user-orders-session.test.ts`（每条都要写成「调用序列 → 断言」，用 `assert.equal(next, prev)` 断言「被丢弃 = 同一引用」）：

- a）加载更多晚到：`open(A, seq1)` → `page(seq1, p1, [a1..a20], 25)` → 关闭 `close(seq2)` → `open(B, seq3)` → `page(seq3, p1, [b1], 1)` → **`page(seq1, p2, [a21..a25], 25)` → 返回同一引用；`list` 仍 `[b1]`、`total` 仍 1**。
- b）`getUser` 晚到：`open(null, seq1)`（按 URL 重开 7）→ `open(B, seq2)`（点了 B 的按钮）→ **`applyUserLoaded({ seq: 1, user: 7 })` → 同一引用，`user` 仍是 B**。
- c）首页晚到（BASE 既有）：`open(A, seq1)` → `open(B, seq2)` → **`page(seq1, p1, A 列表)` → 丢弃** → `page(seq2, p1, B 列表)` → 应用。
- d）关闭后晚到：`open(A, seq1)` → `close(seq2)` → `page(seq1, p1, …)` → 丢弃，`user` 仍 `null`、`list` 仍 `[]`。
- e）追加去重：`page(seq, p1, [1,2,3], 5)` → `page(seq, p2, [3,4,5], 5)` → `list` id 为 `[1,2,3,4,5]`（3 只出现一次，顺序不变），`page = 2`。
- f）错误：`open(A, seq1)` → `applyOrdersError({ seq: 1, page: 1 })` → `failed = true`；`applyOrdersError({ seq: 0, page: 2 })` → 同一引用。

**改坏验证**（执行者在报告里给出原始输出）：把 `applyOrdersPage`/`applyUserLoaded` 里的 `if (seq !== s.seq) return s` 临时删掉跑一次 `npm test --workspace=apps/admin` → a/b/c/d 必红；恢复后必绿。

**人工检查**（进 R1-8 的截图清单）：浏览器 DevTools 把网络节流到 3G（或用「阻止请求 → 放行」的方式）复现复核者的 a) 场景——A 弹窗点「加载更多」未返回时关掉、开 B——B 弹窗标题仍是 B 的「共 N 单」、行数 = B 的单数、没有 A 的订单号。

### R1-2 [R2 阻断] 列合并方案（1024/1280/1440 单行；375 不动；不删信息、不横向裁切）

目标列（≥md 表格，共 **9** 列，`columns={9}`）：

| # | 表头 | 单元格内容 | 说明 |
|---|---|---|---|
| 1 | 用户 | 头像 + 显示名（不变） | |
| 2 | 手机号 | 第一行号码（`whitespace-nowrap`）；第二行原有 `text-xs`「最近一单收货人 · 2026-09-24」（允许它自己换行，这是本来就有的两行结构） | 不变 |
| 3 | 订单数 | 数字（`whitespace-nowrap`） | |
| 4 | 累计消费（可点排序，同现状） | `¥1,086.40`（`whitespace-nowrap`） | 表头按钮 `whitespace-nowrap` |
| 5 | 最近下单 | `YYYY-MM-DD`（见 R1-7），`whitespace-nowrap` | |
| 6 | **积分/券**（新合并列） | 第一行积分数字；第二行 `text-xs text-gray-500`「可用券 N」 | 原「积分」「可用券」两列合一，信息不丢 |
| 7 | 状态 | 胶囊加 `whitespace-nowrap` | |
| 8 | **登录/注册**（新合并列） | 第一行 `fmtDateTime(lastLoginAt, '-')`；第二行 `text-xs text-gray-500`「注册 YYYY-MM-DD」 | 原「最近登录」「注册时间」两列合一 |
| 9 | 操作 | 四个按钮不变；容器改成 `flex flex-wrap justify-end gap-x-3 gap-y-1`，并在 `<xl`（1024–1279）限制宽度让它自然折成 2×2（例如 `max-w-[7.5rem] xl:max-w-none ml-auto`），`≥xl` 单行 | 按钮全部可见可点；不引入横向滚动 |

其它硬要求：所有 `th` 加 `whitespace-nowrap`；两列合并后手机卡片（<md）**不变**（卡片本来就分行显示这些信息）。宽度预算（1024 容器 961–976）：用户 ~96 + 手机号 ~122 + 订单数 ~60 + 累计消费 ~102 + 最近下单 ~107 + 积分/券 ~92 + 状态 ~72 + 登录/注册 ~144 + 操作(2×2) ~130 ≈ 925 ≤ 961；1280（容器 1232）操作单行 222 时 ≈ 1017 ≤ 1232。若实测超预算，先缩 `px-4 → px-3`（仅 `lg:` 以下），再上报。

弹窗（≥md 表格）：订单号 `span` 与渠道标签都加 `whitespace-nowrap`，且两者放在同一个 `inline-flex items-center gap-1.5` 容器里（保证同一行）；「下单时间」列 `whitespace-nowrap`；「商品」列是唯一允许换行的列。<md 卡片不变。

**验收（DOM 实测，三档各跑一次，输出 JSON 原文贴进报告并存 `measurements.md`）**：在 `/users`（默认筛选，≥4 行且含「最近一单收货人」小字的行）运行：

```js
(() => { const t=document.querySelector('table'); const card=t.closest('.overflow-hidden'); const cr=card.getBoundingClientRect();
  const rows=[...t.querySelectorAll('tbody tr')]; const ths=[...t.querySelectorAll('thead th')];
  const badge=r=>[...r.querySelectorAll('span')].find(s=>/^(正常|禁用)$/.test(s.innerText.trim()));
  return { vw: innerWidth, tableW: Math.round(t.getBoundingClientRect().width), containerW: Math.round(cr.width),
    thH: ths.map(th=>Math.round(th.getBoundingClientRect().height)),
    rowH: rows.map(r=>Math.round(r.getBoundingClientRect().height)),
    badgeH: rows.map(r=>Math.round(badge(r).getBoundingClientRect().height)),
    btns: rows.map(r=>[...r.querySelectorAll('td:last-child button')].map(b=>({t:b.innerText, h:Math.round(b.getBoundingClientRect().height), over:Math.round(b.getBoundingClientRect().right-cr.right)}))),
    scrollX: document.documentElement.scrollWidth - innerWidth } })()
```

判定（三档都要满足）：`tableW ≤ containerW`；每个 `thH ≤ 44`（单行）；每个 `badgeH ≤ 20`；每个按钮 `h ≤ 24` 且 `over ≤ 0`；`scrollX ≤ 0`；`rowH`：1280/1440 每行 ≤ 62（与 BASE 1280 的 61 同级），1024 每行 ≤ 70（操作 2×2 允许多一行按钮）。**与 BASE 对照**：BASE 1280 = `th 44 / 胶囊 18 / 行 61`，修后 1280 不得劣于它；BASE 1024 = `th 64 / 胶囊 38 / 行 77`，修后 1024 必须优于它（`th ≤ 44`、胶囊 ≤ 20）。

弹窗在 1280 打开 25 单用户后运行：

```js
(() => { const h=[...document.querySelectorAll('h3')].find(h=>h.innerText.includes('的订单')); const modal=h.closest('.bg-white'); const mt=modal.querySelector('table');
  const rows=[...mt.querySelectorAll('tbody tr')];
  return { modalW: Math.round(modal.clientWidth), tableW: Math.round(mt.getBoundingClientRect().width),
    tag: rows.map(r=>{const no=r.querySelector('td:first-child span.font-mono'); const tg=r.querySelector('td:first-child span.rounded'); return {h:Math.round(tg.getBoundingClientRect().height), dTop:Math.round(tg.getBoundingClientRect().top-no.getBoundingClientRect().top)}}),
    rowH: rows.map(r=>Math.round(r.getBoundingClientRect().height)) } })()
```

判定：`tableW ≤ modalW`；每个 `tag.h ≤ 20` 且 `|dTop| ≤ 4`（与订单号同一行）。375：`document.documentElement.scrollWidth ≤ 375`，卡片仍显示「累计 ¥x」与「最近下单」。

### R1-3 [R3] 按 URL 重开时的错误分流

`getUser` 的 `.catch(err)`：`err.response?.data?.code === 40401`（或 HTTP 404）→ `toast.error('用户不存在')` + 清 `orders` 参数 + `closeSession`；其它（网络错误、5xx、超时）→ `toast.error('用户加载失败，请刷新重试')`，**保留** `orders` 参数、`closeSession`（弹窗不开，刷新会重试）。两种都必须过 `seq` 校验（`seq !== seqRef.current` 直接返回，不弹 toast）。人工检查：地址栏 `orders=99999999` → 「用户不存在」且参数被清；把 API 停掉后刷新带 `orders=<有效 id>` 的地址 → 「用户加载失败」且参数仍在。

### R1-4 [R4] 订单列表排序兜底 + 追加去重

- 服务端 `users.ts:249`：`orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]`（与 `latestOrderByUserIds` 的窗口排序同序）。
- 前端去重已由 R1-1 的 `applyOrdersPage` 覆盖（测试 e）。弹窗打开期间新下的单会把分页整体后移，可能重复一行——去重后不再出现重复 key；漏行（同毫秒两单）由 id 兜底消除。

### R1-5 [R5] 自取单状态文案

`Users.tsx:498,:522` 改为 `<StatusBadge status={o.status} deliveryType={o.deliveryType} />`。人工检查：25 单用户弹窗里 `PICKUP` 单的「已发货」显示为「待取餐」（或「已取餐」）。

### R1-6 [R6 规划缺口] 积分明细/券记录弹窗返回后不重开——本批不做，留后

判定：**不做**。理由：店主原话与确认范围只要求「订单弹窗」重开；流水/券记录里的单号链接是次要路径（「查这一单为什么给了这些分/用了哪张券」），点进详情通常是一次性核对；把两个弹窗（含流水页码、券页签）也入 URL 会把刚定下的 `orders=` 参数契约扩成 `orders|ledger|coupons + 页码 + 页签` 三套互斥参数，本批再改会拖大复核面。留后条目（交编排者登记）：新增 `ledger=<id>&lp=<page>`、`coupons=<id>&ct=<tab>`，三者互斥，重开逻辑复用 R1-1 的会话状态机（给每个弹窗各一份 `seq`）。当前行为（返回后弹窗关闭、列表筛选保留）在 `docs/staff-guide.md` 的那段里加半句说明「从积分明细/券记录点单号进详情，返回后需重新点开明细」。

### R1-7 [R7] 「最近下单」格式改为 `YYYY-MM-DD`

表格与手机卡片都改用 `fmtDate(u.latestOrder?.createdAt, '-')`（`utils/time.ts:64`，同一行「注册时间」已是这个格式），不显示时分。理由：这一列回答的是「多久没来了」，跨年必须看得出年份；`M-DD HH:mm` 是工作台「今天前后几天」的紧凑格式，不适合客户名单；日期比 `YYYY-MM-DD HH:mm` 省 ~40px，1024 的宽度预算靠它。方案正文与预览里的 `MM-DD HH:mm` 以本条为准；e2e 与服务端不受影响。

### R1-8 [R8] 截图证据方式

- 截图目录允许放一份 `measurements.md`（本节两个 DOM 脚本在 1024/1280/1440 的 JSON 原文、375 的 `scrollWidth`、每张 PNG 对应的 `location.href`——用 `javascript_tool` 取 `location.href` 记录，浏览器截图没有地址栏不算缺陷）。
- 重新截取全部 PNG（旧的 16 张删除重拍，文件名沿用方案验收 8 的清单，另加 `desk-1024-list.png`、`desk-1280-list.png`、`desk-modal-race.png`（R1-1 人工检查）、`desk-refresh-apidown.png`（R1-3））。同名文件字节相同视为未重拍。

### 验收增补（在原验收 1–10 之上追加；原 3 的用例清单加一行）

11. 【单测】`npm test --workspace=apps/admin` 必须含 `src/utils/user-orders-session.test.ts` 的 a–f 六条；改坏验证（删掉 `seq` 校验）a/b/c/d 必红，输出贴报告。
12. 【服务端类型】原验收 1 重跑（`orderBy` 数组形式）。
13. 【DOM 实测】R1-2 两个脚本在 1024/1280/1440 的输出满足判定；375 `scrollWidth ≤ 375`；输出存 `measurements.md`。
14. 【人工】R1-1（乱序复现修复）、R1-3（两种错误分流）、R1-5（自取文案）各一张截图 + `location.href`。
15. 【e2e】原验收 5/7 重跑（服务端只改了 `orderBy`，75 段与 §48 增补应原样绿）。
16. 【文档】`docs/api.md` `GET /admin/users/:id/orders` 一句补「按 createdAt desc, id desc」；`docs/staff-guide.md` 那段补 R1-6 的半句与「最近下单显示日期」。

### 授权范围增减

新增：

```
apps/admin/src/utils/user-orders-session.ts
apps/admin/src/utils/user-orders-session.test.ts
```

原有 `docs/superpowers/notes/2026-09-24-admin-users-orders-acceptance/**` 的「只放 PNG」放宽为「PNG + `measurements.md`」。其余授权范围与禁止修改**不变**（`components/ui/StatusBadge.tsx`、`utils/time.ts` 仍不动——R1-5/R1-7 只改调用处）。

### 上报条件增补

- R1-2 按上表合并后任一档仍 `tableW > containerW` 或 `th`/胶囊仍折行，且缩 `px-3` 也不够——停下上报，不得自行删列或改成横向滚动。
- 实现 R1-1 时发现必须把 `Modal`/`Table` 组件改成受控时序（如加 `key` 强制重挂）才能收口——上报，不得改 `components/ui/Table.tsx`。
- `applyOrdersPage` 的去重导致 e2e 75 段「`pageSize=2&page=3` 返回 2 行」的契约需要改——上报（契约是服务端的，去重只在前端）。

### 待用户决定

无。

---

## 修订 2（2026-09-24，裁决：修订 1 的 1024 档 `rowH ≤ 70` 门槛）

【工序】裁决 【模型】Fable 5.1 【等级】M

### A1：1024 档 `rowH=77 > 70` —— **成立（规划缺口：门槛数字漏算，目标须达成）**

依据：
- `apps/admin/src/pages/Users.tsx:423-431`（HEAD `7ec4e12`）手机号列第二行 `<div className="text-xs text-gray-400">最近一单收货人 · {fmtDate(u.latestOrder.createdAt)}</div>` 无 nowrap；`:437` 「最近下单」列是 `fmtDate(u.latestOrder?.createdAt, '-')`——**同一行、同一个值**。手机卡片 `:384` 与 `:388` 同样两处都显示这个日期。
- `measurements.md` §1：1024 → `th` 全 44、胶囊 19、按钮 `over` 全负、`tableW = containerW = 976`、`rowH` 77；1280/1440 → `rowH` 61。行高算式：`py-3` 24 + 号码行 20 + 小字两行 2×16 = 76–77，与修订 1 R1-0 我实测的 BASE 1024 行高 77（同一段小字、同样折成两行）一致；操作列 2×2 只有 44px，积分/券、登录/注册 36px，都不是限制因素。
- 修订 1 的 `≤ 70` 是按「操作 2×2 是最高单元格（20+4+20+24=68）」推出来的，漏算了手机号小字在 1024 列宽下需要两行——门槛数字是规划错误；但 R2 的目标（1024/1280 单行、次要信息最多叠两行）没有错，而且这一格**可以零信息损失地收成单行**：小字里的日期与同一行「最近下单」列完全重复。

处理（修订后的方案条目，执行者照做；不删信息、不引入横向裁切）：

1. `Users.tsx:428`（电脑表格）小字改为 `最近一单收货人`（去掉 ` · 日期`），并加 `whitespace-nowrap`；日期信息由同一行「最近下单」列承载（值相同）。
2. `Users.tsx:388`（手机卡片）同样改为 `最近一单收货人`——卡片下一行 `:384` 已显示「最近下单 YYYY-MM-DD」，同一个值不重复两次。
3. 修订 1 R1-2 表格第 2 行「允许它自己换行｜不变」作废，改为「两行、各自 nowrap」。
4. 执行者已做的 `px-3 xl:px-4`、操作列 `grid grid-cols-2 xl:flex` 保留（1024 按钮全可见，`over` 为负，已达标）。
5. `apps/admin/src/utils/user-label.ts:36-38` 注释里「最近一单收货人 · MM-DD」的说法会略旧——该文件在禁止清单，**不改**，记为建议（下次触碰该文件时顺手改注释）。

验收修订（替换修订 1 的对应门槛）：
- 1024：每行 `rowH ≤ 62`（与 1280/1440 同级，BASE 1280 是 61）；另加：`[...r.querySelectorAll('div')].find(d => d.innerText.startsWith('最近一单收货人')).getBoundingClientRect().height ≤ 18`（小字单行）。其余门槛（`th ≤ 44`、胶囊 ≤ 20、按钮 `h ≤ 24 && over ≤ 0`、`tableW ≤ containerW`、`scrollX ≤ 0`）不变。
- 1280/1440：不变（`rowH ≤ 62`）。375：不变（`scrollWidth ≤ 375`）。
- `measurements.md` §1/§8 按新结果重写，`desk-1024-list.png`、`desk-list.png`、`375-list.png` 重拍（字节须变化）。
- 既有单测/e2e 不受影响（只改两处展示文案）。

授权范围、禁止修改、上报条件：不变。待用户决定：无。
