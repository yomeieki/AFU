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
  assert.equal(legacyTarget('/member-settings', '').pathname, '/membership/settings')
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
  assert.deepEqual(centerTabs.membership.map((tab) => tab.label), ['优惠券', '积分赠品', '会员设置'])
  assert.deepEqual(centerTabs.settings.map((tab) => tab.label), ['全国邮寄设置', '同城配送设置'])
})

test('lists all nine top-level entries in navigation order', () => {
  assert.deepEqual(topNavigation.map((item) => item.label), [
    '接单工作台', '经营概览', '商品管理', '订单管理',
    '会员营销', '店铺设置', '用户管理', '推广运营', '系统维护',
  ])
})

test('defines the child tabs for the two newly merged centers', () => {
  assert.deepEqual(centerTabs.promotion.map((tab) => tab.to), [
    '/promotion/banners', '/promotion/scan-stats',
  ])
  assert.deepEqual(centerTabs.system.map((tab) => tab.to), [
    '/system/printer', '/system/status',
  ])
})

test('redirects the routes absorbed by the new centers', () => {
  assert.equal(legacyTarget('/banners', '').pathname, '/promotion/banners')
  assert.equal(legacyTarget('/scan-stats', '').pathname, '/promotion/scan-stats')
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
  assert.equal(mainNavigation.length, 8)
  assert.equal(mainNavigation.some((item) => item.to === '/workbench'), false)
  // 顶栏左侧顺序不能被 workbench 拆出后打乱
  assert.deepEqual(mainNavigation.map((item) => item.label), [
    '经营概览', '商品管理', '订单管理', '会员营销',
    '店铺设置', '用户管理', '推广运营', '系统维护',
  ])
})

test('still exposes all nine entries for the narrow-screen grid', () => {
  assert.equal(topNavigation.length, 9)
  assert.equal(topNavigation[0], workbenchNav)
})

test('sends every business-center root to its default child, query intact', () => {
  assert.deepEqual(legacyTarget('/catalog', '?channel=LOCAL'), {
    pathname: '/catalog/products',
    search: '?channel=LOCAL',
  })
  assert.equal(legacyTarget('/membership', '').pathname, '/membership/coupons')
  assert.equal(legacyTarget('/settings', '').pathname, '/settings/express')
  assert.equal(legacyTarget('/promotion', '').pathname, '/promotion/banners')
  // 打印机是系统维护的默认子页，旧书签 /system 落在这儿而不是系统状态
  assert.equal(legacyTarget('/system', '').pathname, '/system/printer')
})
