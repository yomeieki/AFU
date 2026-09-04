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

Page({
  data: {
    addresses: [],
    loading: true,
    // 'select' mode: choosing address for order confirm page
    mode: 'normal',
    channel: 'EXPRESS',
  },

  onLoad(options) {
    this.setData({ mode: options.mode || 'normal', channel: options.channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS' })
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
          var addresses = list.map(function(address) {
            if (address.latE6 === null || address.latE6 === undefined || address.lngE6 === null || address.lngE6 === undefined) {
              return Object.assign({}, address, { localStatus: 'missing', localDistanceText: '需补充定位' })
            }
            var km = getStraightDistanceKm(meta.store.latE6, meta.store.lngE6, address.latE6, address.lngE6)
            var inRange = km <= meta.radiusStraightKm
            return Object.assign({}, address, {
              localStatus: inRange ? 'near' : 'far',
              localDistanceText: '直线约 ' + km.toFixed(1) + ' km' + (inRange ? '' : ' · 可能超范围'),
            })
          })
          self.setData({ addresses: addresses, loading: false })
        })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  onAddAddress() {
    wx.navigateTo({ url: '/pages/address/edit' + (this.data.channel === 'LOCAL' ? '?channel=LOCAL' : '') })
  },

  onEditAddress(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/address/edit?id=' + id + (this.data.channel === 'LOCAL' ? '&channel=LOCAL' : '') })
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
      wx.navigateTo({ url: '/pages/address/edit?id=' + address.id + '&channel=LOCAL' })
      return
    }
    app.globalData.selectedAddress = address
    wx.navigateBack()
  },
})
