# 同城配送 M1：渠道与数据基础 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有「全国邮寄」任何行为的前提下，把「渠道」做成一等维度：分类/商品/购物车按渠道隔离，地址与门店有 GCJ-02 坐标，同城设置（营业时段/范围/阶梯运费/暂停）可配置，同城订单可以按阶梯运费下单并进入现有支付流程，后台与商家端可以维护这些数据。

**Architecture:** 一次 Prisma 迁移落下 M1–M2b 全部表结构（`Category.channel`、`Product.channel/netWeightG`、`Address` 坐标、`Order` 同城快照列、`Delivery`、`DeliveryEvent`、`PrintJob`），本计划只使用其中 M1 需要的列，其余列由 M2/M2b 计划使用。`services/local-settings.ts` 是同城运营参数与所有纯计算（营业判定、Haversine、阶梯运费、报价签名）的唯一实现；`routes/local.ts` 对外下发 meta/quote；`routes/orders.ts` 的 `createOrder` 按 `deliveryType` 分派两套互不叠加的计费。渠道一致性由 `services/product-channel.ts` 的一个函数写入并由脚本校验。

**Tech Stack:** Node 25 / Express 4 / Prisma 5.22 (MySQL 8) / zod 4 / React 18 + Vite + Tailwind (admin) / 微信原生小程序。测试：`scripts/e2e.sh`（bash+curl+jq，后端 `PORT=3100 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true`）+ `apps/server/scripts/selftest-*.ts`（ts-node 纯函数自测）。

## Global Constraints

- 金额一律 **分**（Int）；坐标一律 **GCJ-02 微度 Int**（`latE6 = round(lat × 1e6)`），字段名 `latE6/lngE6`。
- 渠道枚举只有 `'EXPRESS' | 'LOCAL'`；所有读接口 `channel` 参数**默认 `EXPRESS`**，现有小程序请求不带参数时行为不变。
- `Order.deliveryType` 沿用现有列作为渠道判别；`createOrder` 的 LOCAL 分支**不得调用** `getShippingSettings/calcShippingFee`。
- 营业时段用 `Asia/Shanghai` 显式换算；首期**禁止跨零点**（`start < end`）、禁止重叠。
- 阶梯运费公式（服务端唯一实现）：`distanceM = round(haversine × detourFactor)`；`distanceM > radiusKm×1000 → 42220`；`subtotal < minOrderAmount → 42210`；`fee = baseFee + max(0, ceil(km − baseKm)) × perKmFee`；`freeThreshold > 0 && subtotal ≥ freeThreshold → 0`。
- `quoteToken`：TTL 5 分钟；下单实收 `fee = min(token.fee, 重算 fee)`，仅 `重算 fee > token.fee` 时 `42227`。
- 新错误码：`42220` 超出配送范围 · `42222` 非营业时间 · `42223` 地址缺少定位 · `42224` 商品渠道不符 · `42226` 同城暂未开通/暂停 · `42227` 配送费已更新 · `42229` 已超过可取消时间 · `42230` 超出单次配送上限 · `42231` 分类下有未支付订单不可改渠道。
- 共享邮寄端点 `POST /admin/orders/:id/accept|ship|complete` 命中 LOCAL 订单返回 `42204「同城订单请在同城看板操作」`。
- LOCAL 订单**不写 `Shipment` 行**。
- 所有 Order 状态流转沿用 `updateMany({ where: { id, status: '旧态' } })` 判 count 的范式。
- 提交信息用中文、`type(scope): 摘要` 格式，结尾附 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

## 文件结构（本计划涉及）

| 路径 | 职责 |
|---|---|
| `apps/server/prisma/schema.prisma` + `prisma/migrations/20260904000000_local_delivery/migration.sql` | 全部新表/新列（M1–M2b） |
| `apps/server/src/utils/channel.ts` | 渠道枚举、`channelOfDeliveryType()` |
| `apps/server/src/services/product-channel.ts` | 商品 `channel` 冗余的唯一写入点、分类改渠道级联 |
| `apps/server/src/services/local-settings.ts` | 同城设置读写缓存 + 营业/距离/运费/预计送达/报价签名纯函数 |
| `apps/server/scripts/selftest-local-settings.ts` | 上述纯函数自测 |
| `apps/server/src/routes/local.ts` | `GET /local/meta`、`POST /local/quote` |
| `apps/server/src/routes/admin/settings.ts` | `+ GET/PUT /admin/settings/local-delivery`、`PATCH .../store-location`、`POST/DELETE .../pause` |
| `apps/server/src/routes/{categories,products,cart,addresses,orders}.ts` | channel 参数/校验、坐标字段、LOCAL 下单分支、cancel-request |
| `apps/server/src/routes/admin/{categories,products,orders}.ts` | channel 读写与级联、netWeightG、EXPRESS 守卫、deliveryType 筛选、localPendingCount |
| `apps/server/src/services/order-notify.ts` | `+ notifyCancelRequest()` |
| `apps/server/src/config.ts`、`.env.example` | 无新增密钥（M1 不接快递100）；只补文档 |
| `apps/server/prisma/seed.ts` | 非生产追加 2 个 LOCAL 分类 + 2 个示例菜品 |
| `apps/admin/src/{types.ts,api/admin.ts}` | Channel 类型、新接口 |
| `apps/admin/src/pages/{Categories,Products,Orders,LocalSettings}.tsx`、`components/Layout.tsx`、`App.tsx` | 渠道 Tab、表单、设置页、导航 |
| `apps/miniapp/pages/merchant/index.{js,wxml}`、`apps/miniapp/app.json` | 商家端「用当前位置设为门店坐标」 |
| `scripts/e2e.sh`、`scripts/check-channel-consistency.mjs` | 回归与一致性校验 |
| `docs/api.md` | 新接口说明 |

---

### Task 1: Prisma 迁移（一次落库 M1–M2b 全部结构）

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/20260904000000_local_delivery/migration.sql`（由 Prisma 生成后改名/校对）

**Interfaces:**
- Produces: Prisma 模型 `Category.channel`、`Product.channel/netWeightG`、`Address.latE6/lngE6/poiName`、`Order.receiverLatE6/receiverLngE6/receiverPoiName/distanceM/estimatedDeliveryAt/cancelRequestedAt/cancelRequestNote/cancelRequestDeliveryStatus/announceCount/lastAnnouncedAt/deliveries`、`Delivery`、`DeliveryEvent`、`PrintJob`。

- [ ] **Step 1: 核对历史数据（迁移前置检查）**

Run（本机 docker MySQL）:
```bash
docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop -e "select delivery_type, count(*) c from orders group by 1;"
```
Expected: 只有 `EXPRESS` 一行（或空表）。若出现 `LOCAL`/`PICKUP`，先执行 `update orders set delivery_type='EXPRESS' where delivery_type<>'EXPRESS';` 并记录到提交信息。

- [ ] **Step 2: 修改 schema.prisma**

在 `model Category` 中 `status` 行之后加：
```prisma
  // 渠道：EXPRESS=全国邮寄 LOCAL=同城配送。一个分类只属于一个渠道，商品随分类归属
  channel   String    @default("EXPRESS") @db.VarChar(16)
```
并把 `@@index([status, sortOrder])` 改为两条：
```prisma
  @@index([status, sortOrder])
  @@index([channel, status, sortOrder])
```

在 `model Product` 中 `deliveryType` 行之后加：
```prisma
  // 渠道冗余自分类（只在 services/product-channel.ts 写入），列表按渠道过滤不必 join
  channel       String    @default("EXPRESS") @db.VarChar(16)
  // 净重（克），同城下单换算快递100 weight(kg)；空则用同城设置的默认值
  netWeightG    Int?      @map("net_weight_g")
```
把 `deliveryType` 上方注释改为 `// @deprecated 历史列，渠道以 channel 为准；后台不再写入`。并追加索引：
```prisma
  @@index([channel, status])
```

在 `model Address` 中 `isDefault` 行之前加：
```prisma
  // GCJ-02 微度坐标 + 地图选点 POI 名；EXPRESS 地址可为空，LOCAL 下单必填
  latE6         Int?      @map("lat_e6")
  lngE6         Int?      @map("lng_e6")
  poiName       String?   @map("poi_name") @db.VarChar(128)
```

在 `model Order` 中 `cancelReason` 行之后加：
```prisma
  // ── 同城配送快照（deliveryType=LOCAL 时写入）──
  receiverLatE6       Int?      @map("receiver_lat_e6")
  receiverLngE6       Int?      @map("receiver_lng_e6")
  receiverPoiName     String?   @map("receiver_poi_name") @db.VarChar(128)
  // 计费距离（米）= 直线 × detourFactor
  distanceM           Int?      @map("distance_m")
  estimatedDeliveryAt DateTime? @map("estimated_delivery_at")
  // 顾客在接单后宽限期内申请取消（D6 ②）；快照当时有效配送单状态，NONE=无单
  cancelRequestedAt   DateTime? @map("cancel_requested_at")
  cancelRequestNote   String?   @map("cancel_request_note") @db.VarChar(255)
  cancelRequestDeliveryStatus String? @map("cancel_request_delivery_status") @db.VarChar(16)
  // 未接单重复播报（M2b）
  announceCount       Int       @default(0) @map("announce_count")
  lastAnnouncedAt     DateTime? @map("last_announced_at")
```
并在 `afterSales AfterSale[]` 之后加 `  deliveries Delivery[]`。

在文件末尾追加三张新表：
```prisma
// ─────────────────────────────────────────────────────────
// 同城配送单（M2 使用）。同一订单可有多张（重呼/换运力），同一时刻只一张有效：
// activeOrderId 有效时 = orderId，终态置 NULL，与 Refund.activeOrderId 同款并发防线。
// ─────────────────────────────────────────────────────────
model Delivery {
  id                Int       @id @default(autoincrement())
  orderId           Int       @map("order_id")
  orderNo           String    @map("order_no") @db.VarChar(32)
  // 商户单号 D<orderId>-<seq>，传给运力方，回调回退查找键
  deliveryNo        String    @unique @map("delivery_no") @db.VarChar(32)
  // 普通 Int 列（非关系字段）：有效单 = orderId，终态 NULL
  activeOrderId     Int?      @unique @map("active_order_id")
  // KD100 | SELF | MOCK
  provider          String    @db.VarChar(16)
  // PENDING CALLING ACCEPTED ARRIVING ARRIVED DELIVERING REASSIGNING ABNORMAL DELIVERED CANCELLED FAILED UNKNOWN
  status            String    @db.VarChar(16)
  statusRank        Int       @default(0) @map("status_rank")
  providerStatus    Int?      @map("provider_status")
  statusDesc        String?   @map("status_desc") @db.VarChar(255)
  providerTaskId    String?   @unique @map("provider_task_id") @db.VarChar(64)
  providerOrderId   String?   @map("provider_order_id") @db.VarChar(64)
  courierCompany    String?   @map("courier_company") @db.VarChar(32)
  courierName       String?   @map("courier_name") @db.VarChar(64)
  courierMobile     String?   @map("courier_mobile") @db.VarChar(20)
  callbackSalt      String    @map("callback_salt") @db.VarChar(20)
  quotedFee         Int?      @map("quoted_fee")
  actualFee         Int?      @map("actual_fee")
  tipFee            Int       @default(0) @map("tip_fee")
  cancelFee         Int       @default(0) @map("cancel_fee")
  providerDistanceM Int?      @map("provider_distance_m")
  errorCode         String?   @map("error_code") @db.VarChar(16)
  failReason        String?   @map("fail_reason") @db.VarChar(255)
  calledAt          DateTime? @map("called_at")
  acceptedAt        DateTime? @map("accepted_at")
  pickedUpAt        DateTime? @map("picked_up_at")
  deliveredAt       DateTime? @map("delivered_at")
  cancelledAt       DateTime? @map("cancelled_at")
  cancelReason      String?   @map("cancel_reason") @db.VarChar(255)
  lastCallbackAt    DateTime? @map("last_callback_at")
  callTimeoutRemindedAt   DateTime? @map("call_timeout_reminded_at")
  acceptedStuckRemindedAt DateTime? @map("accepted_stuck_reminded_at")
  deliveringRemindedAt    DateTime? @map("delivering_reminded_at")
  operator          String?   @db.VarChar(64)
  createdAt         DateTime  @default(now()) @map("created_at")
  updatedAt         DateTime  @updatedAt @map("updated_at")

  order  Order           @relation(fields: [orderId], references: [id])
  events DeliveryEvent[]

  @@index([orderId])
  @@index([status, calledAt])
  @@map("deliveries")
}

// 配送单事件流水：回调幂等去重 + 时间线 + 对账
model DeliveryEvent {
  id                 Int      @id @default(autoincrement())
  deliveryId         Int      @map("delivery_id")
  // sha1(deliveryId|providerStatus|updateTime ?? sha1(rawBody))；ADMIN/SCHEDULER 事件用 uuid
  dedupeKey          String   @unique @map("dedupe_key") @db.VarChar(64)
  // CALLBACK | API | ADMIN | SCHEDULER
  source             String   @db.VarChar(16)
  providerStatus     Int?     @map("provider_status")
  statusDesc         String?  @map("status_desc") @db.VarChar(255)
  courierName        String?  @map("courier_name") @db.VarChar(64)
  courierMobile      String?  @map("courier_mobile") @db.VarChar(20)
  providerUpdateTime String?  @map("provider_update_time") @db.VarChar(32)
  operator           String?  @db.VarChar(64)
  latencyMs          Int?     @map("latency_ms")
  rawPayload         Json?    @map("raw_payload")
  createdAt          DateTime @default(now()) @map("created_at")

  delivery Delivery @relation(fields: [deliveryId], references: [id])

  @@index([deliveryId, createdAt])
  @@map("delivery_events")
}

// 云打印作业（M2b 使用）
model PrintJob {
  id            Int       @id @default(autoincrement())
  orderId       Int       @map("order_id")
  orderNo       String    @map("order_no") @db.VarChar(32)
  // NEW_ORDER | REPEAT | CANCEL | REPRINT | TEST
  kind          String    @db.VarChar(16)
  // FEIE | MOCK
  provider      String    @db.VarChar(16)
  printerSn     String    @map("printer_sn") @db.VarChar(32)
  // PENDING | SENT | PRINTED | FAILED | SKIPPED
  status        String    @db.VarChar(16)
  providerJobId String?   @map("provider_job_id") @db.VarChar(64)
  attempts      Int       @default(0)
  lastError     String?   @map("last_error") @db.VarChar(255)
  content       String    @db.Text
  dedupeKey     String    @unique @map("dedupe_key") @db.VarChar(64)
  sentAt        DateTime? @map("sent_at")
  printedAt     DateTime? @map("printed_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  @@index([status, createdAt])
  @@index([orderId])
  @@map("print_jobs")
}
```

- [ ] **Step 3: 校验并生成迁移**

Run:
```bash
cd apps/server && npx prisma validate && npx prisma migrate dev --name local_delivery --create-only
```
Expected: 生成 `prisma/migrations/2026XXXXXXXXXX_local_delivery/migration.sql`。将目录改名为 `20260904000000_local_delivery`（时间戳必须晚于 `20260903010000_add_settings`）。

- [ ] **Step 4: 校对 SQL 必含语句**

打开 `migration.sql`，确认包含（缺任何一条说明 schema 没改对）：
```sql
ALTER TABLE `categories` ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'EXPRESS';
ALTER TABLE `products` ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'EXPRESS', ADD COLUMN `net_weight_g` INTEGER NULL;
ALTER TABLE `addresses` ADD COLUMN `lat_e6` INTEGER NULL, ADD COLUMN `lng_e6` INTEGER NULL, ADD COLUMN `poi_name` VARCHAR(128) NULL;
ALTER TABLE `orders` ADD COLUMN `announce_count` INTEGER NOT NULL DEFAULT 0, ADD COLUMN `cancel_request_delivery_status` VARCHAR(16) NULL, ...
CREATE TABLE `deliveries` (
CREATE UNIQUE INDEX `deliveries_delivery_no_key` ON `deliveries`(`delivery_no`);
CREATE UNIQUE INDEX `deliveries_active_order_id_key` ON `deliveries`(`active_order_id`);
CREATE UNIQUE INDEX `deliveries_provider_task_id_key` ON `deliveries`(`provider_task_id`);
CREATE TABLE `delivery_events` (
CREATE UNIQUE INDEX `delivery_events_dedupe_key_key` ON `delivery_events`(`dedupe_key`);
CREATE TABLE `print_jobs` (
CREATE INDEX `categories_channel_status_sort_order_idx` ON `categories`(`channel`, `status`, `sort_order`);
CREATE INDEX `products_channel_status_idx` ON `products`(`channel`, `status`);
```

- [ ] **Step 5: 应用迁移并生成 client，类型检查**

Run:
```bash
cd apps/server && npx prisma migrate dev && npx prisma generate && npx tsc --noEmit
```
Expected: 迁移应用成功；`tsc` 零错误（新列全部可空或有默认值，现有代码不受影响）。

- [ ] **Step 6: 回归现有 e2e（确认零行为变化）**

Run（另一个终端已启动 `cd apps/server && PORT=3100 WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true npm run dev`）:
```bash
bash scripts/e2e.sh
```
Expected: 末行 `通过 N / 失败 0`。

- [ ] **Step 7: 提交**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260904000000_local_delivery
git commit -m "feat(db): 同城配送迁移——渠道/坐标/订单快照列 + deliveries/delivery_events/print_jobs 表

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 渠道工具 + 商品渠道冗余写入 + 后台分类/商品渠道接口

**Files:**
- Create: `apps/server/src/utils/channel.ts`
- Create: `apps/server/src/services/product-channel.ts`
- Modify: `apps/server/src/routes/admin/categories.ts`
- Modify: `apps/server/src/routes/admin/products.ts`
- Test: `scripts/e2e.sh`（新增「== 19. 渠道：分类/商品 ==」段）

**Interfaces:**
- Produces:
  - `utils/channel.ts`: `export const CHANNELS = ['EXPRESS','LOCAL'] as const; export type Channel = 'EXPRESS'|'LOCAL'; export const channelSchema = z.enum(CHANNELS); export function channelOfDeliveryType(deliveryType: string): Channel`
  - `services/product-channel.ts`: `export async function channelOfCategory(tx: Prisma.TransactionClient | typeof prisma, categoryId: number): Promise<Channel>`（分类不存在抛 40401）；`export async function changeCategoryChannel(categoryId: number, channel: Channel): Promise<{ productsUpdated: number; cartsDeleted: number }>`（抛 42231）
  - 后台接口：`GET /admin/categories?channel=`（不传=全部）返回含 `channel`；`POST/PUT /admin/categories` 接受 `channel`；`GET /admin/products?channel=`；`POST/PUT /admin/products` 接受 `netWeightG`，`channel` 由服务端按分类写入；`POST /admin/products/batch-status { status, categoryId?, channel? }`。

- [ ] **Step 1: 写 e2e 断言（先失败）**

在 `scripts/e2e.sh` 的 `echo "== 18. 顾客上传 =="` 段之后、`echo "== 11. 清理 =="` 之前插入：
```bash
echo "== 19. 渠道：分类/商品 =="
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E同城分类","channel":"LOCAL","sortOrder":99}')
LCAT=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$LCAT" ]] && ok "创建 LOCAL 分类 #$LCAT" || fail "创建 LOCAL 分类" "$R"
assert_eq "分类 channel=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"
R=$(req POST /api/admin/categories "$AT" '{"name":"E2E邮寄分类","sortOrder":98}')
ECAT=$(jq -r '.data.id // empty' <<<"$R"); assert_eq "默认 channel=EXPRESS" "$(jq -r .data.channel <<<"$R")" "EXPRESS"
R=$(req POST /api/admin/products "$AT" "{\"categoryId\":$LCAT,\"name\":\"E2E凉拌黄瓜\",\"price\":1200,\"stock\":50,\"netWeightG\":300}")
LPID=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$LPID" ]] && ok "创建同城商品 #$LPID" || fail "创建同城商品" "$R"
assert_eq "商品 channel 随分类=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"
assert_eq "netWeightG=300" "$(jq -r .data.netWeightG <<<"$R")" "300"
R=$(req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$ECAT}")
assert_eq "换分类后 channel 跟随=EXPRESS" "$(jq -r .data.channel <<<"$R")" "EXPRESS"
req PUT "/api/admin/products/$LPID" "$AT" "{\"categoryId\":$LCAT}" >/dev/null
R=$(req GET "/api/admin/products?channel=LOCAL&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "1" ]] && ok "admin 列表按 channel=LOCAL 过滤含该商品" || fail "admin 列表 channel 过滤" "$R"
R=$(req GET "/api/admin/products?channel=EXPRESS&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "0" ]] && ok "EXPRESS 列表不含同城商品" || fail "EXPRESS 列表泄漏同城商品"
R=$(req GET "/api/admin/categories?channel=LOCAL" "$AT")
[[ "$(jq -r "[.data[] | select(.id==$LCAT)] | length" <<<"$R")" == "1" ]] && ok "admin 分类按 channel 过滤" || fail "admin 分类 channel 过滤" "$R"
R=$(req PUT "/api/admin/categories/$LCAT" "$AT" '{"channel":"EXPRESS"}')
assert_eq "分类改渠道级联 code 0" "$(code "$R")" "0"
assert_eq "级联后商品 channel=EXPRESS" "$(req GET "/api/admin/products?keyword=E2E凉拌黄瓜" "$AT" | jq -r '.data.list[0].channel')" "EXPRESS"
req PUT "/api/admin/categories/$LCAT" "$AT" '{"channel":"LOCAL"}' >/dev/null
R=$(req POST /api/admin/products/batch-status "$AT" '{"status":"OFF_SHELF","channel":"LOCAL"}')
assert_eq "按渠道批量下架 code 0" "$(code "$R")" "0"
assert_eq "同城商品已下架" "$(req GET "/api/admin/products?keyword=E2E凉拌黄瓜" "$AT" | jq -r '.data.list[0].status')" "OFF_SHELF"
assert_eq "邮寄商品未受影响" "$(req GET "/api/products/$PID" "$UT" | jq -r .data.status)" "ON_SHELF"
req POST /api/admin/products/batch-status "$AT" '{"status":"ON_SHELF","channel":"LOCAL"}' >/dev/null
```
并在 `echo "== 11. 清理 =="` 段末尾追加：
```bash
[[ -n "${LPID:-}" ]] && req DELETE "/api/admin/products/$LPID" "$AT" >/dev/null
[[ -n "${LCAT:-}" ]] && req DELETE "/api/admin/categories/$LCAT" "$AT" >/dev/null
[[ -n "${ECAT:-}" ]] && req DELETE "/api/admin/categories/$ECAT" "$AT" >/dev/null
```
注意 `curl` 传中文 keyword：现有 `req` 直接拼 URL，需把 `keyword=E2E凉拌黄瓜` 改为 `keyword=E2E` 以避免编码问题（两处）。

- [ ] **Step 2: 运行 e2e 确认第 19 段失败**

Run: `bash scripts/e2e.sh 2>&1 | sed -n '/== 19/,/== 11/p'`
Expected: `分类 channel=LOCAL` 等断言 `✘`（返回体无 `channel`）。

- [ ] **Step 3: 新建 `utils/channel.ts`**

```ts
import { z } from 'zod'

/** 销售渠道：全国邮寄 / 同城配送。一个分类（及其商品）只属于一个渠道。 */
export const CHANNELS = ['EXPRESS', 'LOCAL'] as const
export type Channel = (typeof CHANNELS)[number]
export const channelSchema = z.enum(CHANNELS)

export const CHANNEL_LABEL: Record<Channel, string> = {
  EXPRESS: '全国邮寄',
  LOCAL: '同城配送',
}

/** 订单 deliveryType → 渠道（现有列语义复用：LOCAL 即同城，其余一律邮寄） */
export function channelOfDeliveryType(deliveryType: string): Channel {
  return deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}

/** 读接口的 channel 查询参数：缺省 EXPRESS（保证现有小程序零改动），非法值也按 EXPRESS */
export function parseChannelQuery(raw: unknown): Channel {
  return raw === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}
```

- [ ] **Step 4: 新建 `services/product-channel.ts`**

```ts
/**
 * 商品 channel 冗余的唯一写入点。
 *
 * Product.channel 冗余自 Category.channel，避免列表按渠道过滤时 join。
 * 冗余一旦漂移，同城菜单就会出现邮寄商品（或反之），所以：
 *  - 创建/改分类时都从这里取渠道，和 categoryId 同一事务；
 *  - 分类改渠道走 changeCategoryChannel 级联；
 *  - scripts/check-channel-consistency.mjs 定期校验。
 */
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { Channel, CHANNELS } from '../utils/channel'

type Db = Prisma.TransactionClient | typeof prisma

export async function channelOfCategory(db: Db, categoryId: number): Promise<Channel> {
  const cat = await db.category.findUnique({ where: { id: categoryId }, select: { channel: true } })
  if (!cat) throw new AppError(40401, '分类不存在', 404)
  return (CHANNELS as readonly string[]).includes(cat.channel) ? (cat.channel as Channel) : 'EXPRESS'
}

/**
 * 分类改渠道：同事务级联更新旗下商品 channel + 删除这些商品的购物车行。
 * 存在含该分类商品的待付款订单时拒绝（付款后会按旧渠道履约，状态机会错乱）。
 */
export async function changeCategoryChannel(
  categoryId: number,
  channel: Channel
): Promise<{ productsUpdated: number; cartsDeleted: number }> {
  return prisma.$transaction(async (tx) => {
    const cat = await tx.category.findUnique({ where: { id: categoryId } })
    if (!cat) throw new AppError(40401, '分类不存在', 404)
    if (cat.channel === channel) return { productsUpdated: 0, cartsDeleted: 0 }

    const products = await tx.product.findMany({
      where: { categoryId, deletedAt: null },
      select: { id: true },
    })
    const productIds = products.map((p) => p.id)

    if (productIds.length > 0) {
      const unpaid = await tx.order.count({
        where: { status: 'PENDING_PAYMENT', items: { some: { productId: { in: productIds } } } },
      })
      if (unpaid > 0) {
        throw new AppError(42231, `该分类下有 ${unpaid} 笔待付款订单，请等其支付或超时取消后再改渠道`)
      }
    }

    await tx.category.update({ where: { id: categoryId }, data: { channel } })
    const updated = productIds.length
      ? await tx.product.updateMany({ where: { id: { in: productIds } }, data: { channel } })
      : { count: 0 }
    const carts = productIds.length
      ? await tx.cart.deleteMany({ where: { productId: { in: productIds } } })
      : { count: 0 }
    return { productsUpdated: updated.count, cartsDeleted: carts.count }
  })
}
```

- [ ] **Step 5: 改 `routes/admin/categories.ts`**

顶部 import 增加：
```ts
import { channelSchema, parseChannelQuery } from '../../utils/channel'
import { changeCategoryChannel } from '../../services/product-channel'
```
`categorySchema` 加一行：
```ts
  channel: channelSchema.default('EXPRESS'),
```
`GET /` 改为支持可选过滤（不传 = 全部，后台需要看两个渠道）：
```ts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = req.query.channel ? parseChannelQuery(req.query.channel) : undefined
    const categories = await prisma.category.findMany({
      where: channel ? { channel } : {},
      orderBy: [{ channel: 'asc' }, { sortOrder: 'asc' }],
      include: { _count: { select: { products: { where: { deletedAt: null } } } } },
    })
    success(res, categories)
  } catch (e) {
    next(e)
  }
})
```
`PUT /:id` 改为：渠道变更走级联服务，其余字段照旧：
```ts
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const exists = await prisma.category.findUnique({ where: { id } })
    if (!exists) throw new AppError(40401, '分类不存在', 404)

    const { channel, ...data } = categorySchema.partial().parse(req.body)
    if (channel && channel !== exists.channel) {
      await changeCategoryChannel(id, channel)
    }
    const category = await prisma.category.update({ where: { id }, data })
    success(res, category)
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 6: 改 `routes/admin/products.ts`**

import 增加：
```ts
import { parseChannelQuery } from '../../utils/channel'
import { channelOfCategory } from '../../services/product-channel'
```
`productSchema`：把 `deliveryType: z.string().max(64).default('EXPRESS'),` 改为
```ts
  // @deprecated 兼容旧后台仍可能传入；服务端忽略，渠道以分类为准
  deliveryType: z.string().max(64).optional(),
  netWeightG: z.number().int().min(1).max(50_000).nullable().optional(),
```
`GET /` 的 `where` 加 channel 过滤（不传 = 全部）：
```ts
    const channel = req.query.channel ? parseChannelQuery(req.query.channel) : undefined
    const where = {
      deletedAt: null,
      ...(channel ? { channel } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(status ? { status } : {}),
      ...(keyword ? { name: { contains: keyword } } : {}),
    }
```
`POST /`：`const { imageUrls, specDimensions, skus, ...data } = productSchema.parse(req.body)` 之后，把原来的 `const cat = ...; if (!cat) throw ...` 两行替换为：
```ts
    const { deliveryType: _ignored, ...rest } = data
    const channel = await channelOfCategory(prisma, rest.categoryId)
```
并把 `prisma.product.create({ data: { ...data, ` 改为 `prisma.product.create({ data: { ...rest, channel, `。

`PUT /:id`：`const { imageUrls, specDimensions, skus, ...data } = productSchema.partial().parse(req.body)` 之后加：
```ts
    const { deliveryType: _ignored, ...rest } = data
    // 换分类时渠道跟随分类（同事务内取，防止读到并发改渠道前的旧值）
```
事务内 `return tx.product.update({ where: { id }, data: { ...data, ...specData }, ...` 改为：
```ts
      const channelPatch =
        rest.categoryId !== undefined ? { channel: await channelOfCategory(tx, rest.categoryId) } : {}
      return tx.product.update({
        where: { id },
        data: { ...rest, ...channelPatch, ...specData },
        include: skuInclude,
      })
```
`batchStatusSchema` 加 `channel: channelSchema.optional()`（import `channelSchema`），`updateMany` 的 where 改为：
```ts
      where: { deletedAt: null, ...(channel ? { channel } : {}), ...(categoryId ? { categoryId } : {}) },
```

- [ ] **Step 7: 类型检查 + e2e**

Run: `cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh`
Expected: 零类型错误；第 19 段全部 `✔`；总失败 0。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/utils/channel.ts apps/server/src/services/product-channel.ts apps/server/src/routes/admin/categories.ts apps/server/src/routes/admin/products.ts scripts/e2e.sh
git commit -m "feat(server): 分类/商品渠道字段——商品 channel 随分类写入、分类改渠道级联、按渠道批量上下架

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: 公开接口与购物车按渠道过滤/校验

**Files:**
- Modify: `apps/server/src/routes/categories.ts`
- Modify: `apps/server/src/routes/products.ts`
- Modify: `apps/server/src/routes/cart.ts`
- Test: `scripts/e2e.sh`（新增「== 20. 渠道：公开接口/购物车 ==」）

**Interfaces:**
- Produces: `GET /categories?channel=`、`GET /products?channel=`（默认 EXPRESS，返回体含 `channel`）、`GET /products/:id` 含 `channel`；`GET /cart?channel=`（默认 EXPRESS，只返回该渠道行，`totalAmount/selectedCount` 按该渠道算，返回体多 `channel`）；`POST /cart` 返回 `{ id, channel }`。

- [ ] **Step 1: e2e 断言（先失败）**

在第 19 段之后插入：
```bash
echo "== 20. 渠道：公开接口/购物车 =="
R=$(req GET "/api/categories" "$UT"); [[ "$(jq -r "[.[]? // .data[] | select(.id==$LCAT)] | length" <<<"$R")" == "0" ]] && ok "公开分类默认不含 LOCAL" || fail "公开分类泄漏 LOCAL" "$R"
R=$(req GET "/api/categories?channel=LOCAL" "$UT"); [[ "$(jq -r "[.data[] | select(.id==$LCAT)] | length" <<<"$R")" == "1" ]] && ok "公开分类 channel=LOCAL 含同城分类" || fail "公开分类 LOCAL 过滤" "$R"
R=$(req GET "/api/products?pageSize=50" "$UT"); [[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "0" ]] && ok "公开商品默认不含同城商品" || fail "公开商品泄漏同城商品"
R=$(req GET "/api/products?channel=LOCAL&pageSize=50" "$UT"); [[ "$(jq -r "[.data.list[] | select(.id==$LPID)] | length" <<<"$R")" == "1" ]] && ok "公开商品 channel=LOCAL 含同城商品" || fail "公开商品 LOCAL 过滤" "$R"
assert_eq "商品详情返回 channel" "$(req GET "/api/products/$LPID" "$UT" | jq -r .data.channel)" "LOCAL"
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); LCID=$(jq -r '.data.id // empty' <<<"$R")
[[ -n "$LCID" ]] && ok "同城商品加购 #$LCID" || fail "同城加购" "$R"
assert_eq "加购返回 channel=LOCAL" "$(jq -r .data.channel <<<"$R")" "LOCAL"
R=$(req GET /api/cart "$UT"); [[ "$(jq -r "[.data.items[] | select(.id==$LCID)] | length" <<<"$R")" == "0" ]] && ok "默认购物车不含同城行" || fail "默认购物车混入同城行" "$R"
R=$(req GET "/api/cart?channel=LOCAL" "$UT"); [[ "$(jq -r "[.data.items[] | select(.id==$LCID)] | length" <<<"$R")" == "1" ]] && ok "同城购物车含该行" || fail "同城购物车" "$R"
assert_eq "同城购物车小计=2400" "$(jq -r .data.totalAmount <<<"$R")" "2400"
```
清理段追加：`[[ -n "${LCID:-}" ]] && req DELETE "/api/cart/$LCID" "$UT" >/dev/null`。

- [ ] **Step 2: 运行确认失败**

Run: `bash scripts/e2e.sh 2>&1 | sed -n '/== 20/,/== 11/p'` → Expected: 多条 `✘`。

- [ ] **Step 3: 改 `routes/categories.ts`**

```ts
import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { parseChannelQuery } from '../utils/channel'

const router = Router()

// GET /api/categories?channel=EXPRESS|LOCAL（缺省 EXPRESS：现有分类页/首页零改动）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = parseChannelQuery(req.query.channel)
    const categories = await prisma.category.findMany({
      where: { status: 1, channel },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true, iconUrl: true, sortOrder: true, channel: true },
    })
    success(res, categories)
  } catch (e) {
    next(e)
  }
})

export default router
```

- [ ] **Step 4: 改 `routes/products.ts`**

import 加 `import { parseChannelQuery } from '../utils/channel'`；列表 `where` 改为：
```ts
    const channel = parseChannelQuery(req.query.channel)
    const where = {
      status: 'ON_SHELF' as const,
      deletedAt: null,
      channel,
      ...(categoryId ? { categoryId } : {}),
      ...(keyword ? { name: { contains: keyword } } : {}),
    }
```
`select` 中加 `channel: true,`。详情接口 `findFirst` 默认返回全字段，已含 `channel`，无需改。

- [ ] **Step 5: 改 `routes/cart.ts`**

import 加 `import { parseChannelQuery } from '../utils/channel'`。`GET /`：
```ts
    const channel = parseChannelQuery(req.query.channel)
    const items = await prisma.cart.findMany({
      where: { userId, product: { channel } },
      include: {
        product: { select: { id: true, name: true, coverImage: true, price: true, stock: true, status: true, unit: true, channel: true } },
        sku: { select: { id: true, specText: true, price: true, stock: true } },
      },
      orderBy: { createdAt: 'desc' },
    })
```
返回体改为 `success(res, { channel, items: cartItems, totalAmount, selectedCount: selectedItems.length })`。
`POST /`：`findFirst` 的 `include` 里 product 已是完整对象，末尾 `success(res, { id: cart.id })` 改为 `success(res, { id: cart.id, channel: product.channel })`。

- [ ] **Step 6: 类型检查 + e2e**

Run: `cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh` → Expected: 第 20 段全 `✔`，总失败 0。同时确认第 5/6 段（现有邮寄下单）仍通过——证明默认值兼容。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/routes/categories.ts apps/server/src/routes/products.ts apps/server/src/routes/cart.ts scripts/e2e.sh
git commit -m "feat(server): 公开分类/商品/购物车按渠道过滤，缺省 EXPRESS 保证现网零改动

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `services/local-settings.ts` 纯函数与设置读写 + 自测脚本

**Files:**
- Create: `apps/server/src/services/local-settings.ts`
- Create: `apps/server/scripts/selftest-local-settings.ts`

**Interfaces:**
- Produces（后续任务全部依赖这些签名）:
  ```ts
  export interface BusinessHour { start: string; end: string }            // 'HH:mm'
  export interface LocalDeliverySettings { version: number; enabled: boolean; paused: { until: string | null; reason: string } | null; store: { name: string; phone: string; province: string; city: string; district: string; address: string; latE6: number | null; lngE6: number | null }; radiusKm: number; detourFactor: number; fee: { baseFee: number; baseKm: number; perKmFee: number; freeThreshold: number; minOrderAmount: number }; businessHours: BusinessHour[]; prepMinutes: number; riderSpeedKmh: number; acceptGraceMin: number; autoCallDelayMin: number; defaultProvider: 'KD100' | 'SELF'; kd100: { providers: string[]; goodsType: string; defaultItemWeightG: number; insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean }; limits: { maxItems: number; maxWeightKg: number }; callTimeoutMin: number; acceptedStuckMin: number; deliveringTimeoutMin: number; tip: { maxPerCall: number; maxPerOrder: number } }
  export const DEFAULT_LOCAL_SETTINGS: LocalDeliverySettings
  export function sanitizeLocalSettings(raw: unknown): LocalDeliverySettings
  export function validateLocalSettings(s: LocalDeliverySettings): string[]          // 保存校验（时段/联动）
  export function validateForEnable(s: LocalDeliverySettings): string[]             // 开启前完整性
  export async function getLocalSettings(): Promise<LocalDeliverySettings>           // 60s 缓存
  export async function setLocalSettings(next: LocalDeliverySettings): Promise<LocalDeliverySettings>   // version+1
  export async function patchLocalSettings(patch: Partial<LocalDeliverySettings>): Promise<LocalDeliverySettings>
  export function clearLocalSettingsCache(): void
  export function shanghaiMinutes(now?: Date): number                                // 0..1439
  export function isPaused(s, now?: Date): boolean
  export function isOpenNow(s, now?: Date): boolean                                  // enabled && !paused && 在时段内
  export function nextOpenText(s, now?: Date): string
  export function haversineM(aLatE6, aLngE6, bLatE6, bLngE6): number
  export function billableDistanceM(s, latE6, lngE6): number | null                  // 门店无坐标 → null
  export function calcLocalFee(s, distanceM, subtotal): { fee: number; inRange: boolean; belowMin: boolean }
  export function estimateMinutes(s, distanceM): number
  export function signQuote(p: { fee; distanceM; addressId; version }, now?: Date): string
  export function verifyQuote(token: string, now?: Date): { fee; distanceM; addressId; version } | null
  export function publicLocalMeta(s, now?: Date): object                             // /local/meta 用
  ```

- [ ] **Step 1: 写自测脚本（先失败）**

`apps/server/scripts/selftest-local-settings.ts`:
```ts
/**
 * 同城设置纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts
 */
import assert from 'assert'
import {
  DEFAULT_LOCAL_SETTINGS,
  sanitizeLocalSettings,
  validateLocalSettings,
  validateForEnable,
  shanghaiMinutes,
  isOpenNow,
  nextOpenText,
  haversineM,
  billableDistanceM,
  calcLocalFee,
  estimateMinutes,
  signQuote,
  verifyQuote,
} from '../src/services/local-settings'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

// 2026-09-03 12:00 Asia/Shanghai == 04:00Z
const NOON = new Date('2026-09-03T04:00:00Z')
const NIGHT = new Date('2026-09-03T15:30:00Z') // 23:30 上海
const STORE = { latE6: 29339000, lngE6: 104778000 } // 自贡汇东附近

const base = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  enabled: true,
  store: { ...DEFAULT_LOCAL_SETTINGS.store, ...STORE },
  radiusKm: 5,
  detourFactor: 1.35,
  fee: { baseFee: 300, baseKm: 3, perKmFee: 100, freeThreshold: 8000, minOrderAmount: 2000 },
  businessHours: [{ start: '09:00', end: '20:00' }],
})

t('sanitize 填默认值且丢弃非法', () => {
  const s = sanitizeLocalSettings({ radiusKm: 'abc', fee: { baseFee: -1 } })
  assert.strictEqual(s.radiusKm, DEFAULT_LOCAL_SETTINGS.radiusKm)
  assert.strictEqual(s.fee.baseFee, DEFAULT_LOCAL_SETTINGS.fee.baseFee)
  assert.strictEqual(s.enabled, false)
})
t('shanghaiMinutes 12:00 → 720', () => assert.strictEqual(shanghaiMinutes(NOON), 720))
t('营业时段内 isOpenNow=true', () => assert.strictEqual(isOpenNow(base, NOON), true))
t('时段外 isOpenNow=false，nextOpenText=明天', () => {
  assert.strictEqual(isOpenNow(base, NIGHT), false)
  assert.strictEqual(nextOpenText(base, NIGHT), '明天 09:00 营业')
})
t('早于开门 nextOpenText=今天', () => {
  const early = new Date('2026-09-02T23:00:00Z') // 07:00 上海
  assert.strictEqual(nextOpenText(base, early), '今天 09:00 营业')
})
t('paused 生效与过期', () => {
  const p1 = { ...base, paused: { until: null, reason: '暴雨' } }
  assert.strictEqual(isOpenNow(p1, NOON), false)
  const p2 = { ...base, paused: { until: '2026-09-03T03:00:00.000Z', reason: '' } } // 已过
  assert.strictEqual(isOpenNow(p2, NOON), true)
})
t('enabled=false 永不营业', () => assert.strictEqual(isOpenNow({ ...base, enabled: false }, NOON), false))
t('校验：跨零点/重叠/顺序被拒', () => {
  assert.ok(validateLocalSettings({ ...base, businessHours: [{ start: '18:00', end: '01:00' }] }).length > 0)
  assert.ok(validateLocalSettings({ ...base, businessHours: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '14:00' }] }).length > 0)
  assert.strictEqual(validateLocalSettings(base).length, 0)
})
t('校验：autoCallDelayMin 必须 0 或 ∈ [acceptGraceMin,15]', () => {
  assert.ok(validateLocalSettings({ ...base, acceptGraceMin: 5, autoCallDelayMin: 3 }).length > 0)
  assert.strictEqual(validateLocalSettings({ ...base, acceptGraceMin: 5, autoCallDelayMin: 5 }).length, 0)
  assert.ok(validateLocalSettings({ ...base, autoCallDelayMin: 16 }).length > 0)
})
t('开启前完整性：缺坐标/时段被拒', () => {
  assert.ok(validateForEnable({ ...base, store: { ...base.store, latE6: null } }).length > 0)
  assert.ok(validateForEnable({ ...base, businessHours: [] }).length > 0)
  assert.strictEqual(validateForEnable(base).length, 0)
})
t('haversine：同点 0，1° 纬度 ≈ 111.19km', () => {
  assert.strictEqual(haversineM(29000000, 104000000, 29000000, 104000000), 0)
  const d = haversineM(29000000, 104000000, 30000000, 104000000)
  assert.ok(Math.abs(d - 111195) < 200, `got ${d}`)
})
t('billableDistanceM = 直线 × detourFactor；门店无坐标 → null', () => {
  const straight = haversineM(STORE.latE6, STORE.lngE6, 29350000, 104790000)
  assert.strictEqual(billableDistanceM(base, 29350000, 104790000), Math.round(straight * 1.35))
  assert.strictEqual(billableDistanceM({ ...base, store: { ...base.store, latE6: null } }, 1, 1), null)
})
t('阶梯运费：2km→基础费；4.2km→基础+2km 加价；满额免；超范围；不满起送', () => {
  assert.deepStrictEqual(calcLocalFee(base, 2000, 3000), { fee: 300, inRange: true, belowMin: false })
  assert.deepStrictEqual(calcLocalFee(base, 4200, 3000), { fee: 500, inRange: true, belowMin: false })
  assert.deepStrictEqual(calcLocalFee(base, 4200, 8000), { fee: 0, inRange: true, belowMin: false })
  assert.strictEqual(calcLocalFee(base, 5001, 3000).inRange, false)
  assert.strictEqual(calcLocalFee(base, 1000, 1999).belowMin, true)
})
t('estimateMinutes = prep + 距离/速度', () => {
  // prep 15, 15km/h → 3.75km = 15 分钟 → 30
  assert.strictEqual(estimateMinutes({ ...base, prepMinutes: 15, riderSpeedKmh: 15 }, 3750), 30)
})
t('quoteToken 往返、篡改失败、过期失败', () => {
  const tok = signQuote({ fee: 500, distanceM: 4200, addressId: 7, version: 3 }, NOON)
  assert.deepStrictEqual(verifyQuote(tok, NOON), { fee: 500, distanceM: 4200, addressId: 7, version: 3 })
  assert.strictEqual(verifyQuote(tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a'), NOON), null)
  assert.strictEqual(verifyQuote(tok, new Date(NOON.getTime() + 6 * 60 * 1000)), null)
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
```

- [ ] **Step 2: 运行确认失败（模块不存在）**

Run: `cd apps/server && JWT_SECRET=selftest-secret-0123456789 ADMIN_JWT_SECRET=selftest-secret-0123456789 npx ts-node --transpile-only scripts/selftest-local-settings.ts`
Expected: `Cannot find module '../src/services/local-settings'`。

- [ ] **Step 3: 新建 `services/local-settings.ts`**

```ts
/**
 * 同城配送运营参数（settings 表 key=local_delivery）+ 全部纯计算。
 *
 * 这里是运费/范围/营业判定的唯一实现：小程序只展示 /local/quote 的结果，不再本地复刻算法
 * （邮寄运费两端各写一遍的教训见 pages/order/confirm.js 注释）。
 * 缓存策略与 services/settings.ts 一致：60 秒进程内缓存，保存即失效。
 */
import crypto from 'crypto'
import prisma from '../utils/prisma'
import { config } from '../config'

export const LOCAL_SETTINGS_KEY = 'local_delivery'
const CACHE_TTL_MS = 60 * 1000
const QUOTE_TTL_MS = 5 * 60 * 1000

export interface BusinessHour { start: string; end: string }

export interface LocalDeliverySettings {
  version: number
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  store: {
    name: string; phone: string
    province: string; city: string; district: string; address: string
    latE6: number | null; lngE6: number | null
  }
  radiusKm: number
  detourFactor: number
  fee: { baseFee: number; baseKm: number; perKmFee: number; freeThreshold: number; minOrderAmount: number }
  businessHours: BusinessHour[]
  prepMinutes: number
  riderSpeedKmh: number
  acceptGraceMin: number
  autoCallDelayMin: number
  defaultProvider: 'KD100' | 'SELF'
  kd100: {
    providers: string[]; goodsType: string; defaultItemWeightG: number
    insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean
  }
  limits: { maxItems: number; maxWeightKg: number }
  callTimeoutMin: number
  acceptedStuckMin: number
  deliveringTimeoutMin: number
  tip: { maxPerCall: number; maxPerOrder: number }
}

export const KD100_PROVIDERS = [
  'shunfengtongcheng', 'fengniaotongcheng', 'meituantongcheng', 'shansongtongcheng',
  'dadatongcheng', 'uupaotui', 'gxdtongcheng',
] as const

export const DEFAULT_LOCAL_SETTINGS: LocalDeliverySettings = {
  version: 0,
  enabled: false,
  paused: null,
  store: {
    name: '阿福凉菜', phone: '15309003232',
    province: '四川省', city: '自贡市', district: '高新区', address: '汇东新区丹桂40栋底楼',
    latE6: null, lngE6: null,
  },
  radiusKm: 5,
  detourFactor: 1.35,
  fee: { baseFee: 300, baseKm: 3, perKmFee: 100, freeThreshold: 0, minOrderAmount: 0 },
  businessHours: [{ start: '09:00', end: '20:00' }],
  prepMinutes: 15,
  riderSpeedKmh: 15,
  acceptGraceMin: 5,
  autoCallDelayMin: 0,
  defaultProvider: 'SELF',
  kd100: {
    providers: [...KD100_PROVIDERS], goodsType: '食品', defaultItemWeightG: 300,
    insurance: false, autoDowngradeToSelfOnNoBalance: false,
  },
  limits: { maxItems: 30, maxWeightKg: 10 },
  callTimeoutMin: 10,
  acceptedStuckMin: 30,
  deliveringTimeoutMin: 120,
  tip: { maxPerCall: 2000, maxPerOrder: 5000 },
}

// ── sanitize ────────────────────────────────────────────────
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const asObj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const int = (v: unknown, fb: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : fb
}
const num = (v: unknown, fb: number, min = 0, max = 1e9) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : fb
}
const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
const str = (v: unknown, fb: string, max = 128) => (typeof v === 'string' ? v.trim().slice(0, max) : fb)
const intOrNull = (v: unknown, min: number, max: number) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

export function sanitizeLocalSettings(raw: unknown): LocalDeliverySettings {
  const o = asObj(raw)
  const D = DEFAULT_LOCAL_SETTINGS
  const store = asObj(o.store), fee = asObj(o.fee), kd = asObj(o.kd100), lim = asObj(o.limits), tip = asObj(o.tip)
  const paused = o.paused && typeof o.paused === 'object'
    ? { until: str(asObj(o.paused).until, '', 40) || null, reason: str(asObj(o.paused).reason, '', 60) }
    : null
  const hours = Array.isArray(o.businessHours)
    ? o.businessHours
        .map((h) => ({ start: str(asObj(h).start, '', 5), end: str(asObj(h).end, '', 5) }))
        .filter((h) => HHMM.test(h.start) && HHMM.test(h.end))
    : D.businessHours
  const providers = Array.isArray(kd.providers)
    ? kd.providers.filter((p): p is string => typeof p === 'string' && (KD100_PROVIDERS as readonly string[]).includes(p))
    : D.kd100.providers
  return {
    version: int(o.version, 0),
    enabled: bool(o.enabled, false),
    paused,
    store: {
      name: str(store.name, D.store.name, 64), phone: str(store.phone, D.store.phone, 20),
      province: str(store.province, D.store.province, 32), city: str(store.city, D.store.city, 32),
      district: str(store.district, D.store.district, 32), address: str(store.address, D.store.address, 255),
      latE6: intOrNull(store.latE6, -90_000_000, 90_000_000), lngE6: intOrNull(store.lngE6, -180_000_000, 180_000_000),
    },
    radiusKm: num(o.radiusKm, D.radiusKm, 0.5, 50),
    detourFactor: num(o.detourFactor, D.detourFactor, 1, 3),
    fee: {
      baseFee: int(fee.baseFee, D.fee.baseFee, 0, 100_000), baseKm: num(fee.baseKm, D.fee.baseKm, 0, 50),
      perKmFee: int(fee.perKmFee, D.fee.perKmFee, 0, 100_000),
      freeThreshold: int(fee.freeThreshold, D.fee.freeThreshold, 0, 10_000_000),
      minOrderAmount: int(fee.minOrderAmount, D.fee.minOrderAmount, 0, 10_000_000),
    },
    businessHours: hours,
    prepMinutes: int(o.prepMinutes, D.prepMinutes, 0, 180),
    riderSpeedKmh: num(o.riderSpeedKmh, D.riderSpeedKmh, 5, 60),
    acceptGraceMin: int(o.acceptGraceMin, D.acceptGraceMin, 0, 30),
    autoCallDelayMin: int(o.autoCallDelayMin, D.autoCallDelayMin, 0, 60),
    defaultProvider: o.defaultProvider === 'KD100' ? 'KD100' : 'SELF',
    kd100: {
      providers, goodsType: str(kd.goodsType, D.kd100.goodsType, 16),
      defaultItemWeightG: int(kd.defaultItemWeightG, D.kd100.defaultItemWeightG, 50, 20_000),
      insurance: bool(kd.insurance, false), autoDowngradeToSelfOnNoBalance: bool(kd.autoDowngradeToSelfOnNoBalance, false),
    },
    limits: { maxItems: int(lim.maxItems, D.limits.maxItems, 1, 500), maxWeightKg: num(lim.maxWeightKg, D.limits.maxWeightKg, 0.5, 100) },
    callTimeoutMin: int(o.callTimeoutMin, D.callTimeoutMin, 1, 120),
    acceptedStuckMin: int(o.acceptedStuckMin, D.acceptedStuckMin, 1, 240),
    deliveringTimeoutMin: int(o.deliveringTimeoutMin, D.deliveringTimeoutMin, 10, 600),
    tip: { maxPerCall: int(tip.maxPerCall, D.tip.maxPerCall, 0, 100_000), maxPerOrder: int(tip.maxPerOrder, D.tip.maxPerOrder, 0, 500_000) },
  }
}

// ── 校验 ────────────────────────────────────────────────────
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

/** 保存时校验（结构合法但业务上不允许的组合） */
export function validateLocalSettings(s: LocalDeliverySettings): string[] {
  const errs: string[] = []
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  for (const h of sorted) {
    if (toMin(h.start) >= toMin(h.end)) errs.push(`营业时段 ${h.start}-${h.end}：结束须晚于开始（首期不支持跨零点）`)
  }
  for (let i = 1; i < sorted.length; i++) {
    if (toMin(sorted[i].start) < toMin(sorted[i - 1].end)) errs.push(`营业时段 ${sorted[i - 1].start}-${sorted[i - 1].end} 与 ${sorted[i].start}-${sorted[i].end} 重叠`)
  }
  if (s.autoCallDelayMin !== 0 && (s.autoCallDelayMin < s.acceptGraceMin || s.autoCallDelayMin > 15)) {
    errs.push(`自动呼叫延迟须为 0（手动）或介于顾客可取消窗口 ${s.acceptGraceMin} 分钟与 15 分钟之间`)
  }
  if (s.tip.maxPerCall > s.tip.maxPerOrder) errs.push('单次小费上限不能大于单笔订单累计上限')
  return errs
}

/** 开启总开关前的完整性校验 */
export function validateForEnable(s: LocalDeliverySettings): string[] {
  const errs = validateLocalSettings(s)
  if (s.store.latE6 === null || s.store.lngE6 === null) errs.push('请先设置门店坐标（推荐在小程序商家端一键定位）')
  if (!s.store.phone) errs.push('请填写门店电话')
  if (!s.store.address) errs.push('请填写门店地址')
  if (s.businessHours.length === 0) errs.push('至少设置一个营业时段')
  if (s.radiusKm <= 0) errs.push('配送半径须大于 0')
  return errs
}

// ── 读写 + 缓存 ─────────────────────────────────────────────
let cached: { value: LocalDeliverySettings; at: number } | null = null

export async function getLocalSettings(): Promise<LocalDeliverySettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value = DEFAULT_LOCAL_SETTINGS
  try {
    const row = await prisma.setting.findUnique({ where: { key: LOCAL_SETTINGS_KEY } })
    if (row) value = sanitizeLocalSettings(JSON.parse(row.value))
  } catch (e) {
    // 读不到配置 = 默认值（enabled=false），同城入口关闭而不是放行错误运费
    console.warn('[local-settings] 读取失败，回退默认值:', (e as Error).message)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setLocalSettings(next: LocalDeliverySettings): Promise<LocalDeliverySettings> {
  const current = await getLocalSettings()
  const value = sanitizeLocalSettings({ ...next, version: current.version + 1 })
  const json = JSON.stringify(value)
  await prisma.setting.upsert({
    where: { key: LOCAL_SETTINGS_KEY },
    create: { key: LOCAL_SETTINGS_KEY, value: json },
    update: { value: json },
  })
  cached = { value, at: Date.now() }
  return value
}

export async function patchLocalSettings(patch: Partial<LocalDeliverySettings>): Promise<LocalDeliverySettings> {
  const current = await getLocalSettings()
  return setLocalSettings({ ...current, ...patch, store: { ...current.store, ...(patch.store ?? {}) } })
}

export function clearLocalSettingsCache(): void {
  cached = null
}

// ── 营业判定（Asia/Shanghai，不依赖进程时区）────────────────
const SH_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })

export function shanghaiMinutes(now: Date = new Date()): number {
  const parts = SH_FMT.formatToParts(now)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return h * 60 + m
}

export function isPaused(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  if (!s.paused) return false
  if (!s.paused.until) return true
  const until = Date.parse(s.paused.until)
  return Number.isFinite(until) ? until > now.getTime() : true
}

function inHours(s: LocalDeliverySettings, now: Date): boolean {
  const cur = shanghaiMinutes(now)
  return s.businessHours.some((h) => cur >= toMin(h.start) && cur < toMin(h.end))
}

export function isOpenNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return s.enabled && !isPaused(s, now) && inHours(s, now)
}

export function nextOpenText(s: LocalDeliverySettings, now: Date = new Date()): string {
  if (s.businessHours.length === 0) return '暂未设置营业时间'
  const cur = shanghaiMinutes(now)
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  const today = sorted.find((h) => toMin(h.start) > cur)
  return today ? `今天 ${today.start} 营业` : `明天 ${sorted[0].start} 营业`
}

// ── 距离与运费 ───────────────────────────────────────────────
const R_EARTH_M = 6371008.8
export function haversineM(aLatE6: number, aLngE6: number, bLatE6: number, bLngE6: number): number {
  const toRad = (e6: number) => (e6 / 1e6) * (Math.PI / 180)
  const dLat = toRad(bLatE6 - aLatE6), dLng = toRad(bLngE6 - aLngE6)
  const la1 = toRad(aLatE6), la2 = toRad(bLatE6)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h))))
}

/** 计费距离 = 直线 × 绕路系数；门店未设坐标返回 null（调用方按 42226 处理） */
export function billableDistanceM(s: LocalDeliverySettings, latE6: number, lngE6: number): number | null {
  if (s.store.latE6 === null || s.store.lngE6 === null) return null
  return Math.round(haversineM(s.store.latE6, s.store.lngE6, latE6, lngE6) * s.detourFactor)
}

export function calcLocalFee(
  s: LocalDeliverySettings,
  distanceM: number,
  subtotal: number
): { fee: number; inRange: boolean; belowMin: boolean } {
  const inRange = distanceM <= Math.round(s.radiusKm * 1000)
  const belowMin = s.fee.minOrderAmount > 0 && subtotal < s.fee.minOrderAmount
  const km = distanceM / 1000
  let fee = s.fee.baseFee + Math.max(0, Math.ceil(km - s.fee.baseKm)) * s.fee.perKmFee
  if (s.fee.freeThreshold > 0 && subtotal >= s.fee.freeThreshold) fee = 0
  return { fee, inRange, belowMin }
}

export function estimateMinutes(s: LocalDeliverySettings, distanceM: number): number {
  return Math.round(s.prepMinutes + (distanceM / 1000 / s.riderSpeedKmh) * 60)
}

// ── 报价签名（防 quote 与下单之间金额漂移）───────────────────
interface QuotePayload { fee: number; distanceM: number; addressId: number; version: number }
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s: string) => crypto.createHmac('sha256', `quote:${config.jwt.userSecret}`).update(s).digest('hex').slice(0, 32)

export function signQuote(p: QuotePayload, now: Date = new Date()): string {
  const body = b64u(JSON.stringify({ f: p.fee, d: p.distanceM, a: p.addressId, v: p.version, e: now.getTime() + QUOTE_TTL_MS }))
  return `${body}.${hmac(body)}`
}

export function verifyQuote(token: string, now: Date = new Date()): QuotePayload | null {
  const [body, sig] = token.split('.')
  if (!body || !sig || sig.length !== 32) return null
  const expect = hmac(body)
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof o.e !== 'number' || o.e < now.getTime()) return null
    return { fee: Number(o.f), distanceM: Number(o.d), addressId: Number(o.a), version: Number(o.v) }
  } catch {
    return null
  }
}

/** /local/meta 下发的公开子集（不含小费上限、运力配置等运营参数） */
export function publicLocalMeta(s: LocalDeliverySettings, now: Date = new Date()) {
  return {
    enabled: s.enabled,
    isOpen: isOpenNow(s, now),
    paused: isPaused(s, now) ? { reason: s.paused?.reason ?? '', until: s.paused?.until ?? null } : null,
    nextOpenText: nextOpenText(s, now),
    businessHours: s.businessHours,
    store: {
      name: s.store.name, phone: s.store.phone, province: s.store.province, city: s.store.city,
      district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6,
    },
    radiusKm: s.radiusKm,
    radiusStraightKm: Math.round((s.radiusKm / s.detourFactor) * 10) / 10,
    fee: s.fee,
    prepMinutes: s.prepMinutes,
    acceptGraceMin: s.acceptGraceMin,
    limits: s.limits,
  }
}
```

- [ ] **Step 4: 运行自测**

Run: `cd apps/server && JWT_SECRET=selftest-secret-0123456789 ADMIN_JWT_SECRET=selftest-secret-0123456789 npx ts-node --transpile-only scripts/selftest-local-settings.ts`
Expected: 全部 `✔`，末行 `全部通过 16`。

- [ ] **Step 5: 类型检查并提交**

```bash
cd apps/server && npx tsc --noEmit && cd ../.. && git add apps/server/src/services/local-settings.ts apps/server/scripts/selftest-local-settings.ts && git commit -m "feat(server): 同城设置服务——营业时段/暂停/Haversine/阶梯运费/报价签名 + 自测

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: `/local/meta`、`/local/quote` 与后台同城设置接口

**Files:**
- Create: `apps/server/src/routes/local.ts`
- Modify: `apps/server/src/routes/index.ts`
- Modify: `apps/server/src/routes/admin/settings.ts`
- Test: `scripts/e2e.sh`（新增「== 21. 同城设置/报价 ==」）

**Interfaces:**
- Consumes: Task 4 全部导出。
- Produces:
  - `GET /api/local/meta` → `publicLocalMeta()`。
  - `POST /api/local/quote`（用户态可选：传 `addressId` 必须登录；传 `latE6,lngE6` 可匿名）body `{ addressId?: number; latE6?: number; lngE6?: number; subtotal?: number }` → `{ enabled, isOpen, paused, nextOpenText, inRange, distanceM, straightDistanceM, fee, minOrderAmount, belowMin, estimatedMinutes, quoteToken }`；门店无坐标 → 42226；地址无坐标 → 42223。
  - `GET/PUT /api/admin/settings/local-delivery`（PUT 全量，返回保存后的值；`enabled=true` 时跑 `validateForEnable`，任一错误 → 40001 拼接错误列表）；`PATCH /api/admin/settings/local-delivery/store-location { latE6, lngE6 }`；`POST /api/admin/settings/local-delivery/pause { reason, until? }`；`DELETE /api/admin/settings/local-delivery/pause`。

- [ ] **Step 1: e2e 断言（先失败）**

在第 20 段之后插入：
```bash
echo "== 21. 同城设置/报价 =="
R=$(req GET /api/admin/settings/local-delivery "$AT"); assert_eq "读取同城设置 enabled=false 默认" "$(jq -r .data.enabled <<<"$R")" "false"
LS=$(jq -c '.data | .store.latE6=29339000 | .store.lngE6=104778000 | .radiusKm=5 | .fee={baseFee:300,baseKm:3,perKmFee:100,freeThreshold:8000,minOrderAmount:2000} | .businessHours=[{start:"00:00",end:"23:59"}] | .enabled=true' <<<"$R")
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$LS"); assert_eq "保存并开启 code 0" "$(code "$R")" "0"
assert_eq "version 递增" "$(jq -r '.data.version' <<<"$R")" "1"
R=$(req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c '.businessHours=[{start:"18:00",end:"01:00"}]' <<<"$LS")"); assert_eq "跨零点被拒 40001" "$(code "$R")" "40001"
R=$(req PATCH /api/admin/settings/local-delivery/store-location "$AT" '{"latE6":29339500,"lngE6":104778500}'); assert_eq "PATCH 门店坐标" "$(jq -r .data.store.latE6 <<<"$R")" "29339500"
R=$(req GET /api/local/meta ""); assert_eq "公开 meta isOpen=true" "$(jq -r .data.isOpen <<<"$R")" "true"
assert_eq "meta 不泄漏 tip" "$(jq -r '.data.tip // "absent"' <<<"$R")" "absent"
R=$(req POST /api/local/quote "" '{"latE6":29350000,"lngE6":104790000,"subtotal":3000}'); assert_eq "匿名坐标报价 code 0" "$(code "$R")" "0"
assert_eq "范围内" "$(jq -r .data.inRange <<<"$R")" "true"
QFEE=$(jq -r .data.fee <<<"$R"); [[ "$QFEE" =~ ^[0-9]+$ ]] && ok "fee=$QFEE" || fail "fee 非整数" "$R"
[[ -n "$(jq -r '.data.quoteToken // empty' <<<"$R")" ]] && ok "返回 quoteToken" || fail "quoteToken 缺失"
R=$(req POST /api/local/quote "" '{"latE6":29600000,"lngE6":105100000,"subtotal":3000}'); assert_eq "超范围 inRange=false" "$(jq -r .data.inRange <<<"$R")" "false"
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$ADDR}"); assert_eq "旧地址无坐标 42223" "$(code "$R")" "42223"
R=$(req POST /api/admin/settings/local-delivery/pause "$AT" '{"reason":"暴雨暂停"}'); assert_eq "暂停 code 0" "$(code "$R")" "0"
assert_eq "meta 暂停后 isOpen=false" "$(req GET /api/local/meta "" | jq -r .data.isOpen)" "false"
R=$(req DELETE /api/admin/settings/local-delivery/pause "$AT"); assert_eq "恢复后 isOpen=true" "$(req GET /api/local/meta "" | jq -r .data.isOpen)" "true"
```
（`req` 的 method 参数直接传给 `curl -X`，`PATCH` 可用。）

- [ ] **Step 2: 运行确认失败** → `bash scripts/e2e.sh 2>&1 | sed -n '/== 21/,/== 11/p'`，Expected 多条 `✘`。

- [ ] **Step 3: 新建 `routes/local.ts`**

```ts
/**
 * 同城配送公开接口：菜单页店头（meta）与地址报价（quote）。
 * 未登录也可浏览菜单 → meta 完全公开；quote 传 addressId 时需登录（校验地址归属）。
 */
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { optionalUserAuth } from '../middlewares/auth'
import {
  getLocalSettings, publicLocalMeta, isOpenNow, isPaused, nextOpenText,
  billableDistanceM, haversineM, calcLocalFee, estimateMinutes, signQuote,
} from '../services/local-settings'

const router = Router()

router.get('/meta', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, publicLocalMeta(await getLocalSettings()))
  } catch (e) {
    next(e)
  }
})

const quoteSchema = z
  .object({
    addressId: z.number().int().positive().optional(),
    latE6: z.number().int().min(-90_000_000).max(90_000_000).optional(),
    lngE6: z.number().int().min(-180_000_000).max(180_000_000).optional(),
    subtotal: z.number().int().min(0).max(100_000_000).default(0),
  })
  .refine((v) => v.addressId !== undefined || (v.latE6 !== undefined && v.lngE6 !== undefined), {
    message: '请提供 addressId 或坐标',
  })

router.post('/quote', optionalUserAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = quoteSchema.parse(req.body)
    const s = await getLocalSettings()
    if (!s.enabled) throw new AppError(42226, '同城配送暂未开通')
    if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标，暂不能配送')

    let latE6: number, lngE6: number, addressId = 0
    if (body.addressId !== undefined) {
      if (!req.userId) throw new AppError(40101, '请先登录', 401)
      const addr = await prisma.address.findFirst({ where: { id: body.addressId, userId: req.userId, deletedAt: null } })
      if (!addr) throw new AppError(40401, '收货地址不存在', 404)
      if (addr.latE6 === null || addr.lngE6 === null) throw new AppError(42223, '该地址缺少定位，请编辑地址并在地图上选点')
      latE6 = addr.latE6; lngE6 = addr.lngE6; addressId = addr.id
    } else {
      latE6 = body.latE6!; lngE6 = body.lngE6!
    }

    const distanceM = billableDistanceM(s, latE6, lngE6)!
    const q = calcLocalFee(s, distanceM, body.subtotal)
    success(res, {
      enabled: s.enabled,
      isOpen: isOpenNow(s),
      paused: isPaused(s) ? { reason: s.paused?.reason ?? '' } : null,
      nextOpenText: nextOpenText(s),
      inRange: q.inRange,
      distanceM,
      straightDistanceM: haversineM(s.store.latE6, s.store.lngE6, latE6, lngE6),
      fee: q.fee,
      minOrderAmount: s.fee.minOrderAmount,
      belowMin: q.belowMin,
      estimatedMinutes: estimateMinutes(s, distanceM),
      quoteToken: q.inRange ? signQuote({ fee: q.fee, distanceM, addressId, version: s.version }) : null,
    })
  } catch (e) {
    next(e)
  }
})

export default router
```
确认 `middlewares/auth.ts` 已导出 `optionalUserAuth`（代码库现状有）。

- [ ] **Step 4: 挂载路由**

`routes/index.ts` import `localRouter from './local'`，在公开区加：
```ts
router.use('/local', localRouter)
```

- [ ] **Step 5: 扩展 `routes/admin/settings.ts`**

追加（保留原有 shipping 两个路由）：
```ts
import { AppError } from '../../middlewares/error'
import {
  getLocalSettings, setLocalSettings, patchLocalSettings, sanitizeLocalSettings,
  validateLocalSettings, validateForEnable,
} from '../../services/local-settings'

router.get('/local-delivery', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: await getLocalSettings() })
  } catch (e) {
    next(e)
  }
})

// 全量保存：先 sanitize 再业务校验；开启总开关时额外做完整性校验
router.put('/local-delivery', async (req, res, next) => {
  try {
    const next_ = sanitizeLocalSettings(req.body)
    const errs = next_.enabled ? validateForEnable(next_) : validateLocalSettings(next_)
    if (errs.length) throw new AppError(40001, errs.join('；'))
    res.json({ code: 0, message: 'ok', data: await setLocalSettings(next_) })
  } catch (e) {
    next(e)
  }
})

const locationSchema = z.object({
  latE6: z.number().int().min(-90_000_000).max(90_000_000),
  lngE6: z.number().int().min(-180_000_000).max(180_000_000),
})
router.patch('/local-delivery/store-location', async (req, res, next) => {
  try {
    const { latE6, lngE6 } = locationSchema.parse(req.body)
    const current = await getLocalSettings()
    res.json({ code: 0, message: 'ok', data: await patchLocalSettings({ store: { ...current.store, latE6, lngE6 } }) })
  } catch (e) {
    next(e)
  }
})

const pauseSchema = z.object({
  reason: z.string().trim().min(1, '请填写暂停原因').max(60),
  until: z.string().datetime().optional(),
})
router.post('/local-delivery/pause', async (req, res, next) => {
  try {
    const { reason, until } = pauseSchema.parse(req.body)
    res.json({ code: 0, message: 'ok', data: await patchLocalSettings({ paused: { reason, until: until ?? null } }) })
  } catch (e) {
    next(e)
  }
})
router.delete('/local-delivery/pause', async (_req, res, next) => {
  try {
    res.json({ code: 0, message: 'ok', data: await patchLocalSettings({ paused: null }) })
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 6: 类型检查 + e2e**

Run: `cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh` → Expected: 第 21 段全 `✔`。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/routes/local.ts apps/server/src/routes/index.ts apps/server/src/routes/admin/settings.ts scripts/e2e.sh
git commit -m "feat(server): 同城 meta/quote 公开接口 + 后台同城设置/门店坐标/暂停接单

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 地址坐标字段

**Files:**
- Modify: `apps/server/src/routes/addresses.ts`
- Test: `scripts/e2e.sh`（第 21 段末尾追加）

**Interfaces:**
- Produces: `POST/PUT /api/addresses` 接受可选 `latE6, lngE6, poiName`（坐标必须成对，否则 40001）；`GET /api/addresses` 原样返回新列。

- [ ] **Step 1: e2e 断言**

第 21 段末尾追加：
```bash
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E同城","receiverPhone":"13800000001","province":"四川省","city":"自贡市","district":"高新区","detail":"丹桂大街1号 3栋2单元","latE6":29350000,"lngE6":104790000,"poiName":"丹桂小区"}')
LADDR=$(jq -r '.data.id // empty' <<<"$R"); [[ -n "$LADDR" ]] && ok "创建带坐标地址 #$LADDR" || fail "创建带坐标地址" "$R"
assert_eq "poiName 落库" "$(jq -r .data.poiName <<<"$R")" "丹桂小区"
R=$(req POST /api/addresses "$UT" '{"receiverName":"E2E半坐标","receiverPhone":"13800000002","province":"四川省","city":"自贡市","district":"高新区","detail":"x","latE6":29350000}'); assert_eq "坐标不成对 40001" "$(code "$R")" "40001"
R=$(req POST /api/local/quote "$UT" "{\"addressId\":$LADDR,\"subtotal\":3000}"); assert_eq "按地址报价 code 0" "$(code "$R")" "0"
QTOKEN=$(jq -r .data.quoteToken <<<"$R"); QFEE=$(jq -r .data.fee <<<"$R")
```
清理段追加 `[[ -n "${LADDR:-}" ]] && req DELETE "/api/addresses/$LADDR" "$UT" >/dev/null`。

- [ ] **Step 2: 运行确认失败**（`poiName` 为 null / 40001 未触发）。

- [ ] **Step 3: 改 `addresses.ts`**

`addressSchema` 改为：
```ts
const addressSchema = z
  .object({
    receiverName: z.string().min(1, '请填写收货人').max(64),
    receiverPhone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
    province: z.string().min(1, '请填写省份').max(32),
    city: z.string().min(1, '请填写城市').max(32),
    district: z.string().min(1, '请填写区县').max(32),
    detail: z.string().min(1, '请填写详细地址').max(255),
    isDefault: z.number().int().min(0).max(1).default(0),
    // 同城配送用：GCJ-02 微度坐标 + 地图选点名称（成对出现）
    latE6: z.number().int().min(-90_000_000).max(90_000_000).nullable().optional(),
    lngE6: z.number().int().min(-180_000_000).max(180_000_000).nullable().optional(),
    poiName: z.string().max(128).nullable().optional(),
  })
  .refine((v) => (v.latE6 == null) === (v.lngE6 == null), { message: '经纬度必须同时提供' })
```
`PUT /:id` 中 `addressSchema.partial()` 对 `ZodEffects` 不可用，改为定义基础对象 `addressBase = z.object({...})`，`addressSchema = addressBase.refine(...)`，PUT 用 `addressBase.partial().refine((v) => (v.latE6 == null) === (v.lngE6 == null), { message: '经纬度必须同时提供' }).parse(req.body)`。其余逻辑不变（`data` 直接展开写入即可）。

- [ ] **Step 4: 类型检查 + e2e**，Expected 第 21 段追加断言全 `✔`。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/addresses.ts scripts/e2e.sh
git commit -m "feat(server): 收货地址支持 GCJ-02 坐标与 POI 名（同城配送必填项）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 同城下单分支、取消申请、邮寄端点守卫、后台筛选与计数

**Files:**
- Modify: `apps/server/src/routes/orders.ts`
- Modify: `apps/server/src/routes/admin/orders.ts`
- Modify: `apps/server/src/services/order-notify.ts`
- Test: `scripts/e2e.sh`（新增「== 22. 同城下单 ==」）

**Interfaces:**
- Consumes: Task 4（`getLocalSettings/isOpenNow/isPaused/nextOpenText/billableDistanceM/calcLocalFee/estimateMinutes/verifyQuote`）、Task 2（`channelOfDeliveryType`）。
- Produces:
  - `POST /api/orders` body 新增可选 `quoteToken`；`deliveryType` 枚举收窄为 `['EXPRESS','LOCAL']`。
  - `GET /api/orders/:id` 新增字段 `canRequestCancel: boolean`、`cancelRequestDeadline: string|null`、`cancelRequestedAt`。
  - `POST /api/orders/:id/cancel-request { note? }` → `{ cancelRequestedAt }`；错误 42229。
  - `GET /api/admin/orders?deliveryType=`（缺省 `EXPRESS`；`ALL` = 不过滤）；返回行含 `deliveryType/distanceM/cancelRequestedAt`。
  - `GET /api/admin/orders/pending-count` 新增 `localPendingCount`（LOCAL 且 status ∈ PAID,PREPARING 或 `cancelRequestedAt` 非空）。
  - `services/order-notify.ts`: `notifyCancelRequest(order: { orderNo; actualAmount; receiverName; receiverPhone; note?: string | null })`.

- [ ] **Step 1: e2e 断言（先失败）**

在第 21 段之后插入：
```bash
echo "== 22. 同城下单 =="
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); LCID2=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID2],\"addressId\":$LADDR,\"deliveryType\":\"EXPRESS\"}"); assert_eq "同城商品走邮寄被拒 42224" "$(code "$R")" "42224"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID2],\"addressId\":$ADDR,\"deliveryType\":\"LOCAL\"}"); assert_eq "无坐标地址下同城单 42223" "$(code "$R")" "42223"
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID2],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$QTOKEN\"}")
LO1=$(jq -r '.data.orderId // empty' <<<"$R"); [[ -n "$LO1" ]] && ok "同城下单 #$LO1" || fail "同城下单" "$R"
assert_eq "运费=报价 fee" "$(jq -r .data.shippingFee <<<"$R")" "$QFEE"
R=$(req GET "/api/orders/$LO1" "$UT")
assert_eq "订单 deliveryType=LOCAL" "$(jq -r .data.deliveryType <<<"$R")" "LOCAL"
[[ "$(jq -r .data.distanceM <<<"$R")" -gt 0 ]] && ok "distanceM 已快照" || fail "distanceM" "$R"
[[ "$(jq -r .data.estimatedDeliveryAt <<<"$R")" != "null" ]] && ok "estimatedDeliveryAt 已写" || fail "estimatedDeliveryAt"
assert_eq "shipment 为空（LOCAL 不写 Shipment）" "$(jq -r .data.shipment <<<"$R")" "null"
# 全局邮寄运费被设成 9999 也不影响同城运费
req PUT /api/admin/settings/shipping "$AT" '{"fee":999900,"freeThreshold":0,"minOrderAmount":0}' >/dev/null
R=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":1}"); LCID3=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$LCID3],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\"}")
LO2=$(jq -r '.data.orderId // empty' <<<"$R"); [[ "$(jq -r .data.shippingFee <<<"$R")" -lt 999900 ]] && ok "LOCAL 运费与全局邮寄运费无关" || fail "LOCAL 叠加了全局运费" "$R"
req PUT /api/admin/settings/shipping "$AT" '{"fee":0,"freeThreshold":0,"minOrderAmount":0}' >/dev/null
# 支付 → 邮寄端点守卫 → 取消申请窗口
req POST "/api/orders/$LO1/pay" "$UT" >/dev/null
R=$(req POST "/api/admin/orders/$LO1/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"X"}'); assert_eq "LOCAL 单不可走邮寄发货 42204" "$(code "$R")" "42204"
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "未接单不能申请取消(应走秒退) 42229" "$(code "$R")" "42229"
R=$(req POST "/api/admin/orders/$LO1/accept" "$AT"); assert_eq "邮寄接单端点拒绝 LOCAL 42204" "$(code "$R")" "42204"
# M1 暂借用 SQL 把订单置 PREPARING（M2 提供同城接单接口后改为调用接口）
docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop -e "update orders set status='PREPARING', accepted_at=NOW(3) where id=$LO1;" 2>/dev/null
R=$(req GET "/api/orders/$LO1" "$UT"); assert_eq "窗口内 canRequestCancel=true" "$(jq -r .data.canRequestCancel <<<"$R")" "true"
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{}'); assert_eq "重复申请 42229" "$(code "$R")" "42229"
docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop -e "update orders set cancel_requested_at=NULL, accepted_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE) where id=$LO1;" 2>/dev/null
R=$(req POST "/api/orders/$LO1/cancel-request" "$UT" '{}'); assert_eq "超窗口 42229" "$(code "$R")" "42229"
R=$(req GET "/api/admin/orders?pageSize=50" "$AT"); [[ "$(jq -r "[.data.list[] | select(.id==$LO1)] | length" <<<"$R")" == "0" ]] && ok "后台订单列表默认不含同城单" || fail "后台列表混入同城单"
R=$(req GET "/api/admin/orders?deliveryType=LOCAL&pageSize=50" "$AT"); [[ "$(jq -r "[.data.list[] | select(.id==$LO1)] | length" <<<"$R")" == "1" ]] && ok "deliveryType=LOCAL 可查到" || fail "LOCAL 筛选" "$R"
R=$(req GET /api/admin/orders/pending-count "$AT"); [[ "$(jq -r .data.localPendingCount <<<"$R")" -ge 1 ]] && ok "localPendingCount≥1" || fail "localPendingCount" "$R"
```
清理段追加：`for o in ${LO1:-} ${LO2:-}; do docker exec -i food-shop-mysql mysql -ufoodshop_user -pfoodshop_password food_shop -e "update orders set status='CANCELLED' where id=$o and status in ('PENDING_PAYMENT','PAID','PREPARING');" 2>/dev/null; done`。

- [ ] **Step 2: 运行确认失败**。

- [ ] **Step 3: `order-notify.ts` 新增 `notifyCancelRequest`**

在 `notifyRefundRequest` 之后追加（沿用其双通道写法）：
```ts
/** 顾客在接单后宽限期内申请取消同城订单，需店员到工作台确认并退款。 */
export function notifyCancelRequest(order: {
  orderNo: string
  actualAmount: number
  receiverName: string
  receiverPhone: string
  note?: string | null
}): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🛵 同城订单：顾客申请取消（接单后 5 分钟内，需确认全额退款）**`,
    `订单号：${order.orderNo}`,
    `金额：**¥${fmtYuan(order.actualAmount)}**`,
    `顾客：${order.receiverName} ${order.receiverPhone}`,
    ...(order.note ? [`原因：${order.note}`] : []),
    `请到后台「同城订单」处理`,
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '同城订单申请取消', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
```
（若文件内 `sendWecomMarkdown/sendPushPlus` 的参数顺序与 `notifyRefundRequest` 中的调用不同，以该函数现有调用为准复制。）

- [ ] **Step 4: 改 `routes/orders.ts` 下单**

import 追加：
```ts
import { channelOfDeliveryType } from '../utils/channel'
import { notifyCancelRequest } from '../services/order-notify'
import {
  getLocalSettings, isOpenNow, isPaused, nextOpenText, billableDistanceM, calcLocalFee, estimateMinutes, verifyQuote,
} from '../services/local-settings'
```
`createOrderSchema`：`deliveryType: z.enum(['EXPRESS', 'LOCAL']).default('EXPRESS'),` 并加 `quoteToken: z.string().max(512).optional(),`；解构处加 `quoteToken`。

在「2. 逐个验证商品」循环内首行加渠道校验：
```ts
      const channel = channelOfDeliveryType(deliveryType)
      if (p.channel !== channel) {
        throw new AppError(42224, channel === 'LOCAL' ? `${p.name} 不是同城配送商品` : `${p.name} 是同城配送商品，请到同城页面下单`)
      }
```
（`channel` 常量提到循环外声明一次。）

把「4. 计算金额」中从 `// 运费与起送门槛都按**商品小计**判断` 到 `const actualAmount = totalAmount + shippingFee` 替换为：
```ts
    // 两套计费互不叠加：EXPRESS 走 services/settings.ts；LOCAL 走 services/local-settings.ts
    let shippingFee = 0
    let localSnapshot: {
      receiverLatE6?: number; receiverLngE6?: number; receiverPoiName?: string | null
      distanceM?: number; estimatedDeliveryAt?: Date
    } = {}
    if (deliveryType === 'LOCAL') {
      const s = await getLocalSettings()
      if (!s.enabled) throw new AppError(42226, '同城配送暂未开通')
      if (isPaused(s)) throw new AppError(42226, `同城配送暂停接单${s.paused?.reason ? `：${s.paused.reason}` : ''}`)
      if (!isOpenNow(s)) throw new AppError(42222, `当前非营业时间，${nextOpenText(s)}`)
      if (address.latE6 === null || address.lngE6 === null) throw new AppError(42223, '该地址缺少定位，请编辑地址并在地图上选点')
      const distanceM = billableDistanceM(s, address.latE6, address.lngE6)
      if (distanceM === null) throw new AppError(42226, '门店尚未设置坐标，暂不能配送')
      const q = calcLocalFee(s, distanceM, totalAmount)
      if (!q.inRange) throw new AppError(42220, `超出配送范围（约 ${(distanceM / 1000).toFixed(1)} km，最远 ${s.radiusKm} km）`)
      if (q.belowMin) throw new AppError(42210, `同城配送满 ¥${(s.fee.minOrderAmount / 100).toFixed(2)} 起送，当前 ¥${(totalAmount / 100).toFixed(2)}`)
      const totalItems = lines.reduce((n, l) => n + l.quantity, 0)
      const totalWeightKg = lines.reduce((w, l) => w + ((l.product.netWeightG ?? s.kd100.defaultItemWeightG) * l.quantity) / 1000, 0)
      if (totalItems > s.limits.maxItems || totalWeightKg > s.limits.maxWeightKg) {
        throw new AppError(42230, `单次配送最多 ${s.limits.maxItems} 件 / ${s.limits.maxWeightKg} kg，请分单或电话联系商家`)
      }
      let fee = q.fee
      if (quoteToken) {
        const p = verifyQuote(quoteToken)
        if (p && p.addressId === address.id) {
          if (fee > p.fee) throw new AppError(42227, '配送费已更新，请刷新后重新提交')
          fee = Math.min(fee, p.fee)
        }
      }
      shippingFee = fee
      localSnapshot = {
        receiverLatE6: address.latE6,
        receiverLngE6: address.lngE6,
        receiverPoiName: address.poiName,
        distanceM,
        estimatedDeliveryAt: new Date(Date.now() + estimateMinutes(s, distanceM) * 60 * 1000),
      }
    } else {
      // 运费与起送门槛都按**商品小计**判断（不含运费，见 services/settings.ts）
      const shipping = await getShippingSettings()
      if (shipping.minOrderAmount > 0 && totalAmount < shipping.minOrderAmount) {
        throw new AppError(
          42210,
          `订单满 ¥${(shipping.minOrderAmount / 100).toFixed(2)} 起送，当前 ¥${(totalAmount / 100).toFixed(2)}`
        )
      }
      shippingFee = calcShippingFee(totalAmount, shipping)
    }
    const actualAmount = totalAmount + shippingFee
```
并在 `tx.order.create({ data: { ... receiverFullAddress: address.fullAddress,` 之后加一行 `...localSnapshot,`。

- [ ] **Step 5: `GET /orders/:id` 增加取消窗口字段 + 新增 `cancel-request`**

在 `GET /:id` 的 `success(res, { ...withPayExpire(rest), ...` 中加：
```ts
      ...(await cancelWindowOf(order)),
```
并在文件顶部 `withPayExpire` 之后加辅助：
```ts
/** D6 ②：同城订单接单后 acceptGraceMin 分钟内可申请取消 */
async function cancelWindowOf(order: { deliveryType: string; status: string; acceptedAt: Date | null; cancelRequestedAt: Date | null }) {
  if (order.deliveryType !== 'LOCAL' || order.status !== 'PREPARING' || !order.acceptedAt) {
    return { canRequestCancel: false, cancelRequestDeadline: null as Date | null }
  }
  const s = await getLocalSettings()
  const deadline = new Date(order.acceptedAt.getTime() + s.acceptGraceMin * 60 * 1000)
  return { canRequestCancel: !order.cancelRequestedAt && Date.now() < deadline.getTime(), cancelRequestDeadline: deadline }
}
```
在 `PUT /:id/confirm` 之前新增路由：
```ts
// POST /api/orders/:id/cancel-request — 同城订单接单后宽限期内申请取消（订单状态不变，店员确认后全额退）
const cancelRequestSchema = z.object({ note: z.string().trim().max(255).optional() })
router.post('/:id/cancel-request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const userId = req.userId!
    const { note } = cancelRequestSchema.parse(req.body ?? {})
    const order = await prisma.order.findFirst({ where: { id, userId } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    const win = await cancelWindowOf(order)
    if (!win.canRequestCancel) {
      throw new AppError(42229, order.status === 'PAID' ? '商家尚未接单，请直接申请退款' : '已超过可取消时间，如有问题请联系商家')
    }
    // M2 接入配送单后此处改为快照有效 Delivery 的状态；M1 无配送单一律 NONE
    const moved = await prisma.order.updateMany({
      where: { id, status: 'PREPARING', cancelRequestedAt: null },
      data: { cancelRequestedAt: new Date(), cancelRequestNote: note ?? null, cancelRequestDeliveryStatus: 'NONE' },
    })
    if (moved.count === 0) throw new AppError(42229, '已提交过取消申请')
    notifyCancelRequest({ orderNo: order.orderNo, actualAmount: order.actualAmount, receiverName: order.receiverName, receiverPhone: order.receiverPhone, note })
    success(res, { cancelRequestedAt: new Date() })
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 6: 改 `routes/admin/orders.ts`**

列表 `where` 前加：
```ts
    // 邮寄订单页默认只看 EXPRESS；同城看板传 LOCAL；ALL 不过滤
    const dt = (req.query.deliveryType as string | undefined) ?? 'EXPRESS'
```
`where` 加 `...(dt === 'ALL' ? {} : { deliveryType: dt === 'LOCAL' ? 'LOCAL' : 'EXPRESS' }),`。`orderListSelect` 加 `distanceM: true, cancelRequestedAt: true, estimatedDeliveryAt: true,`。

`pending-count`：`Promise.all` 追加一个查询并返回：
```ts
      prisma.order.count({
        where: {
          deliveryType: 'LOCAL',
          OR: [{ status: { in: ['PAID', 'PREPARING'] } }, { cancelRequestedAt: { not: null } }],
        },
      }),
```
解构名 `localPendingCount`，响应体加 `localPendingCount`；原 `count` 查询加 `deliveryType: 'EXPRESS'`（邮寄铃铛只数邮寄）。

`accept`/`ship`/`complete` 三个路由：在 `updateMany` 或状态判断之前加统一守卫（accept/complete 先 `findUnique`）：
```ts
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType === 'LOCAL') throw new AppError(42204, '同城订单请在同城看板操作')
```
（`ship` 已有 `order`，直接在状态判断前加 `if (order.deliveryType === 'LOCAL') throw new AppError(42204, '同城订单请在同城看板操作')`。）

- [ ] **Step 7: 类型检查 + 全量 e2e**

Run: `cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh` → Expected: 第 22 段全 `✔`，且第 6–16 段（邮寄全链路）不变。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/routes/orders.ts apps/server/src/routes/admin/orders.ts apps/server/src/services/order-notify.ts scripts/e2e.sh
git commit -m "feat(server): 同城下单分支（营业/范围/阶梯运费/quoteToken）+ 取消申请窗口 + 邮寄端点守卫 + 后台渠道筛选

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 后台——类型/API、分类与商品渠道 Tab、同城设置页、导航

**Files:**
- Modify: `apps/admin/src/types.ts`
- Modify: `apps/admin/src/api/admin.ts`
- Modify: `apps/admin/src/pages/Categories.tsx`
- Modify: `apps/admin/src/pages/Products.tsx`
- Modify: `apps/admin/src/pages/Orders.tsx`（标题 + 列表请求）
- Create: `apps/admin/src/pages/LocalSettings.tsx`
- Modify: `apps/admin/src/components/Layout.tsx`、`apps/admin/src/App.tsx`
- Test: `npm run build`（tsc + vite）+ 浏览器实测清单

**Interfaces:**
- Consumes: Task 2/5/7 的后台接口。
- Produces: `types.ts` 新增 `Channel`、`CHANNEL_LABEL`、`LocalDeliverySettings`；`Category.channel`、`Product.channel/netWeightG`；`api/admin.ts` 新增 `getLocalSettings/updateLocalSettings/patchStoreLocation/pauseLocal/resumeLocal`，`getCategories(channel?)`、`getProducts({channel})`、`batchProductStatus(status, categoryId?, channel?)`、`getOrders({deliveryType})`。

- [ ] **Step 1: `types.ts`**

在 `Category` 接口加 `channel: Channel`；`Product` 加 `channel: Channel` 与 `netWeightG: number | null`；文件顶部加：
```ts
export type Channel = 'EXPRESS' | 'LOCAL'
export const CHANNEL_LABEL: Record<Channel, string> = { EXPRESS: '全国邮寄', LOCAL: '同城配送' }
```
文件末尾追加：
```ts
/** 同城配送设置（与服务端 services/local-settings.ts 同构；金额分、坐标微度） */
export interface LocalDeliverySettings {
  version: number
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  store: { name: string; phone: string; province: string; city: string; district: string; address: string; latE6: number | null; lngE6: number | null }
  radiusKm: number
  detourFactor: number
  fee: { baseFee: number; baseKm: number; perKmFee: number; freeThreshold: number; minOrderAmount: number }
  businessHours: { start: string; end: string }[]
  prepMinutes: number
  riderSpeedKmh: number
  acceptGraceMin: number
  autoCallDelayMin: number
  defaultProvider: 'KD100' | 'SELF'
  kd100: { providers: string[]; goodsType: string; defaultItemWeightG: number; insurance: boolean; autoDowngradeToSelfOnNoBalance: boolean }
  limits: { maxItems: number; maxWeightKg: number }
  callTimeoutMin: number
  acceptedStuckMin: number
  deliveringTimeoutMin: number
  tip: { maxPerCall: number; maxPerOrder: number }
}
```

- [ ] **Step 2: `api/admin.ts`**

修改/新增：
```ts
export const getCategories = (channel?: Channel) =>
  client.get<ApiResponse<Category[]>>('/admin/categories', { params: channel ? { channel } : undefined })

export const getProducts = (params?: { page?: number; pageSize?: number; categoryId?: number; keyword?: string; status?: string; channel?: Channel }) =>
  client.get<ApiResponse<PaginatedData<Product>>>('/admin/products', { params })

export const batchProductStatus = (status: 'ON_SHELF' | 'OFF_SHELF', categoryId?: number, channel?: Channel) =>
  client.post<ApiResponse<{ updated: number }>>('/admin/products/batch-status', {
    status,
    ...(categoryId ? { categoryId } : {}),
    ...(channel ? { channel } : {}),
  })

export const getOrders = (params?: { page?: number; pageSize?: number; status?: string; keyword?: string; deliveryType?: 'EXPRESS' | 'LOCAL' | 'ALL' }) =>
  client.get<ApiResponse<PaginatedData<Order>>>('/admin/orders', { params })

// 同城设置
export const getLocalSettings = () =>
  client.get<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery').then((r) => r.data.data)
export const updateLocalSettings = (payload: LocalDeliverySettings) =>
  client.put<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery', payload).then((r) => r.data.data)
export const patchStoreLocation = (latE6: number, lngE6: number) =>
  client.patch<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery/store-location', { latE6, lngE6 }).then((r) => r.data.data)
export const pauseLocal = (reason: string, until?: string) =>
  client.post<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery/pause', { reason, until }).then((r) => r.data.data)
export const resumeLocal = () =>
  client.delete<ApiResponse<LocalDeliverySettings>>('/admin/settings/local-delivery/pause').then((r) => r.data.data)
```
import 里加 `Channel, LocalDeliverySettings`。`getPendingOrderCount` 的返回类型加 `localPendingCount: number`。

- [ ] **Step 3: `Categories.tsx` 渠道 Tab + 表单**

- state 加 `const [channel, setChannel] = useState<Channel>('EXPRESS')`；`load` 改 `getCategories(channel)`；`useEffect(() => { load() }, [channel])`。
- `emptyForm` 加 `channel: 'EXPRESS' as Channel`；`openCreate` 时 `setForm({ ...emptyForm, channel })`；`openEdit` 带 `channel: cat.channel`。
- 标题下方加 Tab：
```tsx
      <div className="flex gap-2 border-b border-gray-200">
        {(['EXPRESS', 'LOCAL'] as Channel[]).map((c) => (
          <button key={c} onClick={() => setChannel(c)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 ${channel === c ? 'border-brand-500 text-brand-600 font-medium' : 'border-transparent text-gray-500'}`}>
            {CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>
```
- 表单「状态」旁加渠道选择（编辑且分类下有商品时给提示）：
```tsx
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">渠道</label>
                  <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as Channel })}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm">
                    <option value="EXPRESS">全国邮寄</option>
                    <option value="LOCAL">同城配送</option>
                  </select>
                  {editing && (editing._count?.products ?? 0) > 0 && editing.channel !== form.channel && (
                    <p className="mt-1 text-xs text-amber-600">改渠道会把该分类下 {editing._count?.products} 个商品一起迁到新渠道，并清空顾客购物车里的这些商品</p>
                  )}
                </div>
```
- 保存成功后若 `channel` 变了 `toast.success('已迁移渠道')`。

- [ ] **Step 4: `Products.tsx` 渠道 Tab、分类下拉按渠道过滤、去掉配送方式、加净重**

- state 加 `const [channel, setChannel] = useState<Channel>('EXPRESS')`；`load` 参数加 `channel`；分类拉取改 `getCategories()`（全部）并在下拉/表单里 `categories.filter((c) => c.channel === channel)`；`useEffect(() => { setFilterCategoryId(''); setPage(1); load(1) }, [channel])`。
- 标题下加与分类页相同的 Tab 组件（可抽成 `components/ui/ChannelTabs.tsx`：`export default function ChannelTabs({ value, onChange }: { value: Channel; onChange: (c: Channel) => void })`，两页共用）。
- 删除 `DELIVERY_TYPE_LABEL` 常量、`emptyForm.deliveryType`、`openEdit` 的 `deliveryType`、payload 的 `deliveryType`、表单里「配送方式」`<select>` 整块；在其位置放：
```tsx
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">所属渠道</label>
                  <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-600">
                    {CHANNEL_LABEL[categories.find((c) => c.id === form.categoryId)?.channel ?? channel]}（随分类）
                  </div>
                </div>
```
- `emptyForm` 加 `netWeightG: ''`；`openEdit` 带 `netWeightG: p.netWeightG?.toString() ?? ''`；payload 加 `netWeightG: form.netWeightG ? Number(form.netWeightG) : null`；表单「单位」旁加：
```tsx
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">净重（克）</label>
                  <input type="number" min={1} value={form.netWeightG}
                    onChange={(e) => setForm({ ...form, netWeightG: e.target.value })}
                    placeholder="同城配送按重量呼叫骑手，空=用默认值"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm" />
                </div>
```
- `handleBatchStatus` 调用改 `batchProductStatus(status, catId, channel)`，文案 `scope` 前缀加渠道名。

- [ ] **Step 5: `Orders.tsx`**

标题「订单管理」改「邮寄订单」；`getOrders({...})` 调用处加 `deliveryType: 'EXPRESS'`。

- [ ] **Step 6: 新建 `pages/LocalSettings.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { MapPin, PauseCircle, PlayCircle } from 'lucide-react'
import { getLocalSettings, updateLocalSettings, pauseLocal, resumeLocal } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import type { LocalDeliverySettings } from '../types'

const toYuan = (fen: number) => (fen / 100).toFixed(2)
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}
// 自贡市大致范围：纬度 28.9–29.9，经度 104.0–105.3（防经纬度填反 / 抄错坐标系）
const inZigong = (latE6: number, lngE6: number) => latE6 >= 28_900_000 && latE6 <= 29_900_000 && lngE6 >= 104_000_000 && lngE6 <= 105_300_000

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

export default function LocalSettings() {
  const [s, setS] = useState<LocalDeliverySettings | null>(null)
  const [money, setMoney] = useState({ baseFee: '', perKmFee: '', freeThreshold: '', minOrderAmount: '', maxPerCall: '', maxPerOrder: '' })
  const [coord, setCoord] = useState({ lat: '', lng: '' })
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => {
    setS(v)
    setMoney({
      baseFee: toYuan(v.fee.baseFee), perKmFee: toYuan(v.fee.perKmFee), freeThreshold: toYuan(v.fee.freeThreshold),
      minOrderAmount: toYuan(v.fee.minOrderAmount), maxPerCall: toYuan(v.tip.maxPerCall), maxPerOrder: toYuan(v.tip.maxPerOrder),
    })
    setCoord({ lat: v.store.latE6 === null ? '' : (v.store.latE6 / 1e6).toFixed(6), lng: v.store.lngE6 === null ? '' : (v.store.lngE6 / 1e6).toFixed(6) })
  }
  useEffect(() => { getLocalSettings().then(hydrate) }, [])

  if (!s) return <div className="text-gray-500">加载中...</div>

  const patch = (p: Partial<LocalDeliverySettings>) => setS({ ...s, ...p })
  const patchStore = (p: Partial<LocalDeliverySettings['store']>) => setS({ ...s, store: { ...s.store, ...p } })

  const handleSave = async (enabledOverride?: boolean) => {
    const fen = Object.fromEntries(Object.entries(money).map(([k, v]) => [k, toFen(v)])) as Record<keyof typeof money, number | null>
    if (Object.values(fen).some((v) => v === null)) { toast.error('金额格式不正确（最多两位小数）'); return }
    let latE6: number | null = null, lngE6: number | null = null
    if (coord.lat.trim() || coord.lng.trim()) {
      const lat = Number(coord.lat), lng = Number(coord.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast.error('坐标格式不正确'); return }
      latE6 = Math.round(lat * 1e6); lngE6 = Math.round(lng * 1e6)
      if (!inZigong(latE6, lngE6)) {
        const ok = await confirmDialog({ title: '坐标看起来不在自贡附近', content: '请确认没有把经纬度顺序填反、且使用的是腾讯/高德坐标。仍要保存？', danger: true })
        if (!ok) return
      }
    }
    const payload: LocalDeliverySettings = {
      ...s,
      enabled: enabledOverride ?? s.enabled,
      store: { ...s.store, latE6, lngE6 },
      fee: { ...s.fee, baseFee: fen.baseFee!, perKmFee: fen.perKmFee!, freeThreshold: fen.freeThreshold!, minOrderAmount: fen.minOrderAmount! },
      tip: { maxPerCall: fen.maxPerCall!, maxPerOrder: fen.maxPerOrder! },
    }
    setSaving(true)
    try {
      hydrate(await updateLocalSettings(payload))
      toast.success('已保存（运费改动后 5 分钟内已报价的订单仍按旧价执行）')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handlePause = async () => {
    const reason = window.prompt('暂停原因（顾客可见）', '临时暂停接单') ?? ''
    if (!reason.trim()) return
    hydrate(await pauseLocal(reason.trim()))
    toast.success('已暂停同城接单')
  }
  const handleResume = async () => { hydrate(await resumeLocal()); toast.success('已恢复接单') }

  // 按距离档试算
  const sample = (km: number) => {
    const baseFee = toFen(money.baseFee) ?? 0, perKm = toFen(money.perKmFee) ?? 0
    if (km > s.radiusKm) return '超出配送范围'
    return `¥${toYuan(baseFee + Math.max(0, Math.ceil(km - s.fee.baseKm)) * perKm)}`
  }
  const hoursText = s.businessHours.map((h) => `${h.start}-${h.end}`).join('\n')

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-gray-800">同城设置</h2>
        <div className="flex items-center gap-2">
          {s.paused ? (
            <Button variant="secondary" size="sm" onClick={handleResume}><PlayCircle className="w-4 h-4" />恢复接单</Button>
          ) : (
            <Button variant="secondary" size="sm" onClick={handlePause}><PauseCircle className="w-4 h-4" />暂停接单</Button>
          )}
          <Button size="sm" loading={saving} onClick={() => handleSave(!s.enabled)}>{s.enabled ? '关闭同城配送' : '开启同城配送'}</Button>
        </div>
      </div>
      {s.paused && <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">已暂停接单：{s.paused.reason}</div>}
      {!s.enabled && <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">同城配送未开启，顾客端入口显示「即将开通」。填齐门店坐标、营业时段、运费后点右上角开启。</div>}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><MapPin className="w-4 h-4" />门店</h3>
        <div className="rounded-md bg-brand-50 border border-brand-100 p-3 text-xs text-gray-700 space-y-1">
          <p className="font-medium">推荐：在店里用小程序设置坐标（3 步）</p>
          <p>① 打开小程序 →「我的」→「商家管理」登录 → ② 点「用当前位置设为门店坐标」→ ③ 回到本页刷新确认。</p>
          <p className="text-gray-500">手填经纬度是高级选项：需用腾讯地图坐标拾取器取「纬度,经度」（GCJ-02），填错会导致所有订单距离与运费算错。</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="门店名称"><input className={inputCls} value={s.store.name} onChange={(e) => patchStore({ name: e.target.value })} /></Field>
          <Field label="门店电话"><input className={inputCls} value={s.store.phone} onChange={(e) => patchStore({ phone: e.target.value })} /></Field>
          <Field label="省 / 市 / 区">
            <div className="flex gap-2">
              <input className={inputCls} value={s.store.province} onChange={(e) => patchStore({ province: e.target.value })} />
              <input className={inputCls} value={s.store.city} onChange={(e) => patchStore({ city: e.target.value })} />
              <input className={inputCls} value={s.store.district} onChange={(e) => patchStore({ district: e.target.value })} />
            </div>
          </Field>
          <Field label="详细地址"><input className={inputCls} value={s.store.address} onChange={(e) => patchStore({ address: e.target.value })} /></Field>
          <Field label="纬度（高级）" hint="如 29.339123"><input className={inputCls} inputMode="decimal" value={coord.lat} onChange={(e) => setCoord({ ...coord, lat: e.target.value })} /></Field>
          <Field label="经度（高级）" hint="如 104.778456"><input className={inputCls} inputMode="decimal" value={coord.lng} onChange={(e) => setCoord({ ...coord, lng: e.target.value })} /></Field>
        </div>
        {coord.lat && coord.lng && (
          <a className="text-xs text-blue-600 underline" target="_blank" rel="noreferrer"
            href={`https://apis.map.qq.com/uri/v1/marker?marker=coord:${coord.lat},${coord.lng};title:门店;addr:${encodeURIComponent(s.store.address)}`}>
            在腾讯地图中核对这个点
          </a>
        )}
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">配送范围与运费</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="配送半径（计费距离，km）" hint={`≈ 直线 ${(s.radiusKm / s.detourFactor).toFixed(1)} km`}>
            <input className={inputCls} type="number" step="0.5" min={0.5} value={s.radiusKm} onChange={(e) => patch({ radiusKm: Number(e.target.value) })} /></Field>
          <Field label="绕路系数" hint="计费距离 = 直线 × 系数，默认 1.35">
            <input className={inputCls} type="number" step="0.05" min={1} max={3} value={s.detourFactor} onChange={(e) => patch({ detourFactor: Number(e.target.value) })} /></Field>
          <Field label="基础运费（元）"><input className={inputCls} inputMode="decimal" value={money.baseFee} onChange={(e) => setMoney({ ...money, baseFee: e.target.value })} /></Field>
          <Field label="基础公里数" hint="不超过此距离只收基础运费">
            <input className={inputCls} type="number" step="0.5" min={0} value={s.fee.baseKm} onChange={(e) => patch({ fee: { ...s.fee, baseKm: Number(e.target.value) } })} /></Field>
          <Field label="超出每公里加价（元）"><input className={inputCls} inputMode="decimal" value={money.perKmFee} onChange={(e) => setMoney({ ...money, perKmFee: e.target.value })} /></Field>
          <Field label="满额免运费（元）" hint="0 = 不设"><input className={inputCls} inputMode="decimal" value={money.freeThreshold} onChange={(e) => setMoney({ ...money, freeThreshold: e.target.value })} /></Field>
          <Field label="起送金额（元）" hint="0 = 无门槛"><input className={inputCls} inputMode="decimal" value={money.minOrderAmount} onChange={(e) => setMoney({ ...money, minOrderAmount: e.target.value })} /></Field>
        </div>
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">按距离试算（不含满额免）</p>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>1 km → {sample(1)}</li><li>3 km → {sample(3)}</li><li>5 km → {sample(5)}</li><li>{s.radiusKm + 1} km → {sample(s.radiusKm + 1)}</li>
          </ul>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">营业与履约</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="营业时段（每行一段 HH:mm-HH:mm）" hint="首期不支持跨零点；多段不可重叠">
            <textarea className={inputCls} rows={3} defaultValue={hoursText}
              onBlur={(e) => patch({ businessHours: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [start, end] = l.split('-'); return { start: start?.trim() ?? '', end: end?.trim() ?? '' } }) })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="备餐时长（分）"><input className={inputCls} type="number" min={0} value={s.prepMinutes} onChange={(e) => patch({ prepMinutes: Number(e.target.value) })} /></Field>
            <Field label="骑行均速（km/h）"><input className={inputCls} type="number" min={5} value={s.riderSpeedKmh} onChange={(e) => patch({ riderSpeedKmh: Number(e.target.value) })} /></Field>
            <Field label="接单后可取消（分）" hint="顾客申请取消的窗口"><input className={inputCls} type="number" min={0} max={30} value={s.acceptGraceMin} onChange={(e) => patch({ acceptGraceMin: Number(e.target.value) })} /></Field>
            <Field label="接单后自动呼叫（分）" hint="0 = 手动呼叫；须 ≥ 可取消窗口"><input className={inputCls} type="number" min={0} max={15} value={s.autoCallDelayMin} onChange={(e) => patch({ autoCallDelayMin: Number(e.target.value) })} /></Field>
            <Field label="单次最多件数"><input className={inputCls} type="number" min={1} value={s.limits.maxItems} onChange={(e) => patch({ limits: { ...s.limits, maxItems: Number(e.target.value) } })} /></Field>
            <Field label="单次最大重量（kg）"><input className={inputCls} type="number" step="0.5" min={0.5} value={s.limits.maxWeightKg} onChange={(e) => patch({ limits: { ...s.limits, maxWeightKg: Number(e.target.value) } })} /></Field>
          </div>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">运力（快递100 接入后生效）</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="默认运力">
            <select className={inputCls} value={s.defaultProvider} onChange={(e) => patch({ defaultProvider: e.target.value as 'KD100' | 'SELF' })}>
              <option value="SELF">店内自送</option><option value="KD100">快递100 同城急送</option>
            </select>
          </Field>
          <Field label="商品默认净重（克）" hint="商品未填净重时用"><input className={inputCls} type="number" min={50} value={s.kd100.defaultItemWeightG} onChange={(e) => patch({ kd100: { ...s.kd100, defaultItemWeightG: Number(e.target.value) } })} /></Field>
          <Field label="小费单次上限（元）"><input className={inputCls} inputMode="decimal" value={money.maxPerCall} onChange={(e) => setMoney({ ...money, maxPerCall: e.target.value })} /></Field>
          <Field label="小费单笔订单累计上限（元）"><input className={inputCls} inputMode="decimal" value={money.maxPerOrder} onChange={(e) => setMoney({ ...money, maxPerOrder: e.target.value })} /></Field>
        </div>
      </section>

      <div className="flex justify-end">
        <Button loading={saving} onClick={() => handleSave()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
```
（`brand-50/brand-100` 若 tailwind 未定义则改用 `orange-50/orange-100`。）

- [ ] **Step 7: 路由与导航**

`App.tsx`：`import LocalSettings from './pages/LocalSettings'`，`<Route path="local/settings" element={<LocalSettings />} />`。
`Layout.tsx` `navItems` 在「店铺设置」之后加 `{ to: '/local/settings', label: '同城设置', icon: Bike }`（`import { Bike } from 'lucide-react'`）。「订单管理」label 改「邮寄订单」。

- [ ] **Step 8: 构建 + 浏览器实测**

Run: `cd apps/admin && npm run build`（Expected: 零错误）。启动 `admin`（launch.json，代理 3100）并实测：
1. 分类页两个 Tab 切换，新建 LOCAL 分类出现在「同城配送」Tab。
2. 商品页切到「同城配送」Tab：分类下拉只有 LOCAL 分类；新建商品可填净重；表单无「配送方式」；一键收档只影响同城。
3. 同城设置：填坐标（先填 104.77,29.33 触发填反警告，取消后改正）、保存；开启时缺时段被后端 40001 拦下并 toast 错误列表；暂停/恢复按钮生效。
4. 邮寄订单页标题正确、看不到同城单。
5. 375px 宽度下三页无横向溢出（`document.documentElement.scrollWidth <= 375`）。

- [ ] **Step 9: 提交**

```bash
git add apps/admin/src
git commit -m "feat(admin): 分类/商品渠道 Tab、净重字段、同城设置页（门店坐标/阶梯运费/营业时段/暂停）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: 小程序商家端「用当前位置设为门店坐标」

**Files:**
- Modify: `apps/miniapp/app.json`
- Modify: `apps/miniapp/pages/merchant/index.js`
- Modify: `apps/miniapp/pages/merchant/index.wxml`
- Modify: `docs/miniapp-release-checklist.md`（位置权限勾选项）

**Interfaces:**
- Consumes: `PATCH /admin/settings/local-delivery/store-location`（merchant_token）。

- [ ] **Step 1: `app.json` 声明位置权限**

在 `"window"` 之前加：
```json
  "requiredPrivateInfos": ["getLocation"],
  "permission": {
    "scope.userLocation": { "desc": "用于设置门店坐标与计算同城配送距离" }
  },
```
（M3 会追加 `chooseLocation`。）

- [ ] **Step 2: `index.wxml` 加按钮**

在「进入后台」section 的 `quick-row` 之后加：
```xml
      <view class="open-btn btn-secondary {{locating ? 'btn-disabled' : ''}}" bindtap="onSetStoreLocation">
        <text>{{locating ? '定位中...' : '用当前位置设为门店坐标'}}</text>
      </view>
      <text class="section-desc">请站在店内点击；用于同城配送距离与运费计算。</text>
```
`index.wxss` 若无 `.btn-secondary`，追加：
```css
.btn-secondary { margin-top: 16rpx; background: #fff; color: #e5441e; border: 2rpx solid #e5441e; border-radius: 12rpx; text-align: center; padding: 20rpx; }
```

- [ ] **Step 3: `index.js` 加处理**

`data` 加 `locating: false`；追加方法：
```js
  onSetStoreLocation() {
    var token = this._token()
    if (!token) { this._backToLogin(); return }
    if (this.data.locating) return
    var self = this
    wx.showModal({
      title: '设为门店坐标',
      content: '将把手机当前位置保存为门店坐标（请确认您现在在店内）。',
      success(m) {
        if (!m.confirm) return
        self.setData({ locating: true })
        wx.getLocation({
          type: 'gcj02',
          isHighAccuracy: true,
          success(loc) {
            wx.request({
              url: baseURL + '/admin/settings/local-delivery/store-location',
              method: 'PATCH',
              header: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
              data: { latE6: Math.round(loc.latitude * 1e6), lngE6: Math.round(loc.longitude * 1e6) },
              success(res) {
                var body = res.data
                if (body && body.code === 0) {
                  wx.showToast({ title: '门店坐标已保存', icon: 'success' })
                } else if (res.statusCode === 401) {
                  self._backToLogin()
                } else {
                  wx.showToast({ title: (body && body.message) || '保存失败', icon: 'none' })
                }
              },
              fail() { wx.showToast({ title: '网络错误，请重试', icon: 'none' }) },
              complete() { self.setData({ locating: false }) },
            })
          },
          fail(err) {
            self.setData({ locating: false })
            var denied = err && err.errMsg && err.errMsg.indexOf('auth deny') !== -1
            if (denied) {
              wx.showModal({
                title: '需要位置权限', content: '请在设置中允许「位置信息」后重试', confirmText: '去设置',
                success(r) { if (r.confirm) wx.openSetting() },
              })
            } else {
              wx.showToast({ title: '定位失败，请稍后重试', icon: 'none' })
            }
          },
        })
      },
    })
  },
```

- [ ] **Step 4: 静态校验 + 文档**

Run: `node -e "JSON.parse(require('fs').readFileSync('apps/miniapp/app.json','utf8'))" && node --check apps/miniapp/pages/merchant/index.js`（Expected 无输出）。
`docs/miniapp-release-checklist.md` 隐私指引表「位置信息」行改为「✓ 勾（商家端设置门店坐标；同城配送顾客选点在 M3 上线时同步申报）」，并在服务器域名/接口权限章节加一条「开发管理 → 接口设置：申请 `wx.getLocation`（类目：餐饮）」。
真机目验（用户）：商家端点按钮 → 授权 → toast 成功 → 后台同城设置页刷新可见坐标。

- [ ] **Step 5: 提交**

```bash
git add apps/miniapp/app.json apps/miniapp/pages/merchant docs/miniapp-release-checklist.md
git commit -m "feat(miniapp): 商家端一键用当前位置设为门店坐标（GCJ-02）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 一致性校验脚本、Seed、文档

**Files:**
- Create: `scripts/check-channel-consistency.mjs`
- Modify: `apps/server/prisma/seed.ts`
- Modify: `scripts/e2e.sh`（末尾调用一致性脚本）
- Modify: `docs/api.md`、`.env.example`

- [ ] **Step 1: 一致性脚本**

`scripts/check-channel-consistency.mjs`:
```js
#!/usr/bin/env node
// 只读校验：products.channel 必须等于所属 categories.channel；不一致即退出码 1。
// 用法：DATABASE_URL=mysql://... node scripts/check-channel-consistency.mjs（默认读 apps/server/.env）
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

if (!process.env.DATABASE_URL) {
  const envPath = new URL('../apps/server/.env', import.meta.url)
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/)
      if (m) process.env.DATABASE_URL = m[1]
    }
  }
}
const { PrismaClient } = require('../apps/server/node_modules/@prisma/client')
const prisma = new PrismaClient()
const rows = await prisma.$queryRaw`
  select p.id, p.name, p.channel as productChannel, c.id as categoryId, c.channel as categoryChannel
  from products p join categories c on c.id = p.category_id
  where p.deleted_at is null and p.channel <> c.channel`
if (rows.length) {
  console.error(`✘ ${rows.length} 个商品的 channel 与分类不一致：`)
  for (const r of rows) console.error(`  #${r.id} ${r.name}: product=${r.productChannel} category#${r.categoryId}=${r.categoryChannel}`)
  process.exitCode = 1
} else {
  console.log('✔ 商品渠道与分类一致')
}
await prisma.$disconnect()
```
`scripts/e2e.sh` 在「清理」段之后、汇总之前加：
```bash
echo "== 23. 渠道一致性 =="
node scripts/check-channel-consistency.mjs && ok "product.channel = category.channel" || fail "渠道不一致"
```

- [ ] **Step 2: Seed 加同城演示数据**

`seed.ts` 分类 `createMany` 数组追加 `{ name: '同城·凉菜', sortOrder: 10, channel: 'LOCAL' }, { name: '同城·卤味', sortOrder: 11, channel: 'LOCAL' }`；示例商品段末尾追加（在 `productCount === 0` 分支内）：
```ts
    const catLocal = await prisma.category.findFirst({ where: { name: '同城·凉菜' } })
    if (catLocal) {
      await prisma.product.createMany({
        data: [
          { categoryId: catLocal.id, channel: 'LOCAL', name: '凉拌黄瓜', price: 1200, stock: 50, unit: '份', netWeightG: 300, status: 'ON_SHELF', description: '现拌现送' },
          { categoryId: catLocal.id, channel: 'LOCAL', name: '夫妻肺片', price: 2800, stock: 30, unit: '份', netWeightG: 350, status: 'ON_SHELF', isRecommended: 1 },
        ],
      })
    }
```
现有示例商品的 `deliveryType: 'EXPRESS,LOCAL'` 一律改为 `'EXPRESS'`（列已废弃，避免误导）。

- [ ] **Step 3: 文档**

`docs/api.md` 追加「同城配送（M1）」小节：列出 `GET /local/meta`、`POST /local/quote`、`POST /orders`（LOCAL 分支与 `quoteToken`）、`POST /orders/:id/cancel-request`、`GET/PUT /admin/settings/local-delivery`、`PATCH .../store-location`、`POST/DELETE .../pause`、`channel` 查询参数约定、新错误码表（Global Constraints 中的 11 个）。
`.env.example` 末尾加注释块：
```env
# ── 同城配送（M1）────────────────────────────────────────────
# 运营参数（门店坐标/半径/运费/营业时段）全部在后台「同城设置」配置，无需 env。
# 快递100 密钥（KD100_KEY/KD100_SECRET/KD100_CALLBACK_URL）在 M2 接入时新增。
```

- [ ] **Step 4: 全量验证**

Run:
```bash
cd apps/server && npx tsc --noEmit && npx prisma migrate reset --force --skip-seed && npx prisma migrate deploy && npx prisma db seed && cd ../.. && bash scripts/e2e.sh && cd apps/admin && npm run build
```
Expected: 迁移与 seed 成功（seed 出现同城分类/商品）；e2e `失败 0`；admin 构建成功。
注意：`migrate reset` 只在本机开发库执行，绝不能对生产执行。

- [ ] **Step 5: 提交**

```bash
git add scripts/check-channel-consistency.mjs scripts/e2e.sh apps/server/prisma/seed.ts docs/api.md .env.example
git commit -m "chore: 渠道一致性校验脚本 + 同城演示 seed + API 文档

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## 自检记录（写计划时已核）

- **规格覆盖（M1 范围）**：迁移（Task 1）、`channel` 贯通 categories/products/cart/orders（Task 2/3/7）、`product-channel.ts`（Task 2）、`local-settings.ts` 含 `isOpenNow/paused/haversine/calcLocalFee/quoteToken`（Task 4）、`/local/meta|quote`（Task 5）、`createOrder` LOCAL 分支绕开全局运费（Task 7）、`cancel-request`（Task 7）、后台分类/商品渠道 Tab 与 `LocalSettings.tsx`（Task 8）、商家端一键定位（Task 9）、`.env.example`、一致性脚本、e2e（Task 10）。规格 §9 M1 条目全部有任务对应。
- **未纳入本计划（属 M2/M2b/M3）**：`Delivery/DeliveryEvent/PrintJob` 的业务逻辑、快递100 客户端与回调、同城看板与工作台、42221 退款前置校验（依赖 Delivery）、小程序顾客端页面、隐私弹窗与 `chooseLocation`。`cancel-request` 的 `cancelRequestDeliveryStatus` 在 M1 恒为 `NONE`，M2 改为快照有效配送单状态。
- **类型一致性**：`latE6/lngE6` 命名贯穿 schema、addresses、local-settings、quote、admin types、miniapp；`Channel` 类型在 server `utils/channel.ts` 与 admin `types.ts` 各自定义但值域一致；`quoteToken` 字段名在 quote 响应与 createOrder 请求一致；`localPendingCount` 在 server 与 admin 类型一致。
- **e2e 段号**：新增 19–23 段插入在第 18 段之后、清理段（脚本里编号 11）之前；清理段追加了所有新建资源的删除。
