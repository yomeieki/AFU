const { getAddresses, deleteAddress } = require('../../api/address')
const { getLocalMeta } = require('../../api/local')
const app = getApp()

function getStraightDistanceKm(fromLatE6, fromLngE6, toLatE6, toLngE6) {
  var rad = Math.PI / 180
  var earthRadiusKm = 6371
  var lat1 = fromLatE6 / 1e6 * rad
  var lat2 = toLatE6 / 1e6 * rad
  var deltaLat = lat2 - lat1
  var deltaLng = (toLngE6 - fromLngE6) / 1e6 * rad
  var a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2)
  a += Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2)
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthRadiusKm * c
}

function decorateLocalAddresses(list, meta) {
  var store = meta && meta.store
  // 没有门店坐标时，不能把 null 当作 0 从赤道起算；直接不显示辅助距离标签。
  if (!store || store.latE6 == null || store.lngE6 == null) return list
  return list.map(function(address) {
    if (address.latE6 === null || address.latE6 === undefined || address.lngE6 === null || address.lngE6 === undefined) {
      return Object.assign({}, address, { localStatus: 'missing', localDistanceText: '需补充定位' })
    }
    var km = getStraightDistanceKm(store.latE6, store.lngE6, address.latE6, address.lngE6)
    var inRange = km <= meta.radiusStraightKm
    return Object.assign({}, address, {
      localStatus: inRange ? 'near' : 'far',
      localDistanceText: '直线约 ' + km.toFixed(1) + ' km' + (inRange ? '' : ' · 可能超范围'),
    })
  })
}

Page({
  data: {
    addresses: [],
    loading: true,
    // 'select' mode: choosing address for order confirm page
    mode: 'normal',
    channel: 'EXPRESS',
    returnTo: '',
  },

  onLoad(options) {
    this.setData({
      mode: options.mode || 'normal',
      channel: options.channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS',
      // 由结算页传来，原样继续传给编辑页。本页自己不用它——
      // 它只表示「这条链路的起点是结算页」。
      returnTo: options.returnTo || '',
    })
  },

  onShow() {
    this.loadAddresses()
  },

  loadAddresses() {
    var self = this
    this.setData({ loading: true })
    return getAddresses()
      .then(function(list) {
        if (self.data.channel !== 'LOCAL') {
          self.setData({ addresses: list, loading: false })
          return
        }
        return getLocalMeta().then(function(meta) {
          // 列表上的 km 只是直线粗估，用来帮顾客一眼分辨「哪个地址大概在城这边」，
          // 不是计费距离——计费用的是运力方实测道路距离，只有 /local/quote 给得出。
          // 不给每行各调一次 quote 的原因有两个：一是 /local/quote 每次都会外呼运力方
          // batchPrice（有连接占用），二是服务端限流 30 次/分钟，五六个地址就能把顾客
          // 后面的正经报价挤掉。所以文案一律带「直线约」，且「可能超范围」不禁用选择：
          // 真正的 42220 由确认页拿服务端结论来判，前端不替服务端下结论。
          self.setData({ addresses: decorateLocalAddresses(list, meta), loading: false })
        }).catch(function() {
          // 距离标签只是辅助信息，拿不到就不显示；地址本身必须照常渲染。
          self.setData({ addresses: list, loading: false })
        })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  // 把「从哪来」显式传下去。edit 页据此决定：保存成功后是回列表，
  // 还是把新地址交给结算页并直接回退两层。
  editQuery: function(prefix) {
    var q = prefix
    if (this.data.channel === 'LOCAL') q += 'channel=LOCAL&'
    if (this.data.returnTo) q += 'returnTo=' + this.data.returnTo + '&'
    return q.slice(0, -1)
  },

  onAddAddress() {
    wx.navigateTo({ url: '/pages/address/edit' + this.editQuery('?') })
  },

  onEditAddress(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/address/edit' + this.editQuery('?id=' + id + '&') })
  },

  onDeleteAddress(e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '提示',
      content: '确认删除该地址？',
      success: function(res) {
        if (!res.confirm) return
        deleteAddress(id).then(function() { self.loadAddresses() })
      },
    })
  },

  onSelectAddress(e) {
    if (this.data.mode !== 'select') return
    var address = e.currentTarget.dataset.address
    if (this.data.channel === 'LOCAL' && address.localStatus === 'missing') {
      // 补完定位同样要能一路回到结算页——否则顾客补完坐标回到列表，
      // 还得再点一次同一条地址，而他刚才点的就是它。
      wx.navigateTo({ url: '/pages/address/edit' + this.editQuery('?id=' + address.id + '&') })
      return
    }
    app.globalData.selectedAddress = address
    wx.navigateBack()
  },
})
