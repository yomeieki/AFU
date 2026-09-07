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

module.exports = {
  DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
  buildCategoriesUrl: buildCategoriesUrl,
  buildProductsUrl: buildProductsUrl,
  getCategories: getCategories,
  getProducts: getProducts,
}
