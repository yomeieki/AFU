# 全国邮寄接快递100 · 批次三：轨迹订阅与展示、签收自动完成、对账任务 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 预约下单时免费订阅快递100 轨迹推送，轨迹整体落库并在顾客端显示时间线；轨迹签收（或主动查单查到签收）自动把订单转「已完成」；对「时段过了还没取件」「取件后十天没签收」两类单主动查单补状态、仍无结论提醒店员一次。

**Architecture:** 在批次二的 `express_bookings` 上加三列（stale 对账标记），新增一条公开回调路由 `POST /api/kd-express/:bookingNo/track`（与状态回调同 salt、同验签公式、同限流、同 ack）。轨迹是「展示层」事实：`trackJson` 整体覆盖写、不逐条合并；只有「签收」会推进预约状态（若还没取件先按 10 走一遍让订单 SHIPPED、再按 13 收尾），复用批次二的 `applyProviderStatus`。顾客端新增只读 `track` 字段与「物流轨迹」卡；工作台抽屉加一行「最新轨迹」。对账任务复用 `detail` 查单 + `applyProviderStatus`，与 UNKNOWN 对账（批次二）并列。

**Tech Stack:** Express + Prisma(MySQL) + TypeScript（`apps/server`）、React + Vite（`apps/admin`）、微信小程序原生（`apps/miniapp`，新增文件须 ES5）、bash e2e（`scripts/e2e.d/`）。

## Global Constraints

- **同城 LOCAL 代码路径零行为变化**；**老邮寄单（无预约、手填单号）零行为变化**：`GET /api/orders/:id` 对这类单 `expressBooking` 与 `track` 都是 `null`，顾客端页面显示与批次二完全一致。
- 轨迹回调：`POST /api/kd-express/:bookingNo/track`，form `param`（JSON）+ `sign=MD5(param + callbackSalt)`（与状态回调**同一条预约的同一个 salt**）；ack 固定 `{"result":true,"returnCode":"200","message":"成功"}`；验签失败仍 ack 200 不处理；限流走同一个 `kdExpressCallbackLimiter`，触发回 503。
- `callBackUrl` 与 `pollCallBackUrl` 各自 ≤ 200 字节；下单参数 `op=1`（spec §7）。
- 轨迹 JSON：`trackJson = { status, ischeck, state, nu, items:[{context, ftime}] }`，**最新在上、最多 50 条、整体覆盖**；顾客端最多下发 30 条；顾客白名单不变（不给手机号、不给费用）。
- 签收判定：`lastResult.ischeck === '1'` 或 `lastResult.state === '3'`；签收不给顾客发订阅消息（spec §8）；订单只在 `SHIPPED` 时转 `COMPLETED`（`completedAt` 有值）。
- 对账任务：每 30 分钟一次/单、每单最多 48 次；BOOKED/ACCEPTED 以「时段结束 + `unpickedRemindMin`」为过期；PICKED 以 10 天为过期；仍无结论**每单只提醒一次**（`staleRemindedAt` 打标 count=1 才推送，与批次二任务同范式）。
- 新增小程序文件必须通过 `node scripts/check-miniapp-es5.mjs <file>`（`var`、字符串拼接、`indexOf`，不用箭头函数/`const`/模板串）；`pages/order/detail.js` 既有文件不受闸门约束但新增行同样写 ES5。
- 事件留痕 `express_booking_events` 新增 `source='TRACK'`；去重键 `TR:<bookingNo>:<status>:<md5(rawBody)>`。
- 不新增错误码（批次三没有新的店员操作）。
- e2e 一律 `SCHEDULER_DISABLED=true` + 全部 `*_MOCK=true`，干净库 `food_shop_e2e`；断言总数只增不减（批次二基线 **1405/0**）。
- 不把任何密钥写进文档/代码/测试。

## 文件结构

| 文件 | 职责 | 任务 |
|---|---|---|
| `apps/server/src/services/delivery/express-callback-sign.ts` | 验签抽成 `verifySignedParam`；新增轨迹 param 解析 `_parseTrackParam` / `verifyAndParseExpressTrack` | 1 |
| `apps/server/src/services/delivery/kd100-express.ts` | `ExpressBookInput.pollCallbackUrl`；`_buildBookParam` 加 `op:1`、`pollCallBackUrl` | 1 |
| `apps/server/scripts/selftest-express-booking.ts` | 协议/解析/排序/签收判定用例 | 1 |
| `apps/server/prisma/schema.prisma` + `migrations/20260914000000_express_track/` | `staleCheckedAt/staleRemindedAt/staleTries` 三列 | 2 |
| `apps/server/src/services/delivery/express-track-json.ts` | 纯函数：`StoredTrack` 类型、`parseStoredTrack`、`toStoredTrack` | 2 |
| `apps/server/src/services/delivery/express-track.ts` | `handleExpressTrackCallback`：验签→去重留痕→覆盖写 JSON→签收推进 | 2 |
| `apps/server/src/services/delivery/express-events.ts` | `source` 加 `'TRACK'`、`makeExpressTrackDedupeKey` | 2 |
| `apps/server/src/routes/kd-express-callback.ts` | 加 `/:bookingNo/track` | 2 |
| `apps/server/src/services/delivery/express-booking.ts` | `createBooking` 传 `pollCallbackUrl`；`bookingView` 加轨迹摘要 | 2 |
| `apps/server/src/config.ts` | 启动时最坏 `pollCallBackUrl` 长度校验 | 2 |
| `apps/server/src/routes/orders.ts` | 顾客详情加 `track` | 2 |
| `scripts/e2e.d/61-express-track.sh` | 轨迹 e2e（Task 2 建、Task 3 续） | 2, 3 |
| `apps/server/src/services/delivery/express-booking-tasks.ts` | `reconcileExpressStale` | 3 |
| `apps/server/src/services/scheduler.ts` + `routes/admin/system.ts` | 注册任务、`expressStaleIntervalMin/expressPickedStaleDays` 覆盖 | 3 |
| `apps/miniapp/utils/express-track.js`（新，ES5） | `buildExpressTrack`、`expressStageText` 纯函数 | 4 |
| `apps/miniapp/pages/order/detail.{js,wxml,wxss}` | 引用 util；「物流轨迹」卡；COMPLETED「已签收」 | 4 |
| `tests/miniapp/express-track.test.cjs` | 六种卡片文案 + 轨迹容错 | 4 |
| `apps/admin/src/types.ts` + `pages/Workbench.tsx` | 抽屉「最新轨迹」一行 | 5 |
| `docs/api.md`、`docs/staff-guide.md`、`docs/deployment.md`、spec、`docs/express-shipping-golive-manual.md`（新） | 文档与店主手册 | 6 |

---

### Task 1: 协议层——下单订阅轨迹（op=1 + pollCallBackUrl）、轨迹推送验签与解析

**Files:**
- Modify: `apps/server/src/services/delivery/express-callback-sign.ts`
- Modify: `apps/server/src/services/delivery/kd100-express.ts:26-33`（`ExpressBookInput`）、`:89-104`（`_buildBookParam`）
- Test: `apps/server/scripts/selftest-express-booking.ts`

**Interfaces:**
- Consumes: 既有 `str/numOrNull/pick`、`_parseCallbackParam`、`verifyAndParseExpressCallback`（`express-callback-sign.ts`）。
- Produces:
  ```ts
  export interface ExpressTrackItem { context: string; ftime: string; status: string | null; areaName: string | null }
  export interface ExpressTrackPayload {
    status: string            // 'polling' | 'shutdown' | 'abort' | 'updateall'（小写化）；未知值原样保留
    ischeck: boolean          // lastResult.ischeck === '1' || lastResult.state === '3'
    state: string | null; nu: string | null; com: string | null; message: string | null
    items: ExpressTrackItem[] // 按 ftime 降序（最新在上），最多 50 条，缺 context/ftime 的条目剔除
    raw: Record<string, unknown>
  }
  export function _parseTrackParam(p: Record<string, unknown>): ExpressTrackPayload
  export function verifyAndParseExpressTrack(body: Record<string, string>, salt: string): { ok: true; payload: ExpressTrackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' }
  export const TRACK_MAX_ITEMS = 50
  // kd100-express.ts
  export interface ExpressBookInput { ...既有字段; pollCallbackUrl: string }
  ```

- [ ] **Step 1: 写失败的自测用例**（追加到 `selftest-express-booking.ts` 的 `main()` 末尾、`console.log('通过', pass, '条')` 之前）

```ts
await t('bOrder 参数带 op=1 与 pollCallBackUrl（轨迹订阅免费，spec §7）', () => {
  const p = _buildBookParam({ bookingNo: 'E1-1', kuaidicom: 'jd', sender: { name: 'a', mobile: '1', addr: 'A' }, receiver: { name: 'b', mobile: '2', addr: 'B' }, cargo: '食品', weightKg: 1, callbackUrl: 'http://x/api/kd-express/E1-1', pollCallbackUrl: 'http://x/api/kd-express/E1-1/track', salt: 's' })
  assert.strictEqual(p.op, 1)
  assert.strictEqual(p.pollCallBackUrl, 'http://x/api/kd-express/E1-1/track')
  assert.strictEqual(p.callBackUrl, 'http://x/api/kd-express/E1-1')
})
await t('轨迹 param 解析：最新在上、缺字段剔除、ischeck/state 判签收、封顶 50 条', () => {
  const p = _parseTrackParam({ status: 'POLLING', lastResult: { nu: 'JD1', com: 'jd', ischeck: '0', state: '0', data: [
    { context: '已揽收', ftime: '2026-09-10 10:00:00' },
    { context: '运输中', ftime: '2026-09-10 12:00:00', areaName: '成都' },
    { ftime: '2026-09-10 13:00:00' },          // 无 context → 剔除
    { context: '无时间' },                       // 无 ftime → 剔除
    'garbage', null,
  ] } })
  assert.strictEqual(p.status, 'polling'); assert.strictEqual(p.ischeck, false); assert.strictEqual(p.nu, 'JD1')
  assert.deepStrictEqual(p.items.map((x) => x.context), ['运输中', '已揽收'])
  assert.strictEqual(p.items[0].areaName, '成都')
  assert.strictEqual(_parseTrackParam({ status: 'polling', lastResult: { ischeck: '1', data: [] } }).ischeck, true)
  assert.strictEqual(_parseTrackParam({ status: 'polling', lastResult: { ischeck: '0', state: '3', data: [] } }).ischeck, true)
  assert.strictEqual(_parseTrackParam({ status: 'shutdown', lastResult: { data: [] } }).ischeck, false)
  assert.deepStrictEqual(_parseTrackParam({ status: 'abort', message: '单号不存在' }).items, [])
  assert.strictEqual(_parseTrackParam({ status: 'abort', message: '单号不存在' }).message, '单号不存在')
  const many = Array.from({ length: 60 }, (_, i) => ({ context: `c${i}`, ftime: `2026-09-10 ${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00` }))
  assert.strictEqual(_parseTrackParam({ status: 'polling', lastResult: { data: many } }).items.length, TRACK_MAX_ITEMS)
  // lastResult 是数组/字符串这类脏形状不抛错
  assert.deepStrictEqual(_parseTrackParam({ status: 'polling', lastResult: [1, 2] }).items, [])
  assert.deepStrictEqual(_parseTrackParam({ status: 'polling', lastResult: 'x' }).items, [])
})
await t('轨迹推送验签：与状态回调同公式；篡改/缺 param/非对象 JSON 都拒', () => {
  const salt = 'abc123'
  const param = JSON.stringify({ status: 'polling', lastResult: { ischeck: '0', data: [{ context: 'x', ftime: '2026-09-10 10:00:00' }] } })
  const sign = crypto.createHash('md5').update(param + salt, 'utf8').digest('hex').toUpperCase()
  const ok = verifyAndParseExpressTrack({ param, sign }, salt)
  assert.ok(ok.ok && ok.payload.items.length === 1)
  assert.deepStrictEqual(verifyAndParseExpressTrack({ param, sign: sign.toLowerCase() }, salt).ok, true)   // 大小写不敏感
  assert.deepStrictEqual(verifyAndParseExpressTrack({ param, sign: 'DEADBEEF' }, salt), { ok: false, reason: 'SIGN_MISMATCH' })
  assert.deepStrictEqual(verifyAndParseExpressTrack({ sign } as Record<string, string>, salt), { ok: false, reason: 'BAD_PARAM' })
  const arrParam = '[1,2]'
  const arrSign = crypto.createHash('md5').update(arrParam + salt, 'utf8').digest('hex').toUpperCase()
  assert.deepStrictEqual(verifyAndParseExpressTrack({ param: arrParam, sign: arrSign }, salt), { ok: false, reason: 'BAD_PARAM' })
  // 同一个 salt 下状态回调仍然照常（重构 verifySignedParam 不能改变既有行为）
  const cb = verifyAndParseExpressCallback({ param: JSON.stringify({ status: 1, data: { status: 1 } }), sign: crypto.createHash('md5').update(JSON.stringify({ status: 1, data: { status: 1 } }) + salt, 'utf8').digest('hex').toUpperCase() }, salt)
  assert.ok(cb.ok && cb.payload.status === '1')
})
```

同时把文件头的 import 补上：

```ts
import { _parseTrackParam, verifyAndParseExpressTrack, verifyAndParseExpressCallback, TRACK_MAX_ITEMS } from '../src/services/delivery/express-callback-sign'
```

- [ ] **Step 2: 跑自测确认失败**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-express-booking.ts 2>&1 | tail -5`
Expected: 编译期就报 `Module has no exported member '_parseTrackParam'`（或 `pollCallbackUrl` 不在 `ExpressBookInput` 上）——失败即可。

- [ ] **Step 3: 实现 `express-callback-sign.ts`**

把既有 `verifyAndParseExpressCallback` 的「验签 + JSON.parse + 非对象拒绝」抽成 `verifySignedParam`，两个入口共用：

```ts
export interface ExpressTrackItem { context: string; ftime: string; status: string | null; areaName: string | null }
export interface ExpressTrackPayload {
  status: string; ischeck: boolean; state: string | null; nu: string | null; com: string | null; message: string | null
  items: ExpressTrackItem[]; raw: Record<string, unknown>
}
/** 轨迹 JSON 只留最近 50 条：顾客端只看最近几条，店员抽屉只看最新一条；快递100 一单轨迹一般 10–20 条，50 是余量 */
export const TRACK_MAX_ITEMS = 50

/** pollCallBackUrl 推送的 param（调研 §3.3）：{ status, billstatus, message, lastResult:{ nu, com, ischeck, state, data:[{context,ftime,time,status,areaName}] } } */
export function _parseTrackParam(p: Record<string, unknown>): ExpressTrackPayload {
  const lr = (p.lastResult && typeof p.lastResult === 'object' && !Array.isArray(p.lastResult) ? p.lastResult : {}) as Record<string, unknown>
  const items: ExpressTrackItem[] = []
  for (const it of Array.isArray(lr.data) ? lr.data : []) {
    const r = (it && typeof it === 'object' && !Array.isArray(it) ? it : {}) as Record<string, unknown>
    const context = str(r.context), ftime = str(r.ftime) ?? str(r.time)
    if (!context || !ftime) continue
    items.push({ context: context.slice(0, 255), ftime: ftime.slice(0, 32), status: str(r.status), areaName: str(r.areaName) })
  }
  // 快递100 通常已是最新在前，但不赌它：按 ftime 字符串（'YYYY-MM-DD HH:mm:ss' 可直接比较）降序排一次
  items.sort((a, b) => (a.ftime < b.ftime ? 1 : a.ftime > b.ftime ? -1 : 0))
  const state = str(lr.state)
  return {
    status: String(str(p.status) ?? '').toLowerCase(),
    ischeck: String(lr.ischeck ?? '') === '1' || state === '3',
    state, nu: str(lr.nu), com: str(lr.com), message: str(pick(p.message, lr.message)),
    items: items.slice(0, TRACK_MAX_ITEMS), raw: p,
  }
}

/** sign = MD5(param + salt) 大写；多字节篡改 sign 先按字节长度筛，避免 timingSafeEqual 因长度不等直接抛异常 */
function verifySignedParam(body: Record<string, string>, salt: string): { ok: true; param: Record<string, unknown> } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const paramStr = body.param, sign = body.sign
  if (typeof paramStr !== 'string' || !paramStr || typeof sign !== 'string') return { ok: false, reason: 'BAD_PARAM' }
  const expect = md5U(paramStr + salt), got = sign.toUpperCase()
  if (Buffer.byteLength(got) !== Buffer.byteLength(expect)) return { ok: false, reason: 'SIGN_MISMATCH' }
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return { ok: false, reason: 'SIGN_MISMATCH' }
  let p: Record<string, unknown>
  try { p = JSON.parse(paramStr) as Record<string, unknown> } catch { return { ok: false, reason: 'BAD_PARAM' } }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, reason: 'BAD_PARAM' }
  return { ok: true, param: p }
}

export function verifyAndParseExpressCallback(body: Record<string, string>, salt: string): { ok: true; payload: ExpressCallbackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const v = verifySignedParam(body, salt)
  return v.ok ? { ok: true, payload: _parseCallbackParam(v.param) } : v
}
export function verifyAndParseExpressTrack(body: Record<string, string>, salt: string): { ok: true; payload: ExpressTrackPayload } | { ok: false; reason: 'BAD_PARAM' | 'SIGN_MISMATCH' } {
  const v = verifySignedParam(body, salt)
  return v.ok ? { ok: true, payload: _parseTrackParam(v.param) } : v
}
```

（删除原来 `verifyAndParseExpressCallback` 里重复的那段验签体，只保留上面共用版本。）

- [ ] **Step 4: 实现 `kd100-express.ts`**

`ExpressBookInput` 加字段，`_buildBookParam` 加两个参数：

```ts
export interface ExpressBookInput {
  bookingNo: string; kuaidicom: string; serviceType?: string | null
  sender: ExpressParty; receiver: ExpressParty
  cargo: string; weightKg: number; remark?: string | null
  dayType?: string | null; pickupStart?: string | null; pickupEnd?: string | null
  callbackUrl: string; pollCallbackUrl: string; salt: string; timeoutMs?: number
}
```

`_buildBookParam` 的对象字面量里、`callBackUrl` 那一行改成：

```ts
    callBackUrl: i.callbackUrl, pollCallBackUrl: i.pollCallbackUrl, op: 1, salt: i.salt, thirdOrderId: i.bookingNo,
```

同一文件顶部注释追加一行：`op=1 + pollCallBackUrl：免费订阅轨迹推送，推送验签同 salt（docs/research §3.3）`。

- [ ] **Step 5: 跑自测确认通过 + tsc**

Run: `cd apps/server && npx tsc --noEmit && npx ts-node --transpile-only scripts/selftest-express-booking.ts 2>&1 | tail -3`
Expected: tsc 干净（`express-booking.ts` 里 `book({...})` 调用此时还没传 `pollCallbackUrl`，tsc 会报错——先在 `createBooking` 的 `book({` 入参里临时加 `pollCallbackUrl: callbackUrl + '/track'`，Task 2 会换成正式实现）；selftest 打印 `通过 19 条`（原 16 + 3）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/delivery/express-callback-sign.ts apps/server/src/services/delivery/kd100-express.ts apps/server/src/services/delivery/express-booking.ts apps/server/scripts/selftest-express-booking.ts
git commit -m "快递100 轨迹订阅协议：bOrder 带 op=1/pollCallBackUrl，轨迹推送验签解析（最新在上、封顶 50、ischeck/state 判签收）"
```

---

### Task 2: 轨迹落库——迁移、轨迹回调服务与路由、下单传 pollCallBackUrl、预约视图与顾客详情带轨迹、e2e §61

**Files:**
- Create: `apps/server/prisma/migrations/20260914000000_express_track/migration.sql`
- Modify: `apps/server/prisma/schema.prisma`（`ExpressBooking` 在 `reconcileTries` 后加三列）
- Create: `apps/server/src/services/delivery/express-track-json.ts`
- Create: `apps/server/src/services/delivery/express-track.ts`
- Modify: `apps/server/src/services/delivery/express-events.ts`（`source` 联合类型 + `makeExpressTrackDedupeKey`）
- Modify: `apps/server/src/routes/kd-express-callback.ts`
- Modify: `apps/server/src/services/delivery/express-booking.ts`（`createBooking` 的 URL 与 `book()` 入参；`BookingView`/`bookingView`）
- Modify: `apps/server/src/config.ts:153-159`
- Modify: `apps/server/src/routes/orders.ts:668-676`（顾客详情 `expressBooking` 旁加 `track`）
- Create: `scripts/e2e.d/61-express-track.sh`

**Interfaces:**
- Consumes: Task 1 的 `verifyAndParseExpressTrack`、`ExpressTrackPayload`、`ExpressBookInput.pollCallbackUrl`；批次二的 `applyProviderStatus(tx, booking, payload, after, costAlertRatio)`（`express-callback.ts`）、`recordBookingEvent`、`BOOKING_RANK`、`kdExpressCallbackLimiter`。
- Produces:
  ```ts
  // express-track-json.ts（纯函数，无 prisma）
  export interface StoredTrackItem { context: string; ftime: string }
  export interface StoredTrack { status: string; ischeck: boolean; state: string | null; nu: string | null; items: StoredTrackItem[] }
  export function toStoredTrack(p: ExpressTrackPayload): StoredTrack
  export function parseStoredTrack(v: unknown): StoredTrack | null   // 脏 JSON → null，缺 context/ftime 的条目剔除
  // express-track.ts
  export async function handleExpressTrackCallback(bookingNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }>
  // express-events.ts
  export function makeExpressTrackDedupeKey(bookingNo: string, status: string, rawBody: string): string   // `TR:<bookingNo>:<status>:<md5>`.slice(0,64)
  // RecordBookingEventInput.source: 'CALLBACK' | 'ADMIN' | 'SYSTEM' | 'TRACK'
  // BookingView 新增
  trackStatus: string | null; trackUpdatedAt: string | null; trackCount: number; latestTrack: { context: string; ftime: string } | null
  // GET /api/orders/:id 新增顶层字段
  track: { updatedAt: string | null; signed: boolean; items: { context: string; ftime: string }[] } | null   // 最多 30 条、最新在上；老邮寄单/同城单/无预约/预约 CANCELLED → null
  ```
  Prisma 新列：`staleCheckedAt DateTime? @map("stale_checked_at")`、`staleRemindedAt DateTime? @map("stale_reminded_at")`、`staleTries Int @default(0) @map("stale_tries")`。

- [ ] **Step 1: 迁移与 schema**

`apps/server/prisma/migrations/20260914000000_express_track/migration.sql`：

```sql
-- 批次三：对账任务打标列（时段过期/取件超期主动查单）。纯加列、可空/带默认，回滚代码不需要回滚库。
ALTER TABLE `express_bookings`
  ADD COLUMN `stale_checked_at` DATETIME(3) NULL,
  ADD COLUMN `stale_reminded_at` DATETIME(3) NULL,
  ADD COLUMN `stale_tries` INT NOT NULL DEFAULT 0;
```

`schema.prisma` 的 `ExpressBooking` 里、`reconcileTries` 那行之后加：

```prisma
  staleCheckedAt       DateTime? @map("stale_checked_at")
  staleRemindedAt      DateTime? @map("stale_reminded_at")
  staleTries           Int       @default(0) @map("stale_tries")
```

Run（e2e 库；**不要**跑 `prisma generate` 以外的东西改共享 client——generate 本身必须跑，且其它 agent 此刻不能同时在跑验证）:

```bash
cd apps/server && DATABASE_URL="mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e" npx prisma migrate deploy && npx prisma generate
```

Expected: `1 migration applied`；`Generated Prisma Client`。

- [ ] **Step 2: 写失败的 e2e 片段 `scripts/e2e.d/61-express-track.sh`**

```bash
# 需要 SCHEDULER_DISABLED=true 启动后端（同 §59/§60）。变量 X61_ 前缀。依赖 §58 的 x58_paid_preparing、§59 的 x59_cb / x59_bk。
echo "== 61. 邮寄轨迹：订阅参数/推送落库最新在上/覆盖/去重/验签/签收→完成/先补取件/取消单忽略/顾客契约 =="
X61_CB=/tmp/e2e-xtrack.json
x61_track() { # bookingNo status ischeck state itemsJson → HTTP 码；响应体在 $X61_CB
  local bn="$1" st="$2" chk="$3" state="$4" items="$5" salt param sign
  salt=$(req GET "/api/admin/system/express-mock/salt/$bn" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg s "$st" --arg c "$chk" --arg st2 "$state" --argjson d "$items" '{status:$s, billstatus:"got", message:"", lastResult:{message:"ok", nu:"JD-TRK-61", ischeck:$c, com:"jd", state:$st2, data:$d}}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$X61_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$bn/track" --data-urlencode "param=$param" --data-urlencode "sign=$sign"
}
x61_cust() { req GET "/api/orders/$1" "$UT"; }
X61_I1='[{"context":"【自贡市】已揽收","ftime":"2026-09-10 10:00:00"}]'
X61_I2='[{"context":"【自贡市】已揽收","ftime":"2026-09-10 10:00:00"},{"context":"【成都市】运输中","ftime":"2026-09-10 12:00:00","areaName":"成都"}]'

echo "-- ① 下单参数带 op=1 与 pollCallBackUrl --"
X61_O=$(x58_paid_preparing)
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST "/api/admin/express/orders/$X61_O/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN=$(x59_bk "$X61_O" | jq -r .data.booking.bookingNo)
R=$(req GET "/api/admin/system/express-mock/calls?op=book" "$AT")
assert_eq "book 入参 pollCallbackUrl 指向 /track" "$(jq -r '.data[-1].input.pollCallbackUrl' <<<"$R" | sed "s|.*/api/kd-express/||")" "$X61_BN/track"
assert_eq "顾客契约：无轨迹时 track=null" "$(x61_cust "$X61_O" | jq -c .data.track)" "null"
x59_cb "$X61_BN" 10 '{"kuaidinum":"JD-TRK-61"}' >/dev/null
assert_eq "起点 PICKED" "$(x59_bk "$X61_O" | jq -r .data.booking.status)" "PICKED"

echo "-- ② 推送落库：最新在上；第二次整体覆盖不是追加；重推去重；验签失败不写 --"
HTTPC=$(x61_track "$X61_BN" polling 0 0 "$X61_I1"); assert_eq "轨迹推送 HTTP 200" "$HTTPC" "200"
assert_eq "ack result=true" "$(jq -r .result "$X61_CB")" "true"
R=$(x61_cust "$X61_O"); assert_eq "顾客 track 1 条" "$(jq -r '.data.track.items|length' <<<"$R")" "1"; assert_eq "未签收" "$(jq -r .data.track.signed <<<"$R")" "false"
x61_track "$X61_BN" polling 0 0 "$X61_I2" >/dev/null
R=$(x61_cust "$X61_O"); assert_eq "覆盖后 2 条（不是 3）" "$(jq -r '.data.track.items|length' <<<"$R")" "2"
assert_eq "最新在上" "$(jq -r '.data.track.items[0].context' <<<"$R")" "【成都市】运输中"
assert_eq "顾客契约：条目只有 context/ftime" "$(jq -c '.data.track.items[0]|keys' <<<"$R")" '["context","ftime"]'
R=$(x59_bk "$X61_O"); assert_eq "抽屉最新轨迹" "$(jq -r .data.booking.latestTrack.context <<<"$R")" "【成都市】运输中"; assert_eq "trackCount 2" "$(jq -r .data.booking.trackCount <<<"$R")" "2"; assert_eq "trackStatus polling" "$(jq -r .data.booking.trackStatus <<<"$R")" "polling"
X61_EV=$(jq -r '.data.events|length' <<<"$R")
x61_track "$X61_BN" polling 0 0 "$X61_I2" >/dev/null
assert_eq "同一条重推：事件数不变" "$(x59_bk "$X61_O" | jq -r '.data.events|length')" "$X61_EV"
HTTPC=$(curl -s -o "$X61_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/$X61_BN/track" --data-urlencode 'param={"status":"polling","lastResult":{"ischeck":"1","data":[]}}' --data-urlencode "sign=DEADBEEF")
assert_eq "验签失败 HTTP 200" "$HTTPC" "200"; assert_eq "验签失败不签收仍 PICKED" "$(x59_bk "$X61_O" | jq -r .data.booking.status)" "PICKED"
assert_eq "验签失败不覆盖轨迹" "$(x61_cust "$X61_O" | jq -r '.data.track.items|length')" "2"
HTTPC=$(curl -s -o "$X61_CB" -w '%{http_code}' -X POST "$BASE/api/kd-express/E999999-9/track" --data-urlencode 'param={}' --data-urlencode "sign=DEADBEEF"); assert_eq "未知单号 200" "$HTTPC" "200"

echo "-- ③ 签收：ischeck=1 → DELIVERED、订单 COMPLETED、completedAt 有值；签收后尾随推送仍落 JSON --"
x61_track "$X61_BN" shutdown 1 3 '[{"context":"已签收，签收人：本人","ftime":"2026-09-11 09:00:00"},{"context":"【成都市】运输中","ftime":"2026-09-10 12:00:00"}]' >/dev/null
R=$(x59_bk "$X61_O"); assert_eq "DELIVERED" "$(jq -r .data.booking.status <<<"$R")" "DELIVERED"; assert_eq "不再活跃" "$(jq -r .data.active <<<"$R")" "false"
assert_eq "订单 COMPLETED" "$(order_status $X61_O)" "COMPLETED"
assert_eq "completedAt 有值" "$(sql "SELECT IF(completed_at IS NULL,'NULL','SET') FROM orders WHERE id=$X61_O;")" "SET"
R=$(x61_cust "$X61_O"); assert_eq "顾客 signed=true" "$(jq -r .data.track.signed <<<"$R")" "true"; assert_eq "顾客 expressBooking DELIVERED" "$(jq -r .data.expressBooking.status <<<"$R")" "DELIVERED"
x61_track "$X61_BN" shutdown 1 3 '[{"context":"已签收，签收人：本人（补）","ftime":"2026-09-11 09:00:01"}]' >/dev/null
assert_eq "签收后尾随推送仍更新轨迹" "$(x61_cust "$X61_O" | jq -r '.data.track.items[0].context')" "已签收，签收人：本人（补）"
assert_eq "尾随推送不改状态" "$(x59_bk "$X61_O" | jq -r .data.booking.status)" "DELIVERED"

echo "-- ④ 10 没推到就先来签收：先补 PICKED（订单 SHIPPED + Shipment）再 DELIVERED --"
X61_O2=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O2/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN2=$(x59_bk "$X61_O2" | jq -r .data.booking.bookingNo)
x61_track "$X61_BN2" shutdown 1 3 '[{"context":"已签收","ftime":"2026-09-11 09:00:00"}]' >/dev/null
R=$(x59_bk "$X61_O2"); assert_eq "BOOKED 直接签收 → DELIVERED" "$(jq -r .data.booking.status <<<"$R")" "DELIVERED"
assert_eq "pickedAt 也补上了" "$(jq -r '.data.booking.pickedAt != null' <<<"$R")" "true"
assert_eq "订单 COMPLETED（经过 SHIPPED）" "$(order_status $X61_O2)" "COMPLETED"
assert_eq "Shipment 单号取轨迹 nu、有 shippedAt" "$(sql "SELECT CONCAT(express_no,'|',IF(shipped_at IS NULL,'NULL','SET')) FROM shipments WHERE order_id=$X61_O2;")" "JD-TRK-61|SET"

echo "-- ⑤ abort 只留痕不改状态；取消的预约来轨迹只留痕不写 JSON --"
X61_O3=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O3/book" "$AT" '{"kuaidicom":"jd","dayType":"明天"}' >/dev/null
X61_BN3=$(x59_bk "$X61_O3" | jq -r .data.booking.bookingNo)
HTTPC=$(x61_track "$X61_BN3" abort 0 0 '[]'); assert_eq "abort HTTP 200" "$HTTPC" "200"
R=$(x59_bk "$X61_O3"); assert_eq "abort 不改状态" "$(jq -r .data.booking.status <<<"$R")" "BOOKED"; assert_eq "abort 留痕事件" "$(jq -r '[.data.events[]|select(.source=="TRACK")]|length' <<<"$R")" "1"
req POST "/api/admin/express/orders/$X61_O3/booking/cancel" "$AT" '{}' >/dev/null
x61_track "$X61_BN3" polling 0 0 "$X61_I1" >/dev/null
assert_eq "取消后来轨迹：顾客 track 仍 null" "$(x61_cust "$X61_O3" | jq -c .data.track)" "null"
assert_eq "取消后来轨迹：只留痕" "$(x59_bk "$X61_O3" | jq -r '[.data.events[]|select(.source=="TRACK")]|length')" "2"

echo "-- ⑥ 老邮寄单（手填单号）契约不变：expressBooking/track 都是 null --"
X61_O4=$(x58_paid_preparing)
req POST "/api/admin/orders/$X61_O4/ship" "$AT" '{"expressCompany":"顺丰","expressNo":"SF-OLD-61"}' >/dev/null
R=$(x61_cust "$X61_O4"); assert_eq "老单 expressBooking=null" "$(jq -c .data.expressBooking <<<"$R")" "null"; assert_eq "老单 track=null" "$(jq -c .data.track <<<"$R")" "null"
assert_eq "老单 Shipment 照旧" "$(jq -r .data.shipment.expressNo <<<"$R")" "SF-OLD-61"
X61_KEEP_O=$X61_O   # DELIVERED，留给 §62/工作台走查
```

- [ ] **Step 3: 跑 e2e 确认失败**

Run（后端已按 Global Constraints 起在 3100）: `DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | grep -A3 "== 61\." | head; DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tail -1`
Expected: §61 ①「book 入参 pollCallbackUrl」之后大面积 ✘（`/track` 路由 404、`track` 字段不存在）；末行失败数 > 0。

- [ ] **Step 4: `express-track-json.ts`**

```ts
/** 轨迹 JSON 的存储形状与容错解析。纯函数：bookingView / 顾客详情 / 回调落库三处共用，不碰 prisma。 */
import type { ExpressTrackPayload } from './express-callback-sign'

export interface StoredTrackItem { context: string; ftime: string }
export interface StoredTrack { status: string; ischeck: boolean; state: string | null; nu: string | null; items: StoredTrackItem[] }

export function toStoredTrack(p: ExpressTrackPayload): StoredTrack {
  return { status: p.status, ischeck: p.ischeck, state: p.state, nu: p.nu, items: p.items.map((x) => ({ context: x.context, ftime: x.ftime })) }
}
/** 库里的 JSON 可能是老版本/人工改过：字段缺就补默认，条目缺 context/ftime 就剔除，整体不是对象就当没有 */
export function parseStoredTrack(v: unknown): StoredTrack | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const items: StoredTrackItem[] = []
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const r = (it && typeof it === 'object' && !Array.isArray(it) ? it : {}) as Record<string, unknown>
    if (typeof r.context === 'string' && r.context && typeof r.ftime === 'string' && r.ftime) items.push({ context: r.context, ftime: r.ftime })
  }
  return { status: typeof o.status === 'string' ? o.status : '', ischeck: o.ischeck === true, state: typeof o.state === 'string' ? o.state : null, nu: typeof o.nu === 'string' ? o.nu : null, items }
}
```

- [ ] **Step 5: `express-events.ts`**

`RecordBookingEventInput.source` 改为 `'CALLBACK' | 'ADMIN' | 'SYSTEM' | 'TRACK'`；加：

```ts
export function makeExpressTrackDedupeKey(bookingNo: string, status: string, rawBody: string): string {
  return `TR:${bookingNo}:${status}:${md5hex(rawBody)}`.slice(0, 64)
}
```

- [ ] **Step 6: `express-track.ts`**

```ts
/**
 * 快递100 轨迹推送（pollCallBackUrl）落库。轨迹是「展示层」事实：trackJson 整体覆盖，不逐条合并。
 * 只有「签收」推进预约状态——若还停在 BOOKED/ACCEPTED（10 没推到），先按 10 走一遍让订单 SHIPPED、
 * 发发货通知，再按 13 收尾；两步都复用批次二的 applyProviderStatus，状态机规则只有一份。
 * 顺序同状态回调：查单 → 验签 → 事务内去重留痕 → 写 JSON → 签收推进 → 事务外通知。
 */
import { ExpressBooking, Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { verifyAndParseExpressTrack, ExpressTrackPayload, ExpressCallbackPayload } from './express-callback-sign'
import { recordBookingEvent, makeExpressTrackDedupeKey } from './express-events'
import { BOOKING_RANK } from './express-booking-state'
import { applyProviderStatus } from './express-callback'
import { toStoredTrack } from './express-track-json'
import { notifySystemAlert } from '../notify'
import { notifyExpressAlert } from '../order-notify'
import { getExpressSettings, COURIER_LABEL } from '../express-settings'

/** 快递100 lastResult.state：0 在途 1 揽收 2 疑难 3 签收 4 退签 5 派件 6 退回 14 拒签 */
const RETURN_STATES = ['4', '6', '14']
const NO_TRACK_STATUSES = ['CANCELLED', 'FAILED', 'VOID']

type BookingWithOrder = ExpressBooking & { order: { orderNo: string; user: { openid: string }; items: { productName: string }[] } }

export async function handleExpressTrackCallback(bookingNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const booking = await prisma.expressBooking.findUnique({ where: { bookingNo }, include: { order: { include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1, orderBy: { id: 'asc' } } } } } })
  if (!booking) {
    notifySystemAlert('快递100 轨迹推送查不到预约', [`bookingNo=${bookingNo}`], { key: 'kd-express:track-unknown-booking' })
    return { http: 200 }
  }
  const parsed = verifyAndParseExpressTrack(body, booking.callbackSalt)
  if (!parsed.ok) {
    try { await recordBookingEvent(prisma, { bookingId: booking.id, dedupeKey: makeExpressTrackDedupeKey(bookingNo, 'BAD', rawBody), source: 'TRACK', statusDesc: parsed.reason === 'SIGN_MISMATCH' ? '轨迹推送验签失败' : '轨迹推送格式异常' }) } catch { /* 留痕失败不升级 */ }
    // 固定 key 不带 bookingNo：同状态回调的理由（bookingNo 可枚举，按它分 key 会被刷穿去重）
    notifySystemAlert('快递100 轨迹推送验签失败', [`bookingNo=${bookingNo}`], { key: 'kd-express:track-sign-fail' })
    return { http: 200 }
  }
  const p = parsed.payload
  const after: (() => void)[] = []
  const { costAlertRatio } = await getExpressSettings()
  try {
    await prisma.$transaction(async (tx) => {
      const ev = await recordBookingEvent(tx, { bookingId: booking.id, dedupeKey: makeExpressTrackDedupeKey(bookingNo, p.status, rawBody), source: 'TRACK', statusDesc: trackEventDesc(p), rawPayload: p.raw as Prisma.InputJsonValue })
      if (ev.duplicate) return
      // 取消/失败/作废的预约不该再有轨迹；来了只留痕，不写 JSON——顾客端读的是「最新一条预约」，
      // 店员取消后重约的新单不能被旧单的轨迹顶掉（旧单在 findFirst orderBy id desc 里不是最新，但保险起见不写）
      if (NO_TRACK_STATUSES.includes(booking.status)) return
      await tx.expressBooking.update({ where: { id: booking.id }, data: { trackJson: toStoredTrack(p) as unknown as Prisma.InputJsonValue, trackStatus: p.status.slice(0, 16), trackUpdatedAt: new Date() } })
      const label = COURIER_LABEL[booking.kuaidicom] ?? booking.kuaidicom
      if (p.status === 'abort') {
        after.push(() => notifyExpressAlert('快递100 轨迹订阅中止', [`订单 ${booking.orderNo} · ${label}${booking.kuaidinum ? ` ${booking.kuaidinum}` : ''}`, p.message ?? '单号可能有误或已超期', '顾客端将看不到后续轨迹，可到快递100 后台核对'], { key: `express-track-abort:${booking.id}` }))
      }
      if (p.state && RETURN_STATES.includes(p.state)) {
        after.push(() => notifyExpressAlert('快递100 轨迹显示退签/退回', [`订单 ${booking.orderNo} · ${label}${booking.kuaidinum ? ` ${booking.kuaidinum}` : ''}`, p.items[0]?.context ?? '', '请联系快递员或顾客处理'], { key: `express-track-return:${booking.id}` }))
      }
      if (!p.ischeck || booking.status === 'DELIVERED') return
      // 签收 = 取件 + 签收两件事都成立：没到 PICKED 的先按 10 走一遍（订单 SHIPPED、Shipment、发货通知），再按 13 收尾
      const steps = booking.statusRank < BOOKING_RANK.PICKED ? ['10', '13'] : ['13']
      let cur: BookingWithOrder = booking
      for (const s of steps) {
        await applyProviderStatus(tx, cur, syntheticPayload(cur, p, s), after, costAlertRatio)
        const st = s === '10' ? 'PICKED' : 'DELIVERED'
        cur = { ...cur, status: st, statusRank: BOOKING_RANK[st], kuaidinum: p.nu ?? cur.kuaidinum }
      }
    })
  } catch (e) {
    console.error('[kd-express-track] 处理失败:', e)
    return { http: 500 }
  }
  for (const f of after) { try { f() } catch (e) { console.error('[kd-express-track] after 失败:', e) } }
  return { http: 200 }
}

function trackEventDesc(p: ExpressTrackPayload): string {
  const latest = p.items[0]?.context ?? ''
  return `轨迹 ${p.status}${p.ischeck ? '（已签收）' : ''}${latest ? `：${latest.slice(0, 120)}` : p.message ? `：${p.message.slice(0, 120)}` : ''}`
}
/** 把轨迹签收翻译成状态回调的形状交给 applyProviderStatus：只带单号（轨迹的 nu），不带费用/快递员 */
function syntheticPayload(b: ExpressBooking, p: ExpressTrackPayload, status: string): ExpressCallbackPayload {
  return { status, taskId: null, kdOrderId: null, kuaidinum: p.nu ?? b.kuaidinum, courierName: null, courierMobile: null, weightKg: null, freightFen: null, defPriceFen: null, feeDetails: null, statusDesc: status === '13' ? '轨迹显示已签收' : '轨迹显示已揽收（补取件）', raw: p.raw }
}
```

- [ ] **Step 7: 路由 `kd-express-callback.ts`**（在既有 `router.post('/:bookingNo', …)` **之前**加，注释说明两条路由共用限流与 ack）

```ts
import { handleExpressTrackCallback } from '../services/delivery/express-track'
// 轨迹推送（bOrder 的 pollCallBackUrl）：同 salt、同验签、同限流、同 ack 形状；只是处理函数不同
router.post('/:bookingNo/track', kdExpressCallbackLimiter, express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  let http: 200 | 500 = 200
  try { http = (await handleExpressTrackCallback(String(req.params.bookingNo), (req.body ?? {}) as Record<string, string>)).http }
  catch (e) { console.error('[kd-express-track] 未捕获异常:', e); http = 500 }
  if (http === 200) res.json({ result: true, returnCode: '200', message: '成功' })
  else res.status(500).json({ result: false, returnCode: '500', message: '服务器异常，请重推' })
})
```

- [ ] **Step 8: `createBooking` 与 `config.ts`**

`express-booking.ts` `createBooking` 里 `callbackUrl` 两行之后加：

```ts
  const pollCallbackUrl = `${callbackUrl}/track`
  if (Buffer.byteLength(pollCallbackUrl) > 200) throw new AppError(42225, `轨迹回调地址超长（${pollCallbackUrl.length}>200），请联系管理员`)
```

`book({ … callbackUrl, salt: callbackSalt })` 改成 `book({ … callbackUrl, pollCallbackUrl, salt: callbackSalt })`（去掉 Task 1 Step 5 的临时写法）。

`config.ts:154` 的最坏 URL 改成带 `/track` 的那条（它比状态回调 URL 长 6 字节，两条都覆盖）：

```ts
  // 邮寄取件回调（bOrder 的 callBackUrl / pollCallBackUrl）各限长 200；最坏的是轨迹那条 E999999-99/track，它过了状态回调也过。
  const worstKdExpressUrl = `${publicBaseUrl}/api/kd-express/E999999-99/track`
```

- [ ] **Step 9: `bookingView` 与顾客详情**

`express-booking.ts`：`import { parseStoredTrack } from './express-track-json'`；`BookingView` 接口加

```ts
  trackStatus: string | null; trackUpdatedAt: string | null; trackCount: number; latestTrack: { context: string; ftime: string } | null
```

`bookingView()` 返回对象里加（`iso` 已有）：

```ts
    trackStatus: b.trackStatus, trackUpdatedAt: iso(b.trackUpdatedAt),
    trackCount: parseStoredTrack(b.trackJson)?.items.length ?? 0,
    latestTrack: parseStoredTrack(b.trackJson)?.items[0] ?? null,
```

`routes/orders.ts` 顾客详情：`import { parseStoredTrack } from '../services/delivery/express-track-json'`；在 `let expressBooking …` 之后加 `let track: { updatedAt: string | null; signed: boolean; items: { context: string; ftime: string }[] } | null = null`，在 `if (b && !['FAILED', 'VOID'].includes(b.status)) { … }` 里、`expressBooking = {…}` 之后加：

```ts
        // 轨迹只给非取消的预约；最多 30 条、最新在上（服务端已排好序）。老邮寄单/同城单没有预约行，自然是 null。
        const st = b.status !== 'CANCELLED' ? parseStoredTrack(b.trackJson) : null
        if (st && st.items.length) track = { updatedAt: b.trackUpdatedAt ? b.trackUpdatedAt.toISOString() : null, signed: st.ischeck, items: st.items.slice(0, 30) }
```

`success(res, { …, expressBooking, track })`。

- [ ] **Step 10: tsc + selftest + e2e 全量**

Run:
```bash
cd apps/server && npx tsc --noEmit && npx ts-node --transpile-only scripts/selftest-express-booking.ts | tail -1
cd ../.. && DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tail -1
```
Expected: tsc 干净；`通过 19 条`；e2e `通过 N / 失败 0`，N ≥ 1405 + 30（§61 ①–⑥ 断言数）。若 §61 ④「Shipment 单号取轨迹 nu」红：检查 `applyProviderStatus` 的 Shipment upsert 条件 `current.activeOrderId === current.orderId`（BOOKED 单是活跃的，应满足）。

- [ ] **Step 11: Commit**

```bash
git add apps/server/prisma scripts/e2e.d/61-express-track.sh apps/server/src/services/delivery/express-track.ts apps/server/src/services/delivery/express-track-json.ts apps/server/src/services/delivery/express-events.ts apps/server/src/services/delivery/express-booking.ts apps/server/src/routes/kd-express-callback.ts apps/server/src/routes/orders.ts apps/server/src/config.ts
git commit -m "邮寄轨迹落库：/track 回调（同 salt 验签/去重/覆盖写 JSON）、签收→DELIVERED/COMPLETED（未取件先补 10）、下单传 pollCallBackUrl、预约视图与顾客详情带轨迹、e2e 61、stale 三列迁移"
```

---

### Task 3: 对账定时任务——时段过期未取件 / 取件超 10 天未签收主动查单

**Files:**
- Modify: `apps/server/src/services/delivery/express-booking-tasks.ts`（末尾加 `reconcileExpressStale`、`reconcileStaleBooking`）
- Modify: `apps/server/src/services/scheduler.ts:25`（import）、`:53-85`（`SchedulerOverrides`）、`:115-117`（任务表）
- Modify: `apps/server/src/routes/admin/system.ts:123-125`
- Modify: `scripts/e2e.d/61-express-track.sh`（追加 ⑦）

**Interfaces:**
- Consumes: `unpickedCutoff`（同文件）、`getExpressProvider().detail({ taskId, thirdOrderId })` → `ExpressDetailResult`、`applyProviderStatus`、`KD_EXPRESS_STATUS_MAP`、`recordBookingEvent`。
- Produces:
  ```ts
  export async function reconcileExpressStale(intervalMin = 30, pickedDays = 10): Promise<number>   // 返回本轮推进了状态的预约数
  export async function reconcileStaleBooking(bookingId: number): Promise<'ADVANCED' | 'UNCHANGED' | 'NOT_FOUND' | 'ERROR'>
  // SchedulerOverrides 新增 expressStaleIntervalMin?: number; expressPickedStaleDays?: number
  // 任务名 'expressStale'（run-scheduler 响应里的 key）
  ```

- [ ] **Step 1: e2e 先写（追加到 `61-express-track.sh` 末尾、`X61_KEEP_O=` 之前）**

```bash
echo "-- ⑦ 对账：时段过期未取件 → detail 补 10；取件超 10 天 → detail 补 13；查不到只提醒一次、间隔内不重查 --"
X61_O5=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O5/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN5=$(x59_bk "$X61_O5" | jq -r .data.booking.bookingNo)
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "时段未过：不查单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "时段未过：detail 未被调" "$(req GET "/api/admin/system/express-mock/calls?op=detail" "$AT" | jq -r '.data|length')" "0"
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN5';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":10,"kuaidinum":"JD-ST-61"}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "过期查单：推进 1 单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "1"
R=$(x59_bk "$X61_O5"); assert_eq "detail 10 → PICKED" "$(jq -r .data.booking.status <<<"$R")" "PICKED"; assert_eq "补单号" "$(jq -r .data.booking.kuaidinum <<<"$R")" "JD-ST-61"
assert_eq "订单 SHIPPED" "$(order_status $X61_O5)" "SHIPPED"
assert_eq "对账事件留痕 SYSTEM" "$(jq -r '[.data.events[]|select(.source=="SYSTEM" and (.statusDesc|test("对账")))]|length' <<<"$R")" "1"
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "PICKED 未满 10 天：不查" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
sql "UPDATE express_bookings SET picked_at=DATE_SUB(NOW(), INTERVAL 11 DAY), stale_checked_at=NULL WHERE booking_no='$X61_BN5';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":true,"status":13}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "取件超期查单：推进 1 单" "$(jq -r '.data.expressStale // -1' <<<"$R")" "1"
assert_eq "detail 13 → DELIVERED" "$(x59_bk "$X61_O5" | jq -r .data.booking.status)" "DELIVERED"
assert_eq "订单 COMPLETED" "$(order_status $X61_O5)" "COMPLETED"
# 查不到：提醒一次、计次；间隔 30 分钟内不重查
X61_O6=$(x58_paid_preparing)
req POST "/api/admin/express/orders/$X61_O6/book" "$AT" '{"kuaidicom":"jd","dayType":"今天"}' >/dev/null
X61_BN6=$(x59_bk "$X61_O6" | jq -r .data.booking.bookingNo)
sql "UPDATE express_bookings SET pickup_date='2020-01-01', pickup_end='09:00' WHERE booking_no='$X61_BN6';"
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}'); assert_eq "查不到：不推进" "$(jq -r '.data.expressStale // -1' <<<"$R")" "0"
assert_eq "查不到：仍 BOOKED" "$(x59_bk "$X61_O6" | jq -r .data.booking.status)" "BOOKED"
assert_eq "查不到：提醒已打标" "$(sql "SELECT IF(stale_reminded_at IS NULL,'NULL','SET') FROM express_bookings WHERE booking_no='$X61_BN6';")" "SET"
X61_REM=$(sql "SELECT stale_reminded_at FROM express_bookings WHERE booking_no='$X61_BN6';")
req POST /api/admin/system/express-mock/queue "$AT" '{"op":"detail","directive":{"kind":"ok","found":false}}' >/dev/null
R=$(sched '{"expressStaleIntervalMin":0}')
assert_eq "第二轮：计次 2" "$(sql "SELECT stale_tries FROM express_bookings WHERE booking_no='$X61_BN6';")" "2"
assert_eq "第二轮：提醒时间不变（只一次）" "$(sql "SELECT stale_reminded_at FROM express_bookings WHERE booking_no='$X61_BN6';")" "$X61_REM"
X61_DET=$(req GET "/api/admin/system/express-mock/calls?op=detail" "$AT" | jq -r '.data|length')
R=$(sched '{"expressStaleIntervalMin":30}')
assert_eq "30 分钟内不重查（detail 调用数不变）" "$(req GET "/api/admin/system/express-mock/calls?op=detail" "$AT" | jq -r '.data|length')" "$X61_DET"
req POST "/api/admin/express/orders/$X61_O6/booking/cancel" "$AT" '{}' >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
```

- [ ] **Step 2: 跑 §61 确认 ⑦ 失败**

Run: `DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | grep -A2 "⑦ 对账" | head -5`
Expected: 「时段未过：不查单」期望 0 实际 -1（`expressStale` 任务不存在）。

- [ ] **Step 3: 实现 `reconcileExpressStale`（`express-booking-tasks.ts` 末尾）**

文件头 import 补：

```ts
import { Prisma } from '@prisma/client'
import { getExpressProvider } from './kd100-express'
import { KD_EXPRESS_STATUS_MAP } from './express-booking-state'
import { applyProviderStatus } from './express-callback'
import { recordBookingEvent } from './express-events'
import crypto from 'crypto'
```

```ts
const STALE_MAX_TRIES = 48   // 每 30 分钟一次 = 24 小时；之后不再自动查，靠人工
const orderInclude = { order: { include: { user: { select: { openid: true } }, items: { select: { productName: true }, take: 1, orderBy: { id: 'asc' as const } } } } }

/**
 * 「该有回调了却没有」的两类单主动查单（spec §7 对账任务）：
 *  A. BOOKED/ACCEPTED 且预约时段结束 + unpickedRemindMin 已过——快递100 有时不推揽收/揽货失败；
 *  B. PICKED 且取件已超 pickedDays 天——13 签收没推到（autoComplete 7 天已把订单转 COMPLETED，这里只是把预约收尾）。
 * 每单每 intervalMin 分钟最多查一次、累计最多 STALE_MAX_TRIES 次；查到就按回调同一套 applyProviderStatus 推进；
 * 查不到/无进展只提醒一次（staleRemindedAt 打标 count=1 才推送）。
 */
export async function reconcileExpressStale(intervalMin = 30, pickedDays = 10): Promise<number> {
  const s = await getExpressSettings()
  const { cutDate, nowHm } = unpickedCutoff(new Date(), s.pickup.unpickedRemindMin)
  const due: Prisma.ExpressBookingWhereInput = { staleTries: { lt: STALE_MAX_TRIES }, OR: [{ staleCheckedAt: null }, { staleCheckedAt: { lt: ago(intervalMin) } }] }
  const rows = await prisma.expressBooking.findMany({
    where: { OR: [
      { status: { in: ['BOOKED', 'ACCEPTED'] }, AND: [{ OR: [{ pickupDate: { lt: cutDate } }, { pickupDate: cutDate, pickupEnd: { lte: nowHm } }] }, due] },
      { status: 'PICKED', pickedAt: { lt: ago(pickedDays * 24 * 60) }, AND: [due] },
    ] },
    take: BATCH, select: { id: true, staleCheckedAt: true },
  })
  let n = 0
  for (const b of rows) {
    // 先占坑再查：并发双 tick 只有一个能把 staleCheckedAt 从旧值改掉
    const claimed = await prisma.expressBooking.updateMany({ where: { id: b.id, staleCheckedAt: b.staleCheckedAt }, data: { staleCheckedAt: new Date(), staleTries: { increment: 1 } } })
    if (claimed.count === 0) continue
    if ((await reconcileStaleBooking(b.id)) === 'ADVANCED') n++
  }
  return n
}

export async function reconcileStaleBooking(bookingId: number): Promise<'ADVANCED' | 'UNCHANGED' | 'NOT_FOUND' | 'ERROR'> {
  const b = await prisma.expressBooking.findUnique({ where: { id: bookingId }, include: orderInclude })
  if (!b || !['BOOKED', 'ACCEPTED', 'PICKED'].includes(b.status)) return 'UNCHANGED'
  const label = COURIER_LABEL[b.kuaidicom] ?? b.kuaidicom
  let result: 'ADVANCED' | 'UNCHANGED' | 'NOT_FOUND' | 'ERROR'
  try {
    const d = await getExpressProvider().detail({ taskId: b.taskId, thirdOrderId: b.bookingNo })
    if (!d.found || d.status === null) result = 'NOT_FOUND'
    else {
      const status = String(d.status)
      const rawStr = JSON.stringify(d.raw ?? {})
      const { costAlertRatio } = await getExpressSettings()
      const after: (() => void)[] = []
      await prisma.$transaction(async (tx) => {
        const ev = await recordBookingEvent(tx, { bookingId: b.id, dedupeKey: `RC:${b.bookingNo}:${status}:${crypto.createHash('md5').update(rawStr, 'utf8').digest('hex')}`.slice(0, 64), source: 'SYSTEM', providerStatus: /^\d+$/.test(status) ? Number(status) : null, statusDesc: `对账查单：快递100 状态 ${status}${KD_EXPRESS_STATUS_MAP[status] && 'label' in KD_EXPRESS_STATUS_MAP[status] ? `（${(KD_EXPRESS_STATUS_MAP[status] as { label: string }).label}）` : ''}`, rawPayload: d.raw as Prisma.InputJsonValue })
        if (ev.duplicate) return
        await applyProviderStatus(tx, b, { status, taskId: d.taskId, kdOrderId: d.kdOrderId, kuaidinum: d.kuaidinum, courierName: d.courierName, courierMobile: d.courierMobile, weightKg: null, freightFen: d.freightFen, defPriceFen: null, feeDetails: null, statusDesc: '对账补状态', raw: (d.raw ?? {}) as Record<string, unknown> }, after, costAlertRatio)
      })
      for (const f of after) { try { f() } catch (e) { console.error('[express-stale] after 失败:', e) } }
      const now = await prisma.expressBooking.findUnique({ where: { id: b.id }, select: { status: true } })
      result = now && now.status !== b.status ? 'ADVANCED' : 'UNCHANGED'
    }
  } catch (e) {
    console.warn('[express-stale] detail 失败:', (e as Error).message)
    result = 'ERROR'
  }
  if (result === 'ADVANCED') return result
  // 无结论只提醒一次；ERROR（快递100 抖动）不算结论，不提醒也不占用那一次
  if (result !== 'ERROR') {
    const m = await prisma.expressBooking.updateMany({ where: { id: b.id, staleRemindedAt: null }, data: { staleRemindedAt: new Date() } })
    if (m.count > 0) {
      const why = b.status === 'PICKED'
        ? [`已取件超过 10 天仍无签收回调，主动查单${result === 'NOT_FOUND' ? '查不到该单' : '也无新进展'}`, '订单已按 7 天规则自动完成；如顾客反馈未收到，请到快递100 后台或联系快递公司查件']
        : [`预约时段已过，至今无取件回调，主动查单${result === 'NOT_FOUND' ? '查不到该单' : '也无新进展'}`, '请联系快递员确认是否已取件；未取请改约或取消后换家重约']
      notifyExpressAlert(b.status === 'PICKED' ? '邮寄单取件后长时间未签收' : '预约时段过后仍无进展', [`订单 ${b.orderNo} · ${label}${b.kuaidinum ? ` ${b.kuaidinum}` : ''}`, ...why], { key: `express-stale:${b.id}` })
    }
  }
  return result
}
```

- [ ] **Step 4: 注册任务与覆盖参数**

`scheduler.ts:25` import 加 `reconcileExpressStale`；`SchedulerOverrides` 在 `expressUnknownMin?: number` 后加

```ts
  /** 批次三对账任务：查单间隔（分钟）、取件后多少天算超期 */
  expressStaleIntervalMin?: number
  expressPickedStaleDays?: number
```

任务表 `['expressUnpicked', …]` 之后加：

```ts
    ['expressStale', () => reconcileExpressStale(overrides.expressStaleIntervalMin, overrides.expressPickedStaleDays)],
```

`routes/admin/system.ts` 的 `runSchedulerTick({ … expressUnknownMin: num(body.expressUnknownMin),` 后加：

```ts
        expressStaleIntervalMin: num(body.expressStaleIntervalMin),
        expressPickedStaleDays: num(body.expressPickedStaleDays),
```

- [ ] **Step 5: tsc + e2e**

Run:
```bash
cd apps/server && npx tsc --noEmit && cd ../.. && DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tail -1
```
Expected: tsc 干净；`失败 0`，通过数比 Task 2 再多 16（⑦ 断言数）。若「过期查单：推进 1 单」得 0：确认 `unpickedCutoff` 传的是 `unpickedRemindMin`（e2e 把 `pickup_date` 改到 2020 年，任何阈值都过期）且 mock `detail` 指令已入队（`SCHEDULER_DISABLED` 没开的话心跳会先吃掉它）。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/delivery/express-booking-tasks.ts apps/server/src/services/scheduler.ts apps/server/src/routes/admin/system.ts scripts/e2e.d/61-express-track.sh
git commit -m "邮寄对账任务：时段过期未取件 / 取件超 10 天未签收主动 detail 补状态，每 30 分钟一次封顶 48 次，无结论提醒一次"
```

---

### Task 4: 小程序订单详情——物流轨迹时间线、已签收卡、纯函数单测

**Files:**
- Create: `apps/miniapp/utils/express-track.js`（ES5）
- Modify: `apps/miniapp/pages/order/detail.js:258-276`（阶段文案改调 util）、`:284-286`（新字段）
- Modify: `apps/miniapp/pages/order/detail.wxml:244-272`（轨迹卡）
- Modify: `apps/miniapp/pages/order/detail.wxss`（`.track*`）
- Create: `tests/miniapp/express-track.test.cjs`

**Interfaces:**
- Consumes: 服务端 `GET /api/orders/:id` 的 `expressBooking`（批次二）与 `track`（Task 2）。
- Produces（`utils/express-track.js`）:
  ```js
  buildExpressTrack(track)   // → [{ context, timeText }]，脏条目剔除；track 为 null/缺 items → []
  expressStageText(order)    // → string；'' 表示不显示阶段卡（与批次二行为逐字一致，只多 COMPLETED 一支）
  ```

- [ ] **Step 1: 先写单测 `tests/miniapp/express-track.test.cjs`**

```js
// 邮寄订单详情的物流卡文案（spec §4.2 六种）与轨迹容错。纯函数，直接 require utils，不需要 Page 环境。
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildExpressTrack, expressStageText } = require(path.join(__dirname, '..', '..', 'apps', 'miniapp', 'utils', 'express-track.js'))

const base = { deliveryType: 'EXPRESS', status: 'PREPARING', expressBooking: null }
const eb = (status, extra) => Object.assign({ status, statusLabel: '', courierLabel: '京东物流', courierName: null, slotText: '9月9日 14:00–16:00', kuaidinum: null }, extra || {})

test('§4.2 六种卡片文案', () => {
  assert.equal(expressStageText(base), '商家备货中')
  assert.equal(expressStageText({ ...base, status: 'PAID' }), '商家备货中')
  assert.equal(expressStageText({ ...base, expressBooking: eb('CANCELLED') }), '商家备货中')
  assert.equal(expressStageText({ ...base, expressBooking: eb('PENDING') }), '商家备货中')
  assert.equal(expressStageText({ ...base, expressBooking: eb('BOOKED') }), '已预约快递员上门取件 · 9月9日 14:00–16:00')
  assert.equal(expressStageText({ ...base, expressBooking: eb('UNKNOWN') }), '已预约快递员上门取件 · 9月9日 14:00–16:00')
  assert.equal(expressStageText({ ...base, expressBooking: eb('ACCEPTED', { courierName: '张师傅' }) }), '快递员已接单 · 张师傅 · 9月9日 14:00–16:00')
  assert.equal(expressStageText({ ...base, expressBooking: eb('PICKED', { kuaidinum: 'JD001' }) }), '已取件 · 京东物流 JD001')
  // 已发货：让位给 Shipment 卡（批次二决定，不变）
  assert.equal(expressStageText({ ...base, status: 'SHIPPED', expressBooking: eb('PICKED', { kuaidinum: 'JD001' }) }), '')
  // 批次三：订单完成且预约签收 → 已签收；老邮寄单（无预约）完成 → 仍不显示阶段卡
  assert.equal(expressStageText({ ...base, status: 'COMPLETED', expressBooking: eb('DELIVERED', { kuaidinum: 'JD001' }) }), '已签收 · 京东物流 JD001')
  assert.equal(expressStageText({ ...base, status: 'COMPLETED', expressBooking: eb('PICKED', { kuaidinum: 'JD001' }) }), '已签收 · 京东物流 JD001')
  assert.equal(expressStageText({ ...base, status: 'COMPLETED' }), '')
  assert.equal(expressStageText({ ...base, status: 'COMPLETED', expressBooking: eb('CANCELLED') }), '')
  // 同城/取消/退款：不显示
  assert.equal(expressStageText({ ...base, deliveryType: 'LOCAL', expressBooking: eb('BOOKED') }), '')
  assert.equal(expressStageText({ ...base, status: 'CANCELLED', expressBooking: eb('BOOKED') }), '')
  assert.equal(expressStageText({ ...base, status: 'REFUNDED', expressBooking: eb('PICKED') }), '')
})

test('轨迹：最新在上照服务端顺序、脏条目剔除、空/缺字段不抛', () => {
  assert.deepEqual(buildExpressTrack(null), [])
  assert.deepEqual(buildExpressTrack({}), [])
  assert.deepEqual(buildExpressTrack({ items: 'x' }), [])
  assert.deepEqual(buildExpressTrack({ items: [null, 1, { ftime: '2026-09-10 10:00:00' }, { context: '' }] }), [])
  const r = buildExpressTrack({ signed: false, items: [{ context: '【成都市】运输中', ftime: '2026-09-10 12:00:00' }, { context: '【自贡市】已揽收', ftime: 20260910 }] })
  assert.deepEqual(r, [{ context: '【成都市】运输中', timeText: '2026-09-10 12:00:00' }, { context: '【自贡市】已揽收', timeText: '' }])
})
```

- [ ] **Step 2: 跑单测确认失败**

Run: `node --test tests/miniapp/express-track.test.cjs 2>&1 | tail -3`
Expected: `Cannot find module '.../utils/express-track.js'`。

- [ ] **Step 3: 写 `apps/miniapp/utils/express-track.js`**

```js
// 邮寄订单详情的「物流信息」阶段文案与轨迹条目整理。纯函数、无 wx 依赖，
// tests/miniapp/express-track.test.cjs 直接 require。ES5：scripts/check-miniapp-es5.mjs 闸门。
//
// 阶段文案（spec §4.2）：
//   PAID/PREPARING 无活跃预约 → 商家备货中；BOOKED/UNKNOWN → 已预约…；ACCEPTED → 快递员已接单…；
//   PICKED/DELIVERED（未发货前）→ 已取件…；SHIPPED → ''（让位给 Shipment 卡）；COMPLETED 且预约到过取件 → 已签收…
function expressStageText(order) {
  if (!order || order.deliveryType !== 'EXPRESS') return ''
  var st = order.status
  if (['PAID', 'PREPARING', 'SHIPPED', 'COMPLETED'].indexOf(st) === -1) return ''
  var eb = order.expressBooking
  var ebs = eb ? eb.status : ''
  var tail = eb ? (eb.courierLabel || '') + (eb.kuaidinum ? ' ' + eb.kuaidinum : '') : ''
  if (st === 'COMPLETED') {
    // 只有预约真的走到取件/签收才说「已签收」；老邮寄单（手填单号）没有预约，照旧不显示这张卡
    return ebs === 'DELIVERED' || ebs === 'PICKED' ? '已签收 · ' + tail : ''
  }
  if (st === 'SHIPPED') return ''
  if (ebs === 'BOOKED' || ebs === 'UNKNOWN') return '已预约快递员上门取件' + (eb.slotText ? ' · ' + eb.slotText : '')
  if (ebs === 'ACCEPTED') return '快递员已接单' + (eb.courierName ? ' · ' + eb.courierName : '') + (eb.slotText ? ' · ' + eb.slotText : '')
  if (ebs === 'PICKED' || ebs === 'DELIVERED') return '已取件 · ' + tail
  // 无预约 / 已取消 / 下单中（PENDING）/ 未识别状态：对顾客一律「商家备货中」
  return '商家备货中'
}

// 服务端 track.items 已是最新在上；这里只做容错（缺 context 的条目剔除、ftime 非字符串留空），不排序
function buildExpressTrack(track) {
  var out = []
  if (!track || !track.items || !track.items.length || typeof track.items.length !== 'number') return out
  for (var i = 0; i < track.items.length; i++) {
    var it = track.items[i]
    if (!it || typeof it.context !== 'string' || !it.context) continue
    out.push({ context: it.context, timeText: typeof it.ftime === 'string' ? it.ftime : '' })
  }
  return out
}

module.exports = { expressStageText: expressStageText, buildExpressTrack: buildExpressTrack }
```

- [ ] **Step 4: `detail.js` 改调 util**

文件头 `var fmtHHmm = timeUtil.fmtHHmm` 之后加：

```js
var expressTrackUtil = require('../../utils/express-track')
```

`decorateOrder` 里把 `var expressStageText = ''` 到 `}`（原 260–276 行那段 if 块）整体替换为：

```js
  var expressStageText = expressTrackUtil.expressStageText(order)
  var expressTrack = isExpress ? expressTrackUtil.buildExpressTrack(order.track) : []
```

返回对象里 `showExpressStage: !!expressStageText,` 之后加：

```js
    expressTrack: expressTrack,
    showExpressTrack: expressTrack.length > 0,
```

- [ ] **Step 5: `detail.wxml`**——在「Shipment」卡（`wx:if="{{!order.isLocal && order.shipment && !order.showExpressStage}}"`）那个 `</view>` 之后、`<view class="spacer">` 之前加：

```xml
  <!-- 邮寄轨迹：服务端 track（快递100 推送落库）最新在上，只读；脏条目已在 utils/express-track 剔除 -->
  <view class="card" wx:if="{{order.showExpressTrack}}">
    <view class="card-title">物流轨迹</view>
    <view class="track">
      <view wx:for="{{order.expressTrack}}" wx:key="index" class="track-item {{index === 0 ? 'first' : ''}}">
        <view class="track-dot"></view>
        <view class="track-body">
          <text class="track-context">{{item.context}}</text>
          <text wx:if="{{item.timeText}}" class="track-time">{{item.timeText}}</text>
        </view>
      </view>
    </view>
  </view>
```

- [ ] **Step 6: `detail.wxss`**（追加到文件末尾）

```css
/* 邮寄轨迹（批次三）：与订单进度时间线区分——小点、无连线、长文本换行 */
.track { padding: 8rpx 0 0; }
.track-item { display: flex; align-items: flex-start; padding-bottom: 20rpx; }
.track-dot { width: 14rpx; height: 14rpx; border-radius: 50%; background: var(--border); margin: 12rpx 16rpx 0 6rpx; flex-shrink: 0; }
.track-item.first .track-dot { background: var(--brand); }
.track-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.track-context { font-size: 26rpx; color: var(--text-3); line-height: 1.5; word-break: break-all; white-space: normal; }
.track-item.first .track-context { color: var(--text-1); font-weight: 500; }
.track-time { font-size: 22rpx; color: var(--text-3); margin-top: 4rpx; }
```

- [ ] **Step 7: 单测 + ES5 闸门 + 全套小程序测试**

Run:
```bash
node --test tests/miniapp/express-track.test.cjs 2>&1 | grep -E "^# (pass|fail)"
node scripts/check-miniapp-es5.mjs apps/miniapp/utils/express-track.js
npm run test:miniapp 2>&1 | grep -E "^# (pass|fail)"
```
Expected: `# pass 2 / # fail 0`；ES5 闸门无输出（退出码 0）；`# pass 79 # fail 0`（原 77 + 2）。

- [ ] **Step 8: Commit**

```bash
git add apps/miniapp/utils/express-track.js apps/miniapp/pages/order/detail.js apps/miniapp/pages/order/detail.wxml apps/miniapp/pages/order/detail.wxss tests/miniapp/express-track.test.cjs
git commit -m "小程序订单详情：物流轨迹时间线（最新在上、脏条目容错）、完成单显示「已签收」；阶段文案抽成 utils/express-track 并加单测"
```

---

### Task 5: 工作台抽屉——「最新轨迹」一行

**Files:**
- Modify: `apps/admin/src/types.ts:450-479`（`ExpressBookingView`）
- Modify: `apps/admin/src/pages/Workbench.tsx:1955-1960`（取件预约块，快递员行之后）

**Interfaces:**
- Consumes: Task 2 `bookingView` 的 `trackStatus/trackUpdatedAt/trackCount/latestTrack`。

- [ ] **Step 1: 类型**——`ExpressBookingView` 的 `cancelledAt: string | null` 之后加：

```ts
  /** 批次三：轨迹摘要（trackJson 由快递100 推送落库） */
  trackStatus: string | null
  trackUpdatedAt: string | null
  trackCount: number
  latestTrack: { context: string; ftime: string } | null
```

- [ ] **Step 2: 抽屉**——`{b.failReason && …}` 那行之前加：

```tsx
                  {b.latestTrack && (
                    <div className="wb__line">
                      <span>最新轨迹</span>
                      <span style={{ textAlign: 'right' }}>
                        {b.latestTrack.context}
                        <br />
                        <small className="wb__muted">{b.latestTrack.ftime}{b.trackCount > 1 ? ` · 共 ${b.trackCount} 条` : ''}{b.trackStatus === 'abort' ? ' · 订阅已中止' : ''}</small>
                      </span>
                    </div>
                  )}
```

- [ ] **Step 3: tsc + test + build**

Run: `cd apps/admin && npx tsc --noEmit && npm test 2>&1 | grep -E "^ℹ (pass|fail)" && npm run build 2>&1 | grep -E "built in|error"`
Expected: 无类型错误；`pass 12 / fail 0`；`built in`。

- [ ] **Step 4: 浏览器走查（控制方）**——`admin-3100` 预览打开工作台，找 §61 留下的 `X61_KEEP_O`（已完成列的邮寄卡）打开抽屉：取件预约块显示「状态 已签收」「最新轨迹 已签收，签收人：本人（补） / 2026-09-11 09:00:01 · 共 1 条」；同城卡抽屉无变化。截图留档。

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/types.ts apps/admin/src/pages/Workbench.tsx
git commit -m "工作台抽屉：取件预约块显示最新轨迹与条数"
```

---

### Task 6: 文档、店主手册、spec 回改、全量回归、终审

**Files:**
- Modify: `docs/api.md`（附录 G 内加「轨迹推送」小节、顾客端 `track`、定时任务表加 `expressStale` 行、`bookingView` 新字段、事件 `source=TRACK`）
- Modify: `docs/staff-guide.md`（四点九 末尾加 `### 轨迹与签收`）
- Modify: `docs/deployment.md`（伪回调演练加轨迹一条）
- Modify: `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md`（§7 回改）
- Create: `docs/express-shipping-golive-manual.md`

- [ ] **Step 1: `docs/api.md` 附录 G**

在「### 顾客端回调：`POST /api/kd-express/:bookingNo`」小节之后加小节「### 轨迹推送：`POST /api/kd-express/:bookingNo/track`（批次三）」，内容逐条：
- 来源：下单 `op=1` + `pollCallBackUrl`（免费订阅）；form `param` + `sign=MD5(param+callbackSalt)`，与状态回调**同一条预约的同一个 salt**；ack/验签失败/限流三条行为与状态回调完全一致（引用上一小节）。
- `param` 形状：`{ status: polling|shutdown|abort|updateall, message, lastResult: { nu, com, ischeck, state, data:[{ context, ftime, time, status, areaName }] } }`；解析规则：缺 `context/ftime` 的条目剔除、按 `ftime` 降序、封顶 50 条。
- 落库：`trackJson = { status, ischeck, state, nu, items }` 整体覆盖；`trackStatus`、`trackUpdatedAt`；事件 `source='TRACK'`、去重键 `TR:<bookingNo>:<status>:<md5(rawBody)>`。
- 状态联动：`ischeck==='1' || state==='3'` → 若预约未到 PICKED 先按 10 处理（订单 SHIPPED + Shipment + 发货通知）再按 13（DELIVERED，订单 SHIPPED→COMPLETED）；`abort` 与 `state∈{4,6,14}` 各告警一次；CANCELLED/FAILED/VOID 预约只留痕不写 JSON；DELIVERED 之后的尾随推送仍更新 JSON。
- 顾客端小节加：`track: { updatedAt, signed, items:[{context, ftime}] } | null`（≤30 条、最新在上；老邮寄单/同城单/预约 CANCELLED → null）。
- `bookingView`/管理端 `GET /:id/booking` 新增 `trackStatus/trackUpdatedAt/trackCount/latestTrack`。
- 定时任务表加一行：`对账（时段过期/取件超期）| reconcileExpressStale | 间隔 30 分钟、PICKED 超 10 天、每单封顶 48 次 | expressStaleIntervalMin / expressPickedStaleDays`，并说明 `staleCheckedAt/staleRemindedAt/staleTries` 三列语义。

- [ ] **Step 2: `docs/staff-guide.md`**——四点九「「预约失败」「待核对」怎么办」小节之后（五、换首页轮播图之前）加：

```markdown
### 轨迹与签收(不用你点任何按钮)

- 快递员取件后,快递100 会把包裹的运输轨迹推给我们,顾客在订单详情里能看到「物流轨迹」(最新一条在最上面);你在工作台抽屉的「取件预约」块里能看到「最新轨迹」一行。
- 顾客签收后订单自动变「已完成」,不需要顾客点「确认收货」,也不需要你操作;签收不会再给顾客发通知。
- 就算快递100 没推「已签收」,原来的规则也还在:发货 7 天后订单自动完成。
- 两种情况系统会主动去快递100 查一次并提醒你:预约时段过了一小时还没取件回调;取件 10 天了还没签收。提醒只发一次,收到后去联系快递员或快递公司,不用在后台改什么。
- 抽屉里「最新轨迹」后面若带「订阅已中止」,说明单号有误或已超期,顾客端看不到后续轨迹——到快递100 后台核对单号。
```

- [ ] **Step 3: `docs/deployment.md`**——邮寄伪回调那段 curl 之后加轨迹一条：

```markdown
**轨迹推送**（批次三）：路由 `POST /api/kd-express/:bookingNo/track`，盐同上一条预约的 `callback_salt`，`param` 形状不同：

```bash
BOOKING_NO="$1"; SALT="$2"
PARAM='{"status":"polling","lastResult":{"nu":"演练单号","com":"jd","ischeck":"0","state":"0","data":[{"context":"【演练】已揽收","ftime":"2026-09-10 10:00:00"}]}}'
SIGN=$(printf '%s%s' "$PARAM" "$SALT" | md5sum | cut -d' ' -f1)
curl -s -w '\nHTTP %{http_code}\n' -X POST "https://api.yourdomain.com/api/kd-express/${BOOKING_NO}/track" \
  --data-urlencode "param=${PARAM}" --data-urlencode "sign=${SIGN}"
```

预期同上（`HTTP 200` + 固定 ack）；`GET /api/admin/express/orders/:id/booking` 的 `booking.latestTrack.context` 变成「【演练】已揽收」。**不要**把 `ischeck` 改成 `"1"` 对真实订单演练——那会把订单直接转「已完成」。
```

- [ ] **Step 4: spec §7 回改**（在「轨迹：整体覆盖写 …」那一条后追加「（实现回改，批次三：…）」）：`trackJson` 的实际形状 `{status, ischeck, state, nu, items:[{context, ftime}]}`、封顶 50/顾客端 30；签收若预约未到 PICKED 先补 10；`abort` 与退签/退回告警一次；对账任务的三列打标（`staleCheckedAt/staleRemindedAt/staleTries`）与「每 30 分钟、封顶 48 次、无结论提醒一次」；§13 批次三标「已实现」。

- [ ] **Step 5: 店主手册 `docs/express-shipping-golive-manual.md`**（仿 `docs/local-delivery-golive-manual.md` 的结构与口吻，写给店主，每步说清在哪点、花多少钱、出错找谁）。必须包含这些章节与事实：

1. `# 全国邮寄（快递100 上门取件）开通操作手册`，引言一句：从「只会手填单号」到「真机跑通一单预约取件 + 顾客看到轨迹 + 自动完成」。
2. `## 先看这一页：现在卡在哪`——清单：① 快递100 商务：上门取件产品已开通（2026-09-08 已确认 8 家回价），**顺丰未配价**要找商务；② 测试环境 key（邀请制）；③ 服务器 `.env`：`KD100_EXPRESS_KEY/SECRET`、`PUBLIC_BASE_URL`（必须是公网 https，回调地址 ≤200 字节，启动时自检）、`EXPRESS_PROVIDER_MOCK` 生产必须不设；④ nginx 已有 `location /api/kd-express/`（部署时核对 `nginx -T | grep kd-express`）；⑤ 后台「邮寄设置」当前是 TABLE 模式（沿用旧一口价），切 QUOTE 才按报价收。
3. `## 这一轮要花多少钱`——接口免费；预约成功即预扣所选家报价（自贡→成都 1.5 kg 约 ¥6.6–¥17.1，见 `docs/research/…` §8.1）；取件后按实际重量多退少补；取件前取消退预扣；已取件再取消可能有逆向物流费；余额与同城是否共用由商务确认。
4. `## 第一步：后台「邮寄设置」`——包装附加重 `packagingG`（默认 800 g，寄礼盒调高）、定价名单 `pricingPool`、地区分组与「不寄送」、`acceptGraceMin`（默认 10 分钟）、默认备注；保存后刷新回显。
5. `## 第二步：伪回调演练`——引用 `docs/deployment.md` 两条 curl（状态 + 轨迹），期望 ack；**只对测试订单**。
6. `## 第三步：真机跑一单`——按顺序：3.1 顾客下单（真微信支付，四川地址，看结算页运费）；3.2 后台接单；3.3 工作台「预约取件」（弹窗：最便宜默认、改重量、选时段、确认预扣金额）；3.4 等快递员接单（卡片显示「快递员已接单 · 姓名」，可「打给快递员」）；3.5 取件（订单自动「已发货」、顾客收到发货通知）；3.6 看轨迹（顾客端「物流轨迹」、抽屉「最新轨迹」）；3.7 签收（订单自动「已完成」）；3.8 核对成本行（预扣/实扣/计费重）与快递100 后台余额。
7. `## 第四步：切 QUOTE 模式`——真账号 `batchPrice` 跑通、跑过一单后再切；切了之后运费按中位数 + `markupFen` + 取整收。
8. `## 第五步：收尾`——测试单标 `isTest`（`docs/ops-test-orders.md`）、把临时改过的设置改回。
9. `## 附：按钮总表`——备餐中：预约取件 / 填单号发货；等待配送员：改约时间 / 取消预约 / 打给快递员；状态未确认：只有作废预约；顾客取消申请：同意退款 / 驳回；每个确认弹窗取消键都叫「再想想」。
10. `## 附：提醒都长什么样、收到该做什么`——无人接单（4 小时）、时段过未取件（60 分钟）、时段过后仍无进展/取件后长时间未签收（对账）、揽货失败、快递100 侧取消、下单失败、余额不足、实扣明显高于预扣、轨迹订阅中止、退签/退回、作废的预约仍在推状态。

- [ ] **Step 6: 提交文档**

```bash
git add docs/api.md docs/staff-guide.md docs/deployment.md docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md docs/express-shipping-golive-manual.md
git commit -m "文档：轨迹推送接口与顾客端 track 字段、店员指南轨迹与签收、部署轨迹演练、spec §7 回改、全国邮寄开通店主手册"
```

- [ ] **Step 7: 全量回归（sonnet 执行，haiku 核对）**

```bash
cd apps/server && npx tsc --noEmit && for f in selftest-kd100 selftest-kd100-express selftest-express-settings selftest-express-quote selftest-express-booking; do npx ts-node --transpile-only scripts/$f.ts | tail -1; done
cd ../admin && npx tsc --noEmit && npm test && npm run build
cd ../.. && node scripts/check-miniapp-es5.mjs apps/miniapp/utils/express-track.js && node scripts/check-channel-consistency.mjs && npm run test:miniapp
# 干净库 + SCHEDULER_DISABLED=true（配方见 memory e2e-fresh-db-recipe）
DB_NAME=food_shop_e2e bash scripts/e2e.sh 2>&1 | tail -1
```
Expected：全部通过；e2e `失败 0`，通过数 ≥ 1405 + 46。

haiku 清单：`git log main..HEAD` 每个任务一个提交；`docs/api.md` 里 `/track` 路由路径与 `kd-express-callback.ts` 一致；`track` 字段形状与 `routes/orders.ts` 一致；`scripts/e2e.d/61-express-track.sh` 存在且 `e2e.sh` 会 source；`schema.prisma` 三列与迁移 SQL 列名一致；`scheduler.ts` 有 `expressStale`；`system.ts` 有两个新 override；`apps/miniapp/utils/express-track.js` 过 ES5 闸门；`grep -rn "deliveryType !== 'LOCAL'" apps/server/src/routes/admin/delivery.ts` 仍在；`git status` 干净、`git ls-files .superpowers` 为空。

- [ ] **Step 8: 终审（opus）**——整分支 diff 对照 spec §4.2/§7/§12 与本计划 Global Constraints。重点问：「轨迹回调能否伪造签收把订单转完成」（salt 同状态回调；验签在任何写之前）、「签收先补 10 会不会给已退款/已取消订单发发货通知」（`order.updateMany where status in PAID/PREPARING` 不命中时 Shipment 仍会写——确认可接受或加 order 状态守卫）、「对账任务会不会把 CANCELLED 的预约查活」（只选 BOOKED/ACCEPTED/PICKED）、「同城零变化」「老邮寄单零变化」「trackJson 大小上限」。通过后 `superpowers:finishing-a-development-branch`。

## 执行备注

- 每个任务：sonnet 实现 → `review-package` 打 diff → opus 复核 → sonnet 修 → 再复核；haiku 只做 Task 6 的机械核对。
- e2e 服务端启动命令（3100，干净库）：`PORT=3100 DATABASE_URL=mysql://foodshop_user:foodshop_password@localhost:3306/food_shop_e2e SCHEDULER_DISABLED=true WECHAT_LOGIN_MOCK=true WECHAT_PAY_MOCK=true WECHAT_QRCODE_MOCK=true LOCAL_DELIVERY_PROVIDER_MOCK=true PRINTER_PROVIDER_MOCK=true EXPRESS_PROVIDER_MOCK=true npx ts-node-dev --respawn --transpile-only src/app.ts`；Task 2 Step 1 跑过 `prisma migrate deploy` 后再起。
- `prisma generate` 只在 Task 2 Step 1 跑一次，跑时不能有别的 agent 在验证（worktree 共用 client）。
- 分支名 `claude/express-tracking-batch3`，基线 main `89aeb8a`。
- 不在本批次做：签收后给顾客发通知（spec §8 明确不发）；`autoCompleteShippedOrders` 完成订单时同步把 PICKED 预约收尾（对账任务 B 已覆盖，10 天后处理一次）；快递100 主动查轨迹接口（需 pollToken 且另计费）。
