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

部分退款（不改变订单状态）：PAID / PREPARING / SHIPPED / COMPLETED 任一状态下，商家可发起 amount < 可退余额 的退款，
成功后 order.refundedAmount 累加，订单继续履约；退完全部余额即视为全额退款，走 REFUNDING → REFUNDED。

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
非生产环境可 `POST /api/admin/system/run-scheduler {payTimeoutMin,autoCompleteDays,remindAfterMin}` 手动触发（e2e 用）。

---

## 六、用户确认收货（第一版需实现）

用户在订单详情页点击"确认收货"：
- 前端：PUT /api/orders/:id/confirm
- 后端：检查订单状态为 SHIPPED → 更新为 COMPLETED
- 注意：只能由本人确认自己的订单

---

## 七、配送方式说明

| 配送方式 | 说明 | 第一版状态 |
|----------|------|------------|
| EXPRESS | 快递发货 | 实现 |
| LOCAL | 同城配送 | 实现（流程同快递） |
| PICKUP | 到店自提 | 暂不实现 |
