// 时段弹层（今天/明天页签 + 格子）。自取与预约外送共用；无状态，选择权在页面。
Component({
  options: { addGlobalClass: true },
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '选择取餐时间' },
    days: { type: Array, value: [] },
    activeDay: { type: Number, value: 0 },
    selectedStartAt: { type: String, value: '' },
  },
  methods: {
    noop: function() {},
    onClose: function() { this.triggerEvent('close') },
    onDay: function(e) { this.triggerEvent('daychange', { idx: Number(e.currentTarget.dataset.idx) || 0 }) },
    onSlot: function(e) { this.triggerEvent('select', { idx: Number(e.currentTarget.dataset.idx) }) },
  },
})
