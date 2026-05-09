const { getAddresses, deleteAddress } = require('../../api/address')
const app = getApp()

Page({
  data: {
    addresses: [],
    loading: true,
    // 'select' mode: choosing address for order confirm page
    mode: 'normal',
  },

  onLoad(options) {
    this.setData({ mode: options.mode || 'normal' })
  },

  onShow() {
    this.loadAddresses()
  },

  loadAddresses() {
    var self = this
    this.setData({ loading: true })
    getAddresses()
      .then(function(list) {
        self.setData({ addresses: list, loading: false })
      })
      .catch(function() {
        self.setData({ loading: false })
      })
  },

  onAddAddress() {
    wx.navigateTo({ url: '/pages/address/edit' })
  },

  onEditAddress(e) {
    var id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/address/edit?id=' + id })
  },

  onDeleteAddress(e) {
    var id = e.currentTarget.dataset.id
    var self = this
    wx.showModal({
      title: '提示',
      content: '确认删除该地址？',
      success: function(res) {
        if (!res.confirm) return
        deleteAddress(id).then(function() { self.loadAddresses() })
      },
    })
  },

  onSelectAddress(e) {
    if (this.data.mode !== 'select') return
    var address = e.currentTarget.dataset.address
    app.globalData.selectedAddress = address
    wx.navigateBack()
  },
})
