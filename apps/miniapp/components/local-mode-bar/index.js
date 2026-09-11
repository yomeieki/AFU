// 同城「外送 / 自取」切换栏。主页与分类页共用，位置在页头之下、分类区之上（spec P2）。
//
// 只做两件事：画两个标签（店休而自取可预约时「自取」下多一行「可预约」），点了就把想去的模式抛给页面。
// 模式的写回、阻塞态重算、购物车条刷新都是页面的事——组件不碰 app.globalData。
var localCatalog = require('../../utils/local-catalog')

Component({
  options: { addGlobalClass: true },
  properties: {
    meta: { type: null, value: null },
    mode: { type: String, value: 'DELIVERY' },
  },
  data: {
    holiday: false,
    pickupHint: '',
  },
  observers: {
    meta: function(meta) {
      this.setData({
        holiday: !!(meta && meta.holiday),
        pickupHint: localCatalog.pickupModeHint(meta),
      })
    },
  },
  methods: {
    onTap: function(e) {
      var mode = e.currentTarget.dataset.mode
      if (mode === this.properties.mode) return
      this.triggerEvent('change', { mode: mode })
    },
  },
})
