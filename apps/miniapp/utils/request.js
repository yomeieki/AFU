const { baseURL } = require('../config/index')

/**
 * Wraps wx.request in a Promise.
 * Resolves with res.data.data on code===0, rejects otherwise.
 */
function request({ url, method = 'GET', data = {} }) {
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
        } else {
          const msg = (body && body.message) || '请求失败'
          wx.showToast({ title: msg, icon: 'none', duration: 2000 })
          reject(new Error(msg))
        }
      },
      fail() {
        wx.showToast({ title: '网络错误，请稍后重试', icon: 'none', duration: 2000 })
        reject(new Error('network error'))
      },
    })
  })
}

module.exports = { request }
