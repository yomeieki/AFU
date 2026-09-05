# 会员 M2：结算链路（券与赠品进下单计价） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤用 checkbox（`- [ ]`）语法追踪。
> **前置**：M1（`docs/superpowers/plans/2026-09-04-member-m1-ledger.md`）已全部落地并合入——积分账本、券生命周期、`member` 设置、三个 scheduler 任务、`/member/*` 只读端点都在。本计划**只写 M2**：把券与赠品接进 `POST /orders`，把释放接进未支付取消，把优惠字段透传到订单接口与工作台。**不做后台管理页，不做小程序页面。**
> **本文档性质**：规划文档，由 Principal Engineer 角色撰写，本身不修改任何 `apps/` 代码。代码片段是给执行者的实施依据。

设计依据：`docs/superpowers/specs/2026-09-04-member-points-coupon-design.md`（下称 spec）§5.1–5.3、§5.5、§5.9、§9；`docs/superpowers/plans/2026-09-04-member-points-coupon-masterplan.md` 的 P3 / P5 / P7 与「核心规则」一节。**P1–P10 十条决策与 spec §5 的计费顺序本计划不改动、不重新讨论。**

**Goal:** 顾客下单时能带一张券和若干随单赠品，服务端按 spec §5.1 的固定顺序算出 `actualAmount`，把券核销、积分扣减、赠品行落库与真实库存扣减全部放进同一个下单事务；未支付取消（顾客手点 / 后台取消待付款 / 15 分钟超时）把券与积分释放回去；已支付后的任何退款**不动券、不退赠品积分**（P7），退款上限公式保持 `actualAmount − refundedAmount` 不变；订单的顾客端与管理端接口都返回优惠字段；接单工作台的金额明细与商品清单能看到「优惠券 −¥X」与「赠」标。做完 M2，顾客用 curl 已经能走通完整优惠链路，但小程序与后台页面还看不到（那是 M3/M4）。

**Non-goals（详见文末《明确不做》）：** 不做任何 React 管理页（工作台金额明细那几行除外）；不做小程序；不做多券叠加、折扣券；不改 `quoteToken` 的签发与校验；不改退款上限公式；不做云打印小票模板（本分支打印机状态是 `NOT_CONNECTED`，见 Task 9）。

---

## Global Constraints

- **计费顺序是 P 决策，逐字执行 spec §5.1**：`subtotal = Σ非赠品行` → `discount = coupon ? min(coupon.amount, subtotal) : 0`（门槛比对 `subtotal`）→ 运费/包邮/起送/同城起送**一律按券前 `subtotal`** 判定 → `actualAmount = subtotal − discount + shippingFee`。`actualAmount === 0` 直接 42251「该券金额已超过本单可抵扣范围」。微信支付金额 = `actualAmount`。
- **同城 LOCAL 分支的信任边界一个字都不能动**：`verifyQuote` 四项校验、42239/42227 分支、`calcLocalFee(s, distanceM, totalAmount)` 的入参仍是券前小计、`q.fee > quoted.fee` 比较——这些在 `routes/orders.ts` 下单端点里有一大段注释解释为什么，**执行本计划前先把那段注释读完**（Task 1）。券只作用于商品小计，与报价凭证正交，不需要给 token 加任何字段。
- 赠品行：`OrderItem.isGift = true`、`productPrice = 0`、`subtotal = 0`、`pointsCost = 单件积分价`，**照常扣真实库存、加真实销量**（走与付费行同一段 `updateMany` 原子扣减）；不进 `subtotal`，不参与门槛/包邮判定。
- 一单一券；赠品同种 `quantity <= perOrderLimit`；`stockLimit` 用 `updateMany({ issuedCount: { lt: stockLimit } })` 判 count。
- 券核销、积分扣减（`consumePoints`，M1 提供）、赠品落库、库存扣减、`PointsGood.issuedCount` 递增，**全部在下单事务 `tx` 内**；任何一步失败整单回滚。
- 释放只发生在 `PENDING_PAYMENT → CANCELLED`（三条路径，见 Task 6）。已支付后一律不释放（P7）。`GIFT_REVERT` 的 `@@unique([type,'ORDER',orderId])` 保证一单只退一次。
- 退款：`remainingRefundable()` 公式**不改**；`finalizeRefundSuccess` 的积分扣回是 M1 的事，本计划只回归验证。
- 错误码：42250 积分不足 · 42251 券不可用（消息区分：已用/过期/渠道不符/未达门槛/超出可抵扣范围）· 42252 赠品超出限购或已兑完 · 42224 赠品商品渠道不符（复用现有码）。
- 金额一律分（Int）；状态写入沿用 `updateMany({where:{id, 状态守卫}})` 判 `count`。
- 所有 `/member/*` 端点 `where: { userId: req.userId }`；下单时券必须 `userId` 归属校验。
- 提交信息中文、`type(scope): 摘要`。

---

## 前置条件表（执行前逐条确认，未满足的先去满足，不要带着假设进 Task）

| # | 条件 | 现状（2026-09-05 写稿时） | 未满足时怎么办 |
|---|---|---|---|
| P1 | **批次一（同城配送）已走完整条上线路径**：合并 main → 部署 → 后台同城设置 → 体验版 → 真机联调 → 提审 | ⬜ 未满足。生产仍是 `ca37137`，`Order.isTest` 只在本分支（`migrations/20260905000000_add_order_is_test`）。整条会员链（M1–M5）都排在它后面（spec §11、masterplan 核验补充） | 等。不要在 main 上先写会员代码 |
| P2 | **M1 已落地**：四张表与 `Order`/`OrderItem` 新列已迁移；`services/member/{settings,points,coupons}.ts` 存在；`consumePoints(tx, userId, amount, meta)` 可在外部事务里调用；`routes/member.ts` 已注册 | ⬜ M1 计划已写、0/37 步。本分支 `schema.prisma` 无任何 member 模型、`routes/` 无 `member.ts` | M1 未完不能开 M2。M2 的每个 Task 都依赖 `consumePoints` 与 `UserCoupon` 表 |
| P3 | M1 的 e2e 与 `selftest-member.ts` 全绿，`check-points-consistency.mjs` 退出码 0 | ⬜ 随 M1 | 红着就不开工，否则分不清是 M1 的问题还是 M2 引入的 |
| P4 | **M1 是否已落 `POST /member/points/redeem`、`POST /member/coupons/claim`、`GET /member/mall`、`GET /member/campaign` 四个端点** | ❓ **M1 计划有歧义**：Task 7 只列了三个只读端点，Task 8 的 e2e 又要打「三条发券路径」（必然要经 redeem/claim 端点）。 | 执行 M2 前 `grep -n "router.post" apps/server/src/routes/member.ts` 核实；缺的在本计划 **Task 3 Step 4** 补齐（M4 小程序五页全都要用） |
| P5 | `consumePoints` 能告诉调用方「这次扣了哪些入账行、最早到期日是多少」 | ❓ M1 计划 Task 3 Step 2 的接口签名没写返回值 | spec §5.5 要求 `GIFT_REVERT.expiresAt = 被扣行里最早的到期时间`。若 M1 的 `consumePoints` 没返回 `minExpiresAt`，本计划 **Task 6 Step 1** 先补这个返回值（纯增量，不改语义） |
| P6 | 本地 e2e 基线绿：`bash scripts/e2e.sh`（后端 `PORT=3100 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true`，`.claude/launch.json` 的 `api-3100` 就是这条命令） | ✅ 写稿时 530 断言全绿（不含 M1 新增） | 开工第一步先跑一遍记下数字，M2 每个 Task 结束都要回到「全绿且只增不减」 |
| P7 | 种子里有券模板样例（M1 Task 9：新人礼 / 积分兑 / 客服补偿） | ⬜ 随 M1 | M2 的 e2e 不依赖 seed 模板——Task 3 会落管理端模板 CRUD，e2e 自己建自己删 |

---

## 文件结构（本计划涉及）

| 路径 | 职责 |
|---|---|
| `apps/server/src/services/member/pricing.ts` | **Create**。纯函数：`computeCheckout()`、`checkCouponUsable()`。无 DB、可被 selftest 直接 import |
| `apps/server/src/services/member/checkout.ts` | **Create**。`loadCheckoutOptions()`、`applyOrderBenefits(tx, …)`（下单事务内核销/扣分/赠品）、`releaseOrderBenefits(tx, order)`（未支付取消释放） |
| `apps/server/src/routes/member.ts` | **Modify**。新增 `GET /member/checkout-options`；补齐 P4 缺失的端点 |
| `apps/server/src/routes/orders.ts` | **Modify**。`POST /` 加 `couponId`/`gifts`；`PUT /:id/cancel` 待付款分支接释放；`GET /`、`GET /:id`、`POST /` 响应加优惠字段 |
| `apps/server/src/routes/admin/orders.ts` | **Modify**。`orderListSelect` 加优惠列与 `userId`；`GET /:id` 带券快照；`POST /:id/cancel`（待付款）接释放 |
| `apps/server/src/routes/admin/after-sales.ts` | **Modify**。`orderSummarySelect` 加 `discountAmount`/`pointsUsed` |
| `apps/server/src/routes/admin/coupon-templates.ts` | **Create**。券模板 CRUD（服务端；页面在 M3） |
| `apps/server/src/routes/admin/points-goods.ts` | **Create**。赠品 CRUD（服务端；页面在 M3） |
| `apps/server/src/routes/admin/index.ts` | **Modify**。注册上面两个路由 |
| `apps/server/src/services/scheduler.ts` | **Modify**。`cancelExpiredOrders` 接释放 |
| `apps/server/src/services/order-notify.ts` | **Modify**。新订单推送带「优惠 −¥X」「赠品」标 |
| `apps/server/src/routes/admin/workbench.ts` | **Modify**。卡片 `items.first` 里赠品行带「赠」前缀 |
| `apps/admin/src/pages/Workbench.tsx` + `apps/admin/src/types.ts` | **Modify**。详情抽屉「金额明细」与「商品清单」显示优惠与赠品（本计划唯一的前端改动） |
| `apps/server/scripts/selftest-member.ts` | **Modify**。追加计价矩阵自测 |
| `scripts/e2e.sh` | **Modify**。新增用例段 + §34 契约锁补字段 |
| `docs/api.md` | **Modify**。附录 D（会员）追加 M2 端点与字段 |

---

### Task 1: 只读——读懂现有下单主逻辑，标出插入点

**Files:**
- 无修改。产出写进本次 PR 描述（或 `docs/superpowers/notes/2026-09-xx-member-m2-insertion-points.md`，二选一，不要两处都写）。

**为什么单独成一个 Task**：`routes/orders.ts` 的 `POST /` 是同城配送刚重写过的地方（强制报价凭证、道路距离运费），LOCAL 分支那段 40 行注释解释了「改错这里就是每单漏钱」。M2 要在这个函数里插五处代码，必须先读完再动手。

- [ ] **Step 1: 通读 `POST /orders`（`routes/orders.ts` 约 `:95-330`）**
  逐段记录：① 组装 `lines`（购物车 / `directItem` 两条）；② 逐行验证（渠道 42224、上架 42202、库存 42201）；③ 地址归属；④ 计价——`totalAmount` 累加、EXPRESS 走 `getShippingSettings + calcShippingFee(totalAmount)`、LOCAL 走 `verifyQuote → calcLocalFee(s, distanceM, totalAmount) → 起送/范围/件数重量 → q.fee > quoted.fee`；⑤ 事务：建单 + 原子减库存 + 清购物车。
- [ ] **Step 2: 标出五个插入点**（写成清单，执行 Task 4/5 时逐条对照）
  (a) zod schema 加 `couponId?`、`gifts?`；(b) 在「② 逐行验证」之后、「④ 计价」之前，加载并校验券与赠品（读库、不写）；(c) 「④ 计价」里 `const actualAmount = totalAmount + shippingFee` 改为 `totalAmount − discount + shippingFee`，且 **`calcShippingFee` / `calcLocalFee` 的入参 `totalAmount` 保持券前值**；(d) 事务内 `items: { create }` 追加赠品行，随后调 `applyOrderBenefits(tx, …)`；(e) `success(res, …)` 加 `discountAmount`、`pointsUsed`。
- [ ] **Step 3: 标出「不许碰」清单**
  `verifyQuote` 四项校验与 42239/42227 两个分支；`calcLocalFee` 入参；`q.fee > quoted.fee`；`localSnapshot` 六个字段；`withPayExpire` 的剥字段逻辑（新字段要能透传，见 Task 8）。
- [ ] **Step 4: 跑一遍 e2e 记基线**
  `bash scripts/e2e.sh 2>&1 | tail -3`，把「通过 N / 失败 0」的 N 记进 PR 描述。M2 结束时 N 只能变大。

**Acceptance:** PR 描述里有插入点清单与不许碰清单；基线数字已记录。

---

### Task 2: 计价纯函数 + 自测（`services/member/pricing.ts`）

**Files:**
- Create: `apps/server/src/services/member/pricing.ts`
- Modify: `apps/server/scripts/selftest-member.ts`

**Interfaces:**
- Produces:
  ```ts
  type CouponLike = { amount: number; threshold: number; channel: 'ALL'|'LOCAL'|'EXPRESS'; status: string; expiresAt: Date; userId: number }
  type UsableCheck = { usable: true; discount: number } | { usable: false; reason: 'USED'|'EXPIRED'|'CHANNEL'|'THRESHOLD'|'NOT_OWNER'; message: string }
  function checkCouponUsable(c: CouponLike, ctx: { userId: number; channel: 'LOCAL'|'EXPRESS'; subtotal: number; now?: Date }): UsableCheck
  function computeCheckout(i: { subtotal: number; discount: number; shippingFee: number }): { actualAmount: number }  // 只做一件事：subtotal − discount + shippingFee，并断言 discount <= subtotal
  ```
  `reason → message` 映射固定：USED「优惠券已使用」/ EXPIRED「优惠券已过期」/ CHANNEL「该券仅限同城配送订单使用」或「…仅限全国邮寄…」/ THRESHOLD「满 ¥X 可用，当前 ¥Y」/ NOT_OWNER「优惠券不存在」（不暴露「不属于你」）。

- [ ] **Step 1: 先写自测再写实现**
  在 `selftest-member.ts` 追加「计价矩阵」段，至少覆盖：券 < 小计；券 = 小计；券 > 小计（discount 封顶）；门槛刚好等于小计（可用）；门槛比小计多 1 分（不可用）；`ALL` 券两种渠道都可用；`LOCAL` 券在 EXPRESS 单不可用；过期 1 秒不可用；`actualAmount` 三种运费组合（0 / 有运费 / 券把商品减到 0 但有运费 → actualAmount = 运费，**允许**）；`subtotal − discount + 0 === 0` 时由调用方拒（本函数只算数，不抛）。
- [ ] **Step 2: 实现两个纯函数**
  不 import prisma，不 import AppError——纯函数返回结构化结果，抛错在路由层做。
- [ ] **Step 3: 跑 `npx ts-node apps/server/scripts/selftest-member.ts`**，新段全绿且 M1 旧段不受影响。

**Acceptance:** selftest 全绿；`pricing.ts` 零 DB 依赖（`grep -n prisma` 为空）。

---

### Task 3: `GET /member/checkout-options` + 管理端模板/赠品数据接口

**Files:**
- Create: `apps/server/src/services/member/checkout.ts`（本 Task 只放 `loadCheckoutOptions`）
- Modify: `apps/server/src/routes/member.ts`
- Create: `apps/server/src/routes/admin/coupon-templates.ts`、`apps/server/src/routes/admin/points-goods.ts`
- Modify: `apps/server/src/routes/admin/index.ts`

**Interfaces:**
- `GET /api/member/checkout-options?channel=EXPRESS|LOCAL&subtotal=<分>` →
  ```jsonc
  {
    "pointsBalance": 320,
    "points": { "enabled": true, "earnRatePerYuan": 1 },       // 结算页「预计得 N 分」按 payAmount 估算展示用
    "coupons": [                                               // 该用户 UNUSED 且未过期的全部券，按 usable desc, discount desc, expiresAt asc
      { "id": 1, "name": "满30减5", "amount": 500, "threshold": 3000, "channel": "ALL", "expiresAt": "...", "usable": true, "discount": 500 },
      { "id": 2, "name": "同城专享", "amount": 300, "threshold": 0, "channel": "LOCAL", "expiresAt": "...", "usable": false, "reason": "CHANNEL", "message": "该券仅限同城配送订单使用" }
    ],
    "gifts": [                                                 // PointsGood ON + 商品 ON_SHELF 未删 + 商品渠道 = channel + 库存 > 0 + (stockLimit 未耗尽)
      { "id": 3, "productId": 12, "skuId": null, "name": "夫妻肺片(小份)", "image": "...", "pointsCost": 80, "perOrderLimit": 1, "specText": null, "stock": 5, "remaining": 20 }
    ]
  }
  ```
  `usable`/`discount` 由 Task 2 的 `checkCouponUsable` 算出——小程序**只显示服务端给的数字**，不本地重算（spec §6）。
- 管理端（服务端先落，页面在 M3）：
  - `GET /admin/coupon-templates?source=&status=` 列表（含 `usedCount` = 该模板 `UserCoupon.status='USED'` 计数）；`POST /admin/coupon-templates`；`PUT /admin/coupon-templates/:id`（`source` 不可改；`status` 可 ON/OFF）；`GET /admin/coupon-templates/:id/issued?page=`（发放记录：用户昵称、code、status、source、issuedBy、remark、sourceRef、createdAt）。**无 DELETE**（spec 只有停用）。
  - `GET /admin/points-goods`；`POST /admin/points-goods`（`productId` 必须存在且未删；有 SKU 的商品必须传 `skuId`；`@@unique([productId, skuId])` 在 MySQL 下不约束 NULL，无 SKU 商品先 `findFirst` 再插，重复 → 40001）；`PUT /admin/points-goods/:id`；`DELETE /admin/points-goods/:id`（硬删，`OrderItem` 不引用它的 id）。
  - zod：`amount` 1..100000 分、`threshold` 0..10000000、`validDays` 1..3650、`pointsCost`（`source=POINTS` 必填 ≥1）、`totalLimit`/`perUserLimit` ≥1 或 null；`channel ∈ ALL|LOCAL|EXPRESS`；上限沿用 `admin/settings.ts` 里「挡住把元当分填」的思路。

- [ ] **Step 1: `loadCheckoutOptions(userId, channel, subtotal)`**
  一次查券（`where: { userId, status: 'UNUSED', expiresAt: { gt: now } }`）、一次查赠品（`PointsGood` join `Product`/`ProductSku`），逐张券过 `checkCouponUsable`，赠品过「商品在架 + 渠道一致 + 库存 > 0 + stockLimit 未耗尽」。**读设置用 M1 的 `getMemberSettings()`**。
- [ ] **Step 2: 路由**
  `router.get('/checkout-options', …)`，zod 校验 `channel` 枚举与 `subtotal` 非负整数；沿用 M1 Task 7 的限流写法。输出白名单：券对象不返回 `templateId/issuedBy/remark/sourceRef`。
- [ ] **Step 3: 管理端两个路由文件**
  照 `routes/admin/banners.ts` 的体例（小而全的 CRUD）。`admin/index.ts` 加 `router.use('/coupon-templates', …)` 与 `router.use('/points-goods', …)`（在 `verifyAdminToken` 之后）。
- [ ] **Step 4: 补齐 P4 缺失的端点（若 M1 没落）**
  `GET /member/mall`（`source=POINTS` 且 ON 的模板 + 全部可用赠品，赠品不区分渠道、带 `channel` 字段供前端分组）、`POST /member/points/redeem { templateId }`、`GET /member/campaign`（`source=CAMPAIGN` 且 ON，带 `remaining = totalLimit − issuedCount` 与「本人已领 N 张」）、`POST /member/coupons/claim { templateId }`。服务函数用 M1 的 `redeemByPoints` / `claimCampaign`。**若 M1 已落，本步骤跳过，不要重写。**
- [ ] **Step 5: curl 冒烟**
  用 seed 模板 + 新建一个 `PointsGood`，`checkout-options` 两种渠道各打一次，确认 `usable/reason` 正确、赠品按渠道过滤。

**Acceptance:** 四个（或八个）端点可用；A 用户查不到 B 的券；`channel=LOCAL` 时 EXPRESS 商品的赠品不出现。

---

### Task 4: `POST /orders` 邮寄分支接券与赠品

**Files:**
- Modify: `apps/server/src/routes/orders.ts`（`POST /`）
- Modify: `apps/server/src/services/member/checkout.ts`（新增 `applyOrderBenefits`）

**Interfaces:**
- 请求体新增（都可选）：`couponId?: number`、`gifts?: [{ pointsGoodId: number; quantity: number }]`（`quantity` 1..9；`gifts` ≤ 5 项；同一 `pointsGoodId` 出现两次 → 40001）。
- 响应新增：`discountAmount`、`pointsUsed`、`couponName?`。
- `applyOrderBenefits(tx, { orderId, userId, coupon: UserCoupon | null, giftLines: GiftLine[], pointsUsed })`：
  1. 券：`tx.userCoupon.updateMany({ where: { id, userId, status: 'UNUSED' }, data: { status: 'USED', usedAt: now, orderId } })`，`count === 0` → `AppError(42251, '优惠券已被使用')`（并发防线）。
  2. 积分：`pointsUsed > 0` 时 `consumePoints(tx, userId, pointsUsed, { type: 'GIFT', refType: 'ORDER', refId: String(orderId), remark: '随单赠品' })`——不足抛 42250（M1 已定）。
  3. 每个赠品 `tx.pointsGood.updateMany({ where: { id, status: 'ON', ...(stockLimit != null ? { issuedCount: { lt: stockLimit − quantity + 1 } } : {}) }, data: { issuedCount: { increment: quantity } } })`，`count === 0` → 42252「赠品已兑完」。（`stockLimit` 判定要按 `issuedCount + quantity <= stockLimit`，用 `lt: stockLimit − quantity + 1` 表达。）

- [ ] **Step 1: zod schema**
  在 `createOrderSchema` 加两个可选字段；`refine` 里补「gifts 内 pointsGoodId 不重复」。
- [ ] **Step 2: 事务前只读校验（插入点 b）**
  ① 券：`prisma.userCoupon.findFirst({ where: { id: couponId, userId } })`，不存在 → 42251「优惠券不存在」；过 `checkCouponUsable(c, { userId, channel, subtotal: totalAmount })`，不可用 → 42251 + 对应 message。② 赠品：批量取 `PointsGood`（含 product/sku），逐项校验 `status='ON'`（否则 42252）、`quantity <= perOrderLimit`（42252「每单最多 N 份」）、商品未删在架（42202）、`product.channel === channel`（42224，消息沿用现有格式）、库存 ≥ quantity（42201）。③ `pointsUsed = Σ pointsCost × quantity`，`pointsUsed > user.pointsBalance` 先 42250 快速失败（真正防线是事务内 `consumePoints`）。
  **`totalAmount` 在这一步之前已经算好且只含付费行**——把赠品的 `orderItemsData` 单独组一个数组，不要混进 `lines`（`lines` 参与运费/件数/重量与库存扣减，赠品要参与库存扣减但不参与小计，见 Step 4）。
- [ ] **Step 3: 计价（插入点 c）**
  `const discount = coupon ? min(coupon.amount, totalAmount) : 0`；EXPRESS 分支 `calcShippingFee(totalAmount, shipping)` 与起送判定入参**不变**；`const actualAmount = totalAmount − discount + shippingFee`；`actualAmount === 0` → 42251「该券金额已超过本单可抵扣范围」。
- [ ] **Step 4: 事务（插入点 d）**
  `tx.order.create` 的 `data` 加 `couponId`、`discountAmount: discount`、`pointsUsed`；`items.create` = 付费行 + 赠品行（赠品行 `productPrice: 0, subtotal: 0, isGift: true, pointsCost, skuId: pg.skuId, specText: sku?.specText`）。库存扣减循环改为遍历「付费行 ∪ 赠品行」（同一段 `updateMany` 判 count 逻辑，赠品同样加 `salesCount`——它是真实出货）。然后 `applyOrderBenefits(tx, …)`。最后清购物车不变。
- [ ] **Step 5: 响应（插入点 e）**
  `success(res, { …原字段, discountAmount: order.discountAmount, pointsUsed: order.pointsUsed, couponName: coupon?.name ?? null })`。
- [ ] **Step 6: `notifyOrderPaid` 的商品清单带赠品标**
  `POST /:id/pay` 后查 `orderItem` 的 `select` 加 `isGift`；`services/order-notify.ts` 的 `notifyOrderPaid` 渲染 `【赠品】` 前缀，金额行加「（已用券 −¥X）」——打包的人必须看到赠品。
- [ ] **Step 7: 手工 curl**
  用券 + 一个赠品下一单：`actualAmount` 对；`user_coupons` 该行 `USED` 且 `order_id` 对；`points_ledgers` 有 GIFT 负行；`products.stock` 赠品减了；`points_goods.issued_count` +1。

**Acceptance:** 手工 curl 六项全对；无券无赠品下单的响应与改前完全一致（多出的两个字段为 0/0/null）；既有 e2e 全绿。

---

### Task 5: `POST /orders` 同城 LOCAL 分支接同一套

**Files:**
- Modify: `apps/server/src/routes/orders.ts`（LOCAL 分支）

- [ ] **Step 1: 确认 Task 4 的插入点 b/c/d/e 对两条渠道都是共用代码**
  券与赠品校验在渠道分叉之前、事务在分叉之后——理论上 LOCAL 分支不需要额外代码。本 Task 的价值是**逐条核对没有破坏**：
  - `calcLocalFee(s, distanceM, totalAmount)` 的第三个参数仍是券前 `totalAmount`；
  - `q.belowMin`（同城起送）比对的是券前小计；
  - `q.fee > quoted.fee` 那条「subtotal 造假」防线不变——`/local/quote` 的 subtotal 由顾客传、也是券前值，两边口径一致；
  - `localSnapshot` 六个字段不变。
- [ ] **Step 2: 赠品计入同城「件数 / 重量」上限**
  `totalItems` 与 `totalWeightKg` 的 `reduce` 要包含赠品行——它们是骑手真的要拎的东西。（这是工程判断：42230 的意义是「一个骑手拎不动」，与谁付钱无关。）
- [ ] **Step 3: `channel=LOCAL` 券只在 LOCAL 单可用**
  由 `checkCouponUsable` 的 CHANNEL 分支保证，这里只加断言用例（Task 10）。
- [ ] **Step 4: e2e 跑同城段**
  先用 `mk_local_paid` 的写法（现取 `quoteToken`）造一单带券的同城单，断言 `shippingFee === 报价 fee`、`actualAmount === subtotal − discount + fee`。

**Acceptance:** 同城用券单四项断言绿；既有 §21/§22/§25–§34 同城段全绿不变。

---

### Task 6: 未支付取消释放 `releaseOrderBenefits`

**Files:**
- Modify: `apps/server/src/services/member/checkout.ts`（新增 `releaseOrderBenefits`）
- Modify: `apps/server/src/services/member/points.ts`（仅当 P5 未满足：`consumePoints` 返回 `{ minExpiresAt }`）
- Modify: `apps/server/src/routes/orders.ts`（`PUT /:id/cancel` 的 `PENDING_PAYMENT` 分支）
- Modify: `apps/server/src/routes/admin/orders.ts`（`POST /:id/cancel` 待付款分支，`:333` 附近）
- Modify: `apps/server/src/services/scheduler.ts`（`cancelExpiredOrders`）

**Interfaces:**
- `releaseOrderBenefits(tx, order: { id, userId, couponId, pointsUsed, items })`：
  1. 券：`updateMany({ where: { id: couponId, status: 'USED', orderId: order.id }, data: { status: 'UNUSED', usedAt: null, orderId: null } })`；**若该券 `expiresAt < now`，改置 `EXPIRED`**（spec §5.5）。
  2. 积分：`pointsUsed > 0` 时插一条 `PointsLedger(type='GIFT_REVERT', delta=+pointsUsed, remaining=pointsUsed, refType='ORDER', refId=orderId, expiresAt=本单 GIFT 行记录的 minExpiresAt)` + `User.pointsBalance increment`；P2002 → 视为已退过，跳过。
  3. `PointsGood.issuedCount` 按赠品行 `decrement`（不低于 0：`updateMany({ where: { id, issuedCount: { gte: qty } } })`）。
  4. 库存回滚**不在这里做**——三个调用点已经各自调 `rollbackOrderStock(tx, order.items)`，而 `order.items` 现在天然包含赠品行，赠品库存随之回滚。

- [ ] **Step 1: 落实 P5——`minExpiresAt` 的存放**
  `consumePoints` 返回 `{ minExpiresAt: Date }`；Task 4 的 `applyOrderBenefits` 把它写进那条 GIFT 出账行的 `expiresAt`（列已存在且可空；把 schema 注释「仅 EARN」改为「EARN/GIFT_REVERT = 到期日；GIFT = 被扣行最早到期日，供释放时继承」）。释放时 `findUnique({ type:'GIFT', refType:'ORDER', refId })` 读回来。不加新列、不加 JSON。
- [ ] **Step 2: 实现 `releaseOrderBenefits`**，三步全部条件写判 count，整体幂等（同一单跑两次第二次零副作用）。
- [ ] **Step 3: 接三个调用点**
  顾客取消（`routes/orders.ts:588` 附近事务内，`rollbackOrderStock` 之后）、后台取消待付款（`routes/admin/orders.ts:333` 附近）、超时任务（`scheduler.ts:105` 附近）。三处都在**各自已有的事务内**调用。执行时 `grep -rn "status: 'CANCELLED'" apps/server/src` 再确认一遍没有第四条 `PENDING_PAYMENT → CANCELLED` 路径。
- [ ] **Step 4: 明确不接的路径（写注释）**
  `PAID 且未接单` 的顾客秒退、`routes/admin/orders.ts:504` 的商家取消、拒单、全额/部分退款——全是**已支付**，按 P7 不释放。在 `releaseOrderBenefits` 顶部注释里写清「只服务 PENDING_PAYMENT → CANCELLED」。
- [ ] **Step 5: 手工验证**
  用券 + 赠品下单不付款 → `PUT /orders/:id/cancel` → 券回 `UNUSED`、`points_ledgers` 有 `GIFT_REVERT`、余额恢复、`issued_count` 回落、赠品库存回滚。再造一单，把券的 `expires_at` 用 SQL 改到过去 → 取消 → 券是 `EXPIRED` 不是 `UNUSED`。

**Acceptance:** 三条路径各验一次；`check-points-consistency.mjs` 退出码 0；同一单连续两次释放不重复入账。

---

### Task 7: 退款链路回归（不改公式，只验证）

**Files:**
- Modify: `apps/server/src/services/refund.ts`（**预期零改动**；只允许加注释）
- Modify: `scripts/e2e.sh`（用例在 Task 10 一起写，这里先手工验证）

- [ ] **Step 1: 确认三条不变式**
  ① `remainingRefundable() = actualAmount − refundedAmount`——`actualAmount` 已是扣券后金额，公式不用改；② 全额判定 `refundedAmount >= actualAmount` 不用改；③ `RefundDialog` 的「全额」按钮填的是 `remainingRefundable`，不是商品原价（M3 会加一行灰字提醒店员，服务端这里已经兜住）。
- [ ] **Step 2: 库存与赠品**
  PAID/PREPARING 全额退款 → `rollbackOrderStock(tx, order.items)` 含赠品行 → 赠品库存回去（货没出）。**`PointsGood.issuedCount` 不回落、GIFT 积分不退、券不退**（P7）。在 `refund.ts` 事务 A 附近加一行注释说明这一点，防止将来有人「顺手」在退款里加释放。
- [ ] **Step 3: M1 的退款扣分与 M2 无耦合**
  `deductPointsOnRefund` 只看 `pointsEarned` 与 `refund.amount`，与 `discountAmount`/`pointsUsed` 无关；用券单完成后得分按 `actualAmount`（扣券后）算，这是 P4「按实付发放」的本意。
- [ ] **Step 4: 手工验证**
  用券单支付 → 部分退 1 分 → 券仍 `USED`；再全额退 → 订单 `REFUNDED`、券仍 `USED`、无 `GIFT_REVERT` 行。

**Acceptance:** `refund.ts` 的 diff 只有注释；四项手工验证通过。

---

### Task 8: 订单接口返回优惠字段（顾客端 + 管理端）

**Files:**
- Modify: `apps/server/src/routes/orders.ts`（`GET /`、`GET /:id`）
- Modify: `apps/server/src/routes/admin/orders.ts`（`orderListSelect`、`GET /:id`）
- Modify: `apps/server/src/routes/admin/after-sales.ts`（`orderSummarySelect`）
- Modify: `apps/server/src/routes/admin/users.ts`（`GET /:id/orders` 的 select 加 `discountAmount`）
- Modify: `scripts/e2e.sh` §34（契约锁）

**Interfaces（字段名一次定死，M3/M4 都按这里写）：**
- 顾客端订单行（列表与详情共有）：`discountAmount`、`pointsUsed`、`pointsEarned`；`items[]` 每行加 `isGift`、`pointsCost`。
- 顾客端详情额外：`coupon: { name, code, amount } | null`（按 `couponId` 查 `UserCoupon`，不存在给 null）。列表不带券名（避免 N+1）。
- 管理端列表：`orderListSelect` 加 `userId`（M3 的「发赔偿券」要用）、`couponId`、`discountAmount`、`pointsUsed`、`pointsEarned`；`items.select` 加 `isGift`、`pointsCost`。
- 管理端详情：在 `include` 之外补 `coupon: { name, code, amount, source, issuedBy }`。
- 售后摘要：加 `discountAmount`、`pointsUsed`、`items[].isGift`。

- [ ] **Step 1: 顾客端**
  `GET /` 的 `items.select` 加两字段；`GET /:id` 用 `include: { items: true }` 已全量，只需补 `coupon`。`withPayExpire` 只剥 `quoteSnapshot/quotedAt/isTest`，新字段自然透传——**但要在函数顶部那段「现存携带订单行的出口共 4 处」注释里把新字段也提一句**，那段注释是这个文件的契约。
- [ ] **Step 2: 管理端三处 select**
- [ ] **Step 3: §34 契约锁补字段**
  在 e2e 第 34 段（顾客端字段契约锁）追加 `has("discountAmount")`、`has("pointsUsed")`、`has("pointsEarned")`、`items[0] | has("isGift")` 四条断言——M4 小程序按这些名字取值，锁在这里比锁在文档里管用。

**Acceptance:** 四个端点字段齐；§34 新增断言绿；`docs/api.md` 附录 D 有字段表（Task 10）。

---

### Task 9: 接单工作台显示优惠与赠品（本计划唯一前端改动）

**Files:**
- Modify: `apps/server/src/routes/admin/workbench.ts`（`toCard` 的 `items.first`）
- Modify: `apps/admin/src/types.ts`（`Order` 加 `discountAmount/pointsUsed/pointsEarned/couponId`、`OrderItem` 加 `isGift/pointsCost`）
- Modify: `apps/admin/src/pages/Workbench.tsx`（详情抽屉「商品清单」「金额明细」）

**现状事实**：本分支没有任何云打印/小票代码——`workbench.ts:119` 的 `printer: { status: 'NOT_CONNECTED' }` 是占位，`Workbench.tsx:592` 注释写着「接入后按 snap.printer.status 放出来」。spec §8 的「同城票面显示优惠」在本分支**没有落点**。

- [ ] **Step 1: 卡片摘要**
  `toCard` 的 `items.first` 里赠品行渲染成 `赠·夫妻肺片 ×1`（`loadOrders` 的 `items.select` 加 `isGift`）。卡片 `amountFen` 仍是 `actualAmount`（店员看的是实收）。
- [ ] **Step 2: 详情抽屉「商品清单」**
  `isGift` 行名称前加一个「赠」小标（沿用 `wb__item-spec` 的样式类），金额列显示 `积分 N`（`pointsCost × quantity`）而不是 `¥0.00`——显示 ¥0 会让店员以为漏收钱。
- [ ] **Step 3: 详情抽屉「金额明细」**
  在「商品小计」与「配送费/运费」之间插一行 `优惠券 −¥X`（`discountAmount > 0` 才显示）；「顾客实付」不变；`pointsUsed > 0` 时加一行 `积分抵扣赠品 N 分`（无金额）。
- [ ] **Step 4: 小票模板——交接项**
  在 `docs/superpowers/notes/` 或 PR 描述里记一条交接：将来云打印落地时，票面必须打「优惠券 −¥X」与赠品行「赠」标，否则打包员按票面数不出赠品。**本计划不建打印模板文件。**
- [ ] **Step 5: `tsc` 与浏览器目测**
  `cd apps/admin && npx tsc --noEmit` 零错误；起 `admin` + `api-3100`，用 Task 4 的券单看工作台详情抽屉。

**Acceptance:** 抽屉三处显示正确；无券无赠品的单显示与改前一致；`tsc` 零错误。

---

### Task 10: e2e 用例段 + selftest + docs/api.md

**Files:**
- Modify: `scripts/e2e.sh`
- Modify: `docs/api.md`

**用例段编号**：M1 计划没定编号，执行时以当时 `e2e.sh` 里最大段号 +1 起，插在「== 11. 清理 ==」之前（文件尾部 11/24 两段是清理与一致性检查，顺序是刻意的，不要动）。段内沿用 `assert_eq` + `ok/fail`。造模板/赠品用 Task 3 的管理端接口，段末删掉。

- [ ] **Step 1: 「会员结算：券」段**
  新建一个 `threshold=商品价×1、amount=商品价−1 分、channel=ALL` 的 ADMIN 模板 → 后台发给 e2e 用户（`POST /admin/users/:id/coupons` 若 M3 未落，用 M1 的 `issueCoupon` 走 seed 模板或先用 SQL 插一张券——写清楚用了哪种）→ `checkout-options` 断言 `usable=true` 且 `discount` 正确 → 下单断言 `actualAmount = subtotal − discount + fee`、`discountAmount` 对、券 `USED`（`GET /member/coupons?status=used` 能查到、`orderId` 对）→ 同一张券再下一单 42251 → 过期券（SQL 改 `expires_at`）42251 → `channel=LOCAL` 券下 EXPRESS 单 42251 → 门槛比小计多 1 分 42251 → 面额 = 小计 + 运费 0 → 42251（`actualAmount` 归零）→ **包邮线用例**：把 `freeThreshold` 设成小计恰好等于线、券把它减到线下 → 断言 `shippingFee = 0`（顾客不因用券失去包邮）→ 起送线同理断言不被 42210 → **并发**：两个 `curl &` 用同一张券下单，恰一成一败。
- [ ] **Step 2: 「会员结算：赠品」段**
  先用 M1 的路径给 e2e 用户造 ≥ 200 分（完成一单或 SQL 插 EARN 行——与 M1 e2e 的造分方式保持一致）→ 建 `PointsGood(perOrderLimit=1, stockLimit=1, pointsCost=50)` → 下单带 `quantity=2` → 42252 → `quantity=1` 成功：`pointsUsed=50`、`items` 里有 `isGift=true` 且 `productPrice=0`、商品库存 −1、`issued_count=1`、`GET /member/summary` 余额 −50 → 再下一单同赠品 → 42252（`stockLimit` 耗尽）→ 余额不足的赠品 42250 → 跨渠道赠品（EXPRESS 商品的赠品下 LOCAL 单）42224 → 同一 `pointsGoodId` 传两次 40001。
- [ ] **Step 3: 「未支付取消释放」段**
  用券 + 赠品下单不付 → 顾客取消 → 券 `UNUSED`、余额恢复、`GIFT_REVERT` 行存在且 `expiresAt` 等于被扣行到期日、库存回滚、`issued_count` 回落 → 再造一单 → `run-scheduler {"payTimeoutMin":0}` → 同样五项 → 再造一单 → 后台 `POST /admin/orders/:id/cancel` → 同样五项 → 过期券取消后是 `EXPIRED`。
- [ ] **Step 4: 「用券单退款回归」段**
  用券单支付 → 部分退 1 分：订单 PAID 不变、券 `USED` → 超可退余额 42206（余额 = `actualAmount − 1`，证明上限按扣券后金额）→ 全额退剩余 → `REFUNDED`、券仍 `USED`、无 `GIFT_REVERT`、赠品库存已回（PAID 态全额退）。
- [ ] **Step 5: 「同城用券」段**
  `mk_local_paid` 的写法现取 `quoteToken` → 带 `channel=LOCAL` 券下单 → `shippingFee = 报价 fee`、`actualAmount` 对；带赠品时 `totalItems` 计入赠品（把 `limits.maxItems` 临时设成付费件数，加赠品后 42230，改回）。
- [ ] **Step 6: 管理端模板/赠品 CRUD 冒烟**
  建 / 改 / 停用 / 发放记录 / 删赠品各一条断言；停用后 `checkout-options` 不再列出该模板换的券？（**注意**：停用只影响再发放，已发的券照常可用——断言已发券仍 `usable=true`。）
- [ ] **Step 7: 段末清理**
  删模板不可能（无 DELETE）→ 置 OFF；删 `PointsGood`；把造的订单按尾部清理段的写法 SQL 置 `CANCELLED`。
- [ ] **Step 8: `docs/api.md` 附录 D（会员）**
  M1 若已建附录 D 就往里追加，否则新建：`GET /member/checkout-options` 响应结构、`POST /orders` 新字段、订单响应新字段表、管理端 `coupon-templates` / `points-goods` 端点、42252 触发点。
- [ ] **Step 9: 全量跑三次**
  `bash scripts/e2e.sh` 连续两轮全绿（同城 M4 计划的做法，防偶发）；`selftest-member.ts` 全绿；`check-points-consistency.mjs` 退出码 0。

**Acceptance:** 新增用例 ≥ 45 条全绿；既有用例数不减；两轮全绿。

---

## 完成标准（M2 整体）

1. `bash scripts/e2e.sh` **连续两轮全绿**，新增用例覆盖 spec §9 的「券」「赠品」「未支付取消」条目，以及本计划 Task 10 的包邮线、并发、同城、退款回归四组。
2. `npx ts-node apps/server/scripts/selftest-member.ts` 全绿（含计价矩阵）。
3. `node scripts/check-points-consistency.mjs` 退出码 0。
4. `apps/server` 与 `apps/admin` 的 `tsc --noEmit` 零错误。
5. **不带 `couponId`/`gifts` 的下单请求，行为与改前逐字节一致**（响应只多出 `discountAmount: 0, pointsUsed: 0, couponName: null`）。
6. `git diff apps/server/src/routes/orders.ts` 里 LOCAL 分支的 `verifyQuote` 段、42239/42227 分支、`calcLocalFee` 调用行**无变化**（执行者在 PR 描述里贴这几行的 diff 为空的证据）。
7. `refund.ts` 的 diff 只含注释。
8. 工作台详情抽屉能看到优惠与赠品；顾客端与后台其他页面**仍无任何可见变化**。

---

## 明确不做（本计划范围外）

1. 不做 `apps/admin` 的 Coupons / PointsGoods / MemberSettings 页面与 Users/Orders 页改动（M3）——本计划只落它们的服务端接口。
2. 不做 `apps/miniapp` 任何改动（M4）。
3. 不做多券叠加、折扣券、商品券、券与积分互抵（spec §12）。
4. 不改 `quoteToken` 的载荷、签名、TTL，不改 `/local/quote`。
5. 不改退款上限公式、不在退款路径里加任何释放逻辑（P7）。
6. 不建云打印小票模板——本分支无打印代码，只留交接项（Task 9 Step 4）。
7. 不做「下单幂等键」（同城 M4 计划 Task 4 的事，若那边已落地，本计划的 `couponId` 天然进入幂等键的请求体比对，不需要额外处理）。
8. 不做后台「订单列表按是否用券筛选」之类的报表需求。

---

## 需 PO 决定（本计划已给默认，PO 不反对即按默认执行）

| # | 问题 | spec 现状 | 本计划默认 | 为什么要问 |
|---|---|---|---|---|
| D1 | `member.points.enabled = false` 时，**换券与随单赠品是否也停**？ | spec §5.4 只说开关控制 `settlePoints` 与兜底任务 | **只停发放，已有积分仍可换券/加购赠品直到过期** | 若店主是想「整个积分体系下线」，默认会让顾客继续花分；若是想「暂停送分」，默认正确 |
| D2 | 赠品是否计入同城「单次配送最多 N 件 / M kg」上限？ | 未提 | **计入**（骑手真要拎） | 会让顾客在临界单上因为加赠品撞 42230 |
| D3 | 已支付全额退款（货未出）时 `PointsGood.issuedCount` 是否回落？ | 未提；P7 只说积分与券不退 | **不回落**（总量计数保守） | 限量赠品会被「下单即退款」的人占掉名额；但回落又与 P7 的口径不一致 |
| D4 | 用券订单的员工推送（PushPlus/企微）是否要显示券名 | 未提 | 显示「已用券 −¥X」不显示券名 | 券名可能含「客服补偿」字样，打包员不需要知道 |
