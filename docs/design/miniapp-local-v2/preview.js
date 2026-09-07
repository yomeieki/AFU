/* 小程序双渠道导航与同城结算 —— 独立视觉预览
 *
 * 这是给店主看的**静态预览**，不接任何接口、不改任何业务代码。
 * 它对应 docs/superpowers/plans/2026-09-07-miniapp-dual-channel-navigation-checkout.md 的 Task 1。
 *
 * 唯一有「契约」意义的是下面的 checkoutAction()。
 * ⚠️ Task 2 之后，它的**权威实现已经落在 `apps/miniapp/utils/local-checkout-state.js`**，
 * 由 `tests/miniapp/local-checkout-state.test.cjs` 锁住。这里这一份是给预览用的副本，
 * 改规则要两边一起改——预览是浏览器脚本、模块是 CommonJS，暂时没法直接复用同一个文件。
 *
 * 本文件是浏览器脚本，可以用 ES6；apps/miniapp 下的 ES5 闸门与它无关。
 */
(function () {
  'use strict'

  // ---------------------------------------------------------------- 固定数据
  //
  // 数字全部取自生产真实配置（docs/local-delivery-run-log.md）：
  // 配送半径 10 km、起送 ¥40、基础运费 ¥6、基础公里 3 km、每公里 ¥2.5、满 ¥99 免运费。
  // 商品是生产上那两件真商品，价格未改。

  const SHOP = {
    name: '阿福凉菜',
    longName: '丹桂阿福凉菜（自流井丹桂街道总店 · 三十周年老店）',
    rules: '配送范围 10 km · 满 ¥40 起送 · 基础运费 ¥6 起',
  }

  const ADDR = {
    name: '张女士',
    phone: '138****6677',
    poi: '丹桂大街 12 号',
    full: '四川省自贡市自流井区丹桂街道丹桂大街 12 号 3 栋 2 单元 501',
    longFull: '四川省自贡市自流井区丹桂街道丹桂大街 12 号绿地中央广场 A 区 3 栋 2 单元 501 室（请走北门，门卫处电话联系）',
  }

  const ITEMS = [
    { nm: '凉拌牛肉', spec: '微辣 · 半斤装', price: 2500, qty: 1 },
    { nm: '凉拌三丝', spec: '', price: 1500, qty: 1 },
  ]

  const COUPONS = [
    { id: 1, amt: 500, th: 4000, nm: '同城配送专享券', exp: '2026-09-30 到期', ok: true },
    { id: 2, amt: 300, th: 3000, nm: '全渠道通用券', exp: '2026-10-15 到期', ok: true },
    { id: 3, amt: 1500, th: 9900, nm: '满减大额券', exp: '2026-12-31 到期', ok: false, why: '还差 ¥59.00 可用' },
    { id: 4, amt: 800, th: 2000, nm: '全国邮寄专享券', exp: '2026-09-20 到期', ok: false, why: '本单是同城配送，该券仅限全国邮寄' },
  ]
  const LONG_COUPON = {
    id: 5, amt: 1000, th: 4000,
    nm: '丹桂阿福凉菜三十周年感恩回馈满四十减十元通用券',
    exp: '2026-09-30 到期', ok: true,
  }

  const CK_STATES = ['正常', '无地址', '缺定位', '超范围', '未达起送', '报价中', '报价失败', '暂停接单', '提交中']

  // ---------------------------------------------------------------- 工具

  const yuan = (fen) => (fen / 100).toFixed(2)
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  /**
   * 结算页唯一的按钮状态判定。优先级固定：地址 → 报价 → 业务阻塞 → 提交中。
   *
   * 按钮文案只允许这七种，长原因一律走页面提示区，不塞进按钮（否则小屏必溢出）：
   *   请选择地址 / 请补充定位 / 正在计算运费 / 重新获取运费 / 暂不可配送 / 提交订单 / 提交中
   *
   * amountState 决定金额怎么显示：
   *   ready   —— 显示应付金额
   *   pending —— 显示「待计算」（正在算，或还缺前置条件）
   *   error   —— 显示「待重新计算」（报价失败）
   *   blocked —— 显示「待计算」，同时页面提示区给出原因与出口
   *
   * action 决定点下去干什么：submit | retry | none。
   * ⚠️ 报价失败时按钮是**可点的**（店主 2026-09-07 选的方案 B），所以页面必须按 action 分派，
   * 绝不能写成「按钮没禁用就去提交」——那一刻没有有效 quoteToken，提交会被服务端 42239 拒掉。
   */
  function checkoutAction(s) {
    if (!s.hasAddress) return { disabled: true, text: '请选择地址', amountState: 'pending', action: 'none' }
    if (!s.hasLocation) return { disabled: true, text: '请补充定位', amountState: 'pending', action: 'none' }
    if (s.quoting) return { disabled: true, text: '正在计算运费', amountState: 'pending', action: 'none' }
    if (s.quoteError) return { disabled: false, text: '重新获取运费', amountState: 'error', action: 'retry' }
    if (s.blockReason) return { disabled: true, text: '暂不可配送', amountState: 'blocked', action: 'none' }
    if (s.submitting) return { disabled: true, text: '提交中', amountState: 'ready', action: 'submit' }
    return { disabled: false, text: '提交订单', amountState: 'ready', action: 'submit' }
  }

  /** 把预览面板上的九种状态翻译成 checkoutAction 的输入，外加页面要用的展示数据。 */
  function ckModel(st, stress) {
    const base = {
      hasAddress: true, hasLocation: true, quoting: false, quoteError: false,
      blockReason: '', submitting: false,
      items: ITEMS, distanceKm: 2.4, distanceSrc: '实测道路', fee: 600,
      couponId: 1, discount: 500, gift: true,
      headNotice: '', blockActions: [],
      addrState: 'ok', status: 'open',
    }
    const m = Object.assign({}, base)
    switch (st) {
      case '无地址':
        m.hasAddress = false; m.addrState = 'none'; m.fee = null; m.couponId = null; m.discount = 0
        break
      case '缺定位':
        m.hasLocation = false; m.addrState = 'noloc'; m.fee = null; m.couponId = null; m.discount = 0
        break
      case '超范围':
        m.distanceKm = 12.4; m.fee = null; m.couponId = null; m.discount = 0
        m.blockReason = '超出配送范围：本单约 12.4 km，本店配送上限 10 km'
        m.blockActions = ['换个地址', '改用全国邮寄']
        break
      case '未达起送':
        m.items = [ITEMS[1]]; m.fee = null; m.couponId = null; m.discount = 0
        m.blockReason = '还差 ¥25.00 起送（本店满 ¥40.00 起送）'
        m.blockActions = ['去加菜']
        break
      case '报价中':
        m.quoting = true; m.fee = null
        break
      case '报价失败':
        m.quoteError = true; m.fee = null
        break
      case '暂停接单':
        m.status = 'paused'; m.fee = null; m.couponId = null; m.discount = 0
        m.headNotice = '商家已暂停接单，现在无法下同城单'
        m.blockReason = '商家已暂停接单'
        m.blockActions = ['改用全国邮寄']
        break
      case '提交中':
        m.submitting = true
        break
      default:
        break
    }
    if (stress) m.distanceSrc = '估算'
    m.subtotal = m.items.reduce((a, i) => a + i.price * i.qty, 0)
    m.action = checkoutAction(m)
    m.payAmount = m.action.amountState === 'ready' ? m.subtotal - m.discount + (m.fee || 0) : null
    return m
  }

  // ---------------------------------------------------------------- 片段

  const ICONS = window.TABBAR_ICONS || {}

  function tabbar(active, badge) {
    const tabs = [
      { k: 'home', t: '主页', p: 'home' },
      { k: 'category', t: '分类', p: 'category' },
      { k: 'cart', t: '购物车', p: 'cart' },
      { k: 'user', t: '我的', p: 'user' },
    ]
    return `<div class="tabbar">${tabs.map((tb) => {
      const on = tb.p === active
      const src = ICONS[on ? tb.k + '-active' : tb.k] || ''
      const bd = tb.k === 'cart' && badge ? `<i class="tabbar-badge">${badge}</i>` : ''
      return `<div class="tabbar-item ${on ? 'on' : ''}" data-go="${tb.p}">
        <img src="${src}" alt="">${bd}<span>${tb.t}</span></div>`
    }).join('')}</div>`
  }

  function storeHead(status, notice, stress) {
    const label = { open: '营业中', paused: '暂停接单', closed: '已打烊' }[status]
    // 第一行只有：图标 + 店名 + 状态胶囊。原来的「我的订单 ›」已删除（Spec §4.1）。
    return `<div class="store-head">
      <div class="store-title-row">
        <div class="store-name-wrap">
          <svg class="store-icon" viewBox="0 0 24 24" fill="none" stroke="#e5441e" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/>
            <path d="M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/>
          </svg>
          <div class="store-name">${esc(stress ? SHOP.longName : SHOP.name)}</div>
        </div>
        <div class="status-pill ${status}">${label}</div>
      </div>
      <span class="delivery-rules">${SHOP.rules}</span>
      ${notice ? `<div class="head-notice">
        <div class="head-notice-text">${esc(notice)}</div>
        <div class="head-notice-action">去全国邮寄</div></div>` : ''}
    </div>`
  }

  const priceHTML = (fen, suffix) => {
    const [i, d] = yuan(fen).split('.')
    return `<span class="price"><span class="sym">¥</span><span class="int">${i}</span><span class="dec">.${d}</span>${
      suffix ? `<span class="suffix">${suffix}</span>` : ''}</span>`
  }

  // ---------------------------------------------------------------- 四个 tab 页

  function pageHome(ch, stress) {
    if (ch === 'EXPRESS') {
      return `<div class="page has-cartbar">
        <div class="navbar"><div class="navbar-back">‹ 封面</div><div class="navbar-title">阿福凉菜</div></div>
        <div class="banner"><b>三十年老味道</b><span>全国邮寄 · 冷链直发</span></div>
        <div class="quick-cats"><div class="quick-cat on">全部</div><div class="quick-cat">礼盒</div>
          <div class="quick-cat">卤味</div><div class="quick-cat">干货</div></div>
        <div class="sec-title">为你推荐</div>
        ${grid([
          { nm: '真空卤牛肉礼盒', meta: '顺丰冷链 · 已售 128', price: 12800 },
          { nm: '手工豆干 500g', meta: '常温 · 已售 76', price: 3800 },
          { nm: '灯影牛肉丝', meta: '顺丰冷链 · 已售 54', price: 6800 },
          { nm: '自贡冷吃兔', meta: '顺丰冷链 · 已售 203', price: 8800 },
        ], false)}
      </div>`
    }
    return `<div class="page has-cartbar">
      ${storeHead('open', '', stress)}
      <div class="quick-cats"><div class="quick-cat on">凉菜</div><div class="quick-cat">卤味</div>
        <div class="quick-cat">主食</div><div class="quick-cat">饮品</div></div>
      <div class="sec-title">今日现拌</div>
      ${grid([
        { nm: '凉拌牛肉', meta: '剩 8 份 · 已售 12', price: 2500 },
        { nm: '凉拌三丝', meta: '剩 10 份 · 已售 9', price: 1500 },
        { nm: '口水鸡', meta: '剩 4 份', price: 2800 },
        { nm: '夫妻肺片', meta: '售罄', price: 3200, off: true },
      ], true)}
    </div>${cartBar('LOCAL')}`
  }

  function grid(list, addable) {
    return `<div class="prod-grid">${list.map((p) => `<div class="prod-card">
      <div class="img-ph"></div>
      <div class="body">
        <div class="nm ell">${esc(p.nm)}</div>
        <div class="meta ell">${esc(p.meta)}</div>
        <div class="foot">${priceHTML(p.price)}${
          addable ? `<div class="add-btn ${p.off ? 'off' : ''}">+</div>` : '<span class="fs22 t3">详情 ›</span>'}</div>
      </div></div>`).join('')}</div>`
  }

  function pageCategory(ch) {
    const cats = ch === 'LOCAL' ? ['凉菜', '卤味', '主食', '饮品'] : ['全部', '礼盒', '卤味', '干货', '调料']
    const rows = ch === 'LOCAL'
      ? [{ nm: '凉拌牛肉', sub: '微辣 / 中辣 / 特辣', st: '剩 8 份', price: 2500, sku: true },
         { nm: '凉拌三丝', sub: '', st: '剩 10 份', price: 1500 },
         { nm: '口水鸡', sub: '', st: '剩 4 份', price: 2800 },
         { nm: '夫妻肺片', sub: '', st: '售罄', price: 3200, off: true }]
      : [{ nm: '真空卤牛肉礼盒', sub: '500g / 1000g', st: '有货', price: 12800, sku: true },
         { nm: '手工豆干 500g', sub: '', st: '有货', price: 3800 },
         { nm: '灯影牛肉丝', sub: '', st: '有货', price: 6800 }]
    return `<div class="page-fill">
      ${ch === 'EXPRESS' ? '<div class="searchbar"><div>搜索商品</div></div>' : storeHeadThin()}
      <div class="menu-body">
        <div class="cat-panel">${cats.map((c, i) => `<div class="cat-item ${i === 0 ? 'on' : ''}">${c}</div>`).join('')}</div>
        <div class="prod-panel">${rows.map((r) => `<div class="product-row">
          <div class="img-ph"></div>
          <div class="info">
            <div class="nm ell">${esc(r.nm)}</div>
            ${r.sub ? `<div class="sub ell">${esc(r.sub)}</div>` : ''}
            <div class="sub">${r.st}</div>
            <div class="foot">${priceHTML(r.price, r.sku ? '起' : '')}${
              ch === 'LOCAL' ? `<div class="add-btn ${r.off ? 'off' : ''}">+</div>` : '<span class="fs22 t3">详情 ›</span>'}</div>
          </div></div>`).join('')}</div>
      </div>
    </div>${ch === 'LOCAL' ? cartBar('LOCAL') : ''}`
  }

  function storeHeadThin() {
    return `<div class="store-head" style="padding-bottom:calc(14 * var(--rpx))">
      <div class="store-title-row">
        <div class="store-name-wrap"><div class="store-name">${SHOP.name}</div></div>
        <div class="status-pill open">营业中</div>
      </div></div>`
  }

  function cartBar(ch) {
    if (ch !== 'LOCAL') return ''
    return `<div class="cart-bar">
      <div class="sum"><div class="badge">2</div>
        <div class="txt"><span class="fs22 t2">共 2 件 · 券前小计</span>
          <span class="fs28 bold" style="color:var(--brand)">¥40.00</span></div></div>
      <div class="go btn-primary" data-go="checkout">去结算</div>
    </div>`
  }

  function pageCart(ch) {
    if (ch === 'EXPRESS') {
      return `<div class="page has-bottombar">
        <div class="card"><div class="card-title">全国邮寄购物车</div>
          ${cartItem('真空卤牛肉礼盒', '500g', 12800, 1)}
          ${cartItem('手工豆干 500g', '', 3800, 2)}
        </div></div>
        <div class="bottom-bar"><div class="bottom-main">
          <div class="bottom-total"><span class="lb">合计</span>${priceHTML(20400)}</div>
          <div class="submit-btn btn-primary">去结算(3)</div></div></div>`
    }
    return `<div class="page has-bottombar">
      <div class="card"><div class="card-title">同城购物车</div>
        ${cartItem('凉拌牛肉', '微辣 · 半斤装', 2500, 1)}
        ${cartItem('凉拌三丝', '', 1500, 1)}
      </div>
      <div class="card"><div class="sum-row"><span class="k">券前小计</span><span class="v">¥40.00</span></div>
        <div class="sum-row"><span class="k">起送线</span><span class="v">满 ¥40.00 · 已达成</span></div>
        <div class="fs21 t3" style="margin-top:calc(6 * var(--rpx));line-height:1.5">
          配送费在结算页按实际地址计算，购物车不外呼查价。</div></div>
    </div>
    <div class="bottom-bar"><div class="bottom-main">
      <div class="bottom-total"><span class="lb">券前小计</span>${priceHTML(4000)}</div>
      <div class="submit-btn btn-primary" data-go="checkout">去结算(2)</div></div></div>`
  }

  function cartItem(nm, spec, price, qty) {
    return `<div class="item-row"><div class="img-ph"></div>
      <div class="info"><div class="nm ell">${esc(nm)}</div>
        ${spec ? `<div class="spec ell">${esc(spec)}</div>` : ''}
        <div class="foot">${priceHTML(price)}
          <div class="stepper"><i class="${qty <= 1 ? 'off' : ''}">−</i><b>${qty}</b><i>+</i></div></div>
      </div></div>`
  }

  function pageUser(ch) {
    const tag = ch === 'LOCAL' ? '同城配送' : '全国邮寄'
    return `<div class="page">
      <div class="user-hero"><div class="avatar"></div>
        <div><div class="nm">微信用户</div><div class="sub">积分 1,280 · 优惠券 3 张</div></div>
        <div class="channel-tag">${tag}</div></div>
      <div class="card"><div class="row-between"><div class="card-title" style="margin:0">我的订单</div>
          <span class="fs22 t3">全部 ›</span></div>
        <div class="order-tabs"><span class="on">${tag}</span><span>全部订单</span></div>
        <div class="fs21 t3" style="margin-top:calc(14 * var(--rpx));line-height:1.5">
          默认只看当前渠道的单；切「全部订单」看两个渠道。</div></div>
      <div class="card">
        <div class="cell"><span class="grow">会员中心</span><span class="chevron">›</span></div>
        <div class="cell"><span class="grow">我的优惠券</span><span class="hint">3 张可用</span><span class="chevron">›</span></div>
        <div class="cell"><span class="grow">积分明细</span><span class="hint">1,280</span><span class="chevron">›</span></div>
        <div class="cell"><span class="grow">收货地址</span><span class="chevron">›</span></div>
      </div>
      <div class="card">
        <div class="cell"><span class="grow">联系商家</span><span class="chevron">›</span></div>
        <div class="cell"><span class="grow">用户协议与隐私政策</span><span class="chevron">›</span></div>
        <div class="cell"><span class="grow">商家管理</span><span class="chevron">›</span></div>
      </div>
    </div>`
  }

  // ---------------------------------------------------------------- 结算页

  function pageCheckout(st, stress) {
    const m = ckModel(st, stress)
    const a = m.action
    const full = stress ? ADDR.longFull : ADDR.full

    // ① 页面级营业通知
    const head = m.headNotice ? `<div class="head-notice" style="margin:calc(20 * var(--rpx))">
      <div class="head-notice-text">${esc(m.headNotice)}</div>
      <div class="head-notice-action">改用全国邮寄</div></div>` : ''

    // ② 地址卡
    let addr
    if (m.addrState === 'none') {
      addr = `<div class="card addr-card"><svg class="addr-pin" viewBox="0 0 24 24" fill="none" stroke="#c8c9cc"
          stroke-width="1.8"><path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
        <div class="addr-empty">新增收货地址<div class="fs22 t3" style="margin-top:calc(6 * var(--rpx))">
          同城配送需要地图定位，填完地址会让你在地图上点一下门口</div></div>
        <div class="addr-arrow">›</div></div>`
    } else {
      addr = `<div class="card addr-card">
        <svg class="addr-pin" viewBox="0 0 24 24" fill="none" stroke="#e5441e" stroke-width="1.8">
          <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>
        <div class="addr-body">
          <div class="addr-name-row"><span class="addr-name">${ADDR.name}</span>
            <span class="addr-phone">${ADDR.phone}</span><span class="tag default">默认</span></div>
          <div class="addr-poi ell">${esc(ADDR.poi)}</div>
          <div class="addr-full">${esc(full)}</div>
          ${m.addrState === 'noloc' ? `<div class="addr-alert">
            <span>该地址还没有地图定位，无法计算配送费</span><span>去补充定位</span></div>` : ''}
        </div><div class="addr-arrow">›</div></div>`
    }

    // ③ 配送报价卡
    let dlv
    if (!m.hasAddress) {
      dlv = '<div class="dlv-line t3">选择地址后计算配送费</div>'
    } else if (!m.hasLocation) {
      dlv = '<div class="dlv-line t3">补充地图定位后才能计算配送费</div>'
    } else if (m.quoting) {
      dlv = '<div class="dlv-skeleton s1"></div><div class="dlv-skeleton s2"></div>'
    } else if (m.quoteError) {
      dlv = `<div class="dlv-err"><span>网络不好，配送费没算出来</span>
        <div class="retry-inline">重新获取运费</div></div>`
    } else {
      dlv = `<div class="dlv-line">距离 <b>${m.distanceKm} km</b>
          <span class="src-tag ${m.distanceSrc === '估算' ? 'est' : ''}">${m.distanceSrc}</span></div>
        ${m.fee != null ? `<div class="dlv-line">配送费 <b>¥${yuan(m.fee)}</b></div>
        <div class="dlv-line">预计 <b>36 分钟</b> · 19:41 送达</div>` : ''}
        <div class="dlv-foot">配送时间以骑手接单后实际安排为准</div>`
    }

    // ⑤ 优惠券与积分赠品
    const cpn = COUPONS.find((c) => c.id === m.couponId)
    const cpnVal = m.couponId
      ? `<span class="val pick">${esc(cpn.nm)} −¥${yuan(cpn.amt)}</span>`
      : `<span class="val ${m.hasAddress && m.hasLocation ? 'none' : 'none'}">${
          m.subtotal >= 3000 ? '2 张可用' : '暂无可用券'}</span>`

    // ⑦ 金额明细
    const wait = (txt) => `<span class="v wait">${txt}</span>`
    const money = (fen) => `<span class="v">¥${yuan(fen)}</span>`
    const feeCell = m.quoting ? wait('计算中') : m.quoteError ? wait('待重新计算')
      : m.fee == null ? wait('待计算') : money(m.fee)
    const payCell = a.amountState === 'ready' ? `<span class="v bold" style="color:var(--brand)">¥${yuan(m.payAmount)}</span>`
      : a.amountState === 'error' ? wait('待重新计算') : wait('待计算')

    const sum = `<div class="card">
      <div class="card-title">金额明细</div>
      <div class="sum-row"><span class="k">商品金额</span>${money(m.subtotal)}</div>
      ${m.discount ? `<div class="sum-row"><span class="k">优惠券</span><span class="v cut">−¥${yuan(m.discount)}</span></div>` : ''}
      <div class="sum-row"><span class="k">配送费</span>${feeCell}</div>
      ${m.gift ? '<div class="sum-row"><span class="k">积分赠品</span><span class="v">300 积分</span></div>' : ''}
      <div class="sum-row total"><span class="k">应付金额</span>${payCell}</div>
    </div>`

    // ⑨ 固定底栏
    const strip = m.blockReason ? `<div class="block-strip ${st === '暂停接单' ? 'warn' : ''}">
      <span>${esc(m.blockReason)}</span>
      <div class="acts">${m.blockActions.map((x) => `<span>${x}</span>`).join('')}</div></div>` : ''
    const totalCell = a.amountState === 'ready'
      ? `<span class="lb">合计</span>${priceHTML(m.payAmount)}`
      : `<span class="lb">合计</span><span class="pending">${a.amountState === 'error' ? '待重新计算' : '待计算'}</span>`

    return `<div class="page has-bottombar">
      ${head}${addr}
      <div class="card"><div class="card-title">配送信息</div>${dlv}</div>
      <div class="card"><div class="card-title">商品明细</div>
        ${m.items.map((i) => cartItem(i.nm, i.spec, i.price, i.qty)).join('')}</div>
      <div class="card"><div class="card-title">优惠与积分</div>
        <div class="opt-row" data-go="sheet"><span class="lb">优惠券</span>${cpnVal}<span class="chevron">›</span></div>
        ${m.gift ? `<div class="opt-row"><span class="lb">积分赠品</span>
          <span class="val pick">手工豆干 ×1</span><span class="chevron">›</span></div>
          <div class="gift-row"><div class="img-ph"></div>
            <div class="info"><div class="fs25">手工豆干 500g</div>
              <div class="fs21 t3">库存 12 · 每单限 1 份</div></div>
            <div class="gift-pts">300 积分</div></div>` : `<div class="opt-row"><span class="lb">积分赠品</span>
          <span class="val none">积分 1,280 · 去挑选</span><span class="chevron">›</span></div>`}
      </div>
      <div class="card">
        <div class="opt-row"><span class="lb">需要餐具</span><div class="switch"></div></div>
        <div class="opt-row" style="display:block"><span class="lb">订单备注</span>
          <div class="remark-box">20 字以内，如放门口、不要辣</div></div>
      </div>
      ${sum}
    </div>
    <div class="bottom-bar">${strip}
      <div class="agree-row">提交订单即表示同意 <a>《用户协议》</a> 和 <a>《隐私政策》</a></div>
      <div class="bottom-main">
        <div class="bottom-total">${totalCell}</div>
        <div class="submit-btn btn-primary ${a.disabled ? 'btn-disabled' : ''}">${a.text}</div>
      </div></div>`
  }

  function couponSheet(stress) {
    const list = stress ? [LONG_COUPON].concat(COUPONS) : COUPONS
    return `<div class="mask" data-go="closesheet"><div class="sheet">
      <div class="sheet-head"><b>选择优惠券</b><span data-go="closesheet">关闭</span></div>
      <div class="sheet-body">
        <div class="cpn"><div class="amt"><b>不用</b><span>原价下单</span></div>
          <div class="meta"><div class="nm">不使用优惠券</div>
            <div class="exp">本单按商品原价结算</div></div><div class="pick">选择</div></div>
        ${list.map((c) => `<div class="cpn ${c.ok ? (c.id === 1 ? 'on' : '') : 'off'}">
          <div class="amt"><b>${(c.amt / 100).toFixed(0)}</b><span>满 ${(c.th / 100).toFixed(0)} 可用</span></div>
          <div class="meta"><div class="nm">${esc(c.nm)}</div><div class="exp">${c.exp}</div>
            ${c.why ? `<div class="why">${esc(c.why)}</div>` : ''}</div>
          <div class="pick">${c.ok ? (c.id === 1 ? '已选' : '选择') : ''}</div></div>`).join('')}
      </div></div></div>`
  }

  // ---------------------------------------------------------------- 地址页

  function pageAddressList() {
    return `<div class="page has-bottombar">
      <div class="addr-item"><div class="top"><span class="addr-name">${ADDR.name}</span>
          <span class="addr-phone">${ADDR.phone}</span><span class="tag default">默认</span>
          <span class="dist">直线约 2.1 km</span></div>
        <div class="full">${esc(ADDR.full)}</div>
        <div class="acts"><span>编辑</span><span>删除</span></div></div>
      <div class="addr-item"><div class="top"><span class="addr-name">李先生</span>
          <span class="addr-phone">159****2210</span><span class="tag noloc">缺定位</span></div>
        <div class="full">四川省自贡市贡井区筱溪街 88 号 2 栋 1 单元 302</div>
        <div class="fs22" style="color:var(--warning);margin-top:calc(8 * var(--rpx))">
          同城配送要先在地图上点一下门口，点「编辑」补充</div>
        <div class="acts"><span>编辑</span><span>删除</span></div></div>
      <div class="addr-item"><div class="top"><span class="addr-name">王女士</span>
          <span class="addr-phone">137****9001</span><span class="tag far">可能超范围</span>
          <span class="dist">直线约 9.6 km</span></div>
        <div class="full">四川省自贡市沿滩区沿滩新区兴隆路 5 号</div>
        <div class="fs22 t3" style="margin-top:calc(8 * var(--rpx))">
          最终以结算页按道路距离计算的结果为准</div>
        <div class="acts"><span>编辑</span><span>删除</span></div></div>
    </div>
    <div class="bottom-bar"><div class="bottom-main">
      <div class="submit-btn btn-primary" style="flex:1;min-width:0">新增收货地址</div></div></div>`
  }

  function pageAddressEdit(stress) {
    return `<div class="page has-bottombar">
      <div class="card">
        <div class="form-row"><span class="k">联系人</span><span class="v">${ADDR.name}</span></div>
        <div class="form-row"><span class="k">手机号</span><span class="v">138 6677 8899</span></div>
        <div class="form-row"><span class="k">所在地区</span><span class="v">四川省 自贡市 自流井区</span></div>
        <div class="form-row"><span class="k">详细地址</span>
          <span class="v">${esc(stress ? ADDR.longFull : '丹桂大街 12 号 3 栋 2 单元 501')}</span></div>
        <div class="form-row"><span class="k"><span class="req">*</span>地图定位</span>
          <span class="v ph">同城配送必填</span></div>
        <div class="map-btn">📍 在地图上选择门口位置</div>
        <div class="quote-strip">已定位「丹桂大街 12 号」· 距门店约 2.4 km · 预估配送费 ¥6.00<br>
          <span style="opacity:.75">仅供参考，下单时以结算页报价为准</span></div>
        <div class="form-row" style="border-bottom:none"><span class="k">设为默认</span>
          <div class="switch off" style="margin-left:auto"></div></div>
      </div>
      <div class="card"><div class="row-between"><span class="fs26">导入微信收货地址</span>
          <span class="chevron">›</span></div>
        <div class="fs21 t3" style="margin-top:calc(8 * var(--rpx));line-height:1.5">
          只带回联系人和文字地址，<b>不会带回地图定位</b>；导入后需要重新在地图上点一次。</div></div>
    </div>
    <div class="bottom-bar"><div class="bottom-main">
      <div class="submit-btn btn-primary" style="flex:1;min-width:0">保存并使用该地址</div></div></div>`
  }

  // ---------------------------------------------------------------- 渲染

  const S = { channel: 'LOCAL', page: 'home', ck: '正常', sheet: false, stress: false }
  const TAB_PAGES = ['home', 'category', 'cart', 'user']

  function screenHTML() {
    const ch = S.channel
    switch (S.page) {
      case 'home': return pageHome(ch, S.stress)
      case 'category': return pageCategory(ch)
      case 'cart': return pageCart(ch)
      case 'user': return pageUser(ch)
      case 'checkout': return pageCheckout(S.ck, S.stress) + (S.sheet ? couponSheet(S.stress) : '')
      case 'addressList': return pageAddressList()
      case 'addressEdit': return pageAddressEdit(S.stress)
      default: return ''
    }
  }

  function render() {
    const isTab = TAB_PAGES.indexOf(S.page) !== -1
    const badge = S.channel === 'LOCAL' ? 2 : 3
    const html = screenHTML()
    document.querySelectorAll('.frame').forEach((f) => {
      const vp = f.querySelector('.viewport')
      vp.querySelectorAll(':scope > :not(.screen)').forEach((n) => n.remove())
      const scr = vp.querySelector('.screen')
      scr.innerHTML = html
      // 固定条与遮罩挪出滚动层：留在 .screen 里的 position:absolute 会跟着内容滚，
      // 那与真机的 position:fixed 不是一回事（第一版就是这么错的）。
      scr.querySelectorAll(':scope > .bottom-bar, :scope > .cart-bar, :scope > .mask')
        .forEach((n) => vp.appendChild(n))
      const old = f.querySelector('.tabbar')
      if (old) old.remove()
      if (isTab) f.insertAdjacentHTML('beforeend', tabbar(S.page, badge))
    })
    document.querySelectorAll('[data-k]').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.v === S[el.dataset.k]))
    })
    document.querySelectorAll('[data-k="ck"]').forEach((el) => { el.disabled = S.page !== 'checkout' })
    const sheetBtn = document.querySelector('#sheetBtn')
    sheetBtn.setAttribute('aria-pressed', String(S.sheet))
    sheetBtn.disabled = S.page !== 'checkout'
    document.querySelector('#stressBtn').setAttribute('aria-pressed', String(S.stress))
    hideProbe()
  }

  // ---------------------------------------------------------------- 溢出自检
  //
  // 「没有横向滚动」不能靠肉眼。这里量的是每个 .screen 自身的 scrollWidth，
  // 以及页面内每个元素相对画布右边界的越界量。命中的元素会被描红。

  function hideProbe() {
    const box = document.querySelector('#probeOut')
    box.className = 'probe-out'
    box.textContent = ''
    document.querySelectorAll('.overflow-hit').forEach((el) => el.classList.remove('overflow-hit'))
  }

  function probe() {
    document.querySelectorAll('.overflow-hit').forEach((el) => el.classList.remove('overflow-hit'))
    const lines = []
    document.querySelectorAll('.frame').forEach((f) => {
      const label = f.classList.contains('w375') ? '375×812' : '320×568'
      const vp = f.querySelector('.viewport')
      const scr = vp.querySelector('.screen')
      const over = scr.scrollWidth - scr.clientWidth
      const right = vp.getBoundingClientRect().right
      let hits = 0
      vp.querySelectorAll('*').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.right - right > 0.5) {
          el.classList.add('overflow-hit'); hits++
          if (hits <= 4) {
            lines.push(`  ↳ ${el.className || el.tagName} 越界 ${(r.right - right).toFixed(1)}px`)
          }
        }
      })
      lines.unshift(`${label}：横向可滚动 ${over}px，越界元素 ${hits} 个`)
      if (hits > 4) lines.push(`  ↳ 其余 ${hits - 4} 个已描红`)
    })
    const bad = lines.some((l) => /横向可滚动 [1-9]/.test(l) || /越界元素 [1-9]/.test(l))
    const box = document.querySelector('#probeOut')
    box.className = 'probe-out show ' + (bad ? 'bad' : 'good')
    box.textContent = (bad ? '发现溢出：\n' : '两种画布都没有横向溢出。\n') + lines.join('\n')
  }

  // ---------------------------------------------------------------- 交互

  document.addEventListener('click', (e) => {
    const ctl = e.target.closest('[data-k]')
    if (ctl) {
      S[ctl.dataset.k] = ctl.dataset.v
      if (ctl.dataset.k === 'page') S.sheet = false
      if (ctl.dataset.k === 'channel' && S.page === 'checkout') S.page = 'home'
      return render()
    }
    const go = e.target.closest('[data-go]')
    if (go) {
      const v = go.dataset.go
      if (v === 'sheet') S.sheet = true
      else if (v === 'closesheet') { if (e.target.closest('.sheet') && !e.target.closest('[data-go="closesheet"]')) return; S.sheet = false }
      else { S.page = v; S.sheet = false }
      return render()
    }
    if (e.target.closest('#sheetBtn')) { S.sheet = !S.sheet; return render() }
    if (e.target.closest('#stressBtn')) { S.stress = !S.stress; return render() }
    if (e.target.closest('#probeBtn')) return probe()
  })

  // 状态按钮由 JS 生成，保证与 CK_STATES 单一来源一致
  document.querySelector('#ckStates').innerHTML = CK_STATES
    .map((s) => `<button class="chip" data-k="ck" data-v="${s}">${s}</button>`).join('')

  render()
})()
