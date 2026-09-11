// 购物渠道上下文。
//
// 微信原生 tabBar 的 pagePath 是写死在 app.json 里的，不可能给两个渠道各配四个页面。
// 所以「同城配送」和「全国邮寄」共用同一组 tabBar 页，靠一个全局渠道值决定加载哪边的内容。
//
// 权威值在 app.globalData.shoppingChannel（内存），本模块只负责两件事：
//   ① 归一化——任何来源的值都收敛成 'LOCAL' | 'EXPRESS'，绝不把脏值往下传；
//   ② 落盘与恢复——storage 只用于页面重载 / 开发者工具热重载后把内存值补回来，
//      不是每次读渠道都来查 storage（那样切渠道的时序会变得难以推理）。
//
// 为什么所有 storage 调用都包 try/catch：隐私模式、用户清缓存、开发者工具偶发都可能让
// getStorageSync/setStorageSync 抛。它在 app.onLaunch 路径上，抛出去就是**整个小程序打不开**，
// 比「渠道记错」严重得多。读失败按首次进入处理（EXPRESS），写失败静默——
// 下次冷启动回落到 EXPRESS 是可接受的降级，封面页重新选一次就好。

var STORAGE_KEY = 'shoppingChannel'

function normalizeChannel(value) {
  return value === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
}

function getShoppingChannel() {
  var raw = ''
  try {
    raw = wx.getStorageSync(STORAGE_KEY)
  } catch (err) {
    raw = ''
  }
  return normalizeChannel(raw)
}

function setShoppingChannel(value) {
  var channel = normalizeChannel(value)
  try {
    wx.setStorageSync(STORAGE_KEY, channel)
  } catch (err) {
    // 落盘失败不影响本次会话——内存里的 globalData 才是权威值
  }
  return channel
}

// 商品、分类、购物车、订单的请求一律显式带渠道，不依赖服务端默认值。
// 服务端 /categories、/products、/cart 的 channel 缺省是 EXPRESS，
// 漏传的表现是「同城模式下看到邮寄的货」——不报错、不好发现。
function channelQuery(value) {
  return 'channel=' + normalizeChannel(value)
}

// ── 同城子模式：外送 / 自取 ─────────────────────────────────
// 与 shoppingChannel 同一套约定：内存里 app.globalData.localMode 是权威值，
// storage 只在冷启动/热重载时补回来；读写失败都不抛（隐私模式、清缓存）。
var MODE_STORAGE_KEY = 'localMode'

function normalizeLocalMode(value) {
  return value === 'PICKUP' ? 'PICKUP' : 'DELIVERY'
}

function getLocalMode() {
  var raw = ''
  try {
    raw = wx.getStorageSync(MODE_STORAGE_KEY)
  } catch (err) {
    raw = ''
  }
  return normalizeLocalMode(raw)
}

function setLocalMode(value) {
  var mode = normalizeLocalMode(value)
  try {
    wx.setStorageSync(MODE_STORAGE_KEY, mode)
  } catch (err) {
    // 落盘失败不影响本次会话
  }
  return mode
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  normalizeChannel: normalizeChannel,
  getShoppingChannel: getShoppingChannel,
  setShoppingChannel: setShoppingChannel,
  channelQuery: channelQuery,
  MODE_STORAGE_KEY: MODE_STORAGE_KEY,
  normalizeLocalMode: normalizeLocalMode,
  getLocalMode: getLocalMode,
  setLocalMode: setLocalMode,
}
