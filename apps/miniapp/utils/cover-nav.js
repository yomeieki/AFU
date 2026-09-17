// 封面底部自绘四栏的唯一事实来源（2026-09-17 设计 N6/N7）。
// 这不是系统标签栏：app.json 的 tabBar 一行不改，封面页自己画一条与之等高等样的。
// 四项都不高亮（封面不属于其中任何一项），所以只有灰图，没有高亮态图标。
// 落点规则：主页/分类/购物车按「上次用过的渠道」进，没有记录默认同城；「我的」与渠道无关。
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。
var TABS = [
  { id: 'home', label: '主页', icon: '/assets/tabbar/home.png', route: '/pages/index/index', channelAware: true },
  { id: 'category', label: '分类', icon: '/assets/tabbar/category.png', route: '/pages/product/list', channelAware: true },
  { id: 'cart', label: '购物车', icon: '/assets/tabbar/cart.png', route: '/pages/cart/index', channelAware: true },
  { id: 'user', label: '我的', icon: '/assets/tabbar/user.png', route: '/pages/user/index', channelAware: false }
]

function decideCoverTab(tabId, remembered) {
  var tab = null
  for (var i = 0; i < TABS.length; i++) {
    if (TABS[i].id === tabId) { tab = TABS[i]; break }
  }
  if (!tab) return null
  var channel = null
  if (tab.channelAware) channel = remembered === 'EXPRESS' ? 'EXPRESS' : 'LOCAL'
  return { url: tab.route, channel: channel, event: 'tap_tab_' + tab.id }
}

module.exports = { TABS: TABS, decideCoverTab: decideCoverTab }
