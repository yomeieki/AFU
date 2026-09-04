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

module.exports = { getLocalMeta: getLocalMeta, quoteLocal: quoteLocal }
