# M2-A 同城配送引擎 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让同城订单能通过快递100「同城急送」真的叫到骑手：配送单全生命周期（呼叫/回调/取消/加小费/自送/送达/作废）、与退款/拒单的资金耦合、7 个定时兜底任务，全部可用 mock provider 在 e2e 里确定性驱动。

**Architecture:** `services/delivery/` 十文件分层——provider 只懂协议（签名/编码/超时/验签），编排层只懂业务（事务/状态机/通知）；外呼永远在事务外，外呼前后各一段短事务；`Delivery.activeOrderId` 唯一索引做「一单一有效配送单」，`statusRank` 单调 + `DeliveryEvent.dedupeKey` 唯一做回调幂等；回调按 URL 路径里的 `deliveryNo` 直取（快递100 不支持商户单号，单号拼进 callbackUrl）。

**Tech Stack:** Node 25 / Express 4 / Prisma 5.22 (MySQL 8) / zod 4。测试：`scripts/e2e.sh`（bash+curl+jq 黑盒，后端 `PORT=3100` + 三 mock）与 `apps/server/scripts/selftest-*.ts`（ts-node 离线）。

## Global Constraints

- 金额一律**分**（Int）；坐标一律 **GCJ-02 微度 Int**（`latE6`），传快递100 时除以 1e6 保留 6 位小数。
- 状态机定稿（spec §5.3 + 决策 N8）：rank `PENDING 0 < CALLING 10 < ACCEPTED 20 < ARRIVING 30 < ARRIVED 40 < DELIVERING 50 < DELIVERED 100`；旁路态 `REASSIGNING/ABNORMAL/CANCELLED/FAILED/UNKNOWN` 写入时**不写 rank**；终态 `TERMINAL=['DELIVERED','CANCELLED','FAILED']`；正向推进 `updateMany({where:{id, statusRank:{lt:newRank}, status:{notIn:TERMINAL}}})`；**唯二回拨**：①720 时 Order `SHIPPED→PREPARING`（仅当无在途退款、无 PENDING/APPROVED 售后、completedAt 为空）②`REASSIGNING` 收到 100 允许回拨 ACCEPTED(rank20)。
- **进入终态的所有路径，同一条 update 里 `activeOrderId: null`**（与 refund 的 ABNORMAL 特例不同，Delivery 无例外）。
- Order 侧写入一律 `updateMany({where:{id, deliveryType:'LOCAL', status:{in:白名单}}})` 判 count；**LOCAL 订单永不写 `Shipment` 行**。
- 回调应答（决策 N5）：**仅数据库入库异常（非 P2002）返 500**；查不到单/验签失败/重复/乱序/未知状态一律返 `200 {"result":true,"returnCode":"200","message":"成功"}`。
- 快递100 签名：`sign = MD5(param + t + key + secret)` 32 位大写；回调验签 `MD5(param + salt)` 大写归一 + `timingSafeEqual`；外呼 `AbortSignal.timeout(8000)`。
- 30005 重试（决策 N7）：source=SCHEDULER 退避重试 2 次（延迟 `config.kd100.retryDelaysMs`，默认 [1000,3000]）；source=ADMIN **不重试**。
- mock provider（决策 N6）：**零 setTimeout**，指令队列 + e2e 自己 curl 打回调。
- 错误码（已与既有 42201-42231 去冲突，禁止另造）：`42221` 退款前先取消配送单 · `42225` 呼叫骑手失败（附运力原文）· `42228` 已有在途配送单 · `42232` 余额不足已熔断 · `42233` 无在途配送单 · `42234` 状态未确认（UNKNOWN）不能直接操作 · `42235` 仅待抢单状态可加小费 · `42236` 加小费被运力拒绝 · `42237` 配送单状态已变化，请刷新 · `42238` 取消请求超时，请稍后重试。
- 拒单（决策 N3/N4）：`POST /admin/orders/:id/reject`，两渠道通用；终态 REFUNDED（全额走 `initiateRefund`，`cancelReason='拒单：'+文案` 顾客可见）；PENDING_PAYMENT 单走取消不走退款。
- 环境：本 worktree 独立库 `food_shop_sc`，后端 :3100 常驻热重载（不要另起/不要 kill）；e2e 连跑两次之间等 60s（loginLimiter）。e2e 后端启动需带 `LOCAL_DELIVERY_PROVIDER_MOCK=true`。
- 提交信息中文 `type(scope): 摘要`，结尾 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。

## 文件结构

| 路径 | 职责 |
|---|---|
| `apps/server/src/services/delivery/types.ts` | Provider 接口、ProviderError、回调 payload 类型（零依赖） |
| `apps/server/src/services/delivery/state.ts` | rank 表、TERMINAL、`PROVIDER_STATUS_MAP`（纯常量） |
| `apps/server/src/services/delivery/circuit.ts` | 30004 熔断内存态 |
| `apps/server/src/services/delivery/events.ts` | DeliveryEvent 写入 + dedupeKey + 截断 |
| `apps/server/src/services/delivery/kd100.ts` | 快递100 协议实现 |
| `apps/server/src/services/delivery/mock.ts` | 指令队列 mock |
| `apps/server/src/services/delivery/provider.ts` | 工厂 |
| `apps/server/src/services/delivery/orchestrator.ts` | 呼叫/取消/加小费/自送/送达/作废 |
| `apps/server/src/services/delivery/callback.ts` | 回调处理 |
| `apps/server/src/services/delivery/tasks.ts` | 7 个 scheduler 任务 + autoCall |
| `apps/server/src/routes/kd-callback.ts` | `POST /api/kd/:deliveryNo` |
| `apps/server/src/routes/admin/delivery.ts` | 同城单操作路由（挂 `/admin/local/orders`） |
| `apps/server/src/routes/admin/kd100-mock.ts` | mock 控制（仅 mock 模式挂载） |
| 改动 | `config.ts`、`app.ts`、`prisma/schema.prisma`、`services/{refund,scheduler,order-notify,subscribe-message}.ts`、`routes/orders.ts`、`routes/admin/{orders,system,settings}.ts`、`scripts/e2e.sh`、`.env.example`、`docs/api.md`、spec |

---

### Task 0: 基座——迁移、config、system/status、.env.example

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（Order 加 2 列、Delivery 加 1 列）
- Create: `apps/server/prisma/migrations/20260904100000_m2_reminders/migration.sql`（prisma 生成后改名）
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/routes/admin/system.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.kd100 = { key: string; secret: string; retryDelaysMs: number[] }`、`config.mock.delivery: boolean`、`export function validateKd100Config(): void`（config.ts 底部导出；key/secret 任一为空 throw `Error('Missing required env var: KD100_KEY / KD100_SECRET')`）；Prisma 字段 `Order.localUncalledRemindedAt`、`Order.cancelRequestRemindedAt`、`Delivery.unknownRemindedAt`。

- [ ] **Step 1: schema 加 3 列**

`model Order` 的 `lastAnnouncedAt` 行之后加：
```prisma
  // M2 定时任务「每单只提醒一次」标记（备餐超时未呼叫 / 顾客取消申请未处理）
  localUncalledRemindedAt  DateTime? @map("local_uncalled_reminded_at")
  cancelRequestRemindedAt  DateTime? @map("cancel_request_reminded_at")
```
`model Delivery` 的 `deliveringRemindedAt` 行之后加：
```prisma
  unknownRemindedAt       DateTime? @map("unknown_reminded_at")
```

- [ ] **Step 2: 生成并应用迁移**

```bash
cd apps/server && npx prisma validate && npx prisma migrate dev --name m2_reminders --create-only
```
把生成目录改名为 `20260904100000_m2_reminders`（必须晚于 `20260904000000_local_delivery`），核对 SQL 只有三条 `ALTER TABLE ... ADD COLUMN ... DATETIME(3) NULL`，然后：
```bash
npx prisma migrate dev && npx prisma generate && npx tsc --noEmit
```
Expected: 迁移应用、tsc 零错误。

- [ ] **Step 3: config.ts**

zod schema（Mock 组附近）加：
```ts
  // 快递100 同城急送（懒校验：呼叫骑手前 validateKd100Config 再查缺项）
  KD100_KEY: z.string().optional(),
  KD100_SECRET: z.string().optional(),
  // 30005 运力异常的重试延迟（毫秒，逗号分隔）；e2e 配 "0,0" 免 sleep
  KD100_RETRY_DELAYS_MS: z.string().optional(),
  // 同城运力 mock（生产开启拒绝启动）
  LOCAL_DELIVERY_PROVIDER_MOCK: z.string().optional(),
```
`enabledMocks` 数组加一行：
```ts
      ['LOCAL_DELIVERY_PROVIDER_MOCK', env.LOCAL_DELIVERY_PROVIDER_MOCK],
```
把现有导出里的 `publicBaseUrl` 表达式**上提**为常量（`isProduction` 声明之后）：
```ts
const publicBaseUrl = env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`
```
（导出对象里改用该常量。）生产块 COS 断言之后加：
```ts
  // 快递100 对 callbackUrl 限长 50。最坏单号 D999999-99；当前生产 URL 恰 49，余量 1 字符。
  // 换更长域名前必须先缩短路径前缀（如 /api/k/），否则这里会拦住启动——这是故意的。
  const worstKdCallbackUrl = `${publicBaseUrl}/api/kd/D999999-99`
  if (worstKdCallbackUrl.length > 50) {
    console.error(`[config] 快递100 回调 URL 超长（${worstKdCallbackUrl.length} > 50）：${worstKdCallbackUrl}，服务拒绝启动`)
    process.exit(1)
  }
```
导出对象：`mock` 组加 `delivery: env.LOCAL_DELIVERY_PROVIDER_MOCK === 'true',`；新增组：
```ts
  kd100: {
    key: env.KD100_KEY ?? '',
    secret: env.KD100_SECRET ?? '',
    retryDelaysMs: (env.KD100_RETRY_DELAYS_MS ?? '1000,3000')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0),
  },
```
文件底部（`validatePayConfig` 同款懒校验，但放 config.ts 免循环依赖）：
```ts
/** 呼叫骑手前的懒校验：mock 模式不需要真密钥 */
export function validateKd100Config(): void {
  if (config.mock.delivery) return
  if (!config.kd100.key || !config.kd100.secret) {
    throw new Error('Missing required env var: KD100_KEY / KD100_SECRET')
  }
}
```

- [ ] **Step 4: system/status 加 kd100 块**

`routes/admin/system.ts` 的 status 响应对象加（只回布尔与长度，绝不回密钥值）：
```ts
      kd100: {
        keySet: !!config.kd100.key,
        secretSet: !!config.kd100.secret,
        mock: config.mock.delivery,
        callbackUrlSample: `${config.publicBaseUrl}/api/kd/D999999-99`,
        callbackUrlOk: `${config.publicBaseUrl}/api/kd/D999999-99`.length <= 50,
      },
```

- [ ] **Step 5: .env.example**

同城段落（`KD100_SECRET=""` 之后）追加：
```env
# 30005（运力异常）自动重试延迟，毫秒逗号分隔；本地 e2e 建议 "0,0"
KD100_RETRY_DELAYS_MS="1000,3000"
# 同城运力 mock：true 时不打快递100，走指令队列（生产开启会拒绝启动）
LOCAL_DELIVERY_PROVIDER_MOCK=true
```
并把本 worktree `apps/server/.env` 实际加上这两行（值 `"0,0"` 与 `true`）。

- [ ] **Step 6: 验证 + e2e 回归 + 提交**

```bash
cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3
```
Expected: tsc 零错误；e2e 仍 214/0（后端热重载后 mock.delivery 生效但无人使用）。另验证 status 字段：
```bash
curl -s http://localhost:3100/api/admin/system/status -H "Authorization: Bearer $(curl -s -X POST http://localhost:3100/api/admin/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123456"}' | jq -r .data.token)" | jq .data.kd100
```
Expected: `{ keySet:false, secretSet:false, mock:true, callbackUrlOk:true, ... }`。

```bash
git add apps/server/prisma apps/server/src/config.ts apps/server/src/routes/admin/system.ts .env.example
git commit -m "feat(config): M2 基座——提醒标记列、KD100 配置与懒校验、回调 URL 生产限长断言

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 1: 纯逻辑层——types / state / circuit / events + 自测

**Files:**
- Create: `apps/server/src/services/delivery/types.ts`
- Create: `apps/server/src/services/delivery/state.ts`
- Create: `apps/server/src/services/delivery/circuit.ts`
- Create: `apps/server/src/services/delivery/events.ts`
- Create: `apps/server/scripts/selftest-delivery-core.ts`

**Interfaces:**
- Consumes: Task 0 的 `config.kd100`。
- Produces（后续任务的契约，逐字使用）：
  - types: `ProviderErrorKind = 'CONFIG'|'CAPACITY'|'BALANCE'|'TIMEOUT'|'BUSINESS'`；`class ProviderError extends Error { constructor(public kind: ProviderErrorKind, public code: string, message: string, public raw?: unknown) }`；`interface CreateDeliveryOrderInput { deliveryNo; callbackUrl; callbackSalt; sender: {name;mobile;province;city;district;address;latE6;lngE6}; receiver: 同構; goods: {title; weightKg; totalPriceFen; count}; remark?: string }`；`interface CreateDeliveryOrderResult { taskId: string|null; providerOrderId: string|null; quotedFeeFen: number|null; distanceM: number|null; raw: unknown }`；`interface DeliveryCallbackPayload { taskId: string; providerStatus: string; statusDesc: string|null; courierCompany: string|null; courierName: string|null; courierMobile: string|null; providerUpdateTime: Date|null; raw: Record<string,unknown> }`；`interface DeliveryProvider { readonly name: 'KD100'|'MOCK'; price(input): Promise<{feeFen:number; distanceM:number|null}>; createOrder(input): Promise<CreateDeliveryOrderResult>; precancelOrder(i:{taskId}): Promise<{cancelFeeFen:number|null}>; cancelOrder(i:{taskId; reason}): Promise<{cancelFeeFen:number|null; raw:unknown}>; addTip(i:{taskId; amountFen}): Promise<void>; queryCourier(i:{taskId}): Promise<{latE6:number; lngE6:number}|null>; verifyAndParseCallback(body: Record<string,string>, salt: string): {ok:true; payload: DeliveryCallbackPayload} | {ok:false; reason:'SIGN_MISMATCH'|'BAD_PARAM'} }`
  - state: `DELIVERY_RANK: Record<string,number>`、`TERMINAL = ['DELIVERED','CANCELLED','FAILED'] as const`、`PROVIDER_STATUS_MAP`（'0'→CALLING/10；'100'→ACCEPTED/20/acceptedAt；'210'→ARRIVING/30；'230'→ARRIVED/40；'310'→DELIVERING/50/pickedUpAt；'520'→DELIVERED/100/deliveredAt；'515'→side REASSIGNING；'510'→side ABNORMAL；'720'→side CANCELLED）、`DELIVERY_STATUS_LABEL: Record<string,string>`（中文：待呼叫/待抢单/骑手已接单/骑手赶来取货/骑手已到店/配送中/改派中/配送异常/已送达/已取消/呼叫失败/状态未确认）
  - circuit: `isCircuitTripped(): boolean`、`tripCircuit(reason: string): boolean`（幂等，首次 trip 返 true）、`resetCircuit(operator: string): void`、`getCircuitState(): Readonly<{tripped; trippedAt; reason; operator}>`
  - events: `trunc(s: string|null|undefined, n: number): string|null`；`makeCallbackDedupeKey(deliveryNo: string, providerStatus: string, updateTimeIso: string|null, rawBody: string): string`（有 updateTime → `('CB:'+deliveryNo+':'+status+':'+updateTimeIso)` 截 64；无 → `'CB:'+deliveryNo+':'+status+':'+md5hex(rawBody)` 截 64）；`recordDeliveryEvent(tx, input: {deliveryId; dedupeKey; source; providerStatus?; statusDesc?; courierName?; courierMobile?; providerUpdateTime?; operator?; latencyMs?; rawPayload?}): Promise<{duplicate: boolean}>`（catch P2002 → `{duplicate:true}`）；`adminEventKey(): string`（`'ADM:'+crypto.randomUUID()` 截 64）

- [ ] **Step 1: 写自测（RED）**

`apps/server/scripts/selftest-delivery-core.ts`（照 `selftest-local-settings.ts` 的 `t()` 断言器范式）：
```ts
/** 配送引擎纯逻辑自测（无 DB）：cd apps/server && npx ts-node --transpile-only scripts/selftest-delivery-core.ts */
import assert from 'assert'
import { DELIVERY_RANK, TERMINAL, PROVIDER_STATUS_MAP, DELIVERY_STATUS_LABEL } from '../src/services/delivery/state'
import { isCircuitTripped, tripCircuit, resetCircuit, getCircuitState } from '../src/services/delivery/circuit'
import { trunc, makeCallbackDedupeKey, adminEventKey } from '../src/services/delivery/events'
import { ProviderError } from '../src/services/delivery/types'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

t('rank 表单调且 DELIVERED=100', () => {
  const order = ['PENDING','CALLING','ACCEPTED','ARRIVING','ARRIVED','DELIVERING','DELIVERED']
  for (let i = 1; i < order.length; i++) assert.ok(DELIVERY_RANK[order[i]] > DELIVERY_RANK[order[i-1]], order[i])
  assert.strictEqual(DELIVERY_RANK.DELIVERED, 100)
})
t('旁路态不在 rank 表', () => {
  for (const s of ['REASSIGNING','ABNORMAL','CANCELLED','FAILED','UNKNOWN']) assert.strictEqual(DELIVERY_RANK[s], undefined, s)
})
t('TERMINAL 恰为三态', () => assert.deepStrictEqual([...TERMINAL].sort(), ['CANCELLED','DELIVERED','FAILED']))
t('映射表覆盖 9 个运力状态且类型正确', () => {
  assert.deepStrictEqual(PROVIDER_STATUS_MAP['310'], { type:'rank', status:'DELIVERING', rank:50, stamp:'pickedUpAt' })
  assert.deepStrictEqual(PROVIDER_STATUS_MAP['720'], { type:'side', status:'CANCELLED' })
  assert.strictEqual(Object.keys(PROVIDER_STATUS_MAP).length, 9)
})
t('12 个状态都有中文标签', () => {
  for (const s of ['PENDING','CALLING','ACCEPTED','ARRIVING','ARRIVED','DELIVERING','REASSIGNING','ABNORMAL','DELIVERED','CANCELLED','FAILED','UNKNOWN'])
    assert.ok(DELIVERY_STATUS_LABEL[s]?.length >= 2, s)
})
t('熔断：trip 幂等、reset 记操作人', () => {
  resetCircuit('selftest')
  assert.strictEqual(isCircuitTripped(), false)
  assert.strictEqual(tripCircuit('30004'), true)
  assert.strictEqual(tripCircuit('30004'), false)      // 已熔断，不重复告警
  assert.strictEqual(isCircuitTripped(), true)
  resetCircuit('boss')
  assert.strictEqual(getCircuitState().operator, 'boss')
  assert.strictEqual(isCircuitTripped(), false)
})
t('trunc 空安全与截断', () => {
  assert.strictEqual(trunc(null, 5), null)
  assert.strictEqual(trunc(undefined, 5), null)
  assert.strictEqual(trunc('abcdefg', 5), 'abcde')
})
t('dedupeKey：有 updateTime 用时间，无则退化 rawBody 摘要，恒 ≤64', () => {
  const a = makeCallbackDedupeKey('D42-1', '310', '2026-09-04T10:00:00.000Z', 'x')
  const b = makeCallbackDedupeKey('D42-1', '310', null, 'raw-body-1')
  const c = makeCallbackDedupeKey('D42-1', '310', null, 'raw-body-2')
  assert.ok(a.startsWith('CB:D42-1:310:2026'))
  assert.notStrictEqual(b, c)
  assert.strictEqual(makeCallbackDedupeKey('D42-1', '310', null, 'raw-body-1'), b)   // 稳定
  for (const k of [a, b]) assert.ok(k.length <= 64)
})
t('adminEventKey 唯一且 ≤64', () => {
  const a = adminEventKey(), b = adminEventKey()
  assert.notStrictEqual(a, b); assert.ok(a.length <= 64 && a.startsWith('ADM:'))
})
t('ProviderError 保留 kind/code/name', () => {
  const e = new ProviderError('BALANCE', '30004', '余额不足')
  assert.strictEqual(e.kind, 'BALANCE'); assert.strictEqual(e.code, '30004'); assert.strictEqual(e.name, 'ProviderError')
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
```
Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-delivery-core.ts` → Expected: `Cannot find module '../src/services/delivery/state'`。

- [ ] **Step 2: 实现四个文件（GREEN）**

`types.ts`：按 Interfaces 逐字实现（纯类型 + ProviderError 类，`this.name = 'ProviderError'`）。

`state.ts`：
```ts
/** 配送单状态机常量。改这里前先读 spec §5.3——rank 单调是回调幂等的另一半。 */
export const DELIVERY_RANK: Record<string, number> = {
  PENDING: 0, CALLING: 10, ACCEPTED: 20, ARRIVING: 30, ARRIVED: 40, DELIVERING: 50, DELIVERED: 100,
}
export const TERMINAL = ['DELIVERED', 'CANCELLED', 'FAILED'] as const

type RankEntry = { type: 'rank'; status: keyof typeof DELIVERY_RANK & string; rank: number; stamp?: 'acceptedAt' | 'pickedUpAt' | 'deliveredAt' }
type SideEntry = { type: 'side'; status: 'REASSIGNING' | 'ABNORMAL' | 'CANCELLED' }
export const PROVIDER_STATUS_MAP: Record<string, RankEntry | SideEntry> = {
  '0':   { type: 'rank', status: 'CALLING',    rank: 10 },
  '100': { type: 'rank', status: 'ACCEPTED',   rank: 20, stamp: 'acceptedAt' },
  '210': { type: 'rank', status: 'ARRIVING',   rank: 30 },
  '230': { type: 'rank', status: 'ARRIVED',    rank: 40 },
  '310': { type: 'rank', status: 'DELIVERING', rank: 50, stamp: 'pickedUpAt' },
  '520': { type: 'rank', status: 'DELIVERED',  rank: 100, stamp: 'deliveredAt' },
  '515': { type: 'side', status: 'REASSIGNING' },
  '510': { type: 'side', status: 'ABNORMAL' },
  '720': { type: 'side', status: 'CANCELLED' },
}
export const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING: '待呼叫', CALLING: '待抢单', ACCEPTED: '骑手已接单', ARRIVING: '骑手赶来取货',
  ARRIVED: '骑手已到店', DELIVERING: '配送中', REASSIGNING: '改派中', ABNORMAL: '配送异常',
  DELIVERED: '已送达', CANCELLED: '已取消', FAILED: '呼叫失败', UNKNOWN: '状态未确认',
}
```

`circuit.ts`：
```ts
/**
 * 快递100 余额不足（30004）熔断。进程内存态——与 scheduler 同享「PM2 单实例 fork」
 * 部署约束（见 scheduler.ts 头注释）；重启即复位，下次 30004 会重新 trip 并再告警一次，可接受。
 */
interface CircuitState { tripped: boolean; trippedAt: Date | null; reason: string | null; operator: string | null }
let state: CircuitState = { tripped: false, trippedAt: null, reason: null, operator: null }

export function isCircuitTripped(): boolean { return state.tripped }
/** 返回 true = 首次熔断（调用方发老板告警）；false = 早已熔断（不重复告警） */
export function tripCircuit(reason: string): boolean {
  if (state.tripped) return false
  state = { tripped: true, trippedAt: new Date(), reason, operator: null }
  return true
}
export function resetCircuit(operator: string): void {
  state = { tripped: false, trippedAt: null, reason: null, operator }
}
export function getCircuitState(): Readonly<CircuitState> { return state }
```

`events.ts`：
```ts
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'

type Db = Prisma.TransactionClient | typeof prisma

export function trunc(s: string | null | undefined, n: number): string | null {
  if (s === null || s === undefined) return null
  return s.length > n ? s.slice(0, n) : s
}
const md5hex = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex')

/** 回调幂等键：同一 deliveryNo+状态+updateTime 只落一条；缺 updateTime 退化 rawBody 摘要 */
export function makeCallbackDedupeKey(deliveryNo: string, providerStatus: string, updateTimeIso: string | null, rawBody: string): string {
  const tail = updateTimeIso ?? md5hex(rawBody)
  return `CB:${deliveryNo}:${providerStatus}:${tail}`.slice(0, 64)
}
export function adminEventKey(): string { return `ADM:${crypto.randomUUID()}`.slice(0, 64) }

export interface RecordEventInput {
  deliveryId: number; dedupeKey: string; source: 'CALLBACK' | 'API' | 'ADMIN' | 'SCHEDULER'
  providerStatus?: number | null; statusDesc?: string | null
  courierName?: string | null; courierMobile?: string | null
  providerUpdateTime?: string | null; operator?: string | null
  latencyMs?: number | null; rawPayload?: Prisma.InputJsonValue
}
/** 事件先落库再推进状态机；P2002 = 重复，调用方据此短路。字符串在此统一截到列宽。 */
export async function recordDeliveryEvent(db: Db, input: RecordEventInput): Promise<{ duplicate: boolean }> {
  try {
    await db.deliveryEvent.create({ data: {
      deliveryId: input.deliveryId, dedupeKey: input.dedupeKey, source: input.source,
      providerStatus: input.providerStatus ?? null,
      statusDesc: trunc(input.statusDesc, 255), courierName: trunc(input.courierName, 64),
      courierMobile: trunc(input.courierMobile, 20), providerUpdateTime: trunc(input.providerUpdateTime, 32),
      operator: trunc(input.operator, 64), latencyMs: input.latencyMs ?? null,
      rawPayload: input.rawPayload,
    } })
    return { duplicate: false }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { duplicate: true }
    throw e
  }
}
```

- [ ] **Step 3: 自测通过 + tsc + 提交**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-delivery-core.ts && npx tsc --noEmit`
Expected: `全部通过 10`；tsc 零错误。
```bash
git add apps/server/src/services/delivery apps/server/scripts/selftest-delivery-core.ts
git commit -m "feat(delivery): 引擎纯逻辑层——状态机常量/熔断/事件幂等 + 自测

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: kd100 provider + selftest-kd100

**Files:**
- Create: `apps/server/src/services/delivery/kd100.ts`
- Create: `apps/server/scripts/selftest-kd100.ts`

**Interfaces:**
- Consumes: Task 1 的 types/events(trunc)、Task 0 的 `config.kd100`/`validateKd100Config`。
- Produces: `export const kd100Provider: DeliveryProvider`；另导出供自测的内部件 `_sign(paramStr: string, t: string, key: string, secret: string): string`、`_mapReturnCode(code: number|string): ProviderErrorKind`、`_buildOrderParam(input: CreateDeliveryOrderInput, providers: string[], goodsType: string): Record<string, unknown>`。

- [ ] **Step 1: 写自测（RED）**

`apps/server/scripts/selftest-kd100.ts`：
```ts
/**
 * 快递100 协议自测（离线）：cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts
 * 集成模式（真实只读询价，需 KD100_KEY/SECRET 与门店坐标）：... selftest-kd100.ts --integration
 */
import assert from 'assert'
import crypto from 'crypto'
import { _sign, _mapReturnCode, _buildOrderParam, kd100Provider } from '../src/services/delivery/kd100'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

t('签名 = MD5(param+t+key+secret) 32 位大写', () => {
  const s = _sign('{"a":1}', '1725400000000', 'K', 'S')
  assert.strictEqual(s, md5U('{"a":1}' + '1725400000000' + 'K' + 'S'))
  assert.match(s, /^[0-9A-F]{32}$/)
})
t('错误码映射', () => {
  for (const c of ['30001','30002','30003','30006']) assert.strictEqual(_mapReturnCode(c), 'CONFIG', c)
  assert.strictEqual(_mapReturnCode('30005'), 'CAPACITY')
  assert.strictEqual(_mapReturnCode('30004'), 'BALANCE')
  assert.strictEqual(_mapReturnCode('50000'), 'BUSINESS')
})
t('下单 param：坐标 6 位小数、重量 1 位、金额转元、callbackUrl 原样', () => {
  const p = _buildOrderParam({
    deliveryNo: 'D42-1', callbackUrl: 'http://x/api/kd/D42-1', callbackSalt: 'salt16charsalt16',
    sender: { name:'店', mobile:'15309003232', province:'四川省', city:'自贡市', district:'高新区', address:'丹桂40栋', latE6: 29339000, lngE6: 104778000 },
    receiver: { name:'客', mobile:'13800000000', province:'四川省', city:'自贡市', district:'高新区', address:'某小区', latE6: 29350000, lngE6: 104790000 },
    goods: { title:'凉菜', weightKg: 0.6, totalPriceFen: 2400, count: 2 }, remark: '不要辣',
  }, ['shunfengtongcheng','dadatongcheng'], '食品') as Record<string, unknown>
  assert.strictEqual(p.sendManLat, '29.339000'); assert.strictEqual(p.recManLng, '104.790000')
  assert.strictEqual(p.lbsType, 2); assert.strictEqual(p.weight, '0.6'); assert.strictEqual(p.price, '24.00')
  assert.deepStrictEqual(p.kuaidiComList, ['shunfengtongcheng','dadatongcheng'])
  assert.deepStrictEqual(p.goods, [{ name: '凉菜', type: '食品', count: 2 }])
  assert.strictEqual(p.callbackUrl, 'http://x/api/kd/D42-1'); assert.strictEqual(p.salt, 'salt16charsalt16')
  assert.strictEqual(p.orderType, 0)
})
t('回调验签：正确通过、篡改失败、多字节 sign 不抛异常、缺 param 报 BAD_PARAM', () => {
  const salt = 'abc123'
  const param = JSON.stringify({ orderId:'KD1', kuaidicom:'shansongtongcheng', status:'310', statusDesc:'骑手已取货', courierName:'张三', courierMobile:'13911112222', updateTime:'2026-09-04 10:00:00' })
  const good = { taskId: 'T1', param, sign: md5U(param + salt) }
  const r1 = kd100Provider.verifyAndParseCallback(good, salt)
  assert.ok(r1.ok && r1.payload.providerStatus === '310' && r1.payload.courierName === '张三')
  assert.ok(r1.ok && r1.payload.providerUpdateTime instanceof Date)
  const r2 = kd100Provider.verifyAndParseCallback({ ...good, sign: md5U(param + 'WRONG') }, salt)
  assert.deepStrictEqual(r2, { ok: false, reason: 'SIGN_MISMATCH' })
  const r3 = kd100Provider.verifyAndParseCallback({ ...good, sign: '汉'.repeat(32) }, salt)
  assert.deepStrictEqual(r3, { ok: false, reason: 'SIGN_MISMATCH' })
  // 签名必须算对，否则会在字节长度短路处返回 SIGN_MISMATCH，永远踏不到 BAD_PARAM 分支
  const r4 = kd100Provider.verifyAndParseCallback({ taskId:'T1', param: 'not-json', sign: md5U('not-json' + salt) }, salt)
  assert.deepStrictEqual(r4, { ok: false, reason: 'BAD_PARAM' })
  const r5 = kd100Provider.verifyAndParseCallback({ taskId:'T1', sign: md5U('x' + salt) } as never, salt)
  assert.deepStrictEqual(r5, { ok: false, reason: 'BAD_PARAM' })   // param 缺失
})
t('回调字段截断（statusDesc 500 字 → 255）', () => {
  const salt = 's'
  const param = JSON.stringify({ orderId:'K', status:'510', statusDesc: '异'.repeat(500), updateTime: null })
  const r = kd100Provider.verifyAndParseCallback({ taskId:'T', param, sign: md5U(param + salt) }, salt)
  assert.ok(r.ok && (r.payload.statusDesc ?? '').length === 255)
})
console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)

if (process.argv.includes('--integration')) {
  ;(async () => {
    const { config } = await import('../src/config')
    if (!config.kd100.key || !config.kd100.secret) { console.log('（--integration 跳过：未配置 KD100_KEY/SECRET）'); return }
    const { getLocalSettings } = await import('../src/services/local-settings')
    const s = await getLocalSettings()
    if (s.store.latE6 === null || s.store.lngE6 === null) { console.log('（--integration 跳过：门店未设坐标）'); return }
    const r = await kd100Provider.price({
      deliveryNo: 'probe', callbackUrl: '', callbackSalt: '',
      sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
      receiver: { name: '探测', mobile: '13800000000', province: s.store.province, city: s.store.city, district: s.store.district, address: '探测点', latE6: s.store.latE6 + 9000, lngE6: s.store.lngE6 + 9000 },
      goods: { title: '凉菜', weightKg: 0.5, totalPriceFen: 2000, count: 1 }, remark: '',
    } as never)
    console.log('真实询价（只读不扣费）:', JSON.stringify(r))
    process.exit(process.exitCode ?? 0)
  })().catch((e) => { console.error('--integration 失败:', (e as Error).message); process.exit(1) })
}
```
Run（RED）: `cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts` → `Cannot find module '../src/services/delivery/kd100'`。

- [ ] **Step 2: 实现 kd100.ts**

```ts
/**
 * 快递100 同城急送协议实现。只懂协议：签名/编码/超时/验签/错误映射，不碰数据库。
 * 事实来源 docs/research/2026-09-03-kuaidi100-same-city-api.md：
 *  - POST https://api.kuaidi100.com/bsamecity/order，x-www-form-urlencoded
 *  - sign = MD5(param + t + key + secret) 32 位大写
 *  - 不支持商户自有单号 → deliveryNo 拼进 callbackUrl（回调按 URL 直取）
 *  - 回调 sign = MD5(param + salt)
 * ⚠️ 全仓其它 fetch 都没有超时；这里必须 AbortSignal.timeout(8000)——超时时下单可能已成功，
 *    调用方按 UNKNOWN 处理等回调认领，绝不能重试（会双呼骑手）。
 */
import crypto from 'crypto'
import { config, validateKd100Config } from '../../config'
import { ProviderError, DeliveryProvider, CreateDeliveryOrderInput, CreateDeliveryOrderResult, DeliveryCallbackPayload, ProviderErrorKind } from './types'
import { trunc } from './events'

const API_URL = 'https://api.kuaidi100.com/bsamecity/order'
const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

export function _sign(paramStr: string, t: string, key: string, secret: string): string {
  return md5U(paramStr + t + key + secret)
}
export function _mapReturnCode(code: number | string): ProviderErrorKind {
  const c = String(code)
  if (c === '30004') return 'BALANCE'
  if (c === '30005') return 'CAPACITY'
  if (['30001', '30002', '30003', '30006'].includes(c)) return 'CONFIG'
  return 'BUSINESS'
}
const coord = (e6: number) => (e6 / 1e6).toFixed(6)

export function _buildOrderParam(input: CreateDeliveryOrderInput, providers: string[], goodsType: string): Record<string, unknown> {
  const { sender: s, receiver: r, goods: g } = input
  return {
    kuaidiComList: providers, lbsType: 2, orderType: 0,
    sendManName: s.name, sendManMobile: s.mobile, sendManProvince: s.province, sendManCity: s.city,
    sendManDistrict: s.district, sendManAddr: s.address, sendManLat: coord(s.latE6), sendManLng: coord(s.lngE6),
    recManName: r.name, recManMobile: r.mobile, recManProvince: r.province, recManCity: r.city,
    recManDistrict: r.district, recManAddr: r.address, recManLat: coord(r.latE6), recManLng: coord(r.lngE6),
    weight: String(Math.max(0.5, Math.round(g.weightKg * 10) / 10)),
    price: (g.totalPriceFen / 100).toFixed(2),
    goods: [{ name: g.title, type: goodsType, count: g.count }],
    remark: input.remark ?? '',
    salt: input.callbackSalt, callbackUrl: input.callbackUrl,
  }
}

interface Kd100Response { code?: number | string; returnCode?: number | string; success?: boolean; message?: string; data?: Record<string, unknown> }
async function post(method: string, param: Record<string, unknown>): Promise<Kd100Response> {
  validateKd100Config()
  const t = Date.now().toString()
  const paramStr = JSON.stringify(param)
  const body = new URLSearchParams({ method, key: config.kd100.key, sign: _sign(paramStr, t, config.kd100.key, config.kd100.secret), t, param: paramStr })
  let res: Response
  try {
    res = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(), signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    const name = (e as Error)?.name ?? ''
    const isTimeout = name === 'TimeoutError' || name === 'AbortError'
    throw new ProviderError('TIMEOUT', isTimeout ? 'TIMEOUT' : 'NETWORK', `快递100 请求${isTimeout ? '超时' : '网络失败'}: ${(e as Error).message}`, e)
  }
  let data: Kd100Response
  try { data = (await res.json()) as Kd100Response } catch { throw new ProviderError('BUSINESS', `HTTP_${res.status}`, '快递100 响应非 JSON') }
  const code = data.returnCode ?? data.code
  if (!res.ok || (String(code) !== '200' && data.success !== true)) {
    throw new ProviderError(_mapReturnCode(code ?? res.status), String(code ?? res.status), data.message ?? '快递100 返回异常', data)
  }
  return data
}

const yuanToFen = (v: unknown): number | null => {
  const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null
}
const toInt = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null }

export const kd100Provider: DeliveryProvider = {
  name: 'KD100',
  async price(input) {
    const settings = await import('../local-settings').then((m) => m.getLocalSettings())
    const param = _buildOrderParam(input, settings.kd100.providers, settings.kd100.goodsType)
    const data = await post('batchPrice', param)
    const fees = (data.data?.feeDetail as { discountFee?: unknown; distance?: unknown }[] | undefined) ?? []
    const feesFen = fees.map((f) => yuanToFen(f.discountFee)).filter((n): n is number => n !== null)
    return { feeFen: feesFen.length ? Math.min(...feesFen) : yuanToFen(data.data?.discountFee) ?? 0, distanceM: toInt(fees[0]?.distance ?? data.data?.deliveryDistance) }
  },
  async createOrder(input): Promise<CreateDeliveryOrderResult> {
    const settings = await import('../local-settings').then((m) => m.getLocalSettings())
    const param = _buildOrderParam(input, settings.kd100.providers, settings.kd100.goodsType)
    const data = await post('batchOrder', param)
    const d = data.data ?? {}
    // 距离在 fee[] 每项里（研究文档 §3.5），不在 data 顶层——顶层只作兜底
    const fees = (d.fee as { discountFee?: unknown; deliveryDistance?: unknown }[] | undefined) ?? []
    const feesFen = fees.map((f) => yuanToFen(f.discountFee)).filter((n): n is number => n !== null)
    return {
      taskId: typeof d.taskId === 'string' ? d.taskId : null,
      providerOrderId: typeof d.orderId === 'string' || typeof d.orderId === 'number' ? String(d.orderId) : null,
      quotedFeeFen: feesFen.length ? Math.min(...feesFen) : yuanToFen(d.discountFee),
      distanceM: toInt(fees[0]?.deliveryDistance ?? d.deliveryDistance), raw: data,
    }
  },
  async precancelOrder({ taskId }) {
    const data = await post('precancel', { taskId, cancelMsgType: 8, cancelMsg: '预览取消费用' })
    return { cancelFeeFen: yuanToFen(data.data?.cancelFee) }
  },
  async cancelOrder({ taskId, reason }) {
    const data = await post('cancel', { taskId, cancelMsgType: 8, cancelMsg: trunc(reason, 60) ?? '商家取消' })
    return { cancelFeeFen: yuanToFen(data.data?.cancelFee), raw: data }
  },
  async addTip({ taskId, amountFen }) {
    await post('addfee', { taskId, tips: (amountFen / 100).toFixed(2), remark: '商家加小费' })
  },
  async queryCourier({ taskId }) {
    const data = await post('queryCourier', { taskId })
    const lat = Number(data.data?.courierLat), lng = Number(data.data?.courierLng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return { latE6: Math.round(lat * 1e6), lngE6: Math.round(lng * 1e6) }
  },
  verifyAndParseCallback(body, salt) {
    const paramStr = body.param
    const sign = body.sign
    if (typeof paramStr !== 'string' || !paramStr || typeof sign !== 'string') return { ok: false, reason: 'BAD_PARAM' }
    const expect = md5U(paramStr + salt)
    const got = sign.toUpperCase()
    // 长度不等 timingSafeEqual 会抛：先按字节长度筛掉（多字节字符等构造输入）
    if (Buffer.byteLength(got) !== Buffer.byteLength(expect)) return { ok: false, reason: 'SIGN_MISMATCH' }
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got))) return { ok: false, reason: 'SIGN_MISMATCH' }
    let p: Record<string, unknown>
    try { p = JSON.parse(paramStr) as Record<string, unknown> } catch { return { ok: false, reason: 'BAD_PARAM' } }
    const ut = typeof p.updateTime === 'string' && p.updateTime ? new Date(p.updateTime.replace(' ', 'T') + '+08:00') : null
    const payload: DeliveryCallbackPayload = {
      taskId: trunc(String(body.taskId ?? p.taskId ?? ''), 64) ?? '',
      providerStatus: String(p.status ?? ''),
      statusDesc: trunc(p.statusDesc as string | undefined, 255),
      courierCompany: trunc(p.kuaidicom as string | undefined, 32),
      courierName: trunc(p.courierName as string | undefined, 64),
      courierMobile: trunc(p.courierMobile as string | undefined, 20),
      providerUpdateTime: ut && !Number.isNaN(ut.getTime()) ? ut : null,
      raw: p,
    }
    return { ok: true, payload }
  },
}
```

- [ ] **Step 3: 自测通过 + tsc + 提交**

Run: `cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts && npx tsc --noEmit` → `全部通过 5`、零错误。
（`--integration` 本任务只要求「未配置密钥时优雅跳过」：`npx ts-node --transpile-only scripts/selftest-kd100.ts --integration` 输出跳过提示、退出码 0。真实询价在 V 任务跑。）
```bash
git add apps/server/src/services/delivery/kd100.ts apps/server/scripts/selftest-kd100.ts
git commit -m "feat(delivery): 快递100 协议实现——签名/8s 超时/错误映射/回调验签 + 离线自测

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: mock provider + 工厂 + mock 控制路由

**Files:**
- Create: `apps/server/src/services/delivery/mock.ts`
- Create: `apps/server/src/services/delivery/provider.ts`
- Create: `apps/server/src/routes/admin/kd100-mock.ts`
- Modify: `apps/server/src/routes/admin/index.ts`（条件挂载）
- Test: `scripts/e2e.sh` 新增「== 25. 同城运力 mock 基建 ==」（先写，RED）

**Interfaces:**
- Consumes: Task 1/2 类型。
- Produces:
  - `provider.ts`: `export function getDeliveryProvider(): DeliveryProvider`（`config.mock.delivery` → mock，否则 kd100）。
  - `mock.ts`: `export const mockProvider: DeliveryProvider`；`export type MockDirective = { kind:'ok'; taskId?:string; providerOrderId?:string; quotedFeeFen?:number; distanceM?:number } | { kind:'error'; code:'30001'|'30002'|'30003'|'30004'|'30005'|'30006' } | { kind:'timeout' }`；`export function queueDirective(op:'createOrder'|'cancelOrder'|'precancelOrder'|'addTip'|'queryCourier'|'price', d: MockDirective): void`；`export function getCalls(): {op:string; input:unknown; at:string}[]`；`export function resetMock(): void`。队列空时默认 `ok`（createOrder 默认 `taskId:'MOCKTASK-'+自增`、`quotedFeeFen:500`、`distanceM:2600`；cancelOrder 默认 `cancelFeeFen:200`；precancel 默认 200；queryCourier 默认 null）。`error` 指令抛 `ProviderError(_mapReturnCode(code), code, 'mock:'+code)`；`timeout` 抛 `ProviderError('TIMEOUT','TIMEOUT','mock timeout')`。**verifyAndParseCallback 直接复用 `kd100Provider.verifyAndParseCallback`**（真实验签逻辑必须被 e2e 打到）。
  - 控制路由（挂 `/admin/system/kd100-mock`，`verifyAdminToken` 之内；**仅 `config.mock.delivery` 为 true 时在 admin/index.ts 挂载**）：`POST /queue {op, directive}`、`GET /calls`、`GET /salt/:deliveryNo`（查 delivery 返回 `{salt}`，404→40401）、`POST /reset`。

- [ ] **Step 1: e2e 断言（RED）**

在「== 24. 渠道一致性 ==」之前、清理段之后……**注意**：现有 e2e 的段落顺序是 …第 23 段 → 「== 11. 清理 ==」→「== 24. 渠道一致性 ==」→ 汇总。新段 25 插在**第 23 段之后、清理段之前**（后续任务的 26-30 同理依次追加在 25 之后）：
```bash
echo "== 25. 同城运力 mock 基建 =="
R=$(req POST /api/admin/system/kd100-mock/reset "$AT"); assert_eq "mock reset code 0" "$(code "$R")" "0"
R=$(req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30005"}}')
assert_eq "queue code 0" "$(code "$R")" "0"
R=$(req GET /api/admin/system/kd100-mock/calls "$AT"); assert_eq "calls 初始为空数组" "$(jq -r '.data | length' <<<"$R")" "0"
R=$(req GET /api/admin/system/kd100-mock/salt/D999999-1 "$AT"); assert_eq "未知单号 salt 404" "$(code "$R")" "40401"
```
Run: `bash scripts/e2e.sh 2>&1 | sed -n '/== 25/,/== 11/p'` → Expected 4 条 `✘`（路由不存在，返回体非预期）。

- [ ] **Step 2: 实现 mock.ts / provider.ts / kd100-mock.ts 并挂载**

`mock.ts`（关键片段，完整实现按 Interfaces）：
```ts
import { DeliveryProvider, ProviderError, CreateDeliveryOrderResult } from './types'
import { _mapReturnCode, kd100Provider } from './kd100'

export type MockDirective = /* 见 Interfaces */
const queues = new Map<string, MockDirective[]>()
const calls: { op: string; input: unknown; at: string }[] = []
let seq = 0

export function queueDirective(op: string, d: MockDirective): void {
  if (!queues.has(op)) queues.set(op, [])
  queues.get(op)!.push(d)
}
export function getCalls() { return [...calls] }
export function resetMock(): void { queues.clear(); calls.length = 0; seq = 0 }

function take(op: string): MockDirective { return queues.get(op)?.shift() ?? { kind: 'ok' } }
function record(op: string, input: unknown) { calls.push({ op, input, at: new Date().toISOString() }) }
function act(op: string, input: unknown): MockDirective {
  record(op, input)
  const d = take(op)
  if (d.kind === 'error') throw new ProviderError(_mapReturnCode(d.code), d.code, `mock:${d.code}`)
  if (d.kind === 'timeout') throw new ProviderError('TIMEOUT', 'TIMEOUT', 'mock timeout')
  return d
}

export const mockProvider: DeliveryProvider = {
  name: 'MOCK',
  async price(input) { const d = act('price', input); return { feeFen: d.kind==='ok' && d.quotedFeeFen != null ? d.quotedFeeFen : 500, distanceM: 2600 } },
  async createOrder(input): Promise<CreateDeliveryOrderResult> {
    const d = act('createOrder', input)
    seq += 1
    return { taskId: (d.kind==='ok' && d.taskId) || `MOCKTASK-${seq}`, providerOrderId: (d.kind==='ok' && d.providerOrderId) || `MOCKORD-${seq}`,
             quotedFeeFen: d.kind==='ok' && d.quotedFeeFen != null ? d.quotedFeeFen : 500,
             distanceM: d.kind==='ok' && d.distanceM != null ? d.distanceM : 2600, raw: { mock: true } }
  },
  async precancelOrder(i) { act('precancelOrder', i); return { cancelFeeFen: 200 } },
  async cancelOrder(i) { act('cancelOrder', i); return { cancelFeeFen: 200, raw: { mock: true } } },
  async addTip(i) { act('addTip', i) },
  async queryCourier(i) { act('queryCourier', i); return null },
  verifyAndParseCallback: kd100Provider.verifyAndParseCallback,   // 真验签：e2e 必须能打到验签失败分支
}
```
`provider.ts`：
```ts
import { config } from '../../config'
import { DeliveryProvider } from './types'
import { kd100Provider } from './kd100'
import { mockProvider } from './mock'
export function getDeliveryProvider(): DeliveryProvider {
  return config.mock.delivery ? mockProvider : kd100Provider
}
```
`routes/admin/kd100-mock.ts`：标准 Router，四个端点调 mock.ts 导出；`GET /salt/:deliveryNo` 用 `prisma.delivery.findUnique({where:{deliveryNo}})`，无 → `AppError(40401,'配送单不存在',404)`，有 → `success(res,{salt: d.callbackSalt})`。
`admin/index.ts` 在 `router.use('/system', systemRouter)` 之后：
```ts
// mock 控制面：仅本地/e2e（生产 LOCAL_DELIVERY_PROVIDER_MOCK=true 会在 config 层拒绝启动）
if (config.mock.delivery) router.use('/system/kd100-mock', kd100MockRouter)
```

- [ ] **Step 3: GREEN + 提交**

Run: `cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 25 段 4 条 `✔`，总数 218/0。
```bash
git add apps/server/src/services/delivery/{mock,provider}.ts apps/server/src/routes/admin/kd100-mock.ts apps/server/src/routes/admin/index.ts scripts/e2e.sh
git commit -m "feat(delivery): mock 运力（指令队列/调用记录/真验签复用）+ 控制路由

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: callRider 三分支 + 同城 accept/call/void/熔断恢复路由

**Files:**
- Create: `apps/server/src/services/delivery/orchestrator.ts`（本任务只放 `callRider`、`voidUnknownDelivery`、`getActiveDelivery`）
- Create: `apps/server/src/routes/admin/delivery.ts`
- Modify: `apps/server/src/routes/admin/index.ts`（挂 `/local/orders`）
- Modify: `apps/server/src/routes/admin/system.ts`（`POST /kd100-circuit/reset`；status 的 kd100 块加 `circuitTripped`）
- Modify: `apps/server/src/services/order-notify.ts`（加 `notifyLocalDeliveryAlert(title: string, lines: string[]): void`——店员双通道，照 `notifyCancelRequest` 范式）
- Test: `scripts/e2e.sh` 新增「== 26. 呼叫骑手三分支 ==」

**Interfaces:**
- Consumes: T1-T3 全部；`local-settings.getLocalSettings`；`notify.notifySystemAlert`。
- Produces（orchestrator，后续任务契约）:
  - `export async function getActiveDelivery(orderId: number)` → `prisma.delivery.findFirst({ where: { activeOrderId: orderId } })`。
  - `export interface CallRiderInput { orderId: number; operator: string; source: 'ADMIN' | 'SCHEDULER' }`
  - `export async function callRider(input: CallRiderInput): Promise<{ deliveryId: number; deliveryNo: string; status: 'CALLING' | 'UNKNOWN'; quotedFeeFen: number | null }>`
  - `export async function voidUnknownDelivery(input: { orderId: number; operator: string }): Promise<void>`（按 orderId 找 activeOrderId 单；status!=='UNKNOWN' → 42234；updateMany UNKNOWN→FAILED + activeOrderId:null + errorCode:'VOIDED' + failReason:'人工作废' + event(ADMIN)；count 0 → 42237）
  - 路由：`POST /api/admin/local/orders/:id/accept`（LOCAL 守卫→42204『仅同城订单』；PAID→PREPARING+acceptedAt，count 0→42204 带现状态）、`/accept-and-call`（先 accept，成功后 callRider；callRider 抛错时**接单保留**，错误 message 前缀「已接单，」）、`/call`、`/delivery/void`、`GET /:id/delivery`（`{ delivery: 有效单或最近一张 | null, events: 按时间升序 }`——`findFirst({where:{orderId}, orderBy:{id:'desc'}, include:{events:{orderBy:{id:'asc'}}}})`）。
  - `POST /api/admin/system/kd100-circuit/reset` → `resetCircuit(req.adminUsername)`，返回 `getCircuitState()`。

- [ ] **Step 1: e2e（RED）**

第 25 段之后插入（依赖既有变量：`$AT/$UT/$LPID/$LADDR/$QTOKEN`；同城设置在第 21 段已 enabled 且营业中）：
```bash
echo "== 26. 呼叫骑手三分支 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
# 第 22 段的「改文字清坐标」断言清掉了 $LADDR 的坐标，同城下单要重新报价必须先恢复；
# 顺手把库存加足——26-31 段要造十几笔单，50 件不保险
req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":29350000,"lngE6":104790000}' >/dev/null
req PUT "/api/admin/products/$LPID" "$AT" '{"stock":500}' >/dev/null
mk_local_paid() {  # 造一笔已支付同城单，echo orderId
  local r cid oid
  r=$(req POST /api/cart "$UT" "{\"productId\":$LPID,\"quantity\":2}"); cid=$(jq -r '.data.id // empty' <<<"$r")
  r=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$cid],\"addressId\":$LADDR,\"deliveryType\":\"LOCAL\"}")
  oid=$(jq -r '.data.orderId // empty' <<<"$r"); [[ -n "$oid" ]] || { echo ""; return; }
  req POST "/api/orders/$oid/pay" "$UT" >/dev/null; echo "$oid"
}
DLO1=$(mk_local_paid); [[ -n "$DLO1" ]] && ok "同城单 #$DLO1 已支付" || fail "造单失败"
R=$(req POST "/api/admin/local/orders/$DLO1/call" "$AT"); assert_eq "未接单不能呼叫 42204" "$(code "$R")" "42204"
R=$(req POST "/api/admin/local/orders/$DLO1/accept" "$AT"); assert_eq "同城接单 code 0" "$(code "$R")" "0"
assert_eq "接单后 PREPARING" "$(req GET "/api/admin/orders/$DLO1" "$AT" | jq -r .data.status)" "PREPARING"
# —— 分支①成功：CALLING + taskId + quotedFee
R=$(req POST "/api/admin/local/orders/$DLO1/call" "$AT"); assert_eq "呼叫成功 code 0" "$(code "$R")" "0"
assert_eq "返回 status=CALLING" "$(jq -r .data.status <<<"$R")" "CALLING"
DNO1=$(jq -r .data.deliveryNo <<<"$R"); [[ "$DNO1" == D${DLO1}-1 ]] && ok "deliveryNo=D${DLO1}-1" || fail "deliveryNo 格式" "$DNO1"
R=$(req GET "/api/admin/local/orders/$DLO1/delivery" "$AT")
assert_eq "落库 CALLING" "$(jq -r .data.delivery.status <<<"$R")" "CALLING"
assert_eq "quotedFee=500" "$(jq -r .data.delivery.quotedFee <<<"$R")" "500"
[[ "$(jq -r .data.delivery.providerTaskId <<<"$R")" == MOCKTASK-* ]] && ok "taskId 已写" || fail "taskId"
R=$(req POST "/api/admin/local/orders/$DLO1/call" "$AT"); assert_eq "重复呼叫 42228" "$(code "$R")" "42228"
# mock 记录了 callbackUrl 拼装
R=$(req GET /api/admin/system/kd100-mock/calls "$AT")
[[ "$(jq -r '.data[-1].input.callbackUrl' <<<"$R")" == */api/kd/D${DLO1}-1 ]] && ok "callbackUrl 含 deliveryNo" || fail "callbackUrl" "$R"
# —— 分支②超时：UNKNOWN 占位不释放；作废后可重呼且 seq 递增
DLO2=$(mk_local_paid); req POST "/api/admin/local/orders/$DLO2/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO2/call" "$AT"); assert_eq "超时返回 UNKNOWN" "$(jq -r .data.status <<<"$R")" "UNKNOWN"
R=$(req POST "/api/admin/local/orders/$DLO2/call" "$AT"); assert_eq "UNKNOWN 占位期间再呼 42228" "$(code "$R")" "42228"
R=$(req POST "/api/admin/local/orders/$DLO2/delivery/void" "$AT"); assert_eq "作废 code 0" "$(code "$R")" "0"
R=$(req GET "/api/admin/local/orders/$DLO2/delivery" "$AT"); assert_eq "作废后 FAILED" "$(jq -r .data.delivery.status <<<"$R")" "FAILED"
R=$(req POST "/api/admin/local/orders/$DLO2/call" "$AT"); assert_eq "作废后重呼 code 0" "$(code "$R")" "0"
assert_eq "重呼单号 seq=2" "$(jq -r .data.deliveryNo <<<"$R")" "D${DLO2}-2"
# —— 分支③明确失败：30005 ADMIN 不重试→42225；30004 熔断→42232→恢复
DLO3=$(mk_local_paid); req POST "/api/admin/local/orders/$DLO3/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30005"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "30005 手动呼叫不重试 42225" "$(code "$R")" "42225"
assert_eq "ADMIN 来源只外呼一次" "$(req GET /api/admin/system/kd100-mock/calls "$AT" | jq -r '[.data[]|select(.op=="createOrder")]|length')" "1"
R=$(req GET "/api/admin/local/orders/$DLO3/delivery" "$AT"); assert_eq "失败后 FAILED" "$(jq -r .data.delivery.status <<<"$R")" "FAILED"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"error","code":"30004"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "30004 → 42225" "$(code "$R")" "42225"
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "熔断后直接拒 42232" "$(code "$R")" "42232"
assert_eq "熔断可见于 status" "$(req GET /api/admin/system/status "$AT" | jq -r .data.kd100.circuitTripped)" "true"
R=$(req POST /api/admin/system/kd100-circuit/reset "$AT"); assert_eq "恢复 code 0" "$(code "$R")" "0"
R=$(req POST "/api/admin/local/orders/$DLO3/call" "$AT"); assert_eq "恢复后可呼 code 0" "$(code "$R")" "0"
```
清理段追加（这些单会留在 PREPARING/CALLING，不影响后续断言，但把 mock 复位）：
```bash
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null 2>&1 || true
```
Run RED：第 26 段大量 `✘`。

- [ ] **Step 2: 实现 orchestrator.callRider / voidUnknownDelivery**

`orchestrator.ts`（本任务部分，完整代码）：
```ts
/**
 * 配送单编排层。铁律：
 *  - 外呼永远在事务外；外呼前（占位）后（落结果）各一段短事务
 *  - 进入终态的所有路径，同一条 update 里 activeOrderId: null
 *  - Delivery 并发防线 = activeOrderId 唯一索引（照抄 refund.ts 的 P2002 范式）
 */
import crypto from 'crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { AppError } from '../../middlewares/error'
import { config } from '../../config'
import { getLocalSettings } from '../local-settings'
import { getDeliveryProvider } from './provider'
import { ProviderError, CreateDeliveryOrderInput } from './types'
import { isCircuitTripped, tripCircuit } from './circuit'
import { recordDeliveryEvent, adminEventKey, trunc } from './events'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'

export async function getActiveDelivery(orderId: number) {
  return prisma.delivery.findFirst({ where: { activeOrderId: orderId } })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface CallRiderInput { orderId: number; operator: string; source: 'ADMIN' | 'SCHEDULER' }

export async function callRider(input: CallRiderInput) {
  const { orderId, operator, source } = input
  if (isCircuitTripped()) throw new AppError(42232, '快递100 余额不足已暂停呼叫，请充值后在系统状态页点「恢复」')

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: { include: { product: { select: { netWeightG: true } } } } } })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可呼叫骑手')
  if (order.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${order.status}，仅备餐中订单可呼叫骑手`)
  if (order.cancelRequestedAt) throw new AppError(42204, '顾客已申请取消，请先处理取消申请再决定是否呼叫')
  if (order.receiverLatE6 === null || order.receiverLngE6 === null) throw new AppError(42223, '订单缺少收货坐标，无法呼叫骑手')

  const s = await getLocalSettings()
  if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标')

  // 占位事务：activeOrderId 唯一索引 = 并发防线
  const seq = (await prisma.delivery.count({ where: { orderId } })) + 1
  const deliveryNo = `D${orderId}-${seq}`
  const callbackUrl = `${config.publicBaseUrl}/api/kd/${deliveryNo}`
  if (callbackUrl.length > 50) throw new AppError(42225, `回调地址超长（${callbackUrl.length}>50），请联系管理员缩短域名/路径`)
  const callbackSalt = crypto.randomBytes(8).toString('hex')   // 16 字符 ≤ VarChar(20)
  let deliveryId: number
  try {
    const created = await prisma.delivery.create({ data: {
      orderId, orderNo: order.orderNo, deliveryNo, activeOrderId: orderId,
      provider: getDeliveryProvider().name, status: 'PENDING', statusRank: 0,
      callbackSalt, operator: trunc(operator, 64) ?? operator,
    } })
    deliveryId = created.id
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new AppError(42228, '该订单已有在途配送单')
    }
    throw e
  }

  const totalItems = order.items.reduce((n, it) => n + it.quantity, 0)
  const weightKg = order.items.reduce((w, it) => w + ((it.product?.netWeightG ?? s.kd100.defaultItemWeightG) * it.quantity) / 1000, 0)
  const req: CreateDeliveryOrderInput = {
    deliveryNo, callbackUrl, callbackSalt,
    sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
    receiver: { name: order.receiverName, mobile: order.receiverPhone, province: order.receiverProvince, city: order.receiverCity, district: order.receiverDistrict,
                address: `${order.receiverDetail}${order.receiverPoiName ? `（${order.receiverPoiName}）` : ''}`, latE6: order.receiverLatE6, lngE6: order.receiverLngE6 },
    goods: { title: '凉菜', weightKg: Math.max(0.5, weightKg), totalPriceFen: order.totalAmount, count: totalItems },
    remark: order.remark ?? '',
  }

  // 外呼（事务外）。N7：ADMIN 不重试；SCHEDULER 对 CAPACITY 退避重试 2 次
  const provider = getDeliveryProvider()
  const delays = source === 'SCHEDULER' ? config.kd100.retryDelaysMs : []
  let lastErr: ProviderError | null = null
  let result: Awaited<ReturnType<typeof provider.createOrder>> | null = null
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try { result = await provider.createOrder(req); lastErr = null; break }
    catch (e) {
      if (!(e instanceof ProviderError)) throw e
      lastErr = e
      if (e.kind === 'TIMEOUT' || e.kind !== 'CAPACITY' || attempt === delays.length) break
      await sleep(delays[attempt])
    }
  }

  if (result) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
          status: 'CALLING', statusRank: 10, calledAt: new Date(),
          providerTaskId: trunc(result!.taskId, 64), providerOrderId: trunc(result!.providerOrderId, 64),
          quotedFee: result!.quotedFeeFen, providerDistanceM: result!.distanceM,
        } })
        await recordDeliveryEvent(tx, { deliveryId, dedupeKey: adminEventKey(), source: 'API', statusDesc: '已向运力方下单（并呼抢单中）', operator })
      })
    } catch (e) {
      // 落库失败（如 providerTaskId 撞唯一索引）会让占位行永远停在 PENDING：
      // voidUnknownDelivery 只收 UNKNOWN、cancelDelivery 要求有 taskId，没有任何人能救它，
      // 该订单就此永久不可再呼。所以这里必须同条 update 释放占位再抛。
      await prisma.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
        status: 'FAILED', activeOrderId: null, errorCode: 'PERSIST',
        failReason: trunc(`下单成功但落库失败：${(e as Error).message}`, 255),
      } })
      notifySystemAlert('呼叫骑手成功但落库失败', [`订单 ${order.orderNo}（${deliveryNo}）`, '运力方可能已产生真实单，请到快递100 后台核对', (e as Error).message], { key: `kd100-persist:${orderId}` })
      throw new AppError(42225, '呼叫已发出但本地记录失败，请到快递100 后台核对后重试')
    }
    return { deliveryId, deliveryNo, status: 'CALLING' as const, quotedFeeFen: result.quotedFeeFen }
  }

  const err = lastErr!
  if (err.kind === 'TIMEOUT') {
    // 下单可能已成功：UNKNOWN 占位、不释放，等回调按 URL 认领或人工作废（决策见 spec §5.4）
    await prisma.$transaction(async (tx) => {
      await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: { status: 'UNKNOWN', calledAt: new Date(), errorCode: trunc(err.code, 16), failReason: trunc(err.message, 255) } })
      await recordDeliveryEvent(tx, { deliveryId, dedupeKey: adminEventKey(), source: 'API', statusDesc: `下单响应超时，等待回调认领：${err.message}`, operator })
    })
    notifySystemAlert('快递100 下单响应超时', [`订单 ${order.orderNo}（${deliveryNo}）`, '请到快递100 后台核对是否已产生真实单；回调到达会自动认领，确认没单可在看板作废'], { key: `kd100-timeout:${orderId}` })
    return { deliveryId, deliveryNo, status: 'UNKNOWN' as const, quotedFeeFen: null }
  }

  // 明确失败：FAILED + 释放（先落库再抛，照抄 refund 范式）
  const firstTrip = err.kind === 'BALANCE' ? tripCircuit(err.code) : false
  await prisma.$transaction(async (tx) => {
    await tx.delivery.updateMany({ where: { id: deliveryId, status: 'PENDING' }, data: {
      status: 'FAILED', activeOrderId: null, errorCode: trunc(err.code, 16), failReason: trunc(err.message, 255),
    } })
    await recordDeliveryEvent(tx, { deliveryId, dedupeKey: adminEventKey(), source: 'API', statusDesc: `呼叫失败(${err.code})：${err.message}`, operator })
  })
  if (err.kind === 'CONFIG') notifySystemAlert('快递100 配置类错误', [`订单 ${order.orderNo}：${err.code} ${err.message}`], { key: `kd100-config:${err.code}` })
  if (err.kind === 'BALANCE' && firstTrip) notifySystemAlert('快递100 余额不足，已熔断呼叫', ['请充值后在 系统状态 页点「恢复」', `触发订单 ${order.orderNo}`], { key: 'kd100-balance' })
  if (err.kind === 'CAPACITY') notifyLocalDeliveryAlert('呼叫骑手失败（运力异常）', [`订单 ${order.orderNo}`, err.message, '可稍后重试、加小费或改自己送'])
  throw new AppError(42225, `呼叫骑手失败：${err.message}`)
}

export async function voidUnknownDelivery(input: { orderId: number; operator: string }): Promise<void> {
  const d = await getActiveDelivery(input.orderId)
  if (!d) throw new AppError(42233, '无在途配送单')
  if (d.status !== 'UNKNOWN') throw new AppError(42234, `当前配送单状态为 ${d.status}，仅「状态未确认」可作废`)
  const moved = await prisma.delivery.updateMany({ where: { id: d.id, status: 'UNKNOWN' }, data: {
    status: 'FAILED', activeOrderId: null, errorCode: 'VOIDED', failReason: '人工作废', operator: trunc(input.operator, 64),
  } })
  if (moved.count === 0) throw new AppError(42237, '配送单状态已变化，请刷新')
  await recordDeliveryEvent(prisma, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: '人工作废（快递100 后台确认无单）', operator: input.operator })
}
```

- [ ] **Step 3: 路由与挂载**

`routes/admin/delivery.ts`：五个端点按 Interfaces；`accept` 完整代码：
```ts
router.post('/:id/accept', async (req, res, next) => {
  try {
    const id = Number(req.params.id)
    const target = await prisma.order.findUnique({ where: { id }, select: { deliveryType: true, status: true } })
    if (!target) throw new AppError(40401, '订单不存在', 404)
    if (target.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单可在此接单')
    const moved = await prisma.order.updateMany({ where: { id, status: 'PAID' }, data: { status: 'PREPARING', acceptedAt: new Date() } })
    if (moved.count === 0) throw new AppError(42204, `订单状态为 ${target.status}，仅已付款订单可接单`)
    success(res, await prisma.order.findUnique({ where: { id } }))
  } catch (e) { next(e) }
})
```
`accept-and-call`：调上面逻辑（抽成局部函数 `doAccept(id)`），成功后 `try { const r = await callRider({orderId:id, operator:req.adminUsername!, source:'ADMIN'}); success(res,{accepted:true, ...r}) } catch (e) { if (e instanceof AppError) e.message = '已接单，' + e.message; throw e }`（catch 内 next(e)）。
`admin/index.ts`：`router.use('/local/orders', deliveryRouter)`（在 verifyAdminToken 之后区域）。
`system.ts`：status 的 kd100 块加 `circuitTripped: isCircuitTripped(),`；新增：
```ts
router.post('/kd100-circuit/reset', async (req, res, next) => {
  try { resetCircuit(req.adminUsername ?? 'admin'); success(res, getCircuitState()) } catch (e) { next(e) }
})
```
`order-notify.ts` 加 `notifyLocalDeliveryAlert(title, lines)`：读两个 ORDER_NOTIFY env，拼 `**🛵 ${title}**\n` + lines 前缀 `> `，双通道发送（照 `notifyCancelRequest` 的实现复制改造）。

- [ ] **Step 4: GREEN + 提交**

`cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 26 段全 `✔`（243/0 左右）。
```bash
git add apps/server/src/services/delivery/orchestrator.ts apps/server/src/routes/admin/{delivery.ts,index.ts,system.ts} apps/server/src/services/order-notify.ts scripts/e2e.sh
git commit -m "feat(delivery): callRider 三分支（成功/超时占位/失败熔断）+ 同城接单呼叫路由

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: 回调路由 + handleKdCallback + Order 联动 + 配送订阅消息

**Files:**
- Create: `apps/server/src/services/delivery/callback.ts`
- Create: `apps/server/src/routes/kd-callback.ts`
- Modify: `apps/server/src/app.ts`（公开区挂 `/api/kd`，与微信支付回调同区）
- Modify: `apps/server/src/config.ts`（zod 加 `WECHAT_TMPL_DELIVER`/`WECHAT_TMPL_DELIVER_FIELDS`；subscribe 组加 `deliverTemplateId: env.WECHAT_TMPL_DELIVER ?? ''`、`deliverFields: env.WECHAT_TMPL_DELIVER_FIELDS ?? ''`）
- Modify: `apps/server/src/services/subscribe-message.ts`（`sendDeliverSubscribeMessage` + `getSubscribeTemplateIds` 追加 deliver）
- Test: `scripts/e2e.sh` 新增「== 27. 回调状态机 ==」

**Interfaces:**
- Consumes: T1-T4 全部；`refund.ts` 的 `ACTIVE_REFUND_STATUSES`。
- Produces:
  - `export async function handleKdCallback(deliveryNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }>`
  - `export function sendDeliverSubscribeMessage(openid: string, order: { id: number; orderNo: string }, courier: { courierName?: string | null; courierMobile?: string | null }, productName?: string): void`
  - `getSubscribeTemplateIds()` 返回数组追加 `config.subscribe.deliverTemplateId`（.filter(Boolean) 已有，未配置自动剔除）。

- [ ] **Step 1: e2e（RED）**

第 26 段之后、`echo "== 11. 清理 =="` 之前插入。**注意两处状态前提**：①第 22 段结束时 `$LADDR` 的坐标已被清空（改文字自动清坐标的断言），造同城单前必须先恢复坐标；②`mk_local_paid` 是第 26 段定义的函数，本段直接复用。
```bash
echo "== 27. 回调状态机 =="
req PUT "/api/addresses/$LADDR" "$UT" '{"latE6":29350000,"lngE6":104790000}' >/dev/null   # 恢复第22段清掉的坐标
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
md5hex() { if command -v md5sum >/dev/null 2>&1; then printf '%s' "$1" | md5sum | cut -d' ' -f1; else printf '%s' "$1" | md5 -q; fi; }
KDCB_BODY=/tmp/e2e-kdcb.json
kd_cb() { # deliveryNo taskId status desc updateTime [courierName] [courierMobile] → echo HTTP 状态码，响应体在 $KDCB_BODY
  local dno="$1" task="$2" st="$3" desc="$4" ut="$5" cn="${6:-王骑手}" cm="${7:-13900001111}"
  local salt param sign
  salt=$(req GET "/api/admin/system/kd100-mock/salt/$dno" "$AT" | jq -r '.data.salt // empty')
  param=$(jq -cn --arg t "$task" --arg s "$st" --arg d "$desc" --arg u "$ut" --arg cn "$cn" --arg cm "$cm" \
    '{taskId:$t,status:$s,statusDesc:$d,updateTime:$u,courierName:$cn,courierMobile:$cm,kuaidicom:"shansongtongcheng"}')
  sign=$(md5hex "${param}${salt}" | tr 'a-f' 'A-F')
  curl -s -o "$KDCB_BODY" -w '%{http_code}' -X POST "$BASE/api/kd/$dno" \
    --data-urlencode "param=$param" --data-urlencode "sign=$sign" --data-urlencode "taskId=$task"
}
dstat() { req GET "/api/admin/local/orders/$1/delivery" "$AT" | jq -r .data.delivery.status; }
# —— 正向剧本：0→100→310→520，Order 联动 PREPARING→SHIPPED→COMPLETED
CBO1=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO1/call" "$AT"); CBD1=$(jq -r .data.deliveryNo <<<"$R")
CBT1=$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
assert_eq "cb 100 http 200" "$(kd_cb "$CBD1" "$CBT1" 100 '骑手已接单' '2026-09-04 12:00:00')" "200"
assert_eq "cb 100 应答 result=true" "$(jq -r .result "$KDCB_BODY")" "true"
assert_eq "100→ACCEPTED" "$(dstat $CBO1)" "ACCEPTED"
R=$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT")
assert_eq "骑手姓名已写" "$(jq -r .data.delivery.courierName <<<"$R")" "王骑手"
assert_eq "订单仍 PREPARING（100 不动订单）" "$(req GET "/api/admin/orders/$CBO1" "$AT" | jq -r .data.status)" "PREPARING"
EVN1=$(jq -r '.data.events | length' <<<"$R")
assert_eq "重复 100（同 updateTime）http 200" "$(kd_cb "$CBD1" "$CBT1" 100 '骑手已接单' '2026-09-04 12:00:00')" "200"
assert_eq "重复回调不新增事件" "$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT" | jq -r '.data.events | length')" "$EVN1"
assert_eq "cb 310 http 200" "$(kd_cb "$CBD1" "$CBT1" 310 '骑手已取货' '2026-09-04 12:05:00')" "200"
assert_eq "310→DELIVERING" "$(dstat $CBO1)" "DELIVERING"
assert_eq "订单 →SHIPPED" "$(req GET "/api/admin/orders/$CBO1" "$AT" | jq -r .data.status)" "SHIPPED"
assert_eq "迟到乱序 210 http 200" "$(kd_cb "$CBD1" "$CBT1" 210 '迟到的赶来取货' '2026-09-04 12:03:00')" "200"
assert_eq "rank 单调：迟到包不回退" "$(dstat $CBO1)" "DELIVERING"
assert_eq "cb 520 http 200" "$(kd_cb "$CBD1" "$CBT1" 520 '已送达' '2026-09-04 12:20:00')" "200"
assert_eq "520→DELIVERED" "$(dstat $CBO1)" "DELIVERED"
assert_eq "订单 →COMPLETED" "$(req GET "/api/admin/orders/$CBO1" "$AT" | jq -r .data.status)" "COMPLETED"
assert_eq "终态释放占位（activeOrderId=null）" "$(req GET "/api/admin/local/orders/$CBO1/delivery" "$AT" | jq -r .data.delivery.activeOrderId)" "null"
# —— 防线：验签失败 / 查不到单 / 未知状态，一律 200 且不动状态
CBO2=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO2/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO2/call" "$AT"); CBD2=$(jq -r .data.deliveryNo <<<"$R")
CBT2=$(req GET "/api/admin/local/orders/$CBO2/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
P=$(jq -cn --arg t "$CBT2" '{taskId:$t,status:"100",statusDesc:"x",updateTime:"2026-09-04 12:00:00"}')
HTTPC=$(curl -s -o "$KDCB_BODY" -w '%{http_code}' -X POST "$BASE/api/kd/$CBD2" --data-urlencode "param=$P" --data-urlencode "sign=DEADBEEF" --data-urlencode "taskId=$CBT2")
assert_eq "错签名 http 200" "$HTTPC" "200"
assert_eq "错签名不动状态" "$(dstat $CBO2)" "CALLING"
assert_eq "查不到单 http 200" "$(kd_cb "D999999-9" "T-NONE" 100 x '2026-09-04 12:00:00' 2>/dev/null || echo 200)" "200"
assert_eq "未知状态 999 http 200" "$(kd_cb "$CBD2" "$CBT2" 999 '外星状态' '2026-09-04 12:01:00')" "200"
assert_eq "未知状态不动状态机" "$(dstat $CBO2)" "CALLING"
# —— 入库失败返 500（N5）：providerStatus 超出 Int 列范围 → 事件落库抛错 → 500 让快递100 重推
assert_eq "入库失败 http 500" "$(kd_cb "$CBD2" "$CBT2" 99999999999999999999 '溢出' '2026-09-04 12:02:00')" "500"
assert_eq "500 应答 result=false" "$(jq -r .result "$KDCB_BODY")" "false"
# —— 并呼假撤单：taskId 不匹配的 720 不得终态化；随后真 100 正常推进
assert_eq "陌生 taskId 的 720 http 200" "$(kd_cb "$CBD2" "OTHER-TASK" 720 '未中标运力撤单' '2026-09-04 12:03:00')" "200"
assert_eq "假撤单不终态化" "$(dstat $CBO2)" "CALLING"
assert_eq "真 100 http 200" "$(kd_cb "$CBD2" "$CBT2" 100 '骑手已接单' '2026-09-04 12:04:00')" "200"
assert_eq "推进 ACCEPTED" "$(dstat $CBO2)" "ACCEPTED"
# —— N8：515 改派后收到 100，允许 rank 回拨、换新骑手
assert_eq "cb 515 http 200" "$(kd_cb "$CBD2" "$CBT2" 515 '骑手改派中' '2026-09-04 12:05:00')" "200"
assert_eq "515→REASSIGNING" "$(dstat $CBO2)" "REASSIGNING"
assert_eq "改派后新 100 http 200" "$(kd_cb "$CBD2" "$CBT2" 100 '新骑手接单' '2026-09-04 12:06:00' '李骑手' '13922223333')" "200"
assert_eq "REASSIGNING→ACCEPTED（rank 回拨特例）" "$(dstat $CBO2)" "ACCEPTED"
assert_eq "换成新骑手" "$(req GET "/api/admin/local/orders/$CBO2/delivery" "$AT" | jq -r .data.delivery.courierName)" "李骑手"
# —— 720 匹配 taskId：终态化 + SHIPPED 回退 PREPARING（三重护栏都通过时）
assert_eq "cb 310 http 200" "$(kd_cb "$CBD2" "$CBT2" 310 '骑手已取货' '2026-09-04 12:07:00')" "200"
assert_eq "订单 →SHIPPED" "$(req GET "/api/admin/orders/$CBO2" "$AT" | jq -r .data.status)" "SHIPPED"
assert_eq "匹配 taskId 的 720 http 200" "$(kd_cb "$CBD2" "$CBT2" 720 '骑手取消订单' '2026-09-04 12:08:00')" "200"
assert_eq "720→CANCELLED" "$(dstat $CBO2)" "CANCELLED"
assert_eq "订单回退 PREPARING" "$(req GET "/api/admin/orders/$CBO2" "$AT" | jq -r .data.status)" "PREPARING"
assert_eq "720 释放占位" "$(req GET "/api/admin/local/orders/$CBO2/delivery" "$AT" | jq -r .data.delivery.activeOrderId)" "null"
# —— UNKNOWN 认领：超时占位单收到回调即认领 taskId 并推进
CBO3=$(mk_local_paid); req POST "/api/admin/local/orders/$CBO3/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$CBO3/call" "$AT"); CBD3=$(jq -r .data.deliveryNo <<<"$R")
assert_eq "占位 UNKNOWN" "$(dstat $CBO3)" "UNKNOWN"
assert_eq "迟到回调认领 http 200" "$(kd_cb "$CBD3" "LATE-TASK-1" 0 '并呼抢单中' '2026-09-04 12:10:00')" "200"
assert_eq "UNKNOWN→CALLING（认领成功）" "$(dstat $CBO3)" "CALLING"
assert_eq "认领写入 taskId" "$(req GET "/api/admin/local/orders/$CBO3/delivery" "$AT" | jq -r .data.delivery.providerTaskId)" "LATE-TASK-1"
```
注意：「查不到单」那条断言里 kd_cb 会因 salt 接口 404 拿到空 salt，签名随之无效——但服务端「查不到单」分支在验签**之前**，仍应 200。若实现顺序写反（先验签后查单），这条会失败——这是故意的顺序断言。
Run RED：第 27 段全部 `✘`（路由 404，`%{http_code}` 为 404）。

- [ ] **Step 2: 实现 callback.ts**

```ts
/**
 * 快递100 状态回调处理。应答语义与微信支付相反（决策 N5）：
 * 快递100 没有查单接口，回调是唯一事实来源——仅「数据库入库异常」返 500 让对方重推；
 * 查不到单/验签失败/重复/乱序/未知状态一律 200 停止重推，问题走告警人工兜底。
 * 处理顺序（勿调换）：查单 → 验签 → 并呼假撤单过滤 → 单事务[事件+推进+订单联动] → 事务后通知。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { getDeliveryProvider } from './provider'
import { PROVIDER_STATUS_MAP, TERMINAL } from './state'
import { recordDeliveryEvent, makeCallbackDedupeKey, trunc } from './events'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'
import { sendDeliverSubscribeMessage } from '../subscribe-message'
import { ACTIVE_REFUND_STATUSES } from '../refund'

export async function handleKdCallback(deliveryNo: string, body: Record<string, string>): Promise<{ http: 200 | 500 }> {
  const rawBody = JSON.stringify(body)
  const delivery = await prisma.delivery.findUnique({
    where: { deliveryNo },
    include: { order: { include: {
      user: { select: { openid: true } },
      items: { select: { productName: true }, take: 1 },
      refunds: { select: { status: true } },
      afterSales: { where: { status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true } },
    } } },
  })
  if (!delivery) {
    notifySystemAlert('快递100 回调查不到配送单', [`deliveryNo=${deliveryNo}`, '若此前有下单超时，可能是占位落库失败的孤儿单，请到快递100 后台核对'], { key: `kd-cb-miss:${deliveryNo}` })
    return { http: 200 }
  }
  const parsed = getDeliveryProvider().verifyAndParseCallback(body, delivery.callbackSalt)
  if (!parsed.ok) {
    try {
      await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, 'BAD', null, rawBody), source: 'CALLBACK', statusDesc: parsed.reason === 'SIGN_MISMATCH' ? '回调验签失败' : '回调格式异常', rawPayload: body })
    } catch { /* 留痕失败不升级：这不是业务事件丢失 */ }
    notifySystemAlert('快递100 回调验签失败', [`deliveryNo=${deliveryNo}`], { key: `kd-cb-sign:${deliveryNo}` })
    return { http: 200 }
  }
  const p = parsed.payload
  // 并呼假撤单过滤：多运力并呼时未中标运力也推 720；已锁定 taskId 且不匹配 → 不得终态化
  if (p.providerStatus === '720' && delivery.providerTaskId && p.taskId && p.taskId !== delivery.providerTaskId) {
    try {
      await recordDeliveryEvent(prisma, { deliveryId: delivery.id, dedupeKey: makeCallbackDedupeKey(deliveryNo, `720@${p.taskId}`, null, rawBody), source: 'CALLBACK', providerStatus: 720, statusDesc: `未中标运力撤单（taskId=${p.taskId}），忽略`, rawPayload: body })
    } catch { /* 同上 */ }
    if (delivery.statusRank < 20) notifySystemAlert('快递100 呼叫阶段收到 taskId 不匹配的 720', [`deliveryNo=${deliveryNo}`, `锁定=${delivery.providerTaskId} 回调=${p.taskId}`, '真实联调时请核实并呼语义（spec §5.4）'], { key: `kd-cb-720x:${deliveryNo}` })
    return { http: 200 }
  }
  const mapped = PROVIDER_STATUS_MAP[p.providerStatus]
  const updateTimeIso = p.providerUpdateTime ? p.providerUpdateTime.toISOString() : null
  const dedupeKey = makeCallbackDedupeKey(deliveryNo, p.providerStatus, updateTimeIso, rawBody)
  const n = Number(p.providerStatus)
  const providerStatusNum = Number.isFinite(n) ? n : null
  const after: (() => void)[] = []   // 事务后才发的通知（事务里发会在回滚时误报）
  try {
    await prisma.$transaction(async (tx) => {
      const ev = await recordDeliveryEvent(tx, { deliveryId: delivery.id, dedupeKey, source: 'CALLBACK', providerStatus: providerStatusNum, statusDesc: p.statusDesc, courierName: p.courierName, courierMobile: p.courierMobile, providerUpdateTime: updateTimeIso, rawPayload: body })
      if (ev.duplicate) return
      await tx.delivery.updateMany({ where: { id: delivery.id }, data: { lastCallbackAt: new Date() } })
      // UNKNOWN 认领：下单超时的占位单，第一个到达的回调即认领 taskId（ghost 消解，spec §5.4）
      if (delivery.status === 'UNKNOWN' && !delivery.providerTaskId && p.taskId) {
        await tx.delivery.updateMany({ where: { id: delivery.id, providerTaskId: null }, data: { providerTaskId: p.taskId } })
      }
      if (!mapped) {
        after.push(() => notifySystemAlert('快递100 未知回调状态', [`deliveryNo=${deliveryNo} status=${p.providerStatus}`, p.statusDesc ?? ''], { key: `kd-cb-unknown:${p.providerStatus}` }))
        return
      }
      const courierData = {
        ...(p.courierCompany ? { courierCompany: p.courierCompany } : {}),
        ...(p.courierName ? { courierName: p.courierName } : {}),
        ...(p.courierMobile ? { courierMobile: p.courierMobile } : {}),
        ...(p.statusDesc ? { statusDesc: p.statusDesc } : {}),
        ...(providerStatusNum !== null ? { providerStatus: providerStatusNum } : {}),
      }
      let moved = 0
      if (mapped.type === 'rank') {
        const r = await tx.delivery.updateMany({
          where: { id: delivery.id, statusRank: { lt: mapped.rank }, status: { notIn: [...TERMINAL] } },
          data: { status: mapped.status, statusRank: mapped.rank, ...(mapped.rank === 100 ? { activeOrderId: null } : {}), ...(mapped.stamp ? { [mapped.stamp]: new Date() } : {}), ...courierData },
        })
        moved = r.count
        // N8：改派中收到 100 允许 rank 回拨到 ACCEPTED（新骑手接单）。720 回退之外唯一的第二个回拨。
        if (moved === 0 && p.providerStatus === '100') {
          const r2 = await tx.delivery.updateMany({ where: { id: delivery.id, status: 'REASSIGNING' }, data: { status: 'ACCEPTED', statusRank: 20, acceptedAt: new Date(), ...courierData } })
          moved = r2.count
        }
      } else if (mapped.status === 'CANCELLED') {
        const r = await tx.delivery.updateMany({ where: { id: delivery.id, status: { notIn: [...TERMINAL] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelReason: trunc(p.statusDesc, 255) ?? '运力方取消', ...courierData } })
        moved = r.count
      } else {   // REASSIGNING / ABNORMAL：旁路态不写 rank、不释放
        const r = await tx.delivery.updateMany({ where: { id: delivery.id, status: { notIn: [...TERMINAL] } }, data: { status: mapped.status, ...courierData } })
        moved = r.count
      }
      if (moved === 0) return   // 乱序迟到包：事件已留痕，不动状态、不联动订单
      // —— Order 联动（一律 LOCAL + 白名单 updateMany）——
      if (p.providerStatus === '310') {
        await tx.order.updateMany({ where: { id: delivery.orderId, deliveryType: 'LOCAL', status: 'PREPARING' }, data: { status: 'SHIPPED' } })
        const o = delivery.order
        after.push(() => sendDeliverSubscribeMessage(o.user.openid, { id: o.id, orderNo: o.orderNo }, { courierName: p.courierName ?? delivery.courierName, courierMobile: p.courierMobile ?? delivery.courierMobile }, o.items[0]?.productName))
      } else if (p.providerStatus === '520') {
        await tx.order.updateMany({ where: { id: delivery.orderId, deliveryType: 'LOCAL', status: { in: ['PREPARING', 'SHIPPED'] } }, data: { status: 'COMPLETED', completedAt: new Date() } })
      } else if (p.providerStatus === '720') {
        // 取货后被取消：SHIPPED 回退 PREPARING。三重护栏：无在途退款、无待处理售后、未完成
        const o = delivery.order
        // 与主动取消共用同一个实现（orchestrator.rollbackOrderAfterCancel），护栏只写一处
        await rollbackOrderAfterCancel(tx, delivery.orderId)
        after.push(() => notifyLocalDeliveryAlert('配送单被取消', [`订单 ${delivery.orderNo}`, p.statusDesc ?? '运力方取消', '请重新呼叫骑手或改自己送']))
      }
      if (p.providerStatus === '510') after.push(() => notifyLocalDeliveryAlert('配送异常', [`订单 ${delivery.orderNo}`, p.statusDesc ?? '', '请联系骑手/顾客确认']))
      if (p.providerStatus === '515') after.push(() => notifyLocalDeliveryAlert('骑手改派中', [`订单 ${delivery.orderNo}`, '平台正在重新分配骑手']))
    })
  } catch (e) {
    // 这里**不能**再对 P2002 返 200：dedupeKey 的重复已由 recordDeliveryEvent 自己吃掉并返回
    // {duplicate:true}，永远不会抛到这层。能抛到这层的 P2002 只可能是 UNKNOWN 认领时
    // providerTaskId 撞了另一条配送单的唯一索引——那正是最需要人知道的情形，
    // 返 200 会让事实永久丢失（无查单接口，回调是唯一事实来源）。
    console.error('[kd-callback] 入库失败:', e)
    notifySystemAlert('快递100 回调入库失败', [`deliveryNo=${deliveryNo} status=${p.providerStatus}`, (e as Error).message, '已返回 500 请求重推；若持续失败请人工核对配送单'], { key: `kd-cb-persist:${deliveryNo}` })
    return { http: 500 }   // N5：唯一返 500 的情形——让快递100 重推，这是无查单接口下仅有的补偿
  }
  for (const fn of after) { try { fn() } catch (e) { console.warn('[kd-callback] 通知失败:', (e as Error).message) } }
  return { http: 200 }
}
```

- [ ] **Step 3: 路由 + 挂载 + 订阅消息**

`routes/kd-callback.ts`：
```ts
/** 快递100 状态回调。公开路由（安全性来自 per-单 salt 验签），body 为 x-www-form-urlencoded */
import express, { Router, Request, Response } from 'express'
import { handleKdCallback } from '../services/delivery/callback'

const router = Router()
router.post('/:deliveryNo', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  let http: 200 | 500 = 200
  try {
    http = (await handleKdCallback(String(req.params.deliveryNo), (req.body ?? {}) as Record<string, string>)).http
  } catch (e) {
    console.error('[kd-callback] 未捕获异常:', e)
    http = 500
  }
  if (http === 200) res.json({ result: true, returnCode: '200', message: '成功' })
  else res.status(500).json({ result: false, returnCode: '500', message: '服务器异常，请重推' })
})
export default router
```
`app.ts`：微信支付回调挂载行旁边加 `app.use('/api/kd', kdCallbackRouter)`（在鉴权中间件之前的公开区）。
`subscribe-message.ts` 追加：
```ts
/** 配送通知（快递100 回调 310：骑手已取货出发）。模板字段见 .env WECHAT_TMPL_DELIVER_FIELDS */
export function sendDeliverSubscribeMessage(
  openid: string,
  order: { id: number; orderNo: string },
  courier: { courierName?: string | null; courierMobile?: string | null },
  productName?: string
): void {
  const { deliverTemplateId, deliverFields } = config.subscribe
  if (!deliverTemplateId || !deliverFields) return
  const data = buildData(
    {
      orderNo: order.orderNo,
      productName: productName ?? '',
      courierName: courier.courierName || '配送员',
      courierMobile: courier.courierMobile ?? '',
      // 骑手出发后的粗略预估；真实 ETA 运力方不给，宁可写宽不写窄
      estimatedTime: fmtTime(new Date(Date.now() + 30 * 60 * 1000)),
    },
    parseFieldMap(deliverFields)
  )
  if (!data) return
  void send(openid, deliverTemplateId, `pages/order/detail?id=${order.id}`, data, '配送通知')
}
```
`getSubscribeTemplateIds` 数组加 `config.subscribe.deliverTemplateId`。

- [ ] **Step 4: GREEN + 提交**

`cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 27 段全 `✔`。
```bash
git add apps/server/src/services/delivery/callback.ts apps/server/src/routes/kd-callback.ts apps/server/src/app.ts apps/server/src/config.ts apps/server/src/services/subscribe-message.ts scripts/e2e.sh
git commit -m "feat(delivery): 快递100 回调状态机——幂等/乱序/假撤单/UNKNOWN 认领/订单联动 + 配送订阅消息

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 配送单操作全集 + 资金联动（42221）+ 顾客端可见性

**Files:**
- Modify: `apps/server/src/services/delivery/orchestrator.ts`（追加 precancel/cancel/addTip/selfDeliver/markDelivered）
- Modify: `apps/server/src/services/delivery/mock.ts`（MockDirective 的 error code 联合类型追加 `'50000'`，映射 BUSINESS）
- Modify: `apps/server/src/routes/admin/delivery.ts`（追加 5 个操作端点）
- Modify: `apps/server/src/routes/admin/settings.ts`（`POST /local-delivery/probe`）
- Modify: `apps/server/src/services/refund.ts`（42221 拦截）
- Modify: `apps/server/src/routes/orders.ts`（顾客单详情 delivery 白名单、`GET /:id/courier`、cancel-request 快照真实配送状态）
- Test: `scripts/e2e.sh` 新增「== 28. 配送单操作与资金联动 ==」

**Interfaces:**
- Consumes: T4/T5 全部；`local-settings` 的 `tip.maxPerCall/maxPerOrder`。
- Produces（orchestrator）:
  - `export async function precancelDelivery(orderId: number): Promise<{ cancelFeeFen: number | null }>`（无在途单→42233；UNKNOWN→42234；无 taskId→42234『尚未成单』）
  - `export async function cancelDelivery(input: { orderId: number; operator: string; reason?: string }): Promise<{ cancelFeeFen: number | null }>`（42233/42234 同上；外呼 TIMEOUT→42238 状态不动；BUSINESS→42225『取消配送单失败：原文』；成功→事务 [updateMany 非终态→CANCELLED+释放+cancelFee, count0→42237；event(ADMIN)；SHIPPED 回退 PREPARING 三重护栏同回调 720]）
  - `export async function addTip(input: { orderId: number; amountFen: number; operator: string }): Promise<{ tipFeeFen: number }>`（在途单非 CALLING→42235；`amountFen > settings.tip.maxPerCall`→42235『单次上限』；`tipFee + amountFen > settings.tip.maxPerOrder`→42235『累计上限』；BUSINESS→42236；TIMEOUT→42236『请求超时，请稍后核对』；成功→update tipFee 累加 + event，返累加后值）
  - `export async function selfDeliver(input: { orderId: number; name: string; phone: string; operator: string }): Promise<{ deliveryId: number; deliveryNo: string }>`（订单须 LOCAL+PREPARING→42204；已有在途单：UNKNOWN→42234、其它→42228『请先取消在途配送单』；事务内 create Delivery{provider:'SELF', status:'DELIVERING', statusRank:50, calledAt/pickedUpAt=now, courierName/courierMobile, activeOrderId} catch P2002→42228 + order updateMany PREPARING→SHIPPED（count0→42204 抛出让事务回滚）+ event(ADMIN)）
  - `export async function markDelivered(input: { orderId: number; operator: string }): Promise<void>`（无在途单→42233；UNKNOWN→42234；事务 [updateMany 非终态→DELIVERED rank100 + 释放 + deliveredAt, count0→42237；order updateMany {in:[PREPARING,SHIPPED]}→COMPLETED；event(ADMIN)]）
- 路由：`POST /admin/local/orders/:id/delivery/precancel`、`/delivery/cancel {reason?}`、`/delivery/tip {amount}`（zod int 1..100000）、`/self-deliver {name(1..32), phone(5..20)}`、`/delivered`。
- `POST /admin/settings/local-delivery/probe {latE6, lngE6}` → `getDeliveryProvider().price(...)`（sender=门店、receiver=探测点、goods 500g/¥20/1件）→ `{feeFen, distanceM}`；门店无坐标→42226。
- 顾客端 `GET /api/orders/:id`：`deliveryType==='LOCAL'` 时附 `delivery`（最近一张：`findFirst({where:{orderId}, orderBy:{id:'desc'}})` 的**白名单**序列化：`{ status, statusLabel(查 DELIVERY_STATUS_LABEL), courierName, courierMobile, courierCompany, pickedUpAt, deliveredAt }`——绝不含 callbackSalt/quotedFee/actualFee/taskId）。
- 顾客端 `GET /api/orders/:id/courier`：本人订单；在途单且 status∈{ACCEPTED,ARRIVING,ARRIVED,DELIVERING} 且有 taskId → `provider.queryCourier`，模块级 Map 按 deliveryId 缓存 20 秒；否则/查无 → `{ location: null }`。
- `POST /api/orders/:id/cancel-request`：`cancelRequestDeliveryStatus: 'NONE'` 改为快照 `(await prisma.delivery.findFirst({ where: { activeOrderId: id } }))?.status ?? 'NONE'`。

- [ ] **Step 1: e2e（RED）**

第 27 段之后插入：
```bash
echo "== 28. 配送单操作与资金联动 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
OPO1=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO1/call" "$AT"); OPD1=$(jq -r .data.deliveryNo <<<"$R")
OPT1=$(req GET "/api/admin/local/orders/$OPO1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
# —— 加小费（CALLING 才能加；上限来自设置 tip.maxPerCall=2000/maxPerOrder=5000）
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/tip" "$AT" '{"amount":500}'); assert_eq "加小费 code 0" "$(code "$R")" "0"
assert_eq "tipFee 累加 500" "$(jq -r .data.tipFeeFen <<<"$R")" "500"
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/tip" "$AT" '{"amount":2100}'); assert_eq "超单次上限 42235" "$(code "$R")" "42235"
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"addTip","directive":{"kind":"error","code":"50000"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/tip" "$AT" '{"amount":500}'); assert_eq "运力拒绝加小费 42236" "$(code "$R")" "42236"
# —— 42221：有在途配送单不准退款（admin 退款入口 amount 必填，取整单金额）
OPAMT=$(req GET "/api/admin/orders/$OPO1" "$AT" | jq -r .data.actualAmount)
R=$(req POST "/api/admin/orders/$OPO1/refund" "$AT" "{\"amount\":$OPAMT,\"reason\":\"e2e 测 42221\"}")
assert_eq "在途配送单挡退款 42221" "$(code "$R")" "42221"
# —— 预估取消费 + 取消：CALLING 阶段取消，订单留在 PREPARING 可重呼
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/precancel" "$AT"); assert_eq "precancel code 0" "$(code "$R")" "0"
assert_eq "预估取消费 200" "$(jq -r .data.cancelFeeFen <<<"$R")" "200"
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/cancel" "$AT" '{"reason":"e2e 取消"}'); assert_eq "取消 code 0" "$(code "$R")" "0"
assert_eq "取消后 CANCELLED" "$(dstat $OPO1)" "CANCELLED"
assert_eq "订单留在 PREPARING" "$(req GET "/api/admin/orders/$OPO1" "$AT" | jq -r .data.status)" "PREPARING"
R=$(req POST "/api/admin/local/orders/$OPO1/delivery/cancel" "$AT"); assert_eq "无在途单再取消 42233" "$(code "$R")" "42233"
# 取消后退款可通过（资金联动闭环）
R=$(req POST "/api/admin/orders/$OPO1/refund" "$AT" "{\"amount\":$OPAMT,\"reason\":\"e2e 拒后退款\"}"); assert_eq "取消配送后退款 code 0" "$(code "$R")" "0"
assert_eq "订单 → REFUNDED" "$(req GET "/api/admin/orders/$OPO1" "$AT" | jq -r .data.status)" "REFUNDED"
# —— 取消超时（42238）：状态必须原地不动
OPO2=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO2/accept" "$AT" >/dev/null
req POST "/api/admin/local/orders/$OPO2/call" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"cancelOrder","directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO2/delivery/cancel" "$AT"); assert_eq "取消超时 42238" "$(code "$R")" "42238"
assert_eq "超时后仍 CALLING（未误终态化）" "$(dstat $OPO2)" "CALLING"
req POST "/api/admin/local/orders/$OPO2/delivery/cancel" "$AT" >/dev/null   # 清场：真取消
# —— 自己送 + 标记送达
OPO3=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO3/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO3/self-deliver" "$AT" '{"name":"阿福","phone":"15309003232"}')
assert_eq "自己送 code 0" "$(code "$R")" "0"
assert_eq "订单 →SHIPPED" "$(req GET "/api/admin/orders/$OPO3" "$AT" | jq -r .data.status)" "SHIPPED"
R=$(req GET "/api/admin/local/orders/$OPO3/delivery" "$AT")
assert_eq "SELF 配送单 DELIVERING" "$(jq -r .data.delivery.status <<<"$R")" "DELIVERING"
assert_eq "provider=SELF" "$(jq -r .data.delivery.provider <<<"$R")" "SELF"
R=$(req POST "/api/admin/local/orders/$OPO3/delivered" "$AT"); assert_eq "标记送达 code 0" "$(code "$R")" "0"
assert_eq "订单 →COMPLETED" "$(req GET "/api/admin/orders/$OPO3" "$AT" | jq -r .data.status)" "COMPLETED"
assert_eq "配送单 →DELIVERED" "$(dstat $OPO3)" "DELIVERED"
R=$(req POST "/api/admin/local/orders/$OPO3/delivered" "$AT"); assert_eq "重复标记送达 42233" "$(code "$R")" "42233"
# 有在途单时不准自己送
OPO4=$(mk_local_paid); req POST "/api/admin/local/orders/$OPO4/accept" "$AT" >/dev/null
req POST "/api/admin/local/orders/$OPO4/call" "$AT" >/dev/null
R=$(req POST "/api/admin/local/orders/$OPO4/self-deliver" "$AT" '{"name":"阿福","phone":"15309003232"}')
assert_eq "在途单挡自己送 42228" "$(code "$R")" "42228"
# —— 顾客端可见性：白名单字段 + 位置接口 + 取消申请快照
OPT4=$(req GET "/api/admin/local/orders/$OPO4/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
OPD4=$(req GET "/api/admin/local/orders/$OPO4/delivery" "$AT" | jq -r .data.delivery.deliveryNo)
kd_cb "$OPD4" "$OPT4" 100 '骑手已接单' '2026-09-04 13:00:00' '赵骑手' '13933334444' >/dev/null
R=$(req GET "/api/orders/$OPO4" "$UT")
assert_eq "顾客可见骑手姓名" "$(jq -r .data.delivery.courierName <<<"$R")" "赵骑手"
assert_eq "顾客可见状态标签" "$(jq -r .data.delivery.statusLabel <<<"$R")" "骑手已接单"
assert_eq "salt 不外泄" "$(jq -r '.data.delivery | has("callbackSalt")' <<<"$R")" "false"
assert_eq "费用不外泄" "$(jq -r '.data.delivery | has("quotedFee")' <<<"$R")" "false"
R=$(req GET "/api/orders/$OPO4/courier" "$UT"); assert_eq "位置接口 code 0" "$(code "$R")" "0"
assert_eq "mock 无位置 → null" "$(jq -r .data.location <<<"$R")" "null"
R=$(req POST "/api/orders/$OPO4/cancel-request" "$UT" '{"note":"e2e 快照"}'); assert_eq "取消申请 code 0" "$(code "$R")" "0"
assert_eq "快照真实配送状态" "$(req GET "/api/admin/orders/$OPO4" "$AT" | jq -r .data.cancelRequestDeliveryStatus)" "ACCEPTED"
req POST "/api/admin/local/orders/$OPO4/delivery/cancel" "$AT" >/dev/null   # 清场
# —— 探测接口（门店坐标已在第 21 段设置）
R=$(req POST /api/admin/settings/local-delivery/probe "$AT" '{"latE6":29350000,"lngE6":104790000}')
assert_eq "探测 code 0" "$(code "$R")" "0"
assert_eq "mock 报价 500" "$(jq -r .data.feeFen <<<"$R")" "500"
```
（`kd_cb`/`dstat`/`mk_local_paid` 为第 26/27 段定义的函数。）Run RED。

- [ ] **Step 2: 实现 orchestrator 五操作**

完整代码（追加到 orchestrator.ts；`rollbackOrderAfterCancel` 为本文件私有 helper）：
```ts
import { ACTIVE_REFUND_STATUSES } from '../refund'
import { getLocalSettings } from '../local-settings'   // 已在文件头 import，勿重复

async function requireActive(orderId: number) {
  const d = await getActiveDelivery(orderId)
  if (!d) throw new AppError(42233, '无在途配送单')
  if (d.status === 'UNKNOWN') throw new AppError(42234, '配送单状态未确认：请等回调认领，或确认快递100 后台无单后作废')
  return d
}
/**
 * 骑手已取货后取消 → SHIPPED 回退 PREPARING。**720 回调与主动取消共用这一个实现**
 * （callback.ts 里 720 分支直接调它，不许各写一份——两份护栏迟早会drift）。
 * 三重护栏全部写进 where：先读后写会在读与写之间放进一笔部分退款（部分退款不改订单状态，
 * 因此 status 白名单挡不住它），那正是护栏要防的事。
 */
export async function rollbackOrderAfterCancel(tx: Prisma.TransactionClient, orderId: number) {
  await tx.order.updateMany({ where: {
    id: orderId, deliveryType: 'LOCAL', status: 'SHIPPED', completedAt: null,
    refunds: { none: { status: { in: [...ACTIVE_REFUND_STATUSES] } } },
    afterSales: { none: { status: { in: ['PENDING', 'APPROVED'] } } },
  }, data: { status: 'PREPARING' } })
}

export async function precancelDelivery(orderId: number): Promise<{ cancelFeeFen: number | null }> {
  const d = await requireActive(orderId)
  if (!d.providerTaskId) throw new AppError(42234, '配送单尚未成单，无法预估取消费')
  return { cancelFeeFen: (await getDeliveryProvider().precancelOrder({ taskId: d.providerTaskId })).cancelFeeFen }
}

export async function cancelDelivery(input: { orderId: number; operator: string; reason?: string }): Promise<{ cancelFeeFen: number | null }> {
  const d = await requireActive(input.orderId)
  let cancelFeeFen: number | null = 0
  if (d.provider !== 'SELF' && d.providerTaskId) {
    try {
      cancelFeeFen = (await getDeliveryProvider().cancelOrder({ taskId: d.providerTaskId, reason: input.reason ?? '商家取消' })).cancelFeeFen
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42238, '取消请求超时，请稍后重试（状态未变化）')
      if (e instanceof ProviderError) throw new AppError(42225, `取消配送单失败：${e.message}`)
      throw e
    }
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.delivery.updateMany({ where: { id: d.id, status: { notIn: [...TERMINAL] } }, data: { status: 'CANCELLED', activeOrderId: null, cancelledAt: new Date(), cancelReason: trunc(input.reason, 255) ?? '商家取消', cancelFee: cancelFeeFen ?? 0 } })
    if (moved.count === 0) throw new AppError(42237, '配送单状态已变化，请刷新')
    await rollbackOrderAfterCancel(tx, input.orderId)
    await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: `商家取消（取消费 ${((cancelFeeFen ?? 0) / 100).toFixed(2)} 元）`, operator: input.operator })
  })
  return { cancelFeeFen }
}

export async function addTip(input: { orderId: number; amountFen: number; operator: string }): Promise<{ tipFeeFen: number }> {
  const d = await requireActive(input.orderId)
  if (d.status !== 'CALLING') throw new AppError(42235, '仅待抢单状态可加小费')
  const s = await getLocalSettings()
  if (input.amountFen > s.tip.maxPerCall) throw new AppError(42235, `单次小费上限 ¥${(s.tip.maxPerCall / 100).toFixed(0)}`)
  // 这里只是给操作员一个即时的说法；真正的封顶靠下面写入时的原子条件（读到的 tipFee 可能已过期）
  if (d.tipFee + input.amountFen > s.tip.maxPerOrder) throw new AppError(42235, `本单小费累计上限 ¥${(s.tip.maxPerOrder / 100).toFixed(0)}，已加 ¥${(d.tipFee / 100).toFixed(2)}`)
  if (!d.providerTaskId) throw new AppError(42234, '配送单尚未成单')
  try {
    await getDeliveryProvider().addTip({ taskId: d.providerTaskId, amountFen: input.amountFen })
  } catch (e) {
    if (e instanceof ProviderError && e.kind === 'TIMEOUT') throw new AppError(42236, '加小费请求超时，请稍后在配送明细里核对是否生效')
    if (e instanceof ProviderError) throw new AppError(42236, `加小费被运力拒绝：${e.message}`)
    throw e
  }
  const updated = await prisma.$transaction(async (tx) => {
    // 原子封顶：并发两笔小费各自读到旧 tipFee 都会通过上面的预检，只有条件写能真的拦住越顶；
    // 同时把 status 一并作为条件——外呼期间配送单可能已经不在 CALLING 了。
    const moved = await tx.delivery.updateMany({
      where: { id: d.id, status: 'CALLING', tipFee: { lte: s.tip.maxPerOrder - input.amountFen } },
      data: { tipFee: { increment: input.amountFen } },
    })
    if (moved.count === 0) {
      // 钱已经真的加到运力方了，本地却没记上。照 callRider 落库失败的先例发告警：
      // 不告警的话这笔支出既不在配送单上、也不在事件流里，对账时无从查起，
      // 而操作员看到的只是「请刷新重试」，很可能再加一次 = 再花一次钱。
      notifySystemAlert('加小费已扣费但未记账', [
        `配送单 ${d.deliveryNo}（订单 ${d.orderNo}）`,
        `本次 ¥${(input.amountFen / 100).toFixed(2)} 已提交运力方，但本地写入未命中（已达累计上限或配送单已离开待抢单状态）`,
        '请到快递100 后台核对实际扣费，勿直接重试',
      ], { key: `dlv-tip-lost:${d.id}` })
      throw new AppError(42235, '小费已达上限或配送单状态已变化。本次加价可能已在运力方生效，请先刷新核对再决定是否重试')
    }
    const r = await tx.delivery.findUniqueOrThrow({ where: { id: d.id }, select: { tipFee: true } })
    await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: `加小费 ¥${(input.amountFen / 100).toFixed(2)}（累计 ¥${(r.tipFee / 100).toFixed(2)}）`, operator: input.operator })
    return r
  })
  return { tipFeeFen: updated.tipFee }
}

export async function selfDeliver(input: { orderId: number; name: string; phone: string; operator: string }): Promise<{ deliveryId: number; deliveryNo: string }> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId } })
  if (!order) throw new AppError(40401, '订单不存在', 404)
  if (order.deliveryType !== 'LOCAL') throw new AppError(42204, '仅同城订单')
  if (order.status !== 'PREPARING') throw new AppError(42204, `订单状态为 ${order.status}，仅备餐中订单可自己送`)
  const existing = await getActiveDelivery(input.orderId)
  if (existing) {
    if (existing.status === 'UNKNOWN') throw new AppError(42234, '有状态未确认的配送单，请先作废')
    throw new AppError(42228, '已有在途配送单，请先取消再改自己送')
  }
  const seq = (await prisma.delivery.count({ where: { orderId: input.orderId } })) + 1
  const deliveryNo = `D${input.orderId}-${seq}`
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date()
      const d = await tx.delivery.create({ data: {
        orderId: input.orderId, orderNo: order.orderNo, deliveryNo, activeOrderId: input.orderId,
        provider: 'SELF', status: 'DELIVERING', statusRank: 50,
        callbackSalt: crypto.randomBytes(8).toString('hex'),
        courierName: trunc(input.name, 64), courierMobile: trunc(input.phone, 20),
        calledAt: now, acceptedAt: now, pickedUpAt: now, operator: trunc(input.operator, 64),
      } })
      // 注意：Order 没有 shippedAt 列（发货时间只存在于 Shipment，而 LOCAL 单永不写 Shipment）。
      // 同城单的「出发时间」以 Delivery.pickedUpAt 为准。
      const moved = await tx.order.updateMany({ where: { id: input.orderId, deliveryType: 'LOCAL', status: 'PREPARING' }, data: { status: 'SHIPPED' } })
      if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
      await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: `店内自送：${input.name} ${input.phone}`, operator: input.operator })
      return { deliveryId: d.id, deliveryNo }
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new AppError(42228, '已有在途配送单')
    throw e
  }
}

export async function markDelivered(input: { orderId: number; operator: string }): Promise<void> {
  const d = await requireActive(input.orderId)
  await prisma.$transaction(async (tx) => {
    const moved = await tx.delivery.updateMany({ where: { id: d.id, status: { notIn: [...TERMINAL] } }, data: { status: 'DELIVERED', statusRank: 100, activeOrderId: null, deliveredAt: new Date() } })
    if (moved.count === 0) throw new AppError(42237, '配送单状态已变化，请刷新')
    await tx.order.updateMany({ where: { id: input.orderId, deliveryType: 'LOCAL', status: { in: ['PREPARING', 'SHIPPED'] } }, data: { status: 'COMPLETED', completedAt: new Date() } })
    await recordDeliveryEvent(tx, { deliveryId: d.id, dedupeKey: adminEventKey(), source: 'ADMIN', statusDesc: '店员标记已送达', operator: input.operator })
  })
}
```

- [ ] **Step 3: 路由、refund 42221、顾客端**

`routes/admin/delivery.ts` 追加 5 端点（zod：tip `{amount: z.number().int().min(1).max(100000)}`；self-deliver `{name: z.string().trim().min(1).max(32), phone: z.string().trim().min(5).max(20)}`），全部 `operator: req.adminUsername ?? 'admin'`。
`routes/admin/settings.ts` probe：
```ts
router.post('/local-delivery/probe', async (req, res, next) => {
  try {
    const { latE6, lngE6 } = locationSchema.parse(req.body)
    const s = await getLocalSettings()
    if (s.store.latE6 === null || s.store.lngE6 === null) throw new AppError(42226, '门店尚未设置坐标')
    const r = await getDeliveryProvider().price({
      deliveryNo: 'probe', callbackUrl: '', callbackSalt: '',
      sender: { name: s.store.name, mobile: s.store.phone, province: s.store.province, city: s.store.city, district: s.store.district, address: s.store.address, latE6: s.store.latE6, lngE6: s.store.lngE6 },
      receiver: { name: '探测', mobile: '13800000000', province: s.store.province, city: s.store.city, district: s.store.district, address: '探测点', latE6, lngE6 },
      goods: { title: '凉菜', weightKg: 0.5, totalPriceFen: 2000, count: 1 }, remark: '',
    })
    res.json({ code: 0, message: 'ok', data: { feeFen: r.feeFen, distanceM: r.distanceM } })
  } catch (e) { next(e) }
})
```
`refund.ts`：`42205 已有退款处理中` 检查之后、`42207 支付记录` 检查之前插入：
```ts
  // 42221：同城单有在途配送单先取消配送再退款（骑手在路上把钱退了 = 白送一单）。
  // 一处拦截覆盖全部 4 个 initiateRefund 调用点（admin 退款/顾客取消/售后同意/拒单）。
  if (order.deliveryType === 'LOCAL' && !['COMPLETED', 'REFUNDED'].includes(order.status)) {
    const activeDelivery = await prisma.delivery.findFirst({ where: { activeOrderId: orderId }, select: { status: true } })
    if (activeDelivery) {
      throw new AppError(42221, `该订单有在途配送单（${DELIVERY_STATUS_LABEL[activeDelivery.status] ?? activeDelivery.status}），请先取消配送再退款`)
    }
  }
```
（顶部 `import { DELIVERY_STATUS_LABEL } from './delivery/state'`。）
`routes/orders.ts`：
- 详情响应：LOCAL 单查最近一张 delivery，白名单序列化进 `data.delivery`（无则 null）。
- `GET /:id/courier`（注册在 `GET /:id` 之前防吞）：本人校验照抄详情路由；20 秒缓存 `const courierCache = new Map<number, { at: number; loc: { latE6: number; lngE6: number } | null }>()`。
- cancel-request 快照替换 `'NONE'`。

- [ ] **Step 4: GREEN + 提交**

`cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 28 段全 `✔`；连带核对第 10 段退款既有断言未受 42221 影响（EXPRESS 单不受拦截）。
```bash
git add apps/server/src/services/delivery apps/server/src/routes/admin/{delivery,settings}.ts apps/server/src/services/refund.ts apps/server/src/routes/orders.ts scripts/e2e.sh
git commit -m "feat(delivery): 取消/加小费/自己送/标记送达 + 退款42221联动 + 顾客端白名单与骑手位置

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: 拒单（两渠道通用）

**Files:**
- Modify: `apps/server/src/routes/admin/orders.ts`（`POST /:id/reject`）
- Test: `scripts/e2e.sh` 新增「== 29. 拒单 ==」

**Interfaces:**
- Consumes: `initiateRefund`（T6 已内置 42221 拦截）、`rollbackOrderStock(tx, order.items)`、`notifySystemAlert`。
- Produces: `POST /api/admin/orders/:id/reject { reason: 'SOLD_OUT'|'OUT_OF_RANGE'|'PAST_ACCEPT_TIME'|'CUSTOMER_CANCEL'|'OTHER', note?: string(≤40), soldOutProductIds?: number[] }` → `{ orderId, refund|null, offShelfCount, cancelReason }`。决策 N3/N4：两渠道通用；已付款单终态 REFUNDED（走 initiateRefund 全额），PENDING_PAYMENT 单走取消；`cancelReason='商家拒单：'+文案` 顾客可见。

- [ ] **Step 1: e2e（RED）**

第 28 段之后插入：
```bash
echo "== 29. 拒单 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
# —— 参数校验
RJ1=$(mk_local_paid); req POST "/api/admin/local/orders/$RJ1/accept" "$AT" >/dev/null
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"OTHER"}'); assert_eq "其他原因不填说明 40001" "$(code "$R")" "40001"
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"SOLD_OUT"}'); assert_eq "售罄不勾菜 40001" "$(code "$R")" "40001"
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" "{\"reason\":\"SOLD_OUT\",\"soldOutProductIds\":[999999]}")
assert_eq "勾选非本单商品 40001" "$(code "$R")" "40001"
# —— 42221：在途配送单先拦
req POST "/api/admin/local/orders/$RJ1/call" "$AT" >/dev/null
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"OUT_OF_RANGE"}'); assert_eq "在途配送单挡拒单 42221" "$(code "$R")" "42221"
req POST "/api/admin/local/orders/$RJ1/delivery/cancel" "$AT" >/dev/null
# —— 售罄拒单：REFUNDED + 顾客可见文案 + 联动下架
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" "{\"reason\":\"SOLD_OUT\",\"soldOutProductIds\":[$LPID]}")
assert_eq "售罄拒单 code 0" "$(code "$R")" "0"
assert_eq "联动下架 1 件" "$(jq -r .data.offShelfCount <<<"$R")" "1"
assert_eq "订单 → REFUNDED（N4）" "$(req GET "/api/admin/orders/$RJ1" "$AT" | jq -r .data.status)" "REFUNDED"
R=$(req GET "/api/orders/$RJ1" "$UT")
[[ "$(jq -r .data.cancelReason <<<"$R")" == 商家拒单：菜品售罄* ]] && ok "顾客可见拒单原因" || fail "cancelReason" "$R"
assert_eq "商品已下架" "$(req GET "/api/admin/products/$LPID" "$AT" | jq -r .data.status)" "OFF_SHELF"
req PUT "/api/admin/products/$LPID" "$AT" '{"status":"ON_SHELF"}' >/dev/null   # 恢复上架供后续段使用
R=$(req POST "/api/admin/orders/$RJ1/reject" "$AT" '{"reason":"OUT_OF_RANGE"}'); assert_eq "重复拒单被挡（已终态）" "$(code "$R")" "42204"
# —— 邮寄单也能拒（N3）：造一笔 EXPRESS 已支付单
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); RJC=$(jq -r '.data.id // empty' <<<"$R")
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$RJC],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
RJ2=$(jq -r '.data.orderId // empty' <<<"$R"); req POST "/api/orders/$RJ2/pay" "$UT" >/dev/null
R=$(req POST "/api/admin/orders/$RJ2/reject" "$AT" '{"reason":"OTHER","note":"e2e 邮寄拒单"}')
assert_eq "邮寄单拒单 code 0" "$(code "$R")" "0"
assert_eq "邮寄单 → REFUNDED" "$(req GET "/api/admin/orders/$RJ2" "$AT" | jq -r .data.status)" "REFUNDED"
[[ "$(jq -r .data.cancelReason <<<"$R")" == *其他原因（e2e\ 邮寄拒单）* ]] && ok "OTHER 拼入说明" || fail "OTHER 文案" "$R"
# —— 待付款单拒单：走取消不走退款，库存回滚
R=$(req POST /api/cart "$UT" "{\"productId\":$PID,\"quantity\":1}"); RJC3=$(jq -r '.data.id // empty' <<<"$R")
ST0=$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)
R=$(req POST /api/orders "$UT" "{\"cartItemIds\":[$RJC3],\"addressId\":$ADDR,\"deliveryType\":\"EXPRESS\"}")
RJ3=$(jq -r '.data.orderId // empty' <<<"$R")
R=$(req POST "/api/admin/orders/$RJ3/reject" "$AT" '{"reason":"PAST_ACCEPT_TIME"}')
assert_eq "待付款拒单 code 0" "$(code "$R")" "0"
assert_eq "待付款 → CANCELLED（不退款）" "$(req GET "/api/admin/orders/$RJ3" "$AT" | jq -r .data.status)" "CANCELLED"
assert_eq "退款对象为 null" "$(jq -r .data.refund <<<"$R")" "null"
assert_eq "库存回滚" "$(req GET "/api/products/$PID" "$UT" | jq -r .data.stock)" "$ST0"
```
（`$PID`/`$ADDR` 为 e2e 早段既有的邮寄商品与地址变量。）Run RED。

- [ ] **Step 2: 实现 reject 路由**

`routes/admin/orders.ts`（挨着 refund 路由；完整代码）：
```ts
// POST /api/admin/orders/:id/reject — 拒单（两渠道通用，决策 N3/N4）
// 已付款：全额退走 initiateRefund（其内含 42221 在途配送单拦截），终态 REFUNDED；
// 待付款：直接取消 + 回滚库存。拒单原因写 cancelReason，顾客原样可见。
const REJECT_REASONS: Record<string, string> = {
  SOLD_OUT: '菜品售罄', OUT_OF_RANGE: '超出配送范围', PAST_ACCEPT_TIME: '已过接单时间',
  CUSTOMER_CANCEL: '顾客电话要求取消', OTHER: '其他原因',
}
const rejectSchema = z.object({
  reason: z.enum(['SOLD_OUT', 'OUT_OF_RANGE', 'PAST_ACCEPT_TIME', 'CUSTOMER_CANCEL', 'OTHER']),
  note: z.string().trim().max(40).optional(),
  soldOutProductIds: z.array(z.number().int().positive()).max(50).optional(),
})
router.post('/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id)
    const body = rejectSchema.parse(req.body ?? {})
    if (body.reason === 'OTHER' && !body.note) throw new AppError(40001, '选「其他原因」时必须填写说明')
    const cancelReason = `商家拒单：${REJECT_REASONS[body.reason]}${body.note ? `（${body.note}）` : ''}`
    const order = await prisma.order.findUnique({ where: { id }, include: { items: true } })
    if (!order) throw new AppError(40401, '订单不存在', 404)
    if (!['PENDING_PAYMENT', 'PAID', 'PREPARING'].includes(order.status)) {
      throw new AppError(42204, `订单状态为 ${order.status}，已出餐/在途订单请走退款或售后`)
    }
    // 勾选必须是本单里的菜——防手滑把无关商品下架
    const inOrder = new Set(order.items.map((it) => it.productId))
    const soldOutIds = [...new Set(body.soldOutProductIds ?? [])]
    if (soldOutIds.some((pid) => !inOrder.has(pid))) throw new AppError(40001, '勾选了不属于本订单的商品')
    if (body.reason === 'SOLD_OUT' && soldOutIds.length === 0) throw new AppError(40001, '选「菜品售罄」时请勾选售罄的菜品')

    let refund: Awaited<ReturnType<typeof initiateRefund>> | null = null
    if (order.status === 'PENDING_PAYMENT') {
      await prisma.$transaction(async (tx) => {
        const moved = await tx.order.updateMany({ where: { id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason } })
        if (moved.count === 0) throw new AppError(42204, '订单状态已变化，请刷新')
        await rollbackOrderStock(tx, order.items)
      })
    } else {
      refund = await initiateRefund({ orderId: id, amount: remainingRefundable(order), reason: cancelReason, operator: req.adminUsername ?? 'admin' })
      await prisma.order.update({ where: { id }, data: { cancelReason } })
    }
    // 售罄联动下架：独立小事务。退款已是既成事实，这里失败只告警不回滚——
    // 不下架的话下一位顾客照样点得到，同样的单会再来一遍（UI 规格 §7）。
    let offShelfCount = 0
    if (soldOutIds.length > 0) {
      try {
        offShelfCount = (await prisma.product.updateMany({ where: { id: { in: soldOutIds }, status: 'ON_SHELF' }, data: { status: 'OFF_SHELF' } })).count
      } catch (e) {
        notifySystemAlert('拒单联动下架失败', [`订单 ${order.orderNo}`, (e as Error).message, `商品：${soldOutIds.join(',')}`], { key: `reject-offshelf:${id}` })
      }
    }
    success(res, { orderId: id, refund, offShelfCount, cancelReason })
  } catch (e) { next(e) }
})
```
（`remainingRefundable` 已从 refund.ts 导出并在本文件 import；`rollbackOrderStock`、`notifySystemAlert` 需补 import。`initiateRefund` 里 `remaining<=0` 会抛 42206，无需重复判。）

- [ ] **Step 3: GREEN + 提交**

`cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 29 段全 `✔`。
```bash
git add apps/server/src/routes/admin/orders.ts scripts/e2e.sh
git commit -m "feat(admin): 拒单——两渠道通用，全额退款终态 REFUNDED + 售罄联动下架

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: 同城定时任务 ×7 + 自动呼叫

**Files:**
- Create: `apps/server/src/services/delivery/tasks.ts`
- Modify: `apps/server/src/services/scheduler.ts`（注册 8 项、扩展 `SchedulerOverrides`）
- Modify: `apps/server/src/routes/admin/system.ts`（run-scheduler 透传新 override 键）
- Test: `scripts/e2e.sh` 新增「== 30. 同城定时任务 ==」

**Interfaces:**
- Consumes: T4-T6 的 orchestrator/notify；`local-settings` 的 `callTimeoutMin/acceptedStuckMin/deliveringTimeoutMin/autoCallDelayMin`、`isOpenNow`；熔断 `isCircuitTripped`。
- Produces（tasks.ts 导出，全部 `(阈值?: number) => Promise<number>` 形状，阈值缺省读设置或给定默认）:
  - `remindCallTimeout(min?)` — Delivery CALLING 且 `calledAt < now-X`（X=min ?? settings.callTimeoutMin）且 `callTimeoutRemindedAt: null` → 逐单 `updateMany({where:{id, callTimeoutRemindedAt:null}, data:{callTimeoutRemindedAt:now}})` count=1 才推店员（防并发双推）
  - `remindAcceptedStuck(min?)` — status∈{ACCEPTED,ARRIVING,ARRIVED} 且 `acceptedAt < now-X`（settings.acceptedStuckMin）且 `acceptedStuckRemindedAt:null`
  - `remindDeliveringTimeout(min?)` — DELIVERING 且 `pickedUpAt < now-X`（settings.deliveringTimeoutMin）且 `deliveringRemindedAt:null`
  - `remindUnknownGhost(min?)` — UNKNOWN 且 `calledAt < now-X`（默认 10）且 `unknownRemindedAt:null` → notifySystemAlert 提醒老板去快递100 后台核对后作废/等认领
  - `remindLocalUncalled(min?)` — Order LOCAL PREPARING 且 `acceptedAt < now-X`（默认 10）且 `localUncalledRemindedAt:null` 且 `cancelRequestedAt:null` 且无在途配送单（`deliveries: { none: { activeOrderId: { not: null } } }` 用 relation filter；等价写法：先查 activeOrderId 集合排除）
  - `remindCancelRequestPending(min?)` — Order LOCAL `cancelRequestedAt < now-X`（默认 5）且 status∉{COMPLETED,CANCELLED,REFUNDED} 且 `cancelRequestRemindedAt:null`
  - `autoCallRiders(delayMin?)` — 前置 6 条件：`delay>0`（0=手动模式直接返 0；默认 settings.autoCallDelayMin）、设置 enabled 且 `isOpenNow`、熔断未触发、订单 PREPARING+LOCAL+`acceptedAt < now-delay`、无取消申请、无在途配送单 → 逐单 `callRider({source:'SCHEDULER'})`，单个失败 catch 后继续（AppError 不告警——callRider 内部已告警），返成功数
  - `autoCompleteLocalDelivered(days?)` — **LOCAL 单的自动确认收货兜底**：既有 `autoCompleteShippedOrders` 走 `shipment.shippedAt`，而 LOCAL 单永不写 Shipment 行，所以它永远命中不了同城单；若 520 回调丢失，同城单会永久停在 SHIPPED。本任务补一条：Order `deliveryType:'LOCAL'` + `status:'SHIPPED'`，其在途配送单（或最近一张）的 `pickedUpAt < now - config.order.autoCompleteDays 天` → `updateMany` 置 COMPLETED + completedAt（同时把仍占位的配送单置 DELIVERED + 释放）。返处理行数。
  - `housekeepingDelivery()` — ①终态单 `activeOrderId != null` → 释放 + notifySystemAlert（数据不一致）②**陈旧 PENDING 清扫**：`status:'PENDING'` 且 `createdAt < now-10min` → 置 FAILED + 释放 + `errorCode:'STALE'` + 告警（callRider 的恢复写在 DB 不可达时会失败，占位就此泄漏且无人能救——这是最后一道防线）③`DeliveryEvent.rawPayload` 90 天前 → `updateMany({data:{rawPayload: Prisma.DbNull}})`；返处理行数
- scheduler 注册（追加到 tasks 数组，名字即 e2e 断言键）：`localCallTimeout/localAcceptedStuck/localDelivering/localUnknown/localUncalled/localCancelReq/localAutoCall/localAutoComplete/localHousekeeping`；`SchedulerOverrides` 增 `callTimeoutMin/acceptedStuckMin/deliveringTimeoutMin/unknownStuckMin/localUncalledMin/cancelRequestPendingMin/autoCallDelayMin`；run-scheduler 路由 body 同名透传。

- [ ] **Step 1: e2e（RED）**

第 29 段之后插入。所有阈值传 0 让「刚发生」立即命中；「每单一次」用两连跑第二跑归零来断言（第一跑会把库里全部存量单打上标记）：
```bash
echo "== 30. 同城定时任务 =="
req POST /api/admin/system/kd100-mock/reset "$AT" >/dev/null
sched() { req POST /api/admin/system/run-scheduler "$AT" "$1"; }
SCH1=$(mk_local_paid); req POST "/api/admin/local/orders/$SCH1/accept" "$AT" >/dev/null
# 备餐超时未呼叫（每单一次）
R=$(sched '{"localUncalledMin":0}'); [[ "$(jq -r .data.localUncalled <<<"$R")" -ge 1 ]] && ok "localUncalled ≥1" || fail "localUncalled" "$R"
R=$(sched '{"localUncalledMin":0}'); assert_eq "localUncalled 第二跑归零（每单一次）" "$(jq -r .data.localUncalled <<<"$R")" "0"
# 自动呼叫（override 开启；settings 默认 0=手动）
R=$(sched '{"autoCallDelayMin":0}')
[[ "$(jq -r .data.localAutoCall <<<"$R")" -ge 1 ]] && ok "autoCall ≥1" || fail "autoCall" "$R"
assert_eq "SCH1 被自动呼叫 → CALLING" "$(dstat $SCH1)" "CALLING"
R=$(sched '{"autoCallDelayMin":0}'); assert_eq "已有在途单不重呼" "$(jq -r .data.localAutoCall <<<"$R")" "0"
# 待抢单超时（每单一次）
R=$(sched '{"callTimeoutMin":0}'); [[ "$(jq -r .data.localCallTimeout <<<"$R")" -ge 1 ]] && ok "callTimeout ≥1" || fail "callTimeout" "$R"
R=$(sched '{"callTimeoutMin":0}'); assert_eq "callTimeout 第二跑归零" "$(jq -r .data.localCallTimeout <<<"$R")" "0"
# 接单后卡住 → 配送中超时
SCT1=$(req GET "/api/admin/local/orders/$SCH1/delivery" "$AT" | jq -r .data.delivery.providerTaskId)
SCD1=$(req GET "/api/admin/local/orders/$SCH1/delivery" "$AT" | jq -r .data.delivery.deliveryNo)
kd_cb "$SCD1" "$SCT1" 100 '骑手已接单' '2026-09-04 14:00:00' >/dev/null
R=$(sched '{"acceptedStuckMin":0}'); [[ "$(jq -r .data.localAcceptedStuck <<<"$R")" -ge 1 ]] && ok "acceptedStuck ≥1" || fail "acceptedStuck" "$R"
R=$(sched '{"acceptedStuckMin":0}'); assert_eq "acceptedStuck 第二跑归零" "$(jq -r .data.localAcceptedStuck <<<"$R")" "0"
kd_cb "$SCD1" "$SCT1" 310 '骑手已取货' '2026-09-04 14:05:00' >/dev/null
R=$(sched '{"deliveringTimeoutMin":0}'); [[ "$(jq -r .data.localDelivering <<<"$R")" -ge 1 ]] && ok "delivering ≥1" || fail "delivering" "$R"
R=$(sched '{"deliveringTimeoutMin":0}'); assert_eq "delivering 第二跑归零" "$(jq -r .data.localDelivering <<<"$R")" "0"
kd_cb "$SCD1" "$SCT1" 520 '已送达' '2026-09-04 14:30:00' >/dev/null   # 收尾到终态
# UNKNOWN 幽灵单提醒
SCH2=$(mk_local_paid); req POST "/api/admin/local/orders/$SCH2/accept" "$AT" >/dev/null
req POST /api/admin/system/kd100-mock/queue "$AT" '{"op":"createOrder","directive":{"kind":"timeout"}}' >/dev/null
req POST "/api/admin/local/orders/$SCH2/call" "$AT" >/dev/null
R=$(sched '{"unknownStuckMin":0}'); [[ "$(jq -r .data.localUnknown <<<"$R")" -ge 1 ]] && ok "unknown ≥1" || fail "unknown" "$R"
R=$(sched '{"unknownStuckMin":0}'); assert_eq "unknown 第二跑归零" "$(jq -r .data.localUnknown <<<"$R")" "0"
req POST "/api/admin/local/orders/$SCH2/delivery/void" "$AT" >/dev/null
# 取消申请挂起提醒
SCH3=$(mk_local_paid); req POST "/api/admin/local/orders/$SCH3/accept" "$AT" >/dev/null
req POST "/api/orders/$SCH3/cancel-request" "$UT" '{"note":"e2e 挂起"}' >/dev/null
R=$(sched '{"cancelRequestPendingMin":0}'); [[ "$(jq -r .data.localCancelReq <<<"$R")" -ge 1 ]] && ok "cancelReq ≥1" || fail "cancelReq" "$R"
R=$(sched '{"cancelRequestPendingMin":0}'); assert_eq "cancelReq 第二跑归零" "$(jq -r .data.localCancelReq <<<"$R")" "0"
# housekeeping 存在且不炸
R=$(sched '{}'); [[ "$(jq -r '.data | has("localHousekeeping")' <<<"$R")" == "true" ]] && ok "housekeeping 已注册" || fail "housekeeping" "$R"
```
Run RED（新任务键不存在，`jq -r` 得 null）。

- [ ] **Step 2: 实现 tasks.ts 并注册**

`tasks.ts` 骨架（每个任务同构，以 remindCallTimeout 与 autoCallRiders 为完整样例，其余五个按 Interfaces 的查询条件同样写全）：
```ts
/**
 * 同城配送兜底任务。全部「先 updateMany 打标、count=1 才推送」——标记列是唯一真相，
 * 并发双 tick 或告警发送失败都不会造成重复打扰（宁可漏一条提醒，不可轰炸店员）。
 */
import { Prisma } from '@prisma/client'
import prisma from '../../utils/prisma'
import { getLocalSettings, isOpenNow } from '../local-settings'
import { isCircuitTripped } from './circuit'
import { callRider } from './orchestrator'
import { notifySystemAlert } from '../notify'
import { notifyLocalDeliveryAlert } from '../order-notify'
import { DELIVERY_STATUS_LABEL, TERMINAL } from './state'

const BATCH = 100
const ago = (min: number) => new Date(Date.now() - min * 60 * 1000)

export async function remindCallTimeout(min?: number): Promise<number> {
  const s = await getLocalSettings()
  const threshold = min ?? s.callTimeoutMin
  const rows = await prisma.delivery.findMany({
    where: { status: 'CALLING', calledAt: { lt: ago(threshold) }, callTimeoutRemindedAt: null },
    take: BATCH, select: { id: true, orderNo: true, calledAt: true },
  })
  let n = 0
  for (const d of rows) {
    const marked = await prisma.delivery.updateMany({ where: { id: d.id, callTimeoutRemindedAt: null }, data: { callTimeoutRemindedAt: new Date() } })
    if (marked.count === 0) continue
    n++
    notifyLocalDeliveryAlert('待抢单超时', [`订单 ${d.orderNo}`, `已等待超过 ${threshold} 分钟无人接单`, '可加小费、继续等待或改自己送'])
  }
  return n
}
// remindAcceptedStuck / remindDeliveringTimeout / remindUnknownGhost /
// remindLocalUncalled / remindCancelRequestPending 同构：查询条件与提醒文案见上方 Interfaces，
// UNKNOWN 用 notifySystemAlert（要老板去快递100 后台核对），其余用 notifyLocalDeliveryAlert。

export async function autoCallRiders(delayMin?: number): Promise<number> {
  const s = await getLocalSettings()
  const delay = delayMin ?? s.autoCallDelayMin
  if (delay <= 0) return 0                       // 0 = 手动模式（店主默认，D6 拍板）
  if (!s.enabled || !isOpenNow(s)) return 0
  if (isCircuitTripped()) return 0
  const orders = await prisma.order.findMany({
    where: {
      deliveryType: 'LOCAL', status: 'PREPARING', cancelRequestedAt: null,
      acceptedAt: { lt: ago(delay) },
      deliveries: { none: { activeOrderId: { not: null } } },
    },
    take: BATCH, select: { id: true },
  })
  let n = 0
  for (const o of orders) {
    try { await callRider({ orderId: o.id, operator: 'scheduler', source: 'SCHEDULER' }); n++ }
    catch { /* callRider 内部已按失败类型落库+告警；这里继续处理下一单 */ }
  }
  return n
}

export async function housekeepingDelivery(): Promise<number> {
  let n = 0
  const stuck = await prisma.delivery.findMany({ where: { status: { in: [...TERMINAL] }, activeOrderId: { not: null } }, take: BATCH, select: { id: true, deliveryNo: true, status: true } })
  for (const d of stuck) {
    await prisma.delivery.updateMany({ where: { id: d.id }, data: { activeOrderId: null } })
    notifySystemAlert('配送单数据不一致已自愈', [`${d.deliveryNo} 终态 ${DELIVERY_STATUS_LABEL[d.status] ?? d.status} 但仍占位，已释放`], { key: `dlv-housekeeping:${d.id}` })
    n++
  }
  // 陈旧 PENDING：占位行只应存在于一次外呼期间（最长 8 秒超时 + 落库）。超过 10 分钟还是 PENDING，
  // 说明进程在外呼后崩了、或 callRider 的恢复写本身失败（DB 曾不可达）。不扫的话该订单永久不可再呼。
  const stalePending = await prisma.delivery.findMany({ where: { status: 'PENDING', createdAt: { lt: ago(10) } }, take: BATCH, select: { id: true, deliveryNo: true, orderNo: true } })
  for (const d of stalePending) {
    const moved = await prisma.delivery.updateMany({ where: { id: d.id, status: 'PENDING' }, data: { status: 'FAILED', activeOrderId: null, errorCode: 'STALE', failReason: '呼叫未落库（进程中断或数据库异常），已自动释放' } })
    if (moved.count === 0) continue
    notifySystemAlert('配送单占位超时未落库已释放', [`订单 ${d.orderNo}（${d.deliveryNo}）`, '若运力方已产生真实单，请到快递100 后台核对'], { key: `dlv-stale:${d.id}` })
    n++
  }
  n += (await prisma.deliveryEvent.updateMany({
    where: { createdAt: { lt: new Date(Date.now() - 90 * 24 * 3600 * 1000) }, rawPayload: { not: Prisma.DbNull } },
    data: { rawPayload: Prisma.DbNull },
  })).count
  return n
}
```
（注意 `deliveries: { none: { activeOrderId: { not: null } } }` 需要 Order↔Delivery 反向 relation 名——schema 里 Order 侧字段名以 `npx prisma format` 后为准，若为 `Delivery[]` 默认名请照实写。）
`scheduler.ts`：`SchedulerOverrides` 按 Interfaces 增 7 键；tasks 数组追加 8 行（名字与 e2e 断言一致）。`system.ts` run-scheduler 的 body 透传同名键（沿用 `num()`）。

- [ ] **Step 3: GREEN + 提交**

`cd apps/server && npx tsc --noEmit && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3` → 第 30 段全 `✔`；再快速核对既有第 12 段 run-scheduler 断言未回归。
```bash
git add apps/server/src/services/delivery/tasks.ts apps/server/src/services/scheduler.ts apps/server/src/routes/admin/system.ts scripts/e2e.sh
git commit -m "feat(scheduler): 同城 7 兜底任务 + 自动呼叫（每单一次、打标先行）

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: 服务端收尾——e2e 去 SQL、localPendingCount 收窄、api.md、spec 同步

**Files:**
- Modify: `scripts/e2e.sh`（第 22 段 `docker exec … update orders set status='PREPARING' … where id=$LO1` 改为 `req POST "/api/admin/local/orders/$LO1/accept" "$AT" >/dev/null`——**只改这一条**；同段第 348 行的时间回拨 SQL 与第 476 行清理 SQL 保留，时间旅行没有真接口）
- Modify: `apps/server/src/routes/admin/orders.ts`（pending-count 的 localPendingCount 查询收窄）
- Modify: `docs/api.md`（新增「同城配送单」「拒单」「回调」三节 + 错误码表 42221/42225/42228/42232-42238）
- Modify: `docs/superpowers/specs/2026-09-03-local-delivery-design.md`（spec 同步）

**Interfaces:** 无新接口；纯收尾。

- [ ] **Step 1: e2e 去 SQL + 验证**

改完先单独跑一遍全量 e2e 确认第 22 段仍绿（accept 路由要求 PAID+LOCAL，`$LO1` 恰好满足）。

- [ ] **Step 2: localPendingCount 收窄**

```ts
      prisma.order.count({
        where: {
          deliveryType: 'LOCAL',
          OR: [
            { status: { in: ['PAID', 'PREPARING'] } },
            // 取消申请徽标只数还没走完流程的单：终态单的 cancelRequestedAt 是历史痕迹，不该永久占一个红点
            { cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] } },
          ],
        },
      }),
```

- [ ] **Step 3: spec 同步（逐条，防跑偏）**

1. §5.3 状态机：补 N8 特例（REASSIGNING 收 100 回拨 ACCEPTED）与「唯二回拨」措辞。
2. §5.5 回调应答：改为 N5 语义（仅入库失败 500，其余 200），并注明与微信支付相反的原因。
3. §5.9 残留的 `/kd/cb` 全部改为 `POST /api/kd/:deliveryNo`；错误码表补 42232-42238 十码含义（照本计划 Global Constraints 表）。
4. §6 拒单：终态由 CANCELLED 改 REFUNDED（N4），补两渠道通用（N3）与 `POST /admin/orders/:id/reject` 契约。
5. §7b 工作台：注明界面细则以 `docs/design/workbench-ui-spec.md` 为准，「等待配送员」列 v1 只放同城（N2）。
6. §8 通知：顾客订阅消息定稿为「310 触发配送通知」单模板；100/520 不发（授权配额）。
7. §10 测试场景表：勾掉本里程碑已覆盖行，标注对应 e2e 段号（25-30）。

- [ ] **Step 4: api.md 增补**

按既有文档风格写三节：`/admin/local/orders/*`（accept/accept-and-call/call/delivery GET/precancel/cancel/tip/self-deliver/delivered/void）、`/admin/orders/:id/reject`、`POST /api/kd/:deliveryNo`（应答契约 + 验签说明）、`GET /api/orders/:id/courier`、`POST /admin/settings/local-delivery/probe`、mock 控制面与 run-scheduler 新键；错误码表增行。

- [ ] **Step 5: 全量验证 + 提交**

```bash
cd apps/server && npx tsc --noEmit && npx ts-node --transpile-only scripts/selftest-delivery-core.ts && npx ts-node --transpile-only scripts/selftest-kd100.ts && cd ../.. && bash scripts/e2e.sh 2>&1 | tail -3
sleep 60 && bash scripts/e2e.sh 2>&1 | tail -3   # 连跑两次幂等（loginLimiter 60s 窗口）
```
Expected: 两轮全绿、条数一致。
```bash
git add scripts/e2e.sh apps/server/src/routes/admin/orders.ts docs/api.md docs/superpowers/specs/2026-09-03-local-delivery-design.md
git commit -m "chore(delivery): M2-A 收尾——e2e 去 SQL、徽标口径收窄、api.md 与 spec 同步

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
