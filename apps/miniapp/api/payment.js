const { request } = require('../utils/request')

function mockPaySuccess(orderNo) {
  return request({ url: '/payments/mock/success', method: 'POST', data: { orderNo: orderNo } })
}

function payOrder(orderId) {
  return request({ url: '/orders/' + orderId + '/pay', method: 'POST' })
}

module.exports = { mockPaySuccess, payOrder }
