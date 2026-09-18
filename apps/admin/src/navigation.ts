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
 * 接单工作台不排在顶栏左侧那一串里：宽屏时它单独贴在右侧、与其余入口之间留空，
 * 让「今天要干的活」和「去哪儿改配置」在视觉上是两件事。
 */
export const workbenchNav: NavItem = { to: '/workbench', prefix: '/workbench', label: '接单工作台' }

/** 顶栏左侧那一串（不含工作台）。窄屏入口网格用的是下面的 topNavigation。 */
export const mainNavigation: NavItem[] = [
  { to: '/dashboard', prefix: '/dashboard', label: '经营概览' },
  { to: '/catalog/products', prefix: '/catalog', label: '商品管理' },
  { to: '/orders/local', prefix: '/orders', label: '订单管理' },
  { to: '/promotion/coupons', prefix: '/promotion', label: '推广运营' },
  { to: '/settings/express', prefix: '/settings', label: '店铺设置' },
  { to: '/users', prefix: '/users', label: '用户管理' },
  { to: '/system/printer', prefix: '/system', label: '系统维护' },
]

/** 八个入口的完整顺序，窄屏 4 列网格按它渲染（8 项正好两行）；工作台仍排第一格。 */
export const topNavigation: NavItem[] = [workbenchNav, ...mainNavigation]

/** 窄屏顶栏要显示当前所在的一级入口名；认不出时退回「经营概览」，与根路由的落点一致 */
export const activeNavLabel = (pathname: string) =>
  topNavigation.find((item) => pathname.startsWith(item.prefix))?.label ?? '经营概览'

/**
 * 订单详情页地址。与 `/orders` 父路由是兄弟静态路由（见实施计划「路由与命名」），
 * `pathname.startsWith('/orders')` 依旧命中「订单管理」，不用改 navIcons/navBadge。
 */
export const orderDetailPath = (id: number) => `/orders/detail/${id}`

export const centerTabs: Record<
  'catalog' | 'orders' | 'settings' | 'promotion' | 'system',
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
  // 页签名不带「设置」：上面标题已经是「店铺设置」，每个页签再写一遍是重复，
  // 而且四个 6 字页签在 375px 手机上要横滑 47px（改名前实测）——这是本来就有的适配问题。
  // 去掉后与「订单管理」下的渠道叫法也统一了：同一个渠道在整个后台是同一个词。
  settings: [
    { to: '/settings/express', label: '全国邮寄' },
    { to: '/settings/local', label: '同城配送' },
    { to: '/settings/pickup', label: '到店自取' },
    { to: '/settings/hours', label: '营业时间' },
  ],
  // 2026-09-17 归拢：原「会员营销」整个并进来，满减活动从「店铺设置」挪进来。
  // 顺序按「怎么发优惠 → 摆在哪儿 → 按什么规则」排：前三项是日常要新建要停用的活动，
  // 轮播图是展示位，会员设置是开店时定一次的规则，放最后。
  //
  // 扫码统计（/promotion/scan-stats）**故意不在这里**：店主 2026-09-17 决定先收起来，
  // 等要用时再放回来。页面与路由都还在，往这个数组里加回一行 { to: '/promotion/scan-stats',
  // label: '扫码统计' } 就恢复，不需要动别的地方。
  promotion: [
    { to: '/promotion/coupons', label: '优惠券' },
    // 「满减活动」在这一行里是唯一能安全缩短的：标题已经说了这是推广运营，
    // 「满减」两个字不会有歧义。保留「积分赠品」「会员设置」的全称——缩成
    // 「赠品」会被当成随单送的赠品，缩成「会员」会跟「用户管理」里的会员列表混。
    { to: '/promotion/discount', label: '满减' },
    { to: '/promotion/points-goods', label: '积分赠品' },
    { to: '/promotion/banners', label: '轮播图' },
    { to: '/promotion/member', label: '会员设置' },
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

/**
 * 「这个地址该去哪儿」的唯一映射表，两类都在这儿：
 *   1. 改造前的旧地址（/products、/banners…）——保住书签与外部链接；
 *   2. 业务中心根（/catalog、/system…）——落到该中心的默认子页。
 * 两类都经 legacyTarget 走同一条重定向，因此都会原样带上查询参数。
 * 用 <Navigate to="products"> 那种相对跳转做第 2 类会把 search 丢掉。
 */
const legacyRoutes: Record<string, string> = {
  '/catalog': '/catalog/products',
  '/settings': '/settings/express',
  '/promotion': '/promotion/coupons',
  '/system': '/system/printer',
  '/products': '/catalog/products',
  '/categories': '/catalog/categories',
  '/orders': '/orders/express',
  '/local/orders': '/orders/local',
  '/shop-settings': '/settings/express',
  '/local/settings': '/settings/local',
  '/banners': '/promotion/banners',
  '/scan-stats': '/promotion/scan-stats',
  '/printer-settings': '/system/printer',

  // 2026-09-17 归拢到「推广运营」后的旧地址。店主与店员浏览器里存的链接、以及第一批
  // 改造时留下的更老的裸地址（/coupons 这种），都必须还能落地。
  // 「会员营销」这个中心整个没了，它自己和三个子页一起重定向。
  '/membership': '/promotion/coupons',
  '/membership/coupons': '/promotion/coupons',
  '/membership/points-goods': '/promotion/points-goods',
  '/membership/settings': '/promotion/member',
  '/coupons': '/promotion/coupons',
  '/points-goods': '/promotion/points-goods',
  '/member-settings': '/promotion/member',
  // 满减活动从店铺设置挪到推广运营
  '/settings/promotion': '/promotion/discount',
}

export const legacyTarget = (pathname: string, search: string) => ({
  pathname: legacyRoutes[pathname] ?? pathname,
  search,
})
