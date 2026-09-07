// 同城「快速加购」的整条流程：拉详情 → 弹规格 → 加购 → 提示 → 告诉页面车变了。
//
// 抽成组件是因为主页和分类页都有「+」按钮。这段流程里有三处非直觉的处理，
// 各写一遍必然有一边漏掉，而漏掉的表现都是「顾客以为加上了，其实没有」：
//   ① 列表项只有 hasSkus、没有 skus/specDimensions——直接喂 sku-popup 会被当成
//      无规格商品，多规格商品加购时服务端必报 40001，顾客没有任何绕过路径；
//   ② 服务端叠加超库存会**静默按库存封顶**，一律弹「已加入」会骗人；
//   ③ 商品渠道由服务端按商品本身定，不是按页面定——邮寄商品从这里加购会落进邮寄车。
//
// 页面只需要：放一个 <local-sku-picker id="sku" bind:added="..."/>，
// 然后在「+」的处理里调 this.selectComponent('#sku').open(product)。

var getProductDetail = require('../../api/product').getProductDetail
var addToCart = require('../../api/cart').addToCart

Component({
  options: { addGlobalClass: true },
  data: {
    show: false,
    product: null,
  },
  methods: {
    /** @param {{id:number, stock:number}} product 列表项即可，规格由本组件自己去拉 */
    open: function(product) {
      if (!product || product.stock <= 0) return
      if (this._loading) return
      var self = this
      this._loading = true
      // 用导航栏 loading 而不是 wx.showLoading：后者会和请求层的错误 toast 抢同一个提示实例
      wx.showNavigationBarLoading()
      getProductDetail(product.id)
        .then(function(full) {
          self._loading = false
          wx.hideNavigationBarLoading()
          if (!full || full.status !== 'ON_SHELF') {
            wx.showToast({ title: '该商品已下架', icon: 'none' })
            return
          }
          self.setData({
            show: true,
            product: Object.assign({}, full, {
              skus: full.skus || [],
              specDimensions: full.specDimensions || [],
            }),
          })
        })
        .catch(function() {
          // 失败提示由统一请求层弹出；这里只放开重入
          self._loading = false
          wx.hideNavigationBarLoading()
        })
    },

    onClose: function() {
      this.setData({ show: false, product: null })
    },

    onConfirm: function(e) {
      if (this._adding) return
      var self = this
      var product = this.data.product
      if (!product) return
      this._adding = true
      addToCart(product.id, e.detail.quantity, e.detail.skuId)
        .then(function(result) {
          if (result && result.channel !== 'LOCAL') {
            wx.showToast({ title: '该商品不属于同城菜单', icon: 'none' })
            // 已经落进邮寄车了：让页面刷角标，别让角标与真实的车对不上
            self.triggerEvent('added', { channel: result.channel })
            self._adding = false
            return
          }
          self.onClose()
          if (result && result.capped) {
            var msg = result.added > 0
              ? '库存不足，本次加入 ' + result.added + ' 件，购物车内共 ' + result.quantity + ' 件'
              : '库存不足，购物车内已是最多 ' + result.quantity + ' 件'
            wx.showToast({ title: msg, icon: 'none' })
          } else {
            wx.showToast({ title: '已加入同城购物车', icon: 'none' })
          }
          self.triggerEvent('added', { channel: 'LOCAL' })
          self._adding = false
        })
        .catch(function() {
          self._adding = false
        })
    },
  },
})
