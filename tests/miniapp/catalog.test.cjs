// 分类/商品查询的渠道锁。
//
// 这一层存在的唯一理由：**渠道必须显式出现在每一个查询串里**。
// 服务端 /categories 与 /products 的 channel 缺省是 EXPRESS，漏传不会报错——
// 表现是「顾客在同城模式下看到邮寄的货」，静默、且在开发者工具里一眼看不出来。
// 参数顺序也钉死，方便比对日志与断言。
const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCategoriesUrl, buildProductsUrl, getAllProducts, ALL_PAGE_SIZE, ALL_MAX_PAGES } = require('../../apps/miniapp/api/catalog')

test('分类：渠道永远显式带上', function () {
  assert.equal(buildCategoriesUrl('EXPRESS'), '/categories?channel=EXPRESS')
  assert.equal(buildCategoriesUrl('LOCAL'), '/categories?channel=LOCAL')
})

test('分类：脏值/缺省一律回落 EXPRESS，不发一个没有 channel 的请求', function () {
  assert.equal(buildCategoriesUrl('local'), '/categories?channel=EXPRESS')
  assert.equal(buildCategoriesUrl(undefined), '/categories?channel=EXPRESS')
})

test('商品：参数顺序固定为 channel,page,pageSize,categoryId,keyword', function () {
  assert.equal(
    buildProductsUrl({ channel: 'LOCAL', page: 2, pageSize: 20, categoryId: 7 }),
    '/products?channel=LOCAL&page=2&pageSize=20&categoryId=7'
  )
  assert.equal(
    buildProductsUrl({ channel: 'EXPRESS', page: 1, pageSize: 6 }),
    '/products?channel=EXPRESS&page=1&pageSize=6'
  )
})

test('商品：categoryId 为 null（「全部」）时整个参数不出现，不能拼成 categoryId=null', function () {
  assert.equal(
    buildProductsUrl({ channel: 'LOCAL', page: 1, pageSize: 20, categoryId: null }),
    '/products?channel=LOCAL&page=1&pageSize=20'
  )
})

test('商品：关键词转义（搜索「烤鸭 & 卤味」不能把 & 当参数分隔符）', function () {
  assert.equal(
    buildProductsUrl({ channel: 'EXPRESS', page: 1, pageSize: 20, keyword: '烤鸭 & 卤味' }),
    '/products?channel=EXPRESS&page=1&pageSize=20&keyword=' + encodeURIComponent('烤鸭 & 卤味')
  )
})

test('商品：搜索词与分类互斥——传了 keyword 就不带 categoryId', function () {
  // 服务端两个条件是并列 AND，一起传会把「跨分类搜索」缩成「本分类内搜索」，
  // 顾客搜得到的东西莫名其妙变少，而页面上没有任何提示说明为什么。
  assert.equal(
    buildProductsUrl({ channel: 'EXPRESS', page: 1, pageSize: 20, categoryId: 3, keyword: '牛肉' }),
    '/products?channel=EXPRESS&page=1&pageSize=20&keyword=' + encodeURIComponent('牛肉')
  )
})

test('商品：page/pageSize 缺省补 1/20，不发一个没有分页的请求', function () {
  assert.equal(buildProductsUrl({ channel: 'LOCAL' }), '/products?channel=LOCAL&page=1&pageSize=20')
})

// ── getAllProducts：分组视图一次拉全（2026-09-17 分组锚点设计 §5.2 / C4） ──
//
// 桩打在 wx.request 上，按 `page=` 查询参数返回不同页，记录发出的每一个 URL——
// 断言的是「实际按什么顺序、发了几个请求」，不是拼好的 Promise 结果。
function makeAllCtx(respond) {
  const urls = []
  global.wx = {
    getStorageSync: function () { return '' },
    request: function (o) {
      const u = o.url.replace(/^https?:\/\/[^/]+(\/api)?/, '')
      urls.push(u)
      const pageMatch = /page=(\d+)/.exec(o.url)
      const page = pageMatch ? Number(pageMatch[1]) : 1
      const body = respond(page)
      o.success({ statusCode: 200, data: { code: 0, message: 'ok', data: body } })
    },
  }
  return urls
}

test('getAllProducts：按页循环直到拉全，URL 不含 categoryId 也不含 keyword', async function () {
  const urls = makeAllCtx(function (page) {
    if (page === 1) return { list: new Array(50).fill(0).map(function (_, i) { return { id: i + 1 } }), total: 120 }
    if (page === 2) return { list: new Array(50).fill(0).map(function (_, i) { return { id: i + 51 } }), total: 120 }
    return { list: new Array(20).fill(0).map(function (_, i) { return { id: i + 101 } }), total: 120 }
  })
  const result = await getAllProducts('LOCAL')
  assert.deepEqual(urls, [
    '/products?channel=LOCAL&page=1&pageSize=50',
    '/products?channel=LOCAL&page=2&pageSize=50',
    '/products?channel=LOCAL&page=3&pageSize=50',
  ])
  assert.equal(result.list.length, 120)
  assert.equal(result.total, 120)
  assert.equal(result.truncated, false)
  urls.forEach(function (u) {
    assert.equal(u.indexOf('categoryId=') === -1, true, u)
    assert.equal(u.indexOf('keyword=') === -1, true, u)
  })
})

test('getAllProducts：total 为 0 时只发一个请求，list 为空', async function () {
  const urls = makeAllCtx(function () { return { list: [], total: 0 } })
  const result = await getAllProducts('EXPRESS')
  assert.equal(urls.length, 1)
  assert.deepEqual(result.list, [])
})

test('getAllProducts：20 页上限保护，超量时截断并告警', async function () {
  const urls = makeAllCtx(function () {
    return { list: new Array(50).fill(0).map(function () { return { id: 1 } }), total: 99999 }
  })
  const warn = console.warn
  let warnCalls = 0
  console.warn = function () { warnCalls++ }
  let result
  try {
    result = await getAllProducts('LOCAL')
  } finally {
    console.warn = warn
  }
  assert.equal(urls.length, ALL_MAX_PAGES)
  assert.equal(result.truncated, true)
  assert.equal(result.list.length, ALL_PAGE_SIZE * ALL_MAX_PAGES)
  assert.equal(warnCalls, 1)
})

test('getAllProducts：渠道显式带上；脏值回落 EXPRESS', async function () {
  const urlsExpress = makeAllCtx(function () { return { list: [{ id: 1 }], total: 1 } })
  await getAllProducts('EXPRESS')
  urlsExpress.forEach(function (u) { assert.ok(u.indexOf('channel=EXPRESS') !== -1, u) })

  const urlsDirty = makeAllCtx(function () { return { list: [{ id: 1 }], total: 1 } })
  await getAllProducts('local')
  urlsDirty.forEach(function (u) { assert.ok(u.indexOf('channel=EXPRESS') !== -1, u) })
})
