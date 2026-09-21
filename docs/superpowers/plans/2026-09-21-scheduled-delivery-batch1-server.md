# 同城「预约送达」批次一（服务端）—— 实施计划

> **工序 00 规划 · 模型 fable。** 按「模型分工协议」：改动等级 **L**（跨模块 + 加订单列 + 动取消窗口与呼叫编排），链路 `fable → sonnet → opus → fable → haiku`。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**：`docs/superpowers/specs/2026-09-21-scheduled-delivery-design.md`（以下简称 spec）。本计划只做 spec §2、§3、§4、§7.1–7.3、§8 批次一里的**服务端**部分；工作台/设置页前端（spec §6）是批次一后半（另写计划 `…-batch1b-admin.md`），小程序（spec §5）是批次二。

**Goal:** 服务端能完整收下、校验、流转、提醒、出票一张「带 `scheduledAt` 的同城单」；自取与预约外送的自助取消截止统一为约定时刻前 `selfCancelLeadMin` 分钟；立即单与邮寄单链路逐字节不变。

**Architecture:** 预约单就是 `deliveryType='LOCAL'` 且 `scheduledAt` 非空的订单，不加新类型。时段切格从 `services/pickup.ts` 抽成公共模块 `services/slots.ts`，自取与外送各传自己的「提前量函数」；四个倒推时刻由纯函数 `services/delivery/schedule.ts` 的 `scheduleTimeline` 唯一给出，工作台、任务、取消判定、小票全部只调它。五条定时任务放新文件 `services/delivery/schedule-tasks.ts`，仿 `pickup-tasks.ts`。

**Tech Stack:** Express + Prisma(MySQL) + zod 4；`ts-node --transpile-only` 跑 selftest；`scripts/e2e.sh` + `scripts/e2e.d/*.sh` 跑 e2e（本地 MySQL 容器，`apps/server` 以 `PORT=3100`、各 mock 开关为 true、`SCHEDULER_DISABLED=true` 启动，见 `scripts/e2e.sh` 头部注释与 memory「干净库跑 e2e 配方」）。

## spec 与本计划的差异（规划者裁定，执行方照本计划做；店主不同意再改）

| # | spec 原文 | 本计划 | 理由 |
|---|---|---|---|
| ① | §3.1 `orders` 加 3 列 | 加 **4** 列：多一列 `prep_ticket_at`（备餐票已出/已提醒的打标列） | spec 说用 `PrintJob` 判「备餐票打没打」，但打印机未启用时 `enqueueOrderTicket` **不建行**，任务每轮都会重复推企微。仓库范式是「先 updateMany 打标、count=1 才动作」，一列解决 |
| ② | §3.2 `Delivery.callStrategy` 加 `SCHEDULED_AUTO / MANUAL_EARLY` | `Delivery` 加一列 `call_origin VarChar(16)`，`callStrategy` 不动 | `callStrategy` 参与升级阶梯映射（`HELD_OF`/`NEXT_RUNG`），新值会让预约单的呼叫**失去自动升级**；且它的 `*_HELD` 变体超过 `VarChar(16)`。来源与策略本来就是两个维度 |
| ③ | §4.7「`remindLocalUncalled`、`remindAcceptedStuck` 基准换成 `callAt`」 | `remindLocalUncalled` **排除**预约单（`remindScheduledNotReady` 覆盖同一场景）；`remindAcceptedStuck` **不改** | 后者看的是**骑手接单后**的配送单状态，与呼叫前的预约无关 |
| ④ | §4.7 催备好「用该单 READY_DUE 作业数封顶」 | 按**时间**封顶：`callAt + every × max` 之后不再出小条、告警一次 | 同 ①：打印机关着时没有作业行，计数永远到不了上限 |
| ⑤ | §4.7 超时告警「用限频键只告警一次」 | 用限频键，窗口 **60 分钟**（`notifyLocalDeliveryAlert` 加 `windowMs` 透传） | 限频只能做到「N 分钟内一次」；一小时一次对「还没送到」是合理的重复 |
| ⑥ | §6.1 `phase` 六态 | 加第七态 `CALLED`（已备好且已过 `callAt`，通常此刻已有在途配送单） | 六态覆盖不到「已发单」的卡片，前端需要一个值 |
| ⑦ | §4.11 经营概览「预约单 N 单」 | 挪到批次一后半（后台前端计划）一起做 | 要改 `routes/admin/stats/*` 且只有概览页消费它，与前端同批改动最小 |

## 未决歧义（执行方按「默认」做）

1. 预约单的报价凭证 `quoteToken` 仍是 15 分钟有效。**默认**：不改；顾客选时段磨蹭超过 15 分钟由客户端重报价（小程序批次二处理 42239）。
2. `schedule.prepMinutes` 与高峰的关系。**默认**：`max(schedule.prepMinutes, 高峰时 peak.prepMaxMinutes)`，按送达时刻判高峰。

## Global Constraints

- 文件与函数名、错误码、字段名按本计划；错误码只用 `42290`–`42292`（`42293/42294` 预留不占）。
- 所有时刻按 Asia/Shanghai 判定（复用 `slots.ts` 的 `Intl` 写法），金额单位为分。
- 老调用方零改动原则：不传 `scheduledAt` 的 LOCAL 下单、所有 EXPRESS/PICKUP 路径、`buildPickupSlots` 的输出，行为逐字节一致（A3 守 pickup selftest）。
- 状态流转一律 `updateMany` 带条件判 `count`，不用无条件 `update`。
- 每个 Task 结束前 `cd apps/server && npx tsc --noEmit` 零错误；提交信息用中文、说明「为什么」。
- 不改 `apps/admin`、`apps/miniapp`。工作台快照与管理端接口只**加字段**不改现有字段。
- 预约单**不传** `orderType` 给快递100，仍是即时单。

## 允许修改的文件白名单

```
apps/server/prisma/schema.prisma
apps/server/prisma/migrations/20260922000000_order_scheduled/migration.sql   （新建）
apps/server/src/services/local-settings.ts
apps/server/src/services/slots.ts                                            （新建）
apps/server/src/services/pickup.ts                                           （改成薄壳）
apps/server/src/services/delivery/schedule.ts                                （新建）
apps/server/src/services/delivery/schedule-tasks.ts                          （新建）
apps/server/src/services/delivery/orchestrator.ts
apps/server/src/services/delivery/tasks.ts
apps/server/src/services/scheduler.ts
apps/server/src/services/order-notify.ts
apps/server/src/services/ticket/printer.ts
apps/server/src/services/ticket/content.ts
apps/server/src/services/ticket/index.ts
apps/server/src/routes/local.ts
apps/server/src/routes/orders.ts
apps/server/src/routes/wechat-notify.ts
apps/server/src/routes/admin/delivery.ts
apps/server/src/routes/admin/orders.ts
apps/server/src/routes/admin/workbench.ts
apps/server/scripts/selftest-local-settings.ts
apps/server/scripts/selftest-schedule.ts                                     （新建）
scripts/e2e.d/69-scheduled-delivery.sh                                       （新建）
docs/api.md
```

## 上报触发条件（执行方必须停下）

- 需要改白名单外的任何文件（尤其 `services/refund.ts`、`services/cancel-request.ts`、`routes/admin/system.ts`、`services/delivery/callback.ts`）。
- `npx tsc --noEmit` 报出的错误落在本计划没有列出的文件里。
- `selftest-pickup.ts` 在 Task 3 之后任何一条由绿转红（公共模块改变了自取行为）。
- e2e §40–§68 任一段由绿转红。
- 发现 `42290`–`42292` 已被占用，或 Prisma 迁移在本地库失败。
- `callRider` 内部对 `readyAt` 的写入与 `escalateSoloCalls` 升级路径产生冲突（升级重呼时 `readyAt` 已非空，应无冲突；有就停）。

## 验收标准（只在这里定义，后续工序不得增删）

| # | 跑什么 | 期望 |
|---|---|---|
| A1 | `cd apps/server && npx tsc --noEmit` | 零错误 |
| A2 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-schedule.ts` | 输出「全部通过 N」，N ≥ 14，退出码 0 |
| A3 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts` | 全部通过（数量与改动前一致），证明公共模块没改自取行为 |
| A4 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts` | 全部通过，含新增 3 条 `schedule`/`selfCancelLeadMin` 断言 |
| A5 | `bash scripts/e2e.sh`（干净库 `food_shop_e2e`，`SCHEDULER_DISABLED=true`） | 末行「失败 0」；§69 段全部 ✔；§62 段仍全绿（自取取消截止改动已同步进 §62 的断言） |
| A6 | `grep -rn "scheduledAt" apps/server/src --include=*.ts -l` | 每个文件都在白名单里 |
| A7 | `GET /api/local/meta` | `delivery` 节多 `scheduleEnabled / slotMinutes / selfCancelLeadMin / earliestScheduleText`，老字段全部仍在 |
| A8 | `docs/api.md` 附录 M | 列出全部新端点、新参数、`42290`–`42292`、五条任务、四列 |

---

### Task 1: 数据列与迁移

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（Order 模型 `promoDiscountAmount` 之后；Delivery 模型 `callStrategy` 之后）
- Create: `apps/server/prisma/migrations/20260922000000_order_scheduled/migration.sql`

**Interfaces:**
- Produces: `Order.scheduledAt / readyAt / prepTicketAt / scheduleRemindedAt`（`DateTime?`）、`Delivery.callOrigin`（`String?`）。

- [ ] **Step 1: schema.prisma Order 加 4 列 + 索引**（放在 `promoDiscountAmount` 与 `clientRequestId` 之间；索引放在 `@@index([status, pointsSettledAt, completedAt])` 之后）

```prisma
  // ── 预约送达（deliveryType=LOCAL 且 scheduledAt 非空；spec 2026-09-21-scheduled-delivery-design §3.1）──
  // 顾客选的送达时段起点。空 = 立即单。四个倒推时刻不存库，每次由 services/delivery/schedule.ts 按当时设置重算
  scheduledAt                 DateTime? @map("scheduled_at")
  // 店员点「已备好」/「立即呼叫」/「自己送」的时刻；到点自动呼叫只看它非空
  readyAt                     DateTime? @map("ready_at")
  // 备餐票已出（含企微「该开始备餐了」）的打标列——打印机关着时 PrintJob 不建行，所以不能拿它当标记（计划差异①）
  prepTicketAt                DateTime? @map("prep_ticket_at")
  // 「应备好未备好」上一次提醒的时刻；耗尽告警也复用它（上次时刻 ≥ 耗尽点 = 告警过了）
  scheduleRemindedAt          DateTime? @map("schedule_reminded_at")
```

```prisma
  @@index([deliveryType, scheduledAt])
```

- [ ] **Step 2: schema.prisma Delivery 加一列**（放在 `callStrategy` 之后）

```prisma
  // 呼叫来源（计划差异②）：SCHEDULED_AUTO = 预约单已备好后到点自动发单；MANUAL_EARLY = 店员「立即呼叫」提前发单；
  // NULL = 普通手动 / 升级任务。与 callStrategy（挑运力的策略）是两个维度，报表按它区分「人为提前」
  callOrigin              String?   @map("call_origin") @db.VarChar(16)
```

- [ ] **Step 3: 写迁移 SQL**

```sql
-- 预约送达（批次一）：orders 加 4 个可空列 + 索引，deliveries 加 1 个可空列。纯加列，回滚代码不需回滚库。
ALTER TABLE `orders`
  ADD COLUMN `scheduled_at` DATETIME(3) NULL,
  ADD COLUMN `ready_at` DATETIME(3) NULL,
  ADD COLUMN `prep_ticket_at` DATETIME(3) NULL,
  ADD COLUMN `schedule_reminded_at` DATETIME(3) NULL;
CREATE INDEX `orders_delivery_type_scheduled_at_idx` ON `orders`(`delivery_type`, `scheduled_at`);
ALTER TABLE `deliveries` ADD COLUMN `call_origin` VARCHAR(16) NULL;
```

- [ ] **Step 4: 本地库迁移并生成 client**

Run: `cd apps/server && npx prisma migrate deploy && npx prisma generate`
Expected: 输出含 `20260922000000_order_scheduled` applied；无报错。（memory：并行 worktree 共用 Prisma client，本步不要与别的 agent 同时跑。）

- [ ] **Step 5: tsc 与提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

```bash
git add apps/server/prisma
git commit -m "feat(db): 预约送达——orders 加 scheduled_at/ready_at/prep_ticket_at/schedule_reminded_at，deliveries 加 call_origin"
```

---

### Task 2: 设置节 `schedule` 与 `selfCancelLeadMin`

**Files:**
- Modify: `apps/server/src/services/local-settings.ts`（`PickupSettings` 之后加接口；`LocalDeliverySettings` 加两个字段；`DEFAULT_LOCAL_SETTINGS`、`sanitizeLocalSettings`、`validateLocalSettings`、`publicLocalMeta`）
- Modify: `apps/server/scripts/selftest-local-settings.ts`

**Interfaces:**
- Produces: `ScheduleSettings`；`LocalDeliverySettings.schedule`、`LocalDeliverySettings.selfCancelLeadMin`；`publicLocalMeta().delivery.{scheduleEnabled, slotMinutes, selfCancelLeadMin}`。

- [ ] **Step 1: 加接口**（紧跟 `PickupSettings` 之后）

```ts
/**
 * 预约送达（spec 2026-09-21-scheduled-delivery-design §3.4）。四个倒推时刻的全部参数；
 * 路上时间、呼叫到取走、高峰窗口沿用顶层值，预约单与立即单没理由不同。
 */
export interface ScheduleSettings {
  /** 预约外送总开关，默认关 */
  enabled: boolean
  /** 时段粒度（分钟），15–120 */
  slotMinutes: number
  /** 0 = 只当天，1 = 当天 + 明天，0–3 */
  daysAhead: number
  /** 接单缓冲：接单截止 = 开始备餐 − 它 */
  acceptBufferMin: number
  /** 预约单备餐时长，默认与立即单相同，独立可调（热菜怕冷时调短） */
  prepMinutes: number
  /** 备餐票提前量：出票 = 开始备餐 − 它 */
  prepTicketLeadMin: number
  /** 应备好未备好的追加小条间隔（分钟） */
  readyRemindEveryMin: number
  /** 小条上限：callAt + every×max 之后不再出，告警一次 */
  readyRemindMaxTimes: number
  /** 「该呼叫时刻」前后容忍窗口，只影响卡片提示与「过早呼叫」的 42292 */
  callToleranceMin: number
}
```

- [ ] **Step 2: `LocalDeliverySettings` 加字段**（放在 `pickup: PickupSettings` 之后）

```ts
  schedule: ScheduleSettings
  /** 自取与预约外送共用：约定时刻前多少分钟内关闭顾客自助秒退（spec §4.6，店主 2026-09-21 定 120） */
  selfCancelLeadMin: number
```

- [ ] **Step 3: 默认值**（`DEFAULT_LOCAL_SETTINGS` 里 `pickup: {...}` 之后）

```ts
  schedule: {
    enabled: false, slotMinutes: 30, daysAhead: 1, acceptBufferMin: 5, prepMinutes: 20,
    prepTicketLeadMin: 15, readyRemindEveryMin: 3, readyRemindMaxTimes: 5, callToleranceMin: 5,
  },
  selfCancelLeadMin: 120,
```

- [ ] **Step 4: sanitize**（本文件 `int()` 的语义是**越界回落默认值**，不做夹取；执行裁决 2026-09-21）（`sanitizeLocalSettings` 里，在 `const pkg = asObj(o.packing)` 旁加 `const sc = asObj(o.schedule)`；返回对象里 `pickup: {...}` 之后加）

```ts
    schedule: {
      enabled: bool(sc.enabled, false),
      slotMinutes: int(sc.slotMinutes, D.schedule.slotMinutes, 15, 120),
      daysAhead: int(sc.daysAhead, D.schedule.daysAhead, 0, 3),
      acceptBufferMin: int(sc.acceptBufferMin, D.schedule.acceptBufferMin, 0, 30),
      prepMinutes: int(sc.prepMinutes, D.schedule.prepMinutes, 0, 180),
      prepTicketLeadMin: int(sc.prepTicketLeadMin, D.schedule.prepTicketLeadMin, 0, 60),
      readyRemindEveryMin: int(sc.readyRemindEveryMin, D.schedule.readyRemindEveryMin, 1, 15),
      readyRemindMaxTimes: int(sc.readyRemindMaxTimes, D.schedule.readyRemindMaxTimes, 1, 10),
      callToleranceMin: int(sc.callToleranceMin, D.schedule.callToleranceMin, 0, 15),
    },
    selfCancelLeadMin: int(o.selfCancelLeadMin, D.selfCancelLeadMin, 0, 720),
```

- [ ] **Step 5: validate**（`validateLocalSettings` 末尾 `return errs` 之前）

```ts
  if (s.schedule.enabled && s.businessHours.length === 0) errs.push('开通预约配送须先设置营业时间')
```

- [ ] **Step 6: `publicLocalMeta` 的 `delivery` 节加三个字段**

```ts
    delivery: {
      enabled: s.enabled, isOpen: isOpenNow(s, now),
      paused: isPaused(s, now) ? { reason: s.paused?.reason ?? '', until: s.paused?.until ?? null } : null,
      closedKind: closedKind(s, now), nextOpenText: nextOpenText(s, now),
      // 预约送达（2026-09-21）。earliestScheduleText 由 routes/local.ts 补（它要算时段，本文件不 import schedule.ts 免循环）
      scheduleEnabled: s.schedule.enabled, slotMinutes: s.schedule.slotMinutes, selfCancelLeadMin: s.selfCancelLeadMin,
    },
```

- [ ] **Step 7: selftest 加 3 条**（`selftest-local-settings.ts` 末尾、汇总输出之前，沿用文件里的 `t(name, fn)` 写法）

```ts
t('schedule 默认关、默认值齐全', () => {
  const s = sanitizeLocalSettings({})
  assert.strictEqual(s.schedule.enabled, false)
  assert.deepStrictEqual(s.schedule, { enabled: false, slotMinutes: 30, daysAhead: 1, acceptBufferMin: 5, prepMinutes: 20, prepTicketLeadMin: 15, readyRemindEveryMin: 3, readyRemindMaxTimes: 5, callToleranceMin: 5 })
  assert.strictEqual(s.selfCancelLeadMin, 120)
})
t('schedule 越界回落默认值（与 int() helper 及 perItemFen 同口径）：slotMinutes 5→30、daysAhead 9→1、selfCancelLeadMin 9999→120', () => {
  const s = sanitizeLocalSettings({ schedule: { slotMinutes: 5, daysAhead: 9 }, selfCancelLeadMin: 9999 })
  assert.strictEqual(s.schedule.slotMinutes, 30); assert.strictEqual(s.schedule.daysAhead, 1); assert.strictEqual(s.selfCancelLeadMin, 120)
})
t('开通预约但没有营业时间 → 校验报错', () => {
  const s = sanitizeLocalSettings({ schedule: { enabled: true }, businessHours: [] })
  assert.ok(validateLocalSettings(s).some((e) => e.includes('预约配送')))
})
```
（若文件顶部尚未 import `validateLocalSettings`，补上。）

- [ ] **Step 8: 跑 selftest 与 tsc，提交**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts && npx tsc --noEmit`
Expected: 全部通过；零错误。

```bash
git add apps/server/src/services/local-settings.ts apps/server/scripts/selftest-local-settings.ts
git commit -m "feat(local-settings): 预约送达 schedule 节 + 自助取消截止 selfCancelLeadMin（自取与预约共用）"
```

---

### Task 3: 公共时段模块、倒推时间轴、`pickup.ts` 薄壳

**Files:**
- Create: `apps/server/src/services/slots.ts`
- Create: `apps/server/src/services/delivery/schedule.ts`
- Modify: `apps/server/src/services/pickup.ts`（整文件替换）
- Create: `apps/server/scripts/selftest-schedule.ts`
- Test: `scripts/selftest-pickup.ts`（不改，必须仍全绿）

**Interfaces:**
- Produces（`slots.ts`）：`Slot`、`SlotDay`、`MIN`、`toMin`、`hhmm`、`hhmmOf(d: Date)`、`atShanghai(dateStr, minutes)`、`shanghaiMinutesOf(d)`、`addDays(dateStr, n)`、`dayLabel(dateStr, todayStr)`、`buildSlotDays(input): { days, earliestAt, allHoliday }`、`slotLabel(at, slotMinutes, now?)`、`ticketLabel(at, slotMinutes, now?): { text, stamp }`。
- Produces（`schedule.ts`）：`ScheduleTimeline`、`schedulePrepMinutes(s, at)`、`scheduleTimeline(s, scheduledAt, distanceM)`、`scheduleLeadMinutes(s, slotStart, distanceM)`、`DeliverySlotsView`、`buildDeliverySlots(s, distanceM, now?)`、`isValidDeliverySlot(s, scheduledAt, distanceM, now?)`、`earliestScheduleText(s, now?)`、`SchedulePhase`、`schedulePhase(tl, o, now)`、`etaIfCallNow(s, distanceM, now?)`、`scheduleView(s, order, now?, pickedUp?)`。
- `pickup.ts` 的全部导出名与签名不变。

- [ ] **Step 1: 写 `services/slots.ts`**

```ts
/**
 * 时段切格公共模块（spec 2026-09-21-scheduled-delivery-design §4.1）。自取与预约外送共用：
 * 切格、可选判定、天数/休业过滤、文案。全部纯函数，不 import prisma、不抛 AppError。
 * 「一格可选要提前多少分钟」由调用方以 leadMinutesOf 传入：自取 = 备餐 + 接单缓冲；
 * 外送 = 路上 + 呼叫到取走 + 备餐 + 接单缓冲。全部时刻按 Asia/Shanghai；上海无夏令时，`+08:00` 字面量可直接拼 Date。
 */
import { BusinessHour, shanghaiDateStr } from './local-settings'

export interface Slot { startAt: string; endAt: string; label: string }
export interface SlotDay { date: string; label: string; slots: Slot[] }

export const MIN = 60 * 1000
export const toMin = (hhmmStr: string) => Number(hhmmStr.slice(0, 2)) * 60 + Number(hhmmStr.slice(3, 5))
const pad2 = (n: number) => String(n).padStart(2, '0')
export const hhmm = (minutes: number) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`
/** 上海日期 + 一天内分钟数 → Date */
export const atShanghai = (dateStr: string, minutes: number) => new Date(`${dateStr}T${hhmm(minutes)}:00+08:00`)
/** Date → 上海「一天内的分钟数」 */
export function shanghaiMinutesOf(d: Date): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const h = Number(p.find((x) => x.type === 'hour')?.value ?? 0) % 24
  const m = Number(p.find((x) => x.type === 'minute')?.value ?? 0)
  return h * 60 + m
}
/** Date → 'HH:mm'（上海） */
export const hhmmOf = (d: Date) => hhmm(shanghaiMinutesOf(d))
export function addDays(dateStr: string, n: number): string {
  return shanghaiDateStr(new Date(new Date(`${dateStr}T12:00:00+08:00`).getTime() + n * 24 * 60 * MIN))
}
export function dayLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return '今天'
  if (dateStr === addDays(todayStr, 1)) return '明天'
  return dateStr.slice(5) // '09-13'
}

export interface BuildSlotDaysInput {
  businessHours: BusinessHour[]
  slotMinutes: number
  daysAhead: number
  now: Date
  isHolidayOn: (dateStr: string) => boolean
  /** 这一格要提前多少分钟才来得及；`slotStart − lead < now` 的格子不返回 */
  leadMinutesOf: (slotStart: Date) => number
  /** 额外过滤（外送用：开始备餐不早于该营业段开门、暂停期间不出格）。返回 false 的格子不返回 */
  slotFilter?: (slotStart: Date, window: BusinessHour, dateStr: string) => boolean
}

/** 逐天切格。今天一格都没有时 days[0].slots 为空数组照样返回；休业日整天不出现；全部休业 → allHoliday */
export function buildSlotDays(i: BuildSlotDaysInput): { days: SlotDay[]; earliestAt: string | null; allHoliday: boolean } {
  const today = shanghaiDateStr(i.now)
  const step = i.slotMinutes
  const sorted = [...i.businessHours].sort((a, b) => toMin(a.start) - toMin(b.start))
  const days: SlotDay[] = []
  for (let n = 0; n <= i.daysAhead; n++) {
    const date = addDays(today, n)
    if (i.isHolidayOn(date)) continue
    const slots: Slot[] = []
    for (const h of sorted) {
      for (let m = toMin(h.start); m + step <= toMin(h.end); m += step) {
        const startAt = atShanghai(date, m)
        if (startAt.getTime() - i.leadMinutesOf(startAt) * MIN < i.now.getTime()) continue
        if (i.slotFilter && !i.slotFilter(startAt, h, date)) continue
        slots.push({ startAt: startAt.toISOString(), endAt: atShanghai(date, m + step).toISOString(), label: `${hhmm(m)}–${hhmm(m + step)}` })
      }
    }
    days.push({ date, label: dayLabel(date, today), slots })
  }
  const earliest = days.flatMap((d) => d.slots)[0] ?? null
  return { days, earliestAt: earliest?.startAt ?? null, allHoliday: days.length === 0 }
}

/** 「今天 12:00–12:30」这种给顾客/店员看的文案；工作台、通知共用（每次刷新按当时重算，不会过期） */
export function slotLabel(at: Date, slotMinutes: number, now: Date = new Date()): string {
  const m = shanghaiMinutesOf(at)
  return `${dayLabel(shanghaiDateStr(at), shanghaiDateStr(now))} ${hhmm(m)}–${hhmm(m + slotMinutes)}`
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
/** 'YYYY-MM-DD' → '9月12日（周六）'（按上海日历日取星期：正午 +08:00 的 UTC 日期与上海同日） */
export function cnDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00+08:00`)
  return `${Number(dateStr.slice(5, 7))}月${Number(dateStr.slice(8, 10))}日（${WEEKDAY[d.getUTCDay()]}）`
}

/**
 * 小票专用文案：纸票是付款那一刻打的，印「明天」到了第二天就成了假话，所以票面一律印绝对日期 + 星期；
 * 相对关系只放在票头的戳里（今天不盖戳，明天「明日单」，更远印日期）。
 */
export function ticketLabel(at: Date, slotMinutes: number, now: Date = new Date()): { text: string; stamp: string } {
  const date = shanghaiDateStr(at)
  const today = shanghaiDateStr(now)
  const m = shanghaiMinutesOf(at)
  const stamp = date === today ? '' : date === addDays(today, 1) ? '明日单' : `${cnDate(date).replace(/（.*）/, '')}单`
  return { text: `${cnDate(date)}${hhmm(m)}–${hhmm(m + slotMinutes)}`, stamp }
}
```

- [ ] **Step 2: `services/pickup.ts` 整文件替换为薄壳**（导出名、签名、行为不变）

```ts
/**
 * 到店自取的纯计算（spec 2026-09-11-local-pickup-design §4.2、§4.3）。
 * 2026-09-21 起切格/文案下沉到 services/slots.ts（与预约外送共用），本文件只剩自取自己的：
 * 备餐时长按取餐时刻判高峰、开始备餐时刻、DISABLED/PAUSED/HOLIDAY 三种阻塞、自取优惠。
 * 不 import prisma、不抛 AppError；每条边界由 scripts/selftest-pickup.ts 穷举。
 */
import { LocalDeliverySettings, isHolidayOn, isPickupPaused, minutesInPeak } from './local-settings'
import { Slot, SlotDay, MIN, buildSlotDays, shanghaiMinutesOf, slotLabel, ticketLabel } from './slots'

export type PickupSlot = Slot
export type PickupDay = SlotDay
export interface PickupSlotsView {
  days: PickupDay[]
  earliestAt: string | null
  slotMinutes: number
  blocked: null | { kind: 'HOLIDAY' | 'PAUSED' | 'DISABLED'; text: string }
}

/** 备餐时长按**取餐时刻**是否在高峰取值（平时 prepMinutes，高峰取上界 prepMaxMinutes） */
export function pickupPrepMinutes(s: LocalDeliverySettings, at: Date): number {
  return minutesInPeak(s, shanghaiMinutesOf(at)) ? s.peak.prepMaxMinutes : s.prepMinutes
}

/** 开始备餐时刻 = 取餐 − 备餐 − 接单缓冲。催单、工作台倒计时用它。用**实时**设置不用下单时快照（spec §2 有意） */
export function prepStartAt(s: LocalDeliverySettings, pickupAt: Date): Date {
  return new Date(pickupAt.getTime() - (pickupPrepMinutes(s, pickupAt) + s.pickup.acceptBufferMin) * MIN)
}

export function buildPickupSlots(s: LocalDeliverySettings, now: Date = new Date()): PickupSlotsView {
  const slotMinutes = s.pickup.slotMinutes
  if (!s.pickup.enabled) return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'DISABLED', text: '到店自取暂未开通' } }
  if (isPickupPaused(s, now)) {
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'PAUSED', text: `自取暂停接单${s.pickup.paused?.reason ? `：${s.pickup.paused.reason}` : ''}` } }
  }
  const r = buildSlotDays({
    businessHours: s.businessHours, slotMinutes, daysAhead: s.pickup.daysAhead, now,
    isHolidayOn: (d) => isHolidayOn(s, d),
    // 一格可选：起点 − 备餐(按起点判高峰) − 缓冲 ≥ now，与 prepStartAt 同一公式
    leadMinutesOf: (start) => pickupPrepMinutes(s, start) + s.pickup.acceptBufferMin,
  })
  if (r.allHoliday) {
    const until = s.holiday?.until
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'HOLIDAY', text: `休息中${until ? `，${until.slice(5).replace('-', '月')}日后恢复` : ''}` } }
  }
  return { days: r.days, earliestAt: r.earliestAt, slotMinutes, blocked: null }
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

export const pickupSlotLabel = slotLabel
export const pickupTicketLabel = ticketLabel
```

- [ ] **Step 3: 跑 pickup selftest，必须与改前一样全绿**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-pickup.ts`
Expected: 与 Task 3 之前相同的通过数，退出码 0。红了就停（上报触发条件）。

- [ ] **Step 4: 写 `services/delivery/schedule.ts`**

```ts
/**
 * 预约送达的纯计算（spec 2026-09-21-scheduled-delivery-design §2、§4.1、§6.1）。
 * 四个倒推时刻只在这里算；工作台、定时任务、取消判定、小票全部调 scheduleTimeline，不各自倒推。
 * 不 import prisma、不抛 AppError。
 */
import {
  LocalDeliverySettings, rideMinutes, minutesInPeak, isHolidayOn, isPaused, shanghaiDateStr,
} from '../local-settings'
import { SlotDay, MIN, buildSlotDays, shanghaiMinutesOf, atShanghai, toMin, slotLabel } from '../slots'

export interface ScheduleTimeline {
  scheduledAt: Date
  /** 该呼叫 = 送达 − 路上 − 呼叫到取走 */
  callAt: Date
  /** 开始备餐 = 该呼叫 − 备餐 */
  prepStartAt: Date
  /** 接单截止 = 开始备餐 − 缓冲。催单/重复播报只在它之后 */
  acceptDueAt: Date
  /** 出票 = 开始备餐 − 提前量 */
  ticketAt: Date
  /** 自助取消截止 = 送达 − selfCancelLeadMin */
  selfCancelUntil: Date
  prepMinutes: number
  rideMinutes: number
}

/** 预约单备餐时长：schedule.prepMinutes，送达时刻落在高峰时取与 peak.prepMaxMinutes 的大者（未决歧义 2） */
export function schedulePrepMinutes(s: LocalDeliverySettings, at: Date): number {
  return minutesInPeak(s, shanghaiMinutesOf(at)) ? Math.max(s.schedule.prepMinutes, s.peak.prepMaxMinutes) : s.schedule.prepMinutes
}

export function scheduleTimeline(s: LocalDeliverySettings, scheduledAt: Date, distanceM: number): ScheduleTimeline {
  const ride = rideMinutes(s, distanceM)
  const prep = schedulePrepMinutes(s, scheduledAt)
  const callAt = new Date(scheduledAt.getTime() - (ride + s.callToPickupMin) * MIN)
  const prepStartAt = new Date(callAt.getTime() - prep * MIN)
  const acceptDueAt = new Date(prepStartAt.getTime() - s.schedule.acceptBufferMin * MIN)
  const ticketAt = new Date(prepStartAt.getTime() - s.schedule.prepTicketLeadMin * MIN)
  const selfCancelUntil = new Date(scheduledAt.getTime() - s.selfCancelLeadMin * MIN)
  return { scheduledAt, callAt, prepStartAt, acceptDueAt, ticketAt, selfCancelUntil, prepMinutes: prep, rideMinutes: ride }
}

/** 一格可选要提前多少分钟 = 路上 + 呼叫到取走 + 备餐 + 接单缓冲（= scheduledAt − acceptDueAt） */
export function scheduleLeadMinutes(s: LocalDeliverySettings, slotStart: Date, distanceM: number): number {
  return rideMinutes(s, distanceM) + s.callToPickupMin + schedulePrepMinutes(s, slotStart) + s.schedule.acceptBufferMin
}

export interface DeliverySlotsView {
  days: SlotDay[]
  earliestAt: string | null
  slotMinutes: number
  blocked: null | { kind: 'DISABLED' | 'HOLIDAY' | 'PAUSED'; text: string }
}

/**
 * 外送时段。多两条规则：开始备餐不得早于该营业段开门；暂停期间的格子不出
 * （paused.until 之前不出、之后照出；until 为空视为当天全停，明天照出）。
 */
export function buildDeliverySlots(s: LocalDeliverySettings, distanceM: number, now: Date = new Date()): DeliverySlotsView {
  const slotMinutes = s.schedule.slotMinutes
  if (!s.schedule.enabled) return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'DISABLED', text: '预约配送暂未开通' } }
  const paused = isPaused(s, now)
  const pausedUntil = paused && s.paused?.until && Number.isFinite(Date.parse(s.paused.until)) ? Date.parse(s.paused.until) : null
  const today = shanghaiDateStr(now)
  const r = buildSlotDays({
    businessHours: s.businessHours, slotMinutes, daysAhead: s.schedule.daysAhead, now,
    isHolidayOn: (d) => isHolidayOn(s, d),
    leadMinutesOf: (start) => scheduleLeadMinutes(s, start, distanceM),
    slotFilter: (start, window, date) => {
      if (scheduleTimeline(s, start, distanceM).prepStartAt.getTime() < atShanghai(date, toMin(window.start)).getTime()) return false
      if (!paused) return true
      if (pausedUntil === null) return date !== today
      return start.getTime() >= pausedUntil
    },
  })
  if (r.allHoliday) {
    const until = s.holiday?.until
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'HOLIDAY', text: `休息中${until ? `，${until.slice(5).replace('-', '月')}日后恢复` : ''}` } }
  }
  if (paused && r.earliestAt === null) {
    return { days: [], earliestAt: null, slotMinutes, blocked: { kind: 'PAUSED', text: `同城配送暂停接单${s.paused?.reason ? `：${s.paused.reason}` : ''}` } }
  }
  return { days: r.days, earliestAt: r.earliestAt, slotMinutes, blocked: null }
}

/** 下单时校验：scheduledAt 必须精确命中此刻用同一 distanceM 算出的某一格起点 */
export function isValidDeliverySlot(s: LocalDeliverySettings, scheduledAt: Date, distanceM: number, now: Date = new Date()): boolean {
  const iso = scheduledAt.toISOString()
  return buildDeliverySlots(s, distanceM, now).days.some((d) => d.slots.some((x) => x.startAt === iso))
}

/** 页头没有地址时的保守最早送达文案：按配送半径算最坏路上时间。不可约时返回空串 */
export function earliestScheduleText(s: LocalDeliverySettings, now: Date = new Date()): string {
  const v = buildDeliverySlots(s, Math.round(s.radiusKm * 1000), now)
  if (v.blocked || !v.earliestAt) return ''
  return `最早${slotLabel(new Date(v.earliestAt), v.slotMinutes, now)}送达`
}

/** 现在呼叫预计几点送到 = now + 呼叫到取走 + 路上 */
export function etaIfCallNow(s: LocalDeliverySettings, distanceM: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + (s.callToPickupMin + rideMinutes(s, distanceM)) * MIN)
}

/** 工作台卡片阶段（spec §6.1 六态 + CALLED，计划差异⑥）。LATE 优先：过了约定时刻骑手还没取餐 */
export type SchedulePhase = 'WAITING' | 'TICKETED' | 'PREPPING' | 'CALL_DUE' | 'READY_WAITING' | 'CALLED' | 'LATE'
export function schedulePhase(tl: ScheduleTimeline, o: { readyAt: Date | null; pickedUp: boolean }, now: Date = new Date()): SchedulePhase {
  const t = now.getTime()
  if (!o.pickedUp && t > tl.scheduledAt.getTime()) return 'LATE'
  if (o.readyAt) return t < tl.callAt.getTime() ? 'READY_WAITING' : 'CALLED'
  if (t >= tl.callAt.getTime()) return 'CALL_DUE'
  if (t >= tl.prepStartAt.getTime()) return 'PREPPING'
  if (t >= tl.ticketAt.getTime()) return 'TICKETED'
  return 'WAITING'
}

/** 顾客详情、管理端详情、工作台共用的 schedule 节。非预约单或缺距离 → null */
export function scheduleView(
  s: LocalDeliverySettings,
  order: { deliveryType: string; scheduledAt: Date | null; distanceM: number | null; readyAt: Date | null },
  now: Date = new Date(),
  pickedUp = false,
) {
  if (order.deliveryType !== 'LOCAL' || !order.scheduledAt || order.distanceM === null) return null
  const tl = scheduleTimeline(s, order.scheduledAt, order.distanceM)
  return {
    scheduledAt: tl.scheduledAt.toISOString(),
    slotLabel: slotLabel(tl.scheduledAt, s.schedule.slotMinutes, now),
    ticketAt: tl.ticketAt.toISOString(),
    prepStartAt: tl.prepStartAt.toISOString(),
    callAt: tl.callAt.toISOString(),
    acceptDueAt: tl.acceptDueAt.toISOString(),
    selfCancelUntil: tl.selfCancelUntil.toISOString(),
    readyAt: order.readyAt?.toISOString() ?? null,
    phase: schedulePhase(tl, { readyAt: order.readyAt, pickedUp }, now),
    etaIfCallNow: etaIfCallNow(s, order.distanceM, now).toISOString(),
    callToleranceMin: s.schedule.callToleranceMin,
  }
}
```

- [ ] **Step 5: 写 `scripts/selftest-schedule.ts`**

```ts
/**
 * 预约送达纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-schedule.ts
 */
import assert from 'assert'
import { DEFAULT_LOCAL_SETTINGS, sanitizeLocalSettings } from '../src/services/local-settings'
import {
  scheduleTimeline, schedulePrepMinutes, buildDeliverySlots, isValidDeliverySlot, earliestScheduleText, schedulePhase, scheduleView,
} from '../src/services/delivery/schedule'
import { buildPickupSlots } from '../src/services/pickup'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const sh = (iso: string) => new Date(iso + '+08:00')
const iso = (d: Date) => d.toISOString()

// 3 km / 15 km/h = 12 分路上；呼叫到取走 12；备餐 20（高峰 30）；缓冲 5；提前量 15；自助取消 120
const base = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  businessHours: [{ start: '10:00', end: '14:00' }, { start: '17:00', end: '20:00' }],
  prepMinutes: 20, riderSpeedKmh: 15, callToPickupMin: 12,
  peak: { windows: [{ start: '12:00', end: '13:00' }], prepMinMinutes: 25, prepMaxMinutes: 30 },
  schedule: { ...DEFAULT_LOCAL_SETTINGS.schedule, enabled: true },
  selfCancelLeadMin: 120,
})
const D3 = 3000

t('平时 12:00 前送达（11:30）：呼叫 11:06、开始备餐 10:46、接单截止 10:41、出票 10:31、自助取消 09:30', () => {
  const tl = scheduleTimeline(base, sh('2026-09-22T11:30:00'), D3)
  assert.strictEqual(iso(tl.callAt), iso(sh('2026-09-22T11:06:00')))
  assert.strictEqual(iso(tl.prepStartAt), iso(sh('2026-09-22T10:46:00')))
  assert.strictEqual(iso(tl.acceptDueAt), iso(sh('2026-09-22T10:41:00')))
  assert.strictEqual(iso(tl.ticketAt), iso(sh('2026-09-22T10:31:00')))
  assert.strictEqual(iso(tl.selfCancelUntil), iso(sh('2026-09-22T09:30:00')))
  assert.strictEqual(tl.prepMinutes, 20); assert.strictEqual(tl.rideMinutes, 12)
})
t('高峰送达（12:30）：备餐取 max(20, 30)=30，开始备餐 11:36', () => {
  assert.strictEqual(schedulePrepMinutes(base, sh('2026-09-22T12:30:00')), 30)
  assert.strictEqual(iso(scheduleTimeline(base, sh('2026-09-22T12:30:00'), D3).prepStartAt), iso(sh('2026-09-22T11:36:00')))
})
t('schedule.prepMinutes 大于高峰上界时以它为准', () => {
  const s = sanitizeLocalSettings({ ...base, schedule: { ...base.schedule, prepMinutes: 40 } })
  assert.strictEqual(schedulePrepMinutes(s, sh('2026-09-22T12:30:00')), 40)
})
t('09:00 看时段：10:00 格开始备餐 09:16 早于开门 10:00 → 不出；首格 11:00（开始备餐 10:16 ≥ 10:00）', () => {
  const v = buildDeliverySlots(base, D3, sh('2026-09-22T09:00:00'))
  assert.strictEqual(v.blocked, null)
  const labels = v.days[0].slots.map((x) => x.label)
  assert.ok(!labels.includes('10:00–10:30') && !labels.includes('10:30–11:00'), labels.join(','))
  assert.strictEqual(labels[0], '11:00–11:30')
  assert.strictEqual(v.earliestAt, v.days[0].slots[0].startAt)
})
t('10:30 看时段：11:00 格提前量 12+12+20+5=49 → 10:11 < 10:30 不可选；11:30 格 10:41 ≥ 10:30 可选', () => {
  const v = buildDeliverySlots(base, D3, sh('2026-09-22T10:30:00'))
  assert.strictEqual(v.days[0].slots[0].label, '11:30–12:00')
})
t('末格不越打烊：13:30–14:00 是上午最后一格；晚市首格按开门 17:00 推 → 18:00', () => {
  const labels = buildDeliverySlots(base, D3, sh('2026-09-22T09:00:00')).days[0].slots.map((x) => x.label)
  assert.ok(labels.includes('13:30–14:00')); assert.ok(!labels.some((l) => l.startsWith('14:00')))
  assert.ok(!labels.includes('17:00–17:30') && !labels.includes('17:30–18:00')); assert.ok(labels.includes('18:00–18:30'))
})
t('打烊后（21:00）：今天空数组、明天满格，label 明天', () => {
  const v = buildDeliverySlots(base, D3, sh('2026-09-22T21:00:00'))
  assert.deepStrictEqual(v.days[0].slots, []); assert.strictEqual(v.days[1].label, '明天'); assert.ok(v.days[1].slots.length > 0)
})
t('daysAhead=0 只有今天；休业日整天去掉；全休业 blocked=HOLIDAY', () => {
  const s0 = sanitizeLocalSettings({ ...base, schedule: { ...base.schedule, daysAhead: 0 } })
  assert.strictEqual(buildDeliverySlots(s0, D3, sh('2026-09-22T09:00:00')).days.length, 1)
  const sh1 = sanitizeLocalSettings({ ...base, holiday: { until: '2026-09-22', reason: '盘点' } })
  const v = buildDeliverySlots(sh1, D3, sh('2026-09-22T09:00:00'))
  assert.strictEqual(v.days.length, 1); assert.strictEqual(v.days[0].date, '2026-09-23')
  const sh2 = sanitizeLocalSettings({ ...base, holiday: { until: '2026-09-23', reason: '盘点' } })
  assert.strictEqual(buildDeliverySlots(sh2, D3, sh('2026-09-22T09:00:00')).blocked?.kind, 'HOLIDAY')
})
t('暂停：until 为空当天全停明天照出；until=12:00 则 12:00 前的格不出、之后照出', () => {
  const p1 = sanitizeLocalSettings({ ...base, paused: { until: null, reason: '忙' } })
  const v1 = buildDeliverySlots(p1, D3, sh('2026-09-22T09:00:00'))
  assert.deepStrictEqual(v1.days[0].slots, []); assert.ok(v1.days[1].slots.length > 0); assert.strictEqual(v1.blocked, null)
  const p2 = sanitizeLocalSettings({ ...base, paused: { until: '2026-09-22T12:00:00+08:00', reason: '忙' } })
  const labels = buildDeliverySlots(p2, D3, sh('2026-09-22T09:00:00')).days[0].slots.map((x) => x.label)
  assert.ok(!labels.includes('11:00–11:30')); assert.ok(labels.includes('12:00–12:30'))
  const p3 = sanitizeLocalSettings({ ...p1, schedule: { ...p1.schedule, daysAhead: 0 } })
  assert.strictEqual(buildDeliverySlots(p3, D3, sh('2026-09-22T09:00:00')).blocked?.kind, 'PAUSED')
})
t('未开通 blocked=DISABLED；isValidDeliverySlot 精确命中格起点', () => {
  const off = sanitizeLocalSettings({ ...base, schedule: { ...base.schedule, enabled: false } })
  assert.strictEqual(buildDeliverySlots(off, D3, sh('2026-09-22T09:00:00')).blocked?.kind, 'DISABLED')
  assert.strictEqual(isValidDeliverySlot(base, sh('2026-09-22T11:00:00'), D3, sh('2026-09-22T09:00:00')), true)
  assert.strictEqual(isValidDeliverySlot(base, sh('2026-09-22T11:07:00'), D3, sh('2026-09-22T09:00:00')), false)
  assert.strictEqual(isValidDeliverySlot(base, sh('2026-09-22T10:00:00'), D3, sh('2026-09-22T09:00:00')), false)
})
t('earliestScheduleText 按半径 5 km 算最坏路上 20 分：09:00 看首格 11:00 → 「最早今天 11:00–11:30送达」', () => {
  assert.strictEqual(earliestScheduleText(base, sh('2026-09-22T09:00:00')), '最早今天 11:00–11:30送达')
})
t('phase 七态按时刻切换', () => {
  const tl = scheduleTimeline(base, sh('2026-09-22T11:30:00'), D3)
  const none = { readyAt: null, pickedUp: false }
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T10:00:00')), 'WAITING')
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T10:31:00')), 'TICKETED')
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T10:46:00')), 'PREPPING')
  assert.strictEqual(schedulePhase(tl, none, sh('2026-09-22T11:06:00')), 'CALL_DUE')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: false }, sh('2026-09-22T10:55:00')), 'READY_WAITING')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: false }, sh('2026-09-22T11:10:00')), 'CALLED')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: false }, sh('2026-09-22T11:31:00')), 'LATE')
  assert.strictEqual(schedulePhase(tl, { readyAt: sh('2026-09-22T10:50:00'), pickedUp: true }, sh('2026-09-22T11:31:00')), 'CALLED')
})
t('scheduleView：非预约单/缺距离 → null；预约单给全部时刻与 phase', () => {
  assert.strictEqual(scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: null, distanceM: D3, readyAt: null }), null)
  assert.strictEqual(scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: sh('2026-09-22T11:30:00'), distanceM: null, readyAt: null }), null)
  const v = scheduleView(base, { deliveryType: 'LOCAL', scheduledAt: sh('2026-09-22T11:30:00'), distanceM: D3, readyAt: null }, sh('2026-09-22T09:00:00'))!
  assert.strictEqual(v.phase, 'WAITING'); assert.strictEqual(v.slotLabel, '今天 11:30–12:00'); assert.strictEqual(v.callAt, iso(sh('2026-09-22T11:06:00')))
})
t('自取经公共模块后行为不变：09:00 看自取首格 10:00（10:00−20−5=09:35 ≥ 09:00）', () => {
  const s = sanitizeLocalSettings({ ...base, pickup: { ...base.pickup, enabled: true, slotMinutes: 30, acceptBufferMin: 5, daysAhead: 1 } })
  const v = buildPickupSlots(s, sh('2026-09-22T09:00:00'))
  assert.strictEqual(v.days[0].slots[0].label, '10:00–10:30'); assert.strictEqual(v.days.length, 2)
})

console.log(process.exitCode ? `有失败（通过 ${pass}）` : `全部通过 ${pass}`)
```

- [ ] **Step 6: 跑三个 selftest 与 tsc，提交**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-schedule.ts && npx ts-node --transpile-only scripts/selftest-pickup.ts && npx ts-node --transpile-only scripts/selftest-local-settings.ts && npx tsc --noEmit`
Expected: schedule「全部通过 14」；pickup 与 local-settings 全绿；零错误。

```bash
git add apps/server/src/services/slots.ts apps/server/src/services/pickup.ts apps/server/src/services/delivery/schedule.ts apps/server/scripts/selftest-schedule.ts
git commit -m "feat(schedule): 时段切格抽成公共模块 slots.ts；预约送达倒推时间轴 scheduleTimeline + 外送时段 + phase（纯函数）"
```

---

### Task 4: 公开时段接口、meta、顾客端下单/详情/取消窗口

**Files:**
- Modify: `apps/server/src/routes/local.ts`（`/meta`、新 `/delivery-slots`）
- Modify: `apps/server/src/routes/orders.ts`（schema、LOCAL 分支、`orderCreatedView`、`canSelfCancelOf`、`cancelWindowOf`、详情、`/cancel`、`/cancel-request`、mock 支付推送）

**Interfaces:**
- Produces：`GET /api/local/delivery-slots?distanceM=` → `DeliverySlotsView`；`GET /api/local/meta` 的 `delivery.earliestScheduleText`；`POST /api/orders` 收 `scheduledAt`；`orderCreatedView.scheduledAt`；`GET /api/orders/:id` 的 `schedule` 节（`scheduleView` 的返回）；错误码 42290/42291。
- Consumes：Task 3 全部。

- [ ] **Step 1: `routes/local.ts`：meta 加 `earliestScheduleText`，新时段接口**

```ts
import { buildDeliverySlots, earliestScheduleText } from '../services/delivery/schedule'
```

`/meta` 改成：

```ts
router.get('/meta', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const s = await getLocalSettings()
    const meta = publicLocalMeta(s)
    // 页头还没有地址算不出路上时间，用配送半径算一个保守的最早送达（spec §4.3）
    success(res, { ...meta, delivery: { ...meta.delivery, earliestScheduleText: earliestScheduleText(s) } })
  } catch (e) {
    next(e)
  }
})

// 预约外送时段（公开）。distanceM 必传：来自结算页已拿到的报价，时段的提前量取决于路上时间
const deliverySlotsSchema = z.object({ distanceM: z.coerce.number().int().min(0).max(200_000) })
router.get('/delivery-slots', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { distanceM } = deliverySlotsSchema.parse(req.query)
    success(res, buildDeliverySlots(await getLocalSettings(), distanceM, new Date()))
  } catch (e) {
    next(e)
  }
})
```

- [ ] **Step 2: `routes/orders.ts` import 与 schema**

import 加：
```ts
import { scheduleTimeline, isValidDeliverySlot, scheduleView } from '../services/delivery/schedule'
import { slotLabel } from '../services/slots'
```

`createOrderSchema` 的 object 里加：
```ts
    // 预约送达（2026-09-21）：ISO 时刻，只对 LOCAL 有意义；传了就是预约单
    scheduledAt: z.string().datetime({ offset: true }).optional(),
```
现有两条 `.refine` 之后再加一条：
```ts
  .refine((v) => v.scheduledAt === undefined || v.deliveryType === 'LOCAL', { message: '仅同城外送支持预约送达' })
```
解构处加 `scheduledAt`。

- [ ] **Step 3: LOCAL 分支**（`if (deliveryType === 'LOCAL') {` 内，整段开头到 `const distanceM = quoted.distanceM` 之间按下面改；其后不动）

```ts
    if (deliveryType === 'LOCAL') {
      const s = await getLocalSettings()
      const scheduled = scheduledAt ? new Date(scheduledAt) : null
      if (!s.enabled) throw new AppError(42226, '同城配送暂未开通')
      if (scheduled && !s.schedule.enabled) throw new AppError(42290, '预约配送暂未开通')
      // 预约单跳过「暂停」与「非营业时间」两道门：暂停期间的格子由时段生成排除，营业时间外本就可以约明天（spec §4.4）
      if (!scheduled && isPaused(s)) throw new AppError(42226, `同城配送暂停接单${s.paused?.reason ? `：${s.paused.reason}` : ''}`)
      if (isHolidayNow(s)) throw new AppError(42226, nextOpenText(s))
      if (!scheduled && !isOpenNow(s)) throw new AppError(42222, `当前非营业时间，${nextOpenText(s)}`)
      if (address!.latE6 === null || address!.lngE6 === null) throw new AppError(42223, '该地址缺少定位，请编辑地址并在地图上选点')
      if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标，暂不能配送')
      /* …quoteToken 信任边界注释与 verifyQuote / 42239 / 42227 三段原样… */
      const distanceM = quoted.distanceM
      // 预约时段必须精确命中此刻用凭证里的距离算出的某一格（顾客磨蹭到那格过期了就拒，让他重选）
      if (scheduled && !isValidDeliverySlot(s, scheduled, distanceM, new Date())) throw new AppError(42291, '该时段已不可选，请重新选择送达时间')
```

`localSnapshot = { ... }` 的对象末尾加：
```ts
        // 预约单：送达时段起点 + 预计送达直接等于它（接单时不再重算，见 admin/delivery.ts doAccept）
        ...(scheduled ? { scheduledAt: scheduled, estimatedDeliveryAt: scheduled } : {}),
```
`localSnapshot` 的类型声明加 `scheduledAt?: Date`。

- [ ] **Step 4: `orderCreatedView` 加一行**（`pickupAt` 之后）

```ts
    scheduledAt: order.scheduledAt ?? null,
```

- [ ] **Step 5: 替换 `canSelfCancelOf` 与 `cancelWindowOf`**

```ts
/**
 * 「取消订单」按钮该不该出现（spec 2026-09-21 §4.6）：待付款一律可；
 * 自取 / 预约外送：约定时刻前 selfCancelLeadMin 分钟之外可自助秒退，不看是否接单，PAID/PREPARING 均可，
 * 但已备好（readyAt / pickupReadyAt）后关闭；立即单与邮寄：PAID 未接单。
 */
async function canSelfCancelOf(order: {
  deliveryType: string; status: string; acceptedAt: Date | null
  pickupAt: Date | null; pickupReadyAt: Date | null
  scheduledAt: Date | null; distanceM: number | null; readyAt: Date | null
}) {
  if (order.status === 'PENDING_PAYMENT') return true
  if (order.status !== 'PAID' && order.status !== 'PREPARING') return false
  if (order.deliveryType === 'PICKUP') {
    if (!order.pickupAt || order.pickupReadyAt) return false
    const s = await getLocalSettings()
    return Date.now() < order.pickupAt.getTime() - s.selfCancelLeadMin * 60_000
  }
  if (order.deliveryType === 'LOCAL' && order.scheduledAt) {
    if (order.readyAt || order.distanceM === null) return false
    const s = await getLocalSettings()
    return Date.now() < scheduleTimeline(s, order.scheduledAt, order.distanceM).selfCancelUntil.getTime()
  }
  return order.status === 'PAID' && !order.acceptedAt
}

/**
 * 「申请取消」窗口。立即单/邮寄（D6 ②）：接单后 acceptGraceMin 分钟内。
 * 自取 / 预约外送（spec 2026-09-21 §4.6）：过了自助取消截止、且未备好、且无在途配送单、PAID/PREPARING → 可申请；没有分钟数概念。
 */
async function cancelWindowOf(order: {
  deliveryType: string; status: string; acceptedAt: Date | null; cancelRequestedAt: Date | null
  pickupAt: Date | null; pickupReadyAt: Date | null
  scheduledAt: Date | null; distanceM: number | null; readyAt: Date | null
}) {
  const closed = { canRequestCancel: false, cancelRequestDeadline: null as Date | null, cancelGraceMin: 0 }
  if (order.deliveryType === 'PICKUP') {
    if (!order.pickupAt || order.cancelRequestedAt || order.pickupReadyAt) return closed
    if (order.status !== 'PAID' && order.status !== 'PREPARING') return closed
    const s = await getLocalSettings()
    return { canRequestCancel: Date.now() >= order.pickupAt.getTime() - s.selfCancelLeadMin * 60_000, cancelRequestDeadline: null, cancelGraceMin: 0 }
  }
  if (order.deliveryType === 'LOCAL' && order.scheduledAt) {
    if (order.cancelRequestedAt || order.readyAt || order.distanceM === null) return closed
    if (order.status !== 'PAID' && order.status !== 'PREPARING') return closed
    const s = await getLocalSettings()
    const tl = scheduleTimeline(s, order.scheduledAt, order.distanceM)
    return { canRequestCancel: Date.now() >= tl.selfCancelUntil.getTime(), cancelRequestDeadline: null, cancelGraceMin: 0 }
  }
  if (order.status !== 'PREPARING' || !order.acceptedAt) return closed
  const graceMin = order.deliveryType === 'LOCAL' ? (await getLocalSettings()).acceptGraceMin : order.deliveryType === 'EXPRESS' ? (await getExpressSettings()).acceptGraceMin : 0
  if (graceMin <= 0) return closed
  const deadline = new Date(order.acceptedAt.getTime() + graceMin * 60 * 1000)
  return { canRequestCancel: !order.cancelRequestedAt && Date.now() < deadline.getTime(), cancelRequestDeadline: deadline, cancelGraceMin: graceMin }
}
```
（两个函数的调用点都传整行 Prisma 订单对象，字段已齐；`tsc` 报缺字段的调用点按此补 select。）

- [ ] **Step 6: 详情加 `schedule` 节**（`pickup: await pickupViewOf(order),` 旁边）

```ts
      schedule: order.deliveryType === 'LOCAL' && order.scheduledAt ? scheduleView(await getLocalSettings(), order, new Date(), pickedUp) : null,
```
`pickedUp` 在 LOCAL 分支之前声明、分支内赋值（`d` 是块作用域）：
```ts
    let pickedUp = false
    if (order.deliveryType === 'LOCAL') {
      const d = await prisma.delivery.findFirst({ where: { orderId: id }, orderBy: { id: 'desc' } })
      delivery = d ? customerDeliveryView(d) : null
      pickedUp = !!d?.pickedUpAt
    }
```

- [ ] **Step 7: `PUT /orders/:id/cancel` 的自助秒退分支**

删掉现有的 `if (order.deliveryType === 'PICKUP' && order.status === 'PAID') { … 42229 … }` 块，把 `if (order.status === 'PAID' && !order.acceptedAt) {` 那一整段改成下面（事务分两种，后面的出票/退款共用）：

```ts
    // 自取 / 预约外送：约定时刻前 selfCancelLeadMin 之外可自助秒退，不看是否接单（spec 2026-09-21 §4.6）；
    // 立即单 / 邮寄：PAID 未接单。两种都落到同一段「出 CANCEL 票 + 发起全额退款」。
    const timed = order.deliveryType === 'PICKUP' || (order.deliveryType === 'LOCAL' && !!order.scheduledAt)
    let selfCancelled = false
    if (timed && (order.status === 'PAID' || order.status === 'PREPARING')) {
      if (!(await canSelfCancelOf(order))) throw new AppError(42229, '已临近约定时间，请改为「申请取消」由商家确认')
      await prisma.$transaction(async (tx) => {
        // 条件写：与「已备好」「呼叫骑手」并发时以先落库者为准（readyAt/pickupReadyAt 一旦非空本次取消失败）
        const moved = await tx.order.updateMany({
          where: { id, status: { in: ['PAID', 'PREPARING'] }, readyAt: null, pickupReadyAt: null },
          data: {
            status: 'REFUNDING', cancelledAt: new Date(), cancelReason: '用户申请退款',
            cancelRequestedAt: null, cancelRequestNote: null, cancelRequestDeliveryStatus: null, cancelRequestRemindedAt: null,
          },
        })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
        await rollbackOrderStock(tx, order.items)
      })
      selfCancelled = true
    } else if (order.status === 'PAID' && !order.acceptedAt) {
      await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({
          where: { id, status: 'PAID', acceptedAt: null },
          data: { status: 'REFUNDING', cancelledAt: new Date(), cancelReason: '用户申请退款' },
        })
        if (moved.count === 0) throw new AppError(42204, '商家已接单备餐，请电话联系商家协商退款')
        await rollbackOrderStock(tx, order.items)
      })
      selfCancelled = true
    }
    if (selfCancelled) {
      /* …原有的 enqueueOrderTicket(id,'CANCEL') / initiateRefund / autoRefunded / return success 段原样… */
    }
```
`services/refund.ts` **不用改**：`initiateRefund` 从 `REFUNDING` 全额退的路径不看 PREPARING；42221「有在途配送单」守卫由不变量「有在途单 ⇒ readyAt 非空」保证不会命中（readyAt 非空时上面的条件写已经落空）。

- [ ] **Step 8: `POST /orders/:id/cancel-request`**

`where: { id, status: { in: … } }` 改成：
```ts
      where: { id, status: { in: order.deliveryType === 'PICKUP' || order.scheduledAt ? ['PAID', 'PREPARING'] : ['PREPARING'] }, cancelRequestedAt: null },
```
`!win.canRequestCancel` 的文案改成：
```ts
      const timed = order.deliveryType === 'PICKUP' || (order.deliveryType === 'LOCAL' && !!order.scheduledAt)
      throw new AppError(42229, timed
        ? (order.readyAt || order.pickupReadyAt ? '餐品已备好，如有问题请联系商家或申请售后' : '当前可直接取消订单，无需申请')
        : order.status === 'PAID' ? '商家尚未接单，请直接申请退款' : '已超过可取消时间，如有问题请联系商家')
```

- [ ] **Step 9: mock 支付路径的来单推送带时段**（`/:id/pay` 里 `let slotLabel: string | undefined` 那段之后）

```ts
          let scheduleSlotLabel: string | undefined
          if (order.deliveryType === 'LOCAL' && order.scheduledAt) {
            try { scheduleSlotLabel = slotLabel(order.scheduledAt, (await getLocalSettings()).schedule.slotMinutes) }
            catch (e) { console.error('[orders] 计算预约时段文案失败（mock 支付）:', (e as Error).message) }
          }
          notifyOrderPaid({ ...order, paidAt, pickupSlotLabel: slotLabel, scheduleSlotLabel }, items)
```
（`notifyOrderPaid` 的 `scheduleSlotLabel` 字段在 Task 8 加；本步先加，Task 8 之前 `tsc` 会报多余属性——**本 Task 结束前先把 Task 8 Step 1 的 `NotifyOrderInfo.scheduleSlotLabel` 一行加上**。）

- [ ] **Step 10: tsc，提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

```bash
git add apps/server/src/routes/local.ts apps/server/src/routes/orders.ts apps/server/src/services/order-notify.ts
git commit -m "feat(orders): 预约送达下单/时段接口/详情 schedule 节；自取与预约的自助取消截止改为约定前 selfCancelLeadMin"
```

---

### Task 5: 管理端端点（接单不重算、已备好、立即呼叫）与呼叫来源

**Files:**
- Modify: `apps/server/src/services/delivery/orchestrator.ts`（`CallRiderInput`、`callRider` 占位创建、`selfDeliver`）
- Modify: `apps/server/src/routes/admin/delivery.ts`（`ADMIN_DELIVERY_SELECT`、`doAccept`、`accept-and-call`、`callSchema`、`/call`、新 `/ready`）

**Interfaces:**
- Produces：`DeliveryCallOrigin`；`CallRiderInput.origin?`；`POST /admin/local/orders/:id/ready` → `{ readyAt, called, callAt, …callRider 返回 }`；`POST /admin/local/orders/:id/call` 收 `force?: boolean`；42292。
- 不变量：**有在途配送单 ⇒ `readyAt` 非空**（callRider / selfDeliver 都写它）。

- [ ] **Step 1: orchestrator：类型与占位写 `callOrigin`、写 `readyAt`**

`CallRiderInput` 加：
```ts
  /**
   * **内部字段，不从 HTTP 收**：预约单的呼叫来源（计划差异②）。SCHEDULED_AUTO = 已备好后到点自动发单
   * （schedule-tasks / `/ready` 到点即呼）；MANUAL_EARLY = 店员「立即呼叫」跳过等待；不传 = 普通手动 / 升级。
   */
  origin?: DeliveryCallOrigin
```
文件里 `DeliveryCallStrategy` 类型旁加：
```ts
export type DeliveryCallOrigin = 'SCHEDULED_AUTO' | 'MANUAL_EARLY'
```
`prisma.delivery.create({ data: { … calledProviders, callStrategy, } })` 加 `callOrigin: input.origin ?? null,`。

占位创建的 try/catch 之后、`const delays = …` 之前加：
```ts
  // 预约单：呼叫即视为已备好（spec §4.5 不变量：有在途配送单 ⇒ readyAt 非空）。呼叫失败也保留——店员表达过「好了」
  if (order.scheduledAt && !order.readyAt) {
    await prisma.order.updateMany({ where: { id: orderId, readyAt: null }, data: { readyAt: new Date() } })
  }
```

`selfDeliver` 事务里 `tx.order.updateMany({ where: {…}, data: { status: 'SHIPPED' } })` 改为：
```ts
      const moved = await tx.order.updateMany({
        where: { id: input.orderId, deliveryType: 'LOCAL', status: 'PREPARING' },
        data: { status: 'SHIPPED', ...(order.scheduledAt && !order.readyAt ? { readyAt: now } : {}) },
      })
```

- [ ] **Step 2: `routes/admin/delivery.ts`**

import 加：
```ts
import { scheduleTimeline } from '../../services/delivery/schedule'
import { getActiveDelivery } from '../../services/delivery/orchestrator'
```
`ADMIN_DELIVERY_SELECT` 的 `callStrategy: true,` 后加 `callOrigin: true,`。

`doAccept`：select 加 `scheduledAt: true`；预计送达改为
```ts
  // 预约单下单时已把 estimatedDeliveryAt 写成 scheduledAt，接单不重算（spec §4.5）
  const estimatedDeliveryAt = target.scheduledAt ? null : target.distanceM != null
    ? new Date(acceptedAt.getTime() + estimateMinutes(s, target.distanceM, acceptedAt) * 60 * 1000)
    : null
```

`accept-and-call` 在 `await doAccept(id)` 之前加：
```ts
    const t = await prisma.order.findUnique({ where: { id }, select: { scheduledAt: true } })
    if (t?.scheduledAt) throw new AppError(42292, '预约单请先「接单」，到点后点「已备好」由系统呼叫')
```

`callSchema` 改为：
```ts
const callSchema = z.object({
  providers: z.array(z.string().trim().min(1).max(32)).min(1).max(10).optional(),
  /** 预约单「立即呼叫」：跳过「该呼叫时刻」的等待，记 MANUAL_EARLY */
  force: z.boolean().optional(),
})
```

加守卫函数（放在 `callSchema` 之后）：
```ts
/**
 * 预约单的呼叫时机守卫（spec §4.5）：早于 callAt − callToleranceMin 且未带 force → 42292；带 force → MANUAL_EARLY。
 * 立即单、缺距离的单一律放行（返回 undefined = 普通手动呼叫）。
 */
async function scheduledCallGuard(id: number, force: boolean): Promise<'MANUAL_EARLY' | undefined> {
  const o = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, scheduledAt: true, distanceM: true } })
  if (!o || o.deliveryType !== 'LOCAL' || !o.scheduledAt || o.distanceM === null) return undefined
  const s = await getLocalSettings()
  const tl = scheduleTimeline(s, o.scheduledAt, o.distanceM)
  if (Date.now() >= tl.callAt.getTime() - s.schedule.callToleranceMin * 60_000) return undefined
  if (!force) throw new AppError(42292, `距该呼叫时刻还有 ${Math.ceil((tl.callAt.getTime() - Date.now()) / 60_000)} 分钟，如需提前请用「立即呼叫」`)
  return 'MANUAL_EARLY'
}
```

`/call` 改为：
```ts
router.post('/:id/call', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const { providers, force } = callSchema.parse(req.body ?? {})
    const origin = await scheduledCallGuard(id, !!force)
    const r = await callRider({ orderId: id, operator: req.adminUsername!, source: 'ADMIN', providers, origin })
    success(res, r)
  } catch (e) { next(e) }
})

// POST /api/admin/local/orders/:id/ready — 预约单「已备好」（spec §4.5）：写 readyAt；已到该呼叫时刻立即发单，否则等定时任务到点发
router.post('/:id/ready', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const o = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, status: true, scheduledAt: true, distanceM: true, readyAt: true } })
    if (!o) throw new AppError(40401, '订单不存在', 404)
    if (o.deliveryType !== 'LOCAL' || !o.scheduledAt) throw new AppError(42292, '仅预约单可标记「已备好」；立即单请直接呼叫骑手')
    if (o.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${o.status}，仅备餐中订单可标记已备好`)
    if (await getActiveDelivery(id)) throw new AppError(42228, '该订单已有在途配送单')
    // 幂等：重复点只回原时刻，不覆盖
    const readyAt = o.readyAt ?? new Date()
    if (!o.readyAt) await prisma.order.updateMany({ where: { id, status: 'PREPARING', readyAt: null }, data: { readyAt } })
    const s = await getLocalSettings()
    const tl = o.distanceM === null ? null : scheduleTimeline(s, o.scheduledAt, o.distanceM)
    if (tl && Date.now() >= tl.callAt.getTime()) {
      try {
        const r = await callRider({ orderId: id, operator: req.adminUsername!, source: 'ADMIN', origin: 'SCHEDULED_AUTO' })
        return success(res, { readyAt: readyAt.toISOString(), called: true, callAt: tl.callAt.toISOString(), ...r })
      } catch (e) {
        if (e instanceof AppError) e.message = '已记录备好，' + e.message
        throw e
      }
    }
    success(res, { readyAt: readyAt.toISOString(), called: false, callAt: tl?.callAt.toISOString() ?? null })
  } catch (e) { next(e) }
})
```

- [ ] **Step 3: tsc，提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

```bash
git add apps/server/src/services/delivery/orchestrator.ts apps/server/src/routes/admin/delivery.ts
git commit -m "feat(admin/delivery): 预约单接单不重算送达、已备好端点、立即呼叫 force 与呼叫来源 callOrigin"
```

---

### Task 6: 定时任务（五条新任务 + 现有任务排除预约单 + 重复播报锚点）

**Files:**
- Create: `apps/server/src/services/delivery/schedule-tasks.ts`
- Modify: `apps/server/src/services/delivery/tasks.ts`（`remindLocalUncalled`、`autoRejectStaleCancelRequests`、`autoCallRiders` 三处 where）
- Modify: `apps/server/src/services/scheduler.ts`（`remindUnacceptedOrders` where；注册五条任务）
- Modify: `apps/server/src/services/ticket/index.ts`（`repeatAnnounce` 的锚点；本 Task 只改这一处，票种在 Task 7）
- Modify: `apps/server/src/services/order-notify.ts`（`notifyLocalDeliveryAlert` 加 `windowMs`；新 `notifyScheduledAcceptReminder`）

**Interfaces:**
- Produces：`printPrepTickets()`、`remindScheduledUnaccepted(afterMin?)`、`remindScheduledNotReady()`、`autoCallScheduled()`、`remindScheduledLate(graceMin?)`；scheduler 键 `schedPrepTicket / schedUnaccepted / schedNotReady / schedAutoCall / schedLate`。
- Consumes：Task 5 的 `callRider({ origin })`、Task 7 的票种 `PREP` / `READY_DUE`（本 Task 先以字符串字面量调用，Task 7 把类型补齐；Task 6 结束时 `tsc` 会因 `PrintJobKind` 不含新值而报错——**先做 Task 7 Step 1 的一行类型改动再跑 tsc**）。

- [ ] **Step 1: `order-notify.ts` 两处**

`notifyLocalDeliveryAlert` 签名与限频改为：
```ts
export function notifyLocalDeliveryAlert(title: string, lines: string[], opts: { key?: string; windowMs?: number } = {}): void {
  …
  if (opts.key) {
    const { send, suppressed } = shouldSendAlert(opts.key, opts.windowMs)
```
文件末尾加：
```ts
/** 预约单到「接单截止」仍未接单的催单（schedule-tasks）。文案带送达时段，与立即单的「超过 15 分钟」区分 */
export function notifyScheduledAcceptReminder(
  orders: { orderNo: string; actualAmount: number; receiverName: string; receiverPhone: string; slotLabel: string }[]
): void {
  const wecom = process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!wecom && !pushplusToken) return
  const lines = orders.slice(0, 10).map((o) => `- ${o.orderNo} ¥${fmtYuan(o.actualAmount)} 尾号${o.receiverPhone.slice(-4)}（${o.slotLabel} 送达）`)
  const content = [`**📅 ${orders.length} 张预约单已到接单截止仍未接单**`, ...lines, orders.length > 10 ? `…其余 ${orders.length - 10} 单` : '', '请立即到工作台接单，备餐票已出/即将出'].filter(Boolean).join('\n')
  if (wecom) sendWecomMarkdown(wecom, content)
  if (pushplusToken) sendPushPlus(pushplusToken, `${orders.length} 张预约单待接单`, content, process.env.ORDER_NOTIFY_PUSHPLUS_TOPIC)
}
```

- [ ] **Step 2: 写 `services/delivery/schedule-tasks.ts`**

```ts
/**
 * 预约送达的五条定时任务（spec 2026-09-21-scheduled-delivery-design §4.7）。全部只扫 deliveryType=LOCAL 且
 * scheduledAt 非空；四个时刻每轮按**当时**设置重算（scheduleTimeline），店主改参数已付款的单立刻跟着动。
 * 打标范式与 delivery/tasks.ts 相同：先 updateMany 打标、count=1 才动作，并发双 tick 不会重复打扰。
 * 所有阈值都由时段倒推给出，没有 override 键；e2e 用 SQL 改 scheduled_at 把时刻推到当下（§69）。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { getLocalSettings, LocalDeliverySettings } from '../local-settings'
import { scheduleTimeline, ScheduleTimeline } from './schedule'
import { slotLabel, hhmmOf } from '../slots'
import { callRider, getActiveDelivery } from './orchestrator'
import { isCircuitTripped } from './circuit'
import { enqueueOrderTicket } from '../ticket'
import { notifyLocalDeliveryAlert, notifyScheduledAcceptReminder } from '../order-notify'
import { ACCEPT_REMIND_AFTER_MIN } from '../../utils/constants'

const BATCH = 100
const MIN = 60_000
const SEL = {
  id: true, orderNo: true, status: true, scheduledAt: true, distanceM: true, readyAt: true, prepTicketAt: true,
  scheduleRemindedAt: true, acceptRemindedAt: true, cancelRequestedAt: true, paidAt: true,
  receiverName: true, receiverPhone: true, actualAmount: true,
} satisfies Prisma.OrderSelect
type Row = Prisma.OrderGetPayload<{ select: typeof SEL }>

async function loadScheduled(statuses: string[], extra: Prisma.OrderWhereInput = {}): Promise<Row[]> {
  return prisma.order.findMany({
    where: { deliveryType: 'LOCAL', scheduledAt: { not: null }, status: { in: statuses }, ...extra },
    select: SEL, take: BATCH, orderBy: { scheduledAt: 'asc' },
  })
}
function tlOf(s: LocalDeliverySettings, o: Row): ScheduleTimeline | null {
  return o.scheduledAt && o.distanceM !== null ? scheduleTimeline(s, o.scheduledAt, o.distanceM) : null
}
const tail = (o: Row) => `订单 ${o.orderNo} · 尾号${o.receiverPhone.slice(-4)}`

/** ticketAt 到了 → 备餐票 + 企微「该开始备餐了」，每单一次（prepTicketAt 打标） */
export async function printPrepTickets(): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  let n = 0
  for (const o of await loadScheduled(['PAID', 'PREPARING'], { prepTicketAt: null })) {
    const tl = tlOf(s, o)
    if (!tl || now < tl.ticketAt.getTime()) continue
    const marked = await prisma.order.updateMany({ where: { id: o.id, prepTicketAt: null }, data: { prepTicketAt: new Date() } })
    if (marked.count === 0) continue
    n++
    enqueueOrderTicket(o.id, 'PREP').catch((e) => console.error('[schedule-tasks] 备餐票入队失败:', (e as Error).message))
    notifyLocalDeliveryAlert('预约单该开始备餐了', [
      tail(o),
      `${hhmmOf(tl.prepStartAt)} 开始备餐 · ${hhmmOf(tl.callAt)} 前备好 · ${slotLabel(tl.scheduledAt, s.schedule.slotMinutes)} 送达`,
      o.status === 'PAID' ? '该单尚未接单，请先接单' : '做好后在工作台点「已备好」',
    ])
  }
  return n
}

/** acceptDueAt（且付款 ≥ afterMin）仍 PAID → 企微催单一次（acceptRemindedAt 打标） */
export async function remindScheduledUnaccepted(afterMin = ACCEPT_REMIND_AFTER_MIN): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  const rows = await loadScheduled(['PAID'], { acceptRemindedAt: null, paidAt: { not: null } })
  const due = rows.filter((o) => { const tl = tlOf(s, o); return !!tl && now >= Math.max(o.paidAt!.getTime() + afterMin * MIN, tl.acceptDueAt.getTime()) })
  if (due.length === 0) return 0
  await prisma.order.updateMany({ where: { id: { in: due.map((o) => o.id) }, acceptRemindedAt: null }, data: { acceptRemindedAt: new Date() } })
  notifyScheduledAcceptReminder(due.map((o) => ({ orderNo: o.orderNo, actualAmount: o.actualAmount, receiverName: o.receiverName, receiverPhone: o.receiverPhone, slotLabel: slotLabel(o.scheduledAt!, s.schedule.slotMinutes) })))
  return due.length
}

/**
 * callAt 到了仍未点「已备好」→ 首次：企微 + READY_DUE 小条；之后每 readyRemindEveryMin 一张；
 * callAt + every×max 之后不再出小条，告警一次（计划差异④：按时间封顶，不数 PrintJob）。
 * scheduleRemindedAt = 上次动作时刻；耗尽告警发过的判据是「上次时刻 ≥ 耗尽点」。
 */
export async function remindScheduledNotReady(): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  const every = s.schedule.readyRemindEveryMin * MIN
  const exhaustAfter = every * s.schedule.readyRemindMaxTimes
  let n = 0
  for (const o of await loadScheduled(['PREPARING'], { readyAt: null })) {
    const tl = tlOf(s, o)
    if (!tl || now < tl.callAt.getTime()) continue
    if (await getActiveDelivery(o.id)) continue
    const last = o.scheduleRemindedAt?.getTime() ?? null
    const exhaustAt = tl.callAt.getTime() + exhaustAfter
    if (now >= exhaustAt) {
      if (last !== null && last >= exhaustAt) continue
      const marked = await prisma.order.updateMany({ where: { id: o.id, readyAt: null, scheduleRemindedAt: o.scheduleRemindedAt }, data: { scheduleRemindedAt: new Date() } })
      if (marked.count === 0) continue
      n++
      notifyLocalDeliveryAlert('预约单迟迟未备好', [tail(o), `应于 ${hhmmOf(tl.callAt)} 前备好，已过 ${Math.round((now - tl.callAt.getTime()) / MIN)} 分钟，小条提醒已停`, '请立即处理：点「已备好」/「立即呼叫」/「自己送」'], { key: `sched-exhaust:${o.id}` })
      continue
    }
    if (last !== null && now - last < every) continue
    const marked = await prisma.order.updateMany({ where: { id: o.id, readyAt: null, scheduleRemindedAt: o.scheduleRemindedAt }, data: { scheduleRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    // 第几次提醒 = 该单已有的 READY_DUE 作业数 + 1（只做票面文案与去重 seq；打印机关着时恒为 1，无副作用）
    const seq = (await prisma.printJob.count({ where: { orderId: o.id, kind: 'READY_DUE' } })) + 1
    enqueueOrderTicket(o.id, 'READY_DUE', { seq }).catch((e) => console.error('[schedule-tasks] 催备好小条入队失败:', (e as Error).message))
    if (last === null) notifyLocalDeliveryAlert('预约单应已备好未确认', [tail(o), `应于 ${hhmmOf(tl.callAt)} 前备好 · ${slotLabel(tl.scheduledAt, s.schedule.slotMinutes)} 送达`, '请到工作台点「已备好」或「立即呼叫」'])
  }
  return n
}

/** 已备好且 callAt 到了 → 自动呼叫（SCHEDULED_AUTO）。熔断/未开通不呼；有取消申请的单交给店员 */
export async function autoCallScheduled(): Promise<number> {
  const s = await getLocalSettings()
  if (!s.enabled || isCircuitTripped()) return 0
  const now = Date.now()
  let n = 0
  for (const o of await loadScheduled(['PREPARING'], { readyAt: { not: null }, cancelRequestedAt: null })) {
    const tl = tlOf(s, o)
    if (!tl || now < tl.callAt.getTime()) continue
    if (await getActiveDelivery(o.id)) continue
    try { await callRider({ orderId: o.id, operator: 'scheduler', source: 'SCHEDULER', origin: 'SCHEDULED_AUTO' }); n++ }
    catch (e) { console.warn('[autoCallScheduled] 呼叫订单', o.id, '失败，跳过:', (e as Error)?.message ?? e) }
  }
  return n
}

/** 过了约定送达 + graceMin 骑手还没取餐 → 企微告警，限频 60 分钟一次（计划差异⑤） */
export async function remindScheduledLate(graceMin = 10): Promise<number> {
  const s = await getLocalSettings()
  const now = Date.now()
  let n = 0
  for (const o of await loadScheduled(['PAID', 'PREPARING', 'SHIPPED'], { scheduledAt: { lt: new Date(now - graceMin * MIN) } })) {
    const d = await prisma.delivery.findFirst({ where: { activeOrderId: o.id }, select: { status: true, pickedUpAt: true } })
    if (d?.pickedUpAt) continue
    n++
    notifyLocalDeliveryAlert('预约单已超约定送达时间', [
      tail(o),
      `约定 ${slotLabel(o.scheduledAt!, s.schedule.slotMinutes)}，已晚 ${Math.round((now - o.scheduledAt!.getTime()) / MIN)} 分钟`,
      o.status === 'PAID' ? '尚未接单' : d ? `配送单 ${d.status}` : o.readyAt ? '已备好，未发出呼叫' : '未备好、未呼叫骑手',
    ], { key: `sched-late:${o.id}`, windowMs: 60 * MIN })
  }
  return n
}
```

- [ ] **Step 3: 现有任务排除预约单**

`tasks.ts`：
- `remindLocalUncalled` 的 where 加 `scheduledAt: null,`（预约单由 `remindScheduledNotReady` 覆盖，计划差异③）。
- `autoCallRiders` 的 where 加 `scheduledAt: null,`。
- `autoRejectStaleCancelRequests` 的 `OR[0]` 改成 `{ deliveryType: 'LOCAL', scheduledAt: null, acceptedAt: { lt: ago(localThreshold) } }`。

`scheduler.ts`：`remindUnacceptedOrders` 的 where 加 `scheduledAt: null,`；import 五个函数并在 `pickupAutoComplete` 之后注册：
```ts
    // 预约送达五任务（spec 2026-09-21 §4.7）：阈值全由时段倒推，无 override 键
    ['schedPrepTicket', printPrepTickets],
    ['schedUnaccepted', () => remindScheduledUnaccepted(overrides.remindAfterMin)],
    ['schedNotReady', remindScheduledNotReady],
    ['schedAutoCall', autoCallScheduled],
    ['schedLate', remindScheduledLate],
```

- [ ] **Step 4: `repeatAnnounce` 锚点**（`ticket/index.ts`）

候选 select 加 `scheduledAt: true, distanceM: true`；import `scheduleTimeline`。自取那段 `if (order.deliveryType === 'PICKUP' && localSettings) {…}` 之后加：
```ts
    // 预约外送：接单截止之前不催也不推进计数（明天中午送的单今晚不该响）；之后按普通节奏，
    // 等待时长从接单截止起算，而不是从付款起算（否则票上会印「已等待 600 分钟」）
    let anchor = order.paidAt.getTime()
    if (order.deliveryType === 'LOCAL' && order.scheduledAt && localSettings) {
      if (order.distanceM === null) continue
      const due = scheduleTimeline(localSettings, order.scheduledAt, order.distanceM).acceptDueAt.getTime()
      if (now < due) continue
      anchor = Math.max(anchor, due - settings.repeat.localAfterMin * 60_000)
    }
```
并把下面 `const waitedMs = now - order.paidAt.getTime()` 改成 `const waitedMs = now - anchor`。（`afterMin` 的取值行在它后面，`settings.repeat.localAfterMin` 在这里直接读即可。）

- [ ] **Step 5: 先做 Task 7 Step 1（`PrintJobKind` 加两值），再 tsc，提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

```bash
git add apps/server/src/services/delivery/schedule-tasks.ts apps/server/src/services/delivery/tasks.ts apps/server/src/services/scheduler.ts apps/server/src/services/ticket/index.ts apps/server/src/services/ticket/printer.ts apps/server/src/services/order-notify.ts
git commit -m "feat(scheduler): 预约送达五条任务（备餐票/催单/催备好/到点自动呼叫/超时告警）；现有任务排除预约单；重复播报锚在接单截止"
```

---

### Task 7: 小票（来单票预约版式、备餐票、催备好小条）

**Files:**
- Modify: `apps/server/src/services/ticket/printer.ts`（`PrintJobKind`）
- Modify: `apps/server/src/services/ticket/content.ts`（`TicketOrderInput`、`renderOrderTicket`、新 `renderReadyDueTicket`）
- Modify: `apps/server/src/services/ticket/index.ts`（`OrderForTicket`、`ORDER_SELECT`、`toTicketInput`、`renderForKind`、`enqueueOrderTicket` 的 seq 与 schedule 计算）

**Interfaces:**
- Produces：`PrintJobKind` 含 `'PREP' | 'READY_DUE'`；`enqueueOrderTicket(id, 'PREP')` 去重 seq=0；`enqueueOrderTicket(id, 'READY_DUE', { seq })`。
- 票面：来单票票头「预约配送」+ 戳「明日单」+ `<B>送达 …</B>` + 「开始备餐 HH:mm · 呼叫骑手 HH:mm」；备餐票票头「开始备餐」+ `<B>HH:mm 开始备餐 · HH:mm 前备好</B>` + 未接单时 `[未接单]`；厨房联多一行 `<B>送达 …</B>`。

- [ ] **Step 1: `printer.ts`**

```ts
export type PrintJobKind = 'NEW_ORDER' | 'REPEAT' | 'CANCEL' | 'REPRINT' | 'TEST' | 'CANCEL_REQUEST' | 'RESUME' | 'PREP' | 'READY_DUE'
```

- [ ] **Step 2: `content.ts` 输入类型**（`TicketOrderInput` 里 `announceNo` 之前）

```ts
  // ── 预约送达（channel==='LOCAL' 且 scheduledAt 非空；2026-09-21）──
  scheduledAt?: Date | null
  /** 「9月22日（周二）12:00–12:30」，调用方用 slots.ticketLabel 算好传进来（本文件不算时区） */
  scheduleSlotLabel?: string | null
  /** 票头戳：'' 今天送（不盖）/ '明日单' / '9月22日单' */
  scheduleDayStamp?: string | null
  /** 'HH:mm'：开始备餐 / 该呼叫，来自 scheduleTimeline */
  schedulePrepStart?: string | null
  scheduleCall?: string | null
  /** PREP 备餐票：非空即按备餐票排版（票头「开始备餐」+ 时刻行 + 未接单警示）。NEW_ORDER 不传 */
  prep?: { unaccepted: boolean } | null
```

- [ ] **Step 3: `renderOrderTicket` 三处**

`const isPickup = …` 之后加 `const isScheduled = isLocal && !!o.scheduledAt`。

`header` 数组的第一项与自取戳之间改成：
```ts
    o.prep ? '<CB>开始备餐</CB>' : `<CB>${isPickup ? '到店自取' : isScheduled ? '预约配送' : isLocal ? '同城配送' : '全国邮寄'}</CB>`,
    // 备餐票：第一行就是操作指令；[未接单] 提醒店员先接单
    ...(o.prep ? [`<B>${esc(o.schedulePrepStart ?? '')} 开始备餐 · ${esc(o.scheduleCall ?? '')} 前备好</B>`, ...(o.prep.unaccepted ? ['<CB>[未接单]</CB>'] : [])] : []),
    // 来单票：非今日送达盖戳（同自取），备餐票不盖——它就是当天出的
    ...(isScheduled && !o.prep && o.scheduleDayStamp ? [`<CB>【${esc(o.scheduleDayStamp)}】</CB>`] : []),
```

`receiverBlock` 的 `isLocal` 分支里，把 `...(o.estimatedDeliveryAt ? [\`预计送达：…\`] : [])` 换成：
```ts
          ...(isScheduled
            ? [`<B>送达 ${esc(o.scheduleSlotLabel ?? '')}</B>`, `开始备餐 ${esc(o.schedulePrepStart ?? '')} · 呼叫骑手 ${esc(o.scheduleCall ?? '')}`]
            : o.estimatedDeliveryAt ? [`预计送达：${fmtDateTime(o.estimatedDeliveryAt)}`] : []),
```

`buildKitchen` 的 `\`<CB>尾号…</CB>\`` 之后加：
```ts
      ...(isScheduled ? [`<B>送达 ${esc(o.scheduleSlotLabel ?? '')}</B>`] : []),
```

- [ ] **Step 4: 新 `renderReadyDueTicket`**（放在 `renderReminderTicket` 之后）

```ts
/** 预约单「应备好未备好」催促小条（PO 2026-09-21 S7）。语音款硬件靠出票触发播报，所以它是一张精简票 */
export function renderReadyDueTicket(input: { receiverPhone: string; slotLabel: string; call: string; seq: number }): string {
  return assemble([
    '<CB>预约单催备好</CB>',
    `<CB>尾号${input.receiverPhone.slice(-4)}</CB>`,
    `<B>应于 ${esc(input.call)} 前备好</B>`,
    `送达 ${esc(input.slotLabel)}`,
    `第 ${input.seq} 次提醒`,
    '请到工作台点「已备好」或「立即呼叫」',
  ])
}
```

- [ ] **Step 5: `ticket/index.ts`**

import 加 `scheduleTimeline`（`./../delivery/schedule`）、`ticketLabel, hhmmOf`（`../slots`）、`renderReadyDueTicket`。

`OrderForTicket` 加 `status: string; scheduledAt: Date | null`；`ORDER_SELECT` 加 `status: true, scheduledAt: true`。

```ts
type ScheduleForTicket = { slotLabel: string; stamp: string; prepStart: string; call: string; unaccepted: boolean } | null
```
`toTicketInput(order, slotMinutes, schedule: ScheduleForTicket = null)` 返回对象加：
```ts
    scheduledAt: order.scheduledAt,
    scheduleSlotLabel: schedule?.slotLabel ?? null,
    scheduleDayStamp: schedule?.stamp ?? null,
    schedulePrepStart: schedule?.prepStart ?? null,
    scheduleCall: schedule?.call ?? null,
```
`renderForKind(kind, order, settings, announceNo, slotMinutes, waitedMin?, schedule: ScheduleForTicket = null)`：在 `if (kind === 'REPEAT' && !settings.repeat.reprint)` 之前加：
```ts
  if (kind === 'READY_DUE') {
    return renderReadyDueTicket({ receiverPhone: order.receiverPhone, slotLabel: schedule?.slotLabel ?? '', call: schedule?.call ?? '', seq: announceNo })
  }
```
末尾改为：
```ts
  const input = toTicketInput(order, slotMinutes, schedule)
  if (kind === 'REPEAT') input.announceNo = announceNo
  if (kind === 'PREP') input.prep = { unaccepted: schedule?.unaccepted ?? order.status === 'PAID' }
  return renderOrderTicket(input)
```
`enqueueOrderTicket` 里：
```ts
  const baseSeq = opts.seq ?? (kind === 'NEW_ORDER' || kind === 'CANCEL' || kind === 'PREP' ? 0 : Date.now())
  const localS = await getLocalSettings()
  const slotMinutes = localS.pickup.slotMinutes
  // 预约单：三种票都要印倒推时刻，在这里算一次传下去（content.ts 不算时区）
  const schedule: ScheduleForTicket = order.deliveryType === 'LOCAL' && order.scheduledAt && order.distanceM !== null
    ? (() => {
        const tl = scheduleTimeline(localS, order.scheduledAt, order.distanceM)
        const lb = ticketLabel(order.scheduledAt, localS.schedule.slotMinutes)
        return { slotLabel: lb.text, stamp: lb.stamp, prepStart: hhmmOf(tl.prepStartAt), call: hhmmOf(tl.callAt), unaccepted: order.status === 'PAID' }
      })()
    : null
```
两处 `renderForKind(kind, order, settings, baseSeq, slotMinutes, opts.waitedMin)` 都加末参 `schedule`。

- [ ] **Step 6: tsc，提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

```bash
git add apps/server/src/services/ticket
git commit -m "feat(ticket): 预约单来单票版式、PREP 备餐票、READY_DUE 催备好小条"
```

---

### Task 8: 来单推送、工作台快照、管理端列表/详情、微信回调

**Files:**
- Modify: `apps/server/src/services/order-notify.ts`（`NotifyOrderInfo.scheduleSlotLabel`、`buildContent` 标题）
- Modify: `apps/server/src/routes/wechat-notify.ts`（真实支付回调路径传 `scheduleSlotLabel`）
- Modify: `apps/server/src/routes/admin/workbench.ts`
- Modify: `apps/server/src/routes/admin/orders.ts`

**Interfaces:**
- Produces：快照 `columns.scheduled[]`（新列，WAITING 阶段的预约单）、卡片 `local.schedule`（`scheduleView` 返回）、顶层 `scheduleEnabled`、`scheduleBar: { orderId, prepStartAt, slotLabel, count } | null`；`GET /admin/orders?schedule=SCHEDULED|ASAP`；管理端详情 `schedule` 节；来单推送标题「📅 同城预约单 · 明天 12:00–12:30 送达」。

- [ ] **Step 1: `order-notify.ts`**

`NotifyOrderInfo` 加 `scheduleSlotLabel?: string | null`。`buildContent` 的标题行改成：
```ts
    order.deliveryType === 'PICKUP' ? `**🏪 自取新订单${order.pickupSlotLabel ? ` · ${order.pickupSlotLabel} 取` : ''}**`
      : order.deliveryType === 'LOCAL' ? (order.scheduleSlotLabel ? `**📅 同城预约单 · ${order.scheduleSlotLabel} 送达**` : `**🛵 同城新订单**`)
      : `**🔔 新订单待发货**`,
```

- [ ] **Step 2: `wechat-notify.ts`**（自取 `slotLabel` 那段之后）

```ts
          let scheduleSlotLabel: string | undefined
          if (paid.deliveryType === 'LOCAL' && paid.scheduledAt) {
            try { scheduleSlotLabel = slotLabel(paid.scheduledAt, (await getLocalSettings()).schedule.slotMinutes) }
            catch (err) { console.error('[wechat-notify] 计算预约时段文案失败:', (err as Error).message) }
          }
```
`notifyOrderPaid({...})` 里加 `scheduleSlotLabel,`；import `slotLabel`（`../services/slots`）。若该路由查订单用了 select，补 `scheduledAt: true`。

- [ ] **Step 3: `workbench.ts`**

import：`import { scheduleView } from '../../services/delivery/schedule'`；`slotLabel` 不需要（view 已带）。

`toCard` 签名加末参 `sc: ReturnType<typeof scheduleView> = null`，`local` 节加 `schedule: sc,`。

快照循环：
```ts
    const now = new Date()
    for (const o of orders) {
      const pk = …（不变）
      const d = byOrder.get(o.id) ?? null
      const sc = o.deliveryType === 'LOCAL' && o.scheduledAt ? scheduleView(settings, o, now, !!d?.pickedUpAt) : null
      // 预约单出票之前收进折叠分组，不进五列（spec §6.1 WAITING）
      if (sc?.phase === 'WAITING' && (o.status === 'PAID' || o.status === 'PREPARING') && !d) { cols.scheduled.push(toCard(o, o.paidAt, d, null, null, sc)); continue }
      if (o.status === 'PAID') cols.pending.push(toCard(o, o.paidAt, d, bookingByOrder.get(o.id) ?? null, pk, sc))
      else if (o.status === 'PREPARING') {
        const b = bookingByOrder.get(o.id) ?? null
        if (o.deliveryType === 'LOCAL' && d && WAITING_STATUSES.includes(d.status)) cols.waitingCourier.push(toCard(o, d.calledAt, d, null, null, sc))
        else if (o.deliveryType === 'EXPRESS' && b && b.activeOrderId === o.id) cols.waitingCourier.push(toCard(o, b.bookedAt ?? b.createdAt, null, b, null))
        else cols.preparing.push(toCard(o, o.acceptedAt, d, b, pk, sc))
      }
      else if (o.status === 'SHIPPED') cols.delivering.push(toCard(o, d?.pickedUpAt ?? o.shipment?.shippedAt ?? o.acceptedAt, d, bookingByOrder.get(o.id) ?? null, pk, sc))
      else if (o.status === 'COMPLETED') cols.done.push(toCard(o, o.completedAt, d, bookingByOrder.get(o.id) ?? null, pk, sc))
    }
```
`cols` 初始化加 `scheduled: []`；排序循环的 key 列表加 `'scheduled'`。

`sortColumn` 改成（同渠道内预约单按 prepStartAt 升序排在立即单之前，spec §6.1）：
```ts
type SortableCard = { channel: string; waitSince: string; local?: { schedule?: { prepStartAt: string } | null } | null }
function sortColumn(cards: SortableCard[], newestFirst = false) {
  cards.sort((a, b) => {
    if (a.channel !== b.channel) return (CHANNEL_RANK[a.channel] ?? 9) - (CHANNEL_RANK[b.channel] ?? 9)
    const sa = a.local?.schedule?.prepStartAt ?? null, sb = b.local?.schedule?.prepStartAt ?? null
    if (sa && sb) return sa.localeCompare(sb)
    if (sa !== sb) return sa ? -1 : 1
    return newestFirst ? b.waitSince.localeCompare(a.waitSince) : a.waitSince.localeCompare(b.waitSince)
  })
}
```
（调用处的 `as never` 改成 `as SortableCard[]`。）

`data` 加：
```ts
      scheduleEnabled: settings.schedule.enabled,
      // 常驻倒计时条：WAITING/TICKETED 里 prepStartAt 最近的一张 + 总数（spec §6.1）
      scheduleBar: (() => {
        const all = [...cols.scheduled, ...cols.pending, ...cols.preparing]
          .map((c) => c as unknown as { orderId: number; local: { schedule: { prepStartAt: string; slotLabel: string; phase: string } | null } | null })
          .filter((c) => c.local?.schedule && (c.local.schedule.phase === 'WAITING' || c.local.schedule.phase === 'TICKETED'))
          .sort((a, b) => a.local!.schedule!.prepStartAt.localeCompare(b.local!.schedule!.prepStartAt))
        return all.length ? { orderId: all[0].orderId, prepStartAt: all[0].local!.schedule!.prepStartAt, slotLabel: all[0].local!.schedule!.slotLabel, count: all.length } : null
      })(),
```

- [ ] **Step 4: `routes/admin/orders.ts`**

列表 select（`pickupAt: true` 附近）加 `scheduledAt: true, readyAt: true, prepTicketAt: true`。列表 where：
```ts
    // 预约 / 尽快筛选（2026-09-21）；不传不过滤
    const sc = req.query.schedule ? z.enum(['SCHEDULED', 'ASAP']).parse(req.query.schedule) : undefined
    const scWhere: Prisma.OrderWhereInput = sc === 'SCHEDULED' ? { scheduledAt: { not: null } } : sc === 'ASAP' ? { scheduledAt: null } : {}
```
并把 `scWhere` 展开进最终 `where`。详情 `success(res, { ...order, coupon, … })` 加：
```ts
      schedule: order.deliveryType === 'LOCAL' && order.scheduledAt ? scheduleView(await getLocalSettings(), order, new Date()) : null,
```
（详情查询若用 select，补 `scheduledAt / readyAt / distanceM`；import `scheduleView`、`getLocalSettings`。）

- [ ] **Step 5: tsc，提交**

Run: `cd apps/server && npx tsc --noEmit`
Expected: 零错误。

```bash
git add apps/server/src/services/order-notify.ts apps/server/src/routes/wechat-notify.ts apps/server/src/routes/admin/workbench.ts apps/server/src/routes/admin/orders.ts
git commit -m "feat(admin): 工作台预约单折叠列/phase/倒计时条与排序；订单列表预约筛选；来单推送带送达时段"
```

---

### Task 9: e2e §69 + §62 断言同步

**Files:**
- Create: `scripts/e2e.d/69-scheduled-delivery.sh`
- Modify: `scripts/e2e.d/62-pickup.sh`（⑥⑦ 两处断言改为两小时口径）

**Interfaces:**
- Consumes：`scripts/e2e.sh` 的 `req/code/ok/fail/assert_eq/sched/sql/PJOBS/snap/col_has/lquote/mk_local_paid`，`$UT/$AT/$LPID/$LADDR`。变量一律 `S69_` 前缀。

- [ ] **Step 1: §62 两处改口径**

⑥：`assert_eq "付款后、开始备餐前自助取消 code 0"` 那一单（`P62_O2`，取餐格在 25 分钟后）**已在两小时内** → 期望改为 `42229`；紧接着加一行把它钉远再退：
```bash
R=$(req PUT "/api/orders/$P62_O2/cancel" "$UT")
assert_eq "付款后、距取餐不足两小时自助取消 42229（2026-09-21 起）" "$(code "$R")" "42229"
sql "UPDATE orders SET pickup_at=DATE_ADD(NOW(3), INTERVAL 3 HOUR) WHERE id=$P62_O2;"
R=$(req PUT "/api/orders/$P62_O2/cancel" "$UT")
assert_eq "钉到 3 小时后：自助取消 code 0" "$(code "$R")" "0"
assert_eq "O2 → REFUNDED（mock 即时）" "$(p62_ord "$P62_O2" | jq -r .data.status)" "REFUNDED"
```
⑦：`sql "UPDATE orders SET pickup_at=DATE_SUB(NOW(3), INTERVAL 1 MINUTE)…"` 与其后三条断言保持（过去的取餐时刻当然在两小时内）；文案断言若比对「已进入备餐时段」改为比对码值即可。

- [ ] **Step 2: 写 `scripts/e2e.d/69-scheduled-delivery.sh`**

```bash
echo "== 69. 同城预约送达：设置 / 时段 / 下单 / 取消窗口 / 已备好与呼叫 / 定时任务 / 小票 / 工作台 =="
# 复用 e2e.sh 的 req/code/ok/fail/assert_eq/sched/sql/PJOBS/snap/lquote/mk_local_paid；$UT/$AT/$LPID/$LADDR。变量一律 S69_ 前缀。
# 时段看真实时钟：营业时段钉成 00:00–23:59、daysAhead=1，任何时刻至少明天有格。
# 时刻推进不靠 override 键，靠 SQL 改 scheduled_at；偏移量从详情 schedule 节反推（s69_pin），不手算路上时间。
S69_ORIG=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data)
s69_put() { local cur; cur=$(req GET /api/admin/settings/local-delivery "$AT" | jq -c .data); req PUT /api/admin/settings/local-delivery "$AT" "$(jq -c "$1" <<<"$cur")"; }
s69_ord() { req GET "/api/admin/orders/$1" "$AT"; }
s69_det() { req GET "/api/orders/$1" "$UT"; }
s69_sc() { s69_det "$1" | jq -c '.data.schedule'; }
# s69_pin orderId field offsetMin：把 scheduled_at 钉到「让 <field> = now + offsetMin」
s69_pin() {
  local diff
  diff=$(s69_sc "$1" | jq -r --arg f "$2" '((.scheduledAt|sub("\\.[0-9]+Z$";"Z")|fromdate) - (.[$f]|sub("\\.[0-9]+Z$";"Z")|fromdate)) / 60 | floor')
  sql "UPDATE orders SET scheduled_at=DATE_ADD(NOW(3), INTERVAL $((diff + $3)) MINUTE) WHERE id=$1;"
}
# s69_new slotIndex → echo orderId（已付款）；空串 = 失败（已记 fail）
s69_new() {
  local slot r oid
  lquote "$LADDR" 2400
  slot=$(req GET "/api/local/delivery-slots?distanceM=$LQDIST" | jq -r "[.data.days[].slots[]][$1].startAt")
  [[ -n "$slot" && "$slot" != "null" ]] || { fail "s69_new 没拿到第 $1 格"; echo ""; return; }
  r=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":2},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"$slot\"}")
  oid=$(jq -r '.data.orderId // empty' <<<"$r"); [[ -n "$oid" ]] || { fail "s69_new 下单失败" "$r"; echo ""; return; }
  req POST "/api/orders/$oid/pay" "$UT" >/dev/null; echo "$oid"
}
S69_IDS=""

echo "-- ① 未开通：时段 blocked=DISABLED，带 scheduledAt 下单 42290，非 LOCAL 带 scheduledAt 40001 --"
s69_put '.schedule.enabled=false | .enabled=true | .paused=null | .holiday=null | .businessHours=[{start:"00:00",end:"23:59"}] | .peak.windows=[]' >/dev/null
lquote "$LADDR" 2400
assert_eq "未开通 blocked=DISABLED" "$(req GET "/api/local/delivery-slots?distanceM=$LQDIST" | jq -r '.data.blocked.kind')" "DISABLED"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"2030-01-01T04:00:00.000Z\"}")
assert_eq "未开通带 scheduledAt 下单 42290" "$(code "$R")" "42290"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"deliveryType\":\"PICKUP\",\"pickupAt\":\"2030-01-01T04:00:00.000Z\",\"pickupContact\":{\"phone\":\"13800001234\"},\"scheduledAt\":\"2030-01-01T04:00:00.000Z\"}")
assert_eq "非 LOCAL 带 scheduledAt 40001" "$(code "$R")" "40001"

echo "-- ② 开通：时段有格、meta 字段、距离缺参 40001 --"
R=$(s69_put '.schedule={enabled:true,slotMinutes:30,daysAhead:1,acceptBufferMin:5,prepMinutes:20,prepTicketLeadMin:15,readyRemindEveryMin:3,readyRemindMaxTimes:3,callToleranceMin:5} | .selfCancelLeadMin=120 | .prepMinutes=20 | .autoCallDelayMin=0')
assert_eq "开通预约 code 0" "$(code "$R")" "0"
R=$(req GET "/api/local/delivery-slots?distanceM=$LQDIST")
assert_eq "时段 blocked=null" "$(jq -r '.data.blocked' <<<"$R")" "null"
S69_SLOT0=$(jq -r '[.data.days[].slots[]][0].startAt' <<<"$R")
[[ -n "$S69_SLOT0" && "$S69_SLOT0" != "null" ]] && ok "拿到最早格 $S69_SLOT0" || fail "没有可选时段" "$R"
assert_eq "earliestAt = 第一格" "$(jq -r '.data.earliestAt' <<<"$R")" "$S69_SLOT0"
assert_eq "缺 distanceM 40001" "$(code "$(req GET /api/local/delivery-slots)")" "40001"
R=$(req GET /api/local/meta)
assert_eq "meta.delivery.scheduleEnabled=true" "$(jq -r '.data.delivery.scheduleEnabled' <<<"$R")" "true"
assert_eq "meta.delivery.earliestScheduleText 非空" "$(jq -r '.data.delivery.earliestScheduleText | length > 0' <<<"$R")" "true"
assert_eq "meta.delivery.selfCancelLeadMin=120" "$(jq -r '.data.delivery.selfCancelLeadMin' <<<"$R")" "120"
[[ "$(jq -r '.data.enabled' <<<"$R")" == "true" ]] && ok "老字段 enabled 仍在" || fail "老字段 enabled 丢了"

echo "-- ③ 下单：非整格 42291；预约单落库 scheduled_at 且 estimated_delivery_at 等于它；立即单不受影响 --"
lquote "$LADDR" 2400
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\",\"scheduledAt\":\"2030-01-01T04:07:00.000Z\"}")
assert_eq "非整格 42291" "$(code "$R")" "42291"
S69_O1=$(s69_new 2); S69_IDS="$S69_IDS,$S69_O1"
[[ -n "$S69_O1" ]] && ok "预约单 #$S69_O1 已付款" || fail "造预约单失败"
assert_eq "回传 scheduledAt 非空" "$(s69_det "$S69_O1" | jq -r '.data.scheduledAt != null')" "true"
assert_eq "落库 scheduled_at = estimated_delivery_at" "$(sql "SELECT scheduled_at = estimated_delivery_at FROM orders WHERE id=$S69_O1;")" "1"
S69_ASAP=$(mk_local_paid); S69_IDS="$S69_IDS,$S69_ASAP"
[[ -n "$S69_ASAP" ]] && ok "立即单 #$S69_ASAP 照常" || fail "立即单造单失败"
assert_eq "立即单 scheduled_at 为空" "$(sql "SELECT scheduled_at IS NULL FROM orders WHERE id=$S69_ASAP;")" "1"

echo "-- ④ 打烊：营业时段不含现在 → 立即单 42222、预约单 code 0 --"
S69_H=$(TZ=Asia/Shanghai date +%H); S69_H=$((10#$S69_H))
if (( S69_H <= 17 )); then S69_BH="{start:\"$(printf %02d $((S69_H+2))):00\",end:\"$(printf %02d $((S69_H+5))):00\"}"; else S69_BH='{start:"01:00",end:"06:00"}'; fi
s69_put ".businessHours=[$S69_BH]" >/dev/null
lquote "$LADDR" 2400
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$LPID,\"quantity\":1},\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\",\"quoteToken\":\"$LQTOKEN\"}")
assert_eq "打烊立即单 42222" "$(code "$R")" "42222"
S69_O2=$(s69_new 0); S69_IDS="$S69_IDS,$S69_O2"
[[ -n "$S69_O2" ]] && ok "打烊时预约单 #$S69_O2 成功" || fail "打烊时预约单失败"
s69_put '.businessHours=[{start:"00:00",end:"23:59"}]' >/dev/null

echo "-- ⑤ 详情 schedule 节；两小时外秒退；两小时内 42229 转申请取消（PAID 也可申请）--"
R=$(s69_sc "$S69_O2")
for f in scheduledAt callAt prepStartAt acceptDueAt ticketAt selfCancelUntil phase etaIfCallNow; do
  [[ "$(jq -r ".$f // empty" <<<"$R")" != "" ]] && ok "schedule.$f 非空" || fail "schedule.$f 缺失" "$R"
done
s69_pin "$S69_O2" selfCancelUntil 30
assert_eq "两小时外 canSelfCancel=true" "$(s69_det "$S69_O2" | jq -r '.data.canSelfCancel')" "true"
R=$(req PUT "/api/orders/$S69_O2/cancel" "$UT")
assert_eq "两小时外秒退 code 0" "$(code "$R")" "0"
assert_eq "O2 → REFUNDED" "$(s69_ord "$S69_O2" | jq -r .data.status)" "REFUNDED"
s69_pin "$S69_O1" selfCancelUntil -1
assert_eq "两小时内 canSelfCancel=false、canRequestCancel=true" "$(s69_det "$S69_O1" | jq -r '[.data.canSelfCancel,.data.canRequestCancel]|join(",")')" "false,true"
R=$(req PUT "/api/orders/$S69_O1/cancel" "$UT")
assert_eq "两小时内秒退 42229" "$(code "$R")" "42229"
R=$(req POST "/api/orders/$S69_O1/cancel-request" "$UT" '{"note":"改天再订"}')
assert_eq "PAID 预约单申请取消 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/local/orders/$S69_O1/cancel-request/reject" "$AT")
assert_eq "驳回 code 0" "$(code "$R")" "0"

echo "-- ⑥ 接单不重算送达；接单并呼叫 42292；过早呼叫 42292；force 呼叫 → MANUAL_EARLY + ready_at --"
s69_pin "$S69_O1" callAt 60
S69_EST=$(sql "SELECT estimated_delivery_at FROM orders WHERE id=$S69_O1;")
R=$(req POST "/api/admin/local/orders/$S69_O1/accept-and-call" "$AT")
assert_eq "接单并呼叫对预约单 42292" "$(code "$R")" "42292"
R=$(req POST "/api/admin/local/orders/$S69_O1/accept" "$AT")
assert_eq "接单 code 0" "$(code "$R")" "0"
assert_eq "接单不改 estimated_delivery_at" "$(sql "SELECT estimated_delivery_at FROM orders WHERE id=$S69_O1;")" "$S69_EST"
R=$(req POST "/api/admin/local/orders/$S69_O1/call" "$AT")
assert_eq "早于呼叫窗口 42292" "$(code "$R")" "42292"
R=$(req POST "/api/admin/local/orders/$S69_O1/call" "$AT" '{"force":true}')
assert_eq "force 呼叫 code 0" "$(code "$R")" "0"
assert_eq "call_origin=MANUAL_EARLY" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$S69_O1 ORDER BY id DESC LIMIT 1;")" "MANUAL_EARLY"
assert_eq "呼叫即写 ready_at" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$S69_O1;")" "1"
assert_eq "已呼叫后 canRequestCancel=false" "$(s69_det "$S69_O1" | jq -r '.data.canRequestCancel')" "false"
R=$(req PUT "/api/orders/$S69_O1/cancel" "$UT")
assert_eq "已备好/已呼叫后自助取消 42229" "$(code "$R")" "42229"

echo "-- ⑦ 已备好：立即单 42292、PAID 42204；早备好等到点（schedAutoCall），到点自动呼 SCHEDULED_AUTO --"
R=$(req POST "/api/admin/local/orders/$S69_ASAP/ready" "$AT")
assert_eq "立即单点已备好 42292" "$(code "$R")" "42292"
S69_O3=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O3"
R=$(req POST "/api/admin/local/orders/$S69_O3/ready" "$AT")
assert_eq "PAID 点已备好 42204" "$(code "$R")" "42204"
req POST "/api/admin/local/orders/$S69_O3/accept" "$AT" >/dev/null
s69_pin "$S69_O3" callAt 30
R=$(req POST "/api/admin/local/orders/$S69_O3/ready" "$AT")
assert_eq "早备好 code 0 called=false" "$(jq -r '[.code, .data.called]|join(",")' <<<"$R")" "0,false"
assert_eq "ready_at 已写" "$(sql "SELECT ready_at IS NOT NULL FROM orders WHERE id=$S69_O3;")" "1"
assert_eq "phase=READY_WAITING" "$(s69_sc "$S69_O3" | jq -r .phase)" "READY_WAITING"
R=$(sched '{}'); assert_eq "未到点 schedAutoCall=0" "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" "0"
assert_eq "未到点无配送单" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$S69_O3;")" "0"
s69_pin "$S69_O3" callAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedAutoCall // -1' <<<"$R")" -ge 1 ]] && ok "到点 schedAutoCall≥1" || fail "到点没自动呼" "$R"
assert_eq "call_origin=SCHEDULED_AUTO" "$(sql "SELECT call_origin FROM deliveries WHERE order_id=$S69_O3 ORDER BY id DESC LIMIT 1;")" "SCHEDULED_AUTO"
assert_eq "phase=CALLED" "$(s69_sc "$S69_O3" | jq -r .phase)" "CALLED"
R=$(req POST "/api/admin/local/orders/$S69_O3/ready" "$AT")
assert_eq "已有在途单再点已备好 42228" "$(code "$R")" "42228"

echo "-- ⑧ 备餐票：ticketAt 到点出 PREP（只一张）+ 来单票版式；重复播报在 acceptDueAt 前不计数 --"
req PUT /api/admin/settings/printer "$AT" '{"enabled":true,"printers":[{"sn":"S69-P","channels":["LOCAL","EXPRESS"],"copies":1}],"printCancel":true}' >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
S69_O4=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O4"
sleep 0.5
S69_T=$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="NEW_ORDER")] | last | .content')
[[ "$S69_T" == *"预约配送"* ]] && ok "来单票票头 预约配送" || fail "来单票票头不对" "$S69_T"
[[ "$S69_T" == *"<B>送达 "* ]] && ok "来单票印送达时段" || fail "没印送达" "$S69_T"
[[ "$S69_T" == *"开始备餐 "* && "$S69_T" == *"呼叫骑手 "* ]] && ok "来单票印两个倒推时刻" || fail "没印倒推时刻" "$S69_T"
s69_pin "$S69_O4" ticketAt 30
sql "UPDATE orders SET paid_at=DATE_SUB(NOW(3), INTERVAL 60 MINUTE) WHERE id=$S69_O4;"
R=$(sched '{}')
assert_eq "未到出票时刻 schedPrepTicket=0" "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" "0"
assert_eq "接单截止前不重复播报 announce_count=0" "$(sql "SELECT announce_count FROM orders WHERE id=$S69_O4;")" "0"
assert_eq "接单截止前不催单" "$(sql "SELECT accept_reminded_at IS NULL FROM orders WHERE id=$S69_O4;")" "1"
s69_pin "$S69_O4" ticketAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" -ge 1 ]] && ok "到点 schedPrepTicket≥1" || fail "没出备餐票" "$R"
assert_eq "prep_ticket_at 已写" "$(sql "SELECT prep_ticket_at IS NOT NULL FROM orders WHERE id=$S69_O4;")" "1"
sleep 0.5
S69_P=$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="PREP")] | last | .content')
[[ "$S69_P" == *"开始备餐"* && "$S69_P" == *"前备好"* ]] && ok "备餐票版式" || fail "备餐票版式不对" "$S69_P"
[[ "$S69_P" == *"[未接单]"* ]] && ok "未接单警示" || fail "缺未接单警示" "$S69_P"
R=$(sched '{}'); assert_eq "第二轮不重复出备餐票" "$(jq -r '.data.schedPrepTicket // -1' <<<"$R")" "0"
assert_eq "PREP 作业只一张" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="PREP")] | length')" "1"

echo "-- ⑨ 催单锚在接单截止；通用催单不碰预约单 --"
s69_pin "$S69_O4" acceptDueAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedUnaccepted // -1' <<<"$R")" -ge 1 ]] && ok "到接单截止 schedUnaccepted≥1" || fail "没催" "$R"
assert_eq "accept_reminded_at 已写" "$(sql "SELECT accept_reminded_at IS NOT NULL FROM orders WHERE id=$S69_O4;")" "1"
R=$(sched '{}'); assert_eq "第二轮不重复催" "$(jq -r '.data.schedUnaccepted // -1' <<<"$R")" "0"
sched '{}' >/dev/null
[[ "$(sql "SELECT announce_count FROM orders WHERE id=$S69_O4;")" -ge 1 ]] && ok "接单截止后重复播报开始计数" || fail "接单截止后仍未播报"

echo "-- ⑩ 催备好：callAt 到点小条 + 首次企微；间隔内不重复；耗尽后告警一次不再出小条 --"
req POST "/api/admin/local/orders/$S69_O4/accept" "$AT" >/dev/null
s69_pin "$S69_O4" callAt -1
R=$(sched '{}'); [[ "$(jq -r '.data.schedNotReady // -1' <<<"$R")" -ge 1 ]] && ok "到点 schedNotReady≥1" || fail "没催备好" "$R"
assert_eq "schedule_reminded_at 已写" "$(sql "SELECT schedule_reminded_at IS NOT NULL FROM orders WHERE id=$S69_O4;")" "1"
sleep 0.5
assert_eq "READY_DUE 作业 1 张" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | length')" "1"
R=$(sched '{}'); assert_eq "3 分钟内不重复" "$(jq -r '.data.schedNotReady // -1' <<<"$R")" "0"
sql "UPDATE orders SET schedule_reminded_at=DATE_SUB(NOW(3), INTERVAL 4 MINUTE) WHERE id=$S69_O4;"
R=$(sched '{}'); [[ "$(jq -r '.data.schedNotReady // -1' <<<"$R")" -ge 1 ]] && ok "过 3 分钟再出一张" || fail "第二张没出" "$R"
sleep 0.5
assert_eq "READY_DUE 作业 2 张" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | length')" "2"
s69_pin "$S69_O4" callAt -10   # 3×3=9 分钟已耗尽；只退 10 分钟是为了 scheduledAt 仍在未来（不被判 LATE）
sql "UPDATE orders SET schedule_reminded_at=DATE_SUB(NOW(3), INTERVAL 9 MINUTE) WHERE id=$S69_O4;"
R=$(sched '{}'); [[ "$(jq -r '.data.schedNotReady // -1' <<<"$R")" -ge 1 ]] && ok "耗尽告警一次" || fail "耗尽未告警" "$R"
assert_eq "耗尽后不再出小条（仍 2 张）" "$(PJOBS "$S69_O4" | jq -r '[.data.list[] | select(.kind=="READY_DUE")] | length')" "2"
R=$(sched '{}'); assert_eq "耗尽告警不重复" "$(jq -r '.data.schedNotReady // -1' <<<"$R")" "0"
assert_eq "phase=CALL_DUE" "$(s69_sc "$S69_O4" | jq -r .phase)" "CALL_DUE"
R=$(req POST "/api/admin/local/orders/$S69_O4/ready" "$AT")
assert_eq "过点后点已备好立即呼 called=true" "$(jq -r '[.code, .data.called]|join(",")' <<<"$R")" "0,true"

echo "-- ⑪ 超时告警：过约定时刻 11 分钟未取餐 → schedLate≥1 --"
S69_O5=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O5"
req POST "/api/admin/local/orders/$S69_O5/accept" "$AT" >/dev/null
s69_pin "$S69_O5" scheduledAt -11
R=$(sched '{}'); [[ "$(jq -r '.data.schedLate // -1' <<<"$R")" -ge 1 ]] && ok "超时告警 schedLate≥1" || fail "超时未告警" "$R"
assert_eq "phase=LATE" "$(s69_sc "$S69_O5" | jq -r .phase)" "LATE"

echo "-- ⑫ 工作台：WAITING 进 scheduled 列；TICKETED 进 pending；预约单排在立即单前；scheduleBar --"
S69_O6=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O6"
s69_pin "$S69_O6" ticketAt 60
R=$(snap)
assert_eq "WAITING 在 scheduled 列" "$(col_has scheduled "$S69_O6" "$R")" "true"
assert_eq "WAITING 不在 pending 列" "$(col_has pending "$S69_O6" "$R")" "false"
assert_eq "scheduleBar 非空且 count≥1" "$(jq -r '.data.scheduleBar != null and .data.scheduleBar.count >= 1' <<<"$R")" "true"
assert_eq "快照顶层 scheduleEnabled=true" "$(jq -r '.data.scheduleEnabled' <<<"$R")" "true"
s69_pin "$S69_O6" ticketAt -1
R=$(snap)
assert_eq "TICKETED 进 pending 列" "$(col_has pending "$S69_O6" "$R")" "true"
S69_CARD=$(jq -c ".data.columns.pending[] | select(.orderId==$S69_O6)" <<<"$R")
assert_eq "卡片 local.schedule.phase=TICKETED" "$(jq -r '.local.schedule.phase' <<<"$S69_CARD")" "TICKETED"
assert_eq "卡片 etaIfCallNow 非空" "$(jq -r '.local.schedule.etaIfCallNow != null' <<<"$S69_CARD")" "true"
S69_ASAP2=$(mk_local_paid); S69_IDS="$S69_IDS,$S69_ASAP2"
R=$(snap)
S69_IS=$(jq -r ".data.columns.pending | map(.orderId) | index($S69_O6)" <<<"$R"); S69_IA=$(jq -r ".data.columns.pending | map(.orderId) | index($S69_ASAP2)" <<<"$R")
[[ "$S69_IS" != "null" && "$S69_IA" != "null" && "$S69_IS" -lt "$S69_IA" ]] && ok "预约单排在同渠道立即单之前" || fail "排序不对 sched=$S69_IS asap=$S69_IA"
s69_pin "$S69_O6" prepStartAt -1
assert_eq "phase=PREPPING" "$(s69_sc "$S69_O6" | jq -r .phase)" "PREPPING"
R=$(req GET "/api/admin/orders?deliveryType=LOCAL&schedule=SCHEDULED&pageSize=50" "$AT")
[[ "$(jq -r "[.data.list[] | select(.id==$S69_O6)] | length" <<<"$R")" == "1" ]] && ok "列表 schedule=SCHEDULED 含预约单" || fail "列表筛选不含预约单"
[[ "$(jq -r "[.data.list[] | select(.id==$S69_ASAP2)] | length" <<<"$R")" == "0" ]] && ok "列表 schedule=SCHEDULED 不含立即单" || fail "列表筛选混入立即单"
assert_eq "管理端详情 schedule 节" "$(s69_ord "$S69_O6" | jq -r '.data.schedule.phase')" "PREPPING"

echo "-- ⑬ 现有任务不碰预约单：接单后 N 分钟自动呼叫、取消申请自动驳回 --"
S69_O7=$(s69_new 3); S69_IDS="$S69_IDS,$S69_O7"
req POST "/api/admin/local/orders/$S69_O7/accept" "$AT" >/dev/null
sql "UPDATE orders SET accepted_at=DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id=$S69_O7;"
s69_pin "$S69_O7" callAt 60
sched '{"autoCallDelayMin":0.01,"localUncalledMin":1}' >/dev/null
assert_eq "autoCallRiders 不呼预约单" "$(sql "SELECT COUNT(*) FROM deliveries WHERE order_id=$S69_O7;")" "0"
assert_eq "remindLocalUncalled 不催预约单" "$(sql "SELECT local_uncalled_reminded_at IS NULL FROM orders WHERE id=$S69_O7;")" "1"
s69_pin "$S69_O7" selfCancelUntil -1
req POST "/api/orders/$S69_O7/cancel-request" "$UT" '{"note":"不要了"}' >/dev/null
sched '{"cancelAutoRejectMin":1}' >/dev/null
assert_eq "预约单的取消申请不被自动驳回" "$(sql "SELECT cancel_requested_at IS NOT NULL FROM orders WHERE id=$S69_O7;")" "1"
req POST "/api/admin/local/orders/$S69_O7/cancel-request/reject" "$AT" >/dev/null

echo "-- 收尾：恢复设置、清作业、取消未完成单 --"
req PUT /api/admin/settings/local-delivery "$AT" "$S69_ORIG" >/dev/null
req POST /api/admin/system/printer-mock/reset "$AT" >/dev/null
S69_IDS=${S69_IDS#,}
sql "DELETE FROM print_jobs WHERE order_id IN ($S69_IDS);"
sql "UPDATE orders SET status='CANCELLED', cancelled_at=NOW(3), cancel_reason='e2e 收尾' WHERE id IN ($S69_IDS) AND status IN ('PAID','PREPARING');"
sql "UPDATE deliveries SET status='CANCELLED', active_order_id=NULL, cancelled_at=NOW(3) WHERE order_id IN ($S69_IDS) AND active_order_id IS NOT NULL;"
```

- [ ] **Step 3: 跑全量 e2e**

Run（干净库，见 memory「干净库跑 e2e 配方」；服务端以 `SCHEDULER_DISABLED=true` 启动）: `bash scripts/e2e.sh`
Expected: 末行「失败 0」；§62、§69 全部 ✔。红了先看是不是 §69 自身的时序（`sleep 0.5` 不够可加到 1），不是就停。

- [ ] **Step 4: 提交**

```bash
git add scripts/e2e.d/69-scheduled-delivery.sh scripts/e2e.d/62-pickup.sh
git commit -m "test(e2e): §69 预约送达全链路；§62 自取自助取消截止改两小时口径"
```

---

### Task 10: 文档

**Files:**
- Modify: `docs/api.md`（末尾新增「附录 M：同城预约送达（2026-09-21）」）

- [ ] **Step 1: 写附录 M**（结构仿附录 H；内容按下表）

```markdown
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
| `POST /admin/local/orders/:id/ready` | 新增；`{ readyAt, called, callAt }` |
| `GET /admin/orders` | 加 `schedule=SCHEDULED|ASAP` |
| `GET /admin/orders/:id` | 加 `schedule` 节 |
| `GET /admin/workbench/snapshot` | 加 `columns.scheduled`、卡片 `local.schedule`、顶层 `scheduleEnabled / scheduleBar` |

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
| 42292 | 操作与预约单状态不符（接单并呼叫 / 过早呼叫 / 对立即单点已备好） |
```

- [ ] **Step 2: 提交**

```bash
git add docs/api.md
git commit -m "docs(api): 附录 M 同城预约送达（接口、任务、错误码、数据列）"
```

---

## 执行后交接

- 跑完 A1–A8 全部通过后，按模型分工协议进入 **02 复核 · opus**（新会话，只给 spec + 本分支相对 main 的 diff），再由 fable 回判、haiku 机械核对（A6 + 白名单比对 + 错误码 grep）。
- 批次一后半（后台前端 `Workbench.tsx / LocalSettings.tsx / LocalOrders.tsx / OrderDetail.tsx / types.ts / api/admin.ts`）的计划 `2026-09-21-scheduled-delivery-batch1b-admin.md` 在本计划合并后再写，它消费本计划的：快照 `columns.scheduled / local.schedule / scheduleBar / scheduleEnabled`、`/ready`、`/call?force`、`GET /admin/orders?schedule=`、设置 `schedule` 节。
