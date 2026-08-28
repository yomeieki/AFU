const { request } = require('../utils/request')

function createOrder(data) {
  return request({ url: '/orders', method: 'POST', data: data })
}

function getOrders(params) {
  var parts = []
  if (params) {
    if (params.status) parts.push('status=' + params.status)
    if (params.page) parts.push('page=' + params.page)
    if (params.pageSize) parts.push('pageSize=' + params.pageSize)
  }
  var url = '/orders' + (parts.length ? '?' + parts.join('&') : '')
  return request({ url: url })
}

function getOrderDetail(id) {
  return request({ url: '/orders/' + id })
}

function confirmOrder(id) {
  return request({ url: '/orders/' + id + '/confirm', method: 'PUT' })
}

// 客户自助取消：待付款直接取消；已付款未接单进入退款流程；接单后由后端拒绝
function cancelOrder(id) {
  return request({ url: '/orders/' + id + '/cancel', method: 'PUT' })
}

module.exports = { createOrder, getOrders, getOrderDetail, confirmOrder, cancelOrder }
