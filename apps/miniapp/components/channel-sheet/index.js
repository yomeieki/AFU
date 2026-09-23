// 渠道切换弹层（2026-09-17 设计 N1–N3，2026-09-23 从分类页抽成组件，主页共用）。
// 只画弹层与转发点击，不读不写全局渠道——切换动作在页面里，两个页面共用同一份组件。
Component({
  options: { addGlobalClass: true },
  properties: {
    open: { type: Boolean, value: false },
    // 当前渠道 'LOCAL' | 'EXPRESS'，用来给对应选项打勾
    channel: { type: String, value: '' },
  },
  methods: {
    onPick: function (e) {
      var target = e.currentTarget.dataset.channel
      this.triggerEvent('pick', { channel: target })
    },
    onClose: function () {
      this.triggerEvent('close')
    },
    // 遮罩下的 catchtouchmove 绑定目标：不让底下的 scroll-view 跟着滚（与 sku-popup 同一套写法）
    noop: function () {},
  },
})
