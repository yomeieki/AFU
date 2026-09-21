# 同城「预约送达」批次一后半（后台前端）—— 实施计划

> **工序 00 规划 · 模型 Fable。** 按「多 agent 开发协议」§2.2 定级 **M**（第 3 条：新功能的后台界面；不含迁移、认证、支付、并发一致性——呼叫/退款的一致性守卫已在批次一服务端由 Opus 复核关闭，本批只调用既有端点），链路 `规划（Fable）→ 执行（Sonnet）→ 复核（Sonnet，新会话）→ 交付`。店主可按 §2.2 只升不降。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**：`docs/superpowers/specs/2026-09-21-scheduled-delivery-design.md` §6（后台）与 §4.11 的「经营概览同城 tab 加预约单计数」。服务端接口已在批次一落地（main `987461d`，附录 M `docs/api.md`）。本批之后是批次二（小程序）。

**Goal:** 店员在工作台上能看见、接单、标「已备好」、必要时「立即呼叫」预约单；店主能在后台开关与配置预约送达；订单列表/详情/经营概览能区分预约单。上线后店主打开 `schedule.enabled` 才对顾客可见（小程序批次二）。

**Architecture:** 只消费服务端已有字段：快照 `columns.scheduled`、卡片 `local.schedule`（`scheduleView` 返回：`phase / prepStartAt / callAt / ticketAt / slotLabel / etaIfCallNow / readyAt / callToleranceMin`）、顶层 `scheduleBar / scheduleEnabled`；端点 `/ready`、`/call {force}`、`GET /admin/orders?schedule=`；设置 `schedule` 节与 `selfCancelLeadMin`。工作台的时间语义全部由服务端 `phase` 决定，前端不倒推，只做倒计时与文案（纯函数放 `utils/schedule.ts`，与 `utils/pickup.ts` 同型）。

**Tech Stack:** React 18 + Vite + TS，`node --test` 跑 `src/utils/*.test.ts`，`npm run build` 含 `scripts/check-admin-timezone.mjs` 与 `tsc`。经营概览的一个 KPI 需要服务端 `routes/admin/stats/local.ts` 加两个数字（在授权范围内）。

---

## 协议 §3.1 规划输出

【工序】规划 【模型】Fable 【等级】M

### 验收标准
1. `cd apps/admin && npx tsc --noEmit` → 零错误
2. `cd apps/admin && npm test` → 全部通过，含新文件 `src/utils/schedule.test.ts` 的断言：七个 `phase` 各自的胶囊文案与紧急度、`scheduleFoldable` 只折 WAITING 且无取消申请、`scheduleBarText` 的「还有 N 分钟 · 另有 M 张」、`etaTextIfCallNow`
3. `cd apps/admin && npm run build` → 通过（含时区检查脚本）
4. `cd apps/server && npx tsc --noEmit` → 零错误；`bash scripts/e2e.sh`（干净库、`TZ=Asia/Shanghai`）末行「失败 0」，§54 经营概览段仍绿（服务端只加 `scheduledCount`，老字段不变）
5. 人工检查（店主/执行者按下表逐条走，截图附在报告）：
   - 工作台：造一张 `WAITING` 预约单 → 待接单列顶部出现折叠组「预约单 1」、顶栏下方出现倒计时条；用 SQL 把它推到 `TICKETED` → 进入待接单列正常卡片，胶囊「11:16 开始备餐」；接单 → 备餐中列，按钮只有「已备好」「立即呼叫」「自己送」，没有「接单并呼叫」；`CALL_DUE` 卡片橙色且显示「现在呼叫预计 12:0x 送达」；点「已备好」后显示「已备好 · 11:36 自动呼叫」；早于 `callAt−5` 点「立即呼叫」弹二次确认且文案带预计送达；`LATE` 卡片红色
   - 设置：预约送达页能开关、改九个参数与自助取消截止，示例钟点随输入实时变，保存后刷新仍在
   - 同城订单：筛选「预约 / 尽快」有效；预约单行显示送达时段；详情页显示送达时段、四个倒推时刻、已备好时刻、呼叫来源
   - 经营概览 → 同城 tab：KPI「预约单」有数且与上期对比

### 实现方向
1. `types.ts` / `api/admin.ts` 加字段与三个调用（`readyLocalOrder`、`callRider` 的 `force`、`getOrders` 的 `schedule`）（预计涉及：`apps/admin/src/types.ts`、`apps/admin/src/api/admin.ts`）
2. 纯函数 `utils/schedule.ts` + 单测（预计涉及：`apps/admin/src/utils/schedule.ts`、`apps/admin/src/utils/schedule.test.ts`）
3. 工作台：折叠组、倒计时条、卡片胶囊/字段/颜色、按钮矩阵、抽屉字段、图例文案、统计「预约」（预计涉及：`apps/admin/src/pages/Workbench.tsx`、`apps/admin/src/pages/Workbench.css`）
4. 设置页：新页 `ScheduleSettings.tsx` + 路由 + 子导航；`PickupSettings.tsx` 加一行只读提示（预计涉及：`apps/admin/src/pages/ScheduleSettings.tsx`、`apps/admin/src/App.tsx`、`apps/admin/src/navigation.ts`、`apps/admin/src/pages/PickupSettings.tsx`）
5. 同城订单列表筛选与行、详情页两处（预计涉及：`apps/admin/src/pages/LocalOrders.tsx`、`apps/admin/src/utils/order-list.ts`、`apps/admin/src/components/orders/detail/DetailCustomer.tsx`、`apps/admin/src/components/orders/detail/DetailDelivery.tsx`）
6. 经营概览：服务端 `stats/local.ts` kpi 加 `scheduledCount`（本期与上期），`LocalTab.tsx` 加 KPI（预计涉及：`apps/server/src/routes/admin/stats/local.ts`、`apps/admin/src/types.ts`、`apps/admin/src/components/dashboard/LocalTab.tsx`、`scripts/e2e.d/54-*.sh` 只在需要时补一条断言）

### 授权范围
```
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/utils/schedule.ts
apps/admin/src/utils/schedule.test.ts
apps/admin/src/utils/order-list.ts
apps/admin/src/utils/order-list.test.ts
apps/admin/src/pages/Workbench.tsx
apps/admin/src/pages/Workbench.css
apps/admin/src/pages/ScheduleSettings.tsx
apps/admin/src/pages/PickupSettings.tsx
apps/admin/src/pages/LocalOrders.tsx
apps/admin/src/pages/OrderDetail.tsx
apps/admin/src/components/orders/detail/DetailCustomer.tsx
apps/admin/src/components/orders/detail/DetailDelivery.tsx
apps/admin/src/components/dashboard/LocalTab.tsx
apps/admin/src/App.tsx
apps/admin/src/navigation.ts
apps/admin/src/navigation.test.ts
apps/server/src/routes/admin/stats/local.ts
scripts/e2e.d/54-*.sh
docs/api.md
```

### 禁止修改
```
apps/miniapp/**
apps/server/src/routes/orders.ts
apps/server/src/routes/admin/delivery.ts
apps/server/src/routes/admin/workbench.ts
apps/server/src/services/**
apps/server/prisma/**
apps/admin/src/components/CancelAndRefundModal.tsx
apps/admin/src/components/RefundDialog.tsx
apps/admin/src/hooks/**
scripts/e2e.sh
.env*
```

### 上报条件
- 需要改授权范围外的文件（尤其服务端 `routes/admin/workbench.ts`、`routes/admin/delivery.ts`——若发现快照字段不够用，停下，由规划者决定是否扩服务端授权）
- `snapshot.columns` 新键 `scheduled` 让 `ColKey` 扩展后，现有 `COLUMNS`/`ColumnTabs`/`pickupOnBoard` 之外还有别的地方枚举列且行为改变
- `npm run build` 的时区检查脚本报错（新代码用了本地时区 API）
- e2e §54 由绿转红
- 任何按钮会在 `phase` 与列不一致时（快照轮询窗口）触发一个不可逆的钱操作（呼叫/退款）而没有确认框

### 待用户决定
- 无。（一处规划者按既有先例定的：预约设置做成独立页签 `/settings/schedule`「预约送达」，而不是 spec §6.2 写的「同城设置里加一张卡片」——2026-09-11 店主把自取拆成了独立页签，同一理由：同城设置页已经很长。自助取消截止 `selfCancelLeadMin` 放在预约送达页并注明「自取共用」，自取页加一行只读提示指过去。若店主更想要卡片形式，只影响 Task 4 的落点。）

---

## Global Constraints

- 只消费服务端已有字段与端点（见 `docs/api.md` 附录 M），不改快照/端点契约。
- 工作台三条规矩不破：列内顺序按服务端数组渲染不再排序；渠道三重编码（色条 + 徽章 + 字段差异）；确认框分级——打电话/看进度不弹，呼叫/退款必弹。
- 时间显示一律走 `utils/time` 的 `fmtHHmm/fmtMonthDayTime/todayKey`（Asia/Shanghai），不用 `new Date().getHours()` 一类本地时区 API（`scripts/check-admin-timezone.mjs` 会拦）。
- 倒计时每秒重渲染：卡片级计算只做减法，不在渲染里调 `Intl`。
- 预约单的紧急度**只由服务端 `phase` 决定**（`CALL_DUE` 橙、`LATE` 红），不再叠加立即单的「等待时长」尺子；立即单逻辑逐字节不变。
- 每个 Task 结束前 `cd apps/admin && npx tsc --noEmit && npm test` 零错误；提交信息中文说明为什么，末尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 服务端字段速查（执行者不必再读服务端代码）

```
WorkbenchSnapshot.columns.scheduled: WorkbenchCard[]      // phase=WAITING 的预约单（PAID/PREPARING、无在途单）
WorkbenchSnapshot.scheduleEnabled: boolean
WorkbenchSnapshot.scheduleBar: { orderId, prepStartAt, slotLabel, count } | null   // WAITING/TICKETED 里 prepStartAt 最近的一张
WorkbenchCard.local.schedule: {
  scheduledAt, slotLabel, ticketAt, prepStartAt, callAt, acceptDueAt, selfCancelUntil,   // ISO 或文案
  readyAt: string | null,
  phase: 'WAITING'|'TICKETED'|'PREPPING'|'CALL_DUE'|'READY_WAITING'|'CALLED'|'LATE',
  etaIfCallNow: string,          // ISO：现在呼叫预计几点送到
  callToleranceMin: number
} | null
POST /admin/local/orders/:id/ready   → { readyAt, called: boolean, callAt, …callRider 返回 }；42292 立即单 / 42204 非备餐中 / 42228 已有在途单
POST /admin/local/orders/:id/call    body { providers?, force?: boolean }；预约单早于 callAt−callToleranceMin 无 force → 42292
POST /admin/local/orders/:id/accept-and-call  预约单 → 42292
GET  /admin/orders?schedule=SCHEDULED|ASAP
GET  /admin/orders/:id → 多 schedule 节（同 local.schedule 形状）、scheduledAt、readyAt
GET  /admin/local/orders/:id/delivery → delivery.callOrigin: 'SCHEDULED_AUTO'|'MANUAL_EARLY'|null
LocalDeliverySettings.schedule: { enabled, slotMinutes, daysAhead, acceptBufferMin, prepMinutes, prepTicketLeadMin, readyRemindEveryMin, readyRemindMaxTimes, callToleranceMin }
LocalDeliverySettings.selfCancelLeadMin: number
```

---

### Task 1: 类型与 API 客户端

**Files:**
- Modify: `apps/admin/src/types.ts`
- Modify: `apps/admin/src/api/admin.ts`

**Interfaces:**
- Produces：`ScheduleInfo`、`SchedulePhase`、`WorkbenchCard.local.schedule`、`WorkbenchSnapshot.columns.scheduled / scheduleEnabled / scheduleBar`、`Order.scheduledAt / readyAt / schedule`、`DeliveryInfo.callOrigin`、`LocalDeliverySettings.schedule / selfCancelLeadMin`、`ScheduleSettings`；`readyLocalOrder(id)`、`callRider(id, providers?, force?)`、`getOrders({ schedule })`。

- [ ] **Step 1: `types.ts` 加类型**（放在 `WorkbenchCard` 之前）

```ts
/** 预约送达（spec 2026-09-21 §6.1）。与服务端 services/delivery/schedule.ts 的 scheduleView 同构；phase 由服务端算，前端不倒推 */
export type SchedulePhase = 'WAITING' | 'TICKETED' | 'PREPPING' | 'CALL_DUE' | 'READY_WAITING' | 'CALLED' | 'LATE'
export interface ScheduleInfo {
  scheduledAt: string
  /** 「今天 12:00–12:30」，服务端按快照时刻算好 */
  slotLabel: string
  ticketAt: string
  prepStartAt: string
  callAt: string
  acceptDueAt: string
  selfCancelUntil: string
  readyAt: string | null
  phase: SchedulePhase
  /** 现在呼叫预计几点送到（ISO） */
  etaIfCallNow: string
  callToleranceMin: number
}
```

`WorkbenchCard.local` 里 `delivery: {…} | null` 之后加：
```ts
    /** 预约单才有；立即单为 null */
    schedule?: ScheduleInfo | null
```
`WorkbenchSnapshot.columns` 加 `scheduled: WorkbenchCard[]`（注释：出票前的预约单，不进五列，工作台渲染成待接单列顶部的折叠组）。`WorkbenchSnapshot` 加：
```ts
  scheduleEnabled: boolean
  /** 常驻倒计时条：WAITING/TICKETED 里最近的一张 + 总数；无预约单为 null */
  scheduleBar: { orderId: number; prepStartAt: string; slotLabel: string; count: number } | null
```
`Order` 里 `pickupDiscountAmount?: number` 之后加：
```ts
  /** 预约送达（2026-09-21）：送达时段起点 / 已备好时刻 / 详情接口算好的倒推时刻。立即单为 null */
  scheduledAt?: string | null
  readyAt?: string | null
  schedule?: ScheduleInfo | null
```
`DeliveryInfo`（找到 `callStrategy` 字段）旁加 `callOrigin?: 'SCHEDULED_AUTO' | 'MANUAL_EARLY' | null`。
`PickupSettings` 接口之后加：
```ts
/** 预约送达设置（与服务端 services/local-settings.ts ScheduleSettings 同构） */
export interface ScheduleSettings {
  enabled: boolean
  slotMinutes: number
  daysAhead: number
  acceptBufferMin: number
  prepMinutes: number
  prepTicketLeadMin: number
  readyRemindEveryMin: number
  readyRemindMaxTimes: number
  callToleranceMin: number
}
```
`LocalDeliverySettings` 里 `pickup: PickupSettings` 之后加 `schedule: ScheduleSettings` 与 `selfCancelLeadMin: number`（注释：自取与预约外送共用的自助取消截止，约定前 N 分钟）。
`LocalStatsKpi` 加 `scheduledCount: number`。

- [ ] **Step 2: `api/admin.ts`**

`callRider` 改为：
```ts
export const callRider = (id: number, providers?: string[], force = false) =>
  client.post<ApiResponse<{ deliveryNo: string; status: string; quotedFeeFen: number | null }>>(
    `/admin/local/orders/${id}/call`, { ...(providers?.length ? { providers } : {}), ...(force ? { force: true } : {}) })
```
（现有两处调用 `callRider(order.id)` / `callRider(order.id, pick?.…)` 不受影响。）
`selfDeliverOrder` 之前加：
```ts
/** 预约单「已备好」：写 readyAt；已到该呼叫时刻则服务端立即发单（called=true） */
export const readyLocalOrder = (id: number) =>
  client.post<ApiResponse<{ readyAt: string; called: boolean; callAt: string | null; deliveryNo?: string; status?: string }>>(`/admin/local/orders/${id}/ready`)
```
`getOrders` 的 params 类型加 `schedule?: 'SCHEDULED' | 'ASAP'`。

- [ ] **Step 3: tsc；提交**

Run: `cd apps/admin && npx tsc --noEmit`
Expected: 零错误（`columns.scheduled` 加进类型后，`pickupOnBoard` 用显式列表、`COLUMNS` 是常量数组，不受影响；若报错在别处 → 上报条件第 2 条）。

```bash
git add apps/admin/src/types.ts apps/admin/src/api/admin.ts
git commit -m "feat(admin/types): 预约送达快照/订单/设置类型与 ready、call force、schedule 筛选三个调用"
```

---

### Task 2: 纯函数 `utils/schedule.ts` + 单测

**Files:**
- Create: `apps/admin/src/utils/schedule.ts`
- Create: `apps/admin/src/utils/schedule.test.ts`

**Interfaces:**
- Produces：`scheduleUrgency(phase)`、`scheduleCapsule(sc, colKey, now)`、`scheduleFoldable(card)`、`scheduleBarText(bar, now)`、`etaTextIfCallNow(sc)`、`isBeforeCallWindow(sc, now)`、`scheduleFieldsLine(sc)`。

- [ ] **Step 1: 写 `utils/schedule.ts`**

```ts
/**
 * 预约单在工作台上的时间语义（spec 2026-09-21 §6.1）。全部纯函数、只做减法与文案；
 * 阶段（phase）由服务端算好，这里不倒推。时刻格式化走 utils/time（Asia/Shanghai）。
 */
import { fmtHHmm } from './time.ts'
import type { ScheduleInfo, SchedulePhase, WorkbenchCard } from '../types'

export type ScheduleUrgency = '' | 'warn' | 'late'
export type ScheduleColKey = 'pending' | 'preparing' | 'waitingCourier' | 'delivering' | 'done'

const minLeft = (iso: string, now: number) => Math.ceil((Date.parse(iso) - now) / 60_000)
const minOver = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))

/** 紧急度只看阶段：应备好未备好 = 橙，超约定时间 = 红。其余不点亮（有硬期限的单不用等待时长那把尺子） */
export function scheduleUrgency(phase: SchedulePhase): ScheduleUrgency {
  if (phase === 'LATE') return 'late'
  if (phase === 'CALL_DUE') return 'warn'
  return ''
}

/** 卡片右上角胶囊文案。done 列不归这里管（返回 null 走「完成于」） */
export function scheduleCapsule(sc: ScheduleInfo, colKey: ScheduleColKey, now: number): { text: string; cls: string } | null {
  if (colKey === 'done') return null
  const cls = scheduleUrgency(sc.phase) === 'late' ? 'wb__wait--danger' : scheduleUrgency(sc.phase) === 'warn' ? 'wb__wait--warn' : ''
  switch (sc.phase) {
    case 'WAITING':
    case 'TICKETED':
      return { text: `${fmtHHmm(sc.prepStartAt)} 开始备餐`, cls }
    case 'PREPPING':
      return { text: `距应备好 ${minLeft(sc.callAt, now)} 分`, cls }
    case 'CALL_DUE':
      return { text: `应已备好 · 晚 ${minOver(sc.callAt, now)} 分`, cls }
    case 'READY_WAITING':
      return { text: `已备好 · ${fmtHHmm(sc.callAt)} 自动呼叫`, cls }
    case 'CALLED':
      return { text: `${fmtHHmm(sc.scheduledAt)} 送达`, cls }
    case 'LATE':
      return { text: `已超约定时间 ${minOver(sc.scheduledAt, now)} 分`, cls }
  }
}

/** 折叠进「预约单」组：出票前（WAITING）且没有取消申请——红框告警卡必须留在正常列 */
export function scheduleFoldable(card: WorkbenchCard): boolean {
  const sc = card.local?.schedule
  return !!sc && sc.phase === 'WAITING' && !card.local?.cancelRequested
}

/** 顶部常驻倒计时条文案 */
export function scheduleBarText(bar: { prepStartAt: string; slotLabel: string; count: number }, now: number): string {
  const left = minLeft(bar.prepStartAt, now)
  const when = left > 0 ? `还有 ${left} 分钟` : `已到点 ${-left} 分钟`
  const more = bar.count > 1 ? ` · 另有 ${bar.count - 1} 张` : ''
  return `下一张预约单 ${fmtHHmm(bar.prepStartAt)} 开始备餐，${when}（${bar.slotLabel} 送达）${more}`
}

/** 「现在呼叫预计 12:05 送达」 */
export function etaTextIfCallNow(sc: ScheduleInfo): string {
  return `现在呼叫预计 ${fmtHHmm(sc.etaIfCallNow)} 送达`
}

/** 早于「该呼叫 − 容忍」：点「呼叫」要走 force 并二次确认 */
export function isBeforeCallWindow(sc: ScheduleInfo, now: number): boolean {
  return now < Date.parse(sc.callAt) - sc.callToleranceMin * 60_000
}

/** 卡片字段区那一行「12:00 送达 · 11:16 开始备餐 · 11:36 呼叫」 */
export function scheduleFieldsLine(sc: ScheduleInfo): string {
  return `${sc.slotLabel} 送达 · ${fmtHHmm(sc.prepStartAt)} 开始备餐 · ${fmtHHmm(sc.callAt)} 呼叫`
}
```

- [ ] **Step 2: 写 `utils/schedule.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleUrgency, scheduleCapsule, scheduleFoldable, scheduleBarText, etaTextIfCallNow, isBeforeCallWindow, scheduleFieldsLine } from './schedule.ts'
import type { ScheduleInfo, WorkbenchCard } from '../types'

// 2026-09-22 12:00 Asia/Shanghai = 04:00Z
const NOON = Date.parse('2026-09-22T04:00:00Z')
const min = (n: number) => n * 60_000
const iso = (t: number) => new Date(t).toISOString()
const base = (phase: ScheduleInfo['phase'], readyAt: string | null = null): ScheduleInfo => ({
  scheduledAt: iso(NOON), slotLabel: '今天 12:00–12:30',
  ticketAt: iso(NOON - min(59)), prepStartAt: iso(NOON - min(44)), callAt: iso(NOON - min(24)),
  acceptDueAt: iso(NOON - min(49)), selfCancelUntil: iso(NOON - min(120)),
  readyAt, phase, etaIfCallNow: iso(NOON + min(5)), callToleranceMin: 5,
})

test('紧急度只看阶段：CALL_DUE 橙、LATE 红、其余不亮', () => {
  assert.equal(scheduleUrgency('CALL_DUE'), 'warn'); assert.equal(scheduleUrgency('LATE'), 'late')
  for (const p of ['WAITING', 'TICKETED', 'PREPPING', 'READY_WAITING', 'CALLED'] as const) assert.equal(scheduleUrgency(p), '')
})
test('胶囊文案七态；done 列返回 null', () => {
  const now = NOON - min(50)
  assert.deepEqual(scheduleCapsule(base('WAITING'), 'pending', now), { text: '11:16 开始备餐', cls: '' })
  assert.deepEqual(scheduleCapsule(base('TICKETED'), 'pending', now), { text: '11:16 开始备餐', cls: '' })
  assert.deepEqual(scheduleCapsule(base('PREPPING'), 'preparing', NOON - min(30)), { text: '距应备好 6 分', cls: '' })
  assert.deepEqual(scheduleCapsule(base('CALL_DUE'), 'preparing', NOON - min(20)), { text: '应已备好 · 晚 4 分', cls: 'wb__wait--warn' })
  assert.deepEqual(scheduleCapsule(base('READY_WAITING', iso(NOON - min(40))), 'preparing', NOON - min(30)), { text: '已备好 · 11:36 自动呼叫', cls: '' })
  assert.deepEqual(scheduleCapsule(base('CALLED', iso(NOON - min(40))), 'waitingCourier', NOON - min(10)), { text: '12:00 送达', cls: '' })
  assert.deepEqual(scheduleCapsule(base('LATE'), 'delivering', NOON + min(11)), { text: '已超约定时间 11 分', cls: 'wb__wait--danger' })
  assert.equal(scheduleCapsule(base('CALLED'), 'done', NOON), null)
})
test('折叠：只折 WAITING 且无取消申请', () => {
  const card = (phase: ScheduleInfo['phase'], cancelRequested = false) =>
    ({ channel: 'LOCAL', local: { schedule: base(phase), cancelRequested } } as unknown as WorkbenchCard)
  assert.equal(scheduleFoldable(card('WAITING')), true)
  assert.equal(scheduleFoldable(card('WAITING', true)), false)
  assert.equal(scheduleFoldable(card('TICKETED')), false)
  assert.equal(scheduleFoldable({ channel: 'PICKUP', local: null } as unknown as WorkbenchCard), false)
})
test('倒计时条文案：还有/已到点、另有 N 张', () => {
  const bar = { prepStartAt: iso(NOON - min(44)), slotLabel: '今天 12:00–12:30', count: 3 }
  assert.equal(scheduleBarText(bar, NOON - min(64)), '下一张预约单 11:16 开始备餐，还有 20 分钟（今天 12:00–12:30 送达） · 另有 2 张')
  assert.equal(scheduleBarText({ ...bar, count: 1 }, NOON - min(40)), '下一张预约单 11:16 开始备餐，已到点 4 分钟（今天 12:00–12:30 送达）')
})
test('现在呼叫预计送达 / 呼叫窗口判定 / 字段行', () => {
  const sc = base('PREPPING')
  assert.equal(etaTextIfCallNow(sc), '现在呼叫预计 12:05 送达')
  assert.equal(isBeforeCallWindow(sc, NOON - min(30)), true)    // callAt 11:36 − 5 = 11:31，11:30 仍早
  assert.equal(isBeforeCallWindow(sc, NOON - min(29)), false)
  assert.equal(scheduleFieldsLine(sc), '今天 12:00–12:30 送达 · 11:16 开始备餐 · 11:36 呼叫')
})
```
（`fmtHHmm` 的签名以 `utils/time.ts` 为准；若它要求第二参数占位符，按 `pickup.ts` 现有用法调用。）

- [ ] **Step 3: 跑测试与 tsc；提交**

Run: `cd apps/admin && npm test && npx tsc --noEmit`
Expected: 全部通过；零错误。

```bash
git add apps/admin/src/utils/schedule.ts apps/admin/src/utils/schedule.test.ts
git commit -m "feat(admin/utils): 预约单工作台时间语义纯函数（胶囊/紧急度/折叠/倒计时条）+ 单测"
```

---

### Task 3: 工作台

**Files:**
- Modify: `apps/admin/src/pages/Workbench.tsx`
- Modify: `apps/admin/src/pages/Workbench.css`

**Interfaces:**
- Consumes：Task 1 类型、Task 2 函数、`readyLocalOrder`、`callRider(id, providers, force)`。

- [ ] **Step 1: import 与图例/提示**

import 加 `import { scheduleUrgency, scheduleCapsule, scheduleFoldable, scheduleBarText, etaTextIfCallNow, isBeforeCallWindow, scheduleFieldsLine } from '../utils/schedule'` 与 `readyLocalOrder`。
`HintContent` 末尾加一句：「预约单：出票前收在待接单列顶部的「预约单」组里不计时；到「应备好」未点转橙，超约定送达时间转红。」

- [ ] **Step 2: 紧急度与胶囊接入预约单**

`urgencyOf` 开头（`if (colKey === 'done') return ''` 之后）加：
```ts
  // 预约单只看服务端阶段（spec §6.1）：它有硬期限，不用等待时长那把尺子，也不看 estimatedDeliveryAt（那就是约定时刻）
  const sc = card.local?.schedule
  if (sc) return scheduleUrgency(sc.phase)
```
`Card` 与抽屉里 `const w = pickupCapsule(…) ?? (…)` 改为：
```ts
  const w = (card.local?.schedule ? scheduleCapsule(card.local.schedule, colKey, now) : null)
    ?? pickupCapsule(card, colKey, now, urg)
    ?? (colKey === 'done' ? { text: `完成于 ${hhmm(card.waitSince)}`, cls: '' } : waitLabel(card.waitSince, now, urg))
```

- [ ] **Step 3: 卡片字段区**

`Card` 的 `wb__fields` 里 `local` 且非 `done` 的分支，把原来三行改为：
```tsx
          <>
            {card.local?.schedule && <span className="wb__sched">{scheduleFieldsLine(card.local.schedule)}</span>}
            {kmText && <span>距离 {kmText}</span>}
            <span>骑手 {d?.courierName ? `${d.courierName}${d.courierMobile ? ` ${d.courierMobile}` : ''}` : (d ? d.statusLabel : '未呼叫')}</span>
            {card.local?.schedule
              ? (card.local.schedule.phase === 'CALL_DUE' || card.local.schedule.phase === 'PREPPING') && <span>{etaTextIfCallNow(card.local.schedule)}</span>
              : <span>预计送达 {hhmm(card.local?.estimatedDeliveryAt)}</span>}
          </>
```
`Workbench.css` 加：
```css
.wb__sched { font-weight:600; color:var(--local); }
.wb__schedbar { margin:6px 12px 0; padding:6px 10px; border-radius:8px; font-size:12px; font-weight:600;
  background:color-mix(in srgb, var(--local) 12%, var(--surface)); color:var(--text-1); border:1px solid color-mix(in srgb, var(--local) 40%, var(--line));
  display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:pointer; }
```

- [ ] **Step 4: 折叠组「预约单」与倒计时条**

板块渲染循环里（`const tomorrow = …` 旁），对 `pending` 列追加：
```tsx
          // 预约单出票前不进五列（服务端 columns.scheduled），在待接单列顶部折成一组；有取消申请的留在正常列（同明日自取的道理）
          const scheduledFold = col.key === 'pending' && snap ? snap.columns.scheduled.filter(scheduleFoldable) : []
          const scheduledLoose = col.key === 'pending' && snap ? snap.columns.scheduled.filter((c) => !scheduleFoldable(c)) : []
```
`wb__col-body` 内容改为：先渲染折叠组（在最上面），再 `scheduledLoose.map(renderCard)`，再 `todayList.map(renderCard)`，最后原有「明日自取」组：
```tsx
                {scheduledFold.length > 0 && (
                  <div className="wb__fold" style={{ marginTop: 0, borderTop: 'none', paddingTop: 0, marginBottom: 8 }}>
                    <button type="button" className="wb__fold-t" onClick={() => setScheduledOpen((v) => !v)}>
                      <span>预约单 <b style={{ color: 'var(--local)' }}>{scheduledFold.length}</b>{snap?.scheduleBar ? ` · 最近 ${hhmm(snap.scheduleBar.prepStartAt)} 开始备餐` : ''}</span>
                      <span>{scheduledOpen ? '收起' : '展开'}</span>
                    </button>
                    {scheduledOpen && scheduledFold.map(renderCard)}
                  </div>
                )}
                {scheduledLoose.map(renderCard)}
```
空态判断改成 `todayList.length === 0 && tomorrow.length === 0 && scheduledFold.length === 0 && scheduledLoose.length === 0`。加 state `const [scheduledOpen, setScheduledOpen] = useState(false)`（不持久化）。
列头计数：`pending` 列的 `list.length` 改为 `list.length + (snap?.columns.scheduled.length ?? 0)`；`ColumnTabs` 同样把 `scheduled` 计入 `pending` 的数字。手机模式 `phoneCol === 'pending'` 时同样渲染上述折叠组（同一段代码在 `isPhone` 与桌面共用，不需要分支）。

倒计时条：`TopAlerts` 之后、图例之前加
```tsx
      {snap?.scheduleBar && (
        <div className="wb__schedbar" onClick={() => { setScheduledOpen(true); boardRef.current?.scrollTo({ left: 0, behavior: 'smooth' }) }} role="button" tabIndex={0}>
          <span>{scheduleBarText(snap.scheduleBar, now)}</span>
          <span className="wb__muted">点击查看</span>
        </div>
      )}
```

- [ ] **Step 5: 按钮矩阵**

`renderActions` 里 LOCAL 的两处改动：
1. `colKey === 'pending'`：`if (ch === 'LOCAL')` 加「接单并呼叫」那段改成 `if (ch === 'LOCAL' && !card.local?.schedule)`；接单确认文案对预约单改为 `订单转入「备餐中」。到 ${hhmm(sc.prepStartAt)} 开始备餐，做好后点「已备好」，系统会在 ${hhmm(sc.callAt)} 自动呼叫骑手。`（`sc = card.local.schedule`）。
2. `colKey === 'preparing' && ch === 'LOCAL'` 的非 UNKNOWN 分支，在 `const failed = …` 之前插入预约单分支并 `return`-free 地替换主按钮：
```tsx
        const sc = card.local?.schedule
        if (sc && active === null) {
          // 预约单（spec §4.5 / §6.1）：主「已备好」→ 系统在 max(已备好, 该呼叫时刻) 发单；次「立即呼叫」跳过等待；「自己送」照常
          if (!sc.readyAt) {
            btns.push(fill('ready', '已备好', () => confirm({
              title: '已备好', channel: ch, confirmText: '确认已备好', okMsg: '已记录，到点自动呼叫',
              what: Date.parse(sc.callAt) <= now
                ? '餐已备好且已到该呼叫时刻：确认后立即向快递100 发单呼叫骑手。'
                : `餐已备好。系统会在 ${hhmm(sc.callAt)} 自动呼叫骑手，餐在店里等骑手。`,
              customer: '顾客看到「商家已确认」；骑手接单后显示骑手信息。',
              cost: Date.parse(sc.callAt) <= now ? '会预扣一次配送费。' : '到点呼叫时预扣一次配送费。',
              run: () => readyLocalOrder(order.id),
            })))
          }
          const early = isBeforeCallWindow(sc, now)
          btns.push(ghost('call-now', '立即呼叫', () => confirm(callSpec(
            '立即呼叫骑手', '确认立即呼叫',
            `${early ? '早于该呼叫时刻（' + hhmm(sc.callAt) + '），' : ''}${etaTextIfCallNow(sc)}，早于顾客约定的 ${hhmm(sc.scheduledAt)}。向快递100 发单，骑手会来店里取货。`,
            (pick) => callRider(order.id, pick?.manual ? pick.providers : undefined, true),
          ))))
          btns.push(ghost('self', '自己送', () => setModal({ kind: 'self' })))
        } else {
          /* 原有立即单的「呼叫骑手 / 重新呼叫骑手」+「自己送」两颗按钮原样 */
        }
```
（`callSpec` 的第四参 `run` 已接收 `pick`；`early` 为真时确认框 `amber` 栏写「骑手会比约定时间早到，确定现在呼？」——`callSpec` 若不支持 `amber`，把这句并进 `what`。）
`waitingCourier` 与 `delivering` 列的按钮对预约单不变。

- [ ] **Step 6: 抽屉字段**

抽屉「收货信息」块 `local` 分支，`预计送达` 那一行改为：
```tsx
                      {card.local?.schedule ? (
                        <>
                          <div className="wb__line"><span>约定送达</span><span>{card.local.schedule.slotLabel}</span></div>
                          <div className="wb__line"><span>开始备餐</span><span>{hhmm(card.local.schedule.prepStartAt)}</span></div>
                          <div className="wb__line"><span>该呼叫</span><span>{hhmm(card.local.schedule.callAt)}</span></div>
                          {card.local.schedule.readyAt && <div className="wb__line"><span>已备好</span><span>{dateTime(card.local.schedule.readyAt)}</span></div>}
                        </>
                      ) : (
                        <div className="wb__line"><span>预计送达</span><span>{hhmm(o?.estimatedDeliveryAt)}</span></div>
                      )}
```
「配送员」块 `呼叫方式` 行之后加：
```tsx
                {d.callOrigin && <div className="wb__line"><span>呼叫来源</span><span>{d.callOrigin === 'SCHEDULED_AUTO' ? '到点自动' : '店员提前呼叫'}</span></div>}
```

- [ ] **Step 7: 顶栏统计**

`TopBar` 与手机 `menu` 弹层的「自取 N」旁加「预约 N」：`scheduleOnBoard(snap)` = `columns.scheduled.length + 四列里 local.schedule 非空的卡片数`（写在 `pickupOnBoard` 旁）。

- [ ] **Step 8: tsc、测试、构建；提交**

Run: `cd apps/admin && npx tsc --noEmit && npm test && npm run build`
Expected: 零错误、全通过、构建成功。

```bash
git add apps/admin/src/pages/Workbench.tsx apps/admin/src/pages/Workbench.css
git commit -m "feat(admin/workbench): 预约单折叠组、倒计时条、阶段胶囊与颜色、已备好/立即呼叫按钮、抽屉倒推时刻"
```

---

### Task 4: 预约送达设置页

**Files:**
- Create: `apps/admin/src/pages/ScheduleSettings.tsx`
- Modify: `apps/admin/src/App.tsx`（`settings/pickup` 之后加 `<Route path="schedule" element={<ScheduleSettings />} />`）
- Modify: `apps/admin/src/navigation.ts`（店铺设置子导航 `到店自取` 之后加 `{ to: '/settings/schedule', label: '预约送达' }`）；`navigation.test.ts` 若枚举了子导航条数，同步
- Modify: `apps/admin/src/pages/PickupSettings.tsx`（顶部提示区加一行只读：「自助取消截止：约定时刻前 {selfCancelLeadMin} 分钟内顾客不能自助取消（与预约送达共用，在「预约送达」页修改）」；需要在 `hydrate` 里多存 `v.selfCancelLeadMin`）

- [ ] **Step 1: 写 `ScheduleSettings.tsx`**（整体仿 `PickupSettings.tsx`：读整包 → 只编辑 `schedule` 与 `selfCancelLeadMin` → 保存前取最新整包写回）

```tsx
import { useEffect, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import type { LocalDeliverySettings, ScheduleSettings as Sched } from '../types'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { fmtHHmm } from '../utils/time'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

/**
 * 示例钟点——**与服务端 services/delivery/schedule.ts 的 scheduleTimeline 同一套公式**，改这里必须同时改那边。
 * 3 km 的单、约 12:00 送达（用上海日历的今天 12:00）：呼叫 = 送达 − 路上 − 呼叫到取走；开始备餐 = 呼叫 − 备餐；
 * 出票 = 开始备餐 − 提前量；接单截止 = 开始备餐 − 缓冲；自助取消截止 = 送达 − selfCancelLeadMin。
 */
function example(s: LocalDeliverySettings, sc: Sched, selfCancelLeadMin: number) {
  const noon = new Date(); noon.setHours(12, 0, 0, 0)   // 只用于取「今天 12:00」这个演示锚点；显示走 fmtHHmm
  const ride = Math.round((3 / s.riderSpeedKmh) * 60)
  const t = noon.getTime()
  const callAt = t - (ride + s.callToPickupMin) * 60_000
  const prepStartAt = callAt - sc.prepMinutes * 60_000
  return {
    ticket: fmtHHmm(prepStartAt - sc.prepTicketLeadMin * 60_000),
    acceptDue: fmtHHmm(prepStartAt - sc.acceptBufferMin * 60_000),
    prepStart: fmtHHmm(prepStartAt),
    call: fmtHHmm(callAt),
    selfCancel: fmtHHmm(t - selfCancelLeadMin * 60_000),
    ride,
  }
}

export default function ScheduleSettings() {
  const { setDirty } = useUnsavedSettings()
  const [s, setS] = useState<LocalDeliverySettings | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydrate = (v: LocalDeliverySettings) => { setS(v); setDirty(false) }
  useEffect(() => {
    getLocalSettings().then(hydrate).catch(() => { setLoadFailed(true); toast.error('预约设置加载失败，请刷新重试') })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loadFailed) return <div className="text-red-600">预约设置加载失败，请刷新页面重试。</div>
  if (!s) return <div className="text-gray-500">加载中...</div>

  const sc = s.schedule
  const patch = (x: Partial<Sched>) => setS({ ...s, schedule: { ...sc, ...x } })
  const ex = example(s, sc, s.selfCancelLeadMin)
  const formError = sc.enabled && s.businessHours.length === 0 ? '开通预约配送须先在「营业时间」页设置营业时段' : ''

  const save = async () => {
    if (formError) { toast.error(formError); return }
    setSaving(true)
    try {
      let fresh: LocalDeliverySettings
      try { fresh = await getLocalSettings() } catch { toast.error('读取最新设置失败，本次未保存，请刷新后重试'); return }
      const next = await updateLocalSettings({ ...fresh, schedule: sc, selfCancelLeadMin: s.selfCancelLeadMin })
      hydrate(next)
      toast.success('已保存，新参数对已付款的预约单也立即生效（倒推时刻按当时设置重算）')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <h3 className="text-lg font-semibold text-gray-800">预约送达设置</h3>
      {!sc.enabled && <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-sm text-gray-600">预约送达未开通，顾客结算页只有「尽快送达」。开通前请确认工作台已升级到带「预约单」组的版本（否则出票前的预约单在工作台上看不见）。</div>}

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><CalendarClock className="w-4 h-4" />预约送达</h3>
        <p className="text-xs text-gray-500">
          预约单从顾客选的送达时段倒推：呼叫 = 送达 − 路上 − 呼叫到取走；开始备餐 = 呼叫 − 备餐；备餐票 = 开始备餐 − 提前量；接单截止 = 开始备餐 − 缓冲。店员点「已备好」后系统到点自动呼叫；「立即呼叫」可跳过等待。
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={sc.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          开通预约送达
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="时段粒度（分）" hint="顾客按格选送达时间，如 30 = 12:00–12:30">
            <select className={inputCls} value={sc.slotMinutes} onChange={(e) => patch({ slotMinutes: Number(e.target.value) })}>
              {[15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="可预约">
            <select className={inputCls} value={sc.daysAhead} onChange={(e) => patch({ daysAhead: Number(e.target.value) })}>
              <option value={0}>仅今天</option><option value={1}>今天和明天</option><option value={2}>三天内</option><option value={3}>四天内</option>
            </select>
          </Field>
          <Field label="接单缓冲（分）" hint="接单截止 = 开始备餐 − 它；到点未接单才催"><input className={inputCls} type="number" min={0} max={30} value={sc.acceptBufferMin} onChange={(e) => patch({ acceptBufferMin: Number(e.target.value) })} /></Field>
          <Field label="预约单备餐时长（分）" hint="与立即单分开；热菜怕冷可调短，高峰取与高峰上界的大者"><input className={inputCls} type="number" min={0} max={180} value={sc.prepMinutes} onChange={(e) => patch({ prepMinutes: Number(e.target.value) })} /></Field>
          <Field label="备餐票提前量（分）" hint="开始备餐前多久出备餐票并语音播报；0 = 到点才出"><input className={inputCls} type="number" min={0} max={60} value={sc.prepTicketLeadMin} onChange={(e) => patch({ prepTicketLeadMin: Number(e.target.value) })} /></Field>
          <Field label="催备好间隔（分）" hint="到该呼叫时刻仍未点「已备好」，每隔这么久出一张催促小条"><input className={inputCls} type="number" min={1} max={15} value={sc.readyRemindEveryMin} onChange={(e) => patch({ readyRemindEveryMin: Number(e.target.value) })} /></Field>
          <Field label="催备好上限（次）" hint="超过后停止小条并告警一次"><input className={inputCls} type="number" min={1} max={10} value={sc.readyRemindMaxTimes} onChange={(e) => patch({ readyRemindMaxTimes: Number(e.target.value) })} /></Field>
          <Field label="呼叫容忍窗口（分）" hint="早于「该呼叫 − 它」点呼叫要二次确认（立即呼叫）"><input className={inputCls} type="number" min={0} max={15} value={sc.callToleranceMin} onChange={(e) => patch({ callToleranceMin: Number(e.target.value) })} /></Field>
          <Field label="自助取消截止（分）" hint="自取与预约外送共用：约定时刻前这么多分钟内，顾客不能自助秒退，只能申请取消">
            <input className={inputCls} type="number" min={0} max={720} value={s.selfCancelLeadMin} onChange={(e) => setS({ ...s, selfCancelLeadMin: Number(e.target.value) })} /></Field>
        </div>
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
          <p className="text-xs font-medium text-gray-600 mb-1.5">示例：3 km 的单约今天 12:00 送达（路上 {ex.ride} 分、呼叫到取走 {s.callToPickupMin} 分，按当前输入实时算）</p>
          <ul className="text-xs text-gray-600 space-y-1">
            <li>{ex.selfCancel} 顾客自助取消截止</li>
            <li>{ex.ticket} 出备餐票 · {ex.acceptDue} 接单截止 · <b>{ex.prepStart} 开始备餐</b> · <b>{ex.call} 呼叫骑手</b> · 12:00 送达</li>
          </ul>
        </div>
      </section>

      <div className="flex justify-end">
        {formError && <span className="text-xs text-red-600 self-center mr-2">{formError}</span>}
        <Button loading={saving} disabled={!!formError} onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
```
⚠ `example()` 里用了 `setHours`——`scripts/check-admin-timezone.mjs` 若拦本地时区 API，改成：取「上海今天 12:00」用 `utils/time` 已有的 `todayKey()` 拼 `new Date(\`${todayKey(new Date())}T12:00:00+08:00\`)`。以脚本为准。

- [ ] **Step 2: 路由与导航；自取页只读提示；tsc、测试、构建；提交**

```bash
git add apps/admin/src/pages/ScheduleSettings.tsx apps/admin/src/App.tsx apps/admin/src/navigation.ts apps/admin/src/navigation.test.ts apps/admin/src/pages/PickupSettings.tsx
git commit -m "feat(admin/settings): 预约送达设置页（九项参数 + 自助取消截止 + 示例钟点），自取页指向共用截止"
```

---

### Task 5: 同城订单列表与详情

**Files:**
- Modify: `apps/admin/src/pages/LocalOrders.tsx`（`TYPE_TABS` 之后加 `SCHED_TABS: [{ '', '全部' }, { 'SCHEDULED', '预约' }, { 'ASAP', '尽快' }]`，写进 URL 参数 `sched`，`getOrders` 传 `schedule`；只在 `type !== 'PICKUP'` 时显示）
- Modify: `apps/admin/src/utils/order-list.ts`（`deliveryColumn(o)`：`o.scheduledAt` 非空时首行显示「预约 」+ `o.schedule?.slotLabel ?? fmtMonthDayTime(o.scheduledAt)`；列表接口不返回 `schedule` 节时退回时刻格式化）与 `order-list.test.ts` 加一条
- Modify: `apps/admin/src/components/orders/detail/DetailCustomer.tsx`（`order.pickupAt` 那行旁加 `{order.schedule && <p>预约送达 {order.schedule.slotLabel}</p>}`）
- Modify: `apps/admin/src/components/orders/detail/DetailDelivery.tsx`（有 `order.schedule` 时在配送信息卡顶部加四行：出票 / 开始备餐 / 该呼叫 / 已备好；配送单存在时加「呼叫来源」行，取 `data.delivery.callOrigin`）；`OrderDetail.tsx` 若 `DetailDelivery` 不接收 `order`，补传

- [ ] **Step 1–3: 按上面改；`npm test` 含 `order-list.test.ts` 新断言；tsc；提交**

```bash
git commit -m "feat(admin/orders): 同城订单预约/尽快筛选、行内送达时段、详情页倒推时刻与呼叫来源"
```

---

### Task 6: 经营概览「预约单」KPI

**Files:**
- Modify: `apps/server/src/routes/admin/stats/local.ts`（`kpi` 加 `scheduledCount: await prisma.order.count({ where: { ...where, scheduledAt: { not: null } } })`，与 `freeShipCount` 同款并入那组 `Promise.all`；上期 `prev.kpi` 自然带上）
- Modify: `apps/admin/src/components/dashboard/LocalTab.tsx`（KPI 网格改 5 列：加 `<KpiCard label="预约单" value={String(k.scheduledCount)} sub={占比 pct(k.orderCount ? k.scheduledCount / k.orderCount : null)} cur={k.scheduledCount} prev={k.prev.scheduledCount} />`；栅格 `lg:grid-cols-5`）
- Modify: `docs/api.md` 附录 M「接口」表加一行 `GET /api/admin/stats/local` → `kpi.scheduledCount`
- 可选：`scripts/e2e.d/54-*.sh` 加一条 `kpi.scheduledCount` 存在且 ≥ 0 的断言

- [ ] **Step 1–3: 改、跑 `cd apps/server && npx tsc --noEmit`、e2e 干净库全量（`TZ=Asia/Shanghai`）；admin tsc/test/build；提交**

```bash
git commit -m "feat(stats): 同城经营概览加预约单计数与占比"
```

---

### Task 7: 人工验收与交付材料

- [ ] 按验收标准 5 逐条走（本地起 server + admin dev，用 SQL 推 `scheduled_at` 造各阶段，方法见 `scripts/e2e.d/69-scheduled-delivery.sh` 的 `s69_pin`），截图存 `docs/superpowers/notes/2026-09-2x-scheduled-delivery-batch1b-acceptance/`（只放 PNG）。
- [ ] 报告写明：桌面 / iPad（≥700px）/ 手机（≤700px）三种宽度各走一遍工作台。

---

## 执行后交接

- 复核（M 级 Sonnet，新会话）只给：spec §6、本计划 §3.1 六栏、Global Constraints、BASE、`git diff BASE`、未跟踪文件清单、执行者「验证」栏原文、「偏离方案」的「改了什么」。
- 交付报告须写：范围检查是否可运行（`.agent/check-scope.sh` 仍不存在则「未运行」）；上线顺序：**本批上线后店主才可开 `schedule.enabled`**；小程序批次二计划另写。
