/**
 * 餐具规则纯函数自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-tableware.ts
 *
 * 规则来源：docs/superpowers/specs/2026-09-14-tableware-choice-design.md（T1–T10）
 * 与 docs/superpowers/plans/2026-09-14-tableware-choice.md Task 1 brief。
 */
import assert from 'assert'
import {
  tablewareSchema,
  applyLegacyTablewarePrefix,
  tablewareColumns,
  tablewareLabel,
  tablewareTicketText,
} from '../src/services/tableware'

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

// 1. tablewareLabel（界面文案）
t('tablewareLabel NONE → 无需餐具', () => {
  assert.strictEqual(tablewareLabel('NONE', null), '无需餐具')
})
t('tablewareLabel BY_MEAL → 需要餐具 · 按餐量', () => {
  assert.strictEqual(tablewareLabel('BY_MEAL', null), '需要餐具 · 按餐量')
})
t('tablewareLabel COUNT 3 → 需要餐具 · 3 份', () => {
  assert.strictEqual(tablewareLabel('COUNT', 3), '需要餐具 · 3 份')
})
t('tablewareLabel null/null → 空串', () => {
  assert.strictEqual(tablewareLabel(null, null), '')
})

// 2. tablewareTicketText（小票文案）
t('tablewareTicketText NONE → 无需餐具', () => {
  assert.strictEqual(tablewareTicketText('NONE', null), '无需餐具')
})
t('tablewareTicketText BY_MEAL → 餐具：按餐量', () => {
  assert.strictEqual(tablewareTicketText('BY_MEAL', null), '餐具：按餐量')
})
t('tablewareTicketText COUNT 3 → 餐具：3 份', () => {
  assert.strictEqual(tablewareTicketText('COUNT', 3), '餐具：3 份')
})
t('tablewareTicketText null/null → 空串', () => {
  assert.strictEqual(tablewareTicketText(null, null), '')
})

// 3. tablewareSchema
t('tablewareSchema COUNT+count=3 成功', () => {
  const r = tablewareSchema.safeParse({ mode: 'COUNT', count: 3 })
  assert.strictEqual(r.success, true)
})
t('tablewareSchema COUNT 缺 count 失败', () => {
  const r = tablewareSchema.safeParse({ mode: 'COUNT' })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.error!.issues[0].message, '指定餐具份数时请填写 1–10 份')
})
t('tablewareSchema COUNT count=0 失败', () => {
  const r = tablewareSchema.safeParse({ mode: 'COUNT', count: 0 })
  assert.strictEqual(r.success, false)
})
t('tablewareSchema COUNT count=11 失败', () => {
  const r = tablewareSchema.safeParse({ mode: 'COUNT', count: 11 })
  assert.strictEqual(r.success, false)
})
t('tablewareSchema COUNT count=1.5 失败', () => {
  const r = tablewareSchema.safeParse({ mode: 'COUNT', count: 1.5 })
  assert.strictEqual(r.success, false)
})
t('tablewareSchema BY_MEAL 带 count=2 失败', () => {
  const r = tablewareSchema.safeParse({ mode: 'BY_MEAL', count: 2 })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.error!.issues[0].message, '餐具选项无效')
})
t('tablewareSchema mode=XX 失败', () => {
  const r = tablewareSchema.safeParse({ mode: 'XX' })
  assert.strictEqual(r.success, false)
})
t('tablewareSchema COUNT+count=null 失败：份数提示', () => {
  const r = tablewareSchema.safeParse({ mode: 'COUNT', count: null })
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.error!.issues[0].message, '餐具份数为 1–10 份')
})
t('tablewareSchema.optional() 解析 null 失败：选项无效', () => {
  const r = tablewareSchema.optional().safeParse(null)
  assert.strictEqual(r.success, false)
  assert.strictEqual(r.error!.issues[0].message, '餐具选项无效')
})

// 4. applyLegacyTablewarePrefix
t('applyLegacyTablewarePrefix 带空格前缀：剥前缀 + 补 BY_MEAL', () => {
  const r = applyLegacyTablewarePrefix({ remark: '[需要餐具] 不要辣' }) as Record<string, unknown>
  assert.strictEqual(r.remark, '不要辣')
  assert.deepStrictEqual(r.tableware, { mode: 'BY_MEAL' })
})
t('applyLegacyTablewarePrefix 无空格前缀：同样剥前缀 + 补 BY_MEAL', () => {
  const r = applyLegacyTablewarePrefix({ remark: '[需要餐具]不要辣' }) as Record<string, unknown>
  assert.strictEqual(r.remark, '不要辣')
  assert.deepStrictEqual(r.tableware, { mode: 'BY_MEAL' })
})
t('applyLegacyTablewarePrefix 剥完为空串：remark 视为未填（undefined）', () => {
  const r = applyLegacyTablewarePrefix({ remark: '[需要餐具] ' }) as Record<string, unknown>
  assert.strictEqual(r.remark, undefined)
  assert.deepStrictEqual(r.tableware, { mode: 'BY_MEAL' })
})
t('applyLegacyTablewarePrefix 已带 tableware:{mode:NONE}：保留 NONE，只剥前缀', () => {
  const r = applyLegacyTablewarePrefix({ remark: '[需要餐具] 不要辣', tableware: { mode: 'NONE' } }) as Record<
    string,
    unknown
  >
  assert.strictEqual(r.remark, '不要辣')
  assert.deepStrictEqual(r.tableware, { mode: 'NONE' })
})
t('applyLegacyTablewarePrefix 带前缀 + tableware:null：只剥前缀，null 原样保留交给 zod', () => {
  const r = applyLegacyTablewarePrefix({ remark: '[需要餐具] 不要辣', tableware: null }) as Record<string, unknown>
  assert.strictEqual(r.remark, '不要辣')
  assert.strictEqual(r.tableware, null)
})
t('applyLegacyTablewarePrefix 无前缀：原样返回（同一对象引用）', () => {
  const body = { remark: '不要辣' }
  const r = applyLegacyTablewarePrefix(body)
  assert.strictEqual(r, body)
})
t('applyLegacyTablewarePrefix 非对象 null：原样返回', () => {
  assert.strictEqual(applyLegacyTablewarePrefix(null), null)
})
t('applyLegacyTablewarePrefix 非对象 数组：原样返回（同一引用）', () => {
  const body: unknown[] = []
  assert.strictEqual(applyLegacyTablewarePrefix(body), body)
})

// 5. tablewareColumns
t('tablewareColumns EXPRESS + NONE → 两列 null', () => {
  const r = tablewareColumns('EXPRESS', { mode: 'NONE' })
  assert.deepStrictEqual(r, { tablewareMode: null, tablewareCount: null })
})
t('tablewareColumns PICKUP + undefined → 两列 null', () => {
  const r = tablewareColumns('PICKUP', undefined)
  assert.deepStrictEqual(r, { tablewareMode: null, tablewareCount: null })
})
t('tablewareColumns LOCAL + COUNT 2 → COUNT/2', () => {
  const r = tablewareColumns('LOCAL', { mode: 'COUNT', count: 2 })
  assert.deepStrictEqual(r, { tablewareMode: 'COUNT', tablewareCount: 2 })
})
t('tablewareColumns PICKUP + BY_MEAL → BY_MEAL/null', () => {
  const r = tablewareColumns('PICKUP', { mode: 'BY_MEAL' })
  assert.deepStrictEqual(r, { tablewareMode: 'BY_MEAL', tablewareCount: null })
})

console.log(`\n${pass} 例通过${process.exitCode ? '，存在失败' : ''}`)
