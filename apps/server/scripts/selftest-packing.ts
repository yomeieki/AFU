/**
 * 打包费纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-packing.ts
 *
 * 公式（2026-09-13 打包费设计 §2.4，逐字执行）：
 *   perItem(product) = product.packingFeeFen ?? settings.packing.perItemFen
 *   packingFee = (settings.packing.enabled && deliveryType ∈ {LOCAL, PICKUP})
 *              ? Σ(非赠品行 quantity × perItem) : 0
 */
import assert from 'assert'
import { DEFAULT_LOCAL_SETTINGS, sanitizeLocalSettings } from '../src/services/local-settings'
import { packingFeeEach, calcPackingFee } from '../src/services/packing-fee'

let pass = 0
function t(name: string, fn: () => void) {
  try { fn(); pass++; console.log('  ✔', name) } catch (e) { console.error('  ✘', name, '\n    ', (e as Error).message); process.exitCode = 1 }
}

const base = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS }) // packing: { enabled: true, perItemFen: 100 }

t('默认 ¥1：两行共 3 份，都跟随默认 → 300', () => {
  const lines = [
    { packingFeeFen: null, quantity: 1 },
    { packingFeeFen: null, quantity: 2 },
  ]
  assert.strictEqual(calcPackingFee(base, 'LOCAL', lines), 300)
})
t('商品覆盖 0：该行不收', () => {
  const lines = [
    { packingFeeFen: 0, quantity: 2 },
    { packingFeeFen: null, quantity: 1 },
  ]
  // 覆盖 0 的那行 0 × 2 = 0，跟随默认的那行 1 × 100 = 100
  assert.strictEqual(calcPackingFee(base, 'LOCAL', lines), 100)
  assert.strictEqual(packingFeeEach(base, { packingFeeFen: 0 }), 0)
})
t('商品覆盖 250：按 250/份计', () => {
  const lines = [{ packingFeeFen: 250, quantity: 2 }]
  assert.strictEqual(calcPackingFee(base, 'LOCAL', lines), 500)
  assert.strictEqual(packingFeeEach(base, { packingFeeFen: 250 }), 250)
})
t('赠品行不计（isGift=true 整行排除，不论 quantity）', () => {
  const lines = [
    { packingFeeFen: null, quantity: 3, isGift: true },
    { packingFeeFen: null, quantity: 1, isGift: false },
  ]
  assert.strictEqual(calcPackingFee(base, 'LOCAL', lines), 100)
})
t('总开关 enabled=false：整店不收，为 0', () => {
  const off = sanitizeLocalSettings({ ...DEFAULT_LOCAL_SETTINGS, packing: { enabled: false, perItemFen: 100 } })
  const lines = [{ packingFeeFen: null, quantity: 3 }]
  assert.strictEqual(calcPackingFee(off, 'LOCAL', lines), 0)
  assert.strictEqual(packingFeeEach(off, { packingFeeFen: null }), 0)
})
t('deliveryType=EXPRESS（全国邮寄）：不收，为 0', () => {
  const lines = [{ packingFeeFen: null, quantity: 3 }]
  assert.strictEqual(calcPackingFee(base, 'EXPRESS', lines), 0)
})
t('PICKUP（到店自取）与 LOCAL 同价同口径', () => {
  const lines = [{ packingFeeFen: null, quantity: 2 }, { packingFeeFen: 0, quantity: 1 }]
  assert.strictEqual(calcPackingFee(base, 'PICKUP', lines), 200)
})

console.log(`\n${pass} 例通过${process.exitCode ? '，存在失败' : ''}`)
