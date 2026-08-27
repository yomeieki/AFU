const { getCart, updateCartItem, deleteCartItem } = require('../../api/cart')
const { formatPrice } = require('../../utils/format')

Page({
  data: {
    items: [],
    totalAmount: 0,
    selectedCount: 0,
    loading: true,
  },

  onShow() {
    this.loadCart()
  },

  loadCart() {
    var self = this
    this.setData({ loading: true })
    getCart()
      .then(function(data) {
        self.setData({
          items: (data.items || []).map(function(item) {
            return Object.assign({}, item, { priceText: formatPrice(item.price) })
          }),
          totalAmount: data.totalAmount,
          selectedCount: data.selectedCount,
          loading: false,
        })
        getApp().updateCartCount()
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  onToggleSelect(e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(i) { return i.id === id })
    if (!item || item.status !== 'ON_SHELF') return
    var newVal = item.isSelected === 1 ? 0 : 1
    updateCartItem(id, { isSelected: newVal })
      .then(function() { self.loadCart() })
  },

  onDecrease(e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(i) { return i.id === id })
    if (!item || item.status !== 'ON_SHELF' || item.quantity <= 1) return
    updateCartItem(id, { quantity: item.quantity - 1 })
      .then(function() { self.loadCart() })
  },

  onIncrease(e) {
    var self = this
    var id = e.currentTarget.dataset.id
    var item = this.data.items.find(function(i) { return i.id === id })
    if (!item || item.status !== 'ON_SHELF') return
    updateCartItem(id, { quantity: item.quantity + 1 })
      .then(function() { self.loadCart() })
  },

  onDelete(e) {
    var self = this
    var id = e.currentTarget.dataset.id
    wx.showModal({
      title: '提示',
      content: '确认删除该商品？',
      success: function(res) {
        if (!res.confirm) return
        deleteCartItem(id).then(function() { self.loadCart() })
      },
    })
  },

  onCheckout() {
    var selectedItems = this.data.items.filter(function(i) { return i.isSelected === 1 })
    if (selectedItems.length === 0) {
      wx.showToast({ title: '请选择商品', icon: 'none' })
      return
    }
    var ids = selectedItems.map(function(i) { return i.id }).join(',')
    wx.navigateTo({ url: '/pages/order/confirm?cartItemIds=' + ids })
  },

  formatTotal() {
    return formatPrice(this.data.totalAmount)
  },
})
