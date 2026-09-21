import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSpecs, syncProductSkus, type SkuTx } from '../src/services/specs'
import { AppError } from '../src/middlewares/error'

interface FakeRow {
  id: number
  productId: number
  specText: string
  specValues: string[]
  price: number
  originalPrice: number | null
  stock: number
  sortOrder: number
}

interface FakeCall {
  method: 'findMany' | 'deleteMany' | 'update' | 'create'
  args: unknown
}

function makeFakeTx(initial: FakeRow[]) {
  let rows = initial.map((r) => ({ ...r }))
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1
  const calls: FakeCall[] = []

  function assertUnique(productId: number, specText: string, excludeId?: number) {
    if (rows.some((r) => r.productId === productId && r.specText === specText && r.id !== excludeId)) {
      throw new Error(`unique constraint violated: (productId=${productId}, specText=${specText})`)
    }
  }

  const tx: SkuTx = {
    productSku: {
      async findMany({ where }: { where: { productId: number } }) {
        calls.push({ method: 'findMany', args: { where } })
        return rows.filter((r) => r.productId === where.productId).map((r) => ({ id: r.id, specText: r.specText }))
      },
      async deleteMany({ where }: { where: { id: { in: number[] }; productId: number } }) {
        calls.push({ method: 'deleteMany', args: { where } })
        const ids = new Set(where.id.in)
        const before = rows.length
        rows = rows.filter((r) => !(ids.has(r.id) && r.productId === where.productId))
        return { count: before - rows.length }
      },
      async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
        calls.push({ method: 'update', args: { where, data } })
        const row = rows.find((r) => r.id === where.id)
        if (!row) throw new Error(`row ${where.id} not found`)
        if (typeof data.specText === 'string') assertUnique(row.productId, data.specText, row.id)
        Object.assign(row, data)
        return { ...row }
      },
      async create({ data }: { data: Record<string, unknown> }) {
        calls.push({ method: 'create', args: { data } })
        const productId = data.productId as number
        const specText = data.specText as string
        assertUnique(productId, specText)
        const row: FakeRow = {
          id: nextId++,
          productId,
          specText,
          specValues: data.specValues as string[],
          price: data.price as number,
          originalPrice: (data.originalPrice as number | null) ?? null,
          stock: data.stock as number,
          sortOrder: data.sortOrder as number,
        }
        rows.push(row)
        return { ...row }
      },
    },
  }

  return { tx, calls, getRows: () => rows.map((r) => ({ ...r })) }
}

function sku(
  id: number | undefined,
  specText: string,
  specValues: string[],
  sortOrder = 0,
  overrides: Partial<{ price: number; originalPrice: number | null; stock: number }> = {}
) {
  return {
    ...(id !== undefined ? { id } : {}),
    specText,
    specValues,
    price: overrides.price ?? 100,
    originalPrice: overrides.originalPrice ?? null,
    stock: overrides.stock ?? 1,
    sortOrder,
  }
}

// ---- S1 / S2 / S3 ----
test('S1 validateSpecs 拒绝同维度重复值（含去首尾空格后重复），文案精确等于 M4', () => {
  const dims = [{ name: '辣度', values: ['中辣', '中辣'] }]
  assert.throws(() => validateSpecs(dims, [sku(undefined, '中辣', ['中辣'])]), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    assert.equal(e.message, '规格项「辣度」里的选项「中辣」重复了')
    return true
  })

  const dims2 = [{ name: '辣度', values: ['中辣', '中辣 '] }]
  assert.throws(() => validateSpecs(dims2, [sku(undefined, '中辣', ['中辣'])]), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    assert.equal(e.message, '规格项「辣度」里的选项「中辣」重复了')
    return true
  })
})

test('S2 validateSpecs 拒绝纯空格值，文案精确等于 M3', () => {
  const dims = [{ name: '辣度', values: ['中辣', '  '] }]
  assert.throws(() => validateSpecs(dims, [sku(undefined, '中辣', ['中辣'])]), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    assert.equal(e.message, '规格项「辣度」里有空白的选项')
    return true
  })
})

test('S3 validateSpecs 合法输入原样返回', () => {
  const dims = [{ name: '辣度', values: ['微辣', '中辣'] }]
  const skus = [sku(undefined, '微辣', ['微辣']), sku(undefined, '中辣', ['中辣'])]
  const { dims: outDims, skuList } = validateSpecs(dims, skus)
  assert.deepEqual(outDims, dims)
  assert.deepEqual(skuList, skus)
})

test('validateSpecs 拒绝值数量与维度数不一致、specText 与值组合不一致的 SKU', () => {
  const dims = [{ name: '辣度', values: ['微辣', '中辣'] }]
  assert.throws(() => validateSpecs(dims, [sku(undefined, '微辣', ['微辣', '带骨'])]), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    return true
  })
  assert.throws(() => validateSpecs(dims, [sku(undefined, '不一致', ['微辣'])]), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    return true
  })
})

// ---- S4 两阶段同步 ----
test('S4 假 tx 自检：直接 create 重复 specText 必须抛错', async () => {
  const { tx } = makeFakeTx([{ id: 1, productId: 1, specText: 'A/X', specValues: ['A', 'X'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 }])
  await assert.rejects(() => tx.productSku.create({ data: { productId: 1, specText: 'A/X', specValues: ['A', 'X'], price: 100, stock: 1, sortOrder: 1 } }))
})

test('S4 两阶段同步：维度重排后两个 SKU 的 specText 互换不撞唯一索引', async () => {
  // 假 tx 初始 sortOrder（9, 8）与本次提交值（0, 1）不同，用于断言 sortOrder 确实被写入提交值
  const { tx, getRows } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A/X', specValues: ['A', 'X'], price: 100, originalPrice: null, stock: 1, sortOrder: 9 },
    { id: 2, productId: 1, specText: 'B/X', specValues: ['B', 'X'], price: 200, originalPrice: null, stock: 2, sortOrder: 8 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx, 1, [
      sku(1, 'B/X', ['B', 'X'], 0, { price: 150, originalPrice: 180, stock: 3 }),
      sku(2, 'A/X', ['A', 'X'], 1, { price: 250, originalPrice: null, stock: 4 }),
    ])
  )
  const rows = getRows()
  const id1 = rows.find((r) => r.id === 1)!
  const id2 = rows.find((r) => r.id === 2)!
  assert.equal(id1.specText, 'B/X')
  assert.deepEqual(id1.specValues, ['B', 'X'])
  assert.equal(id1.sortOrder, 0)
  assert.equal(id1.price, 150)
  assert.equal(id1.originalPrice, 180)
  assert.equal(id1.stock, 3)
  assert.equal(id2.specText, 'A/X')
  assert.deepEqual(id2.specValues, ['A', 'X'])
  assert.equal(id2.sortOrder, 1)
  assert.equal(id2.price, 250)
  assert.equal(id2.originalPrice, null)
  assert.equal(id2.stock, 4)
  // 不残留任何临时 specText
  assert.ok(rows.every((r) => !r.specText.startsWith('\u0001tmp:')))
})

test('S5 维度重排：4 个 SKU 的 specText 两两互换，id 全部保留', async () => {
  // 假 tx 初始 sortOrder（13-10）与提交值（0-3）不同、初始 price 也与提交值不同
  const { tx, getRows } = makeFakeTx([
    { id: 1, productId: 1, specText: 'a/x', specValues: ['a', 'x'], price: 100, originalPrice: null, stock: 1, sortOrder: 13 },
    { id: 2, productId: 1, specText: 'a/y', specValues: ['a', 'y'], price: 100, originalPrice: null, stock: 1, sortOrder: 12 },
    { id: 3, productId: 1, specText: 'b/x', specValues: ['b', 'x'], price: 100, originalPrice: null, stock: 1, sortOrder: 11 },
    { id: 4, productId: 1, specText: 'b/y', specValues: ['b', 'y'], price: 100, originalPrice: null, stock: 1, sortOrder: 10 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx, 1, [
      sku(1, 'x/a', ['x', 'a'], 0, { price: 111, originalPrice: 120, stock: 5 }),
      sku(2, 'y/a', ['y', 'a'], 1, { price: 222, originalPrice: null, stock: 6 }),
      sku(3, 'x/b', ['x', 'b'], 2, { price: 333, originalPrice: 340, stock: 7 }),
      sku(4, 'y/b', ['y', 'b'], 3, { price: 444, originalPrice: null, stock: 8 }),
    ])
  )
  const rows = getRows()
  assert.equal(rows.length, 4)
  for (const [id, specText, specValues, sortOrder, price, originalPrice, stock] of [
    [1, 'x/a', ['x', 'a'], 0, 111, 120, 5],
    [2, 'y/a', ['y', 'a'], 1, 222, null, 6],
    [3, 'x/b', ['x', 'b'], 2, 333, 340, 7],
    [4, 'y/b', ['y', 'b'], 3, 444, null, 8],
  ] as const) {
    const r = rows.find((r) => r.id === id)!
    assert.equal(r.specText, specText)
    assert.deepEqual(r.specValues, specValues as unknown as string[])
    assert.equal(r.sortOrder, sortOrder)
    assert.equal(r.price, price)
    assert.equal(r.originalPrice, originalPrice)
    assert.equal(r.stock, stock)
  }
})

test('S6 删除与新建：未携带的旧行删除，无 id 的行新建', async () => {
  // 假 tx 初始 sortOrder（5, 4）与提交值（0, 1）不同
  const { tx, getRows } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A', specValues: ['A'], price: 100, originalPrice: null, stock: 1, sortOrder: 5 },
    { id: 2, productId: 1, specText: 'B', specValues: ['B'], price: 100, originalPrice: null, stock: 1, sortOrder: 4 },
  ])
  await syncProductSkus(tx, 1, [
    sku(2, 'B', ['B'], 0, { price: 260, originalPrice: 300, stock: 9 }),
    sku(undefined, 'A', ['A'], 1, { price: 170, originalPrice: null, stock: 2 }),
  ])
  let rows = getRows()
  assert.equal(rows.length, 2)
  assert.ok(!rows.some((r) => r.id === 1), 'id1 应被删除')
  const keptB = rows.find((r) => r.id === 2)!
  assert.equal(keptB.specText, 'B')
  assert.equal(keptB.sortOrder, 0)
  assert.equal(keptB.price, 260)
  assert.equal(keptB.originalPrice, 300)
  assert.equal(keptB.stock, 9)
  const newA = rows.find((r) => r.specText === 'A')!
  assert.notEqual(newA.id, 1)
  assert.equal(newA.sortOrder, 1)
  assert.equal(newA.price, 170)
  assert.equal(newA.originalPrice, null)
  assert.equal(newA.stock, 2)

  await syncProductSkus(tx, 1, [])
  rows = getRows()
  assert.equal(rows.length, 0)
})

test('S7 提交中的 id 不属于该商品时按新建处理，不更新任何已有行', async () => {
  const { tx, getRows, calls } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A', specValues: ['A'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
  ])
  await syncProductSkus(tx, 1, [sku(999, 'A', ['A'], 0)])
  const rows = getRows()
  // id1 未携带 -> 被删除；999 不存在于库中 -> 当新建处理，得到新分配的 id
  assert.ok(!rows.some((r) => r.id === 1))
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].id, 999)
  assert.ok(!calls.some((c) => c.method === 'update' && (c.args as { where: { id: number } }).where.id === 999))
})

test('S8 specText 未变化的行只收到一次 update 调用', async () => {
  const { tx, calls } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A', specValues: ['A'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
  ])
  await syncProductSkus(tx, 1, [sku(1, 'A', ['A'], 0)])
  const updatesForId1 = calls.filter((c) => c.method === 'update' && (c.args as { where: { id: number } }).where.id === 1)
  assert.equal(updatesForId1.length, 1)
  assert.notEqual((updatesForId1[0].args as { data: { specText?: string } }).data.specText, '\u0001tmp:1')
})

// ---- S10（第一轮裁决 R10）----
test('S10 validateSpecs 拒绝 skuList 中重复的 id，文案精确等于 M6', () => {
  const dims = [{ name: '辣度', values: ['微辣', '中辣'] }]
  const skus = [sku(1, '微辣', ['微辣']), sku(1, '中辣', ['中辣'])]
  assert.throws(() => validateSpecs(dims, skus), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    assert.equal(e.message, '同一个规格被提交了两次')
    return true
  })
})

// ---- S11（用户决定，第一轮裁决后：服务端也要求组合覆盖 cartesian(dims)）----
test('S11 validateSpecs 要求 skuList 恰等于 cartesian(dims)：2x2 只提交 3 个抛错，提交完整 4 个正常；文案精确等于 M11', () => {
  const dims = [
    { name: '辣度', values: ['微辣', '中辣'] },
    { name: '骨型', values: ['带骨', '去骨'] },
  ]
  const three = [
    sku(undefined, '微辣/带骨', ['微辣', '带骨']),
    sku(undefined, '微辣/去骨', ['微辣', '去骨']),
    sku(undefined, '中辣/带骨', ['中辣', '带骨']),
  ]
  assert.throws(() => validateSpecs(dims, three), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    assert.equal(e.message, '规格组合的个数和选项对不上，请关掉编辑窗口重新打开后再保存')
    return true
  })

  const four = [
    sku(undefined, '微辣/带骨', ['微辣', '带骨']),
    sku(undefined, '微辣/去骨', ['微辣', '去骨']),
    sku(undefined, '中辣/带骨', ['中辣', '带骨']),
    sku(undefined, '中辣/去骨', ['中辣', '去骨']),
  ]
  assert.doesNotThrow(() => validateSpecs(dims, four))
})

// ---- S12-S16（第二轮复核 R11：只对真正冲突的行写临时名；控制字符校验）----
test('S12 只对真正冲突的行改临时名：4 个 SKU 的 specText 全部改成互不相关的新值，不需要临时名', async () => {
  const { tx, getRows, calls } = makeFakeTx([
    { id: 1, productId: 1, specText: 'a/x', specValues: ['a', 'x'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
    { id: 2, productId: 1, specText: 'a/y', specValues: ['a', 'y'], price: 100, originalPrice: null, stock: 1, sortOrder: 1 },
    { id: 3, productId: 1, specText: 'b/x', specValues: ['b', 'x'], price: 100, originalPrice: null, stock: 1, sortOrder: 2 },
    { id: 4, productId: 1, specText: 'b/y', specValues: ['b', 'y'], price: 100, originalPrice: null, stock: 1, sortOrder: 3 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx, 1, [
      sku(1, 'x/a', ['x', 'a'], 0),
      sku(2, 'y/a', ['y', 'a'], 1),
      sku(3, 'x/b', ['x', 'b'], 2),
      sku(4, 'y/b', ['y', 'b'], 3),
    ])
  )
  const tempUpdates = calls.filter(
    (c) => c.method === 'update' && typeof (c.args as { data: { specText?: string } }).data.specText === 'string' && (c.args as { data: { specText: string } }).data.specText.startsWith('\u0001')
  )
  assert.equal(tempUpdates.length, 0)
  const updates = calls.filter((c) => c.method === 'update')
  assert.equal(updates.length, 4)
  const rows = getRows()
  assert.deepEqual(
    rows.map((r) => [r.id, r.specText, r.specValues]).sort((a, b) => (a[0] as number) - (b[0] as number)),
    [
      [1, 'x/a', ['x', 'a']],
      [2, 'y/a', ['y', 'a']],
      [3, 'x/b', ['x', 'b']],
      [4, 'y/b', ['y', 'b']],
    ]
  )
})

test('S13 互换必须仍走临时名：库中 A/X(1)、B/X(2) 提交互换，临时名 update 恰 2 次', async () => {
  const { tx, getRows, calls } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A/X', specValues: ['A', 'X'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
    { id: 2, productId: 1, specText: 'B/X', specValues: ['B', 'X'], price: 100, originalPrice: null, stock: 1, sortOrder: 1 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx, 1, [
      sku(1, 'B/X', ['B', 'X'], 0),
      sku(2, 'A/X', ['A', 'X'], 1),
    ])
  )
  const tempUpdates = calls.filter(
    (c) => c.method === 'update' && typeof (c.args as { data: { specText?: string } }).data.specText === 'string' && (c.args as { data: { specText: string } }).data.specText.startsWith('\u0001')
  )
  assert.equal(tempUpdates.length, 2)
  const rows = getRows()
  assert.equal(rows.find((r) => r.id === 1)!.specText, 'B/X')
  assert.equal(rows.find((r) => r.id === 2)!.specText, 'A/X')
  assert.ok(rows.every((r) => !r.specText.startsWith('\u0001tmp:')))
})

test('S14 旧名被新行占用：新行在前提交，临时名 update 恰 1 次；顺序反过来提交结果相同', async () => {
  const { tx: tx1, getRows: getRows1, calls: calls1 } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A', specValues: ['A'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx1, 1, [
      sku(undefined, 'A', ['A'], 0),
      sku(1, 'B', ['B'], 1),
    ])
  )
  const tempUpdates1 = calls1.filter(
    (c) => c.method === 'update' && typeof (c.args as { data: { specText?: string } }).data.specText === 'string' && (c.args as { data: { specText: string } }).data.specText.startsWith('\u0001')
  )
  assert.equal(tempUpdates1.length, 1)
  const rows1 = getRows1()
  assert.equal(rows1.find((r) => r.id === 1)!.specText, 'B')
  assert.equal(rows1.find((r) => r.specText === 'A')!.id !== 1, true)

  const { tx: tx2, getRows: getRows2, calls: calls2 } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A', specValues: ['A'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx2, 1, [
      sku(1, 'B', ['B'], 0),
      sku(undefined, 'A', ['A'], 1),
    ])
  )
  const tempUpdates2 = calls2.filter(
    (c) => c.method === 'update' && typeof (c.args as { data: { specText?: string } }).data.specText === 'string' && (c.args as { data: { specText: string } }).data.specText.startsWith('\u0001')
  )
  assert.equal(tempUpdates2.length, 1)
  const rows2 = getRows2()
  assert.equal(rows2.find((r) => r.id === 1)!.specText, 'B')
  assert.equal(rows2.find((r) => r.specText === 'A')!.id !== 1, true)
})

test('S15 链式改名：1→B, 2→C, 3→D，临时名 update 恰 2 次（id2、id3；id1 的旧名 A 没人要）', async () => {
  const { tx, getRows, calls } = makeFakeTx([
    { id: 1, productId: 1, specText: 'A', specValues: ['A'], price: 100, originalPrice: null, stock: 1, sortOrder: 0 },
    { id: 2, productId: 1, specText: 'B', specValues: ['B'], price: 100, originalPrice: null, stock: 1, sortOrder: 1 },
    { id: 3, productId: 1, specText: 'C', specValues: ['C'], price: 100, originalPrice: null, stock: 1, sortOrder: 2 },
  ])
  await assert.doesNotReject(() =>
    syncProductSkus(tx, 1, [
      sku(1, 'B', ['B'], 0),
      sku(2, 'C', ['C'], 1),
      sku(3, 'D', ['D'], 2),
    ])
  )
  const tempUpdateIds = calls
    .filter((c) => c.method === 'update' && typeof (c.args as { data: { specText?: string } }).data.specText === 'string' && (c.args as { data: { specText: string } }).data.specText.startsWith('\u0001'))
    .map((c) => (c.args as { where: { id: number } }).where.id)
    .sort()
  assert.deepEqual(tempUpdateIds, [2, 3])
  const rows = getRows()
  assert.equal(rows.find((r) => r.id === 1)!.specText, 'B')
  assert.equal(rows.find((r) => r.id === 2)!.specText, 'C')
  assert.equal(rows.find((r) => r.id === 3)!.specText, 'D')
})

test('S16 validateSpecs 拒绝选项里的控制字符，文案精确等于 M5，可以兜住与临时名相同的选项', () => {
  const dims = [{ name: '辣度', values: ['\u0001tmp:1'] }]
  const skus = [sku(undefined, '\u0001tmp:1', ['\u0001tmp:1'])]
  assert.throws(() => validateSpecs(dims, skus), (e: unknown) => {
    assert.ok(e instanceof AppError)
    assert.equal(e.code, 40001)
    assert.equal(e.message, '选项「\u0001tmp:1」里有不能用的字符')
    return true
  })
})
