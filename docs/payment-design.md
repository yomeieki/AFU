# 支付设计文档

## 一、总体设计原则

1. **后端计算金额**：下单时后端根据数据库价格计算，前端传商品 ID 和数量，不传价格。
2. **幂等处理**：支付回调可能重复推送，必须保证幂等性。
3. **签名验证**：微信支付回调必须验签，防止伪造支付通知。
4. **状态校验**：处理回调前验证订单状态，防止重复处理已支付订单。
5. **事务保证**：更新订单状态和支付记录在同一个数据库事务中执行。

---

## 二、Mock Payment 设计

### 2.1 使用场景

- 开发阶段调试
- 第一版 MVP 上线（正式微信支付接入前）
- 功能演示

### 2.2 Mock 支付流程

```
小程序用户
    │
    ├─ 1. POST /api/orders → 创建订单（status=PENDING_PAYMENT）
    │       响应：orderId, orderNo, actualAmount
    │
    ├─ 2. 跳转到支付页面（展示订单金额）
    │
    ├─ 3. 点击"模拟支付成功"按钮
    │
    └─ 4. POST /api/payments/mock/success
              Request: { orderNo: "ORD20240101001" }
              │
              ├─ 后端验证：
              │     ① 订单存在
              │     ② 订单属于当前用户
              │     ③ 订单状态为 PENDING_PAYMENT
              │
              ├─ 数据库事务：
              │     ① 创建 payments 记录（type=MOCK, status=SUCCESS）
              │     ② 更新 orders.status = PAID
              │     ③ 更新 orders.paid_at = NOW()
              │
              └─ 响应：{ status: "PAID" }
```

### 2.3 Mock 支付接口

```
POST /api/payments/mock/success
Authorization: Bearer <user_token>

Request Body:
{
  "orderNo": "ORD20240101001"
}

Response:
{
  "code": 0,
  "data": {
    "orderNo": "ORD20240101001",
    "status": "PAID",
    "paidAt": "2024-01-01T10:05:00Z"
  }
}
```

### 2.4 Mock 支付安全控制

```javascript
// 环境控制：生产环境可通过配置开关禁用
if (process.env.MOCK_PAYMENT_ENABLED !== 'true') {
  return res.status(403).json({ code: 40301, message: 'Mock 支付未开启' })
}
```

在 `.env` 中配置：
```env
# 开发环境
MOCK_PAYMENT_ENABLED=true

# 生产环境（真实支付接入后改为 false）
MOCK_PAYMENT_ENABLED=false
```

---

## 三、微信支付 JSAPI 设计（第二阶段）

### 3.1 前提条件

- 已申请微信支付商户号（mchid）
- 已完成微信支付 APIv3 密钥配置
- 小程序 AppID 已关联到商户号
- 服务器域名已完成备案且支持 HTTPS
- 微信支付回调地址（notify_url）可公网访问

### 3.2 微信支付 JSAPI 完整流程

```
小程序                    后端服务器                    微信支付服务器
   │                          │                              │
   │─ POST /api/orders ──────►│                              │
   │◄── orderId, orderNo ─────│                              │
   │                          │                              │
   │─ POST /api/payments/     │                              │
   │   wechat/prepay ────────►│                              │
   │   {orderNo}              │─ 调用微信下单接口 ──────────►│
   │                          │  (JSAPI 统一下单 v3)         │
   │                          │  appid, mchid, openid        │
   │                          │  out_trade_no = orderNo      │
   │                          │  total = actualAmount（分）  │
   │                          │◄── prepay_id ────────────────│
   │                          │                              │
   │                          │─ 生成签名参数                │
   │                          │  timeStamp, nonceStr         │
   │                          │  package, signType, paySign  │
   │◄── 返回支付参数 ──────────│                              │
   │                          │                              │
   │─ wx.requestPayment() ────►│                              │
   │  (调起微信支付收银台)      │                              │
   │                          │                              │
用户完成付款                   │                              │
   │                          │                              │
   │                          │◄── notify 回调 ──────────────│
   │                          │  POST /api/payments/         │
   │                          │       wechat/notify          │
   │                          │                              │
   │                          │─ 验签、解密                  │
   │                          │─ 幂等检查                    │
   │                          │─ 核对订单号                  │
   │                          │─ 核对金额                    │
   │                          │─ 更新订单为 PAID             │
   │                          │─ 返回 SUCCESS ──────────────►│
   │                          │                              │
   │─ 前端轮询订单状态 ────────►│                             │
   │◄── status: PAID ──────────│                              │
```

### 3.3 预下单接口

```
POST /api/payments/wechat/prepay
Authorization: Bearer <user_token>

Request Body:
{
  "orderNo": "ORD20240101001"
}

后端处理逻辑：
1. 验证用户身份（JWT）
2. 查询订单，验证：
   - 订单存在
   - 订单属于当前用户
   - 订单状态为 PENDING_PAYMENT
3. 获取用户 openid（从数据库）
4. 调用微信支付 JSAPI 下单接口
   - out_trade_no = orderNo（全局唯一）
   - total = order.actualAmount（分）
   - openid = user.openid
   - notify_url = https://api.yourdomain.com/api/payments/wechat/notify
5. 获取 prepay_id
6. 生成 wx.requestPayment 所需签名参数：
   - timeStamp: 当前时间戳（字符串）
   - nonceStr: 随机字符串
   - package: "prepay_id=xxxx"
   - signType: "RSA"
   - paySign: 签名（使用商户私钥）
7. 保存 prepay_id 到 payments 表

Response:
{
  "code": 0,
  "data": {
    "timeStamp": "1704067200",
    "nonceStr": "5K8264ILTKCH16CQ2502SI8ZNMTM67VS",
    "package": "prepay_id=wx201410272009395522657a690389285100",
    "signType": "RSA",
    "paySign": "oR9d8PuhnIc+YZ8cBHFCwfgpaK9gd7vaRvkYD7rthRAZ..."
  }
}
```

### 3.4 支付回调处理

```
POST /api/payments/wechat/notify
（无需 JWT 认证，使用微信签名验证）

后端处理逻辑（必须严格按顺序执行）：

Step 1：验签
  - 从 HTTP Header 获取：
    Wechatpay-Timestamp
    Wechatpay-Nonce
    Wechatpay-Signature
    Wechatpay-Serial
  - 使用微信平台公钥验证签名
  - 验签失败 → 返回 FAIL，拒绝处理

Step 2：解密 resource 字段
  - 使用 APIv3 密钥（AES-256-GCM）解密 resource.ciphertext
  - 解密失败 → 返回 FAIL

Step 3：解析通知内容
  - out_trade_no（商户订单号 = orderNo）
  - transaction_id（微信支付流水号）
  - trade_state（支付状态）
  - amount.total（支付金额，分）
  - payer.openid

Step 4：幂等检查（关键！）
  - 查询 payments 表是否已存在 wx_transaction_id = transaction_id 的记录
  - 若已存在（重复回调） → 直接返回 SUCCESS，不再处理

Step 5：查询订单
  - 根据 out_trade_no 查询订单
  - 订单不存在 → 返回 FAIL

Step 6：核对商户号
  - 验证 mchid 与配置中的商户号一致
  - 不一致 → 返回 FAIL

Step 7：核对金额
  - 验证 amount.total === order.actualAmount
  - 金额不一致 → 不更新订单，记录异常日志，返回 FAIL

Step 8：检查订单状态
  - 若订单状态已为 PAID（并发情况）→ 直接返回 SUCCESS

Step 9：数据库事务更新
  - 创建 payments 记录：
    payment_type=WECHAT, status=SUCCESS
    wx_transaction_id=transaction_id
    wx_notify_data=原始报文（JSON 字符串）
    paid_at=当前时间
  - 更新 orders：status=PAID, paid_at=当前时间

Step 10：返回 SUCCESS 给微信
  {
    "code": "SUCCESS",
    "message": "成功"
  }
```

### 3.5 回调幂等实现

```javascript
// 核心幂等逻辑
async function handleWechatNotify(notifyData) {
  const { transaction_id, out_trade_no, amount, trade_state } = notifyData

  // 仅处理支付成功回调
  if (trade_state !== 'SUCCESS') {
    return { code: 'SUCCESS', message: '非支付成功通知，忽略' }
  }

  // 幂等检查
  const existingPayment = await prisma.payment.findUnique({
    where: { wxTransactionId: transaction_id }
  })
  if (existingPayment) {
    // 已处理过，直接返回成功
    return { code: 'SUCCESS', message: '已处理' }
  }

  // 查询并核对订单
  const order = await prisma.order.findUnique({
    where: { orderNo: out_trade_no }
  })
  if (!order) throw new Error('订单不存在')
  if (amount.total !== order.actualAmount) throw new Error('金额不匹配')
  if (order.status === 'PAID') return { code: 'SUCCESS', message: '订单已支付' }

  // 事务更新
  await prisma.$transaction([
    prisma.payment.create({
      data: {
        orderId: order.id,
        orderNo: order.orderNo,
        paymentType: 'WECHAT',
        amount: amount.total,
        status: 'SUCCESS',
        wxTransactionId: transaction_id,
        wxNotifyData: JSON.stringify(notifyData),
        paidAt: new Date(),
      }
    }),
    prisma.order.update({
      where: { id: order.id },
      data: { status: 'PAID', paidAt: new Date() }
    })
  ])

  return { code: 'SUCCESS', message: '处理成功' }
}
```

---

## 四、金额校验规则

| 校验点 | 规则 | 失败处理 |
|--------|------|----------|
| 前端提交订单 | 前端不传价格，后端根据 productId 查库计算 | 无需校验，直接忽略前端价格 |
| 后端创建订单 | totalAmount = Σ(product.price × quantity) | 计算错误返回 500 |
| 微信预下单 | amount = order.actualAmount（已入库） | 金额从数据库读取，不来自前端 |
| 微信回调 | amount.total === order.actualAmount | 金额不匹配 → 拒绝 + 告警 |

---

## 五、关键环境变量

```env
# 微信支付配置（第二阶段使用）
WX_PAY_MCH_ID=商户号
WX_PAY_API_KEY_V3=APIv3密钥（32字节）
WX_PAY_SERIAL_NO=商户证书序列号
WX_PAY_PRIVATE_KEY_PATH=/path/to/apiclient_key.pem
WX_PAY_NOTIFY_URL=https://api.yourdomain.com/api/payments/wechat/notify

# Mock 支付开关
MOCK_PAYMENT_ENABLED=true
```

---

## 六、前端轮询订单状态

由于微信支付是异步回调，前端在 wx.requestPayment 成功后需要轮询订单状态：

```javascript
// 小程序端支付成功后轮询
async function pollOrderStatus(orderNo, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    await sleep(2000)  // 每 2 秒查一次
    const res = await request({ url: `/api/orders/${orderNo}` })
    if (res.data.status === 'PAID') {
      // 跳转到支付成功页
      wx.navigateTo({ url: `/pages/order/success?orderNo=${orderNo}` })
      return
    }
  }
  // 超时提示用户去订单列表查看
  wx.showToast({ title: '请在订单列表中确认支付结果', icon: 'none' })
}
```

---

## 七、退款设计（预留，第一版不实现）

退款接口预留：
- POST /api/admin/orders/:id/refund（管理员发起退款）
- 调用微信支付退款 API
- 更新订单状态为 REFUNDED
- 退款回调：POST /api/payments/wechat/refund-notify

第一版退款流程：管理员线下处理，手动修改订单状态。
