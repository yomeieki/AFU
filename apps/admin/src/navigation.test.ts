import assert from 'node:assert/strict'
import test from 'node:test'
import { activeNavLabel, centerTabs, isChannel, legacyTarget, mainNavigation, readChannel, topNavigation, workbenchNav } from './navigation.ts'

test('maps the legacy express orders URL without losing its status', () => {
  assert.deepEqual(legacyTarget('/orders', '?status=PAID'), {
    pathname: '/orders/express',
    search: '?status=PAID',
  })
})

test('maps every removed sidebar page to its business-center child route', () => {
  assert.equal(legacyTarget('/local/orders', '').pathname, '/orders/local')
  assert.equal(legacyTarget('/member-settings', '').pathname, '/promotion/member')
  assert.equal(legacyTarget('/local/settings', '').pathname, '/settings/local')
})

test('accepts only the two known sales channels', () => {
  assert.equal(isChannel('EXPRESS'), true)
  assert.equal(isChannel('LOCAL'), true)
  assert.equal(isChannel('ALL'), false)
})

test('uses express when a catalog URL has no valid channel', () => {
  assert.equal(readChannel(new URLSearchParams('channel=OTHER')), 'EXPRESS')
})

test('defines the approved child tabs for every business center', () => {
  assert.deepEqual(centerTabs.catalog.map((tab) => tab.label), ['商品列表', '分类管理'])
  assert.deepEqual(centerTabs.orders.map((tab) => tab.label), ['同城配送', '全国邮寄'])
  // 页签名不带「设置」：与「订单管理」的渠道叫法统一，也让四项在 375px 手机上一行放得下
  assert.deepEqual(centerTabs.settings.map((tab) => tab.label), ['全国邮寄', '同城配送', '到店自取', '营业时间'])
  assert.deepEqual(centerTabs.promotion.map((tab) => tab.label), ['优惠券', '满减', '积分赠品', '轮播图', '会员设置'])
})

// 一级入口的 `to` 同时被 Layout 的 navIcons 当键用（查不到会白屏），也必须是该中心的
// 落地页。2026-09-17 把推广运营默认子页从 /promotion/banners 改成 /promotion/coupons 时
// 就漏改过 navIcons —— 这条断言锁住「入口地址 = 该中心第一个页签」，让两边不会再各走各的。
test('every center entry points at its own first tab', () => {
  const centerOf: Record<string, keyof typeof centerTabs> = {
    '/catalog': 'catalog', '/orders': 'orders', '/promotion': 'promotion',
    '/settings': 'settings', '/system': 'system',
  }
  for (const item of mainNavigation) {
    const key = centerOf[item.prefix]
    if (!key) continue // 经营概览、用户管理是单页，没有页签行
    assert.equal(item.to, centerTabs[key][0].to, `${item.label} 的入口地址应等于它第一个页签`)
  }
})

test('lists all eight top-level entries in navigation order', () => {
  assert.deepEqual(topNavigation.map((item) => item.label), [
    '接单工作台', '经营概览', '商品管理', '订单管理',
    '推广运营', '店铺设置', '用户管理', '系统维护',
  ])
})

test('defines the child tabs for the two newly merged centers', () => {
  // 扫码统计（/promotion/scan-stats）刻意不在页签里：店主 2026-09-17 决定先收起入口，
  // 路由还在、直接输地址可达。这条断言就是那个决定的锁——把它加回页签会在这里变红。
  assert.deepEqual(centerTabs.promotion.map((tab) => tab.to), [
    '/promotion/coupons', '/promotion/discount', '/promotion/points-goods',
    '/promotion/banners', '/promotion/member',
  ])
  assert.deepEqual(centerTabs.system.map((tab) => tab.to), [
    '/system/printer', '/system/status',
  ])
})

test('redirects the routes absorbed by the new centers', () => {
  assert.equal(legacyTarget('/banners', '').pathname, '/promotion/banners')
  assert.equal(legacyTarget('/scan-stats', '').pathname, '/promotion/scan-stats')
  // 归拢后：会员营销整个中心与三个子页、满减活动都得落到新位置
  assert.equal(legacyTarget('/membership', '').pathname, '/promotion/coupons')
  assert.equal(legacyTarget('/membership/coupons', '').pathname, '/promotion/coupons')
  assert.equal(legacyTarget('/membership/points-goods', '').pathname, '/promotion/points-goods')
  assert.equal(legacyTarget('/membership/settings', '').pathname, '/promotion/member')
  assert.equal(legacyTarget('/coupons', '').pathname, '/promotion/coupons')
  assert.equal(legacyTarget('/settings/promotion', '').pathname, '/promotion/discount')
  assert.equal(legacyTarget('/printer-settings', '').pathname, '/system/printer')
})

test('names the active entry from any of its child routes', () => {
  assert.equal(activeNavLabel('/promotion/scan-stats'), '推广运营')
  assert.equal(activeNavLabel('/system/status'), '系统维护')
  assert.equal(activeNavLabel('/orders/express'), '订单管理')
  assert.equal(activeNavLabel('/unknown'), '经营概览')
})

test('keeps the workbench out of the main run of entries', () => {
  assert.equal(workbenchNav.to, '/workbench')
  assert.equal(mainNavigation.length, 7)
  assert.equal(mainNavigation.some((item) => item.to === '/workbench'), false)
  // 顶栏左侧顺序不能被 workbench 拆出后打乱。
  // 2026-09-17：「会员营销」整个并进「推广运营」，一级入口 8 → 7（连工作台共 8）。
  assert.deepEqual(mainNavigation.map((item) => item.label), [
    '经营概览', '商品管理', '订单管理', '推广运营',
    '店铺设置', '用户管理', '系统维护',
  ])
})

test('still exposes all eight entries for the narrow-screen grid', () => {
  assert.equal(topNavigation.length, 8)
  assert.equal(topNavigation[0], workbenchNav)
})

test('sends every business-center root to its default child, query intact', () => {
  assert.deepEqual(legacyTarget('/catalog', '?channel=LOCAL'), {
    pathname: '/catalog/products',
    search: '?channel=LOCAL',
  })
  assert.equal(legacyTarget('/settings', '').pathname, '/settings/express')
  assert.equal(legacyTarget('/promotion', '').pathname, '/promotion/coupons')
  // 打印机是系统维护的默认子页，旧书签 /system 落在这儿而不是系统状态
  assert.equal(legacyTarget('/system', '').pathname, '/system/printer')
})
