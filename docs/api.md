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
| 42204 | 支付金额不匹配 |
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
| `POST /api/local/quote` | 地址/坐标报价。`optionalUserAuth`：传 `addressId` 需登录（校验地址归属）；传 `latE6,lngE6` 可匿名（如未登录预览页）。Body `{ addressId?, latE6?, lngE6?, subtotal?=0 }`（金额分，`addressId` 与坐标二选一）。返回 `{ enabled, isOpen, paused, nextOpenText, inRange, distanceM, straightDistanceM, fee, minOrderAmount, belowMin, estimatedMinutes, quoteToken }`；`quoteToken` 仅在 `inRange=true` 时签发，TTL 5 分钟，下单时可携带以锁定报价（见下） |
| `POST /api/orders`（LOCAL 分支） | `deliveryType: 'LOCAL'` 时走独立计费（`services/local-settings.ts`，**不调用**全局运费 `getShippingSettings/calcShippingFee`）：校验营业时段/暂停/门店坐标/地址坐标/配送范围/起送门槛/单次件数与重量上限。可选传 `quoteToken`（`/local/quote` 返回的令牌）：实收运费取 `min(token.fee, 重算 fee)`，仅当重算更贵时才报 42227，让顾客在浏览到下单之间的正常延迟不必重新报价 |
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

### 新错误码（11 个）

| code | HTTP | 含义 | 出现位置 |
|---|---|---|---|
| 42204 | 400 | 同城订单请在同城看板操作 | 邮寄端点 `admin/orders/:id/{accept,ship,complete}` 命中 LOCAL 订单（沿用既有「订单状态错误」码，非新增码值，此处为新用法） |
| 42210 | 400 | 同城配送未达起送金额 | `POST /api/orders`（LOCAL 分支）/ `POST /api/local/quote`（沿用既有「未达起送门槛」码，LOCAL 走独立门槛 `minOrderAmount`） |
| 42220 | 400 | 超出配送范围 | `POST /api/orders`（LOCAL）、`POST /api/local/quote` 隐含在 `inRange=false` |
| 42222 | 400 | 当前非营业时间 | `POST /api/orders`（LOCAL 分支下单时校验；`/local/quote` 只提示不拦截） |
| 42223 | 400 | 地址缺少定位（未在地图上选点） | `POST /api/local/quote`、`POST /api/orders`（LOCAL） |
| 42224 | 400 | 商品渠道与下单渠道不符 | `POST /api/orders` 逐行校验 `product.channel === channelOfDeliveryType(deliveryType)` |
| 42226 | 400 | 同城配送未开通 / 已暂停 / 门店未设坐标 | `POST /api/local/quote`、`POST /api/orders`（LOCAL） |
| 42227 | 400 | 配送费已更新，请刷新后重新提交 | `POST /api/orders`（LOCAL，携带 `quoteToken` 且重算运费更贵时） |
| 42229 | 400 | 已超过可取消时间 / 已提交过取消申请 | `POST /api/orders/:id/cancel-request` |
| 42230 | 400 | 超出单次配送件数/重量上限 | `POST /api/orders`（LOCAL） |
| 42231 | 400 | 该分类下有待付款订单，暂不可切换渠道 | `PUT /api/admin/categories/:id`（改 `channel` 时，`services/product-channel.ts`） |

> 上述 11 个码值均在计划文档 `docs/superpowers/plans/2026-09-03-local-delivery-m1-channel-foundation.md` 的 Global Constraints 一节列出；`42221`（请先取消配送单）、`42225`（呼叫骑手失败）、`42228`（已有进行中的配送单）三个码值已在设计中预留，但业务逻辑属于 M2（依赖尚未实现的 `Delivery` 配送单模型），M1 代码不会抛出。
