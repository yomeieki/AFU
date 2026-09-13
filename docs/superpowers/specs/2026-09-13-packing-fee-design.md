# 打包费（同城外送 + 到店自取）设计

日期：2026-09-13　作者：Claude（00 规划 · fable）　状态：待店主审阅

## 0. 一句话

同城渠道（外送、自取）每份菜按份收打包费：全店默认每份 ¥1，每道菜可在商品编辑页单独设「不收」或另一个金额；赠品不收；邮寄不收。打包费作为独立一行出现在结算页、订单详情、小票、工作台与后台订单页；不参与起送门槛、券门槛、自取折扣与券的计算。

## 1. 已拍板的产品决策（改动需重新确认）

| # | 决策 | 结论 |
|---|---|---|
| P1 | 计费口径 | 按**份**收（数量 × 单份打包费），不按单、不按 SKU 行 |
| P2 | 默认值与覆盖 | 全店默认 **¥1.00/份**；每道菜可覆盖：留空 = 跟随默认，0 = 不收，其它 = 该菜单份金额 |
| P3 | 渠道 | 同城外送、到店自取都收，同一价；全国邮寄不收（箱费在运费里） |
| P4 | 赠品 | 不收 |
| P5 | 与门槛/优惠的关系 | 起送门槛、阶梯免运、券门槛都按**商品小计**判，打包费不参与；自取折扣与券只打商品金额 |
| P6 | 退款 | 全额退含打包费；部分退款店员填金额，不改 |
| P7 | 总开关 | 「同城配送设置」里的打包费开关**默认开**；关掉 = 整店临时不收，商品上的设置保留 |
| P8 | 快照 | 下单时按当时设置算好存进订单，之后改设置不影响已下的单（与运费同理） |
| P9 | 展示 | 结算页/订单详情/小票取餐联/工作台抽屉/后台订单详情各加一行「打包费」；购物车条不含（进结算页才算，与运费一致） |

未来可能分开外送/自取定价：本期只存一个默认值，字段命名不带渠道，分开时加一个 `pickupPerItemFen` 即可。

## 2. 数据模型

### 2.1 商品表 `products` 加 1 列

| 列 | 类型 | 含义 |
|---|---|---|
| `packing_fee_fen` | `INT NULL` | null = 跟随全店默认；0 = 不收；>0 = 该菜单份打包费（分） |

历史商品迁移后全为 null，即上线那一刻全店按默认值收，不用逐个补。

### 2.2 订单表 `orders` 加 1 列

| 列 | 类型 | 含义 |
|---|---|---|
| `packing_fee` | `INT NOT NULL DEFAULT 0` | 本单打包费快照（分） |

一次 Prisma 迁移 `20260916000000_packing_fee`，两列都可空/有默认，老数据零影响。

### 2.3 设置（`Setting` key `local_delivery`，无表结构变化）

```
packing: { enabled: boolean /* 默认 true */, perItemFen: number /* 默认 100 */ }
```

sanitize：`perItemFen` 取整、0–10000（¥100）；越界或非整数回落默认 100（仓库既有 `int()` 语义，不是夹到边界）；缺省补 `{ enabled: true, perItemFen: 100 }`。

### 2.4 计算公式（服务端唯一实现 `services/packing-fee.ts`）

```
perItem(product) = product.packingFeeFen ?? settings.packing.perItemFen
packingFee(order) = settings.packing.enabled && channel ∈ {LOCAL, PICKUP}
                    ? Σ(非赠品行 quantity × perItem(product))
                    : 0
actualAmount = subtotal − pickupDiscount − couponDiscount + shippingFee + packingFee
```

`computeCheckout` 加可选入参 `packingFee`（默认 0），与 `shippingFee` 同一层相加；封顶校验不变（券 + 自取优惠 ≤ 商品小计）。

## 3. 服务端

### 3.1 商品

- `GET /api/products*`、`GET /api/products/:id`、购物车行：多返回 `packingFeeFen: number | null`（原始值）与 `packingFeeEach: number`（已解析出的单份实收，供小程序结算页预览用）。
- `POST/PUT /api/admin/products`：zod `packingFeeFen: z.number().int().min(0).max(10_000).nullable().optional()`。

### 3.2 元数据

- `GET /api/local/meta` 多 `packing: { enabled, perItemFen }`。

### 3.3 下单 `POST /api/orders`

- `deliveryType ∈ {LOCAL, PICKUP}` 时按 2.4 算 `packingFee`，写入 `orders.packing_fee`，参与 `actualAmount`；EXPRESS 恒 0。
- 起送门槛（`fee.minOrderAmount`、`pickup.minOrderAmountFen`）、阶梯免运、券门槛仍用商品小计，不变。
- 响应与 `GET /api/orders/:id`、`GET /api/orders` 列表多 `packingFee`。

### 3.4 退款

`remainingRefundable` 已按 `actualAmount − refundedAmount` 算，天然含打包费，不改。

### 3.5 管理端

- `GET /api/admin/settings/local-delivery` / `PUT`：多 `packing` 节。
- `GET /api/admin/orders/:id`、列表：多 `packingFee`。
- 工作台快照卡片：`amountFen` 已是实付，不改；抽屉金额明细由订单详情提供 `packingFee`。

### 3.6 小票（`services/ticket/content.ts`）

取餐联金额段顺序：`合计（商品）→ 打包费 → 自取优惠 → 优惠券 → 运费（外送）→ 实付`。`packingFee > 0` 才印「打包费：¥1.00」；厨房联不印。

### 3.7 统计

`stats/overview` 等实收口径用 `actualAmount`，自然含打包费；不单列，不改。

## 4. 小程序

### 4.1 结算页（同城外送 `pages/local/confirm`、自取 `pages/local/pickup`）

- 金额明细顺序：商品金额 → 打包费「¥2.00（2 份 × ¥1.00）」→ 自取优惠 / 运费 → 优惠券 → 积分赠品 → 应付。
- 打包费本地按购物车行的 `packingFeeEach × quantity`（排除赠品）预览，提交后以服务端返回为准；`meta.packing.enabled=false` 时整行不显示。
- 底部合计 = 服务端口径公式，`utils/local-checkout-state.js` / `pickup-checkout-state.js` 各加 `packingFee` 入参，单测覆盖。

### 4.2 订单详情 `pages/order/detail`

金额区在「商品金额」之后加「打包费」行（`order.packingFee > 0` 时显示）。

### 4.3 购物车 / 商品页

不显示打包费（避免每张卡都多一行小字）；结算页首次出现。

## 5. 后台

- **商品编辑页**（`pages/Products.tsx`）：「净重（克）」旁加「打包费（元）」输入，提示「留空 = 跟随全店默认 ¥X；填 0 = 这道菜不收」。列表不加列。
- **同城配送设置**（`pages/LocalSettings.tsx`）：加「打包费」卡片：开关（默认开）+ 默认每份金额（元）。保存走既有整包合并。
- **工作台抽屉 / 同城订单列表 / 邮寄订单页**：金额明细加「打包费」行（`packingFee > 0`）。
- `types.ts`：`Product.packingFeeFen`、`Order.packingFee`、`LocalDeliverySettings.packing`。

## 6. 测试

- 服务端 selftest：`packing-fee.ts` 纯函数 6 例（默认/覆盖 0/覆盖金额/赠品排除/开关关/邮寄 0）；`computeCheckout` 加 packingFee 例。
- e2e 新段 `§63 打包费`：设默认 ¥1 → 商品 A 覆盖 0、商品 B 跟随 → 下同城单与自取单核对 `packingFee`/`actualAmount`；邮寄单为 0；关开关后为 0；券门槛按小计判；全额退款金额含打包费；小票含「打包费：」。
- 小程序单测：两个 checkout-state 工具的合计公式各加 2 例。
- 后台 `npm test`/`build`。

## 7. 手工验收

1. 后台默认值 ¥1，商品 A 设 0，商品 B 留空；小程序同城外送下单 A×1 + B×2 → 结算页「打包费 ¥2.00（2 份 × ¥1.00）」，应付含它；自取同样。
2. 券门槛按商品小计（打包费不算）能用；自取折扣只打商品。
3. 订单详情、小票、工作台抽屉、后台订单页都有打包费行；邮寄单没有。
4. 关掉开关再下单打包费 0；已下的单不变。
5. 全额退款金额含打包费。

## 8. 影响面

服务端：`prisma/schema.prisma` + 迁移、`services/packing-fee.ts`（新）、`services/local-settings.ts`、`services/member/{pricing,checkout}.ts`、`routes/{orders,products,local}.ts`、`routes/admin/{products,settings,orders}.ts`、`services/ticket/content.ts`、`docs/api.md`。
小程序：`pages/local/{confirm,pickup}.*`、`pages/order/detail.*`、`utils/{local-checkout-state,pickup-checkout-state}.js`、`api/*.js`（透传字段）。
后台：`types.ts`、`api/admin.ts`、`pages/{Products,LocalSettings,Workbench,LocalOrders,Orders}.tsx`。

## 9. 明确不做

按重量/按容器种类计费、外送与自取分开定价（留字段位）、打包费参与门槛、顾客端购物车提前展示。
