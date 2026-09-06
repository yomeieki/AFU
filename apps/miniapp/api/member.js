var request = require('../utils/request').request

// 会员积分与优惠券的八个端点。页面一律走这里，不自己拼 URL。
// 查询串手拼（与 api/order.js 同款）——小程序没有 URLSearchParams。

// 会员中心页头 + 规则说明。points{enabled,earnRatePerYuan,validDays} 与 rulesText
// 是规则公示要实时渲染的值，**不许在页面里写死数字**（docs/member-terms-copy.md）
function getSummary(silent) {
  return request({ url: '/member/summary', silent: !!silent })
}

// 积分明细。行里 expiresAt 是「有效期至」，orderNo 是 refType='ORDER' 时的单号；
// 跳订单详情用的是 refId（它就是 Order.id），不是 orderNo
function getPointsLedger(page, pageSize) {
  return request({ url: '/member/points/ledger?page=' + (page || 1) + '&pageSize=' + (pageSize || 20) })
}

// status 只认 available | used | expired（服务端 zod enum），不是库里的 UNUSED/USED/EXPIRED
function getCoupons(status) {
  return request({ url: '/member/coupons?status=' + status })
}

// 积分商城：{ pointsBalance, points, coupons[], gifts[] }。gifts 只展示不能在此兑换
function getMall() {
  return request({ url: '/member/mall' })
}

// 积分换券。42250 积分不足 / 42253 已领完或已达上限 / 42254 该活动已结束
function redeemCoupon(templateId) {
  return request({ url: '/member/points/redeem', method: 'POST', data: { templateId: templateId } })
}

// 领券中心：{ list[] }，每项带 remaining（null=不限）与 claimedByMe
function getCampaign() {
  return request({ url: '/member/campaign' })
}

function claimCoupon(templateId) {
  return request({ url: '/member/coupons/claim', method: 'POST', data: { templateId: templateId } })
}

// 结算页优惠项。subtotal 传**券前**商品小计（分）。
// silent=true：结算页拉失败时由组件自己显示降级态，不该弹全局 toast
function getCheckoutOptions(channel, subtotal, silent) {
  return request({
    url: '/member/checkout-options?channel=' + channel + '&subtotal=' + subtotal,
    silent: !!silent,
  })
}

module.exports = {
  getSummary: getSummary,
  getPointsLedger: getPointsLedger,
  getCoupons: getCoupons,
  getMall: getMall,
  redeemCoupon: redeemCoupon,
  getCampaign: getCampaign,
  claimCoupon: claimCoupon,
  getCheckoutOptions: getCheckoutOptions,
}
