const { formatPrice, formatStock } = require('../../utils/format')

/**
 * 规格选择半屏弹层。
 * 无规格商品（skus 为空）只显示价格 + 数量步进器；
 * 多规格商品按 specDimensions 分组胶囊选择，实时解析选中 SKU 的价格/库存。
 */
Component({
  properties: {
    show: { type: Boolean, value: false },
    // 商品对象：需含 id/coverImage/price/originalPrice/stock/unit/specDimensions/skus
    product: { type: Object, value: null },
    // cart=加入购物车 buy=立即购买（只影响确认按钮文案，事件由页面处理）
    mode: { type: String, value: 'cart' },
  },

  data: {
    selected: [],       // 每个维度当前选中值（null=未选）
    quantity: 1,
    dimGroups: [],      // [{name, options:[{value, active, disabled}]}]
    priceText: '0.00',
    originalPriceText: null,
    stockLabel: '',
    maxQty: 1,
    currentSkuId: null,
    selectedText: '',   // "中辣/去骨" 已选文案
    canConfirm: false,
    confirmLabel: '加入购物车',
  },

  observers: {
    'show, product': function (show, product) {
      if (!show || !product) return
      this.initSelection()
    },
    mode: function (mode) {
      this.setData({ confirmLabel: mode === 'buy' ? '立即购买' : '加入购物车' })
    },
  },

  methods: {
    hasSkus() {
      var p = this.properties.product
      return !!(p && p.skus && p.skus.length > 0)
    },

    /** 打开时初始化：默认选中第一个有库存 SKU 的组合 */
    initSelection() {
      var p = this.properties.product
      if (!this.hasSkus()) {
        this.setData({ selected: [], quantity: 1 })
        this.recompute()
        return
      }
      var first = null
      for (var i = 0; i < p.skus.length; i++) {
        if (p.skus[i].stock > 0) { first = p.skus[i]; break }
      }
      if (!first) first = p.skus[0]
      this.setData({ selected: first.specValues.slice(), quantity: 1 })
      this.recompute()
    },

    /** 按当前选择重算：分组选项可用性 + 当前 SKU + 价格/库存 */
    recompute() {
      var p = this.properties.product
      if (!p) return

      // 无规格：直接用商品级价格/库存
      if (!this.hasSkus()) {
        var maxQty = Math.max(1, Math.min(p.stock, 99))
        this.setData({
          dimGroups: [],
          priceText: formatPrice(p.price),
          originalPriceText: p.originalPrice ? formatPrice(p.originalPrice) : null,
          stockLabel: formatStock(p.stock),
          maxQty: maxQty,
          currentSkuId: null,
          selectedText: '',
          canConfirm: p.stock > 0,
          quantity: Math.min(this.data.quantity, maxQty),
        })
        return
      }

      var dims = p.specDimensions || []
      var skus = p.skus
      var selected = this.data.selected

      // 每个维度的每个值：在「其余维度维持当前选择」的前提下是否存在有库存组合
      var dimGroups = dims.map(function (dim, di) {
        return {
          name: dim.name,
          options: dim.values.map(function (v) {
            var available = skus.some(function (sku) {
              if (sku.stock <= 0) return false
              if (sku.specValues[di] !== v) return false
              for (var j = 0; j < dims.length; j++) {
                if (j === di) continue
                if (selected[j] && sku.specValues[j] !== selected[j]) return false
              }
              return true
            })
            return { value: v, active: selected[di] === v, disabled: !available }
          }),
        }
      })

      // 全部维度已选时解析当前 SKU
      var complete = selected.length === dims.length && selected.every(function (v) { return !!v })
      var current = null
      if (complete) {
        current = skus.find(function (sku) {
          return sku.specValues.every(function (v, i) { return v === selected[i] })
        }) || null
      }

      var price = current ? current.price : p.price
      var originalPrice = current ? current.originalPrice : p.originalPrice
      var stock = current ? current.stock : null
      var maxQty2 = current ? Math.max(1, Math.min(current.stock, 99)) : 1

      this.setData({
        dimGroups: dimGroups,
        priceText: formatPrice(price),
        originalPriceText: originalPrice ? formatPrice(originalPrice) : null,
        stockLabel: current
          ? (current.stock <= 0 ? '该规格已售罄' : '该规格剩 ' + current.stock + ' ' + (p.unit || '份'))
          : '请选择规格',
        maxQty: maxQty2,
        currentSkuId: current ? current.id : null,
        selectedText: complete ? selected.join('/') : '',
        canConfirm: !!current && stock > 0,
        quantity: Math.min(this.data.quantity, maxQty2),
      })
    },

    onSelectValue(e) {
      var di = e.currentTarget.dataset.dim
      var value = e.currentTarget.dataset.value
      var disabled = e.currentTarget.dataset.disabled
      if (disabled) return
      var selected = this.data.selected.slice()
      // 点击已选值 = 取消选择（常见交互）
      selected[di] = selected[di] === value ? null : value
      this.setData({ selected: selected })
      this.recompute()
    },

    onDecrease() {
      if (this.data.quantity <= 1) return
      this.setData({ quantity: this.data.quantity - 1 })
    },

    onIncrease() {
      if (this.data.quantity >= this.data.maxQty) {
        wx.showToast({ title: '已达库存上限', icon: 'none' })
        return
      }
      this.setData({ quantity: this.data.quantity + 1 })
    },

    onConfirm() {
      if (!this.data.canConfirm) return
      this.triggerEvent('confirm', {
        skuId: this.data.currentSkuId,
        quantity: this.data.quantity,
        specText: this.data.selectedText,
      })
    },

    onClose() {
      this.triggerEvent('close')
    },

    // 阻止 mask 触摸滚动穿透
    noop() {},
  },
})
