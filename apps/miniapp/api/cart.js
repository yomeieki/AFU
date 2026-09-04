const { request } = require('../utils/request')

// channel 省略 = EXPRESS（服务端默认），保持既有调用零改动
function getCart(channel) {
  return request({ url: '/cart' + (channel === 'LOCAL' ? '?channel=LOCAL' : '') })
}

function addToCart(productId, quantity, skuId) {
  var data = { productId: productId, quantity: quantity }
  if (skuId) data.skuId = skuId
  return request({ url: '/cart', method: 'POST', data: data })
}

function updateCartItem(id, data) {
  return request({ url: '/cart/' + id, method: 'PUT', data: data })
}

function deleteCartItem(id) {
  return request({ url: '/cart/' + id, method: 'DELETE' })
}

module.exports = { getCart, addToCart, updateCartItem, deleteCartItem }
