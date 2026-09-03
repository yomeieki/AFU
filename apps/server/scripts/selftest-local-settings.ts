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
t('estimateMinutes = prep + 距离/速度', () => {
  // prep 15, 15km/h → 3.75km = 15 分钟 → 30
  assert.strictEqual(estimateMinutes({ ...base, prepMinutes: 15, riderSpeedKmh: 15 }, 3750), 30)
})
t('quoteToken 往返、篡改失败、过期失败', () => {
  const tok = signQuote({ fee: 500, distanceM: 4200, addressId: 7, version: 3 }, NOON)
  assert.deepStrictEqual(verifyQuote(tok, NOON), { fee: 500, distanceM: 4200, addressId: 7, version: 3 })
  assert.strictEqual(verifyQuote(tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a'), NOON), null)
  assert.strictEqual(verifyQuote(tok, new Date(NOON.getTime() + 6 * 60 * 1000)), null)
  // 修复项1：sig 段换成 32 个多字节字符（字符数=32，但 Buffer 字节数=96）时应返回 null 而不是抛异常
  // （sig.length===32 曾经把「字符数」误当「字节数」校验，timingSafeEqual 两个不等长 Buffer 会抛 RangeError）
  const body = tok.split('.')[0]
  assert.strictEqual(verifyQuote(`${body}.${'汉'.repeat(32)}`, NOON), null)
})

console.log(`\n${process.exitCode ? '有失败' : `全部通过 ${pass}`}`)
