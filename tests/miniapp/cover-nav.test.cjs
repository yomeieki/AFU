// 封面底部自绘四栏的落点决策——锁的是「落到哪个渠道」这条规则，页面只负责跳。
// 不是系统标签栏（app.json 的 tabBar 一行不改）：封面不属于四栏中任何一项，
// 所以只有灰图、没有高亮态；落点规则：主页/分类/购物车按「上次用过的渠道」进，
// 没有记录默认同城（设计 N7）；「我的」与渠道无关。
const test = require('node:test')
const assert = require('node:assert/strict')

const coverNav = require('../../apps/miniapp/utils/cover-nav')

test('TABS 恰 4 项，顺序与路由跟 app.js 的 TAB_BAR_PAGES 同序，图标都是灰图', function () {
  assert.equal(coverNav.TABS.length, 4)
  assert.deepEqual(coverNav.TABS.map(function (t) { return t.id }), ['home', 'category', 'cart', 'user'])
  const routes = coverNav.TABS.map(function (t) { return t.route })
  assert.deepEqual(routes, ['/pages/index/index', '/pages/product/list', '/pages/cart/index', '/pages/user/index'])
  coverNav.TABS.forEach(function (t) {
    assert.ok(t.icon.indexOf('/assets/tabbar/') === 0, t.id + ' 图标应以 /assets/tabbar/ 开头')
    assert.ok(t.icon.indexOf('-active') === -1, t.id + ' 图标不应含 -active（四项都不高亮）')
  })
})

test('记忆 EXPRESS 点购物车 → 落到购物车、渠道 EXPRESS', function () {
  const decision = coverNav.decideCoverTab('cart', 'EXPRESS')
  assert.deepEqual(decision, { url: '/pages/cart/index', channel: 'EXPRESS', event: 'tap_tab_cart' })
})

test('记忆 LOCAL 点主页 → 渠道 LOCAL', function () {
  const decision = coverNav.decideCoverTab('home', 'LOCAL')
  assert.equal(decision.channel, 'LOCAL')
  assert.equal(decision.url, '/pages/index/index')
})

test('无记录（首次安装/清缓存）点分类 → 默认同城（N7）', function () {
  const decision = coverNav.decideCoverTab('category', null)
  assert.equal(decision.channel, 'LOCAL')
  assert.equal(decision.url, '/pages/product/list')
})

test('脏值按无记录处理，不按邮寄', function () {
  const decision = coverNav.decideCoverTab('home', 'OTHER')
  assert.equal(decision.channel, 'LOCAL')
})

test('点「我的」与渠道无关，无论记忆是什么都是 channel: null', function () {
  assert.equal(coverNav.decideCoverTab('user', 'EXPRESS').channel, null)
  assert.equal(coverNav.decideCoverTab('user', 'LOCAL').channel, null)
  assert.equal(coverNav.decideCoverTab('user', null).channel, null)
  assert.equal(coverNav.decideCoverTab('user', null).url, '/pages/user/index')
})

test('未知 id 返回 null', function () {
  assert.equal(coverNav.decideCoverTab('nope', 'LOCAL'), null)
})

test('event 沿用封面既有 tap_* 埋点约定', function () {
  assert.equal(coverNav.decideCoverTab('home', 'LOCAL').event, 'tap_tab_home')
  assert.equal(coverNav.decideCoverTab('category', 'LOCAL').event, 'tap_tab_category')
  assert.equal(coverNav.decideCoverTab('cart', 'LOCAL').event, 'tap_tab_cart')
  assert.equal(coverNav.decideCoverTab('user', 'LOCAL').event, 'tap_tab_user')
})
