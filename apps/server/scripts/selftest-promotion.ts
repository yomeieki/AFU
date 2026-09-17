/**
 * 全店自动满减纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-promotion.ts
 *
 * 覆盖 2026-09-17 全店满减设计 §3/§4：设置块 sanitize/validate、`promoDiscountOf`
 * 取档规则、`promoPreviewOf` 下一档判定、`computeCheckout` 接满减、小票满减行。
 *
 * channels 的键直接用 `DeliveryType`（`LOCAL`/`PICKUP`/`EXPRESS`），不是 spec 草稿里的
 * `LOCAL_DELIVERY`——这是 00 规划定稿后店主对「冲突 5」的裁定，本文件的用例照裁定后的
 * 键名写，不再有 `promoChannelOf` 映射函数需要测。
 */
import assert from 'assert'
import {
  DEFAULT_LOCAL_SETTINGS,
  sanitizeLocalSettings,
  validateLocalSettings,
  validateRawLocalSettings,
} from '../src/services/local-settings'
import { promoDiscountOf, promoPreviewOf, publicPromotionView } from '../src/services/promotion'
import { computeCheckout } from '../src/services/member/pricing'
import { renderOrderTicket } from '../src/services/ticket/content'

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

// ── sanitizeLocalSettings：promotion 块 ────────────────────────────────────

t('sanitize：缺 promotion 块 → 默认（enabled:false、name、channels、tiers:[]）', () => {
  const s = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, promotion: undefined })
  assert.deepStrictEqual(s.promotion, {
    enabled: false, name: '全店满减', startAt: null, endAt: null,
    channels: { LOCAL: true, PICKUP: false, EXPRESS: true },
    tiers: [],
  })
})

t('sanitize：tiers 乱序 + 重复 minFen + 非法行 + 12 档 → 升序、同门槛留 cut 大的、非法行丢、只剩前 10 档', () => {
  const s = sanitizeLocalSettings({
    ...DEFAULT_LOCAL_SETTINGS,
    promotion: {
      enabled: true, name: '满减', startAt: null, endAt: null,
      channels: { LOCAL: true, PICKUP: true, EXPRESS: true },
      tiers: [
        { minFen: 10000, cutFen: 1200 },
        { minFen: 5000, cutFen: 500 },
        { minFen: 5000, cutFen: 800 }, // 同门槛，留这条（cut 更大）
        { minFen: 3000, cutFen: 0 },   // cutFen 非法（< 1）
        { minFen: 3000, cutFen: -5 },  // cutFen 非法
        { minFen: 0, cutFen: 100 },    // minFen 非法（< 1）
        { minFen: 1.5, cutFen: 100 },  // minFen 非整数
        {},                             // 缺字段
        { minFen: 6000, cutFen: 600 },
        { minFen: 7000, cutFen: 700 },
        { minFen: 8000, cutFen: 800 },
        { minFen: 9000, cutFen: 900 },
        { minFen: 11000, cutFen: 1100 },
        { minFen: 12000, cutFen: 1300 },
      ],
    },
  })
  assert.deepStrictEqual(s.promotion.tiers, [
    { minFen: 5000, cutFen: 800 },
    { minFen: 6000, cutFen: 600 },
    { minFen: 7000, cutFen: 700 },
    { minFen: 8000, cutFen: 800 },
    { minFen: 9000, cutFen: 900 },
    { minFen: 10000, cutFen: 1200 },
    { minFen: 11000, cutFen: 1100 },
    { minFen: 12000, cutFen: 1300 },
  ])
  assert.strictEqual(s.promotion.tiers.length, 8, '本例合法行只有 8 条，未触发 10 档上限，先确认过滤/去重是对的')
})

t('sanitize：tiers 超过 10 档 → 截到前 10 档', () => {
  const tiers = Array.from({ length: 12 }, (_, i) => ({ minFen: (i + 1) * 1000, cutFen: (i + 1) * 10 }))
  const s = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, promotion: { ...DEFAULT_LOCAL_SETTINGS.promotion, tiers } })
  assert.strictEqual(s.promotion.tiers.length, 10)
  assert.strictEqual(s.promotion.tiers[0].minFen, 1000)
  assert.strictEqual(s.promotion.tiers[9].minFen, 10000)
})

t('sanitize：startAt 合法带时区字符串 → 归一成 ISO', () => {
  const s = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, promotion: { ...DEFAULT_LOCAL_SETTINGS.promotion, startAt: '2026-09-18T00:00:00+08:00' } })
  assert.strictEqual(s.promotion.startAt, new Date('2026-09-18T00:00:00+08:00').toISOString())
})

t('sanitize：startAt 非法值 / 空串 / undefined → null', () => {
  for (const v of ['abc', '', undefined]) {
    const s = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, promotion: { ...DEFAULT_LOCAL_SETTINGS.promotion, startAt: v } })
    assert.strictEqual(s.promotion.startAt, null, `startAt=${JSON.stringify(v)} 应回落 null`)
  }
})

// ── validateLocalSettings ──────────────────────────────────────────────────

t('validate：cutFen >= minFen → 一条含「亏本」的错', () => {
  const s = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, promotion: { ...DEFAULT_LOCAL_SETTINGS.promotion, tiers: [{ minFen: 5000, cutFen: 5000 }] } })
  const errs = validateLocalSettings(s)
  assert.ok(errs.some((e) => e.includes('亏本')), `应含亏本提示，实际: ${JSON.stringify(errs)}`)
})

t('validate：startAt >= endAt → 一条错', () => {
  const s = sanitizeLocalSettings({
    ...DEFAULT_LOCAL_SETTINGS,
    promotion: { ...DEFAULT_LOCAL_SETTINGS.promotion, startAt: '2026-10-01T00:00:00+08:00', endAt: '2026-09-01T00:00:00+08:00' },
  })
  const errs = validateLocalSettings(s)
  assert.ok(errs.some((e) => e.includes('结束时间须晚于开始时间')), `实际: ${JSON.stringify(errs)}`)
})

t('validate：enabled 且 tiers 空 → 一条错', () => {
  const s = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, promotion: { ...DEFAULT_LOCAL_SETTINGS.promotion, enabled: true, tiers: [] } })
  const errs = validateLocalSettings(s)
  assert.ok(errs.some((e) => e.includes('启用满减至少要配一档')), `实际: ${JSON.stringify(errs)}`)
})

t('validate：合法配置不新增错（与既有校验并存）', () => {
  const s = sanitizeLocalSettings({
    ...DEFAULT_LOCAL_SETTINGS,
    promotion: { enabled: true, name: '满减', startAt: null, endAt: null, channels: { LOCAL: true, PICKUP: false, EXPRESS: true }, tiers: [{ minFen: 5000, cutFen: 500 }] },
  })
  const errs = validateLocalSettings(s)
  assert.deepStrictEqual(errs, [])
})

// ── validateRawLocalSettings（原始请求体，sanitize 之前）───────────────────

t('validateRaw：endAt="2026/10/08" → 一条含「格式不正确」的错', () => {
  const errs = validateRawLocalSettings({ promotion: { endAt: '2026/10/08' } })
  assert.ok(errs.some((e) => e.includes('格式不正确')), `实际: ${JSON.stringify(errs)}`)
})

t('validateRaw：合法值 / 空串 → 无错', () => {
  assert.deepStrictEqual(validateRawLocalSettings({ promotion: { startAt: '2026-09-18T00:00:00+08:00', endAt: '' } }), [])
})

// ── promoDiscountOf：取档规则 ───────────────────────────────────────────────

const NOW = new Date('2026-09-18T04:00:00Z')
const two = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  promotion: { enabled: true, name: '满减', startAt: null, endAt: null, channels: { LOCAL: true, PICKUP: true, EXPRESS: true }, tiers: [{ minFen: 5000, cutFen: 500 }, { minFen: 10000, cutFen: 1200 }] },
})

t('promoDiscountOf：两档，小计 4999/5000/9999/10000/12000', () => {
  assert.strictEqual(promoDiscountOf(two, 4999, 'LOCAL', NOW), 0)
  assert.strictEqual(promoDiscountOf(two, 5000, 'LOCAL', NOW), 500)
  assert.strictEqual(promoDiscountOf(two, 9999, 'LOCAL', NOW), 500)
  assert.strictEqual(promoDiscountOf(two, 10000, 'LOCAL', NOW), 1200)
  assert.strictEqual(promoDiscountOf(two, 12000, 'LOCAL', NOW), 1200)
})

const messy = sanitizeLocalSettings({
  ...DEFAULT_LOCAL_SETTINGS,
  promotion: { enabled: true, name: '满减', startAt: null, endAt: null, channels: { LOCAL: true, PICKUP: true, EXPRESS: true }, tiers: [{ minFen: 5000, cutFen: 800 }, { minFen: 8000, cutFen: 600 }, { minFen: 10000, cutFen: 1200 }] },
})

t('promoDiscountOf：三档乱配，小计 9000 → 取 cut 最大（800）而不是最后一档（600）', () => {
  assert.strictEqual(promoDiscountOf(messy, 9000, 'LOCAL', NOW), 800)
})

t('promoDiscountOf：enabled:false → 0', () => {
  const s = { ...two, promotion: { ...two.promotion, enabled: false } }
  assert.strictEqual(promoDiscountOf(s, 6000, 'LOCAL', NOW), 0)
})

t('promoDiscountOf：now < startAt → 0；窗口内 → 命中；now >= endAt → 0（边界不含 endAt）', () => {
  const windowed = { ...two, promotion: { ...two.promotion, startAt: '2026-09-18T00:00:00+08:00', endAt: '2026-09-19T00:00:00+08:00' } }
  assert.strictEqual(promoDiscountOf(windowed, 6000, 'LOCAL', new Date('2026-09-17T23:00:00+08:00')), 0)
  assert.strictEqual(promoDiscountOf(windowed, 6000, 'LOCAL', new Date('2026-09-18T12:00:00+08:00')), 500)
  assert.strictEqual(promoDiscountOf(windowed, 6000, 'LOCAL', new Date('2026-09-19T00:00:00+08:00')), 0, 'now===endAt 应不生效')
})

t('promoDiscountOf：startAt/endAt 都 null → 长期生效', () => {
  assert.strictEqual(promoDiscountOf(two, 6000, 'LOCAL', new Date('2099-01-01')), 500)
})

t('promoDiscountOf：渠道未勾选 → 0；同一小计另一渠道勾选 → 命中', () => {
  const s = { ...two, promotion: { ...two.promotion, channels: { LOCAL: true, PICKUP: false, EXPRESS: true } } }
  assert.strictEqual(promoDiscountOf(s, 6000, 'PICKUP', NOW), 0)
  assert.strictEqual(promoDiscountOf(s, 6000, 'LOCAL', NOW), 500)
})

// ── promoPreviewOf ──────────────────────────────────────────────────────────

t('promoPreviewOf：未达标 3000 → discount 0，下一档 5000/500/差 2000', () => {
  assert.deepStrictEqual(promoPreviewOf(two, 3000, 'LOCAL', NOW), { active: true, discountFen: 0, nextTierMinFen: 5000, nextTierCutFen: 500, nextTierGapFen: 2000 })
})

t('promoPreviewOf：已达一档 6000 → discount 500，下一档 10000/差 4000', () => {
  assert.deepStrictEqual(promoPreviewOf(two, 6000, 'LOCAL', NOW), { active: true, discountFen: 500, nextTierMinFen: 10000, nextTierCutFen: 1200, nextTierGapFen: 4000 })
})

t('promoPreviewOf：已达最高档 12000 → 三个 null', () => {
  assert.deepStrictEqual(promoPreviewOf(two, 12000, 'LOCAL', NOW), { active: true, discountFen: 1200, nextTierMinFen: null, nextTierCutFen: null, nextTierGapFen: null })
})

t('promoPreviewOf：三档乱配小计 6000 → 跳过 8000 档（cut 600 不比当前 800 多），指向 10000', () => {
  assert.deepStrictEqual(promoPreviewOf(messy, 6000, 'LOCAL', NOW), { active: true, discountFen: 800, nextTierMinFen: 10000, nextTierCutFen: 1200, nextTierGapFen: 4000 })
})

t('promoPreviewOf：不 active → active:false，discount 0，三个 null', () => {
  const off = { ...two, promotion: { ...two.promotion, enabled: false } }
  assert.deepStrictEqual(promoPreviewOf(off, 6000, 'LOCAL', NOW), { active: false, discountFen: 0, nextTierMinFen: null, nextTierCutFen: null, nextTierGapFen: null })
})

// ── publicPromotionView ──────────────────────────────────────────────────────

t('publicPromotionView：active 随时间窗与开关变化；tiers 已排序；字段集合恰为约定的六个', () => {
  const v1 = publicPromotionView(two, NOW)
  assert.strictEqual(v1.active, true)
  assert.deepStrictEqual(Object.keys(v1).sort(), ['active', 'channels', 'endAt', 'name', 'startAt', 'tiers'])
  assert.deepStrictEqual(v1.tiers.map((t) => t.minFen), [5000, 10000])
  const off = { ...two, promotion: { ...two.promotion, enabled: false } }
  assert.strictEqual(publicPromotionView(off, NOW).active, false)
})

// ── computeCheckout：promoDiscount ────────────────────────────────────────

t('computeCheckout：promoDiscount 不传与传 0 逐字节一致', () => {
  assert.deepStrictEqual(
    computeCheckout({ subtotal: 5000, discount: 0, shippingFee: 0 }),
    computeCheckout({ subtotal: 5000, discount: 0, shippingFee: 0, promoDiscount: 0 }),
  )
})

t('computeCheckout：自取 + 满减 + 券 + 运费 + 打包费 全部叠加', () => {
  assert.deepStrictEqual(
    computeCheckout({ subtotal: 6000, pickupDiscount: 300, promoDiscount: 500, discount: 200, shippingFee: 300, packingFee: 100 }),
    { actualAmount: 5400 },
  )
})

t('computeCheckout：pickup+promo+discount > subtotal → 抛', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, pickupDiscount: 400, promoDiscount: 400, discount: 300, shippingFee: 0 }))
})

t('computeCheckout：promoDiscount 为负 → 抛', () => {
  assert.throws(() => computeCheckout({ subtotal: 1000, discount: 0, shippingFee: 0, promoDiscount: -1 }))
})

t('computeCheckout：pickup+promo+discount 恰好等于 subtotal 且运费 0 → actualAmount 0，不抛', () => {
  assert.deepStrictEqual(
    computeCheckout({ subtotal: 1000, pickupDiscount: 300, promoDiscount: 500, discount: 200, shippingFee: 0 }),
    { actualAmount: 0 },
  )
})

// ── 小票：满减行 ─────────────────────────────────────────────────────────

t('小票：满减行紧跟自取优惠之后、优惠券之前；promoDiscountAmount:0/缺省 → 不打；厨房联不含满减', () => {
  const base = {
    orderNo: 'ORD1', channel: 'PICKUP' as const,
    createdAt: new Date('2026-09-18T02:00:00Z'), paidAt: new Date('2026-09-18T02:01:00Z'),
    items: [{ productName: '凉拌牛肉', specText: null, quantity: 2, subtotal: 5000 }],
    totalAmount: 5000, shippingFee: 0, actualAmount: 4000, remark: null,
    receiverName: '张三', receiverPhone: '13800001234', receiverFullAddress: '四川省自贡市自流井区丹桂40栋底楼',
  }
  const withPromo = renderOrderTicket({ ...base, pickupDiscountAmount: 300, promoDiscountAmount: 500, discountAmount: 200 })
  const delivery = withPromo.split('<CUT>')[0]
  assert.ok(delivery.includes('满减：−¥5.00'))
  const pickupAt = delivery.indexOf('自取优惠')
  const promoAt = delivery.indexOf('满减')
  const couponAt = delivery.indexOf('优惠券')
  assert.ok(pickupAt !== -1 && promoAt !== -1 && couponAt !== -1)
  assert.ok(pickupAt < promoAt && promoAt < couponAt, `顺序应为 自取优惠 → 满减 → 优惠券，实际位置 ${pickupAt}/${promoAt}/${couponAt}`)

  const zero = renderOrderTicket({ ...base, pickupDiscountAmount: 300, promoDiscountAmount: 0, discountAmount: 200 })
  assert.ok(!zero.split('<CUT>')[0].includes('满减'))
  const missing = renderOrderTicket({ ...base, pickupDiscountAmount: 300, discountAmount: 200 })
  assert.ok(!missing.split('<CUT>')[0].includes('满减'))

  const kitchen = withPromo.split('<CUT>')[1] ?? ''
  assert.ok(!kitchen.includes('满减'))
})

console.log(`\n${pass} passed${process.exitCode ? ', 有失败' : ''}`)
