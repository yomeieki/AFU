const { request } = require('../utils/request')

function getCart() {
  return request({ url: '/cart' })
}

function addToCart(productId, quantity) {
  return request({ url: '/cart', method: 'POST', data: { productId: productId, quantity: quantity } })
}

function updateCartItem(id, data) {
  return request({ url: '/cart/' + id, method: 'PUT', data: data })
}

function deleteCartItem(id) {
  return request({ url: '/cart/' + id, method: 'DELETE' })
}

module.exports = { getCart, addToCart, updateCartItem, deleteCartItem }
