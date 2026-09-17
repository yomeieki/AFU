// 自取结算页。与同城外送结算页（pages/local/confirm.js）是两套独立的状态机：
// 那边围绕「地址 → 报价凭证」，这边围绕「时段 → 手机号」，硬塞进一个页面只会互相绊。
//
// 顺序（spec §5.4）：通知 → 取餐门店 → 取餐时间 → 取餐人 → 商品 → 优惠 → 备注 → 金额 → 协议 → 底栏。
// 底部按钮只由 utils/pickup-checkout-state 的 pickupCheckoutAction 决定，页面按 action 分派。
//
// ⚠️ 新文件，保持 ES5。

var cartApi = require('../../api/cart')
var localApi = require('../../api/local')
var orderApi = require('../../api/order')
var requestSubscribe = require('../../utils/subscribe').requestSubscribe
var formatPrice = require('../../utils/format').formatPrice
var localCatalog = require('../../utils/local-catalog')
var st = require('../../utils/pickup-checkout-state')
var newClientRequestId = require('../../utils/local-checkout-state').newClientRequestId
var tableware = require('../../utils/tableware')
var app = getApp()

function selectedItems(cart, cartItemIds) {
  return (cart.items || []).filter(function(item) { return cartItemIds.indexOf(item.id) !== -1 }).map(function(item) {
    return Object.assign({}, item, { priceText: formatPrice(item.price) })
  })
}

// text 带具体日期「今天 9月12日 16:30–17:00」：顾客过了零点还停在结算页时，「今天」两个字会骗人，日期不会
function decorateSlot(slot, day) {
  if (!slot) return null
  var dateText = day.monthDay ? ' ' + day.monthDay : ''
  return { startAt: slot.startAt, endAt: slot.endAt, label: slot.label, dayLabel: day.label, text: day.label + dateText + ' ' + slot.label }
}

Page({
  data: {
    cartItemIds: [],
    items: [],
    subtotal: 0,
    meta: null,
    headNotice: '',
    blockReason: '',
    // 时段
    days: [],
    activeDay: 0,
    selected: null,       // { startAt, endAt, label, dayLabel, text }
    slotStale: false,
    slotsLoading: true,
    slotsError: '',
    hasAnySlot: false,     // 本轮时段里是否有任意一格可选（区分「还没选」与「真没时段」两种占位文案）
    pickerOpen: false,
    // 取餐人
    contactName: '',
    contactPhone: '',
    tableware: null,
    tablewareLabel: '',
    tablewareOpen: false,
    remark: '',
    // 优惠（来自 checkout-benefits）
    couponId: null,
    gifts: [],
    discount: 0,
    couponDiscount: 0,
    pointsUsed: 0,
    benefitsLoading: false,
    // 金额
    discountRule: null,
    pickupDiscount: 0,
    packingFee: 0,
    payAmount: null,
    belowMinGap: 0,
    submitting: false,
    // 首屏时段还没拉回来（slotsLoading 初值即 true），此刻不该可点
    action: { disabled: true, text: '请选择取餐时间', amountState: 'pending', action: 'none' },
    subscribeTemplateIds: [],
    payTimeoutMin: 15,
  },

  onLoad: function(options) {
    var ids = (options.cartItemIds || '').split(',').filter(Boolean).map(Number)
    // 幂等键随页面而生，整页只有这一个；只在确认下单成功后换新的（见 doSubmit）
    this._clientRequestId = newClientRequestId()
    this.setData({ cartItemIds: ids })
    this.loadAll()
    var self = this
    orderApi.getOrderMeta().then(function(meta) {
      var groups = (meta && meta.subscribeTemplates) || {}
      self.setData({
        // 自取页只请求「取餐提醒 + 退款」两个模板；老服务端没有分组时退回整份列表
        subscribeTemplateIds: (groups.pickup && groups.pickup.length ? groups.pickup : (meta && meta.subscribeTemplateIds)) || [],
        payTimeoutMin: (meta && meta.payTimeoutMin) || 15,
      })
    }).catch(function() {})
  },

  // 从别的页回来：时段可能过期、店主可能刚暂停自取——重拉时段与 meta，保留已选的格子（还在就留着）
  onShow: function() {
    if (!this._loadedOnce) return
    this.loadMeta()
    this.loadSlots()
  },

  loadAll: function() {
    var self = this
    // 预填上次餐具是静默请求（spec §5.4）：单独发、不进 Promise.all，慢了不拖住商品/地址/报价。
    // applyLastTableware 自带 _tablewareTouched 与已选值两道守卫，晚回来也不会冲掉顾客自己选的
    orderApi.getLastTableware().then(function(v) { self.applyLastTableware(v) }).catch(function() {})
    Promise.all([
      cartApi.getCart('LOCAL'),
      localApi.getLocalMeta().catch(function() { return null }),
      orderApi.getPickupContact().catch(function() { return null }),
    ]).then(function(results) {
      var items = selectedItems(results[0] || {}, self.data.cartItemIds)
      var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
      var contact = results[2] || {}
      self.setData({
        items: items,
        subtotal: subtotal,
        contactName: contact.name || '',
        contactPhone: contact.phone || '',
      })
      self.applyMeta(results[1])
      self._loadedOnce = true
      self.loadSlots()
    }).catch(function() {
      self.setData({ blockReason: '商品信息加载失败，请返回同城菜单重试', payAmount: null })
      self.recompute()
    })
  },

  loadMeta: function() {
    var self = this
    localApi.getLocalMeta().then(function(meta) { self.applyMeta(meta) }).catch(function() {})
  },

  applyMeta: function(meta) {
    var notice = localCatalog.headNoticeOf(meta, 'PICKUP')
    this.setData({
      meta: meta,
      headNotice: notice.text,
      blockReason: notice.blocking ? notice.text : '',
      discountRule: meta && meta.pickup ? meta.pickup.discount : null,
    })
    this.recompute()
  },

  // 已有选择就只判它还在不在（不覆盖），没有选择才自动选第一格
  loadSlots: function() {
    var self = this
    var seq = (this._slotSeq = (this._slotSeq || 0) + 1)
    this.setData({ slotsLoading: true, slotsError: '' })
    localApi.getPickupSlots()
      .then(function(view) {
        if (seq !== self._slotSeq) return
        var days = (view.days || []).map(function(d) {
          var dt = st.pickupDateText(d.date)
          return { date: d.date, label: d.label, monthDay: dt.monthDay, dateText: dt.monthDay + ' ' + dt.weekday, slots: d.slots || [], empty: !(d.slots && d.slots.length) }
        })
        var hasAnySlot = false
        for (var i = 0; i < days.length; i++) {
          if (!days[i].empty) { hasAnySlot = true; break }
        }
        var patch = { days: days, slotsLoading: false, hasAnySlot: hasAnySlot }
        var blocked = !!view.blocked
        if (blocked) {
          // 服务端说这会儿不能自取（休业/暂停/未开通）：清选择、阻塞提交，文案用它给的
          patch.selected = null
          patch.slotStale = false
          patch.blockReason = view.blocked.text || '暂不可自取'
          patch.headNotice = view.blocked.text || ''
        } else if (self.data.selected) {
          // 已有选择就只判它还在不在，不覆盖——别盖掉顾客在请求在途时刚点的格；
          // 不在了标 stale，按钮变成「重新选择时间」
          patch.slotStale = !st.slotOffered(view, self.data.selected.startAt)
          patch.blockReason = ''
          patch.activeDay = Math.min(self.data.activeDay || 0, Math.max(0, days.length - 1))
        } else {
          // 2026-09-17 起不再自动预选第一个时段：进页/弹层要停在空态，顾客自己点。
          // patch.selected 保持 null——不要把这行改回 decorateSlot(first.slot, ...)，
          // 那等于撤销整个「顾客自己选」的需求（护栏见 tests/miniapp/pickup-page.test.cjs）。
          // activeDay 仍落到第一个有时段的那天，省得顾客打开弹层还要自己翻页。
          var first = st.firstSlot(view)
          patch.selected = null
          patch.activeDay = first ? first.dayIndex : 0
          patch.slotStale = false
          patch.blockReason = ''
        }
        self.setData(patch)
        self.recompute()
        // 从 blocked 恢复为可用：让页头通知按最新 meta 重算（applyMeta 若仍阻塞会重新写回 blockReason）
        if (!blocked) self.loadMeta()
      })
      .catch(function(err) {
        if (seq !== self._slotSeq) return
        self.setData({ slotsLoading: false, slotsError: (err && err.message) || '取餐时段获取失败', hasAnySlot: false })
        self.recompute()
      })
  },

  /**
   * 金额与按钮的唯一重算点。每一处改变 blockReason / selected / slotStale / contactPhone /
   * discount / benefitsLoading / submitting 的地方都要跟着调一次。
   */
  recompute: function() {
    var d = this.data
    // 打包费不再额外接一道 meta.packing.enabled 的门：总开关关闭时服务端下发的
    // items[].packingFeeEach 本就恒为 0，与 calcPackingFee 同一口径。meta 可能还没
    // 拉到（loadAll 里 getLocalMeta 失败会退成 null）时若在这里另判 enabled，
    // 会把这一项硬压成 0，而 items 里的 packingFeeEach 其实是非 0 的，导致顾客看到的
    // 应付比微信实扣少一笔打包费。
    var packingFee = st.packingFeeOf(d.items)
    var amounts = st.computePickupPay(d.subtotal, d.discountRule, d.discount, packingFee)
    var gap = Math.max(0, localCatalog.minOrderOf(d.meta, 'PICKUP') - d.subtotal)
    var payAmount = d.items.length ? amounts.payAmount : null
    this.setData({
      pickupDiscount: amounts.pickupDiscount,
      couponDiscount: amounts.couponDiscount,
      packingFee: amounts.packingFee,
      payAmount: payAmount,
      belowMinGap: gap,
      action: st.pickupCheckoutAction({
        blockReason: d.blockReason,
        slotsLoading: d.slotsLoading,
        slotsError: !!d.slotsError,
        noSlots: !d.slotsLoading && !d.slotsError && !d.hasAnySlot,
        hasSlot: !!d.selected,
        slotStale: d.slotStale,
        phoneValid: st.isValidPhone(d.contactPhone),
        belowMinGap: gap,
        payAmount: payAmount,
        hasTableware: !!d.tableware,
        benefitsLoading: d.benefitsLoading,
        submitting: d.submitting,
      }),
    })
  },

  // ── 时段选择器 ──────────────────────────────────────────────
  openPicker: function() {
    if (this.data.blockReason || this.data.slotsLoading || this.data.slotsError) return
    this.setData({ pickerOpen: true })
  },
  closePicker: function() {
    this.setData({ pickerOpen: false })
  },
  noop: function() {},
  onRetrySlots: function() {
    this.loadSlots()
  },
  selectDay: function(e) {
    this.setData({ activeDay: Number(e.currentTarget.dataset.idx) || 0 })
  },
  selectSlot: function(e) {
    var idx = Number(e.currentTarget.dataset.idx)
    var day = this.data.days[this.data.activeDay]
    var slot = day && day.slots[idx]
    if (!slot) return
    this.setData({ selected: decorateSlot(slot, day), slotStale: false, pickerOpen: false })
    // 换了时段就是另一张单：超时重试的幂等只该在同一时段内成立
    this._clientRequestId = newClientRequestId()
    this.recompute()
  },

  // ── 取餐人 / 备注 ──────────────────────────────────────────
  onNameInput: function(e) {
    this.setData({ contactName: e.detail.value })
  },
  onPhoneInput: function(e) {
    this.setData({ contactPhone: e.detail.value })
    this.recompute()
  },
  onRemarkInput: function(e) {
    this.setData({ remark: e.detail.value })
  },

  openTableware: function() { this.setData({ tablewareOpen: true }) },
  closeTableware: function() { this.setData({ tablewareOpen: false }) },
  // 顾客在弹层里确定的选择。_tablewareTouched 挡住「预填请求比顾客手慢」时把顾客刚选的值冲掉
  onTablewareConfirm: function(e) {
    var v = tableware.normalizeTableware(e.detail)
    if (!v) return
    this._tablewareTouched = true
    this.setData({ tableware: v, tablewareLabel: tableware.tablewareLabel(v.mode, v.count), tablewareOpen: false })
    this.recompute()
  },
  applyLastTableware: function(raw) {
    var v = tableware.normalizeTableware(raw)
    if (!v || this._tablewareTouched || this.data.tableware) return
    this.setData({ tableware: v, tablewareLabel: tableware.tablewareLabel(v.mode, v.count) })
    this.recompute()
  },

  // ── 商品数量（与同城结算页同款） ─────────────────────────────
  reloadCart: function() {
    var self = this
    return cartApi.getCart('LOCAL').then(function(cart) {
      var items = selectedItems(cart || {}, self.data.cartItemIds)
      var subtotal = items.reduce(function(sum, item) { return sum + item.subtotal }, 0)
      self.setData({ items: items, subtotal: subtotal })
      self.recompute()
    })
  },
  onDecrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(row) { return row.id === id })
    if (!item || item.quantity <= 1 || this._cartMutating) return
    this.updateQuantity(id, item.quantity - 1)
  },
  onIncrease: function(e) {
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(row) { return row.id === id })
    if (!item || this._cartMutating) return
    this.updateQuantity(id, item.quantity + 1)
  },
  updateQuantity: function(id, quantity) {
    var self = this
    this._cartMutating = true
    cartApi.updateCartItem(id, { quantity: quantity })
      .then(function() { return self.reloadCart() })
      .then(function() { self._cartMutating = false })
      .catch(function() { self._cartMutating = false })
  },
  onDelete: function(e) {
    if (this._cartMutating) return
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: function(result) {
        if (!result.confirm) return
        self._cartMutating = true
        cartApi.deleteCartItem(id)
          .then(function() {
            self.setData({ cartItemIds: self.data.cartItemIds.filter(function(itemId) { return itemId !== id }) })
            return self.reloadCart()
          })
          .then(function() { self._cartMutating = false })
          .catch(function() { self._cartMutating = false })
      },
    })
  },

  // 优惠组件回传：discount 是服务端算好的券抵扣额；封顶到「小计−自取优惠」在 recompute 里做
  onBenefitsChange: function(e) {
    var d = e.detail || {}
    this.setData({
      couponId: d.couponId === undefined ? null : d.couponId,
      gifts: d.gifts || [],
      discount: d.discount || 0,
      pointsUsed: d.pointsUsed || 0,
      benefitsLoading: !!d.loading,
    })
    this.recompute()
  },

  // ── 出路 ───────────────────────────────────────────────────
  goDelivery: function() {
    app.setLocalMode('DELIVERY')
    wx.navigateBack()
  },
  goExpress: function() {
    app.setShoppingChannel('EXPRESS')
    wx.switchTab({ url: '/pages/index/index' })
  },
  contactShop: function() {
    var phone = this.data.meta && this.data.meta.store && this.data.meta.store.phone
    if (!phone) { wx.showToast({ title: '商家电话暂未设置', icon: 'none' }); return }
    wx.makePhoneCall({ phoneNumber: phone })
  },
  openStore: function() {
    var s = this.data.meta && this.data.meta.store
    if (!s || s.latE6 == null || s.lngE6 == null) return
    wx.openLocation({ latitude: s.latE6 / 1e6, longitude: s.lngE6 / 1e6, name: s.name || '门店', address: (s.district || '') + (s.address || '') })
  },
  goLegal: function(e) {
    wx.navigateTo({ url: '/pages/legal/index?type=' + e.currentTarget.dataset.type })
  },

  // ── 提交 ───────────────────────────────────────────────────
  onSubmit: function() {
    var act = this.data.action || {}
    var self = this
    if (act.action === 'slot') {
      this.openPicker()
      return
    }
    if (act.action === 'tableware') {
      this.openTableware()
      return
    }
    if (act.action === 'reslot') {
      this.setData({ selected: null, slotStale: false, pickerOpen: true })
      this.recompute()
      this.loadSlots()
      return
    }
    if (act.disabled || act.action !== 'submit') return
    requestSubscribe(this.data.subscribeTemplateIds, function() { self.doSubmit() })
  },

  doSubmit: function() {
    if (this.data.submitting || !this.data.selected || this.data.slotStale || !this.data.tableware || !this.data.action || this.data.action.action !== 'submit' || this.data.action.disabled) return
    this.setData({ submitting: true })
    this.recompute()
    var self = this
    var name = (this.data.contactName || '').trim()
    orderApi.createOrder({
      cartItemIds: this.data.cartItemIds,
      deliveryType: 'PICKUP',
      pickupAt: this.data.selected.startAt,
      pickupContact: name ? { name: name.slice(0, 32), phone: this.data.contactPhone.trim() } : { phone: this.data.contactPhone.trim() },
      remark: this.data.remark ? this.data.remark.slice(0, 20) : undefined,
      tableware: this.data.tableware,
      couponId: this.data.couponId || undefined,
      gifts: this.data.gifts && this.data.gifts.length ? this.data.gifts : undefined,
      // 幂等键。失败时故意不换：超时那一类失败服务端可能已建单，再按一次带同一个 id 就拿回那张单
      clientRequestId: this._clientRequestId,
    }, true)
      .then(function(res) {
        self._clientRequestId = newClientRequestId()
        wx.showToast({ title: '下单成功，请在 ' + self.data.payTimeoutMin + ' 分钟内完成支付', icon: 'none', duration: 1500 })
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId + '&autopay=1' })
        }, 800)
      })
      .catch(function(err) {
        self.setData({ submitting: false })
        self.recompute()
        self.handleSubmitError(err)
      })
  },

  handleSubmitError: function(err) {
    var code = err.code
    // 商品问题：刷车让顾客看到真实库存/在售状态
    if (code === 42201 || code === 42202 || code === 42224) {
      wx.showToast({ title: err.message || '商品信息已变化，请确认后重试', icon: 'none', duration: 2500 })
      this.reloadCart().catch(function() {})
      return
    }
    // 优惠项在别处变了：只刷组件
    if (code === 42250 || code === 42251 || code === 42252 || code === 42253 || code === 42254) {
      wx.showToast({ title: err.message || '优惠已变化，请重新选择', icon: 'none', duration: 2500 })
      var benefits = this.selectComponent('#benefits')
      if (benefits) benefits.refresh()
      return
    }
    // 42281 时段不可选：重拉时段、清选择、打开选择器让顾客重选
    if (code === 42281) {
      wx.showToast({ title: err.message || '该时段已不可选，请重新选择', icon: 'none', duration: 2500 })
      this.setData({ selected: null, slotStale: false })
      this.recompute()
      this.loadSlots()
      this.setData({ pickerOpen: true })
      return
    }
    // 42280 自取不可用 / 42282 门槛：刷 meta，按钮按最新状态变
    if (code === 42280 || code === 42282) {
      wx.showToast({ title: err.message, icon: 'none', duration: 3000 })
      this.loadMeta()
      return
    }
    wx.showToast({ title: err.message || '下单失败，请重试', icon: 'none', duration: 2500 })
  },
})
