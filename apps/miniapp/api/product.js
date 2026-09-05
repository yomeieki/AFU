const { request } = require('../utils/request')

// 列表接口（/products）只带 hasSkus，不带 skus/specDimensions；
// 凡是要喂给 sku-popup 的商品都得走这条详情接口拿完整规格。
function getProductDetail(id) {
  return request({ url: '/products/' + id })
}

module.exports = { getProductDetail }
