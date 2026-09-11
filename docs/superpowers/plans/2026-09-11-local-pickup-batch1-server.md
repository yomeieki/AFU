# 同城「到店自取」批次一：服务端底座 —— 实施计划

> **工序 00 规划 · 模型 fable。** 按「模型分工协议」：改动等级 **L**（跨模块 + 加订单列 + 动退款与订单状态流），链路 `fable → sonnet → opus → fable → haiku`。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**：`docs/superpowers/specs/2026-09-11-local-pickup-design.md`（以下简称 spec）。本批只做 spec §3、§4、§7（服务端部分）、§8.1–8.3。小程序（spec §5）是批次二，后台前端（spec §6）是批次三，各自另写计划。

**Goal:** 服务端能完整收下、流转、通知、打印一张 `deliveryType='PICKUP'` 的自取单，并把「开门前显示午间休息」修掉；老的外送/邮寄链路逐字节不变。

**Architecture:** `deliveryType` 收窄成联合类型 `'EXPRESS'|'LOCAL'|'PICKUP'`，商品渠道仍走 `channelOfDeliveryType('PICKUP') === 'LOCAL'`。时段/备餐起点/优惠三个纯函数放新文件 `services/pickup.ts`；设置挂在现有 `local_delivery` 下的 `pickup` 与 `holiday` 两节；状态流复用 `PAID → PREPARING → SHIPPED → COMPLETED`，新增两个管理端端点推进后两步；定时任务放新文件 `services/pickup-tasks.ts`。

**Tech Stack:** 与仓库现状一致：Express + Prisma(MySQL) + zod 4，`ts-node --transpile-only` 跑 selftest，`scripts/e2e.sh` + `scripts/e2e.d/*.sh` 跑 e2e（需本地 MySQL 容器与 `apps/server` 以 `PORT=3100`、各 mock 开关为 true 启动，见 `scripts/e2e.sh` 头部注释）。

## 未决歧义（执行方按「默认」做，店主不同意再改）

1. 自取单的「未接单重复播报」是否受营业时间门控。**默认**：与邮寄同款，非营业时间不播（明天中午的单不该半夜响）。
2. 自取单出票用哪台打印机。**默认**：用配了 `LOCAL` 渠道的打印机（同一台店内机）。
3. `pickup.discount.type='PERCENT'` 的 `value` 语义。**默认**：`value=95` 表示按 95% 收（9.5 折），取值 1–100，100 = 不打折。

## Global Constraints

- 文件与函数名、错误码、字段名全部按 spec；错误码只用 `42280`–`42284`，含义见 spec §4.9。
- 所有金额单位为分（Int）；所有时刻按 Asia/Shanghai 判定，不依赖进程时区（复用 `shanghaiMinutes` 的 `Intl` 写法）。
- 老调用方零改动原则：`computeCheckout`、`loadCouponForOrder`、`getSubscribeTemplateIds`、`/orders` 的 `deliveryType` 参数在不传新参数时行为逐字节一致。
- 状态流转一律 `updateMany` 带 `status`（与 `deliveryType`）条件判 `count`，不用无条件 `update`。
- 每个 Task 结束前：`cd apps/server && npx tsc --noEmit` 零错误；提交信息用中文、说明「为什么」。
- 不改小程序、不改 `apps/admin`（批次二/三）。工作台快照接口只**加字段**不改现有字段。

## 允许修改的文件白名单

```
apps/server/prisma/schema.prisma
apps/server/prisma/migrations/20260915000000_order_pickup/migration.sql   （新建）
apps/server/src/utils/channel.ts
apps/server/src/utils/constants.ts                                        （Task 8：ACCEPT_REMIND_AFTER_MIN 挪入）
apps/server/src/config.ts
apps/server/src/services/local-settings.ts
apps/server/src/services/pickup.ts                                        （新建）
apps/server/src/services/pickup-tasks.ts                                  （新建）
apps/server/src/services/member/pricing.ts
apps/server/src/services/member/checkout.ts
apps/server/src/services/subscribe-message.ts
apps/server/src/services/order-notify.ts
apps/server/src/services/scheduler.ts
apps/server/src/services/ticket/content.ts
apps/server/src/services/ticket/index.ts
apps/server/src/routes/local.ts
apps/server/src/routes/orders.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/delivery.ts
apps/server/src/routes/admin/settings.ts
apps/server/src/routes/admin/workbench.ts
apps/server/scripts/selftest-local-settings.ts
apps/server/scripts/selftest-pickup.ts                                    （新建）
apps/server/scripts/selftest-member.ts
scripts/e2e.d/62-pickup.sh                                                （新建）
.env.example
docs/api.md
docs/order-flow.md
```

## 上报触发条件（执行方必须停下）

- 需要改白名单外的任何文件（尤其 `services/refund.ts`、`services/delivery/*`、`routes/wechat-notify.ts`）。
- `npx tsc --noEmit` 报出的 `deliveryType` 二分支不在本计划列出的位置（说明审计漏了一处，要回到规划）。
- e2e §40–§61 任一段由绿转红。
- 发现 `42280`–`42284` 已被占用，或 Prisma 迁移在本地库上失败。
- 现有 `autoRejectStaleCancelRequests` 会命中 `PICKUP` 单（spec 要求自取**不**自动驳回）。

## 验收标准（只在这里定义，后续工序不得增删）

| # | 跑什么 | 期望 |
|---|---|---|
| A1 | `cd apps/server && npx tsc --noEmit` | 零错误 |
| A2 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts` | 输出「全部通过 N」，N ≥ 13，退出码 0 |
| A3 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts` | 全部通过，含新增 3 条 closedKind/nextOpenText 断言 |
| A4 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-member.ts` | 全部通过，含新增 4 条 computeCheckout 自取优惠断言 + 1 条自取小票断言 |
| A5 | `bash scripts/e2e.sh`（干净库） | 末行「失败 0」；§62 段全部 ✔ |
| A6 | `grep -n "=== 'LOCAL' ? " apps/server/src -r` 输出的每一处 | 都在本计划 Task 中被处理或在计划里注明「PICKUP 走邮寄侧是有意的」 |
| A7 | `GET /api/local/meta` | 响应含 `delivery`、`pickup`、`holiday` 三节，且老字段 `enabled/isOpen/paused/nextOpenText/closedKind/businessHours/store` 仍在 |
| A8 | `docs/api.md` 附录 H | 列出全部新端点、`42280`–`42284`、新增 scheduler 任务与 override 键 |

---

### Task 1: 数据列、迁移、联合类型

**Files:**
- Modify: `apps/server/prisma/schema.prisma:304-322`（Order 模型，`expressWeightG` 之后）
- Create: `apps/server/prisma/migrations/20260915000000_order_pickup/migration.sql`
- Modify: `apps/server/src/utils/channel.ts`

**Interfaces:**
- Produces: `DELIVERY_TYPES`、`DeliveryType`、`deliveryTypeSchema`、`isPickup(deliveryType)`；`channelOfDeliveryType('PICKUP') === 'LOCAL'`。

- [ ] **Step 1: schema.prisma 加 4 列**（放在 `expressWeightG` 与 `clientRequestId` 之间）

```prisma
  // ── 到店自取（deliveryType=PICKUP 时写入；spec 2026-09-11-local-pickup-design §3.1）──
  // 顾客选的取餐时段起点。取消窗口/催单/过时未取/自动完成全部以它为基准，不看 paidAt
  pickupAt                    DateTime? @map("pickup_at")
  // 自取优惠（分）。小票与统计直接读它，不从设置反推——设置会变，这单当时优惠了多少不该跟着变
  pickupDiscountAmount        Int       @default(0) @map("pickup_discount_amount")
  // 店员点「已备好」的时刻（PREPARING → SHIPPED）
  pickupReadyAt               DateTime? @map("pickup_ready_at")
  // 「过时未取」提醒只发一次的标记，与 acceptRemindedAt 同款
  pickupRemindedAt            DateTime? @map("pickup_reminded_at")
```

- [ ] **Step 2: 写迁移 SQL**

```sql
-- 到店自取（批次一）：订单加 4 列。纯加列、可空/带默认，回滚代码不需要回滚库。
ALTER TABLE `orders`
  ADD COLUMN `pickup_at` DATETIME(3) NULL,
  ADD COLUMN `pickup_discount_amount` INT NOT NULL DEFAULT 0,
  ADD COLUMN `pickup_ready_at` DATETIME(3) NULL,
  ADD COLUMN `pickup_reminded_at` DATETIME(3) NULL;
```

- [ ] **Step 3: 本地库迁移并生成 client**

Run: `cd apps/server && npx prisma migrate deploy && npx prisma generate`
Expected: 输出含 `20260915000000_order_pickup` applied；无报错。

- [ ] **Step 4: `utils/channel.ts` 加联合类型**（整文件替换为下面内容）

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

/**
 * 订单履约方式。PICKUP（到店自取）是同城渠道下的第二种履约方式（spec 2026-09-11 P14）：
 * 菜单、购物车、券的渠道校验都按 LOCAL 走，只有「怎么把货交到顾客手上」不同。
 * 写成联合类型而不是 string，是为了让 tsc 把仓库里所有 `=== 'LOCAL' ? A : B` 的二分支揪出来——
 * 那种写法会把自取单当邮寄单处理（打邮寄票、显示「填单号发货」）。
 */
export const DELIVERY_TYPES = ['EXPRESS', 'LOCAL', 'PICKUP'] as const
export type DeliveryType = (typeof DELIVERY_TYPES)[number]
export const deliveryTypeSchema = z.enum(DELIVERY_TYPES)
export const DELIVERY_TYPE_LABEL: Record<DeliveryType, string> = {
  EXPRESS: '全国邮寄',
  LOCAL: '同城配送',
  PICKUP: '到店自取',
}
export const isPickup = (deliveryType: string): boolean => deliveryType === 'PICKUP'

/** 订单 deliveryType → 渠道：LOCAL 与 PICKUP 都是同城菜单，其余一律邮寄 */
export function channelOfDeliveryType(deliveryType: string): Channel {
  return deliveryType === 'LOCAL' || deliveryType === 'PICKUP' ? 'LOCAL' : 'EXPRESS'
}

/** 读接口的 channel 查询参数：缺省 EXPRESS（保证现有小程序零改动），非法值也按 EXPRESS */
export function parseChannelQuery(raw: unknown): Channel {
  return raw === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}
```

- [ ] **Step 5: tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误（此时还没有人消费 `DeliveryType`）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260915000000_order_pickup apps/server/src/utils/channel.ts
git commit -m "自取批次一：订单加 pickup 四列；deliveryType 联合类型加 PICKUP，渠道归 LOCAL"
```

---

### Task 2: 设置节 `pickup` / `holiday`、营业时间修复、公开 meta

**Files:**
- Modify: `apps/server/src/services/local-settings.ts`（类型、默认值、sanitize、validate、`closedKind`、`nextOpenText`、`publicLocalMeta`；新增判定函数）
- Modify: `apps/server/src/routes/admin/settings.ts:96-108`
- Test: `apps/server/scripts/selftest-local-settings.ts`

**Interfaces:**
- Produces（全部从 `local-settings.ts` 导出）：
  - `LocalDeliverySettings.pickup: PickupSettings`、`LocalDeliverySettings.holiday: { until: string | null; reason: string } | null`
  - `shanghaiDateStr(now: Date): string`（`YYYY-MM-DD`）
  - `isHolidayOn(s, dateStr: string): boolean`、`isHolidayNow(s, now?)`
  - `isPickupPaused(s, now?)`、`pickupAvailableNow(s, now?)`（开通 && 非休业 && 非暂停）
  - `minutesInPeak(s, minutes: number): boolean`
  - `validateForPickupEnable(s): string[]`

- [ ] **Step 1: 先写失败的 selftest**（追加到 `selftest-local-settings.ts` 末尾 `console.log` 之前）

```ts
// ── 2026-09-11：开门前不是「午间休息」；自取/休业节 ──────────────────────────
import { closedKind, isHolidayOn, isHolidayNow, isPickupPaused, shanghaiDateStr, minutesInPeak } from '../src/services/local-settings'
const TWO_SHIFTS = sanitizeLocalSettings({ ...base, businessHours: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '20:00' }] })
t('开门前（09:00）closedKind=CLOSED、nextOpenText=今天 10:00 营业', () => {
  const early = new Date('2026-09-03T01:00:00Z') // 09:00 上海
  assert.strictEqual(closedKind(TWO_SHIFTS, early), 'CLOSED')
  assert.strictEqual(nextOpenText(TWO_SHIFTS, early), '今天 10:00 营业')
})
t('两段之间（15:00）closedKind=BREAK、文案「午间休息，17:00 继续营业」', () => {
  const mid = new Date('2026-09-03T07:00:00Z') // 15:00 上海
  assert.strictEqual(closedKind(TWO_SHIFTS, mid), 'BREAK')
  assert.strictEqual(nextOpenText(TWO_SHIFTS, mid), '午间休息，17:00 继续营业')
})
t('打烊后（21:00）closedKind=CLOSED、文案「明天 10:00 营业」', () => {
  const late = new Date('2026-09-03T13:00:00Z') // 21:00 上海
  assert.strictEqual(closedKind(TWO_SHIFTS, late), 'CLOSED')
  assert.strictEqual(nextOpenText(TWO_SHIFTS, late), '明天 10:00 营业')
})
t('sanitize 缺 pickup/holiday 时补默认值：自取默认关、无休业', () => {
  const s = sanitizeLocalSettings({})
  assert.strictEqual(s.pickup.enabled, false)
  assert.strictEqual(s.pickup.slotMinutes, 30)
  assert.strictEqual(s.pickup.daysAhead, 1)
  assert.deepStrictEqual(s.pickup.discount, { type: 'NONE', value: 0 })
  assert.strictEqual(s.holiday, null)
})
t('sanitize：折扣类型只认三个字面量，PERCENT 的 value 夹到 1–100', () => {
  assert.deepStrictEqual(sanitizeLocalSettings({ pickup: { discount: { type: 'PERCENT', value: 250 } } }).pickup.discount, { type: 'PERCENT', value: 100 })
  assert.deepStrictEqual(sanitizeLocalSettings({ pickup: { discount: { type: 'HALF', value: 5 } } }).pickup.discount, { type: 'NONE', value: 0 })
})
t('休业：until 含当天，过了 until 自动恢复；until=null 一直休', () => {
  const h = { ...base, holiday: { until: '2026-10-08', reason: '国庆' } }
  assert.strictEqual(isHolidayOn(h, '2026-10-08'), true)
  assert.strictEqual(isHolidayOn(h, '2026-10-09'), false)
  assert.strictEqual(isHolidayOn({ ...base, holiday: { until: null, reason: '装修' } }, '2027-01-01'), true)
  assert.strictEqual(isHolidayNow(base, NOON), false)
})
t('shanghaiDateStr 按上海日期取值（UTC 17:00 = 次日 01:00）', () => {
  assert.strictEqual(shanghaiDateStr(new Date('2026-09-03T17:00:00Z')), '2026-09-04')
})
t('isPickupPaused 与 minutesInPeak', () => {
  assert.strictEqual(isPickupPaused({ ...base, pickup: { ...base.pickup, paused: { until: null, reason: '忙' } } }, NOON), true)
  assert.strictEqual(isPickupPaused(base, NOON), false)
  const peak = { ...base, peak: { ...base.peak, windows: [{ start: '12:00', end: '13:00' }] } }
  assert.strictEqual(minutesInPeak(peak, 12 * 60 + 30), true)
  assert.strictEqual(minutesInPeak(peak, 11 * 60), false)
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts`
Expected: 编译期报错 `closedKind`/`isHolidayOn` 等未导出，或断言失败（09:00 得到 BREAK）。

- [ ] **Step 3: 类型与默认值**。在 `LocalDeliverySettings` 接口里 `businessHours: BusinessHour[]` 之前加：

```ts
  /**
   * 休业总开关（spec 2026-09-11 P12）：节假日/装修整店停，外送与自取一起停；邮寄不受影响。
   * until 是恢复营业日期 `YYYY-MM-DD`（含当天仍休业，次日恢复）；null = 手动恢复。
   * 与 paused 的区别：paused 是「今天临时停一下」，按时刻；holiday 是「这几天不开门」，按日。
   */
  holiday: { until: string | null; reason: string } | null
  pickup: PickupSettings
```

并在接口上方加：

```ts
export interface PickupSettings {
  /** 自取开关。与 enabled（外送开关）各自独立；同城入口只要任一开着就显示 */
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  /** 时段粒度（分钟） */
  slotMinutes: number
  /** 接单缓冲：最早可取 = 现在 + 它 + 备餐时长 */
  acceptBufferMin: number
  /** 0 = 只当天，1 = 当天 + 明天 */
  daysAhead: number
  /** 自取起送门槛（分），0 = 不限 */
  minOrderAmountFen: number
  /** PERCENT: value=95 即按 95% 收（9.5 折）；FIXED: value 为立减分 */
  discount: { type: 'NONE' | 'PERCENT' | 'FIXED'; value: number }
  /** 取餐时间过后多久没点「已取走」就自动完成 */
  autoCompleteAfterMin: number
  /** 取餐时间过后多久提醒店员「有单未取」 */
  unpickedRemindAfterMin: number
}
```

`DEFAULT_LOCAL_SETTINGS` 里 `businessHours` 之前加：

```ts
  holiday: null,
  pickup: {
    enabled: false, paused: null, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1,
    minOrderAmountFen: 0, discount: { type: 'NONE', value: 0 },
    autoCompleteAfterMin: 120, unpickedRemindAfterMin: 30,
  },
```

- [ ] **Step 4: sanitize**。在 `sanitizeLocalSettings` 的 `return {` 之前加：

```ts
  const pk = asObj(o.pickup), pkd = asObj(pk.discount)
  const DATE = /^\d{4}-\d{2}-\d{2}$/
  const holiday = o.holiday && typeof o.holiday === 'object'
    ? (() => {
        const h = asObj(o.holiday)
        const until = str(h.until, '', 10)
        return { until: DATE.test(until) ? until : null, reason: str(h.reason, '', 60) }
      })()
    : null
  const pickupPaused = pk.paused && typeof pk.paused === 'object'
    ? { until: str(asObj(pk.paused).until, '', 40) || null, reason: str(asObj(pk.paused).reason, '', 60) }
    : null
  const discountType = pkd.type === 'PERCENT' || pkd.type === 'FIXED' ? pkd.type : 'NONE'
  const discount = discountType === 'PERCENT'
    ? { type: 'PERCENT' as const, value: int(pkd.value, 100, 1, 100) }
    : discountType === 'FIXED'
      ? { type: 'FIXED' as const, value: int(pkd.value, 0, 0, 10_000_000) }
      : { type: 'NONE' as const, value: 0 }
```

在返回对象里 `businessHours: hours,` 之前加：

```ts
    holiday,
    pickup: {
      enabled: bool(pk.enabled, false),
      paused: pickupPaused,
      slotMinutes: int(pk.slotMinutes, D.pickup.slotMinutes, 5, 120),
      acceptBufferMin: int(pk.acceptBufferMin, D.pickup.acceptBufferMin, 0, 60),
      daysAhead: int(pk.daysAhead, D.pickup.daysAhead, 0, 7),
      minOrderAmountFen: int(pk.minOrderAmountFen, D.pickup.minOrderAmountFen, 0, 10_000_000),
      discount,
      autoCompleteAfterMin: int(pk.autoCompleteAfterMin, D.pickup.autoCompleteAfterMin, 10, 1440),
      unpickedRemindAfterMin: int(pk.unpickedRemindAfterMin, D.pickup.unpickedRemindAfterMin, 5, 1440),
    },
```

- [ ] **Step 5: 校验函数**。在 `validateForEnable` 之后加：

```ts
/** 打开自取开关前的完整性校验：不要求门店坐标（自取不算距离），但要有地址/电话/营业时段 */
export function validateForPickupEnable(s: LocalDeliverySettings): string[] {
  const errs = validateLocalSettings(s)
  if (!s.store.phone) errs.push('请填写门店电话（自取单顾客要联系店里）')
  if (!s.store.address) errs.push('请填写门店地址（自取单要显示取餐地点）')
  if (s.businessHours.length === 0) errs.push('至少设置一个营业时段（自取时段只落在营业时间内）')
  return errs
}
```

`validateLocalSettings` 里 `return errs` 之前加：

```ts
  if (s.pickup.unpickedRemindAfterMin >= s.pickup.autoCompleteAfterMin) {
    errs.push(`「过时未取提醒」(${s.pickup.unpickedRemindAfterMin} 分钟) 须早于「自动完成」(${s.pickup.autoCompleteAfterMin} 分钟)`)
  }
```

- [ ] **Step 6: 营业判定修复与新判定**。把现有 `closedKind` 与 `nextOpenText` 整体替换为：

```ts
/**
 * 现在不营业时，是「午间休息」还是「今天打烊了/还没开门」。
 * BREAK 当且仅当**已经过了一段**且**还有一段没开始**——2026-09-11 之前只看后半句，
 * 早上 9 点还没开门也被判成「午间休息」（店主实测发现）。
 */
export function closedKind(s: LocalDeliverySettings, now: Date = new Date()): 'OPEN' | 'BREAK' | 'CLOSED' {
  if (inHours(s, now)) return 'OPEN'
  const cur = shanghaiMinutes(now)
  const passedOne = s.businessHours.some((h) => toMin(h.end) <= cur)
  const hasNext = s.businessHours.some((h) => toMin(h.start) > cur)
  return passedOne && hasNext ? 'BREAK' : 'CLOSED'
}

export function nextOpenText(s: LocalDeliverySettings, now: Date = new Date()): string {
  if (s.businessHours.length === 0) return '暂未设置营业时间'
  const cur = shanghaiMinutes(now)
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  const today = sorted.find((h) => toMin(h.start) > cur)
  if (!today) return `明天 ${sorted[0].start} 营业`
  // 中间休息时说「继续营业」；开门前说「今天 X 营业」（两者靠 closedKind 分开）
  return closedKind(s, now) === 'BREAK' ? `午间休息，${today.start} 继续营业` : `今天 ${today.start} 营业`
}

// ── 休业 / 自取暂停 / 高峰（按分钟）────────────────────────────
const SH_DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
/** 上海日期 `YYYY-MM-DD`（en-CA 的输出天然就是这个格式） */
export function shanghaiDateStr(now: Date = new Date()): string {
  return SH_DATE_FMT.format(now)
}
export function isHolidayOn(s: LocalDeliverySettings, dateStr: string): boolean {
  if (!s.holiday) return false
  return s.holiday.until === null ? true : dateStr <= s.holiday.until
}
export function isHolidayNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return isHolidayOn(s, shanghaiDateStr(now))
}
export function isPickupPaused(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  const p = s.pickup.paused
  if (!p) return false
  if (!p.until) return true
  const until = Date.parse(p.until)
  return Number.isFinite(until) ? until > now.getTime() : true
}
/** 自取此刻能不能下单：开通 && 非休业 && 非自取暂停。**不看营业时段**（营业外可订明天） */
export function pickupAvailableNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return s.pickup.enabled && !isHolidayNow(s, now) && !isPickupPaused(s, now)
}
/** 某个「一天中的分钟数」是否落在高峰窗口。给自取时段用：备餐时长按取餐时刻判，不按现在 */
export function minutesInPeak(s: LocalDeliverySettings, minutes: number): boolean {
  return s.peak.windows.some((h) => minutes >= toMin(h.start) && minutes < toMin(h.end))
}
```

同时把 `isOpenNow` 改为也看休业（休业日外送也不能下单）：

```ts
export function isOpenNow(s: LocalDeliverySettings, now: Date = new Date()): boolean {
  return s.enabled && !isHolidayNow(s, now) && !isPaused(s, now) && inHours(s, now)
}
```

`isShopOpenNow`（催单用）也加 `!isHolidayNow(s, now) &&`。

- [ ] **Step 7: `publicLocalMeta` 加三节**。在返回对象末尾 `limits: s.limits,` 之后加：

```ts
    // ── 2026-09-11 起按履约方式分节；上面的老字段保留给老客户端 ──
    delivery: {
      enabled: s.enabled, isOpen: isOpenNow(s, now),
      paused: isPaused(s, now) ? { reason: s.paused?.reason ?? '', until: s.paused?.until ?? null } : null,
      closedKind: closedKind(s, now), nextOpenText: nextOpenText(s, now),
    },
    pickup: {
      enabled: s.pickup.enabled,
      paused: isPickupPaused(s, now) ? { reason: s.pickup.paused?.reason ?? '', until: s.pickup.paused?.until ?? null } : null,
      available: pickupAvailableNow(s, now),
      minOrderAmountFen: s.pickup.minOrderAmountFen,
      discount: s.pickup.discount,
      discountText: s.pickup.discount.type === 'PERCENT' && s.pickup.discount.value < 100
        ? `自取享 ${(s.pickup.discount.value / 10).toFixed(1).replace(/\.0$/, '')} 折`
        : s.pickup.discount.type === 'FIXED' && s.pickup.discount.value > 0
          ? `自取立减 ¥${(s.pickup.discount.value / 100).toFixed(2)}`
          : '',
      slotMinutes: s.pickup.slotMinutes,
      daysAhead: s.pickup.daysAhead,
    },
    holiday: isHolidayNow(s, now) ? { until: s.holiday?.until ?? null, reason: s.holiday?.reason ?? '' } : null,
```

- [ ] **Step 8: 设置路由校验**。`routes/admin/settings.ts:102` 那行改为：

```ts
    const errs = [
      ...rawErrs,
      ...(next_.enabled ? validateForEnable(next_) : validateLocalSettings(next_)),
      ...(next_.pickup.enabled ? validateForPickupEnable(next_) : []),
    ]
```

并在文件顶部 import 列表加 `validateForPickupEnable`。`validateForEnable` 与 `validateForPickupEnable` 都会各带一份 `validateLocalSettings` 的错误，去重：改成 `Array.from(new Set(errs))` 再判空。

- [ ] **Step 9: 跑 selftest 与 tsc**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts && npx tsc --noEmit`
Expected: 全部通过；tsc 零错误。

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/services/local-settings.ts apps/server/src/routes/admin/settings.ts apps/server/scripts/selftest-local-settings.ts
git commit -m "同城设置加 pickup/holiday 两节与公开 meta 分节；修「开门前显示午间休息」"
```

---

### Task 3: 纯函数 `services/pickup.ts` + 时段接口

**Files:**
- Create: `apps/server/src/services/pickup.ts`
- Create: `apps/server/scripts/selftest-pickup.ts`
- Modify: `apps/server/src/routes/local.ts`（加 `GET /pickup-slots`）

**Interfaces:**
- Produces（`services/pickup.ts`）：
  - `pickupPrepMinutes(s, at: Date): number`
  - `prepStartAt(s, pickupAt: Date): Date`
  - `buildPickupSlots(s, now: Date): PickupSlotsView`
  - `isValidPickupSlot(s, pickupAt: Date, now: Date): boolean`
  - `pickupDiscountOf(s, subtotalFen: number): number`
  - `pickupSlotLabel(pickupAt: Date, slotMinutes: number, now: Date): string`（`今天 12:00–12:30` / `明天 …` / `09-13 12:00–12:30`）
  - `type PickupSlotsView = { days: { date: string; label: string; slots: { startAt: string; endAt: string; label: string }[] }[]; earliestAt: string | null; slotMinutes: number; blocked: null | { kind: 'HOLIDAY' | 'PAUSED' | 'DISABLED'; text: string } }`

- [ ] **Step 1: 写 selftest（先失败）** `apps/server/scripts/selftest-pickup.ts`

```ts
/**
 * 到店自取纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts
 */
import assert from 'assert'
import { DEFAULT_LOCAL_SETTINGS, sanitizeLocalSettings } from '../src/services/local-settings'
import { buildPickupSlots, prepStartAt, pickupPrepMinutes, isValidPickupSlot, pickupDiscountOf, pickupSlotLabel } from '../src/services/pickup'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const sh = (iso: string) => new Date(iso + '+08:00') // 上海时刻字面量

const base = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  businessHours: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '20:00' }],
  prepMinutes: 20,
  peak: { windows: [{ start: '12:00', end: '13:00' }], prepMinMinutes: 25, prepMaxMinutes: 30 },
  pickup: { ...DEFAULT_LOCAL_SETTINGS.pickup, enabled: true, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1 },
})

t('备餐时长：取餐时刻在高峰取上界 30，否则 20', () => {
  assert.strictEqual(pickupPrepMinutes(base, sh('2026-09-11T12:30:00')), 30)
  assert.strictEqual(pickupPrepMinutes(base, sh('2026-09-11T11:00:00')), 20)
})
t('开始备餐时刻 = 取餐 − 备餐 − 缓冲', () => {
  assert.strictEqual(prepStartAt(base, sh('2026-09-11T11:00:00')).toISOString(), sh('2026-09-11T10:35:00').toISOString())
  assert.strictEqual(prepStartAt(base, sh('2026-09-11T12:30:00')).toISOString(), sh('2026-09-11T11:55:00').toISOString())
})
t('09:00 下单：今天从 10:00 起每 30 分钟一格，10:00 可选（10:00−20−5=09:35 ≥ 09:00）', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T09:00:00'))
  assert.strictEqual(v.blocked, null)
  assert.strictEqual(v.days.length, 2)
  assert.strictEqual(v.days[0].date, '2026-09-11'); assert.strictEqual(v.days[0].label, '今天')
  assert.strictEqual(v.days[0].slots[0].label, '10:00–10:30')
  assert.strictEqual(v.days[0].slots[0].startAt, sh('2026-09-11T10:00:00').toISOString())
  assert.strictEqual(v.earliestAt, v.days[0].slots[0].startAt)
})
t('10:50 下单：10:00/10:30/11:00 都来不及（11:00−25=10:35<10:50），第一格 11:30', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T10:50:00'))
  assert.strictEqual(v.days[0].slots[0].label, '11:30–12:00')
})
t('高峰格备餐更久：11:40 下单，12:00 格要 12:00−30−5=11:25<11:40 不可选，12:30 可选', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T11:40:00'))
  assert.ok(!v.days[0].slots.some((x) => x.label === '12:00–12:30'))
  assert.strictEqual(v.days[0].slots[0].label, '12:30–13:00')
})
t('末格不越打烊：13:30–14:00 是上午最后一格，没有 14:00 起的格', () => {
  const v = buildPickupSlots(base, sh('2026-09-11T09:00:00'))
  const labels = v.days[0].slots.map((x) => x.label)
  assert.ok(labels.includes('13:30–14:00'))
  assert.ok(!labels.some((l) => l.startsWith('14:00')))
  assert.ok(labels.includes('19:30–20:00'))
})
t('两段之间（15:00）今天还有晚市格；打烊后（21:00）今天为空数组、明天满格', () => {
  assert.strictEqual(buildPickupSlots(base, sh('2026-09-11T15:00:00')).days[0].slots[0].label, '17:00–17:30')
  const v = buildPickupSlots(base, sh('2026-09-11T21:00:00'))
  assert.deepStrictEqual(v.days[0].slots, [])
  assert.strictEqual(v.days[1].label, '明天')
  assert.strictEqual(v.days[1].slots[0].label, '10:00–10:30')
  assert.strictEqual(v.earliestAt, v.days[1].slots[0].startAt)
})
t('daysAhead=0 只有今天；daysAhead=2 第三天标签是日期', () => {
  assert.strictEqual(buildPickupSlots({ ...base, pickup: { ...base.pickup, daysAhead: 0 } }, sh('2026-09-11T09:00:00')).days.length, 1)
  const v = buildPickupSlots({ ...base, pickup: { ...base.pickup, daysAhead: 2 } }, sh('2026-09-11T09:00:00'))
  assert.strictEqual(v.days[2].label, '09-13')
})
t('休业：整天去掉；全部休业则 blocked=HOLIDAY 且 days 为空', () => {
  const v = buildPickupSlots({ ...base, holiday: { until: '2026-09-11', reason: '盘点' } }, sh('2026-09-11T09:00:00'))
  assert.strictEqual(v.blocked, null)
  assert.strictEqual(v.days.length, 1); assert.strictEqual(v.days[0].date, '2026-09-12')
  const all = buildPickupSlots({ ...base, holiday: { until: '2026-09-20', reason: '装修' } }, sh('2026-09-11T09:00:00'))
  assert.strictEqual(all.blocked?.kind, 'HOLIDAY'); assert.deepStrictEqual(all.days, [])
})
t('未开通 DISABLED、暂停 PAUSED', () => {
  assert.strictEqual(buildPickupSlots({ ...base, pickup: { ...base.pickup, enabled: false } }, sh('2026-09-11T09:00:00')).blocked?.kind, 'DISABLED')
  assert.strictEqual(buildPickupSlots({ ...base, pickup: { ...base.pickup, paused: { until: null, reason: '忙' } } }, sh('2026-09-11T09:00:00')).blocked?.kind, 'PAUSED')
})
t('isValidPickupSlot：命中格子才有效；过期格、非整格都无效', () => {
  const now = sh('2026-09-11T09:00:00')
  assert.strictEqual(isValidPickupSlot(base, sh('2026-09-11T10:00:00'), now), true)
  assert.strictEqual(isValidPickupSlot(base, sh('2026-09-11T10:15:00'), now), false)
  assert.strictEqual(isValidPickupSlot(base, sh('2026-09-11T10:00:00'), sh('2026-09-11T09:50:00')), false)
})
t('自取优惠：PERCENT 95 → 小计 5000 减 250；FIXED 300 封顶到小计；NONE 为 0', () => {
  assert.strictEqual(pickupDiscountOf({ ...base, pickup: { ...base.pickup, discount: { type: 'PERCENT', value: 95 } } }, 5000), 250)
  assert.strictEqual(pickupDiscountOf({ ...base, pickup: { ...base.pickup, discount: { type: 'PERCENT', value: 95 } } }, 3333), 167)
  assert.strictEqual(pickupDiscountOf({ ...base, pickup: { ...base.pickup, discount: { type: 'FIXED', value: 300 } } }, 200), 200)
  assert.strictEqual(pickupDiscountOf(base, 5000), 0)
})
t('时段文案：今天/明天/日期', () => {
  const now = sh('2026-09-11T09:00:00')
  assert.strictEqual(pickupSlotLabel(sh('2026-09-11T12:00:00'), 30, now), '今天 12:00–12:30')
  assert.strictEqual(pickupSlotLabel(sh('2026-09-12T12:00:00'), 30, now), '明天 12:00–12:30')
  assert.strictEqual(pickupSlotLabel(sh('2026-09-13T12:00:00'), 30, now), '09-13 12:00–12:30')
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts`
Expected: 报 `Cannot find module '../src/services/pickup'`。

- [ ] **Step 3: 实现 `services/pickup.ts`**

```ts
/**
 * 到店自取的纯计算（spec 2026-09-11-local-pickup-design §4.2、§4.3）。
 * 不 import prisma、不抛 AppError：时段/备餐起点/优惠的每条边界都由 scripts/selftest-pickup.ts 穷举，
 * 拒不拒单是路由层的事。全部时刻按 Asia/Shanghai；上海无夏令时，`+08:00` 字面量可直接拼 Date。
 */
import {
  LocalDeliverySettings, shanghaiDateStr, isHolidayOn, isPickupPaused, minutesInPeak,
} from './local-settings'

export interface PickupSlot { startAt: string; endAt: string; label: string }
export interface PickupDay { date: string; label: string; slots: PickupSlot[] }
export interface PickupSlotsView {
  days: PickupDay[]
  earliestAt: string | null
  slotMinutes: number
  blocked: null | { kind: 'HOLIDAY' | 'PAUSED' | 'DISABLED'; text: string }
}

const MIN = 60 * 1000
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const pad2 = (n: number) => String(n).padStart(2, '0')
const hhmm = (minutes: number) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
/** 上海日期 + 一天内分钟数 → Date */
const atShanghai = (dateStr: string, minutes: number) => new Date(`${dateStr}T${hhmm(minutes)}:00+08:00`)
/** Date → 上海「一天内的分钟数」 */
function shanghaiMinutesOf(d: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0)
  return h * 60 + m
}
function addDays(dateStr: string, n: number): string {
  return shanghaiDateStr(new Date(new Date(`${dateStr}T12:00:00+08:00`).getTime() + n * 24 * 60 * MIN))
}

/** 备餐时长按**取餐时刻**是否在高峰取值（平时 prepMinutes，高峰取上界 prepMaxMinutes） */
export function pickupPrepMinutes(s: LocalDeliverySettings, at: Date): number {
  return minutesInPeak(s, shanghaiMinutesOf(at)) ? s.peak.prepMaxMinutes : s.prepMinutes
}

/** 开始备餐时刻 = 取餐 − 备餐 − 接单缓冲。取消窗口、催单、工作台倒计时都用它 */
export function prepStartAt(s: LocalDeliverySettings, pickupAt: Date): Date {
  return new Date(pickupAt.getTime() - (pickupPrepMinutes(s, pickupAt) + s.pickup.acceptBufferMin) * MIN)
}

function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return '今天'
  if (dateStr === addDays(todayStr, 1)) return '明天'
  return dateStr.slice(5) // '09-13'
}

function slotsOfDay(s: LocalDeliverySettings, dateStr: string, now: Date): PickupSlot[] {
  const out: PickupSlot[] = []
  const step = s.pickup.slotMinutes
  const sorted = [...s.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  for (const h of sorted) {
    for (let m = toMin(h.start); m + step <= toMin(h.end); m += step) {
      const startAt = atShanghai(dateStr, m)
      // 一格可选：起点 − 备餐(按起点判高峰) − 缓冲 ≥ now。不可选的格子直接不返回
      if (prepStartAt(s, startAt).getTime() < now.getTime()) continue
      out.push({ startAt: startAt.toISOString(), endAt: atShanghai(dateStr, m + step).toISOString(), label: `${hhmm(m)}–${hhmm(m + step)}` })
    }
  }
  return out
}

export function buildPickupSlots(s: LocalDeliverySettings, now: Date = new Date()): PickupSlotsView {
  const slotMinutes = s.pickup.slotMinutes
  const today = shanghaiDateStr(now)
  if (!s.pickup.enabled) return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'DISABLED', text: '到店自取暂未开通' } }
  if (isPickupPaused(s, now)) {
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'PAUSED', text: `自取暂停接单${s.pickup.paused?.reason ? `：${s.pickup.paused.reason}` : ''}` } }
  }
  const days: PickupDay[] = []
  for (let i = 0; i <= s.pickup.daysAhead; i++) {
    const date = addDays(today, i)
    if (isHolidayOn(s, date)) continue
    days.push({ date, label: dayLabel(date, today), slots: slotsOfDay(s, date, now) })
  }
  if (days.length === 0) {
    const until = s.holiday?.until
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'HOLIDAY', text: `休息中${until ? `，${until.slice(5).replace('-', '月')}日恢复` : ''}` } }
  }
  const earliest = days.flatMap((d) => d.slots)[0] ?? null
  return { days, earliestAt: earliest?.startAt ?? null, slotMinutes, blocked: null }
}

/** 下单时校验：pickupAt 必须精确命中此刻算出的某一格起点 */
export function isValidPickupSlot(s: LocalDeliverySettings, pickupAt: Date, now: Date = new Date()): boolean {
  const iso = pickupAt.toISOString()
  return buildPickupSlots(s, now).days.some((d) => d.slots.some((x) => x.startAt === iso))
}

/** 自取优惠（分）。PERCENT: 小计 − round(小计 × value/100)；FIXED: min(value, 小计) */
export function pickupDiscountOf(s: LocalDeliverySettings, subtotalFen: number): number {
  const d = s.pickup.discount
  if (d.type === 'PERCENT') return Math.max(0, subtotalFen - Math.round((subtotalFen * d.value) / 100))
  if (d.type === 'FIXED') return Math.min(d.value, subtotalFen)
  return 0
}

/** 「今天 12:00–12:30」这种给顾客/店员看的文案；小票、通知、工作台共用 */
export function pickupSlotLabel(pickupAt: Date, slotMinutes: number, now: Date = new Date()): string {
  const date = shanghaiDateStr(pickupAt)
  const m = shanghaiMinutesOf(pickupAt)
  return `${dayLabel(date, shanghaiDateStr(now))} ${hhmm(m)}–${hhmm(m + slotMinutes)}`
}
```

- [ ] **Step 4: 跑 selftest**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts`
Expected: `全部通过 13`。

- [ ] **Step 5: 路由 `GET /api/local/pickup-slots`**。在 `routes/local.ts` 的 `router.get('/meta', …)` 之后加：

```ts
// 自取时段（公开；不登录也能看）。全部计算在 services/pickup.ts，这里只是读设置 + 出参
router.get('/pickup-slots', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    success(res, buildPickupSlots(await getLocalSettings(), new Date()))
  } catch (e) {
    next(e)
  }
})
```

顶部加 `import { buildPickupSlots } from '../services/pickup'`。

- [ ] **Step 6: tsc + 手工冒烟**

Run: `cd apps/server && npx tsc --noEmit && curl -s http://localhost:3100/api/local/pickup-slots | jq '.data.blocked'`
Expected: tsc 零错误；未开通时 `{"kind":"DISABLED",...}`。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/services/pickup.ts apps/server/scripts/selftest-pickup.ts apps/server/src/routes/local.ts
git commit -m "自取纯函数：时段生成/备餐起点/优惠/文案 + GET /local/pickup-slots，13 条自测"
```

---

### Task 4: 计价加自取优惠（纯函数 + 券封顶）

**Files:**
- Modify: `apps/server/src/services/member/pricing.ts:110-119`
- Modify: `apps/server/src/services/member/checkout.ts:201-219`
- Test: `apps/server/scripts/selftest-member.ts`

**Interfaces:**
- Produces：`computeCheckout({ subtotal, discount, shippingFee, pickupDiscount? })`；`loadCouponForOrder(userId, couponId, channel, subtotal, opts?: { maxDiscount?: number })`。

- [ ] **Step 1: 先写失败的 selftest**（追加到 `selftest-member.ts` 的 computeCheckout 段之后）

```ts
// ── computeCheckout：自取优惠（spec 2026-09-11 P6：小计 → 自取优惠 → 券 → 实付）──
t('computeCheckout 自取优惠先扣，再扣券', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 0, pickupDiscount: 250 }), { actualAmount: 4250 })
})
t('computeCheckout 不传 pickupDiscount 与传 0 逐字节一致', () => {
  assert.deepStrictEqual(computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 600 }), computeCheckout({ subtotal: 5000, discount: 500, shippingFee: 600, pickupDiscount: 0 }))
})
t('computeCheckout 自取优惠 + 券 超过小计 → 抛（调用方没封顶）', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 900, shippingFee: 0, pickupDiscount: 200 }))
})
t('computeCheckout 自取优惠为负 → 抛', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 0, shippingFee: 0, pickupDiscount: -1 }))
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-member.ts 2>&1 | tail -8`
Expected: 「自取优惠先扣」一条 ✘（实付算成 4500）。

- [ ] **Step 3: 改 `computeCheckout`**（整函数替换）

```ts
export function computeCheckout(i: {
  subtotal: number
  discount: number
  shippingFee: number
  /** 自取优惠（分），只有 PICKUP 单非 0。顺序：小计 → 自取优惠 → 券 → 运费（spec 2026-09-11 P6） */
  pickupDiscount?: number
}): { actualAmount: number } {
  const pickupDiscount = i.pickupDiscount ?? 0
  if (pickupDiscount < 0) throw new Error(`自取优惠 ${pickupDiscount} 为负：调用方传错`)
  if (pickupDiscount + i.discount > i.subtotal) {
    throw new Error(`自取优惠 ${pickupDiscount} + 折扣 ${i.discount} 超过商品小计 ${i.subtotal}：调用方未按封顶逻辑算券`)
  }
  return { actualAmount: i.subtotal - pickupDiscount - i.discount + i.shippingFee }
}
```

- [ ] **Step 4: `loadCouponForOrder` 加封顶参数**（整函数替换）

```ts
export async function loadCouponForOrder(
  userId: number,
  couponId: number,
  channel: CheckoutChannel,
  subtotal: number,
  /** 自取单：券面额封顶到「小计 − 自取优惠」（门槛仍按原小计判，见 checkCouponUsable 的 ctx.subtotal） */
  opts: { maxDiscount?: number } = {}
): Promise<ValidatedCoupon> {
  const c = await prisma.userCoupon.findFirst({
    where: { id: couponId, userId },
    select: { id: true, userId: true, name: true, amount: true, threshold: true, channel: true, status: true, expiresAt: true },
  })
  // 查不到与不属于本人是同一个回答：不暴露「这张券存在但不是你的」
  if (!c) throw new AppError(42251, '优惠券不存在')
  const r = checkCouponUsable(
    { userId: c.userId, amount: c.amount, threshold: c.threshold, channel: c.channel as 'ALL' | 'LOCAL' | 'EXPRESS', status: c.status, expiresAt: c.expiresAt },
    { userId, channel, subtotal }
  )
  if (!r.usable) throw new AppError(42251, r.message)
  const discount = opts.maxDiscount !== undefined ? Math.min(r.discount, Math.max(0, opts.maxDiscount)) : r.discount
  return { id: c.id, name: c.name, amount: c.amount, threshold: c.threshold, channel: c.channel, expiresAt: c.expiresAt, discount }
}
```

- [ ] **Step 5: 跑 selftest + tsc**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-member.ts && npx tsc --noEmit`
Expected: 全部通过；tsc 零错误。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/member/pricing.ts apps/server/src/services/member/checkout.ts apps/server/scripts/selftest-member.ts
git commit -m "计价：computeCheckout 加自取优惠入参，券按「小计−自取优惠」封顶，老调用方不变"
```

---

### Task 5: 顾客端下单、取消、列表、详情、取餐人记忆

**Files:**
- Modify: `apps/server/src/routes/orders.ts`（schema、创建分支、`cancelWindowOf`、`GET /`、`GET /:id`、`/:id/cancel-request`、`PUT /:id/cancel`、`PUT /:id/confirm`、`/meta`、新 `GET /pickup-contact`）
- Modify: `apps/server/src/services/subscribe-message.ts`（只加 `getSubscribeTemplateGroups`，模板发送在 Task 7）
- Modify: `apps/server/src/config.ts:190-199`（加 `pickupTemplateId/pickupFields`）
- Modify: `apps/server/src/services/order-notify.ts:90-133`（`notifyCancelRequest` 的 channel 扩成三值）
- Test: `scripts/e2e.d/62-pickup.sh`（本 Task 写 ①–⑦ 段，Task 6/8 续写）

**Interfaces:**
- Consumes：Task 3 的 `isValidPickupSlot/prepStartAt/pickupDiscountOf/pickupSlotLabel/buildPickupSlots`；Task 4 的两个签名；Task 2 的 `pickupAvailableNow/isHolidayNow/isPickupPaused`。
- Produces：`POST /orders` 接受 `deliveryType:'PICKUP', pickupAt, pickupContact`；`GET /orders?channel=LOCAL|EXPRESS`；`GET /orders/:id` 的 `pickup` 节与 `canSelfCancel`；`GET /orders/pickup-contact`；`/orders/meta` 与 `orderCreatedView` 的 `subscribeTemplates`。

- [ ] **Step 1: config 加订阅模板槽**。`config.ts` 的 `subscribe` 对象末尾（`deliverFields` 之后）加：

```ts
    pickupTemplateId: env.WECHAT_TMPL_PICKUP ?? '',
    pickupFields: env.WECHAT_TMPL_PICKUP_FIELDS ?? '',
```

- [ ] **Step 2: 订阅模板分组**。`subscribe-message.ts` 的 `getSubscribeTemplateIds` 之后加：

```ts
/**
 * 按结算场景分组的模板 ID（spec 2026-09-11 §4.8）。wx.requestSubscribeMessage 一次最多 3 个，
 * 三个渠道各自要的不一样：邮寄要发货，外送要配送，自取要取餐；退款三边都要。空 ID 自动剔除。
 * 老字段 getSubscribeTemplateIds 保留给老版本小程序。
 */
export function getSubscribeTemplateGroups(): { express: string[]; local: string[]; pickup: string[] } {
  const c = config.subscribe
  return {
    express: [c.shipTemplateId, c.refundTemplateId].filter(Boolean),
    local: [c.deliverTemplateId, c.refundTemplateId].filter(Boolean),
    pickup: [c.pickupTemplateId, c.refundTemplateId].filter(Boolean),
  }
}
```

- [ ] **Step 3: `notifyCancelRequest` 扩成三渠道**。`order-notify.ts` 里该函数：参数类型 `channel: 'LOCAL' | 'EXPRESS'` 改为 `channel: 'LOCAL' | 'EXPRESS' | 'PICKUP'`；函数体开头的四个变量改为：

```ts
  const windowText = channel === 'PICKUP'
    ? '备好之前可申请'
    : graceMin > 0 ? `接单后 ${graceMin} 分钟内` : '接单后不可申请（窗口已关闭）'
  const isExpress = channel === 'EXPRESS'
  const title = channel === 'PICKUP' ? '自取订单申请取消' : isExpress ? '邮寄订单申请取消' : '同城订单申请取消'
  const header = channel === 'PICKUP'
    ? `**🏪 自取订单：顾客申请取消（${windowText}，需确认全额退款）**`
    : isExpress
      ? `**📦 邮寄订单：顾客申请取消（${windowText}，需确认全额退款）**`
      : `**🛵 同城订单：顾客申请取消（${windowText}，需确认全额退款）**`
  const footer = channel === 'PICKUP' ? '请到后台「接单工作台」处理' : isExpress ? '请到后台「接单工作台」或「全国邮寄」订单页处理' : '请到后台「同城订单」处理'
```

- [ ] **Step 4: orders.ts 的 import 与 schema**。import 改为：

```ts
import { channelOfDeliveryType, deliveryTypeSchema } from '../utils/channel'
import {
  getLocalSettings, isOpenNow, isPaused, nextOpenText, calcLocalFee, verifyQuote, haversineM,
  isHolidayNow, isPickupPaused, LocalDeliverySettings,
} from '../services/local-settings'
import { isValidPickupSlot, prepStartAt, pickupDiscountOf, pickupSlotLabel } from '../services/pickup'
import { getSubscribeTemplateIds, sendPaidSubscribeMessage, getSubscribeTemplateGroups } from '../services/subscribe-message'
```

（前两条是替换现有的同名 import 行，后两条是新增。）

`createOrderSchema`：

```ts
    addressId: z.number().int().positive('请选择收货地址').optional(),
    deliveryType: deliveryTypeSchema.default('EXPRESS'),
    // ── 到店自取（spec 2026-09-11 §4.3）──
    pickupAt: z.string().datetime({ offset: true }).optional(),
    pickupContact: z
      .object({ name: z.string().trim().max(32).optional(), phone: z.string().trim().regex(/^1\d{10}$/, '取餐人手机号无效') })
      .optional(),
```

并在两个 `.refine` 之后再加两条：

```ts
  .refine((v) => (v.deliveryType === 'PICKUP' ? v.addressId === undefined : v.addressId !== undefined), {
    message: '自取订单不需要收货地址；外送/邮寄订单请选择收货地址',
  })
  .refine((v) => v.deliveryType !== 'PICKUP' || (!!v.pickupAt && !!v.pickupContact), { message: '请选择取餐时间并填写取餐人手机号' })
```

- [ ] **Step 5: 创建分支**。`router.post('/')` 里：解构加 `pickupAt, pickupContact`。把「3. 获取收货地址」改为：

```ts
    // 3. 收货地址（自取单没有：取餐地点是门店，后面写门店地址快照）
    const address = deliveryType === 'PICKUP'
      ? null
      : await prisma.address.findFirst({ where: { id: addressId!, userId, deletedAt: null } })
    if (deliveryType !== 'PICKUP' && !address) throw new AppError(40401, '收货地址不存在', 404)
```

「会员优惠」段里 `const coupon = couponId ? await loadCouponForOrder(userId, couponId, channel, totalAmount) : null` 改为放到自取优惠算完之后（见下），先声明 `let pickupDiscount = 0`。

`let shippingFee = 0` 之前加：

```ts
    // ── 自取：优惠先于券算出来，券面额按「小计 − 自取优惠」封顶（spec P6）──
    let pickupDiscount = 0
    let pickupSnapshot: { pickupAt?: Date; pickupDiscountAmount?: number } = {}
    let localStore: LocalDeliverySettings['store'] | null = null
```

`if (deliveryType === 'LOCAL') {` 之前插入 PICKUP 分支（整个 if/else 变成 `if PICKUP / else if LOCAL / else`）：

```ts
    if (deliveryType === 'PICKUP') {
      const s = await getLocalSettings()
      if (!s.pickup.enabled) throw new AppError(42280, '到店自取暂未开通')
      if (isHolidayNow(s)) throw new AppError(42280, `休息中${s.holiday?.until ? `，${s.holiday.until.slice(5).replace('-', '月')}日恢复` : ''}`)
      if (isPickupPaused(s)) throw new AppError(42280, `自取暂停接单${s.pickup.paused?.reason ? `：${s.pickup.paused.reason}` : ''}`)
      const at = new Date(pickupAt!)
      // 必须精确命中此刻算出的某一格：顾客在页面磨蹭到那格过期了就拒，让他重选
      if (!isValidPickupSlot(s, at, new Date())) throw new AppError(42281, '该时段已不可选，请重新选择取餐时间')
      if (s.pickup.minOrderAmountFen > 0 && totalAmount < s.pickup.minOrderAmountFen) {
        throw new AppError(42282, `到店自取满 ¥${(s.pickup.minOrderAmountFen / 100).toFixed(2)} 起，当前 ¥${(totalAmount / 100).toFixed(2)}`)
      }
      pickupDiscount = pickupDiscountOf(s, totalAmount)
      pickupSnapshot = { pickupAt: at, pickupDiscountAmount: pickupDiscount }
      localStore = s.store
    } else if (deliveryType === 'LOCAL') {
```

然后把原来的 `const coupon = …` 一行移到这整段 if/else **之后**、`const discount = coupon?.discount ?? 0` 之前，改为：

```ts
    const coupon = couponId
      ? await loadCouponForOrder(userId, couponId, channel, totalAmount, deliveryType === 'PICKUP' ? { maxDiscount: totalAmount - pickupDiscount } : {})
      : null
```

⚠️ 原来 `loadCouponForOrder` 在赠品聚合校验之前调用；挪到后面不改变任何校验结果（它是只读校验），但要确认 `coupon` 在 LOCAL/EXPRESS 分支里没有被引用（当前没有）。

`computeCheckout` 调用改为 `computeCheckout({ subtotal: totalAmount, discount, shippingFee, pickupDiscount })`。

LOCAL 与 EXPRESS 分支里所有 `address.xxx` 改为 `address!.xxx`（这两个分支 `address` 必非空）。

事务里 `tx.order.create` 的 `data`：

```ts
          receiverName: deliveryType === 'PICKUP' ? (pickupContact!.name || '顾客') : address!.receiverName,
          receiverPhone: deliveryType === 'PICKUP' ? pickupContact!.phone : address!.receiverPhone,
          receiverProvince: deliveryType === 'PICKUP' ? localStore!.province : address!.province,
          receiverCity: deliveryType === 'PICKUP' ? localStore!.city : address!.city,
          receiverDistrict: deliveryType === 'PICKUP' ? localStore!.district : address!.district,
          receiverDetail: deliveryType === 'PICKUP' ? localStore!.address : address!.detail,
          receiverFullAddress: deliveryType === 'PICKUP'
            ? `${localStore!.province}${localStore!.city}${localStore!.district}${localStore!.address}`
            : address!.fullAddress,
          ...localSnapshot,
          ...pickupSnapshot,
```

顶部 import 加 `LocalDeliverySettings` 类型：`import { …, LocalDeliverySettings } from '../services/local-settings'`。

- [ ] **Step 6: `orderCreatedView` 与 `/meta` 加字段**。`orderCreatedView` 返回里加：

```ts
    pickupAt: order.pickupAt ?? null,
    pickupDiscountAmount: order.pickupDiscountAmount,
    subscribeTemplates: getSubscribeTemplateGroups(),
```

`/meta` 的 `success(res, {…})` 加 `subscribeTemplates: getSubscribeTemplateGroups(),`。

- [ ] **Step 7: 取消窗口**。`cancelWindowOf` 整函数替换：

```ts
/**
 * D6 ②：同城/邮寄订单接单后 acceptGraceMin 分钟内可申请取消（各渠道各自的宽限分钟，0 = 关闭）。
 * 自取（spec 2026-09-11 P10）：接单前且未到开始备餐时刻 → 自助秒退（不走这里）；
 * PAID 且已过开始备餐时刻、或 PREPARING → 可申请；已备好（SHIPPED）后关闭。没有分钟数的概念。
 */
async function cancelWindowOf(order: { deliveryType: string; status: string; acceptedAt: Date | null; cancelRequestedAt: Date | null; pickupAt: Date | null }) {
  const closed = { canRequestCancel: false, cancelRequestDeadline: null as Date | null, cancelGraceMin: 0 }
  if (order.deliveryType === 'PICKUP') {
    if (!order.pickupAt || order.cancelRequestedAt) return closed
    if (order.status === 'PREPARING') return { canRequestCancel: true, cancelRequestDeadline: null, cancelGraceMin: 0 }
    if (order.status === 'PAID') {
      const s = await getLocalSettings()
      return { canRequestCancel: Date.now() >= prepStartAt(s, order.pickupAt).getTime(), cancelRequestDeadline: null, cancelGraceMin: 0 }
    }
    return closed
  }
  if (order.status !== 'PREPARING' || !order.acceptedAt) return closed
  const graceMin = order.deliveryType === 'LOCAL' ? (await getLocalSettings()).acceptGraceMin : order.deliveryType === 'EXPRESS' ? (await getExpressSettings()).acceptGraceMin : 0
  if (graceMin <= 0) return closed
  const deadline = new Date(order.acceptedAt.getTime() + graceMin * 60 * 1000)
  return { canRequestCancel: !order.cancelRequestedAt && Date.now() < deadline.getTime(), cancelRequestDeadline: deadline, cancelGraceMin: graceMin }
}
```

- [ ] **Step 8: `cancel-request` 路由**。`const moved = await prisma.order.updateMany({ where: { id, status: 'PREPARING', cancelRequestedAt: null }, …` 改为 `where: { id, status: { in: order.deliveryType === 'PICKUP' ? ['PAID', 'PREPARING'] : ['PREPARING'] }, cancelRequestedAt: null }`。`snapshotStatus` 改为：

```ts
    const snapshotStatus =
      order.deliveryType === 'LOCAL'
        ? ((await prisma.delivery.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE')
        : order.deliveryType === 'EXPRESS'
          ? ((await prisma.expressBooking.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE')
          : 'NONE'
```

`notifyCancelRequest(…, order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS')` 改为 `order.deliveryType === 'LOCAL' ? 'LOCAL' : order.deliveryType === 'PICKUP' ? 'PICKUP' : 'EXPRESS'`。

- [ ] **Step 9: 自助取消 `PUT /:id/cancel`**。在 `if (order.status === 'PAID' && !order.acceptedAt) {` 之前加：

```ts
    // 自取：已到开始备餐时刻就不能自助退了（店里可能已经在做），转「申请取消」（spec P10）
    if (order.deliveryType === 'PICKUP' && order.status === 'PAID' && order.pickupAt) {
      const s = await getLocalSettings()
      if (Date.now() >= prepStartAt(s, order.pickupAt).getTime()) throw new AppError(42229, '已进入备餐时段，请改为「申请取消」由商家确认')
    }
```

- [ ] **Step 10: `PUT /:id/confirm`**。`if (order.deliveryType === 'LOCAL') throw …` 之后加 `if (order.deliveryType === 'PICKUP') throw new AppError(42284, '自取订单由店员点「已取走」完成')`。

- [ ] **Step 11: 列表 `channel` 参数**。`GET /` 里 `deliveryType` 解析改为：

```ts
    const rawDeliveryType = req.query.deliveryType
    const deliveryType = rawDeliveryType ? deliveryTypeSchema.parse(rawDeliveryType) : undefined
    // channel=LOCAL 一次拿外送 + 自取（同城渠道下的「我的订单」）；channel=EXPRESS 等价 deliveryType=EXPRESS
    const rawChannel = req.query.channel
    const channelFilter = rawChannel ? z.enum(['EXPRESS', 'LOCAL']).parse(rawChannel) : undefined
    const where = {
      userId,
      ...(deliveryType ? { deliveryType } : channelFilter === 'LOCAL' ? { deliveryType: { in: ['LOCAL', 'PICKUP'] } } : channelFilter === 'EXPRESS' ? { deliveryType: 'EXPRESS' } : {}),
      ...(statuses.length === 1 ? { status: statuses[0] } : statuses.length > 1 ? { status: { in: statuses } } : {}),
    }
```

- [ ] **Step 12: 详情 `pickup` 节**。`GET /:id` 的 `success(res, {…})` 里 `delivery,` 之前加：

```ts
      pickup: await pickupViewOf(order),
      canSelfCancel: await canSelfCancelOf(order),
      subscribeTemplates: getSubscribeTemplateGroups(),
```

并在 `withPayExpire` 之后定义两个函数：

```ts
/** 顾客端自取节：取餐时间、备好时刻、开始备餐时刻、门店（spec §5.5）。非自取单为 null */
async function pickupViewOf(order: { deliveryType: string; pickupAt: Date | null; pickupReadyAt: Date | null }) {
  if (order.deliveryType !== 'PICKUP' || !order.pickupAt) return null
  const s = await getLocalSettings()
  return {
    pickupAt: order.pickupAt.toISOString(),
    pickupReadyAt: order.pickupReadyAt?.toISOString() ?? null,
    prepStartAt: prepStartAt(s, order.pickupAt).toISOString(),
    slotLabel: pickupSlotLabel(order.pickupAt, s.pickup.slotMinutes),
    store: { name: s.store.name, phone: s.store.phone, address: `${s.store.district}${s.store.address}`, latE6: s.store.latE6, lngE6: s.store.lngE6 },
  }
}
/** 「取消订单」按钮该不该出现：待付款一律可；自取 PAID 且未到开始备餐；其余渠道 PAID 未接单 */
async function canSelfCancelOf(order: { deliveryType: string; status: string; acceptedAt: Date | null; pickupAt: Date | null }) {
  if (order.status === 'PENDING_PAYMENT') return true
  if (order.status !== 'PAID' || order.acceptedAt) return false
  if (order.deliveryType !== 'PICKUP') return true
  if (!order.pickupAt) return false
  const s = await getLocalSettings()
  return Date.now() < prepStartAt(s, order.pickupAt).getTime()
}
```

- [ ] **Step 13: `GET /pickup-contact`**。必须注册在 `GET /:id` 之前（与 `/meta`、`/:id/courier` 同样的顺序理由）：

```ts
// GET /api/orders/pickup-contact — 最近一张自取单的取餐人，结算页预填用（spec §3.3，不加表）
router.get('/pickup-contact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const last = await prisma.order.findFirst({
      where: { userId: req.userId!, deliveryType: 'PICKUP' },
      orderBy: { id: 'desc' },
      select: { receiverName: true, receiverPhone: true },
    })
    success(res, last ? { name: last.receiverName === '顾客' ? '' : last.receiverName, phone: last.receiverPhone } : null)
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 14: tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。若报 `cancelWindowOf` 的调用处缺 `pickupAt`，那两处（`GET /:id`、`cancel-request`）传的都是整行 `order`，已含该列。

- [ ] **Step 15: e2e §62 ①–⑦**。新建 `scripts/e2e.d/62-pickup.sh`：

```bash
echo "== 62. 到店自取：设置 / 时段 / 下单计价 / 取消 / 状态流 / 定时任务 =="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sched/sql/PJOBS；$UT/$AT/$LPID（同城商品）。变量一律 P62_ 前缀。
# 时段生成看真实时钟：营业时段钉成 00:00–23:59、daysAhead=1，任何时刻至少明天有格。
# 备餐 20 + 缓冲 5，最早格 = 现在 + 25 分钟向上取整到半点，所以「尽快格」的 prepStartAt 一定在未来 ≤ 30 分钟内。
P62_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
p62_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
p62_ord() { req GET "/api/admin/orders/$1" "$AT"; }
P62_PRICE=$(req GET "/api/products/$LPID" "$UT" | jq -r '.data.price')

echo "-- ① 未开通：时段 blocked=DISABLED，下单 42280 --"
p62_put '.pickup.enabled=false | .holiday=null' >/dev/null
assert_eq "未开通 blocked=DISABLED" "$(req GET /api/local/pickup-slots | jq -r '.data.blocked.kind')" "DISABLED"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:00:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "未开通下单 42280" "$(code "$R")" "42280"

echo "-- ② 开通：meta 分节、时段有格、外送开关独立 --"
R=$(p62_put '.pickup.enabled=true | .pickup.slotMinutes=30 | .pickup.acceptBufferMin=5 | .pickup.daysAhead=1 | .pickup.minOrderAmountFen=0 | .pickup.discount={type:"PERCENT",value:95} | .pickup.autoCompleteAfterMin=120 | .pickup.unpickedRemindAfterMin=30 | .prepMinutes=20 | .peak.windows=[] | .businessHours=[{start:"00:00",end:"23:59"}] | .holiday=null | .pickup.paused=null')
assert_eq "开通自取 code 0" "$(code "$R")" "0"
R=$(req GET /api/local/meta)
assert_eq "meta.pickup.enabled=true" "$(jq -r '.data.pickup.enabled' <<<"$R")" "true"
assert_eq "meta.pickup.discountText=自取享 9.5 折" "$(jq -r '.data.pickup.discountText' <<<"$R")" "自取享 9.5 折"
assert_eq "meta.delivery.enabled 与老字段 enabled 一致" "$(jq -r '.data.delivery.enabled' <<<"$R")" "$(jq -r '.data.enabled' <<<"$R")"
[[ "$(jq -r '.data.businessHours | length' <<<"$R")" -ge 1 ]] && ok "老字段 businessHours 仍下发" || fail "老字段 businessHours 丢了"
R=$(req GET /api/local/pickup-slots)
assert_eq "时段 blocked=null" "$(jq -r '.data.blocked' <<<"$R")" "null"
P62_SLOT=$(jq -r '[.data.days[].slots[]][0].startAt' <<<"$R")
P62_SLOT2=$(jq -r '[.data.days[].slots[]][3].startAt' <<<"$R")
[[ "$P62_SLOT" != "null" && -n "$P62_SLOT" ]] && ok "拿到最早格 $P62_SLOT" || fail "没有可选时段" "$R"
assert_eq "earliestAt = 第一格" "$(jq -r '.data.earliestAt' <<<"$R")" "$P62_SLOT"

echo "-- ③ 下单：手机号校验、非整格 42281、计价（9.5 折 + 运费 0）、门店地址快照 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"123\"}}")
assert_eq "手机号无效 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:07:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "非整格时段 42281" "$(code "$R")" "42281"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"addressId\":1,\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "自取带 addressId 40001" "$(code "$R")" "40001"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"name\":\"张三\",\"phone\":\"13800001234\"}}")
assert_eq "自取下单 code 0" "$(code "$R")" "0"
P62_O1=$(jq -r .data.orderId <<<"$R")
P62_DISC=$(( P62_PRICE - (P62_PRICE * 95 + 50) / 100 ))   # round(price×0.95)：整数四舍五入
assert_eq "pickupDiscountAmount = 5%" "$(jq -r .data.pickupDiscountAmount <<<"$R")" "$P62_DISC"
assert_eq "shippingFee=0" "$(jq -r .data.shippingFee <<<"$R")" "0"
assert_eq "actualAmount = 小计 − 自取优惠" "$(jq -r .data.actualAmount <<<"$R")" "$((P62_PRICE - P62_DISC))"
assert_eq "subscribeTemplates.pickup 是数组" "$(jq -r '.data.subscribeTemplates.pickup | type' <<<"$R")" "array"
assert_eq "落库 delivery_type=PICKUP" "$(sql "SELECT delivery_type FROM orders WHERE id=$P62_O1;")" "PICKUP"
assert_eq "落库 pickup_at 非空" "$(sql "SELECT pickup_at IS NOT NULL FROM orders WHERE id=$P62_O1;")" "1"
assert_eq "取餐人姓名" "$(sql "SELECT receiver_name FROM orders WHERE id=$P62_O1;")" "张三"
[[ "$(sql "SELECT receiver_full_address FROM orders WHERE id=$P62_O1;")" == *"自贡"* ]] && ok "地址列是门店地址快照" || fail "地址列不是门店地址"
assert_eq "pickup-contact 回最近一单" "$(req GET /api/orders/pickup-contact "$UT" | jq -r '.data.phone')" "13800001234"

echo "-- ④ 起送门槛 42282；券叠加：门槛看原小计、面额封顶到小计−自取优惠 --"
p62_put ".pickup.minOrderAmountFen=$((P62_PRICE+1))" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"}}")
assert_eq "未达自取起送 42282" "$(code "$R")" "42282"
p62_put '.pickup.minOrderAmountFen=0' >/dev/null
# 一张面额 = 原小计 的券：门槛=原小计（刚好可用），面额本应抵到 0，自取单要封顶到 小计−自取优惠，实付 = 0 → 42251 拒
P62_TID=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E自取大券\",\"amount\":$P62_PRICE,\"threshold\":$P62_PRICE,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P62_CID=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P62_TID}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"},\"couponId\":$P62_CID}")
assert_eq "券把实付减到 0 → 42251" "$(code "$R")" "42251"
# 面额 = 自取优惠 + 100 的券：封顶后仍是原面额（未超过 小计−自取优惠），实付 = 小计 − 自取优惠 − 面额
P62_TID2=$(req POST /api/admin/coupon-templates "$AT" "{\"name\":\"E2E自取小券\",\"amount\":$((P62_DISC+100)),\"threshold\":$P62_PRICE,\"channel\":\"LOCAL\",\"validDays\":30,\"source\":\"CAMPAIGN\"}" | jq -r '.data.id')
P62_CID2=$(req POST /api/member/coupons/claim "$UT" "{\"templateId\":$P62_TID2}" | jq -r '.data.id')
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT\",\"pickupContact\":{\"phone\":\"13800001234\"},\"couponId\":$P62_CID2}")
assert_eq "用券下单 code 0（门槛按原小计判）" "$(code "$R")" "0"
P62_O2=$(jq -r .data.orderId <<<"$R")
assert_eq "实付 = 小计 − 自取优惠 − 券" "$(jq -r .data.actualAmount <<<"$R")" "$((P62_PRICE - P62_DISC - P62_DISC - 100))"

echo "-- ⑤ 列表 channel=LOCAL 同时返回外送与自取；deliveryType=PICKUP 只回自取 --"
R=$(req GET "/api/orders?channel=LOCAL&pageSize=50" "$UT")
[[ "$(jq -r "[.data.list[] | select(.id==$P62_O1)] | length" <<<"$R")" == "1" ]] && ok "channel=LOCAL 含自取单" || fail "channel=LOCAL 不含自取单"
[[ "$(jq -r '[.data.list[] | select(.deliveryType=="LOCAL")] | length' <<<"$R")" -ge 1 ]] && ok "channel=LOCAL 含外送单" || fail "channel=LOCAL 不含外送单"
R=$(req GET "/api/orders?deliveryType=PICKUP&pageSize=50" "$UT")
assert_eq "deliveryType=PICKUP 全是自取" "$(jq -r '[.data.list[] | select(.deliveryType!="PICKUP")] | length' <<<"$R")" "0"

echo "-- ⑥ 详情 pickup 节；自助取消：未付款可取消；付款后未到开始备餐可秒退 --"
R=$(req GET "/api/orders/$P62_O1" "$UT")
assert_eq "详情 pickup.slotLabel 非空" "$(jq -r '.data.pickup.slotLabel | length > 0' <<<"$R")" "true"
assert_eq "详情 pickup.store.name" "$(jq -r '.data.pickup.store.name | length > 0' <<<"$R")" "true"
assert_eq "待付款 canSelfCancel=true" "$(jq -r '.data.canSelfCancel' <<<"$R")" "true"
req POST "/api/orders/$P62_O2/pay" "$UT" >/dev/null
assert_eq "O2 已付款" "$(p62_ord "$P62_O2" | jq -r .data.status)" "PAID"
R=$(req PUT "/api/orders/$P62_O2/cancel" "$UT")
assert_eq "付款后、开始备餐前自助取消 code 0" "$(code "$R")" "0"
assert_eq "O2 → REFUNDED（mock 即时）" "$(p62_ord "$P62_O2" | jq -r .data.status)" "REFUNDED"

echo "-- ⑦ 已到开始备餐时刻：自助取消 42229、可申请取消（PAID 也行）；接单后仍可申请 --"
req POST "/api/orders/$P62_O1/pay" "$UT" >/dev/null
sql "UPDATE orders SET pickup_at=DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id=$P62_O1;"
R=$(req PUT "/api/orders/$P62_O1/cancel" "$UT")
assert_eq "已过开始备餐时刻自助取消 42229" "$(code "$R")" "42229"
assert_eq "此时 canSelfCancel=false、canRequestCancel=true" "$(req GET "/api/orders/$P62_O1" "$UT" | jq -r '[.data.canSelfCancel,.data.canRequestCancel] | join(",")')" "false,true"
R=$(req POST "/api/orders/$P62_O1/cancel-request" "$UT" '{"note":"临时有事"}')
assert_eq "PAID 状态申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/orders/$P62_O1/cancel-request" "$UT" '{}')
assert_eq "重复申请 42229" "$(code "$R")" "42229"
```

（`P62_O1` 留到 Task 6 的 ⑧ 段继续用；不要在本 Task 收尾。）

- [ ] **Step 16: 跑 e2e 全量**

Run: `bash scripts/e2e.sh 2>&1 | tail -30`
Expected: §62 ①–⑦ 全 ✔；末行「失败 0」。若 §40–§61 有红，停下上报。

- [ ] **Step 17: Commit**

```bash
git add apps/server/src/routes/orders.ts apps/server/src/services/subscribe-message.ts apps/server/src/config.ts apps/server/src/services/order-notify.ts scripts/e2e.d/62-pickup.sh
git commit -m "自取下单：PICKUP 分支（时段/门槛/优惠/门店地址快照）、取消规则按开始备餐时刻、列表 channel 过滤、详情 pickup 节、取餐人记忆；e2e §62 ①–⑦"
```

---

### Task 6: 管理端状态流端点、误操作拦截、工作台快照字段

**Files:**
- Modify: `apps/server/src/routes/admin/orders.ts`（`GET /` 的 `channel` 参数、`pending-count`、`/:id/accept` 注释、`/:id/ship`、`/:id/complete`、新 `/:id/pickup-ready`、`/:id/picked-up`、`/:id/cancel-request/approve`、`/:id/cancel-request/reject`）
- Modify: `apps/server/src/routes/admin/delivery.ts:35-40`（`doAccept` 已拒绝非 LOCAL，只补注释）
- Modify: `apps/server/src/routes/admin/workbench.ts`（`toCard` 加 `pickup` 节；`loadOrders` 的 select 若是显式列表要加 `pickupAt/pickupReadyAt`）
- Test: `scripts/e2e.d/62-pickup.sh` ⑧–⑩

**Interfaces:**
- Consumes：Task 3 `prepStartAt/pickupSlotLabel`；`sendPickupReadySubscribeMessage`——本 Task 的 Step 1 先在 `subscribe-message.ts` 里放一个空实现保证编译，Task 7 再填字段映射。每个 Task 结束时 tsc 都必须零错误。
- Produces：`POST /admin/orders/:id/pickup-ready`、`POST /admin/orders/:id/picked-up`、`POST /admin/orders/:id/cancel-request/approve|reject`（仅 PICKUP）；工作台卡片 `pickup: { pickupAt, pickupReadyAt, prepStartAt, slotLabel, cancelRequested, cancelRejected, acceptedAt } | null`；`GET /admin/orders?channel=LOCAL`；`pending-count.localPendingCount` 含自取。

- [ ] **Step 1: 订阅消息空实现（Task 7 填内容）**。`subscribe-message.ts` 末尾加：

```ts
/** 「已备好，请来取餐」（Task 7 实现字段映射；先留空壳保证编译） */
export function sendPickupReadySubscribeMessage(
  openid: string,
  order: { id: number; orderNo: string; pickupAt: Date | null; receiverName: string },
  productName?: string
): void {
  void openid; void order; void productName
}
```

- [ ] **Step 2: admin/orders.ts import**。加：

```ts
import { getLocalSettings } from '../../services/local-settings'
import { prepStartAt, pickupSlotLabel } from '../../services/pickup'
import { sendPickupReadySubscribeMessage } from '../../services/subscribe-message'
import { rejectCancelRequest } from '../../services/cancel-request'
import { settlePoints } from '../../services/member/points'
```

- [ ] **Step 3: 列表与铃铛**。`GET /` 里 `const dt = …` 与 `where` 的渠道那行改为：

```ts
    // 邮寄订单页默认只看 EXPRESS；同城看板传 LOCAL / PICKUP；channel=LOCAL 一次看外送 + 自取；ALL 不过滤
    const dt = (req.query.deliveryType as string | undefined) ?? 'EXPRESS'
    const ch = req.query.channel as string | undefined
    const dtWhere = ch === 'LOCAL'
      ? { deliveryType: { in: ['LOCAL', 'PICKUP'] } }
      : dt === 'ALL' ? {} : { deliveryType: dt === 'LOCAL' ? 'LOCAL' : dt === 'PICKUP' ? 'PICKUP' : 'EXPRESS' }
```

`where` 里 `...(dt === 'ALL' ? {} : { deliveryType: … })` 换成 `...dtWhere`。`receiverDisplayAddress: displayAddress(o, o.deliveryType === 'LOCAL')` 改为 `displayAddress(o, o.deliveryType === 'LOCAL' || o.deliveryType === 'PICKUP')`（自取地址列是门店地址，同样只显示「区 + 详细」）。`orderListSelect` 加 `pickupAt: true, pickupReadyAt: true, pickupDiscountAmount: true,`。

`pending-count` 的 `localPendingCount` 查询里 `deliveryType: 'LOCAL'` 改为 `deliveryType: { in: ['LOCAL', 'PICKUP'] }`。

- [ ] **Step 4: 误操作拦截**。`/:id/ship` 里 `if (order.deliveryType === 'LOCAL') throw …` 之后加 `if (order.deliveryType === 'PICKUP') throw new AppError(42284, '自取订单没有快递：备好后点「已备好」，顾客取走后点「已取走」')`。`/:id/complete` 里同位置加 `if (target.deliveryType === 'PICKUP') throw new AppError(42284, '自取订单请点「已取走」完成')`。`/:id/accept` 不改（PICKUP 本来就走这条；LOCAL 仍被拒），只在其注释里补一句「自取单也走这里」。

- [ ] **Step 5: 新端点**（放在 `/:id/complete` 之后）

```ts
// POST /api/admin/orders/:id/pickup-ready — 自取「已备好」（PREPARING → SHIPPED，顾客收到取餐提醒）
router.post('/:id/pickup-ready', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({
      where: { id },
      include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1 } },
    })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.deliveryType !== 'PICKUP') throw new AppError(42284, '仅自取订单可标记「已备好」')
    const pickupReadyAt = new Date()
    const moved = await prisma.order.updateMany({
      where: { id, status: 'PREPARING', deliveryType: 'PICKUP' },
      data: { status: 'SHIPPED', pickupReadyAt },
    })
    if (moved.count === 0) {
      const cur = await prisma.order.findUnique({ where: { id }, select: { status: true } })
      throw new AppError(42204, `订单状态为 ${cur?.status ?? '未知'}，仅备餐中的自取订单可标记已备好`)
    }
    // 有未处理的取消申请：菜已经做好了，视同驳回（spec §4.4）。rejectCancelRequest 对 SHIPPED 允许（只拒终态）
    if (order.cancelRequestedAt) await rejectCancelRequest(id, 'MANUAL', { returnOrder: false })
    sendPickupReadySubscribeMessage(order.user.openid, { ...order, pickupAt: order.pickupAt }, order.items[0]?.productName)
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/picked-up — 自取「已取走」（SHIPPED → COMPLETED）
router.post('/:id/picked-up', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType !== 'PICKUP') throw new AppError(42284, '仅自取订单可标记「已取走」')
    const moved = await prisma.order.updateMany({
      where: { id, status: 'SHIPPED', deliveryType: 'PICKUP' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) {
      const cur = await prisma.order.findUnique({ where: { id }, select: { status: true } })
      throw new AppError(42204, `订单状态为 ${cur?.status ?? '未知'}，仅「待取餐」的自取订单可标记已取走`)
    }
    void settlePoints(id) // 与顾客确认收货同款：失败由 settleMissedPoints 兜底
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/cancel-request/approve — 自取：同意取消 = 全额退（没有配送单/预约要撤）
router.post('/:id/cancel-request/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const order = await prisma.order.findUnique({ where: { id } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (order.deliveryType !== 'PICKUP') throw new AppError(42284, '同城/邮寄订单的取消申请请到各自看板处理')
    if (!order.cancelRequestedAt) throw new AppError(42204, '该订单没有待处理的取消申请')
    const result = await initiateRefund({ orderId: id, amount: remainingRefundable(order), reason: '顾客申请取消', operator: req.adminUsername ?? 'admin' })
    // 与邮寄 approveExpressCancelRequest 同款：退款已发起就清标记，免得工作台同时显示「退款中」和「待处理申请」
    await prisma.order.updateMany({
      where: { id, cancelRequestedAt: { not: null } },
      data: { cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null },
    })
    success(res, result)
  } catch (e) {
    next(e)
  }
})

// POST /api/admin/orders/:id/cancel-request/reject — 自取：驳回（同城/邮寄各有自己的路由）
router.post('/:id/cancel-request/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType !== 'PICKUP') throw new AppError(42284, '同城/邮寄订单的取消申请请到各自看板处理')
    success(res, await rejectCancelRequest(id, 'MANUAL'))
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 6: 工作台卡片 `pickup` 节**。`workbench.ts` 的 `toCard` 签名末尾加参数 `pk: { prepStartAt: string; slotLabel: string } | null = null`，返回对象 `local: …` 之后加：

```ts
    pickup: o.deliveryType === 'PICKUP'
      ? {
          pickupAt: o.pickupAt?.toISOString() ?? null,
          pickupReadyAt: o.pickupReadyAt?.toISOString() ?? null,
          prepStartAt: pk?.prepStartAt ?? null,
          slotLabel: pk?.slotLabel ?? '',
          cancelRequested: !!o.cancelRequestedAt && !['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(o.status),
          cancelRejected: !!o.cancelRequestRejectedAt && ['PAID', 'PREPARING'].includes(o.status)
            ? (o.cancelRequestRejectedBy === 'AUTO' ? 'AUTO' : 'MANUAL')
            : null,
          acceptedAt: o.acceptedAt?.toISOString() ?? null,
        }
      : null,
```

在 `/snapshot` 的 `for (const o of orders)` 循环开头加：

```ts
      const pk = o.deliveryType === 'PICKUP' && o.pickupAt
        ? { prepStartAt: prepStartAt(settings, o.pickupAt).toISOString(), slotLabel: pickupSlotLabel(o.pickupAt, settings.pickup.slotMinutes) }
        : null
```

并把该循环里每个 `toCard(…)` 调用补上第 5 个参数 `pk`（共 5 处：pending / waitingCourier 两处不必传——那两处只可能是 LOCAL/EXPRESS，传 `null` 即可以保持位置一致 / preparing / delivering / done）。`sortColumn` 的排序改为三档：

```ts
const CHANNEL_RANK: Record<string, number> = { LOCAL: 0, PICKUP: 1, EXPRESS: 2 }
function sortColumn(cards: { channel: string; waitSince: string }[], newestFirst = false) {
  cards.sort((a, b) => {
    if (a.channel !== b.channel) return (CHANNEL_RANK[a.channel] ?? 9) - (CHANNEL_RANK[b.channel] ?? 9)
    return newestFirst ? b.waitSince.localeCompare(a.waitSince) : a.waitSince.localeCompare(b.waitSince)
  })
}
```

import 加 `import { prepStartAt, pickupSlotLabel } from '../../services/pickup'`。`loadOrders` 若用了显式 `select`，加 `pickupAt: true, pickupReadyAt: true`（现状是 `include`，Order 标量全返回，不用改）。快照顶层加 `pickupEnabled: settings.pickup.enabled, pickupPaused: settings.pickup.paused, holiday: settings.holiday,` 三个字段（批次三前端用）。

- [ ] **Step 7: tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

- [ ] **Step 8: e2e ⑧–⑩**（追加到 `62-pickup.sh`）

```bash
echo "-- ⑧ 状态流：接单（通用 accept）→ 已备好（视同驳回取消申请）→ 已取走；同城 accept 拒 --"
R=$(req POST "/api/admin/local/orders/$P62_O1/accept" "$AT")
assert_eq "同城看板 accept 拒自取 42204" "$(code "$R")" "42204"
R=$(req POST "/api/admin/orders/$P62_O1/picked-up" "$AT")
assert_eq "PAID 点已取走 42204" "$(code "$R")" "42204"
R=$(req POST "/api/admin/orders/$P62_O1/accept" "$AT")
assert_eq "接单 code 0" "$(code "$R")" "0"
assert_eq "→ PREPARING" "$(p62_ord "$P62_O1" | jq -r .data.status)" "PREPARING"
R=$(req POST "/api/admin/orders/$P62_O1/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"SF1"}')
assert_eq "自取单填单号发货 42284" "$(code "$R")" "42284"
R=$(req POST "/api/admin/orders/$P62_O1/pickup-ready" "$AT")
assert_eq "已备好 code 0" "$(code "$R")" "0"
assert_eq "→ SHIPPED（待取餐）" "$(p62_ord "$P62_O1" | jq -r .data.status)" "SHIPPED"
assert_eq "pickup_ready_at 已写" "$(sql "SELECT pickup_ready_at IS NOT NULL FROM orders WHERE id=$P62_O1;")" "1"
assert_eq "备好视同驳回：cancel_requested_at 清空" "$(sql "SELECT cancel_requested_at IS NULL FROM orders WHERE id=$P62_O1;")" "1"
assert_eq "驳回痕迹 MANUAL" "$(sql "SELECT cancel_request_rejected_by FROM orders WHERE id=$P62_O1;")" "MANUAL"
R=$(req POST "/api/admin/orders/$P62_O1/complete" "$AT")
assert_eq "自取单「标记完成」42284" "$(code "$R")" "42284"
R=$(req PUT "/api/orders/$P62_O1/confirm" "$UT")
assert_eq "顾客确认收货对自取 42284" "$(code "$R")" "42284"
assert_eq "待取餐后 canRequestCancel=false" "$(req GET "/api/orders/$P62_O1" "$UT" | jq -r '.data.canRequestCancel')" "false"
R=$(req POST "/api/admin/orders/$P62_O1/picked-up" "$AT")
assert_eq "已取走 code 0" "$(code "$R")" "0"
assert_eq "→ COMPLETED" "$(p62_ord "$P62_O1" | jq -r .data.status)" "COMPLETED"

echo "-- ⑨ 工作台快照：自取卡带 pickup 节且排在同城之后、邮寄之前 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800005678\"}}")
P62_O3=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O3/pay" "$UT" >/dev/null
R=$(req GET "/api/admin/workbench/snapshot?fresh=1" "$AT")
P62_CARD=$(jq -c ".data.columns.pending[] | select(.orderId==$P62_O3)" <<<"$R")
[[ -n "$P62_CARD" ]] && ok "自取单在 pending 列" || fail "自取单不在 pending 列" "$R"
assert_eq "卡片 channel=PICKUP" "$(jq -r .channel <<<"$P62_CARD")" "PICKUP"
assert_eq "卡片 pickup.slotLabel 非空" "$(jq -r '.pickup.slotLabel | length > 0' <<<"$P62_CARD")" "true"
assert_eq "卡片 pickup.prepStartAt 非空" "$(jq -r '.pickup.prepStartAt != null' <<<"$P62_CARD")" "true"
assert_eq "卡片 local=null、express=null" "$(jq -r '[.local,.express] | map(. == null) | all' <<<"$P62_CARD")" "true"
assert_eq "快照顶层 pickupEnabled=true" "$(jq -r '.data.pickupEnabled' <<<"$R")" "true"
P62_RANKS=$(jq -r '.data.columns.pending | map(.channel) | map(if .=="LOCAL" then 0 elif .=="PICKUP" then 1 else 2 end) | . == sort' <<<"$R")
assert_eq "pending 列排序 同城 < 自取 < 邮寄" "$P62_RANKS" "true"

echo "-- ⑩ 取消申请：同意 = 全额退并清标记；驳回留痕；admin 列表 channel=LOCAL 含自取 --"
req POST "/api/admin/orders/$P62_O3/accept" "$AT" >/dev/null
R=$(req POST "/api/orders/$P62_O3/cancel-request" "$UT" '{"note":"不要了"}')
assert_eq "接单后申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/orders/$P62_O3/cancel-request/reject" "$AT")
assert_eq "驳回 code 0" "$(code "$R")" "0"
assert_eq "驳回后 cancelRequestRejectedBy=MANUAL" "$(jq -r .data.cancelRequestRejectedBy <<<"$R")" "MANUAL"
R=$(req POST "/api/orders/$P62_O3/cancel-request" "$UT" '{"note":"再申请一次"}')
assert_eq "驳回后可再申请 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/orders/$P62_O3/cancel-request/approve" "$AT")
assert_eq "同意 code 0" "$(code "$R")" "0"
assert_eq "同意 isFull=true" "$(jq -r .data.isFull <<<"$R")" "true"
assert_eq "O3 → REFUNDED" "$(p62_ord "$P62_O3" | jq -r .data.status)" "REFUNDED"
assert_eq "同意后标记清空" "$(sql "SELECT cancel_requested_at IS NULL FROM orders WHERE id=$P62_O3;")" "1"
R=$(req GET "/api/admin/orders?channel=LOCAL&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$P62_O3)] | length" <<<"$R")" == "1" ]] && ok "admin 列表 channel=LOCAL 含自取" || fail "admin 列表 channel=LOCAL 不含自取"
[[ "$(req GET /api/admin/orders/pending-count "$AT" | jq -r '.data.localPendingCount')" -ge 0 ]] && ok "pending-count 仍可用" || fail "pending-count 挂了"
```

- [ ] **Step 9: 跑 e2e 全量**

Run: `bash scripts/e2e.sh 2>&1 | tail -30`
Expected: §62 ①–⑩ 全 ✔；「失败 0」。

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/routes/admin/orders.ts apps/server/src/routes/admin/workbench.ts apps/server/src/services/subscribe-message.ts scripts/e2e.d/62-pickup.sh
git commit -m "自取管理端：已备好/已取走/取消申请同意与驳回，发货与完成对自取拦截，工作台卡片 pickup 节与三档排序；e2e §62 ⑧–⑩"
```

---

### Task 7: 订阅消息、小票、店员推送

**Files:**
- Modify: `apps/server/src/services/subscribe-message.ts`（填 `sendPickupReadySubscribeMessage`；`sendPaidSubscribeMessage` 的 `deliveryLabel` 已含 PICKUP）
- Modify: `apps/server/src/services/ticket/content.ts`（`TicketChannel` 加 `PICKUP`；`TicketOrderInput` 加 `pickupAt/pickupSlotLabel/pickupDiscountAmount`；四个 render 函数的渠道文案）
- Modify: `apps/server/src/services/ticket/index.ts`（`ORDER_SELECT`、`toTicketInput`、`renderForKind`、`enqueueOrderTicket` 的 `PrinterChannel` 映射、`repeatAnnounce` 门控）
- Modify: `apps/server/src/services/order-notify.ts`（`notifyOrderPaid` 标题按渠道；新增 `notifyPickupUnpicked`、`notifyPickupAutoCompleted`）
- Modify: `.env.example`
- Test: `apps/server/scripts/selftest-member.ts`（自取小票 1 条）；e2e §62 ⑪（小票内容）

**Interfaces:**
- Produces：`sendPickupReadySubscribeMessage`（实现）；`notifyPickupUnpicked(orders)`、`notifyPickupAutoCompleted(orders)`（Task 8 用）；`TicketOrderInput.channel: 'LOCAL' | 'EXPRESS' | 'PICKUP'`。

- [ ] **Step 1: selftest（先失败）**。`selftest-member.ts` 里现有 `renderOrderTicket` 测试之后加：

```ts
t('自取小票：票头「到店自取」、取餐时间放大、不印地址/距离/运费、印自取优惠、有厨房联', () => {
  const s = renderOrderTicket({
    channel: 'PICKUP', orderNo: 'ORD1', createdAt: new Date('2026-09-11T02:00:00Z'), paidAt: new Date('2026-09-11T02:01:00Z'),
    items: [{ productName: '凉拌牛肉', specText: null, quantity: 2, subtotal: 5000 }],
    totalAmount: 5000, shippingFee: 0, actualAmount: 4750, remark: null, discountAmount: 0, pointsUsed: 0, pickupDiscountAmount: 250,
    receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
    pickupAt: new Date('2026-09-11T04:00:00Z'), pickupSlotLabel: '今天 12:00–12:30',
  })
  assert.ok(s.includes('<CB>到店自取</CB>'))
  assert.ok(s.includes('<B>取餐 今天 12:00–12:30</B>'))
  assert.ok(s.includes('尾号1234'))
  assert.ok(!s.includes('地址'))
  assert.ok(!s.includes('运费'))
  assert.ok(s.includes('自取优惠：−¥2.50'))
  assert.ok(s.includes('<CB>厨房联</CB>'))
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-member.ts 2>&1 | tail -5`
Expected: 类型错误（`'PICKUP'` 不可赋给 `TicketChannel`）或断言失败。

- [ ] **Step 3: `content.ts`**。

`export type TicketChannel = 'LOCAL' | 'EXPRESS' | 'PICKUP'`；加 `const CHANNEL_WORD: Record<TicketChannel, string> = { LOCAL: '同城', EXPRESS: '邮寄', PICKUP: '自取' }`。

`TicketOrderInput` 里 `announceNo` 之前加：

```ts
  // ── 自取专属（channel==='PICKUP'）──
  pickupAt?: Date | null
  /** 「今天 12:00–12:30」，由调用方用 services/pickup 的 pickupSlotLabel 算好传进来（本文件不算时区） */
  pickupSlotLabel?: string | null
  /** 自取优惠（分）。>0 时取餐联在合计与券之间打一行；厨房联不打 */
  pickupDiscountAmount?: number
```

`renderOrderTicket`：`const isLocal = o.channel === 'LOCAL'` 改为

```ts
  const isLocal = o.channel === 'LOCAL'
  const isPickup = o.channel === 'PICKUP'
  const hasKitchen = isLocal || isPickup // 自取也是后厨现拌 + 柜台装袋，两联
```

票头第一行 `<CB>${isLocal ? '同城配送' : '全国邮寄'}</CB>` 改为 `<CB>${isPickup ? '到店自取' : isLocal ? '同城配送' : '全国邮寄'}</CB>`。

`receiverBlock` 改为三分支：

```ts
  const receiverBlock: string[] = isPickup
    ? [
        // 取餐联：时间放大（顾客几点来是店员要看的第一眼），姓名与脱敏电话普通字号；不印地址——地址是店自己
        `<B>取餐 ${esc(o.pickupSlotLabel ?? '')}</B>`,
        `取餐人 ${esc(o.receiverName)}`,
        `电话 ${maskPhone(esc(o.receiverPhone))}`,
      ]
    : isLocal
      ? [ …原同城分支不变… ]
      : [ …原邮寄分支不变… ]
```

`footer`：

```ts
  const footer: string[] = [
    `合计：${yuan(o.totalAmount)}`,
    ...(o.pickupDiscountAmount && o.pickupDiscountAmount > 0 ? [`自取优惠：−${yuan(o.pickupDiscountAmount)}`] : []),
    ...(o.discountAmount && o.discountAmount > 0 ? [`优惠券：−${yuan(o.discountAmount)}`] : []),
    ...(isPickup ? [] : [`运费：${yuan(o.shippingFee)}`]),
    `<B>实付：${yuan(o.actualAmount)}</B>`,
    ...
```

`let kitchen: string[] | null = isLocal ? buildKitchen(0, null) : null` 与降级段里三处 `if (isLocal)` 全部改成 `hasKitchen`。

`renderReminderTicket`、`renderCancelTicket`、`renderCancelRequestTicket` 里 `${input.channel === 'LOCAL' ? '同城' : '邮寄'}` 改为 `${CHANNEL_WORD[input.channel]}`。

- [ ] **Step 4: `ticket/index.ts`**。`ORDER_SELECT` 加 `pickupAt: true, pickupDiscountAmount: true,`。`toTicketInput` 改为：

```ts
function toTicketInput(order: OrderForTicket, slotMinutes: number): TicketOrderInput {
  const channel: TicketChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : order.deliveryType === 'PICKUP' ? 'PICKUP' : 'EXPRESS'
  return {
    channel,
    …原字段不变…
    pickupAt: order.pickupAt,
    pickupSlotLabel: order.pickupAt ? pickupSlotLabel(order.pickupAt, slotMinutes) : null,
    pickupDiscountAmount: order.pickupDiscountAmount,
  }
}
```

调用 `toTicketInput` 的地方（`renderForKind` 里）改为传 `settings` 之外再传一个 `slotMinutes`——`renderForKind` 签名加 `slotMinutes: number`，其调用处（`enqueueOrderTicket` 两处、重打两处）在函数里先 `const slotMinutes = (await getLocalSettings()).pickup.slotMinutes`（`enqueueOrderTicket` 里已经在读打印设置，紧挨着读一次同城设置即可；`getLocalSettings` 有 60 秒缓存）。`renderForKind` 里三处 `const channel: PrinterChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : 'EXPRESS'` 与 `enqueueOrderTicket` 里那处，改为：

```ts
  // 自取单用 LOCAL 渠道的打印机（同一台店内机，未决歧义 2）；票面文案由 TicketChannel 区分
  const channel: PrinterChannel = order.deliveryType === 'LOCAL' || order.deliveryType === 'PICKUP' ? 'LOCAL' : 'EXPRESS'
```

`renderForKind` 传给 `renderReminderTicket/renderCancelTicket/renderCancelRequestTicket` 的 `channel` 改传 `TicketChannel`（三值），新增局部 `const ticketChannel: TicketChannel = order.deliveryType === 'LOCAL' ? 'LOCAL' : order.deliveryType === 'PICKUP' ? 'PICKUP' : 'EXPRESS'`。

`repeatAnnounce`：`if (order.deliveryType !== 'LOCAL' && !shopOpen) continue` 保持（PICKUP 与邮寄同样受营业门控，未决歧义 1）；`afterMin` 那行改为 `order.deliveryType === 'EXPRESS' ? settings.repeat.expressAfterMin : settings.repeat.localAfterMin`。

import 加 `import { pickupSlotLabel } from '../pickup'`、`TicketChannel` 从 `./content` 导入。

- [ ] **Step 5: 订阅消息实现**。把 Task 6 Step 1 的空壳替换为：

```ts
/**
 * 「已备好，请来取餐」（spec §4.8）。模板由店主在公众平台选「取餐/订单备好」类公共模板，
 * 字段映射走 WECHAT_TMPL_PICKUP_FIELDS，可用字段：orderNo / productName / pickupTime / shopName / address / name / note
 */
export function sendPickupReadySubscribeMessage(
  openid: string,
  order: { id: number; orderNo: string; pickupAt: Date | null; receiverName: string },
  productName?: string
): void {
  const { pickupTemplateId, pickupFields } = config.subscribe
  if (!pickupTemplateId || !pickupFields) {
    console.warn('[subscribe] 取餐提醒未配置模板（WECHAT_TMPL_PICKUP），本条未发出')
    return
  }
  void import('./local-settings').then(({ getLocalSettings }) => getLocalSettings()).then((s) => {
    const data = buildData(
      {
        orderNo: order.orderNo,
        productName: productName ?? '',
        pickupTime: order.pickupAt ? fmtTime(order.pickupAt) : fmtTime(new Date()),
        shopName: s.store.name,
        address: `${s.store.district}${s.store.address}`,
        name: order.receiverName,
        note: '您的餐品已备好，凭手机尾号到店取餐',
      },
      parseFieldMap(pickupFields)
    )
    if (!data) return
    void send(openid, pickupTemplateId, `pages/order/detail?id=${order.id}`, data, '取餐提醒')
  }).catch((e) => console.warn('[subscribe] 取餐提醒读门店信息失败，本条未发出:', (e as Error)?.message ?? e))
}
```

- [ ] **Step 6: 店员推送**。`order-notify.ts` 的 `NotifyOrderInfo` 加 `deliveryType?: string; pickupSlotLabel?: string | null`；`buildContent` 的标题行改为：

```ts
    order.deliveryType === 'PICKUP' ? `**🏪 自取新订单${order.pickupSlotLabel ? ` · ${order.pickupSlotLabel} 取` : ''}**`
      : order.deliveryType === 'LOCAL' ? `**🛵 同城新订单**` : `**🔔 新订单待发货**`,
```

（现有两处调用 `notifyOrderPaid` 传的是整行 order，`deliveryType` 自动带上；`pickupSlotLabel` 由 Task 8 不动、由调用处不传——标题只显示「自取新订单」即可，`pickupSlotLabel` 留给批次三接线。）文件末尾加：

```ts
/** 自取：取餐时间过后仍没人点「已取走」（每单一次，pickupRemindedAt 记录） */
export function notifyPickupUnpicked(orders: { orderNo: string; receiverPhone: string; slotLabel: string }[]): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🏪 ${orders.length} 单自取已过取餐时间仍未取走**`,
    ...orders.slice(0, 10).map((o) => `- 尾号${o.receiverPhone.slice(-4)} · ${o.slotLabel}`),
    '顾客来取请在工作台点「已取走」；确认不来取可退款',
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '自取单未取', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
/** 自取：超时自动完成（店员没点「已取走」，系统按取餐时间 + N 分钟收尾） */
export function notifyPickupAutoCompleted(orders: { orderNo: string; receiverPhone: string; slotLabel: string }[]): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const content = [
    `**🏪 ${orders.length} 单自取按超时自动完成**`,
    ...orders.slice(0, 10).map((o) => `- 尾号${o.receiverPhone.slice(-4)} · ${o.slotLabel}`),
    '如果顾客确实没来取，请到后台按售后/退款处理',
  ].join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, '自取单自动完成', content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
```

- [ ] **Step 7: `.env.example`**。在 `WECHAT_TMPL_DELIVER_FIELDS=…` 那行之后加：

```
# ── 到店自取「已备好，请来取餐」通知（2026-09-11）─────────────────
# 公众平台选一个「取餐提醒 / 订单备好通知」类公共模板，ID 填这里；留空则「已备好」不发订阅消息、只记 warn。
# 可用字段：orderNo / productName / pickupTime / shopName / address / name / note
# WECHAT_TMPL_PICKUP=
# WECHAT_TMPL_PICKUP_FIELDS=pickupTime=time1,productName=thing2,address=thing3,note=thing4
```

- [ ] **Step 8: selftest + tsc + e2e ⑪**。e2e 追加：

```bash
echo "-- ⑪ 小票：自取单出票票头「到店自取」、印取餐时间与自取优惠、不印运费 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"P62-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_SLOT2\",\"pickupContact\":{\"phone\":\"13800009999\"}}")
P62_O4=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O4/pay" "$UT" >/dev/null
sleep 0.5
P62_T=$(PJOBS "$P62_O4" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$P62_T" == *"到店自取"* ]] && ok "票头 到店自取" || fail "票头不对" "$P62_T"
[[ "$P62_T" == *"<B>取餐 "* ]] && ok "印取餐时间" || fail "没印取餐时间" "$P62_T"
[[ "$P62_T" == *"自取优惠：−"* ]] && ok "印自取优惠" || fail "没印自取优惠" "$P62_T"
[[ "$P62_T" != *"运费："* ]] && ok "不印运费" || fail "自取票印了运费" "$P62_T"
[[ "$P62_T" == *"尾号9999"* ]] && ok "尾号正确" || fail "尾号不对" "$P62_T"
[[ "$P62_T" == *"厨房联"* ]] && ok "有厨房联" || fail "没有厨房联" "$P62_T"
```

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-member.ts && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -20`
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/services/subscribe-message.ts apps/server/src/services/ticket apps/server/src/services/order-notify.ts .env.example apps/server/scripts/selftest-member.ts scripts/e2e.d/62-pickup.sh
git commit -m "自取通知与小票：取餐提醒订阅消息、双联自取票（取餐时间/自取优惠/不印地址运费）、店员推送三条；e2e §62 ⑪"
```

---

### Task 8: 定时任务（催单基准、过时未取、自动完成）

**Files:**
- Create: `apps/server/src/services/pickup-tasks.ts`
- Modify: `apps/server/src/services/scheduler.ts`（`remindUnacceptedOrders` 排除 PICKUP；注册三个任务；`SchedulerOverrides` 加两个键）
- Test: `scripts/e2e.d/62-pickup.sh` ⑫–⑬

**Interfaces:**
- Consumes：Task 3 `prepStartAt/pickupSlotLabel`；Task 7 `notifyPickupUnpicked/notifyPickupAutoCompleted`；现有 `notifyAcceptReminder`。
- Produces：`remindPickupUnaccepted(afterMin?)`、`remindPickupUnpicked(afterMin?)`、`autoCompletePickup(afterMin?)`；override 键 `pickupUnpickedMin`、`pickupAutoCompleteMin`；scheduler stats 键 `pickupUnaccepted`、`pickupUnpicked`、`pickupAutoComplete`。

- [ ] **Step 1: `pickup-tasks.ts`**

```ts
/**
 * 到店自取的三条定时任务（spec 2026-09-11 §4.6）。全部以 pickupAt 为基准，不看 paidAt：
 *   1. 未接单催单：max(付款 + 15 分钟, 开始备餐时刻 − 15 分钟) 到了还 PAID → 催一次
 *   2. 过时未取提醒：SHIPPED 且 pickupAt + unpickedRemindAfterMin 已过 → 提醒一次
 *   3. 自动完成：SHIPPED 且 pickupAt + autoCompleteAfterMin 已过 → COMPLETED + 推送
 * 「已发货 7 天自动完成」按 Shipment.shippedAt 过滤，自取没有 Shipment 行，天然不碰；
 * `autoRejectStaleCancelRequests` 只扫 LOCAL/EXPRESS，自取不自动驳回（spec §4.5）。
 */
import prisma from '../utils/prisma'
import { getLocalSettings } from './local-settings'
import { prepStartAt, pickupSlotLabel } from './pickup'
import { notifyAcceptReminder, notifyPickupUnpicked, notifyPickupAutoCompleted } from './order-notify'
import { settlePoints } from './member/points'
import { ACCEPT_REMIND_AFTER_MIN } from './scheduler'

const BATCH = 100
const MIN = 60 * 1000

export async function remindPickupUnaccepted(afterMin = ACCEPT_REMIND_AFTER_MIN): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  const rows = await prisma.order.findMany({
    where: { deliveryType: 'PICKUP', status: 'PAID', acceptRemindedAt: null, paidAt: { not: null }, pickupAt: { not: null } },
    select: { id: true, orderNo: true, actualAmount: true, receiverName: true, receiverPhone: true, paidAt: true, pickupAt: true },
    take: BATCH, orderBy: { paidAt: 'asc' },
  })
  // 触发时刻 = max(付款 + afterMin, 开始备餐 − 15 分钟)：明天的单不在今晚催，尽快的单照旧 15 分钟
  const due = rows.filter((o) => now >= Math.max(o.paidAt!.getTime() + afterMin * MIN, prepStartAt(s, o.pickupAt!).getTime() - 15 * MIN))
  if (due.length === 0) return 0
  await prisma.order.updateMany({ where: { id: { in: due.map((o) => o.id) } }, data: { acceptRemindedAt: new Date() } })
  notifyAcceptReminder(due)
  return due.length
}

export async function remindPickupUnpicked(afterMin?: number): Promise<number> {
  const s = await getLocalSettings()
  const after = afterMin ?? s.pickup.unpickedRemindAfterMin
  const rows = await prisma.order.findMany({
    where: { deliveryType: 'PICKUP', status: 'SHIPPED', pickupRemindedAt: null, pickupAt: { lt: new Date(Date.now() - after * MIN) } },
    select: { id: true, orderNo: true, receiverPhone: true, pickupAt: true },
    take: BATCH, orderBy: { pickupAt: 'asc' },
  })
  let n = 0
  const reminded: { orderNo: string; receiverPhone: string; slotLabel: string }[] = []
  for (const o of rows) {
    const marked = await prisma.order.updateMany({ where: { id: o.id, pickupRemindedAt: null }, data: { pickupRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    reminded.push({ orderNo: o.orderNo, receiverPhone: o.receiverPhone, slotLabel: pickupSlotLabel(o.pickupAt!, s.pickup.slotMinutes) })
  }
  if (reminded.length) notifyPickupUnpicked(reminded)
  return n
}

export async function autoCompletePickup(afterMin?: number): Promise<number> {
  const s = await getLocalSettings()
  const after = afterMin ?? s.pickup.autoCompleteAfterMin
  const rows = await prisma.order.findMany({
    where: { deliveryType: 'PICKUP', status: 'SHIPPED', pickupAt: { lt: new Date(Date.now() - after * MIN) } },
    select: { id: true, orderNo: true, receiverPhone: true, pickupAt: true },
    take: BATCH, orderBy: { pickupAt: 'asc' },
  })
  const done: { orderNo: string; receiverPhone: string; slotLabel: string }[] = []
  for (const o of rows) {
    const moved = await prisma.order.updateMany({
      where: { id: o.id, status: 'SHIPPED', deliveryType: 'PICKUP' },
      data: { status: 'COMPLETED', completedAt: new Date() },
    })
    if (moved.count === 0) continue
    void settlePoints(o.id)
    done.push({ orderNo: o.orderNo, receiverPhone: o.receiverPhone, slotLabel: pickupSlotLabel(o.pickupAt!, s.pickup.slotMinutes) })
  }
  if (done.length) notifyPickupAutoCompleted(done)
  if (done.length > 0) console.log(`[scheduler] 自取超时自动完成 ${done.length} 单`)
  return done.length
}
```

⚠️ `scheduler.ts` 与 `pickup-tasks.ts` 互相 import（`ACCEPT_REMIND_AFTER_MIN` ↔ 三个任务函数）。为避免循环依赖，把 `export const ACCEPT_REMIND_AFTER_MIN = 15` 挪到 `utils/constants.ts` 并从两处 import；`scheduler.ts` 保留 `export { ACCEPT_REMIND_AFTER_MIN }` 的再导出以防外部引用（`grep -rn ACCEPT_REMIND_AFTER_MIN apps/server/src` 确认）。

- [ ] **Step 2: scheduler 接线**。`remindUnacceptedOrders` 的 `where` 加 `deliveryType: { not: 'PICKUP' }`。`SchedulerOverrides` 加：

```ts
  /** 自取：过时未取提醒 / 自动完成的分钟阈值（不传读同城设置的 pickup.*） */
  pickupUnpickedMin?: number
  pickupAutoCompleteMin?: number
```

`tasks` 数组在 `['remindUnaccepted', …]` 之后加：

```ts
    ['pickupUnaccepted', () => remindPickupUnaccepted(overrides.remindAfterMin)],
    ['pickupUnpicked', () => remindPickupUnpicked(overrides.pickupUnpickedMin)],
    ['pickupAutoComplete', () => autoCompletePickup(overrides.pickupAutoCompleteMin)],
```

import 加 `import { remindPickupUnaccepted, remindPickupUnpicked, autoCompletePickup } from './pickup-tasks'`。

- [ ] **Step 3: tsc**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

- [ ] **Step 4: e2e ⑫–⑬**（追加）

```bash
echo "-- ⑫ 催单基准：明天的自取单付款 15 分钟后不催；开始备餐前 15 分钟才催 --"
P62_TOMORROW=$(req GET /api/local/pickup-slots | jq -r '[.data.days[] | select(.label=="明天") | .slots[]][0].startAt')
[[ -n "$P62_TOMORROW" && "$P62_TOMORROW" != "null" ]] && ok "拿到明天的格" || fail "明天没有格" 
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_TOMORROW\",\"pickupContact\":{\"phone\":\"13800002222\"}}")
P62_O5=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O5/pay" "$UT" >/dev/null
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 20 MINUTE) WHERE id=$P62_O5;"
sched '{}' >/dev/null
assert_eq "明天的单付款 20 分钟未催" "$(sql "SELECT accept_reminded_at IS NULL FROM orders WHERE id=$P62_O5;")" "1"
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 30 MINUTE) WHERE id=$P62_O5;"   # 开始备餐 = 30−25 = 5 分钟后，−15 已过
R=$(sched '{}')
[[ "$(jq -r '.data.pickupUnaccepted // -1' <<<"$R")" -ge 1 ]] && ok "到点催单 pickupUnaccepted≥1" || fail "没催" "$R"
assert_eq "accept_reminded_at 已写" "$(sql "SELECT accept_reminded_at IS NOT NULL FROM orders WHERE id=$P62_O5;")" "1"
assert_eq "通用催单任务没重复催自取单（仍只有一次标记）" "$(sql "SELECT COUNT(*) FROM orders WHERE id=$P62_O5 AND accept_reminded_at IS NOT NULL;")" "1"

echo "-- ⑬ 过时未取提醒一次 → 自动完成；自取单不被取消申请自动驳回任务碰 --"
req POST "/api/admin/orders/$P62_O5/accept" "$AT" >/dev/null
req POST "/api/admin/orders/$P62_O5/pickup-ready" "$AT" >/dev/null
assert_eq "O5 待取餐" "$(p62_ord "$P62_O5" | jq -r .data.status)" "SHIPPED"
sql "UPDATE orders SET pickup_at=DATE_SUB(NOW(3), INTERVAL 40 MINUTE) WHERE id=$P62_O5;"
R=$(sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":120}')
[[ "$(jq -r '.data.pickupUnpicked // -1' <<<"$R")" -ge 1 ]] && ok "过时未取提醒 ≥1" || fail "未提醒" "$R"
assert_eq "仍是 SHIPPED（120 分钟未到）" "$(p62_ord "$P62_O5" | jq -r .data.status)" "SHIPPED"
R=$(sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":120}')
assert_eq "第二轮不重复提醒" "$(jq -r '.data.pickupUnpicked // -1' <<<"$R")" "0"
R=$(sched '{"pickupUnpickedMin":30,"pickupAutoCompleteMin":30}')
[[ "$(jq -r '.data.pickupAutoComplete // -1' <<<"$R")" -ge 1 ]] && ok "自动完成 ≥1" || fail "未自动完成" "$R"
assert_eq "O5 → COMPLETED" "$(p62_ord "$P62_O5" | jq -r .data.status)" "COMPLETED"
# 自动驳回任务：造一张 PREPARING 且申请取消、接单已超 10 分钟的自取单，跑一轮，申请必须还在
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"$P62_TOMORROW\",\"pickupContact\":{\"phone\":\"13800003333\"}}")
P62_O6=$(jq -r .data.orderId <<<"$R"); req POST "/api/orders/$P62_O6/pay" "$UT" >/dev/null
req POST "/api/admin/orders/$P62_O6/accept" "$AT" >/dev/null
req POST "/api/orders/$P62_O6/cancel-request" "$UT" '{"note":"不要了"}' >/dev/null
sql "UPDATE orders SET accepted_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id=$P62_O6;"
sched '{"cancelAutoRejectMin":1}' >/dev/null
assert_eq "自取单的取消申请不被自动驳回" "$(sql "SELECT cancel_requested_at IS NOT NULL FROM orders WHERE id=$P62_O6;")" "1"
req POST "/api/admin/orders/$P62_O6/cancel-request/approve" "$AT" >/dev/null

echo "-- 收尾：恢复同城设置、停用本段券模板、清本段打印作业 --"
req PUT /api/admin/settings/local-delivery "$AT" "$P62_ORIG" >/dev/null
for t in ${P62_TID:-} ${P62_TID2:-}; do req PUT "/api/admin/coupon-templates/$t" "$AT" '{"status":"OFF"}' >/dev/null 2>&1 || true; done
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
sql "DELETE FROM print_jobs WHERE order_id IN ($P62_O1,$P62_O3,$P62_O4,$P62_O5,$P62_O6);"
# O4 只用来验小票，仍是 PAID：取消掉，免得下一轮的「未接单重复播报」一直催它
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 收尾' WHERE id=$P62_O4 AND status='PAID';"
```

⚠️ 停用券模板的接口路径以 `routes/admin/coupon-templates.ts` 实际为准（执行方 grep `router.put` 后改这一行；找不到就删掉这一行——留着两个停用的联调模板无害，§39 同样如此）。

- [ ] **Step 5: 跑 e2e 全量**

Run: `bash scripts/e2e.sh 2>&1 | tail -30`
Expected: §62 全 ✔；「失败 0」。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/pickup-tasks.ts apps/server/src/services/scheduler.ts apps/server/src/utils/constants.ts scripts/e2e.d/62-pickup.sh
git commit -m "自取定时任务：催单按开始备餐时刻、过时未取提醒一次、超时自动完成；通用催单排除自取；e2e §62 ⑫–⑬ 与收尾"
```

---

### Task 9: 文档

**Files:**
- Modify: `docs/api.md`（1.4 错误码表加一行提示；末尾加「附录 H：到店自取（批次一）」）
- Modify: `docs/order-flow.md`（三、状态流转图之后加「自取订单」小节）

- [ ] **Step 1: api.md 附录 H**（追加到文件末尾）

```markdown
## 附录 H：到店自取（批次一，2026-09-11）

设计依据 `docs/superpowers/specs/2026-09-11-local-pickup-design.md`。自取是同城渠道下的第二种履约方式：`deliveryType='PICKUP'`，商品/购物车/券按 `LOCAL` 渠道校验。

### 小程序端

| 接口 | 说明 |
|---|---|
| `GET /api/local/meta` | 新增 `delivery`、`pickup`、`holiday` 三节（老字段保留）。`pickup: { enabled, paused, available, minOrderAmountFen, discount, discountText, slotMinutes, daysAhead }`；`holiday` 休业中才非 null。 |
| `GET /api/local/pickup-slots` | 公开。`{ days: [{ date, label('今天'/'明天'/'MM-DD'), slots: [{ startAt, endAt, label }] }], earliestAt, slotMinutes, blocked: null \| { kind: 'HOLIDAY'\|'PAUSED'\|'DISABLED', text } }`。不可选的格子不返回；今天为空时 `days[0].slots=[]`。 |
| `POST /api/orders` | `deliveryType:'PICKUP'` 时 **不传** `addressId`，必传 `pickupAt`（须精确等于某格 `startAt`）与 `pickupContact: { name?, phone }`。计价：小计 → 自取优惠 → 券（门槛看原小计，面额封顶到小计−自取优惠）→ 实付；运费 0。响应多 `pickupAt`、`pickupDiscountAmount`、`subscribeTemplates`。 |
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
| 42284 | 操作与自取订单状态不符（发货/标记完成/确认收货/同城接单等误操作） |

### 环境变量

`WECHAT_TMPL_PICKUP` / `WECHAT_TMPL_PICKUP_FIELDS`（取餐提醒模板；留空只 warn 不阻塞）。
```

并在 1.4 错误码表最后一行之后加一行：`| 4228x | 到店自取（见附录 H） |`。

- [ ] **Step 2: order-flow.md**。在「三、订单状态流转图」小节末尾（`部分退款…` 段落之前）加：

```markdown
**到店自取（deliveryType=PICKUP，2026-09-11）**：复用同一套状态，只改语义——

    PAID（待接单）→ 店员接单 → PREPARING（备餐中）→ 店员「已备好」→ SHIPPED（待取餐，发取餐提醒）
    → 店员「已取走」→ COMPLETED；取餐时间 + autoCompleteAfterMin 仍未点则系统自动完成并推送。

    取消：PAID 且未到「开始备餐时刻」（取餐时间 − 备餐 − 接单缓冲）→ 顾客自助秒退；
          之后（含 PREPARING）只能「申请取消」，店员同意 = 全额退，**不自动驳回**；
          点「已备好」时若有未处理申请视同驳回；SHIPPED/COMPLETED 走售后。
    自取单没有 Shipment 行，「发货 7 天自动完成」天然不碰它；填单号发货、标记完成、顾客确认收货一律 42284。
```

- [ ] **Step 3: Commit**

```bash
git add docs/api.md docs/order-flow.md
git commit -m "文档：api.md 附录 H 到店自取（接口/定时任务/错误码/环境变量）、order-flow 自取状态流"
```

---

## 复核与收尾（工序 02–04）

- **02 复核 · opus，新会话**：输入 = spec + 本计划的「验收标准」+ `git diff main...claude/local-pickup -- apps/server scripts docs/api.md`。重点对抗：① 全仓 `deliveryType` 二分支是否漏改（A6）；② 自取单会不会被任何同城/邮寄的定时任务或退款守卫误伤（`refund.ts` 的 42221/42263 只看 LOCAL/EXPRESS，自取应直接放行）；③ `loadCouponForOrder` 调用点前移后有没有改变 LOCAL/EXPRESS 的错误顺序；④ `isOpenNow` 加休业判定后，同城报价与催单是否与 spec §2 一致；⑤ e2e §62 的时钟依赖（跨零点、跨高峰）是否会偶发红。
- **03 回判 · fable**：逐条判定 02 的清单。
- **04 机械核对 · haiku**：跑 A1–A5 与 A6 的 grep，对照本计划「Files」逐文件核对 diff 只落在白名单内；输出验收表。

## 交给批次二/三的接口清单（本批产出、后续消费）

- 小程序（批次二）：`/local/meta` 三节、`/local/pickup-slots`、`POST /orders` PICKUP 字段、`GET /orders?channel=`、详情 `pickup/canSelfCancel/subscribeTemplates`、`/orders/pickup-contact`、`/orders/meta.subscribeTemplates`。
- 后台（批次三）：设置 `pickup/holiday` 节、四个管理端端点、`GET /admin/orders?channel=`、工作台卡片 `pickup` 节与顶层三字段、`pending-count` 口径。
