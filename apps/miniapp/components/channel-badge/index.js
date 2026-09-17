// 渠道标识（2026-09-17 设计 N1–N3）。分类页两侧各放一枚：同城在门店头第一行右端，邮寄在搜索框那一行右端。
// 组件只负责长相与「被点了」，不读不写全局渠道——切换动作在页面里，两侧共用一个弹层。
Component({
  options: { addGlobalClass: true },
  properties: {
    channel: { type: String, value: 'EXPRESS' },
  },
  data: { label: '全国邮寄' },
  observers: {
    channel: function(channel) {
      this.setData({ label: channel === 'LOCAL' ? '同城配送' : '全国邮寄' })
    },
  },
  methods: {
    onTap: function() { this.triggerEvent('switch') },
  },
})
