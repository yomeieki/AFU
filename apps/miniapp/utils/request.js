const { baseURL } = require('../config/index')

/**
 * Wraps wx.request in a Promise.
 * Resolves with res.data.data on code===0, rejects otherwise.
 * token 失效（40101/40102）时自动重新登录并重试一次。
 */
function doRequest({ url, method = 'GET', data = {} }, retried) {
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
                return doRequest({ url, method, data }, true)
              })
              .then(resolve)
              .catch(function(err) {
                wx.showToast({ title: '登录已过期，请重试', icon: 'none', duration: 2000 })
                reject(err)
              })
            return
          }
        }
        const msg = (body && body.message) || '请求失败'
        wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        reject(new Error(msg))
      },
      fail() {
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none', duration: 2000 })
        reject(new Error('network error'))
      },
    })
  })
}

function request(options) {
  return doRequest(options, false)
}

module.exports = { request }
