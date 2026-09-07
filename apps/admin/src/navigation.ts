import type { Channel } from './types'

export interface CenterTab {
  to: string
  label: string
}

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
