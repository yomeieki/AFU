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
t('sanitize：分组内重复省份被去重', () => {
  const s = sanitizeExpressSettings({ regionGroups: [
    { name: '西南', provinces: ['四川省', '四川省', '重庆市'], freeShipMinFen: 0, tableFirstFen: 800, tableOverPerKgFen: 100, blocked: false },
  ] })
  const g = s.regionGroups.find((x) => x.name === '西南')!
  assert.deepStrictEqual(g.provinces, ['四川省', '重庆市'])
})
t("sanitize：''/null/false/[] 这类空输入按数字字段回落，不当成合法 0", () => {
  const s = sanitizeExpressSettings({ weight: { packagingG: '' }, acceptGraceMin: null })
  assert.strictEqual(s.weight.packagingG, 800)
  assert.strictEqual(s.acceptGraceMin, 10)
  const s2 = sanitizeExpressSettings({ costAlertRatio: false, regionGroups: [
    { name: '其他', provinces: [], freeShipMinFen: [], tableFirstFen: '   ', tableOverPerKgFen: 200, blocked: false },
  ] })
  assert.strictEqual(s2.costAlertRatio, 1.2)
  const other = s2.regionGroups.find((g) => g.name === OTHER_GROUP)!
  assert.strictEqual(other.freeShipMinFen, 0)
  assert.strictEqual(other.tableFirstFen, 0)
})
t('validate：缺其他组 / 其他组 blocked / 省份重复 / 分组名重复 / 定价名单不足 2 家 / 中位数家数超过定价名单 都报错', () => {
  const base = DEFAULT_EXPRESS_SETTINGS
  assert.ok(validateExpressSettings({ ...base, regionGroups: base.regionGroups.filter((g) => g.name !== OTHER_GROUP) }).some((e) => e.includes('其他')))
  assert.ok(validateExpressSettings({ ...base, regionGroups: base.regionGroups.map((g) => g.name === OTHER_GROUP ? { ...g, blocked: true } : g) }).some((e) => e.includes('其他')))
  const dup = base.regionGroups.map((g) => g.name === '周边' ? { ...g, provinces: [...g.provinces, '四川省'] } : g)
  assert.ok(validateExpressSettings({ ...base, regionGroups: dup }).some((e) => e.includes('四川省')))
  const dupName = base.regionGroups.map((g) => g.name === '周边' ? { ...g, name: '四川' } : g)
  assert.ok(validateExpressSettings({ ...base, regionGroups: dupName }).some((e) => e.includes('分组名重复')))
  assert.ok(validateExpressSettings({ ...base, pricingPool: ['jd'] }).some((e) => e.includes('定价')))
  assert.ok(validateExpressSettings({ ...base, fee: { ...base.fee, minQuoteCount: base.pricingPool.length + 1 } }).some((e) => e.includes('中位数')))
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
t('findRegionGroup：畸形数据里没有「其他」组也不抛，兜底返回名为「其他」的组（且是拷贝，不是模块常量本身）', () => {
  const s = { ...DEFAULT_EXPRESS_SETTINGS, regionGroups: DEFAULT_EXPRESS_SETTINGS.regionGroups.filter((g) => g.name !== OTHER_GROUP) }
  const g = findRegionGroup(s, '北京市')
  assert.strictEqual(g.name, OTHER_GROUP)
  assert.notStrictEqual(g, DEFAULT_EXPRESS_SETTINGS.regionGroups.find((x) => x.name === OTHER_GROUP))
  g.provinces.push('毒污染')
  assert.strictEqual(DEFAULT_EXPRESS_SETTINGS.regionGroups.find((x) => x.name === OTHER_GROUP)!.provinces.includes('毒污染'), false)
})
t('legacyShippingView / applyLegacyShipping 往返：blocked 组的 blocked 不变、freeShipMinFen 不跟着一口价走', () => {
  const s = applyLegacyShipping(DEFAULT_EXPRESS_SETTINGS, { fee: 500, freeThreshold: 9900, minOrderAmount: 2000 })
  assert.strictEqual(s.fee.mode, 'TABLE')
  for (const g of s.regionGroups) {
    assert.strictEqual(g.tableFirstFen, 500)
    assert.strictEqual(g.tableOverPerKgFen, 0)
    if (g.blocked) { assert.strictEqual(g.freeShipMinFen, 0) } else { assert.strictEqual(g.freeShipMinFen, 9900) }
  }
  const blocked = s.regionGroups.find((g) => g.name === '不寄送')!
  assert.strictEqual(blocked.blocked, true)
  assert.deepStrictEqual(legacyShippingView(s), { fee: 500, freeThreshold: 9900, minOrderAmount: 2000 })
})
t('迁移语义（getExpressSettings 首次无行分支复用 applyLegacyShipping）：完全复刻旧一口价，0 也照搬', () => {
  // legacy.fee=500：mode TABLE，非 blocked 组 500/0/9900（首重/续重/包邮门槛），blocked 组 500/0/0
  const s = applyLegacyShipping(DEFAULT_EXPRESS_SETTINGS, { fee: 500, freeThreshold: 9900, minOrderAmount: 2000 })
  assert.strictEqual(s.fee.mode, 'TABLE')
  assert.strictEqual(s.minOrderAmountFen, 2000)
  for (const g of s.regionGroups) {
    assert.strictEqual(g.tableFirstFen, 500)
    assert.strictEqual(g.tableOverPerKgFen, 0)
    assert.strictEqual(g.freeShipMinFen, g.blocked ? 0 : 9900)
  }
  // legacy.fee=0（旧一口价就是免运费）：tableFirstFen 处处为 0，不能被误当成"未配置"回落到默认 ¥12
  const s0 = applyLegacyShipping(DEFAULT_EXPRESS_SETTINGS, { fee: 0, freeThreshold: 0, minOrderAmount: 0 })
  for (const g of s0.regionGroups) {
    assert.strictEqual(g.tableFirstFen, 0)
    assert.strictEqual(g.tableOverPerKgFen, 0)
    assert.strictEqual(g.freeShipMinFen, 0)
  }
  assert.strictEqual(s0.minOrderAmountFen, 0)
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
