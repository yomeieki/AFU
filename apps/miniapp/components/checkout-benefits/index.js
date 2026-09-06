var member = require('../../api/member')

/**
 * 结算页优惠组件：选券 + 用积分加购随单赠品。邮寄与同城两个结算页共用。
 *
 * ── 与父页的契约（父页只认这四个值，不看组件内部）──────────────────────
 *
 *   bind:change → { couponId, gifts, discount, pointsUsed }
 *
 * `discount` **一律是服务端算好的 `coupons[].discount`**，组件不自己算
 * `min(面额, 小计)`（spec §6）。这条不是洁癖：封顶规则、门槛判定、渠道判定
 * 都在服务端的 `checkCouponUsable` 里，前端复制一份就等于承诺两边永远同步——
 * 而门槛比的是券前小计、封顶到小计这些细节，抄错一处就是每单都算错钱。
 *
 * ── 失败时必须把选择清空 ───────────────────────────────────────────
 *
 * 拉不到优惠项时不能让父页带着上一次的 `couponId` 去提交：那张券可能已经被
 * 别处用掉了，服务端会拒（42251），顾客看到的是一个莫名其妙的下单失败。
 * 所以 `failed` 分支要主动 emit 一次全 0。
 */
Component({
  properties: {
    channel: { type: String, value: 'EXPRESS' },
    // 券前商品小计（分）。父页金额变了要重新拉——门槛与封顶都依赖它
    subtotal: { type: Number, value: 0 },
    /**
     * 运费/配送费（分）。**只用于「预计得分」那一行**，不参与选券与门槛判定。
     *
     * 必须由父页传进来：服务端发分走 `calcEarn(order.actualAmount, …)`，而 actualAmount
     * **含运费**（docs/member-terms-copy.md 明写「实付金额包含运费」）。组件若只按
     * `subtotal − discount` 估算，就会比实际到账少「运费元数 × rate」——
     * 邮寄单未过包邮线时差一截，同城单配送费恒 > 0，**每一单都对不上**。
     * 父页拿不到运费时传 0，此时估算偏低但不会偏高（宁可少说，不要许多）。
     */
    shippingFee: { type: Number, value: 0 },
    // 父页在提交中 / 报价中时置 true，整卡不可点
    disabled: { type: Boolean, value: false },
  },

  data: {
    state: 'loading', // loading | ready | failed | empty
    pointsBalance: 0,
    pointsEnabled: false,
    earnRatePerYuan: 0,
    coupons: [],
    gifts: [],
    selectedCouponId: null,
    selectedCouponName: '',
    discount: 0,
    pointsUsed: 0,
    // { pointsGoodId: quantity }，只存非 0 的
    giftQty: {},
    pickerOpen: false,
    usableCount: 0,
    discountText: '',
    earnText: '',
  },

  observers: {
    'channel, subtotal': function () {
      this._scheduleLoad()
    },
    // 运费变了不用重新拉优惠项（它不参与选券），但「预计得分」要跟着重算
    shippingFee: function () {
      if (this.data.state === 'ready' || this.data.state === 'empty') this._emit()
    },
  },

  lifetimes: {
    attached: function () {
      this._scheduleLoad()
    },
    detached: function () {
      if (this._timer) clearTimeout(this._timer)
    },
  },

  methods: {
    /** 父页在 4225x 之后调：立刻重拉，不走防抖 */
    refresh: function () {
      this._load()
    },

    /**
     * 防抖 300ms。购物车页改数量后返回会连着触发几次 subtotal 变化，
     * 每次都打一发请求既浪费也会让画面闪。
     */
    _scheduleLoad: function () {
      var self = this
      if (this._timer) clearTimeout(this._timer)
      this._timer = setTimeout(function () {
        self._timer = null
        self._load()
      }, 300)
    },

    _load: function () {
      var self = this
      var subtotal = this.data.subtotal
      // 小计为 0（购物车空 / 父页还没算出来）时不请求：服务端要拿它判门槛，传 0 没有意义
      if (!subtotal || subtotal <= 0) {
        this.setData({ state: 'empty', coupons: [], gifts: [] })
        this._reset()
        return
      }
      // 并发防串：只认最后一次发出的请求的结果，否则慢的那发会盖掉快的
      var seq = (this._seq || 0) + 1
      this._seq = seq
      this.setData({ state: 'loading' })
      member
        .getCheckoutOptions(this.properties.channel, subtotal, true)
        .then(function (d) {
          if (self._seq !== seq) return
          self._apply(d)
        })
        .catch(function () {
          if (self._seq !== seq) return
          self.setData({ state: 'failed', coupons: [], gifts: [] })
          // 关键：清空并通知父页。留着旧的 couponId 会让下单撞 42251
          self._reset()
        })
    },

    _apply: function (d) {
      var coupons = d.coupons || []
      var gifts = d.gifts || []
      if (!coupons.length && !gifts.length) {
        this.setData({
          state: 'empty',
          coupons: [],
          gifts: [],
          pointsBalance: d.pointsBalance || 0,
          pointsEnabled: !!(d.points && d.points.enabled),
          earnRatePerYuan: (d.points && d.points.earnRatePerYuan) || 0,
        })
        this._reset()
        return
      }

      // 券的展示文案在 js 里拼好，wxml 只管显示（wxml 里做不了这种分支拼接）
      var i
      for (i = 0; i < coupons.length; i++) {
        var c = coupons[i]
        c.amountText = yuan(c.amount)
        c.thresholdText = c.threshold > 0 ? '满 ¥' + yuan(c.threshold) + ' 可用' : '无门槛'
        c.channelText = c.channel === 'LOCAL' ? '同城专享' : c.channel === 'EXPRESS' ? '邮寄专享' : ''
        c.expiresText = fmtDate(c.expiresAt)
        c.discountText = c.usable ? yuan(c.discount) : ''
      }
      for (i = 0; i < gifts.length; i++) {
        gifts[i].qty = this.data.giftQty[gifts[i].id] || 0
      }

      var usable = 0
      for (i = 0; i < coupons.length; i++) if (coupons[i].usable) usable++

      // 保留原选择：subtotal 变了以后这张券可能已经不可用（掉到门槛以下）。
      // 不可用就取消并明确告诉顾客，不能静默留着一个已经不算数的选择。
      var keep = null
      if (this.data.selectedCouponId !== null) {
        for (i = 0; i < coupons.length; i++) {
          if (coupons[i].id === this.data.selectedCouponId && coupons[i].usable) {
            keep = coupons[i]
            break
          }
        }
        if (!keep) {
          wx.showToast({ title: '已取消不可用的优惠券', icon: 'none' })
        }
      } else if (!this._userTouchedCoupon) {
        // 默认自动选最优的一张（M4 D2 默认）。服务端已按「可用在前、discount 大在前」
        // 排好序，取第一张 usable 的即可，不在前端重排。
        // `_userTouchedCoupon` 保证顾客一旦手动选过「不使用」，重新拉取时不会被又自动选上。
        for (i = 0; i < coupons.length; i++) {
          if (coupons[i].usable) {
            keep = coupons[i]
            break
          }
        }
      }

      // 赠品数量按新的上限重新夹一遍：库存/名额/每单限购都可能已经变小
      var qty = {}
      for (i = 0; i < gifts.length; i++) {
        var g = gifts[i]
        var want = this.data.giftQty[g.id] || 0
        var max = this._maxQty(g)
        var got = want > max ? max : want
        if (got > 0) qty[g.id] = got
        g.qty = got
      }

      this.setData({
        state: 'ready',
        coupons: coupons,
        gifts: gifts,
        pointsBalance: d.pointsBalance || 0,
        pointsEnabled: !!(d.points && d.points.enabled),
        earnRatePerYuan: (d.points && d.points.earnRatePerYuan) || 0,
        usableCount: usable,
        selectedCouponId: keep ? keep.id : null,
        selectedCouponName: keep ? keep.name : '',
        giftQty: qty,
      })
      this._emit()
    },

    /** 这件赠品最多能加几件：每单限购 / 兑换名额 / 真实库存 三者取小 */
    _maxQty: function (g) {
      var max = g.perOrderLimit
      if (g.remaining !== null && g.remaining !== undefined && g.remaining < max) max = g.remaining
      if (g.stock !== null && g.stock !== undefined && g.stock < max) max = g.stock
      return max > 0 ? max : 0
    },

    _reset: function () {
      this.setData({
        selectedCouponId: null,
        selectedCouponName: '',
        giftQty: {},
        discount: 0,
        pointsUsed: 0,
        discountText: '',
        earnText: '',
      })
      this._emit()
    },

    /** 重算 discount / pointsUsed 并把四个值抛给父页。**唯一的 emit 出口。** */
    _emit: function () {
      var i
      var discount = 0
      var sel = null
      for (i = 0; i < this.data.coupons.length; i++) {
        if (this.data.coupons[i].id === this.data.selectedCouponId) {
          sel = this.data.coupons[i]
          break
        }
      }
      // discount 只从服务端给的值取；取不到就是 0，绝不本地推算
      if (sel && sel.usable) discount = sel.discount || 0

      var gifts = []
      var pointsUsed = 0
      for (i = 0; i < this.data.gifts.length; i++) {
        var g = this.data.gifts[i]
        var q = this.data.giftQty[g.id] || 0
        if (q > 0) {
          gifts.push({ pointsGoodId: g.id, quantity: q })
          pointsUsed += g.pointsCost * q
        }
      }

      // 「预计得 N 分」：口径必须与服务端 calcEarn 一致 ——
      //   服务端：floor(actualAmount / 100) × rate，其中 actualAmount = 小计 − 券 + 运费
      // 少加运费就会比实际到账少「运费元数 × rate」（同城单配送费恒 > 0，每单都错）。
      // 文案带「预计」是必须的：真实得分在订单**完成**时才结算，中间还可能退款按比例扣回。
      var earnText = ''
      if (this.data.pointsEnabled && this.data.earnRatePerYuan > 0) {
        var payFen = this.data.subtotal - discount + (this.properties.shippingFee || 0)
        if (payFen < 0) payFen = 0
        var earn = Math.floor(payFen / 100) * this.data.earnRatePerYuan
        if (earn > 0) earnText = '预计获得 ' + earn + ' 积分'
      }

      this.setData({
        discount: discount,
        pointsUsed: pointsUsed,
        discountText: discount > 0 ? yuan(discount) : '',
        earnText: earnText,
      })
      this.triggerEvent('change', {
        couponId: this.data.selectedCouponId,
        gifts: gifts,
        discount: discount,
        pointsUsed: pointsUsed,
      })
    },

    onOpenPicker: function () {
      if (this.properties.disabled || this.data.state !== 'ready') return
      this.setData({ pickerOpen: true })
    },
    onClosePicker: function () {
      this.setData({ pickerOpen: false })
    },
    // 阻止弹层内部的点击冒泡到遮罩把弹层关掉
    onStopPropagation: function () {},

    onPickCoupon: function (e) {
      var id = e.currentTarget.dataset.id
      var i
      for (i = 0; i < this.data.coupons.length; i++) {
        if (this.data.coupons[i].id === id && !this.data.coupons[i].usable) return // 不可用的点了没反应
      }
      this._userTouchedCoupon = true
      var name = ''
      for (i = 0; i < this.data.coupons.length; i++) {
        if (this.data.coupons[i].id === id) name = this.data.coupons[i].name
      }
      this.setData({ selectedCouponId: id, selectedCouponName: name, pickerOpen: false })
      this._emit()
    },

    onClearCoupon: function () {
      this._userTouchedCoupon = true
      this.setData({ selectedCouponId: null, selectedCouponName: '', pickerOpen: false })
      this._emit()
    },

    onGiftPlus: function (e) {
      if (this.properties.disabled) return
      var id = e.currentTarget.dataset.id
      var i
      var g = null
      for (i = 0; i < this.data.gifts.length; i++) if (this.data.gifts[i].id === id) g = this.data.gifts[i]
      if (!g) return
      var cur = this.data.giftQty[id] || 0
      if (cur >= this._maxQty(g)) return
      // 积分不够就别让加：加了也会在下单时被服务端拒（42250），不如当场说清楚
      if (this.data.pointsUsed + g.pointsCost > this.data.pointsBalance) {
        wx.showToast({ title: '积分不足', icon: 'none' })
        return
      }
      this._setQty(id, cur + 1)
    },

    onGiftMinus: function (e) {
      if (this.properties.disabled) return
      var id = e.currentTarget.dataset.id
      var cur = this.data.giftQty[id] || 0
      if (cur <= 0) return
      this._setQty(id, cur - 1)
    },

    _setQty: function (id, n) {
      var qty = {}
      var k
      for (k in this.data.giftQty) if (this.data.giftQty.hasOwnProperty(k)) qty[k] = this.data.giftQty[k]
      if (n > 0) qty[id] = n
      else delete qty[id]

      var gifts = this.data.gifts
      var i
      for (i = 0; i < gifts.length; i++) gifts[i].qty = qty[gifts[i].id] || 0

      this.setData({ giftQty: qty, gifts: gifts })
      this._emit()
    },

    onRetry: function () {
      this._load()
    },
  },
})

function yuan(fen) {
  return ((fen || 0) / 100).toFixed(2)
}

function fmtDate(v) {
  if (!v) return ''
  var s = '' + v
  // 服务端给的是 ISO 串。只取日期部分，不 new Date——iOS 对某些格式解析会 NaN
  var i = s.indexOf('T')
  return i === -1 ? s : s.substring(0, i)
}
