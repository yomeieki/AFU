const { baseURL } = require('../config/index')

/**
 * Wraps wx.request in a Promise.
 * Resolves with res.data.data on code===0, rejects otherwise.
 * token 失效（40101/40102）时自动重新登录并重试一次。
 */
// 把后端/网关的技术性错误翻译成用户能看懂的话；业务 4xx 的中文 message 原样透出
function friendlyMessage(statusCode, body) {
  if (body && body.code === 50001) return '系统开小差了，请稍后再试'
  if (statusCode === 429) return '操作太频繁，请稍后再试'
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) return '服务繁忙，请稍后再试'
  if (body && typeof body.message === 'string' && body.message) return body.message
  return '请求失败，请稍后再试'
}

function doRequest({ url, method = 'GET', data = {}, silent = false }, retried) {
  return new Promise((resolve, reject) => {
    const token = wx.getStorageSync('token')
    wx.request({
      url: baseURL + url,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      success(res) {
        const body = res.data
        if (body && body.code === 0) {
          resolve(body.data)
          return
        }
        // 未登录/token 过期：自动重新登录后重试一次（登录接口本身除外，防循环）
        const isAuthError = body && (body.code === 40101 || body.code === 40102)
        if (isAuthError && !retried && url.indexOf('/auth/') !== 0) {
          const app = getApp()
          if (app && app._tryLogin) {
            app
              ._tryLogin()
              .then(function() {
                return doRequest({ url, method, data, silent }, true)
              })
              .then(resolve)
              .catch(function(err) {
                if (!silent) wx.showToast({ title: '登录已过期，请重试', icon: 'none', duration: 2000 })
                reject(err)
              })
            return
          }
        }
        const msg = friendlyMessage(res.statusCode, body)
        if (!silent) wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        const err = new Error(msg)
        // 业务码透出给调用方分流（42227/42239/42220…）；网络层失败没有业务码，置 null。
        // silent 只关掉 toast，不影响 code —— 「谁来提示」是页面的事，「出了什么事」是这里的事。
        err.code = body && typeof body.code === 'number' ? body.code : null
        err.data = body && body.data ? body.data : null
        reject(err)
      },
      fail(err) {
        const isTimeout = err && err.errMsg && err.errMsg.indexOf('timeout') !== -1
        const msg = isTimeout ? '网络超时，请检查网络后重试' : '网络错误，请稍后重试'
        if (!silent) wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        const requestErr = new Error(msg)
        requestErr.code = null
        reject(requestErr)
      },
    })
  })
}

function request(options) {
  return doRequest(options, false)
}

module.exports = { request }
