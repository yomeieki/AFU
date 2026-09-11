# 订单流程设计文档

## 一、完整下单流程

```
用户端
│
├─ 1. 浏览商品
│     └─ GET /api/products（列表）
│     └─ GET /api/products/:id（详情）
│
├─ 2. 加入购物车 或 立即购买
│     ├─ 加入购物车：POST /api/cart
│     └─ 立即购买：直接携带 productId + quantity 进入确认订单页
│
├─ 3. 填写/选择收货地址
│     ├─ GET /api/addresses（选择已有地址）
│     └─ POST /api/addresses（新增地址）
│
├─ 4. 确认订单页
│     ├─ 展示：商品信息、收货地址、配送方式、运费、订单备注
│     └─ 展示：金额合计（前端仅展示，不计算最终价格）
│
├─ 5. 提交订单
│     └─ POST /api/orders
│           请求参数：cartItemIds / productId+quantity, addressId, deliveryType, remark
│           后端：验证商品状态和库存 → 计算金额 → 创建订单 → 减库存 → 清购物车
│           响应：orderId, orderNo, actualAmount, status=PENDING_PAYMENT
│
├─ 6. 支付
│     ├─ 第一阶段（Mock Payment）
│     │     └─ 点击"模拟支付成功" → POST /api/payments/mock/success
│     │           后端：验证订单状态为 PENDING_PAYMENT → 更新为 PAID → 记录支付时间
│     │
│     └─ 第二阶段（微信支付）
│           └─ POST /api/payments/wechat/prepay → 返回支付参数
│           └─ wx.requestPayment → 用户付款
│           └─ 微信回调 POST /api/payments/wechat/notify
│                 后端：验签 → 幂等检查 → 更新订单为 PAID
│
├─ 7. 支付成功页
│     └─ 展示订单号、金额、跳转"查看订单"
│
└─ 8. 我的订单
      └─ GET /api/orders?status=PAID（待发货）
      └─ GET /api/orders/:id（订单详情）
```

---

## 二、发货流程

```
后台管理员
│
├─ 1. 查看待发货订单
│     └─ GET /api/admin/orders?status=PAID
│
├─ 2. 门店备货
│     └─ 线下操作
│
├─ 3. 填写发货信息
│     └─ POST /api/admin/orders/:id/ship
│           参数：expressCompany, expressNo
│           后端：创建 shipments 记录 → 更新订单状态为 SHIPPED
│
└─ 4. 用户查看物流信息
      └─ GET /api/orders/:id（含 shipment 字段）
```

---

## 三、订单状态流转图

```
创建订单
    │
    ▼
PENDING_PAYMENT（待付款）
    │
    ├──── 超时未付款（15 分钟，定时任务自动取消+回滚库存+微信关单）► CANCELLED（已取消）
    │
    ├──── 用户主动取消 ─────────────────────────────────────► CANCELLED（已取消）
    │
    ▼
PAID（已付款 / 待发货）
    │
    ├──── 用户申请退款 ──────────────────────────────────────► REFUNDING（退款中）
    │                                                              │
    │                                                              ▼
    │                                                         REFUNDED（已退款）
    │
    ▼
SHIPPED（已发货）
    │
    ├──── 用户确认收货 ──────────────────────────────────────► COMPLETED（已完成）
    │
    └──── 系统自动完成（发货 7 天后定时任务）───────────────► COMPLETED（已完成）
```

**到店自取（deliveryType=PICKUP，2026-09-11）**：复用同一套状态，只改语义——

    PAID（待接单）→ 店员接单 → PREPARING（备餐中）→ 店员「已备好」→ SHIPPED（待取餐，发取餐提醒）
    → 店员「已取走」→ COMPLETED；取餐时间 + autoCompleteAfterMin 仍未点则系统自动完成并推送。

    取消：PAID 且未到「开始备餐时刻」（取餐时间 − 备餐 − 接单缓冲）→ 顾客自助秒退；
          之后（含 PREPARING）只能「申请取消」，店员同意 = 全额退，**不自动驳回**；
          点「已备好」时若有未处理申请视同驳回；SHIPPED/COMPLETED 走售后。
    自取单没有 Shipment 行，「发货 7 天自动完成」天然不碰它；填单号发货、标记完成、顾客确认收货一律 42284。

部分退款（不改变订单状态）：PAID / PREPARING / SHIPPED / COMPLETED 任一状态下，商家可发起 amount < 可退余额 的退款，
成功后 order.refundedAmount 累加，订单继续履约；退完全部余额即视为全额退款，走 REFUNDING → REFUNDED。

**已支付后的退款一律不释放会员优惠**（刻意的不对称）：

    库存 回滚 · 销量 回滚 · 优惠券 不退 · 赠品积分 不退 · 赠品名额 不回落

库存回滚是因为货是实物、退了就该能再卖；券与名额不回滚是因为「下单即退」就能白嫖一张券、
或者占掉限量赠品的名额。**退款路径一处都不调 `releaseOrderBenefits`。**

已发放的积分按**退款金额比例扣回**：`points_earned × 退款额 / points_base`，与当前的
`earnRatePerYuan` 无关（`points_base` 是发分那一刻的基数快照，所以店主改比例不影响历史单）。
扣回不超过本单发放过的量，也不会让余额变成负数；只从「在世」的入账行扣，不碰到期未清扫的死行。

售后：SHIPPED / COMPLETED 且有可退余额时顾客可提交 AfterSale（PENDING）→ 商家 approve（按金额发起退款，APPROVED → 回调成功 DONE）或 reject（REJECTED）。
```

**状态流转规则：**

| 当前状态 | 允许转换到 | 操作方 |
|----------|------------|--------|
| PENDING_PAYMENT | PAID | 系统（支付成功回调） |
| PENDING_PAYMENT | CANCELLED | 用户、管理员 |
| PAID | SHIPPED | 管理员 |
| PAID | REFUNDING | 用户申请（第一版手动处理） |
| SHIPPED | COMPLETED | 用户确认收货 |
| REFUNDING | REFUNDED | 退款回调 / 管理员手动标记 |
| SHIPPED | COMPLETED | 管理员「标记完成」或定时任务（7 天） |
| COMPLETED | REFUNDING → REFUNDED | 管理员全额退款（货已出不回滚库存） |
| CANCELLED | REFUNDING → REFUNDED | 已取消订单收到迟到的支付成功回调：自动全额退款并告警 |

**禁止的状态变更（后端必须拒绝）：**
- COMPLETED → 任何状态
- CANCELLED → 任何状态
- REFUNDED → 任何状态
- 跳过中间状态（如 PENDING_PAYMENT 直接到 SHIPPED）

---

## 四、创建订单核心逻辑（伪代码）

```javascript
async function createOrder(userId, { cartItemIds, addressId, deliveryType, remark }) {
  // 1. 获取购物车商品（或直接购买商品）
  const cartItems = await getSelectedCartItems(userId, cartItemIds)
  if (cartItems.length === 0) throw new Error('购物车为空')

  // 2. 批量获取商品信息（从数据库，不信任前端价格）
  const productIds = cartItems.map(item => item.productId)
  const products = await getProductsByIds(productIds)

  // 3. 逐个验证商品
  for (const item of cartItems) {
    const product = products.find(p => p.id === item.productId)
    if (!product || product.deletedAt) throw new AppError(40401, '商品不存在')
    if (product.status !== 'ON_SHELF') throw new AppError(42202, `${product.name} 已下架`)
    if (product.stock < item.quantity) throw new AppError(42201, `${product.name} 库存不足`)
  }

  // 4. 获取收货地址
  const address = await getUserAddress(userId, addressId)
  if (!address) throw new AppError(40401, '地址不存在')

  // 5. 计算运费（第一版默认0，后续完善）
  const shippingFee = calculateShippingFee(deliveryType, totalAmount)

  // 6. 计算金额（全部后端计算）
  let totalAmount = 0
  const orderItemsData = []
  for (const item of cartItems) {
    const product = products.find(p => p.id === item.productId)
    const subtotal = product.price * item.quantity
    totalAmount += subtotal
    orderItemsData.push({
      productId: product.id,
      productName: product.name,       // 快照
      productImage: product.coverImage, // 快照
      productPrice: product.price,      // 快照
      quantity: item.quantity,
      subtotal,
    })
  }
  const actualAmount = totalAmount + shippingFee

  // 6b. 会员优惠（M2 起）。顺序是产品决策，不能调：
  //     小计 = Σ 非赠品行
  //     折扣 = 券 ? min(券面额, 小计) : 0        ← 门槛比对的是**小计**
  //     运费 = 按**券前小计**判（包邮/起送/同城起送）← 顾客不因用券失去包邮
  //     实付 = 小计 − 折扣 + 运费
  //
  //     所以第 5 步的 calculateShippingFee 收到的 totalAmount 必须**始终是券前小计**。
  //     实现见 services/member/pricing.ts 的 checkCouponUsable / computeCheckout
  //     （两个纯函数，不 import prisma，便于 selftest 覆盖整个计价矩阵）。
  //
  //     actualAmount === 0 必须拒单（42251）：券把商品减到 0 且免运费在算术上合法，
  //     但微信支付收不了 0 元,会掉进无回调的死角。
  //
  //     赠品行 productPrice/subtotal 恒为 0、isGift=true、pointsCost 记快照；
  //     赠品**计入**同城的件数与重量上限（骑手真要拎）。

  // 7. 生成唯一订单号
  const orderNo = generateOrderNo()

  // 8. 数据库事务：创建订单 + 减库存 + 清购物车
  await prisma.$transaction(async (tx) => {
    // 创建订单
    const order = await tx.order.create({
      data: {
        orderNo,
        userId,
        status: 'PENDING_PAYMENT',
        totalAmount,
        shippingFee,
        actualAmount,
        deliveryType,
        remark,
        // 地址快照
        receiverName: address.receiverName,
        receiverPhone: address.receiverPhone,
        receiverProvince: address.province,
        receiverCity: address.city,
        receiverDistrict: address.district,
        receiverDetail: address.detail,
        receiverFullAddress: address.fullAddress,
        items: { create: orderItemsData }
      }
    })

    // 减库存（并发场景需用乐观锁或数据库原子操作）
    for (const item of cartItems) {
      await tx.product.updateMany({
        where: { id: item.productId, stock: { gte: item.quantity } },
        data: {
          stock: { decrement: item.quantity },
          salesCount: { increment: item.quantity }
        }
      })
      // 验证是否真的减成功
      const updated = await tx.product.findUnique({ where: { id: item.productId } })
      if (!updated) throw new Error('库存扣减失败')
    }

    // 清空购物车对应项
    await tx.cart.deleteMany({
      where: { id: { in: cartItemIds }, userId }
    })

    return order
  })
}
```

---

## 五、订单超时自动取消（已实现：services/scheduler.ts）

进程内 `setInterval` 每 60 秒一轮（PM2 单实例；多实例时其余进程设 `SCHEDULER_DISABLED=true`）：
1. `PENDING_PAYMENT` 且 `createdAt < now - PAY_TIMEOUT_MIN` → 条件 `updateMany` 置 CANCELLED + `rollbackOrderStock` + best-effort 微信关单 `closeOrder`
2. `SHIPPED` 且发货超 `AUTO_COMPLETE_DAYS` → COMPLETED
3. `PAID` 超 15 分钟未接单且未催过 → 企微催单，写 `acceptRemindedAt`
4. 低库存（≤5）每 12 小时推送一次

配套：微信预下单带 `time_expire`（= createdAt + 超时），`/pay` 对超时订单直接拒绝，顾客端按 `payExpireAt` 显示倒计时；
支付回调若命中已 CANCELLED 订单，记账后自动全额退款并告警（`wechat-notify.ts`）。

**会员优惠的释放只发生在「未支付取消」**（四条路径都覆盖：顾客自助取消、超时任务、
管理员取消、商家拒单的待付款分支）：券回 `UNUSED`（**若已过期则置 `EXPIRED`** —— 过期券不还给
顾客用，也不能留在 `USED` 状态误导）、赠品积分退回（`GIFT_REVERT`，沿用原到期日不延长）、
赠品名额 `issued_count` 回落。

判定按**状态守卫**而不是端点白名单（`releaseOrderBenefits` 要求调用方已确认状态翻转成功）——
按端点列名单的话，漏了「拒单的待付款分支」这种路径就是券与积分静默消失，而那条分支正是
第一版差点漏掉的。
非生产环境可 `POST /api/admin/system/run-scheduler {payTimeoutMin,autoCompleteDays,remindAfterMin}` 手动触发（e2e 用）。

---

## 六、用户确认收货（第一版需实现）

用户在订单详情页点击"确认收货"：
- 前端：PUT /api/orders/:id/confirm
- 后端：检查订单状态为 SHIPPED → 更新为 COMPLETED
- 注意：只能由本人确认自己的订单

---

## 七、配送方式说明

| 配送方式 | 说明 | 状态 |
|----------|------|------------|
| EXPRESS | 快递发货，走本文档第二节「发货流程」（`Shipment` 记录 + 快递公司/单号） | 已实现 |
| LOCAL | 同城配送（快递100 同城急送 / 店内自送），**不是「流程同快递」**——无 `Shipment` 记录，走独立的 `Delivery` 表与骑手状态机，详见下方两张表；设计依据 `docs/superpowers/specs/2026-09-03-local-delivery-design.md` §4/§5.3 | 代码已实现（M1–M3 已合入），**生产尚未部署、总开关关闭**——本节的线上行为在批次二部署并开启同城总开关后才对顾客生效，之前只是"代码存在"，不是"已上线" |
| PICKUP | 到店自提 | 未实现（仅 `subscribe-message.ts` 里存在一条展示用的渠道文案映射，无实际下单/自提流程） |

> LOCAL 与 EXPRESS 共用 `Order` 表与 `Order.status`（本文档第三节的状态流转图对两个渠道都成立），差异集中在「谁负责把订单从 `SHIPPED` 推进到 `COMPLETED`」：EXPRESS 靠顾客手动确认收货或 7 天自动完成；LOCAL 靠快递100 回调（`520` 已送达）或店员手动「标记已送达」。

### 7.1 同城 Delivery 状态机

`Delivery` 是与 `Order` 平行的一张表（`deliveryType='LOCAL'` 的订单才会有），字段与 rank 定义见 `apps/server/src/services/delivery/state.ts`。正向状态按 `statusRank` 单调递增，进入终态后任何迟到的回调都不能把它推回去。

| 状态 | rank | 含义 | 进入条件 | 是否终态 |
|---|---|---|---|---|
| `PENDING` | 0 | 已建配送单，尚未真正外呼 | 店员点「呼叫骑手」的瞬间，事务内先落这个占位状态 | 否 |
| `CALLING` | 10 | 待抢单，运力方回调 `0` | 外呼快递100 `batchOrder` 成功 | 否 |
| `ACCEPTED` | 20 | 骑手已接单，回调 `100` | 某家运力抢到单 | 否 |
| `ARRIVING` | 30 | 骑手赶来取货，回调 `210` | — | 否 |
| `ARRIVED` | 40 | 骑手已到店，回调 `230` | — | 否 |
| `DELIVERING` | 50 | 配送中，回调 `310` | 骑手取货出发；同一事务把 `Order.status` 推进到 `SHIPPED` | 否 |
| `DELIVERED` | 100 | 已送达，回调 `520` | 同一事务把 `Order.status` 推进到 `COMPLETED`，释放 `activeOrderId` | **是** |
| `REASSIGNING` | 旁路（不写 rank） | 改派中，回调 `515` | 原骑手无法完成，运力方正在找下一个骑手；成功后会再推一条 `100`，专门的兜底逻辑把 rank 从旁路态「拨回」20（唯二允许的状态回退之一，见 spec §5.3 N8） | 否 |
| `ABNORMAL` | 旁路（不写 rank） | 配送异常，回调 `510` | 运力方标记异常（联系不上顾客等），需要人工介入 | 否 |
| `CANCELLED` | 终态 | 已取消 | 运力方撤单回调 `720`，或店员在后台主动取消 | **是** |
| `FAILED` | 终态 | 呼叫失败 | 明确的下单错误（配置问题/余额不足/运力异常重试耗尽） | **是** |
| `UNKNOWN` | 停在被打断前的 rank | 状态未确认 | 呼叫请求超时且暂无回调认领；`deliveryNo` 已写进回调 URL，之后回调到达可自动认领 | 否，但**不会自愈**，需人工核对（见 `docs/staff-guide.md` 六点五节） |

顾客端与店员看到的中文文案取自同一份 `DELIVERY_STATUS_LABEL`（`state.ts`），两端不会出现不同措辞。

> **待补**：上表文案目前来自代码常量与设计 spec 的推断，尚未经过真机真实回调逐条核验——M4 计划 Task 6（真机真钱联调）截至本次文档同步尚未执行（`docs/superpowers/notes/` 下还没有对应的联调记录）。Task 6 完成后应回来把每个状态在小程序订单详情页的**实际呈现时刻与文案**核对进本表，不一致处以真实回调为准。

### 7.2 Order × Delivery 组合矩阵

用于排查线上异常数据：某条订单/配送单的组合是否正常，还是意味着代码某处有 bug。矩阵只覆盖 `deliveryType='LOCAL'` 的订单；EXPRESS 订单没有 `Delivery` 行。

| Order.status ＼ Delivery.status | 无 Delivery | PENDING/CALLING | ACCEPTED/ARRIVING/ARRIVED | DELIVERING | DELIVERED | CANCELLED/FAILED | REASSIGNING/ABNORMAL/UNKNOWN |
|---|---|---|---|---|---|---|---|
| `PENDING_PAYMENT` | ✅ 正常（未付款不可能有配送单） | ❌ 不该出现——下单未付款不会建 Delivery | ❌ 不该出现 | ❌ 不该出现 | ❌ 不该出现 | ❌ 不该出现 | ❌ 不该出现 |
| `PAID` | ✅ 正常（已付款、店员尚未接单，同城场景「接单」= 开始备餐，与是否已建配送单无关） | ❌ 不该出现——呼叫骑手要求订单先 `PREPARING` | ❌ 不该出现 | ❌ 不该出现 | ❌ 不该出现 | ⚠️ 极端情况：接单后又被 720 打回 `PREPARING` 之前的一瞬间理论上不落在这里，若真出现在 `PAID` 上说明状态推进代码漏了分支 | ❌ 不该出现 |
| `PREPARING` | ✅ 正常（已接单、备餐中，尚未呼叫或此前配送单已终态） | ✅ 正常（已呼叫，待抢单/骑手赶来/已到店） | ✅ 正常 | ❌ **不该出现**——`310` 回调会在同一事务把 Order 推进到 `SHIPPED`，若 Delivery 已 `DELIVERING` 而 Order 还停在 `PREPARING`，说明那次回调事务只写了 Delivery 没写 Order | ❌ **不该出现**，理由同上（`520` 同事务推进到 `COMPLETED`） | ✅ 正常（720 运力取消或店员手动取消后回落到 `PREPARING` 等待重呼，spec §5.3 唯二回退之二；或配送单从未成功呼出即被作废） | ✅ 正常（`UNKNOWN` 等待人工核对；`REASSIGNING`/`ABNORMAL` 等待运力方处理，Order 侧无需变化） |
| `SHIPPED` | ❌ **不该出现**——LOCAL 的 `SHIPPED` 只能由「配送中回调 310」或「店内自送」产生，两者都必然有一条 Delivery | ❌ 不该出现 | ❌ 不该出现——到这个阶段 Order 应仍是 `PREPARING` | ✅ 正常（配送中，与 Order 同步进入 `SHIPPED` 的那一刻） | ⚠️ 短暂中间态：`520` 回调事务内 Order 会与 Delivery 同时推进到终态，若长期停留在这个组合说明该次事务只提交了一半 | ⚠️ 短暂/异常：正常情况下 720 取消会把 Order 拉回 `PREPARING`；若 Order 已经是 `SHIPPED`（说明 310 已发生）又收到 720，按 §5.3 走「其余情况」分支（告警人工，不回退状态），此组合允许短暂存在但需要人工介入 | ✅ 正常（配送中出现改派/异常，Order 侧原地不动） |
| `COMPLETED` | ✅ 正常（EXPRESS 订单，或 LOCAL 走店内自送/店员手动标记已送达后配送单本身也进了终态但已被下方一列覆盖） | ❌ **不该出现**——完成了却还有一张待抢单的配送单，数据不一致 | ❌ **不该出现** | ❌ **不该出现**——完成了但骑手侧显示仍在配送中 | ✅ 正常（`520` 回调或店员标记已送达后的最终状态） | ✅ 正常（历史配送单已终态，订单随后完成——例如重呼后旧单 CANCELLED、新单 DELIVERED） | ❌ **不该出现**——已完成的订单不该还挂着未收尾的异常配送单 |
| `REFUNDING`/`REFUNDED` | ✅ 正常 | ⚠️ 拒单/退款前应先走 42221「请先取消配送单」前置校验，正常路径不该看到在途配送单还没处理就已进入退款；出现说明前置校验被绕过 | 同左 | 同左 | ✅ 正常（已送达后仍可发起全额退款，如拒单/售后） | ✅ 正常（先取消配送单，再退款是标准路径） | 同「⚠️」 |
| `CANCELLED` | ✅ 正常（待付款超时取消，从未涉及配送单） | ❌ 不该出现 | ❌ 不该出现 | ❌ 不该出现 | ❌ 不该出现 | ✅ 允许（配送单也已取消） | ❌ 不该出现 |

标记说明：✅ 正常在途/终态组合；⚠️ 只应短暂存在或需人工介入，长期停留视为异常；❌ 理论上不该出现，出现即代表状态机代码某处漏更新了一侧。
