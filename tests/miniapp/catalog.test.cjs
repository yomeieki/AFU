// 分类/商品查询的渠道锁。
//
// 这一层存在的唯一理由：**渠道必须显式出现在每一个查询串里**。
// 服务端 /categories 与 /products 的 channel 缺省是 EXPRESS，漏传不会报错——
// 表现是「顾客在同城模式下看到邮寄的货」，静默、且在开发者工具里一眼看不出来。
// 参数顺序也钉死，方便比对日志与断言。
const test = require('node:test')
const assert = require('node:assert/strict')

const { buildCategoriesUrl, buildProductsUrl } = require('../../apps/miniapp/api/catalog')

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
