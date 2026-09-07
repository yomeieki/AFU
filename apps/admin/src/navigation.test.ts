import assert from 'node:assert/strict'
import test from 'node:test'
import {
  centerTabs,
  isChannel,
  legacyTarget,
  moreNavigationSections,
  readChannel,
  topNavigation,
} from './navigation.ts'

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

test('keeps only high-frequency entry points in the single top row', () => {
  assert.deepEqual(topNavigation.map((item) => item.to), [
    '/workbench',
    '/dashboard',
    '/orders/local',
    '/catalog/products',
  ])
})

test('groups every low-frequency route under More', () => {
  assert.deepEqual(moreNavigationSections.map((section) => section.label), [
    '会员营销',
    '店铺设置',
    '后台工具',
  ])
  assert.deepEqual(moreNavigationSections[0].items.map((item) => item.to), [
    '/membership/settings',
    '/membership/coupons',
    '/membership/points-goods',
  ])
})
