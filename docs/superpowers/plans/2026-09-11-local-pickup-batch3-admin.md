# 到店自取 · 批次三（后台前端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **工序声明**：本文件是「模型分工协议」的 **00 规划 · fable** 产物，等级 **L**。
> 后续：01 执行 · sonnet（逐任务子代理）→ 02 复核 · opus（新会话，只给需求 + 最终 diff）→ 03 回判 · fable → 04 机械核对 · haiku。
> 验收标准只在本文件定义（§验收标准）；复核类工序一律新会话、最小上下文。

**Goal:** 让后台（`apps/admin`）能看见、处理、配置到店自取：工作台自取卡片与操作、暂停范围弹窗、同城设置的「到店自取」「休业」卡片、全店统一的营业时间页、同城订单列表渠道筛选、经营概览自取渠道。

**Architecture:** 服务端（批次一）已经给齐字段与端点：快照卡片 `pickup{…}`、顶层 `pickupEnabled/pickupPaused/holiday`、设置 `pickup{…}`/`holiday`、订单 `pickupAt/pickupReadyAt/pickupDiscountAmount`、端点 `pickup-ready/picked-up/cancel-request/approve|reject`、`GET /admin/orders?channel=LOCAL`、统计 `channels.PICKUP`。本批只做前端消费：类型与 API 层先行，纯函数（取餐倒计时、明日折叠、暂停范围）独立成可单测的工具文件，再逐页接线。工作台沿用现有约定（渠道色条 + 徽标、`ConfirmSpec` 分级确认弹窗、`renderActions` 按列的按钮矩阵）；设置页沿用「整包 PUT 前先 GET 最新再合并」的约定。

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind（设置/列表页）、`Workbench.css` 自绘（工作台，支持深色）、react-router 6、`node --test`（`npm test`）、构建前置 `scripts/check-admin-timezone.mjs`。

**Spec:** `docs/superpowers/specs/2026-09-11-local-pickup-design.md` §6（后台）、§4.10（营业时间统一）、§1 P9/P10/P12/P13。服务端契约见 `docs/api.md` 附录 H。

---

## Global Constraints（每个任务隐含包含本节）

- **工作目录**：`/Users/yumingyi/food-shop/.claude/worktrees/local-pickup`（worktree，分支 `claude/local-pickup`）。不要 `cd` 到主检出；不要 `git stash`。
- **每个任务结束前必过**（在 `apps/admin` 下）：`npm test`（`node --test src/*.test.ts src/utils/*.test.ts`）与 `npm run build`（= `check-admin-timezone.mjs && tsc && vite build`）。
- **时区闸门**：`apps/admin/src` 内禁止 `getHours/getMinutes/getDate/getDay/getMonth/getFullYear/setDate/setHours/toLocaleString*` 等（见 `scripts/check-admin-timezone.mjs`）。日期键一律用 `utils/time.ts` 的 `todayKey(date)` / `shiftDayKey(n)` / `fmtHHmm` / `fmtDateTime`。
- **`Channel` 类型不改**：`Channel = 'EXPRESS' | 'LOCAL'` 是商品/销售渠道（`readChannel`、商品页在用）。新增 `OrderChannel = Channel | 'PICKUP'` 表示订单履约渠道；只有工作台卡片、`ConfirmSpec.channel`、`chColor`、`FillButton`、`CancelAndRefundModal.channel` 改用它。
- **整包 PUT 合并规则**：任何写 `local_delivery` 的地方，保存前先 `getLocalSettings()` 取最新，再合并；**永不**用页面缓存覆盖 `version`、`paused`、`pickup.paused`、`holiday`、`store.latE6/lngE6`、以及本页不编辑的 `businessHours`（营业时间挪到独立页后，同城设置页保存必须回写 `fresh.businessHours`）。
- **文案逐字**（来自 spec §6 / §1）：徽标「自取」；图例「到店自取」；按钮「接单」「已备好」「已取走」；倒计时「距取餐 N 分」、超时「已过取餐时间 N 分钟」；折叠分组「明日自取」；熔断横幅「快递100 余额不足，外送呼叫已暂停。充值后点「恢复」，或改用「自己送」；自取单不受影响。」；暂停弹窗四项「只暂停外送」「只暂停自取」「全部暂停（今天）」「休业至某日」；统计「自取」；营业时间卡片标题「营业时间（全店统一）」；设置页签「营业时间」；同城订单筛选「全部 / 外送 / 自取」。
- **颜色 token**：`--pickup:#0e7c6b; --pickup-soft:#e3f3ef;`（深色 `--pickup:#5fd3bd; --pickup-soft:#0f2f2b80;`）。经营概览用 `PICKUP_COLOR = '#0d9488'`。
- **自取单没有配送单**：`loadDetail` 对 PICKUP 不请求 `getOrderDelivery` 也不请求 `getExpressBooking`；抽屉不渲染骑手块、报价块、「看进度」。
- **提交**：每个任务至少一个提交，`git add` 只加白名单内文件，提交信息中文、以 `feat(admin)/fix(admin)/test(admin)/docs` 开头，结尾加 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- **不做**（spec §10）：取餐码/二维码核销、按日库存、自取独立菜单、休业影响邮寄、短信。

## 允许修改的文件白名单

```
apps/admin/src/types.ts
apps/admin/src/api/admin.ts
apps/admin/src/utils/pickup.ts                 （新建）
apps/admin/src/utils/pickup.test.ts            （新建）
apps/admin/src/utils/pause-scope.ts            （新建）
apps/admin/src/utils/pause-scope.test.ts       （新建）
apps/admin/src/components/ui/StatusBadge.tsx
apps/admin/src/pages/Workbench.tsx
apps/admin/src/pages/Workbench.css
apps/admin/src/components/CancelAndRefundModal.tsx
apps/admin/src/components/PauseScopeDialog.tsx （新建，Tailwind 版，设置页用）
apps/admin/src/pages/LocalSettings.tsx
apps/admin/src/pages/BusinessHoursSettings.tsx （新建）
apps/admin/src/pages/SettingsCenter.tsx
apps/admin/src/navigation.ts
apps/admin/src/navigation.test.ts
apps/admin/src/App.tsx
apps/admin/src/pages/LocalOrders.tsx
apps/admin/src/components/dashboard/OverviewTab.tsx
apps/admin/src/components/dashboard/StackedBars.tsx（仅 series 注释「1–2 个」→「1–3 个」，Task 6）
apps/server/src/routes/admin/stats/overview.ts  （仅 channel 枚举加 'PICKUP'，Task 6）
apps/server/src/routes/admin/stats/shared.ts    （仅 paidOrdersWhere 的 channel 类型，Task 6）
docs/staff-guide.md
docs/api.md                                     （仅附录 H 补一行 stats overview channel=PICKUP）
docs/superpowers/plans/2026-09-11-local-pickup-batch3-admin.md（本文件：勘误与验收记录）
```

## 上报触发条件（实施方遇到即 BLOCKED，不得自行绕过）

1. 需要改白名单之外的文件（含 `Orders.tsx`、`Products.tsx`、`utils/time.ts`、任何服务端文件除上列两个之外）。
2. 服务端返回的字段名/形状与本计划 §Task 1 的类型不一致（以 `apps/server/src/routes/admin/workbench.ts`、`services/local-settings.ts`、`routes/admin/orders.ts` 为准；发现不一致先停）。
3. `check-admin-timezone.mjs` 报错且无法用 `utils/time.ts` 现有函数解决。
4. `navigation.test.ts` 除本计划 Task 5 指明的两处断言外还有别的断言需要改。
5. 任务要求与 spec 文案冲突、或两任务互相矛盾。
6. `npm run build` 因第三方/环境原因失败（如 node 版本），而非代码原因。

---

## Task 1：类型、API 层、纯函数工具（含单测）

**Files:**
- Modify: `apps/admin/src/types.ts`
- Modify: `apps/admin/src/api/admin.ts`
- Create: `apps/admin/src/utils/pickup.ts`、`apps/admin/src/utils/pickup.test.ts`
- Create: `apps/admin/src/utils/pause-scope.ts`、`apps/admin/src/utils/pause-scope.test.ts`
- Modify: `apps/admin/src/components/ui/StatusBadge.tsx`

**Interfaces:**
- Produces（后续任务全部依赖）：`OrderChannel`、`WorkbenchCard.pickup`、`WorkbenchSnapshot.pickupEnabled/pickupPaused/holiday`、`LocalDeliverySettings.pickup/holiday`、`Order.pickupAt/pickupReadyAt/pickupDiscountAmount`、`OverviewStats.channels.PICKUP`；API：`pickupReadyOrder`、`pickedUpOrder`、`approvePickupCancelRequest`、`rejectPickupCancelRequest`、`pausePickup`、`resumePickup`、`setHoliday`、`clearHoliday`、`getOrders({ channel })`、`getOverviewStats({ channel: 'PICKUP' })`；工具：`pickupCountdown`、`isFutureDayPickup`、`pickupUrgency`、`pickupPendingAnchor`、`PAUSE_SCOPES`、`validatePauseInput`、`pauseStateLines`、`endOfTodayIso`；`orderStatusLabel(status, deliveryType)`。

- [ ] **Step 1：types.ts 加字段**

在 `export type Channel = 'EXPRESS' | 'LOCAL'` 之后加：

```ts
/** 订单履约渠道：在销售渠道之上多一个「到店自取」（商品/购物车仍按 LOCAL 渠道，见 spec P14） */
export type OrderChannel = Channel | 'PICKUP'
```

`WorkbenchCard`：`channel: Channel` 改为 `channel: OrderChannel`；在 `local: {...} | null` 之后加：

```ts
  /** 自取单（deliveryType=PICKUP）。与服务端 workbench.ts toCard 的 pickup 同构 */
  pickup: {
    pickupAt: string | null
    pickupReadyAt: string | null
    /** 开始备餐时刻 = pickupAt − 备餐时长 − acceptBufferMin（服务端 prepStartAt） */
    prepStartAt: string | null
    /** 「今天 12:00–12:30」，服务端按快照时刻算好 */
    slotLabel: string
    cancelRequested: boolean
    cancelRejected: 'AUTO' | 'MANUAL' | null
    acceptedAt: string | null
  } | null
```

`WorkbenchSnapshot`：在 `paused: ...` 之后加：

```ts
  pickupEnabled: boolean
  pickupPaused: { reason: string; until: string | null } | null
  /** 休业总开关（P12）：外送与自取一起停，邮寄不受影响。until 为 'YYYY-MM-DD' 或 null */
  holiday: { until: string | null; reason: string } | null
```

`LocalDeliverySettings`：在 `paused: ...` 之后加：

```ts
  pickup: PickupSettings
  holiday: { until: string | null; reason: string } | null
```

并在该 interface 之前新增：

```ts
export interface PickupSettings {
  enabled: boolean
  paused: { until: string | null; reason: string } | null
  /** 取餐时段粒度（分） */
  slotMinutes: number
  /** 接单缓冲（分）：最早可取 = 现在 + 缓冲 + 备餐，向上取整到粒度 */
  acceptBufferMin: number
  /** 可预订天数：0=仅今天，1=今天+明天 */
  daysAhead: number
  minOrderAmountFen: number
  /** PERCENT 的 value 是「按几折收」（90 = 九折，减 10%）；FIXED 的 value 是立减分数 */
  discount: { type: 'NONE' | 'PERCENT' | 'FIXED'; value: number }
  autoCompleteAfterMin: number
  unpickedRemindAfterMin: number
}
```

`Order`：在 `cancelRequestNote?: string | null` 之后加：

```ts
  /** 自取单：取餐时段起点 / 备好时刻 / 自取优惠（分）。非自取单为 null/0 */
  pickupAt?: string | null
  pickupReadyAt?: string | null
  pickupDiscountAmount?: number
```

`OverviewStats`：`channels: { LOCAL: ChannelAgg; EXPRESS: ChannelAgg }` 改为 `channels: { LOCAL: ChannelAgg; EXPRESS: ChannelAgg; PICKUP: ChannelAgg }`；`trend` 元素同样加 `PICKUP: ChannelAgg`。

- [ ] **Step 2：api/admin.ts 加端点**

`getOrders` 参数改为：

```ts
export const getOrders = (params?: {
  page?: number
  pageSize?: number
  status?: string
  /** 订单号 / 收货人 / 手机号 模糊 */
  keyword?: string
  deliveryType?: 'EXPRESS' | 'LOCAL' | 'PICKUP' | 'ALL'
  /** channel=LOCAL 一次看外送 + 自取；与 deliveryType 二选一；同时传时服务端以 channel 为准（routes/admin/orders.ts），所以调用方只传其一 */
  channel?: 'LOCAL' | 'EXPRESS'
}) => client.get<ApiResponse<PaginatedData<Order>>>('/admin/orders', { params })
```

在 `rejectCancelRequest` 附近加：

```ts
// ── 到店自取（spec 2026-09-11 §4.4；服务端 routes/admin/orders.ts）──
/** PREPARING → SHIPPED（待取餐），发取餐提醒；有未处理取消申请视同驳回 */
export const pickupReadyOrder = (id: number) => client.post<ApiResponse<Order>>(`/admin/orders/${id}/pickup-ready`)
/** SHIPPED（待取餐）→ COMPLETED */
export const pickedUpOrder = (id: number) => client.post<ApiResponse<Order>>(`/admin/orders/${id}/picked-up`)
/** 同意自取单的取消申请 = 全额退并清标记 */
export const approvePickupCancelRequest = (id: number) =>
  client.post<ApiResponse<unknown>>(`/admin/orders/${id}/cancel-request/approve`)
export const rejectPickupCancelRequest = (id: number) =>
  client.post<ApiResponse<Order>>(`/admin/orders/${id}/cancel-request/reject`)
```

在 `resumeLocal` 之后加（整包 PUT 合并，理由见 Global Constraints）：

```ts
/** 读最新设置再整包写回一个补丁——服务端只有 paused 有专用端点，pickup.paused 与 holiday 走整包 PUT */
async function patchLocalSettingsMerged(mutate: (fresh: LocalDeliverySettings) => LocalDeliverySettings) {
  const fresh = await getLocalSettings()
  return updateLocalSettings(mutate(fresh))
}
export const pausePickup = (reason: string, until: string | null = null) =>
  patchLocalSettingsMerged((f) => ({ ...f, pickup: { ...f.pickup, paused: { reason, until } } }))
export const resumePickup = () =>
  patchLocalSettingsMerged((f) => ({ ...f, pickup: { ...f.pickup, paused: null } }))
/** until = 'YYYY-MM-DD'（含当天仍休业，次日恢复），null = 手动恢复 */
export const setHoliday = (until: string | null, reason: string) =>
  patchLocalSettingsMerged((f) => ({ ...f, holiday: { until, reason } }))
export const clearHoliday = () => patchLocalSettingsMerged((f) => ({ ...f, holiday: null }))
```

`getOverviewStats` 的 `channel` 类型改为 `'ALL' | 'LOCAL' | 'EXPRESS' | 'PICKUP'`。

- [ ] **Step 3：写 `utils/pickup.test.ts`（先写测试）**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickupCountdown, isFutureDayPickup, pickupUrgency, pickupPendingAnchor } from './pickup.ts'

// 2026-09-11 12:00 Asia/Shanghai = 04:00Z
const NOON = Date.parse('2026-09-11T04:00:00Z')
const min = (n: number) => n * 60_000

test('pickupCountdown：未到点显示「距取餐 N 分」，向上取整', () => {
  assert.deepEqual(pickupCountdown(new Date(NOON + min(25)).toISOString(), NOON), { text: '距取餐 25 分', overdueMin: 0 })
  assert.deepEqual(pickupCountdown(new Date(NOON + min(0.4)).toISOString(), NOON), { text: '距取餐 1 分', overdueMin: 0 })
})

test('pickupCountdown：过点显示「已过取餐时间 N 分钟」，向下取整', () => {
  assert.deepEqual(pickupCountdown(new Date(NOON - min(40.9)).toISOString(), NOON), { text: '已过取餐时间 40 分钟', overdueMin: 40 })
  assert.deepEqual(pickupCountdown(new Date(NOON).toISOString(), NOON), { text: '已过取餐时间 0 分钟', overdueMin: 0 })
})

test('isFutureDayPickup：按上海日历日比较，不按 24 小时', () => {
  // 今天 23:30 取 → 不是明日
  assert.equal(isFutureDayPickup('2026-09-11T15:30:00Z', NOON), false)
  // 明天 00:30 取 → 明日（上海 2026-09-12）
  assert.equal(isFutureDayPickup('2026-09-11T16:30:00Z', NOON), true)
  assert.equal(isFutureDayPickup(null, NOON), false)
})

test('pickupUrgency：备餐中看离取餐还剩多久；待取餐过点转琥珀；明日单永不点亮', () => {
  const p = (pickupAt: number, prepStartAt = pickupAt - min(25)) => ({
    pickupAt: new Date(pickupAt).toISOString(), prepStartAt: new Date(prepStartAt).toISOString(),
  })
  assert.equal(pickupUrgency('preparing', p(NOON + min(30)), NOON), '')
  assert.equal(pickupUrgency('preparing', p(NOON + min(15)), NOON), 'warn')
  assert.equal(pickupUrgency('preparing', p(NOON + min(5)), NOON), 'late')
  assert.equal(pickupUrgency('preparing', p(NOON - min(1)), NOON), 'late')
  assert.equal(pickupUrgency('delivering', p(NOON + min(5)), NOON), '')
  assert.equal(pickupUrgency('delivering', p(NOON - min(1)), NOON), 'warn')
  assert.equal(pickupUrgency('pending', p(NOON + min(5)), NOON), '')
  assert.equal(pickupUrgency('done', p(NOON - min(60)), NOON), '')
  // 明天的单：哪一列都不点亮
  assert.equal(pickupUrgency('preparing', p(NOON + min(24 * 60)), NOON), '')
})

test('pickupPendingAnchor：待接单计时从 max(付款, 开始备餐−15分) 起算', () => {
  const paid = new Date(NOON - min(10)).toISOString()
  // 开始备餐在 2 小时后 → 锚点 = 开始备餐−15 分（还在未来）
  assert.equal(pickupPendingAnchor(paid, new Date(NOON + min(120)).toISOString()), NOON + min(105))
  // 开始备餐 5 分钟前 → 锚点 = 付款时刻
  assert.equal(pickupPendingAnchor(paid, new Date(NOON - min(5)).toISOString()), NOON - min(10))
  // 没有 prepStartAt → 付款时刻
  assert.equal(pickupPendingAnchor(paid, null), NOON - min(10))
})
```

- [ ] **Step 4：跑测试确认失败**

Run: `cd apps/admin && npm test`
Expected: FAIL（`./pickup.ts` 不存在）。

- [ ] **Step 5：写 `utils/pickup.ts`**

```ts
/**
 * 自取单在工作台上的时间语义（spec 2026-09-11 §6.1、P9）。全部是纯函数，便于单测；
 * 日期比较走 utils/time 的 todayKey（Asia/Shanghai），不碰本地时区 API（见 scripts/check-admin-timezone.mjs）。
 */
import { todayKey } from './time'

export type PickupUrgency = '' | 'warn' | 'late'
export type PickupColKey = 'pending' | 'preparing' | 'waitingCourier' | 'delivering' | 'done'

/** 备餐中：距取餐 ≤15 分琥珀、≤5 分（含已过点）红——与同城「预计送达」同一把尺子 */
const PICKUP_WARN_MIN = 15
const PICKUP_LATE_MIN = 5
/** 待接单计时提前量：与服务端 remindPickupUnaccepted 的「开始备餐 −15 分」同口径 */
const PENDING_LEAD_MIN = 15

/** 「距取餐 N 分」/「已过取餐时间 N 分钟」（文案见 spec §6.1） */
export function pickupCountdown(pickupAt: string, now: number): { text: string; overdueMin: number } {
  const left = (Date.parse(pickupAt) - now) / 60_000
  if (left > 0) return { text: `距取餐 ${Math.ceil(left)} 分`, overdueMin: 0 }
  const over = Math.floor(-left)
  return { text: `已过取餐时间 ${over} 分钟`, overdueMin: over }
}

/** 取餐日不是今天（上海日历日）→ 收进「明日自取」折叠组 */
export function isFutureDayPickup(pickupAt: string | null | undefined, now: number): boolean {
  if (!pickupAt) return false
  return todayKey(new Date(pickupAt)) !== todayKey(new Date(now))
}

export function pickupUrgency(
  colKey: PickupColKey,
  p: { pickupAt: string | null; prepStartAt: string | null },
  now: number,
): PickupUrgency {
  if (!p.pickupAt || colKey === 'done' || colKey === 'pending' || colKey === 'waitingCourier') return ''
  if (isFutureDayPickup(p.pickupAt, now)) return ''
  const left = (Date.parse(p.pickupAt) - now) / 60_000
  if (colKey === 'preparing') {
    if (left <= PICKUP_LATE_MIN) return 'late'
    if (left <= PICKUP_WARN_MIN) return 'warn'
    return ''
  }
  // delivering = 待取餐：过了取餐时间转琥珀（spec：过时未取卡片橙色），不升红——红留给退菜/异常
  return left <= 0 ? 'warn' : ''
}

/** 待接单的等待锚点：明天/下午的单不该从付款那一刻就开始「烧」，从开始备餐前 15 分钟起算 */
export function pickupPendingAnchor(waitSince: string, prepStartAt: string | null): number {
  const paid = Date.parse(waitSince)
  if (!prepStartAt) return paid
  const lead = Date.parse(prepStartAt) - PENDING_LEAD_MIN * 60_000
  return Number.isFinite(lead) ? Math.max(paid, lead) : paid
}
```

- [ ] **Step 6：写 `utils/pause-scope.test.ts`**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PAUSE_SCOPES, validatePauseInput, pauseStateLines, endOfTodayIso } from './pause-scope.ts'

test('四个范围的顺序与文案（spec §6.1）', () => {
  assert.deepEqual(PAUSE_SCOPES.map((s) => s.key), ['DELIVERY', 'PICKUP', 'ALL_TODAY', 'HOLIDAY'])
  assert.deepEqual(PAUSE_SCOPES.map((s) => s.label), ['只暂停外送', '只暂停自取', '全部暂停（今天）', '休业至某日'])
})

test('validatePauseInput：原因必填；休业日期必填且不早于今天', () => {
  assert.equal(validatePauseInput('DELIVERY', { reason: ' ', until: '' }, '2026-09-11'), '请填写原因（顾客可见）')
  assert.equal(validatePauseInput('DELIVERY', { reason: '临时暂停', until: '' }, '2026-09-11'), null)
  assert.equal(validatePauseInput('HOLIDAY', { reason: '国庆休业', until: '' }, '2026-09-11'), '请选择恢复营业日期')
  assert.equal(validatePauseInput('HOLIDAY', { reason: '国庆休业', until: '2026-09-10' }, '2026-09-11'), '恢复日期不能早于今天')
  assert.equal(validatePauseInput('HOLIDAY', { reason: '国庆休业', until: '2026-09-11' }, '2026-09-11'), null)
})

test('pauseStateLines：按休业 > 外送 > 自取列出当前状态', () => {
  assert.deepEqual(pauseStateLines({ paused: null, pickupPaused: null, holiday: null, pickupEnabled: true }), [])
  assert.deepEqual(
    pauseStateLines({ paused: { reason: '下雨', until: null }, pickupPaused: { reason: '人手不够', until: null }, holiday: { until: '2026-10-07', reason: '国庆' }, pickupEnabled: true }),
    [
      { key: 'HOLIDAY', text: '休业中：国庆（10-07 后恢复）' },
      { key: 'DELIVERY', text: '外送已暂停：下雨' },
      { key: 'PICKUP', text: '自取已暂停：人手不够' },
    ],
  )
  // 自取没开通时不列自取那行（没开通谈不上暂停）
  assert.deepEqual(
    pauseStateLines({ paused: null, pickupPaused: { reason: 'x', until: null }, holiday: { until: null, reason: '装修' }, pickupEnabled: false }),
    [{ key: 'HOLIDAY', text: '休业中：装修（手动恢复）' }],
  )
})

test('endOfTodayIso：上海当天 23:59:59 的 ISO', () => {
  assert.equal(endOfTodayIso('2026-09-11'), '2026-09-11T15:59:59.000Z')
})
```

- [ ] **Step 7：写 `utils/pause-scope.ts`**

```ts
/**
 * 「暂停接单」四选一（spec 2026-09-11 §6.1，P12）。工作台弹窗与同城设置页的对话框共用这里的
 * 文案、校验与状态行；真正调接口的顺序在 api/admin.ts（pauseLocal / pausePickup / setHoliday）。
 */
export type PauseScope = 'DELIVERY' | 'PICKUP' | 'ALL_TODAY' | 'HOLIDAY'

export const PAUSE_SCOPES: { key: PauseScope; label: string; hint: string }[] = [
  { key: 'DELIVERY', label: '只暂停外送', hint: '顾客仍可下自取单；到恢复前外送入口显示暂停原因' },
  { key: 'PICKUP', label: '只暂停自取', hint: '顾客仍可下外送单；自取结算页显示暂停原因' },
  { key: 'ALL_TODAY', label: '全部暂停（今天）', hint: '外送与自取都停，今天 24:00 自动恢复；邮寄不受影响' },
  { key: 'HOLIDAY', label: '休业至某日', hint: '节假日/装修整店停，含所选日期当天，次日自动恢复；邮寄不受影响' },
]

export interface PauseInput { reason: string; until: string }

/** 返回错误文案；null = 通过。todayKey 由调用方传入（utils/time.todayKey()），便于单测 */
export function validatePauseInput(scope: PauseScope, input: PauseInput, todayKey: string): string | null {
  if (!input.reason.trim()) return '请填写原因（顾客可见）'
  if (scope === 'HOLIDAY') {
    if (!input.until) return '请选择恢复营业日期'
    if (input.until < todayKey) return '恢复日期不能早于今天'
  }
  return null
}

export interface PauseState {
  paused: { reason: string; until: string | null } | null
  pickupPaused: { reason: string; until: string | null } | null
  holiday: { until: string | null; reason: string } | null
  pickupEnabled: boolean
}

export function pauseStateLines(s: PauseState): { key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP'; text: string }[] {
  const out: { key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP'; text: string }[] = []
  if (s.holiday) out.push({ key: 'HOLIDAY', text: `休业中：${s.holiday.reason || '休业'}（${s.holiday.until ? `${s.holiday.until.slice(5)} 后恢复` : '手动恢复'}）` })
  if (s.paused) out.push({ key: 'DELIVERY', text: `外送已暂停：${s.paused.reason || '手动暂停'}` })
  if (s.pickupEnabled && s.pickupPaused) out.push({ key: 'PICKUP', text: `自取已暂停：${s.pickupPaused.reason || '手动暂停'}` })
  return out
}

/** 「全部暂停（今天）」的截止时刻：上海当天 23:59:59。todayKey 形如 '2026-09-11' */
export function endOfTodayIso(todayKey: string): string {
  return new Date(`${todayKey}T23:59:59+08:00`).toISOString()
}
```

- [ ] **Step 8：`api/admin.ts` 加 `applyPauseScope`**

紧接 `clearHoliday` 之后：

```ts
import type { PauseScope } from '../utils/pause-scope'   // 放到文件顶部 import 区
import { endOfTodayIso } from '../utils/pause-scope'
import { todayKey } from '../utils/time'

/** 四选一落地。ALL_TODAY 两个开关都写同一个 until（上海当天 23:59:59），服务端 isPaused/isPickupPaused 按 until 自动失效 */
export async function applyPauseScope(scope: PauseScope, input: { reason: string; until: string }) {
  const reason = input.reason.trim()
  switch (scope) {
    case 'DELIVERY': return pauseLocal(reason)
    case 'PICKUP': return pausePickup(reason)
    case 'ALL_TODAY': {
      const until = endOfTodayIso(todayKey())
      await pauseLocal(reason, until)
      return pausePickup(reason, until)
    }
    case 'HOLIDAY': return setHoliday(input.until, reason)
  }
}
```

- [ ] **Step 9：StatusBadge 加自取文案**

在 `STATUS_MAP` 之后、`interface StatusBadgeProps` 之前加：

```ts
/** 自取单复用 PAID/SHIPPED/COMPLETED 三个状态，但店员看到的词不同（spec P8） */
const PICKUP_STATUS_LABEL: Record<string, string> = { PAID: '待接单', SHIPPED: '待取餐', COMPLETED: '已取餐' }
/** 同城外送的 SHIPPED 是「配送中」——StatusBadge 默认是邮寄的「已发货」 */
const LOCAL_STATUS_LABEL: Record<string, string> = { SHIPPED: '配送中' }

export function orderStatusLabel(status: string, deliveryType?: string | null): string {
  const base = STATUS_MAP[status]?.label ?? status
  if (deliveryType === 'PICKUP') return PICKUP_STATUS_LABEL[status] ?? base
  if (deliveryType === 'LOCAL') return LOCAL_STATUS_LABEL[status] ?? base
  return base
}
```

`StatusBadgeProps` 加 `deliveryType?: string | null`，组件内 `{label ?? orderStatusLabel(status, deliveryType)}`（`orderStatusLabel` 对非订单状态返回 `conf.label`，行为不变）。

- [ ] **Step 10：跑测试与构建**

Run: `cd apps/admin && npm test && npm run build`
Expected: 全绿（新增 9 个 test 通过；`tsc` 通过——`WorkbenchCard.channel` 改为 `OrderChannel` 后若 `Workbench.tsx`/`CancelAndRefundModal.tsx` 报类型错，只做**最小**改动让它们编译：`chColor` 加 `c === 'PICKUP' ? 'var(--pickup)'` 分支、`ConfirmSpec.channel`/`FillButton.channel`/`CancelAndRefundModal.channel`/`renderModal` 的 `ch` 改为 `OrderChannel`；不改任何行为。不在此任务写自取按钮）。

- [ ] **Step 11：提交**

```bash
git add apps/admin/src/types.ts apps/admin/src/api/admin.ts apps/admin/src/utils/pickup.ts apps/admin/src/utils/pickup.test.ts apps/admin/src/utils/pause-scope.ts apps/admin/src/utils/pause-scope.test.ts apps/admin/src/components/ui/StatusBadge.tsx apps/admin/src/pages/Workbench.tsx apps/admin/src/components/CancelAndRefundModal.tsx
git commit -m "feat(admin): 自取类型、API 层与纯函数工具（取餐倒计时/明日折叠/暂停范围）"
```

---

## Task 2：工作台——自取卡片、顶栏、图例、熔断文案

**Files:**
- Modify: `apps/admin/src/pages/Workbench.tsx`（`Card`、`urgencyOf`、`dwellBudget`、`openStateOf`、`TopBar`、`TopAlerts`、`LegendContent`、`HintContent`、手机「⋯」层、列渲染的折叠组）
- Modify: `apps/admin/src/pages/Workbench.css`

**Interfaces:**
- Consumes：Task 1 的 `card.pickup`、`snap.pickupEnabled/pickupPaused/holiday`、`utils/pickup`。
- Produces：`Card` 对 `channel==='PICKUP'` 的渲染；`pickupOnBoard(snap)` 计数；折叠组状态 `tomorrowOpen`。

- [ ] **Step 1：CSS token 与类**

`Workbench.css` 第 4 行 `.wb {` 的变量里加 `--pickup:#0e7c6b; --pickup-soft:#e3f3ef;`；两处深色块（`.wb[data-theme="dark"]` 与 `.wb:not([data-theme="light"])` 的媒体查询）各加 `--pickup:#5fd3bd; --pickup-soft:#0f2f2b80;`。

在 `.wb__card--express::before` 之后加 `.wb__card--pickup::before { background:var(--pickup); }`；在 `.wb__badge--express` 之后加 `.wb__badge--pickup { background:var(--pickup-soft); color:var(--pickup); }`。

文件末尾加折叠组样式：

```css
/* 「明日自取」折叠组：列底部一条可点开的分割，收起时只占一行（spec §6.1） */
.wb__fold { margin-top:8px; border-top:1px dashed var(--line); padding-top:6px; }
.wb__fold-t { display:flex; align-items:center; justify-content:space-between; width:100%;
  background:none; border:0; padding:4px 2px; font:inherit; font-size:12px; color:var(--text-2); cursor:pointer; }
.wb__fold-t b { color:var(--pickup); font-variant-numeric:tabular-nums; }
```

- [ ] **Step 2：`Workbench.tsx` 顶部 import 与工具**

import 行加 `Store` 图标：`import { Bell, Bike, CircleAlert, CircleQuestionMark, Copy, Ellipsis, LogOut, Maximize, Moon, Package, Phone, Printer, Store, Sun, X } from 'lucide-react'`。
加 `import { pickupCountdown, isFutureDayPickup, pickupUrgency, pickupPendingAnchor } from '../utils/pickup'`。
类型 import 里加 `OrderChannel`。

`chColor` 改为：

```ts
const chColor = (c: OrderChannel) => (c === 'LOCAL' ? 'var(--local)' : c === 'PICKUP' ? 'var(--pickup)' : 'var(--express)')
```

新增（放在 `openStateOf` 前）：

```ts
/** 渠道徽标：三处（卡片、抽屉头、图例）共用同一份图标与文案 */
function ChannelBadge({ channel }: { channel: OrderChannel }) {
  const cls = channel === 'LOCAL' ? 'wb__badge--local' : channel === 'PICKUP' ? 'wb__badge--pickup' : 'wb__badge--express'
  const Icon = channel === 'LOCAL' ? Bike : channel === 'PICKUP' ? Store : Package
  return (
    <span className={`wb__badge ${cls}`}>
      <Icon className="w-3.5 h-3.5" />
      {channel === 'LOCAL' ? '同城配送' : channel === 'PICKUP' ? '自取' : '全国邮寄'}
    </span>
  )
}

/** 看板上自取单张数（五列合计）——顶栏「自取 N」用 */
function pickupOnBoard(snap: WorkbenchSnapshot | null): number {
  if (!snap) return 0
  return COLUMNS.reduce((n, c) => n + snap.columns[c.key].filter((x) => x.channel === 'PICKUP').length, 0)
}
```

`openStateOf` 改为（休业优先；外送暂停措辞点明「外送」）：

```ts
function openStateOf(snap: WorkbenchSnapshot | null): { text: string; cls: string } {
  if (!snap) return { text: '加载中', cls: '' }
  if (snap.holiday) return { text: `休业中${snap.holiday.until ? `，${snap.holiday.until.slice(5)} 后恢复` : ''}`, cls: 'wb__dot--danger' }
  if (snap.paused) return { text: `外送已暂停：${snap.paused.reason || '手动暂停'}`, cls: 'wb__dot--danger' }
  if (!snap.localEnabled) return { text: '同城已关闭', cls: '' }
  return snap.localOpenNow ? { text: '营业中', cls: 'wb__dot--ok' } : { text: '非营业时间', cls: 'wb__dot--warn' }
}

/** 顶栏第二盏灯：自取开放/暂停。没开通就不显示（返回 null） */
function pickupStateOf(snap: WorkbenchSnapshot | null): { text: string; cls: string } | null {
  if (!snap || !snap.pickupEnabled) return null
  if (snap.holiday) return { text: '自取休业', cls: 'wb__dot--danger' }
  if (snap.pickupPaused) return { text: `自取已暂停：${snap.pickupPaused.reason || '手动暂停'}`, cls: 'wb__dot--warn' }
  return { text: '自取开放', cls: 'wb__dot--ok' }
}
```

- [ ] **Step 3：`dwellBudget` 与 `urgencyOf`**

`dwellBudget(colKey, channel: OrderChannel, prepMin)`：开头加 `if (channel === 'PICKUP') return colKey === 'pending' ? [2, 5] : null`（自取备餐中/待取餐看取餐时刻，不看停留时长）。

`urgencyOf` 改为：

```ts
function urgencyOf(card: WorkbenchCard, colKey: ColKey, now: number, prepMin: number): Urgency {
  if (colKey === 'done') return ''
  // 明天的自取单在哪一列都不点亮：它的所有时限都在明天
  if (card.channel === 'PICKUP' && isFutureDayPickup(card.pickup?.pickupAt, now)) return ''
  let u: Urgency = ''
  const budget = dwellBudget(colKey, card.channel, prepMin)
  if (budget) {
    // 自取待接单从「开始备餐 −15 分」起算（下午的单不该从付款起就烧红）
    const since = card.channel === 'PICKUP' && card.pickup ? pickupPendingAnchor(card.waitSince, card.pickup.prepStartAt) : Date.parse(card.waitSince)
    const min = (now - since) / 60_000
    if (min >= budget[1]) u = 'late'
    else if (min >= budget[0]) u = 'warn'
  }
  const est = card.local?.estimatedDeliveryAt
  if (est) {
    const left = (Date.parse(est) - now) / 60_000
    if (left <= DEADLINE_LATE_MIN) u = 'late'
    else if (left <= DEADLINE_WARN_MIN && u !== 'late') u = 'warn'
  }
  if (card.channel === 'PICKUP' && card.pickup) {
    const pu = pickupUrgency(colKey, card.pickup, now)
    if (pu === 'late') u = 'late'
    else if (pu === 'warn' && u !== 'late') u = 'warn'
  }
  return u
}
```

- [ ] **Step 4：`Card` 自取渲染**

在 `Card` 内：

```ts
  const local = card.channel === 'LOCAL'
  const pickup = card.channel === 'PICKUP' ? card.pickup : null
  ...
  const cancelState = card.local ?? card.express ?? card.pickup
  ...
  // 自取：等待锚点可能在未来（明天/下午的单），那时胶囊写「HH:mm 开始备餐」而不是负数计时
  const pickupAnchor = pickup && colKey === 'pending' ? pickupPendingAnchor(card.waitSince, pickup.prepStartAt) : null
  const w = colKey === 'done'
    ? { text: `完成于 ${hhmm(card.waitSince)}`, cls: '' }
    : pickupAnchor != null && pickupAnchor > now && pickup?.prepStartAt
      ? { text: `${hhmm(pickup.prepStartAt)} 开始备餐`, cls: '' }
      : pickup && colKey !== 'pending'
        ? { text: pickupCountdown(pickup.pickupAt ?? card.waitSince, now).text, cls: urg ? `wb__wait--${urg}` : '' }
        : waitLabel(pickupAnchor != null ? new Date(pickupAnchor).toISOString() : card.waitSince, now, urg)
```

> `waitLabel` 返回的 `cls` 是什么命名就沿用什么：先读 `waitLabel` 的实现，把上面 `wb__wait--${urg}` 换成它实际用的类名（保持琥珀/红与同城一致）。

卡片根 className：`${local ? 'wb__card--local' : pickup ? 'wb__card--pickup' : 'wb__card--express'}`；顶部徽标换成 `<ChannelBadge channel={card.channel} />`（把原来的 `local ? <Bike…> : <Package…>` 那一段整体替换）。

`wb__fields` 里在 `local ? (...) : (...)` 前加自取分支：

```tsx
        {pickup ? (
          <>
            <span>取餐 {pickup.slotLabel || hhmm(pickup.pickupAt)}</span>
            {colKey === 'delivering' && <span>已备好 {hhmm(pickup.pickupReadyAt)}</span>}
            {colKey === 'done' && <span>已取餐</span>}
          </>
        ) : local ? ( …原样… ) : ( …原样… )}
```

取消申请条：自取没有超时自动驳回（P10），倒计时不显示；驳回按钮对自取也显示：

```tsx
          <span>顾客要退菜{card.channel === 'PICKUP' ? '' : (autoRejectLeft(cancelState.acceptedAt, graceMin, now) ?? '')}</span>
          ...
            {card.channel !== 'LOCAL' && <button className="wb__iconbtn" onClick={(e) => { e.stopPropagation(); onReject() }}>驳回</button>}
```

把原来的注释「同城 LOCAL 在 main 上从来没有手动驳回按钮…」改成「同城 LOCAL 在 main 上从来没有手动驳回按钮，只有超时自动驳回；邮寄与自取（P10：自取不自动驳回，店员必须决定）都有」。

`urg` 的计算不变（`alert ? 'late' : urgencyOf(...)`），但 `w` 需要 `urg`，所以把 `const urg = …` 挪到 `const w = …` 之前（原文件里 `urg` 本来就在 `w` 前，确认顺序即可）。

- [ ] **Step 5：列渲染的「明日自取」折叠组**

主组件 state 加 `const [tomorrowOpen, setTomorrowOpen] = useState<Record<string, boolean>>({})`。

列渲染里把 `list` 拆分（放在 `const collapsed = …` 之前）：

```ts
          // 明天的自取单默认折叠到列底（spec §6.1）；开始备餐时刻一到自然是「今天」，会自动回到正常列
          const tomorrow = col.key === 'done' ? [] : list.filter((c) => c.channel === 'PICKUP' && isFutureDayPickup(c.pickup?.pickupAt, now))
          const todayList = tomorrow.length ? list.filter((c) => !tomorrow.includes(c)) : list
```

`wb__col-body` 内容改为：

```tsx
              <div className="wb__col-body">
                {todayList.length === 0 && tomorrow.length === 0
                  ? <div className="wb__empty">{snap ? '暂无订单' : '加载中…'}</div>
                  : todayList.map((c) => (<Card …原样… />))}
                {tomorrow.length > 0 && (
                  <div className="wb__fold">
                    <button type="button" className="wb__fold-t"
                      onClick={() => setTomorrowOpen((m) => ({ ...m, [col.key]: !m[col.key] }))}>
                      <span>明日自取 <b>{tomorrow.length}</b></span>
                      <span>{tomorrowOpen[col.key] ? '收起' : '展开'}</span>
                    </button>
                    {tomorrowOpen[col.key] && tomorrow.map((c) => (<Card …与上面同一份 props… />))}
                  </div>
                )}
              </div>
```

> 两处 `<Card>` 的 props 完全相同：抽成列内的一个 `const renderCard = (c: WorkbenchCard) => (<Card … />)` 再各调一次，别复制两份。`graceMin` 对 PICKUP 传 `snap?.acceptGraceMin ?? 0`（只有倒计时会用到，而自取不显示倒计时）。

- [ ] **Step 6：顶栏、告警横幅、图例、说明、手机层**

`TopBar`：`openState` 后面加第二盏灯：

```tsx
          {(() => { const ps = pickupStateOf(snap); return ps ? <span className="wb__meta"><i className={`wb__dot ${ps.cls}`} />{ps.text}</span> : null })()}
```

统计区在「平均送达」之后加 `<span>自取<b>{snap ? pickupOnBoard(snap) : '--'}</b></span>`。

`TopAlerts` 熔断横幅文案改为：`快递100 余额不足，外送呼叫已暂停。充值后点「恢复」，或改用「自己送」；自取单不受影响。`

`LegendContent` 第一组在邮寄之后加：

```tsx
        <span className="wb__badge wb__badge--pickup"><Store className="w-3.5 h-3.5" />到店自取</span>
        <span>顾客来店取，排在同城之下、邮寄之上</span>
```

`HintContent` 末尾追加一句：`自取单：备餐中看离取餐时间（≤15 分转琥珀、≤5 分转红），待取餐过了取餐时间转琥珀；明天的单收在「明日自取」里不计时。`

手机「⋯」层（`sheet === 'menu'`）在「平均送达」那行之后加 `<div className="wb__sheet-row"><span>自取</span><b>{snap ? pickupOnBoard(snap) : '--'}</b></div>`。

`PhoneTopBar` 若渲染 `openStateOf`，不加第二盏灯（手机顶栏空间不够，spec 未要求）。

- [ ] **Step 7：构建**

Run: `cd apps/admin && npm test && npm run build`
Expected: 全绿。

- [ ] **Step 8：提交**

```bash
git add apps/admin/src/pages/Workbench.tsx apps/admin/src/pages/Workbench.css
git commit -m "feat(admin): 工作台自取卡片、明日自取折叠、顶栏自取状态与计数、熔断文案"
```

---

## Task 3：工作台——自取操作区、抽屉、取消申请处理

**Files:**
- Modify: `apps/admin/src/pages/Workbench.tsx`（`loadDetail`、`rejectCancelSpec`、`renderActions`、`renderDrawer`、`renderModal`）
- Modify: `apps/admin/src/components/CancelAndRefundModal.tsx`

**Interfaces:**
- Consumes：Task 1 的 `pickupReadyOrder/pickedUpOrder/approvePickupCancelRequest/rejectPickupCancelRequest`、`orderStatusLabel`；Task 2 的 `ChannelBadge`。

- [ ] **Step 1：`loadDetail` 跳过配送/预约**

```ts
      const [o, d, eb] = await Promise.all([
        getOrder(orderId),
        channel === 'LOCAL' ? getOrderDelivery(orderId) : null,
        channel === 'EXPRESS' ? getExpressBooking(orderId) : null,
      ])
```
已经按渠道判断，PICKUP 两个都是 null——确认签名 `channel: OrderChannel` 即可，不需别的改动。

- [ ] **Step 2：`rejectCancelSpec` 分三路**

```ts
    run: () => (card.channel === 'EXPRESS' ? rejectExpressCancelRequest(card.orderId)
      : card.channel === 'PICKUP' ? rejectPickupCancelRequest(card.orderId)
        : rejectCancelRequest(card.orderId)),
```
`what` 文案改为「顾客的取消申请被驳回，订单继续制作/备货；顾客端显示「商家未同意取消」。」（已是），不动。

- [ ] **Step 3：`renderActions` 自取矩阵**

在 `if (colKey === 'pending') {` 之前加：

```ts
    // ── 自取（spec §6.1）：只有三颗状态键 + 打给顾客。没有骑手、自送、小费、进度。──
    if (ch === 'PICKUP') {
      const pk = card.pickup
      const cancelPending = !!pk?.cancelRequested
      if (colKey === 'pending') {
        btns.push(fill('accept', '接单', () => confirm({
          title: '接单', channel: ch, confirmText: '确认接单', okMsg: '已接单',
          what: `订单转入「备餐中」。${pk?.prepStartAt ? `建议 ${hhmm(pk.prepStartAt)} 开始备餐，` : ''}做好后点「已备好」通知顾客来取。`,
          customer: '顾客小程序显示「商家已接单」。',
          cost: '不产生任何费用。',
          run: () => acceptOrder(order.id),
        })))
      }
      if (colKey === 'preparing') {
        btns.push(fill('ready', '已备好', () => confirm({
          title: '已备好', channel: ch, confirmText: '确认已备好', okMsg: '已通知顾客取餐',
          what: '订单转「待取餐」，给顾客发取餐提醒。',
          customer: '顾客收到「可以来取餐了」的提醒，小程序显示「待取餐」。',
          cost: '不产生费用。',
          amber: cancelPending ? '这单有未处理的取消申请：点「已备好」视同驳回申请，顾客端会显示「商家未同意取消」。' : undefined,
          run: () => pickupReadyOrder(order.id),
        })))
      }
      if (colKey === 'delivering') {
        btns.push(fill('picked', '已取走', () => confirm({
          title: '已取走', channel: ch, confirmText: '确认已取走', okMsg: '已完成',
          what: '顾客已把餐取走，订单转「已完成」。',
          customer: '顾客小程序显示「已取餐」，之后可以评价或申请售后。',
          cost: '不产生费用。',
          run: () => pickedUpOrder(order.id),
        })))
      }
      if (order.receiverPhone) btns.push(tel('call-customer', '打给顾客', order.receiverPhone))
      return btns
    }
```

`hhmm` 是文件里已有的工具（抽屉在用），确认其签名接受 `string | null | undefined`。

- [ ] **Step 4：抽屉**

`renderDrawer` 内加 `const pickup = card.channel === 'PICKUP' ? card.pickup : null`。

抽屉头徽标换 `<ChannelBadge channel={card.channel} />`。

状态行：`<StatusBadge status={o?.status ?? card.status} deliveryType={o?.deliveryType ?? card.channel} />`。

「收货信息」块：自取单标题改「取餐信息」，地址行不显示，换成取餐时段/开始备餐/备好/取走：

```tsx
            <div className="wb__block">
              <div className="wb__block-t">{pickup ? '取餐信息' : '收货信息'}</div>
              <div className="wb__line"><span>{pickup ? '取餐人' : '收货人'}</span><span>{o?.receiverName ?? card.receiver.name}</span></div>
              <div className="wb__line">…电话行原样…</div>
              {pickup ? (
                <>
                  <div className="wb__line"><span>取餐时段</span><span>{pickup.slotLabel || hhmm(pickup.pickupAt)}</span></div>
                  <div className="wb__line"><span>开始备餐</span><span>{hhmm(pickup.prepStartAt)}</span></div>
                  {pickup.pickupReadyAt && <div className="wb__line"><span>已备好</span><span>{dateTime(pickup.pickupReadyAt)}</span></div>}
                  {!!o?.completedAt && <div className="wb__line"><span>已取走</span><span>{dateTime(o.completedAt)}</span></div>}
                </>
              ) : (
                <>
                  <div className="wb__line"><span>地址</span>…原样…</div>
                  {local ? ( …原样… ) : ( …原样… )}
                </>
              )}
            </div>
```

金额明细：在「优惠券」行之前加自取优惠行（顺序与小程序结算页一致：小计 → 自取优惠 → 券）：

```tsx
              {!!o?.pickupDiscountAmount && <div className="wb__line"><span>自取优惠</span><span className="wb__amt">-¥{yuan(o.pickupDiscountAmount)}</span></div>}
```

「配送费/运费」行对自取显示 `¥0.00` 即可（服务端 shippingFee=0），不改。

- [ ] **Step 5：`CancelAndRefundModal` 自取分支**

Props：`channel: OrderChannel`；`chColor` 加 PICKUP 分支：`c === 'LOCAL' ? 'var(--local)' : c === 'PICKUP' ? 'var(--pickup)' : 'var(--express)'`。import 加 `approvePickupCancelRequest`。

新增 `isPickup = channel === 'PICKUP'` 与：

```ts
  // 自取一步走：服务端 approve = 全额退并清标记（没有配送单/预约要取消）
  const doApprovePickup = async () => {
    setBusy(true); setError('')
    try { await approvePickupCancelRequest(orderId); onDone() }
    catch (e) { setError(apiMessage(e, '处理失败，请重试')) }
    finally { setBusy(false) }
  }
```

在 `if (isExpress) { return (...) }` 之前加：

```tsx
  if (isPickup) {
    return (
      <div className="wb__modal-mask" role="dialog" aria-modal="true">
        <div className="wb__modal">
          <div className="wb__modal-head">
            <span>处理取消申请</span>
            <button className="wb__iconbtn" onClick={onClose} disabled={busy} aria-label="关闭"><X className="w-4 h-4" /></button>
          </div>
          <div className="wb__modal-body">
            <div className="wb__meta">尾号 <b>{receiverPhone.slice(-4)}</b></div>
            <p>同意顾客的取消申请：把货款原路退回顾客微信，订单转为已退款终态；已经做了的菜由门店自行处理。</p>
            <p className="wb__meta">顾客会看到：退款通知，1-3 个工作日到账。不同意请关闭本窗，在卡片上点「驳回」。</p>
            <div className="wb__redbar">
              {amountFen > 0
                ? `确认后退款 ¥${yuan(amountFen)} 原路退回，此操作不可撤销。`
                : '本单已无可退余额，无需再退款，可直接关闭。'}
            </div>
          </div>
          {error && <div className="wb__redbar wb__modal-error">{error}</div>}
          <div className="wb__modal-foot">
            <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>暂不处理</button>
            <button className="wb__btn wb__btn--fill" style={{ background: chColor(channel) }}
              disabled={busy || amountFen <= 0} onClick={() => void doApprovePickup()}>
              {busy ? '处理中…' : '同意取消并退款'}
            </button>
          </div>
        </div>
      </div>
    )
  }
```

`renderModal` 的 `cancelRefund` 分支：`deliveryStatusLabel` 与 `hasActiveDelivery` 对 PICKUP 给 `null`/`false`；`onDone` 的提示：`ch === 'EXPRESS' ? '已取消预约并退款' : ch === 'PICKUP' ? '已同意取消并退款' : '已取消配送并退款'`。

`renderModal` 顶部 `const ch: Channel = card?.channel ?? 'LOCAL'` 改为 `const ch: OrderChannel = …`。

`RejectModal`/`CancelDeliveryModal`/`SelfDeliverModal` 等签名里的 `channel: Channel` 若因 `ch` 变宽而报错，改为 `OrderChannel`（它们只把 channel 传给 `chColor`/`FillButton`）。

- [ ] **Step 6：构建**

Run: `cd apps/admin && npm test && npm run build`
Expected: 全绿。

- [ ] **Step 7：提交**

```bash
git add apps/admin/src/pages/Workbench.tsx apps/admin/src/components/CancelAndRefundModal.tsx
git commit -m "feat(admin): 工作台自取操作（接单/已备好/已取走）、抽屉取餐信息、取消申请同意/驳回"
```

---

## Task 4：暂停范围弹窗（工作台 + 同城设置）与同城设置「到店自取」「休业」卡片

**Files:**
- Modify: `apps/admin/src/pages/Workbench.tsx`（`ModalState` 加 `'pause'`；`PauseScopeModal` 组件；顶栏与手机「⋯」层的入口按钮；`renderModal` 早退前处理）
- Create: `apps/admin/src/components/PauseScopeDialog.tsx`（Tailwind `Modal` 版，设置页用）
- Modify: `apps/admin/src/pages/LocalSettings.tsx`

**Interfaces:**
- Consumes：Task 1 的 `PAUSE_SCOPES/validatePauseInput/pauseStateLines/PauseState`、`applyPauseScope/resumeLocal/resumePickup/clearHoliday`。
- Produces：`PauseScopeDialog` props `{ state: PauseState; onClose(); onDone(msg: string) }`。

> 两套皮肤、一套逻辑：工作台弹窗必须用 `wb__*`（深色主题；`Workbench.css` 文件头注释），设置页用通用 `Modal`。共用的文案/校验/状态行全在 `utils/pause-scope.ts`（Task 1），两处都不许再各写一份。

- [ ] **Step 1：`PauseScopeDialog.tsx`（设置页）**

```tsx
import { useState } from 'react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { applyPauseScope, resumeLocal, resumePickup, clearHoliday } from '../api/admin'
import { PAUSE_SCOPES, validatePauseInput, pauseStateLines, type PauseScope, type PauseState } from '../utils/pause-scope'
import { todayKey } from '../utils/time'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const apiMessage = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback

/** 「暂停接单」四选一 + 当前状态逐项恢复（spec 2026-09-11 §6.1，P12）。设置页用；工作台有同逻辑的深色版 */
export default function PauseScopeDialog({ state, onClose, onDone }: {
  state: PauseState; onClose: () => void; onDone: (msg: string) => void
}) {
  const [scope, setScope] = useState<PauseScope>('DELIVERY')
  const [reason, setReason] = useState('临时暂停接单')
  const [until, setUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lines = pauseStateLines(state)

  const pick = (s: PauseScope) => {
    setScope(s)
    setReason(s === 'HOLIDAY' ? '节假日休业' : '临时暂停接单')
    setError('')
  }
  const submit = async () => {
    const err = validatePauseInput(scope, { reason, until }, todayKey())
    if (err) { setError(err); return }
    setBusy(true); setError('')
    try {
      await applyPauseScope(scope, { reason, until })
      onDone(scope === 'HOLIDAY' ? `已休业至 ${until}` : scope === 'DELIVERY' ? '已暂停外送' : scope === 'PICKUP' ? '已暂停自取' : '已暂停外送与自取，今天 24:00 自动恢复')
    } catch (e) { setError(apiMessage(e, '操作失败，请重试')) }
    finally { setBusy(false) }
  }
  const resume = async (key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP') => {
    setBusy(true); setError('')
    try {
      if (key === 'HOLIDAY') await clearHoliday()
      else if (key === 'DELIVERY') await resumeLocal()
      else await resumePickup()
      onDone(key === 'HOLIDAY' ? '已结束休业' : key === 'DELIVERY' ? '已恢复外送' : '已恢复自取')
    } catch (e) { setError(apiMessage(e, '恢复失败，请重试')) }
    finally { setBusy(false) }
  }

  return (
    <Modal title="暂停接单 / 休业" onClose={onClose} closeOnOverlay={!busy}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>关闭</Button>
        <Button variant="danger" loading={busy} onClick={() => void submit()}>{PAUSE_SCOPES.find((s) => s.key === scope)!.label}</Button>
      </>}>
      <div className="space-y-4">
        {lines.length > 0 && (
          <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center justify-between gap-2">
                <span>{l.text}</span>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void resume(l.key)}>
                  {l.key === 'HOLIDAY' ? '结束休业' : l.key === 'DELIVERY' ? '恢复外送' : '恢复自取'}
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2">
          {PAUSE_SCOPES.map((s) => (
            <label key={s.key} className={`flex gap-2 items-start rounded-md border p-2 cursor-pointer ${scope === s.key ? 'border-brand-400 bg-brand-50' : 'border-gray-200'}`}>
              <input type="radio" name="pause-scope" className="mt-1" checked={scope === s.key} onChange={() => pick(s.key)} disabled={busy} />
              <span>
                <span className="block text-sm font-medium text-gray-800">{s.label}</span>
                <span className="block text-xs text-gray-500">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {scope === 'HOLIDAY' && (
          <label className="block text-sm">
            <span className="block text-gray-700 mb-1">恢复营业日期（含当天仍休业）</span>
            <input type="date" className={inputCls} value={until} min={todayKey()} onChange={(e) => setUntil(e.target.value)} disabled={busy} />
          </label>
        )}
        <label className="block text-sm">
          <span className="block text-gray-700 mb-1">原因（顾客可见）</span>
          <input className={inputCls} value={reason} maxLength={60} onChange={(e) => setReason(e.target.value)} disabled={busy} />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  )
}
```

- [ ] **Step 2：`LocalSettings.tsx` 接入对话框，替换 `window.prompt`**

- import：去掉 `pauseLocal, resumeLocal`；加 `import PauseScopeDialog from '../components/PauseScopeDialog'`。
- state：`const [pauseOpen, setPauseOpen] = useState(false)`。
- 删除 `handlePause`/`handleResume`。
- 头部右侧按钮改为一颗：`<Button variant="secondary" size="sm" onClick={() => setPauseOpen(true)}><PauseCircle className="w-4 h-4" />暂停 / 休业</Button>`（`PlayCircle` import 若不再使用则移除）。
- 头部状态条改为用 `pauseStateLines`：

```tsx
      {pauseStateLines({ paused: s.paused, pickupPaused: s.pickup.paused, holiday: s.holiday, pickupEnabled: s.pickup.enabled }).map((l) => (
        <div key={l.key} className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">{l.text}</div>
      ))}
```
- 页面底部（`</div>` 前）：

```tsx
      {pauseOpen && (
        <PauseScopeDialog
          state={{ paused: s.paused, pickupPaused: s.pickup.paused, holiday: s.holiday, pickupEnabled: s.pickup.enabled }}
          onClose={() => setPauseOpen(false)}
          onDone={async (msg) => {
            setPauseOpen(false)
            toast.success(msg)
            try { hydrate(await getLocalSettings()) } catch { toast.error('刷新设置失败，请手动刷新页面') }
          }}
        />
      )}
```

- [ ] **Step 3：`handleSave` 合并规则补三项**

payload 里加：

```ts
        holiday: fresh.holiday,
        businessHours: fresh.businessHours,   // Task 5 起营业时间在独立页编辑；这里绝不能用页面缓存覆盖
        pickup: {
          ...s.pickup,
          paused: fresh.pickup.paused,
          minOrderAmountFen: fen.pickupMinOrder!,
          discount: s.pickup.discount.type === 'FIXED'
            ? { type: 'FIXED', value: fen.pickupFixed! }
            : s.pickup.discount,
        },
```

去掉原来的 `businessHours: sortRanges(s.businessHours)` 行。`money` state 加两项 `pickupMinOrder: ''`、`pickupFixed: ''`，`hydrate` 里 `pickupMinOrder: toYuan(v.pickup.minOrderAmountFen)`、`pickupFixed: v.pickup.discount.type === 'FIXED' ? toYuan(v.pickup.discount.value) : '0.00'`。

**注意**：`handleSave` 开头用 `Object.values(fen).some((v) => v === null)` 对所有金额做格式校验，新两项自动被覆盖。

- [ ] **Step 4：「到店自取」卡片**

放在「营业与履约」section 之后、「高峰时段」之前：

```tsx
      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><Store className="w-4 h-4" />到店自取</h3>
        <p className="text-xs text-gray-500">
          自取与外送共用菜单和营业时间；运费为 0，可另设自取优惠与起送门槛。休业会同时停外送与自取，邮寄不受影响。
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={s.pickup.enabled} onChange={(e) => patchPickup({ enabled: e.target.checked })} />
          开通到店自取（开通需已填门店电话、地址与营业时段）
        </label>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="取餐时段粒度（分）" hint="顾客按格选时间，如 30 = 12:00–12:30">
            <select className={inputCls} value={s.pickup.slotMinutes} onChange={(e) => patchPickup({ slotMinutes: Number(e.target.value) })}>
              {[15, 20, 30, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="接单缓冲（分）" hint="最早可取 = 现在 + 缓冲 + 备餐时长，向上取整到粒度">
            <input className={inputCls} type="number" min={0} max={60} value={s.pickup.acceptBufferMin} onChange={(e) => patchPickup({ acceptBufferMin: Number(e.target.value) })} /></Field>
          <Field label="可预订">
            <select className={inputCls} value={s.pickup.daysAhead} onChange={(e) => patchPickup({ daysAhead: Number(e.target.value) })}>
              <option value={0}>仅今天</option><option value={1}>今天和明天</option>
            </select>
          </Field>
          <Field label="自取起送金额（元）" hint="0 = 无门槛；与外送起送分开设">
            <input className={inputCls} inputMode="decimal" value={money.pickupMinOrder} onChange={(e) => setMoney({ ...money, pickupMinOrder: e.target.value })} /></Field>
          <Field label="自取优惠" hint="先扣自取优惠再算券；券门槛看原小计，券面额封顶到小计−自取优惠">
            <select className={inputCls} value={s.pickup.discount.type}
              onChange={(e) => {
                const type = e.target.value as 'NONE' | 'PERCENT' | 'FIXED'
                patchPickup({ discount: type === 'PERCENT' ? { type, value: s.pickup.discount.type === 'PERCENT' ? s.pickup.discount.value : 90 } : type === 'FIXED' ? { type, value: 0 } : { type: 'NONE', value: 0 } })
              }}>
              <option value="NONE">不打折</option><option value="PERCENT">按折扣</option><option value="FIXED">立减固定金额</option>
            </select>
          </Field>
          {s.pickup.discount.type === 'PERCENT' && (
            <Field label="按几折收（%）" hint="90 = 九折（减 10%）；1–100">
              <input className={inputCls} type="number" min={1} max={100} value={s.pickup.discount.value}
                onChange={(e) => patchPickup({ discount: { type: 'PERCENT', value: Number(e.target.value) } })} /></Field>
          )}
          {s.pickup.discount.type === 'FIXED' && (
            <Field label="立减（元）" hint="超过小计时按小计减">
              <input className={inputCls} inputMode="decimal" value={money.pickupFixed} onChange={(e) => setMoney({ ...money, pickupFixed: e.target.value })} /></Field>
          )}
          <Field label="过时未取提醒（分）" hint="取餐时间过后这么久推一次提醒给顾客与店员">
            <input className={inputCls} type="number" min={5} max={1440} value={s.pickup.unpickedRemindAfterMin} onChange={(e) => patchPickup({ unpickedRemindAfterMin: Number(e.target.value) })} /></Field>
          <Field label="超时自动完成（分）" hint="取餐时间过后这么久仍未点「已取走」则自动完成；须大于上一项">
            <input className={inputCls} type="number" min={10} max={1440} value={s.pickup.autoCompleteAfterMin} onChange={(e) => patchPickup({ autoCompleteAfterMin: Number(e.target.value) })} /></Field>
        </div>
      </section>
```

加 `const patchPickup = (p: Partial<LocalDeliverySettings['pickup']>) => setS({ ...s, pickup: { ...s.pickup, ...p } })`；import `Store` from lucide。

`formErrors` 加一条：`s.pickup.unpickedRemindAfterMin >= s.pickup.autoCompleteAfterMin ? '「过时未取提醒」须早于「超时自动完成」' : ''`（放在阶梯免运费那条之后）。

- [ ] **Step 5：「休业」卡片**

放在「到店自取」section 之后：

```tsx
      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-2">
        <h3 className="font-medium text-gray-800">休业</h3>
        <p className="text-xs text-gray-500">节假日/装修整店停：外送与自取一起停，邮寄不受影响。到日期自动恢复，也可提前结束。</p>
        {s.holiday
          ? <p className="text-sm text-amber-800">休业中：{s.holiday.reason || '休业'}（{s.holiday.until ? `${s.holiday.until} 后恢复` : '手动恢复'}）——在右上角「暂停 / 休业」里结束。</p>
          : <p className="text-sm text-gray-600">当前正常营业。要休业请点右上角「暂停 / 休业」→「休业至某日」。</p>}
      </section>
```

- [ ] **Step 6：工作台 `PauseScopeModal`（深色版）与入口**

`ModalState` 加 `| { kind: 'pause' }`。

在 `TipModal` 附近新增组件（用 `WbModal`；逻辑同 Step 1，只换皮）：

```tsx
/** 「暂停接单」四选一（spec §6.1）。与 components/PauseScopeDialog 同逻辑、不同皮：工作台必须走 wb__ 变量（深色） */
function PauseScopeModal({ state, onClose, onDone }: { state: PauseState; onClose: () => void; onDone: (msg: string) => void }) {
  const [scope, setScope] = useState<PauseScope>('DELIVERY')
  const [reason, setReason] = useState('临时暂停接单')
  const [until, setUntil] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lines = pauseStateLines(state)
  const pick = (s: PauseScope) => { setScope(s); setReason(s === 'HOLIDAY' ? '节假日休业' : '临时暂停接单'); setError('') }
  const submit = async () => {
    const err = validatePauseInput(scope, { reason, until }, todayKey())
    if (err) { setError(err); return }
    setBusy(true); setError('')
    try {
      await applyPauseScope(scope, { reason, until })
      onDone(scope === 'HOLIDAY' ? `已休业至 ${until}` : scope === 'DELIVERY' ? '已暂停外送' : scope === 'PICKUP' ? '已暂停自取' : '已暂停外送与自取，今天 24:00 自动恢复')
    } catch (e) { setError(apiMessage(e, '操作失败，请重试')) } finally { setBusy(false) }
  }
  const resume = async (key: 'HOLIDAY' | 'DELIVERY' | 'PICKUP') => {
    setBusy(true); setError('')
    try {
      if (key === 'HOLIDAY') await clearHoliday(); else if (key === 'DELIVERY') await resumeLocal(); else await resumePickup()
      onDone(key === 'HOLIDAY' ? '已结束休业' : key === 'DELIVERY' ? '已恢复外送' : '已恢复自取')
    } catch (e) { setError(apiMessage(e, '恢复失败，请重试')) } finally { setBusy(false) }
  }
  return (
    <WbModal title="暂停接单 / 休业" onClose={onClose} error={error}
      footer={<>
        <button className="wb__btn wb__btn--ghost" onClick={onClose} disabled={busy}>关闭</button>
        <button className="wb__btn wb__btn--fill" style={{ background: 'var(--danger)' }} disabled={busy} onClick={() => void submit()}>
          {busy ? '处理中…' : PAUSE_SCOPES.find((s) => s.key === scope)!.label}
        </button>
      </>}>
      {lines.length > 0 && (
        <div className="wb__amber">
          {lines.map((l) => (
            <div key={l.key} className="wb__line">
              <span>{l.text}</span>
              <button className="wb__iconbtn" disabled={busy} onClick={() => void resume(l.key)}>
                {l.key === 'HOLIDAY' ? '结束休业' : l.key === 'DELIVERY' ? '恢复外送' : '恢复自取'}
              </button>
            </div>
          ))}
        </div>
      )}
      {PAUSE_SCOPES.map((s) => (
        <label key={s.key} className="wb__line" style={{ cursor: 'pointer', alignItems: 'flex-start', gap: 8 }}>
          <input type="radio" name="wb-pause-scope" checked={scope === s.key} onChange={() => pick(s.key)} disabled={busy} />
          <span style={{ flex: 1, textAlign: 'left' }}>
            <b>{s.label}</b><br /><span className="wb__muted">{s.hint}</span>
          </span>
        </label>
      ))}
      {scope === 'HOLIDAY' && (
        <label className="wb__line"><span>恢复日期</span>
          <input className="wb__input" type="date" value={until} min={todayKey()} onChange={(e) => setUntil(e.target.value)} disabled={busy} /></label>
      )}
      <label className="wb__line"><span>原因（顾客可见）</span>
        <input className="wb__input" value={reason} maxLength={60} onChange={(e) => setReason(e.target.value)} disabled={busy} /></label>
    </WbModal>
  )
}
```

> `wb__input` 若在 `Workbench.css` 中不存在，读一下 `ShipModal` 用的输入框类名并改用它（例如 `wb__field`）；不新造第二套输入框样式。

import 补：`PAUSE_SCOPES, validatePauseInput, pauseStateLines, type PauseScope, type PauseState` from `../utils/pause-scope`；`applyPauseScope, resumeLocal, resumePickup, clearHoliday` from `../api/admin`；`todayKey` 已 import。

入口：`TopBar` props 加 `onPause: () => void`，在「退出工作台」按钮之前加 `<button className="wb__iconbtn" onClick={onPause}><CircleAlert className="w-4 h-4" />暂停/休业</button>`；手机「⋯」层在「退出工作台」之前加同样的按钮（`onClick={() => { setSheet(null); setModal({ kind: 'pause' }) }}`）。

`renderModal`：在 `if (modal.kind === 'exit')` 之后、`if (!o || !card) return null` 之前加：

```tsx
    if (modal.kind === 'pause') {
      return (
        <PauseScopeModal
          state={{ paused: snap?.paused ?? null, pickupPaused: snap?.pickupPaused ?? null, holiday: snap?.holiday ?? null, pickupEnabled: !!snap?.pickupEnabled }}
          onClose={close}
          onDone={async (m) => { await afterAction(m) }}
        />
      )
    }
```

`afterAction` 会 `load(true)` 刷新快照，顶栏两盏灯随之更新。

- [ ] **Step 7：构建**

Run: `cd apps/admin && npm test && npm run build`
Expected: 全绿。

- [ ] **Step 8：提交**

```bash
git add apps/admin/src/components/PauseScopeDialog.tsx apps/admin/src/pages/LocalSettings.tsx apps/admin/src/pages/Workbench.tsx
git commit -m "feat(admin): 暂停范围四选一（外送/自取/全部今天/休业）、同城设置到店自取与休业卡片"
```

---

## Task 5：营业时间独立页（P13 / §4.10）

**Files:**
- Create: `apps/admin/src/pages/BusinessHoursSettings.tsx`
- Modify: `apps/admin/src/navigation.ts`、`apps/admin/src/navigation.test.ts`、`apps/admin/src/App.tsx`、`apps/admin/src/pages/SettingsCenter.tsx`（仅描述文案）、`apps/admin/src/pages/LocalSettings.tsx`

**Interfaces:**
- Consumes：`getLocalSettings/updateLocalSettings`、`RowList/TimeRangeRow/validateRanges/sortRanges`、`useUnsavedSettings`。
- Produces：路由 `/settings/hours`；`centerTabs.settings` 第三项 `{ to: '/settings/hours', label: '营业时间' }`。

- [ ] **Step 1：改测试**

`navigation.test.ts` 第 32 行：`assert.deepEqual(centerTabs.settings.map((tab) => tab.label), ['全国邮寄设置', '同城配送设置', '营业时间'])`。
Run: `cd apps/admin && npm test` → 该断言 FAIL。

- [ ] **Step 2：`navigation.ts`**

`settings` 数组追加 `{ to: '/settings/hours', label: '营业时间' }`。跑测试 → PASS。

- [ ] **Step 3：`BusinessHoursSettings.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { getLocalSettings, updateLocalSettings } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { RowList, TimeRangeRow, validateRanges, sortRanges } from '../components/ui/RowList'
import { useUnsavedSettings } from '../components/UnsavedSettings'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'

/**
 * 营业时间（全店统一）——spec 2026-09-11 §4.10 / P13。
 * 存储仍是 local_delivery.businessHours（服务端单一来源），这里只编辑这一个字段：
 * 保存前先取最新设置再整包写回，其余字段原样带回（服务端 PUT 是整包覆盖）。
 */
export default function BusinessHoursSettings() {
  const { setDirty } = useUnsavedSettings()
  const [hours, setHours] = useState<{ start: string; end: string }[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    getLocalSettings()
      .then((v) => { setHours([...v.businessHours]); setDirty(false) })
      .catch(() => { setLoadFailed(true); toast.error('营业时间加载失败，请刷新重试') })
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  if (loadFailed) return <div className="text-red-600">营业时间加载失败，请刷新页面重试。</div>
  if (!hours) return <div className="text-gray-500">加载中...</div>

  const errs = validateRanges(hours)
  const hasErr = errs.some(Boolean)
  const sorted = sortRanges(hours)
  const breakText = !hasErr && sorted.length >= 2
    ? sorted.slice(1).map((h, i) => `${sorted[i].end}–${h.start}`).join('、') + ' 顾客端显示「午间休息」'
    : ''

  const save = async () => {
    if (hasErr) { toast.error('营业时段有错误，请先改正'); return }
    setSaving(true)
    try {
      let fresh
      try { fresh = await getLocalSettings() } catch { toast.error('读取最新设置失败，本次未保存，请刷新后重试'); return }
      const next = await updateLocalSettings({ ...fresh, businessHours: sortRanges(hours) })
      setHours([...next.businessHours]); setDirty(false)
      toast.success('已保存，外送下单、自取时段、来单催单与小程序「关于」页即刻按新时段')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 max-w-3xl" onChangeCapture={() => setDirty(true)}>
      <h3 className="text-lg font-semibold text-gray-800">营业时间</h3>
      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800 flex items-center gap-1"><Clock className="w-4 h-4" />营业时间（全店统一）</h3>
        <p className="text-xs text-gray-500">
          这一份时段同时决定：外送什么时候能下单、自取能选哪些取餐时段、来单催单在什么时段响、小程序「关于」页显示的营业时间。
          开门前顾客端显示「今天 HH:mm 营业」，两段之间显示「午间休息」，打烊后显示「明天 HH:mm 营业」。首期不支持跨零点；多段不可重叠。
        </p>
        <RowList rows={hours} onChange={setHours}
          blank={() => ({ start: '', end: '' })} errors={errs} addLabel="再加一段"
          emptyHint="一段都没有 = 全天不营业（外送与自取都无法开通）"
          render={(row, set) => <TimeRangeRow row={row} set={set} cls={inputCls} />} />
        {sorted.length > 0 && !hasErr && <p className="text-xs text-gray-500">今天 {sorted.map((h) => `${h.start}–${h.end}`).join('、')} 营业{breakText ? `；${breakText}` : ''}</p>}
        <p className="text-xs text-gray-400">高峰时段（备餐更慢的那几段）在「同城配送设置」里；休业在同城配送设置右上角「暂停 / 休业」。</p>
      </section>
      <div className="flex justify-end">
        {hasErr && <span className="text-xs text-red-600 self-center mr-2">营业时段有错误，请先改正</span>}
        <Button loading={saving} disabled={hasErr} onClick={() => void save()}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4：路由与中心页**

`App.tsx`：import `BusinessHoursSettings`；在 `<Route path="local" element={<LocalSettings />} />` 之后加 `<Route path="hours" element={<BusinessHoursSettings />} />`。
`SettingsCenter.tsx` description 改为「按配送方式分别维护规则；营业时间全店统一。保存只作用于当前设置页。」

- [ ] **Step 5：`LocalSettings.tsx` 原位置留链接**

「营业与履约」section 里的 `<Field label="营业时段" …><RowList …/></Field>` 整块替换为：

```tsx
          <Field label="营业时段（全店统一）" hint="外送、自取、来单催单、小程序「关于」页共用">
            <p className="text-sm text-gray-800 py-2">
              {s.businessHours.length ? fmtRanges(s.businessHours) : '未设置（全天不营业）'}
            </p>
            <Link to="/settings/hours" className="text-xs text-blue-600 underline">去「营业时间」页修改</Link>
          </Field>
```

import `Link` from `react-router-dom`。删除 `hoursErrs`、`breakText` 及 `formErrors` 里的营业时段那一条；`RowList`/`TimeRangeRow` 仍被高峰时段使用，保留 import；`validateRanges` 仍用于 `peakErrs`。`handleSave` 已在 Task 4 改为 `businessHours: fresh.businessHours`。

- [ ] **Step 6：构建与提交**

Run: `cd apps/admin && npm test && npm run build` → 全绿。

```bash
git add apps/admin/src/pages/BusinessHoursSettings.tsx apps/admin/src/navigation.ts apps/admin/src/navigation.test.ts apps/admin/src/App.tsx apps/admin/src/pages/SettingsCenter.tsx apps/admin/src/pages/LocalSettings.tsx
git commit -m "feat(admin): 营业时间独立设置页（全店统一），同城设置原位置留链接"
```

---

## Task 6：同城订单列表渠道筛选与自取字段、经营概览自取渠道

**Files:**
- Modify: `apps/admin/src/pages/LocalOrders.tsx`
- Modify: `apps/admin/src/components/dashboard/OverviewTab.tsx`
- Modify: `apps/server/src/routes/admin/stats/overview.ts`（`channelSchema` 枚举加 `'PICKUP'`；注释同步）
- Modify: `apps/server/src/routes/admin/stats/shared.ts`（`paidOrdersWhere(r, channel?: 'LOCAL' | 'EXPRESS' | 'PICKUP')`）
- Modify: `docs/api.md`（附录 H 管理端表补一行）

**Interfaces:**
- Consumes：Task 1 的 `getOrders({ channel })`、`Order.pickupAt/pickupReadyAt`、`orderStatusLabel`、`OverviewStats.channels.PICKUP`。

- [ ] **Step 1：`LocalOrders.tsx` 渠道筛选**

`STATUS_TABS` 的 SHIPPED 标签改为「配送中/待取餐」。新增：

```ts
// 渠道筛选：全部 = 服务端 channel=LOCAL（外送 + 自取）；外送/自取各用 deliveryType
const TYPE_TABS: { value: '' | 'LOCAL' | 'PICKUP'; label: string }[] = [
  { value: '', label: '全部' }, { value: 'LOCAL', label: '外送' }, { value: 'PICKUP', label: '自取' },
]
```

`const type = (searchParams.get('type') === 'LOCAL' || searchParams.get('type') === 'PICKUP') ? searchParams.get('type') as 'LOCAL' | 'PICKUP' : ''`。

`load` 的参数：`...(type ? { deliveryType: type } : { channel: 'LOCAL' })`（替换 `deliveryType: 'LOCAL'`）。`useEffect` 依赖加 `type`。

`handleTabChange` 改为同时保留 type：`setSearchParams({ ...(value ? { status: value } : {}), ...(type ? { type } : {}) }, { replace: true })`；新增 `handleTypeChange(value)` 同理保留 status，并 `setPage(1)`。

在状态 Tab 行之上加一行渠道分段按钮（同样式的 `rounded-full` 按钮组）；空状态文案：`type === 'PICKUP' ? '暂无自取订单' : type === 'LOCAL' ? '暂无外送订单' : '暂无同城订单'`。

- [ ] **Step 2：行内自取字段**

每行：`<StatusBadge status={o.status} deliveryType={o.deliveryType} />`；在订单号前加渠道小标：

```tsx
                    <span className={`text-xs px-1.5 py-0.5 rounded ${o.deliveryType === 'PICKUP' ? 'bg-teal-50 text-teal-700' : 'bg-orange-50 text-orange-700'}`}>{o.deliveryType === 'PICKUP' ? '自取' : '外送'}</span>
```

信息行：自取单不显示「配送成本/骑手」，改显示 `取餐 {fmtDateTime(o.pickupAt)}`、`{o.pickupReadyAt && `已备好 ${fmtDateTime(o.pickupReadyAt)}`}`、`{o.status === 'COMPLETED' && o.completedAt && `已取走 ${fmtDateTime(o.completedAt)}`}`。

「配送时间线」按钮对自取单不渲染（`o.deliveryType !== 'PICKUP' && (...)`），`toggleExpand` 不会被调用；退款与「查看工作台」按钮不变。

- [ ] **Step 3：`OverviewTab.tsx` 三渠道**

```ts
const PICKUP_COLOR = '#0d9488'   // 自取：青（与工作台 --pickup 同一语义）
type HotChannel = 'ALL' | 'LOCAL' | 'PICKUP' | 'EXPRESS'
```
- `hotChannel` state 与 `Body` props 类型改 `HotChannel`。
- `total = LOCAL + PICKUP + EXPRESS`；占比条三段：`LOCAL` 宽 `localShare`、`PICKUP` 宽 `pickupShare`、`EXPRESS` `flex:1`（`total > 0` 时才渲染，理由同原注释）。
- 图例三项：同城 / 自取 / 邮寄（各 `orderCount 单 · 实收`）。
- 趋势 `series` 加 `{ name: '自取', color: PICKUP_COLOR, values: d.trend.map((t) => t.PICKUP.revenueFen) }`（放同城之后）。`StackedBars` 的注释写「1–2 个」但实现是 `series.map` 无上限——确认 `StackedBars.tsx` 里没有 `series.length` 相关限制后，把该行注释改为「1–3 个」（这是白名单外文件：**只允许改这一行注释**，若发现实现确有上限则上报）。
- 热销分段按钮：`(['ALL', 'LOCAL', 'PICKUP', 'EXPRESS'] as const)`，文案「全部 / 同城 / 自取 / 邮寄」。

- [ ] **Step 4：服务端 channel 枚举**

`overview.ts`：`const channelSchema = z.object({ channel: z.enum(['ALL', 'LOCAL', 'EXPRESS', 'PICKUP']).optional() })`，注释 `channel=ALL|LOCAL|EXPRESS|PICKUP`；把 `ch` 传给 `paidOrdersWhere` 的地方类型随之通过。
`shared.ts`：`export function paidOrdersWhere(r: Range, channel?: 'LOCAL' | 'EXPRESS' | 'PICKUP')`。
验证：`cd apps/server && npx tsc --noEmit -p .`（只要通过即可；不需重跑 e2e）。
`docs/api.md` 附录 H 管理端表末尾加一行：`| \`GET /api/admin/stats/overview\` | \`channel\` 接受 \`PICKUP\`（热销榜按自取过滤）；\`channels\`/\`trend\` 含 \`PICKUP\` 桶（批次一已加）。 |`

- [ ] **Step 5：构建与提交**

Run: `cd apps/admin && npm test && npm run build && cd ../server && npx tsc --noEmit -p .` → 全绿。

```bash
git add apps/admin/src/pages/LocalOrders.tsx apps/admin/src/components/dashboard/OverviewTab.tsx apps/admin/src/components/dashboard/StackedBars.tsx apps/server/src/routes/admin/stats/overview.ts apps/server/src/routes/admin/stats/shared.ts docs/api.md
git commit -m "feat(admin): 同城订单列表外送/自取筛选与取餐字段，经营概览自取渠道"
```

（`StackedBars.tsx` 仅在改了那一行注释时才加入；本计划据此把它临时纳入白名单，范围仅限该注释行。）

---

## Task 7：店员手册

**Files:**
- Modify: `docs/staff-guide.md`

- [ ] **Step 1：在「六点五、同城配送」章末（「## 七、优惠券与积分」之前）加一节**

```markdown
## 六点六、到店自取

自取单和同城外送共用菜单，工作台上是**青色**竖条、徽标「自取」，排在同城单下面、邮寄单上面。

### 在哪一列、点什么按钮

- **待接单**：点「接单」。卡片右上角写着「HH:mm 开始备餐」的是下午或明天的单，不用马上做；明天的单默认收在列底「明日自取」里，点开才看得到，到了开始备餐时刻会自动回到正常列。
- **备餐中**：卡片上是「距取餐 N 分」；≤15 分钟转琥珀、≤5 分钟转红。做好后点「已备好」，顾客会收到取餐提醒，订单变「待取餐」。
- **配送中**这一列对自取单叫**待取餐**：顾客到店报手机尾号，核对后点「已取走」，订单完成。过了取餐时间没来的单会转琥珀并写「已过取餐时间 N 分钟」；超过后台设的分钟数系统会自动完成（默认 120 分钟），并推送提醒。
- 自取单**没有**呼叫骑手、自己送、加小费、看进度这些按钮，也不受快递100 余额熔断影响。

### 顾客申请取消（自取单）

- 顾客在**接单前且还没到开始备餐时刻**可以自己秒退，不经过你。
- 接单后顾客只能「申请取消」，卡片出现「顾客要退菜」条：点「同意退款」= 全额退；点「驳回」= 继续做。**不处理不会自动驳回**（和同城外送不一样），所以要尽快点其中一个。点「已备好」也等于驳回。
- 已备好之后顾客不能再申请取消，只能走售后。

### 暂停接单与休业

后台「同城配送设置」右上角「暂停 / 休业」，或工作台顶栏「暂停/休业」，四选一：**只暂停外送**、**只暂停自取**、**全部暂停（今天）**（今天 24:00 自动恢复）、**休业至某日**（含当天，次日自动恢复；邮寄不受影响）。恢复在同一个弹窗里逐项点。工作台顶栏有两盏灯：外送状态、自取状态。

### 营业时间在哪改

后台「店铺设置」→「营业时间」页，**全店只有这一份**：管外送能不能下单、自取能选哪些时段、来单催单、小程序「关于」页。开门前顾客端显示「今天 HH:mm 营业」，两段之间显示「午间休息」（以前开门前也显示午间休息的问题已修）。自取的折扣、门槛、时段粒度在「同城配送设置」→「到店自取」卡片。
```

- [ ] **Step 2：提交**

```bash
git add docs/staff-guide.md
git commit -m "docs: 店员手册增加到店自取一节"
```

---

## 验收标准（只在此定义；04 机械核对按此逐条打 PASS/FAIL）

- **C1 测试与构建**：`apps/admin` 下 `npm test` 全绿（含 `utils/pickup.test.ts` 5 例、`utils/pause-scope.test.ts` 4 例、`navigation.test.ts` 更新后的断言），`npm run build` 全绿（时区闸门 + tsc + vite）；`apps/server` 下 `npx tsc --noEmit -p .` 通过。
- **C2 类型与 API**：`types.ts` 含 `OrderChannel`、`WorkbenchCard.pickup`、`WorkbenchSnapshot.pickupEnabled/pickupPaused/holiday`、`LocalDeliverySettings.pickup/holiday`、`Order.pickupAt/pickupReadyAt/pickupDiscountAmount`、`OverviewStats.channels.PICKUP`；`api/admin.ts` 含 `pickupReadyOrder/pickedUpOrder/approvePickupCancelRequest/rejectPickupCancelRequest/pausePickup/resumePickup/setHoliday/clearHoliday/applyPauseScope`，路径与 `docs/api.md` 附录 H 一致；`Channel` 类型仍为 `'EXPRESS' | 'LOCAL'`。
- **C3 工作台卡片**：`Workbench.tsx` 中 PICKUP 卡片用 `wb__card--pickup`/`wb__badge--pickup`，徽标文案「自取」，字段行「取餐 {slotLabel}」；`dwellBudget('preparing','PICKUP',…)`/`('delivering','PICKUP',…)` 返回 null；`urgencyOf` 对明日自取返回 `''`；列底存在「明日自取」折叠组；顶栏统计含「自取」，图例含「到店自取」，熔断横幅文案含「外送呼叫已暂停」与「自取单不受影响」；`openStateOf` 休业时返回「休业中」。
- **C4 工作台操作**：`renderActions` 对 PICKUP：pending 仅「接单」（调 `acceptOrder`），preparing 仅「已备好」（调 `pickupReadyOrder`），delivering 仅「已取走」（调 `pickedUpOrder`），三列都无「呼叫骑手/自己送/加小费/看进度/查物流」，有「打给顾客」；`loadDetail` 对 PICKUP 不调 `getOrderDelivery/getExpressBooking`；抽屉「取餐信息」块含取餐时段/开始备餐/已备好/已取走，金额明细含「自取优惠」行。
- **C5 取消申请**：PICKUP 卡片「顾客要退菜」条无自动回绝倒计时、有「驳回」与「同意退款」；驳回调 `rejectPickupCancelRequest`；`CancelAndRefundModal` PICKUP 分支一步调 `approvePickupCancelRequest`，按钮「同意取消并退款」。
- **C6 暂停范围**：`PAUSE_SCOPES` 四项文案逐字为「只暂停外送 / 只暂停自取 / 全部暂停（今天）/ 休业至某日」；`applyPauseScope`：DELIVERY→`pauseLocal`，PICKUP→`pausePickup`，ALL_TODAY→两者且 `until` = 上海当天 23:59:59，HOLIDAY→`setHoliday(until, reason)`；`LocalSettings.tsx` 不再含 `window.prompt`；工作台 `ModalState` 含 `'pause'` 且顶栏/手机层有入口。
- **C7 同城设置**：存在「到店自取」section（开通开关、粒度、缓冲、可预订、起送、优惠类型/值、过时提醒、自动完成）与「休业」section；`handleSave` payload 含 `holiday: fresh.holiday`、`businessHours: fresh.businessHours`、`pickup.paused: fresh.pickup.paused`、`paused: fresh.paused`、坐标合并逻辑未变；`formErrors` 含「过时未取提醒」须早于「超时自动完成」。
- **C8 营业时间页**：`/settings/hours` 路由存在，`centerTabs.settings` 第三项 label「营业时间」，页面卡片标题「营业时间（全店统一）」，保存走「GET 最新 → 只改 `businessHours` → PUT」；`LocalSettings.tsx` 营业时段只读并带 `Link` 到 `/settings/hours`。
- **C9 订单列表与概览**：`LocalOrders.tsx` 筛选「全部/外送/自取」分别发 `channel=LOCAL` / `deliveryType=LOCAL` / `deliveryType=PICKUP`，自取行显示「取餐 …」「已备好 …」「已取走 …」且无「配送时间线」；`OverviewTab.tsx` 占比条与图例三渠道、趋势三系列、热销分段含「自取」；服务端 `overview.ts` channel 枚举含 `PICKUP`。
- **C10 文档**：`docs/staff-guide.md` 含「六点六、到店自取」四小节；`docs/api.md` 附录 H 含 overview channel=PICKUP 行。
- **W 白名单**：`git diff --name-only 39823e9..HEAD`（本批次的提交范围以账本记录为准）中本批新增/修改的文件全部在白名单内（含 `StackedBars.tsx` 注释行的例外）。
- **C 提交**：本批每个提交信息以 `feat(admin)/fix(admin)/test(admin)/docs` 开头且含 `Co-Authored-By: Claude Fable 5.1` 尾注。

## 手工验收（三批合并，最后统一做；需要 3109 服务端 + 后台 dev server 指向它）

后台：`cd apps/admin && VITE_PROXY_TARGET=http://localhost:3109 npm run dev`（`vite.config.ts` 的代理目标读这个环境变量，默认 3000）。

1. 同城配送设置 →「到店自取」：开通、粒度 30、缓冲 5、可预订今天和明天、起送 ¥20、九折 → 保存 → 刷新后各值保留，右上角状态条无变化，门店坐标未被清空。
2. 店铺设置 →「营业时间」：改成 10:00–14:00、17:00–21:00 → 保存 → 同城配送设置页营业时段只读显示同样的段；小程序「关于」页同步。
3. 暂停 / 休业：依次试「只暂停自取」（工作台顶栏第二盏灯变「自取已暂停」，小程序自取结算页显示暂停）、恢复；「休业至明天」（顶栏「休业中，MM-DD 后恢复」，小程序外送/自取都不可下单，邮寄可下）、结束休业。
4. 小程序下一张自取单（今天最近时段）→ 工作台「待接单」出现青色「自取」卡，字段「取餐 今天 …」→ 点「接单」→ 备餐中显示「距取餐 N 分」→ 点「已备好」（小程序收到取餐提醒、状态「待取餐」）→ 卡片到「配送中」列显示「已备好 HH:mm」→ 点「已取走」→ 已完成列显示「已取餐」。
5. 下一张明天的自取单 → 「待接单」列底出现「明日自取 1」折叠组，卡片不变红；点开可见，胶囊「HH:mm 开始备餐」。
6. 接单后在小程序申请取消 → 卡片「顾客要退菜」无倒计时；点「驳回」→ 小程序「商家未同意取消」；再申请 → 点「同意退款」→ 弹窗「同意取消并退款」→ 订单已退款并离开看板。
7. 同城订单列表：切「自取」只见自取单，行内有取餐/备好/取走时刻，无「配送时间线」；切「外送」只见外送单；「全部」两者都有。
8. 经营概览 → 总览：占比条三色、图例「自取 N 单」、趋势三系列、热销分段「自取」有数据。
9. 工作台深色主题下青色徽标/竖条清晰可辨；手机宽度（≤700px）「⋯」层有「自取 N」与「暂停/休业」按钮。

## 勘误与验收记录（执行时追加）

（空）
