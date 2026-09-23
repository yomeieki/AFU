// 时段弹层（今天/明天页签 + 格子）。自取与预约外送共用；无状态，选择权在页面。
Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '选择取餐时间' },
    days: { type: Array, value: [] },
    activeDay: { type: Number, value: 0 },
    selectedStartAt: { type: String, value: '' },
    // M10（复审建议，纳入本批）：自取与外送（同城预约送达）共用这个组件，
    // 但外送说「取」不通顺——「无可取时段」是自取页的用词。默认值保持自取页
    // 原文案不变，外送页（confirm.wxml）显式传「无可选时段」（店主决定 D4）。
    emptyLabel: { type: String, value: '无可取时段' },
    dayEmptyLabel: { type: String, value: '这一天已无可取时段' },
  },
  methods: {
    noop: function() {},
    onClose: function() { this.triggerEvent('close') },
    onDay: function(e) { this.triggerEvent('daychange', { idx: Number(e.currentTarget.dataset.idx) || 0 }) },
    onSlot: function(e) { this.triggerEvent('select', { idx: Number(e.currentTarget.dataset.idx) }) },
  },
})
