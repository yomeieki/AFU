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

/**
 * 坐标对应的「地址文字快照」，用于在 onSave 时判断坐标是否还新鲜。
 * 拼法必须和地图选点/服务端判断「文字是否变了」的字段口径一致：省市区 + 详细地址。
 */
function coordTextKey(region, detail) {
  return (region || []).join('/') + '|' + ((detail || '').trim())
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
    // 坐标写入时（loadAddress 读回 / onPickLocation 选点）对应的地址文字快照。
    // onSave 时若当前文字与快照不一致，说明顾客改了文字却没重新选点——见 onSave 里的判断。
    coordSnapshotText: null,
    // 上面那种「文字变了、坐标没跟着变」的状态，供 wxml 提前提示（不用等到点保存才发现）。
    coordStale: false,
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
      var hasCoord = addr.latE6 !== undefined && addr.latE6 !== null && addr.lngE6 !== undefined && addr.lngE6 !== null
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
        // 库里已有坐标时，把「当前坐标 = 库里读回的文字」记成快照；后面 onInput/
        // onRegionChange 改文字都不会跟着更新它，onSave 时用它判断坐标是否过期。
        // 不这样记的话，onSave 只判「坐标非空」就回传旧坐标，服务端 addresses.ts
        // 的 staleCoordPatch 永远判不到「文字变了」，顾客改门牌号/换小区后配送费
        // 和骑手目的地会一直按旧坐标算——这正是本次要修的问题。
        coordSnapshotText: hasCoord ? coordTextKey(region, addr.detail || '') : null,
        coordStale: false,
      })
      self.refreshQuote()
    })
  },

  // 文字改了但坐标没跟着变时，提前把 coordStale 置真，让 wxml 能在保存前就提示——
  // 不用等到点保存才用弹窗打断顾客。真正拦截回传坐标的判断仍在 onSave 里做一次。
  refreshCoordStale() {
    var snapshot = this.data.coordSnapshotText
    if (snapshot === null) { this.setData({ coordStale: false }); return }
    var current = coordTextKey(this.data.region, this.data.form.detail)
    this.setData({ coordStale: current !== snapshot })
  },

  onInput(e) {
    var field = e.currentTarget.dataset.field
    var update = {}
    update['form.' + field] = e.detail.value
    this.setData(update)
    if (field === 'detail') this.refreshCoordStale()
  },

  onRegionChange(e) {
    var region = e.detail.value || []
    this.setData({ region: region, regionText: region.join(' / ') })
    this.refreshCoordStale()
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
        // 重新选点=坐标与文字一起刷新，快照必须跟着这次的最终文字重记，否则
        // 选完点马上又会被判成「文字与快照不一致」（旧快照对应的是选点前的文字）。
        var resultRegion = patch.region || self.data.region
        var resultDetail = patch['form.detail'] !== undefined ? patch['form.detail'] : self.data.form.detail
        patch.coordSnapshotText = coordTextKey(resultRegion, resultDetail)
        patch.coordStale = false
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

  // 导入微信收货地址（只有用户主动取消才静默，其余一律给出可见反馈）
  //
  // 这个按钮在生产上曾长期是个死按钮：接口权限 2026-09-03 才开通，而在此之前
  // fail 分支只认「auth deny」一类文案，接口未开通/未声明返回的是别的错误，
  // 于是点了毫无反应、也没人报障（见 docs/wechat-platform-local-delivery-setup.md）。
  // 所以这里的默认分支必须是「说点什么」，而不是「什么都不说」。
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
        // 用户自己点「取消」——唯一该静默的情况
        if (msg.indexOf('cancel') !== -1) return
        if (msg.indexOf('auth deny') !== -1 || msg.indexOf('auth denied') !== -1 || msg.indexOf('authorize') !== -1) {
          wx.showToast({ title: '请在设置中允许获取地址', icon: 'none' })
          return
        }
        // 接口未开通、未在 app.json 声明、低版本基础库……顾客不需要知道是哪一种，
        // 但必须知道「这条路走不通，请改用手填」，否则会反复点同一个按钮。
        wx.showToast({ title: '无法读取微信地址，请手动填写', icon: 'none' })
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

    var hasCoord = this.data.latE6 !== null && this.data.lngE6 !== null
    // 坐标是否还对得上当前文字——对不上说明顾客改了省市区/详细地址却没重新选点。
    // 不拦这一下的话，下面会把（未变的）旧坐标当「新鲜坐标」原样回传，服务端
    // addresses.ts 的 coordProvided 恒为 true，「改了文字就清坐标」的防线形同虚设：
    // 顾客把「丹桂 3 栋」改成「城南某小区 8 栋」后，配送费和骑手目的地会一直按旧坐标算。
    var coordStale = hasCoord && this.data.coordSnapshotText !== coordTextKey(region, detail)

    if (coordStale) {
      var self = this
      wx.showModal({
        title: '地址文字已修改',
        content: '地址文字已修改，请重新在地图上选点，否则同城配送将无法报价',
        confirmText: '去选点',
        cancelText: '仍要保存',
        success: function(r) {
          if (r.confirm) {
            self.onPickLocation()
            return
          }
          // 顾客选「仍要保存」：不回传这份对不上文字的旧坐标，交给服务端按
          // 「文字变了 + 本次未带坐标」清空坐标（addresses.ts 的 staleCoordPatch）。
          // 这比带着错坐标保存安全——顾客下次同城下单会被 42223 挡住去补定位，
          // 好过悄悄按旧地点算运费、把骑手派到错误地址。
          self.doSave(name, phone, region, detail, form, false)
        },
      })
      return
    }

    this.doSave(name, phone, region, detail, form, hasCoord)
  },

  doSave(name, phone, region, detail, form, includeCoord) {
    var payload = {
      receiverName: name,
      receiverPhone: phone,
      province: region[0],
      city: region[1],
      district: region[2],
      detail: detail,
      isDefault: form.isDefault ? 1 : 0,
    }
    // 坐标成对提交（服务端要求非此即彼）；邮寄地址/坐标已判定过期时不带坐标，
    // 行为与既有一致（后者交给服务端 staleCoordPatch 清空）
    if (includeCoord) {
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
