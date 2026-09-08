const { request } = require('../utils/request')

// 邮寄报价：清单与下单同形（cartItemIds 或 directItem，可带 gifts）。
// silent=true：结算页要按 code 自己分流（42260 不寄送要显示在页面里，不是 toast）。
function quoteExpress(data) {
  return request({ url: '/express/quote', method: 'POST', silent: true, data: data })
}

module.exports = { quoteExpress: quoteExpress }
