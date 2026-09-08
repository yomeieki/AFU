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
t('一家一票：快递100 同一家可能回多个产品档，取最低那条参与中位数，重复行不占 minQuoteCount 名额', () => {
  // Q 里 jd 已经是 1130 那条，再追加一条更低的 999——去重后定价名单 6 家应为
  // 660,690,705,710,830,999（jd 只算一次、取 999），中位数 (705+710)/2=707.5→708
  const dup: CourierQuote[] = [...Q, { kuaidicom: 'jd', serviceType: '特惠送', priceFen: 999, defPriceFen: 1500 }]
  const sExact = { ...S, fee: { ...S.fee, roundToFen: 0 } }  // 不取整，直接看中位数原始值，避免被 roundToFen 抹平差异
  const r = calcExpressFee(sExact, SC, 1.5, dup, 5000)
  assert.strictEqual(r.feeSource, 'QUOTE')
  // 若没去重，jd 会被算两次变成 7 家（660,690,705,710,830,999,1130），中位数会变成 710，不是 708
  assert.strictEqual(r.quotedFeeFen, 708)

  // minQuoteCount 门槛按“去重后的家数”算：pool 只留两家，其中一家有两条重复报价，仍然只算 2 家有效
  const s2 = { ...S, pricingPool: ['jtexpress', 'jd'] }
  const twoRows: CourierQuote[] = [
    { kuaidicom: 'jtexpress', serviceType: '标准快递', priceFen: 660, defPriceFen: 900 },
    { kuaidicom: 'jd', serviceType: '特惠送', priceFen: 999, defPriceFen: 1500 },
    { kuaidicom: 'jd', serviceType: '标准快递', priceFen: 1130, defPriceFen: 1500 },
  ]
  assert.strictEqual(calcExpressFee({ ...s2, fee: { ...s2.fee, minQuoteCount: 2 } }, SC, 1.5, twoRows, 5000).feeSource, 'QUOTE')
  assert.strictEqual(calcExpressFee({ ...s2, fee: { ...s2.fee, minQuoteCount: 3 } }, SC, 1.5, twoRows, 5000).feeSource, 'TABLE')
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
t('blocked：不寄送分组透传到 FeeCalc，路由层若忘了拦截也能被看见', () => {
  const blockedGroup = findRegionGroup(S, '新疆维吾尔自治区')
  assert.strictEqual(blockedGroup.blocked, true)
  assert.strictEqual(calcExpressFee(S, blockedGroup, 1.5, Q, 5000).blocked, true)
  assert.strictEqual(calcExpressFee(S, SC, 1.5, Q, 5000).blocked, false)
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
  // 9 家快照实测 533 字符；卡到 < 700 让 payload 增长（比如加了新字段）尽早报警——
  // 下游 zod 的限制是 1024（不是同城报价的 512），< 700 留出余量但不会晚到临界才发现
  assert.ok(tok.length < 700, `token 太长 ${tok.length}`)
  assert.deepStrictEqual(verifyExpressQuote(tok, now), p)
  assert.strictEqual(verifyExpressQuote(tok, new Date(now.getTime() + 15 * 60 * 1000 + 1)), null)
  const [body, sig] = tok.split('.')
  assert.strictEqual(verifyExpressQuote(`${body}x.${sig}`, now), null)
  assert.strictEqual(verifyExpressQuote(`${body}.${sig.slice(0, 31)}0`, now), null)
  assert.strictEqual(verifyExpressQuote('中文.中文', now), null)
  assert.strictEqual(expressQuoteExpiresAt(now).getTime(), now.getTime() + 15 * 60 * 1000)
})
t('凭证：非字符串 token 一律判无效（调用方不能保证传进来的是字符串）', () => {
  const now = new Date('2026-09-08T04:00:00Z')
  assert.strictEqual(verifyExpressQuote(undefined as unknown, now), null)
  assert.strictEqual(verifyExpressQuote(123 as unknown, now), null)
  assert.strictEqual(verifyExpressQuote({} as unknown, now), null)
})

console.log(`\n通过 ${pass} 条${process.exitCode ? '，有失败' : ''}`)
