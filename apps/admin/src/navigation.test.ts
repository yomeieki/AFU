import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { activeNavLabel, centerTabs, isChannel, legacyTarget, mainNavigation, orderDetailPath, readChannel, topNavigation, workbenchNav } from './navigation.ts'

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

test('orderDetailPath 拼出详情页地址，且不是 legacyRoutes 的已知旧地址', () => {
  assert.equal(orderDetailPath(12), '/orders/detail/12')
  assert.equal(legacyTarget('/orders/detail/12', '').pathname, '/orders/detail/12')
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
  // 页签名不带「设置」：与「订单管理」的渠道叫法统一，也让页签在 375px 手机上更容易放下
  // （2026-09-22 加「预约送达」后共五项，375px 实际是否一行放下未重新实测，仅沿用简称策略）
  assert.deepEqual(centerTabs.settings.map((tab) => tab.label), ['全国邮寄', '同城配送', '到店自取', '预约送达', '营业时间'])
  assert.deepEqual(centerTabs.promotion.map((tab) => tab.label), ['优惠券', '满减', '积分赠品', '轮播图', '会员设置'])
})

// 入口地址必须是该中心的落地页，否则点进去会停在一个没有页签高亮的状态。
test('every center entry points at its own first tab', () => {
  const centerOf: Record<string, keyof typeof centerTabs> = {
    '/catalog': 'catalog', '/orders': 'orders', '/promotion': 'promotion',
    '/settings': 'settings', '/system': 'system',
  }
  // centerOf 是手写的，漏登记一个中心会让下面的循环静默跳过它。先钉住这张表本身：
  // 有页签行的中心 = mainNavigation 里 to !== prefix 的那些（单页入口两者相同）。
  assert.deepEqual(
    Object.keys(centerOf).sort(),
    mainNavigation.filter((i) => i.to !== i.prefix).map((i) => i.prefix).sort(),
    'centerOf 漏登记了某个有页签的中心'
  )
  for (const item of mainNavigation) {
    const key = centerOf[item.prefix]
    if (!key) continue // 经营概览、用户管理是单页，没有页签行
    assert.equal(item.to, centerTabs[key][0].to, `${item.label} 的入口地址应等于它第一个页签`)
  }
})

// Layout.tsx 是 tsx，node --test 跑不了，只能源码级比对。这两条挡的是真实踩过的坑：
// navIcons 漏一个键 → `<Icon />` 收到 undefined → 整页白屏；navBadge 漏一个 → 徽标静默消失。
// 两张表现在都按 prefix 索引（prefix 是中心身份，不随默认子页变），这里确认覆盖完整。
test('Layout 的图标表覆盖每一个一级入口', () => {
  const src = readFileSync(new URL('./components/Layout.tsx', import.meta.url), 'utf8')
  const block = /const navIcons: Record<string, LucideIcon> = \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(block, '找不到 navIcons 定义')
  const keys = [...block[1].matchAll(/'([^']+)':/g)].map((m) => m[1])
  assert.deepEqual(keys.sort(), topNavigation.map((i) => i.prefix).sort(), 'navIcons 的键必须与一级入口的 prefix 一一对应')
})

// 扫码统计：店主 2026-09-17 决定收起入口、保留页面，以后再放回来。
// 页签已经没有了，谁顺手把路由也删掉，光看测试是发现不了的——这条就是那个决定的锁。
// 徽标表故意只覆盖 8 个入口里的 2 个（工作台、订单管理），做不了一一对应，
// 但键必须都是真实存在的 prefix：写错一个不会崩，只会让红点数字静默消失。
test('Layout 的徽标表只用真实存在的入口 prefix', () => {
  const src = readFileSync(new URL('./components/Layout.tsx', import.meta.url), 'utf8')
  const prefixes = topNavigation.map((i) => i.prefix)
  for (const name of ['navBadge', 'badgeTitle']) {
    const block = new RegExp(`const ${name}: Record<string, [^>]+> = \\{([\\s\\S]*?)\\n  \\}`).exec(src)
    assert.ok(block, `找不到 ${name} 定义`)
    const keys = [...block[1].matchAll(/'([^']+)':/g)].map((m) => m[1])
    assert.ok(keys.length > 0, `${name} 没解析出键`)
    for (const k of keys) assert.ok(prefixes.includes(k), `${name} 的键 ${k} 不是任何一级入口的 prefix`)
  }
})

test('扫码统计的路由仍在（入口收起，地址仍可访问）', () => {
  const src = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(src, /<Route path="scan-stats" element=\{<ScanStats \/>\} \/>/, '扫码统计路由被删了：店主只要求收起入口，不是删功能')
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
