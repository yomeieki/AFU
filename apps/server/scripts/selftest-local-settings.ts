/**
 * 同城设置纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts
 */
import assert from 'assert'
import crypto from 'crypto'
import { config } from '../src/config'
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
  quoteExpiresAt,
  closedKind,
  isHolidayOn,
  isHolidayNow,
  isPickupPaused,
  shanghaiDateStr,
  minutesInPeak,
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
t('sanitize 畸形 businessHours/kd100.providers/paused 不抛错且逐字段回落', () => {
  const s = sanitizeLocalSettings({
    businessHours: [{ start: '25:00', end: '20:00' }, { start: '09:00', end: '18:00' }],
    kd100: { providers: 'not-an-array' },
    paused: { until: 12345, reason: { foo: 'bar' } },
  })
  assert.deepStrictEqual(s.businessHours, [{ start: '09:00', end: '18:00' }])
  assert.deepStrictEqual(s.kd100.providers, DEFAULT_LOCAL_SETTINGS.kd100.providers)
  assert.deepStrictEqual(s.paused, { until: null, reason: '' })
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
t('estimateMinutes = prep + 呼叫取货 + 距离/速度', () => {
  // prep 15, 15km/h → 3.75km = 15 分钟路上；pickupMinutes 串行加 callToPickupMin（默认 12）→ 15+12+15 = 42
  // （此条断言随 e21f4dd「预计送达补上呼叫→取货那一段」的 30 失效，之前一直未同步更新，这里补上）
  assert.strictEqual(estimateMinutes({ ...base, prepMinutes: 15, riderSpeedKmh: 15 }, 3750), 42)
})
t('quoteToken 往返、篡改失败、过期失败', () => {
  const P = {
    fee: 500, baseFee: 250, feeSource: 'QUOTE' as const, distanceM: 4200, addressId: 7,
    latE6: 29350000, lngE6: 104790000, storeLatE6: 29339500, storeLngE6: 104778500,
    distanceSource: 'MEASURED' as const,
  }
  const tok = signQuote(P, NOON)
  assert.deepStrictEqual(verifyQuote(tok, NOON), P)
  assert.strictEqual(verifyQuote(tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a'), NOON), null)
  // TTL 15 分钟：14 分钟仍有效、16 分钟已过期（两条一起才钉得住这个值，只测过期那条把 TTL 调大也照样绿）
  assert.notStrictEqual(verifyQuote(tok, new Date(NOON.getTime() + 14 * 60 * 1000)), null)
  assert.strictEqual(verifyQuote(tok, new Date(NOON.getTime() + 16 * 60 * 1000)), null)
  // 修复项1：sig 段换成 32 个多字节字符（字符数=32，但 Buffer 字节数=96）时应返回 null 而不是抛异常
  // （sig.length===32 曾经把「字符数」误当「字节数」校验，timingSafeEqual 两个不等长 Buffer 会抛 RangeError）
  const body = tok.split('.')[0]
  assert.strictEqual(verifyQuote(`${body}.${'汉'.repeat(32)}`, NOON), null)
})
const b64u = (x: string) => Buffer.from(x, 'utf8').toString('base64url')
const signBody = (o: Record<string, number>) => {
  const body = b64u(JSON.stringify(o))
  return `${body}.${crypto.createHmac('sha256', `quote:${config.jwt.userSecret}`).update(body).digest('hex').slice(0, 32)}`
}
t('quoteToken 必须带收货坐标：没有 la/ln 的老 token 一律作废', () => {
  // 手工拼一个「老格式」token（f/d/a/e，没有 la/ln）并用同一把密钥正确签名——
  // 它签名合法、也没过期，唯一的问题就是缺坐标。下单端点信任 token 里的距离，
  // 缺坐标就意味着「改坐标薅低价」那条路没人守，所以只能当无效处理。
  assert.strictEqual(verifyQuote(signBody({ f: 500, d: 4200, a: 7, e: NOON.getTime() + 60_000 }), NOON), null)
})
t('quoteToken 必须带门店坐标：没有 sla/sln 的老 token 一律作废', () => {
  // 同上，但缺的是门店坐标。它是 geoVersion 的全部实现——「门店搬家/改坐标 → 在途报价作废」
  // 只由这两个字段保证。缺了不能当成 0：0 会与「门店在赤道本初子午线」这种理论坐标相等，
  // 于是一张老 token 就能永远绕过门店坐标比对，签着一段与当前门店无关的距离照常计费。
  assert.strictEqual(
    verifyQuote(signBody({ f: 500, d: 4200, a: 7, la: 29350000, ln: 104790000, e: NOON.getTime() + 60_000 }), NOON),
    null
  )
})
t('quoteToken 的 distanceSource 白名单校验：缺字段或非法值一律作废，但不参与信任比对', () => {
  // 缺 ds 的老 token：与 la/ln、sla/sln 同规则，判无效。
  assert.strictEqual(
    verifyQuote(
      signBody({
        f: 500, d: 4200, a: 7, la: 29350000, ln: 104790000, sla: 29339500, sln: 104778500,
        e: NOON.getTime() + 60_000,
      }),
      NOON
    ),
    null
  )
  // ds 是白名单而非任意字符串：篡改成词表之外的值同样判无效。
  assert.strictEqual(
    verifyQuote(
      signBody({
        f: 500, d: 4200, a: 7, la: 29350000, ln: 104790000, sla: 29339500, sln: 104778500,
        ds: 'FORGED', e: NOON.getTime() + 60_000,
      } as unknown as Record<string, number>),
      NOON
    ),
    null
  )
})
t('道路距离进了 token：同一地址不同实测距离 → 不同运费档', () => {
  // 报价端签的是运力方返回的真实道路距离，下单端直接按它算钱。
  // 直线 1.6 km 的点，正西向（实测系数 2.12）道路 3.4 km 要多收一档，
  // 东北向（1.30）2.1 km 只收基础费——固定系数做不到这个区分，这正是改用实测的理由。
  assert.strictEqual(calcLocalFee(base, 3400, 3000).fee, 400)
  assert.strictEqual(calcLocalFee(base, 2100, 3000).fee, 300)
  // 直线 3 km 在范围内（× 1.7 = 5.1 km 其实已超），实测 5.4 km → 必须判超范围
  assert.strictEqual(calcLocalFee(base, 5400, 3000).inRange, false)
})

t('quoteExpiresAt 与 token 里的 e 是同一个时刻，客户端不必再硬编码 TTL', () => {
  // 小程序原来自己写死「超过 10 分钟就算陈旧」（confirm.js:398），
  // 而服务端的 TTL 是 15 分钟——两个数字各写各的，改一边另一边不知道。
  // 现在过期时刻由服务端随报价一起下发，两边共用这一个函数。
  const issuedAt = new Date('2026-09-07T00:00:00.000Z')
  assert.strictEqual(quoteExpiresAt(issuedAt).toISOString(), '2026-09-07T00:15:00.000Z')

  // 同一个 issuedAt 签出来的 token，在过期时刻前一毫秒仍可兑付、到点即失效。
  const payload = {
    fee: 600, baseFee: 350, feeSource: 'QUOTE' as const, distanceM: 2400, addressId: 7, latE6: 29350000, lngE6: 104790000,
    storeLatE6: 29339500, storeLngE6: 104778500, distanceSource: 'MEASURED' as const,
  }
  const token = signQuote(payload, issuedAt)
  // 边界口径：verifyQuote 判的是 `e < now`（local-settings.ts:606），
  // 所以**过期时刻那一毫秒本身仍然有效**，下一毫秒才失效。
  // 客户端拿 quoteExpiresAt 做「还新不新鲜」的判断时按同一口径，不要自己再留余量。
  const exp = quoteExpiresAt(issuedAt).getTime()
  assert.ok(verifyQuote(token, new Date(exp - 1)) !== null, '过期前一毫秒应当有效')
  assert.ok(verifyQuote(token, new Date(exp)) !== null, '过期时刻当毫秒仍然有效')
  assert.strictEqual(verifyQuote(token, new Date(exp + 1)), null, '过期时刻之后即失效')
})

// ── 2026-09-11：开门前不是「午间休息」；自取/休业节 ──────────────────────────
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
t('sanitize 缺 packing 时补默认值：总开关默认开、¥1/份', () => {
  const s = sanitizeLocalSettings({})
  assert.deepStrictEqual(s.packing, { enabled: true, perItemFen: 100 })
})
t('sanitize：perItemFen 越界（负数/超 ¥100）回落默认值 100，界内的合法值原样保留', () => {
  assert.strictEqual(sanitizeLocalSettings({ packing: { perItemFen: -5 } }).packing.perItemFen, 100)
  assert.strictEqual(sanitizeLocalSettings({ packing: { perItemFen: 20_000 } }).packing.perItemFen, 100)
  assert.deepStrictEqual(sanitizeLocalSettings({ packing: { enabled: false, perItemFen: 250 } }).packing, { enabled: false, perItemFen: 250 })
})
t('休业：until 含当天，过了 until 自动恢复；until=null 一直休', () => {
  const h = { ...base, holiday: { until: '2026-10-08', reason: '国庆' } }
  assert.strictEqual(isHolidayOn(h, '2026-10-08'), true)
  assert.strictEqual(isHolidayOn(h, '2026-10-09'), false)
  assert.strictEqual(isHolidayOn({ ...base, holiday: { until: null, reason: '装修' } }, '2027-01-01'), true)
  assert.strictEqual(isHolidayNow(base, NOON), false)
})
t('F4/F11：休业中 closedKind=CLOSED、nextOpenText 含「休息中」；营业时段内 isOpenNow=false', () => {
  const h = { ...base, holiday: { until: '2026-10-08', reason: '国庆' } }
  assert.strictEqual(closedKind(h, NOON), 'CLOSED')
  assert.ok(nextOpenText(h, NOON).includes('休息中'), nextOpenText(h, NOON))
  assert.strictEqual(isOpenNow(h, NOON), false)
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

t('schedule 默认关、默认值齐全', () => {
  const s = sanitizeLocalSettings({})
  assert.strictEqual(s.schedule.enabled, false)
  assert.deepStrictEqual(s.schedule, { enabled: false, slotMinutes: 30, daysAhead: 1, acceptBufferMin: 5, prepMinutes: 20, prepTicketLeadMin: 15, readyRemindEveryMin: 3, readyRemindMaxTimes: 5, callToleranceMin: 5 })
  assert.strictEqual(s.selfCancelLeadMin, 120)
})
// 上报：brief 原「schedule 越界夹取：slotMinutes 5→15、daysAhead 9→3、selfCancelLeadMin 9999→720」
// 一条未加入——它假设越界值会被夹到 min/max，但本文件的 int() helper（Step 4 也是用它实现的）
// 越界时一律回落到默认值，不做夹取，与同文件里 perItemFen 的既有用例（越界→回落默认值 100）
// 及 daysAhead/selfCancelLeadMin 自身的默认值语义一致。用实际代码验证：
// sanitizeLocalSettings({ schedule: { slotMinutes: 5 } }).schedule.slotMinutes === 30（默认值），不是 15。
// 详见执行者输出「上报」栏。
t('开通预约但没有营业时间 → 校验报错', () => {
  const s = sanitizeLocalSettings({ schedule: { enabled: true }, businessHours: [] })
  assert.ok(validateLocalSettings(s).some((e) => e.includes('预约配送')))
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
