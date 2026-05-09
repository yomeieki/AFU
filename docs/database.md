# 数据库设计文档

> 金额字段统一使用 INT 类型，单位为分（人民币），避免浮点数精度问题。
> 所有表包含 created_at 和 updated_at 字段。
> 删除操作使用软删除（deleted_at 字段）。

---

## 一、表清单

| 表名 | 说明 |
|------|------|
| users | 小程序用户 |
| admins | 后台管理员 |
| categories | 商品分类 |
| products | 商品 |
| product_images | 商品图片 |
| carts | 购物车 |
| addresses | 收货地址 |
| orders | 订单 |
| order_items | 订单商品 |
| payments | 支付记录 |
| shipments | 发货/物流信息 |
| scan_logs | 二维码扫码日志 |

---

## 二、表结构详细设计

### 2.1 users（小程序用户）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | 用户 ID |
| openid | VARCHAR(64) | UNIQUE, NOT NULL | 微信 openid |
| unionid | VARCHAR(64) | NULL | 微信 unionid（如开通开放平台） |
| nickname | VARCHAR(64) | NULL | 用户昵称（微信授权获取） |
| avatar_url | VARCHAR(500) | NULL | 头像 URL |
| phone | VARCHAR(20) | NULL | 手机号（微信授权获取，可选） |
| status | TINYINT | DEFAULT 1 | 1=正常, 0=禁用 |
| last_login_at | DATETIME | NULL | 最近登录时间 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- UNIQUE INDEX idx_openid (openid)

---

### 2.2 admins（后台管理员）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | 管理员 ID |
| username | VARCHAR(64) | UNIQUE, NOT NULL | 登录账号 |
| password_hash | VARCHAR(255) | NOT NULL | bcrypt hash 密码 |
| name | VARCHAR(64) | NULL | 管理员姓名 |
| role | VARCHAR(32) | DEFAULT 'admin' | 角色（预留：super_admin） |
| status | TINYINT | DEFAULT 1 | 1=正常, 0=禁用 |
| last_login_at | DATETIME | NULL | 最近登录时间 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**安全要求：** 密码使用 bcrypt，cost factor >= 12。

---

### 2.3 categories（商品分类）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | 分类 ID |
| name | VARCHAR(64) | NOT NULL | 分类名称 |
| icon_url | VARCHAR(500) | NULL | 分类图标 URL |
| sort_order | INT | DEFAULT 0 | 排序权重，升序 |
| status | TINYINT | DEFAULT 1 | 1=显示, 0=隐藏 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- INDEX idx_status_sort (status, sort_order)

---

### 2.4 products（商品）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | 商品 ID |
| category_id | INT | FK → categories.id | 所属分类 |
| name | VARCHAR(128) | NOT NULL | 商品名称 |
| subtitle | VARCHAR(255) | NULL | 副标题/简介 |
| cover_image | VARCHAR(500) | NULL | 主图 URL |
| price | INT | NOT NULL | 售价（分） |
| original_price | INT | NULL | 划线原价（分） |
| stock | INT | DEFAULT 0 | 库存数量 |
| sales_count | INT | DEFAULT 0 | 已售数量 |
| unit | VARCHAR(16) | DEFAULT '份' | 单位（份/盒/斤等） |
| weight | VARCHAR(32) | NULL | 规格/重量（如 500g） |
| shelf_life | VARCHAR(64) | NULL | 保质期说明 |
| storage_method | VARCHAR(128) | NULL | 储存方式 |
| delivery_info | TEXT | NULL | 配送说明 |
| description | TEXT | NULL | 商品详情描述（富文本/Markdown） |
| status | VARCHAR(16) | DEFAULT 'ON_SHELF' | ON_SHELF=上架, OFF_SHELF=下架, DELETED=删除 |
| delivery_type | VARCHAR(64) | DEFAULT 'EXPRESS' | EXPRESS=快递, LOCAL=同城, PICKUP=自提，逗号分隔多选 |
| is_recommended | TINYINT | DEFAULT 0 | 1=推荐首页 |
| qr_scene | VARCHAR(64) | NULL | 小程序码 scene 参数（如 p_10001） |
| qr_code_url | VARCHAR(500) | NULL | 小程序码图片 URL（存 COS） |
| qr_generated_at | DATETIME | NULL | 二维码生成时间 |
| deleted_at | DATETIME | NULL | 软删除时间 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- INDEX idx_category_status (category_id, status)
- INDEX idx_status_recommended (status, is_recommended)
- INDEX idx_deleted_at (deleted_at)

---

### 2.5 product_images（商品图片）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| product_id | INT | FK → products.id | 所属商品 |
| image_url | VARCHAR(500) | NOT NULL | 图片 URL |
| sort_order | INT | DEFAULT 0 | 排序 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- INDEX idx_product_sort (product_id, sort_order)

---

### 2.6 carts（购物车）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| user_id | INT | FK → users.id | 用户 ID |
| product_id | INT | FK → products.id | 商品 ID |
| quantity | INT | DEFAULT 1 | 数量 |
| is_selected | TINYINT | DEFAULT 1 | 1=勾选结算 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**约束：**
- UNIQUE KEY uk_user_product (user_id, product_id)

**索引：**
- INDEX idx_user_id (user_id)

---

### 2.7 addresses（收货地址）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| user_id | INT | FK → users.id | 用户 ID |
| receiver_name | VARCHAR(64) | NOT NULL | 收货人姓名 |
| receiver_phone | VARCHAR(20) | NOT NULL | 收货人电话 |
| province | VARCHAR(32) | NOT NULL | 省 |
| city | VARCHAR(32) | NOT NULL | 市 |
| district | VARCHAR(32) | NOT NULL | 区/县 |
| detail | VARCHAR(255) | NOT NULL | 详细地址 |
| full_address | VARCHAR(500) | NOT NULL | 省市区+详细地址拼接（冗余，方便查询） |
| is_default | TINYINT | DEFAULT 0 | 1=默认地址 |
| deleted_at | DATETIME | NULL | 软删除 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- INDEX idx_user_id (user_id)

---

### 2.8 orders（订单）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | 订单内部 ID |
| order_no | VARCHAR(32) | UNIQUE, NOT NULL | 订单号（业务唯一号，如 ORD20240101001） |
| user_id | INT | FK → users.id | 用户 ID |
| status | VARCHAR(32) | NOT NULL | 订单状态（见枚举） |
| total_amount | INT | NOT NULL | 商品总额（分） |
| shipping_fee | INT | DEFAULT 0 | 运费（分） |
| actual_amount | INT | NOT NULL | 实际支付金额 = total_amount + shipping_fee（分） |
| delivery_type | VARCHAR(16) | NOT NULL | EXPRESS / LOCAL / PICKUP |
| remark | VARCHAR(255) | NULL | 买家备注 |
| receiver_name | VARCHAR(64) | NOT NULL | **收货地址快照：**收货人 |
| receiver_phone | VARCHAR(20) | NOT NULL | **收货地址快照：**电话 |
| receiver_province | VARCHAR(32) | NOT NULL | **收货地址快照：**省 |
| receiver_city | VARCHAR(32) | NOT NULL | **收货地址快照：**市 |
| receiver_district | VARCHAR(32) | NOT NULL | **收货地址快照：**区 |
| receiver_detail | VARCHAR(255) | NOT NULL | **收货地址快照：**详细地址 |
| receiver_full_address | VARCHAR(500) | NOT NULL | **收货地址快照：**完整地址 |
| paid_at | DATETIME | NULL | 支付时间 |
| cancelled_at | DATETIME | NULL | 取消时间 |
| cancel_reason | VARCHAR(255) | NULL | 取消原因 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- UNIQUE INDEX idx_order_no (order_no)
- INDEX idx_user_id_status (user_id, status)
- INDEX idx_status_created (status, created_at)

**订单状态枚举：**

| 状态值 | 说明 |
|--------|------|
| PENDING_PAYMENT | 待付款 |
| PAID | 已付款（待发货） |
| SHIPPED | 已发货 |
| COMPLETED | 已完成 |
| CANCELLED | 已取消 |
| REFUNDING | 退款中 |
| REFUNDED | 已退款 |

后续扩展（自提场景）：

| 状态值 | 说明 |
|--------|------|
| PENDING_PICKUP | 待自提 |
| PICKED_UP | 已自提 |

---

### 2.9 order_items（订单商品）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| order_id | INT | FK → orders.id | 订单 ID |
| product_id | INT | FK → products.id | 商品 ID（原始，可为 NULL 如商品已删除） |
| product_name | VARCHAR(128) | NOT NULL | **商品快照：**商品名称 |
| product_image | VARCHAR(500) | NULL | **商品快照：**商品图片 |
| product_price | INT | NOT NULL | **商品快照：**下单时单价（分） |
| quantity | INT | NOT NULL | 数量 |
| subtotal | INT | NOT NULL | 小计 = product_price × quantity（分） |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- INDEX idx_order_id (order_id)

---

### 2.10 payments（支付记录）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| order_id | INT | FK → orders.id | 订单 ID |
| order_no | VARCHAR(32) | NOT NULL | 订单号（冗余，方便查询） |
| payment_type | VARCHAR(16) | NOT NULL | MOCK / WECHAT |
| amount | INT | NOT NULL | 支付金额（分） |
| status | VARCHAR(16) | NOT NULL | PENDING / SUCCESS / FAILED / REFUNDED |
| wx_prepay_id | VARCHAR(64) | NULL | 微信预支付 ID |
| wx_transaction_id | VARCHAR(64) | NULL | 微信支付流水号 |
| wx_notify_data | TEXT | NULL | 微信支付回调原始报文（用于对账） |
| paid_at | DATETIME | NULL | 实际支付时间 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**幂等说明：** 微信支付回调以 wx_transaction_id 为唯一键，重复回调直接返回 SUCCESS，不重复处理。

**索引：**
- INDEX idx_order_id (order_id)
- INDEX idx_order_no (order_no)
- UNIQUE INDEX idx_wx_transaction_id (wx_transaction_id)（允许 NULL，NULL 不触发唯一约束）

---

### 2.11 shipments（发货/物流信息）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| order_id | INT | FK → orders.id | 订单 ID |
| order_no | VARCHAR(32) | NOT NULL | 订单号 |
| express_company | VARCHAR(64) | NULL | 快递公司名称（如：顺丰、圆通） |
| express_no | VARCHAR(64) | NULL | 快递单号 |
| shipped_at | DATETIME | NULL | 发货时间 |
| delivery_type | VARCHAR(16) | NOT NULL | EXPRESS / LOCAL / PICKUP |
| remark | VARCHAR(255) | NULL | 发货备注 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- INDEX idx_order_id (order_id)

---

### 2.12 scan_logs（二维码扫码日志）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| product_id | INT | FK → products.id | 商品 ID |
| user_id | INT | NULL | 用户 ID（若已登录） |
| openid | VARCHAR(64) | NULL | 微信 openid（若已登录） |
| scene | VARCHAR(64) | NOT NULL | 扫码 scene 参数（如 p_10001） |
| source | VARCHAR(32) | DEFAULT 'package' | 来源（package=包装扫码） |
| ip | VARCHAR(45) | NULL | 请求 IP（预留） |
| user_agent | VARCHAR(255) | NULL | UA（预留） |
| created_at | DATETIME | NOT NULL | 扫码时间 |

**索引：**
- INDEX idx_product_id (product_id)
- INDEX idx_openid (openid)
- INDEX idx_created_at (created_at)

---

## 三、关键设计说明

### 3.1 金额存储

- 所有金额字段使用 INT，单位为分（人民币）。
- 示例：商品价格 29.90 元 → 存储为 2990。
- 前后端传输时统一使用分，前端展示时除以 100。

### 3.2 地址快照

订单表中的 receiver_* 字段是下单时的地址快照。即使用户后续修改或删除地址，历史订单的收货地址保持不变。

### 3.3 商品快照

order_items 表中的 product_name、product_image、product_price 是下单时的商品快照，保证历史订单数据准确。

### 3.4 软删除

- products 表使用 deleted_at 字段软删除，查询时需过滤 `deleted_at IS NULL`。
- addresses 表同样使用软删除。

### 3.5 订单号生成规则

订单号格式：`ORD` + 日期(8位) + 随机数(6位)

示例：`ORD202401010001`

生成逻辑在后端实现，确保唯一性（可结合数据库唯一约束保障）。

### 3.6 支付幂等

payments 表的 wx_transaction_id 字段加唯一索引，当微信重复回调时，尝试插入会因唯一键冲突而失败，后端捕获错误后直接返回 SUCCESS，不重复处理。

---

## 四、Prisma Schema 预览

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model User {
  id          Int       @id @default(autoincrement())
  openid      String    @unique @db.VarChar(64)
  unionid     String?   @db.VarChar(64)
  nickname    String?   @db.VarChar(64)
  avatarUrl   String?   @db.VarChar(500) @map("avatar_url")
  phone       String?   @db.VarChar(20)
  status      Int       @default(1) @db.TinyInt
  lastLoginAt DateTime? @map("last_login_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  carts     Cart[]
  addresses Address[]
  orders    Order[]
  scanLogs  ScanLog[]

  @@map("users")
}

model Admin {
  id           Int       @id @default(autoincrement())
  username     String    @unique @db.VarChar(64)
  passwordHash String    @db.VarChar(255) @map("password_hash")
  name         String?   @db.VarChar(64)
  role         String    @default("admin") @db.VarChar(32)
  status       Int       @default(1) @db.TinyInt
  lastLoginAt  DateTime? @map("last_login_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  @@map("admins")
}

model Category {
  id        Int       @id @default(autoincrement())
  name      String    @db.VarChar(64)
  iconUrl   String?   @db.VarChar(500) @map("icon_url")
  sortOrder Int       @default(0) @map("sort_order")
  status    Int       @default(1) @db.TinyInt
  createdAt DateTime  @default(now()) @map("created_at")
  updatedAt DateTime  @updatedAt @map("updated_at")

  products  Product[]

  @@index([status, sortOrder])
  @@map("categories")
}

model Product {
  id              Int             @id @default(autoincrement())
  categoryId      Int             @map("category_id")
  name            String          @db.VarChar(128)
  subtitle        String?         @db.VarChar(255)
  coverImage      String?         @db.VarChar(500) @map("cover_image")
  price           Int
  originalPrice   Int?            @map("original_price")
  stock           Int             @default(0)
  salesCount      Int             @default(0) @map("sales_count")
  unit            String          @default("份") @db.VarChar(16)
  weight          String?         @db.VarChar(32)
  shelfLife       String?         @db.VarChar(64) @map("shelf_life")
  storageMethod   String?         @db.VarChar(128) @map("storage_method")
  deliveryInfo    String?         @db.Text @map("delivery_info")
  description     String?         @db.Text
  status          String          @default("ON_SHELF") @db.VarChar(16)
  deliveryType    String          @default("EXPRESS") @db.VarChar(64) @map("delivery_type")
  isRecommended   Int             @default(0) @db.TinyInt @map("is_recommended")
  qrScene         String?         @db.VarChar(64) @map("qr_scene")
  qrCodeUrl       String?         @db.VarChar(500) @map("qr_code_url")
  qrGeneratedAt   DateTime?       @map("qr_generated_at")
  deletedAt       DateTime?       @map("deleted_at")
  createdAt       DateTime        @default(now()) @map("created_at")
  updatedAt       DateTime        @updatedAt @map("updated_at")

  category    Category      @relation(fields: [categoryId], references: [id])
  images      ProductImage[]
  carts       Cart[]
  orderItems  OrderItem[]
  scanLogs    ScanLog[]

  @@index([categoryId, status])
  @@index([status, isRecommended])
  @@map("products")
}

// 其余 model 定义参考上述字段设计...
```
