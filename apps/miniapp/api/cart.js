const { request } = require('../utils/request')
const { normalizeChannel } = require('../utils/channel')

// 渠道永远显式带上，不依赖服务端默认值。归一化走 utils/channel 那一份，
// 与 api/catalog 用同一个来源——两处各写一套「非 LOCAL 就当 EXPRESS」的话，
// 将来加第三个渠道时必然漏改一处。
function getCart(channel) {
  return request({ url: '/cart?channel=' + normalizeChannel(channel) })
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
