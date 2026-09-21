var promoBarOf = require('../../utils/promo').promoBarOf
var freeShipBarOf = require('../../utils/promo').freeShipBarOf
Component({
  options: { addGlobalClass: true },
  properties: {
    // 'promo'（默认，满减条）| 'freeship'（免运费条，复用同一组件与同一套 wxss）
    kind: { type: String, value: 'promo' },
    promotion: { type: null, value: null },
    meta: { type: null, value: null },
    deliveryType: { type: String, value: 'LOCAL' },
  },
  data: { bar: { show: false, badge: '', summary: '', name: '', detailLines: [] } },
  observers: {
    'kind, promotion, meta, deliveryType': function() {
      var bar = this.properties.kind === 'freeship'
        ? freeShipBarOf(this.properties.meta, this.properties.deliveryType)
        : promoBarOf(this.properties.promotion, this.properties.deliveryType)
      this.setData({ bar: bar })
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
