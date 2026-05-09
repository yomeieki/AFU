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

module.exports = { createOrder, getOrders, getOrderDetail }
