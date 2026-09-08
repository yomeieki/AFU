# 全国邮寄接快递100 · 批次二（预约取件 / 回调 / 状态联动 / 工作台）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 店员在工作台为邮寄订单「预约快递员上门取件」（选快递、改重量、选时段），快递100 的回调把订单推到「已发货」并发发货通知；取消/改约/失败/取消申请/退款前置/定时提醒/未知单对账全部闭环；顾客端订单详情看到预约与快递员状态。

**Architecture:** 照同城 `Delivery` 那套骨架平行搭：`ExpressBooking` + `ExpressBookingEvent` 两张表、`express-booking-state.ts`（状态白名单与快递100 状态映射）、`kd100-express.ts` 扩 `bOrder/cancel/modifyOrder/detail/synPay` + 回调验签、`express-booking.ts`（编排：建单/取消/改约/作废/对账）、`express-callback.ts` + `routes/kd-express-callback.ts`、`express-booking-tasks.ts`（提醒/对账）、后台 `routes/admin/express.ts` + 工作台弹窗、顾客端详情视图。批次一的 `express-settings` / `express-quote(-service)` / `kd100-client` / `express-mock` 全部复用。

**Tech Stack:** 同批次一：Node 20 + Express + Prisma(MySQL) + zod；后台 React + Tailwind + Workbench.css；小程序原生 ES5；`scripts/selftest-*.ts` + `scripts/e2e.sh` + `scripts/e2e.d/*.sh`。

**设计依据：** `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md` §4.2–§9、§11–§13；调研 `docs/research/2026-09-08-kuaidi100-merchant-shipping-api.md` §3。批次一落地事实见 `docs/superpowers/plans/2026-09-08-express-shipping-batch1-quote.md` 与 `.superpowers/sdd/progress.md`。

## Global Constraints

- 金额「分」、重量「克」落库；接口层 `weightKg` 一位小数。
- 快递100 上门取件：`POST https://poll.kuaidi100.com/order/borderapi.do`（`config.kd100Express.apiUrl`），`method=bOrder|cancel|modifyOrder|detail|synPay`；签名 `MD5(param+t+key+secret)`；回调 POST form `param`(JSON)+`sign=MD5(param+salt)`，我们必须回 `{"result":true,"returnCode":"200","message":"成功"}`，否则重推 2 次。`callBackUrl` ≤ 200 字节。`thirdOrderId` = 我们的 `bookingNo`。
- 回调状态码（`data.status`）：0 下单成功 / 1 已接单 / 2 收件中 / 10 已取件 / 11 揽货失败 / 12 已退回 / 13 已签收 / 14 异常签收 / 15 已结算 / 155 修改重量 / 166 订单复活 / 9 用户取消 / 99 订单取消 / 101 运输中 / 400 派送中 / 200 已出单 / 201 出单失败 / 610 下单失败。
- 预约记录状态：`PENDING`(占位) → `BOOKED` → `ACCEPTED` → `PICKED` → `DELIVERED`；分支 `CANCELLED` / `FAILED` / `UNKNOWN` / `VOID`。活跃 = `BOOKED/ACCEPTED/UNKNOWN`（`activeOrderId` 非空，唯一索引保证一单同时最多一条）。
- 订单联动只在两处：`PICKED` → `Order.SHIPPED` + `Shipment` 写公司/单号/`shippedAt` + 发货订阅消息；`DELIVERED` → `Order.COMPLETED`（仅当 SHIPPED）。其余不动订单状态。
- 新错误码（4226x 段，批次一用了 42260–42262）：`42263` 有取件预约请先取消、`42264` 有活跃预约不能手填发货、`42265` 已有取件预约、`42266` 有待处理的取消申请、`42267` 预约状态不允许该操作（含 UNKNOWN 待核对）、`42268` 快递100 请求超时状态未变、`42269` 时段不合规。
- 时段规则：`dayType` ∈ 今天/明天/后天；`HH:mm`；`end − start ≥ 60` 分钟；今天的时段要求 `now < end − 2h`；顺丰必填时段，其余家可留空（留空则不传）。
- 顾客取消窗口：EXPRESS 单接单后 `expressSettings.acceptGraceMin` 分钟内可 `cancel-request`（与同城同流程），店员同意 = 先取消预约（若有）再全额退款；超时自动驳回沿用同城任务，按渠道各自读宽限分钟数。
- 同城 LOCAL 代码路径**零行为变化**：`Delivery` 表、`orchestrator/callback/tasks` 不改；共用函数抽取只允许纯搬运。
- 生产 mock 守卫沿用 `EXPRESS_PROVIDER_MOCK`；回调限流触发时回 **503**（不是 200 成功形状）。
- 每个任务结束 `cd apps/server && npx tsc --noEmit` 0 错误；全量 e2e `DB_NAME=food_shop_e2e bash scripts/e2e.sh` 失败 0，通过数只增不减（批次一收尾 1288）。
- 提交信息中文一句话；正文末尾空行 + `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 模型分工

| 角色 | 模型 | 在本计划里 |
|---|---|---|
| 规划 | fable | 本文 |
| 执行 | sonnet | Task 1–8 每个一个 fresh subagent |
| 复核 / 对抗验证 | opus | 每个任务合并前一次；Task 8 整批终审 |
| 机械核对 | haiku | Task 8 的文档/断言计数核对 |

## 文件结构

新建：
- `apps/server/prisma/migrations/20260913000000_express_bookings/migration.sql`
- `apps/server/src/services/delivery/express-booking-state.ts` — 状态 rank/终态/快递100 状态映射/标签
- `apps/server/src/services/delivery/express-booking.ts` — 编排：报价给弹窗、建单、取消、改约、作废、对账、活跃查询
- `apps/server/src/services/delivery/express-callback.ts` — 回调处理（验签/去重/状态推进/订单联动/费用）
- `apps/server/src/services/delivery/express-booking-tasks.ts` — 定时：无人接单、时段过未取件、UNKNOWN 对账
- `apps/server/src/services/delivery/express-events.ts` — 事件留痕（去重键、写事件）
- `apps/server/src/routes/kd-express-callback.ts` — `POST /api/kd-express/:bookingNo`
- `apps/server/src/routes/admin/express.ts` — `/api/admin/express/orders/:id/*`
- `apps/server/scripts/selftest-express-booking.ts`
- `scripts/e2e.d/58-express-booking.sh`、`59-express-callback.sh`、`60-express-guards.sh`
- `apps/admin/src/components/ExpressBookingModal.tsx`

修改：
- `apps/server/prisma/schema.prisma` — 两张新表 + `Order.expressBookings`
- `apps/server/src/services/delivery/kd100-express.ts` — 五个新方法 + 回调验签 + provider 接口扩展
- `apps/server/src/services/delivery/express-mock.ts` — 新指令与调用记录、salt 查询
- `apps/server/src/routes/admin/express-mock.ts` — `salt/:bookingNo`、`queue` 支持 op
- `apps/server/src/middlewares/rate-limit.ts` — `kdExpressCallbackLimiter`（503）
- `apps/server/src/app.ts` — 挂 `/api/kd-express`
- `apps/server/src/routes/admin/index.ts` — 挂 `/express/orders`
- `apps/server/src/services/refund.ts` — 42263 前置
- `apps/server/src/routes/admin/orders.ts` — `/ship` 42264；详情 select 带 bookings
- `apps/server/src/routes/orders.ts` — `cancelWindowOf` 支持 EXPRESS；`cancel-request` 快照预约状态；详情下发 `expressBooking` + `cancelGraceMin`
- `apps/server/src/routes/admin/delivery.ts` — 取消申请驳回抽成共用函数并放开 EXPRESS
- `apps/server/src/services/scheduler.ts` — 新任务 + overrides；`autoRejectStaleCancelRequests`/`remindCancelRequestPending` 按渠道取宽限
- `apps/server/src/services/order-notify.ts` — `notifyExpressAlert`
- `apps/server/src/routes/admin/workbench.ts` — express 卡片带预约/取消申请
- `apps/admin/src/types.ts`、`api/admin.ts`、`pages/Workbench.tsx`、`components/CancelAndRefundModal.tsx`、`components/CancelDeliveryModal`（在 Workbench.tsx 内）
- `apps/miniapp/pages/order/detail.{js,wxml,wxss}`
- `scripts/nginx.conf`、`docs/deployment.md`、`docs/api.md`、`docs/staff-guide.md`

---

### Task 1: 预约表 + 状态机模块 + 迁移

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（在 `model Delivery` 之前插入两张表；`Order` 加 `expressBookings ExpressBooking[]`）
- Create: `apps/server/prisma/migrations/20260913000000_express_bookings/migration.sql`
- Create: `apps/server/src/services/delivery/express-booking-state.ts`
- Create: `apps/server/src/services/delivery/express-events.ts`
- Test: `apps/server/scripts/selftest-express-booking.ts`（本任务只写状态机部分，后续任务追加）

**Interfaces:**
- Produces:
  - Prisma `ExpressBooking`、`ExpressBookingEvent`
  - `BOOKING_RANK: Record<string, number>`（PENDING 0 / UNKNOWN 5 / BOOKED 10 / ACCEPTED 20 / PICKED 30 / DELIVERED 100）
  - `BOOKING_TERMINAL = ['DELIVERED','CANCELLED','FAILED','VOID'] as const`
  - `BOOKING_ACTIVE = ['BOOKED','ACCEPTED','UNKNOWN'] as const`
  - `BOOKING_STATUS_LABEL: Record<string,string>`
  - `KD_EXPRESS_STATUS_MAP: Record<string, RankEntry | SideEntry>`，`RankEntry { type:'rank'; status; rank; stamp?: 'acceptedAt'|'pickedAt'|'deliveredAt' }`，`SideEntry { type:'side'; kind:'CANCELLED'|'FAILED'|'FEE'|'ALERT'|'IGNORE'; label: string }`
  - `canTransition(from: string, to: string): boolean`
  - `makeExpressDedupeKey(bookingNo, providerStatus, rawBody): string`、`recordBookingEvent(db, input): Promise<{duplicate:boolean}>`、`adminBookingEventKey()`
- Consumes: 无。

- [ ] **Step 1: 自测先失败** — 新建 `apps/server/scripts/selftest-express-booking.ts`

```ts
/**
 * 邮寄预约状态机与协议自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts
 */
import assert from 'assert'
import { BOOKING_RANK, BOOKING_TERMINAL, BOOKING_ACTIVE, KD_EXPRESS_STATUS_MAP, canTransition, BOOKING_STATUS_LABEL } from '../src/services/delivery/express-booking-state'
import { makeExpressDedupeKey } from '../src/services/delivery/express-events'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

t('rank 单调：PENDING<UNKNOWN<BOOKED<ACCEPTED<PICKED<DELIVERED', () => {
  const r = BOOKING_RANK
  assert.ok(r.PENDING < r.UNKNOWN && r.UNKNOWN < r.BOOKED && r.BOOKED < r.ACCEPTED && r.ACCEPTED < r.PICKED && r.PICKED < r.DELIVERED)
  assert.deepStrictEqual([...BOOKING_TERMINAL], ['DELIVERED', 'CANCELLED', 'FAILED', 'VOID'])
  assert.deepStrictEqual([...BOOKING_ACTIVE], ['BOOKED', 'ACCEPTED', 'UNKNOWN'])
})
t('canTransition：只允许前进与终态化；终态后一律拒', () => {
  assert.ok(canTransition('BOOKED', 'ACCEPTED')); assert.ok(canTransition('BOOKED', 'PICKED')); assert.ok(canTransition('ACCEPTED', 'PICKED'))
  assert.ok(canTransition('PICKED', 'DELIVERED')); assert.ok(canTransition('BOOKED', 'CANCELLED')); assert.ok(canTransition('ACCEPTED', 'FAILED'))
  assert.ok(canTransition('UNKNOWN', 'BOOKED')); assert.ok(canTransition('UNKNOWN', 'VOID')); assert.ok(canTransition('PENDING', 'UNKNOWN'))
  assert.ok(!canTransition('PICKED', 'ACCEPTED')); assert.ok(!canTransition('ACCEPTED', 'BOOKED'))
  for (const term of BOOKING_TERMINAL) for (const to of ['BOOKED', 'ACCEPTED', 'PICKED', 'DELIVERED', 'CANCELLED']) assert.ok(!canTransition(term, to), `${term}->${to}`)
  assert.ok(!canTransition('PICKED', 'CANCELLED'), '取件后不能再被回调取消')
})
t('快递100 状态映射', () => {
  const m = KD_EXPRESS_STATUS_MAP
  assert.deepStrictEqual(m['0'], { type: 'rank', status: 'BOOKED', rank: 10 })
  assert.deepStrictEqual(m['1'], { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' })
  assert.deepStrictEqual(m['2'], { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' })
  assert.deepStrictEqual(m['10'], { type: 'rank', status: 'PICKED', rank: 30, stamp: 'pickedAt' })
  assert.deepStrictEqual(m['13'], { type: 'rank', status: 'DELIVERED', rank: 100, stamp: 'deliveredAt' })
  assert.strictEqual(m['11'].type, 'side'); assert.strictEqual((m['11'] as { kind: string }).kind, 'FAILED')
  assert.strictEqual((m['610'] as { kind: string }).kind, 'FAILED')
  assert.strictEqual((m['9'] as { kind: string }).kind, 'CANCELLED'); assert.strictEqual((m['99'] as { kind: string }).kind, 'CANCELLED')
  assert.strictEqual((m['15'] as { kind: string }).kind, 'FEE'); assert.strictEqual((m['155'] as { kind: string }).kind, 'FEE')
  for (const s of ['101', '400', '200', '201']) assert.strictEqual((m[s] as { kind: string }).kind, 'IGNORE', s)
  for (const s of ['12', '14', '166']) assert.strictEqual((m[s] as { kind: string }).kind, 'ALERT', s)
  assert.strictEqual(m['999'], undefined)
  assert.strictEqual(BOOKING_STATUS_LABEL.BOOKED, '已预约·待接单')
})
t('去重键：同 bookingNo+status+同 body 相同；body 变则不同；≤64', () => {
  const a = makeExpressDedupeKey('E12-1', '10', '{"a":1}'), b = makeExpressDedupeKey('E12-1', '10', '{"a":1}'), c = makeExpressDedupeKey('E12-1', '10', '{"a":2}')
  assert.strictEqual(a, b); assert.notStrictEqual(a, c); assert.ok(a.length <= 64); assert.ok(a.startsWith('CB:E12-1:10:'))
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
```
Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts` → Expected: `Cannot find module '../src/services/delivery/express-booking-state'`

- [ ] **Step 2: `express-booking-state.ts`**

```ts
/**
 * 邮寄取件预约的状态机：rank 单调推进 + 终态化；快递100「上门取件」回调状态 → 本地状态的映射。
 * 与同城 delivery/state.ts 平行，互不引用。
 * 状态：PENDING(占位，未外呼完成) → BOOKED → ACCEPTED → PICKED → DELIVERED；
 *       分支 CANCELLED / FAILED / UNKNOWN(外呼超时，等对账或回调认领) / VOID(对账确认无单)。
 */
export const BOOKING_RANK: Record<string, number> = { PENDING: 0, UNKNOWN: 5, BOOKED: 10, ACCEPTED: 20, PICKED: 30, DELIVERED: 100 }
export const BOOKING_TERMINAL = ['DELIVERED', 'CANCELLED', 'FAILED', 'VOID'] as const
export const BOOKING_ACTIVE = ['BOOKED', 'ACCEPTED', 'UNKNOWN'] as const

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  PENDING: '预约中', UNKNOWN: '待核对', BOOKED: '已预约·待接单', ACCEPTED: '快递员已接单', PICKED: '已取件',
  DELIVERED: '已签收', CANCELLED: '已取消', FAILED: '预约失败', VOID: '已作废',
}

export interface RankEntry { type: 'rank'; status: 'BOOKED' | 'ACCEPTED' | 'PICKED' | 'DELIVERED'; rank: number; stamp?: 'acceptedAt' | 'pickedAt' | 'deliveredAt' }
export interface SideEntry { type: 'side'; kind: 'CANCELLED' | 'FAILED' | 'FEE' | 'ALERT' | 'IGNORE'; label: string }

/** 快递100 上门取件回调 data.status → 本地动作（docs/research/2026-09-08 §3.2） */
export const KD_EXPRESS_STATUS_MAP: Record<string, RankEntry | SideEntry> = {
  '0': { type: 'rank', status: 'BOOKED', rank: 10 },
  '1': { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' },
  '2': { type: 'rank', status: 'ACCEPTED', rank: 20, stamp: 'acceptedAt' },
  '10': { type: 'rank', status: 'PICKED', rank: 30, stamp: 'pickedAt' },
  '13': { type: 'rank', status: 'DELIVERED', rank: 100, stamp: 'deliveredAt' },
  '11': { type: 'side', kind: 'FAILED', label: '揽货失败' },
  '610': { type: 'side', kind: 'FAILED', label: '下单失败' },
  '9': { type: 'side', kind: 'CANCELLED', label: '用户取消' },
  '99': { type: 'side', kind: 'CANCELLED', label: '订单取消' },
  '15': { type: 'side', kind: 'FEE', label: '已结算' },
  '155': { type: 'side', kind: 'FEE', label: '修改重量' },
  '101': { type: 'side', kind: 'IGNORE', label: '运输中' },
  '400': { type: 'side', kind: 'IGNORE', label: '派送中' },
  '200': { type: 'side', kind: 'IGNORE', label: '已出单' },
  '201': { type: 'side', kind: 'IGNORE', label: '出单失败' },
  '12': { type: 'side', kind: 'ALERT', label: '已退回' },
  '14': { type: 'side', kind: 'ALERT', label: '异常签收' },
  '166': { type: 'side', kind: 'ALERT', label: '订单复活' },
}

/** 白名单：终态不可再动；rank 只能前进；取件后不能被取消/失败；UNKNOWN 可认领为 BOOKED 或作废 */
export function canTransition(from: string, to: string): boolean {
  if ((BOOKING_TERMINAL as readonly string[]).includes(from)) return false
  if (to === 'VOID') return from === 'UNKNOWN'
  if (to === 'CANCELLED' || to === 'FAILED') return from === 'PENDING' || from === 'UNKNOWN' || from === 'BOOKED' || from === 'ACCEPTED'
  if (to === 'UNKNOWN') return from === 'PENDING'
  const a = BOOKING_RANK[from], b = BOOKING_RANK[to]
  if (a === undefined || b === undefined) return false
  return b > a
}
```

- [ ] **Step 3: `express-events.ts`**

```ts
/** 预约事件留痕。与 delivery/events.ts 平行（表不同、不复用）。 */
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'

type Db = Prisma.TransactionClient | typeof prisma
const md5hex = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')
export const truncStr = (s: string | null | undefined, n: number): string | null => (s == null ? null : String(s).slice(0, n))

export function makeExpressDedupeKey(bookingNo: string, providerStatus: string, rawBody: string): string {
  return `CB:${bookingNo}:${providerStatus}:${md5hex(rawBody)}`.slice(0, 64)
}
export function adminBookingEventKey(): string { return `ADM:${crypto.randomUUID()}`.slice(0, 64) }

export interface RecordBookingEventInput {
  bookingId: number; dedupeKey: string; source: 'CALLBACK' | 'ADMIN' | 'SYSTEM'
  providerStatus?: number | null; statusDesc?: string | null; courierName?: string | null; courierMobile?: string | null
  operator?: string | null; rawPayload?: Prisma.InputJsonValue | null
}
export async function recordBookingEvent(db: Db, i: RecordBookingEventInput): Promise<{ duplicate: boolean }> {
  try {
    await db.expressBookingEvent.create({ data: {
      bookingId: i.bookingId, dedupeKey: i.dedupeKey, source: i.source, providerStatus: i.providerStatus ?? null,
      statusDesc: truncStr(i.statusDesc, 255), courierName: truncStr(i.courierName, 64), courierMobile: truncStr(i.courierMobile, 20),
      operator: truncStr(i.operator, 64), rawPayload: i.rawPayload ?? undefined,
    } })
    return { duplicate: false }
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { duplicate: true }
    throw e
  }
}
```

- [ ] **Step 4: schema + migration**

`schema.prisma`：`Order` 的 `deliveries Delivery[]` 下加 `expressBookings ExpressBooking[]`。在 `model Delivery {` 之前插入：
```prisma
// ─────────────────────────────────────────────────────────
// 邮寄取件预约（快递100 上门取件）。一单可多条（取消后重约），活跃的同一时刻最多一条（activeOrderId 唯一）
// ─────────────────────────────────────────────────────────
model ExpressBooking {
  id                   Int       @id @default(autoincrement())
  orderId              Int       @map("order_id")
  orderNo              String    @map("order_no") @db.VarChar(32)
  bookingNo            String    @unique @map("booking_no") @db.VarChar(32)
  activeOrderId        Int?      @unique @map("active_order_id")
  kuaidicom            String    @db.VarChar(32)
  serviceType          String?   @map("service_type") @db.VarChar(32)
  status               String    @db.VarChar(16)
  statusRank           Int       @default(0) @map("status_rank")
  providerStatus       Int?      @map("provider_status")
  statusDesc           String?   @map("status_desc") @db.VarChar(255)
  taskId               String?   @unique @map("task_id") @db.VarChar(64)
  kdOrderId            String?   @map("kd_order_id") @db.VarChar(64)
  kuaidinum            String?   @db.VarChar(64)
  pollToken            String?   @map("poll_token") @db.VarChar(64)
  dayType              String?   @map("day_type") @db.VarChar(8)
  pickupDate           String?   @map("pickup_date") @db.VarChar(10)
  pickupStart          String?   @map("pickup_start") @db.VarChar(5)
  pickupEnd            String?   @map("pickup_end") @db.VarChar(5)
  weightG              Int       @map("weight_g")
  customerFeeFen       Int       @map("customer_fee_fen")
  quotedFeeFen         Int?      @map("quoted_fee_fen")
  prepaidFeeFen        Int?      @map("prepaid_fee_fen")
  settledFeeFen        Int?      @map("settled_fee_fen")
  billedWeightG        Int?      @map("billed_weight_g")
  feeDetails           Json?     @map("fee_details")
  courierName          String?   @map("courier_name") @db.VarChar(64)
  courierMobile        String?   @map("courier_mobile") @db.VarChar(20)
  callbackSalt         String    @map("callback_salt") @db.VarChar(40)
  remark               String?   @db.VarChar(64)
  errorCode            String?   @map("error_code") @db.VarChar(16)
  failReason           String?   @map("fail_reason") @db.VarChar(255)
  cancelledBy          String?   @map("cancelled_by") @db.VarChar(8)
  cancelReason         String?   @map("cancel_reason") @db.VarChar(255)
  trackJson            Json?     @map("track_json")
  trackStatus          String?   @map("track_status") @db.VarChar(16)
  trackUpdatedAt       DateTime? @map("track_updated_at")
  bookedAt             DateTime? @map("booked_at")
  acceptedAt           DateTime? @map("accepted_at")
  pickedAt             DateTime? @map("picked_at")
  deliveredAt          DateTime? @map("delivered_at")
  cancelledAt          DateTime? @map("cancelled_at")
  lastCallbackAt       DateTime? @map("last_callback_at")
  unacceptedRemindedAt DateTime? @map("unaccepted_reminded_at")
  unpickedRemindedAt   DateTime? @map("unpicked_reminded_at")
  unknownRemindedAt    DateTime? @map("unknown_reminded_at")
  costAlertedAt        DateTime? @map("cost_alerted_at")
  reconcileTries       Int       @default(0) @map("reconcile_tries")
  operator             String?   @db.VarChar(64)
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @updatedAt @map("updated_at")

  order  Order                 @relation(fields: [orderId], references: [id])
  events ExpressBookingEvent[]

  @@index([orderId])
  @@index([status, bookedAt])
  @@map("express_bookings")
}

model ExpressBookingEvent {
  id             Int      @id @default(autoincrement())
  bookingId      Int      @map("booking_id")
  dedupeKey      String   @unique @map("dedupe_key") @db.VarChar(64)
  source         String   @db.VarChar(16)
  providerStatus Int?     @map("provider_status")
  statusDesc     String?  @map("status_desc") @db.VarChar(255)
  courierName    String?  @map("courier_name") @db.VarChar(64)
  courierMobile  String?  @map("courier_mobile") @db.VarChar(20)
  operator       String?  @db.VarChar(64)
  rawPayload     Json?    @map("raw_payload")
  createdAt      DateTime @default(now()) @map("created_at")

  booking ExpressBooking @relation(fields: [bookingId], references: [id])

  @@index([bookingId, createdAt])
  @@map("express_booking_events")
}
```
`migrations/20260913000000_express_bookings/migration.sql`：
```sql
-- 邮寄取件预约两张新表。纯新增，回滚代码不需要回滚库。
CREATE TABLE `express_bookings` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `order_id` INT NOT NULL,
  `order_no` VARCHAR(32) NOT NULL,
  `booking_no` VARCHAR(32) NOT NULL,
  `active_order_id` INT NULL,
  `kuaidicom` VARCHAR(32) NOT NULL,
  `service_type` VARCHAR(32) NULL,
  `status` VARCHAR(16) NOT NULL,
  `status_rank` INT NOT NULL DEFAULT 0,
  `provider_status` INT NULL,
  `status_desc` VARCHAR(255) NULL,
  `task_id` VARCHAR(64) NULL,
  `kd_order_id` VARCHAR(64) NULL,
  `kuaidinum` VARCHAR(64) NULL,
  `poll_token` VARCHAR(64) NULL,
  `day_type` VARCHAR(8) NULL,
  `pickup_date` VARCHAR(10) NULL,
  `pickup_start` VARCHAR(5) NULL,
  `pickup_end` VARCHAR(5) NULL,
  `weight_g` INT NOT NULL,
  `customer_fee_fen` INT NOT NULL,
  `quoted_fee_fen` INT NULL,
  `prepaid_fee_fen` INT NULL,
  `settled_fee_fen` INT NULL,
  `billed_weight_g` INT NULL,
  `fee_details` JSON NULL,
  `courier_name` VARCHAR(64) NULL,
  `courier_mobile` VARCHAR(20) NULL,
  `callback_salt` VARCHAR(40) NOT NULL,
  `remark` VARCHAR(64) NULL,
  `error_code` VARCHAR(16) NULL,
  `fail_reason` VARCHAR(255) NULL,
  `cancelled_by` VARCHAR(8) NULL,
  `cancel_reason` VARCHAR(255) NULL,
  `track_json` JSON NULL,
  `track_status` VARCHAR(16) NULL,
  `track_updated_at` DATETIME(3) NULL,
  `booked_at` DATETIME(3) NULL,
  `accepted_at` DATETIME(3) NULL,
  `picked_at` DATETIME(3) NULL,
  `delivered_at` DATETIME(3) NULL,
  `cancelled_at` DATETIME(3) NULL,
  `last_callback_at` DATETIME(3) NULL,
  `unaccepted_reminded_at` DATETIME(3) NULL,
  `unpicked_reminded_at` DATETIME(3) NULL,
  `unknown_reminded_at` DATETIME(3) NULL,
  `cost_alerted_at` DATETIME(3) NULL,
  `reconcile_tries` INT NOT NULL DEFAULT 0,
  `operator` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `express_bookings_booking_no_key`(`booking_no`),
  UNIQUE INDEX `express_bookings_active_order_id_key`(`active_order_id`),
  UNIQUE INDEX `express_bookings_task_id_key`(`task_id`),
  INDEX `express_bookings_order_id_idx`(`order_id`),
  INDEX `express_bookings_status_booked_at_idx`(`status`, `booked_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `express_booking_events` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `booking_id` INT NOT NULL,
  `dedupe_key` VARCHAR(64) NOT NULL,
  `source` VARCHAR(16) NOT NULL,
  `provider_status` INT NULL,
  `status_desc` VARCHAR(255) NULL,
  `courier_name` VARCHAR(64) NULL,
  `courier_mobile` VARCHAR(20) NULL,
  `operator` VARCHAR(64) NULL,
  `raw_payload` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `express_booking_events_dedupe_key_key`(`dedupe_key`),
  INDEX `express_booking_events_booking_id_created_at_idx`(`booking_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `express_bookings` ADD CONSTRAINT `express_bookings_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `express_booking_events` ADD CONSTRAINT `express_booking_events_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `express_bookings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
```
（照 `prisma/migrations/` 里 `deliveries` 那条迁移的写法核对 FK 与索引命名；若 `npx prisma migrate diff --from-migrations ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --shadow-database-url ...` 不可用，就 `npx prisma migrate deploy` 后用 `npx prisma db pull --print` 对比列名。）

```bash
cd apps/server && npx prisma migrate deploy && npx prisma generate
```

- [ ] **Step 5: 自测 + 编译**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts && npx tsc --noEmit
```
Expected: `通过 4 条`；tsc 无输出。

- [ ] **Step 6: 提交**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260913000000_express_bookings apps/server/src/services/delivery/express-booking-state.ts apps/server/src/services/delivery/express-events.ts apps/server/scripts/selftest-express-booking.ts
git commit -m "邮寄取件预约：两张表与迁移、状态机白名单、快递100 状态映射、事件留痕"
```

**复核（opus）要点**：`canTransition` 对 PICKED→CANCELLED 拒（取件后只能走售后）；`activeOrderId` 唯一索引；迁移 FK/索引名与 Prisma 生成规则一致（否则下次 `migrate dev` 会想改名）；`KD_EXPRESS_STATUS_MAP` 与调研 §3.2 表逐行对得上。

---

### Task 2: 快递100 上门取件协议扩展（bOrder / cancel / modifyOrder / detail / synPay / 回调验签）+ mock

**Files:**
- Modify: `apps/server/src/services/delivery/kd100-express.ts`
- Modify: `apps/server/src/services/delivery/express-mock.ts`
- Modify: `apps/server/src/routes/admin/express-mock.ts`
- Test: `apps/server/scripts/selftest-express-booking.ts`（追加协议用例）

**Interfaces:**
- Produces（`kd100-express.ts`）：
  ```ts
  export interface ExpressParty { name: string; mobile: string; addr: string }
  export interface ExpressBookInput {
    bookingNo: string; kuaidicom: string; serviceType?: string | null
    sender: ExpressParty; receiver: ExpressParty
    cargo: string; weightKg: number; remark?: string | null
    dayType?: string | null; pickupStart?: string | null; pickupEnd?: string | null
    callbackUrl: string; salt: string; timeoutMs?: number
  }
  export interface ExpressBookResult { taskId: string | null; kdOrderId: string | null; kuaidinum: string | null; pollToken: string | null }
  export interface ExpressDetailResult {
    found: boolean; status: number | null; taskId: string | null; kdOrderId: string | null; kuaidinum: string | null
    courierName: string | null; courierMobile: string | null; freightFen: number | null; raw: unknown
  }
  export interface ExpressCallbackPayload {
    status: string; taskId: string | null; kdOrderId: string | null; kuaidinum: string | null
    courierName: string | null; courierMobile: string | null
    weightKg: number | null; freightFen: number | null; defPriceFen: number | null; feeDetails: unknown
    statusDesc: string | null; raw: Record<string, unknown>
  }
  export interface ExpressPriceProvider {   // 扩展批次一的接口，名字不变
    name: 'KD100' | 'MOCK'
    batchPrice(input: ExpressBatchPriceInput): Promise<CourierQuote[]>
    book(input: ExpressBookInput): Promise<ExpressBookResult>
    cancel(input: { taskId: string | null; kdOrderId: string | null; reason: string; timeoutMs?: number }): Promise<void>
    modify(input: { taskId: string | null; kdOrderId: string | null; dayType: string; pickupStart: string | null; pickupEnd: string | null }): Promise<void>
    detail(input: { taskId: string | null; thirdOrderId: string }): Promise<ExpressDetailResult>
    synPay(input: { kdOrderId: string }): Promise<void>
    verifyAndParseCallback(body: Record<string, string>, salt: string): { ok: true; payload: ExpressCallbackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' }
  }
  export function _buildBookParam(i: ExpressBookInput): Record<string, unknown>
  export function _parseBook(data: unknown): ExpressBookResult
  export function _parseDetail(data: unknown): ExpressDetailResult
  export function _parseCallbackParam(p: Record<string, unknown>): ExpressCallbackPayload
  ```
- Produces（mock）：`ExpressMockOp = 'batchPrice'|'book'|'cancel'|'modify'|'detail'|'synPay'`；`queueExpressDirective(d, op = 'batchPrice')`；`getExpressCalls(op?)` 返回 `{ op, input, at }[]`；`resetExpressMock()`；directive 联合类型见下。
- Produces（admin mock 路由）：`POST /queue { op?, directive }`、`GET /calls?op=`、`GET /salt/:bookingNo`（读 `express_bookings.callback_salt`）。
- Consumes：`postKd100`、`config.kd100Express`、`CourierQuote`。

- [ ] **Step 1: 自测先失败** — 在 `selftest-express-booking.ts` 顶部 import 加：

```ts
import { _buildBookParam, _parseBook, _parseDetail, _parseCallbackParam, kd100ExpressProvider } from '../src/services/delivery/kd100-express'
import { expressMockProvider, queueExpressDirective, resetExpressMock, getExpressCalls } from '../src/services/delivery/express-mock'
import crypto from 'crypto'
import { ProviderError } from '../src/services/delivery/types'
```
并在 `console.log` 汇总行之前追加（把 `t` 改成也接受 async：`function t(name, fn: () => void | Promise<void>)` 用 `Promise.resolve().then(fn)` 链式记数，同 selftest-kd100-express 的写法；整份文件末尾用 `main()` 包起来）：

```ts
t('bOrder param：必填字段齐全、时段只在给了才传、顺丰 serviceType 透传、thirdOrderId=bookingNo', () => {
  const p = _buildBookParam({
    bookingNo: 'E12-1', kuaidicom: 'shunfeng', serviceType: '顺丰特快',
    sender: { name: '阿福凉菜', mobile: '15309003232', addr: '四川省自贡市自流井区丹桂街道丹桂40栋底楼' },
    receiver: { name: '客', mobile: '13800000000', addr: '北京市朝阳区建国路93号' },
    cargo: '食品', weightKg: 1.5, remark: '食品请勿重压', dayType: '今天', pickupStart: '14:00', pickupEnd: '16:00',
    callbackUrl: 'http://x/api/kd-express/E12-1', salt: 'saltsaltsaltsalt',
  })
  assert.strictEqual(p.kuaidicom, 'shunfeng'); assert.strictEqual(p.serviceType, '顺丰特快'); assert.strictEqual(p.cargo, '食品')
  assert.strictEqual(p.weight, '1.5'); assert.strictEqual(p.dayType, '今天'); assert.strictEqual(p.pickupStartTime, '14:00'); assert.strictEqual(p.pickupEndTime, '16:00')
  assert.strictEqual(p.callBackUrl, 'http://x/api/kd-express/E12-1'); assert.strictEqual(p.salt, 'saltsaltsaltsalt'); assert.strictEqual(p.thirdOrderId, 'E12-1')
  assert.strictEqual(p.recManPrintAddr, '北京市朝阳区建国路93号'); assert.strictEqual(p.sendManName, '阿福凉菜'); assert.strictEqual(p.payment, 'SHIPPER')
  const q = _buildBookParam({ bookingNo: 'E1-1', kuaidicom: 'jtexpress', sender: { name: 'a', mobile: '1', addr: 'x' }, receiver: { name: 'b', mobile: '2', addr: 'y' }, cargo: '食品', weightKg: 1, callbackUrl: 'u', salt: 's' })
  assert.ok(!('dayType' in q) && !('pickupStartTime' in q) && !('serviceType' in q))
})
t('解析下单响应：字段缺省为 null（韵达异步无单号）', () => {
  assert.deepStrictEqual(_parseBook({ taskId: 'T1', orderId: 'O1', kuaidinum: 'JD001', pollToken: 'pt' }), { taskId: 'T1', kdOrderId: 'O1', kuaidinum: 'JD001', pollToken: 'pt' })
  assert.deepStrictEqual(_parseBook({ taskId: 'T2', orderId: 'O2' }), { taskId: 'T2', kdOrderId: 'O2', kuaidinum: null, pollToken: null })
  assert.deepStrictEqual(_parseBook(null), { taskId: null, kdOrderId: null, kuaidinum: null, pollToken: null })
})
t('解析查单：空/非对象=未找到；有 status 就是找到', () => {
  assert.strictEqual(_parseDetail(null).found, false); assert.strictEqual(_parseDetail({}).found, false)
  const d = _parseDetail({ taskId: 'T', orderId: 'O', kuaidiNum: 'N', status: 1, courierName: '张', courierMobile: '138', freight: '8.30' })
  assert.deepStrictEqual({ ...d, raw: undefined }, { found: true, status: 1, taskId: 'T', kdOrderId: 'O', kuaidinum: 'N', courierName: '张', courierMobile: '138', freightFen: 830, raw: undefined })
})
t('回调 param 解析：顶层与 data 两层都读，费用元→分', () => {
  const p = _parseCallbackParam({ status: 10, kuaidinum: 'N1', data: { orderId: 'O1', status: 10, courierName: '李', courierMobile: '139', weight: '1.6', freight: '8.30', defPrice: '10.00', feeDetails: [{ feeType: 1 }] } })
  assert.strictEqual(p.status, '10'); assert.strictEqual(p.kuaidinum, 'N1'); assert.strictEqual(p.kdOrderId, 'O1')
  assert.strictEqual(p.courierName, '李'); assert.strictEqual(p.weightKg, 1.6); assert.strictEqual(p.freightFen, 830); assert.strictEqual(p.defPriceFen, 1000)
  assert.deepStrictEqual(p.feeDetails, [{ feeType: 1 }])
  const q = _parseCallbackParam({ data: { status: '1' } })
  assert.strictEqual(q.status, '1'); assert.strictEqual(q.kuaidinum, null)
})
t('回调验签：正确通过、篡改失败、多字节 sign 不抛、缺 param 报 BAD_PARAM', () => {
  const salt = 'abcdef0123456789'
  const param = JSON.stringify({ status: 10, data: { status: 10 } })
  const sign = crypto.createHash('md5').update(param + salt, 'utf8').digest('hex').toUpperCase()
  const ok = kd100ExpressProvider.verifyAndParseCallback({ param, sign }, salt)
  assert.ok(ok.ok && ok.payload.status === '10')
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ param, sign: sign.slice(0, 31) + '0' }, salt), { ok: false, reason: 'SIGN_MISMATCH' })
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ param, sign: '中文中文中文中文中文中文中文中文' }, salt), { ok: false, reason: 'SIGN_MISMATCH' })
  assert.deepStrictEqual(kd100ExpressProvider.verifyAndParseCallback({ sign }, salt), { ok: false, reason: 'BAD_PARAM' })
  assert.strictEqual(kd100ExpressProvider.verifyAndParseCallback({ param, sign: sign.toLowerCase() }, salt).ok, true)
})
await t('mock：book 默认成功返 taskId/kdOrderId/单号（韵达单号为空）；指令 timeout/error；calls 按 op 过滤', async () => {
  resetExpressMock()
  const base = { bookingNo: 'E1-1', sender: { name: 'a', mobile: '1', addr: 'x' }, receiver: { name: 'b', mobile: '2', addr: 'y' }, cargo: '食品', weightKg: 1, callbackUrl: 'u', salt: 's' }
  const r = await expressMockProvider.book({ ...base, kuaidicom: 'jd' })
  assert.ok(r.taskId && r.kdOrderId && r.kuaidinum && r.kuaidinum.startsWith('JD'))
  const y = await expressMockProvider.book({ ...base, bookingNo: 'E1-2', kuaidicom: 'yunda' })
  assert.strictEqual(y.kuaidinum, null)
  queueExpressDirective({ kind: 'timeout' }, 'book')
  await assert.rejects(() => expressMockProvider.book({ ...base, kuaidicom: 'jd' }), (e: unknown) => e instanceof ProviderError && e.kind === 'TIMEOUT')
  queueExpressDirective({ kind: 'error', code: '500', message: '下单失败:该区域暂时不开放' }, 'book')
  await assert.rejects(() => expressMockProvider.book({ ...base, kuaidicom: 'jd' }), (e: unknown) => e instanceof ProviderError && e.kind === 'BUSINESS' && /该区域/.test(e.message))
  assert.strictEqual(getExpressCalls('book').length, 4); assert.strictEqual(getExpressCalls('batchPrice').length, 0)
  await expressMockProvider.cancel({ taskId: r.taskId, kdOrderId: r.kdOrderId, reason: 'x' })
  queueExpressDirective({ kind: 'error', code: '500', message: '订单已揽收，无法取消' }, 'cancel')
  await assert.rejects(() => expressMockProvider.cancel({ taskId: r.taskId, kdOrderId: r.kdOrderId, reason: 'x' }), /已揽收/)
  const d0 = await expressMockProvider.detail({ taskId: null, thirdOrderId: 'E9-9' })
  assert.strictEqual(d0.found, false)
  queueExpressDirective({ kind: 'ok', found: true, status: 1, kuaidinum: 'N9', taskId: 'T9', kdOrderId: 'O9' }, 'detail')
  const d1 = await expressMockProvider.detail({ taskId: null, thirdOrderId: 'E9-9' })
  assert.ok(d1.found && d1.status === 1 && d1.kuaidinum === 'N9')
})
```
Run → Expected: `has no exported member '_buildBookParam'`（编译期）或 `_buildBookParam is not a function`。

- [ ] **Step 2: 扩展 `kd100-express.ts`**

在文件里追加（保留批次一的全部内容；`ExpressPriceProvider` 接口原地扩展；`import crypto from 'crypto'`）：

```ts
export interface ExpressParty { name: string; mobile: string; addr: string }
export interface ExpressBookInput {
  bookingNo: string; kuaidicom: string; serviceType?: string | null
  sender: ExpressParty; receiver: ExpressParty
  cargo: string; weightKg: number; remark?: string | null
  dayType?: string | null; pickupStart?: string | null; pickupEnd?: string | null
  callbackUrl: string; salt: string; timeoutMs?: number
}
export interface ExpressBookResult { taskId: string | null; kdOrderId: string | null; kuaidinum: string | null; pollToken: string | null }
export interface ExpressDetailResult {
  found: boolean; status: number | null; taskId: string | null; kdOrderId: string | null; kuaidinum: string | null
  courierName: string | null; courierMobile: string | null; freightFen: number | null; raw: unknown
}
export interface ExpressCallbackPayload {
  status: string; taskId: string | null; kdOrderId: string | null; kuaidinum: string | null
  courierName: string | null; courierMobile: string | null
  weightKg: number | null; freightFen: number | null; defPriceFen: number | null; feeDetails: unknown
  statusDesc: string | null; raw: Record<string, unknown>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const numOrNull = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

/** bOrder 参数（docs/research §3.1）。时段/业务类型只在给了才传：顺丰必填，其它家留空表示「随时」 */
export function _buildBookParam(i: ExpressBookInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    kuaidicom: i.kuaidicom,
    recManName: i.receiver.name, recManMobile: i.receiver.mobile, recManPrintAddr: i.receiver.addr,
    sendManName: i.sender.name, sendManMobile: i.sender.mobile, sendManPrintAddr: i.sender.addr,
    callBackUrl: i.callbackUrl, salt: i.salt, thirdOrderId: i.bookingNo,
    cargo: i.cargo, weight: i.weightKg.toFixed(1), payment: 'SHIPPER',
  }
  if (i.serviceType) p.serviceType = i.serviceType
  if (i.remark) p.remark = i.remark
  if (i.dayType) p.dayType = i.dayType
  if (i.pickupStart) p.pickupStartTime = i.pickupStart
  if (i.pickupEnd) p.pickupEndTime = i.pickupEnd
  return p
}
export function _parseBook(data: unknown): ExpressBookResult {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return { taskId: str(d.taskId), kdOrderId: str(d.orderId), kuaidinum: str(d.kuaidinum ?? d.kuaidiNum), pollToken: str(d.pollToken) }
}
export function _parseDetail(data: unknown): ExpressDetailResult {
  const d = (data && typeof data === 'object' && !Array.isArray(data) ? data : {}) as Record<string, unknown>
  const status = numOrNull(d.status)
  if (status === null && !str(d.taskId) && !str(d.orderId)) return { found: false, status: null, taskId: null, kdOrderId: null, kuaidinum: null, courierName: null, courierMobile: null, freightFen: null, raw: data }
  const fr = numOrNull(d.freight)
  return { found: true, status, taskId: str(d.taskId), kdOrderId: str(d.orderId), kuaidinum: str(d.kuaidiNum ?? d.kuaidinum), courierName: str(d.courierName), courierMobile: str(d.courierMobile), freightFen: fr === null ? null : Math.round(fr * 100), raw: data }
}
/** 回调 param：文档把状态既放顶层 status 又放 data.status，单号/快递员在 data 里为主、顶层为辅，两层都读 */
export function _parseCallbackParam(p: Record<string, unknown>): ExpressCallbackPayload {
  const d = (p.data && typeof p.data === 'object' ? p.data : {}) as Record<string, unknown>
  const w = numOrNull(d.weight), fr = numOrNull(d.freight), def = numOrNull(d.defPrice)
  return {
    status: String(d.status ?? p.status ?? ''),
    taskId: str(p.taskId ?? d.taskId), kdOrderId: str(d.orderId ?? p.orderId), kuaidinum: str(p.kuaidinum ?? d.kuaidinum ?? d.kuaidiNum),
    courierName: str(d.courierName ?? p.courierName), courierMobile: str(d.courierMobile ?? p.courierMobile),
    weightKg: w, freightFen: fr === null ? null : Math.round(fr * 100), defPriceFen: def === null ? null : Math.round(def * 100),
    feeDetails: d.feeDetails ?? null, statusDesc: str(p.message ?? d.statusDesc ?? d.message), raw: p,
  }
}

async function call(method: string, param: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS) {
  validateKd100ExpressConfig()
  return postKd100({ url: config.kd100Express.apiUrl, method, param, key: config.kd100Express.key, secret: config.kd100Express.secret, timeoutMs, mapReturnCode: (code, message) => _mapExpressReturnCode(code, message) })
}
```
把 `kd100ExpressProvider` 对象补全（`batchPrice` 保留原实现）：
```ts
export const kd100ExpressProvider: ExpressPriceProvider = {
  name: 'KD100',
  async batchPrice(input) { /* 原实现不变 */ },
  async book(input) { const r = await call('bOrder', _buildBookParam(input), input.timeoutMs ?? 15000); return _parseBook(r.data) },
  async cancel(input) { await call('cancel', { taskId: input.taskId ?? '', orderId: input.kdOrderId ?? '', cancelMsg: input.reason.slice(0, 30) }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS) },
  async modify(input) {
    const p: Record<string, unknown> = { taskId: input.taskId ?? '', orderId: input.kdOrderId ?? '', dayType: input.dayType }
    if (input.pickupStart) p.pickupStartTime = input.pickupStart
    if (input.pickupEnd) p.pickupEndTime = input.pickupEnd
    await call('modifyOrder', p)
  },
  async detail(input) {
    const p: Record<string, unknown> = { thirdOrderId: input.thirdOrderId }
    if (input.taskId) p.taskId = input.taskId
    const r = await call('detail', p)
    return _parseDetail(r.data)
  },
  async synPay(input) { await call('synPay', { orderId: input.kdOrderId }) },
  verifyAndParseCallback(body, salt) {
    const paramStr = body.param, sign = body.sign
    if (typeof paramStr !== 'string' || !paramStr || typeof sign !== 'string') return { ok: false, reason: 'BAD_PARAM' }
    const expect = md5U(paramStr + salt), got = sign.toUpperCase()
    if (Buffer.byteLength(got) !== Buffer.byteLength(expect)) return { ok: false, reason: 'SIGN_MISMATCH' }
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return { ok: false, reason: 'SIGN_MISMATCH' }
    let p: Record<string, unknown>
    try { p = JSON.parse(paramStr) as Record<string, unknown> } catch { return { ok: false, reason: 'BAD_PARAM' } }
    if (!p || typeof p !== 'object') return { ok: false, reason: 'BAD_PARAM' }
    return { ok: true, payload: _parseCallbackParam(p) }
  },
}
```
`ExpressPriceProvider` 接口按 Interfaces 块扩展（方法签名逐字）。`detail` 的查询键：文档只写了 `taskId`，`thirdOrderId` 是否被接受**未验证**（spec §14）——两个都传，测试环境验证后若不支持，UNKNOWN 对账退回人工（Task 5 的对账任务据 `found=false` 且 `taskId` 为空时**不作废**，只提醒）。

- [ ] **Step 3: 扩展 `express-mock.ts`**

```ts
export type ExpressMockOp = 'batchPrice' | 'book' | 'cancel' | 'modify' | 'detail' | 'synPay'
export type ExpressMockDirective =
  | { kind: 'ok'; quotes?: CourierQuote[]; taskId?: string; kdOrderId?: string; kuaidinum?: string | null; found?: boolean; status?: number; courierName?: string; courierMobile?: string }
  | { kind: 'timeout' }
  | { kind: 'error'; code: string; message?: string }

const queues = new Map<ExpressMockOp, ExpressMockDirective[]>()
const calls: { op: ExpressMockOp; input: unknown; at: string }[] = []
let seq = 0
const procTag = Date.now().toString(36)

export function queueExpressDirective(d: ExpressMockDirective, op: ExpressMockOp = 'batchPrice'): void {
  if (!queues.has(op)) queues.set(op, [])
  queues.get(op)!.push(d)
}
export function getExpressCalls(op?: ExpressMockOp) { return op ? calls.filter((c) => c.op === op) : [...calls] }
export function resetExpressMock(): void { queues.clear(); calls.length = 0 }

function take(op: ExpressMockOp, input: unknown): ExpressMockDirective {
  calls.push({ op, input, at: new Date().toISOString() })
  const d = queues.get(op)?.shift() ?? { kind: 'ok' as const }
  if (d.kind === 'timeout') throw new ProviderError('TIMEOUT', 'TIMEOUT', `mock ${op} 超时`)
  if (d.kind === 'error') throw new ProviderError(d.code === '503' || d.code === '600' || d.code === '601' ? 'CONFIG' : /余额/.test(d.message ?? '') ? 'BALANCE' : 'BUSINESS', d.code, d.message ?? `mock ${op} 错误`)
  return d
}
```
`expressMockProvider` 改成：
```ts
export const expressMockProvider: ExpressPriceProvider = {
  name: 'MOCK',
  async batchPrice(input) { const d = take('batchPrice', input); return d.kind === 'ok' && d.quotes ? d.quotes : defaultQuotes(input) },
  async book(input) {
    const d = take('book', input) as Extract<ExpressMockDirective, { kind: 'ok' }>
    seq++
    const n = `${procTag}-${seq}`
    // 韵达异步出单：默认不返单号，等回调 0 再给——让「单号异步」这条路径可测
    const kuaidinum = d.kuaidinum !== undefined ? d.kuaidinum : input.kuaidicom === 'yunda' ? null : `${input.kuaidicom.toUpperCase()}${n}`
    return { taskId: d.taskId ?? `MOCKX-${n}`, kdOrderId: d.kdOrderId ?? `KDX-${n}`, kuaidinum, pollToken: `pt-${n}` }
  },
  async cancel(input) { take('cancel', input) },
  async modify(input) { take('modify', input) },
  async detail(input) {
    const d = take('detail', input) as Extract<ExpressMockDirective, { kind: 'ok' }>
    if (!d.found) return { found: false, status: null, taskId: null, kdOrderId: null, kuaidinum: null, courierName: null, courierMobile: null, freightFen: null, raw: null }
    return { found: true, status: d.status ?? 0, taskId: d.taskId ?? null, kdOrderId: d.kdOrderId ?? null, kuaidinum: d.kuaidinum ?? null, courierName: d.courierName ?? null, courierMobile: d.courierMobile ?? null, freightFen: null, raw: d }
  },
  async synPay(input) { take('synPay', input) },
  verifyAndParseCallback(body, salt) { return kd100ExpressProvider.verifyAndParseCallback(body, salt) },
}
```
（`kd100ExpressProvider` 需从 `./kd100-express` 以值导入——会形成运行时环：`kd100-express` 已 import `expressMockProvider`。解法：把验签实现放到 `kd100-express.ts` 的独立导出函数 `verifyExpressCallbackSignature(body, salt)`，两个 provider 都调它，而 mock 只 `import type` 类型 + 用 `require` 延迟？——**不要**用 require。正确做法：新建 `services/delivery/express-callback-sign.ts` 放 `verifyAndParseExpressCallback(body, salt)`（含 `_parseCallbackParam`），`kd100-express.ts` 与 `express-mock.ts` 都从它 import；`_parseCallbackParam` 从那里 re-export。）

- [ ] **Step 4: admin mock 路由**

`routes/admin/express-mock.ts`：
```ts
import prisma from '../../utils/prisma'
// POST /queue — { op?: ExpressMockOp, directive }
router.post('/queue', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { op?: string; directive?: ExpressMockDirective }
    const op = (body.op ?? 'batchPrice') as ExpressMockOp
    if (!['batchPrice', 'book', 'cancel', 'modify', 'detail', 'synPay'].includes(op)) throw new AppError(40000, '无效 op', 400)
    const d = body.directive
    if (!d || !['ok', 'timeout', 'error'].includes(d.kind)) throw new AppError(40000, '无效指令', 400)
    if (d.kind === 'error' && (typeof d.code !== 'string' || !d.code)) throw new AppError(40000, 'error 指令需要 code', 400)
    if (d.kind === 'ok' && d.quotes !== undefined && !Array.isArray(d.quotes)) throw new AppError(40000, 'quotes 需为数组', 400)
    queueExpressDirective(d, op); success(res, {})
  } catch (e) { next(e) }
})
// GET /calls?op=book
router.get('/calls', async (req, res, next) => { try { success(res, getExpressCalls(req.query.op as ExpressMockOp | undefined)) } catch (e) { next(e) } })
// GET /salt/:bookingNo — e2e 构造合法回调用
router.get('/salt/:bookingNo', async (req, res, next) => {
  try {
    const b = await prisma.expressBooking.findUnique({ where: { bookingNo: String(req.params.bookingNo) }, select: { callbackSalt: true } })
    if (!b) throw new AppError(40401, '预约不存在', 404)
    success(res, { salt: b.callbackSalt })
  } catch (e) { next(e) }
})
```

- [ ] **Step 5: 自测 + 编译 + 同城/批次一自测回归**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts && npx ts-node --transpile-only scripts/selftest-kd100-express.ts | tail -1 && npx tsc --noEmit
```
Expected: 新自测 `通过 10 条`；kd100-express 自测仍全 ✔；tsc 无输出。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/delivery/kd100-express.ts apps/server/src/services/delivery/express-mock.ts apps/server/src/services/delivery/express-callback-sign.ts apps/server/src/routes/admin/express-mock.ts apps/server/scripts/selftest-express-booking.ts
git commit -m "快递100 上门取件协议：bOrder/cancel/modifyOrder/detail/synPay 与回调验签，mock 扩到六个 op"
```

**复核（opus）要点**：`_buildBookParam` 不传空时段；`cancelMsg` ≤ 30 字；`verifyAndParseCallback` 对多字节 sign 先按字节长度筛；mock 与真实 provider 共用同一份验签实现（无运行时 import 环，`import type` 之外只允许对 `express-callback-sign.ts` 的值导入）；`detail` 同时传 `taskId` 与 `thirdOrderId`。

---

### Task 3: 预约编排 `express-booking.ts` + 后台接口 `/api/admin/express/orders/:id/*` + e2e §58

**Files:**
- Create: `apps/server/src/services/delivery/express-booking.ts`
- Modify: `apps/server/src/services/order-notify.ts`（加 `notifyExpressAlert`）
- Create: `apps/server/src/routes/admin/express.ts`；Modify: `apps/server/src/routes/admin/index.ts`（挂载 `/express/orders`）
- Create: `scripts/e2e.d/58-express-booking.sh`
- Test: `apps/server/scripts/selftest-express-booking.ts`（追加时段校验/预填用例）

**Interfaces:**
- Produces（`express-booking.ts`）：
  ```ts
  export const BOOKING_QUOTE_STALE_MS = 2 * 60 * 60 * 1000
  export interface SlotInput { dayType: '今天' | '明天' | '后天'; pickupStart: string | null; pickupEnd: string | null }
  export function validateSlot(slot: SlotInput, kuaidicom: string, now?: Date): string | null   // 错误文案或 null
  export function suggestSlot(now?: Date): SlotInput
  export function pickupDateOf(dayType: SlotInput['dayType'], now?: Date): string   // 'YYYY-MM-DD' Asia/Shanghai
  export async function getActiveBooking(orderId: number)   // BOOKED/ACCEPTED/UNKNOWN 的那条或 null
  export async function getBookingQuotes(orderId: number, weightKg?: number): Promise<{ quotes: CourierQuote[]; weightKg: number; customerFeeFen: number; fromSnapshot: boolean; quotedAt: string | null }>
  export async function createBooking(i: { orderId: number; kuaidicom: string; serviceType?: string | null; weightKg?: number; slot: SlotInput; remark?: string | null; operator: string }): Promise<{ bookingId: number; bookingNo: string; status: 'BOOKED' | 'UNKNOWN'; kuaidinum: string | null }>
  export async function cancelBooking(i: { orderId: number; operator: string; reason?: string; by: 'STAFF' | 'CUSTOMER' }): Promise<void>
  export async function modifyBookingSlot(i: { orderId: number; slot: SlotInput; operator: string }): Promise<void>
  export async function voidUnknownBooking(i: { orderId: number; operator: string }): Promise<void>
  export async function reconcileUnknownBooking(bookingId: number): Promise<'CLAIMED' | 'STILL_UNKNOWN'>
  export function bookingView(b: ExpressBooking): BookingView   // 后台/顾客端共用的白名单视图（顾客端再裁）
  export interface BookingView { id; bookingNo; status; statusLabel; kuaidicom; courierLabel; serviceType; kuaidinum; dayType; pickupDate; pickupStart; pickupEnd; slotText; weightKg; customerFeeFen; quotedFeeFen; prepaidFeeFen; settledFeeFen; billedWeightG; courierName; courierMobile; failReason; cancelledBy; bookedAt; acceptedAt; pickedAt; deliveredAt; cancelledAt }
  ```
- Produces（HTTP，全部 `verifyAdminToken` 后）：
  - `GET /api/admin/express/orders/:id/booking` → `{ booking: BookingView | null, active: boolean, events: { id, source, providerStatus, statusDesc, courierName, operator, createdAt }[] }`
  - `GET /api/admin/express/orders/:id/quotes?weightKg=` → `getBookingQuotes` 结果 + `{ suggestedSlot: SlotInput, couriers: { code, label }[] }`
  - `POST /api/admin/express/orders/:id/book` Body `{ kuaidicom, serviceType?, weightKg?, dayType, pickupStart?, pickupEnd?, remark? }` → `createBooking` 结果
  - `POST /api/admin/express/orders/:id/booking/cancel` Body `{ reason? }`
  - `POST /api/admin/express/orders/:id/booking/modify` Body `{ dayType, pickupStart?, pickupEnd? }`
  - `POST /api/admin/express/orders/:id/booking/void`
- 新错误码（补进 Global Constraints）：`42270` 快递100 下单失败（原话）。
- Consumes：Task 1/2 全部；`getExpressSettings/findRegionGroup/COURIER_LABEL/EXPRESS_COURIERS`；`fetchCourierQuotes/MAX_ADDRESS_BYTES`；`getLocalSettings().store`；`shanghaiMinutes`（`local-settings.ts` 已导出）；`config.publicBaseUrl`。

- [ ] **Step 1: 自测先失败** — `selftest-express-booking.ts` 追加：

```ts
import { validateSlot, suggestSlot, pickupDateOf } from '../src/services/delivery/express-booking'
// 2026-09-09 10:00 上海 = 02:00Z
const T10 = new Date('2026-09-09T02:00:00Z')
const T19 = new Date('2026-09-09T11:00:00Z')   // 19:00 上海
t('时段校验：格式/间隔/截单/顺丰必填', () => {
  assert.strictEqual(validateSlot({ dayType: '今天', pickupStart: '14:00', pickupEnd: '16:00' }, 'jd', T10), null)
  assert.match(validateSlot({ dayType: '今天', pickupStart: '14:00', pickupEnd: '14:30' }, 'jd', T10)!, /1 小时/)
  assert.match(validateSlot({ dayType: '今天', pickupStart: '09:00', pickupEnd: '11:00' }, 'jd', T10)!, /2 小时/)   // 11:00 结束，现在 10:00 → 不足 2h
  assert.strictEqual(validateSlot({ dayType: '明天', pickupStart: '09:00', pickupEnd: '11:00' }, 'jd', T19), null)
  assert.match(validateSlot({ dayType: '今天', pickupStart: '9:00', pickupEnd: '11:00' }, 'jd', T10)!, /HH:mm/)
  assert.match(validateSlot({ dayType: '今天', pickupStart: null, pickupEnd: null }, 'shunfeng', T10)!, /顺丰/)
  assert.strictEqual(validateSlot({ dayType: '明天', pickupStart: null, pickupEnd: null }, 'jd', T10), null)
  assert.match(validateSlot({ dayType: '大后天' as never, pickupStart: null, pickupEnd: null }, 'jd', T10)!, /今天/)
})
t('预填：现在+2h 向上取整点起两小时；晚于 20:00 翻到明天 09:00–11:00', () => {
  assert.deepStrictEqual(suggestSlot(T10), { dayType: '今天', pickupStart: '12:00', pickupEnd: '14:00' })
  assert.deepStrictEqual(suggestSlot(new Date('2026-09-09T02:10:00Z')), { dayType: '今天', pickupStart: '13:00', pickupEnd: '15:00' })
  assert.deepStrictEqual(suggestSlot(T19), { dayType: '明天', pickupStart: '09:00', pickupEnd: '11:00' })
  assert.strictEqual(pickupDateOf('今天', T10), '2026-09-09'); assert.strictEqual(pickupDateOf('后天', T19), '2026-09-11')
})
```

- [ ] **Step 2: `order-notify.ts` 加 `notifyExpressAlert`**（放在 `notifyLocalDeliveryAlert` 之后，同款实现，只换前缀 `**📦 ${title}**`）

```ts
/** 邮寄取件预约告警（揽货失败/快递100 取消/下单失败/余额不足/超时未接单/时段过未取件/待核对） */
export function notifyExpressAlert(title: string, lines: string[], opts: { key?: string } = {}): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  let suppressedLine = ''
  if (opts.key) {
    const { send, suppressed } = shouldSendAlert(opts.key)
    if (!send) return
    if (suppressed > 0) suppressedLine = `\n> （期间抑制 ${suppressed} 次同类告警）`
  }
  const content = [`**📦 ${title}**`, ...lines.map((l) => `> ${l}`)].join('\n') + suppressedLine
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, title, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
```

- [ ] **Step 3: `express-booking.ts`**

```ts
/**
 * 邮寄取件预约的编排层（与同城 orchestrator.ts 平行）：建单 / 取消 / 改约 / 作废 / 对账 / 给弹窗报价。
 * 只在这里碰 express_bookings 的状态列；回调推进见 express-callback.ts。
 * 规则来源 spec §5.2–§5.4、§6。
 */
import crypto from 'crypto'
import { ExpressBooking, Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { config } from '../../config'
import { getExpressSettings, findRegionGroup, COURIER_LABEL, EXPRESS_COURIERS } from '../express-settings'
import { CourierQuote, calcPackageWeightKg } from '../express-quote'
import { fetchCourierQuotes, MAX_ADDRESS_BYTES } from '../express-quote-service'
import { getLocalSettings, shanghaiMinutes } from '../local-settings'
import { getExpressProvider } from './kd100-express'
import { ProviderError } from './types'
import { BOOKING_ACTIVE, BOOKING_RANK, BOOKING_STATUS_LABEL } from './express-booking-state'
import { recordBookingEvent, adminBookingEventKey, truncStr } from './express-events'
import { notifyExpressAlert } from '../order-notify'

export const BOOKING_QUOTE_STALE_MS = 2 * 60 * 60 * 1000
const DAY_TYPES = ['今天', '明天', '后天'] as const
export interface SlotInput { dayType: (typeof DAY_TYPES)[number]; pickupStart: string | null; pickupEnd: string | null }
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** 时段规则（spec §5.2 / 调研 §3.1）：≥1h；今天要 now < end−2h；顺丰必填；其它家可留空 */
export function validateSlot(slot: SlotInput, kuaidicom: string, now: Date = new Date()): string | null {
  if (!(DAY_TYPES as readonly string[]).includes(slot.dayType)) return '预约日期只能是今天、明天或后天'
  const s = slot.pickupStart, e = slot.pickupEnd
  if (!s && !e) return kuaidicom === 'shunfeng' ? '顺丰必须填写取件时段' : null
  if (!s || !e || !HHMM.test(s) || !HHMM.test(e)) return '取件时段请填 HH:mm（如 14:00）'
  if (toMin(e) - toMin(s) < 60) return '取件时段至少 1 小时'
  if (slot.dayType === '今天' && shanghaiMinutes(now) >= toMin(e) - 120) return '今天的时段须在结束前 2 小时预约，请改晚一点或约明天'
  return null
}
/** 预填：现在 + 2h 向上取整点为开始，结束 = 开始 + 2h；超过 20:00 就明天 09:00–11:00 */
export function suggestSlot(now: Date = new Date()): SlotInput {
  const start = Math.ceil((shanghaiMinutes(now) + 120) / 60) * 60
  if (start + 120 > 20 * 60) return { dayType: '明天', pickupStart: '09:00', pickupEnd: '11:00' }
  return { dayType: '今天', pickupStart: fromMin(start), pickupEnd: fromMin(start + 120) }
}
export function pickupDateOf(dayType: SlotInput['dayType'], now: Date = new Date()): string {
  const offset = DAY_TYPES.indexOf(dayType)
  const sh = new Date(now.getTime() + 8 * 3600 * 1000 + offset * 86400 * 1000)
  return sh.toISOString().slice(0, 10)
}

export async function getActiveBooking(orderId: number) {
  return prisma.expressBooking.findFirst({ where: { activeOrderId: orderId } })
}

export interface BookingView {
  id: number; bookingNo: string; status: string; statusLabel: string; kuaidicom: string; courierLabel: string; serviceType: string | null
  kuaidinum: string | null; dayType: string | null; pickupDate: string | null; pickupStart: string | null; pickupEnd: string | null; slotText: string
  weightKg: number; customerFeeFen: number; quotedFeeFen: number | null; prepaidFeeFen: number | null; settledFeeFen: number | null; billedWeightG: number | null
  courierName: string | null; courierMobile: string | null; failReason: string | null; cancelledBy: string | null
  bookedAt: string | null; acceptedAt: string | null; pickedAt: string | null; deliveredAt: string | null; cancelledAt: string | null
}
const iso = (d: Date | null) => (d ? d.toISOString() : null)
export function bookingView(b: ExpressBooking): BookingView {
  const date = b.pickupDate ? `${Number(b.pickupDate.slice(5, 7))}月${Number(b.pickupDate.slice(8, 10))}日` : ''
  const slotText = b.pickupStart && b.pickupEnd ? `${date} ${b.pickupStart}–${b.pickupEnd}` : date ? `${date} 时段不限` : ''
  return {
    id: b.id, bookingNo: b.bookingNo, status: b.status, statusLabel: BOOKING_STATUS_LABEL[b.status] ?? b.status,
    kuaidicom: b.kuaidicom, courierLabel: COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom, serviceType: b.serviceType,
    kuaidinum: b.kuaidinum, dayType: b.dayType, pickupDate: b.pickupDate, pickupStart: b.pickupStart, pickupEnd: b.pickupEnd, slotText,
    weightKg: b.weightG / 1000, customerFeeFen: b.customerFeeFen, quotedFeeFen: b.quotedFeeFen, prepaidFeeFen: b.prepaidFeeFen, settledFeeFen: b.settledFeeFen, billedWeightG: b.billedWeightG,
    courierName: b.courierName, courierMobile: b.courierMobile, failReason: b.failReason, cancelledBy: b.cancelledBy,
    bookedAt: iso(b.bookedAt), acceptedAt: iso(b.acceptedAt), pickedAt: iso(b.pickedAt), deliveredAt: iso(b.deliveredAt), cancelledAt: iso(b.cancelledAt),
  }
}

async function loadExpressOrder(orderId: number) {
  const o = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { select: { productId: true, quantity: true, product: { select: { netWeightG: true } } } } } })
  if (!o) throw new AppError(40401, '订单不存在', 404)
  if (o.deliveryType !== 'EXPRESS') throw new AppError(42204, '仅邮寄订单可预约取件')
  return o
}
async function orderWeightKg(o: Awaited<ReturnType<typeof loadExpressOrder>>): Promise<number> {
  if (o.expressWeightG) return o.expressWeightG / 1000
  const s = await getExpressSettings()
  return calcPackageWeightKg(o.items.map((it) => ({ netWeightG: it.product.netWeightG, quantity: it.quantity })), s.weight)
}

/** 弹窗用：各家报价（快照 2 小时内且重量未变就复用，否则现查）+ 顾客付的运费 */
export async function getBookingQuotes(orderId: number, weightKg?: number) {
  const o = await loadExpressOrder(orderId)
  const s = await getExpressSettings()
  const w = weightKg ?? (await orderWeightKg(o))
  const snap = (o.expressQuoteSnapshot ?? null) as { quotes?: CourierQuote[]; weightKg?: number } | null
  const fresh = Date.now() - o.createdAt.getTime() < BOOKING_QUOTE_STALE_MS
  if (snap?.quotes?.length && snap.weightKg === w && fresh) {
    return { quotes: snap.quotes, weightKg: w, customerFeeFen: o.shippingFee, fromSnapshot: true, quotedAt: o.createdAt.toISOString() }
  }
  const live = (await fetchCourierQuotes(s, 0, o.receiverFullAddress, w)) ?? []
  return { quotes: live, weightKg: w, customerFeeFen: o.shippingFee, fromSnapshot: false, quotedAt: new Date().toISOString() }
}

export async function createBooking(i: { orderId: number; kuaidicom: string; serviceType?: string | null; weightKg?: number; slot: SlotInput; remark?: string | null; operator: string }) {
  const o = await loadExpressOrder(i.orderId)
  if (o.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${o.status}，仅备货中订单可预约取件`)
  if (o.cancelRequestedAt) throw new AppError(42266, '顾客有待处理的取消申请，请先处理再预约')
  if (!(EXPRESS_COURIERS as readonly string[]).includes(i.kuaidicom)) throw new AppError(40001, '不支持的快递公司')
  const s = await getExpressSettings()
  const group = findRegionGroup(s, o.receiverProvince)
  if (group.blocked) throw new AppError(42260, '该地区暂不支持邮寄')
  if (Buffer.byteLength(o.receiverFullAddress, 'utf8') > MAX_ADDRESS_BYTES) throw new AppError(42262, '收货地址过长，请精简后再试')
  const slotErr = validateSlot(i.slot, i.kuaidicom)
  if (slotErr) throw new AppError(42269, slotErr)
  if (await getActiveBooking(i.orderId)) throw new AppError(42265, '该订单已有取件预约，请先取消再重约')
  const weightKg = Math.max(0.1, Math.round((i.weightKg ?? (await orderWeightKg(o))) * 10) / 10)
  const q = await getBookingQuotes(i.orderId, weightKg)
  const quoted = q.quotes.find((x) => x.kuaidicom === i.kuaidicom)?.priceFen ?? null

  const seq = (await prisma.expressBooking.count({ where: { orderId: i.orderId } })) + 1
  const bookingNo = `E${i.orderId}-${seq}`
  const callbackUrl = `${config.publicBaseUrl}/api/kd-express/${bookingNo}`
  if (Buffer.byteLength(callbackUrl) > 200) throw new AppError(42225, `回调地址超长（${callbackUrl.length}>200），请联系管理员`)
  const callbackSalt = crypto.randomBytes(16).toString('hex')
  let row: ExpressBooking
  try {
    row = await prisma.expressBooking.create({ data: {
      orderId: i.orderId, orderNo: o.orderNo, bookingNo, activeOrderId: i.orderId, kuaidicom: i.kuaidicom, serviceType: i.serviceType ?? null,
      status: 'PENDING', statusRank: BOOKING_RANK.PENDING, dayType: i.slot.dayType, pickupDate: pickupDateOf(i.slot.dayType),
      pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd, weightG: Math.round(weightKg * 1000),
      customerFeeFen: o.shippingFee, quotedFeeFen: quoted, callbackSalt, remark: truncStr(i.remark ?? s.pickup.defaultRemark, 64), operator: truncStr(i.operator, 64),
    } })
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new AppError(42265, '该订单已有取件预约，请先取消再重约')
    throw e
  }
  const store = (await getLocalSettings()).store
  try {
    const r = await getExpressProvider().book({
      bookingNo, kuaidicom: i.kuaidicom, serviceType: i.serviceType ?? null,
      sender: { name: store.name, mobile: store.phone, addr: `${store.province}${store.city}${store.district}${store.address}` },
      receiver: { name: o.receiverName, mobile: o.receiverPhone, addr: o.receiverFullAddress },
      cargo: s.pickup.cargoName, weightKg, remark: row.remark, dayType: i.slot.dayType, pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd,
      callbackUrl, salt: callbackSalt,
    })
    await prisma.$transaction(async (tx) => {
      await tx.expressBooking.update({ where: { id: row.id }, data: { status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED, bookedAt: new Date(), taskId: r.taskId, kdOrderId: r.kdOrderId, kuaidinum: r.kuaidinum, pollToken: r.pollToken } })
      await recordBookingEvent(tx, { bookingId: row.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: `预约成功 ${COURIER_LABEL[i.kuaidicom] ?? i.kuaidicom}${r.kuaidinum ? ` 单号 ${r.kuaidinum}` : '（单号待回调）'}`, operator: i.operator })
      // 单号一到就写 Shipment（不写 shippedAt、不改订单状态——那是「已取件」回调的事）
      if (r.kuaidinum) {
        await tx.shipment.upsert({ where: { orderId: i.orderId }, update: { expressCompany: COURIER_LABEL[i.kuaidicom] ?? i.kuaidicom, expressNo: r.kuaidinum }, create: { orderId: i.orderId, orderNo: o.orderNo, deliveryType: 'EXPRESS', expressCompany: COURIER_LABEL[i.kuaidicom] ?? i.kuaidicom, expressNo: r.kuaidinum } })
      }
    })
    return { bookingId: row.id, bookingNo, status: 'BOOKED' as const, kuaidinum: r.kuaidinum }
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') {
      // 下单可能已成功：占位改 UNKNOWN、不释放，等回调认领或对账任务 detail 认领/人工作废
      await prisma.expressBooking.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'UNKNOWN', statusRank: BOOKING_RANK.UNKNOWN, bookedAt: new Date(), errorCode: truncStr(e.code, 16), failReason: truncStr(e.message, 255) } })
      return { bookingId: row.id, bookingNo, status: 'UNKNOWN' as const, kuaidinum: null }
    }
    const msg = e instanceof ProviderError ? e.message : (e as Error).message
    await prisma.expressBooking.updateMany({ where: { id: row.id, status: 'PENDING' }, data: { status: 'FAILED', activeOrderId: null, errorCode: truncStr(e instanceof ProviderError ? e.code : 'ERR', 16), failReason: truncStr(msg, 255) } })
    if (e instanceof ProviderError && e.kind === 'BALANCE') notifyExpressAlert('快递100 余额不足，邮寄预约失败', [`订单 ${o.orderNo}`, msg, '请到快递100 企业后台充值'], { key: 'express:balance' })
    throw new AppError(42270, `快递100 下单失败：${msg}`)
  }
}

export async function cancelBooking(i: { orderId: number; operator: string; reason?: string; by: 'STAFF' | 'CUSTOMER' }): Promise<void> {
  const b = await getActiveBooking(i.orderId)
  if (!b) throw new AppError(42267, '没有可取消的取件预约')
  if (b.status === 'UNKNOWN') throw new AppError(42267, '预约状态未确认：请等系统核对，或确认快递100 后台无单后作废')
  const reason = (i.reason ?? (i.by === 'CUSTOMER' ? '顾客申请取消' : '店员取消')).slice(0, 30)
  try {
    await getExpressProvider().cancel({ taskId: b.taskId, kdOrderId: b.kdOrderId, reason })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42268, '取消请求超时，请稍后重试（状态未变化）')
    throw new AppError(42267, `快递100 拒绝取消：${(e as Error).message}`)
  }
  await prisma.$transaction(async (tx) => {
    await tx.expressBooking.updateMany({ where: { id: b.id, status: { in: ['BOOKED', 'ACCEPTED'] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelledBy: i.by, cancelReason: truncStr(reason, 255) } })
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: `取消预约（${reason}）`, operator: i.operator })
  })
}

export async function modifyBookingSlot(i: { orderId: number; slot: SlotInput; operator: string }): Promise<void> {
  const b = await getActiveBooking(i.orderId)
  if (!b || !['BOOKED', 'ACCEPTED'].includes(b.status)) throw new AppError(42267, '当前没有可改约的预约')
  const err = validateSlot(i.slot, b.kuaidicom)
  if (err) throw new AppError(42269, err)
  try {
    await getExpressProvider().modify({ taskId: b.taskId, kdOrderId: b.kdOrderId, dayType: i.slot.dayType, pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42268, '改约请求超时，请稍后重试（状态未变化）')
    throw new AppError(42267, `快递100 拒绝改约：${(e as Error).message}`)
  }
  await prisma.$transaction(async (tx) => {
    await tx.expressBooking.update({ where: { id: b.id }, data: { dayType: i.slot.dayType, pickupDate: pickupDateOf(i.slot.dayType), pickupStart: i.slot.pickupStart, pickupEnd: i.slot.pickupEnd, unpickedRemindedAt: null } })
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: `改约 ${i.slot.dayType} ${i.slot.pickupStart ?? ''}–${i.slot.pickupEnd ?? ''}`, operator: i.operator })
  })
}

export async function voidUnknownBooking(i: { orderId: number; operator: string }): Promise<void> {
  const b = await getActiveBooking(i.orderId)
  if (!b || b.status !== 'UNKNOWN') throw new AppError(42267, '仅「待核对」的预约可作废')
  await prisma.$transaction(async (tx) => {
    const moved = await tx.expressBooking.updateMany({ where: { id: b.id, status: 'UNKNOWN' }, data: { status: 'VOID', activeOrderId: null, cancelledAt: new Date(), cancelledBy: 'STAFF' } })
    if (moved.count === 0) throw new AppError(42267, '预约状态已变化，请刷新')
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'ADMIN', statusDesc: '人工作废（快递100 后台核对无单）', operator: i.operator })
  })
}

/**
 * UNKNOWN 对账：用 thirdOrderId 查 detail。查到 → 认领为 BOOKED（补 taskId/单号）；查不到只计数，
 * **不自动作废**——detail 按 thirdOrderId 查是否可用尚未在测试环境验证（spec §14），自动作废判错就是双单。
 */
export async function reconcileUnknownBooking(bookingId: number): Promise<'CLAIMED' | 'STILL_UNKNOWN'> {
  const b = await prisma.expressBooking.findUnique({ where: { id: bookingId } })
  if (!b || b.status !== 'UNKNOWN') return 'STILL_UNKNOWN'
  let d
  try { d = await getExpressProvider().detail({ taskId: b.taskId, thirdOrderId: b.bookingNo }) } catch { return 'STILL_UNKNOWN' }
  if (!d.found) { await prisma.expressBooking.update({ where: { id: b.id }, data: { reconcileTries: { increment: 1 } } }); return 'STILL_UNKNOWN' }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.expressBooking.updateMany({ where: { id: b.id, status: 'UNKNOWN' }, data: { status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED, taskId: d.taskId ?? b.taskId, kdOrderId: d.kdOrderId ?? b.kdOrderId, kuaidinum: d.kuaidinum ?? b.kuaidinum, courierName: d.courierName ?? undefined, courierMobile: d.courierMobile ?? undefined } })
    if (moved.count === 0) return
    await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: adminBookingEventKey(), source: 'SYSTEM', statusDesc: `对账认领：快递100 有单（status=${d.status ?? '?'}）` })
    if (d.kuaidinum) await tx.shipment.upsert({ where: { orderId: b.orderId }, update: { expressCompany: COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom, expressNo: d.kuaidinum }, create: { orderId: b.orderId, orderNo: b.orderNo, deliveryType: 'EXPRESS', expressCompany: COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom, expressNo: d.kuaidinum } })
  })
  return 'CLAIMED'
}
export const isActiveBookingStatus = (s: string) => (BOOKING_ACTIVE as readonly string[]).includes(s)
```

- [ ] **Step 4: `routes/admin/express.ts` 并挂载**

```ts
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { COURIER_LABEL, EXPRESS_COURIERS } from '../../services/express-settings'
import { getBookingQuotes, createBooking, cancelBooking, modifyBookingSlot, voidUnknownBooking, getActiveBooking, bookingView, suggestSlot, SlotInput } from '../../services/delivery/express-booking'

const router = Router()
const slotSchema = z.object({ dayType: z.enum(['今天', '明天', '后天']), pickupStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(), pickupEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional() })
const bookSchema = slotSchema.extend({
  kuaidicom: z.string().min(1).max(32), serviceType: z.string().max(32).nullable().optional(),
  weightKg: z.number().min(0.1).max(50).optional(), remark: z.string().max(64).nullable().optional(),
})
const toSlot = (b: z.infer<typeof slotSchema>): SlotInput => ({ dayType: b.dayType, pickupStart: b.pickupStart ?? null, pickupEnd: b.pickupEnd ?? null })

// GET /api/admin/express/orders/:id/booking — 最近一条预约 + 是否活跃 + 事件
router.get('/:id/booking', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const b = await prisma.expressBooking.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' }, include: { events: { orderBy: { createdAt: 'asc' }, select: { id: true, source: true, providerStatus: true, statusDesc: true, courierName: true, operator: true, createdAt: true } } } })
    success(res, { booking: b ? bookingView(b) : null, active: !!b && b.activeOrderId === id, events: b?.events ?? [] })
  } catch (e) { next(e) }
})
// GET /api/admin/express/orders/:id/quotes?weightKg=1.5 — 预约弹窗用
router.get('/:id/quotes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const w = req.query.weightKg !== undefined ? Number(req.query.weightKg) : undefined
    if (w !== undefined && !(w >= 0.1 && w <= 50)) throw new AppError(40001, '重量需在 0.1–50 kg')
    const q = await getBookingQuotes(id, w)
    success(res, { ...q, suggestedSlot: suggestSlot(), couriers: EXPRESS_COURIERS.map((c) => ({ code: c, label: COURIER_LABEL[c] })) })
  } catch (e) { next(e) }
})
router.post('/:id/book', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const b = bookSchema.parse(req.body ?? {})
    success(res, await createBooking({ orderId: id, kuaidicom: b.kuaidicom, serviceType: b.serviceType ?? null, weightKg: b.weightKg, slot: toSlot(b), remark: b.remark ?? null, operator: req.adminUsername ?? 'admin' }))
  } catch (e) { next(e) }
})
router.post('/:id/booking/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { reason } = z.object({ reason: z.string().max(30).optional() }).parse(req.body ?? {})
    await cancelBooking({ orderId: id, operator: req.adminUsername ?? 'admin', reason, by: 'STAFF' })
    success(res, {})
  } catch (e) { next(e) }
})
router.post('/:id/booking/modify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    await modifyBookingSlot({ orderId: id, slot: toSlot(slotSchema.parse(req.body ?? {})), operator: req.adminUsername ?? 'admin' })
    success(res, {})
  } catch (e) { next(e) }
})
router.post('/:id/booking/void', async (req: Request, res: Response, next: NextFunction) => {
  try { await voidUnknownBooking({ orderId: Number(req.params.id), operator: req.adminUsername ?? 'admin' }); success(res, {}) } catch (e) { next(e) }
})
export default router
```
`routes/admin/index.ts`：`import expressAdminRouter from './express'`，在 `router.use('/local/orders', deliveryRouter)` 之后加 `router.use('/express/orders', expressAdminRouter)`。

- [ ] **Step 5: e2e `scripts/e2e.d/58-express-booking.sh`**

```bash
echo "== 58. 邮寄预约取件：报价/建单/重复/时段/取消/超时未知/失败 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq/make_paid_order/order_status/sql 与 $AT/$UT/$PID/$ADDR。变量 X58_ 前缀。
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
x58_paid_preparing() { local o; o=$(make_paid_order); req POST "/api/admin/orders/$o/accept" "$AT" >/dev/null; echo "$o"; }
x58_bk() { req GET "/api/admin/express/orders/$1/booking" "$AT"; }

echo "-- ① 报价接口：各家价 + 预填时段 + 快递名单 --"
X58_O1=$(x58_paid_preparing)
R=$(req GET "/api/admin/express/orders/$X58_O1/quotes" "$AT")
assert_eq "quotes code 0" "$(code "$R")" "0"
assert_eq "9 家" "$(jq -r '.data.quotes|length' <<<"$R")" "9"
assert_eq "couriers 9 个" "$(jq -r '.data.couriers|length' <<<"$R")" "9"
[[ "$(jq -r '.data.suggestedSlot.dayType' <<<"$R")" =~ ^(今天|明天)$ ]] && ok "预填时段 dayType" || fail "预填时段" "$R"
assert_eq "顾客付的运费 = 订单 shippingFee" "$(jq -r .data.customerFeeFen <<<"$R")" "$(req GET "/api/admin/orders/$X58_O1" "$AT" | jq -r .data.shippingFee)"

echo "-- ② 时段校验 42269 --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"09:30"}'); assert_eq "间隔<1h 42269" "$(code "$R")" "42269"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"shunfeng","dayType":"明天"}'); assert_eq "顺丰缺时段 42269" "$(code "$R")" "42269"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"bogus","dayType":"明天"}'); assert_eq "未知快递 40001" "$(code "$R")" "40001"

echo "-- ③ 预约成功：BOOKED + 单号写入 Shipment，订单仍 PREPARING --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"11:00","weightKg":1.5,"remark":"轻拿轻放"}')
assert_eq "book code 0" "$(code "$R")" "0"
assert_eq "status BOOKED" "$(jq -r .data.status <<<"$R")" "BOOKED"
X58_BN1=$(jq -r .data.bookingNo <<<"$R"); [[ "$X58_BN1" == "E${X58_O1}-1" ]] && ok "bookingNo=E<orderId>-1" || fail "bookingNo" "$X58_BN1"
X58_NUM1=$(jq -r .data.kuaidinum <<<"$R"); [[ "$X58_NUM1" == JD* ]] && ok "京东同步返单号 $X58_NUM1" || fail "单号" "$R"
assert_eq "订单仍 PREPARING" "$(order_status $X58_O1)" "PREPARING"
assert_eq "Shipment 已写单号但 shippedAt 空" "$(sql "SELECT CONCAT(express_no, '|', IFNULL(shipped_at,'NULL')) FROM shipments WHERE order_id=$X58_O1;")" "${X58_NUM1}|NULL"
R=$(x58_bk "$X58_O1")
assert_eq "booking.active=true" "$(jq -r .data.active <<<"$R")" "true"
assert_eq "courierLabel 京东物流" "$(jq -r .data.booking.courierLabel <<<"$R")" "京东物流"
assert_eq "weightKg 1.5" "$(jq -r .data.booking.weightKg <<<"$R")" "1.5"
assert_eq "slotText 含 09:00–11:00" "$(jq -r '.data.booking.slotText|test("09:00–11:00")' <<<"$R")" "true"
assert_eq "事件 1 条（预约成功）" "$(jq -r '.data.events|length' <<<"$R")" "1"
assert_eq "mock book 收到 thirdOrderId=bookingNo" "$(req GET "/api/admin/system/express-mock/calls?op=book" "$AT" | jq -r '.data[-1].input.bookingNo')" "$X58_BN1"

echo "-- ④ 重复预约 42265；改约成功；取消成功回备货中 --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"11:00"}'); assert_eq "重复预约 42265" "$(code "$R")" "42265"
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/modify" "$AT" '{"dayType":"后天","pickupStart":"14:00","pickupEnd":"16:00"}'); assert_eq "改约 code 0" "$(code "$R")" "0"
assert_eq "改约后 dayType=后天" "$(x58_bk "$X58_O1" | jq -r .data.booking.dayType)" "后天"
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{"reason":"改天发"}'); assert_eq "取消 code 0" "$(code "$R")" "0"
R=$(x58_bk "$X58_O1")
assert_eq "取消后 CANCELLED" "$(jq -r .data.booking.status <<<"$R")" "CANCELLED"; assert_eq "active=false" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "cancelledBy STAFF" "$(jq -r .data.booking.cancelledBy <<<"$R")" "STAFF"
assert_eq "订单仍 PREPARING" "$(order_status $X58_O1)" "PREPARING"
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}'); assert_eq "没有活跃预约再取消 42267" "$(code "$R")" "42267"

echo "-- ⑤ 韵达异步：单号为空；序号 -2 --"
R=$(req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"yunda","dayType":"明天"}')
assert_eq "韵达 book code 0" "$(code "$R")" "0"; assert_eq "单号 null" "$(jq -r .data.kuaidinum <<<"$R")" "null"; assert_eq "bookingNo -2" "$(jq -r .data.bookingNo <<<"$R")" "E${X58_O1}-2"
req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}' >/dev/null

echo "-- ⑥ 快递100 取消被拒（已揽收）→ 42267 且状态不变 --"
req POST "/api/admin/express/orders/$X58_O1/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"cancel","directive":{"kind":"error","code":"500","message":"订单已揽收，无法取消"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}'); assert_eq "已揽收拒绝取消 42267" "$(code "$R")" "42267"
assert_eq "状态仍 BOOKED" "$(x58_bk "$X58_O1" | jq -r .data.booking.status)" "BOOKED"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"cancel","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}'); assert_eq "取消超时 42268" "$(code "$R")" "42268"
req POST "/api/admin/express/orders/$X58_O1/booking/cancel" "$AT" '{}' >/dev/null

echo "-- ⑦ 下单超时 → UNKNOWN（占活跃位），对账认领 / 人工作废 --"
X58_O2=$(x58_paid_preparing)
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}')
assert_eq "超时 code 0 且 status UNKNOWN" "$(jq -r .data.status <<<"$R")" "UNKNOWN"
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}'); assert_eq "UNKNOWN 占位时再约 42265" "$(code "$R")" "42265"
R=$(req POST "/api/admin/express/orders/$X58_O2/booking/cancel" "$AT" '{}'); assert_eq "UNKNOWN 不能直接取消 42267" "$(code "$R")" "42267"
R=$(req POST "/api/admin/express/orders/$X58_O2/booking/void" "$AT"); assert_eq "作废 code 0" "$(code "$R")" "0"
assert_eq "作废后 VOID 且不活跃" "$(x58_bk "$X58_O2" | jq -r '[.data.booking.status, (.data.active|tostring)]|join(",")')" "VOID,false"

echo "-- ⑧ 下单业务失败 → FAILED + 42270 原话，可再约 --"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"error","code":"500","message":"下单失败:该区域暂时不开放"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}')
assert_eq "业务失败 42270" "$(code "$R")" "42270"; assert_eq "带原话" "$(jq -r '.message|test("该区域暂时不开放")' <<<"$R")" "true"
assert_eq "记录为 FAILED" "$(x58_bk "$X58_O2" | jq -r .data.booking.status)" "FAILED"
R=$(req POST "/api/admin/express/orders/$X58_O2/book" "$AT" '{"kuaidicom":"jtexpress","dayType":"明天"}'); assert_eq "失败后可再约 code 0" "$(code "$R")" "0"
X58_KEEP_O2=$X58_O2   # 留给 §59 用（BOOKED，极兔）
X58_KEEP_O1=$X58_O1   # PREPARING，无活跃预约
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
```
`make_paid_order` 造的是 EXPRESS 单（`$ADDR` 四川成都），批次一之后它会走报价（e2e 开头把邮寄设置复位成 TABLE/0 元，运费 0）。`x58_paid_preparing` 需要 `accept` 端点：`POST /api/admin/orders/:id/accept`（既有）。

- [ ] **Step 6: 验证**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts && npx tsc --noEmit
DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tee /tmp/e2e-b2t3.log | tail -3
sed -n '/== 58\./,/== 24\./p' /tmp/e2e-b2t3.log | grep -c '✔'
```
Expected: 自测 `通过 12 条`；e2e 1288 + §58 条数（约 38）、失败 0。后端启动参数同批次一（`EXPRESS_PROVIDER_MOCK=true`）。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/services/delivery/express-booking.ts apps/server/src/services/order-notify.ts apps/server/src/routes/admin/express.ts apps/server/src/routes/admin/index.ts scripts/e2e.d/58-express-booking.sh apps/server/scripts/selftest-express-booking.ts
git commit -m "邮寄预约编排：报价/建单/取消/改约/作废/对账 + 后台 /express/orders 接口 + e2e 58"
```

**复核（opus）要点**：占位行 `PENDING` 带 `activeOrderId` 抢唯一索引（并发双预约只成功一个）；超时不释放（UNKNOWN 仍活跃）；业务失败释放；`cancelBooking` 先外呼成功再落库（顺序不能反）；`Shipment` 写单号但不写 `shippedAt`；`reconcileUnknownBooking` 查不到不作废（spec §5.3 的放宽要在 spec 里回改，Task 8）；`validateSlot` 用上海时间；`getBookingQuotes` 的 `fetchCourierQuotes(s, 0, …)` 缓存键 addressId=0 与顾客侧不撞（顾客侧 addressId ≥ 1）。

---

### Task 4: 回调 `POST /api/kd-express/:bookingNo` + 状态推进 + 订单联动 + e2e §59

**Files:**
- Create: `apps/server/src/services/delivery/express-callback.ts`
- Create: `apps/server/src/routes/kd-express-callback.ts`
- Modify: `apps/server/src/middlewares/rate-limit.ts`（`kdExpressCallbackLimiter`）
- Modify: `apps/server/src/app.ts`（`app.use('/api/kd-express', kdExpressCallbackRouter)` 紧跟 `/api/kd`）
- Modify: `scripts/nginx.conf`（加 `location /api/kd-express/`，与 `/api/kd/` 同配置）；`docs/deployment.md` nginx 段加一行
- Create: `scripts/e2e.d/59-express-callback.sh`

**Interfaces:**
- Produces：`handleExpressCallback(bookingNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }>`；`applyExpressStatus(tx, booking, payload, opts)` 内部函数（对账任务 Task 5 也用它推进状态 → 导出为 `applyProviderStatus(tx, bookingId, providerStatus, payload)`）。
- 联动：`PICKED` → 同事务 `Order.status='SHIPPED'`（where status in PAID/PREPARING）+ `Shipment` upsert（公司/单号/`shippedAt`）+ 事务外 `sendShipSubscribeMessage`；`DELIVERED` → `Order.status='COMPLETED', completedAt`（where SHIPPED）；`FAILED/CANCELLED` → `activeOrderId=null` + `notifyExpressAlert`（CANCELLED 且 `cancelledBy` 已是 STAFF 的尾随回调不再提醒）；`FEE`（15/155）→ `settledFeeFen/billedWeightG/feeDetails`，15 后调 `synPay`，实扣/预扣 > `costAlertRatio` 提醒一次（`costAlertedAt`）。
- Consumes：Task 1–3。

- [ ] **Step 1: e2e 先写** `scripts/e2e.d/59-express-callback.sh`

```bash
echo "== 59. 邮寄预约回调：验签/去重/乱序/接单/取件→已发货/结算/签收→完成/失败/取消 =="
# 复用主体 helper 与 §58 留下的 $X58_KEEP_O2（BOOKED，极兔）。变量 X59_ 前缀。
X59_CB=/tmp/e2e-xcb.json
x59_cb() { # bookingNo status [extraDataJson] → HTTP 码；响应体在 $X59_CB
  local bn="$1" st="$2" extra="${3:-{\}}" salt param sign
  salt=$(req GET "/api/admin/system/express-mock/salt/$bn" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg s "$st" --argjson x "$extra" '{status:($s|tonumber), kuaidinum:($x.kuaidinum // null), data:({status:($s|tonumber), orderId:"KDX-1"} + $x)}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$X59_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$bn" --data-urlencode "param=$param" --data-urlencode "sign=$sign"
}
x59_bk() { req GET "/api/admin/express/orders/$1/booking" "$AT"; }
X59_O=$X58_KEEP_O2
X59_BN=$(x59_bk "$X59_O" | jq -r .data.booking.bookingNo)
assert_eq "起点 BOOKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "BOOKED"

echo "-- ① 验签失败 → 200 ack 但状态不变；未知 bookingNo → 200 --"
X59_P='{"status":1,"data":{"status":1}}'
HTTPC=$(curl -s -o "$X59_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$X59_BN" --data-urlencode "param=$X59_P" --data-urlencode "sign=DEADBEEF")
assert_eq "验签失败 HTTP 200" "$HTTPC" "200"; assert_eq "仍 BOOKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "BOOKED"
HTTPC=$(curl -s -o "$X59_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/E999999-9" --data-urlencode "param=$X59_P" --data-urlencode "sign=DEADBEEF"); assert_eq "未知单号 200" "$HTTPC" "200"

echo "-- ② 1 已接单 → ACCEPTED + 快递员；重复推送去重；乱序 0 不回退 --"
HTTPC=$(x59_cb "$X59_BN" 1 '{"courierName":"张师傅","courierMobile":"13811112222"}'); assert_eq "回调 1 HTTP 200" "$HTTPC" "200"
assert_eq "ack 形状 result=true" "$(jq -r .result "$X59_CB")" "true"
R=$(x59_bk "$X59_O"); assert_eq "ACCEPTED" "$(jq -r .data.booking.status <<<"$R")" "ACCEPTED"; assert_eq "快递员" "$(jq -r .data.booking.courierName <<<"$R")" "张师傅"
X59_EV=$(jq -r '.data.events|length' <<<"$R")
x59_cb "$X59_BN" 1 '{"courierName":"张师傅","courierMobile":"13811112222"}' >/dev/null
assert_eq "同一条重推：事件数不变" "$(x59_bk "$X59_O" | jq -r '.data.events|length')" "$X59_EV"
x59_cb "$X59_BN" 0 '{"kuaidinum":"JT-LATE"}' >/dev/null
assert_eq "乱序 0 不回退" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "ACCEPTED"
assert_eq "订单仍 PREPARING" "$(order_status $X59_O)" "PREPARING"

echo "-- ③ 10 已取件 → PICKED，订单 SHIPPED，Shipment 写单号+shippedAt --"
x59_cb "$X59_BN" 10 '{"kuaidinum":"JT9990001"}' >/dev/null
R=$(x59_bk "$X59_O"); assert_eq "PICKED" "$(jq -r .data.booking.status <<<"$R")" "PICKED"; assert_eq "单号回填" "$(jq -r .data.booking.kuaidinum <<<"$R")" "JT9990001"
assert_eq "订单 SHIPPED" "$(order_status $X59_O)" "SHIPPED"
assert_eq "Shipment 公司/单号/发货时间" "$(sql "SELECT CONCAT(express_company,'|',express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X59_O;")" "极兔速递|JT9990001|SET"
x59_cb "$X59_BN" 9 '{}' >/dev/null
assert_eq "取件后收到取消回调：忽略，仍 PICKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "PICKED"
assert_eq "取件后订单仍 SHIPPED" "$(order_status $X59_O)" "SHIPPED"

echo "-- ④ 15 结算 → 实扣/计费重；155 更新；synPay 被调；成本告警只一次 --"
x59_cb "$X59_BN" 15 '{"weight":"2.0","freight":"12.50","defPrice":"16.00","feeDetails":[{"feeType":"freight","amount":"12.50"}]}' >/dev/null
R=$(x59_bk "$X59_O"); assert_eq "settledFeeFen 1250" "$(jq -r .data.booking.settledFeeFen <<<"$R")" "1250"; assert_eq "billedWeightG 2000" "$(jq -r .data.booking.billedWeightG <<<"$R")" "2000"
assert_eq "synPay 调了 1 次" "$(req GET "/api/admin/system/express-mock/calls?op=synPay" "$AT" | jq -r '.data|length')" "1"
x59_cb "$X59_BN" 155 '{"weight":"2.5","freight":"13.80"}' >/dev/null
assert_eq "155 更新实扣 1380" "$(x59_bk "$X59_O" | jq -r .data.booking.settledFeeFen)" "1380"
assert_eq "状态仍 PICKED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "PICKED"

echo "-- ⑤ 101/400 只留痕；13 签收 → DELIVERED，订单 COMPLETED --"
x59_cb "$X59_BN" 101 '{}' >/dev/null; x59_cb "$X59_BN" 400 '{}' >/dev/null
assert_eq "运输/派送中不改状态" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "PICKED"
x59_cb "$X59_BN" 13 '{}' >/dev/null
assert_eq "DELIVERED" "$(x59_bk "$X59_O" | jq -r .data.booking.status)" "DELIVERED"
assert_eq "订单 COMPLETED" "$(order_status $X59_O)" "COMPLETED"
assert_eq "不再活跃" "$(x59_bk "$X59_O" | jq -r .data.active)" "false"

echo "-- ⑥ 揽货失败 11 → FAILED 回备货中可重约；快递100 侧取消 9 → CANCELLED --"
X59_O3=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X59_O3/book" "$AT" '{"kuaidicom":"zhongtong","dayType":"明天"}' >/dev/null
X59_BN3=$(x59_bk "$X59_O3" | jq -r .data.booking.bookingNo)
x59_cb "$X59_BN3" 11 '{"message":"揽货失败：联系不上寄件人"}' >/dev/null
R=$(x59_bk "$X59_O3"); assert_eq "FAILED" "$(jq -r .data.booking.status <<<"$R")" "FAILED"; assert_eq "不活跃" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "订单仍 PREPARING" "$(order_status $X59_O3)" "PREPARING"
R=$(req POST "/api/admin/express/orders/$X59_O3/book" "$AT" '{"kuaidicom":"zhongtong","dayType":"明天"}'); assert_eq "失败后重约 code 0" "$(code "$R")" "0"
X59_BN4=$(jq -r .data.bookingNo <<<"$R")
x59_cb "$X59_BN4" 99 '{}' >/dev/null
R=$(x59_bk "$X59_O3"); assert_eq "99 → CANCELLED" "$(jq -r .data.booking.status <<<"$R")" "CANCELLED"; assert_eq "cancelledBy KD100" "$(jq -r .data.booking.cancelledBy <<<"$R")" "KD100"

echo "-- ⑦ 韵达异步：回调 0 补单号写 Shipment；610 → FAILED --"
R=$(req POST "/api/admin/express/orders/$X59_O3/book" "$AT" '{"kuaidicom":"yunda","dayType":"明天"}'); X59_BN5=$(jq -r .data.bookingNo <<<"$R")
assert_eq "韵达下单单号空" "$(jq -r .data.kuaidinum <<<"$R")" "null"
x59_cb "$X59_BN5" 0 '{"kuaidinum":"YD0007"}' >/dev/null
assert_eq "回调 0 补单号" "$(x59_bk "$X59_O3" | jq -r .data.booking.kuaidinum)" "YD0007"
assert_eq "Shipment 单号 YD0007 未发货" "$(sql "SELECT CONCAT(express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X59_O3;")" "YD0007|NULL"
x59_cb "$X59_BN5" 610 '{"message":"下单失败"}' >/dev/null
assert_eq "610 → FAILED" "$(x59_bk "$X59_O3" | jq -r .data.booking.status)" "FAILED"

echo "-- ⑧ UNKNOWN 占位被回调认领 --"
X59_O4=$(x58_paid_preparing)
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"timeout"}}' >/dev/null
req POST "/api/admin/express/orders/$X59_O4/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X59_BN6=$(x59_bk "$X59_O4" | jq -r .data.booking.bookingNo)
x59_cb "$X59_BN6" 1 '{"taskId":"T-CLAIM","courierName":"王师傅"}' >/dev/null
R=$(x59_bk "$X59_O4"); assert_eq "UNKNOWN 被 1 认领为 ACCEPTED" "$(jq -r .data.booking.status <<<"$R")" "ACCEPTED"
assert_eq "taskId 认领" "$(sql "SELECT task_id FROM express_bookings WHERE booking_no='$X59_BN6';")" "T-CLAIM"

echo "-- ⑨ 未知状态码 → 留痕 + 200 --"
HTTPC=$(x59_cb "$X59_BN6" 777 '{}'); assert_eq "未知状态 200" "$HTTPC" "200"
assert_eq "状态不变 ACCEPTED" "$(x59_bk "$X59_O4" | jq -r .data.booking.status)" "ACCEPTED"
X59_KEEP_O4=$X59_O4   # ACCEPTED，留给 §60 退款前置用
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
```

- [ ] **Step 2: `express-callback.ts`**

```ts
/**
 * 快递100 上门取件回调处理。回调是预约状态的唯一事实来源（对账任务只在 UNKNOWN 时补位）。
 * 顺序：查单 → 验签 → 去重留痕 → UNKNOWN 认领 → 按映射推进（rank 只前进；终态后忽略）→ 订单联动 → 事务外通知。
 */
import { ExpressBooking, Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { getExpressProvider, ExpressCallbackPayload } from './kd100-express'
import { KD_EXPRESS_STATUS_MAP, BOOKING_RANK, BOOKING_TERMINAL, canTransition } from './express-booking-state'
import { recordBookingEvent, makeExpressDedupeKey, truncStr } from './express-events'
import { notifySystemAlert } from '../notify'
import { notifyExpressAlert } from '../order-notify'
import { sendShipSubscribeMessage } from '../subscribe-message'
import { COURIER_LABEL, getExpressSettings } from '../express-settings'

type Tx = Prisma.TransactionClient

export async function handleExpressCallback(bookingNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const booking = await prisma.expressBooking.findUnique({ where: { bookingNo }, include: { order: { include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } } } } })
  if (!booking) {
    notifySystemAlert('快递100 取件回调查不到预约', [`bookingNo=${bookingNo}`], { key: 'kd-express:unknown-booking' })
    return { http: 200 }
  }
  const parsed = getExpressProvider().verifyAndParseCallback(body, booking.callbackSalt)
  if (!parsed.ok) {
    try { await recordBookingEvent(prisma, { bookingId: booking.id, dedupeKey: makeExpressDedupeKey(bookingNo, 'BAD', rawBody), source: 'CALLBACK', statusDesc: parsed.reason === 'SIGN_MISMATCH' ? '回调验签失败' : '回调格式异常' }) } catch { /* 留痕失败不升级 */ }
    notifySystemAlert('快递100 取件回调验签失败', [`bookingNo=${bookingNo}`], { key: `kd-express-sign:${bookingNo}` })
    return { http: 200 }
  }
  const p = parsed.payload
  const after: (() => void)[] = []
  try {
    await prisma.$transaction(async (tx) => {
      const ev = await recordBookingEvent(tx, { bookingId: booking.id, dedupeKey: makeExpressDedupeKey(bookingNo, p.status, rawBody), source: 'CALLBACK', providerStatus: Number.isFinite(Number(p.status)) ? Number(p.status) : null, statusDesc: p.statusDesc, courierName: p.courierName, courierMobile: p.courierMobile, rawPayload: p.raw as Prisma.InputJsonValue })
      if (ev.duplicate) return
      await tx.expressBooking.update({ where: { id: booking.id }, data: { lastCallbackAt: new Date() } })
      await applyProviderStatus(tx, booking, p, after)
    })
  } catch (e) {
    console.error('[kd-express-callback] 处理失败:', e)
    return { http: 500 }
  }
  for (const f of after) { try { f() } catch (e) { console.error('[kd-express-callback] after 失败:', e) } }
  return { http: 200 }
}

/** 把一条快递100 状态套到预约上。对账任务复用（source 不同）。after 收集事务外通知。 */
export async function applyProviderStatus(tx: Tx, booking: ExpressBooking & { order: { orderNo: string; user: { openid: string }; items: { productName: string }[] } }, p: ExpressCallbackPayload, after: (() => void)[]): Promise<void> {
  const mapped = KD_EXPRESS_STATUS_MAP[p.status]
  const label = COURIER_LABEL[booking.kuaidicom] ?? booking.kuaidicom
  const identity = {
    ...(p.taskId && !booking.taskId ? { taskId: p.taskId } : {}),
    ...(p.kdOrderId && !booking.kdOrderId ? { kdOrderId: p.kdOrderId } : {}),
    ...(p.kuaidinum ? { kuaidinum: p.kuaidinum } : {}),
    ...(p.courierName ? { courierName: p.courierName } : {}),
    ...(p.courierMobile ? { courierMobile: p.courierMobile } : {}),
    ...(p.statusDesc ? { statusDesc: truncStr(p.statusDesc, 255) } : {}),
    ...(Number.isFinite(Number(p.status)) ? { providerStatus: Number(p.status) } : {}),
  }
  // UNKNOWN 认领：任何一条能验签的回调都证明单在快递100 那头存在
  if (booking.status === 'UNKNOWN') {
    await tx.expressBooking.updateMany({ where: { id: booking.id, status: 'UNKNOWN' }, data: { status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED, ...identity } })
    booking = { ...booking, status: 'BOOKED', statusRank: BOOKING_RANK.BOOKED }
  }
  // 单号一到就同步到 Shipment（不写 shippedAt）
  if (p.kuaidinum && p.kuaidinum !== booking.kuaidinum) {
    await tx.shipment.upsert({ where: { orderId: booking.orderId }, update: { expressCompany: label, expressNo: p.kuaidinum }, create: { orderId: booking.orderId, orderNo: booking.orderNo, deliveryType: 'EXPRESS', expressCompany: label, expressNo: p.kuaidinum } })
  }
  if (!mapped) {
    await tx.expressBooking.update({ where: { id: booking.id }, data: identity })
    after.push(() => notifySystemAlert('快递100 取件回调未知状态', [`bookingNo=${booking.bookingNo} status=${p.status}`, p.statusDesc ?? ''], { key: `kd-express-unknown:${p.status}` }))
    return
  }
  if ((BOOKING_TERMINAL as readonly string[]).includes(booking.status)) {
    // 终态后的尾随回调：只留痕（事件已写）；FEE 例外——结算可能晚于签收
    if (mapped.type === 'side' && mapped.kind === 'FEE') await applyFee(tx, booking, p, after)
    return
  }
  if (mapped.type === 'rank') {
    if (!canTransition(booking.status, mapped.status)) { await tx.expressBooking.update({ where: { id: booking.id }, data: identity }); return }
    const stamp = mapped.stamp ? { [mapped.stamp]: new Date() } : {}
    const r = await tx.expressBooking.updateMany({ where: { id: booking.id, statusRank: { lt: mapped.rank } }, data: { status: mapped.status, statusRank: mapped.rank, ...stamp, ...identity, ...(mapped.status === 'DELIVERED' ? { activeOrderId: null } : {}) } })
    if (r.count === 0) return
    if (mapped.status === 'PICKED') {
      const kuaidinum = p.kuaidinum ?? booking.kuaidinum
      await tx.order.updateMany({ where: { id: booking.orderId, status: { in: ['PAID', 'PREPARING'] } }, data: { status: 'SHIPPED' } })
      const shipment = await tx.shipment.upsert({ where: { orderId: booking.orderId }, update: { expressCompany: label, ...(kuaidinum ? { expressNo: kuaidinum } : {}), shippedAt: new Date() }, create: { orderId: booking.orderId, orderNo: booking.orderNo, deliveryType: 'EXPRESS', expressCompany: label, expressNo: kuaidinum, shippedAt: new Date() } })
      const o = booking.order
      after.push(() => sendShipSubscribeMessage(o.user.openid, { id: booking.orderId, orderNo: booking.orderNo }, shipment, o.items[0]?.productName))
    } else if (mapped.status === 'DELIVERED') {
      await tx.order.updateMany({ where: { id: booking.orderId, status: 'SHIPPED' }, data: { status: 'COMPLETED', completedAt: new Date() } })
    }
    return
  }
  switch (mapped.kind) {
    case 'FAILED': {
      const r = await tx.expressBooking.updateMany({ where: { id: booking.id, status: { in: ['PENDING', 'UNKNOWN', 'BOOKED', 'ACCEPTED'] } }, data: { status: 'FAILED', activeOrderId: null, failReason: truncStr(p.statusDesc ?? mapped.label, 255), ...identity } })
      if (r.count > 0) after.push(() => notifExpressFailed(booking.orderNo, label, `${mapped.label}${p.statusDesc ? `：${p.statusDesc}` : ''}`, booking.id))
      return
    }
    case 'CANCELLED': {
      const r = await tx.expressBooking.updateMany({ where: { id: booking.id, status: { in: ['PENDING', 'UNKNOWN', 'BOOKED', 'ACCEPTED'] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelledBy: 'KD100', cancelReason: truncStr(p.statusDesc ?? mapped.label, 255), ...identity } })
      if (r.count > 0) after.push(() => notifyExpressAlert('快递100 取消了取件预约', [`订单 ${booking.orderNo} · ${label}`, p.statusDesc ?? mapped.label, '订单已回到备货中，请重新预约或改填单号发货'], { key: `express-cancel:${booking.id}` }))
      return
    }
    case 'FEE': await applyFee(tx, booking, p, after); return
    case 'ALERT':
      await tx.expressBooking.update({ where: { id: booking.id }, data: identity })
      after.push(() => notifyExpressAlert(`快递100 推送「${mapped.label}」`, [`订单 ${booking.orderNo} · ${label}`, p.statusDesc ?? '', '请到快递100 后台或联系快递员核实'], { key: `express-alert:${booking.id}:${p.status}` }))
      return
    case 'IGNORE':
      await tx.expressBooking.update({ where: { id: booking.id }, data: identity })
      return
  }
}
function notifExpressFailed(orderNo: string, label: string, why: string, id: number) {
  notifyExpressAlert('取件预约失败', [`订单 ${orderNo} · ${label}`, why, '订单已回到备货中：换一家重约，或改填单号发货'], { key: `express-fail:${id}` })
}
async function applyFee(tx: Tx, booking: ExpressBooking, p: ExpressCallbackPayload, after: (() => void)[]) {
  if (p.freightFen === null && p.weightKg === null) return
  const data: Prisma.ExpressBookingUpdateInput = {}
  if (p.freightFen !== null) data.settledFeeFen = p.freightFen
  if (p.weightKg !== null) data.billedWeightG = Math.round(p.weightKg * 1000)
  if (p.feeDetails != null) data.feeDetails = p.feeDetails as Prisma.InputJsonValue
  if (booking.prepaidFeeFen === null && p.defPriceFen !== null && p.status === '0') data.prepaidFeeFen = p.defPriceFen
  await tx.expressBooking.update({ where: { id: booking.id }, data })
  if (p.status === '15' && booking.kdOrderId) {
    const kdOrderId = booking.kdOrderId
    after.push(() => { void getExpressProvider().synPay({ kdOrderId }).catch((e) => console.warn('[kd-express] synPay 失败:', (e as Error).message)) })
  }
  const base = booking.quotedFeeFen ?? booking.prepaidFeeFen
  if (p.freightFen !== null && base && !booking.costAlertedAt) {
    const s = await getExpressSettings()
    if (p.freightFen / base > s.costAlertRatio) {
      await tx.expressBooking.updateMany({ where: { id: booking.id, costAlertedAt: null }, data: { costAlertedAt: new Date() } })
      after.push(() => notifyExpressAlert('邮寄实扣运费明显高于预扣', [`订单 ${booking.orderNo}`, `预扣 ¥${(base / 100).toFixed(2)} → 实扣 ¥${(p.freightFen! / 100).toFixed(2)}`, '可能是包装附加重量设低了，请核对「邮寄设置 → 重量」'], { key: `express-cost:${booking.id}` }))
    }
  }
}
```
（`prepaidFeeFen`：建单成功时若 `getBookingQuotes` 有该家报价，Task 3 已写 `quotedFeeFen`；预扣以快递100 回调 0 的 `defPrice`/`freight` 为准——若回调 0 带 `freight`，`applyFee` 会在 `status==='0'` 时把它写进 `prepaidFeeFen`：把上面那行改成 `if (booking.prepaidFeeFen === null && p.status === '0' && (p.freightFen ?? p.defPriceFen) !== null) data.prepaidFeeFen = p.freightFen ?? p.defPriceFen`，并且在 rank 分支处理完 `0` 之后也调用 `applyFee`（`mapped.status === 'BOOKED'` 时）。）

- [ ] **Step 3: 路由 + 限流 + 挂载 + nginx**

`rate-limit.ts`（紧跟 `kdCallbackLimiter`）：
```ts
/** 邮寄取件回调限流。被限流时回 503 让快递100 重推——同城那条回 200 成功形状会让回调静默丢失（memory 里记过） */
export const kdExpressCallbackLimiter = rateLimit({
  windowMs: 60 * 1000, limit: devCeiling(120, 2000), standardHeaders: true, legacyHeaders: false,
  statusCode: 503, message: { result: false, returnCode: '503', message: '请求过于频繁，请稍后重推' },
})
```
`routes/kd-express-callback.ts`：
```ts
/** 快递100 上门取件状态回调。公开路由（安全性来自 per-预约 salt 验签），body 为 x-www-form-urlencoded */
import express, { Router, Request, Response } from 'express'
import { handleExpressCallback } from '../services/delivery/express-callback'
import { kdExpressCallbackLimiter } from '../middlewares/rate-limit'
const router = Router()
router.post('/:bookingNo', kdExpressCallbackLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  let http: 200 | 500 = 200
  try { http = (await handleExpressCallback(String(req.params.bookingNo), (req.body ?? {}) as Record<string, string>)).http }
  catch (e) { console.error('[kd-express-callback] 未捕获异常:', e); http = 500 }
  if (http === 200) res.json({ result: true, returnCode: '200', message: '成功' })
  else res.status(500).json({ result: false, returnCode: '500', message: '服务器异常，请重推' })
})
export default router
```
`app.ts`：`import kdExpressCallbackRouter from './routes/kd-express-callback'`；在 `app.use('/api/kd', kdCallbackRouter)` 后加 `app.use('/api/kd-express', kdExpressCallbackRouter)`。
`scripts/nginx.conf`：复制 `location /api/kd/ { … gzip off; }` 整块为 `location /api/kd-express/`，注释改成「快递100 上门取件回调，同上」。`docs/deployment.md` 的 nginx 段加一句「`/api/kd-express/` 与 `/api/kd/` 同配置，部署时一起加」。`config.ts` 启动校验里那段最坏回调 URL 计算（`worstKdCallbackUrl`）旁加 `worstKdExpressUrl = ${publicBaseUrl}/api/kd-express/E999999-99` ≤ 200 的校验。

- [ ] **Step 4: 验证**

```bash
cd apps/server && npx tsc --noEmit
DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tee /tmp/e2e-b2t4.log | tail -3
```
Expected：失败 0，通过数 = Task 3 结果 + §59 条数（约 40）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/delivery/express-callback.ts apps/server/src/routes/kd-express-callback.ts apps/server/src/middlewares/rate-limit.ts apps/server/src/app.ts apps/server/src/config.ts scripts/nginx.conf docs/deployment.md scripts/e2e.d/59-express-callback.sh
git commit -m "邮寄取件回调：验签去重、状态推进、取件→已发货+发货通知、签收→完成、结算费用、失败/取消提醒 + e2e 59"
```

**复核（opus）要点**：`PICKED` 联动在同一事务；发货通知在事务外；终态后 FEE 仍可写；`canTransition` 与 `statusRank<rank` 双守卫；`cancelledBy='KD100'` 只在回调路径；限流 503；`0` 回调对 UNKNOWN 认领后不会把已 ACCEPTED 的行回拨（先认领再判 rank）；`booking` 局部变量在认领后被重新赋值（TS 允许对参数重新赋值——若 lint 不允许，用 `let current = booking`）。

---

### Task 5: 守卫、顾客取消窗口、取消申请处理、定时任务 + e2e §60

**Files:**
- Modify: `apps/server/src/services/refund.ts`（42263 前置）
- Modify: `apps/server/src/routes/admin/orders.ts`（`/ship` 42264；`/:id` 详情 select 增 `expressBookings`）
- Modify: `apps/server/src/routes/orders.ts`（`cancelWindowOf` 支持 EXPRESS；`cancel-request` 快照预约状态；详情下发 `expressBooking` + `cancelGraceMin`；`/:id/cancel` 顾客自助路径不变）
- Modify: `apps/server/src/routes/admin/delivery.ts` → 抽 `rejectCancelRequest(id, by)` 到 `services/cancel-request.ts`，同城路由改调它；`routes/admin/express.ts` 加 `POST /:id/cancel-request/reject` 与 `POST /:id/cancel-request/approve`
- Modify: `apps/server/src/services/order-notify.ts`（`notifyCancelRequest` 接受渠道宽限分钟）
- Modify: `apps/server/src/services/scheduler.ts`（新任务与 overrides；`autoRejectStaleCancelRequests`/`remindCancelRequestPending` 按渠道）
- Create: `apps/server/src/services/delivery/express-booking-tasks.ts`
- Create: `scripts/e2e.d/60-express-guards.sh`

**Interfaces:**
- `services/cancel-request.ts`：`rejectCancelRequest(orderId: number, by: 'MANUAL' | 'AUTO'): Promise<Order>`（从 delivery.ts 搬来的 updateMany，去掉 `deliveryType !== 'LOCAL'` 限制）；`approveExpressCancelRequest({ orderId, operator })`：有活跃预约先 `cancelBooking(by:'CUSTOMER')`（UNKNOWN → 42267），再 `initiateRefund(全额, reason '顾客申请取消')`，返回 refund 结果。
- `express-booking-tasks.ts`：`remindExpressUnaccepted(hours?)`、`remindExpressUnpicked(min?)`、`reconcileExpressUnknown(minAge = 1)`、`remindExpressUnknownStuck(min = 10)`；`SchedulerOverrides` 加 `expressUnacceptedHours?`, `expressUnpickedMin?`, `expressUnknownMin?`。
- `routes/orders.ts`：`cancelWindowOf(order)`：`LOCAL` 读同城 `acceptGraceMin`，`EXPRESS` 读邮寄 `acceptGraceMin`（0 = 关闭），其余条件同；`cancel-request` 的 `cancelRequestDeliveryStatus` 快照对 EXPRESS 取活跃预约状态或 `'NONE'`；详情响应加 `expressBooking: { status, statusLabel, courierLabel, courierName, slotText, kuaidinum } | null`（顾客白名单，不给手机号、不给费用）与 `cancelGraceMin`。
- 新 HTTP：`POST /api/admin/express/orders/:id/cancel-request/reject`、`POST /api/admin/express/orders/:id/cancel-request/approve`。

- [ ] **Step 1: e2e 先写** `scripts/e2e.d/60-express-guards.sh`

```bash
echo "== 60. 邮寄守卫：有预约不能手填发货/退款/拒单；顾客取消窗口；同意=先取消预约再退款；定时提醒与对账 =="
# 依赖 §59 的 $X59_KEEP_O4（ACCEPTED，京东）。变量 X60_ 前缀。
X60_ORIG=$(req GET /api/admin/settings/express "$AT" | jq -c .data)
req PUT /api/admin/settings/express "$AT" "$(jq -c '.acceptGraceMin=10' <<<"$X60_ORIG")" >/dev/null

echo "-- ① 活跃预约：/ship 42264、全额退款 42263、拒单 42263 --"
X60_O=$X59_KEEP_O4
R=$(req POST "/api/admin/orders/$X60_O/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"X"}'); assert_eq "手填发货被拦 42264" "$(code "$R")" "42264"
X60_AMT=$(req GET "/api/admin/orders/$X60_O" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$X60_O/refund" "$AT" "{\"amount\":$X60_AMT,\"reason\":\"e2e\"}"); assert_eq "全额退款被拦 42263" "$(code "$R")" "42263"
R=$(req POST "/api/admin/orders/$X60_O/reject" "$AT" '{"reason":"OTHER","note":"e2e"}'); assert_eq "拒单被拦 42263" "$(code "$R")" "42263"
R=$(req POST "/api/admin/orders/$X60_O/refund" "$AT" '{"amount":1,"reason":"e2e 部分"}'); assert_eq "部分退款不受影响 code 0" "$(code "$R")" "0"
req POST "/api/admin/express/orders/$X60_O/booking/cancel" "$AT" '{}' >/dev/null
R=$(req POST "/api/admin/orders/$X60_O/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"X60"}'); assert_eq "取消预约后可手填发货" "$(code "$R")" "0"

echo "-- ② 顾客取消窗口（EXPRESS）：接单前秒退不变；接单后 10 分钟内可申请；窗口 0 关闭 --"
X60_O2=$(make_paid_order)
R=$(req POST "/api/orders/$X60_O2/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "未接单不能申请 42229" "$(code "$R")" "42229"
req POST "/api/admin/orders/$X60_O2/accept" "$AT" >/dev/null
R=$(req GET "/api/orders/$X60_O2" "$UT")
assert_eq "详情 canRequestCancel=true" "$(jq -r .data.canRequestCancel <<<"$R")" "true"
assert_eq "详情 cancelGraceMin=10" "$(jq -r .data.cancelGraceMin <<<"$R")" "10"
assert_eq "expressBooking 为 null（未预约）" "$(jq -r .data.expressBooking <<<"$R")" "null"
req POST "/api/admin/express/orders/$X60_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天","pickupStart":"09:00","pickupEnd":"11:00"}' >/dev/null
R=$(req GET "/api/orders/$X60_O2" "$UT")
assert_eq "顾客端看到 expressBooking.status BOOKED" "$(jq -r .data.expressBooking.status <<<"$R")" "BOOKED"
assert_eq "顾客端不给手机号字段" "$(jq -r '.data.expressBooking | has("courierMobile")' <<<"$R")" "false"
R=$(req POST "/api/orders/$X60_O2/cancel-request" "$UT" '{"note":"不要了"}'); assert_eq "接单后窗口内申请 code 0" "$(code "$R")" "0"
assert_eq "快照预约状态 BOOKED" "$(sql "SELECT cancel_request_delivery_status FROM orders WHERE id=$X60_O2;")" "BOOKED"
R=$(req POST "/api/admin/express/orders/$X60_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}'); assert_eq "有取消申请时预约被拦（已有预约先 42265）" "$(code "$R")" "42265"

echo "-- ③ 驳回：清标记、留驳回痕迹；再申请可以 --"
R=$(req POST "/api/admin/express/orders/$X60_O2/cancel-request/reject" "$AT"); assert_eq "驳回 code 0" "$(code "$R")" "0"
assert_eq "驳回痕迹 MANUAL" "$(sql "SELECT cancel_request_rejected_by FROM orders WHERE id=$X60_O2;")" "MANUAL"
R=$(req POST "/api/orders/$X60_O2/cancel-request" "$UT" '{}'); assert_eq "窗口内再申请 code 0" "$(code "$R")" "0"

echo "-- ④ 同意：先取消预约再全额退款；预约取消失败则不退款 --"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"cancel","directive":{"kind":"error","code":"500","message":"订单已揽收，无法取消"}}' >/dev/null
R=$(req POST "/api/admin/express/orders/$X60_O2/cancel-request/approve" "$AT"); assert_eq "预约取消失败 → 42267" "$(code "$R")" "42267"
assert_eq "未退款：订单仍 PREPARING" "$(order_status $X60_O2)" "PREPARING"
R=$(req POST "/api/admin/express/orders/$X60_O2/cancel-request/approve" "$AT"); assert_eq "再同意 code 0" "$(code "$R")" "0"
assert_eq "预约 CANCELLED by CUSTOMER" "$(req GET "/api/admin/express/orders/$X60_O2/booking" "$AT" | jq -r '.data.booking.cancelledBy')" "CUSTOMER"
assert_eq "订单 REFUNDED（mock 即时）" "$(order_status $X60_O2)" "REFUNDED"

echo "-- ⑤ 窗口 0 = 关闭 --"
req PUT /api/admin/settings/express "$AT" "$(jq -c '.acceptGraceMin=0' <<<"$X60_ORIG")" >/dev/null
X60_O3=$(make_paid_order); req POST "/api/admin/orders/$X60_O3/accept" "$AT" >/dev/null
R=$(req POST "/api/orders/$X60_O3/cancel-request" "$UT" '{}'); assert_eq "窗口关闭 42229" "$(code "$R")" "42229"
req PUT /api/admin/settings/express "$AT" "$(jq -c '.acceptGraceMin=10' <<<"$X60_ORIG")" >/dev/null

echo "-- ⑥ 超时自动驳回（EXPRESS 也走）--"
X60_O4=$(make_paid_order); req POST "/api/admin/orders/$X60_O4/accept" "$AT" >/dev/null
req POST "/api/orders/$X60_O4/cancel-request" "$UT" '{}' >/dev/null
R=$(sched '{"cancelAutoRejectMin":0}')
assert_eq "自动驳回痕迹 AUTO" "$(sql "SELECT cancel_request_rejected_by FROM orders WHERE id=$X60_O4;")" "AUTO"

echo "-- ⑦ 定时提醒：预约后无人接单、时段结束未取件、UNKNOWN 对账 --"
X60_O5=$(make_paid_order); req POST "/api/admin/orders/$X60_O5/accept" "$AT" >/dev/null
req POST "/api/admin/express/orders/$X60_O5/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
R=$(sched '{"expressUnacceptedHours":0}'); assert_eq "无人接单提醒 1 条" "$(jq -r '.data.expressUnaccepted // -1' <<<"$R")" "1"
R=$(sched '{"expressUnacceptedHours":0}'); assert_eq "只提醒一次" "$(jq -r '.data.expressUnaccepted // -1' <<<"$R")" "0"
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE active_order_id=$X60_O5;"
R=$(sched '{"expressUnpickedMin":0}'); assert_eq "时段过未取件提醒 1 条" "$(jq -r '.data.expressUnpicked // -1' <<<"$R")" "1"
req POST "/api/admin/express/orders/$X60_O5/booking/cancel" "$AT" '{}' >/dev/null
X60_O6=$(make_paid_order); req POST "/api/admin/orders/$X60_O6/accept" "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"book","directive":{"kind":"timeout"}}' >/dev/null
req POST "/api/admin/express/orders/$X60_O6/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressUnknownMin":0}'); assert_eq "对账查不到：仍 UNKNOWN（不自动作废）" "$(req GET "/api/admin/express/orders/$X60_O6/booking" "$AT" | jq -r .data.booking.status)" "UNKNOWN"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":0,"taskId":"T-RC","kdOrderId":"O-RC","kuaidinum":"JD-RC"}}' >/dev/null
R=$(sched '{"expressUnknownMin":0}'); assert_eq "对账查到：认领 BOOKED" "$(req GET "/api/admin/express/orders/$X60_O6/booking" "$AT" | jq -r .data.booking.status)" "BOOKED"
assert_eq "认领补单号" "$(req GET "/api/admin/express/orders/$X60_O6/booking" "$AT" | jq -r .data.booking.kuaidinum)" "JD-RC"
req POST "/api/admin/express/orders/$X60_O6/booking/cancel" "$AT" '{}' >/dev/null

req PUT /api/admin/settings/express "$AT" "$X60_ORIG" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
```

- [ ] **Step 2: 守卫**

`services/refund.ts`，紧接 42221 那段之后：
```ts
  // 42263：邮寄单有活跃取件预约（快递员可能已在路上）先取消预约再退款——同 42221 的理由
  if (order.deliveryType === 'EXPRESS' && !['COMPLETED', 'REFUNDED'].includes(order.status)) {
    const active = await prisma.expressBooking.findFirst({ where: { activeOrderId: orderId }, select: { status: true } })
    if (active) throw new AppError(42263, `该订单有取件预约（${BOOKING_STATUS_LABEL[active.status] ?? active.status}），请先取消预约再退款`)
  }
```
（`isFull` 才拦：部分退款不碰货，放行——把这段放进 `if (isFull)` 里；同城 42221 现在是否也只拦全额？照它的现状，若它不分，就与它一致地不分——按 e2e ① 「部分退款不受影响」的断言，**必须**只拦全额。若同城不分，只给 EXPRESS 分。）
`routes/admin/orders.ts` `/ship`：在 `if (!['PAID','PREPARING'].includes(order.status))` 之后加：
```ts
    const activeBooking = await prisma.expressBooking.findFirst({ where: { activeOrderId: id }, select: { status: true } })
    if (activeBooking) throw new AppError(42264, `该订单有取件预约（${BOOKING_STATUS_LABEL[activeBooking.status] ?? activeBooking.status}），请先取消预约再手填单号`)
```
详情 select 加 `expressBookings: { orderBy: { id: 'desc' as const }, take: 1, select: { id: true, bookingNo: true, status: true, kuaidicom: true, kuaidinum: true, dayType: true, pickupDate: true, pickupStart: true, pickupEnd: true, courierName: true, courierMobile: true, customerFeeFen: true, quotedFeeFen: true, prepaidFeeFen: true, settledFeeFen: true, billedWeightG: true, weightG: true, failReason: true, activeOrderId: true } }`。

- [ ] **Step 3: 顾客取消窗口与详情**

`routes/orders.ts`：
```ts
async function cancelWindowOf(order: { deliveryType: string; status: string; acceptedAt: Date | null; cancelRequestedAt: Date | null }) {
  if (order.status !== 'PREPARING' || !order.acceptedAt) return { canRequestCancel: false, cancelRequestDeadline: null as Date | null, cancelGraceMin: 0 }
  const graceMin = order.deliveryType === 'LOCAL' ? (await getLocalSettings()).acceptGraceMin : order.deliveryType === 'EXPRESS' ? (await getExpressSettings()).acceptGraceMin : 0
  if (graceMin <= 0) return { canRequestCancel: false, cancelRequestDeadline: null as Date | null, cancelGraceMin: 0 }
  const deadline = new Date(order.acceptedAt.getTime() + graceMin * 60 * 1000)
  return { canRequestCancel: !order.cancelRequestedAt && Date.now() < deadline.getTime(), cancelRequestDeadline: deadline, cancelGraceMin: graceMin }
}
```
`cancel-request` 里的快照：`const snapshotStatus = order.deliveryType === 'LOCAL' ? ((await prisma.delivery.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE') : ((await prisma.expressBooking.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE')`；`notifyCancelRequest(...)` 加参数 `graceMin`（它内部原来读 `getLocalSettings()` 拼分钟数——改成用传入值；同城调用处传同城的）。
详情 `GET /:id`：
```ts
    let expressBooking: { status: string; statusLabel: string; courierLabel: string; courierName: string | null; slotText: string; kuaidinum: string | null } | null = null
    if (order.deliveryType === 'EXPRESS') {
      const b = await prisma.expressBooking.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' } })
      if (b && !['FAILED', 'VOID'].includes(b.status)) {   // 失败/作废对顾客等于「没预约」
        const v = bookingView(b)
        expressBooking = { status: v.status, statusLabel: v.statusLabel, courierLabel: v.courierLabel, courierName: v.courierName, slotText: v.slotText, kuaidinum: v.kuaidinum }
      }
    }
    // success(...) 里加 expressBooking
```
（`CANCELLED` 也下发但顾客端按「商家备货中」显示——Task 7 处理。）

- [ ] **Step 4: 取消申请共用服务 + express 路由**

新建 `services/cancel-request.ts`：
```ts
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { cancelBooking, getActiveBooking } from './delivery/express-booking'
import { initiateRefund, remainingRefundable } from './refund'

/** 驳回顾客取消申请：清四列标记 + 留驳回痕迹。同城与邮寄共用（从 routes/admin/delivery.ts 搬来，去掉渠道限制） */
export async function rejectCancelRequest(orderId: number, by: 'MANUAL' | 'AUTO') {
  const target = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, cancelRequestedAt: true } })
  if (!target) throw new AppError(40401, '订单不存在', 404)
  const moved = await prisma.order.updateMany({
    where: { id: orderId, cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED', 'REFUNDING'] } },
    data: { cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null, cancelRequestRejectedAt: new Date(), cancelRequestRejectedBy: by },
  })
  if (moved.count === 0) throw new AppError(42204, target.cancelRequestedAt ? `订单状态为 ${target.status}，取消申请已无需处理` : '该订单没有待处理的取消申请')
  return prisma.order.findUniqueOrThrow({ where: { id: orderId } })
}
/** 同意邮寄单的取消申请：先取消预约（有的话），成功再全额退款。第一步失败不进第二步。 */
export async function approveExpressCancelRequest(i: { orderId: number; operator: string }) {
  const order = await prisma.order.findUnique({ where: { id: i.orderId } })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'EXPRESS') throw new AppError(42204, '仅邮寄订单')
  if (!order.cancelRequestedAt) throw new AppError(42204, '该订单没有待处理的取消申请')
  if (await getActiveBooking(i.orderId)) await cancelBooking({ orderId: i.orderId, operator: i.operator, by: 'CUSTOMER' })
  return initiateRefund({ orderId: i.orderId, amount: remainingRefundable(order), reason: '顾客申请取消', operator: i.operator })
}
```
`routes/admin/delivery.ts` 的 `cancel-request/reject` 改成：保留 `deliveryType !== 'LOCAL'` 检查（同城路由语义不变），主体调 `rejectCancelRequest(id, 'MANUAL')`。`scheduler`/`tasks.ts` 里 `autoRejectStaleCancelRequests` 若内联了同一段 updateMany，改调 `rejectCancelRequest(id, 'AUTO')` 且候选查询去掉 `deliveryType: 'LOCAL'`、按渠道取 `acceptGraceMin`（LOCAL 读同城、EXPRESS 读邮寄；override 仍统一覆盖）；`remindCancelRequestPending` 同样放开渠道。`routes/admin/express.ts` 加：
```ts
router.post('/:id/cancel-request/reject', async (req, res, next) => { try { success(res, await rejectCancelRequest(Number(req.params.id), 'MANUAL')) } catch (e) { next(e) } })
router.post('/:id/cancel-request/approve', async (req, res, next) => { try { success(res, await approveExpressCancelRequest({ orderId: Number(req.params.id), operator: req.adminUsername ?? 'admin' })) } catch (e) { next(e) } })
```

- [ ] **Step 5: 定时任务** `express-booking-tasks.ts`

```ts
import prisma from '../../utils/prisma'
import { getExpressSettings } from '../express-settings'
import { notifyExpressAlert } from '../order-notify'
import { notifySystemAlert } from '../notify'
import { reconcileUnknownBooking, pickupDateOf } from './express-booking'
import { COURIER_LABEL } from '../express-settings'

const BATCH = 100
const ago = (min: number) => new Date(Date.now() - min * 60 * 1000)

/** 预约后超过 N 小时没有快递员接单（每单一次） */
export async function remindExpressUnaccepted(hours?: number): Promise<number> {
  const s = await getExpressSettings()
  const h = hours ?? s.pickup.unacceptedRemindHours
  const rows = await prisma.expressBooking.findMany({ where: { status: 'BOOKED', bookedAt: { lt: ago(h * 60) }, unacceptedRemindedAt: null }, take: BATCH, select: { id: true, orderNo: true, kuaidicom: true } })
  let n = 0
  for (const b of rows) {
    const m = await prisma.expressBooking.updateMany({ where: { id: b.id, unacceptedRemindedAt: null }, data: { unacceptedRemindedAt: new Date() } })
    if (m.count === 0) continue
    n++
    notifyExpressAlert('取件预约超时无人接单', [`订单 ${b.orderNo} · ${COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom}`, `预约已超过 ${h} 小时无快递员接单`, '可改约、换家重约或联系快递100 客服'])
  }
  return n
}
/** 预约时段已结束 N 分钟仍未取件（每单一次）。改约会清标记 */
export async function remindExpressUnpicked(min?: number): Promise<number> {
  const s = await getExpressSettings()
  const m = min ?? s.pickup.unpickedRemindMin
  const today = pickupDateOf('今天')
  const nowHm = new Date(Date.now() + 8 * 3600 * 1000 - m * 60 * 1000).toISOString().slice(11, 16)
  const rows = await prisma.expressBooking.findMany({
    where: { status: { in: ['BOOKED', 'ACCEPTED'] }, unpickedRemindedAt: null, OR: [{ pickupDate: { lt: today } }, { pickupDate: today, pickupEnd: { lte: nowHm } }] },
    take: BATCH, select: { id: true, orderNo: true, kuaidicom: true, pickupDate: true, pickupEnd: true },
  })
  let n = 0
  for (const b of rows) {
    const r = await prisma.expressBooking.updateMany({ where: { id: b.id, unpickedRemindedAt: null }, data: { unpickedRemindedAt: new Date() } })
    if (r.count === 0) continue
    n++
    notifyExpressAlert('预约时段已过仍未取件', [`订单 ${b.orderNo} · ${COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom}`, `预约 ${b.pickupDate ?? ''} ${b.pickupEnd ?? ''} 前上门，至今无取件回调`, '请联系快递员或改约；快递100 有时不推揽收失败'])
  }
  return n
}
/** UNKNOWN 对账：满 minAge 分钟的每轮查一次；查到认领，查不到只计数，10 次后提醒一次 */
export async function reconcileExpressUnknown(minAge = 1): Promise<number> {
  const rows = await prisma.expressBooking.findMany({ where: { status: 'UNKNOWN', bookedAt: { lt: ago(minAge) } }, take: BATCH, select: { id: true, orderNo: true, bookingNo: true, reconcileTries: true, unknownRemindedAt: true } })
  let n = 0
  for (const b of rows) {
    const r = await reconcileUnknownBooking(b.id)
    if (r === 'CLAIMED') { n++; continue }
    if (b.reconcileTries + 1 >= 10 && !b.unknownRemindedAt) {
      const m = await prisma.expressBooking.updateMany({ where: { id: b.id, unknownRemindedAt: null }, data: { unknownRemindedAt: new Date() } })
      if (m.count > 0) notifySystemAlert('取件预约状态长时间未确认', [`订单 ${b.orderNo}（${b.bookingNo}）`, '下单超时后多次查单无结果', '请到快递100 后台核对：有单等回调认领，无单在工作台作废重约'], { key: `express-unknown:${b.id}` })
    }
  }
  return n
}
```
`scheduler.ts`：`SchedulerOverrides` 加 `expressUnacceptedHours?: number; expressUnpickedMin?: number; expressUnknownMin?: number`；tasks 数组在 `localHousekeeping` 之后加：
```ts
    ['expressUnknownReconcile', () => reconcileExpressUnknown(overrides.expressUnknownMin)],
    ['expressUnaccepted', () => remindExpressUnaccepted(overrides.expressUnacceptedHours)],
    ['expressUnpicked', () => remindExpressUnpicked(overrides.expressUnpickedMin)],
```
（`run-scheduler` 路由若对 overrides 有 zod 白名单，把三个键加上。）

- [ ] **Step 6: 验证 + 提交**

```bash
cd apps/server && npx tsc --noEmit
DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tee /tmp/e2e-b2t5.log | tail -3
```
Expected：失败 0；§40–53 同城段全绿（取消申请驳回抽取后行为不变）；§60 全 ✔。
```bash
git add apps/server/src/services/refund.ts apps/server/src/routes/admin/orders.ts apps/server/src/routes/orders.ts apps/server/src/routes/admin/delivery.ts apps/server/src/routes/admin/express.ts apps/server/src/services/cancel-request.ts apps/server/src/services/order-notify.ts apps/server/src/services/scheduler.ts apps/server/src/services/delivery/tasks.ts apps/server/src/services/delivery/express-booking-tasks.ts apps/server/src/routes/admin/system.ts scripts/e2e.d/60-express-guards.sh
git commit -m "邮寄守卫与流程：有预约禁手填发货/退款/拒单、顾客取消窗口、同意=先取消预约再退款、三条定时任务 + e2e 60"
```

**复核（opus）要点**：42263 只拦全额；`approveExpressCancelRequest` 第一步失败不退款；`rejectCancelRequest` 搬运后同城 e2e §52 仍绿；`cancelWindowOf` 对 EXPRESS 且 `acceptGraceMin=0` 返回 false；`remindExpressUnpicked` 的上海时间换算；对账不自动作废。

---

### Task 6: 工作台：邮寄卡片带预约、按钮矩阵、预约/改约/取消弹窗、取消申请处理

**Files:**
- Modify: `apps/server/src/routes/admin/workbench.ts`（express 卡片字段、列归属、取消申请计数含 EXPRESS）
- Modify: `apps/admin/src/types.ts`（`WorkbenchCard.express` 扩展、`ExpressBookingView`、`ExpressBookingQuotes`）
- Modify: `apps/admin/src/api/admin.ts`（8 个函数）
- Create: `apps/admin/src/components/ExpressBookingModal.tsx`
- Modify: `apps/admin/src/pages/Workbench.tsx`（按钮矩阵、`ModifySlotModal`、`CancelDeliveryModal` 支持 EXPRESS、抽屉预约块与成本行、卡片文案）
- Modify: `apps/admin/src/components/CancelAndRefundModal.tsx`（EXPRESS 一步走 `approveExpressCancelRequest`）

**Interfaces:**
- 服务端快照 `WorkbenchCard.express`：
  ```ts
  express: {
    province: string; city: string; expressCompany: string | null; expressNo: string | null
    booking: { status: string; statusLabel: string; courierLabel: string; courierName: string | null; courierMobile: string | null; slotText: string; kuaidinum: string | null; failReason: string | null; bookedAt: string | null } | null
    cancelRequested: boolean; cancelRejected: 'AUTO' | 'MANUAL' | null; acceptedAt: string | null
  } | null
  ```
  列归属：EXPRESS `PREPARING` 且活跃预约（BOOKED/ACCEPTED/UNKNOWN）→ `waitingCourier`，`waitSince = booking.bookedAt`；否则 `preparing`。`done` 列的 EXPRESS 卡带最后一条预约（DELIVERED/CANCELLED 均可）。`cancelReqCount` 改为不分渠道（去掉 `deliveryType: 'LOCAL'`），`snapshot.expressAcceptGraceMin` 新增（卡片倒计时用）。
- 前端 API（`api/admin.ts`）：
  ```ts
  export const getExpressBooking = (id: number) => client.get<ApiResponse<{ booking: ExpressBookingView | null; active: boolean; events: ExpressBookingEventInfo[] }>>(`/admin/express/orders/${id}/booking`)
  export const getExpressBookingQuotes = (id: number, weightKg?: number) => client.get<ApiResponse<ExpressBookingQuotes>>(`/admin/express/orders/${id}/quotes`, { params: weightKg ? { weightKg } : undefined })
  export const bookExpress = (id: number, data: { kuaidicom: string; serviceType?: string | null; weightKg?: number; dayType: '今天' | '明天' | '后天'; pickupStart?: string | null; pickupEnd?: string | null; remark?: string | null }) => client.post<ApiResponse<{ bookingNo: string; status: 'BOOKED' | 'UNKNOWN'; kuaidinum: string | null }>>(`/admin/express/orders/${id}/book`, data)
  export const cancelExpressBooking = (id: number, reason?: string) => client.post<ApiResponse<null>>(`/admin/express/orders/${id}/booking/cancel`, { reason })
  export const modifyExpressBooking = (id: number, data: { dayType: '今天' | '明天' | '后天'; pickupStart?: string | null; pickupEnd?: string | null }) => client.post<ApiResponse<null>>(`/admin/express/orders/${id}/booking/modify`, data)
  export const voidExpressBooking = (id: number) => client.post<ApiResponse<null>>(`/admin/express/orders/${id}/booking/void`)
  export const rejectExpressCancelRequest = (id: number) => client.post<ApiResponse<Order>>(`/admin/express/orders/${id}/cancel-request/reject`)
  export const approveExpressCancelRequest = (id: number) => client.post<ApiResponse<unknown>>(`/admin/express/orders/${id}/cancel-request/approve`)
  ```
  类型 `ExpressBookingView`（同服务端 `BookingView`）、`ExpressBookingEventInfo { id; source; providerStatus: number | null; statusDesc: string | null; courierName: string | null; operator: string | null; createdAt: string }`、`ExpressBookingQuotes { quotes: { kuaidicom; serviceType; priceFen: number | null; defPriceFen: number | null }[]; weightKg: number; customerFeeFen: number; fromSnapshot: boolean; quotedAt: string | null; suggestedSlot: { dayType; pickupStart; pickupEnd }; couriers: { code; label }[] }`。

- [ ] **Step 1: 服务端快照**

`workbench.ts`：`loadOrders` 不变。在 `snapshot` 里，取 `expressIds = orders.filter(o => o.deliveryType==='EXPRESS').map(o=>o.id)`，查 `prisma.expressBooking.findMany({ where: { orderId: { in: expressIds } }, orderBy: { id: 'asc' } })`，按 `orderId` 折成「最后一条」`bookingByOrder`。`toCard` 增加参数 `b: ExpressBooking | null`，`express` 字段改为：
```ts
    express: o.deliveryType === 'EXPRESS'
      ? {
          province: o.receiverProvince, city: o.receiverCity, expressCompany: o.shipment?.expressCompany ?? null, expressNo: o.shipment?.expressNo ?? null,
          booking: b ? (() => { const v = bookingView(b); return { status: v.status, statusLabel: v.statusLabel, courierLabel: v.courierLabel, courierName: v.courierName, courierMobile: v.courierMobile, slotText: v.slotText, kuaidinum: v.kuaidinum, failReason: v.failReason, bookedAt: v.bookedAt } })() : null,
          cancelRequested: !!o.cancelRequestedAt && !['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(o.status),
          cancelRejected: !!o.cancelRequestRejectedAt && ['PAID', 'PREPARING'].includes(o.status) ? (o.cancelRequestRejectedBy === 'AUTO' ? 'AUTO' : 'MANUAL') : null,
          acceptedAt: o.acceptedAt?.toISOString() ?? null,
        }
      : null,
```
列循环里：
```ts
      else if (o.status === 'PREPARING') {
        const b = bookingByOrder.get(o.id) ?? null
        if (o.deliveryType === 'LOCAL' && d && WAITING_STATUSES.includes(d.status)) cols.waitingCourier.push(toCard(o, d.calledAt, d, null))
        else if (o.deliveryType === 'EXPRESS' && b && b.activeOrderId === o.id) cols.waitingCourier.push(toCard(o, b.bookedAt ?? b.createdAt, null, b))
        else cols.preparing.push(toCard(o, o.acceptedAt, d, b))
      }
```
其余 `toCard` 调用传 `bookingByOrder.get(o.id) ?? null`。`cancelReqCount` 的 where 去掉 `deliveryType: 'LOCAL'`。响应里加 `expressAcceptGraceMin: (await getExpressSettings()).acceptGraceMin`。

- [ ] **Step 2: 前端类型与 API**（按 Interfaces 逐字加；`WorkbenchSnapshot` 加 `expressAcceptGraceMin: number`）

- [ ] **Step 3: `ExpressBookingModal.tsx`**

```tsx
/** 邮寄「预约取件」弹窗：各家报价（最便宜默认选中、标注与顾客付款的差价）、重量可改、时段手选（预填最近可约）、备注。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import '../pages/Workbench.css'
import { bookExpress, getExpressBookingQuotes } from '../api/admin'
import type { ExpressBookingQuotes } from '../types'

const yuan = (fen: number) => (fen / 100).toFixed(2)
const apiMessage = (e: unknown, fallback: string) => (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
const DAYS = ['今天', '明天', '后天'] as const
type Day = (typeof DAYS)[number]
const HOURS = Array.from({ length: 12 }, (_, i) => `${String(9 + i).padStart(2, '0')}:00`)   // 09:00–20:00
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
/** 与服务端 validateSlot 同规则（服务端仍会再校验一次） */
function slotError(day: Day, start: string, end: string, kuaidicom: string, nowMin: number): string {
  if (!start && !end) return kuaidicom === 'shunfeng' ? '顺丰必须填写取件时段' : ''
  if (!start || !end) return '起止时间要一起填'
  if (toMin(end) - toMin(start) < 60) return '取件时段至少 1 小时'
  if (day === '今天' && nowMin >= toMin(end) - 120) return '今天的时段须在结束前 2 小时预约，请改晚一点或约明天'
  return ''
}
const shanghaiNowMin = () => { const d = new Date(Date.now() + 8 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes() }

export default function ExpressBookingModal({ orderId, defaultRemark, onClose, onDone }: { orderId: number; defaultRemark: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [q, setQ] = useState<ExpressBookingQuotes | null>(null)
  const [loading, setLoading] = useState(true)
  const [weight, setWeight] = useState('')
  const [kuaidicom, setKuaidicom] = useState('')
  const [day, setDay] = useState<Day>('今天')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [remark, setRemark] = useState(defaultRemark)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (w?: number) => {
    setLoading(true); setError('')
    try {
      const r = (await getExpressBookingQuotes(orderId, w)).data.data
      setQ(r)
      setWeight(String(r.weightKg))
      if (!kuaidicom) {
        const cheapest = [...r.quotes].filter((x) => x.priceFen !== null).sort((a, b) => a.priceFen! - b.priceFen!)[0]
        setKuaidicom(cheapest?.kuaidicom ?? '')
        setDay(r.suggestedSlot.dayType); setStart(r.suggestedSlot.pickupStart ?? ''); setEnd(r.suggestedSlot.pickupEnd ?? '')
      }
    } catch (e) { setError(apiMessage(e, '报价加载失败')) } finally { setLoading(false) }
  }, [orderId, kuaidicom])
  useEffect(() => { void load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (!q) return []
    const label = new Map(q.couriers.map((c) => [c.code, c.label]))
    return [...q.quotes].sort((a, b) => (a.priceFen ?? 1e9) - (b.priceFen ?? 1e9)).map((x) => ({ ...x, label: label.get(x.kuaidicom) ?? x.kuaidicom }))
  }, [q])
  const cheapest = rows.find((r) => r.priceFen !== null)?.kuaidicom
  const chosen = rows.find((r) => r.kuaidicom === kuaidicom)
  const err = slotError(day, start, end, kuaidicom, shanghaiNowMin())
  const canSubmit = !!q && !!kuaidicom && !err && !busy && !loading

  const onWeightBlur = () => { const w = Number(weight); if (Number.isFinite(w) && w >= 0.1 && w <= 50 && q && w !== q.weightKg) void load(Math.round(w * 10) / 10) }
  const submit = async () => {
    if (!canSubmit) return
    setBusy(true); setError('')
    try {
      const r = (await bookExpress(orderId, { kuaidicom, serviceType: chosen?.serviceType ?? null, weightKg: Number(weight), dayType: day, pickupStart: start || null, pickupEnd: end || null, remark })).data.data
      onDone(r.status === 'UNKNOWN' ? '快递100 未及时响应，预约状态待核对（系统会自动查单）' : `已预约 ${chosen?.label ?? kuaidicom}${r.kuaidinum ? ` · 单号 ${r.kuaidinum}` : ''}`)
    } catch (e) { setError(apiMessage(e, '预约失败，请重试')) } finally { setBusy(false) }
  }

  return (
    <div className="wb__modal-mask" onClick={onClose}>
      <div className="wb__modal" onClick={(e) => e.stopPropagation()}>
        <div className="wb__modal-head"><span>预约快递员上门取件</span><button className="wb__icon-btn" onClick={onClose} aria-label="关闭">×</button></div>
        <div className="wb__modal-body">
          {q && <div className="wb__line"><span>顾客付</span><strong>¥{yuan(q.customerFeeFen)}</strong><span className="wb__muted">{q.fromSnapshot ? '报价来自下单快照' : '刚查的价'}</span></div>}
          <label className="wb__field"><span>重量（kg）</span><input className="wb__input" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} onBlur={onWeightBlur} /></label>
          <div className="wb__quote-list" role="radiogroup" aria-label="选择快递">
            {loading && <div className="wb__muted">查价中…</div>}
            {!loading && rows.map((r) => {
              const disabled = r.priceFen === null
              const diff = q && r.priceFen !== null ? r.priceFen - q.customerFeeFen : null
              return (
                <button key={r.kuaidicom} type="button" role="radio" aria-checked={kuaidicom === r.kuaidicom} disabled={disabled}
                  className={`wb__quote-row ${kuaidicom === r.kuaidicom ? 'is-on' : ''} ${disabled ? 'is-off' : ''}`} onClick={() => setKuaidicom(r.kuaidicom)}>
                  <span>{r.label}{r.serviceType ? ` · ${r.serviceType}` : ''}{r.kuaidicom === cheapest ? <em className="wb__tag">最低</em> : null}</span>
                  <span>{disabled ? '无价' : `¥${yuan(r.priceFen!)}`}{diff !== null && <small className={diff > 0 ? 'wb__neg' : 'wb__pos'}>{diff > 0 ? `比顾客付的多 ¥${yuan(diff)}` : diff < 0 ? `少 ¥${yuan(-diff)}` : '与顾客付的相同'}</small>}</span>
                </button>
              )
            })}
          </div>
          <div className="wb__row">
            <select className="wb__select" value={day} onChange={(e) => setDay(e.target.value as Day)}>{DAYS.map((d) => <option key={d} value={d}>{d}</option>)}</select>
            <select className="wb__select" value={start} onChange={(e) => setStart(e.target.value)}><option value="">不限</option>{HOURS.map((h) => <option key={h} value={h}>{h}</option>)}</select>
            <span>–</span>
            <select className="wb__select" value={end} onChange={(e) => setEnd(e.target.value)}><option value="">不限</option>{HOURS.map((h) => <option key={h} value={h}>{h}</option>)}</select>
          </div>
          {err && <div className="wb__error">{err}</div>}
          <label className="wb__field"><span>备注</span><input className="wb__input" maxLength={50} value={remark} onChange={(e) => setRemark(e.target.value)} /></label>
          <p className="wb__muted">向快递100 下单，预扣{chosen?.priceFen != null ? ` ¥${yuan(chosen.priceFen)}` : '所选家报价'}，快递员上门后按实际重量多退少补。快递员上门前取消不收费；取件后取消要联系快递公司。货物名固定「食品」。</p>
          {error && <div className="wb__error">{error}</div>}
        </div>
        <div className="wb__modal-foot">
          <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>再想想</button>
          <button className="wb__btn wb__btn--fill" style={{ background: 'var(--express)' }} onClick={submit} disabled={!canSubmit}>{busy ? '预约中…' : '确认预约'}</button>
        </div>
      </div>
    </div>
  )
}
```
（`.wb__quote-list/.wb__quote-row/.is-on/.is-off/.wb__tag/.wb__neg/.wb__pos/.wb__field/.wb__row` 若 `Workbench.css` 没有，加进去：行是 flex 两端对齐、选中加左侧 4px 渠道色边、`is-off` 灰字禁用；其余沿用已有 `wb__*` 类。看 `CallQuoteBlock` 用的类名优先复用。）

- [ ] **Step 4: `Workbench.tsx` 接线**

- `modal` 联合类型加 `{ kind: 'book' } | { kind: 'modifySlot' }`；`renderModal` 加两个 case：`case 'book': return <ExpressBookingModal orderId={o.id} defaultRemark="食品请勿重压" onClose={close} onDone={afterAction} />`；`case 'modifySlot': return <ModifySlotModal orderId={o.id} booking={card.express?.booking ?? null} onClose={close} onDone={afterAction} />`。
- 按钮矩阵（在现有 `if (colKey === 'preparing')` 的 `else` 分支替换）：
```tsx
      } else {
        const b = card.express?.booking
        const activeB = b && ['BOOKED', 'ACCEPTED', 'UNKNOWN'].includes(b.status)
        if (b?.status === 'UNKNOWN') {
          btns.push(fill('void-booking', '作废预约', () => confirm({
            title: '作废待核对的预约', channel: ch, confirmText: '确认作废', okMsg: '已作废',
            what: '把这条「待核对」的预约记为作废，之后可以重新预约或手填单号。',
            customer: '顾客看到「商家备货中」。',
            cost: '不产生费用。',
            amber: '作废前请先到快递100 后台确认这张单确实不存在；若它其实已成单，重约会变成两张单、两笔钱。',
            run: () => voidExpressBooking(order.id),
          })))
        } else if (!activeB) {
          btns.push(fill('book', b?.status === 'FAILED' || b?.status === 'CANCELLED' ? '重新预约取件' : '预约取件', () => setModal({ kind: 'book' })))
          btns.push(ghost('ship', '填单号发货', () => setModal({ kind: 'ship' })))
        }
      }
```
`waitingCourier` 分支加 EXPRESS：
```tsx
      if (ch === 'EXPRESS') {
        const b = card.express?.booking
        if (b?.status === 'UNKNOWN') btns.push(fill('void-booking2', '作废预约', () => confirm({ /* 同上 spec */ })))
        else if (b) {
          btns.push(fill('modify-slot', '改约时间', () => setModal({ kind: 'modifySlot' })))
          btns.push(ghost('cancel-booking', '取消预约', () => setModal({ kind: 'cancelDelivery', title: '取消取件预约' })))
        }
        if (b?.courierMobile) btns.push(tel('call-courier', '打给快递员', b.courierMobile))
      }
```
`CancelDeliveryModal`：加 prop `channel` 已有；内部 `run` 改为 `channel === 'EXPRESS' ? cancelExpressBooking(orderId, reason) : cancelDelivery(orderId, reason)`，EXPRESS 时不查 precancel 费、文案「快递员上门前取消不收费；已取件则要联系快递公司」。
- 卡片文案（`Card` 组件 express 段，`:973-975` 一带）：有 `booking` 时第二行显示 `booking.statusLabel · booking.courierLabel · booking.slotText`，`ACCEPTED` 再加 `courierName`；`FAILED` 用红字显示 `failReason`；无 booking 沿用「未发货」。`cancelRequested` 徽标与 `onHandleCancel` 对 EXPRESS 同样显示（现有 `card.local?.cancelRequested` 处改成 `(card.local ?? card.express)?.cancelRequested`；倒计时用 `snap.expressAcceptGraceMin`）。
- 抽屉（`renderDrawer` 邮寄段）：加「取件预约」块：状态、快递、时段、单号（可复制）、快递员、失败原因；成本行「顾客付 ¥ · 预扣 ¥/— · 实扣 ¥/— · 计费 x.x kg/—」（数据来自 `getExpressBooking(o.id)`，抽屉打开时拉一次，10 秒轮询与配送详情同节奏）；事件时间线列表。
- `ModifySlotModal`（Workbench.tsx 内新增，约 40 行）：三个 select（同 ExpressBookingModal 的 DAYS/HOURS）+ 同一 `slotError` 校验（把 `slotError`/`HOURS`/`DAYS` 从 ExpressBookingModal export）→ `modifyExpressBooking`。
- `CancelAndRefundModal`：`channel === 'EXPRESS'` 时第一步改为单按钮「取消预约并退款」调 `approveExpressCancelRequest(orderId)`（服务端两步），成功即 `onDone`；无活跃预约时也走同一端点（服务端只退款）。`hasActiveDelivery` 对 EXPRESS 由父组件传 `!!card.express?.booking && ['BOOKED','ACCEPTED','UNKNOWN'].includes(status)`；UNKNOWN 时按钮禁用并提示「预约待核对，先作废或等系统查单」。驳回按钮（现有 `rejectCancelRequest` 调用处）按渠道分派 `rejectExpressCancelRequest`。

- [ ] **Step 5: 验证**

```bash
cd apps/server && npx tsc --noEmit && cd ../admin && npx tsc --noEmit && npm test && npm run build
DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tail -3
```
浏览器（控制方按 spec §12.3）：邮寄单在「备货中」列出现「预约取件」；弹窗报价排序、最低标注、差价、改重量重查、时段校验四种文案、顺丰缺时段禁用确认；预约后卡片进「等快递员」列并显示时段；改约/取消；作废 UNKNOWN（用 mock timeout 造）；取消申请卡片的「同意」走一步、「驳回」可用；抽屉成本行。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/routes/admin/workbench.ts apps/admin/src/types.ts apps/admin/src/api/admin.ts apps/admin/src/components/ExpressBookingModal.tsx apps/admin/src/components/CancelAndRefundModal.tsx apps/admin/src/pages/Workbench.tsx apps/admin/src/pages/Workbench.css
git commit -m "工作台：邮寄预约取件弹窗、改约/取消/作废、卡片与抽屉显示预约与成本、取消申请同意/驳回走邮寄接口"
```

**复核（opus）要点**：EXPRESS 有活跃预约时「填单号发货」不可见；UNKNOWN 只给「作废」；快照列归属与服务端一致；`CancelAndRefundModal` EXPRESS 分支不再调同城 `cancelDelivery`；`slotError` 与服务端 `validateSlot` 同规则；无价家不可选；成本行空值显示「—」。

---

### Task 7: 顾客端订单详情：预约/接单/取件状态、取消窗口对邮寄开放

**Files:**
- Modify: `apps/miniapp/pages/order/detail.js`（`decorate` 加 express 字段；`graceMin` 改读 `order.cancelGraceMin`）
- Modify: `apps/miniapp/pages/order/detail.wxml`（物流卡片增加预约态；取消卡片条件放开）
- Modify: `apps/miniapp/pages/order/detail.wxss`（一两条样式）

**Interfaces:**
- Consumes：`GET /orders/:id` 的 `expressBooking { status, statusLabel, courierLabel, courierName, slotText, kuaidinum } | null`、`canRequestCancel`、`cancelRequestDeadline`、`cancelGraceMin`、`cancelRequestedAt`、`cancelRequestRejectedAt`。
- Produces（页面 data）：`order.isExpress`、`order.expressStageText`（'商家备货中' / '已预约快递员上门取件 · 9月9日 14:00–16:00' / '快递员已接单 · 张师傅' / '已取件 · 京东物流 JD…'）、`order.showExpressStage`、`order.canRequestCancel`（服务端给）、`order.cancelDeadlineText`。

- [ ] **Step 1: `detail.js`**

在 `decorate` 里（`isLocal` 之后）加：
```js
  var isExpress = order.deliveryType === 'EXPRESS'
  var eb = order.expressBooking
  var expressStageText = ''
  if (isExpress && ['PAID', 'PREPARING', 'SHIPPED'].indexOf(order.status) !== -1) {
    if (!eb || eb.status === 'CANCELLED') expressStageText = order.status === 'SHIPPED' ? '' : '商家备货中'
    else if (eb.status === 'BOOKED' || eb.status === 'UNKNOWN') expressStageText = '已预约快递员上门取件' + (eb.slotText ? ' · ' + eb.slotText : '')
    else if (eb.status === 'ACCEPTED') expressStageText = '快递员已接单' + (eb.courierName ? ' · ' + eb.courierName : '') + (eb.slotText ? ' · ' + eb.slotText : '')
    else if (eb.status === 'PICKED' || eb.status === 'DELIVERED') expressStageText = '已取件 · ' + (eb.courierLabel || '') + (eb.kuaidinum ? ' ' + eb.kuaidinum : '')
  }
```
返回对象里加：`isExpress: isExpress, expressStageText: expressStageText, showExpressStage: !!expressStageText, cancelDeadlineText: deadlineText(order.cancelRequestDeadline)`，并把原来只对 `isLocal` 生效的四个取消相关字段改成对 `(isLocal || isExpress)` 生效：`localCancelDeadlineText`→ 用 `cancelDeadlineText`；`showLocalCancelRejected`、`showLocalCancelUnavailable` 的 `isLocal &&` 改成 `(isLocal || isExpress) &&`。页面 `data.graceMin` 原来从哪来就保留，但 `setData` 时改成 `graceMin: order.cancelGraceMin || 0`（服务端现在按渠道下发）。

- [ ] **Step 2: `detail.wxml`**

物流卡片（`<view class="card" wx:if="{{!order.isLocal && order.shipment}}">` 那块之前）加：
```xml
  <view class="card" wx:if="{{order.showExpressStage}}">
    <view class="card-title">物流信息</view>
    <view class="express-stage">{{order.expressStageText}}</view>
    <view class="info-row" wx:if="{{order.expressBooking && order.expressBooking.kuaidinum && order.status !== 'SHIPPED' && order.status !== 'COMPLETED'}}">
      <text class="info-label">快递单号</text>
      <text class="info-value">{{order.expressBooking.kuaidinum}}</text>
    </view>
  </view>
```
既有「物流信息」卡片条件改为 `wx:if="{{!order.isLocal && order.shipment && (order.status === 'SHIPPED' || order.status === 'COMPLETED')}}"`（发货前的单号显示由上面的预约卡片承担，避免两张卡）。取消卡片 `wx:if="{{order.isLocal && (...)}}"` 改为 `wx:if="{{(order.isLocal || order.isExpress) && (...)}}"`，内部 `order.localCancelDeadlineText` 改 `order.cancelDeadlineText`；底部「申请取消」按钮条件同样放开。`.express-stage { font-size: 28rpx; color: var(--text-1); padding: 8rpx 0; }`。

- [ ] **Step 3: 验证**

```bash
node -e "new (require('vm').Script)(require('fs').readFileSync('apps/miniapp/pages/order/detail.js','utf8'))" && grep -c "<view" apps/miniapp/pages/order/detail.wxml && grep -c "</view>" apps/miniapp/pages/order/detail.wxml
```
同城详情页零变化：`grep -n "isLocal" apps/miniapp/pages/order/detail.wxml` 的每一处要么原样，要么只是加了 `|| order.isExpress`。真机/开发者工具走查由店主做（spec §12.4）。

- [ ] **Step 4: 提交**

```bash
git add apps/miniapp/pages/order/detail.js apps/miniapp/pages/order/detail.wxml apps/miniapp/pages/order/detail.wxss
git commit -m "小程序订单详情：邮寄单显示预约/快递员/取件状态，取消申请窗口对邮寄开放"
```

**复核（opus）要点**：CANCELLED/FAILED/VOID 的预约对顾客显示「商家备货中」；不泄露快递员手机号；同城分支文案与条件一字未变；WXML 不用 `<`。

---

### Task 8: 文档、spec 回改、全量回归、终审

**Files:**
- Modify: `docs/api.md`（附录 G：预约取件接口、回调、错误码 42263–42270）
- Modify: `docs/staff-guide.md`（「邮寄怎么预约快递员」一节：预约/改约/取消/待核对/取消申请）
- Modify: `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md`（§5.3 UNKNOWN 对账「查不到不自动作废」；错误码 42263–42270；§6 状态机加 PENDING/VOID）
- Modify: `docs/deployment.md`（nginx `/api/kd-express/`、伪回调演练加邮寄一条：从 `express_bookings.callback_salt` 取盐）

- [ ] **Step 1: 文档**（附录 G 表格列出 6 个后台接口、回调路由、状态映射表、错误码；店员指南按 spec §5.1 按钮矩阵写「在哪列点什么」）
- [ ] **Step 2: 全量回归（sonnet 执行，haiku 核对）**

```bash
cd apps/server && npx tsc --noEmit && for f in selftest-kd100 selftest-kd100-express selftest-express-settings selftest-express-quote selftest-express-booking; do npx ts-node --transpile-only scripts/$f.ts | tail -1; done
cd ../admin && npx tsc --noEmit && npm test && npm run build
cd ../.. && DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tail -3
```
haiku 清单：每个任务的提交都在 `git log`；`docs/api.md` 附录 G 的接口路径与 `routes/admin/express.ts` 逐一对上；spec 里 `42263`–`42270` 与代码一致；`scripts/e2e.d/` 有 58/59/60；nginx 与 deployment 都提到 `/api/kd-express/`；`grep -rn "deliveryType !== 'LOCAL'" apps/server/src/routes/admin/delivery.ts` 仍在（同城路由语义未变）。

- [ ] **Step 3: 提交 + 终审（opus）**：整批 diff 对照 spec §5–§8 与本计划 Global Constraints；重点：「回调能否被伪造推进订单到已发货」「取消预约与退款的顺序能否被绕过」「UNKNOWN 能否造成双单」「同城是否被牵连」「老邮寄单（无预约、手填单号）是否零变化」。终审通过后 `superpowers:finishing-a-development-branch`。

## 批次三（另写计划）

轨迹订阅 `op=1` + `pollCallBackUrl` 路由、`trackJson` 落库、顾客端时间线、签收自动完成兜底、30 分钟对账任务（PICKED 超 10 天）、店主操作手册。
