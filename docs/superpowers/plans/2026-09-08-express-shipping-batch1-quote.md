# 全国邮寄接快递100 · 批次一（邮寄设置 + 中位数报价 + 结算页 + 下单校验）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 邮寄订单的运费从「后台一口价」改成「按目的地 + 重量向快递100 查各家报价取中位数」，顾客在结算页看到的运费由服务端签成凭证、下单时校验；后台能配地区分组/包邮/不寄送/定价名单。店员流程本批不变。

**Architecture:** 照同城骨架平行搭一套：`express-settings.ts`（设置 + 分组）、`express-quote.ts`（纯计算 + 凭证）、`kd100-express.ts`（快递100 上门取件协议，只做 `batchPrice`）、`express-quote-service.ts`（编排 + 缓存）、`routes/express.ts`（顾客报价接口）、`orders.ts` 邮寄分支改走凭证。快递100 的签名/提交/超时分类从同城 `kd100.ts` 抽到共用的 `kd100-client.ts`。

**Tech Stack:** Node 20 + Express + Prisma(MySQL) + zod；后台 React + Tailwind；小程序原生（ES5 风格 `var`/`function`）；测试用 `scripts/selftest-*.ts`（ts-node 离线断言）+ `scripts/e2e.sh` + `scripts/e2e.d/*.sh`（curl+jq）。

**设计依据：** `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md` §1–§4、§9–§13。

## Global Constraints

- 金额单位一律「分」（Int）；重量在设置/接口里用**克**（Int）或一位小数的公斤（number），落库用克。
- 错误码：`42210` 起送（沿用）；新增 `42260` 该地区暂不支持邮寄、`42261` 运费已更新请重新确认、`42262` 收货地址过长。（spec 里写的 42240/42241/42243 与打印机模块撞号，以本文为准，Task 10 回改 spec。）
- **老版本小程序兼容**：`POST /api/orders` 邮寄单 `quoteToken` **可选**。不带 → 服务端现查现算（同一套函数）；带了 → 校验，不符 → 42261。这是对 spec §4.1「必带」的放宽，原因：小程序发版有滞后，服务端先上线时不能把所有邮寄单拒掉。
- 生产禁止 mock：`EXPRESS_PROVIDER_MOCK=true` 在 `NODE_ENV=production` 下拒绝启动（与现有五个 mock 同列）。
- 快递100 上门取件正式地址 `https://poll.kuaidi100.com/order/borderapi.do`；`batchPrice` 免费、不扣余额。
- 省份名用微信 `picker mode="region"` 的全名（`四川省`/`重庆市`/`新疆维吾尔自治区`/`香港特别行政区`），默认分组按此写。
- 同城代码行为**零变化**：Task 1 抽协议层后 `selftest-kd100.ts` 与 `scripts/e2e.sh` 全绿是判据。
- 每个任务结束 `cd apps/server && npx tsc --noEmit` 必须 0 错误。
- 提交信息中文、一句话说清改了什么；每个任务至少一次提交。

## 模型分工（按 `workflow-model-tiering`）

| 角色 | 模型 | 在本计划里 |
|---|---|---|
| 规划 | fable | 本文（已完成） |
| 执行 | sonnet | Task 1–9 每个任务一个 fresh subagent |
| 复核 / 对抗验证 | opus | 每个任务合并前一次代码复核；Task 10 整批终审 |
| 机械核对 | haiku | Task 10 的文档与断言计数核对 |

## 文件结构

新建：
- `apps/server/src/services/delivery/kd100-client.ts` — 签名 / form 提交 / 超时与网络错误分类（同城与邮寄共用）
- `apps/server/src/services/express-settings.ts` — 邮寄设置类型、默认值、sanitize/validate、读写缓存、旧设置迁移、省份分组查找
- `apps/server/src/services/express-quote.ts` — 纯计算：重量、中位数、兜底表、包邮/起送、商品指纹、凭证签验
- `apps/server/src/services/delivery/kd100-express.ts` — 快递100 上门取件 `batchPrice` 协议 + provider 切换
- `apps/server/src/services/delivery/express-mock.ts` — 邮寄查价 mock（指令队列）
- `apps/server/src/services/order-lines.ts` — 从 `orders.ts` 抽出的「组装下单行 + 校验可售」
- `apps/server/src/services/express-quote-service.ts` — 报价编排：地址/分组/重量/查价缓存/凭证
- `apps/server/src/routes/express.ts` — `POST /api/express/quote`
- `apps/server/src/routes/admin/express-mock.ts` — mock 控制面
- `apps/server/prisma/migrations/20260912000000_express_quote_snapshot/migration.sql`
- `apps/server/scripts/selftest-express-settings.ts`、`selftest-express-quote.ts`、`selftest-kd100-express.ts`
- `scripts/e2e.d/56-express-quote.sh`、`scripts/e2e.d/57-express-order.sh`
- `apps/miniapp/api/express.js`

修改：
- `apps/server/src/services/delivery/kd100.ts` — `post()`/`_sign` 改调 client
- `apps/server/src/config.ts` — 新 env 与 mock 开关
- `apps/server/src/routes/orders.ts` — 抽 `loadOrderLines`；邮寄分支走凭证；`/meta` 兼容
- `apps/server/src/routes/index.ts`、`routes/admin/index.ts` — 挂载
- `apps/server/src/middlewares/rate-limit.ts` — `expressQuoteLimiter`
- `apps/server/src/routes/admin/settings.ts` — `GET/PUT /express`；`/shipping` 改成兼容垫片
- `apps/server/prisma/schema.prisma` — Order 三列
- `apps/admin/src/types.ts`、`api/admin.ts`、`pages/ShopSettings.tsx`
- `apps/miniapp/pages/order/confirm.js|wxml|wxss`
- `scripts/e2e.sh` — 开头把邮寄设置复位成 TABLE/0 元
- `docs/api.md`（附录 F）、`docs/staff-guide.md`、spec 错误码

---

### Task 1: 抽出快递100 协议底座 `kd100-client.ts`

**Files:**
- Create: `apps/server/src/services/delivery/kd100-client.ts`
- Modify: `apps/server/src/services/delivery/kd100.ts:14-96`（`_sign`、`post`）
- Test: `apps/server/scripts/selftest-kd100.ts`（追加 1 条）

**Interfaces:**
- Produces: `signKd100(paramStr, t, key, secret): string`；`postKd100(o: PostKd100Options): Promise<Kd100Response>`；`Kd100Response { code?, returnCode?, success?, message?, data?: unknown }`；`PostKd100Options { url, method, param, key, secret, timeoutMs, mapReturnCode }`。
- Consumes: `ProviderError`、`ProviderErrorKind`（`./types`）。

- [ ] **Step 1: 在 selftest-kd100.ts 末尾（`console.log` 汇总行之前）加一条会失败的断言**

```ts
import { signKd100 } from '../src/services/delivery/kd100-client'
t('_sign 与 kd100-client.signKd100 逐字节一致', () => {
  assert.strictEqual(_sign('{"x":"中文"}', '1725400000000', 'K', 'S'), signKd100('{"x":"中文"}', '1725400000000', 'K', 'S'))
})
```
（`import` 放文件顶部与其它 import 并列。）

- [ ] **Step 2: 跑它，确认因模块不存在而失败**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100.ts
```
Expected: `Cannot find module '../src/services/delivery/kd100-client'`

- [ ] **Step 3: 新建 `kd100-client.ts`**

```ts
/**
 * 快递100 两个产品（同城急送 / 上门取件）共用的协议底座：签名、form 提交、超时与网络错误分类。
 * 只懂 HTTP，不懂业务：returnCode → ProviderErrorKind 的映射由各产品自己传进来。
 * 2026-09-08 从 kd100.ts 抽出，行为与抽出前逐字节一致；selftest-kd100 与同城 e2e 是判据。
 *
 * ⚠️ 超时/网络错误的分类规则是同城下单防双呼的根基（详见 kd100.ts 顶部注释），这里一行都不能松：
 *  - AbortSignal 超时 → TIMEOUT（下单可能已成功，调用方按 UNKNOWN 等回调，绝不重试）
 *  - ECONNREFUSED/ENOTFOUND/EAI_AGAIN → BUSINESS（能证明包没发出去，可重试）
 *  - 其它 fetch reject、HTTP 5xx → TIMEOUT（证明不了没送达）
 */
import crypto from 'crypto'
import { ProviderError, ProviderErrorKind } from './types'

export interface Kd100Response {
  code?: number | string
  returnCode?: number | string
  success?: boolean
  message?: string
  data?: unknown
}

const md5U = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

/** sign = MD5(param + t + key + secret)，32 位大写。两个产品同一公式。 */
export function signKd100(paramStr: string, t: string, key: string, secret: string): string {
  return md5U(paramStr + t + key + secret)
}

export interface PostKd100Options {
  url: string
  method: string
  param: Record<string, unknown>
  key: string
  secret: string
  timeoutMs: number
  /** 业务错误码 → 错误类别。同城是 30001…，上门取件是 400/503/600…，各产品自己给。 */
  mapReturnCode: (code: number | string) => ProviderErrorKind
}

export async function postKd100(o: PostKd100Options): Promise<Kd100Response> {
  const t = Date.now().toString()
  const paramStr = JSON.stringify(o.param)
  const body = new URLSearchParams({
    method: o.method, key: o.key, sign: signKd100(paramStr, t, o.key, o.secret), t, param: paramStr,
  })
  let res: Response
  try {
    res = await fetch(o.url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: body.toString(), signal: AbortSignal.timeout(o.timeoutMs),
    })
  } catch (e) {
    const err = e as Error & { cause?: unknown }
    const name = err?.name ?? ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ProviderError('TIMEOUT', 'TIMEOUT', `快递100 请求超时: ${err.message}`, e)
    }
    const causeCode = err.cause && typeof err.cause === 'object' && 'code' in err.cause
      ? String((err.cause as { code?: unknown }).code ?? '') : ''
    const CONFIRMED_NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])
    if (CONFIRMED_NOT_SENT.has(causeCode)) {
      throw new ProviderError('BUSINESS', causeCode, `快递100 请求未能发出（${causeCode}）: ${err.message}`, e)
    }
    throw new ProviderError('TIMEOUT', causeCode || 'NETWORK', `快递100 请求网络失败: ${err.message}`, e)
  }
  if (res.status >= 500) {
    throw new ProviderError('TIMEOUT', 'HTTP_5XX', `快递100 网关异常 HTTP ${res.status}`, res)
  }
  let data: Kd100Response
  try { data = (await res.json()) as Kd100Response } catch { throw new ProviderError('BUSINESS', `HTTP_${res.status}`, '快递100 响应非 JSON') }
  const code = data.returnCode ?? data.code
  if (!res.ok || (String(code) !== '200' && data.success !== true)) {
    throw new ProviderError(o.mapReturnCode(code ?? res.status), String(code ?? res.status), data.message ?? '快递100 返回异常', data)
  }
  return data
}
```

- [ ] **Step 4: 改 `kd100.ts` 用它**

把 `kd100.ts` 里 `const md5U = ...` **保留**（回调验签仍用），`_sign` 改成：
```ts
import { signKd100, postKd100 } from './kd100-client'
export function _sign(paramStr: string, t: string, key: string, secret: string): string {
  return signKd100(paramStr, t, key, secret)
}
```
把整个 `async function post(...)` 函数体（从 `validateKd100Config()` 到最后 `return data`）替换为：
```ts
async function post(method: string, param: Record<string, unknown>, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Kd100Response> {
  validateKd100Config()
  return (await postKd100({
    url: API_URL, method, param, key: config.kd100.key, secret: config.kd100.secret, timeoutMs, mapReturnCode: _mapReturnCode,
  })) as Kd100Response
}
```
`kd100.ts` 里原来的 `interface Kd100Response { ... data?: Record<string, unknown> }` 保留不动（本文件内部仍按 Record 读 `data.feeDetail`）。删掉 `post` 旧函数体后不再用到的 import（`ProviderErrorKind` 若只在 `_mapReturnCode` 签名里用则保留）。

- [ ] **Step 5: 编译 + 自测**

```bash
cd apps/server && npx tsc --noEmit && npx ts-node --transpile-only scripts/selftest-kd100.ts
```
Expected: tsc 无输出；selftest 全 ✔ 且最后一行通过数比改前多 1。

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/services/delivery/kd100-client.ts apps/server/src/services/delivery/kd100.ts apps/server/scripts/selftest-kd100.ts
git commit -m "快递100 协议底座抽成 kd100-client（签名/提交/超时分类），同城行为不变"
```

**复核（opus）要点**：`post()` 的五种错误分支与抽出前一一对应；`_sign` 未改语义；`mock.ts` 若引用了 `kd100.ts` 的 `_sign`/`md5U` 仍能编译。

---

### Task 2: 邮寄设置 `express-settings.ts`

**Files:**
- Create: `apps/server/src/services/express-settings.ts`
- Test: `apps/server/scripts/selftest-express-settings.ts`

**Interfaces:**
- Produces: `EXPRESS_COURIERS`、`COURIER_LABEL`、`PROVINCE_NAMES`、`OTHER_GROUP`、`RegionGroup`、`ExpressSettings`、`DEFAULT_EXPRESS_SETTINGS`、`sanitizeExpressSettings(raw): ExpressSettings`、`validateExpressSettings(s): string[]`、`getExpressSettings(): Promise<ExpressSettings>`、`setExpressSettings(next): Promise<ExpressSettings>`、`patchExpressSettings(p)`、`clearExpressSettingsCache()`、`findRegionGroup(s, province): RegionGroup`、`legacyShippingView(s): { fee, freeThreshold, minOrderAmount }`、`applyLegacyShipping(s, legacy): ExpressSettings`。
- Consumes: `prisma`（`../utils/prisma`）、`getShippingSettings`（`./settings`，仅迁移用）。

- [ ] **Step 1: 写自测（先失败）** `apps/server/scripts/selftest-express-settings.ts`

```ts
/**
 * 邮寄设置纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-express-settings.ts
 */
import assert from 'assert'
import {
  DEFAULT_EXPRESS_SETTINGS, OTHER_GROUP, sanitizeExpressSettings, validateExpressSettings,
  findRegionGroup, legacyShippingView, applyLegacyShipping,
} from '../src/services/express-settings'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

t('默认值：四组、其他组存在且不 blocked、定价名单 6 家', () => {
  const s = DEFAULT_EXPRESS_SETTINGS
  assert.strictEqual(s.regionGroups.length, 4)
  const other = s.regionGroups.find((g) => g.name === OTHER_GROUP)!
  assert.ok(other && !other.blocked)
  assert.deepStrictEqual(s.pricingPool, ['jtexpress', 'yuantong', 'shentong', 'yunda', 'zhongtong', 'jd'])
  assert.strictEqual(s.fee.mode, 'QUOTE'); assert.strictEqual(s.fee.roundToFen, 50); assert.strictEqual(s.fee.minQuoteCount, 2)
  assert.strictEqual(s.weight.packagingG, 800); assert.strictEqual(s.weight.defaultItemG, 300)
  assert.strictEqual(s.acceptGraceMin, 10)
})
t('sanitize：非法值逐字段回落，不抛', () => {
  const s = sanitizeExpressSettings({ weight: { packagingG: -5 }, fee: { mode: 'WHATEVER', roundToFen: 'x' }, pricingPool: ['jd', 'bogus', 7], regionGroups: 'nope' })
  assert.strictEqual(s.weight.packagingG, 800)
  assert.strictEqual(s.fee.mode, 'QUOTE'); assert.strictEqual(s.fee.roundToFen, 50)
  assert.deepStrictEqual(s.pricingPool, ['jd'])
  assert.strictEqual(s.regionGroups.length, 4)
})
t('sanitize：分组里未知省份被剔除、字段回落', () => {
  const s = sanitizeExpressSettings({ regionGroups: [
    { name: '其他', provinces: [], freeShipMinFen: 0, tableFirstFen: 1000, tableOverPerKgFen: 200, blocked: false },
    { name: '西南', provinces: ['四川省', '火星省'], freeShipMinFen: 'x', tableFirstFen: 800, tableOverPerKgFen: 100, blocked: 'no' },
  ] })
  const g = s.regionGroups.find((x) => x.name === '西南')!
  assert.deepStrictEqual(g.provinces, ['四川省']); assert.strictEqual(g.freeShipMinFen, 0); assert.strictEqual(g.blocked, false)
})
t('validate：缺其他组 / 其他组 blocked / 省份重复 / 定价名单不足 2 家 都报错', () => {
  const base = DEFAULT_EXPRESS_SETTINGS
  assert.ok(validateExpressSettings({ ...base, regionGroups: base.regionGroups.filter((g) => g.name !== OTHER_GROUP) }).some((e) => e.includes('其他')))
  assert.ok(validateExpressSettings({ ...base, regionGroups: base.regionGroups.map((g) => g.name === OTHER_GROUP ? { ...g, blocked: true } : g) }).some((e) => e.includes('其他')))
  const dup = base.regionGroups.map((g) => g.name === '周边' ? { ...g, provinces: [...g.provinces, '四川省'] } : g)
  assert.ok(validateExpressSettings({ ...base, regionGroups: dup }).some((e) => e.includes('四川省')))
  assert.ok(validateExpressSettings({ ...base, pricingPool: ['jd'] }).some((e) => e.includes('定价')))
  assert.deepStrictEqual(validateExpressSettings(base), [])
})
t('findRegionGroup：命中 / 落其他 / 不寄送', () => {
  const s = DEFAULT_EXPRESS_SETTINGS
  assert.strictEqual(findRegionGroup(s, '四川省').name, '四川')
  assert.strictEqual(findRegionGroup(s, '重庆市').name, '周边')
  assert.strictEqual(findRegionGroup(s, '北京市').name, OTHER_GROUP)
  assert.strictEqual(findRegionGroup(s, '不存在').name, OTHER_GROUP)
  assert.strictEqual(findRegionGroup(s, '新疆维吾尔自治区').blocked, true)
})
t('legacyShippingView / applyLegacyShipping 往返', () => {
  const s = applyLegacyShipping(DEFAULT_EXPRESS_SETTINGS, { fee: 500, freeThreshold: 9900, minOrderAmount: 2000 })
  assert.strictEqual(s.fee.mode, 'TABLE')
  for (const g of s.regionGroups) { assert.strictEqual(g.tableFirstFen, 500); assert.strictEqual(g.tableOverPerKgFen, 0); assert.strictEqual(g.freeShipMinFen, 9900) }
  assert.deepStrictEqual(legacyShippingView(s), { fee: 500, freeThreshold: 9900, minOrderAmount: 2000 })
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
```

- [ ] **Step 2: 跑，确认模块不存在而失败**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-settings.ts
```
Expected: `Cannot find module '../src/services/express-settings'`

- [ ] **Step 3: 新建 `express-settings.ts`**

```ts
/**
 * 全国邮寄运营参数（settings 表 key=express_delivery）。
 * 与 local-settings.ts 同款：60 秒进程缓存、保存即失效、sanitize 只回落不抛。
 * 设计：docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md §2
 */
import prisma from '../utils/prisma'
import { getShippingSettings, ShippingSettings } from './settings'

export const EXPRESS_SETTINGS_KEY = 'express_delivery'
const CACHE_TTL_MS = 60 * 1000

/** 快递100 上门取件（线上支付）支持的 9 家，编码即 kuaidicom */
export const EXPRESS_COURIERS = ['shunfeng', 'jd', 'debangkuaidi', 'jtexpress', 'yuantong', 'shentong', 'zhongtong', 'yunda', 'ems'] as const
export type ExpressCourier = (typeof EXPRESS_COURIERS)[number]
export const COURIER_LABEL: Record<string, string> = {
  shunfeng: '顺丰速运', jd: '京东物流', debangkuaidi: '德邦快递', jtexpress: '极兔速递', yuantong: '圆通速递',
  shentong: '申通快递', zhongtong: '中通快递', yunda: '韵达快递', ems: '邮政 EMS',
}

/** 微信 picker mode="region" 的省级全名 */
export const PROVINCE_NAMES = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省', '浙江省',
  '安徽省', '福建省', '江西省', '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市',
  '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省', '青海省', '宁夏回族自治区', '新疆维吾尔自治区',
  '香港特别行政区', '澳门特别行政区', '台湾省',
] as const

export const OTHER_GROUP = '其他'

export interface RegionGroup {
  name: string
  provinces: string[]
  /** 满额包邮门槛（分），按券前商品小计判；0 = 该组不包邮 */
  freeShipMinFen: number
  /** 兜底表：首重 1 kg 价（分） */
  tableFirstFen: number
  /** 兜底表：续重每公斤（分） */
  tableOverPerKgFen: number
  /** 不寄送 */
  blocked: boolean
}

export interface ExpressSettings {
  version: number
  weight: { packagingG: number; defaultItemG: number }
  /** 参与中位数定价的 kuaidicom 列表 */
  pricingPool: string[]
  fee: { mode: 'QUOTE' | 'TABLE'; markupFen: number; roundToFen: number; minQuoteCount: number }
  minOrderAmountFen: number
  regionGroups: RegionGroup[]
  /** 接单后顾客可申请取消的窗口（分钟），0 = 关闭 */
  acceptGraceMin: number
  pickup: { cargoName: string; defaultRemark: string; unacceptedRemindHours: number; unpickedRemindMin: number }
  costAlertRatio: number
}

export const DEFAULT_EXPRESS_SETTINGS: ExpressSettings = {
  version: 0,
  weight: { packagingG: 800, defaultItemG: 300 },
  pricingPool: ['jtexpress', 'yuantong', 'shentong', 'yunda', 'zhongtong', 'jd'],
  fee: { mode: 'QUOTE', markupFen: 0, roundToFen: 50, minQuoteCount: 2 },
  minOrderAmountFen: 0,
  regionGroups: [
    { name: '四川', provinces: ['四川省'], freeShipMinFen: 9900, tableFirstFen: 800, tableOverPerKgFen: 150, blocked: false },
    { name: '周边', provinces: ['重庆市', '云南省', '贵州省', '陕西省', '甘肃省'], freeShipMinFen: 14900, tableFirstFen: 1000, tableOverPerKgFen: 300, blocked: false },
    { name: OTHER_GROUP, provinces: [], freeShipMinFen: 19900, tableFirstFen: 1200, tableOverPerKgFen: 300, blocked: false },
    { name: '不寄送', provinces: ['新疆维吾尔自治区', '西藏自治区', '香港特别行政区', '澳门特别行政区', '台湾省'], freeShipMinFen: 0, tableFirstFen: 0, tableOverPerKgFen: 0, blocked: true },
  ],
  acceptGraceMin: 10,
  pickup: { cargoName: '食品', defaultRemark: '食品请勿重压', unacceptedRemindHours: 4, unpickedRemindMin: 60 },
  costAlertRatio: 1.2,
}

// ── sanitize 小工具（与 local-settings 同款语义：非法一律回落到 fallback）──
const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const int = (v: unknown, fb: number, min = 0, max = Number.MAX_SAFE_INTEGER) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : fb }
const num = (v: unknown, fb: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : fb }
const str = (v: unknown, fb: string, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : fb)
const bool = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
const PROVINCE_SET = new Set<string>(PROVINCE_NAMES)
const COURIER_SET = new Set<string>(EXPRESS_COURIERS)

function sanitizeGroup(raw: unknown): RegionGroup | null {
  const g = asObj(raw)
  const name = str(g.name, '', 16)
  if (!name) return null
  const provinces = Array.isArray(g.provinces) ? g.provinces.filter((p): p is string => typeof p === 'string' && PROVINCE_SET.has(p)) : []
  return {
    name,
    provinces: [...new Set(provinces)],
    freeShipMinFen: int(g.freeShipMinFen, 0, 0, 10_000_000),
    tableFirstFen: int(g.tableFirstFen, 0, 0, 100_000),
    tableOverPerKgFen: int(g.tableOverPerKgFen, 0, 0, 100_000),
    blocked: bool(g.blocked, false),
  }
}

export function sanitizeExpressSettings(raw: unknown): ExpressSettings {
  const o = asObj(raw)
  const D = DEFAULT_EXPRESS_SETTINGS
  const w = asObj(o.weight), fee = asObj(o.fee), pk = asObj(o.pickup)
  const pool = Array.isArray(o.pricingPool) ? o.pricingPool.filter((c): c is string => typeof c === 'string' && COURIER_SET.has(c)) : D.pricingPool
  const groups = Array.isArray(o.regionGroups)
    ? o.regionGroups.map(sanitizeGroup).filter((g): g is RegionGroup => g !== null)
    : D.regionGroups.map((g) => ({ ...g, provinces: [...g.provinces] }))
  return {
    version: int(o.version, 0),
    weight: { packagingG: int(w.packagingG, D.weight.packagingG, 0, 20_000), defaultItemG: int(w.defaultItemG, D.weight.defaultItemG, 1, 20_000) },
    pricingPool: [...new Set(pool)],
    fee: {
      mode: fee.mode === 'TABLE' ? 'TABLE' : 'QUOTE',
      markupFen: int(fee.markupFen, D.fee.markupFen, 0, 100_000),
      roundToFen: int(fee.roundToFen, D.fee.roundToFen, 0, 1000),
      minQuoteCount: int(fee.minQuoteCount, D.fee.minQuoteCount, 1, 9),
    },
    minOrderAmountFen: int(o.minOrderAmountFen, D.minOrderAmountFen, 0, 10_000_000),
    regionGroups: groups,
    acceptGraceMin: int(o.acceptGraceMin, D.acceptGraceMin, 0, 30),
    pickup: {
      cargoName: str(pk.cargoName, D.pickup.cargoName, 16) || D.pickup.cargoName,
      defaultRemark: str(pk.defaultRemark, D.pickup.defaultRemark, 50),
      unacceptedRemindHours: int(pk.unacceptedRemindHours, D.pickup.unacceptedRemindHours, 1, 72),
      unpickedRemindMin: int(pk.unpickedRemindMin, D.pickup.unpickedRemindMin, 10, 1440),
    },
    costAlertRatio: num(o.costAlertRatio, D.costAlertRatio, 1, 5),
  }
}

/** 业务校验（sanitize 之后调用）。返回空数组 = 通过。 */
export function validateExpressSettings(s: ExpressSettings): string[] {
  const errs: string[] = []
  const other = s.regionGroups.find((g) => g.name === OTHER_GROUP)
  if (!other) errs.push(`必须保留名为「${OTHER_GROUP}」的分组（没归组的省份落到它）`)
  else if (other.blocked) errs.push(`「${OTHER_GROUP}」分组不能设为不寄送`)
  const names = new Set<string>()
  for (const g of s.regionGroups) {
    if (names.has(g.name)) errs.push(`分组名重复：${g.name}`)
    names.add(g.name)
  }
  const seen = new Map<string, string>()
  for (const g of s.regionGroups) for (const p of g.provinces) {
    if (seen.has(p)) errs.push(`省份 ${p} 同时属于「${seen.get(p)}」和「${g.name}」`)
    seen.set(p, g.name)
  }
  if (s.pricingPool.length < 2) errs.push('参与定价的快递至少勾选 2 家')
  return errs
}

/** 按省份全名找分组；没归组的落「其他」。 */
export function findRegionGroup(s: ExpressSettings, province: string): RegionGroup {
  const hit = s.regionGroups.find((g) => g.provinces.includes(province))
  if (hit) return hit
  return s.regionGroups.find((g) => g.name === OTHER_GROUP) ?? DEFAULT_EXPRESS_SETTINGS.regionGroups[2]
}

/** 老接口 /orders/meta 与 GET /admin/settings/shipping 的兼容视图：取「其他」组 */
export function legacyShippingView(s: ExpressSettings): ShippingSettings {
  const other = findRegionGroup(s, '')
  return { fee: other.tableFirstFen, freeThreshold: other.freeShipMinFen, minOrderAmount: s.minOrderAmountFen }
}

/**
 * 老接口 PUT /admin/settings/shipping 的兼容写法：一口价 = 全部分组同一张兜底表 + 同一包邮线，且切到 TABLE。
 * 只给 e2e 与过渡期用；新后台页不调它。
 */
export function applyLegacyShipping(s: ExpressSettings, legacy: ShippingSettings): ExpressSettings {
  return {
    ...s,
    fee: { ...s.fee, mode: 'TABLE' },
    minOrderAmountFen: legacy.minOrderAmount,
    regionGroups: s.regionGroups.map((g) => ({ ...g, tableFirstFen: legacy.fee, tableOverPerKgFen: 0, freeShipMinFen: legacy.freeThreshold })),
  }
}

let cached: { value: ExpressSettings; at: number } | null = null

/**
 * 读取。settings 表没有 express_delivery 行时（首次上线），用默认值 + 把旧 shipping 的三个数
 * 迁进「其他」组（fee → tableFirstFen、freeThreshold → freeShipMinFen、minOrderAmount）。
 * 不自动落库——店主第一次在新页面点保存才写入新 key。
 */
export async function getExpressSettings(): Promise<ExpressSettings> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  let value: ExpressSettings
  try {
    const row = await prisma.setting.findUnique({ where: { key: EXPRESS_SETTINGS_KEY } })
    if (row) {
      value = sanitizeExpressSettings(JSON.parse(row.value))
    } else {
      const legacy = await getShippingSettings()
      const base = sanitizeExpressSettings(DEFAULT_EXPRESS_SETTINGS)
      value = {
        ...base,
        minOrderAmountFen: legacy.minOrderAmount,
        regionGroups: base.regionGroups.map((g) => g.name === OTHER_GROUP
          ? { ...g, tableFirstFen: legacy.fee > 0 ? legacy.fee : g.tableFirstFen, freeShipMinFen: legacy.freeThreshold > 0 ? legacy.freeThreshold : g.freeShipMinFen }
          : g),
      }
    }
  } catch (e) {
    console.warn('[express-settings] 读取失败，回退默认值:', (e as Error).message)
    return sanitizeExpressSettings(DEFAULT_EXPRESS_SETTINGS)
  }
  cached = { value, at: Date.now() }
  return value
}

export async function setExpressSettings(next: ExpressSettings): Promise<ExpressSettings> {
  const current = await getExpressSettings()
  const value = sanitizeExpressSettings({ ...next, version: current.version + 1 })
  const json = JSON.stringify(value)
  await prisma.setting.upsert({ where: { key: EXPRESS_SETTINGS_KEY }, create: { key: EXPRESS_SETTINGS_KEY, value: json }, update: { value: json } })
  cached = { value, at: Date.now() }
  return value
}

/** 顶层字段级 patch（嵌套对象整体替换，与 local-settings 同约定） */
export async function patchExpressSettings(patch: Partial<ExpressSettings>): Promise<ExpressSettings> {
  const current = await getExpressSettings()
  return setExpressSettings({ ...current, ...patch })
}

export function clearExpressSettingsCache(): void {
  cached = null
}
```

- [ ] **Step 4: 跑自测与编译**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-settings.ts && npx tsc --noEmit
```
Expected: `通过 7 条`，tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/express-settings.ts apps/server/scripts/selftest-express-settings.ts
git commit -m "邮寄设置：地区分组/定价名单/包装重量/兜底表，含旧一口价迁移"
```

**复核（opus）要点**：`findRegionGroup` 在「其他」组被删除的畸形数据下不抛；`applyLegacyShipping` 不动 `blocked`；`getExpressSettings` 读失败**不写缓存**（同 `settings.ts` 的理由）。

---

### Task 3: 报价纯函数 `express-quote.ts`（重量 / 中位数 / 兜底表 / 指纹 / 凭证）

**Files:**
- Create: `apps/server/src/services/express-quote.ts`
- Test: `apps/server/scripts/selftest-express-quote.ts`

**Interfaces:**
- Produces:
  - `CourierQuote { kuaidicom: string; serviceType: string | null; priceFen: number | null; defPriceFen: number | null }`
  - `calcPackageWeightKg(items: { netWeightG: number | null; quantity: number }[], w: { packagingG: number; defaultItemG: number }): number`（一位小数，向上取到 0.1，最小 0.1）
  - `medianFen(values: number[]): number`
  - `roundUpTo(fen: number, step: number): number`
  - `tableFee(g: RegionGroup, weightKg: number): number`
  - `FeeCalc { feeFen; quotedFeeFen; feeSource: 'QUOTE' | 'TABLE'; freeShip: boolean; belowMin: boolean }`
  - `calcExpressFee(s: ExpressSettings, group: RegionGroup, weightKg: number, quotes: CourierQuote[] | null, subtotalFen: number, locked?: { quotedFeeFen: number } | null): FeeCalc`
  - `itemsHash(lines: { productId: number; skuId: number | null; quantity: number }[], gifts: { pointsGoodId: number; quantity: number }[]): string`（16 位 hex）
  - `ExpressQuotePayload { addressId; itemsHash; weightKg; feeFen; quotedFeeFen; feeSource; groupName; quotes: { kuaidicom; serviceType; priceFen }[] }`
  - `signExpressQuote(p, now?): string`、`verifyExpressQuote(token, now?): ExpressQuotePayload | null`、`expressQuoteExpiresAt(now?): Date`、`EXPRESS_QUOTE_TTL_MS = 15 * 60 * 1000`
- Consumes: `ExpressSettings`、`RegionGroup`（Task 2）；`config.jwt.userSecret`。

- [ ] **Step 1: 写自测（先失败）** `apps/server/scripts/selftest-express-quote.ts`

```ts
/**
 * 邮寄报价纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-express-quote.ts
 */
import assert from 'assert'
import { DEFAULT_EXPRESS_SETTINGS, findRegionGroup, ExpressSettings } from '../src/services/express-settings'
import {
  calcPackageWeightKg, medianFen, roundUpTo, tableFee, calcExpressFee, itemsHash,
  signExpressQuote, verifyExpressQuote, expressQuoteExpiresAt, CourierQuote,
} from '../src/services/express-quote'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}
const S: ExpressSettings = DEFAULT_EXPRESS_SETTINGS
const SC = findRegionGroup(S, '四川省')
const W = { packagingG: 800, defaultItemG: 300 }
// 2026-09-08 实测：自贡→成都 1.5 kg 折后价
const Q: CourierQuote[] = [
  { kuaidicom: 'jtexpress', serviceType: '标准快递', priceFen: 660, defPriceFen: 900 },
  { kuaidicom: 'yuantong', serviceType: '标准快递', priceFen: 690, defPriceFen: 1400 },
  { kuaidicom: 'shentong', serviceType: '标准快递', priceFen: 705, defPriceFen: 1000 },
  { kuaidicom: 'yunda', serviceType: '标准快递', priceFen: 710, defPriceFen: 1300 },
  { kuaidicom: 'zhongtong', serviceType: '标准快递', priceFen: 830, defPriceFen: 1000 },
  { kuaidicom: 'debangkuaidi', serviceType: '标准快递', priceFen: 1110, defPriceFen: 1300 },
  { kuaidicom: 'jd', serviceType: '特惠送', priceFen: 1130, defPriceFen: 1500 },
  { kuaidicom: 'ems', serviceType: '标准快递', priceFen: 1710, defPriceFen: 1400 },
  { kuaidicom: 'shunfeng', serviceType: null, priceFen: null, defPriceFen: null },
]

t('重量：净重×数量 + 包装，向上取 0.1 kg，缺净重用默认', () => {
  assert.strictEqual(calcPackageWeightKg([{ netWeightG: 250, quantity: 2 }], W), 1.3)      // 500+800=1300
  assert.strictEqual(calcPackageWeightKg([{ netWeightG: null, quantity: 1 }], W), 1.1)     // 300+800
  assert.strictEqual(calcPackageWeightKg([{ netWeightG: 333, quantity: 1 }], W), 1.2)      // 1133 → 1.2
  assert.strictEqual(calcPackageWeightKg([], { packagingG: 0, defaultItemG: 300 }), 0.1)   // 最小 0.1
})
t('中位数：奇数取中间，偶数取中间两家均值（四舍五入到分）', () => {
  assert.strictEqual(medianFen([660, 690, 705]), 690)
  assert.strictEqual(medianFen([660, 690, 705, 710]), 698)  // (690+705)/2=697.5 → 698
  assert.strictEqual(medianFen([1130]), 1130)
})
t('向上取整：0 不取整，50 取五毛，整数不动', () => {
  assert.strictEqual(roundUpTo(833, 0), 833)
  assert.strictEqual(roundUpTo(833, 50), 850)
  assert.strictEqual(roundUpTo(850, 50), 850)
})
t('兜底表：首重 1 kg，续重按公斤向上取整', () => {
  const g = { ...SC, tableFirstFen: 800, tableOverPerKgFen: 150 }
  assert.strictEqual(tableFee(g, 0.5), 800)
  assert.strictEqual(tableFee(g, 1), 800)
  assert.strictEqual(tableFee(g, 1.5), 950)
  assert.strictEqual(tableFee(g, 3), 1100)
})
t('QUOTE：只用定价名单里的 6 家取中位数 → (705+710)/2=708 → 取五毛 750', () => {
  const r = calcExpressFee(S, SC, 1.5, Q, 5000)
  assert.strictEqual(r.feeSource, 'QUOTE'); assert.strictEqual(r.quotedFeeFen, 750); assert.strictEqual(r.feeFen, 750)
  assert.strictEqual(r.freeShip, false); assert.strictEqual(r.belowMin, false)
})
t('QUOTE：加价与不取整生效', () => {
  const s2 = { ...S, fee: { ...S.fee, markupFen: 100, roundToFen: 0 } }
  assert.strictEqual(calcExpressFee(s2, SC, 1.5, Q, 5000).quotedFeeFen, 808)
})
t('回价不足 minQuoteCount → TABLE；quotes 为 null → TABLE；mode=TABLE 无视报价', () => {
  const one = Q.filter((q) => q.kuaidicom === 'jd')
  assert.strictEqual(calcExpressFee(S, SC, 1.5, one, 5000).feeSource, 'TABLE')
  assert.strictEqual(calcExpressFee(S, SC, 1.5, null, 5000).feeSource, 'TABLE')
  assert.strictEqual(calcExpressFee(S, SC, 1.5, null, 5000).quotedFeeFen, tableFee(SC, 1.5))
  const s3 = { ...S, fee: { ...S.fee, mode: 'TABLE' as const } }
  assert.strictEqual(calcExpressFee(s3, SC, 1.5, Q, 5000).feeSource, 'TABLE')
})
t('包邮：达到该组门槛运费归零但 quotedFeeFen 保留；起送：belowMin', () => {
  const r = calcExpressFee(S, SC, 1.5, Q, 9900)
  assert.strictEqual(r.feeFen, 0); assert.strictEqual(r.quotedFeeFen, 750); assert.strictEqual(r.freeShip, true)
  const s4 = { ...S, minOrderAmountFen: 3000 }
  assert.strictEqual(calcExpressFee(s4, SC, 1.5, Q, 2999).belowMin, true)
  assert.strictEqual(calcExpressFee(s4, SC, 1.5, Q, 3000).belowMin, false)
})
t('锁价：传 locked 时不看 quotes、不重取中位数，但包邮仍按当前设置判', () => {
  const r = calcExpressFee(S, SC, 1.5, null, 5000, { quotedFeeFen: 750 })
  assert.strictEqual(r.feeSource, 'QUOTE'); assert.strictEqual(r.feeFen, 750)
  assert.strictEqual(calcExpressFee(S, SC, 1.5, null, 9900, { quotedFeeFen: 750 }).feeFen, 0)
})
t('指纹：与顺序无关、数量/规格/赠品任一变都不同', () => {
  const a = itemsHash([{ productId: 1, skuId: null, quantity: 2 }, { productId: 2, skuId: 5, quantity: 1 }], [])
  const b = itemsHash([{ productId: 2, skuId: 5, quantity: 1 }, { productId: 1, skuId: null, quantity: 2 }], [])
  assert.strictEqual(a, b); assert.match(a, /^[0-9a-f]{16}$/)
  assert.notStrictEqual(a, itemsHash([{ productId: 1, skuId: null, quantity: 3 }, { productId: 2, skuId: 5, quantity: 1 }], []))
  assert.notStrictEqual(a, itemsHash([{ productId: 1, skuId: 9, quantity: 2 }, { productId: 2, skuId: 5, quantity: 1 }], []))
  assert.notStrictEqual(a, itemsHash([{ productId: 1, skuId: null, quantity: 2 }, { productId: 2, skuId: 5, quantity: 1 }], [{ pointsGoodId: 3, quantity: 1 }]))
})
t('凭证：签验往返、过期、篡改、旧格式缺字段都判无效', () => {
  const p = { addressId: 7, itemsHash: 'abcdef0123456789', weightKg: 1.5, feeFen: 750, quotedFeeFen: 750, feeSource: 'QUOTE' as const, groupName: '四川', quotes: Q.map((q) => ({ kuaidicom: q.kuaidicom, serviceType: q.serviceType, priceFen: q.priceFen })) }
  const now = new Date('2026-09-08T04:00:00Z')
  const tok = signExpressQuote(p, now)
  assert.ok(tok.length < 1024, `token 太长 ${tok.length}`)
  assert.deepStrictEqual(verifyExpressQuote(tok, now), p)
  assert.strictEqual(verifyExpressQuote(tok, new Date(now.getTime() + 15 * 60 * 1000 + 1)), null)
  const [body, sig] = tok.split('.')
  assert.strictEqual(verifyExpressQuote(`${body}x.${sig}`, now), null)
  assert.strictEqual(verifyExpressQuote(`${body}.${sig.slice(0, 31)}0`, now), null)
  assert.strictEqual(verifyExpressQuote('中文.中文', now), null)
  assert.strictEqual(expressQuoteExpiresAt(now).getTime(), now.getTime() + 15 * 60 * 1000)
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
```

- [ ] **Step 2: 跑，确认模块不存在而失败**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-quote.ts
```
Expected: `Cannot find module '../src/services/express-quote'`

- [ ] **Step 3: 新建 `express-quote.ts`**

```ts
/**
 * 邮寄运费的全部纯计算（不碰 DB、不外呼）。小程序只展示 /express/quote 的结果，不复刻。
 * 设计：spec §3。中位数只对 settings.pricingPool 里的家算；快照可以带全部 9 家。
 */
import crypto from 'crypto'
import { config } from '../config'
import { ExpressSettings, RegionGroup } from './express-settings'

export const EXPRESS_QUOTE_TTL_MS = 15 * 60 * 1000

export interface CourierQuote {
  kuaidicom: string
  serviceType: string | null
  /** 折后总价（分）；null = 该家这条线路没报价 */
  priceFen: number | null
  /** 标准价（分） */
  defPriceFen: number | null
}

/** 重量 = Σ(净重 ?? 默认净重) × 数量 + 每单包装；向上取到 0.1 kg，最小 0.1 */
export function calcPackageWeightKg(items: { netWeightG: number | null; quantity: number }[], w: { packagingG: number; defaultItemG: number }): number {
  const grams = items.reduce((sum, i) => sum + (i.netWeightG ?? w.defaultItemG) * i.quantity, 0) + w.packagingG
  return Math.max(0.1, Math.ceil(grams / 100) / 10)
}

export function medianFen(values: number[]): number {
  const a = [...values].sort((x, y) => x - y)
  const n = a.length
  if (n === 0) return 0
  return n % 2 === 1 ? a[(n - 1) / 2] : Math.round((a[n / 2 - 1] + a[n / 2]) / 2)
}

export function roundUpTo(fen: number, step: number): number {
  if (step <= 0) return fen
  return Math.ceil(fen / step) * step
}

/** 兜底表：首重 1 kg + 续重按整公斤向上取整 */
export function tableFee(g: RegionGroup, weightKg: number): number {
  return g.tableFirstFen + g.tableOverPerKgFen * Math.max(0, Math.ceil(weightKg) - 1)
}

export interface FeeCalc {
  /** 实收（包邮则 0） */
  feeFen: number
  /** 未包邮时的报价（成本展示与凭证锁价用） */
  quotedFeeFen: number
  feeSource: 'QUOTE' | 'TABLE'
  freeShip: boolean
  belowMin: boolean
}

/**
 * 算运费。`locked` 传了就是「信凭证里签的报价」（QUOTE 锁价 15 分钟，与同城一致），
 * 此时 quotes 被忽略；包邮/起送永远按**当前**设置与**真实**小计判。
 */
export function calcExpressFee(
  s: ExpressSettings, group: RegionGroup, weightKg: number, quotes: CourierQuote[] | null, subtotalFen: number,
  locked?: { quotedFeeFen: number } | null,
): FeeCalc {
  let quotedFeeFen: number
  let feeSource: 'QUOTE' | 'TABLE'
  if (locked) {
    quotedFeeFen = locked.quotedFeeFen; feeSource = 'QUOTE'
  } else {
    const pool = new Set(s.pricingPool)
    const valid = (quotes ?? []).filter((q) => pool.has(q.kuaidicom) && q.priceFen !== null).map((q) => q.priceFen as number)
    if (s.fee.mode === 'QUOTE' && valid.length >= s.fee.minQuoteCount) {
      quotedFeeFen = roundUpTo(medianFen(valid) + s.fee.markupFen, s.fee.roundToFen); feeSource = 'QUOTE'
    } else {
      quotedFeeFen = tableFee(group, weightKg); feeSource = 'TABLE'
    }
  }
  const freeShip = group.freeShipMinFen > 0 && subtotalFen >= group.freeShipMinFen
  const belowMin = s.minOrderAmountFen > 0 && subtotalFen < s.minOrderAmountFen
  return { feeFen: freeShip ? 0 : quotedFeeFen, quotedFeeFen, feeSource, freeShip, belowMin }
}

/** 商品清单指纹：凭证只能用在它报价时的那一份清单上（数量、规格、赠品任一变都作废） */
export function itemsHash(lines: { productId: number; skuId: number | null; quantity: number }[], gifts: { pointsGoodId: number; quantity: number }[]): string {
  const parts = [
    ...lines.map((l) => `p${l.productId}:${l.skuId ?? 0}:${l.quantity}`),
    ...gifts.map((g) => `g${g.pointsGoodId}:${g.quantity}`),
  ].sort()
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16)
}

export interface ExpressQuotePayload {
  addressId: number
  itemsHash: string
  weightKg: number
  feeFen: number
  quotedFeeFen: number
  feeSource: 'QUOTE' | 'TABLE'
  groupName: string
  quotes: { kuaidicom: string; serviceType: string | null; priceFen: number | null }[]
}

export function expressQuoteExpiresAt(now: Date = new Date()): Date {
  return new Date(now.getTime() + EXPRESS_QUOTE_TTL_MS)
}
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const hmac = (s: string) => crypto.createHmac('sha256', `express-quote:${config.jwt.userSecret}`).update(s).digest('hex').slice(0, 32)

export function signExpressQuote(p: ExpressQuotePayload, now: Date = new Date()): string {
  const body = b64u(JSON.stringify({
    a: p.addressId, h: p.itemsHash, w: Math.round(p.weightKg * 10), f: p.feeFen, qf: p.quotedFeeFen, fs: p.feeSource, g: p.groupName,
    q: p.quotes.map((q) => [q.kuaidicom, q.serviceType, q.priceFen]),
    e: expressQuoteExpiresAt(now).getTime(),
  }))
  return `${body}.${hmac(body)}`
}

export function verifyExpressQuote(token: string, now: Date = new Date()): ExpressQuotePayload | null {
  const [body, sig] = token.split('.')
  // 与 local-settings.verifyQuote 同款：先用字符集卡死 sig 形状，timingSafeEqual 才不会因长度不等抛 RangeError
  if (!body || !sig || !/^[0-9a-f]{32}$/.test(sig)) return null
  try {
    if (!crypto.timingSafeEqual(Buffer.from(hmac(body)), Buffer.from(sig))) return null
  } catch { return null }
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof o.e !== 'number' || o.e < now.getTime()) return null
    if ([o.a, o.w, o.f, o.qf].some((n) => typeof n !== 'number' || !Number.isFinite(n))) return null
    if (typeof o.h !== 'string' || !/^[0-9a-f]{16}$/.test(o.h)) return null
    if (o.fs !== 'QUOTE' && o.fs !== 'TABLE') return null
    if (typeof o.g !== 'string' || !Array.isArray(o.q)) return null
    const quotes: ExpressQuotePayload['quotes'] = []
    for (const row of o.q) {
      if (!Array.isArray(row) || row.length !== 3 || typeof row[0] !== 'string') return null
      if (row[1] !== null && typeof row[1] !== 'string') return null
      if (row[2] !== null && (typeof row[2] !== 'number' || !Number.isFinite(row[2]))) return null
      quotes.push({ kuaidicom: row[0], serviceType: row[1], priceFen: row[2] })
    }
    return { addressId: o.a, itemsHash: o.h, weightKg: o.w / 10, feeFen: o.f, quotedFeeFen: o.qf, feeSource: o.fs, groupName: o.g, quotes }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 跑自测与编译**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-express-quote.ts && npx tsc --noEmit
```
Expected: `通过 11 条`，tsc 无输出。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/services/express-quote.ts apps/server/scripts/selftest-express-quote.ts
git commit -m "邮寄报价纯函数：包装重量、定价名单中位数、兜底表、分组包邮、清单指纹与凭证"
```

**复核（opus）要点**：中位数偶数取整方向（`Math.round` 半上）；`pool` 过滤发生在中位数之前而不是之后；凭证 `w` 用 ×10 整数避免浮点；`verifyExpressQuote` 对任何畸形输入都返回 null 而不是抛。

---

### Task 4: 快递100 上门取件查价 `kd100-express.ts` + mock + 配置

**Files:**
- Modify: `apps/server/src/config.ts`（envSchema、生产 mock 守卫列表、`config.mock`、新增 `config.kd100Express`、`validateKd100ExpressConfig`）
- Create: `apps/server/src/services/delivery/kd100-express.ts`
- Create: `apps/server/src/services/delivery/express-mock.ts`
- Create: `apps/server/src/routes/admin/express-mock.ts`
- Modify: `apps/server/src/routes/admin/index.ts:18,40`（挂载）
- Test: `apps/server/scripts/selftest-kd100-express.ts`

**Interfaces:**
- Produces:
  - `config.kd100Express: { apiUrl: string; key: string; secret: string }`、`config.mock.express: boolean`、`validateKd100ExpressConfig(): void`
  - `ExpressBatchPriceInput { couriers: string[]; senderAddr: string; receiverAddr: string; weightKg: number; timeoutMs?: number }`
  - `ExpressPriceProvider { name: 'KD100' | 'MOCK'; batchPrice(input: ExpressBatchPriceInput): Promise<CourierQuote[]> }`
  - `getExpressProvider(): ExpressPriceProvider`
  - `_buildBatchPriceParam(input)`、`_parseBatchPrice(data: unknown): CourierQuote[]`、`_mapExpressReturnCode(code, message?)`
  - mock：`queueExpressDirective(d)`、`getExpressCalls()`、`resetExpressMock()`、`ExpressMockDirective = { kind: 'ok'; quotes?: CourierQuote[] } | { kind: 'timeout' } | { kind: 'error'; code: string; message?: string }`
- Consumes: `postKd100`（Task 1）、`CourierQuote`（Task 3）、`EXPRESS_COURIERS`（Task 2）。

- [ ] **Step 1: 写自测（先失败）** `apps/server/scripts/selftest-kd100-express.ts`

```ts
/**
 * 快递100 上门取件协议自测（离线）：cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100-express.ts
 */
import assert from 'assert'
import { _buildBatchPriceParam, _parseBatchPrice, _mapExpressReturnCode } from '../src/services/delivery/kd100-express'
import { queueExpressDirective, resetExpressMock, expressMockProvider, getExpressCalls } from '../src/services/delivery/express-mock'
import { ProviderError } from '../src/services/delivery/types'

let pass = 0
function t(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ✔', name) }, (e) => { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 })
}

async function main() {
  await t('batchPrice param：编码数组、两端地址、重量一位小数', () => {
    const p = _buildBatchPriceParam({ couriers: ['jd', 'shunfeng'], senderAddr: '四川省自贡市A', receiverAddr: '北京市B', weightKg: 1.5 })
    assert.deepStrictEqual(p, { kuaidiComList: ['jd', 'shunfeng'], sendManPrintAddr: '四川省自贡市A', recManPrintAddr: '北京市B', weight: '1.5' })
  })
  await t('解析响应：元→分、null 保留、缺字段兜底', () => {
    const q = _parseBatchPrice([
      { kuaidiCom: 'jd', price: '11.30', defPrice: '15.00', serviceType: '特惠送' },
      { kuaidiCom: 'shunfeng', price: null, defPrice: null, serviceType: null },
      { kuaidiCom: '', price: '1.00' },
    ])
    assert.deepStrictEqual(q, [
      { kuaidicom: 'jd', serviceType: '特惠送', priceFen: 1130, defPriceFen: 1500 },
      { kuaidicom: 'shunfeng', serviceType: null, priceFen: null, defPriceFen: null },
    ])
    assert.deepStrictEqual(_parseBatchPrice('garbage'), [])
  })
  await t('错误码映射：503/600/601 → CONFIG，余额 → BALANCE，其余 BUSINESS', () => {
    assert.strictEqual(_mapExpressReturnCode('503'), 'CONFIG')
    assert.strictEqual(_mapExpressReturnCode('600'), 'CONFIG')
    assert.strictEqual(_mapExpressReturnCode('601'), 'CONFIG')
    assert.strictEqual(_mapExpressReturnCode('500', '账户余额不足'), 'BALANCE')
    assert.strictEqual(_mapExpressReturnCode('500', '当前线路未设置价格'), 'BUSINESS')
    assert.strictEqual(_mapExpressReturnCode('400'), 'BUSINESS')
  })
  await t('mock：默认按 9 家固定表回价，重量续重生效，记录调用', async () => {
    resetExpressMock()
    const q = await expressMockProvider.batchPrice({ couriers: ['jtexpress', 'jd', 'shunfeng'], senderAddr: 'a', receiverAddr: 'b', weightKg: 1.5 })
    assert.deepStrictEqual(q.map((x) => [x.kuaidicom, x.priceFen]), [['jtexpress', 660 + 130], ['jd', 1130 + 130], ['shunfeng', null]])
    assert.strictEqual(getExpressCalls().length, 1)
  })
  await t('mock：指令 ok/timeout/error 各生效一次后回默认', async () => {
    resetExpressMock()
    queueExpressDirective({ kind: 'ok', quotes: [{ kuaidicom: 'jd', serviceType: '特惠送', priceFen: 999, defPriceFen: 1500 }] })
    queueExpressDirective({ kind: 'timeout' })
    queueExpressDirective({ kind: 'error', code: '600', message: '非法用户' })
    const i = { couriers: ['jd'], senderAddr: 'a', receiverAddr: 'b', weightKg: 1 }
    assert.strictEqual((await expressMockProvider.batchPrice(i))[0].priceFen, 999)
    await assert.rejects(() => expressMockProvider.batchPrice(i), (e: unknown) => e instanceof ProviderError && e.kind === 'TIMEOUT')
    await assert.rejects(() => expressMockProvider.batchPrice(i), (e: unknown) => e instanceof ProviderError && e.kind === 'CONFIG' && e.code === '600')
    assert.strictEqual((await expressMockProvider.batchPrice(i))[0].priceFen, 1130)
  })
  console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
}
main()
```

- [ ] **Step 2: 跑，确认因模块不存在而失败**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100-express.ts
```
Expected: `Cannot find module '../src/services/delivery/kd100-express'`

- [ ] **Step 3: 改 `config.ts`**

envSchema 里紧接 `LOCAL_DELIVERY_PROVIDER_MOCK` 之后加：
```ts
  // 快递100 上门取件（全国邮寄）。key/secret 缺省复用同城那一对（同一企业账号）；测试环境时三项都填
  KD100_EXPRESS_API_URL: z.string().optional(),
  KD100_EXPRESS_KEY: z.string().optional(),
  KD100_EXPRESS_SECRET: z.string().optional(),
  // 邮寄查价 mock（生产开启拒绝启动）
  EXPRESS_PROVIDER_MOCK: z.string().optional(),
```
生产 mock 守卫 `enabledMocks` 数组里加一行：
```ts
      ['EXPRESS_PROVIDER_MOCK', env.EXPRESS_PROVIDER_MOCK],
```
`config.mock` 里加：
```ts
    express: env.EXPRESS_PROVIDER_MOCK === 'true',
```
`config.kd100` 之后加：
```ts
  kd100Express: {
    apiUrl: (env.KD100_EXPRESS_API_URL ?? 'https://poll.kuaidi100.com/order/borderapi.do').trim(),
    key: env.KD100_EXPRESS_KEY ?? env.KD100_KEY ?? '',
    secret: env.KD100_EXPRESS_SECRET ?? env.KD100_SECRET ?? '',
  },
```
`validateKd100Config` 之后加：
```ts
/** 邮寄查价/下单前的懒校验：mock 模式不需要真密钥 */
export function validateKd100ExpressConfig(): void {
  if (config.mock.express) return
  if (!config.kd100Express.key || !config.kd100Express.secret) {
    throw new Error('Missing required env var: KD100_KEY / KD100_SECRET（或 KD100_EXPRESS_KEY / KD100_EXPRESS_SECRET）')
  }
}
```

- [ ] **Step 4: 新建 `kd100-express.ts`**

```ts
/**
 * 快递100「上门取件 API（线上支付）」协议实现。批次一只有 batchPrice；下单/取消/查单在批次二加。
 * 事实来源 docs/research/2026-09-08-kuaidi100-merchant-shipping-api.md：
 *  - POST https://poll.kuaidi100.com/order/borderapi.do，form；sign 与同城同公式
 *  - batchPrice：{ kuaidiComList, sendManPrintAddr, recManPrintAddr, weight }，响应 data 是数组，
 *    每项 { kuaidiCom, price, defPrice, serviceType, firstPrice, overPrice, ... }，没价的家 price=null
 *  - 错误码 400 参数 / 503 签名 / 600 非法用户 / 601 key 过期；业务失败走 500 + message 原话
 */
import { config, validateKd100ExpressConfig } from '../../config'
import { postKd100 } from './kd100-client'
import { ProviderErrorKind } from './types'
import { CourierQuote } from '../express-quote'
import { expressMockProvider } from './express-mock'

export interface ExpressBatchPriceInput {
  couriers: string[]
  senderAddr: string
  receiverAddr: string
  weightKg: number
  timeoutMs?: number
}
export interface ExpressPriceProvider {
  name: 'KD100' | 'MOCK'
  batchPrice(input: ExpressBatchPriceInput): Promise<CourierQuote[]>
}

const DEFAULT_TIMEOUT_MS = 8000

export function _mapExpressReturnCode(code: number | string, message = ''): ProviderErrorKind {
  const c = String(code)
  if (c === '503' || c === '600' || c === '601') return 'CONFIG'
  if (/余额/.test(message)) return 'BALANCE'
  return 'BUSINESS'
}

export function _buildBatchPriceParam(i: ExpressBatchPriceInput): Record<string, unknown> {
  return { kuaidiComList: i.couriers, sendManPrintAddr: i.senderAddr, recManPrintAddr: i.receiverAddr, weight: i.weightKg.toFixed(1) }
}

const yuanToFen = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null
}

export function _parseBatchPrice(data: unknown): CourierQuote[] {
  if (!Array.isArray(data)) return []
  const out: CourierQuote[] = []
  for (const row of data) {
    const r = (row ?? {}) as Record<string, unknown>
    const code = String(r.kuaidiCom ?? r.kuaidicom ?? '').trim()
    if (!code) continue
    out.push({
      kuaidicom: code,
      serviceType: typeof r.serviceType === 'string' && r.serviceType ? r.serviceType : null,
      priceFen: yuanToFen(r.price),
      defPriceFen: yuanToFen(r.defPrice),
    })
  }
  return out
}

export const kd100ExpressProvider: ExpressPriceProvider = {
  name: 'KD100',
  async batchPrice(input) {
    validateKd100ExpressConfig()
    const data = await postKd100({
      url: config.kd100Express.apiUrl, method: 'batchPrice', param: _buildBatchPriceParam(input),
      key: config.kd100Express.key, secret: config.kd100Express.secret,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      mapReturnCode: (code, message) => _mapExpressReturnCode(code, message),
    })
    return _parseBatchPrice(data.data)
  },
}

export function getExpressProvider(): ExpressPriceProvider {
  return config.mock.express ? expressMockProvider : kd100ExpressProvider
}
```
注意：`postKd100` 把 `message` 丢给 `mapReturnCode` 之前拿不到——为了让「余额」映射生效，把 `kd100-client.ts` 的 `mapReturnCode` 签名改成 `(code: number | string, message?: string) => ProviderErrorKind`，调用处传 `o.mapReturnCode(code ?? res.status, data.message)`；同城的 `_mapReturnCode(code)` 多收一个参数不影响。

- [ ] **Step 5: 新建 `express-mock.ts`**

```ts
/**
 * 邮寄查价 mock（EXPRESS_PROVIDER_MOCK=true）。零 setTimeout，靠指令队列驱动；不排指令时按固定表回价。
 * 固定表 = 2026-09-08 实测自贡→成都 1.5 kg 折后首重价；续重每公斤一律 +¥1.30，让「重量影响报价」可断言。
 */
import { ProviderError } from './types'
import { CourierQuote } from '../express-quote'
import type { ExpressPriceProvider, ExpressBatchPriceInput } from './kd100-express'

export type ExpressMockDirective =
  | { kind: 'ok'; quotes?: CourierQuote[] }
  | { kind: 'timeout' }
  | { kind: 'error'; code: string; message?: string }

const FIRST_FEN: Record<string, number | null> = {
  jtexpress: 660, yuantong: 690, shentong: 705, yunda: 710, zhongtong: 830, debangkuaidi: 1110, jd: 1130, ems: 1710, shunfeng: null,
}
const OVER_PER_KG_FEN = 130
const SERVICE: Record<string, string> = { jd: '特惠送' }

const queue: ExpressMockDirective[] = []
const calls: { input: ExpressBatchPriceInput; at: string }[] = []

export function queueExpressDirective(d: ExpressMockDirective): void { queue.push(d) }
export function getExpressCalls() { return [...calls] }
export function resetExpressMock(): void { queue.length = 0; calls.length = 0 }

function defaultQuotes(i: ExpressBatchPriceInput): CourierQuote[] {
  const over = Math.max(0, Math.ceil(i.weightKg) - 1) * OVER_PER_KG_FEN
  return i.couriers.map((c) => {
    const first = FIRST_FEN[c] ?? null
    return { kuaidicom: c, serviceType: first === null ? null : (SERVICE[c] ?? '标准快递'), priceFen: first === null ? null : first + over, defPriceFen: first === null ? null : first + over + 300 }
  })
}

export const expressMockProvider: ExpressPriceProvider = {
  name: 'MOCK',
  async batchPrice(input) {
    calls.push({ input, at: new Date().toISOString() })
    const d = queue.shift() ?? { kind: 'ok' as const }
    if (d.kind === 'timeout') throw new ProviderError('TIMEOUT', 'TIMEOUT', 'mock 超时')
    if (d.kind === 'error') throw new ProviderError(d.code === '503' || d.code === '600' || d.code === '601' ? 'CONFIG' : /余额/.test(d.message ?? '') ? 'BALANCE' : 'BUSINESS', d.code, d.message ?? 'mock 错误')
    return d.quotes ?? defaultQuotes(input)
  },
}
```
（`kd100-express.ts` 与 `express-mock.ts` 互相 import：mock 用 `import type` 只取类型，不会形成运行时环。）

- [ ] **Step 6: 新建 `routes/admin/express-mock.ts` 并挂载**

```ts
import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { queueExpressDirective, getExpressCalls, resetExpressMock, ExpressMockDirective } from '../../services/delivery/express-mock'
import { clearExpressQuoteCache } from '../../services/express-quote-service'

const router = Router()

// POST /api/admin/system/express-mock/reset — 清指令队列 + 调用记录 + 服务端报价缓存
router.post('/reset', async (_req: Request, res: Response, next: NextFunction) => {
  try { resetExpressMock(); clearExpressQuoteCache(); success(res, {}) } catch (e) { next(e) }
})
// POST /api/admin/system/express-mock/queue — { directive }
router.post('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const d = (req.body ?? {}).directive as ExpressMockDirective | undefined
    if (!d || !['ok', 'timeout', 'error'].includes(d.kind)) throw new AppError(40000, '无效指令', 400)
    queueExpressDirective(d); success(res, {})
  } catch (e) { next(e) }
})
// GET /api/admin/system/express-mock/calls
router.get('/calls', async (_req: Request, res: Response, next: NextFunction) => {
  try { success(res, getExpressCalls()) } catch (e) { next(e) }
})
export default router
```
`clearExpressQuoteCache` 在 Task 6 才实现——本任务先在 `services/express-quote-service.ts` 建一个只含它的占位文件：
```ts
const cache = new Map<string, { quotes: unknown; at: number }>()
export function clearExpressQuoteCache(): void { cache.clear() }
export const _quoteCache = cache
```
（Task 6 会把这个文件写全，保留这两个导出名。）

`routes/admin/index.ts`：在 `import kd100MockRouter from './kd100-mock'` 下加 `import expressMockRouter from './express-mock'`；在 `if (config.mock.delivery) router.use('/system/kd100-mock', kd100MockRouter)` 下加 `if (config.mock.express) router.use('/system/express-mock', expressMockRouter)`。

- [ ] **Step 7: 跑自测与编译**

```bash
cd apps/server && npx ts-node --transpile-only scripts/selftest-kd100-express.ts && npx ts-node --transpile-only scripts/selftest-kd100.ts && npx tsc --noEmit
```
Expected: 新自测 `通过 5 条`；同城自测仍全 ✔；tsc 无输出。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/config.ts apps/server/src/services/delivery/kd100-express.ts apps/server/src/services/delivery/express-mock.ts apps/server/src/services/delivery/kd100-client.ts apps/server/src/services/express-quote-service.ts apps/server/src/routes/admin/express-mock.ts apps/server/src/routes/admin/index.ts apps/server/scripts/selftest-kd100-express.ts
git commit -m "快递100 上门取件 batchPrice 协议 + 邮寄查价 mock + 配置开关"
```

**复核（opus）要点**：`config.kd100Express.key` 缺省回退到同城 key（同一企业账号）；生产 mock 守卫多了一项；`_parseBatchPrice` 对 `price: ""` 与 `null` 都给 null；mock 的 `error` 分支 kind 判定与真实 `_mapExpressReturnCode` 一致。

---

### Task 5: 抽出「组装下单行」到 `order-lines.ts`（无行为变化）

**Files:**
- Create: `apps/server/src/services/order-lines.ts`
- Modify: `apps/server/src/routes/orders.ts:120-215`（`OrderLine` 接口、组装块、校验循环）

**Interfaces:**
- Produces: `OrderLine`（原样搬）、`DirectItemInput { productId: number; skuId?: number; quantity: number }`、`loadOrderLines(userId: number, src: { cartItemIds?: number[]; directItem?: DirectItemInput }): Promise<OrderLine[]>`、`assertLinesSellable(lines: OrderLine[], channel: 'EXPRESS' | 'LOCAL'): void`。
- Consumes: `prisma`、`AppError`、`Prisma` 类型。

- [ ] **Step 1: 新建 `order-lines.ts`（从 orders.ts 逐字搬，只改缩进与函数壳）**

```ts
/**
 * 下单行的组装与可售校验。从 routes/orders.ts 抽出（2026-09-08），供下单与邮寄报价共用：
 * 报价必须按**同一份**清单算重量，否则凭证里的指纹对不上。搬出来时逻辑一字未改。
 */
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'

export interface OrderLine {
  productId: number
  skuId: number | null
  quantity: number
  product: Prisma.ProductGetPayload<Record<string, never>>
  sku: Prisma.ProductSkuGetPayload<Record<string, never>> | null
}
export interface DirectItemInput { productId: number; skuId?: number; quantity: number }

/** 购物车项 或 立即购买单品（不经购物车，避免与已加购数量合并）——二选一 */
export async function loadOrderLines(userId: number, src: { cartItemIds?: number[]; directItem?: DirectItemInput }): Promise<OrderLine[]> {
  if (src.cartItemIds) {
    const cartItems = await prisma.cart.findMany({
      where: { id: { in: src.cartItemIds }, userId },
      include: { product: true, sku: true },
    })
    if (cartItems.length === 0) throw new AppError(40001, '购物车商品不存在或不属于当前用户')
    return cartItems.map((c) => ({ productId: c.productId, skuId: c.skuId, quantity: c.quantity, product: c.product, sku: c.sku }))
  }
  const item = src.directItem
  if (!item) throw new AppError(40001, '请选择商品')
  const product = await prisma.product.findFirst({ where: { id: item.productId, deletedAt: null }, include: { skus: true } })
  if (!product) throw new AppError(40401, '商品不存在')
  let sku: OrderLine['sku'] = null
  if (product.skus.length > 0) {
    if (!item.skuId) throw new AppError(40001, '请选择商品规格')
    sku = product.skus.find((s) => s.id === item.skuId) ?? null
    if (!sku) throw new AppError(40401, '商品规格不存在', 404)
  } else if (item.skuId) {
    throw new AppError(40001, '该商品无规格')
  }
  const { skus: _skus, ...plain } = product
  return [{ productId: product.id, skuId: sku?.id ?? null, quantity: item.quantity, product: plain, sku }]
}

/** 逐个验证商品（有 SKU 的行按 SKU 库存校验）——与下单时的判定完全一致 */
export function assertLinesSellable(lines: OrderLine[], channel: 'EXPRESS' | 'LOCAL'): void {
  for (const line of lines) {
    const p = line.product
    if (!p || p.deletedAt) throw new AppError(40401, '商品不存在')
    if (p.channel !== channel) {
      throw new AppError(42224, channel === 'LOCAL' ? `${p.name} 不是同城配送商品` : `${p.name} 是同城配送商品，请到同城页面下单`)
    }
    if (p.status !== 'ON_SHELF') throw new AppError(42202, `${p.name} 已下架`)
    if (line.skuId && !line.sku) throw new AppError(40401, `${p.name} 所选规格已失效`)
    const stock = line.sku?.stock ?? p.stock
    const label = line.sku ? `${p.name}（${line.sku.specText}）` : p.name
    if (stock < line.quantity) throw new AppError(42201, `${label} 库存不足（剩余 ${stock}）`)
  }
}
```

- [ ] **Step 2: 改 `orders.ts`**

删掉文件内的 `interface OrderLine {...}`，顶部加 `import { loadOrderLines, assertLinesSellable, OrderLine } from '../services/order-lines'`（若 `OrderLine` 在文件其它处不再用到就不导入）。把「1. 组装下单行」整块（`let lines: OrderLine[]` 到 `lines = [{ ... }]` 结束的 `}`）替换为：
```ts
    // 1. 组装下单行（购物车项 或 立即购买单品）——与邮寄报价共用同一份逻辑，见 services/order-lines.ts
    const lines = await loadOrderLines(userId, { cartItemIds, directItem })
```
把「2. 逐个验证商品」的 `for (const line of lines) { ... }` 循环替换为：
```ts
    // 2. 逐个验证商品（有 SKU 的行按 SKU 库存校验）
    const channel = channelOfDeliveryType(deliveryType)
    assertLinesSellable(lines, channel)
```
（`const channel = ...` 那一行原本就在循环前，保留一份即可。）

- [ ] **Step 3: 编译 + 跑一遍主 e2e 的下单相关段**

```bash
cd apps/server && npx tsc --noEmit
```
Expected: 无输出。
然后按 `docs/e2e-fresh-db-recipe`（记忆）或 `scripts/e2e.sh` 头注释启动 mock 后端并跑：
```bash
DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -3
```
Expected: `通过 N / 失败 0`，N 与改前一致（改前先跑一次记下 N）。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/services/order-lines.ts apps/server/src/routes/orders.ts
git commit -m "下单行组装与可售校验抽到 services/order-lines，供邮寄报价复用（无行为变化）"
```

**复核（opus）要点**：diff 里 `orders.ts` 删掉的每一行都能在 `order-lines.ts` 找到对应；错误码与文案逐字一致；`_skus` 解构未丢。

---

### Task 6: 报价编排 `express-quote-service.ts` + `POST /api/express/quote` + e2e

**Files:**
- Modify: `apps/server/src/services/express-quote-service.ts`（Task 4 的占位文件写全）
- Create: `apps/server/src/routes/express.ts`
- Modify: `apps/server/src/middlewares/rate-limit.ts`（紧接 `localQuoteLimiter` 之后加 `expressQuoteLimiter`）
- Modify: `apps/server/src/routes/index.ts`（挂载）
- Modify: `scripts/e2e.sh:57`（管理员登录后复位邮寄设置）
- Create: `scripts/e2e.d/56-express-quote.sh`

**Interfaces:**
- Produces:
  - `QuoteRequest { userId: number; addressId: number; cartItemIds?: number[]; directItem?: DirectItemInput; gifts?: { pointsGoodId: number; quantity: number }[] }`
  - `QuoteResult { feeFen; quotedFeeFen; feeSource; weightKg; groupName; freeShipMinFen; freeShip; belowMin; minOrderAmountFen; subtotalFen; quoteCount: number; quoteToken: string; quoteExpiresAt: string }`（**不含各家成本价**：与同城一致，成本只进凭证与订单快照，不下发顾客）
  - `quoteExpress(req: QuoteRequest, now?: Date): Promise<QuoteResult>`（抛 42260 / 42262 / 40401 / 42224 / 42202 / 42201）
  - `fetchCourierQuotes(s: ExpressSettings, addressId: number, receiverFullAddress: string, weightKg: number): Promise<CourierQuote[] | null>`（带 15 分钟缓存；查价失败返回 null，不抛）
  - `clearExpressQuoteCache()`
  - HTTP：`POST /api/express/quote`（需用户 token）Body `{ addressId, cartItemIds? | directItem?, gifts? }` → `QuoteResult`
- Consumes：Task 2/3/4/5 的导出；`loadGiftLines`（`services/member/checkout`）；`getLocalSettings().store`（寄件地址）。

- [ ] **Step 1: 写 e2e 片段（先失败）** `scripts/e2e.d/56-express-quote.sh`

```bash
echo "== 56. 邮寄报价：分组/中位数/包邮/不寄送/兜底/凭证 =="
# 复用 e2e.sh 主体的 req/code/ok/fail/assert_eq 与 $AT/$UT/$PID/$ADDR（四川省成都市）。变量一律 X54_ 前缀。
X54_ORIG=$(req GET /api/admin/settings/express "$AT" | jq -c .data)
# 明确切到 QUOTE 口径 + 默认分组（e2e 开头把它复位成了 TABLE/0 元，见 e2e.sh §1）
X54_S=$(jq -c '.fee.mode="QUOTE" | .fee.markupFen=0 | .fee.roundToFen=50 | .fee.minQuoteCount=2 | .minOrderAmountFen=0
  | .weight.packagingG=800 | .weight.defaultItemG=300
  | .regionGroups=[
      {name:"四川",provinces:["四川省"],freeShipMinFen:9900,tableFirstFen:800,tableOverPerKgFen:150,blocked:false},
      {name:"其他",provinces:[],freeShipMinFen:19900,tableFirstFen:1200,tableOverPerKgFen:300,blocked:false},
      {name:"不寄送",provinces:["新疆维吾尔自治区"],freeShipMinFen:0,tableFirstFen:0,tableOverPerKgFen:0,blocked:true}]' <<<"$X54_ORIG")
R=$(req PUT /api/admin/settings/express "$AT" "$X54_S"); assert_eq "邮寄设置切 QUOTE code 0" "$(code "$R")" "0"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null

X54_BJ=$(req POST /api/addresses "$UT" '{"receiverName":"E2E北京","receiverPhone":"13800000054","province":"北京市","city":"北京市","district":"朝阳区","detail":"建国路93号"}' | jq -r '.data.id // empty')
X54_XJ=$(req POST /api/addresses "$UT" '{"receiverName":"E2E新疆","receiverPhone":"13800000055","province":"新疆维吾尔自治区","city":"乌鲁木齐市","district":"天山区","detail":"人民路1号"}' | jq -r '.data.id // empty')
[[ -n "$X54_BJ" && -n "$X54_XJ" ]] && ok "造北京/新疆地址" || fail "造地址失败"
X54_PRICE=$(req GET "/api/products/$PID" "$UT" | jq -r '.data.price')
# 期望值按商品真实净重算（种子商品可能填了净重，不能写死 1.1 kg）：
#   重量(0.1kg 整数) = ceil((净重×数量 + 800)/100)；ceil 公斤 = ceil(重量/10)
#   mock 各家价 = 首重价 + 130×(ceil 公斤 − 1)；定价名单 6 家中位数 = 708 + 续重 → 向上取五毛
#   兜底表（四川组）= 800 + 150×(ceil 公斤 − 1)
X54_NW=$(sql "SELECT COALESCE(net_weight_g,300) FROM products WHERE id=$PID;")
x54_wt()   { echo $(( ($X54_NW * $1 + 800 + 99) / 100 )); }            # 单位 0.1 kg
x54_ceil() { echo $(( ($(x54_wt $1) + 9) / 10 )); }                     # 向上整公斤
x54_fee()  { local o=$(( ($(x54_ceil $1) - 1) * 130 )); echo $(( ((708 + o + 49) / 50) * 50 )); }
x54_tfee() { echo $(( 800 + 150 * ($(x54_ceil $1) - 1) )); }
X54_FEE1=$(x54_fee 1); X54_TFEE1=$(x54_tfee 1); X54_WT1=$(x54_wt 1)

echo "-- ① 四川：定价名单 6 家中位数（含 mock 续重）→ $X54_FEE1；重量 $(x54_wt 1)/10 kg --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "报价 code 0" "$(code "$R")" "0"
assert_eq "groupName=四川" "$(jq -r .data.groupName <<<"$R")" "四川"
assert_eq "feeSource=QUOTE" "$(jq -r .data.feeSource <<<"$R")" "QUOTE"
assert_eq "weightKg（×10）" "$(jq -r '.data.weightKg*10|round' <<<"$R")" "$X54_WT1"
if [[ "$X54_PRICE" -ge 9900 ]]; then
  assert_eq "小计≥99 → 包邮 fee=0" "$(jq -r .data.feeFen <<<"$R")" "0"
  assert_eq "quotedFeeFen 仍是中位数价" "$(jq -r .data.quotedFeeFen <<<"$R")" "$X54_FEE1"
else
  assert_eq "fee=中位数价 $X54_FEE1" "$(jq -r .data.feeFen <<<"$R")" "$X54_FEE1"
  assert_eq "freeShip=false" "$(jq -r .data.freeShip <<<"$R")" "false"
fi
X54_TOK=$(jq -r '.data.quoteToken // empty' <<<"$R"); [[ -n "$X54_TOK" ]] && ok "签发 quoteToken" || fail "缺 quoteToken" "$R"
assert_eq "回价 9 家（含无价的顺丰）" "$(jq -r .data.quoteCount <<<"$R")" "9"
assert_eq "响应体不含各家成本价" "$(jq -r '.data.quotes // "absent"' <<<"$R")" "absent"
assert_eq "mock 被调 1 次" "$(req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "1"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "同地址同重量 15 分钟内复用缓存，mock 仍 1 次" "$(req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "1"

echo "-- ② 数量 2 → 重量变、缓存 key 变，mock 第 2 次 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":2}}")
assert_eq "weightKg（×10）随数量变" "$(jq -r '.data.weightKg*10|round' <<<"$R")" "$(x54_wt 2)"
assert_eq "mock 2 次" "$(req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "2"

echo "-- ③ 北京落「其他」组 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$X54_BJ,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "groupName=其他" "$(jq -r .data.groupName <<<"$R")" "其他"
assert_eq "freeShipMinFen=19900" "$(jq -r .data.freeShipMinFen <<<"$R")" "19900"

echo "-- ④ 新疆不寄送 42260 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$X54_XJ,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "不寄送 42260" "$(code "$R")" "42260"

echo "-- ⑤ 查价超时 → TABLE 兜底 $X54_TFEE1 --"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "超时仍 code 0" "$(code "$R")" "0"
assert_eq "feeSource=TABLE" "$(jq -r .data.feeSource <<<"$R")" "TABLE"
assert_eq "quotedFeeFen=兜底 $X54_TFEE1" "$(jq -r .data.quotedFeeFen <<<"$R")" "$X54_TFEE1"
assert_eq "兜底不写缓存：再报一次 mock 又被调" "$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}" >/dev/null; req GET /api/admin/system/express-mock/calls "$AT" | jq -r '.data | length')" "2"

echo "-- ⑥ 只回 1 家 < minQuoteCount → TABLE --"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"directive":{"kind":"ok","quotes":[{"kuaidicom":"jd","serviceType":"特惠送","priceFen":1130,"defPriceFen":1500}]}}' >/dev/null
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
assert_eq "回价不足 → TABLE" "$(jq -r .data.feeSource <<<"$R")" "TABLE"

echo "-- ⑦ 参数错误 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR}"); [[ "$(code "$R")" != "0" ]] && ok "缺商品被拒 ($(code "$R"))" || fail "缺商品未被拒"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":999999,\"directItem\":{\"productId\":$PID,\"quantity\":1}}"); assert_eq "地址不存在 40401" "$(code "$R")" "40401"
R=$(req POST /api/express/quote "" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}"); [[ "$(code "$R")" == "40101" || "$(code "$R")" == "401" ]] && ok "未登录被拒" || fail "未登录未被拒" "$R"

# 收尾：地址留给 57 用；设置恢复原样
X54_KEEP_BJ=$X54_BJ; X54_KEEP_XJ=$X54_XJ; X54_KEEP_S=$X54_S; X54_KEEP_FEE=$X54_FEE1; X54_KEEP_TFEE=$X54_TFEE1; X54_KEEP_WT=$X54_WT1
req PUT /api/admin/settings/express "$AT" "$X54_ORIG" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
```

- [ ] **Step 2: `scripts/e2e.sh` 开头复位邮寄设置**

在第 57 行 `req PUT /api/admin/settings/printer ...` 之后加：
```bash
# 邮寄设置复位成「TABLE / 全 0 元 / 无包邮线 / 无起送」：与本文件写成时的一口价默认值等价，
# 让后面几十处 EXPRESS 下单的金额断言不受 QUOTE 中位数报价影响。56/57 两段自己切 QUOTE 再恢复。
req PUT /api/admin/settings/shipping "$AT" '{"fee":0,"freeThreshold":0,"minOrderAmount":0}' >/dev/null
```
（Task 8 会把 `PUT /shipping` 改成垫片：等价于 `applyLegacyShipping`。本任务先加这一行，跑 56 时若 `/settings/express` 还没有——它在 Task 8——先在本任务里把 `GET/PUT /admin/settings/express` 的**最小版本**加上：见 Step 5。）

- [ ] **Step 3: 写全 `express-quote-service.ts`**

```ts
/**
 * 邮寄报价编排：地址 → 分组 → 清单/重量 → 查价（缓存）→ 运费 → 凭证。
 * 顾客侧 /express/quote 与下单端点（老客户端不带凭证时）都走这里，保证同一套口径。
 */
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { getExpressSettings, findRegionGroup, ExpressSettings, EXPRESS_COURIERS } from './express-settings'
import {
  CourierQuote, calcPackageWeightKg, calcExpressFee, itemsHash, signExpressQuote, expressQuoteExpiresAt, EXPRESS_QUOTE_TTL_MS,
} from './express-quote'
import { getExpressProvider } from './delivery/kd100-express'
import { loadOrderLines, assertLinesSellable, DirectItemInput } from './order-lines'
import { loadGiftLines } from './member/checkout'
import { getLocalSettings } from './local-settings'

/** 顾客在结算页等报价的上限，与同城顾客侧一致 */
export const CUSTOMER_QUOTE_TIMEOUT_MS = 5000
/** 收件地址字节上限（快递100 recManPrintAddr 限 300 字节） */
export const MAX_ADDRESS_BYTES = 300

const cache = new Map<string, { quotes: CourierQuote[]; at: number }>()
const CACHE_MAX = 500
export const _quoteCache = cache
export function clearExpressQuoteCache(): void { cache.clear() }

function senderAddress(): Promise<string> {
  return getLocalSettings().then((s) => `${s.store.province}${s.store.city}${s.store.district}${s.store.address}`)
}

/**
 * 向快递100 查 9 家报价（全部家，不只定价名单——快照给店员端看）。
 * 同一 (addressId, weightKg) 15 分钟内复用；查价失败返回 null（调用方退兜底表），**失败不写缓存**。
 */
export async function fetchCourierQuotes(s: ExpressSettings, addressId: number, receiverFullAddress: string, weightKg: number): Promise<CourierQuote[] | null> {
  if (s.fee.mode !== 'QUOTE') return null
  const key = `${addressId}:${weightKg}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < EXPRESS_QUOTE_TTL_MS) return hit.quotes
  try {
    const quotes = await getExpressProvider().batchPrice({
      couriers: [...EXPRESS_COURIERS], senderAddr: await senderAddress(), receiverAddr: receiverFullAddress, weightKg, timeoutMs: CUSTOMER_QUOTE_TIMEOUT_MS,
    })
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
    cache.set(key, { quotes, at: Date.now() })
    return quotes
  } catch (e) {
    console.warn('[express-quote] 查价失败，退回兜底表:', (e as Error).message)
    return null
  }
}

export interface QuoteRequest {
  userId: number
  addressId: number
  cartItemIds?: number[]
  directItem?: DirectItemInput
  gifts?: { pointsGoodId: number; quantity: number }[]
}
export interface QuoteResult {
  feeFen: number; quotedFeeFen: number; feeSource: 'QUOTE' | 'TABLE'; weightKg: number; groupName: string
  freeShipMinFen: number; freeShip: boolean; belowMin: boolean; minOrderAmountFen: number; subtotalFen: number
  /** 回价家数（含无价的家）；各家成本价不下发顾客，只签进凭证 */
  quoteCount: number; quoteToken: string; quoteExpiresAt: string
}

export async function quoteExpress(req: QuoteRequest, now: Date = new Date()): Promise<QuoteResult> {
  const s = await getExpressSettings()
  const address = await prisma.address.findFirst({ where: { id: req.addressId, userId: req.userId, deletedAt: null } })
  if (!address) throw new AppError(40401, '收货地址不存在', 404)
  const group = findRegionGroup(s, address.province)
  if (group.blocked) throw new AppError(42260, '该地区暂不支持邮寄')
  if (Buffer.byteLength(address.fullAddress, 'utf8') > MAX_ADDRESS_BYTES) throw new AppError(42262, '收货地址过长，请精简后再试')

  const lines = await loadOrderLines(req.userId, { cartItemIds: req.cartItemIds, directItem: req.directItem })
  assertLinesSellable(lines, 'EXPRESS')
  const gifts = req.gifts ?? []
  const giftLines = (await loadGiftLines(req.userId, 'EXPRESS', gifts)).lines
  const subtotalFen = lines.reduce((sum, l) => sum + (l.sku?.price ?? l.product.price) * l.quantity, 0)
  const weightKg = calcPackageWeightKg(
    [...lines.map((l) => ({ netWeightG: l.product.netWeightG, quantity: l.quantity })), ...giftLines.map((g) => ({ netWeightG: g.netWeightG, quantity: g.quantity }))],
    s.weight,
  )
  const quotes = await fetchCourierQuotes(s, address.id, address.fullAddress, weightKg)
  const fee = calcExpressFee(s, group, weightKg, quotes, subtotalFen)
  const snapshot = (quotes ?? []).map((q) => ({ kuaidicom: q.kuaidicom, serviceType: q.serviceType, priceFen: q.priceFen }))
  const quoteToken = signExpressQuote({
    addressId: address.id, itemsHash: itemsHash(lines, gifts), weightKg,
    feeFen: fee.feeFen, quotedFeeFen: fee.quotedFeeFen, feeSource: fee.feeSource, groupName: group.name, quotes: snapshot,
  }, now)
  return {
    feeFen: fee.feeFen, quotedFeeFen: fee.quotedFeeFen, feeSource: fee.feeSource, weightKg, groupName: group.name,
    freeShipMinFen: group.freeShipMinFen, freeShip: fee.freeShip, belowMin: fee.belowMin, minOrderAmountFen: s.minOrderAmountFen, subtotalFen,
    quoteCount: (quotes ?? []).length, quoteToken, quoteExpiresAt: expressQuoteExpiresAt(now).toISOString(),
  }
}
```

- [ ] **Step 4: 限流器 + 路由 + 挂载**

`rate-limit.ts` 在 `localQuoteLimiter` 之后加：
```ts
/** 邮寄报价限流：与同城报价同参数，单独计数（两个渠道的结算页互不影响） */
export const expressQuoteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: devCeiling(30, 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 42901, message: '请求过于频繁，请稍后再试', data: null },
})
```
新建 `routes/express.ts`：
```ts
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { success } from '../utils/response'
import { expressQuoteLimiter } from '../middlewares/rate-limit'
import { quoteExpress } from '../services/express-quote-service'

const router = Router()

const quoteSchema = z
  .object({
    addressId: z.number().int().positive(),
    cartItemIds: z.array(z.number().int().positive()).min(1).optional(),
    directItem: z.object({ productId: z.number().int().positive(), skuId: z.number().int().positive().optional(), quantity: z.number().int().min(1).max(99) }).optional(),
    gifts: z.array(z.object({ pointsGoodId: z.number().int().positive(), quantity: z.number().int().min(1).max(9) })).max(5).optional(),
  })
  .refine((v) => !!v.cartItemIds !== !!v.directItem, { message: '请选择商品' })

// POST /api/express/quote — 邮寄运费报价（需登录；清单与下单同形，凭证按同一份清单签）
router.post('/quote', expressQuoteLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = quoteSchema.parse(req.body)
    success(res, await quoteExpress({ userId: req.userId!, ...body }))
  } catch (e) {
    next(e)
  }
})

export default router
```
`routes/index.ts`：加 `import expressRouter from './express'`，在「用户接口」段加 `router.use('/express', verifyUserToken, expressRouter)`。

- [ ] **Step 5: 管理端 `GET/PUT /admin/settings/express` 最小版本**（Task 8 再补垫片与后台页）

`routes/admin/settings.ts` 顶部加 `import { getExpressSettings, setExpressSettings, sanitizeExpressSettings, validateExpressSettings } from '../../services/express-settings'`，文件末尾 `export default` 前加：
```ts
router.get('/express', async (_req, res, next) => {
  try { res.json({ code: 0, message: 'ok', data: await getExpressSettings() }) } catch (e) { next(e) }
})
router.put('/express', async (req, res, next) => {
  try {
    const next_ = sanitizeExpressSettings(req.body)
    const errs = validateExpressSettings(next_)
    if (errs.length) throw new AppError(40001, errs.join('；'))
    res.json({ code: 0, message: 'ok', data: await setExpressSettings(next_) })
  } catch (e) { next(e) }
})
```

- [ ] **Step 6: 启动 mock 后端跑 54**

后端启动参数在原有基础上加 `EXPRESS_PROVIDER_MOCK=true`（e2e 配方里的启动命令补这一个变量）。然后：
```bash
DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | sed -n '/== 56\./,/== 57\./p' | head -60
```
Expected: 56 段全 ✔（约 27 条），最后汇总 `失败 0`。

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/services/express-quote-service.ts apps/server/src/routes/express.ts apps/server/src/routes/index.ts apps/server/src/middlewares/rate-limit.ts apps/server/src/routes/admin/settings.ts scripts/e2e.sh scripts/e2e.d/56-express-quote.sh
git commit -m "邮寄报价接口 POST /api/express/quote：分组/重量/查价缓存/中位数/凭证 + e2e 56"
```

**复核（opus）要点**：`fetchCourierQuotes` 失败不写缓存；缓存 key 不含 userId 是有意的（报价只依赖地址与重量，地址归属已在 `quoteExpress` 校过）；`loadGiftLines` 抛的会员错误直接透传（结算页组件只给可用赠品，不会走到）；限流器是独立实例；响应体**不含**各家成本价（与同城 `/local/quote` 同一原则），快照只在凭证里、下单时落到订单列供店员端用。

---

### Task 7: 下单走凭证 + 订单快照列 + `/orders/meta` 兼容 + e2e

**Files:**
- Modify: `apps/server/prisma/schema.prisma`（Order 加三列，放在 `clientRequestId` 之前）
- Create: `apps/server/prisma/migrations/20260912000000_express_quote_snapshot/migration.sql`
- Modify: `apps/server/src/routes/orders.ts`（`createOrderSchema.quoteToken` 上限、EXPRESS 分支、`tx.order.create` data、`/meta`）
- Create: `scripts/e2e.d/57-express-order.sh`

**Interfaces:**
- Produces: `Order.expressQuoteSnapshot Json?`、`Order.expressRegionGroup String?`、`Order.expressWeightG Int?`；`POST /api/orders` 邮寄分支的新错误 42260/42261/42262；`GET /orders/meta.shipping` 改为 `legacyShippingView(expressSettings)`。
- Consumes: Task 3 `verifyExpressQuote/calcExpressFee/itemsHash/calcPackageWeightKg`、Task 6 `fetchCourierQuotes`、Task 2 `getExpressSettings/findRegionGroup/legacyShippingView`。

- [ ] **Step 1: 写 e2e 片段（先失败）** `scripts/e2e.d/57-express-order.sh`

```bash
echo "== 57. 邮寄下单：凭证校验 / 老客户端现算 / 包邮起送 / 不寄送 / 快照落库 =="
# 依赖 56 段留下的 $X54_KEEP_BJ $X54_KEEP_XJ $X54_KEEP_S $X54_KEEP_FEE（中位数价）$X54_KEEP_TFEE（兜底价）$X54_KEEP_WT（重量×10）。变量一律 X55_ 前缀。
X55_ORIG=$(req GET /api/admin/settings/express "$AT" | jq -c .data)
req PUT /api/admin/settings/express "$AT" "$X54_KEEP_S" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
X55_PRICE=$(req GET "/api/products/$PID" "$UT" | jq -r '.data.price')
# 让四川不包邮：把门槛抬到远高于单价
X55_S2=$(jq -c '.regionGroups |= map(if .name=="四川" then .freeShipMinFen=99999900 else . end)' <<<"$X54_KEEP_S")
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null

echo "-- ① 带凭证下单：运费 = 凭证 $X54_KEEP_FEE，快照落库 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK=$(jq -r .data.quoteToken <<<"$R")
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK\"}")
assert_eq "下单 code 0" "$(code "$R")" "0"
X55_O1=$(jq -r .data.orderId <<<"$R")
assert_eq "shippingFee=凭证价" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_FEE"
assert_eq "actualAmount = 小计 + 运费" "$(jq -r .data.actualAmount <<<"$R")" "$((X55_PRICE+X54_KEEP_FEE))"
assert_eq "订单快照：分组=四川" "$(sql "SELECT express_region_group FROM orders WHERE id=$X55_O1;")" "四川"
assert_eq "订单快照：重量（克）" "$(sql "SELECT express_weight_g FROM orders WHERE id=$X55_O1;")" "$((X54_KEEP_WT*100))"
[[ "$(sql "SELECT JSON_LENGTH(express_quote_snapshot, '$.quotes') FROM orders WHERE id=$X55_O1;")" == "9" ]] && ok "订单快照：9 家报价" || fail "快照 quotes 不是 9 家"

echo "-- ② 凭证与清单不符 42261（数量改 2） --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":2},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK\"}")
assert_eq "清单不符 42261" "$(code "$R")" "42261"
echo "-- ③ 凭证与地址不符 42261 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$X54_KEEP_BJ,\"quoteToken\":\"$X55_TOK\"}")
assert_eq "地址不符 42261" "$(code "$R")" "42261"
echo "-- ④ 凭证被篡改 42261 --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"${X55_TOK}x\"}")
assert_eq "篡改 42261" "$(code "$R")" "42261"

echo "-- ⑤ 老客户端不带凭证：服务端现算，运费同样 $X54_KEEP_FEE --"
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
assert_eq "不带凭证下单 code 0" "$(code "$R")" "0"
assert_eq "现算运费=凭证价" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_FEE"

echo "-- ⑥ QUOTE 锁价：报价后店主把加价改成 ¥50，旧凭证仍按原价成交 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK2=$(jq -r .data.quoteToken <<<"$R")
req PUT /api/admin/settings/express "$AT" "$(jq -c '.fee.markupFen=5000' <<<"$X55_S2")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK2\"}")
assert_eq "锁价成交" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_FEE"
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null

echo "-- ⑦ 包邮按当前设置与真实小计判：报价时不包邮，下单前把四川门槛降到单价 → 运费 0 --"
R=$(req POST /api/express/quote "$UT" "{\"addressId\":$ADDR,\"directItem\":{\"productId\":$PID,\"quantity\":1}}")
X55_TOK3=$(jq -r .data.quoteToken <<<"$R")
req PUT /api/admin/settings/express "$AT" "$(jq -c --argjson p "$X55_PRICE" '.regionGroups |= map(if .name=="四川" then .freeShipMinFen=$p else . end)' <<<"$X55_S2")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR,\"quoteToken\":\"$X55_TOK3\"}")
assert_eq "包邮线降到单价 → 运费 0" "$(jq -r .data.shippingFee <<<"$R")" "0"
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null

echo "-- ⑧ 起送不足 42210；不寄送 42260 --"
req PUT /api/admin/settings/express "$AT" "$(jq -c '.minOrderAmountFen=99999900' <<<"$X55_S2")" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
assert_eq "起送不足 42210" "$(code "$R")" "42210"
req PUT /api/admin/settings/express "$AT" "$X55_S2" >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$X54_KEEP_XJ}")
assert_eq "不寄送 42260" "$(code "$R")" "42260"

echo "-- ⑨ 查价超时 → TABLE 兜底价成交 $X54_KEEP_TFEE，快照 feeSource=TABLE --"
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
req POST /api/admin/system/express-mock/queue "$AT" '{"directive":{"kind":"timeout"}}' >/dev/null
R=$(req POST /api/orders "$UT" "{\"directItem\":{\"productId\":$PID,\"quantity\":1},\"addressId\":$ADDR}")
assert_eq "兜底价" "$(jq -r .data.shippingFee <<<"$R")" "$X54_KEEP_TFEE"
assert_eq "快照 feeSource=TABLE" "$(sql "SELECT JSON_UNQUOTE(JSON_EXTRACT(express_quote_snapshot,'$.feeSource')) FROM orders WHERE id=$(jq -r .data.orderId <<<"$R");")" "TABLE"

echo "-- ⑩ /orders/meta 兼容视图来自「其他」组 --"
R=$(req GET /api/orders/meta "$UT")
assert_eq "meta.shipping.fee = 其他组兜底首重 1200" "$(jq -r .data.shipping.fee <<<"$R")" "1200"
assert_eq "meta.shipping.freeThreshold = 其他组 19900" "$(jq -r .data.shipping.freeThreshold <<<"$R")" "19900"

echo "-- ⑪ 同城单不受影响：LOCAL 下单路径没读邮寄设置（沿用 §8 那张 LADDR 单的断言即可，这里只确认接口还活着） --"
R=$(req GET /api/local/meta ""); assert_eq "/local/meta 仍 200" "$(code "$R")" "0"

# 收尾：把本段造的 PENDING_PAYMENT 单取消，地址删除，设置恢复
for o in $(sql "SELECT id FROM orders WHERE status='PENDING_PAYMENT' AND delivery_type='EXPRESS' AND express_region_group IS NOT NULL;"); do sql "UPDATE orders SET status='CANCELLED' WHERE id=$o;"; done
req DELETE "/api/addresses/$X54_KEEP_BJ" "$UT" >/dev/null; req DELETE "/api/addresses/$X54_KEEP_XJ" "$UT" >/dev/null
req PUT /api/admin/settings/express "$AT" "$X55_ORIG" >/dev/null
req POST /api/admin/system/express-mock/reset "$AT" >/dev/null
```

- [ ] **Step 2: schema + migration**

`schema.prisma` Order 模型，在 `clientRequestId` 那段注释之前加：
```prisma
  // ── 邮寄报价快照（deliveryType=EXPRESS 时写入；批次一）──
  // 下单那一刻的凭证载荷（各家成本价、feeSource、分组、指纹），店员端预约弹窗与成本核对直接读它
  expressQuoteSnapshot        Json?     @map("express_quote_snapshot")
  expressRegionGroup          String?   @map("express_region_group") @db.VarChar(32)
  // 报价重量（克）。用克不用 Decimal：Prisma 的 Decimal 在应用层是对象，比较/序列化都要转，Int 最省事
  expressWeightG              Int?      @map("express_weight_g")
```
`migrations/20260912000000_express_quote_snapshot/migration.sql`：
```sql
-- 邮寄报价快照三列。全部可空、additive：旧代码不读它们，代码回滚不需要回滚数据库。
ALTER TABLE `orders` ADD COLUMN `express_quote_snapshot` JSON NULL;
ALTER TABLE `orders` ADD COLUMN `express_region_group` VARCHAR(32) NULL;
ALTER TABLE `orders` ADD COLUMN `express_weight_g` INT NULL;
```
```bash
cd apps/server && npx prisma migrate dev --name express_quote_snapshot --create-only 2>/dev/null; npx prisma migrate deploy && npx prisma generate
```
（若 `--create-only` 生成了另一个目录，删掉它，保留手写的那个目录名；⚠ 并行 worktree 共用 Prisma client，`generate` 期间不要在别的会话里跑同城验证，见记忆 `worktrees-share-prisma-client`。）

- [ ] **Step 3: 改 `orders.ts`**

(a) `createOrderSchema`：`quoteToken: z.string().max(512).optional()` → `max(1024)`。

(b) import 区加：
```ts
import { getExpressSettings, findRegionGroup, legacyShippingView } from '../services/express-settings'
import { calcPackageWeightKg, calcExpressFee, itemsHash, verifyExpressQuote } from '../services/express-quote'
import { fetchCourierQuotes, MAX_ADDRESS_BYTES } from '../services/express-quote-service'
```
删掉 `import { getShippingSettings, calcShippingFee } from '../services/settings'`。

(c) 在 `let localSnapshot ...` 之后加：
```ts
    let expressSnapshot: { expressQuoteSnapshot?: Prisma.InputJsonValue; expressRegionGroup?: string; expressWeightG?: number } = {}
```
把 `} else {` 分支（原「运费与起送门槛都按商品小计判断」到 `shippingFee = calcShippingFee(totalAmount, shipping)`）整段替换为：
```ts
    } else {
      /**
       * 邮寄运费（批次一，spec §3/§4.1）。口径与同城一致：包邮/起送/不寄送按**下单时**的设置与**真实**小计判；
       * 报价数字只在两种来源里二选一——
       *   有凭证：验签 + 地址 + 清单指纹三项全对才信，QUOTE 口径锁凭证里的 quotedFeeFen（15 分钟），
       *           TABLE 口径现算（表就在设置里）；任一不符 → 42261 让客户端重报价。
       *   无凭证：老版本小程序。服务端自己走一遍同样的查价（带缓存）与计算——不能拒，小程序发版有滞后。
       * 两条路都不信客户端的任何金额。
       */
      const s = await getExpressSettings()
      const group = findRegionGroup(s, address.province)
      if (group.blocked) throw new AppError(42260, '该地区暂不支持邮寄')
      if (Buffer.byteLength(address.fullAddress, 'utf8') > MAX_ADDRESS_BYTES) throw new AppError(42262, '收货地址过长，请精简后再试')
      if (s.minOrderAmountFen > 0 && totalAmount < s.minOrderAmountFen) {
        throw new AppError(42210, `订单满 ¥${(s.minOrderAmountFen / 100).toFixed(2)} 起送，当前 ¥${(totalAmount / 100).toFixed(2)}`)
      }
      const hash = itemsHash(lines, gifts ?? [])
      const weightKg = calcPackageWeightKg(
        [...lines.map((l) => ({ netWeightG: l.product.netWeightG, quantity: l.quantity })), ...giftLines.map((g) => ({ netWeightG: g.netWeightG, quantity: g.quantity }))],
        s.weight,
      )
      const quoted = quoteToken ? verifyExpressQuote(quoteToken) : null
      if (quoteToken && (!quoted || quoted.addressId !== address.id || quoted.itemsHash !== hash)) {
        throw new AppError(42261, '运费已更新，请重新确认')
      }
      let fee, snapshotQuotes: { kuaidicom: string; serviceType: string | null; priceFen: number | null }[]
      if (quoted) {
        fee = calcExpressFee(s, group, quoted.weightKg, null, totalAmount, quoted.feeSource === 'QUOTE' ? { quotedFeeFen: quoted.quotedFeeFen } : null)
        snapshotQuotes = quoted.quotes
      } else {
        const live = await fetchCourierQuotes(s, address.id, address.fullAddress, weightKg)
        fee = calcExpressFee(s, group, weightKg, live, totalAmount)
        snapshotQuotes = (live ?? []).map((q) => ({ kuaidicom: q.kuaidicom, serviceType: q.serviceType, priceFen: q.priceFen }))
      }
      shippingFee = fee.feeFen
      expressSnapshot = {
        expressQuoteSnapshot: {
          feeFen: fee.feeFen, quotedFeeFen: fee.quotedFeeFen, feeSource: fee.feeSource, groupName: group.name,
          weightKg: quoted?.weightKg ?? weightKg, itemsHash: hash, fromToken: !!quoted, quotes: snapshotQuotes,
        },
        expressRegionGroup: group.name,
        expressWeightG: Math.round((quoted?.weightKg ?? weightKg) * 1000),
      }
    }
```
（`giftLines` 在这段之前已由 `loadGiftLines` 得到，作用域可见。）

(d) `tx.order.create({ data: { ... shippingFee, ...` 里，在 `...localSnapshot` 旁加 `...expressSnapshot`（若原代码是把 `localSnapshot` 字段逐个展开的，就在 `deliveryType,` 之后加 `...expressSnapshot,`）。

(e) `/meta`：`shipping: await getShippingSettings()` → `shipping: legacyShippingView(await getExpressSettings())`。

- [ ] **Step 4: 编译 + 跑 e2e 56/57 + 全量**

```bash
cd apps/server && npx tsc --noEmit
DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -3
```
Expected: `失败 0`；通过数 = Task 5 记下的 N + 56 段条数 + 57 段条数（约 +50）。若 §6/§7 等老段落里 EXPRESS 单的 `actualAmount` 断言变红，说明 e2e.sh §1 的复位没生效（垫片 Task 8 才到）——本任务临时让 `PUT /admin/settings/shipping` 直接调用 `applyLegacyShipping` 写入（把 Task 8 Step 2 的垫片提前做掉，Task 8 就不再重复）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/prisma/schema.prisma apps/server/prisma/migrations/20260912000000_express_quote_snapshot apps/server/src/routes/orders.ts scripts/e2e.d/57-express-order.sh
git commit -m "邮寄下单走报价凭证（可选，老客户端现算），订单落报价快照三列；/orders/meta 兼容视图"
```

**复核（opus）要点**：42261 只在**带了**凭证且不符时抛，不带凭证不抛；`fromToken=false` 的现算路径与 `/express/quote` 用同一 `fetchCourierQuotes`（缓存命中即不外呼）；`quoted.weightKg` 优先于现算 `weightKg` 写快照（凭证时刻的重量就是报价依据）；`Prisma.InputJsonValue` 类型能通过；LOCAL 分支一行没动；`calcShippingFee` 在全仓已无调用方（`grep -rn calcShippingFee apps/server/src` 只剩定义）。

---

### Task 8: 后台「邮寄设置」页 + `/shipping` 兼容垫片

**Files:**
- Modify: `apps/server/src/routes/admin/settings.ts`（`GET/PUT /shipping` 改垫片）
- Modify: `apps/admin/src/types.ts:330-338`（新增 `ExpressSettings`/`RegionGroup`，`ShippingSettings` 保留）
- Modify: `apps/admin/src/api/admin.ts:224-228`（新增 `getExpressSettings/updateExpressSettings`）
- Modify: `apps/admin/src/pages/ShopSettings.tsx`（整文件重写；路由 `/settings/express` 与标题不变）

**Interfaces:**
- Produces: `GET /api/admin/settings/express` → `ExpressSettings`；`PUT /api/admin/settings/express`（全量，40001 带错误列表）；`GET /shipping` → `legacyShippingView`；`PUT /shipping` → `applyLegacyShipping` 后保存（仅 e2e/过渡用）。
- Consumes: Task 2 全部导出。

- [ ] **Step 1: 服务端垫片**

`routes/admin/settings.ts`：把 `import { getShippingSettings, setShippingSettings } from '../../services/settings'` 删掉；`express-settings` 的 import 加上 `applyLegacyShipping, legacyShippingView`。两个 `/shipping` 路由改为：
```ts
// ── 兼容垫片：一口价旧接口。GET 给老后台/老 e2e 看「其他」组；PUT 等价于「全部分组同一张兜底表 + 切 TABLE」。
//    新后台页不用它；批次二结束后删除。
router.get('/shipping', async (_req, res, next) => {
  try { res.json({ code: 0, message: 'ok', data: legacyShippingView(await getExpressSettings()) }) } catch (e) { next(e) }
})
router.put('/shipping', async (req, res, next) => {
  try {
    const body = shippingSchema.parse(req.body)
    const saved = await setExpressSettings(applyLegacyShipping(await getExpressSettings(), body))
    res.json({ code: 0, message: 'ok', data: legacyShippingView(saved) })
  } catch (e) { next(e) }
})
```
`shippingSchema` 保留。`services/settings.ts` 文件不删（`getShippingSettings` 仍被 `express-settings.ts` 的迁移路径调用）。

- [ ] **Step 2: 后台类型与 API**

`types.ts` 在 `ShippingSettings` 之后加：
```ts
/** 邮寄设置（与服务端 services/express-settings.ts 同构；金额分、重量克） */
export interface RegionGroup { name: string; provinces: string[]; freeShipMinFen: number; tableFirstFen: number; tableOverPerKgFen: number; blocked: boolean }
export interface ExpressSettings {
  version: number
  weight: { packagingG: number; defaultItemG: number }
  pricingPool: string[]
  fee: { mode: 'QUOTE' | 'TABLE'; markupFen: number; roundToFen: number; minQuoteCount: number }
  minOrderAmountFen: number
  regionGroups: RegionGroup[]
  acceptGraceMin: number
  pickup: { cargoName: string; defaultRemark: string; unacceptedRemindHours: number; unpickedRemindMin: number }
  costAlertRatio: number
}
```
`api/admin.ts` 的 `import type {` 列表加 `ExpressSettings`；在 `updateShippingSettings` 之后加：
```ts
// 邮寄设置（批次一）
export const getExpressSettings = () =>
  client.get<ApiResponse<ExpressSettings>>('/admin/settings/express').then((r) => r.data.data)
export const updateExpressSettings = (payload: ExpressSettings) =>
  client.put<ApiResponse<ExpressSettings>>('/admin/settings/express', payload).then((r) => r.data.data)
```

- [ ] **Step 3: 重写 `pages/ShopSettings.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { getExpressSettings, updateExpressSettings } from '../api/admin'
import type { ExpressSettings, RegionGroup } from '../types'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import { useUnsavedSettings } from '../components/UnsavedSettings'

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)
const toYuan = (fen: number) => (fen / 100).toFixed(2)
/** 元字符串 → 分；非法返回 null（走正则不走 parseFloat，避免 0.29*100 的浮点坑） */
function toFen(input: string): number | null {
  const v = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  const [yuan, dec = ''] = v.split('.')
  return Number(yuan) * 100 + Number(dec.padEnd(2, '0'))
}

const COURIERS: { code: string; label: string }[] = [
  { code: 'jtexpress', label: '极兔' }, { code: 'yuantong', label: '圆通' }, { code: 'shentong', label: '申通' }, { code: 'yunda', label: '韵达' },
  { code: 'zhongtong', label: '中通' }, { code: 'jd', label: '京东' }, { code: 'debangkuaidi', label: '德邦' }, { code: 'ems', label: 'EMS' }, { code: 'shunfeng', label: '顺丰' },
]
const PROVINCES = [
  '北京市', '天津市', '河北省', '山西省', '内蒙古自治区', '辽宁省', '吉林省', '黑龙江省', '上海市', '江苏省', '浙江省', '安徽省', '福建省', '江西省',
  '山东省', '河南省', '湖北省', '湖南省', '广东省', '广西壮族自治区', '海南省', '重庆市', '四川省', '贵州省', '云南省', '西藏自治区', '陕西省', '甘肃省',
  '青海省', '宁夏回族自治区', '新疆维吾尔自治区', '香港特别行政区', '澳门特别行政区', '台湾省',
]
const OTHER = '其他'

/** 分组行的可编辑副本：金额用元字符串，省份用数组 */
interface GroupForm { name: string; provinces: string[]; freeShipMin: string; tableFirst: string; tableOverPerKg: string; blocked: boolean }
interface MoneyForm { markup: string; roundTo: string; minOrder: string }

export default function ShopSettings() {
  const { setDirty } = useUnsavedSettings()
  const [s, setS] = useState<ExpressSettings | null>(null)
  const [groups, setGroups] = useState<GroupForm[]>([])
  const [money, setMoney] = useState<MoneyForm>({ markup: '0.00', roundTo: '0.50', minOrder: '0.00' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')

  const fromServer = (v: ExpressSettings) => {
    setS(v)
    setGroups(v.regionGroups.map((g) => ({ name: g.name, provinces: g.provinces, freeShipMin: toYuan(g.freeShipMinFen), tableFirst: toYuan(g.tableFirstFen), tableOverPerKg: toYuan(g.tableOverPerKgFen), blocked: g.blocked })))
    setMoney({ markup: toYuan(v.fee.markupFen), roundTo: toYuan(v.fee.roundToFen), minOrder: toYuan(v.minOrderAmountFen) })
    setDirty(false)
  }
  useEffect(() => {
    getExpressSettings().then(fromServer).catch(() => { setLoadFailed(true); toast.error('邮寄设置加载失败，请刷新') }).finally(() => setLoading(false))
  }, [])

  const patch = (p: Partial<ExpressSettings>) => setS((prev) => (prev ? { ...prev, ...p } : prev))
  const patchGroup = (i: number, p: Partial<GroupForm>) => setGroups((gs) => gs.map((g, j) => (j === i ? { ...g, ...p } : g)))
  const provinceOwner = (p: string, except: number) => groups.findIndex((g, j) => j !== except && g.provinces.includes(p))
  const toggleProvince = (i: number, p: string) => {
    const owner = provinceOwner(p, i)
    setGroups((gs) => gs.map((g, j) => {
      if (j === i) return { ...g, provinces: g.provinces.includes(p) ? g.provinces.filter((x) => x !== p) : [...g.provinces, p] }
      if (j === owner) return { ...g, provinces: g.provinces.filter((x) => x !== p) } // 一省只能属一组：从原组摘掉
      return g
    }))
  }
  const addGroup = () => setGroups((gs) => [...gs, { name: '', provinces: [], freeShipMin: '0.00', tableFirst: '12.00', tableOverPerKg: '3.00', blocked: false }])
  const removeGroup = (i: number) => { if (groups[i].name === OTHER) { toast.error('「其他」分组不能删除'); return } setGroups((gs) => gs.filter((_, j) => j !== i)) }

  const buildPayload = (): ExpressSettings | null => {
    if (!s) return null
    const markup = toFen(money.markup), roundTo = toFen(money.roundTo), minOrder = toFen(money.minOrder)
    if (markup === null || roundTo === null || minOrder === null) { setError('额外加价 / 取整 / 起送金额请填金额，最多两位小数'); return null }
    const regionGroups: RegionGroup[] = []
    for (const g of groups) {
      const a = toFen(g.freeShipMin), b = toFen(g.tableFirst), c = toFen(g.tableOverPerKg)
      if (!g.name.trim()) { setError('分组名不能为空'); return null }
      if (a === null || b === null || c === null) { setError(`分组「${g.name}」的金额请填最多两位小数`); return null }
      if (g.blocked && a > 0) { setError(`分组「${g.name}」已设为不寄送，不能再设包邮线`); return null }
      regionGroups.push({ name: g.name.trim(), provinces: g.provinces, freeShipMinFen: a, tableFirstFen: b, tableOverPerKgFen: c, blocked: g.blocked })
    }
    if (!regionGroups.some((g) => g.name === OTHER)) { setError('必须保留名为「其他」的分组'); return null }
    if (s.pricingPool.length < 2) { setError('参与定价的快递至少勾选 2 家'); return null }
    setError('')
    return { ...s, fee: { ...s.fee, markupFen: markup, roundToFen: roundTo }, minOrderAmountFen: minOrder, regionGroups }
  }
  const handleSave = async () => {
    if (loadFailed) { toast.error('加载失败，请刷新后再保存'); return }
    const payload = buildPayload(); if (!payload) return
    setSaving(true)
    try { fromServer(await updateExpressSettings(payload)); toast.success('已保存，新下单立即按新规则计费') }
    catch (e) { setError((e as Error).message || '保存失败'); toast.error((e as Error).message || '保存失败') }
    finally { setSaving(false) }
  }

  if (loading) return <div className="text-gray-500">加载中...</div>
  if (!s) return <div className="text-red-600">邮寄设置加载失败，请刷新</div>
  const isQuote = s.fee.mode === 'QUOTE'

  return (
    <div className="space-y-4 max-w-4xl" onChangeCapture={() => setDirty(true)}>
      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div>
          <h3 className="font-medium text-gray-800">运费怎么算</h3>
          <p className="text-xs text-gray-500 mt-0.5">顾客填完地址那一刻向快递100 查各家报价，取<strong>参与定价名单的中位数</strong>；查不到就用下面分组里的兜底表。包邮线与起送金额都按<strong>券前商品小计</strong>判。</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="运费口径">
            <select className={inputCls} value={s.fee.mode} onChange={(e) => patch({ fee: { ...s.fee, mode: e.target.value as 'QUOTE' | 'TABLE' } })}>
              <option value="QUOTE">按快递100 实时报价取中位数（推荐）</option>
              <option value="TABLE">只用分组兜底表</option>
            </select>
          </Field>
          <Field label="起送金额（元）" hint="0 = 无门槛"><input className={inputCls} inputMode="decimal" value={money.minOrder} onChange={(e) => setMoney({ ...money, minOrder: e.target.value })} /></Field>
          {isQuote && <>
            <Field label="额外加价（元）" hint="在中位数之上再加；0 = 不加"><input className={inputCls} inputMode="decimal" value={money.markup} onChange={(e) => setMoney({ ...money, markup: e.target.value })} /></Field>
            <Field label="向上取整到（元）" hint="0.5 时 ¥7.08 收 ¥7.50；0 = 不取整"><input className={inputCls} inputMode="decimal" value={money.roundTo} onChange={(e) => setMoney({ ...money, roundTo: e.target.value })} /></Field>
            <Field label="至少几家回价才用中位数" hint="不足就退回兜底表"><input className={inputCls} type="number" min={1} max={9} value={s.fee.minQuoteCount} onChange={(e) => patch({ fee: { ...s.fee, minQuoteCount: Number(e.target.value) } })} /></Field>
          </>}
        </div>
        {isQuote && (
          <Field label="参与定价的快递" hint="只影响「顾客付多少」；店员发货时仍能看到全部家的价。EMS 折后比标准价还贵、德邦超 2.5 kg 不报价，默认不勾">
            <div className="flex flex-wrap gap-3">
              {COURIERS.map((c) => (
                <label key={c.code} className="inline-flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={s.pricingPool.includes(c.code)} onChange={(e) => patch({ pricingPool: e.target.checked ? [...s.pricingPool, c.code] : s.pricingPool.filter((x) => x !== c.code) })} />
                  {c.label}
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div>
          <h3 className="font-medium text-gray-800">重量</h3>
          <p className="text-xs text-gray-500 mt-0.5">重量 = 各商品净重 × 数量 + 每单包装。礼盒重量填在商品的「净重」里；泡沫箱、冰袋填在这里。</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="每单包装附加重量（克）" hint="泡沫箱 + 冰袋实称一次"><input className={inputCls} type="number" min={0} value={s.weight.packagingG} onChange={(e) => patch({ weight: { ...s.weight, packagingG: Number(e.target.value) } })} /></Field>
          <Field label="商品未填净重时按（克）"><input className={inputCls} type="number" min={1} value={s.weight.defaultItemG} onChange={(e) => patch({ weight: { ...s.weight, defaultItemG: Number(e.target.value) } })} /></Field>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-medium text-gray-800">地区分组</h3>
            <p className="text-xs text-gray-500 mt-0.5">一个省只能属于一个组，没勾的省自动落到「其他」。勾了「不寄送」的组，顾客选到该地址会被提示暂不支持。</p>
          </div>
          <Button onClick={addGroup}>+ 新增分组</Button>
        </div>
        {groups.map((g, i) => (
          <div key={i} className="rounded-md border border-gray-200 p-3 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
              <Field label="组名"><input className={inputCls} value={g.name} disabled={g.name === OTHER} onChange={(e) => patchGroup(i, { name: e.target.value })} /></Field>
              <Field label="满额包邮（元）" hint="0 = 不包邮"><input className={inputCls} inputMode="decimal" value={g.freeShipMin} disabled={g.blocked} onChange={(e) => patchGroup(i, { freeShipMin: e.target.value })} /></Field>
              <Field label="兜底首重价（元）"><input className={inputCls} inputMode="decimal" value={g.tableFirst} disabled={g.blocked} onChange={(e) => patchGroup(i, { tableFirst: e.target.value })} /></Field>
              <Field label="兜底续重/公斤（元）"><input className={inputCls} inputMode="decimal" value={g.tableOverPerKg} disabled={g.blocked} onChange={(e) => patchGroup(i, { tableOverPerKg: e.target.value })} /></Field>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-1 text-sm"><input type="checkbox" checked={g.blocked} disabled={g.name === OTHER} onChange={(e) => patchGroup(i, { blocked: e.target.checked, freeShipMin: e.target.checked ? '0.00' : g.freeShipMin })} />不寄送</label>
                {g.name !== OTHER && <button className="text-xs text-red-600" onClick={() => removeGroup(i)}>删除</button>}
              </div>
            </div>
            {g.name !== OTHER && (
              <div className="flex flex-wrap gap-2">
                {PROVINCES.map((p) => {
                  const mine = g.provinces.includes(p); const owner = provinceOwner(p, i)
                  return (
                    <button key={p} type="button" onClick={() => toggleProvince(i, p)}
                      className={`px-2 py-0.5 rounded text-xs border ${mine ? 'bg-brand-500 text-white border-brand-500' : owner >= 0 ? 'bg-gray-100 text-gray-400 border-gray-200' : 'bg-white text-gray-700 border-gray-300'}`}
                      title={owner >= 0 && !mine ? `当前在「${groups[owner].name}」` : ''}>{p.replace(/(省|市|壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区)$/, '')}</button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
        <h3 className="font-medium text-gray-800">顾客取消窗口</h3>
        <Field label="接单后顾客可申请取消（分钟）" hint="0 = 关闭；申请后由店员同意或驳回，同意即全额退款"><input className={inputCls} type="number" min={0} max={30} value={s.acceptGraceMin} onChange={(e) => patch({ acceptGraceMin: Number(e.target.value) })} /></Field>
      </div>

      {error && <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}
      {loadFailed && <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">邮寄设置加载失败，上面显示的不是当前生效的值，请刷新页面后再修改。</div>}
      <div className="flex justify-end">
        <Button loading={saving} disabled={loadFailed} onClick={handleSave}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
```
（`pickup` 与 `costAlertRatio` 本批不展示，原样随 `s` 回传。）

- [ ] **Step 4: 编译两端 + 浏览器验证 + e2e 全量**

```bash
cd apps/server && npx tsc --noEmit && cd ../admin && npx tsc --noEmit && npm test
```
Expected: 全部无错。
用 `.claude/launch.json` 里的后台配置起预览，打开 `/settings/express`，按 spec §12.3 逐项截图：加载回显、切 TABLE 后加价/取整/名单隐藏、新增分组、把「四川省」从四川组点到新组后原组自动摘掉、删除「其他」被拒、保存成功 toast、刷新后回显一致、手机宽度不溢出。
```bash
DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -3
```
Expected: `失败 0`，通过数与 Task 7 一致（垫片让 §1/§6/M2 段落行为不变）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/admin/settings.ts apps/admin/src/types.ts apps/admin/src/api/admin.ts apps/admin/src/pages/ShopSettings.tsx
git commit -m "后台邮寄设置页：运费口径/定价名单/包装重量/地区分组/取消窗口；一口价旧接口改兼容垫片"
```

**复核（opus）要点**：`toggleProvince` 从原组摘掉后两组的 provinces 互斥；「其他」组名不可改不可删不可 blocked；`buildPayload` 的 `pickup/costAlertRatio` 未丢；`useUnsavedSettings` 离开提示仍生效；垫片 PUT 的响应形状与旧接口逐字段一致（e2e M2 段 `M2_ORIG_SHIP` 往返不失真）。

---

### Task 9: 小程序结算页改走服务端报价

**Files:**
- Create: `apps/miniapp/api/express.js`
- Modify: `apps/miniapp/pages/order/confirm.js`（`data`、`loadMeta/applyShipping` → `refreshQuote`、`onShow`、`onBenefitsChange`、`onSubmit/doSubmit`、错误处理）
- Modify: `apps/miniapp/pages/order/confirm.wxml:87-91,113-117`（运费行与提示行）
- Modify: `apps/miniapp/pages/order/confirm.wxss`（两条样式）

**Interfaces:**
- Consumes: `POST /express/quote`（Task 6 响应字段）、`POST /orders` 的 42261/42260/42262/42210。
- Produces: 结算页 `data.quote`、`data.quoteToken`、`data.quoteExpiresAtMs`、`data.quoteError`、`data.quoting`、`data.blockReason`。

- [ ] **Step 1: 新建 `api/express.js`**

```js
const { request } = require('../utils/request')

// 邮寄报价：清单与下单同形（cartItemIds 或 directItem，可带 gifts）。
// silent=true：结算页要按 code 自己分流（42260 不寄送要显示在页面里，不是 toast）。
function quoteExpress(data) {
  return request({ url: '/express/quote', method: 'POST', silent: true, data: data })
}

module.exports = { quoteExpress: quoteExpress }
```

- [ ] **Step 2: 改 `confirm.js`**

(a) 顶部 `require` 区加 `const { quoteExpress } = require('../../api/express')`。

(b) `data` 里删掉 `shipping: {...}`、`belowMinOrder`、`minOrderTip`、`metaFailed`，改为：
```js
    shippingFee: 0,
    payAmount: 0,
    // 服务端报价（/express/quote）。小程序不再自己算运费——两端各写一遍的口径迟早漂
    quote: null,
    quoteToken: null,
    quoteExpiresAtMs: 0,
    quoting: false,
    quoteError: '',
    // 阻塞下单的原因（不寄送 / 未达起送 / 缺地址）；空串 = 可提交
    blockReason: '',
```

(c) `loadMeta` 改成只拉订阅模板与超时（不再读 `meta.shipping`）：
```js
  loadMeta() {
    var self = this
    return getOrderMeta()
      .then(function(meta) {
        self.setData({
          subscribeTemplateIds: (meta && meta.subscribeTemplateIds) || [],
          payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
        })
      })
      .catch(function() {})
  },
```
删掉 `onRetryMeta`。

(d) `onShow`：换地址后重报价。
```js
  onShow() {
    if (app.globalData.selectedAddress) {
      this.setData({ address: app.globalData.selectedAddress })
      app.globalData.selectedAddress = null
      this.refreshQuote('address')
    }
  },
```

(e) 用 `refreshQuote` 替换整个 `applyShipping`：
```js
  // 组装与下单同形的清单参数（cartItemIds 或 directItem + gifts）——凭证按这份清单签，
  // 下单时服务端会比对指纹，所以两处必须传同一份
  quotePayload() {
    var p = { addressId: this.data.address.id }
    if (this.data.mode === 'direct') p.directItem = this.data.directItem
    else p.cartItemIds = this.data.cartItemIds
    if (this.data.gifts && this.data.gifts.length) p.gifts = this.data.gifts
    return p
  },

  /**
   * 向服务端报价。地址、清单、赠品任一变都要重来；换券**不**重来（包邮按券前小计判，运费不随券动），
   * 只在本地重算合计。序号 _quoteSeq 让在途的旧响应作废。
   */
  refreshQuote(reason) {
    var self = this
    var seq = (this._quoteSeq = (this._quoteSeq || 0) + 1)
    if (!this.data.address) {
      this.setData({ quote: null, quoteToken: null, quoteExpiresAtMs: 0, quoting: false, quoteError: '', shippingFee: 0, blockReason: '请选择收货地址' })
      this.recalcPay()
      return
    }
    if (!this.data.items.length) {
      this.setData({ quote: null, quoteToken: null, quoteExpiresAtMs: 0, quoting: false, quoteError: '', shippingFee: 0, blockReason: '' })
      this.recalcPay()
      return
    }
    this.setData({ quoting: true, quoteToken: null, quoteExpiresAtMs: 0, quoteError: '', blockReason: '' })
    quoteExpress(this.quotePayload())
      .then(function(q) {
        if (seq !== self._quoteSeq) return
        var block = ''
        if (q.belowMin) block = '还差 ¥' + formatPrice(q.minOrderAmountFen - q.subtotalFen) + ' 起送'
        self.setData({
          quoting: false,
          quote: q,
          quoteToken: block ? null : q.quoteToken,
          quoteExpiresAtMs: Date.parse(q.quoteExpiresAt) || 0,
          shippingFee: q.feeFen,
          blockReason: block,
          quoteError: '',
        })
        self.recalcPay()
      })
      .catch(function(err) {
        if (seq !== self._quoteSeq) return
        var code = err && err.code
        if (code === 42260) {
          // 不寄送：页面内提示 + 禁付款，不 toast
          self.setData({ quoting: false, quote: null, quoteToken: null, quoteExpiresAtMs: 0, shippingFee: 0, quoteError: '', blockReason: err.message || '该地区暂不支持邮寄' })
        } else if (code === 42262 || code === 42224 || code === 42202 || code === 42201) {
          self.setData({ quoting: false, quote: null, quoteToken: null, quoteExpiresAtMs: 0, shippingFee: 0, quoteError: '', blockReason: err.message })
        } else {
          var rateLimited = code === 42901 || code === 429
          self.setData({ quoting: false, quote: null, quoteToken: null, quoteExpiresAtMs: 0, shippingFee: 0, blockReason: '', quoteError: rateLimited ? '操作太频繁，请稍后再试' : '运费获取失败' })
          if (rateLimited && !self._retriedRateLimit) { self._retriedRateLimit = true; setTimeout(function() { self.refreshQuote('retry') }, 3000) }
        }
        self.recalcPay()
      })
  },

  onRetryQuote() { this.refreshQuote('retry') },

  // 合计 = 小计 − 券 + 运费（券只抵商品，不抵运费）
  recalcPay() {
    var pay = this.data.totalAmount - this.data.discount + (this.data.shippingFee || 0)
    this.setData({ payAmount: pay < 0 ? 0 : pay })
  },
```

(f) `onBenefitsChange`：换券只重算合计；赠品变了要重报价（重量变、指纹变）。
```js
  onBenefitsChange(e) {
    var d = e.detail || {}
    var giftsChanged = JSON.stringify(d.gifts || []) !== JSON.stringify(this.data.gifts || [])
    this.setData({
      couponId: d.couponId === undefined ? null : d.couponId,
      gifts: d.gifts || [],
      discount: d.discount || 0,
      pointsUsed: d.pointsUsed || 0,
    })
    if (giftsChanged) this.refreshQuote('gifts')
    else this.recalcPay()
  },
```

(g) `loadData` 的 `.then` 里把 `self.applyShipping()` 改成 `self.refreshQuote('load')`；`.catch` 里 `loadFailed: true` 那行保留，去掉对 `shippingFee/payAmount` 之外字段的引用即可。

(h) `onSubmit`：删掉 `metaFailed` 那段 `wx.showModal`；把 `belowMinOrder` 判断改成：
```js
    if (this.data.quoting) { wx.showToast({ title: '运费计算中，请稍候', icon: 'none' }); return }
    if (this.data.quoteError) { wx.showToast({ title: '运费获取失败，请重试', icon: 'none' }); this.refreshQuote('submit'); return }
    if (this.data.blockReason) { wx.showToast({ title: this.data.blockReason, icon: 'none' }); return }
    // 凭证过期就先重报价再让顾客点一次——服务端会拒 42261，但那句报错顾客看不懂
    if (this.data.quoteExpiresAtMs && Date.now() > this.data.quoteExpiresAtMs) {
      wx.showToast({ title: '运费已刷新，请再次确认', icon: 'none' })
      this.refreshQuote('expired')
      return
    }
```

(i) `doSubmit` 的 `payload` 加 `quoteToken: this.data.quoteToken || undefined`；`.catch` 里在会员三个码的判断之前加：
```js
        if (code === 42261 || code === 42260 || code === 42210 || code === 42262) {
          // 运费/地区/起送在服务端变了：重报价，页面会显示新的运费或阻塞原因
          self.refreshQuote('rejected')
          return
        }
```

- [ ] **Step 3: 改 `confirm.wxml`**

运费行（原 87–91 行）替换为：
```xml
    <view class="row">
      <text class="row-label">运费</text>
      <text wx:if="{{quoting}}" class="row-value row-wait">计算中…</text>
      <text wx:elif="{{quoteError}}" class="row-value row-wait">待重新计算</text>
      <text wx:elif="{{blockReason}}" class="row-value row-wait">—</text>
      <text wx:elif="{{shippingFee > 0}}" class="row-value">¥{{pricefmt.fen(shippingFee)}}</text>
      <text wx:else class="row-value free">{{quote && quote.freeShip ? '已包邮' : '免运费'}}</text>
    </view>
    <view wx:if="{{quote && !quoting && !quoteError && !blockReason && !quote.freeShip && quote.freeShipMinFen > 0 && quote.subtotalFen < quote.freeShipMinFen}}" class="row row-hint">
      <text class="row-hint-text">再买 ¥{{pricefmt.fen(quote.freeShipMinFen - quote.subtotalFen)}} 包邮（{{quote.groupName}}满 ¥{{pricefmt.fen(quote.freeShipMinFen)}}）</text>
    </view>
```
底部提示（原 113–117 行）替换为：
```xml
  <view wx:if="{{quoteError}}" class="min-order-tip">
    <text>{{quoteError}}　</text>
    <text class="agree-link" bindtap="onRetryQuote">重新获取运费</text>
  </view>
  <view wx:elif="{{blockReason}}" class="min-order-tip">{{blockReason}}</view>
```
提交按钮：在原按钮的 `disabled` 表达式里加 `|| quoting || !!blockReason || !!quoteError`（若原按钮没有 `disabled`，加 `disabled="{{submitting || quoting || blockReason || quoteError}}"`）。

- [ ] **Step 4: `confirm.wxss` 加两条**

```css
.row-wait { color: #999; }
.row-hint { padding-top: 0; }
.row-hint-text { font-size: 24rpx; color: #e8792b; }
```
（颜色沿用页面里已有的强调色变量；若 wxss 顶部有 `--brand` 之类变量就用它。）

- [ ] **Step 5: 验证（微信开发者工具 + 真机）**

按 spec §12.4 结算页那一段逐项：五种运费显示、换地址重报价、换券运费不变且合计对、选赠品重报价、切到不寄送地址付款按钮灰、凭证过期点付款先刷新、下单成功页金额与服务端一致、同城结算页零变化。每项截图存到 `docs/superpowers/notes/2026-09-XX-express-batch1-miniapp-screens/`。
本地联调：后端 `EXPRESS_PROVIDER_MOCK=true`，开发者工具「不校验合法域名」。

- [ ] **Step 6: 提交**

```bash
git add apps/miniapp/api/express.js apps/miniapp/pages/order/confirm.js apps/miniapp/pages/order/confirm.wxml apps/miniapp/pages/order/confirm.wxss
git commit -m "小程序邮寄结算页改走服务端报价：运费/包邮提示/不寄送阻塞/凭证过期重报价"
```

**复核（opus）要点**：`_quoteSeq` 让旧响应作废；换券不打接口；`quoteToken` 在 `belowMin` 时置空；`doSubmit` 收到 42261 后不会无限循环（重报价后等顾客再点）；`loadFailed` 与 `quoteError` 两种失败互不覆盖；同城 `pages/local/confirm.js` 一行未动。

---

### Task 10: 文档、spec 回改、全量回归与终审

**Files:**
- Modify: `docs/api.md`（新增「附录 F：全国邮寄报价（批次一）」）
- Modify: `docs/staff-guide.md`（「邮寄设置」一节）
- Modify: `docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md`（错误码、凭证可选、重量单位）
- Modify: `apps/server/.env.example`（若存在；加四个新变量）

- [ ] **Step 1: `docs/api.md` 末尾追加**

```markdown
## 附录 F：全国邮寄报价（批次一，2026-09）

### 小程序端
| 接口 | 说明 |
|---|---|
| `POST /api/express/quote` | 需登录。Body `{ addressId, cartItemIds? \| directItem?, gifts? }`（与 `POST /orders` 同形）。返回 `{ feeFen, quotedFeeFen, feeSource('QUOTE'\|'TABLE'), weightKg, groupName, freeShipMinFen, freeShip, belowMin, minOrderAmountFen, subtotalFen, quoteCount, quoteToken, quoteExpiresAt }`。**不下发各家成本价**。凭证 TTL 15 分钟，签入地址 id、清单指纹、重量、报价、各家价。 |
| `POST /api/orders`（EXPRESS 分支） | `quoteToken` **可选**（老客户端兼容）。带了：验签/有效期/地址/清单指纹任一不符 → 42261；QUOTE 口径锁凭证价、TABLE 现算。不带：服务端现查现算。包邮/起送/不寄送一律按下单时设置与真实小计判。订单落 `express_quote_snapshot / express_region_group / express_weight_g`。 |
| `GET /api/orders/meta` | `shipping` 改为邮寄设置「其他」组的兼容视图 `{ fee, freeThreshold, minOrderAmount }`，仅供老版本小程序显示。 |

### 管理端
| 接口 | 说明 |
|---|---|
| `GET/PUT /api/admin/settings/express` | 邮寄设置全量读写，结构见 `services/express-settings.ts`（`ExpressSettings`）。PUT 先 sanitize 再 validate，40001 带错误列表。 |
| `GET/PUT /api/admin/settings/shipping` | **兼容垫片**：GET = 「其他」组视图；PUT = 全部分组同一张兜底表 + 切 TABLE。批次二后删除。 |
| `/api/admin/system/express-mock/{reset,queue,calls}` | 仅 `EXPRESS_PROVIDER_MOCK=true`。`queue` Body `{ directive: {kind:'ok',quotes?} \| {kind:'timeout'} \| {kind:'error',code,message?} }`。 |

### 错误码
| 码 | 含义 |
|---|---|
| 42260 | 该地区暂不支持邮寄（省级不寄送名单） |
| 42261 | 运费已更新，请重新确认（凭证不符/过期/篡改） |
| 42262 | 收货地址过长（>300 字节） |

### 环境变量
`KD100_EXPRESS_API_URL`（默认正式地址）、`KD100_EXPRESS_KEY` / `KD100_EXPRESS_SECRET`（缺省复用 `KD100_KEY/SECRET`）、`EXPRESS_PROVIDER_MOCK`（生产禁止）。
```

- [ ] **Step 2: `docs/staff-guide.md` 在「五、换首页轮播图」之前插入**

```markdown
## 四点八、邮寄运费怎么定（后台 → 设置 → 全国邮寄）

顾客填完地址那一刻，系统会向快递100 查 9 家快递的价，取你勾选的「参与定价」那几家的**中间价**收顾客；查不到就按分组里的兜底表收。你要管的只有三件事：

1. **地区分组**：一个省只能在一个组里。每组填「满多少包邮」「兜底首重价」「兜底续重价」。勾了「不寄送」的组，顾客选那里的地址会被提示暂不支持。「其他」组不能删。
2. **每单包装重量**：泡沫箱加冰袋实称一次填进去；礼盒的重量填在商品的「净重」里。
3. **参与定价的快递**：默认极兔/圆通/申通/韵达/中通/京东六家。EMS 折后比标准还贵、德邦超 2.5 公斤不报价，默认不勾。

改完点保存，新下单立即生效；已下的单不变。
```

- [ ] **Step 3: 回改 spec**

`docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md`：§3 步骤 2 的 `42240` → `42260`；§4.1 的 `42241` → `42261` 并把「邮寄单必带 `quoteToken`」改为「带则校验，不带（老客户端）服务端现算」；§9 `expressWeightKg Decimal(6,1)` → `expressWeightG Int`；§11 表里 `42243` → `42262`。

- [ ] **Step 4: 全量回归（执行 sonnet；核对 haiku）**

```bash
cd apps/server && npx tsc --noEmit && for f in selftest-kd100 selftest-kd100-express selftest-express-settings selftest-express-quote selftest-local-settings selftest-delivery-core; do npx ts-node --transpile-only scripts/$f.ts | tail -1; done
cd ../admin && npx tsc --noEmit && npm test
cd ../.. && DB_NAME=food_shop_audit bash scripts/e2e.sh 2>&1 | tail -3
```
Expected：全部通过；e2e 通过数 ≥ 803 + 56/57 两段条数，失败 0。
haiku 核对清单：① 本计划每个任务的「提交」都在 `git log` 里；② `docs/api.md` 附录 F 的字段名与 `express-quote-service.ts` 的 `QuoteResult` 逐一对得上；③ spec 里不再出现 42240/42241/42243 与 `Decimal(6,1)`；④ `grep -rn calcShippingFee apps/server/src` 只剩 `settings.ts` 里的定义。

- [ ] **Step 5: 提交 + 终审（opus）**

```bash
git add docs/api.md docs/staff-guide.md docs/superpowers/specs/2026-09-08-express-shipping-kuaidi100-design.md apps/server/.env.example
git commit -m "文档：邮寄报价接口附录 F、店员指南邮寄设置、spec 错误码与凭证可选回改"
```
opus 终审范围：整批 diff 对照 spec §1 E1/E2/E5/E6/E9 与本计划 Global Constraints；重点找「客户端能否影响金额」「凭证能否跨地址/跨清单复用」「查价失败是否漏钱」「同城是否被牵连」四类问题。终审通过后走 `superpowers:finishing-a-development-branch`。

---

## 批次二 / 批次三（另写计划，待本批落地后）

- **批次二**：`express_bookings` 表与事件表、`kd100-express.ts` 加 `bOrder/cancel/modifyOrder/detail/synPay`、回调路由 `/api/kd-express/:bookingNo` + nginx、预约状态机、工作台按钮矩阵与预约弹窗、退款/拒单前置 42263、顾客取消窗口放开 EXPRESS、定时提醒与 UNKNOWN 对账、四类推送、`/ship` 在有活跃预约时拒绝。
- **批次三**：轨迹订阅 `pollCallBackUrl` 落库、顾客端时间线、签收自动完成、30 分钟对账任务、店主操作手册。
