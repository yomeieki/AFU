const shop = require('../../config/shop')
const { callShop } = require('../../utils/contact')

Page({
  data: {
    shop: shop,
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
