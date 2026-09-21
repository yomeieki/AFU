import { test } from 'node:test'
import assert from 'node:assert/strict'

// 小程序组件用 Component(...) 全局函数注册；测试体内先接管 globalThis.Component
// 再用 require()（不能用顶层 import，否则打包后 import 会先于这里的赋值执行）加载组件文件，
// 这样才能拿到传给 Component 的 { data, methods, observers }。
let componentOpts: { data: Record<string, unknown>; methods: Record<string, (...args: unknown[]) => unknown> } | null = null

function loadComponentOnce() {
  if (componentOpts) return componentOpts
  ;(globalThis as unknown as { Component: (opts: typeof componentOpts) => void }).Component = (opts) => {
    componentOpts = opts
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('../../apps/miniapp/components/sku-popup/index.js')
  if (!componentOpts) throw new Error('Component() 未被调用')
  return componentOpts
}

interface FakeInstance {
  properties: { product: unknown }
  data: Record<string, unknown>
  setData(patch: Record<string, unknown>): void
  [method: string]: unknown
}

function makeInstance(product: unknown): FakeInstance {
  const opts = loadComponentOnce()
  const inst: FakeInstance = {
    properties: { product },
    data: { ...opts.data },
    setData(patch: Record<string, unknown>) {
      Object.assign(inst.data, patch)
    },
  }
  for (const [name, fn] of Object.entries(opts.methods)) {
    inst[name] = (fn as (...args: unknown[]) => unknown).bind(inst)
  }
  return inst
}

function buildProduct(skus: Array<{ id: number; specValues: string[]; price: number; stock: number }>) {
  return {
    id: 1,
    price: 1000,
    originalPrice: null,
    stock: skus.reduce((s, k) => s + k.stock, 0),
    unit: '份',
    specDimensions: [
      { name: '骨型', values: ['带骨', '去骨'] },
      { name: '辣度', values: ['微辣', '中辣'] },
    ],
    skus: skus.map((k) => ({ ...k, originalPrice: null, sortOrder: k.id })),
  }
}

test('P1 维度重排后：默认选中第一个有库存的组合，dimGroups 顺序与维度顺序一致', () => {
  const product = buildProduct([
    { id: 1, specValues: ['带骨', '微辣'], price: 1000, stock: 0 },
    { id: 2, specValues: ['带骨', '中辣'], price: 1200, stock: 5 },
  ])
  const inst = makeInstance(product)
  ;(inst.initSelection as () => void)()

  assert.deepEqual(inst.data.selected, ['带骨', '中辣'])
  assert.equal(inst.data.currentSkuId, 2)
  const dimGroups = inst.data.dimGroups as Array<{ name: string }>
  assert.deepEqual(dimGroups.map((g) => g.name), ['骨型', '辣度'])
})

test('P2 售罄置灰：库存为 0 的组合 disabled=true，有库存的 disabled=false', () => {
  const product = buildProduct([
    { id: 1, specValues: ['带骨', '微辣'], price: 1000, stock: 0 },
    { id: 2, specValues: ['带骨', '中辣'], price: 1200, stock: 5 },
  ])
  const inst = makeInstance(product)
  ;(inst.initSelection as () => void)()

  const dimGroups = inst.data.dimGroups as Array<{ name: string; options: Array<{ value: string; disabled: boolean }> }>
  const spicyGroup = dimGroups[1]
  assert.equal(spicyGroup.name, '辣度')
  const mildOption = spicyGroup.options.find((o) => o.value === '微辣')!
  const hotOption = spicyGroup.options.find((o) => o.value === '中辣')!
  assert.equal(mildOption.disabled, true)
  assert.equal(hotOption.disabled, false)
})

test('无规格商品：直接用商品级价格/库存，不生成 dimGroups', () => {
  const product = { id: 1, price: 800, originalPrice: null, stock: 3, unit: '份', specDimensions: [], skus: [] }
  const inst = makeInstance(product)
  ;(inst.initSelection as () => void)()

  assert.deepEqual(inst.data.dimGroups, [])
  assert.equal(inst.data.canConfirm, true)
  assert.equal(inst.data.currentSkuId, null)
})

test('P3 全部售罄：默认选中第一个 SKU 的规格值，canConfirm 为 false', () => {
  const product = buildProduct([
    { id: 1, specValues: ['带骨', '微辣'], price: 1000, stock: 0 },
    { id: 2, specValues: ['带骨', '中辣'], price: 1200, stock: 0 },
  ])
  const inst = makeInstance(product)
  ;(inst.initSelection as () => void)()

  assert.deepEqual(inst.data.selected, ['带骨', '微辣'])
  assert.equal(inst.data.canConfirm, false)
})
