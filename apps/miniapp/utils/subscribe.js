/**
 * 订阅消息授权：必须在用户点击手势内调用 wx.requestSubscribeMessage。
 * 模板 ID 由服务端下发（订单接口 subscribeTemplateIds），未配置则直接跳过。
 * 无论用户允许/拒绝/接口失败，都继续执行 next（订阅只是附加能力，绝不阻塞下单/支付）。
 */
function requestSubscribe(tmplIds, next) {
  var ids = (tmplIds || []).filter(Boolean)
  if (ids.length === 0 || typeof wx.requestSubscribeMessage !== 'function') {
    next()
    return
  }
  var called = false
  var done = function() {
    if (called) return
    called = true
    next()
  }
  try {
    wx.requestSubscribeMessage({
      tmplIds: ids.slice(0, 3),
      complete: done,
    })
  } catch (e) {
    done()
  }
  // 极端情况下 complete 不回调（旧基础库），兜底 3 秒后继续
  setTimeout(done, 3000)
}

module.exports = { requestSubscribe }
