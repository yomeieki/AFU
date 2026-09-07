import type { Channel } from './types'

export interface CenterTab {
  to: string
  label: string
}

export interface NavItem {
  /** 点击后去的实际地址（中心项指向其默认子页） */
  to: string
  /** 判定高亮用的路径前缀，一个中心的所有子页共用一个前缀 */
  prefix: string
  label: string
}

/**
 * 顶栏一级导航，数组顺序即渲染顺序。
 * 第 0 项 /workbench 是唯一实色强调项，由 Layout 按 to 单独取样式，不靠位置隐式约定。
 */
export const topNavigation: NavItem[] = [
  { to: '/workbench', prefix: '/workbench', label: '接单工作台' },
  { to: '/dashboard', prefix: '/dashboard', label: '经营概览' },
  { to: '/catalog/products', prefix: '/catalog', label: '商品管理' },
  { to: '/orders/local', prefix: '/orders', label: '订单管理' },
  { to: '/membership/coupons', prefix: '/membership', label: '会员营销' },
  { to: '/settings/express', prefix: '/settings', label: '店铺设置' },
  { to: '/users', prefix: '/users', label: '用户管理' },
  { to: '/promotion/banners', prefix: '/promotion', label: '推广运营' },
  { to: '/system/printer', prefix: '/system', label: '系统维护' },
]

/** 窄屏顶栏要显示当前所在的一级入口名；认不出时退回「经营概览」，与根路由的落点一致 */
export const activeNavLabel = (pathname: string) =>
  topNavigation.find((item) => pathname.startsWith(item.prefix))?.label ?? '经营概览'

export const centerTabs: Record<
  'catalog' | 'orders' | 'membership' | 'settings' | 'promotion' | 'system',
  CenterTab[]
> = {
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
  promotion: [
    { to: '/promotion/banners', label: '轮播图' },
    { to: '/promotion/scan-stats', label: '扫码统计' },
  ],
  system: [
    { to: '/system/printer', label: '打印机' },
    { to: '/system/status', label: '系统状态' },
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
  '/banners': '/promotion/banners',
  '/scan-stats': '/promotion/scan-stats',
  '/printer-settings': '/system/printer',
}

export const legacyTarget = (pathname: string, search: string) => ({
  pathname: legacyRoutes[pathname] ?? pathname,
  search,
})
