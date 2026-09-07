// 同城门店头。主页用完整版（店名 + 状态 + 配送规则 + 阻塞通知），
// 分类页用紧凑版（compact，只留第一行），两页共用同一份状态判定与同一套排版规则。
//
// 存在的理由是排版而不只是复用：原来这一行是 `justify-content: space-between`，
// 中间还挂着一个「我的订单 ›」。店名一长，space-between 会把状态胶囊推到远处、
// 并把它压扁——绿色底色跟着文字一起被截断，看起来像渲染坏了。
// 规格 §4.1 因此钉死了三条：整行左对齐、店名可收缩可省略、胶囊不可收缩不换行。

var localCatalog = require('../../utils/local-catalog')

Component({
  options: {
    // 让外部传进来的 class 能作用到组件根节点，两个页面各自微调间距
    addGlobalClass: true,
  },
  properties: {
    meta: { type: null, value: null },
    // 紧凑版：只画第一行（图标 + 店名 + 状态），不画配送规则与通知
    compact: { type: Boolean, value: false },
  },
  data: {
    tone: 'closed',
    label: '暂未营业',
    notice: '',
    rulesText: '',
  },
  observers: {
    meta: function(meta) {
      var status = localCatalog.storeStatusOf(meta)
      this.setData({
        tone: status.tone,
        label: status.label,
        notice: localCatalog.headNoticeOf(meta).text,
        rulesText: this.buildRules(meta),
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
    onGoExpress: function() {
      this.triggerEvent('goexpress')
    },
  },
})
