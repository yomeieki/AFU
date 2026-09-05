# 会员积分 + 积分商城 + 优惠券（含赔偿券）顶层设计 v1

分支：`claude/member-points-coupon`（纯文档分支，基线 `ca37137` = 生产实际运行版本）。
上游总计划：`docs/superpowers/plans/2026-09-04-member-points-coupon-masterplan.md`（PO 已批准的方案正文 + 落盘核验）。
合规调研：`docs/research/2026-09-03-member-wallet-points-coupon-compliance.md`。
实施计划：`docs/superpowers/plans/2026-09-04-member-m1-ledger.md`（M1）；M2–M5 待前序里程碑落地后再写。

## Context

- 店铺：丹桂阿福凉菜（**个体工商户**），四川省自贡市，单店，凉菜/熟食。
- 现状：原生微信小程序 + Express/Prisma(MySQL) + React 后台。「全国邮寄」全链路已在生产：下单、微信支付、一键退款、部分退款、售后、定时任务、订阅消息、PushPlus/企微推送、COS 图片。
- 「同城配送」在分支 `claude/same-city-delivery-plan-2ffa20` 开发中（M1 渠道基础 / M2 配送引擎 / M2b 工作台已完成，云打印出票与 M3 顾客端进行中）。**该分支既未合并 main，也未部署到生产**（见 §11 硬依赖）。
- 定稿的首页封面画稿留了「会员中心 / 会员储值 / 积分商城」三个次入口，目前全部弹「即将开通」。
- 代码里会员相关**零实现**：`User` 无任何金额字段；`Order` 无折扣列，`actualAmount = totalAmount + shippingFee`；退款上限唯一依据是 `actualAmount − refundedAmount`；后台用户页只读。
- 目标：新增与配送渠道正交的**会员权益层**——消费得积分、积分商城（换券 + 随单赠品）、优惠券（含店员定向发放的赔偿券）。储值本轮不做（§2）。

### 已确认的产品决策

| # | 决策 | 结论 |
|---|---|---|
| P1 | 主体 | 个体工商户（决定了 P2） |
| P2 | 储值 | **本轮不做**；赔偿一律发券，不发赔偿积分 |
| P3 | 兑换物 | 优惠券 + 本店商品作**随单赠品**（结算页用积分加购，随付费订单履约）；不做单独 0 元兑换单 |
| P4 | 积分来源 | 只做消费得积分（订单 COMPLETED 时按实付发放）；不做签到/分享/店员手动送分 |
| P5 | 券形态 | 只做固定金额满减（满 X 减 Y，X=0 即代金券），可限渠道，领取后 N 天有效；不做折扣券/商品券 |
| P6 | 券来源 | 积分兑换、店员定向发放（赔偿）、领券中心、新客券 |
| P7 | 退款与券 | 已支付订单任何退款（全额/部分）券**不退回**，赠品消耗的积分同样不退；未支付取消则释放 |
| P8 | 架构 | 账本式：积分带流水，券分模板与用户券 |
| P9 | 开工时机 | 文档先行；代码阶段等同城走完整条上线路径（§11） |
| P10 | 封面入口 | 三颗按钮改为 会员中心 / **优惠券** / 积分商城（原「会员储值」改词） |

---

## 1. 现状盘点（代码级，已核实）

**可直接复用**
- `Setting` KV 表 + `services/settings.ts` 的「JSON 值 + 60s 进程内缓存 + sanitize + clearCache」范式 → `member` 设置照抄。
- `services/refund.ts` 的 `finalizeRefundSuccess()` 是「钱退回去了」的**唯一漏斗**（refund SUCCESS、`activeOrderId=null`、`refundedAmount` 累加、全额时订单转 REFUNDED、级联 AfterSale→DONE）→ 积分扣回挂这里。
- `utils/order-stock.ts` 的 `rollbackOrderStock()`（含 SKU）→ 赠品行取消时复用。
- `services/scheduler.ts` 的任务表 `const tasks: [string, () => Promise<number>][]`，每项独立 try/catch + `notifySystemAlert` → 新增三个任务照插。
- `updateMany({ where: { id, status: '旧态' } })` 判 count 的条件流转范式；`Refund.activeOrderId @unique` 式的并发防线。
- admin `Layout navItems` + `api/admin.ts` + `types.ts` 三处一改加页；`Table` 的 `mobileCards` 双渲染；`ShopSettings.tsx` 的元↔分换算（`toFen`/`toYuan`）。
- miniapp `utils/request.js`（401 自动重登重试一次）、`components/empty-state`、`utils/price.wxs`、`utils/subscribe.js`。

**硬缺口**
- `User` 无 `pointsBalance`；无任何积分/券表。
- `Order` 无 `discountAmount / couponId / pointsUsed / pointsEarned`；`OrderItem` 无赠品标记。
- `routes/orders.ts` 的 `createOrder` 里 `actualAmount = totalAmount + shippingFee` 是**唯一**计价点，没有为折扣留位置。
- 后台 `routes/admin/users.ts` 只有两个只读端点（列表、该用户订单），**没有任何写端点**。
- 无单元测试框架，回归靠 `scripts/e2e.sh`（bash + curl + jq）。

**代码事实（影响设计）**
- 退款上限判定在 `refund.ts` 的 `remainingRefundable() = actualAmount − refundedAmount`，全额判定 `refundedAmount >= actualAmount` → 只要券在**下单时**就减进 `actualAmount`，退款链路无需改公式。
- 订单进入 COMPLETED 有多条路径：用户确认收货（`routes/orders.ts` 的 `PUT /orders/:id/confirm`）、`scheduler.ts` 的 `autoCompleteShippedOrders`、同城分支的配送 520 回调与店员「标记已送达」→ 积分发放必须**兜底任务 + 幂等唯一键**，不能只挂钩子。
- 同城分支新增 `Order.isTest`（测试单隔离，已接入全部统计口径）→ 积分发放必须排除测试单。
- 同城分支的下单已**强制报价凭证**，运费用运力方返回的真实道路距离 → 券只作用于商品小计，不触碰报价凭证，两者正交。

---

## 2. 合规边界（结论，依据见调研全文）

| 事项 | 结论 | 对设计的约束 |
|---|---|---|
| 会员储值 | **不做**。个体户法律上无需预付卡备案，但微信小程序含「会员卡预充值」需补选「商家自营-预付卡」类目，资质为备案公示材料或支付业务许可证，个体户两样都拿不到 | 无余额表、无充值入口、无余额支付；封面「会员储值」改词为「优惠券」 |
| 预付式消费法规 | 2024 消保法实施条例第 22 条（书面合同）、2025 法释〔2025〕4 号（7 日退本金、余额可退、赠送金按比例折算） | 本轮不涉及（无储值）；将来做储值时须先落电子协议 |
| 积分 | 官方明确「消费得积分、积分兑换商品」属正常运营 | 不做积分提现、不做抽奖/盲盒/签到；**须在小程序内公示获取规则与有效期** |
| 优惠券 | 自建券在下单前减价，微信支付只看到实付金额，无资质无预算无审批。微信支付「代金券」定向赔偿不灵活，「商家券」2025-12-15 起停止新接入 | 全部自建；不接微信营销工具 |
| 小程序权限 | 不新增。不取手机号（省 0.03 元/次且免改隐私保护指引），积分与券绑 openid | `app.json` 无新增 `requiredPrivateInfos`；隐私指引不动 |
| 订阅消息 | 「积分到账 / 券到期」是否在餐饮类目公共模板库中未确认 | 本轮**不发**任何会员类订阅消息，改用页内角标；列二期 |
| 发货信息管理 | 无新增虚拟商品订单（P3 否掉了 0 元兑换单） | 不受影响 |

---

## 3. 业务流程（端到端）

### 3.1 顾客侧
1. **入口**：封面「会员中心 / 优惠券 / 积分商城」→ `pages/member/index` / `member/coupons` / `member/mall`；「我的」页头新增积分与券条。
2. **会员中心**：积分余额大字、「N 分将于 X 月 X 日过期」提示、可用券张数；五个入口（积分商城 / 我的券 / 领券中心 / 积分明细 / 规则说明）。规则说明页展示 `member.rulesText` + 系统生成的「每消费 1 元得 N 分、有效期 M 天、积分不可提现不可转让、退款按比例扣回」（合规公示要求）。
3. **积分商城**（`member/mall`）：Tab「换券」列 `source=POINTS` 的模板（名称/面额/门槛/渠道/积分价/剩余可兑换次数），点「兑换」→ 二次确认 → 到账 toast，券进「我的券」；Tab「随单赠品」列 `PointsGood`（商品图/名/规格/积分价/限购），按钮「去下单」按 `product.channel` 跳同城菜单或邮寄首页（赠品在结算页加购，此处只种草）。
4. **领券中心**（`member/claim`）：列 `source=CAMPAIGN` 且在架的模板，显示「已领 x/y」，点「领取」→ 到账；已达每人上限的按钮置灰。
5. **我的券**（`member/coupons`）：三 Tab 可用 / 已用 / 已过期；卡片展示面额、门槛、渠道标签、有效期、来源（「客服补偿」「积分兑换」「活动领取」「新人礼」）。
6. **结算**（邮寄 `order/confirm`、同城 `local/confirm` 共用组件）：
   - 进页调 `GET /member/checkout-options?channel=&subtotal=` → 可用券（服务端已按渠道/门槛/有效期过滤并按面额降序）、不可用券及原因、可选赠品、积分余额、本单预计得分。
   - 券行：默认**自动选中面额最大的可用券**，可点开切换或「不使用优惠券」。
   - 赠品区：每项 stepper（0..`perOrderLimit`），实时扣减显示的可用积分；余额不足的项置灰。
   - 金额区：小计 / 优惠 −X / 运费 / 实付；底部「预计可得 N 积分」。
   - 提交带 `couponId` 与 `gifts`，服务端重算，不信任前端。
7. **订单详情/列表**：金额区多一行「优惠券 −X」；商品区赠品行带「赠」角标、价格显示为「N 积分」；已完成订单显示「本单获得 N 积分」。
8. **积分明细**（`member/points-log`）：按时间倒序的流水，每行「+/−N ｜ 类型文案 ｜ 关联订单号 ｜ 时间」，分页。

### 3.2 店员侧
1. **赔偿券**（核心场景）：订单详情或售后面板点「发赔偿券」→ 弹窗选券模板 + 填备注（必填，如「配送超时补偿」）→ 二次确认 → 发放。券自动带上该订单号作 `sourceRef`、当前管理员作 `issuedBy`。可以**只发券不退款**，也可以退款后再发。
2. **用户页**：列表新增「积分」「可用券」两列；行操作「发券」「积分明细」「券记录」。
3. **券模板管理**（`Coupons.tsx`）：新建/编辑/停用；列表显示已发放数、已使用数；`source=CAMPAIGN` 的可设总量与每人限领；`source=POINTS` 的必须填积分价。
4. **赠品管理**（`PointsGoods.tsx`）：从商品库选商品（有 SKU 则选到 SKU）、定积分价、每单限购、可选总量上限；渠道随商品只读显示。
5. **会员设置**（`MemberSettings.tsx`）：积分总开关、每元得分比例、积分有效期天数、新客券模板选择（可选「不发」）、规则文案。

---

## 4. 数据模型

迁移 `<晚于同城最新迁移的时间戳>_member_points_coupon`。**时间戳必须晚于同城分支最新的 `20260905000000`**，否则 shadow DB 回放失败。金额与积分一律 `Int`（分 / 分值），状态一律 `String` + 注释枚举，表名 `@@map` 蛇形——与全项目一致。

```prisma
model User {
  pointsBalance Int @default(0) @map("points_balance")   // 冗余 = 未过期 EARN 行 remaining 之和
}

// 积分流水。余额可由本表重算，出账必留痕
model PointsLedger {
  id           Int       @id @default(autoincrement())
  userId       Int       @map("user_id")
  // EARN 消费得分 | REDEEM 兑换券 | GIFT 随单赠品 | GIFT_REVERT 未支付取消退回
  // | REFUND_DEDUCT 退款扣回 | EXPIRE 过期 | ADMIN 手动调整(预留,本轮无入口)
  type         String    @db.VarChar(16)
  delta        Int                                        // 正=入账 负=出账
  balanceAfter Int       @map("balance_after")
  remaining    Int       @default(0)                      // 仅 EARN：该笔尚未被消耗/过期的余量
  refType      String    @map("ref_type") @db.VarChar(16) // ORDER | COUPON | REFUND | LEDGER
  refId        String    @map("ref_id") @db.VarChar(32)
  remark       String?   @db.VarChar(255)
  expiresAt    DateTime? @map("expires_at")               // 仅 EARN
  createdAt    DateTime  @default(now()) @map("created_at")
  user User @relation(fields: [userId], references: [id])
  @@unique([type, refType, refId])                        // 幂等防线：同一单只能发一次分
  @@index([userId, createdAt])
  @@index([userId, type, expiresAt])                      // FIFO 扣减与过期扫描
  @@map("points_ledgers")
}

// 券模板：店员定义的券种
model CouponTemplate {
  id           Int      @id @default(autoincrement())
  name         String   @db.VarChar(64)
  description  String?  @db.VarChar(255)
  amount       Int                                        // 减免金额(分)
  threshold    Int      @default(0)                       // 满多少可用(分)，0 = 代金券
  channel      String   @default("ALL") @db.VarChar(16)   // ALL | LOCAL | EXPRESS
  validDays    Int      @map("valid_days")                // 领取后 N 天有效
  source       String   @db.VarChar(16)                   // ADMIN | POINTS | CAMPAIGN | NEWCOMER
  pointsCost   Int?     @map("points_cost")               // source=POINTS 必填
  totalLimit   Int?     @map("total_limit")               // source=CAMPAIGN 可选总量
  perUserLimit Int?     @map("per_user_limit")
  issuedCount  Int      @default(0) @map("issued_count")
  status       String   @default("ON") @db.VarChar(16)    // ON | OFF
  sortOrder    Int      @default(0) @map("sort_order")
  createdAt / updatedAt
  coupons UserCoupon[]
  @@index([source, status, sortOrder])
  @@map("coupon_templates")
}

// 发到某个人手里的一张券。面额等字段快照自模板，模板停用/改价不影响已发券
model UserCoupon {
  id         Int       @id @default(autoincrement())
  userId     Int       @map("user_id")
  templateId Int       @map("template_id")
  code       String    @unique @db.VarChar(32)            // 展示与客服核对用
  name       String    @db.VarChar(64)                    // ↓ 四个快照字段
  amount     Int
  threshold  Int       @default(0)
  channel    String    @default("ALL") @db.VarChar(16)
  status     String    @default("UNUSED") @db.VarChar(16) // UNUSED | USED | EXPIRED
  source     String    @db.VarChar(16)                    // 同模板 source
  sourceRef  String?   @map("source_ref") @db.VarChar(64) // 赔偿时 = 关联订单号
  issuedBy   String?   @map("issued_by") @db.VarChar(64)  // 赔偿时 = 操作管理员
  remark     String?   @db.VarChar(255)                   // 赔偿原因
  expiresAt  DateTime  @map("expires_at")
  usedAt     DateTime? @map("used_at")
  orderId    Int?      @map("order_id")
  createdAt  DateTime  @default(now()) @map("created_at")
  user     User           @relation(fields: [userId], references: [id])
  template CouponTemplate @relation(fields: [templateId], references: [id])
  @@index([userId, status, expiresAt])
  @@index([orderId])
  @@index([status, expiresAt])                            // 过期扫描
  @@map("user_coupons")
}

// 可用积分加购的随单赠品
model PointsGood {
  id            Int    @id @default(autoincrement())
  productId     Int    @map("product_id")
  skuId         Int?   @map("sku_id")
  pointsCost    Int    @map("points_cost")
  perOrderLimit Int    @default(1) @map("per_order_limit")
  stockLimit    Int?   @map("stock_limit")                // 可选总量，NULL = 不限
  issuedCount   Int    @default(0) @map("issued_count")
  status        String @default("ON") @db.VarChar(16)
  sortOrder     Int    @default(0) @map("sort_order")
  createdAt / updatedAt
  @@unique([productId, skuId])   // 注意：MySQL 唯一索引不约束 NULL，无 SKU 商品需在代码里
                                 // 先 findFirst 再插（与 Cart 表同款处理）
  @@index([status, sortOrder])
  @@map("points_goods")
}

model Order {
  couponId        Int?      @map("coupon_id")             // 普通 Int 列，不建关系字段
  discountAmount  Int       @default(0) @map("discount_amount")
  pointsUsed      Int       @default(0) @map("points_used")    // 赠品消耗
  pointsEarned    Int       @default(0) @map("points_earned")  // 实际发放量，可能为 0
  pointsSettledAt DateTime? @map("points_settled_at")     // 结算标记：非空 = 已处理，不再重扫
  // actualAmount = totalAmount − discountAmount + shippingFee
  @@index([status, pointsSettledAt, completedAt])         // 兜底任务扫描用
}

model OrderItem {
  isGift     Boolean @default(false) @map("is_gift")      // 赠品行：productPrice/subtotal = 0
  pointsCost Int     @default(0) @map("points_cost")
}
```

**设置**（`Setting` key `member`，`services/member/settings.ts`，复用 `settings.ts` 范式）：
```ts
interface MemberSettings {
  points: { enabled: boolean; earnRatePerYuan: number; validDays: number }  // 默认 true / **100** / 365（PO 2026-09-05 定 100 分/元）
  // ⚠️ earnRatePerYuan=100 意味着一单 ¥28 = 2800 分，赠品与换券的积分价必须按这个量级重定
  newcomer: { templateId: number | null }                                   // 默认 null = 不发
  rulesText: string                                                         // 规则说明补充文案
}
```
无新增 env、无新增密钥。

---

## 5. 服务端：核心规则（写死，不留给实施临场决定）

### 5.1 计价顺序（唯一实现在 `createOrder`）
```
subtotal  = Σ(非赠品行 unitPrice × qty)
discount  = coupon ? min(coupon.amount, subtotal) : 0        // 券只减商品，永不减出负数
shippingFee = 按【券前 subtotal】判定满额包邮 / 起送 / 同城起送后算出
actualAmount = subtotal − discount + shippingFee
```
- **门槛与包邮一律比对券前 `subtotal`**：顾客不会因为用券而失去包邮、或跌破起送线。
- 赠品行不进 `subtotal`（`productPrice = 0`、`subtotal = 0`），也不参与门槛判定。
- 微信支付金额 = `actualAmount`。同城 `quoteToken` 只管运费，与券正交，不需要改签名载荷。
- `actualAmount` 允许为 0 吗？**不允许**：券面额上限即商品小计，若 `actualAmount === 0`（例如全额券 + 免运费）则返回 42251，提示「该券金额已超过本单可抵扣范围」。理由：0 元订单无法走微信支付，会掉进无支付回调的死角。

### 5.2 券的使用（下单事务内）
1. 事务前校验：券属于该用户、`status=UNUSED`、`expiresAt > now`、`channel ∈ {ALL, 本单渠道}`、`subtotal >= threshold`；任一不满足 → 42251（错误消息区分四种原因）。
2. 事务内核销：`updateMany({ where: { id, userId, status: 'UNUSED' }, data: { status: 'USED', usedAt, orderId } })`，`count === 0` → 42251「优惠券已被使用」（并发防线）。
3. 一单一券。多券叠加列二期。

### 5.3 赠品（下单事务内）
1. 校验每项 `PointsGood.status=ON`、`qty <= perOrderLimit`、`stockLimit` 未耗尽、商品在架、`product.channel` 与本单渠道一致（否则 42252 / 42224）。
2. 总积分 `pointsUsed = Σ(pointsCost × qty)`，走 §5.4 的 FIFO 扣减；余额不足 → 42250。
3. 赠品行写入 `OrderItem(isGift=true, productPrice=0, subtotal=0, pointsCost)`，**照常扣真实库存**（与普通行同一段 `updateMany` 原子扣减逻辑）。
4. `PointsGood.issuedCount` 用 `updateMany({ where: { id, ...(stockLimit != null ? { issuedCount: { lt: stockLimit } } : {}) } })` 原子递增。

### 5.4 积分账本
- **可用积分行**统称「入账行」：`type IN ('EARN','GIFT_REVERT') && remaining > 0 && expiresAt > now`。下文的 FIFO 扣减与过期扫描都以此为准。
- **FIFO 扣减** `consumePoints(tx, userId, amount, {type, refType, refId, remark})`：按 `expiresAt ASC, id ASC` 取入账行，逐行 `updateMany({ where: { id, remaining: { gte: take } }, data: { remaining: { decrement: take } } })`，`count === 0` 说明被并发抢走 → 重取一次，两轮仍不足 → 42250。写一条负 delta 流水 + `User.pointsBalance decrement`。
- **发放** `settlePoints(orderId)`：
  - 前置：`order.status === 'COMPLETED'`、`order.isTest !== true`、`order.pointsSettledAt === null`、`member.points.enabled`。
  - `earn = Math.floor((actualAmount − refundedAmount) / 100) × earnRatePerYuan`。
  - `earn <= 0`（小额单、或已全额退款）：只写 `pointsSettledAt = now`、`pointsEarned = 0`，**不写流水**。
  - `earn > 0` 事务：insert `PointsLedger(EARN, delta=earn, remaining=earn, refType='ORDER', refId=orderId, expiresAt=completedAt+validDays)` → `@@unique` 冲突（P2002）说明并发已发过，吞掉并补写标记；`Order.pointsEarned = earn` + `pointsSettledAt = now`；`User.pointsBalance increment`。
  - **`pointsSettledAt` 是唯一的「已处理」标记**，不能用 `pointsEarned === 0` 代替——否则 `earn=0` 的订单会被兜底任务每分钟重扫一次，永不停止。
  - 调用点：`PUT /orders/:id/confirm`、`autoCompleteShippedOrders`、同城 520 回调、店员「标记已送达」——**全部 fire-and-forget，失败不影响主流程**，由兜底任务补。
- **兜底** scheduler `settleMissedPoints`：每分钟扫 `status='COMPLETED' && pointsSettledAt IS NULL && isTest = false && completedAt BETWEEN now−7d AND now−2min`，批 100，逐单调 `settlePoints`。
  - 下界 7 天有两个作用：积分开关从关到开时，不会突然给历史全量订单补发；`enabled=false` 期间积压的订单也不会无限扫描。开关关闭时该任务直接跳过。
- **过期** scheduler `expirePoints`：每日一次，扫 `type IN ('EARN','GIFT_REVERT') && remaining > 0 && expiresAt < now`，批 200：每行 `remaining → 0` + 写 EXPIRE 流水（`refType='LEDGER'`, `refId = 被过期的那行 id`，故 `@@unique` 天然防重）+ `pointsBalance decrement`。

- **⚠️ 有效期改为「最后一次消费起算」的滚动续期（PO 2026-09-05 定）**

  原设计是**按批过期**：每笔积分从它自己产生那天起算 `validDays`，一批一批陆续掉。
  PO 要求改成**账户级**：积分的到期日 = 最后一次消费 + `validDays`（已定 **365 天**）；
  只要顾客还在消费，全部积分一直不过期；`validDays` 天不消费，账户内积分**一次性全部清零**。

  **实现方式（刻意选择保留既有机制，不推翻）**：每行仍然各自存 `expiresAt`，
  只是在 `settlePoints` 成功后追加一步——把该用户**全部未过期入账行**的 `expiresAt`
  统一推到 `completedAt + validDays`：

  ```
  await tx.pointsLedger.updateMany({
    where: { userId, type: { in: ['EARN','GIFT_REVERT'] }, remaining: { gt: 0 }, expiresAt: { gt: now } },
    data:  { expiresAt: addDays(completedAt, validDays) },
  })
  ```

  这样 FIFO 扣减、`expirePoints` 扫描、`GIFT_REVERT` 继承最早到期日**全都不用改**——
  它们读的仍然是行上的 `expiresAt`，只是这个值会被续期推后。

  **触发点是订单完成，不是付款**：与发积分同一时刻同一钩子，且下单后取消/退款的单
  不会白白帮顾客续期一年。

  **对顾客文案的影响**：会员中心原设计的「N 分将于 X 月 X 日过期」（某一批分）在滚动
  续期下不成立，必须改成账户级口径「若 1 年内无消费，您的 N 分将于 X 月 X 日全部过期」。
  规则页与协议的**权威定稿见 `docs/member-terms-copy.md`**，一字照抄。

  **副作用要认下来**：流失顾客是悬崖式清零（攒了一年的分一次性归零，包括昨天刚得的）。
  PO 已知悉，并因此把窗口从最初提的 3 个月放宽到 1 年。
- **退款扣回**（在 `finalizeRefundSuccess` 内，退款成功写完之后）：
  - 条件：`order.pointsEarned > 0`。已扣回量 = 该订单 `REFUND_DEDUCT` 流水 delta 绝对值之和。
  - `deduct = min( floor(refund.amount / 100) × rate , pointsEarned − 已扣回 , user.pointsBalance )` → **不会出现负余额，也不会扣超过这单给过的分**。
  - 扣减顺序：先扣该订单那条 EARN 行的 `remaining`，不足再按 FIFO 扣其他 EARN 行；仍不足就扣到 0 为止（用户已经花掉了，不追）。
  - 写 `REFUND_DEDUCT` 流水，`refType='REFUND'`，`refId = refund.id`（同一单可多次部分退款，用 refund.id 才不会撞 `@@unique`）。
  - `deduct === 0` 时不写流水（不必留痕，因为没扣任何东西）。
- **券与赠品在退款时一律不动**（P7）：券不退回、赠品积分不退。顾客端与店员手册都要写明。

### 5.5 未支付取消时的释放
`PUT /orders/:id/cancel`（PENDING_PAYMENT 分支）与 scheduler `cancelExpiredOrders` 共用一个 `releaseOrderBenefits(tx, order)`：
- 券：`updateMany({ where: { id: couponId, status: 'USED', orderId }, data: { status: 'UNUSED', usedAt: null, orderId: null } })`；**若 `expiresAt < now` 则改置 `EXPIRED`**（过期券不还给顾客用，但也不留在 USED 状态误导）。
- 赠品积分：写一条 `GIFT_REVERT` 入账行（正 delta，`refType='ORDER'`, `refId=orderId`，`remaining = delta`），`expiresAt` 取**本单当初被扣掉的那些行里最早的到期时间**——退回来的积分不该比原来更耐用。该行按 §5.4 的定义属于入账行，与 EARN 一同参与 FIFO 扣减与过期。
- 释放整体幂等：`GIFT_REVERT` 的 `@@unique([type, refType, refId])` 保证同一单只退一次；券的条件更新保证只回滚一次。
- `PointsGood.issuedCount` 递减；库存回滚沿用 `rollbackOrderStock`。

### 5.6 券的发放（四条来源，各自幂等）
| 来源 | 入口 | 幂等/限制 |
|---|---|---|
| NEWCOMER | `wechat-login` 创建 User 成功后 fire-and-forget | 查 `UserCoupon(userId, templateId, source='NEWCOMER')` 存在则跳过；老用户不补发；模板为 null 或 OFF 时跳过 |
| POINTS | `POST /member/points/redeem { templateId }` | 事务：FIFO 扣分 → 发券 → 写 REDEEM 流水（`refType='COUPON'`, `refId=userCouponId`）；`perUserLimit` 用该用户该模板已发数判定 |
| CAMPAIGN | `POST /member/coupons/claim { templateId }` | `updateMany({ where: { id, status:'ON', ...(totalLimit != null ? { issuedCount: { lt: totalLimit } } : {}) }, data: { issuedCount: { increment: 1 } } })`，`count===0` → 42253；再发券 |
| ADMIN | `POST /admin/users/:id/coupons { templateId, remark, orderNo? }` | 无数量上限；`remark` 必填；记 `issuedBy`（当前管理员）与 `sourceRef=orderNo`；admin 侧限流 |

- 发券公共函数 `issueCoupon(tx, { userId, template, source, sourceRef, issuedBy, remark })`：生成 `code`（`C` + 8 位 base32 随机，`@unique` 冲突重试 3 次）、快照四字段、`expiresAt = now + validDays`。
- **券过期** scheduler `expireCoupons`：每日扫 `status='UNUSED' && expiresAt < now` 批量置 `EXPIRED`；所有读取路径同样按 `expiresAt` 判定，不依赖任务准时。
- 模板 `status=OFF` 只挡住再发放，已发的券照常可用。
- **不发任何会员类订阅消息**（§2），靠「我的」页与会员中心的角标。

### 5.7 越权与滥用
- 所有 `/member/*` 端点走现有用户鉴权中间件，一律 `where: { userId: req.user.id }`，绝不接受前端传 userId。
- `POST /admin/users/:id/coupons` 记录操作人与备注，用户页可查该用户全部券的发放记录（来源、操作人、备注、时间）。
- 兑换/领取端点加用户维度限流（复用 `rate-limit.ts` 的 `ipKeyGenerator` 兜底写法）。
- 顾客端返回的券对象用显式 `select` 白名单，不返回 `templateId` 之外的内部字段与 `issuedBy`。

### 5.8 定时任务（新增 3 项，插入 `scheduler.ts` 的任务表）
`settleMissedPoints`（每分钟）、`expirePoints`（每日）、`expireCoupons`（每日）。每日任务用「上次执行时间存 `Setting` key `member_cron_state`」的方式判定，避免进程重启后重复跑或整天不跑。三者均独立 try/catch + `notifySystemAlert` 失败告警。

### 5.9 接口清单
- 用户态：`GET /member/summary`（积分余额 / 即将过期分与日期 / 可用券数）、`GET /member/points/ledger?page=`、`GET /member/coupons?status=`、`GET /member/mall`（换券模板 + 赠品）、`POST /member/points/redeem`、`GET /member/campaign`（领券中心）、`POST /member/coupons/claim`、`GET /member/checkout-options?channel=&subtotal=`。
- 下单：`POST /orders` 增加可选 `couponId`、`gifts: [{ pointsGoodId, quantity }]`。
- 管理：`GET/POST/PUT /admin/coupon-templates`、`GET /admin/coupon-templates/:id/issued`、`GET/POST/PUT/DELETE /admin/points-goods`、`GET/PUT /admin/settings/member`、`POST /admin/users/:id/coupons`、`GET /admin/users/:id/points-ledger`、`GET /admin/users/:id/coupons`；`GET /admin/users` 返回体加 `pointsBalance` 与 `availableCoupons`。
- 非生产：`POST /admin/system/run-scheduler` 已有，扩展 overrides 让 e2e 能强制触发三个新任务。

### 5.10 错误码
`42250` 积分不足 · `42251` 优惠券不可用（已用/过期/渠道不符/未达门槛/超出可抵扣范围） · `42252` 赠品超出限购或已兑完 · `42253` 该券已领完或已达每人上限 · `42254` 券模板已停用。
（`4225x` 段全项目零占用，已核。）

---

## 6. 小程序（apps/miniapp）

- 新增页面：`pages/member/index`、`member/mall`、`member/coupons`、`member/claim`、`member/points-log`，全部登录后可见（未登录点入口先走 `_tryLogin`）。
- 新增组件 `components/checkout-benefits`：入参 `channel / subtotal / options`，出参 `couponId / gifts / discount`；邮寄 `order/confirm` 与同城 `local/confirm` 各接一次，**金额计算只用服务端返回值**，本地不重算优惠。
- `pages/order/detail`、`order/list`：优惠行、赠品角标、「本单获得 N 积分」。
- `pages/user/index`：页头下方加积分/券条（`wxml:18-21` 位置），菜单区加「我的券」。
- 封面页（在同城分支）：三入口按 P10 接线，「会员储值」改词为「优惠券」→ `pages/member/coupons`。
- `config/legal.js`：隐私政策无需改动（不新增个人信息收集）；**服务协议/用户须知补一节积分与优惠券规则**（获取、有效期、不可提现、退款不退券）。
- 预览台 `tools/miniapp-preview/`：补 5 个镜像页与结算页优惠区。

---

## 7. 后台（apps/admin）

- `Layout.tsx` 导航新增两项：「营销」（下挂券模板与赠品，或平铺两项）、「会员设置」。
- `pages/Coupons.tsx`：模板列表（名称/面额/门槛/渠道/来源/有效期/已发/已用/状态）+ 新建编辑弹窗 + 停用；`source` 选择后动态显隐 `pointsCost` / `totalLimit` / `perUserLimit`；手机端 `mobileCards`。
- `pages/PointsGoods.tsx`：选商品（复用现有商品选择器逻辑）→ 选 SKU → 积分价 / 每单限购 / 总量；列表显示渠道（只读，随商品）。
- `pages/MemberSettings.tsx`：开关、每元得分、有效期天数、新客券下拉（列 `source=NEWCOMER` 的模板 + 「不发」）、规则文案；保存前校验比例 > 0、有效期 ≥ 1。
- `pages/Users.tsx`：加「积分」「可用券」列；行操作「发券」（弹窗：选模板 + 备注必填 + 二次确认）、「积分明细」抽屉、「券记录」抽屉。
- `pages/Orders.tsx` + `components/AfterSalePanel.tsx` + `components/RefundDialog.tsx`：订单展开区显示「优惠券 −X（券名）」与赠品行；`RefundDialog` 上方加一行灰字「本单实付 ¥X（已用券 ¥Y）」避免店员按商品原价退；订单详情与售后面板加「发赔偿券」按钮（与退款并列，可单独使用）。
- `types.ts` / `api/admin.ts`：补类型与端点包装。

---

## 8. 里程碑

- **M1 账本与规则**（先做，纯服务端）：迁移；`services/member/{settings,points,coupons}.ts`；`settlePoints` 挂钩 COMPLETED 各路径；`finalizeRefundSuccess` 扣回；登录发新客券；三个 scheduler 任务；`/member/summary|points/ledger|coupons` 只读端点；e2e 覆盖发放幂等、FIFO 扣减、过期、退款扣回不为负、测试单不发分。
- **M2 结算链路**：`GET /member/checkout-options`；`POST /orders` 券与赠品分支（含 §5.1–5.3 全部校验）；`releaseOrderBenefits`；退款上限回归；订单详情返回优惠字段；同城票面与工作台显示优惠。
- **M3 后台**：三个管理页 + 用户页积分/券列与三个操作 + 订单/售后面板赔偿券按钮与优惠显示。
- **M4 小程序**：会员五页 + `checkout-benefits` 组件接入两个结算页 + 订单详情/列表 + 「我的」页头 + 封面入口接线 + 预览台镜像。
- **M5 联调与文档**：真机一分钱走「用券下单 → 赠品 → 完成得分 → 部分退款扣回」全链路；`docs/staff-guide.md` 新增「优惠券与积分」章节（含赔偿券话术与「退款不退券」的解释口径）；`docs/api.md`；`docs/requirement.md` 移除「积分系统 / 复杂优惠券 = 后续规划」两行；`docs/miniapp-release-checklist.md` 增加「积分规则已在小程序内公示」检查项。

每个里程碑完成后由不同模型审阅（架构/资金一致性 + 文案/边界），意见回流后再合并。

---

## 9. 验证

**e2e（`scripts/e2e.sh` 追加用例，`WECHAT_PAY_MOCK=true`）**
- 积分：完成订单发分且金额正确；重复触发只发一次；`isTest` 单不发分；`earn=0` 时不写流水；兜底任务能补发漏挂的单。
- FIFO：造两笔不同到期日的 EARN，兑换后先消耗早到期那笔；余额不足返回 42250。
- 过期：把 EARN 的 `expiresAt` 改到过去 → 跑 `expirePoints` → `remaining=0`、余额同步、流水存在；已过期的分不能再用于兑换。
- 退款扣回：完成单发 100 分 → 部分退款 → 扣回按比例且 ≤ 已发；连续两次部分退款累计不超发放量；用户已花光积分时扣到 0 不为负。
- 券：满额判定用券前小计（造一单「小计刚好等于包邮线、用券后低于线」→ 断言运费为 0）；渠道不符 42251；过期券 42251；并发用同一张券只有一次成功；`actualAmount` 归零时 42251。
- 赠品：超 `perOrderLimit` 42252；库存被真实扣减；跨渠道赠品 42224。
- 未支付取消：券回 UNUSED、赠品积分回账、库存回滚、`PointsGood.issuedCount` 递减；已过期的券置 EXPIRED 而非 UNUSED。
- 领券中心：`totalLimit` 并发领取不超发；`perUserLimit` 生效。
- 新客券：首次登录发一张，再次登录不重复发。
- 越权：A 用户不能用 B 的券、不能查 B 的流水。

**纯函数自测** `apps/server/scripts/selftest-member.ts`：计价顺序（券/门槛/包邮组合矩阵）、`earn` 取整、扣回上限公式、`code` 生成唯一性。

**后台浏览器实测**（桌面 + 375px）：券模板增删改停用、赠品选品、会员设置校验、用户页发券弹窗与两个抽屉、订单展开区优惠显示、售后面板赔偿券。

**小程序**：预览台五页截图 + 结算页优惠区；真机走 §8 M5 的全链路。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 券让 `actualAmount` 归零导致无支付回调的死单 | §5.1 直接拒绝，返回 42251 |
| 积分发放漏挂钩子（COMPLETED 有多条路径，同城还会再加） | `settleMissedPoints` 每分钟兜扫 + `@@unique` 幂等；钩子只是加速 |
| 并发用同一张券 / 抢同一个限量券 | 券核销与 `issuedCount` 递增都用 `updateMany` 条件更新判 count |
| 积分余额与流水对不上 | `remaining` 逐行扣减 + 余额是冗余；提供 `scripts/check-points-consistency.mjs`（余额 = Σremaining）接进 e2e |
| 店员把用券订单按原价退款 | `RefundDialog` 显式展示实付与券额；退款上限由服务端 `remainingRefundable` 兜住 |
| 顾客投诉「退款为什么不退券」 | 规则页与订单详情写明；`staff-guide.md` 给统一话术 |
| 赠品被薅（0 元拿货） | 赠品必须随付费订单；`perOrderLimit` + 可选 `stockLimit` + 积分本身来自消费 |
| 微信审核对「积分商城」提出规则公示要求 | 规则说明页在 M4 一并上线，列入发版检查项 |

---

## 11. 硬依赖与开工时机（重要）

1. **`Order.isTest` 只存在于同城分支**（`claude/same-city-delivery-plan-2ffa20`），生产与 main 都没有。§5.4 的「测试单不发积分」依赖它，因此**会员代码不得早于同城合并进 main**。若确需提前，必须先把 `isTest` 单独摘出来落 main，否则该规则无法实现。
2. **代码阶段的解锁条件不是「同城合并」四个字**。2026-09-04 实测：生产 `https://api.yuegui-hotel.online/api/local/meta` 返回 404，生产机 `/www/food-shop` 的 HEAD 是 `ca37137`（无同城代码、无 `apps/miniapp/pages/local/`），`scripts/deploy.sh` 从 `origin/main` 拉取而同城分支未合并未推送。完整路径是：**合并 → 部署 → 后台配同城设置与 LOCAL 商品 → 上传体验版 → 真机真钱联调 → 提审发布**。排期按这条路径估。
3. 迁移时间戳必须晚于同城分支当时的最新迁移（截至 2026-09-04 是 `20260905000000`），落地前重新确认一次。
4. 封面画稿「会员储值 → 优惠券」的改词**由封面所在分支执行**，本分支不碰 `docs/design/`。交接内容：按钮文案改「优惠券」，点击后 `wx.navigateTo('/pages/member/coupons')`；另两颗分别指向 `/pages/member/index` 与 `/pages/member/mall`。

---

## 12. 明确不做（二期）

储值与余额支付；赔偿积分（赔偿一律用券）；折扣券、商品券、多券叠加；券到期与积分到账的订阅消息提醒；微信支付代金券/商家券对接；积分抽奖、盲盒、签到、分享得分；积分兑换实物的单独发货订单；会员等级与成长值；积分转赠。
