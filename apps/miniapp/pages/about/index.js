const shop = require('../../config/shop')
const { callShop } = require('../../utils/contact')
const { getLocalMeta } = require('../../api/local')

Page({
  data: {
    shop: shop,
    // 营业时间只有后台那一份（local_delivery.businessHours）。config/shop.js 的字符串只作接口失败兜底
    businessHoursText: shop.businessHours,
  },

  onLoad() {
    var self = this
    getLocalMeta()
      .then(function(meta) {
        var hours = (meta && meta.businessHours) || []
        var text = hours.map(function(h) { return h.start + '–' + h.end }).join('、')
        if (text) self.setData({ businessHoursText: text })
      })
      .catch(function() {})
  },

  onCall() {
    callShop()
  },

  onCopyAddress() {
    wx.setClipboardData({ data: shop.address })
  },

  goLegal(e) {
    var type = e.currentTarget.dataset.type
    wx.navigateTo({ url: '/pages/legal/index?type=' + type })
  },
})
