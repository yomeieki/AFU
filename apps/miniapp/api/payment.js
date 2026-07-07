const { request } = require('../utils/request')

// 发起支付：后端按 WECHAT_PAY_MOCK 返回 { mode: 'mock' } 或 { mode: 'wechat', ...payParams }
function payOrder(orderId) {
  return request({ url: '/orders/' + orderId + '/pay', method: 'POST' })
}

module.exports = { payOrder }
