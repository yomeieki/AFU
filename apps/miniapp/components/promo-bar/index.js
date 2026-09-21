var promoBarOf = require('../../utils/promo').promoBarOf
var freeShipBarOf = require('../../utils/promo').freeShipBarOf
var sheetRowsOf = require('./sheet').sheetRowsOf
Component({
  options: { addGlobalClass: true },
  properties: {
    // 'promo'（默认，满减条）| 'freeship'（免运费条，复用同一组件与同一套 wxss）
    kind: { type: String, value: 'promo' },
    promotion: { type: null, value: null },
    meta: { type: null, value: null },
    deliveryType: { type: String, value: 'LOCAL' },
  },
  data: {
    bar: { show: false, badge: '', summary: '', name: '', detailLines: [] },
    sheetOpen: false,
    sheet: { title: '', rows: [], note: '' },
  },
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
      var rowsAndNote = sheetRowsOf(this.properties.kind, this.properties.promotion, this.properties.meta)
      this.setData({
        sheetOpen: true,
        sheet: { title: bar.name, rows: rowsAndNote.rows, note: rowsAndNote.note },
      })
    },
    onCloseSheet: function() {
      this.setData({ sheetOpen: false })
    },
    noop: function() {},
  },
})
