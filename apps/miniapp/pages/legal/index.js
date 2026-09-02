const legal = require('../../config/legal')

Page({
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
