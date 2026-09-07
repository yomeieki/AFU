// 封面六个入口的唯一事实来源。
//
// rect —— 点击热区，单位 rpx，基准画板 750 × 1333（方案 C 青瓦简约版）。
//   坐标出自设计交付包 specs/hotspots.json。与该文件唯一的差异：会员中心 / 优惠券 /
//   积分商城原坐标边界完全相接（140-297-454-610），与交付包《转换准备》里
//   「热区之间保留间隔，避免互相误触」自相矛盾。这里各留 12rpx 间隙，
//   三段文字的视觉中心 218.5 / 375.5 / 532 保持不变，视觉零改动。
//
// action —— 跳转方式，三种：
//   'local'     走 app.enterLocalChannel()：位置许可 → 定渠道 LOCAL → switchTab 进共享主页。
//               ⚠️ 这一档**不读 route**（双渠道改版后同城与邮寄共用同一个主页），
//               下面那个 route 只留作「旧兼容路由在哪」的记录，改它不会改变跳转行为。
//   'switchTab' 目标是 tabBar 页，只能用 switchTab；跳之前会显式把渠道定成 EXPRESS，
//               否则顾客上次停在同城时，主页会拉出同城的菜单
//   'navigate'  普通 navigateTo（会员三页，与渠道无关，不碰渠道）
module.exports = [
  {
    id: 'local_delivery',
    label: '同城配送',
    en: 'LOCAL DELIVERY',
    event: 'tap_local_delivery',
    variant: 'delivery',
    rect: { x: 58, y: 558, width: 306, height: 120 },
    action: 'local',
    route: '/pages/local/index'
  },
  {
    id: 'nationwide_shipping',
    label: '全国邮寄',
    en: 'NATIONWIDE SHIPPING',
    event: 'tap_nationwide_shipping',
    variant: 'delivery',
    rect: { x: 386, y: 558, width: 306, height: 120 },
    action: 'switchTab',
    route: '/pages/index/index'
  },
  {
    id: 'member_center',
    label: '会员中心',
    en: '',
    event: 'tap_member_center',
    variant: 'text',
    rect: { x: 146, y: 724, width: 145, height: 88 },
    action: 'navigate',
    route: '/pages/member/index'
  },
  {
    id: 'coupon',
    label: '优惠券',
    en: '',
    event: 'tap_coupon',
    variant: 'text',
    rect: { x: 303, y: 724, width: 145, height: 88 },
    action: 'navigate',
    route: '/pages/member/coupons'
  },
  {
    id: 'points_mall',
    label: '积分商城',
    en: '',
    event: 'tap_points_mall',
    variant: 'text',
    rect: { x: 460, y: 724, width: 144, height: 88 },
    action: 'navigate',
    route: '/pages/member/mall'
  },
  {
    // 现状：冷链与「全国邮寄」落到同一个 tabBar 主页（沿用亭子版封面 goExpress 的行为）。
    // 交付包把它列为独立入口，但没给独立页面；是否要单开页面/WebView/客服会话待业务方定。
    id: 'cold_chain',
    label: '全国冷链配送',
    en: 'COLD-CHAIN DELIVERY',
    event: 'tap_cold_chain',
    variant: 'banner',
    rect: { x: 140, y: 844, width: 470, height: 120 },
    action: 'switchTab',
    route: '/pages/index/index'
  }
];
