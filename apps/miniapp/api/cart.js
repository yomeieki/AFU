const { request } = require('../utils/request')

// channel 省略或非 LOCAL 时显式带 EXPRESS，避免依赖服务端默认渠道契约
function getCart(channel) {
  return request({ url: '/cart?channel=' + (channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS') })
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
