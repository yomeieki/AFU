/**
 * 库存预警纯函数自测（无需 DB）：
 *   cd apps/server && TZ=Asia/Shanghai npx ts-node --transpile-only scripts/selftest-low-stock.ts
 */
import assert from 'assert'
import { config } from '../src/config'
import { sanitizeLowStockSettings, validateLowStockSettings, type LowStockSettings } from '../src/services/low-stock-settings'
import {
  classifyStock, pushLevelOf, diffAlertTransitions, dailySummaryDueAt, shouldSendDaily,
  buildLowStockChangeContent, buildLowStockDailyContent,
  type StockUnit, type AlertState, type AlertLevel, type LowStockOverview,
} from '../src/services/low-stock'
import { DEFAULT_LOCAL_SETTINGS, type LocalDeliverySettings } from '../src/services/local-settings'
void config // 仅为触发 TZ 钉死（config.ts 顶部 pinTimezone）

let pass = 0
function t(name: string, fn: () => void) {
  try {
    fn()
    pass++
    console.log('  ✔', name)
  } catch (e) {
    console.error('  ✘', name, '\n    ', (e as Error).message)
    process.exitCode = 1
  }
}

const S: LowStockSettings = { lowThreshold: 3, pushBelow: 2 }

function u(key: string, opts: Partial<StockUnit> = {}): StockUnit {
  return {
    key,
    productId: opts.productId ?? 1,
    productName: opts.productName ?? '测试商品',
    channel: opts.channel ?? 'LOCAL',
    coverImage: null,
    skuId: opts.skuId ?? null,
    specText: opts.specText ?? null,
    stock: opts.stock ?? 0,
    onShelf: opts.onShelf ?? true,
    sortOrder: opts.sortOrder ?? 0,
    ...opts,
  }
}

const emptyState = (): AlertState => ({ levels: {}, dailySentOn: null })

// ── a. sanitizeLowStockSettings ─────────────────────────────
t('sanitize：空输入 → 默认 {3,2}', () => {
  assert.deepStrictEqual(sanitizeLowStockSettings({}), { lowThreshold: 3, pushBelow: 2 })
  assert.deepStrictEqual(sanitizeLowStockSettings(null), { lowThreshold: 3, pushBelow: 2 })
})
t('sanitize：pushBelow > lowThreshold 回落到 lowThreshold', () => {
  assert.deepStrictEqual(sanitizeLowStockSettings({ lowThreshold: 4, pushBelow: 9 }), { lowThreshold: 4, pushBelow: 4 })
})
t('sanitize：负数/小数/字符串 → 默认值', () => {
  assert.deepStrictEqual(sanitizeLowStockSettings({ lowThreshold: -1, pushBelow: 1.5 }), { lowThreshold: 3, pushBelow: 2 })
  assert.deepStrictEqual(sanitizeLowStockSettings({ lowThreshold: 'x', pushBelow: 'y' }), { lowThreshold: 3, pushBelow: 2 })
})
t('sanitize：上限 999', () => {
  assert.deepStrictEqual(sanitizeLowStockSettings({ lowThreshold: 1000, pushBelow: 1 }), { lowThreshold: 3, pushBelow: 1 })
  assert.deepStrictEqual(sanitizeLowStockSettings({ lowThreshold: 999, pushBelow: 999 }), { lowThreshold: 999, pushBelow: 999 })
})
t('validate：合法值无错误', () => {
  assert.deepStrictEqual(validateLowStockSettings({ lowThreshold: 3, pushBelow: 2 }), [])
})
t('validate：pushBelow > lowThreshold 报错', () => {
  assert.ok(validateLowStockSettings({ lowThreshold: 3, pushBelow: 5 }).length > 0)
})
t('validate：非法整数报错', () => {
  assert.ok(validateLowStockSettings({ lowThreshold: 0, pushBelow: 2 }).length > 0)
})

// ── b. classifyStock ─────────────────────────────────────────
t('classifyStock：0/-1 → OUT', () => {
  assert.strictEqual(classifyStock(0, S), 'OUT')
  assert.strictEqual(classifyStock(-1, S), 'OUT')
})
t('classifyStock：1..3 → LOW（lowThreshold=3）', () => {
  assert.strictEqual(classifyStock(1, S), 'LOW')
  assert.strictEqual(classifyStock(2, S), 'LOW')
  assert.strictEqual(classifyStock(3, S), 'LOW')
})
t('classifyStock：4 → OK', () => {
  assert.strictEqual(classifyStock(4, S), 'OK')
})
t('classifyStock：lowThreshold=5 时 5→LOW、6→OK', () => {
  const s5: LowStockSettings = { lowThreshold: 5, pushBelow: 2 }
  assert.strictEqual(classifyStock(5, s5), 'LOW')
  assert.strictEqual(classifyStock(6, s5), 'OK')
})

// ── c. pushLevelOf ────────────────────────────────────────────
t('pushLevelOf：0 → OUT，1 → LOW，2 → null（pushBelow=2）', () => {
  assert.strictEqual(pushLevelOf(0, S), 'OUT')
  assert.strictEqual(pushLevelOf(1, S), 'LOW')
  assert.strictEqual(pushLevelOf(2, S), null)
})
t('pushLevelOf：pushBelow=1 时 1 → null', () => {
  const s1: LowStockSettings = { lowThreshold: 3, pushBelow: 1 }
  assert.strictEqual(pushLevelOf(1, s1), null)
})

// ── d. diffAlertTransitions ───────────────────────────────────
t('3→1：推 LOW，状态 LOW；再扫一次（仍 1）：不推', () => {
  const r1 = diffAlertTransitions(emptyState(), [u('a', { stock: 1 })], S)
  assert.deepStrictEqual(r1.pushes.map((p) => p.level), ['LOW'])
  assert.deepStrictEqual(r1.nextLevels, { a: 'LOW' })
  const r2 = diffAlertTransitions({ levels: r1.nextLevels, dailySentOn: null }, [u('a', { stock: 1 })], S)
  assert.deepStrictEqual(r2.pushes, [])
  assert.deepStrictEqual(r2.nextLevels, { a: 'LOW' })
})
t('1→0：推 OUT，状态 OUT；再扫：不推', () => {
  const r1 = diffAlertTransitions({ levels: { a: 'LOW' }, dailySentOn: null }, [u('a', { stock: 0 })], S)
  assert.deepStrictEqual(r1.pushes.map((p) => p.level), ['OUT'])
  assert.deepStrictEqual(r1.nextLevels, { a: 'OUT' })
  const r2 = diffAlertTransitions({ levels: r1.nextLevels, dailySentOn: null }, [u('a', { stock: 0 })], S)
  assert.deepStrictEqual(r2.pushes, [])
})
t('0→1：不推，状态仍 OUT；1→0：不推', () => {
  const r1 = diffAlertTransitions({ levels: { a: 'OUT' }, dailySentOn: null }, [u('a', { stock: 1 })], S)
  assert.deepStrictEqual(r1.pushes, [])
  assert.deepStrictEqual(r1.nextLevels, { a: 'OUT' })
  const r2 = diffAlertTransitions({ levels: r1.nextLevels, dailySentOn: null }, [u('a', { stock: 0 })], S)
  assert.deepStrictEqual(r2.pushes, [])
  assert.deepStrictEqual(r2.nextLevels, { a: 'OUT' })
})
t('0→5：不推，状态删除；随后 5→0：推 OUT（只一条，没有 LOW）', () => {
  const r1 = diffAlertTransitions({ levels: { a: 'OUT' }, dailySentOn: null }, [u('a', { stock: 5 })], S)
  assert.deepStrictEqual(r1.pushes, [])
  assert.deepStrictEqual(r1.nextLevels, {})
  const r2 = diffAlertTransitions({ levels: r1.nextLevels, dailySentOn: null }, [u('a', { stock: 0 })], S)
  assert.deepStrictEqual(r2.pushes.map((p) => p.level), ['OUT'])
})
t('3→0（无状态直接跌到 0）：只推一条 OUT', () => {
  const r = diffAlertTransitions(emptyState(), [u('a', { stock: 0 })], S)
  assert.strictEqual(r.pushes.length, 1)
  assert.strictEqual(r.pushes[0].level, 'OUT')
})
t('单位从 units 里消失（下架/删除）：状态删除', () => {
  const r = diffAlertTransitions({ levels: { a: 'OUT', b: 'LOW' }, dailySentOn: null }, [u('b', { stock: 1 })], S)
  assert.ok(!('a' in r.nextLevels))
})
t('同一轮多个单位各自独立：两个单位同时跌到 0 → 两条 push、两个状态', () => {
  const r = diffAlertTransitions(emptyState(), [u('a', { stock: 0 }), u('b', { stock: 0 })], S)
  assert.strictEqual(r.pushes.length, 2)
  assert.deepStrictEqual(r.nextLevels, { a: 'OUT', b: 'OUT' })
})
// R1-3 追加
t('onShelf=false、stock=0、prev=OUT：不推、状态仍 OUT', () => {
  const r = diffAlertTransitions({ levels: { a: 'OUT' }, dailySentOn: null }, [u('a', { stock: 0, onShelf: false })], S)
  assert.deepStrictEqual(r.pushes, [])
  assert.deepStrictEqual(r.nextLevels, { a: 'OUT' })
})
t('onShelf=false、stock=0、prev 无：不推、状态仍无', () => {
  const r = diffAlertTransitions(emptyState(), [u('a', { stock: 0, onShelf: false })], S)
  assert.deepStrictEqual(r.pushes, [])
  assert.deepStrictEqual(r.nextLevels, {})
})
t('onShelf=false、stock=5、prev=OUT：状态删除（重置不看在架）', () => {
  const r = diffAlertTransitions({ levels: { a: 'OUT' }, dailySentOn: null }, [u('a', { stock: 5, onShelf: false })], S)
  assert.deepStrictEqual(r.nextLevels, {})
})
t('单位从 units 消失、prev=OUT：状态删除', () => {
  const r = diffAlertTransitions({ levels: { a: 'OUT' }, dailySentOn: null }, [], S)
  assert.deepStrictEqual(r.nextLevels, {})
})
t('同一轮：A 在架 0(OUT)、B 下架 0(OUT)、C 被删(LOW) → 0 条 push，nextLevels 只剩 A、B', () => {
  const prev: AlertState = { levels: { a: 'OUT', b: 'OUT', c: 'LOW' }, dailySentOn: null }
  const units = [u('a', { stock: 0, onShelf: true }), u('b', { stock: 0, onShelf: false })]
  const r = diffAlertTransitions(prev, units, S)
  assert.deepStrictEqual(r.pushes, [])
  assert.deepStrictEqual(r.nextLevels, { a: 'OUT', b: 'OUT' })
})

// ── e. dailySummaryDueAt ──────────────────────────────────────
t('dailySummaryDueAt：乱序时段取最早 start，减 30 分钟，同一天', () => {
  const hours = [{ start: '16:30', end: '19:30' }, { start: '10:00', end: '14:30' }]
  const now = new Date(2026, 8, 24, 8, 0, 0)
  const due = dailySummaryDueAt(hours, now)
  assert.ok(due)
  assert.strictEqual(due!.getHours(), 9)
  assert.strictEqual(due!.getMinutes(), 30)
  assert.strictEqual(due!.getDate(), now.getDate())
})
t('dailySummaryDueAt：跨零点减法不炸（00:10 减 30 分钟 = 前一天 23:40）', () => {
  const now = new Date(2026, 8, 24, 8, 0, 0)
  const due = dailySummaryDueAt([{ start: '00:10', end: '12:00' }], now)
  assert.ok(due)
  assert.strictEqual(due!.getHours(), 23)
  assert.strictEqual(due!.getMinutes(), 40)
  assert.strictEqual(due!.getDate(), now.getDate() - 1)
})
t('dailySummaryDueAt：空数组 → null', () => {
  assert.strictEqual(dailySummaryDueAt([], new Date()), null)
})

// ── f. shouldSendDaily ────────────────────────────────────────
function localSettingsWith(patch: Partial<LocalDeliverySettings>): LocalDeliverySettings {
  return { ...DEFAULT_LOCAL_SETTINGS, businessHours: [{ start: '10:00', end: '20:00' }], ...patch }
}
t('shouldSendDaily：dailySentOn===今天 → false', () => {
  const now = new Date(2026, 8, 24, 9, 40, 0)
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const s = localSettingsWith({ holiday: null })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: today }, s, now), false)
})
t('shouldSendDaily：now < due → false', () => {
  const now = new Date(2026, 8, 24, 9, 0, 0) // due=9:30
  const s = localSettingsWith({ holiday: null })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: null }, s, now), false)
})
t('shouldSendDaily：now ≥ due 且未发 → true', () => {
  const now = new Date(2026, 8, 24, 9, 40, 0)
  const s = localSettingsWith({ holiday: null })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: null }, s, now), true)
})
t('shouldSendDaily：businessHours=[] → false', () => {
  const now = new Date(2026, 8, 24, 9, 40, 0)
  const s = localSettingsWith({ businessHours: [], holiday: null })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: null }, s, now), false)
})
t('shouldSendDaily：holiday={until:null} → false（无限期休业）', () => {
  const now = new Date(2026, 8, 24, 9, 40, 0)
  const s = localSettingsWith({ holiday: { until: null, reason: 'x' } })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: null }, s, now), false)
})
t('shouldSendDaily：holiday until=2026-09-23、now=09-24 09:40 → true（休业已过）', () => {
  const now = new Date(2026, 8, 24, 9, 40, 0)
  const s = localSettingsWith({ holiday: { until: '2026-09-23', reason: 'x' } })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: null }, s, now), true)
})
t('shouldSendDaily：holiday until=2026-09-24 同一 now → false', () => {
  const now = new Date(2026, 8, 24, 9, 40, 0)
  const s = localSettingsWith({ holiday: { until: '2026-09-24', reason: 'x' } })
  assert.strictEqual(shouldSendDaily({ levels: {}, dailySentOn: null }, s, now), false)
})

// ── g. 文案纯函数 ────────────────────────────────────────────
t('buildLowStockChangeContent：门槛数字来自参数、含渠道字，不写死', () => {
  const s: LowStockSettings = { lowThreshold: 4, pushBelow: 3 }
  const pushes: { unit: StockUnit; level: AlertLevel }[] = [
    { unit: u('sku:1', { productName: '钻子牛肉', specText: '白味/100克', channel: 'LOCAL', stock: 0 }), level: 'OUT' },
    { unit: u('sku:2', { productName: '麻辣牛肉', specText: '白味/200克', channel: 'EXPRESS', stock: 1 }), level: 'LOW' },
  ]
  const content = buildLowStockChangeContent(pushes, s)
  assert.ok(content.includes('同城'), '缺同城渠道字')
  assert.ok(content.includes('邮寄'), '缺邮寄渠道字')
  assert.ok(content.includes('钻子牛肉') && content.includes('白味/100克'))
  assert.ok(content.includes('麻辣牛肉') && content.includes('白味/200克'))
  assert.ok(content.includes('3'), '推送门槛 3 应出现在文案里')
  assert.ok(content.includes('已售罄'))
  assert.ok(!content.includes('≤3'), '即时推送文案不该用 ≤ 格式（那是每日汇总门槛的写法）')
})
t('buildLowStockDailyContent：门槛数字来自参数、含渠道字，超 30 行截断', () => {
  const s: LowStockSettings = { lowThreshold: 4, pushBelow: 3 }
  const groups = [
    { productId: 1, productName: '钻子牛肉', channel: 'LOCAL' as const, coverImage: null, hasSkus: true, out: 1, low: 0, units: [{ key: 'sku:1', skuId: 1, specText: '白味/100克', stock: 0, level: 'OUT' as const }] },
    { productId: 2, productName: '麻辣牛肉', channel: 'EXPRESS' as const, coverImage: null, hasSkus: true, out: 0, low: 1, units: [{ key: 'sku:2', skuId: 2, specText: '白味/200克', stock: 2, level: 'LOW' as const }] },
  ]
  const overview: LowStockOverview = {
    settings: s,
    counts: { total: 2, out: 1, low: 1, byChannel: { EXPRESS: { out: 0, low: 1 }, LOCAL: { out: 1, low: 0 } } },
    groups,
  }
  const content = buildLowStockDailyContent(overview, s)
  assert.ok(content.includes('同城') && content.includes('邮寄'))
  assert.ok(content.includes('4'), '紧张门槛 4 应出现在文案里')
  assert.ok(content.includes('钻子牛肉') && content.includes('麻辣牛肉'))

  // 超过 30 行截断
  const manyGroups = Array.from({ length: 40 }, (_, i) => ({
    productId: i + 1,
    productName: `商品${i}`,
    channel: 'LOCAL' as const,
    coverImage: null,
    hasSkus: false,
    out: 1,
    low: 0,
    units: [{ key: `product:${i}`, skuId: null, specText: null, stock: 0, level: 'OUT' as const }],
  }))
  const bigOverview: LowStockOverview = {
    settings: s,
    counts: { total: 40, out: 40, low: 0, byChannel: { EXPRESS: { out: 0, low: 0 }, LOCAL: { out: 40, low: 0 } } },
    groups: manyGroups,
  }
  const bigContent = buildLowStockDailyContent(bigOverview, s)
  assert.ok(bigContent.includes('其余'), '超过 30 行应带「…其余 N 项」')
})

console.log(`\n全部通过 ${pass}`)
