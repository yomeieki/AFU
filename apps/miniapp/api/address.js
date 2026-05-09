const { request } = require('../utils/request')

function getAddresses() {
  return request({ url: '/addresses' })
}

function createAddress(data) {
  return request({ url: '/addresses', method: 'POST', data: data })
}

function updateAddress(id, data) {
  return request({ url: '/addresses/' + id, method: 'PUT', data: data })
}

function deleteAddress(id) {
  return request({ url: '/addresses/' + id, method: 'DELETE' })
}

module.exports = { getAddresses, createAddress, updateAddress, deleteAddress }
