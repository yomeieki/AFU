// 餐具选择弹层（餐具设计 §5.2）。两个结算页共用；只管弹层内的草稿，确定时把 { mode, count? } 抛给页面。
var tw = require('../../utils/tableware')

Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false },
    value: { type: null, value: null },
  },
  data: { needChoice: '', qtyMode: 'BY_MEAL', count: 1, max: tw.MAX },
  observers: {
    show: function(show) {
      if (!show) return
      // 每次打开都从页面当前值重建草稿：上次没点确定就关掉的改动不应残留
      var v = tw.normalizeTableware(this.properties.value)
      this.setData({
        needChoice: !v ? '' : (v.mode === 'NONE' ? 'NONE' : 'NEED'),
        qtyMode: v && v.mode === 'COUNT' ? 'COUNT' : 'BY_MEAL',
        count: v && v.mode === 'COUNT' ? v.count : 1,
      })
    },
  },
  methods: {
    noop: function() {},
    onClose: function() { this.triggerEvent('close') },
    onPickNeed: function() { this.setData({ needChoice: 'NEED' }) },
    onPickNone: function() { this.setData({ needChoice: 'NONE' }) },
    onPickByMeal: function() { this.setData({ qtyMode: 'BY_MEAL' }) },
    // 点步进器即切到指定份数；第一次点只切换不加减，免得顾客以为「按餐量」被悄悄改成了 2 份
    onMinus: function() {
      if (this.data.qtyMode !== 'COUNT') return this.setData({ qtyMode: 'COUNT' })
      this.setData({ count: tw.stepCount(this.data.count, -1) })
    },
    onPlus: function() {
      if (this.data.qtyMode !== 'COUNT') return this.setData({ qtyMode: 'COUNT' })
      this.setData({ count: tw.stepCount(this.data.count, 1) })
    },
    onConfirm: function() {
      var d = this.data
      if (!d.needChoice) return
      var value = d.needChoice === 'NONE' ? { mode: 'NONE' }
        : d.qtyMode === 'COUNT' ? { mode: 'COUNT', count: d.count } : { mode: 'BY_MEAL' }
      this.triggerEvent('confirm', value)
    },
  },
})
