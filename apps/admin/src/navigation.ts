import type { Channel } from './types'

export interface CenterTab {
  to: string
  label: string
}

export interface NavigationItem {
  to: string
  prefix: string
  label: string
}

export interface NavigationSection {
  label: string
  items: NavigationItem[]
}

export const topNavigation: NavigationItem[] = [
  { to: '/workbench', prefix: '/workbench', label: '接单工作台' },
  { to: '/dashboard', prefix: '/dashboard', label: '经营概览' },
  { to: '/orders/local', prefix: '/orders', label: '订单管理' },
  { to: '/catalog/products', prefix: '/catalog', label: '商品管理' },
]

export const moreNavigationSections: NavigationSection[] = [
  {
    label: '会员营销',
    items: [
      { to: '/membership/settings', prefix: '/membership/settings', label: '会员管理' },
      { to: '/membership/coupons', prefix: '/membership/coupons', label: '优惠券' },
      { to: '/membership/points-goods', prefix: '/membership/points-goods', label: '积分赠品' },
    ],
  },
  {
    label: '店铺设置',
    items: [
      { to: '/settings/express', prefix: '/settings/express', label: '全国邮寄设置' },
      { to: '/settings/local', prefix: '/settings/local', label: '同城设置' },
    ],
  },
  {
    label: '后台工具',
    items: [
      { to: '/users', prefix: '/users', label: '用户管理' },
      { to: '/scan-stats', prefix: '/scan-stats', label: '扫码统计' },
      { to: '/banners', prefix: '/banners', label: '轮播管理' },
      { to: '/printer-settings', prefix: '/printer-settings', label: '打印机设置' },
      { to: '/system', prefix: '/system', label: '系统状态' },
    ],
  },
]

export const centerTabs: Record<'catalog' | 'orders' | 'membership' | 'settings', CenterTab[]> = {
  catalog: [
    { to: '/catalog/products', label: '商品列表' },
    { to: '/catalog/categories', label: '分类管理' },
  ],
  orders: [
    { to: '/orders/local', label: '同城配送' },
    { to: '/orders/express', label: '全国邮寄' },
  ],
  membership: [
    { to: '/membership/coupons', label: '优惠券' },
    { to: '/membership/points-goods', label: '积分赠品' },
    { to: '/membership/settings', label: '会员设置' },
  ],
  settings: [
    { to: '/settings/express', label: '全国邮寄设置' },
    { to: '/settings/local', label: '同城配送设置' },
  ],
}

export const isChannel = (value: string | null): value is Channel =>
  value === 'EXPRESS' || value === 'LOCAL'

export const readChannel = (params: URLSearchParams): Channel => {
  const value = params.get('channel')
  return isChannel(value) ? value : 'EXPRESS'
}

const legacyRoutes: Record<string, string> = {
  '/products': '/catalog/products',
  '/categories': '/catalog/categories',
  '/orders': '/orders/express',
  '/local/orders': '/orders/local',
  '/coupons': '/membership/coupons',
  '/points-goods': '/membership/points-goods',
  '/member-settings': '/membership/settings',
  '/shop-settings': '/settings/express',
  '/local/settings': '/settings/local',
}

export const legacyTarget = (pathname: string, search: string) => ({
  pathname: legacyRoutes[pathname] ?? pathname,
  search,
})
