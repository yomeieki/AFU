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
| 4228x | 到店自取（见附录 H） |

### 1.5 金额说明

- 所有金额字段单位为**分（整数）**。
- 示例：`price: 2990` 表示 29.90 元。
- 前端展示时自行除以 100。

### 1.6 版本响应头

- 所有响应带 `X-App-Version`（git 短 SHA 或 `dev`），后台据此提示刷新。

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
        "status": "ON_SHELF",
        "categoryId": 1,
        "sortOrder": 0
      }
    ],
    "total": 30,
    "page": 1,
    "pageSize": 20
  }
}
```

**排序规则**（2026-09-17 分类内排序设计 §4.1，`services/product-sort.ts` 唯一实现，公开列表与后台列表共用）：
1. `isRecommended` 降序（推荐商品整个列表最前）；
2. 分类 `sortOrder` 升序，相同再按 `categoryId` 升序；
3. 分类内：该分类 `productSortMode=MANUAL` → 按商品 `sortOrder` 升序，相同按 `createdAt` 升序；`SALES_30D` → 按近 30 天销量降序，相同按 `sortOrder`、`createdAt` 升序；
4. 最后一律按 `id` 升序兜底，保证分页稳定。

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
  "data": { "id": 1, "channel": "EXPRESS", "quantity": 2, "capped": false, "added": 2 }
}
```

**说明：** 若商品已在购物车中，数量累加；累加后超过库存时静默按库存封顶（不报错）。
`quantity` 是封顶/累加后的最终数量，`capped` 标记本次是否被封顶，`added` 是本次
实际加入的件数（被封顶时小于请求的 `quantity`；购物车内已是库存上限时为 0）。

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

编辑分类（字段同新增；partial 更新，不带的字段不动）。可带 `productSortMode`，值域 `MANUAL`（手动排序，默认）/ `SALES_30D`（按近 30 天销量降序），非法值 40001。改了排序方式（值真的变化时）会清一次销量聚合缓存，让公开列表立刻按最新排序重排。

#### DELETE /api/admin/categories/:id

删除分类（检查是否有关联商品，有则拒绝或提示）。

#### POST /api/admin/categories/:id/product-order

保存某分类下商品的手动排序（拖拽/上下移一次即调一次）。

**Request Body:**
```json
{ "ids": [12, 10, 11] }
```

`ids` 必须**正好**是该分类下全部未删除商品（顺序即目标顺序）；多、少、重复、混入其它分类的 id 一律 `40001`（文案：`商品列表与该分类当前商品不一致，请刷新后重试`）。成功后按数组下标把每个商品的 `sortOrder` 写成其下标（0-based），并清一次销量聚合缓存。

**Response:**
```json
{ "code": 0, "data": { "updated": 3 } }
```

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
| pageSize | 每页数量，默认 20，最大 **200**（选定分类拖拽排序要求一页取完该分类全集，2026-09-17 分类内排序设计 §5） |

`categoryId` 有值时，列表顺序与顾客端 `GET /api/products` 一致（同一套 `sortProducts` 规则，见该接口文档的「排序规则」）；不带 `categoryId` 时顺序仍是 `createdAt desc`。每项都新增 `sortOrder`（分类内手动排序值）与 `sales30d`（近 30 天销量，整数，无销量为 0）。手动排序方式下的拖拽保存见 `POST /api/admin/categories/:id/product-order`。

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

**Query Params（实际实现，2026-09-18 订单详情页 + 日期筛选核实并补齐）：**
| 参数 | 说明 |
|------|------|
| page | 页码，默认 1 |
| pageSize | 每页数量，默认 20，上限 50 |
| status | 订单状态筛选；逗号分隔可传多个（如 `REFUNDING,REFUNDED`）。伪状态 `REFUND_ATTENTION`（2026-09-22）= 退款待处理：`status=REFUNDING` 且没有 PENDING/PROCESSING 的退款记录（无记录 / ABNORMAL / CLOSED / FAILED，都要人出手）；与其他状态不能并列 |
| keyword | 订单号 / 收货人 / 手机号模糊（`orderNo` 为旧参数名，仍兼容） |
| deliveryType | `EXPRESS` \| `LOCAL` \| `PICKUP` \| `ALL`，默认 `EXPRESS` |
| channel | `LOCAL`（一次看外送+自取）\| `EXPRESS`；与 `deliveryType` 同传时以 `channel` 为准 |
| startDate | 下单日期起（含），`YYYY-MM-DD`，**上海自然日**，按 `createdAt` 过滤，可选 |
| endDate | 下单日期止（含），`YYYY-MM-DD`，同上，可选；只传其一表示「从/到该日起/止」 |

日期参数各自可选、按上海自然日解释（进程本地时区，生产为 Asia/Shanghai）；格式不对、不是真实日历日（如 `2026-02-30`）、或起晚于止，一律 `40001`。不传日期 = 不限日期（默认全部历史）。

**出参**（`data.list` 每项新增）：`latestDelivery`（最近一张配送单的 `{status, courierName, courierCompany, provider}`，非同城单为 `null`）。

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

#### ~~POST /api/admin/orders/:id/refund-complete~~（2026-09-22 已删除）

原「人工标记退款完成」兜底：不问微信、不核金额就把 `REFUNDING` 订单标成 `REFUNDED`，误点即一笔假退款。自动补查（附录 L）上线后回调丢失的场景由系统自己查微信落账，此接口与后台按钮一并去掉。店主在商户平台手动打款而不经系统的情况，现无接口可记，需要时按运维流程改库。

`GET /api/admin/orders` 列表每项附带 `latestRefund`（最近一条退款记录：`status` / `outRefundNo` / `amount` / `mode` / `errorMessage`）。

### 3.6 用户管理

#### GET /api/admin/users

用户列表。

**Query Params:**
- page, pageSize
- keyword：匹配昵称、微信绑定手机号（users.phone，目前实际总是空），或**该用户任一订单**的收货人姓名/收货人手机号（子串匹配，天然支持只输尾号）
- hasOrders：只认字面量 `1`——只列「下过单的」（orders 表任一状态 ≥1 条，与 orderCount 列同一口径）。不传或传其他值都不过滤，默认返回全部用户（后台前端默认勾选「只看下过单的」发 `hasOrders=1`，但接口本身不预设这个过滤，调用方不传就是不过滤）

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
        "pointsBalance": 120,
        "availableCoupons": 2,
        "lastLoginAt": "2024-01-01T10:00:00Z",
        "createdAt": "2024-01-01T10:00:00Z",
        "latestOrder": {
          "orderNo": "ORD202409010001",
          "receiverName": "张三",
          "receiverPhone": "13800008000",
          "status": "PAID",
          "createdAt": "2024-09-01T10:00:00Z"
        }
      }
    ],
    "total": 100
  }
}
```

`latestOrder`：该用户 createdAt 最新的一张订单快照，**不排除任何状态**（含 PENDING_PAYMENT、CANCELLED、isTest），没下过单则为 `null`。这是订单收货人信息，不代表用户本人改过昵称或绑定过这个手机号——users.phone/nickname/avatarUrl 目前只在极少数场景被写入，`latestOrder` 是后台前端用来兜底展示「这串号码最近打给谁用过」的依据，不是身份认证结果。

---

#### GET /api/admin/users/:id/orders

查看指定用户的订单列表（参数同订单列表）。

---

### 3.7 数据统计

> 口径（2026-09-08 起）：所有经营统计按**付款日**归属（`paid_at` 落在区间，上海自然日），
> 状态不限、排除测试单（`is_test`）。区间参数 `startDate`/`endDate`（`YYYY-MM-DD`，含端，默认近 7 天，最长 92 天）。
> 每个接口返回 `range.{startDate,endDate,prevStartDate,prevEndDate}`，`prev` 为紧挨在前的等长区间。金额单位分。

#### GET /api/admin/stats/overview?startDate&endDate&channel=ALL|LOCAL|EXPRESS
总览：`kpi{revenueFen,refundFen,orderCount,avgOrderFen,prev}`、`channels{LOCAL,EXPRESS}{orderCount,revenueFen}`、
`trend[{date,LOCAL,EXPRESS}]`、`hourly[24]`、`customers{users,newUsers,returningUsers,repeatRate}`、
`hotProducts[{productId,name,qty,revenueFen}]`（按 order_items 聚合、排除赠品；只有它受 `channel` 影响）。

#### GET /api/admin/stats/local?startDate&endDate
同城：`kpi{orderCount,revenueFen,avgDistanceM,freeShipCount,freeShipRate,prev}`、
`freight{customerPaidFen,deliveryFen,tipFen,cancelFen,riderTotalFen,netFen,prev}`（netFen<0 = 补贴）、
`timing.stages[{key,label,medianMin,p90Min,n}]`（acceptToCall/callToRider/riderToPickup/pickupToDone/total）、
`providers[{provider,count,avgFeeFen,avgPickupMin}]`（`provider` 是 `courierCompany`/kuaidicom 编码——闪送/达达一类，
不是 Delivery.provider 那个 KD100|SELF|MOCK 渠道抽象；avgPickupMin = 呼叫→取货）、`ladder{first,cheapestN,all}`、
`distance[{label,count}]`、`cancels{requested,deliveryCancelled}`。

#### GET /api/admin/stats/express?startDate&endDate
邮寄：`kpi{orderCount,revenueFen,shippingFeeFen,prev}`、`backlog{count,oldestHours,oldestOrderNo}`（**实时**，不受区间影响）、
`shipTiming{medianHours,p90Hours,n}`、`companies[{name,count}]`、`regions[{province,count}]`（Top 5）、
`afterSales{refundCount,refundFen,afterSaleCount}`。

#### GET /api/admin/stats

基础统计数据。`today.*` 与 `/trend` 同为付款日口径（见上）。

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
| `GET /api/admin/orders?startDate=&endDate=` | 2026-09-18：按上海自然日筛选下单日期（各自可选）；列表增 `latestDelivery`，详见 3.5 节 |
| `GET /api/admin/express/orders/:id/booking` | 2026-09-18：响应增 `track`（`{updatedAt, signed, items[≤30]}` \| `null`），管理端订单详情页展开物流轨迹用，与顾客端同口径；`booking`/`events` 不变 |
| `POST /api/admin/orders/:id/refund` | `amount` 可为部分（≤ 可退余额）；响应增 `isFull` |
| `POST /api/admin/orders/:id/complete` | SHIPPED → COMPLETED |
| `GET /api/admin/after-sales?status=` | 售后单列表（含订单摘要、`remainingRefundable`、`reasonLabel`） |
| `POST /api/admin/after-sales/:id/approve` | `{ amount, reply? }` → 发起退款并置 APPROVED（回调成功 → DONE） |
| `POST /api/admin/after-sales/:id/reject` | `{ reply }` → REJECTED |
| `GET /api/admin/orders/pending-count` | 增 `afterSaleCount` |
| `POST /api/admin/webview-code` | admin token → 一次性 code（2 分钟） |
| `POST /api/admin/login/webview` | `{ code }` → token（小程序 web-view `/m?code=` 用） |
| `POST /api/admin/system/run-scheduler` | 非生产：手动跑一轮定时任务，可传阈值覆盖；2026-09-21 起新增 5 个退款补查覆盖键（附录 L） |
| `POST /api/admin/system/pay-mock/{reset,refund-query,calls}` | 仅 `WECHAT_PAY_MOCK=true` 时挂载，退款查询 mock 控制面（附录 L） |

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
| `POST /api/local/quote` | 地址/坐标报价。`optionalUserAuth`：传 `addressId` 需登录（校验地址归属）；传 `latE6,lngE6` 可匿名（如未登录预览页）。Body `{ addressId?, latE6?, lngE6?, subtotal?=0 }`（金额分，`addressId` 与坐标二选一）。返回 `{ enabled, isOpen, paused, nextOpenText, inRange, distanceM, distanceSource, straightDistanceM, fee, minOrderAmount, belowMin, estimatedMinutes, quoteToken }`。`distanceM` 优先取运力方 `batchPrice` 返回的**真实道路距离**（5 秒超时）；查不到就退回 `直线 × detourFactor` 的估算，**不报错**，此时 `distanceSource='ESTIMATED'`（实测为 `'MEASURED'`），调用方据此决定文案。`quoteToken` 仅在 **`inRange=true` 且传了 `addressId`** 时签发（匿名坐标报价签出来的 `addressId=0` 必然兑不了，索性不签），TTL **15 分钟**，签入 `fee/distanceM/addressId/收货坐标/门店坐标/distanceSource`（**不含 `settings.version`**；`distanceSource` 不参与信任比对，纯随行审计信息，见 `services/local-settings.ts` 的 `QuotePayload.distanceSource` 注释）。下单**必须**携带，见下 |
| `POST /api/orders`（LOCAL 分支） | `deliveryType: 'LOCAL'` 时走独立计费（`services/local-settings.ts`，**不调用**全局运费 `getShippingSettings`（旧一口价，已由 `express-quote-service` 取代））：校验营业时段/暂停/门店坐标/地址坐标/配送范围/起送门槛/单次件数与重量上限。**距离不再在这里重算，也没有兜底估算这条路**：`quoteToken` 是必填的——不带 / 验签或有效期不过 / `addressId` 不符 / **收货**坐标不符 → **42239**；**门店**坐标不符（店主改过门店坐标）→ 42227。全对时直接采用 token 里签过名的真实道路距离，范围与运费都按它判。**不比 `settings.version`**：除距离外每个量都在这里用当前设置重算，与门店坐标无关的设置变更（营业时间、备餐时长、费率、半径…）不作废在途报价。实收运费恒为**重算 fee**（凭证价从不胜出，只用来判断要不要拒单）：重算更贵 → 42227，否则按重算价收——距离同源之后这条挡的是顾客把 `/local/quote` 的 `subtotal` 报高换免运 token。订单落库时快照 `distanceSource`（取自 token，MEASURED/ESTIMATED），事后可直接从订单行判断这一单是按实测还是估算距离成交，不用关联其它表推断 |
| `POST /api/orders/:id/cancel-request` | 同城订单被接单（`PREPARING`）后 `acceptGraceMin` 分钟宽限期内，顾客可申请取消（订单状态**不变**，交由店员在后台确认后全额退款；不是自助取消）。Body `{ note? }` → `{ cancelRequestedAt }`。窗口外或已申请过 → 42229。M1 无配送单，`cancelRequestDeliveryStatus` 快照字段恒为 `NONE`（M2 起改为快照当时有效配送单状态） |

### 管理端

| 接口 | 说明 |
|---|---|
| `GET /api/admin/settings/local-delivery` | 读取完整同城配送设置（门店坐标/营业时段/运费阶梯/起送门槛/配送半径/接单宽限期/单次上限等），结构见 `LocalDeliverySettings`（`services/local-settings.ts`） |
| `PUT /api/admin/settings/local-delivery` | 全量保存。服务端先 `sanitizeLocalSettings` 再校验；`enabled=true`（开启同城配送总开关）时走更严格的 `validateForEnable`（例如必须已设置门店坐标） |
| `PATCH /api/admin/settings/local-delivery/store-location` | 单独更新门店坐标 `{ latE6, lngE6 }`（商家端「门店位置」地图选点用，不必先拉全量设置再整份 PUT——`apps/miniapp/pages/merchant/index.js` 调的是 `wx.chooseLocation` 手动选点，不是 `wx.getLocation` 自动定位，这里不是「一键」） |
| `POST /api/admin/settings/local-delivery/pause` | 临时暂停接单 `{ reason, until? }`（ISO datetime，缺省不限时） |
| `DELETE /api/admin/settings/local-delivery/pause` | 取消暂停 |

共享的邮寄端点 `POST /api/admin/orders/:id/accept|ship|complete` 命中 `deliveryType='LOCAL'` 的订单一律返回 42204「同城订单请在同城看板操作」（M1 尚无同城看板，这条防线先挡住误操作；避免给 LOCAL 订单写出 `Shipment` 记录）。

### 新错误码（13 个）

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
| 42227 | 400 | 配送费已更新，请刷新后重新提交 | `POST /api/orders`（LOCAL，「重算运费更贵」或「凭证签发后**门店坐标**变更」时） |
| 42229 | 400 | 已超过可取消时间 / 已提交过取消申请 | `POST /api/orders/:id/cancel-request` |
| 42230 | 400 | 超出单次配送件数/重量上限 | `POST /api/orders`（LOCAL） |
| 42231 | 400 | 该分类下有待付款订单，暂不可切换渠道 | `PUT /api/admin/categories/:id`（改 `channel` 时，`services/product-channel.ts`） |
| 42239 | 400 | 请重新获取配送报价后再提交 | `POST /api/orders`（LOCAL）：`quoteToken` 缺失/验签失败/已过期/`addressId` 或**收货**坐标与凭证不符。与 42227 的分工：42239 是「你手上这张票不作数，重报一次价」，42227 是「店家改了参数，刷新后重新提交」 |

> 上述码值中的 12 个均在计划文档 `docs/superpowers/plans/2026-09-03-local-delivery-m1-channel-foundation.md` 的 Global Constraints 一节列出（`42221` 在 M1 阶段仅预留码值，M2 起已实现，见附录 C）；`42239` 是后加的（强制报价凭证），占用 42238 与打印机的 42240-42242（M2b 起已实现，见附录 D）之间唯一的空位；`42225`（呼叫骑手失败）、`42228`（已有进行中的配送单）两个码值不在该清单中，同样在 M1 阶段仅预留，**M2 起已实现，用法见附录 C**。

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

### 顾客端 `GET /api/orders/:id` 的同城扩展字段

M1/M2 在通用订单详情响应之外，为 `deliveryType='LOCAL'` 的订单额外补了几个字段（`apps/server/src/routes/orders.ts`）：

| 字段 | 说明 |
|---|---|
| `canRequestCancel` | 是否可以调用下面的 `POST /:id/cancel-request`。仅当 `deliveryType==='LOCAL' && status==='PREPARING'` 且已接单（`acceptedAt` 非空）且未过 `acceptGraceMin` 宽限期且尚未申请过，为 `true`；其余一律 `false`（非同城订单恒 `false`） |
| `cancelRequestDeadline` | 宽限期截止时间（`acceptedAt + acceptGraceMin` 分钟），非同城订单或未接单时为 `null`。前端用它显示倒计时/「已超过可取消时间」 |
| `delivery` | 仅 `deliveryType==='LOCAL'` 时非 `null`，取该订单最近一条 `Delivery` 记录的顾客可见白名单视图（`customerDeliveryView`，`routes/orders.ts`）：`{ status, statusLabel, courierName, courierMobile, courierCompany, pickedUpAt, deliveredAt }`。**注意**：这与设计 spec §5.7 描述的白名单字段不完全一致——spec 里写的 `statusDesc`/`courierCompanyLabel`/`acceptedAt`/`estimatedDeliveryAt`/`events[]` 在当前代码里并不存在，实际字段名是 `statusLabel`（不是 `statusDesc`）、`courierCompany`（不是 `courierCompanyLabel`），且没有 `acceptedAt`/`estimatedDeliveryAt`/`events`。这是设计与实现的落差，本次文档同步只如实记录代码现状，未回头改 spec（不在本轮任务范围） |

**这三个字段只在 `GET /api/orders/:id`（详情）返回，`GET /api/orders`（列表）没有**——列表接口没有调用 `cancelWindowOf`，也没有查 `delivery`；顾客端「我的订单」列表页如果要判断能否申请取消，需要先进详情页。

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

---

## 附录 D：出票与打印机（M2b）

规格 `docs/superpowers/specs/2026-09-03-local-delivery-design.md` §8b。核心层（`printer.ts` 接口 /
`feie.ts` 飞鹅实现 / `mock.ts` / `content.ts` 票面渲染 / `printer-settings.ts` / `ticket/index.ts` 的
`enqueueOrderTicket`/`processQueue`/`repeatAnnounce`/`healthCheck`）由更早一批实现；本里程碑把它接进
业务流：付款成功触发出票、scheduler 三任务、工作台打印机状态灯、后台绑定/记录/重试接口。

### 触发点

| 事件 | 位置 | 说明 |
|---|---|---|
| 付款成功 | `routes/orders.ts`（mock 支付）、`routes/wechat-notify.ts`（真实微信支付回调） | `enqueueOrderTicket(orderId,'NEW_ORDER')`，fire-and-forget，与 `notifyOrderPaid` 并列，绝不阻塞回调应答；出票单独起一条 promise 链，不依赖同一处理函数里其它同步 void 通知函数是否抛出（H3） |
| 顾客申请取消（D6②） | `POST /api/orders/:id/cancel-request` | `printCancel=true` 时出 `CANCEL_REQUEST` 提醒票（H6：不是 `CANCEL`——这只是「申请」，店员可能驳回，票面文案与真正的取消要分开） |
| 取消申请被驳回 | `POST /api/admin/local/orders/:id/cancel-request/reject` | `printCancel=true` 时出 `RESUME` 票，提醒厨房「顾客还是要这一单，继续制作」（H6） |
| 顾客自助秒退（D6①） | `PUT /api/orders/:id/cancel`（`PAID` 且未接单分支） | 决定取消即出票，不等退款请求/回调确认完成 |
| 退款成功、订单累计退完全款 | `services/refund.ts` 的 `finalizeRefundSuccess`（事务提交后，`flippedToRefunded` 时） | 覆盖**全部**退款入口——后台一键退款（含 mock 同步 SUCCESS）、售后同意、顾客自助取消触发的退款、微信异步退款回调，各入口不必各自记得补一次；部分退款不出票；`CANCEL` 的 `dedupeKey` 固定 `seq=0`，同一单被多个入口重复推进只会真出一张 |
| 商家拒单 | `routes/admin/orders.ts` 的 `reject` | 只在「付过款、店里理论上已经知道这单」时补票；未付款单从没出过接单票，不需要补取消票（详见 `cb27694`）。原「人工标记退款完成」入口 2026-09-22 已删 |
| 店员手动重打 | `POST /api/admin/orders/:id/reprint` | `enqueueOrderTicket(orderId,'REPRINT')`，每次都新开一条记录，不做幂等 |
| 后台打印测试页 | `POST /api/admin/printers/:sn/test` | `orderId=0`、`orderNo='TEST'` |

`PrintJob.status` 状态机：`PENDING`（待发送/待重试）→ `SENDING`（认领态，发送中）→ `SENT`（已提交给服务商，等待轮询确认）→ `PRINTED`（已确认打印完成）；失败分支 `FAILED`、跳过分支 `SKIPPED`（如配置读取失败）。`SENDING` 是短暂的认领态，正常只在 `attemptSend` 执行期间可见；孤儿回收（进程被杀死留下的 `SENDING` 残留）会把它退回 `PENDING`。

### scheduler 新增三任务

| 任务 | 内容 |
|---|---|
| `printQueueSweep` | 兜扫 `PrintJob(PENDING)` 按 5s/30s/2min 退避重试；M2：普通失败（非超时）首发之后最多再重试 3 次，合计**最多 4 次发送**仍失败才转 `FAILED` + 告警（不是「3 次失败转 FAILED」——那样总共只发了 3 次，比规格少一次）；`TIMEOUT` 类失败另有更保守的封顶（首发 + 至多 1 次重试 = 最多 2 次发送，且重试前必须确认打印机在线，见 M11）；`CONFIG` 类错误不占重试次数，直接 `FAILED`；`SENT` 超 3 分钟未确认查一次平台状态 |
| `repeatAnnounce` | `PAID` 且等待超过 `repeat.localAfterMin`/`expressAfterMin` 分钟未接单 → 入队 `REPEAT` 作业（精简催单票或按 `repeat.reprint` 重打全票），次数耗尽告警老板 |
| `printerHealth` | 查全部已配置打印机状态；连续 `offlineAlertMin` 分钟离线/异常告警一次；恢复 `ONLINE` 时告知一次，并触发两条独立的补发路径：① `retryRecoveredPrinterJobs`——重打该打印机名下最近 30 分钟内、失败原因非 `CONFIG` 类的 `FAILED` 作业（超过窗口的旧单不补打）；② D2 `recoverFromOfflineQueue`——打印机离线期间飞鹅侧 `Open_printMsg` 其实仍返回成功（票已进云端队列，不会走到 `FAILED`），所以先查 `queryQueueInfo(sn).waiting`：`waiting<=0` 什么都不做；`waiting>0` 说明恢复瞬间飞鹅会把队列全部自动吐出，先 `clearQueue` 清空云端积压，再由本地 `PrintJob` 记录决定真正补发谁——30 分钟窗口内仍是 `PENDING`/`SENT`（未确认）的行重置为 `PENDING` 走 `attemptSend` 重发；超过窗口的旧单标 `FAILED` + `lastError='STALE:DROPPED'`（不算新故障，不告警） |

三个任务不经 `run-scheduler` 的 override（那是同城配送阈值专用的临时覆盖通道）——出票的开关/阈值都在
`Setting(key=printer)` 里，改阈值走 `PUT /admin/settings/printer`。

### 接口

| 接口 | 说明 |
|---|---|
| `GET/PUT /api/admin/settings/printer` | 打印机运营设置（`enabled`/`printers[]`/`voice`/`repeat`/`offlineAlertMin`/`printCancel`） |
| `POST /api/admin/printers/bind` | `{ sn, key, name? }`，成功调用飞鹅 `Open_printerAddlist` 后才写入设置；`key` 不落库明文 |
| `DELETE /api/admin/printers/:sn` | 只从本地设置移除，不调用飞鹅侧删除接口 |
| `POST /api/admin/printers/:sn/test` | 打印测试页 |
| `POST /api/admin/printers/:sn/clear-queue` | D2：手动清空该打印机云端待打印队列（飞鹅 `Open_delPrinterSqs`）。正常情况下由 `printerHealth` 检测到「离线恢复且 `waiting>0`」时自动调用，这里是给店主的手动入口 |
| `GET /api/admin/printers/status` | 现查一次全部已配置打印机状态（供设置页手动刷新；工作台状态灯走独立的缓存路径，见下） |
| `GET /api/admin/print-jobs?orderId=` | 打印记录：带 `orderId` 返回该订单最多 50 条，不带返回全局最近 20 条 |
| `POST /api/admin/print-jobs/:id/retry` | 仅 `FAILED` 状态可重试，条件写防并发 |
| `POST /api/admin/orders/:id/reprint` | 两渠道通用 |
| `GET /api/admin/workbench/snapshot` | `data.printer` 由硬编码 `NOT_CONNECTED` 改为真实健康检测归并结果：`{ status, printers[] }`，`status` 取多台打印机中「最差」的一个（任一 `OFFLINE`/查询出错 → `OFFLINE`；任一 `ABNORMAL`/`UNKNOWN` → `ABNORMAL`；否则 `ONLINE`；未启用/未绑定任何打印机 → `NOT_CONNECTED`） |

非生产（`PRINTER_PROVIDER_MOCK=true` 时才挂载于 `/api/admin/system/printer-mock`）：`POST /reset`、
`POST /state {sn,state}`、`POST /fail {sn,kind,message?}`、`GET /jobs?sn=`、`POST /retry-delays {delays}`、
`POST /health-track {sn,offlineSinceMsAgo,alerted}`、`POST /repeat-min-wait {ms}`——最后三个是测试专用钩子，
用于跳过重试退避（5s/30s/2min）、离线告警持续时长（下限 1 分钟）、重复播报等待阈值（下限 1 分钟）的真实
等待，e2e 秒级验证这几条路径，生产环境不挂载。

### 错误码 `42240`-`42242`

之前只是预留码值（见附录 B 末尾说明），本里程碑起在 `routes/admin/printer.ts` 的 `mapPrinterError`
实际抛出，对应 `services/ticket/printer.ts` 的 `PrinterError.kind`：

| code | HTTP | 含义 | 对应 PrinterError.kind |
|---|---|---|---|
| 42240 | 400 | 打印机未配置（账号/密钥/该渠道未绑定打印机等） | `CONFIG` |
| 42241 | 400 | 打印机离线 | `CAPACITY` |
| 42242 | 400 | 打印提交失败（附平台原文） | `BUSINESS`/`TIMEOUT` |

## 附录 E：会员积分与优惠券

设计依据 `docs/superpowers/specs/2026-09-04-member-points-coupon-design.md`；
顾客可见文案定稿 `docs/member-terms-copy.md`（**对外文字改动必须先改那份**）。

下面先是一份**完整端点表与错误码表**（查接口只看这两张就够），后面 E.1/E.2/E.3
按实施批次保留实现笔记——那些「为什么这么做」的内容是批次特有的，合并会丢掉上下文。

### 端点总表（2026-09-06 逐条对源码核对）

**顾客端**（`/api/member/*`，全部需要 `verifyUserToken`）

| 端点 | 说明 |
|---|---|
| `GET /member/summary` | 页头：`pointsBalance`、`pointsExpireAt`、`availableCoupons`、`points{enabled,earnRatePerYuan,validDays}`、`rulesText`。后两项供「规则说明」实时渲染——**合规公示项，不许在小程序里写死数字** |
| `GET /member/points/ledger?page=&pageSize=` | 积分流水。行含 `typeLabel`（服务端拼的中文）、`delta`、`refType`、`refId`、`remark`、`expiresAt`、`orderNo`。**不返回内部自增 id 与原始 type 码** |
| `GET /member/coupons?status=available\|used\|expired` | 我的券。**取值只认这三个小写字面量**，不是库里的 `UNUSED/USED/EXPIRED`。输出白名单不含 `issuedBy`/`remark`/`sourceRef`/`templateId` |
| `GET /member/mall` | 积分商城：`coupons[]`（可兑券模板）+ `gifts[]`（随单赠品，带 `channel` 供前端分组）。赠品在此**只展示不兑换** |
| `GET /member/campaign` | 领券中心：`list[]` 带 `remaining`（NULL = 不限量）与 `claimedByMe` |
| `GET /member/checkout-options?channel=&subtotal=` | 结算页选项。`subtotal` 传**券前**小计。券带 `usable` 与 `discount`，不可用的**也返回**并带 `reason`(`NOT_OWNER\|USED\|EXPIRED\|CHANNEL\|THRESHOLD`) + 中文 `message` |
| `POST /member/points/redeem` | 积分兑券 `{ templateId }` |
| `POST /member/coupons/claim` | 领券中心领取 `{ templateId }` |

**下单**：`POST /orders` 多收 `couponId?: number` 与 `gifts?: [{pointsGoodId, quantity}]`；
订单响应（列表与详情）多出 `discountAmount`、`pointsUsed`、`pointsEarned`、`items[].isGift`、
`items[].pointsCost`，详情另有 `coupon`（无券时为 `null`，不是字段缺失）。
**不返回** `pointsSettledAt`/`pointsBase`（内部记账字段，e2e §34 锁住）。

**管理端**（`/api/admin/*`，全部需要 `verifyAdminToken`）

| 端点 | 说明 |
|---|---|
| `GET /admin/coupon-templates?source=&status=` | 券模板列表。派生字段：`issuedTotal`（真实发出张数，**「已发」列用这个**）、`usedCount`、`usedAsNewcomer` |
| `POST /admin/coupon-templates` | 新建。`source` 建后不可改 |
| `PUT /admin/coupon-templates/:id` | 编辑。**无 DELETE**——删模板会让已发券的 `templateId` 悬空 |
| `GET /admin/coupon-templates/:id/issued?page=` | 发放记录（谁领了、谁发的、为什么发） |
| `GET /admin/points-goods` | 赠品列表。派生字段：`productName/productImage/productStatus/productChannel/specText/stock/unitPrice` |
| `POST /admin/points-goods` | 新建。`productId`/`skuId` 建后不可改 |
| `PUT /admin/points-goods/:id` | 编辑 |
| `DELETE /admin/points-goods/:id` | 硬删（`OrderItem` 落快照、不引用它的 id） |
| `GET /admin/settings/member` | 读会员设置 |
| `PUT /admin/settings/member` | 写会员设置（**整包覆盖**，先 GET 拿完整对象再传回） |
| `GET /admin/users` | 列表多两列：`pointsBalance`、`availableCoupons`（按**时间**判：`UNUSED && expiresAt > now`） |
| `GET /admin/users/:id/points-ledger?page=&pageSize=` | 该用户积分流水，`pageSize` 上限 50 |
| `GET /admin/users/:id/coupons?status=` | 该用户全部券。管理端**可以**读 `issuedBy`/`remark` |
| `POST /admin/users/:id/coupons` | 定向发券 `{ templateId, remark, orderNo? }`。只认 `source='ADMIN'` 模板；`remark` 必填；限流 30 次/分钟**按管理员名**计数 |

**`POST /admin/system/run-scheduler`** 的会员相关 override 键：`settleMissedPointsAfterMin`
（把「completedAt 至少 2 分钟前」这道门槛调小，e2e 用它免去等待）。

### 错误码（逐条对源码核对）

| 码 | 文案取向 | 实际触发点 |
|---|---|---|
| **42250** | 积分不足 | `checkout.ts` 事务前快速失败（带「本单需 N 分，当前 M 分」）；`points.ts` 的 `consumePoints` 两轮仍不足——**后者才是真防线**，前者只是提前给个好消息 |
| **42251** | 券不可用（**一律用这一个码**，靠 message 区分原因） | 券不存在 / 已使用 / 已过期 / 渠道不符 / 未达门槛（`checkout.ts`）；`actualAmount === 0`（`orders.ts`，「该券金额已超过本单可抵扣范围」）；并发抢用同一张券（`used.count === 0`，「优惠券已被使用」）；`redeemByPoints` 的「该券不支持积分兑换」 |
| **42252** | 赠品不可用 | 不存在 / 已下架 / 超每单限购 / 已兑完（`checkout.ts`，含事务内 `taken.count === 0` 的并发防线） |
| **42253** | 已领完或已达上限 | `perUserLimit` 已满 / `totalLimit` 递增失败（`redeemByPoints` 与 `claimCampaign` 各一处） |
| **42254** | 该券已停用 | `issueCoupon` 公共原语；`redeemByPoints` **必须在 `totalLimit` 的 updateMany 之前判**，否则会被含混的 42253 盖掉；`POST /admin/users/:id/coupons` |

> `NOT_OWNER` 的文案刻意说「优惠券不存在」而不是「不属于你」——后者等于确认了这张券存在，
> 拿别人的券号试探就能枚举出有效券号。

---

### E.1 M1：账本层

实施计划 `docs/superpowers/plans/2026-09-04-member-m1-ledger.md`。M1 只做服务端账本，
不改下单计价、不碰前端页面——积分商城/赠品/结算页用券在 M2。

### 数据模型

一次迁移建齐了 M1–M2 全部结构（`20260906000000_member_points_coupon`）：`PointsLedger`
（积分流水）、`CouponTemplate`（券模板）、`UserCoupon`（用户券）、`PointsGood`（随单赠品，M1
未使用）；`User.pointsBalance`；`Order` 的 `couponId/discountAmount/pointsUsed/pointsEarned/
pointsSettledAt`（M1 只用 `pointsEarned`/`pointsSettledAt`，其余留给 M2）；`OrderItem.isGift/
pointsCost`（M1 未使用）。字段定义与枚举取值见 spec §4。

### 服务端实现

| 文件 | 职责 |
|---|---|
| `services/member/settings.ts` | `Setting(key='member')` 读写 + 60s 缓存；读失败时保守回退（`points.enabled=false`），与运费设置读失败回退「全 0」的语义方向相反——防止配置不可信时误发分 |
| `services/member/points.ts` | 发放（`settlePoints`）/ FIFO 扣减（`consumePoints`）/ 过期（`expirePointsBatch`）/ 退款扣回（`deductPointsOnRefund`）/ 只读查询 |
| `services/member/coupons.ts` | 发券（`issueCoupon` 公共原语 + `redeemByPoints`/`claimCampaign`/`issueNewcomerCoupon`）/ 过期（`expireCouponsBatch`）/ 只读查询 |
| `services/member/cron-state.ts` | `expirePoints`/`expireCoupons` 两个「每日一次」任务的日切判定（`Setting(key='member_cron_state')`） |

### 发放/扣回钩子

| 事件 | 位置 |
|---|---|
| 顾客确认收货 | `PUT /api/orders/:id/confirm` |
| 同城骑手送达（520 回调） | `services/delivery/callback.ts`，事务提交后触发（塞进已有的 `after[]` 数组） |
| 同城店员标记已送达 | `services/delivery/orchestrator.ts` 的 `markDelivered` |
| 兜底（漏挂钩子，含发货超时自动确认收货） | `scheduler.settleMissedPoints`，每分钟扫 `COMPLETED && pointsSettledAt IS NULL && isTest=false && completedAt ∈ [now-7d, now-2min]` |
| 退款扣回 | `services/refund.ts` 的 `finalizeRefundSuccess` 事务末尾（同一事务内，扣回失败整笔回滚并抛错） |
| 新客券 | `routes/auth.ts` 的 `wechat-login`，新建 `User` 分支之后 |

以上全部 fire-and-forget（退款扣回除外——那个必须在同一事务内，见上表），失败不影响主流程，
由 `settleMissedPoints` 兜底任务补。

> `scheduler.autoCompleteShippedOrders`（发货超时自动确认收货）**不是**发分钩子：它只把订单
> 状态从 `SHIPPED` 推到 `COMPLETED`，不调用 `settlePoints`。这批订单的积分完全靠上面「兜底」
> 那一行的 `settleMissedPoints` 扫描结算，不存在专门的确认收货钩子。
>
> `finalizeRefundSuccess` 里的扣回失败**不是**「靠微信回调重试补」——那只对走真实微信异步
> 退款回调（`wechat-refund-notify`）的路径成立（`finalizeRefundSuccess` 抛错时该 handler
> `replyFail`，微信按其重试策略重新投递通知）。自动补查（`services/refund-reconcile.ts`）
> 路径下 `finalizeRefundSuccess` 抛错则记 `QUERY_FAILED`，下一轮 tick 再试，同样不会漏。
> （原 `refund-complete` 人工兜底路径 2026-09-22 已删除。）

### scheduler 新增三任务

| 任务 | 内容 |
|---|---|
| `settleMissedPoints` | 见上表；开关 `member.points.enabled=false` 时直接返回 0 |
| `expirePoints` | 每日一次：`type IN ('EARN','GIFT_REVERT') && remaining>0 && expiresAt<now`，批 200，`remaining→0` + 写 `EXPIRE` 流水 + 余额同步 |
| `expireCoupons` | 每日一次：`UserCoupon(status='UNUSED', expiresAt<now)` 批量置 `EXPIRED` |

`run-scheduler` 的 overrides 新增 `settleMissedPointsAfterMin`（下界降到 0，e2e 用）、
`forceDailyMemberTasks`（绕过日切判定，e2e 用）与 `dailyTaskBatchLimit`（H9：`expirePoints`/
`expireCoupons` 每批处理的行数，默认 200；两个任务现在会循环调用直到某轮返回值 < 该批量才
收工——不再是「跑一批 200 就记账」，一次到期行数超过 200 的账户不会被拖到次日，e2e 传小值
复现「一大批」场景不用真插 200+ 行）。

### 接口

用户态（挂 `verifyUserToken`，一律 `where:{userId:req.userId!}`，见 `routes/member.ts`）：

| 接口 | 说明 |
|---|---|
| `GET /api/member/summary` | `{ pointsBalance, expiringSoon:{points,date}\|null, availableCoupons }` |
| `GET /api/member/points/ledger?page=&pageSize=` | 流水，白名单只返回 `typeLabel/delta/refType/refId/remark/expiresAt/orderNo/createdAt`（`expiresAt`/`orderNo` 是 M4 加的；**不返回**内部自增 `id` 与原始 `type` 码） |
| `GET /api/member/coupons?status=available\|used\|expired` | 券列表，白名单只返回 `id/code/name/amount/threshold/channel/status/source/expiresAt/usedAt/orderId`（`orderId` 是 M4 加的，「已用于订单 …」要能点进详情，是顾客**自己的**订单 id；**不返回** `issuedBy/remark/sourceRef/templateId`） |
| `POST /api/member/points/redeem` | `{ templateId }`，积分兑换券 |
| `POST /api/member/coupons/claim` | `{ templateId }`，领券中心领取 |

管理态：`GET/PUT /api/admin/settings/member`（积分总开关/每元得分/有效期天数/新客券模板/规则文案）。
券模板管理、赠品管理、用户页积分/券列、赔偿券发放（`source=ADMIN`）留给 M3，本里程碑只提供了
`issueCoupon()` 通用原语，未开放对应的管理端点。

### 新错误码（`4225x`，5 个）

| code | 含义 |
|---|---|
| 42250 | 积分不足 |
| 42251 | 优惠券不可用（M1 暂无触发路径，留给 M2 结算链路） |
| 42252 | 赠品超出限购或已兑完（M1 暂无触发路径，留给 M2） |
| 42253 | 该券已领完或已达每人上限 |
| 42254 | 券模板已停用 |

---

### E.2 M2：结算链路

M1 只有账本与只读端点；M2 把券与赠品接进了 `POST /orders`。**42251/42252 从「留给 M2」变成真有触发路径。**

### 顾客端新增

| 端点 | 说明 |
|---|---|
| `GET /member/checkout-options?channel=LOCAL\|EXPRESS&subtotal=<分>` | 结算页选项：积分余额、券列表（每张带 `usable` 与 `discount`，或 `reason` + `message`）、可换赠品 |
| `GET /member/mall` | 积分商城：可换券模板 + 全部赠品。**不按渠道过滤**，带 `channel` 供前端分组 |
| `GET /member/campaign` | 领券中心：CAMPAIGN 模板 + `remaining`（`totalLimit` 为空则 null）+ `claimedByMe` |

`checkout-options` 的 `usable`/`discount` **由服务端算好**，小程序只显示、不本地重算（spec §6）。
不可用的券**也返回**，带 `reason`（`NOT_OWNER`/`USED`/`EXPIRED`/`CHANNEL`/`THRESHOLD`）与中文 `message`——
结算页要把它们灰掉并说明原因，藏起来顾客会以为券丢了。

`subtotal` 由前端传，**只用于展示**：下单时 `POST /orders` 会用自己算出来的小计重新判一遍，
传假值最多让顾客看到一个乐观的预览。

### `POST /orders` 新增

请求体（都可选，不传时行为与 M2 之前逐字节一致）：

    couponId?: number
    gifts?: [{ pointsGoodId: number, quantity: 1..9 }]   // 最多 5 种，同一种不得重复提交

响应新增 `discountAmount` / `pointsUsed` / `couponName`。

**计价顺序（spec §5.1，逐字执行）**：

    小计   = Σ 非赠品行
    折扣   = 券 ? min(券面额, 小计) : 0      ← 门槛比对**小计**
    运费   = 按**券前小计**判包邮/起送/同城起送
    实付   = 小计 − 折扣 + 运费

顾客**不会因为用券失去包邮或跌破起送线**。`actualAmount === 0` 直接拒（42251「该券金额已超过
本单可抵扣范围」）——0 元订单走不了微信支付，会掉进没有支付回调的死角。

赠品行 `isGift=1, productPrice=0, subtotal=0, pointsCost=单件积分价`，**照常扣真实库存、加真实销量**，
并**计入同城的件数与重量上限**（42230 的意义是「一个骑手拎不动」，与谁付钱无关）。

### 订单响应新增字段

顾客端与管理端的列表与详情都加了 `discountAmount` / `pointsUsed` / `pointsEarned`，
`items[]` 每行加 `isGift` / `pointsCost`；**详情**另给 `coupon` 对象（列表不给，避免 N+1）：

- 顾客端 `coupon: { name, code, amount } | null`
- 管理端 `coupon: { name, code, amount, threshold, source, issuedBy, remark } | null`

管理端列表另加 `userId`（M3 的「发赔偿券」按用户维度发放）。

⚠️ **`pointsSettledAt` 与 `pointsBase` 不再下发给顾客**。两个都是内部记账（前者是兜底任务的
「已处理」标记，后者是退款按比例扣回的分母），从 M1 起一直在往外发，M2 由 `withPayExpire` 收掉。

### 未支付取消释放（`releaseOrderBenefits`）

**只服务 `PENDING_PAYMENT → CANCELLED`，四条路径全部接了**：

| 入口 | 位置 |
|---|---|
| 顾客手点 `PUT /orders/:id/cancel` | `routes/orders.ts` |
| 商家拒单 `POST /admin/orders/:id/reject` 的**待付款分支** | `routes/admin/orders.ts` |
| 后台改状态 `PUT /admin/orders/:id/status` | `routes/admin/orders.ts` |
| 超时任务 `cancelExpiredOrders` | `services/scheduler.ts` |

四处形状一致：状态翻转 `updateMany` 判 count 成功 → `rollbackOrderStock` → 释放。
**按状态守卫而不是按端点名单**——名单会漏（计划原文就漏了「拒单」那条，照它写会让待付款单被
商家拒掉时顾客的券和积分永久蒸发）。

释放内容：券回 `UNUSED`（**若已过期则置 `EXPIRED`**，过期券不还给顾客用也不留在 USED 误导）；
赠品积分写 `GIFT_REVERT` 入账行并**继承下单时那条 GIFT 行的到期日**（退回来的积分不该比原来更耐用）；
`PointsGood.issuedCount` 递减。库存回滚由调用方已有的 `rollbackOrderStock` 负责（`order.items`
天然含赠品行）。

### 已支付后一律不释放（P7）

退款路径**一处都不调** `releaseOrderBenefits`。刻意的不对称：

    库存 回滚 · 销量 回滚 · 优惠券 不退 · 赠品积分 不退 · 赠品名额 不回落

库存防的是超卖（货是实物，退了就该能再卖），名额防的是薅（下单即退就能占掉限量）。

### 管理端新增

`GET/POST/PUT /admin/coupon-templates`（**无 DELETE**，spec 只有停用；`source` 建后不可改）、
`GET /admin/coupon-templates/:id/issued?page=`、`GET/POST/PUT/DELETE /admin/points-goods`。

金额上限沿用「挡住把元当分填」：券面额 ≤ 100000 分（¥1000）、门槛 ≤ 10000000 分。

---

### E.3 M3：管理端用户维度

后台的会员相关页面（优惠券 / 积分赠品 / 会员设置 / 用户管理）落在 M3。除了 E-2 已列的
券模板与赠品 CRUD，这一轮新增四个**用户维度**的端点，全部挂在 `/admin/users` 下。

### 端点

| 端点 | 说明 |
|---|---|
| `GET /admin/users` | 每行新增 `pointsBalance` 与 `availableCoupons` |
| `GET /admin/users/:id/points-ledger?page=&pageSize=` | 积分流水，分页倒序，`pageSize` 上限 50 |
| `GET /admin/users/:id/coupons?status=` | 该用户全部券（含已用/已过期） |
| `POST /admin/users/:id/coupons` | 定向发券（赔偿券）。`{ templateId, remark, orderNo? }` |

用户不存在一律 `40401`，`:id` 非正整数 `40001`。

### `availableCoupons` 按**时间**判，不是只看 `status`

计数条件是 `status='UNUSED' AND expiresAt > now()`。过期是定时任务批量翻的，
任务扫到之前那些券还挂着 `UNUSED`——只看 `status` 会把它们算进可用数。
一次 `groupBy` 数完本页所有用户，不在 map 里逐用户 `count()`。

### 积分流水的 `typeLabel` 与 `orderNo` 由服务端补

- `typeLabel`：`EARN` 消费得分 / `REDEEM` 积分兑换 / `GIFT` 随单赠品 / `GIFT_REVERT` 取消退回 /
  `REFUND_DEDUCT` 退款扣回 / `EXPIRE` 积分过期 / `ADMIN` 手动调整（预留，本轮无入口）。
  **唯一来源是 `services/member/points.ts` 的 `LEDGER_TYPE_LABEL`**，顾客端与管理端共用同一份；
  改文案改那一处，别在文档里另写一套（M3 曾各写一份，两份当场就漂移了）。
  未知 type 原样回落成字面量。**在服务端拼**是因为这套 type 已经有三个消费方，各写一份 map 必然漂移。
- `orderNo`：`refType='ORDER'` 时 `refId` 存的是 **`Order.id`**（不是单号），服务端联查补出真实单号。
- 排序按 `id` 倒序而非 `createdAt`：同一事务里写的多条流水（如 `GIFT` + `EARN`）时间戳相同，
  按它排序不稳定，翻页会漏行/重行。

### 定向发券只认 `source='ADMIN'` 的模板

| 情形 | 返回 |
|---|---|
| 模板不存在 | `40401` |
| `source ≠ ADMIN` | `40001` 只能发放「手动发放」类型的券模板 |
| 模板已停用 | `42254`（与 `redeemByPoints` 同码） |
| `remark` 空白 | `40001` 请填写发放原因 |
| `orderNo` 不属于该用户 | `40001` 订单不属于该用户 |

`POINTS` / `CAMPAIGN` 模板带 `totalLimit` 的库存语义，从这条路发会绕开
`issuedCount` 那道并发防线（本端点不递增它），限量券就变成无限量；`NEWCOMER` 靠
「每人一张」的查重发放，手动补发会打破那条不变式。

`remark` **必填**：这个端点凭空造出真金白银，「为什么发」不写清楚，一个月后没人说得清。
`issuedBy` 记登录名，`orderNo` 落到 `sourceRef`。管理端**可以**读 `issuedBy`/`remark`，
顾客端 `GET /member/coupons` 的输出白名单里没有这两个字段（备注里可能写着对顾客不友好的话），
e2e 第 48 段用 `has("issuedBy") == false` 锁住。

限流：`adminIssueLimiter` 30 次/分钟，**按管理员名计数而非 IP**——店里几个人共用出口 IP，
按 IP 会互相挤占；要防的恰恰是某一个账号短时间刷券。

### 两个为后台页面补的字段

- `GET /admin/coupon-templates` 新增 **`issuedTotal`**（真实发出的张数）与已有的 `usedCount`。
  模板上的 `issuedCount` 是限量券的并发防线，只有 `POINTS`/`CAMPAIGN` 两条自助路径递增，
  `ADMIN`/`NEWCOMER` 模板上它永远是 0——后台「已发」列必须用 `issuedTotal`。
  对前两者两个数恒等（递增与发券同事务），所以「已发 / 总量」拿它当分子同样正确。
- `GET /admin/points-goods` 新增 **`unitPrice`**（商品或所选规格的当前售价，商品已删为 null）。
  后台要在积分价输入框旁实时显示「≈ 消费 ¥X 可得 · 回报率 N%」——积分价是店主可调的，
  没有这条提示只能凭感觉填。另注意 `productStatus` 是 `Product.status` 的**原值**
  `ON_SHELF`/`OFF_SHELF`（外加 `DELETED`/`MISSING`），不是券模板/赠品自身开关的 `ON`/`OFF`。

---

### 已知待办（交接给后续里程碑）

- 会员中心/积分商城/我的券/领券中心/积分明细五个小程序页面、封面入口接线 — M4。
- `docs/staff-guide.md`「优惠券与积分」章节、`docs/miniapp-release-checklist.md` 的规则公示检查项 — M5。

---

## 附录 F：全国邮寄报价（批次一，2026-09）

设计依据 `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md`。
本批只做报价与下单；预约取件、轨迹、顾客端时间线是批次二/三，见 spec 末尾「批次二/批次三」。

### 小程序端

| 接口 | 说明 |
|---|---|
| `POST /api/express/quote` | 需登录。Body `{ addressId, cartItemIds? \| directItem?, gifts? }`（与 `POST /orders` 同形，清单与凭证按同一份签）。返回 `{ feeFen, quotedFeeFen, feeSource('QUOTE'\|'TABLE'), weightKg, groupName, freeShipMinFen, freeShip, belowMin, minOrderAmountFen, subtotalFen, quoteCount, quoteToken, quoteExpiresAt }`。**不下发各家成本价**（`quoteCount` 只报回价家数，不报是哪几家、多少钱）。`quoteToken` TTL 15 分钟，签入 `addressId`、收货地址内容摘要（`addressHash`）、清单指纹（`itemsHash`）、重量、报价、各家成本价快照。 |
| `POST /api/orders`（EXPRESS 渠道） | `quoteToken` **可选**（老客户端兼容）。带了：验签、`addressId`/`addressHash`/`itemsHash` 三项任一不符 → `42261`，小程序自动重报价；QUOTE 口径锁凭证价与重量，TABLE 口径现算。不带：服务端自己走一遍查价（带缓存）与计算，不报 42261。包邮、起送、不寄送一律按**下单时**的设置与真实小计判（凭证里的 `freeShip` 不信）。收货地址原地改过（`PUT /api/addresses/:id`）会让 `addressHash` 不再匹配，旧凭证随即失效。订单落 `express_quote_snapshot`（JSON）、`express_region_group`（VARCHAR 32）、`express_weight_g`（INT，克，不是公斤）。 |
| `GET /api/orders/meta` | `shipping` 改为邮寄设置「其他」组的兼容视图 `{ fee, freeThreshold, minOrderAmount }`，仅供老版本小程序显示；新版本走 `/api/express/quote`。 |

### 管理端

| 接口 | 说明 |
|---|---|
| `GET/PUT /api/admin/settings/express` | 邮寄设置全量读写，结构见 `services/express-settings.ts` 的 `ExpressSettings`（地区分组、包邮门槛、兜底表、参与定价的快递池、重量参数等）。PUT 先 sanitize 非法输入回落默认值，再 validate；校验失败 `40001`，`message` 是多条错误用「；」连接的字符串。 |
| `GET/PUT /api/admin/settings/shipping` | **兼容垫片**（`services/settings.ts` 现为迁移用的只读 legacy，`setShippingSettings` 已删除）：GET 返回「其他」组的兼容视图；PUT 把传入的一口价写成「全部分组同一张兜底表 + 同一包邮线」并把 `fee.mode` 切到 `TABLE`。写侧仅非生产环境挂载（e2e 用），生产只保留 GET 兼容视图；新代码一律走 `settings/express`。 |
| `/api/admin/system/express-mock/{reset,queue,calls}` | 仅 `EXPRESS_PROVIDER_MOCK=true` 时挂载。`POST reset` 清空指令队列、调用记录与服务端报价缓存；`POST queue` Body `{ directive: {kind:'ok', quotes?} \| {kind:'timeout'} \| {kind:'error', code, message?} }`，服务端校验 `kind` 取值与各分支必填字段；`GET calls` 读调用记录，供 e2e/联调断言。 |

### 错误码

| 码 | 含义 |
|---|---|
| 42210 | 邮寄订单未达起送金额（复用同城「未达起送门槛」码值，`ExpressSettings.minOrderAmountFen`；下单时校验，`routes/orders.ts` EXPRESS 分支） |
| 42260 | 该地区暂不支持邮寄（省级不寄送名单，`ExpressSettings.regionGroups[].blocked`） |
| 42261 | 运费已更新，请重新确认（`quoteToken` 验签/TTL/地址/清单指纹任一不符；仅在带了 `quoteToken` 时才会报） |
| 42262 | 收货地址过长（收货地址 `fullAddress` 超过 300 字节，快递100 `recManPrintAddr` 限长） |

### 环境变量

`KD100_EXPRESS_API_URL`（默认 `https://poll.kuaidi100.com/order/borderapi.do`）、
`KD100_EXPRESS_KEY` / `KD100_EXPRESS_SECRET`（缺省复用 `KD100_KEY` / `KD100_SECRET`，与同城共用一套快递100账号）、
`EXPRESS_PROVIDER_MOCK`（`true` 时查价走内存 mock 且挂载上面的管理端 mock 控制面；生产环境禁止开启）。

---

## 附录 G：全国邮寄预约取件（批次二，2026-09）

设计依据 `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md` §5–§8。
本批做：工作台「预约快递员上门取件」（选快递/改重量/选时段）、快递100 上门取件回调把订单推到「已发货」、
改约/取消/作废、顾客取消申请前置、顾客端订单详情预约状态、三条兜底定时任务。轨迹订阅与顾客端时间线是批次三。

### 管理端：`/api/admin/express/orders/:id/*`

挂载于 `apps/server/src/routes/admin/express.ts`（`routes/admin/index.ts` 里 `router.use('/express/orders', expressAdminRouter)`），
均需管理员登录。`:id` 是订单 id（不是 `bookingNo`）。

| 接口 | 说明 |
|---|---|
| `GET /:id/booking` | 该订单最近一条预约（含是否为「活跃」预约、事件列表）。返回 `{ booking: BookingView \| null, active: boolean, events: [] }`。`BookingView` 含 `status/statusLabel/kuaidicom/courierLabel/serviceType/kuaidinum/dayType/pickupDate/pickupStart/pickupEnd/slotText/weightKg/customerFeeFen/quotedFeeFen/prepaidFeeFen/settledFeeFen/billedWeightG/courierName/courierMobile/failReason/cancelledBy` 及各阶段时间戳，另加 `trackStatus/trackUpdatedAt/trackCount/latestTrack`（批次三，见下方「`bookingView` 与管理端加字段」）。`active` 为 `true` 当且仅当这条预约就是订单当前的 `activeOrderId` 指向对象（`BOOKED/ACCEPTED/UNKNOWN`，`PENDING` 占位也算——见状态机）。事件字段：`id/source/providerStatus/statusDesc/courierName/operator/createdAt`，`source` 现有 `CALLBACK/ADMIN/SYSTEM/TRACK` 四种（`TRACK` 为批次三新增，轨迹推送落的留痕事件）。 |
| `GET /:id/quotes?weightKg=` | 预约弹窗打开时拉一次。`weightKg` 可选（0.1–50，不传用订单商品算出的默认重量）。返回各家报价（快照 90 分钟内、重量未变、且有价家数 ≥ `fee.minQuoteCount` 才复用下单时的快照，否则现查全部 9 家）+ `suggestedSlot`（预填时段）+ `couriers`（`{code,label}[]`，供下拉渲染）。 |
| `POST /:id/book` | 建预约。Body `{ kuaidicom, serviceType?, weightKg?, dayType, pickupStart?, pickupEnd?, remark? }`。成功返回 `{ bookingId, bookingNo, status: 'BOOKED'\|'UNKNOWN', kuaidinum }`（`UNKNOWN` 时 `kuaidinum` 可能非空——外呼可能已经成功只是响应超时）。校验顺序：订单须 `PREPARING`；无待处理取消申请（`42266`）；快递公司需在 `EXPRESS_COURIERS` 内；地区不在不寄送名单；收货地址 ≤ 300 字节（`42262`）；时段合规（`42269`）；无活跃预约（`42265`）；下单超时进 `UNKNOWN`；业务失败 `42270`（原话）。 |
| `POST /:id/booking/cancel` | 取消当前活跃预约。Body `{ reason? }`（≤30 字，缺省按操作者是店员/顾客给默认文案）。`UNKNOWN` 状态不可取消（`42267`，需先等对账或作废）；快递100 拒绝取消（已揽收）→ `42267` 原话；请求超时 → `42268`（状态未变）。成功后预约转 `CANCELLED`，订单不受影响（本就在 `PREPARING`），可重新预约。 |
| `POST /:id/booking/modify` | 改约。Body `{ dayType, pickupStart?, pickupEnd? }`（不能换快递公司——`modifyBookingSlot` 不收 `kuaidicom`）。仅 `BOOKED/ACCEPTED` 可改；时段不合规 `42269`；快递100 拒绝或超时同「取消」的 `42267/42268`。成功后清空「未取件提醒」标记（避免刚改完又立刻被旧时段触发提醒）。 |
| `POST /:id/booking/void` | 作废「待核对」（`UNKNOWN`）的预约，或作废下单占位卡住超过 2 分钟的 `PENDING`。其余状态一律 `42267`。作废后 `activeOrderId` 释放，可重新预约或改填单号发货。**人工操作，系统从不自动作废**（见状态机）。 |
| `POST /:id/cancel-request/reject` | 驳回顾客的取消申请（同城/邮寄共用 `rejectCancelRequest`，无 Body）。 |
| `POST /:id/cancel-request/approve` | 同意顾客的取消申请：**先取消预约（若有活跃预约）→ 成功后再全额退款**；第一步失败直接抛错，不进入第二步。无活跃预约时跳过第一步直接退款。 |

### 顾客端回调：`POST /api/kd-express/:bookingNo`

公开路由（`apps/server/src/routes/kd-express-callback.ts`，挂载于 `app.ts` 的 `express.json()` 之前），`x-www-form-urlencoded` 表单体，字段 `param`（JSON 字符串）+ `sign`。

- **验签**：`sign = MD5(param + callbackSalt)`（大小写不敏感），`callbackSalt` 是**每条预约随机生成**的 32 字节十六进制串，存在 `express_bookings.callback_salt`（不是全局密钥）。验签失败**仍 ack 200**（不处理状态，只记一条留痕事件并告警店员核对）——这样对方不会因为收到失败形状而无限重推，同时也不给伪造请求提供「猜中签名就能推进状态」的攻击面（签名本身仍必须对得上 `callbackSalt` 才会被采信）。
- **ack**：一律 `{"result":true,"returnCode":"200","message":"成功"}`（HTTP 200）。只有处理过程中抛出未捕获异常才回 `HTTP 500`（触发对方重推，最多 2 次，间隔约 1 分钟）。
- **限流 503**：`kdExpressCallbackLimiter`（`middlewares/rate-limit.ts`）触发时直接 `HTTP 503`，body `{"result":false,"returnCode":"503","message":"请求过于频繁，请稍后重推"}`——**不是**成功形状，让对方按「失败」重推，避免限流把回调静默吞掉。
- **幂等**：`(bookingNo, providerStatus, rawBody 摘要)` 组成去重键（`makeExpressDedupeKey`），重复推送直接 ack 不重复处理状态；同一条内容变了（如 `statusDesc` 更新）视为新事件仍会处理。
- **处理顺序**：查预约（查不到只告警，仍 ack 200）→ 验签 → 事务内去重留痕 → `UNKNOWN` 认领（任何一条验签通过的回调都证明单在快递100 那头真实存在，直接转 `BOOKED`）→ 按状态映射推进（终态后的尾随回调只留痕，`FEE` 类例外——结算可能晚于签收）→ 订单联动（仅 `PICKED`/`DELIVERED` 两处，见下）→ 事务外发通知。

### 轨迹推送：`POST /api/kd-express/:bookingNo/track`（批次三）

`apps/server/src/routes/kd-express-callback.ts` 同一个 router 上另一条路由，处理函数是 `handleExpressTrackCallback`（`services/delivery/express-track.ts`）。

- **来源**：下单时传 `op=1` + `pollCallBackUrl`（`${callbackUrl}/track`，`express-booking.ts`），这是免费订阅——不是另计费的主动查轨迹接口。表单同样是 `param`（JSON 字符串）+ `sign=MD5(param+callbackSalt)`，**盐与状态回调是同一条预约的同一个 `callback_salt`**，不是另一把。查不到预约、验签失败、限流触发三条行为与状态回调完全一致（ack 固定形状、`HTTP 500` 仅未捕获异常、`HTTP 503` 限流）——见上一小节。
- **`param` 形状**（`_parseTrackParam`，`express-callback-sign.ts`）：`{ status: 'polling'|'shutdown'|'abort'|'updateall', message, lastResult: { nu, com, ischeck, state, data: [{ context, ftime, time, status, areaName }] } }`。解析规则：`data` 里缺 `context` 或 `ftime`（`time` 兜底）的条目直接剔除；`context` 截 255 字符、`ftime` 截 32 字符；不管来源顺序，一律按 `ftime` 字符串降序重排一遍；整体封顶 `TRACK_MAX_ITEMS = 50` 条。
- **落库**（`express-track-json.ts` 的 `toStoredTrack`）：`trackJson = { status, ischeck, state, nu, items: [{context, ftime}] }` **整体覆盖**（不是逐条 append）；同时更新 `trackStatus`（`status` 截 16 字符）、`trackUpdatedAt`。事件表 `source='TRACK'`，去重键 `TR:<bookingNo>:<status>:<md5(rawBody)>`（`makeExpressTrackDedupeKey`）——同一条内容的重推直接 ack 不重复处理，`status`/正文任一变化都算新事件。`abort` 且这次推送不带任何轨迹条目时**不覆盖**已落库的 `trackJson`（大概率是「单号有误/已超期」这类空推送，不能拿它去顶掉顾客已经看到的历史轨迹），但仍刷新 `trackStatus`/`trackUpdatedAt` 留痕。
- **状态联动**：`ischeck==='1'` 或 `state==='3'` 视为签收。若该预约还没到 `PICKED`（10 没推到），**先按状态回调的「10」走一遍**（`Order.SHIPPED` + `Shipment` + 发货订阅消息），再按「13」收尾（`DELIVERED`；`Order.SHIPPED → COMPLETED`）——两步共用 `applyProviderStatus`，状态机规则只有一份，实现在 `syntheticPayload` 把轨迹签收伪装成状态回调的形状。`CANCELLED/FAILED/VOID` 的预约收到轨迹推送只留痕、不写 `trackJson`（顾客端读的是「最新一条预约」，不该被旧单的轨迹顶掉）。`DELIVERED` 之后的尾随轨迹推送仍会更新 `trackJson`（展示层数据，没有「终态后拒收」这一说）。`abort` 与 `state ∈ {4,6,14}`（退签/退回/拒签）各告警店员一次（`express-track-abort:<id>`、`express-track-return:<id>`）。

### `bookingView` 与管理端 `GET /:id/booking` 加字段

`BookingView`（`services/delivery/express-booking.ts`）新增四个字段，`GET /api/admin/express/orders/:id/booking` 原样透出：

| 字段 | 说明 |
|---|---|
| `trackStatus` | 最近一次轨迹推送的 `status`（`polling`/`shutdown`/`abort`/`updateall`），未收到过为 `null` |
| `trackUpdatedAt` | 最近一次轨迹推送落库时间（ISO），未收到过为 `null` |
| `trackCount` | `trackJson.items` 条数（0–50） |
| `latestTrack` | `trackJson.items[0]`（`{context, ftime}`），最新一条在最上面；没有轨迹为 `null` |

工作台抽屉「取件预约」块用 `latestTrack.context` + `trackCount` 拼「最新轨迹」一行，`trackStatus === 'abort'` 时后面加「· 订阅已中止」。

### 状态映射（`KD_EXPRESS_STATUS_MAP`，`express-booking-state.ts`）

回调 `data.status` → 本地动作：

| 快递100 状态码 | 含义 | 本地动作 |
|---|---|---|
| `0` | 下单成功 | `ExpressBooking.status = BOOKED`；同时记一次预扣（`prepaidFeeFen`，只写第一次） |
| `1` | 已接单 | `ACCEPTED`，记 `acceptedAt` |
| `2` | 收件中 | `ACCEPTED`，记 `acceptedAt`（与 `1` 同一动作） |
| `10` | 已取件 | `PICKED`，记 `pickedAt`；**同一事务** `Order.status: PAID/PREPARING → SHIPPED`，`Shipment` 写公司/单号/`shippedAt`；事务外发一次发货订阅消息 |
| `13` | 已签收 | `DELIVERED`，记 `deliveredAt`；`Order.status: SHIPPED → COMPLETED`（仅当订单当前正是 `SHIPPED`） |
| `11` | 揽货失败 | `FAILED`，释放 `activeOrderId`，推送店员一次 |
| `610` | 下单失败（异步） | `FAILED`，同上 |
| `9` | 用户取消 | `CANCELLED`（`cancelledBy=KD100`），释放 `activeOrderId`，推送店员一次（提示重新预约或改填单号） |
| `99` | 订单取消 | `CANCELLED`，同 `9` |
| `15` | 已结算 | 落 `settledFeeFen`/`billedWeightG`/`feeDetails`；随后调一次 `synPay(kdOrderId)`；若实扣/预扣 `> costAlertRatio` 告警一次（`costAlertedAt` 标记去重） |
| `155` | 修改重量 | 同 `15`（更新实扣/计费重，不重复调 `synPay`） |
| `101` | 运输中 | 仅落 identity 字段（单号/快递员等），不推进状态 |
| `400` | 派送中 | 同 `101` |
| `200` | 已出单 | 同 `101` |
| `201` | 出单失败 | 同 `101`（忽略，不算 `FAILED`——出单是快递公司内部动作，不代表揽收失败） |
| `12` | 已退回 | 落 identity，告警店员核实 |
| `14` | 异常签收 | 同 `12` |
| `166` | 订单复活 | 同 `12` |
| 未在表中的状态码 | — | 落 identity，告警一次「未知状态」，不推进 |

订单侧联动**只在两处**：`PICKED` → `Order.SHIPPED` + `Shipment` + 发货订阅消息；`DELIVERED` → `Order.COMPLETED`（仅当此前是 `SHIPPED`）。其余状态一律不碰订单状态。

### 预约记录状态机

```
PENDING(占位，外呼进行中) ──(外呼成功)──► BOOKED ──(1/2)──► ACCEPTED ──(10)──► PICKED ──(13)──► DELIVERED
    │                                        │
    ├──(9/99、店员取消)────────────────────► CANCELLED
    ├──(11、610)──────────────────────────► FAILED
    └──(外呼超时/落库失败等不确定情形)──► UNKNOWN ──(任意一条验签通过的回调)──► BOOKED
          │
          └──(店员在快递100 后台核实无单后手动作废；或 PENDING 卡住超 2 分钟)──► VOID
```

- `PENDING` 是 `createBooking` 先落库占位、还没等到外呼结果时的中间态；正常几秒内会推进到 `BOOKED/UNKNOWN/FAILED` 之一。只有进程在这几秒窗口崩溃重启才会留下一条永远卡住的 `PENDING`——超过 2 分钟可视为卡死，允许人工 `void`；2 分钟内一律当作「正常下单中」处理（`voidUnknownBooking` 会拒绝）。
- **活跃** = `BOOKED / ACCEPTED / UNKNOWN`（`activeOrderId` 唯一索引，一单同时最多一条活跃预约；`PENDING` 虽然也占着 `activeOrderId`，但不算「活跃」三态之一，只在按钮矩阵里当占位处理）。
- 终态 `DELIVERED/CANCELLED/FAILED/VOID` 不可再被任何回调或人工操作改动；回调的 rank 只能前进，`PICKED` 之后不能再被取消/失败（取件后只走售后）。
- `VOID` 只能由店员通过 `POST .../booking/void` 手动触发，**系统不会自动把 `UNKNOWN` 转成 `VOID`**——`detail` 按 `thirdOrderId` 查询在测试环境未验证过，若自动作废判错就是同一单在快递100 那头真实存在、店内却又重新建了一单的「双单」事故。

### 错误码（4226x 段，接续批次一的 42260–42262）

| 码 | 含义 |
|---|---|
| 42263 | 该订单有取件预约（待取件），请先取消预约再退款 —— `initiateRefund`/拒单路径的前置校验，与同城 `42221` 同款理由 |
| 42264 | 该订单有取件预约，请先取消预约再手填单号发货 —— `/api/admin/orders/:id/ship` 的前置校验 |
| 42265 | 该订单已有取件预约，请先取消再重约 —— 建预约时已存在活跃预约（含并发建单撞唯一索引的兜底） |
| 42266 | 顾客有待处理的取消申请，请先处理再预约 —— 建预约前置校验，避免与取消申请的处理顺序打架 |
| 42267 | 预约状态不允许该操作 —— 取消/改约/作废时目标预约不存在、状态已变化、或 `UNKNOWN`（待核对，需先等对账或作废）；也覆盖快递100 明确拒绝（如已揽收不可取消）的原话透传 |
| 42268 | 快递100 请求超时，状态未变化 —— 取消/改约请求超时，本地状态未回滚，可重试 |
| 42269 | 取件时段不合规 —— 少于 1 小时、今天的时段未留够 2 小时提前量、顺丰未填时段等（原话由 `validateSlot` 给出） |
| 42270 | 快递100 下单失败：`<原话>` —— 建预约时业务失败（风控/停派/地址过短/重量超限/余额不足等），不建记录 |
| 42225 | 回调地址超长（复用同城「呼叫骑手失败」码值，客户端契约不动）—— 建预约时 `callbackUrl`/`pollCallbackUrl` 超过 200 字节，`createBooking` |

### 顾客端变化：`GET /api/orders/:id`

- 新增 `expressBooking: { status, statusLabel, courierLabel, courierName, slotText, kuaidinum } | null`（`FAILED/VOID` 对顾客等同「没预约」，不下发；`CANCELLED` 仍下发，顾客端按「商家备货中」展示）。顾客白名单：不下发快递员手机号、不下发任何费用字段。
- **（批次三）** 新增 `track: { updatedAt, signed, items: [{context, ftime}] } | null`（`routes/orders.ts`）。`updatedAt` 是 `trackUpdatedAt`；`signed` 即 `ischeck`；`items` 最多 30 条、最新在上（服务端已按 `ftime` 排好序，前端不再排）。以下情况一律 `null`：预约已 `CANCELLED`；预约是 `FAILED/VOID`（`expressBooking` 字段自己也是 `null`，等同「没预约」）；预约没有 `trackJson` 或 `trackJson.items` 为空（老邮寄单手填单号、同城单没有 `expressBooking` 行，自然是 `null`）。
- 新增 `cancelGraceMin`（本单渠道对应的取消申请宽限分钟数，`LOCAL` 读 `localSettings.acceptGraceMin`、`EXPRESS` 读 `expressSettings.acceptGraceMin`）；`canRequestCancel`/`cancelRequestDeadline` 两个既有字段现在 `EXPRESS` 渠道同样会算（`cancelWindowOf` 按 `deliveryType` 分流）。
- `POST /:id/cancel-request`：接单后宽限期内可申请，`EXPRESS` 与 `LOCAL` 走同一条路由；申请时快照当前活跃预约状态到 `cancelRequestDeliveryStatus`（供店员处理时判断快递员是否已在路上）。

### 定时任务与阈值覆盖

`apps/server/src/services/delivery/express-booking-tasks.ts` 四条，接入 `scheduler.ts` 每分钟一轮（与同城任务同一个 tick，互不阻塞）：

| 任务 | 函数 | 默认阈值（读 `ExpressSettings.pickup`） | 覆盖参数（`POST /api/admin/system/run-scheduler` 的 `overrides`，仅非生产可用） |
|---|---|---|---|
| 无人接单提醒 | `remindExpressUnaccepted` | `unacceptedRemindHours`（默认 4 小时） | `expressUnacceptedHours` |
| 时段过未取件提醒 | `remindExpressUnpicked` | `unpickedRemindMin`（默认 60 分钟） | `expressUnpickedMin` |
| `UNKNOWN` 对账 | `reconcileExpressUnknown` | `minAge` 默认 1 分钟 | `expressUnknownMin` |
| 对账（时段过期/取件超期） | `reconcileExpressStale` | 间隔 30 分钟、`PICKED` 超 10 天、每单封顶 48 次 | `expressStaleIntervalMin` / `expressPickedStaleDays` |

`UNKNOWN` 对账用 `detail` 按 `thirdOrderId`（即 `bookingNo`）查单：查到 → 认领为 `BOOKED` 并补 `taskId/kdOrderId/kuaidinum`；**查不到只记一次查单事件、`reconcileTries` 加一，不自动作废**（理由见上面状态机小节）；连续 10 次查不到提醒店员一次；累计 30 次或预约超过 24 小时后停止自动查询（再提醒一次「已停止自动查单」），之后只能人工核实后 `void`。每单每类提醒只发一次，标记列放在 `express_bookings` 上（`unacceptedRemindedAt`/`unpickedRemindedAt`/`unknownRemindedAt`），改约会清空「未取件提醒」标记，同时清空对账三列 `staleCheckedAt`/`staleRemindedAt`/`staleTries`（批次三）。

`reconcileExpressStale`（`express-booking-tasks.ts`，批次三，spec §7「对账定时任务」）是「该有回调了却没有」两类单的主动查单，不是 `UNKNOWN` 对账的重复：

- **A 类**：`BOOKED/ACCEPTED` 且预约时段已结束超过 `unpickedRemindMin`——快递100 有时不推揽收/揽货失败回调。
- **B 类**：`PICKED` 且取件已超 `pickedDays`（默认 10）天仍未 `DELIVERED`——`autoCompleteShippedOrders` 7 天规则已经把订单转 `COMPLETED`，这里只是把预约本身收尾，不重复处理订单。
- 三列标记语义（都在 `express_bookings` 上）：`staleCheckedAt` 是「上次查过」的时间戳，与 `intervalMin`（默认 30 分钟）比较决定这轮要不要再查，`updateMany({ staleCheckedAt: 旧值 })` 先占坑再查，避免并发双 tick 重复调用 provider；`staleTries` 每查一次加一，达到 `STALE_MAX_TRIES = 48`（30 分钟一次、约 24 小时）后不再自动查，转人工；`staleRemindedAt` 是「无结论提醒过」的一次性标记，查到 `ADVANCED`（预约或订单状态确有推进）不会碰它，查不到/无进展时才打标并只提醒一次。
- 无结论提醒每单一次；若已发过「时段过未取件」提醒，有单无进展不再重复通知，但 `detail` **查不到该单**仍通知一次并留 SYSTEM 事件『对账查单：快递100 查不到该单』（批次五）。
- `detail` 显示 `101/400`（在途/派送中）而预约还没到 PICKED 时，对账先合成一次「10」补齐取件联动再套真实状态；`13`（签收）的补记统一内置在 `applyProviderStatus`，回调 / 轨迹 / 对账三条路径共用一处。`detail` 请求失败（provider 抖动）算 `ERROR`，不占「无结论提醒」的名额——外层调度器的 `try/catch` 记账继续，下一轮正常重试。

### 环境变量与 mock

- `EXPRESS_PROVIDER_MOCK`（沿用批次一）：`true` 时预约的下单/取消/改约/查单/结算通知全部走内存 mock，且挂载 `apps/server/src/routes/admin/express-mock.ts`（`/api/admin/system/express-mock/{reset,queue,calls,salt/:bookingNo}`）。`POST queue` 的 `op` 现可传 `book/cancel/modify/detail/synPay`（原 `batchPrice` 之外新增五个）；`GET salt/:bookingNo` 供 e2e/联调构造合法签名的回调请求；生产环境禁止开启。
- `SCHEDULER_DISABLED=true` 时上面四条定时任务与其余全部 scheduler 任务一起停跑（多实例部署时只留一个实例跑 scheduler）。

## 附录 H：到店自取（批次一，2026-09-11）

设计依据 `docs/superpowers/specs/2026-09-11-local-pickup-design.md`。自取是同城渠道下的第二种履约方式：`deliveryType='PICKUP'`，商品/购物车/券按 `LOCAL` 渠道校验。

### 小程序端

| 接口 | 说明 |
|---|---|
| `GET /api/local/meta` | 新增 `delivery`、`pickup`、`holiday` 三节（老字段保留）。`pickup: { enabled, paused, available, minOrderAmountFen, discount, discountText, slotMinutes, daysAhead }`；`holiday` 休业中才非 null。 |
| `GET /api/local/pickup-slots` | 公开。`{ days: [{ date, label('今天'/'明天'/'MM-DD'), slots: [{ startAt, endAt, label }] }], earliestAt, slotMinutes, blocked: null \| { kind: 'HOLIDAY'\|'PAUSED'\|'DISABLED', text } }`。不可选的格子不返回；今天为空时 `days[0].slots=[]`。 |
| `POST /api/orders` | `deliveryType:'PICKUP'` 时 **不传** `addressId`，必传 `pickupAt`（须精确等于某格 `startAt`）与 `pickupContact: { name?, phone }`。计价：小计 → 自取优惠 → 满减（2026-09-17 加入，见附录 K）→ 券（门槛看原小计，面额封顶到小计−自取优惠−满减）→ 实付；运费 0。响应多 `pickupAt`、`pickupDiscountAmount`、`promoDiscountAmount`、`subscribeTemplates`。 |
| `GET /api/orders` | `deliveryType` 接受 `PICKUP`；新增 `channel=LOCAL`（外送 + 自取）/ `channel=EXPRESS`。 |
| `GET /api/orders/:id` | 自取单多 `pickup: { pickupAt, pickupReadyAt, prepStartAt, slotLabel, store }`；所有单多 `canSelfCancel`、`subscribeTemplates`。自取的 `canRequestCancel`：PAID 且已到开始备餐时刻、或 PREPARING；SHIPPED 后 false。 |
| `GET /api/orders/pickup-contact` | 最近一张自取单的 `{ name, phone }`，无则 `null`。 |
| `GET /api/orders/meta` | 多 `subscribeTemplates: { express, local, pickup }`（各 ≤ 3 个模板 ID）。 |
| `PUT /api/orders/:id/cancel` | 自取：PAID 且 `now < 开始备餐时刻` 才能自助秒退，否则 `42229`。 |
| `POST /api/orders/:id/cancel-request` | 自取：PAID/PREPARING 都可申请。 |
| `PUT /api/orders/:id/confirm` | 自取 `42284`。 |

开始备餐时刻 = `pickupAt − 备餐时长(按 pickupAt 是否在高峰) − pickup.acceptBufferMin`（`services/pickup.ts` 的 `prepStartAt`）。

### 管理端

| 接口 | 说明 |
|---|---|
| `GET/PUT /api/admin/settings/local-delivery` | 新增 `pickup` 节与 `holiday`；`enabled` 语义收窄为外送开关。`pickup.enabled=true` 时额外校验门店电话/地址/营业时段。 |
| `POST /api/admin/orders/:id/accept` | 自取单也走这条（同城外送仍走 `/admin/local/orders/:id/accept`）。 |
| `POST /api/admin/orders/:id/pickup-ready` | PREPARING → SHIPPED（待取餐），写 `pickupReadyAt`，发取餐提醒；有未处理取消申请视同驳回（MANUAL）。 |
| `POST /api/admin/orders/:id/picked-up` | SHIPPED → COMPLETED。 |
| `POST /api/admin/orders/:id/cancel-request/approve` / `reject` | 仅自取。同意 = 全额退并清标记。 |
| `POST /api/admin/orders/:id/ship` / `complete` | 自取 `42284`。 |
| `GET /api/admin/orders` | `deliveryType=PICKUP`；`channel=LOCAL` 一次看外送 + 自取。`pending-count.localPendingCount` 含自取。 |
| `GET /api/admin/workbench/snapshot` | 卡片多 `pickup: { pickupAt, pickupReadyAt, prepStartAt, slotLabel, cancelRequested, cancelRejected, acceptedAt } \| null`；排序同城 < 自取 < 邮寄；顶层多 `pickupEnabled/pickupPaused/holiday`。 |
| `POST /api/admin/system/run-scheduler` | 覆盖键新增 pickupUnpickedMin、pickupAutoCompleteMin（非生产环境，e2e 用）。 |
| `GET /api/admin/stats/overview` | `channel` 接受 `PICKUP`（热销榜按自取过滤）；`channels`/`trend` 含 `PICKUP` 桶（批次一已加）。 |

### 定时任务（`scheduler.ts`）

| 任务 | 函数 | 阈值 | override 键 |
|---|---|---|---|
| 自取未接单催单 | `remindPickupUnaccepted` | max(付款+15 分钟, 开始备餐−15 分钟) | `remindAfterMin` |
| 过时未取提醒 | `remindPickupUnpicked` | `pickup.unpickedRemindAfterMin` | `pickupUnpickedMin` |
| 超时自动完成 | `autoCompletePickup` | `pickup.autoCompleteAfterMin` | `pickupAutoCompleteMin` |

通用 `remindUnacceptedOrders` 排除自取；`autoRejectStaleCancelRequests` 不碰自取。

### 错误码

| 码 | 含义 |
|---|---|
| 42280 | 到店自取不可用（未开通 / 休业 / 自取暂停，文案区分） |
| 42281 | 取餐时段不可选（非整格或已过期） |
| 42282 | 未达自取起送门槛 |
| 42283 | （预留：取餐人手机号无效。当前由 zod 以 40001 报，保留码值不占用） |
| 42284 | 操作与自取订单状态不符（发货/标记完成/确认收货等误操作） |

同城看板路由（`/admin/local/orders/:id/accept|call|self-deliver|delivered`）对非同城单沿用既有的
`42204`，不改成 42284——那些守卫早于自取存在，对邮寄单也是 42204。

### 环境变量

`WECHAT_TMPL_PICKUP` / `WECHAT_TMPL_PICKUP_FIELDS`（取餐提醒模板；留空只 warn 不阻塞）。

## 附录 I：打包费（2026-09-13）

设计依据 `docs/superpowers/specs/2026-09-13-packing-fee-design.md`。同城外送（`LOCAL`）与到店自取（`PICKUP`）按份收打包费；全国邮寄（`EXPRESS`）恒 0（箱费已在运费里）。唯一实现见 `services/packing-fee.ts`。

### 公式

```
perItem(product) = product.packingFeeFen ?? settings.packing.perItemFen
packingFee        = (settings.packing.enabled && deliveryType ∈ {LOCAL, PICKUP})
                    ? Σ(非赠品行 quantity × perItem(product)) : 0
actualAmount      = subtotal − pickupDiscount − promoDiscount − couponDiscount + shippingFee + packingFee
```

打包费按**下单时**的设置与商品覆盖值算好，写进 `orders.packing_fee` 快照；之后改设置或改商品都不影响已下的单（与运费同理）。**不参与**起送门槛、阶梯免运、券门槛、券封顶、自取折扣、满减档位的任何判定——那些判定用的都是商品小计（`totalAmount`），全程未动过。`promoDiscount`（满减）见附录 K，2026-09-17 加入本公式。

### 字段

| 字段 | 位置 | 说明 |
|---|---|---|
| `packing: { enabled, perItemFen }` | `GET /api/local/meta`、`GET/PUT /api/admin/settings/local-delivery` | 全店开关（默认开）与默认每份打包费（分，默认 100；0–10000（分）；越界或非整数回落默认 100（仓库 int() 语义）；商品级 packingFeeFen 越界是 400 拒绝，不回落）。`enabled=false` 时整店临时不收，商品上的覆盖值原样保留。 |
| `packingFeeFen: number \| null` | 商品对象（`GET /api/products*`、购物车行）、`POST/PUT /api/admin/products` | 商品级覆盖：`null`=跟随全店默认，`0`=该菜不收，其它=该菜每份打包费（分，0–10000）。 |
| `packingFeeEach: number` | 商品对象、购物车行 | 已解析出的单份实收（分），供结算页/购物车预览用；`= packingFeeEach(settings, product)`。 |
| `packingFee: number` | 订单对象（下单响应、顾客订单列表/详情、后台订单列表/详情） | 本单打包费快照（分）。`EXPRESS` 单恒 0。 |

赠品行不计打包费：下单时赠品行根本不进入 `calcPackingFee`（`lines` 只含付费行），函数另留 `isGift` 守卫作第二道闸。邮寄渠道商品的 `packingFeeEach` 恒为 0。

### 小票

取餐/配送联金额顺序：`合计 → 打包费 → 自取优惠 → 满减 → 优惠券 → 运费（外送）→ 实付`（2026-09-17 全店满减设计加入「满减」一行，见附录 K）。`packingFee > 0` 才打「打包费：¥X.XX」；`packingFee=0` 不印；厨房联不印（不印任何金额）。

### 退款

`remainingRefundable = actualAmount − refundedAmount` 已天然含打包费，未改动。

### 错误码

无新增。

### 影响的既有接口

`POST /api/orders`（计价接线）、`GET /api/orders`、`GET /api/orders/:id`、`GET /api/admin/orders`、`GET /api/admin/orders/:id`、`GET /api/products`、`GET /api/products/:id`、`GET /api/cart`、`POST /api/admin/products`、`PUT /api/admin/products/:id`。

## 附录 J：餐具选择（2026-09-14）

设计依据 `docs/superpowers/specs/2026-09-14-tableware-choice-design.md`。同城外送（`LOCAL`）与到店自取（`PICKUP`）结算页必选餐具；全国邮寄（`EXPRESS`）不涉及餐具。规则唯一来源 `services/tableware.ts`（zod 校验、旧版前缀兼容、落库列、两套文案），下单时写入 `orders.tableware_mode`/`orders.tableware_count`，其余接口只读这两列。**免费**：不参与任何金额明细（结算页、小票、工作台、订单详情都不出现餐具行的金额）。

### 下单 body：`tableware`

```
tableware?: { mode: 'NONE' | 'BY_MEAL' | 'COUNT', count?: number }
```

- `mode='COUNT'` 时必须带 `count`（1–10 的整数）；`mode='NONE'`/`'BY_MEAL'` 时不得带 `count`——带了直接 400（`40001`），不做静默纠正。
- `LOCAL`/`PICKUP` 不带 `tableware` 也能建单（两列落 `null`，兼容未升级的旧版客户端）。
- `EXPRESS` 单即使带了 `tableware` 也会被忽略（两列恒 `null`）。字段本身仍要通过校验——`EXPRESS` 带了非法 `tableware` 同样 `40001`；备注前缀剥离也不分渠道。

| 校验失败场景 | 错误码 |
|---|---|
| `mode='COUNT'` 缺 `count` | `40001` |
| `count` 不在 1–10（如 `0`、`11`） | `40001` |
| `mode` 非 `COUNT` 却带了 `count`（如 `{mode:'BY_MEAL',count:2}`） | `40001` |
| `mode` 不在三值枚举内 | `40001` |

### 旧版前缀兼容

旧版小程序把「需要餐具」拼进备注前缀：请求体 `remark` 以 `/^\[需要餐具\]\s*/` 开头时，服务端在 zod 解析**之前**剥掉这个前缀；若同一请求没有 `tableware` 字段，自动补成 `{ mode: 'BY_MEAL' }`（旧版客户端不区分按餐量/按份数，一律按餐量记）；剥完前缀后若剩余字符串为空，`remark` 视为未填。`remark` 的 20 字上限只约束剥前缀之后的正文，原始请求体因此允许比 20 字更长（前缀本身不占用户的备注字数）。

### `GET /api/orders/tableware-last`

该顾客最近一次选过餐具的订单（`deliveryType ∈ {LOCAL, PICKUP}` 且 `tablewareMode` 非空），供结算页预填「记住上次选择」用，不建新表：

```json
{ "mode": "COUNT", "count": 3 }
```

没有任何历史选择时返回 `null`。

### 订单对象字段

| 字段 | 位置 | 说明 |
|---|---|---|
| `tablewareMode: 'NONE' \| 'BY_MEAL' \| 'COUNT' \| null` | 下单响应、顾客订单列表/详情、后台订单列表/详情 | `EXPRESS` 单与未选餐具的旧版客户端单恒为 `null`。 |
| `tablewareCount: number \| null` | 同上 | 仅 `tablewareMode='COUNT'` 时为 1–10 的整数，其余情况恒为 `null`。 |

### 工作台卡片

`GET /api/admin/workbench/snapshot` 的每张卡片新增：

```json
"tableware": { "mode": "COUNT", "count": 3 } | null
```

`tablewareMode` 为空时整个 `tableware` 字段为 `null`（不是 `{mode:null,count:null}`）。

### 文案

| 位置 | `NONE` | `BY_MEAL` | `COUNT`（N 份） | `null` |
|---|---|---|---|---|
| 界面（小程序结算页/详情、后台工作台/同城订单列表） | 无需餐具 | 需要餐具 · 按餐量 | 需要餐具 · N 份 | （不显示） |
| 小票 | 无需餐具 | 餐具：按餐量 | 餐具：N 份 | （不印） |

### 小票

餐具独立成行，**不进备注、也不进金额明细**：取餐联/配送联在收件信息块之后、备注之前印一行（`<B>` 放大）；厨房联紧跟尾号印同一行。票面超长触发的所有降级（①–⑤，含第⑤步压缩备注）都不会删或截断这一行——保证「少放一份餐具」这种错误不会因为票面裁剪而发生。邮寄单与未选餐具的旧单不印这一行。

### 错误码

无新增，复用 `40001`（zod 校验失败）。

### 影响的既有接口

`POST /api/orders`（校验、旧前缀兼容、计价接线不涉及）、`GET /api/orders`、`GET /api/orders/:id`、`GET /api/admin/orders`、`GET /api/admin/orders/:id`、`GET /api/admin/workbench/snapshot`、`GET /api/orders/tableware-last`（新增）、小票渲染（`services/ticket/content.ts`）。

## 附录 K：全店自动满减（2026-09-17）

设计依据 `docs/superpowers/specs/2026-09-17-store-promotion-design.md`。后台可配「全店自动满减」（多档、按渠道勾选、可设起止时间），顾客不用领券、达标自动减。唯一实现见 `services/promotion.ts`（纯函数）与 `services/local-settings.ts`（设置块）。**本批不改小程序**：活动条 / 进度提示 / 结算页金额行留给下一批，本批只保证服务端算对、后台配得了、四个只读契约字段先就位。

`channels` 的键**直接用 `DeliveryType`**（`LOCAL`/`PICKUP`/`EXPRESS`），不是设计稿草案里的 `LOCAL_DELIVERY`——两套值域本来就一一对应，00 规划定稿后由店主裁定去掉这层映射（避免多一处将来对不上的地方）。

### 公式

```
promoDiscount  = min(promoDiscountOf(settings, subtotal, channel, now), subtotal − pickupDiscount)
couponDiscount = 券 ? min(券面额, subtotal − pickupDiscount − promoDiscount) : 0
actualAmount   = subtotal − pickupDiscount − promoDiscount − couponDiscount + shippingFee + packingFee
```

计价顺序：小计 → 自取优惠 → **满减** → 优惠券 → 运费 → 打包费 → 实付。满减插在自取优惠之后、
优惠券之前；`promoDiscountOf` 本身保证 `cutFen < minFen ≤ subtotal`，但「自取立减 + 满减」仍可能
把两者之和推过小计，所以额外封顶到 `subtotal − pickupDiscount`——满减让位给自取折扣（自取折扣先
算，是「渠道属性」）。起送门槛、阶梯免运、券门槛判定**一律按减前的商品小计**（`totalAmount`），
不受满减影响，与既有的打包费/自取折扣口径一致。

### 设置块：`promotion`（`GET/PUT /api/admin/settings/local-delivery`、`GET /api/local/meta`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `enabled` | boolean | 总开关，默认 `false`（存量生产库没有这个块，部署后活动关着，店主自己开）。 |
| `name` | string | 活动名称，1–20 字，默认「全店满减」；空串回默认。 |
| `startAt` / `endAt` | string(ISO 8601) \| null | 起止时间，`null` = 立即生效 / 长期有效。格式必须是带 `T` 分隔符的 ISO 8601（如 `2026-09-18T00:00:00+08:00`）——`2026/10/08` 这类斜杠日期会被 `Date.parse` 当本地时区悄悄解析成一个「看似正确」的时刻，因此格式闸门不能只查 `Date.parse` 是否有限，`validateRawLocalSettings` 与 sanitize 都用同一条更严格的正则。**时区偏移必填**：结尾必须是 `Z` 或 `±HH:mm`，不带一律 40001——`new Date('2026-09-18T00:00')` 按进程 TZ 解析，服务端若不在 +08:00 运行，店主填的时刻会整体平移。 |
| `channels` | `{ LOCAL, PICKUP, EXPRESS: boolean }` | 三个渠道各自的开关，默认 `{ LOCAL: true, PICKUP: false, EXPRESS: true }`（自取默认不勾，避免叠加自取折扣亏本）。 |
| `tiers` | `{ minFen, cutFen }[]` | 按 `minFen` 升序、去重（同门槛只留 `cutFen` 更大的那条）、≤ 10 档，默认 `[]`。 |

校验（`validateLocalSettings`，保存时）：任一档 `cutFen >= minFen` → 「满 ¥X 减 ¥Y：减的比门槛还多，这样配会亏本」；`startAt && endAt && startAt >= endAt` → 「活动结束时间须晚于开始时间」；`enabled && tiers.length === 0` → 「启用满减至少要配一档」。

单档金额出界（`minFen`/`cutFen` 不在 1–10_000_000 分）不报错，而是在 sanitize 里被**整行丢弃**——保存返回 0、回查才发现少一档。后台页 `PromotionSettings.tsx` 的行内校验挡住了两端，直接调 API 时请自行注意。

后台整包保存（`PUT /api/admin/settings/local-delivery`）里请求体不带 `promotion` 键时，从当前设置原样带回再 sanitize——与 `packing` 同一处理：不这样做的话，任何一个不认识这个块的整包保存页面（同城配送设置、到店自取设置……）一保存就会把活动静默关掉。

### 满减规则（`services/promotion.ts`）

- `promoDiscountOf(settings, subtotalFen, channel, now)`：活动未 active（未启用 / 不在起止时间内）或该渠道未勾选 → `0`；否则在所有 `subtotalFen >= minFen` 的档里取 **`cutFen` 最大**的一档（不是最后一档，不叠加多档）；没有达标档 → `0`。
- `promoPreviewOf(settings, subtotalFen, channel, now)` → `{ active, discountFen, nextTierMinFen, nextTierCutFen, nextTierGapFen }`：`discountFen` 同上；「下一档」是按 `minFen` 升序第一条满足 `minFen > subtotal && cutFen > discountFen` 的档（减得不比当前多的档不算「值得再买」）；不 active 时 `discountFen=0`、三个 `null`。
- 四个函数（含 `isPromoActive`、`publicPromotionView`）都是纯函数：不 import prisma、不抛 AppError，`now` 必传。

### 只读接口（下一批小程序接的契约，改名即破坏契约）

| 接口 | 新增字段 | 说明 |
|---|---|---|
| `GET /api/local/meta` | `promotion: { active, name, startAt, endAt, channels, tiers }` | 不 active 也照常给结构（`active:false`），字段形状稳定。 |
| `POST /api/local/quote` | `promoDiscountFen`、`nextTierGapFen` | 按 `LOCAL` 渠道、请求体 `subtotal` 算。 |
| `POST /api/express/quote` | `promoDiscountFen`、`nextTierGapFen` | 按 `EXPRESS` 渠道、清单小计算。 |
| `GET /api/local/promo-preview?deliveryType=LOCAL\|PICKUP\|EXPRESS&subtotal=N`（新增） | `promoPreviewOf(...)` 原样 | 公开、不登录、无限流。自取没有报价接口、购物车阶段没有地址报不了 `LOCAL` 的价，这是它们唯一能拿到「本单减多少 / 还差多少」的地方。`subtotal` 是顾客传的展示用值，真正下单时服务端按 `totalAmount` 重算。 |

### 订单对象字段

| 字段 | 位置 | 说明 |
|---|---|---|
| `promoDiscountAmount: number` | 下单响应、顾客订单列表/详情、后台订单列表/详情 | 本单实际减掉的满减金额（分），下单时快照。非参加单（未启用/未达标/渠道未勾）恒为 `0`。 |

### 小票

配送/取餐联金额顺序：`合计 → 打包费 → 自取优惠 → 满减 → 优惠券 → 运费（外送）→ 实付`。`promoDiscountAmount > 0` 才打「满减：−¥X.XX」，紧跟在「自取优惠」之后、「优惠券」之前；`=0` 不印；厨房联不印（不印任何金额）。

### 退款

`services/refund.ts` 不改计算：退款一律按**实付金额**为上限，满减不返还、部分退款不重算满减（与打包费、自取优惠同一口径）。

### 错误码

无新增，复用 `40001`（zod 校验失败 / `validateLocalSettings` 业务校验失败）与 `42251`（实付被抵到 0，与既有「券/自取优惠抵完」共用同一码）。

### 影响的既有接口

`POST /api/orders`（计价接线：自取优惠之后、券之前插入满减，券封顶随之改为「小计 − 自取优惠 − 满减」）、`GET /api/orders`、`GET /api/orders/:id`、`GET /api/admin/orders`、`GET /api/admin/orders/:id`、`GET /api/local/meta`、`POST /api/local/quote`、`POST /api/express/quote`、`GET /api/local/promo-preview`（新增）、`GET/PUT /api/admin/settings/local-delivery`、小票渲染（`services/ticket/content.ts`）。`services/member/pricing.ts` 的 `computeCheckout` 新增可选入参 `promoDiscount`（默认 0，不传与传 0 逐字节一致）。


### 小程序接入（2026-09-19）

- 外送页从 `/local/quote.promoDiscountFen`、邮寄页从 `/express/quote.promoDiscountFen`、自取页从 `/local/promo-preview?deliveryType=PICKUP&subtotal=N` 的 `discountFen` 获取满减。页面与组件不从 `promotion.tiers` 自行取档。
- `apps/miniapp/utils/checkout-pay.js` 的 `composePay` 是小程序金额组合的唯一入口：自取优惠 → 满减 → 券，依次封顶到商品余额，然后加运费与打包费。`computePickupPay` 委托该函数；旧四参数调用保持原返回形状，显式传第五参数 `promoFen` 时新增 `promoDiscount`。
- `checkout-benefits.otherDiscount`（分）为自取优惠与满减之和，组件将服务端券抵扣额二次封顶到 `subtotal − otherDiscount`，显示与父页明细保持一致；券资格与门槛始终按减前小计。父页只在数值变化时更新该属性，避免回传事件反复重算。
- 主页、分类页在两个渠道均读取公开 `/local/meta` 的活动配置，邮寄不采用同城营业状态。购物车进度使用公开 promo-preview；同城免运提示动态读取 `fee.freeShipTiers` / `radiusKm`，有距离限制时说明公里范围，自取与邮寄不显示这段同城免运提示。
- promo-preview 请求失败：结算条隐藏进度和满减划线；自取页应付显示待计算，按钮在其它必要条件满足后显示「重新计算优惠」并重试。在途旧响应用序号作废，关闭活动或不参加自取时立即清零且不请求。
- 订单详情读取订单快照 `promoDiscountAmount`，不根据当前活动设置反算。以上金额变化不影响起送、免运和券门槛的减前小计口径。

## 附录 L：退款状态自动补查与服务端时区（2026-09-21）

### 退款状态自动补查

微信退款回调丢失时，60 秒心跳定时任务（`refundReconcile`，实现在 `services/refund-reconcile.ts`）定时去问微信这笔退款到底成没成，按结果走既有的状态流转，不新增状态机、不改退款金额计算。

**扫描范围**（`reconcileStuckRefunds`）：
- `status IN ('PENDING','PROCESSING')` 且 `createdAt` 早于 `afterMin`（默认 5 分钟，同时也是复查间隔）且距上次补查已过 `intervalMin`；
- `status = 'ABNORMAL'`（在途态，占 `activeOrderId`）且距上次补查已过 `abnormalIntervalMin`（默认 60 分钟，不进 env——店主在商户平台人工处理后微信可能推 SUCCESS/CLOSED 回调，回调丢了同样要有人兜）；
- 每轮最多处理 `batch` 笔（默认 20），`orderBy createdAt asc`。

**查询结果 × 当前状态 → 动作**（`reconcileRefund`，单笔，可独立调用做自测/联调）：

| 微信查询结果 | 本地状态 | 动作 |
|---|---|---|
| `SUCCESS` | 任意在途态 | 走 `finalizeRefundSuccess`（与回调同一函数，天然幂等） |
| `CLOSED` | 任意在途态 | 走 `markRefundClosed`，释放 `activeOrderId` |
| `ABNORMAL` | 任意在途态 | 走 `markRefundAbnormal`，保留 `activeOrderId` |
| `PROCESSING` | — | 不改状态，只记录本次已查过 |
| 查无此单 | `PENDING` | 标 `FAILED`（`errorCode='RECONCILE_NOT_FOUND'`），释放 `activeOrderId`（后台可重试） |
| 查无此单 | `PROCESSING`/`ABNORMAL` | 不改状态，只告警（当初拿到过 `refund_id`，查无此单不正常） |
| 查询抛错（超时/5xx） | — | 不改状态，`reconcileLastError` 记录错误，下轮再试 |
| 微信侧金额与本地 `amount` 不符 | — | 不改状态，告警（口径同 `wechat-notify.ts` 的回调金额校验） |

**幂等与互斥依据**：`finalizeRefundSuccess` 用 `SELECT ... FOR UPDATE` 把回调与补查串行化，条件写 `status ≠ SUCCESS` 保证只有一方真正累加 `refundedAmount`，金额用 `LEAST(refunded_amount + amount, actual_amount)` 封顶。`markRefundAbnormal`/`markRefundClosed`/`markRefundFailed` 三个函数本批全部改成条件 `updateMany`（只有行仍在各自的「在途态」集合内才会真正转移状态并发通知），已被推进到别的终态的行调用这三个函数会 `count=0` 直接返回，不改状态、不重复通知。`reconcileRefund` 自己用 CAS 占坑（`reconcileCheckedAt` 从旧值改成 `now` 才算抢到）防并发 tick 重复查询。

**Refund 新增三列**（`refunds` 表）：`reconcile_checked_at`（上次补查时间，`DATETIME(3)` 可空）、`reconcile_count`（累计补查次数，默认 0）、`reconcile_last_error`（最近一次查询失败或金额不符的原因，`VARCHAR(255)` 可空）。`GET /admin/orders/:id` 响应的 `refunds[]` 每项随之带上这三个字段（只读，供人工核对补查进度）。

**告警**：`PENDING`/`PROCESSING` 行连续 `alertAfter`（默认 6 次，约 30 分钟）补查后仍未到终态 → 「退款长时间未到账」（`key: refund-reconcile-stuck:<id>`，6 小时窗口内只发一次）。`ABNORMAL` 行不发这条告警（`markRefundAbnormal` 已经告警过，且本就要人工处理）。另外两个新告警：「退款补查：微信查无此单」（`key: refund-reconcile-notfound:<id>`）、「退款补查金额不一致」（`key: refund-reconcile-mismatch:<id>`），6 小时窗口内只发一次（与「退款长时间未到账」同）。三条都走既有 `notifySystemAlert` 通道（企微系统告警 webhook → 回退订单群；PushPlus 只给老板），不新开通道。

**env 三键**（默认值见 `.env.example`）：`REFUND_RECONCILE_AFTER_MIN`（≥1，默认 5，既是年龄阈值也是复查间隔）、`REFUND_RECONCILE_ALERT_AFTER`（≥1，默认 6）、`REFUND_RECONCILE_BATCH`（1–100，默认 20）。

**`run-scheduler` 新增 5 个覆盖键**（供联调/e2e）：`refundReconcileAfterMin`、`refundReconcileIntervalMin`、`refundReconcileAbnormalIntervalMin`、`refundReconcileAlertAfter`、`refundReconcileBatch`（都可传 0，语义同其它阈值覆盖键——0 是「立刻命中」不是「关掉」）。

**pay-mock 控制面** `/api/admin/system/pay-mock/*`（仅 `WECHAT_PAY_MOCK=true` 时挂载，生产不存在）：

| 接口 | 说明 |
|---|---|
| `POST /reset` | 清空指令队列与调用记录 |
| `POST /refund-query` | `{ outRefundNo?, directive }`，`outRefundNo` 缺省或传 `'*'` 表示对任意单号通配。`directive` 四种：`{kind:'ok', status:'SUCCESS'\|'CLOSED'\|'PROCESSING'\|'ABNORMAL', amount?, refundId?, successTime?}` / `{kind:'not_found'}` / `{kind:'error', code, message?, httpStatus?}` / `{kind:'timeout'}`。无指令时默认 `{kind:'ok', status:'PROCESSING'}`（安全默认，不改任何状态）。`ok` 不带 `amount` 时响应也不带 `amount`（补查只在 `amount` 存在时比对金额，与真实微信一致） |
| `GET /calls?op=queryRefund` | 已记录的调用列表，供 e2e/联调断言查了几次 |

**`GET /api/admin/system/status` 新增**：`order.refundReconcile.{afterMin,alertAfter,batch}`（当前生效的 env 配置）、`timezone`（见下）。

### 服务端固定北京时间

进程启动时（`config.ts`，`dotenv` 加载之后、任何业务 `Date` 使用之前）无条件把 `process.env.TZ` 覆盖为 `Asia/Shanghai`（不是缺省才填——PM2 显式配了 `TZ=UTC` 也会被纠正），随后自检：偏移必须是 `-480` 且 `Intl.DateTimeFormat().resolvedOptions().timeZone` 必须是 `Asia/Shanghai`（赋一个不存在的时区名会静默回落到 UTC，`offset` 会变 0，靠这个自检能抓到）。生产环境自检失败直接拒绝启动（`pm2 logs` 会看到 `[timezone] … 拒绝启动`）；非生产只警告不拦截。PM2 侧 `ecosystem.config.js` 的 `env_production` 也加了 `TZ: 'Asia/Shanghai'` 作第二道保险。

`GET /api/admin/system/status` 新增 `timezone: { name, offsetMin, ok, overriddenFrom }`（`overriddenFrom` 是被覆盖前的原值，未发生覆盖则为 `null`）。启动日志新增一行 `[server] timezone: Asia/Shanghai (offset -480)`；若环境原本设了别的 TZ，会先打一行 `[timezone] 环境 TZ=<原值> 已被覆盖为 Asia/Shanghai`。

## 附录 M：同城预约送达（2026-09-21）

设计依据 `docs/superpowers/specs/2026-09-21-scheduled-delivery-design.md`。预约单 = `deliveryType=LOCAL` 且 `scheduledAt` 非空；四个倒推时刻由 `services/delivery/schedule.ts` 的 `scheduleTimeline` 唯一给出。

### 数据

`orders`：`scheduled_at / ready_at / prep_ticket_at / schedule_reminded_at`（均可空）；`deliveries`：`call_origin`（`SCHEDULED_AUTO | MANUAL_EARLY | NULL`）。

### 设置（`local_delivery.schedule` + 顶层 `selfCancelLeadMin`）

| 字段 | 默认 | 范围 | 含义 |
|---|---|---|---|
| `schedule.enabled` | false | — | 预约外送总开关 |
| `schedule.slotMinutes` | 30 | 15–120 | 时段粒度 |
| `schedule.daysAhead` | 1 | 0–3 | 0 只当天，1 当天+明天 |
| `schedule.acceptBufferMin` | 5 | 0–30 | 接单截止 = 开始备餐 − 它 |
| `schedule.prepMinutes` | 20 | 0–180 | 预约单备餐；高峰取与 `peak.prepMaxMinutes` 的大者 |
| `schedule.prepTicketLeadMin` | 15 | 0–60 | 备餐票 = 开始备餐 − 它 |
| `schedule.readyRemindEveryMin` | 3 | 1–15 | 催备好小条间隔 |
| `schedule.readyRemindMaxTimes` | 5 | 1–10 | `callAt + every×max` 后停止小条并告警一次 |
| `schedule.callToleranceMin` | 5 | 0–15 | 早于 `callAt − 它` 呼叫须 `force` |
| `selfCancelLeadMin` | 120 | 0–720 | 自取与预约共用：约定前 N 分钟内关闭自助秒退 |

### 接口

| 接口 | 变化 |
|---|---|
| `GET /api/local/meta` | `delivery` 节加 `scheduleEnabled / slotMinutes / selfCancelLeadMin / earliestScheduleText` |
| `GET /api/local/delivery-slots?distanceM=` | 新增，结构同 `pickup-slots` |
| `POST /api/orders` | LOCAL 可传 `scheduledAt`；42290 未开通 / 42291 时段不可选；预约单跳过暂停与营业时间判定 |
| `GET /api/orders/:id` | 加 `schedule` 节；`canSelfCancel`/`canRequestCancel` 按约定前 `selfCancelLeadMin` 判（自取同） |
| `PUT /api/orders/:id/cancel` | 自取/预约：约定前 `selfCancelLeadMin` 之外 PAID/PREPARING 均可秒退；之内 42229 |
| `POST /api/orders/:id/cancel-request` | 自取/预约：PAID 也可申请 |
| `POST /admin/local/orders/:id/accept` | 预约单不重算 `estimatedDeliveryAt` |
| `POST /admin/local/orders/:id/accept-and-call` | 预约单 42292 |
| `POST /admin/local/orders/:id/call` | 加 `force`；预约单早于 `callAt − callToleranceMin` 无 force → 42292 |
| `POST /admin/local/orders/:id/ready` | 新增；`{ readyAt, called, callAt }`；`distanceM` 缺失（数据异常）→ 42292，不写 `readyAt`，店员改用「立即呼叫」或「自己送」 |
| `GET /admin/orders` | 加 `schedule=SCHEDULED|ASAP` |
| `GET /admin/orders/:id` | 加 `schedule` 节 |
| `GET /admin/workbench/snapshot` | 加 `columns.scheduled`、卡片 `local.schedule`、顶层 `scheduleEnabled / scheduleBar` |
| `GET /api/admin/stats/local` | `kpi.scheduledCount` / `kpi.prev.scheduledCount`（预约单计数） |

### 定时任务（`scheduler.ts`，无 override 键）

| 键 | 函数 | 触发 |
|---|---|---|
| `schedPrepTicket` | `printPrepTickets` | `ticketAt`，每单一次（`prep_ticket_at`） |
| `schedUnaccepted` | `remindScheduledUnaccepted` | max(付款+15, `acceptDueAt`)，每单一次 |
| `schedNotReady` | `remindScheduledNotReady` | `callAt` 起每 `readyRemindEveryMin`，`every×max` 后告警一次 |
| `schedAutoCall` | `autoCallScheduled` | 已备好且 `callAt` 到 |
| `schedLate` | `remindScheduledLate` | `scheduledAt`+10 分未取餐，限频 60 分钟 |

`remindUnacceptedOrders / autoCallRiders / remindLocalUncalled / autoRejectStaleCancelRequests` 排除预约单；`repeatAnnounce` 对预约单锚在 `acceptDueAt`。

### 小票

`PrintJob.kind` 加 `PREP`（去重 seq 0）、`READY_DUE`（seq = 第几次）。版式见 spec §4.8。

### 错误码

| 码 | 含义 |
|---|---|
| 42290 | 预约配送未开通 |
| 42291 | 送达时段不可选 |
| 42292 | 操作与预约单状态不符（接单并呼叫 / 过早呼叫 / 对立即单点已备好 / 标记已备好但 `distanceM` 缺失） |
