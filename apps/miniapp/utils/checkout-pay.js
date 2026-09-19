// 金额组合与封顶唯一入口；满减金额只取服务端响应，不在客户端取档。
function composePay(i) {
  var subtotal = i.subtotal || 0
  var pickup = Math.min(Math.max(0, i.pickupDiscount || 0), subtotal)
  var promo = Math.min(Math.max(0, i.promoFen || 0), subtotal - pickup)
  var coupon = Math.min(Math.max(0, i.couponDiscount || 0), subtotal - pickup - promo)
  return {
    pickupDiscount: pickup,
    promoDiscount: promo,
    couponDiscount: coupon,
    totalCut: pickup + promo + coupon,
    payAmount: subtotal - pickup - promo - coupon + (i.shippingFee || 0) + (i.packingFee || 0),
  }
}
module.exports = { composePay: composePay }
