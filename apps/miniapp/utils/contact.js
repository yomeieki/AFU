const shop = require('../config/shop')

// 一键拨打店铺客服电话（多处复用：我的页 / 订单详情 / 关于我们）
function callShop() {
  if (!shop.phone || shop.phone.indexOf('待填') !== -1) {
    wx.showToast({ title: '客服电话待配置', icon: 'none' })
    return
  }
  wx.makePhoneCall({ phoneNumber: shop.phone })
}

module.exports = { callShop }
