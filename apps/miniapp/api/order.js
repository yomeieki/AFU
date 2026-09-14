const { request } = require('../utils/request')
const { baseURL } = require('../config/index')

// data 原样透传，**这里不生成 clientRequestId**：幂等键必须由页面持有，
// 重试时沿用同一个才有意义；在 API 层生成的话每次调用都是新 id，等于没有幂等。
function createOrder(data, silent) {
  return request({ url: '/orders', method: 'POST', data: data, silent: !!silent })
}

function getOrders(params) {
  var parts = []
  if (params) {
    if (params.status) parts.push('status=' + encodeURIComponent(params.status))
    // 渠道过滤由服务端做。客户端拿分页结果再筛会漏单——第一页 20 条里可能一条同城都没有。
    // 只在明确要过滤时才带这个参数；传空串会被服务端按「不过滤」处理，但不如不传干净。
    if (params.deliveryType) parts.push('deliveryType=' + encodeURIComponent(params.deliveryType))
    if (params.channel) parts.push('channel=' + encodeURIComponent(params.channel))
    if (params.page) parts.push('page=' + params.page)
    if (params.pageSize) parts.push('pageSize=' + params.pageSize)
  }
  var url = '/orders' + (parts.length ? '?' + parts.join('&') : '')
  return request({ url: url })
}

// 下单页公共参数：{ subscribeTemplateIds, payTimeoutMin }
function getOrderMeta() {
  return request({ url: '/orders/meta' })
}

function getOrderDetail(id) {
  return request({ url: '/orders/' + id })
}

function confirmOrder(id) {
  return request({ url: '/orders/' + id + '/confirm', method: 'PUT' })
}

// 客户自助取消：待付款直接取消；已付款未接单进入退款流程；接单后由后端拒绝
function cancelOrder(id) {
  return request({ url: '/orders/' + id + '/cancel', method: 'PUT' })
}

// 同城：接单后宽限期内申请取消（订单状态不变，店员确认后全额退）
function requestCancelOrder(id, note) {
  return request({ url: '/orders/' + id + '/cancel-request', method: 'POST', silent: true, data: note ? { note: note } : {} })
}

// 同城：骑手位置（非在途或查不到时 data.location 为 null，不是错误）
function getCourierLocation(id) {
  return request({ url: '/orders/' + id + '/courier', silent: true })
}

// 售后申请（已发货/已完成订单）：{ reason, description, images: [url] }
function applyAfterSale(orderId, data) {
  return request({ url: '/orders/' + orderId + '/after-sale', method: 'POST', data: data })
}

// 上传售后凭证图片：POST /upload（multipart 字段名 file），resolve 图片绝对 URL。
// 与 utils/request 一致：token 取 storage，失败统一 toast 后 reject。
function uploadImage(filePath) {
  return new Promise(function(resolve, reject) {
    var token = wx.getStorageSync('token')
    wx.uploadFile({
      url: baseURL + '/upload',
      filePath: filePath,
      name: 'file',
      header: token ? { Authorization: 'Bearer ' + token } : {},
      success: function(res) {
        var body = null
        try { body = JSON.parse(res.data) } catch (e) { body = null }
        if (body && body.code === 0 && body.data && body.data.url) {
          resolve(body.data.url)
          return
        }
        var msg = (body && body.message) || '图片上传失败，请重试'
        wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        reject(new Error(msg))
      },
      fail: function(err) {
        var isTimeout = err && err.errMsg && err.errMsg.indexOf('timeout') !== -1
        var msg = isTimeout ? '上传超时，请检查网络后重试' : '图片上传失败，请重试'
        wx.showToast({ title: msg, icon: 'none', duration: 2000 })
        reject(new Error(msg))
      },
    })
  })
}

// 自取：最近一张自取单的取餐人（结算页预填），没有则 null。silent：拉不到就留空让顾客填
function getPickupContact() {
  return request({ url: '/orders/pickup-contact', silent: true })
}

// 该顾客最近一次选过的餐具（结算页预填），没有则 null。silent：拉不到就让顾客自己选
function getLastTableware() {
  return request({ url: '/orders/tableware-last', silent: true })
}

module.exports = {
  createOrder,
  getOrders,
  getOrderMeta,
  getPickupContact,
  getLastTableware,
  getOrderDetail,
  confirmOrder,
  cancelOrder,
  requestCancelOrder,
  getCourierLocation,
  applyAfterSale,
  uploadImage,
}
