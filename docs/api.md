# API 设计文档

## 一、通用约定

### 1.1 请求格式

- 协议：HTTPS
- 数据格式：JSON（`Content-Type: application/json`）
- 字符集：UTF-8
- 文件上传：`multipart/form-data`

### 1.2 认证方式

- 用户端：`Authorization: Bearer <user_jwt_token>`
- 管理端：`Authorization: Bearer <admin_jwt_token>`

### 1.3 统一响应格式

**成功：**
```json
{
  "code": 0,
  "message": "success",
  "data": { ... }
}
```

**分页列表：**
```json
{
  "code": 0,
  "message": "success",
  "data": {
    "list": [ ... ],
    "total": 100,
    "page": 1,
    "pageSize": 20
  }
}
```

**失败：**
```json
{
  "code": 40001,
  "message": "商品不存在",
  "data": null
}
```

### 1.4 错误码设计

| 错误码 | 说明 |
|--------|------|
| 0 | 成功 |
| 40001 | 参数错误 |
| 40101 | 未登录 / Token 无效 |
| 40102 | Token 已过期 |
| 40301 | 无权限 |
| 40401 | 资源不存在 |
| 40901 | 数据冲突（如重复提交） |
| 42201 | 库存不足 |
| 42202 | 商品已下架 |
| 42203 | 订单状态错误 |
| 42204 | 支付金额不匹配（另见附录 B：该码值已被复用于其他场景） |
| 50001 | 服务器内部错误 |
| 50002 | 第三方服务错误（微信/COS） |

### 1.5 金额说明

- 所有金额字段单位为**分（整数）**。
- 示例：`price: 2990` 表示 29.90 元。
- 前端展示时自行除以 100。

---

## 二、小程序端 API

### 2.1 认证

#### POST /api/auth/wechat-login

微信登录，用 code 换取用户 JWT。

**Request Body:**
```json
{
  "code": "wx_login_code_from_wx.login()"
}
```

**Response:**
```json
{
  "code": 0,
  "data": {
    "token": "eyJhbGci...",
    "userId": 1,
    "nickname": "张三",
    "avatarUrl": "https://..."
  }
}
```

**说明：**
- 后端用 code 调用微信 `jscode2session` 接口换取 openid。
- 首次登录自动创建用户记录。
- 返回自签 JWT，有效期 7 天。

---

### 2.2 商品分类

#### GET /api/categories

获取所有上架分类列表。

**Response:**
```json
{
  "code": 0,
  "data": [
    {
      "id": 1,
      "name": "熟食",
      "iconUrl": "https://cos.../icon.png",
      "sortOrder": 1
    }
  ]
}
```

---

### 2.3 商品

#### GET /api/products

商品列表（支持分类筛选、搜索、分页）。

**Query Params:**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| categoryId | int | 否 | 分类 ID |
| keyword | string | 否 | 搜索关键词 |
| page | int | 否 | 页码，默认 1 |
| pageSize | int | 否 | 每页数量，默认 20，最大 50 |

**Response:**
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1,
        "name": "招牌猪头肉",
        "coverImage": "https://...",
        "price": 2990,
        "originalPrice": 3500,
        "unit": "份",
        "salesCount": 128,
        "stock": 50,
        "status": "ON_SHELF"
      }
    ],
    "total": 30,
    "page": 1,
    "pageSize": 20
  }
}
```

---

#### GET /api/products/:id

商品详情。

**Response:**
```json
{
  "code": 0,
  "data": {
    "id": 1,
    "categoryId": 2,
    "name": "招牌猪头肉",
    "subtitle": "每日新鲜制作，限量供应",
    "coverImage": "https://...",
    "images": [
      { "id": 1, "imageUrl": "https://...", "sortOrder": 0 }
    ],
    "price": 2990,
    "originalPrice": 3500,
    "stock": 50,
    "salesCount": 128,
    "unit": "份",
    "weight": "500g",
    "shelfLife": "常温3天，冷藏7天",
    "storageMethod": "常温存放，开封后冷藏",
    "deliveryInfo": "支持顺丰快递，次日达",
    "description": "<p>...</p>",
    "deliveryType": "EXPRESS,LOCAL",
    "status": "ON_SHELF"
  }
}
```

---

### 2.4 购物车

> 所有购物车接口需要携带用户 JWT。

#### GET /api/cart

获取当前用户购物车。

**Response:**
```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 1,
        "productId": 1,
        "productName": "招牌猪头肉",
        "productImage": "https://...",
        "price": 2990,
        "stock": 50,
        "status": "ON_SHELF",
        "quantity": 2,
        "isSelected": true,
        "subtotal": 5980
      }
    ],
    "totalAmount": 5980,
    "selectedCount": 1
  }
}
```

---

#### POST /api/cart

添加商品到购物车。

**Request Body:**
```json
{
  "productId": 1,
  "quantity": 2
}
```

**Response:**
```json
{
  "code": 0,
  "data": { "id": 1 }
}
```

**说明：** 若商品已在购物车中，数量累加。

---

#### PUT /api/cart/:id

更新购物车项（数量或选中状态）。

**Request Body:**
```json
{
  "quantity": 3,
  "isSelected": true
}
```

---

#### DELETE /api/cart/:id

删除购物车项。

**Response:**
```json
{ "code": 0, "data": null }
```

---

### 2.5 收货地址

#### GET /api/addresses

获取当前用户地址列表。

**Response:**
```json
{
  "code": 0,
  "data": [
    {
      "id": 1,
      "receiverName": "张三",
      "receiverPhone": "13800138000",
      "province": "广东省",
      "city": "广州市",
      "district": "天河区",
      "detail": "天河路 100 号 3 楼",
      "fullAddress": "广东省广州市天河区天河路 100 号 3 楼",
      "isDefault": true
    }
  ]
}
```

---

#### POST /api/addresses

新增地址。

**Request Body:**
```json
{
  "receiverName": "张三",
  "receiverPhone": "13800138000",
  "province": "广东省",
  "city": "广州市",
  "district": "天河区",
  "detail": "天河路 100 号 3 楼",
  "isDefault": true
}
```

---

#### PUT /api/addresses/:id

编辑地址（字段同新增）。

---

#### DELETE /api/addresses/:id

删除地址（软删除）。

---

### 2.6 订单

#### POST /api/orders

创建订单。

**Request Body:**
```json
{
  "cartItemIds": [1, 2],
  "addressId": 1,
  "deliveryType": "EXPRESS",
  "remark": "请放门口"
}
```

**说明：**
- 前端只传 cartItemIds（或 productId + quantity 直接购买），不传价格。
- 后端根据数据库商品价格计算金额。
- 创建订单时检查：商品存在、已上架、库存充足。
- 订单创建成功后减少库存、清空对应购物车项。

**Response:**
```json
{
  "code": 0,
  "data": {
    "orderId": 100,
    "orderNo": "ORD20240101001",
    "totalAmount": 5980,
    "shippingFee": 0,
    "actualAmount": 5980,
    "status": "PENDING_PAYMENT"
  }
}
```

---

#### GET /api/orders

获取当前用户订单列表。

**Query Params:**
| 参数 | 类型 | 说明 |
|------|------|------|
| status | string | 订单状态筛选，不传则查全部 |
| page | int | 页码 |
| pageSize | int | 每页数量 |

**Response:**
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 100,
        "orderNo": "ORD20240101001",
        "status": "PENDING_PAYMENT",
        "actualAmount": 5980,
        "createdAt": "2024-01-01T10:00:00Z",
        "items": [
          {
            "productName": "招牌猪头肉",
            "productImage": "https://...",
            "quantity": 2,
            "productPrice": 2990
          }
        ]
      }
    ],
    "total": 5,
    "page": 1,
    "pageSize": 20
  }
}
```

---

#### GET /api/orders/:id

订单详情。

**Response:**
```json
{
  "code": 0,
  "data": {
    "id": 100,
    "orderNo": "ORD20240101001",
    "status": "SHIPPED",
    "totalAmount": 5980,
    "shippingFee": 0,
    "actualAmount": 5980,
    "deliveryType": "EXPRESS",
    "remark": "请放门口",
    "receiverName": "张三",
    "receiverPhone": "13800138000",
    "receiverFullAddress": "广东省广州市天河区天河路 100 号 3 楼",
    "paidAt": "2024-01-01T10:05:00Z",
    "createdAt": "2024-01-01T10:00:00Z",
    "items": [
      {
        "id": 1,
        "productName": "招牌猪头肉",
        "productImage": "https://...",
        "productPrice": 2990,
        "quantity": 2,
        "subtotal": 5980
      }
    ],
    "shipment": {
      "expressCompany": "顺丰速运",
      "expressNo": "SF1234567890",
      "shippedAt": "2024-01-02T09:00:00Z"
    }
  }
}
```

---

### 2.7 支付

#### POST /api/orders/:id/pay

发起支付。后端按环境变量 `WECHAT_PAY_MOCK` 决定支付模式，响应中的 `mode` 字段区分：

**Mock 模式响应（`WECHAT_PAY_MOCK=true`，仅开发环境）：**
```json
{
  "code": 0,
  "data": {
    "mode": "mock",
    "status": "PAID",
    "paidAt": "2026-01-01T00:00:00.000Z"
  }
}
```

**真实微信支付响应（JSAPI 预下单，返回 `wx.requestPayment` 所需参数）：**
```json
{
  "code": 0,
  "data": {
    "mode": "wechat",
    "timeStamp": "1704067200",
    "nonceStr": "randomstring",
    "package": "prepay_id=wx...",
    "signType": "RSA",
    "paySign": "..."
  }
}
```

**安全说明：** mock 默认关闭，仅显式 `WECHAT_PAY_MOCK=true` 时启用；生产环境（`NODE_ENV=production`）开启 mock 会导致服务拒绝启动。

---

#### PUT /api/orders/:id/confirm

确认收货（仅 `SHIPPED` 状态订单），订单流转为 `COMPLETED`。

**Response:** 返回更新后的订单对象。

---

#### POST /api/wechat/pay/notify

微信支付 APIv3 回调（微信服务器主动调用，非小程序调用）。

**无需认证，但必须验签（生产环境强制），并比对回调金额与订单实付金额，不一致拒绝处理。**

**Request Body（APIv3 JSON 加密报文）:** 由微信发送，后端验签后解密处理。

**Response Body（返回给微信）:**
```json
{ "code": "SUCCESS", "message": "成功" }
```

---

#### POST /api/wechat/pay/refund-notify

微信退款结果回调（`REFUND.SUCCESS` / `REFUND.ABNORMAL` / `REFUND.CLOSED`）。与支付回调共用验签逻辑：按 `Wechatpay-Serial` 头自动识别「微信支付公钥」（`PUB_KEY_ID_` 前缀）或「平台证书」模式，时间戳偏差 >5 分钟拒绝。

处理：按 `out_refund_no` 找到退款记录 → 已 SUCCESS 直接 ack（幂等）→ 回调 `amount.refund` 必须等于记录金额否则 400 FAIL → SUCCESS 时事务写 `refunds.status=SUCCESS`、`orders.status=REFUNDED`、`payments.status=REFUNDED` 并推送通知；ABNORMAL/CLOSED 写状态并告警。

### 2.8 扫码日志

#### POST /api/scan-logs

记录扫码事件（用户扫包装二维码时调用）。

**Request Body:**
```json
{
  "scene": "p_10001",
  "source": "package"
}
```

**Response:**
```json
{ "code": 0, "data": null }
```

**说明：** 不需要强制登录，openid 有则记录，无则留空。

---

## 三、后台管理端 API

> 所有后台接口需要携带管理员 JWT：`Authorization: Bearer <admin_token>`

### 3.1 管理员认证

#### POST /api/admin/login

**Request Body:**
```json
{
  "username": "admin",
  "password": "your_password"
}
```

**Response:**
```json
{
  "code": 0,
  "data": {
    "token": "eyJhbGci...",
    "expiresIn": 86400,
    "adminInfo": {
      "id": 1,
      "username": "admin",
      "name": "店长",
      "role": "admin"
    }
  }
}
```

---

### 3.2 商品分类管理

#### GET /api/admin/categories

获取所有分类（含隐藏分类）。

#### POST /api/admin/categories

新增分类。

**Request Body:**
```json
{
  "name": "熟食",
  "iconUrl": "https://...",
  "sortOrder": 1,
  "status": 1
}
```

#### PUT /api/admin/categories/:id

编辑分类（字段同新增）。

#### DELETE /api/admin/categories/:id

删除分类（检查是否有关联商品，有则拒绝或提示）。

---

### 3.3 商品管理

#### GET /api/admin/products

商品列表。

**Query Params:**
| 参数 | 说明 |
|------|------|
| categoryId | 分类筛选 |
| status | ON_SHELF / OFF_SHELF |
| keyword | 搜索关键词 |
| page | 页码 |
| pageSize | 每页数量 |

---

#### POST /api/admin/products

新增商品。

**Request Body:**
```json
{
  "categoryId": 1,
  "name": "招牌猪头肉",
  "subtitle": "每日新鲜制作",
  "coverImage": "https://...",
  "imageUrls": ["https://...", "https://..."],
  "price": 2990,
  "originalPrice": 3500,
  "stock": 100,
  "unit": "份",
  "weight": "500g",
  "shelfLife": "常温3天，冷藏7天",
  "storageMethod": "常温存放，开封后冷藏",
  "deliveryInfo": "支持顺丰快递",
  "description": "<p>...</p>",
  "status": "ON_SHELF",
  "deliveryType": "EXPRESS,LOCAL",
  "isRecommended": 1
}
```

---

#### PUT /api/admin/products/:id

编辑商品（字段同新增）。

---

#### DELETE /api/admin/products/:id

软删除商品（设置 deleted_at）。

---

#### POST /api/admin/products/:id/qrcode

为商品生成小程序码。

**说明：**
- 后端调用微信接口生成小程序码（getwxacode 或 getwxacodeunlimit）。
- 小程序码图片上传到腾讯云 COS。
- 更新 products 表的 qr_scene、qr_code_url、qr_generated_at 字段。

**Response:**
```json
{
  "code": 0,
  "data": {
    "qrCodeUrl": "https://cos.../qrcode/product_1.png",
    "qrScene": "p_1",
    "qrGeneratedAt": "2024-01-01T10:00:00Z"
  }
}
```

---

### 3.4 文件上传

#### POST /api/admin/upload

上传图片到腾讯云 COS。

**Request:** `multipart/form-data`，字段名 `file`。

**Response:**
```json
{
  "code": 0,
  "data": {
    "url": "https://cos.yourdomain.com/images/abc123.jpg"
  }
}
```

---

### 3.5 订单管理

#### GET /api/admin/orders

订单列表。

**Query Params:**
| 参数 | 说明 |
|------|------|
| status | 订单状态筛选 |
| orderNo | 订单号搜索 |
| startDate | 开始日期 |
| endDate | 结束日期 |
| page | 页码 |
| pageSize | 每页数量 |

---

#### GET /api/admin/orders/:id

订单详情（同用户端订单详情，含更多字段）。

---

#### PUT /api/admin/orders/:id/status

修改订单状态。

**Request Body:**
```json
{
  "status": "CANCELLED"
}
```

**说明：** 当前仅支持取消待付款（`PENDING_PAYMENT`）订单，取消时自动回滚库存与销量。

---

#### POST /api/admin/orders/:id/ship

发货操作。

**Request Body:**
```json
{
  "expressCompany": "顺丰速运",
  "expressNo": "SF1234567890",
  "remark": ""
}
```

**说明：** 成功后订单状态变为 `SHIPPED`，创建 shipments 记录。

---

#### POST /api/admin/orders/:id/refund

一键退款（全额，微信退款 API 原路退回）。允许状态：`PAID` / `PREPARING` / `SHIPPED`（登记并执行），或 `REFUNDING`（用户自助取消 / 上次发起失败后重试）。

请求：
```json
{ "amount": 3800, "reason": "商品缺货" }
```
- `amount`（必填，分）必须等于订单 `actualAmount`，否则 `42206`
- 同一订单已有进行中的退款 → `42205`；订单状态并发变化 → `42204`；无成功支付记录 / 模拟支付订单 → `42207`
- 待接单/备餐中退款回滚库存，已发货不回滚
- `WECHAT_PAY_MOCK=true` 时直接置 `REFUNDED`（`mode: "mock"`）
- 微信 API 返回失败 → 退款记录 `FAILED`、订单保持 `REFUNDING`、企微告警，响应 `50201`（HTTP 502）

响应：
```json
{ "code": 0, "data": { "order": { "status": "REFUNDING" }, "refund": { "outRefundNo": "refund_12_1725...", "status": "PROCESSING" }, "mode": "wechat" } }
```

#### POST /api/admin/orders/:id/refund-complete

人工兜底：确认商户平台已退款成功但系统未收到回调时，把 `REFUNDING` 订单标记为 `REFUNDED`（同时把进行中的退款记录标 SUCCESS）。仅 `REFUNDING` 可调用；重复调用 `42204`。

`GET /api/admin/orders` 列表每项附带 `latestRefund`（最近一条退款记录：`status` / `outRefundNo` / `amount` / `mode` / `errorMessage`）。

### 3.6 用户管理

#### GET /api/admin/users

用户列表。

**Query Params:** page, pageSize, keyword（按昵称/手机号搜索）

**Response:**
```json
{
  "code": 0,
  "data": {
    "list": [
      {
        "id": 1,
        "openid": "o6_bm...",
        "nickname": "张三",
        "avatarUrl": "https://...",
        "phone": "138****8000",
        "status": 1,
        "orderCount": 5,
        "lastLoginAt": "2024-01-01T10:00:00Z",
        "createdAt": "2024-01-01T10:00:00Z"
      }
    ],
    "total": 100
  }
}
```

---

#### GET /api/admin/users/:id/orders

查看指定用户的订单列表（参数同订单列表）。

---

### 3.7 数据统计

#### GET /api/admin/stats

基础统计数据。

**Response:**
```json
{
  "code": 0,
  "data": {
    "today": {
      "orderCount": 12,
      "salesAmount": 35880
    },
    "total": {
      "orderCount": 1024,
      "productCount": 36,
      "categoryCount": 5
    },
    "hotProducts": [
      {
        "id": 1,
        "name": "招牌猪头肉",
        "coverImage": "https://...",
        "salesCount": 256,
        "price": 2990
      }
    ]
  }
}
```

---

## 四、接口安全说明

1. **用户接口**：使用 `verifyUserToken` 中间件，验证用户 JWT。
2. **管理员接口**：使用 `verifyAdminToken` 中间件，验证管理员 JWT，使用不同的 secret。
3. **微信支付回调**：不使用 JWT 认证，使用微信签名验证。
4. **Mock 支付**：仅在 `NODE_ENV !== 'production'` 时开放，或通过配置开关控制。
5. **文件上传**：限制文件类型（仅允许图片）、文件大小（不超过 5MB）。
6. **SQL 注入**：使用 Prisma ORM，参数化查询，不拼接 SQL。
7. **XSS**：富文本字段存储前做 sanitize。
8. **CORS**：后端配置白名单域名。


---

## 附录 A：2026-09 新增/变更接口速查

### 小程序端
| 接口 | 说明 |
|---|---|
| `POST /api/orders` | 新增 `directItem {productId, skuId?, quantity}` 与 `cartItemIds` 二选一（立即购买不经购物车）；响应增 `payExpireAt`、`subscribeTemplateIds` |
| `GET /api/orders/meta` | `{ subscribeTemplateIds, payTimeoutMin }`（下单页请求订阅消息用） |
| `GET /api/orders` / `GET /api/orders/:id` | 增 `payExpireAt`（待付款）、`refundedAmount`、`latestRefund`、`afterSale`；详情增 `refunds[]`、`canApplyAfterSale`、`subscribeTemplateIds` |
| `POST /api/orders/:id/after-sale` | `{ reason: SHORTAGE\|WRONG\|DAMAGED\|OTHER, description?, images?: url[] ≤3 }`；仅 SHIPPED/COMPLETED、有可退余额、无处理中售后单 |
| `GET /api/orders/:id/after-sale` | 该订单售后单列表 |
| `POST /api/upload` | 顾客上传售后图片（3MB，每分钟 10 张） |
| `POST /api/orders/:id/pay` | 超时返回 42209；未过期的预下单复用 prepay_id |

### 管理端
| 接口 | 说明 |
|---|---|
| `GET /api/admin/orders?keyword=` | 订单号 / 收货人 / 手机号模糊；列表增 `remark`、`refundedAmount`、`remainingRefundable`、`afterSale` |
| `POST /api/admin/orders/:id/refund` | `amount` 可为部分（≤ 可退余额）；响应增 `isFull` |
| `POST /api/admin/orders/:id/complete` | SHIPPED → COMPLETED |
| `GET /api/admin/after-sales?status=` | 售后单列表（含订单摘要、`remainingRefundable`、`reasonLabel`） |
| `POST /api/admin/after-sales/:id/approve` | `{ amount, reply? }` → 发起退款并置 APPROVED（回调成功 → DONE） |
| `POST /api/admin/after-sales/:id/reject` | `{ reply }` → REJECTED |
| `GET /api/admin/orders/pending-count` | 增 `afterSaleCount` |
| `POST /api/admin/webview-code` | admin token → 一次性 code（2 分钟） |
| `POST /api/admin/login/webview` | `{ code }` → token（小程序 web-view `/m?code=` 用） |
| `POST /api/admin/system/run-scheduler` | 非生产：手动跑一轮定时任务，可传阈值覆盖 |

### 错误码新增
| code | 含义 |
|---|---|
| 42206 | 退款金额超过可退余额 / 已全额退款 |
| 42208 | 已有售后申请处理中 |
| 42209 | 订单已超时，请重新下单 |
| 40103 | web-view 登录凭证失效 |

---

## 附录 B：同城配送 API（M1）

M1 只做「渠道基础设施」：分类/商品按 `channel` 归属、门店报价、LOCAL 下单、顾客取消申请。骑手呼叫、配送单状态机、快递100 对接、同城看板留给 M2（见 `docs/superpowers/specs/2026-09-03-local-delivery-design.md`）。

### channel 参数约定

`GET /api/categories`、`GET /api/products`、`GET /api/cart` 均支持 `?channel=EXPRESS|LOCAL` 查询参数：**缺省或非法值一律按 `EXPRESS`**（`utils/channel.ts` 的 `parseChannelQuery`），保证现有小程序页面不传该参数时行为完全不变。一个分类只属于一个渠道，商品的 `channel` 冗余自所属分类（唯一写入点 `services/product-channel.ts`），不会出现商品与分类渠道不一致——`scripts/check-channel-consistency.mjs` 专门校验这一点。

`POST /api/orders` 用 `deliveryType: 'EXPRESS' | 'LOCAL'`（复用订单已有列，默认 `EXPRESS`）判定渠道，下单商品的 `channel` 必须与之匹配，否则 42224。

### 小程序端

| 接口 | 说明 |
|---|---|
| `GET /api/local/meta` | 公开，无需登录。同城配送店头信息：`{ enabled, isOpen, paused, nextOpenText, businessHours, store{name,phone,province,city,district,address,latE6,lngE6}, radiusKm, radiusStraightKm, fee, prepMinutes, acceptGraceMin, limits }` |
| `POST /api/local/quote` | 地址/坐标报价。`optionalUserAuth`：传 `addressId` 需登录（校验地址归属）；传 `latE6,lngE6` 可匿名（如未登录预览页）。Body `{ addressId?, latE6?, lngE6?, subtotal?=0 }`（金额分，`addressId` 与坐标二选一）。返回 `{ enabled, isOpen, paused, nextOpenText, inRange, distanceM, distanceSource, straightDistanceM, fee, minOrderAmount, belowMin, estimatedMinutes, quoteToken }`。`distanceM` 优先取运力方 `batchPrice` 返回的**真实道路距离**（5 秒超时）；查不到就退回 `直线 × detourFactor` 的估算，**不报错**，此时 `distanceSource='ESTIMATED'`（实测为 `'MEASURED'`），调用方据此决定文案。`quoteToken` 仅在 `inRange=true` 时签发，TTL 5 分钟，签入 `fee/distanceM/addressId/坐标/settings.version`，下单时携带（见下） |
| `POST /api/orders`（LOCAL 分支） | `deliveryType: 'LOCAL'` 时走独立计费（`services/local-settings.ts`，**不调用**全局运费 `getShippingSettings/calcShippingFee`）：校验营业时段/暂停/门店坐标/地址坐标/配送范围/起送门槛/单次件数与重量上限。**距离不再在这里重算**：`quoteToken` 的签名/有效期/`addressId`/坐标/`settings.version` 五项全对时，直接采用 token 里签过名的真实道路距离，范围与运费都按它判；任一不符即当作没有 token，退回 `直线 × detourFactor` 兜底（`version` 不符则直接 42227 要求刷新）。实收运费仍取 `min(token.fee, 重算 fee)`，重算更贵报 42227——距离同源之后这条挡的是顾客把 `/local/quote` 的 `subtotal` 报高换免运 token |
| `POST /api/orders/:id/cancel-request` | 同城订单被接单（`PREPARING`）后 `acceptGraceMin` 分钟宽限期内，顾客可申请取消（订单状态**不变**，交由店员在后台确认后全额退款；不是自助取消）。Body `{ note? }` → `{ cancelRequestedAt }`。窗口外或已申请过 → 42229。M1 无配送单，`cancelRequestDeliveryStatus` 快照字段恒为 `NONE`（M2 起改为快照当时有效配送单状态） |

### 管理端

| 接口 | 说明 |
|---|---|
| `GET /api/admin/settings/local-delivery` | 读取完整同城配送设置（门店坐标/营业时段/运费阶梯/起送门槛/配送半径/接单宽限期/单次上限等），结构见 `LocalDeliverySettings`（`services/local-settings.ts`） |
| `PUT /api/admin/settings/local-delivery` | 全量保存。服务端先 `sanitizeLocalSettings` 再校验；`enabled=true`（开启同城配送总开关）时走更严格的 `validateForEnable`（例如必须已设置门店坐标） |
| `PATCH /api/admin/settings/local-delivery/store-location` | 单独更新门店坐标 `{ latE6, lngE6 }`（商家端「一键定位」用，不必先拉全量设置再整份 PUT） |
| `POST /api/admin/settings/local-delivery/pause` | 临时暂停接单 `{ reason, until? }`（ISO datetime，缺省不限时） |
| `DELETE /api/admin/settings/local-delivery/pause` | 取消暂停 |

共享的邮寄端点 `POST /api/admin/orders/:id/accept|ship|complete` 命中 `deliveryType='LOCAL'` 的订单一律返回 42204「同城订单请在同城看板操作」（M1 尚无同城看板，这条防线先挡住误操作；避免给 LOCAL 订单写出 `Shipment` 记录）。

### 新错误码（12 个）

| code | HTTP | 含义 | 出现位置 |
|---|---|---|---|
| 42204 | 400 | 同城订单请在同城看板操作 | 邮寄端点 `admin/orders/:id/{accept,ship,complete}` 命中 LOCAL 订单（沿用既有「订单状态错误」码，非新增码值，此处为新用法） |
| 42210 | 400 | 同城配送未达起送金额 | `POST /api/orders`（LOCAL 分支）/ `POST /api/local/quote`（沿用既有「未达起送门槛」码，LOCAL 走独立门槛 `minOrderAmount`） |
| 42220 | 400 | 超出配送范围 | `POST /api/orders`（LOCAL）、`POST /api/local/quote` 隐含在 `inRange=false` |
| 42221 | 400 | 请先取消配送单 | M1 阶段仅预留码值不会抛出；**M2 起已实现**（`services/refund.ts`），见附录 C |
| 42222 | 400 | 当前非营业时间 | `POST /api/orders`（LOCAL 分支下单时校验；`/local/quote` 只提示不拦截） |
| 42223 | 400 | 地址缺少定位（未在地图上选点） | `POST /api/local/quote`、`POST /api/orders`（LOCAL） |
| 42224 | 400 | 商品渠道与下单渠道不符 | `POST /api/orders` 逐行校验 `product.channel === channelOfDeliveryType(deliveryType)` |
| 42226 | 400 | 同城配送未开通 / 已暂停 / 门店未设坐标 | `POST /api/local/quote`、`POST /api/orders`（LOCAL） |
| 42227 | 400 | 配送费已更新，请刷新后重新提交 | `POST /api/orders`（LOCAL，携带 `quoteToken` 且「重算运费更贵」或「签发后同城设置改过（`version` 不符）」时） |
| 42229 | 400 | 已超过可取消时间 / 已提交过取消申请 | `POST /api/orders/:id/cancel-request` |
| 42230 | 400 | 超出单次配送件数/重量上限 | `POST /api/orders`（LOCAL） |
| 42231 | 400 | 该分类下有待付款订单，暂不可切换渠道 | `PUT /api/admin/categories/:id`（改 `channel` 时，`services/product-channel.ts`） |

> 上述 12 个码值均在计划文档 `docs/superpowers/plans/2026-09-03-local-delivery-m1-channel-foundation.md` 的 Global Constraints 一节列出（`42221` 在 M1 阶段仅预留码值，M2 起已实现，见附录 C）；`42225`（呼叫骑手失败）、`42228`（已有进行中的配送单）两个码值不在该清单中，同样在 M1 阶段仅预留，**M2 起已实现，用法见附录 C**。

---

## 附录 C：同城配送 API（M2）

M2 在 M1「渠道基础设施」之上补齐「配送服务」：骑手呼叫、配送单状态机（对接快递100）、店内自送、拒单（两渠道通用）、顾客端骑手位置、同城定时任务。设计依据 `docs/superpowers/specs/2026-09-03-local-delivery-design.md` §5。

### 接单工作台快照 `GET /api/admin/workbench/snapshot`

M2-B 店员默认落地页 `/workbench` 的唯一数据源：归类（五列）与排序都在服务端做——同城恒排邮寄之上是产品规则，不是前端展示偏好，放服务端保证未来别的客户端复用同一口径。**3 秒进程内缓存**（挡 10 秒轮询×多店员的洪峰）；`?fresh=1` 跳过缓存供操作后强刷。

响应：
```json
{
  "code": 0,
  "data": {
    "columns": {
      "pending": [ /* PAID：待接单 */ ],
      "preparing": [ /* PREPARING 且非「等待配送员」的部分：备餐中 */ ],
      "waitingCourier": [ /* 仅 LOCAL：PREPARING 且配送单处于 CALLING/ACCEPTED/ARRIVING/ARRIVED/REASSIGNING/ABNORMAL/UNKNOWN */ ],
      "delivering": [ /* SHIPPED：配送中 */ ],
      "done": [ /* 今日 COMPLETED，最新在前，最多 30 条 */ ]
    },
    "stats": { "todayOrders": 42, "todayRevenueFen": 128000, "avgDeliverMinutes": 27 },
    "circuit": { "tripped": false },
    "localEnabled": true, "localOpenNow": true,
    "paused": null,
    "printer": { "status": "NOT_CONNECTED" },
    "pendingAlerts": 1,
    "now": "2026-09-04T03:00:00.000Z"
  }
}
```
- 每张卡片（`columns.*[]`）字段与前端 `WorkbenchCard` 类型同构：`waitSince` 是本列的计时锚点（各列锚点不同，见路由源码注释），`items` 是摘要（`first` 前两菜名、`kinds` 种数、`units` 总份数），`local.delivery` 为该单当前有效配送单的精简视图（无则 `null`）
- `avgDeliverMinutes` 只统计**当天下单当天完成**的同城单（`paidAt` 与 `completedAt` 都在今天）——跨零点完成的单会把均值拉高但不代表真实配送时长
- `pendingAlerts` = 顾客取消申请待处理数 + 配送异常（`ABNORMAL`/`UNKNOWN`）数 + 熔断中(1)
- `printer.status` 目前恒为 `NOT_CONNECTED`（打印机对接是 M2b 范围，此处先占位）
- 历史订单检索**不**在此端点：`/local/orders` 页走既有 `GET /api/admin/orders?deliveryType=LOCAL`

### 管理端：同城配送单操作 `/api/admin/local/orders/:id/*`

除标注外均要求订单 `deliveryType=LOCAL`；订单不存在 → `40401`。

| 接口 | 说明 |
|---|---|
| `POST /:id/accept` | 接单，`PAID → PREPARING`（只标记开始备餐，不呼叫骑手）。非 `PAID` → `42204` |
| `POST /:id/accept-and-call` | 接单 + 立即呼叫骑手的组合端点。接单成功但呼叫失败时**接单结果保留**（不回滚），错误信息前缀「已接单，」；响应 `{ accepted: true, ...call响应 }` |
| `POST /:id/call` | 呼叫骑手：落一条 `Delivery(PENDING→CALLING)` 占位（`activeOrderId` 唯一索引防并发重呼，撞了 → `42228`）→ 事务外调用快递100 `batchOrder`。仅 `PREPARING` 且无顾客取消申请、有收货坐标可呼叫，否则 `42204`/`42223`。响应 `{ deliveryId, deliveryNo, status: 'CALLING'\|'UNKNOWN', quotedFeeFen }`：`CALLING` = 下单成功；`UNKNOWN` = 下单响应超时，占位保留等回调认领。明确失败（配置错误/余额不足/运力异常重试耗尽）→ `42225`；熔断中 → `42232` |
| `GET /:id/delivery` | 该订单当前有效配送单（无则取最近一张历史单）+ 事件时间线。响应 `{ delivery, events[] }`；`delivery` 为 `null` 表示从未呼叫过 |
| `POST /:id/delivery/precancel` | 预估取消费（只读，不真取消，用于取消前给店员看一眼要扣多少钱）。响应 `{ cancelFeeFen }`。无在途单 → `42233`；尚未成单（无 `providerTaskId`）→ `42234` |
| `POST /:id/delivery/cancel` | 取消在途配送单（真取消，调用快递100 `cancel`）。Body `{ reason? }`（≤255 字）。响应 `{ cancelFeeFen }`；取消费与小费一律店铺承担，记入 `Delivery` 对账。取消请求超时（状态未变化）→ `42238`；无在途单 → `42233`；状态已变化（并发）→ `42237` |
| `POST /:id/delivery/tip` | 加小费（仅 `CALLING` 待抢单阶段可加，超过设置里的单次/单笔累计上限 → `42235`）。Body `{ amount }`（整数分，1-100000）。响应 `{ tipFeeFen }`（累计小费）。运力拒绝/请求超时 → `42236` |
| `POST /:id/self-deliver` | 店内自送：新建 `Delivery(provider='SELF', status='DELIVERING')`，订单 `PREPARING → SHIPPED`。Body `{ name, phone }`。响应 `{ deliveryId, deliveryNo }`。已有在途配送单 → `42228`（若是「状态未确认」单则提示先作废 → `42234`） |
| `POST /:id/delivered` | 标记已送达：配送单 → `DELIVERED`，订单 → `COMPLETED`。无在途单 → `42233`；并发状态已变化 → `42237` |
| `POST /:id/delivery/void` | 作废「状态未确认」（`UNKNOWN`）配送单——人工核实快递100 后台确认无单后使用。仅 `UNKNOWN` 状态可作废，否则 → `42234` |

### 拒单 `POST /admin/orders/:id/reject`

**两渠道通用**（EXPRESS 与 LOCAL 均可调用，挂在共享的 `admin/orders.ts` 而非同城专属路由）——店家在邮寄场景同样可能需要因缺货/超范围/顾客口头取消而拒单，没必要为同一动作维护两套端点。

允许状态：`PENDING_PAYMENT` / `PAID` / `PREPARING`；`SHIPPED` 及以后（已出餐/在途）→ `42204`，须改走退款或售后。

Body：
```json
{ "reason": "SOLD_OUT", "note": "只剩最后一份被点走了", "soldOutProductIds": [12, 15] }
```
- `reason`：`SOLD_OUT`(菜品售罄) / `OUT_OF_RANGE`(超出配送范围) / `PAST_ACCEPT_TIME`(已过接单时间) / `CUSTOMER_CANCEL`(顾客电话要求取消) / `OTHER`(其他原因)
- `reason='OTHER'` 时 `note`（≤40 字）必填，否则 `40001`
- `reason='SOLD_OUT'` 时 `soldOutProductIds` 必须非空；且所有 id 必须属于本订单商品，否则 `40001`
- **终态**：待付款订单直接 `CANCELLED` + 库存回滚；**已付款订单终态是 `REFUNDED`（不是 `CANCELLED`）**——走标准 `initiateRefund` 全额退款，而非绕开退款子系统直接改状态，从而保住退款幂等（不会有两条并行退款记录）、对账（`Refund` 表记录）与 42221 前置校验（有在途配送单先拦，见附录中「配送单操作」表的 `delivery/cancel`）
- 拒单原因原样拼进 `Order.cancelReason`（顾客可见）：`商家拒单：<原因中文>（<note>）`
- **售罄联动下架**：勾选的商品在同一次请求里从 `ON_SHELF` 改 `OFF_SHELF`（独立小事务，失败只告警不回滚——退款已是既成事实，不下架的话同样的单还会再来一遍）

响应：
```json
{ "code": 0, "data": { "orderId": 88, "refund": { "outRefundNo": "refund_88_...", "status": "PROCESSING" }, "offShelfCount": 2, "cancelReason": "商家拒单：菜品售罄（只剩最后一份被点走了）" } }
```
`refund` 在待付款分支为 `null`。

### 回调 `POST /api/kd/:deliveryNo`

快递100 配送单状态回调，公开路由（安全性来自逐单随机 `callbackSalt` 验签，不用 JWT），`x-www-form-urlencoded`。挂在 `/api/kd` 前缀下（不在 `/api/admin` 或 `/api/local` 家族里），路径里的 `deliveryNo` 是查单的第一优先键（下单前就已写死进 `callbackUrl`，比事后猜测可靠）。

**验签**：请求体含 `param`（JSON 字符串）与 `sign`；`sign = MD5(param + salt).toUpperCase()`（`salt` 是建单时随机生成、按配送单存储的 16 字符串，不是全局密钥）；服务端用该配送单的 `callbackSalt` 重算并 `timingSafeEqual` 比对（先按字节长度短路，避免变长输入直接进 `timingSafeEqual` 抛异常）。

**应答契约（与微信支付回调相反，务必记住）**：微信支付回调失败可以返非 200 促使微信重推，因为随时能反查订单状态；快递100 **没有等价的查单接口**，回调是唯一事实来源，对它返回非 200 会让快递100 停止重推、这次状态转移永久丢失。因此：
- **仅「数据库入库异常」返 `500`**（例如 `UNKNOWN` 认领时 `providerTaskId` 撞了另一条配送单的唯一索引）——这是唯一会让快递100 重推的情形。
- **其余一律 `200`**：查不到配送单、验签失败、并呼场景下未中标运力推来的假撤单、`dedupeKey` 命中的重复回调、乱序/迟到的旧状态包、`PROVIDER_STATUS_MAP` 未收录的未知状态码——统统留痕/告警后原地应答 200，不依赖重推。

响应体：
```json
{ "result": true, "returnCode": "200", "message": "成功" }
```
入库失败时 HTTP 500，`result: false`。`result` 字段仅供人工核对回调日志，快递100 是否重推只看 HTTP 状态码。

状态机细节（rank 单调推进、旁路态、N8 特例、720 回退）见 spec §5.3；回调幂等键 `dedupeKey = CB:<deliveryNo>:<providerStatus>:<updateTime ?? md5(rawBody)>`（`services/delivery/events.ts`）。

### 顾客端骑手位置 `GET /api/orders/:id/courier`

`findFirst({id, userId})` 校验订单归属（非本人订单 → `40401`）。仅当该订单有在途配送单且状态 ∈ `ACCEPTED/ARRIVING/ARRIVED/DELIVERING`（已上路）才真的查询；否则直接返回 `{ location: null }`，不外呼。

响应：
```json
{ "code": 0, "data": { "location": { "latE6": 29350000, "lngE6": 104790000 } } }
```
- **20 秒进程内缓存**（按 `delivery.id` 键控）：避免顾客端轮询把 `queryCourier` 打爆
- **运力方查询故障时也负缓存**（`location: null` 并写入缓存）：否则每次轮询都会真打一次外部 API，把故障放大成订单页反复报错

### 探测接口 `POST /admin/settings/local-delivery/probe`

用当前门店坐标 + 一个探测点试算运力报价（`batchPrice`，**不落库、不下单**），用于开店前核实某个方向/距离是否有运力覆盖，及大致费用。

Body：`{ latE6, lngE6 }`（探测点坐标）。门店尚未设置坐标 → `42226`。

响应：
```json
{ "code": 0, "data": { "feeFen": 500, "distanceM": 3200 } }
```

### Mock 控制面 `/api/admin/system/kd100-mock/*`

**仅 mock 模式挂载**（`config.mock.delivery=true` 时才 `router.use`；生产环境这组路由完全不存在，不是靠鉴权/环境判断拒绝，是压根没注册）。供本地开发与 e2e 注入异常场景（超时、30004/30005 等错误码、precancel/addTip/queryCourier 的自定义返回）而不必真的接快递100。

| 接口 | 说明 |
|---|---|
| `POST /reset` | 重置 mock 状态（清空已排队的指令与调用记录） |
| `POST /queue` | 排队下一次某个操作（`createOrder`/`cancelOrder`/`precancelOrder`/`addTip`/`queryCourier`/`price`）的返回结果或异常。Body `{ op, directive }` |
| `GET /calls` | 已记录的调用列表（供断言「呼叫了几次」「重试了几次」） |
| `GET /salt/:deliveryNo` | 取某配送单的 `callbackSalt`（e2e 用它在测试里现算正确的回调签名，无需读数据库） |

### `POST /admin/system/kd100-circuit/reset` —— 手动恢复余额熔断

快递100 返回 30004（余额不足）时，服务端会把「呼叫骑手」整体熔断（进程内存态，拒绝一切新呼叫直到手动恢复），避免同一天里反复余额不足反复告警。此接口无环境限制（管理员登录即可），是店主充值后点击「恢复」用的**生产可用**功能，与仅供联调用的 mock 控制面不是一回事。响应为当前熔断状态：
```json
{ "code": 0, "data": { "tripped": false, "trippedAt": null, "reason": null, "operator": "admin" } }
```

### `run-scheduler` 新增 override 键

`POST /admin/system/run-scheduler`（仅非生产，`config.isProduction` 时 `40301`）在 M1 既有的 `payTimeoutMin`/`autoCompleteDays`/`remindAfterMin` 之外，本里程碑新增 7 个同城定时任务的阈值覆盖键（供联调/e2e 精确控制触发时机，不必真等几分钟）：

| 键 | 对应任务 |
|---|---|
| `callTimeoutMin` | 待抢单（`CALLING`）超时提醒 |
| `acceptedStuckMin` | 骑手已接单但卡在 `ACCEPTED/ARRIVING/ARRIVED` 提醒 |
| `deliveringTimeoutMin` | 配送中（`DELIVERING`）超时提醒（老板告警） |
| `unknownStuckMin` | `CALLING`/`UNKNOWN` 且无 `taskId`（幽灵单）超时提醒 |
| `localUncalledMin` | 已接单但迟迟未呼叫骑手提醒 |
| `cancelRequestPendingMin` | 顾客申请取消超时未处理提醒 |
| `autoCallDelayMin` | 接单后自动呼叫骑手的延迟（每单最多触发一次；有取消申请或历史呼叫记录则不触发） |

### 新错误码（7 个，`42232`-`42238`）

`42221`/`42225`/`42228` 三个码值早在 M1 阶段就已列入设计（见附录 B「新错误码」表），彼时业务逻辑未实现；M2 起已在下列位置真正抛出：`42221`→`services/refund.ts`（有在途配送单先拦退款/拒单）、`42225`/`42228`→`services/delivery/orchestrator.ts`（呼叫/取消失败、已有在途配送单）。以下是本里程碑新增的码值，均在 `services/delivery/orchestrator.ts` 抛出：

| code | HTTP | 含义 | 出现位置 |
|---|---|---|---|
| 42232 | 400 | 快递100 余额不足已暂停呼叫，请充值后在系统状态页点「恢复」 | `POST /:id/call`（`isCircuitTripped()` 为真时直接拒绝，不再外呼） |
| 42233 | 400 | 无在途配送单 | `POST /:id/delivered`、`delivery/precancel`、`delivery/cancel`、`delivery/void` 等要求存在有效 `Delivery` 的操作 |
| 42234 | 400 | 配送单状态不允许该操作（尚未成单 / 状态未确认需先等回调认领或作废 / 仅「状态未确认」可作废） | `delivery/void`（非 `UNKNOWN` 状态）、`delivery/precancel`/`delivery/tip`（无 `providerTaskId`）、`self-deliver`（存在 `UNKNOWN` 单需先作废）、其余要求「非 `UNKNOWN`」的操作 |
| 42235 | 400 | 加小费超限或状态不允许（仅 `CALLING` 可加、超单次上限、超单笔累计上限、状态已变化） | `delivery/tip` |
| 42236 | 400 | 加小费被运力方拒绝，或请求超时 | `delivery/tip`（调用快递100 `addfee` 失败/超时） |
| 42237 | 400 | 配送单状态已变化，请刷新（并发保护：`updateMany` 命中 0 行） | `delivery/void`、`delivery/cancel`、`delivered` |
| 42238 | 400 | 取消请求超时，请稍后重试（状态未变化） | `delivery/cancel`（调用快递100 `cancel` 超时；本地状态保证未被误改） |

> 上述 7 个码值出现在 `docs/superpowers/plans/2026-09-03-local-delivery-m2-engine.md` 的 Global Constraints 表。HTTP 状态码全部是 400——`AppError` 的 `httpStatus` 默认值即 400，`services/delivery/orchestrator.ts` 里这些抛出均未传第三个参数覆盖默认值（与项目里绝大多数业务错误码的约定一致，业务语义全靠 `code` 区分，HTTP 状态码本身不承载语义）。
