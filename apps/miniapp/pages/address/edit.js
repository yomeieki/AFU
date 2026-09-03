const { getAddresses, createAddress, updateAddress } = require('../../api/address')
const { baseURL } = require('../../config/index')

var PHONE_RE = /^1[3-9]\d{9}$/

/**
 * 从 wx.chooseLocation 返回的完整地址里拆出省市区。
 * 解析失败时返回空 region，交由顾客自己用省市区选择器补——
 * 地图 POI 的地址格式并不保证规整，硬猜错了比留空更糟。
 */
function splitRegion(address) {
  var s = address || ''
  var out = { region: [], rest: s }
  var mProv = /^(.+?(?:省|自治区|特别行政区))/.exec(s)
  var prov = mProv ? mProv[1] : ''
  if (!prov) {
    var mMuni = /^(北京市|上海市|天津市|重庆市)/.exec(s)
    prov = mMuni ? mMuni[1] : ''
  }
  if (!prov) return out
  var rest = s.slice(prov.length)
  var mCity = /^(.+?(?:市|自治州|地区|盟))/.exec(rest)
  // 直辖市没有独立的市级名，省市同名
  var city = mCity ? mCity[1] : prov
  if (mCity) rest = rest.slice(city.length)
  var mDist = /^(.+?(?:区|县|市|旗))/.exec(rest)
  if (!mDist) return out
  rest = rest.slice(mDist[1].length)
  out.region = [prov, city, mDist[1]]
  out.rest = rest
  return out
}

Page({
  data: {
    id: null,
    // EXPRESS=全国邮寄（默认，行为与既有一致）；LOCAL=同城配送，必须地图选点
    channel: 'EXPRESS',
    form: {
      receiverName: '',
      receiverPhone: '',
      detail: '',
      isDefault: 0,
    },
    // 省市区三元组（picker mode="region"）；空数组 = 未选择，显示占位
    region: [],
    regionText: '',
    // ── 同城配送：地图选点结果 ──
    poiName: '',        // 地点名，如「丹桂小区」
    pickedAddress: '',  // 地图返回的完整地址，仅作展示
    latE6: null,        // GCJ-02 微度，与服务端 Address.latE6 一致
    lngE6: null,
    locating: false,
    // 报价条：距离 / 配送费 / 是否超范围
    quoteText: '',
    quoteOk: true,
    saving: false,
  },

  onLoad(options) {
    var channel = options.channel === 'LOCAL' ? 'LOCAL' : 'EXPRESS'
    this.setData({ channel: channel })
    if (options.id) {
      this.setData({ id: Number(options.id) })
      wx.setNavigationBarTitle({ title: '编辑地址' })
      this.loadAddress(Number(options.id))
    } else {
      wx.setNavigationBarTitle({ title: channel === 'LOCAL' ? '新增收货地址' : '新增地址' })
    }
  },

  loadAddress(id) {
    var self = this
    getAddresses().then(function(list) {
      var addr = list.find(function(a) { return a.id === id })
      if (!addr) return
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
        poiName: addr.poiName || '',
        pickedAddress: addr.poiName ? region.join('') + (addr.detail || '') : '',
        latE6: addr.latE6 === undefined ? null : addr.latE6,
        lngE6: addr.lngE6 === undefined ? null : addr.lngE6,
      })
      self.refreshQuote()
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

  // ── 同城配送：在地图上选择收货位置 ──────────────────────────
  // 取消（cancel）静默返回；拒绝授权引导去设置。两者的 errMsg 不同，
  // 不区分的话顾客每次点「取消」都会被弹一次「请去设置」，很烦。
  onPickLocation() {
    if (this.data.locating) return
    var self = this
    this.setData({ locating: true })
    wx.chooseLocation({
      success(res) {
        var parsed = splitRegion(res.address)
        var patch = {
          poiName: res.name || res.address || '',
          pickedAddress: res.address || '',
          latE6: Math.round(res.latitude * 1e6),
          lngE6: Math.round(res.longitude * 1e6),
        }
        if (parsed.region.length === 3) {
          patch.region = parsed.region
          patch.regionText = parsed.region.join(' / ')
        }
        // 详细地址预填成「路名门牌」，顾客补上楼栋单元即可；已填过则不覆盖
        if (!self.data.form.detail && parsed.rest) {
          patch['form.detail'] = parsed.rest
        }
        self.setData(patch)
        self.refreshQuote()
      },
      fail(err) {
        var msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') !== -1) return
        if (msg.indexOf('auth deny') !== -1 || msg.indexOf('auth denied') !== -1 || msg.indexOf('authorize') !== -1) {
          wx.showModal({
            title: '需要位置权限',
            content: '选择收货位置需要使用地图，请在设置中允许「位置信息」后重试',
            confirmText: '去设置',
            success(r) { if (r.confirm) wx.openSetting() },
          })
          return
        }
        wx.showToast({ title: '地图打开失败，请稍后重试', icon: 'none' })
      },
      complete() {
        self.setData({ locating: false })
      },
    })
  },

  /**
   * 拉取配送报价（距离 / 运费 / 是否超范围）。
   *
   * 这里直连 wx.request 而不是 utils/request：报价失败（网络抖动、接口未部署）
   * 不该打断顾客填地址，静默隐藏运费条就行，而 utils/request 会统一弹 toast。
   * 距离与运费一律以服务端为准，前端不复刻算法（邮寄运费两端各写一遍的教训）。
   */
  refreshQuote() {
    var self = this
    if (this.data.channel !== 'LOCAL' || this.data.latE6 === null) return
    var token = wx.getStorageSync('token')
    wx.request({
      url: baseURL + '/local/quote',
      method: 'POST',
      header: token
        ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }
        : { 'Content-Type': 'application/json' },
      data: { latE6: this.data.latE6, lngE6: this.data.lngE6 },
      success(res) {
        var body = res.data
        if (!body || body.code !== 0 || !body.data) {
          self.setData({ quoteText: '' })
          return
        }
        var q = body.data
        var km = (q.distanceM / 1000).toFixed(1)
        if (!q.inRange) {
          self.setData({
            quoteOk: false,
            quoteText: '超出配送范围（约 ' + km + ' km），可换个地址，或改用全国邮寄',
          })
          return
        }
        var text = '距门店约 ' + km + ' km · 配送费 ¥' + (q.fee / 100).toFixed(2)
        if (q.estimatedMinutes) text += ' · 约 ' + q.estimatedMinutes + ' 分钟送达'
        self.setData({ quoteOk: true, quoteText: text })
      },
      fail() {
        self.setData({ quoteText: '' })
      },
    })
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
    var isLocal = this.data.channel === 'LOCAL'

    if (isLocal && this.data.latE6 === null) {
      wx.showToast({ title: '请先在地图上选择收货位置', icon: 'none' })
      return
    }
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
    // 坐标成对提交（服务端要求非此即彼）；邮寄地址不带坐标，行为与既有一致
    if (this.data.latE6 !== null && this.data.lngE6 !== null) {
      payload.latE6 = this.data.latE6
      payload.lngE6 = this.data.lngE6
      payload.poiName = this.data.poiName || null
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
