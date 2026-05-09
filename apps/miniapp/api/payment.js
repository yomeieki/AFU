const { request } = require('../utils/request')

function mockPaySuccess(orderNo) {
  return request({ url: '/payments/mock/success', method: 'POST', data: { orderNo: orderNo } })
}

module.exports = { mockPaySuccess }
