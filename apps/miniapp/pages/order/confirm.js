const { getCart } = require('../../api/cart')
const { getAddresses } = require('../../api/address')
const { createOrder } = require('../../api/order')
const { formatPrice } = require('../../utils/format')
const app = getApp()

Page({
  data: {
    cartItemIds: [],
    items: [],
    address: null,
    remark: '',
    totalAmount: 0,
    submitting: false,
  },

  onLoad(options) {
    var ids = (options.cartItemIds || '').split(',').filter(Boolean).map(Number)
    this.setData({ cartItemIds: ids })
    this.loadData()
  },

  onShow() {
    // Check if user selected a new address from address/list
    if (app.globalData.selectedAddress) {
      this.setData({ address: app.globalData.selectedAddress })
      app.globalData.selectedAddress = null
    }
  },

  loadData() {
    var self = this
    var ids = this.data.cartItemIds
    Promise.all([getCart(), getAddresses()])
      .then(function(results) {
        var cartData = results[0]
        var addresses = results[1]

        // Filter to only the selected cart items
        var items = (cartData.items || []).filter(function(item) {
          return ids.indexOf(item.id) !== -1
        }).map(function(item) {
          return Object.assign({}, item, { priceText: formatPrice(item.price) })
        })

        var totalAmount = items.reduce(function(sum, item) {
          return sum + item.subtotal
        }, 0)

        // Pick default address or first address
        var address = addresses.find(function(a) { return a.isDefault }) || addresses[0] || null

        self.setData({
          items: items,
          totalAmount: totalAmount,
          address: address,
        })
      })
  },

  onSelectAddress() {
    wx.navigateTo({ url: '/pages/address/list?mode=select' })
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value })
  },

  onSubmit() {
    if (!this.data.address) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' })
      return
    }
    if (this.data.items.length === 0) {
      wx.showToast({ title: '请先选择商品', icon: 'none' })
      return
    }
    if (this.data.submitting) return

    this.setData({ submitting: true })
    var self = this
    createOrder({
      cartItemIds: this.data.cartItemIds,
      addressId: this.data.address.id,
      deliveryType: 'EXPRESS',
      remark: this.data.remark || undefined,
    })
      .then(function(res) {
        wx.showToast({ title: '下单成功', icon: 'success' })
        getApp().updateCartCount()
        setTimeout(function() {
          wx.redirectTo({ url: '/pages/order/detail?id=' + res.orderId })
        }, 800)
      })
      .catch(function() {
        self.setData({ submitting: false })
      })
  },
})
