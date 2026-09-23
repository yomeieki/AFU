const legal = require('../../config/legal')
var share = require('../../utils/share')

Page({
  onShareAppMessage: share.onShareAppMessage,
  data: {
    doc: null,
  },

  onLoad(options) {
    var type = options.type === 'privacy' ? 'privacy' : 'agreement'
    var doc = legal[type]
    wx.setNavigationBarTitle({ title: doc.title })
    this.setData({ doc: doc })
  },
})
