const { request } = require('../utils/request')

function getCart() {
  return request({ url: '/cart' })
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
