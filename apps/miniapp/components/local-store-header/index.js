// 同城门店头。主页用完整版（店名 + 状态 + 规则行 + 通知），分类页用紧凑版（compact，只留第一行），
// 两页共用同一份状态判定与同一套排版规则。
//
// 存在的理由是排版而不只是复用：原来这一行是 `justify-content: space-between`，
// 中间还挂着一个「我的订单 ›」。店名一长，space-between 会把状态胶囊推到远处、
// 并把它压扁——绿色底色跟着文字一起被截断，看起来像渲染坏了。
// 规格 §4.1 因此钉死了三条：整行左对齐、店名可收缩可省略、胶囊不可收缩不换行。
//
// 2026-09-11 起按同城子模式（外送 / 自取）切换胶囊、规则行与通知；切换控件本身不在这里，
// 在独立的 local-mode-bar 组件（页头之下、分类区之上）。

var localCatalog = require('../../utils/local-catalog')

Component({
  options: {
    // 让外部传进来的 class 能作用到组件根节点，两个页面各自微调间距
    addGlobalClass: true,
  },
  properties: {
    meta: { type: null, value: null },
    // 紧凑版：只画第一行（图标 + 店名 + 状态），不画规则行与通知
    compact: { type: Boolean, value: false },
    // 同城子模式 'DELIVERY' | 'PICKUP'
    mode: { type: String, value: 'DELIVERY' },
  },
  data: {
    tone: 'closed',
    label: '暂未营业',
    notice: '',
    noticeBlocking: false,
    rulesText: '',
    // 通知里的出路：另一侧可用就「改用自取/改用外送」，否则「去全国邮寄」
    altMode: '',
    altLabel: '去全国邮寄',
    // 自取模式且门店有坐标：规则行可点，打开地图导航
    canNavigate: false,
  },
  observers: {
    'meta, mode': function(meta, mode) {
      var status = localCatalog.storeStatusOf(meta, mode)
      var notice = localCatalog.headNoticeOf(meta, mode)
      var alt = notice.blocking ? localCatalog.altModeOf(meta, mode) : null
      var store = meta && meta.store
      this.setData({
        tone: status.tone,
        label: status.label,
        notice: notice.text,
        noticeBlocking: notice.blocking,
        rulesText: mode === 'PICKUP' ? localCatalog.pickupRulesText(meta) : this.buildRules(meta),
        altMode: alt || '',
        altLabel: alt === 'PICKUP' ? '改用自取' : alt === 'DELIVERY' ? '改用外送' : '去全国邮寄',
        canNavigate: mode === 'PICKUP' && !!(store && store.latE6 != null && store.lngE6 != null),
      })
    },
  },
  methods: {
    // 「配送范围 10 km · 满 ¥40 起送 · 基础运费 ¥6 起」。
    // 三段都缺时返回空串——宁可不画这一行，也不要画出「配送范围 undefined km」。
    buildRules: function(meta) {
      if (!meta || !meta.fee) return ''
      var parts = []
      if (meta.radiusKm) parts.push('配送范围 ' + meta.radiusKm + ' km')
      if (meta.fee.minOrderAmount) parts.push('满 ¥' + (meta.fee.minOrderAmount / 100).toFixed(2).replace(/\.00$/, '') + ' 起送')
      if (meta.fee.baseFee) parts.push('基础运费 ¥' + (meta.fee.baseFee / 100).toFixed(2).replace(/\.00$/, '') + ' 起')
      return parts.join(' · ')
    },
    // 通知里的出路按钮：另一侧可用 → 页面切模式；都不可用 → 页面切去邮寄
    onAction: function() {
      if (this.data.altMode) this.triggerEvent('switchmode', { mode: this.data.altMode })
      else this.triggerEvent('goexpress')
    },
    onGoExpress: function() {
      this.triggerEvent('goexpress')
    },
    // 自取规则行的「›」：打开地图导航到门店。没坐标就不可点（canNavigate=false，wxml 不渲染箭头）
    onOpenStore: function() {
      var store = this.properties.meta && this.properties.meta.store
      if (!this.data.canNavigate || !store) return
      wx.openLocation({
        latitude: store.latE6 / 1e6,
        longitude: store.lngE6 / 1e6,
        name: store.name || '门店',
        address: (store.district || '') + (store.address || ''),
      })
    },
  },
})
