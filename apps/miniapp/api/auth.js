const { request } = require('../utils/request')

function wechatLogin(code) {
  return request({ url: '/auth/wechat-login', method: 'POST', data: { code: code } })
}

module.exports = { wechatLogin }
