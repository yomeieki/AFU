const { request } = require('../utils/request')

// 同城店头：营业状态/范围/起送/运费规则/门店坐标。未登录也可调。
function getLocalMeta() {
  return request({ url: '/local/meta', silent: true })
}

// 报价：登录态传 addressId（才会签发 quoteToken），subtotal 决定免运/起送口径。
// silent=true：确认页要按 code 自己分流，不走统一 toast。
function quoteLocal(addressId, subtotal) {
  return request({ url: '/local/quote', method: 'POST', silent: true, data: { addressId: addressId, subtotal: subtotal } })
}

// 匿名报价：只给坐标、不给 addressId。地址编辑页在顾客选完点后用它显示一条参考运费。
// 服务端在这条路径上**不签 quoteToken**（local.ts:97），所以它拿不到能下单的凭证——
// 这正是想要的：编辑页只是给个参考，真正的报价在结算页按 addressId 重新签。
// silent=true：顾客正在填地址，报价失败不该弹一个全局 toast 打断他。
function quoteLocalByLocation(latE6, lngE6) {
  return request({
    url: '/local/quote',
    method: 'POST',
    silent: true,
    data: { latE6: latE6, lngE6: lngE6, subtotal: 0 },
  })
}

// 自取时段（公开）。silent：结算页要按 blocked 自己分流，不走统一 toast。
function getPickupSlots() {
  return request({ url: '/local/pickup-slots', silent: true })
}

function getPromoPreview(deliveryType, subtotal) {
  return request({ url: '/local/promo-preview?deliveryType=' + deliveryType + '&subtotal=' + (subtotal || 0), silent: true })
}

module.exports = {
  getPromoPreview: getPromoPreview,
  getLocalMeta: getLocalMeta,
  quoteLocal: quoteLocal,
  quoteLocalByLocation: quoteLocalByLocation,
  getPickupSlots: getPickupSlots,
}
