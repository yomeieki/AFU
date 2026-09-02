const { getAddresses, createAddress, updateAddress } = require('../../api/address')

var PHONE_RE = /^1[3-9]\d{9}$/

Page({
  data: {
    id: null,
    form: {
      receiverName: '',
      receiverPhone: '',
      detail: '',
      isDefault: 0,
    },
    // 省市区三元组（picker mode="region"）；空数组 = 未选择，显示占位
    region: [],
    regionText: '',
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
        var region = addr.province && addr.city && addr.district
          ? [addr.province, addr.city, addr.district]
          : []
        self.setData({
          form: {
            receiverName: addr.receiverName || '',
            receiverPhone: addr.receiverPhone || '',
            detail: addr.detail || '',
            isDefault: addr.isDefault ? 1 : 0,
          },
          region: region,
          regionText: region.join(' / '),
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

  onRegionChange(e) {
    var region = e.detail.value || []
    this.setData({ region: region, regionText: region.join(' / ') })
  },

  // 导入微信收货地址（用户取消静默；拒绝授权提示去设置）
  onImportWechatAddress() {
    var self = this
    wx.chooseAddress({
      success(res) {
        var region = [res.provinceName || '', res.cityName || '', res.countyName || '']
        self.setData({
          'form.receiverName': res.userName || '',
          'form.receiverPhone': res.telNumber || '',
          'form.detail': res.detailInfo || '',
          region: region,
          regionText: region.join(' / '),
        })
      },
      fail(err) {
        var msg = (err && err.errMsg) || ''
        if (msg.indexOf('auth deny') !== -1 || msg.indexOf('auth denied') !== -1 || msg.indexOf('authorize') !== -1) {
          wx.showToast({ title: '请在设置中允许获取地址', icon: 'none' })
        }
      },
    })
  },

  onToggleDefault() {
    this.setData({ 'form.isDefault': this.data.form.isDefault ? 0 : 1 })
  },

  onSave() {
    if (this.data.saving) return
    var form = this.data.form
    var region = this.data.region
    var name = (form.receiverName || '').trim()
    var phone = (form.receiverPhone || '').trim()
    var detail = (form.detail || '').trim()

    if (!name) { wx.showToast({ title: '请填写收货人', icon: 'none' }); return }
    if (!PHONE_RE.test(phone)) { wx.showToast({ title: '请输入正确的手机号', icon: 'none' }); return }
    if (!region || region.length < 3 || !region[0]) { wx.showToast({ title: '请选择省市区', icon: 'none' }); return }
    if (!detail) { wx.showToast({ title: '请填写详细地址', icon: 'none' }); return }

    var payload = {
      receiverName: name,
      receiverPhone: phone,
      province: region[0],
      city: region[1],
      district: region[2],
      detail: detail,
      isDefault: form.isDefault ? 1 : 0,
    }

    var self = this
    this.setData({ saving: true })
    var promise = this.data.id
      ? updateAddress(this.data.id, payload)
      : createAddress(payload)

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
