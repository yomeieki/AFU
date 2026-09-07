# 数据库设计文档

> 金额字段统一使用 INT 类型，单位为分（人民币），避免浮点数精度问题。
> 所有表包含 created_at 和 updated_at 字段。
> 删除操作使用软删除（deleted_at 字段）。

---

## 一、表清单

24 张表。**下面第二节只详写其中一部分**（本文档从 MVP 时期长起来的，后续功能的表按需补）；
完整、精确的结构一律以 `apps/server/prisma/schema.prisma` 为准（见第四节）。

| 表名 | 说明 | 第二节有详表 |
|------|------|---|
| users | 小程序用户 | ✅ 2.1 |
| admins | 后台管理员 | ✅ 2.2 |
| categories | 商品分类 | ✅ 2.3 |
| products | 商品 | ✅ 2.4 |
| product_images | 商品图片 | ✅ 2.5 |
| product_skus | 商品规格（多规格商品） | — |
| carts | 购物车 | ✅ 2.6 |
| addresses | 收货地址 | ✅ 2.7 |
| orders | 订单 | ✅ 2.8 |
| order_items | 订单商品 | ✅ 2.9 |
| payments | 支付记录 | ✅ 2.10 |
| refunds | 退款记录 | — |
| after_sales | 售后申请 | — |
| shipments | 发货/物流信息 | ✅ 2.11 |
| deliveries | 同城配送单 | — |
| delivery_events | 同城配送状态事件 | — |
| print_jobs | 小票打印作业 | — |
| scan_logs | 二维码扫码日志 | ✅ 2.12 |
| settings | 键值配置（运费/同城/打印机/会员） | — |
| banners | 首页轮播 | — |
| points_ledgers | 积分流水（**权威账本**） | ✅ 2.13 |
| coupon_templates | 券模板 | ✅ 2.14 |
| user_coupons | 顾客手里的券 | ✅ 2.15 |
| points_goods | 随单赠品配置 | ✅ 2.16 |

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
| points_balance | INT | DEFAULT 0 | 积分余额。**冗余列**，为查询加的；权威来源是 `points_ledgers`（见 2.13 与 3.8） |
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
| coupon_id | INT | NULL | 用的哪张券。普通 Int 列，**不建关系字段**（避免与 `user_coupons.order_id` 双向强关联） |
| discount_amount | INT | DEFAULT 0 | 券抵扣额（分）。只抵商品金额，不抵运费 |
| points_used | INT | DEFAULT 0 | 赠品消耗的积分 |
| points_earned | INT | DEFAULT 0 | 本单发放的积分 |
| points_settled_at | DATETIME | NULL | 积分已结算的标记。**判「结算过没有」只能看它,不能用 `points_earned === 0`**——否则得 0 分的订单会被兜底任务永远重扫（spec §5.4） |
| points_base | INT | NULL | 发分时的计算基数（实付 − 当时已退）。退款按 `points_earned × 退款额 / points_base` 摊，与 `earnRatePerYuan` 无关，改比例不影响历史单 |
| created_at | DATETIME | NOT NULL | 创建时间 |
| updated_at | DATETIME | NOT NULL | 更新时间 |

**索引：**
- UNIQUE INDEX idx_order_no (order_no)
- INDEX idx_user_id_status (user_id, status)
- INDEX idx_status_created (status, created_at)
- INDEX (status, points_settled_at, completed_at) —— 积分兜底任务的扫描

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
| subtotal | INT | NOT NULL | 小计 = product_price × quantity（分）。**赠品行恒为 0** |
| is_gift | BOOLEAN | DEFAULT false | 随单赠品行。靠它区分「免费的」与「0 元 bug」——票面与顾客端都据此打「赠」标、把单价换成积分价 |
| points_cost | INT | DEFAULT 0 | 赠品的单件积分价（快照）。**不引用 `points_goods.id`**，所以删赠品配置不影响历史订单 |
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
| scene | VARCHAR(64) | NOT NULL | 扫码 scene 参数（如 p_10001） |
| source | VARCHAR(32) | DEFAULT 'package' | 来源（package=包装扫码） |
| ip | VARCHAR(45) | NULL | 请求 IP（预留） |
| created_at | DATETIME | NOT NULL | 扫码时间 |

**索引：**
- INDEX idx_product_id (product_id)
- INDEX idx_created_at (created_at)
- FK scan_logs_user_id_fkey (user_id) —— 外键自带索引，不另建

> **2026-09-06 删掉了 `openid` 与 `user_agent` 两列**（迁移 `20260907120000_drop_dead_scan_log_columns`）。
> 两列从建表起就没有任何写入点，全表 NULL。后台「独立访客」原本读 `COUNT(DISTINCT openid)`，
> 因此自 `init` 起一直显示 0；已改数 `user_id`。`openid` 不补写是因为它 100% 冗余
> （每行都写了 `user_id`，而 `User.openid` 唯一非空，能由 `user_id` 唯一确定）。

---

### 2.13 points_ledgers（积分流水）

**权威来源。** `users.points_balance` 是为查询加的冗余列，两者的一致性由
`scripts/check-points-consistency.mjs` 只读校验（`points_balance` 必须等于 Σ 未过期入账行的 `remaining`）。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| user_id | INT | FK → users.id | 用户 ID |
| type | VARCHAR(16) | NOT NULL | EARN 消费得分 / REDEEM 兑换券 / GIFT 随单赠品 / GIFT_REVERT 未支付取消退回 / REFUND_DEDUCT 退款扣回 / EXPIRE 过期 / ADMIN 手动调整（预留，无入口） |
| delta | INT | NOT NULL | 正 = 入账，负 = 出账 |
| balance_after | INT | NOT NULL | 记账后余额（对账用） |
| remaining | INT | DEFAULT 0 | **仅入账行有意义**：这一笔还没被消耗/过期的余量。FIFO 扣减就是扣它 |
| ref_type | VARCHAR(16) | NOT NULL | ORDER / COUPON / REFUND / LEDGER |
| ref_id | VARCHAR(32) | NOT NULL | 来源主键。`ref_type='ORDER'` 时是 **`orders.id`**，不是订单号 |
| remark | VARCHAR(255) | NULL | 备注 |
| expires_at | DATETIME | NULL | EARN/GIFT_REVERT = 到期日；GIFT = 被扣行里最早的到期日（供退回时继承） |
| created_at | DATETIME | NOT NULL | 记账时间 |

**索引：**
- **UNIQUE (type, ref_type, ref_id)** —— 幂等防线，见 3.7
- INDEX (user_id, created_at)
- INDEX (user_id, type, expires_at) —— FIFO 扣减与过期扫描

---

### 2.14 coupon_templates（券模板）

**没有删除操作**，只有停用（`status='OFF'`）。删模板会让已发券的 `template_id` 悬空、发放记录查不出来源。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| name | VARCHAR(64) | NOT NULL | 券名 |
| description | VARCHAR(255) | NULL | 说明 |
| amount | INT | NOT NULL | 减免金额（分） |
| threshold | INT | DEFAULT 0 | 门槛（分），0 = 无门槛代金券 |
| channel | VARCHAR(16) | DEFAULT 'ALL' | ALL / LOCAL / EXPRESS |
| valid_days | INT | NOT NULL | 领取后 N 天有效 |
| source | VARCHAR(16) | NOT NULL | ADMIN 定向发放 / POINTS 积分兑换 / CAMPAIGN 领券中心 / NEWCOMER 新客券。**建后不可改** |
| points_cost | INT | NULL | `source='POINTS'` 必填 |
| total_limit | INT | NULL | 总量，NULL = 不限 |
| per_user_limit | INT | NULL | 每人限领，NULL = 不限 |
| issued_count | INT | DEFAULT 0 | **限量券的并发防线**（`updateMany` 条件递增），只有 POINTS/CAMPAIGN 两条自助路径递增。ADMIN/NEWCOMER 不递增——**后台「已发」列不能用它**，要用接口派生的 `issuedTotal` |
| status | VARCHAR(16) | DEFAULT 'ON' | ON / OFF |
| sort_order | INT | DEFAULT 0 | 排序 |
| created_at / updated_at | DATETIME | NOT NULL | — |

**索引：** INDEX (source, status, sort_order)

---

### 2.15 user_coupons（顾客手里的券）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| user_id | INT | FK → users.id | 归属 |
| template_id | INT | FK → coupon_templates.id | 来源模板 |
| code | VARCHAR(32) | UNIQUE | 券码，客服核对用（Crockford base32，排除易混的 I/L/O/U） |
| name / amount / threshold / channel | — | — | **四个快照字段**：模板改价或停用都不影响已发出去的券 |
| status | VARCHAR(16) | DEFAULT 'UNUSED' | UNUSED / USED / EXPIRED |
| source | VARCHAR(16) | NOT NULL | 同模板 source |
| source_ref | VARCHAR(64) | NULL | 赔偿券 = 关联订单号 |
| issued_by | VARCHAR(64) | NULL | 赔偿券 = 操作管理员登录名。**顾客端白名单里没有这一列** |
| remark | VARCHAR(255) | NULL | 赔偿原因。**同样不外露给顾客** |
| expires_at | DATETIME | NOT NULL | 到期时刻 |
| used_at | DATETIME | NULL | 核销时刻 |
| order_id | INT | NULL | 用在哪一单。普通 Int 列，不建关系字段（与 `orders.coupon_id` 同款） |
| created_at | DATETIME | NOT NULL | 发放时间 |

**索引：** INDEX (user_id, status, expires_at)、INDEX (order_id)、INDEX (status, expires_at)（过期扫描）

> **「可用」一律按时间判**：`status='UNUSED' AND expires_at > NOW()`。过期是定时任务批量翻的，
> 任务扫到之前那些券还挂着 `UNUSED`，只看 `status` 会多算。

---

### 2.16 points_goods（随单赠品配置）

顾客在结算页用积分加购、**跟着付费订单一起履约**的商品。不是单独的 0 元兑换单。

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | INT | PK, AUTO_INCREMENT | ID |
| product_id | INT | NOT NULL | 商品 ID。**建后不可改** |
| sku_id | INT | NULL | 规格 ID，有 SKU 的商品必填。**建后不可改** |
| points_cost | INT | NOT NULL | 单件积分价 |
| per_order_limit | INT | DEFAULT 1 | 每单最多几件 |
| stock_limit | INT | NULL | 总量，NULL = 不限 |
| issued_count | INT | DEFAULT 0 | 已发件数，配 `stock_limit` 判剩余 |
| status | VARCHAR(16) | DEFAULT 'ON' | ON / OFF |
| sort_order | INT | DEFAULT 0 | 排序 |
| created_at / updated_at | DATETIME | NOT NULL | — |

**索引：** UNIQUE (product_id, sku_id)、INDEX (status, sort_order)

> ⚠️ **MySQL 唯一索引不约束 NULL**：无 SKU 商品可以插进多条 `(product_id, NULL)`，
> 唯一索引拦不住。重复校验必须在代码里先 `findFirst`（与 `carts` 表同款处理）。
>
> 有 DELETE（与券模板不同）：`order_items` 落的是商品快照、不引用 `points_goods.id`，
> 删一条配置不会让任何历史订单指向空。

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

订单号格式：`ORD` + 日期(8位，Asia/Shanghai) + **当日流水(4位)**

示例：`ORD202609070087` —— 2026-09-07 的第 87 单，小票与工作台显示为 `#0087`。

2026-09-07 之前是 `ORD` + 日期 + **6 位随机数**（18 位）。改掉的原因：小票和工作台
只显示后四位，而随机数的后四位是均匀随机的一万个数——同一天 100 单出现重号的概率
39%、200 单 86%。撞号之后店员照着票点退款，退的可能是另一个人的钱。

实现见 `apps/server/src/services/order-no.ts`：计数器表 `order_no_seq` 一行/天，
用 `INSERT ... ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)` 原子自增，
在下单事务**之外**取号（放进去会把计数器行锁持有到整笔交易结束，下单被串行化）。
下单失败会烧掉一个号、留下空档——这是给人读的号，不是会计流水。

新号 15 位、旧号 18 位，两者不可能重号，历史单不需要迁移。

### 3.6 支付幂等

payments 表的 wx_transaction_id 字段加唯一索引，当微信重复回调时，尝试插入会因唯一键冲突而失败，后端捕获错误后直接返回 SUCCESS，不重复处理。

### 3.7 积分记账幂等

`points_ledgers` 上的 **`UNIQUE (type, ref_type, ref_id)`** 是这套账的唯一防线：同一来源只能记一次账。

它挡的不是并发，而是**重放**——发分有两条路（订单完成的钩子 + 每日兜底任务
`settleMissedPoints`），退款扣回也可能因为微信重复回调而重跑。两条路都往同一个
`(type='EARN', ref_type='ORDER', ref_id=<order.id>)` 写，唯一键让第二次直接冲突，
代码捕获 `P2002` 后当作「已经记过」跳过。

**不要改成先查再插**：查与插之间的窗口正是重复发分的入口。这条约束在 MySQL 层面
实测过（错误码 1062）。

### 3.8 积分余额的冗余与校验

余额有两处：

- `points_ledgers` —— **权威来源**。余额 = Σ（未过期入账行的 `remaining`）
- `users.points_balance` —— 冗余列，为「列表页要显示每个人多少分」加的

写入一律同事务：改 `remaining` 的同时改 `points_balance`。两者失步就是账错了，
`scripts/check-points-consistency.mjs` 只读校验这一条，e2e 每轮都跑。

`remaining` 的语义值得单独记一笔：**只有入账行有意义**。FIFO 扣减扣的是它而不是 `delta`
（`delta` 是历史事实，不能改），过期扫描也是把到期行的 `remaining` 清零。所以
「余额」不能用 `SUM(delta)` 算——那样会把已经过期的分算进去。

### 3.9 已发出去的东西不追改

三处快照，取向一致：

| 快照 | 在哪 | 为什么 |
|---|---|---|
| 券的面额/门槛/渠道/券名 | `user_coupons` 四列 | 模板改价或停用,顾客手里那张不受影响 |
| 赠品的积分价 | `order_items.points_cost` | 删掉赠品配置,历史订单照常显示 |
| 积分的发放基数 | `orders.points_base` | 店主改 `earnRatePerYuan`,历史单的退款扣回口径不变 |

### 3.10 时间列一律 UTC

**库里存的是 UTC 墙钟，不是北京时间。** Prisma 往 `DATETIME` 列写的是 UTC，而 MySQL 自己的
`NOW()` 取会话时区。2026-09-06 生产实测：`NOW() = 20:25:39` 而 `UTC_TIMESTAMP() = 12:25:39`。

排查现场时**查出来的时间要 +8 小时才是本地时间**。首单 `ORD20260906918208` 的
`created_at` 是 `11:59`，实际发生在 **19:59**——这个坑值得单独记一笔，因为它不会报错，
只会让人把时间线读错 8 小时。

两条规则：

1. **裸 SQL 插入必须显式给时间**，写 `created_at = UTC_TIMESTAMP(3)`，不要依赖列默认值。
   全库 23 张表的 `created_at` 默认值都是 `CURRENT_TIMESTAMP(3)`，它取的是**会话时区**——
   生产会话时区是 `SYSTEM`(CST) 时，裸 SQL 插进去的行会比 Prisma 写的行**早 8 小时**。
   目前所有插入都由 Prisma 显式给值，所以还没出过事；将来任何一处裸 SQL 插入都会踩到。
2. 服务端的自然日分桶一律走 `utils/local-day.ts`（按 `Asia/Shanghai` 提取），
   **不要在 SQL 里用 `NOW()/CURDATE()/DATE()`** ——它们依赖会话时区。当前服务端原生 SQL 里没有
   这类用法，这条是为了保持它没有。

> 前端同理：管理端一律走 `apps/admin/src/utils/time.ts`（由 `scripts/check-admin-timezone.mjs`
> 在 build 时把守），小程序走 `apps/miniapp/utils/time.js`。两处都固定按北京时间渲染，
> 不跟随浏览器/设备时区——否则同一张单在不同时区的电脑上会显示不同的时间。

**可选的加固（运维动作，需店主授权）**：把生产 MySQL 全局时区钉成 UTC，
让列默认值与 Prisma 写入一致，`NOW()` 也就等于 `UTC_TIMESTAMP()`：

```sql
SET GLOBAL time_zone = '+00:00';
-- 并写入 /etc/mysql/mysql.conf.d/mysqld.cnf 的 [mysqld] 段，重启后仍生效：
--   default-time-zone='+00:00'
```

- 影响面：只影响 `DATETIME` 列的**默认值**与手工 `mysql` 会话里 `NOW()` 的显示。
  Prisma 对 `DATETIME` 不做时区换算，与会话时区无关，**已有数据一个字节都不会变**。
- 验收：`sudo mysql -N -e "SELECT NOW(), UTC_TIMESTAMP()"` 两列相等。
- 回滚：`SET GLOBAL time_zone = 'SYSTEM'` + 删掉配置行。
- 代价：运维习惯要改——之后手工查询看到的 `NOW()` 是 UTC。

---

## 四、Prisma Schema

**权威定义在 `apps/server/prisma/schema.prisma`,本文档不再内联抄一份。**

原来这里有一段内联的 schema 预览。2026-09-06 核对时它只剩 4 个 model,而真 schema 有 24 个
——缺了 20 个(`Order`、`OrderItem`、`Payment`、`Refund`、`AfterSale`、`Delivery`、`PrintJob`、
`ProductSku`、以及本轮的 `PointsLedger`/`CouponTemplate`/`UserCoupon`/`PointsGood` 等)。
一份缺了 80% 的「预览」比没有更坏:看的人不知道自己看的是残缺版。

抄一份新的会重新烂掉——上面那 20 个缺失就是这么攒出来的。所以改成指路:

```bash
# 看完整结构
cat apps/server/prisma/schema.prisma

# 只看某张表
sed -n "/^model Order /,/^}/p" apps/server/prisma/schema.prisma

# 看已应用的迁移
ls apps/server/prisma/migrations/
```

上面第二、三节的字段表是**给人读的**(带「为什么这么设计」),会随功能变更同步维护;
需要精确到类型与默认值时以 `schema.prisma` 为准。

