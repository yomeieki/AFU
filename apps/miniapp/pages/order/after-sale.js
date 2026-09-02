const { getOrderDetail, applyAfterSale, uploadImage } = require('../../api/order')
const { formatPrice } = require('../../utils/format')

var REASONS = [
  { value: 'SHORTAGE', label: '少发/漏发' },
  { value: 'WRONG', label: '错发' },
  { value: 'DAMAGED', label: '变质/破损' },
  { value: 'OTHER', label: '其他' },
]
var MAX_IMAGES = 3
var MAX_DESC = 200

var imageSeq = 0

Page({
  data: {
    orderId: null,
    order: null,          // 摘要：orderNo / firstItemName / firstItemQty / itemCount / actualAmountText
    loading: true,
    reasons: REASONS,
    reason: '',
    description: '',
    descLength: 0,
    maxDesc: MAX_DESC,
    maxImages: MAX_IMAGES,
    // [{ key, localPath, url, uploading }]
    images: [],
    canAddImage: true,
    submitting: false,
  },

  onLoad(options) {
    var id = options.id
    if (!id) {
      wx.showToast({ title: '订单不存在', icon: 'none' })
      setTimeout(function() { wx.navigateBack() }, 1500)
      return
    }
    this.setData({ orderId: id })
    this.loadOrder(id)
  },

  loadOrder(id) {
    var self = this
    wx.showLoading({ title: '加载中...' })
    getOrderDetail(id)
      .then(function(order) {
        wx.hideLoading()
        var items = order.items || []
        var first = items[0] || {}
        self.setData({
          order: {
            id: order.id,
            orderNo: order.orderNo,
            firstItemName: first.productName || '',
            firstItemSpec: first.specText || '',
            firstItemQty: first.quantity || 0,
            itemCount: items.length,
            hasMoreItems: items.length > 1,
            actualAmountText: formatPrice(order.actualAmount),
          },
          loading: false,
        })
      })
      .catch(function() {
        wx.hideLoading()
        self.setData({ loading: false })
        setTimeout(function() { wx.navigateBack() }, 1500)
      })
  },

  onSelectReason(e) {
    this.setData({ reason: e.currentTarget.dataset.value })
  },

  onDescInput(e) {
    var v = e.detail.value || ''
    this.setData({ description: v, descLength: v.length })
  },

  // 选图后立即逐张上传；每张带独立上传中遮罩，失败则移除并提示
  onChooseImage() {
    var self = this
    var remain = MAX_IMAGES - this.data.images.length
    if (remain <= 0) return
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success(res) {
        var files = (res.tempFiles || []).slice(0, remain)
        if (!files.length) return
        var added = files.map(function(f) {
          return { key: 'img' + (++imageSeq), localPath: f.tempFilePath, url: '', uploading: true }
        })
        self.setImages(self.data.images.concat(added))
        added.forEach(function(img) { self.uploadOne(img) })
      },
      fail() {
        // 用户取消：静默
      },
    })
  },

  uploadOne(img) {
    var self = this
    uploadImage(img.localPath)
      .then(function(url) {
        self.patchImage(img.key, { url: url, uploading: false })
      })
      .catch(function() {
        // uploadImage 已 toast 错误；移除该图，用户可重选
        self.removeImageByKey(img.key)
      })
  },

  patchImage(key, patch) {
    var images = this.data.images
    for (var i = 0; i < images.length; i++) {
      if (images[i].key === key) {
        var update = {}
        Object.keys(patch).forEach(function(k) {
          update['images[' + i + '].' + k] = patch[k]
        })
        this.setData(update)
        return
      }
    }
    // 已被用户移除：忽略上传结果
  },

  removeImageByKey(key) {
    var images = this.data.images.filter(function(it) { return it.key !== key })
    this.setImages(images)
  },

  // images 变更统一入口：同步「还能不能再加图」标记（wxml 内避免写 < 比较）
  setImages(images) {
    this.setData({ images: images, canAddImage: images.length < MAX_IMAGES })
  },

  onRemoveImage(e) {
    this.removeImageByKey(e.currentTarget.dataset.key)
  },

  onPreviewImage(e) {
    var key = e.currentTarget.dataset.key
    var urls = []
    var current = ''
    this.data.images.forEach(function(it) {
      var src = it.url || it.localPath
      urls.push(src)
      if (it.key === key) current = src
    })
    if (!urls.length) return
    wx.previewImage({ current: current, urls: urls })
  },

  onSubmit() {
    if (this.data.submitting) return
    var reason = this.data.reason
    var description = (this.data.description || '').trim()
    if (!reason) { wx.showToast({ title: '请选择售后原因', icon: 'none' }); return }
    if (reason === 'OTHER' && !description) { wx.showToast({ title: '选择「其他」时请填写说明', icon: 'none' }); return }
    if (description.length > MAX_DESC) { wx.showToast({ title: '说明最多 ' + MAX_DESC + ' 字', icon: 'none' }); return }
    var uploading = this.data.images.some(function(it) { return it.uploading })
    if (uploading) { wx.showToast({ title: '图片上传中，请稍候', icon: 'none' }); return }

    var images = this.data.images
      .map(function(it) { return it.url })
      .filter(function(u) { return !!u })

    var self = this
    this.setData({ submitting: true })
    applyAfterSale(this.data.orderId, { reason: reason, description: description, images: images })
      .then(function() {
        wx.showToast({ title: '已提交，商家会尽快处理', icon: 'none', duration: 1500 })
        setTimeout(function() { wx.navigateBack() }, 1000)
      })
      .catch(function() {
        // request 工具已 toast 服务端 message；恢复按钮
        self.setData({ submitting: false })
      })
  },
})
