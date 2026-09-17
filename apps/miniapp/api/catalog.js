// 分类与商品的查询层。
//
// 双渠道改版之后，「主页 / 分类」两个 tabBar 页被同城和邮寄共用，页面自己不再知道
// 该拉哪边的货——渠道由 app.globalData.shoppingChannel 决定，然后**显式**拼进每一个查询串。
//
// 为什么非要显式：服务端 /categories 与 /products 的 channel 缺省是 EXPRESS。
// 漏传不报错、不告警，表现是「顾客在同城模式下看到一整屏邮寄的货」，
// 而这两个页面本来就长得一样，在开发者工具里一眼看不出来。
// 把拼串收敛到这两个纯函数里，再用 tests/miniapp/catalog.test.cjs 钉住。

var channelUtil = require('../utils/channel')
var request = require('../utils/request').request

var DEFAULT_PAGE_SIZE = 20

function buildCategoriesUrl(channel) {
  return '/categories?channel=' + channelUtil.normalizeChannel(channel)
}

/**
 * 参数顺序固定为 channel,page,pageSize,categoryId,keyword——顺序稳定，日志与断言才好比对。
 *
 * keyword 与 categoryId **互斥**：服务端这两个条件是并列 AND，一起传会把
 * 「跨分类搜索」悄悄缩成「只在本分类里搜」，顾客搜得到的东西变少而页面不解释为什么。
 */
function buildProductsUrl(params) {
  var p = params || {}
  var url = '/products?channel=' + channelUtil.normalizeChannel(p.channel) +
    '&page=' + (p.page || 1) +
    '&pageSize=' + (p.pageSize || DEFAULT_PAGE_SIZE)
  if (p.keyword) {
    url += '&keyword=' + encodeURIComponent(p.keyword)
  } else if (p.categoryId != null) {
    url += '&categoryId=' + encodeURIComponent(p.categoryId)
  }
  return url
}

function getCategories(channel) {
  return request({ url: buildCategoriesUrl(channel) })
}

function getProducts(params) {
  return request({ url: buildProductsUrl(params) })
}

// 分组视图一次拉全本渠道的菜（2026-09-17 分组锚点设计 §5.2 / C4）：按页循环到没有为止，不写死总数。
// 20 页（1000 条）上限只防接口异常时死循环——正常单渠道一百多道，触顶就是数据出了问题，要告警不要静默。
var ALL_PAGE_SIZE = 50
var ALL_MAX_PAGES = 20

function getAllProducts(channel) {
  var acc = []
  function step(page) {
    return getProducts({ channel: channel, page: page, pageSize: ALL_PAGE_SIZE }).then(function(data) {
      var list = (data && data.list) || []
      var total = (data && data.total) || 0
      acc = acc.concat(list)
      if (!list.length || acc.length >= total) return { list: acc, total: total, truncated: false }
      if (page >= ALL_MAX_PAGES) {
        console.warn('[catalog] 商品超过 ' + (ALL_PAGE_SIZE * ALL_MAX_PAGES) + ' 条，已截断')
        return { list: acc, total: total, truncated: true }
      }
      return step(page + 1)
    })
  }
  return step(1)
}

module.exports = {
  DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
  ALL_PAGE_SIZE: ALL_PAGE_SIZE,
  ALL_MAX_PAGES: ALL_MAX_PAGES,
  buildCategoriesUrl: buildCategoriesUrl,
  buildProductsUrl: buildProductsUrl,
  getCategories: getCategories,
  getProducts: getProducts,
  getAllProducts: getAllProducts,
}
