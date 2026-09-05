/**
 * 收货地址的展示形态。
 *
 * 同城单的省市恒定是门店所在地（本店：四川省自贡市），对店员、厨房、顾客都是已知信息，
 * 却要占掉 6 个字。这在两个地方是实打实的代价：
 *
 *   - 58mm 小票只有 32 列，砍掉省市等于多出小半行留给楼栋门牌；
 *   - 微信订阅消息的 `thing` 字段上限 20 字，且**截断是从尾部砍的**——
 *     传完整地址会保留顾客早就知道的省市区、砍掉真正有用的门牌号，
 *     「四川省自贡市自流井区丹桂大街12号阳光小区3栋2单元501」→「四川省自贡市自流井区丹桂大街12…」。
 *
 * 所以同城单一律从「区」起写。**区不能省**：配送范围可能跨区（自流井 / 大安 / 贡井），
 * 只写详细地址会出现两个区同名街道分不清的情况。
 *
 * 全国邮寄单不适用——那是真的要跨省，省市不能丢。
 */

type AddressParts = {
  receiverProvince?: string | null
  receiverCity?: string | null
  receiverDistrict?: string | null
  receiverDetail?: string | null
  receiverFullAddress?: string | null
}

/**
 * 同城单的短地址：区 + 详细地址。
 * 拆分字段缺失时回退到 `receiverFullAddress`（老订单或异常数据），保证永远有东西可显示。
 */
export function localShortAddress(o: AddressParts): string {
  const short = [o.receiverDistrict, o.receiverDetail].filter(Boolean).join('')
  return short || o.receiverFullAddress || ''
}

/**
 * 按渠道选地址形态：LOCAL 用短地址，EXPRESS 用完整地址。
 */
export function displayAddress(o: AddressParts, isLocal: boolean): string {
  return isLocal ? localShortAddress(o) : o.receiverFullAddress || ''
}
