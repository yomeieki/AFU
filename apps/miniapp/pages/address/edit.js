const { getAddresses, createAddress, updateAddress } = require('../../api/address')

Page({
  data: {
    id: null,
    form: {
      receiverName: '',
      receiverPhone: '',
      province: '',
      city: '',
      district: '',
      detail: '',
      isDefault: 0,
    },
    saving: false,
  },

  onLoad(options) {
    if (options.id) {
      this.setData({ id: Number(options.id) })
      wx.setNavigationBarTitle({ title: '编辑地址' })
      this.loadAddress(Number(options.id))
    } else {
      wx.setNavigationBarTitle({ title: '新增地址' })
    }
  },

  loadAddress(id) {
    var self = this
    getAddresses().then(function(list) {
      var addr = list.find(function(a) { return a.id === id })
      if (addr) {
        self.setData({
          form: {
            receiverName: addr.receiverName,
            receiverPhone: addr.receiverPhone,
            province: addr.province,
            city: addr.city,
            district: addr.district,
            detail: addr.detail,
            isDefault: addr.isDefault,
          },
        })
      }
    })
  },

  onInput(e) {
    var field = e.currentTarget.dataset.field
    var update = {}
    update['form.' + field] = e.detail.value
    this.setData(update)
  },

  onToggleDefault() {
    this.setData({ 'form.isDefault': this.data.form.isDefault ? 0 : 1 })
  },

  onSave() {
    var form = this.data.form
    if (!form.receiverName.trim()) { wx.showToast({ title: '请填写收货人', icon: 'none' }); return }
    if (!form.receiverPhone.trim()) { wx.showToast({ title: '请填写手机号', icon: 'none' }); return }
    if (!form.province.trim()) { wx.showToast({ title: '请填写省份', icon: 'none' }); return }
    if (!form.city.trim()) { wx.showToast({ title: '请填写城市', icon: 'none' }); return }
    if (!form.district.trim()) { wx.showToast({ title: '请填写区县', icon: 'none' }); return }
    if (!form.detail.trim()) { wx.showToast({ title: '请填写详细地址', icon: 'none' }); return }

    var self = this
    this.setData({ saving: true })
    var promise = this.data.id
      ? updateAddress(this.data.id, form)
      : createAddress(form)

    promise
      .then(function() {
        wx.showToast({ title: '保存成功', icon: 'success' })
        setTimeout(function() { wx.navigateBack() }, 1000)
      })
      .catch(function() {
        self.setData({ saving: false })
      })
  },
})
