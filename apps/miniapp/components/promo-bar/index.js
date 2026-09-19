var promoBarOf = require('../../utils/promo').promoBarOf
Component({
  options: { addGlobalClass: true },
  properties: {
    promotion: { type: null, value: null },
    deliveryType: { type: String, value: 'LOCAL' },
  },
  data: { bar: { show: false, summary: '', name: '', detailLines: [] } },
  observers: {
    'promotion, deliveryType': function() {
      this.setData({ bar: promoBarOf(this.properties.promotion, this.properties.deliveryType) })
    },
  },
  methods: {
    onTapDetail: function() {
      var bar = this.data.bar
      if (!bar.show) return
      wx.showModal({ title: bar.name, content: bar.detailLines.join('\n'), showCancel: false, confirmText: '知道了' })
    },
  },
})
