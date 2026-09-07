/**
 * 小程序订阅消息（一次性模板）：发货通知 / 退款通知。
 *
 * 顾客在小程序支付前调用 wx.requestSubscribeMessage 授权一次，每个模板可发一条。
 * 模板由用户在公众平台「订阅消息」选公共模板，字段 key（如 character_string1/thing2/amount3）因模板而异，
 * 因此通过 env 做「本系统字段 → 模板字段」映射：
 *   WECHAT_TMPL_SHIP=xxx
 *   WECHAT_TMPL_SHIP_FIELDS=orderNo=character_string1,expressCompany=thing2,expressNo=character_string3,time=time4
 *   WECHAT_TMPL_REFUND=yyy
 *   WECHAT_TMPL_REFUND_FIELDS=orderNo=character_string1,amount=amount2,reason=thing3,time=time4
 *
 * 可用字段：
 *   下单/付款成功：orderNo / amount / time / shopName / deliveryType / address / productName / receiverName
 *   发货：orderNo / expressCompany / expressNo / productName / time / remark
 *   退款：orderNo / amount / reason / note（「退款已受理：原因」≤20 字）/ productName / time
 * 值按微信类型限制自动截断（thing ≤20 字、character_string ≤32、name ≤10、phrase ≤5）。
 * 全部 fire-and-forget：未配置模板/用户未授权（43101）/token 失败都只 warn，绝不影响主流程。
 */
import { config } from '../config'
import { getAccessToken, invalidateAccessToken, isWechatApiConfigured } from './wechat-access-token'

type FieldMap = Record<string, string> // ourKey -> templateKey

function parseFieldMap(spec: string): FieldMap {
  const map: FieldMap = {}
  for (const pair of spec.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim())
    if (k && v) map[k] = v
  }
  return map
}

function limitFor(templateKey: string): number {
  if (templateKey.startsWith('thing')) return 20
  if (templateKey.startsWith('character_string')) return 32
  if (templateKey.startsWith('name')) return 10
  if (templateKey.startsWith('phrase')) return 5
  return 0
}

function clip(value: string, templateKey: string): string {
  const max = limitFor(templateKey)
  if (!max) return value
  const chars = Array.from(value)
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : value
}

function fmtTime(d: Date): string {
  return d.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).replace(/\//g, '-')
}

function buildData(values: Record<string, string>, fields: FieldMap): Record<string, { value: string }> | null {
  const data: Record<string, { value: string }> = {}
  for (const [ourKey, tmplKey] of Object.entries(fields)) {
    const v = values[ourKey]
    if (v === undefined || v === '') continue
    data[tmplKey] = { value: clip(v, tmplKey) }
  }
  return Object.keys(data).length > 0 ? data : null
}

// A9：全部 fire-and-forget，本来就不该让一条卡住的请求占着连接——之前裸 fetch 无超时，
// 对端不响应时会一直挂着（虽然不影响主流程，但每挂一条就多攒一个悬空 socket）。
const SUBSCRIBE_TIMEOUT_MS = 10000

async function send(openid: string, templateId: string, page: string, data: Record<string, { value: string }>, label: string) {
  if (!isWechatApiConfigured()) return
  try {
    const token = await getAccessToken()
    let resp: Response
    try {
      resp = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ touser: openid, template_id: templateId, page, data, miniprogram_state: 'formal', lang: 'zh_CN' }),
        signal: AbortSignal.timeout(SUBSCRIBE_TIMEOUT_MS),
      })
    } catch (e) {
      const err = e as Error
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new Error(`订阅消息请求超时（${SUBSCRIBE_TIMEOUT_MS}ms）: ${err.message}`)
      }
      throw err
    }
    const body = (await resp.json()) as { errcode?: number; errmsg?: string }
    if (body.errcode && body.errcode !== 0) {
      if ([40001, 40014, 42001].includes(body.errcode)) invalidateAccessToken()
      // 43101 用户拒绝/未授权 属正常情况（小程序未弹授权或用户点了拒绝），记 info 便于排查
      if (body.errcode === 43101) console.log(`[subscribe] ${label} 未发送：用户未授权该模板`)
      else console.warn(`[subscribe] ${label} 发送失败 ${body.errcode}: ${body.errmsg}`)
    } else {
      console.log(`[subscribe] ${label} 已发送`)
    }
  } catch (e) {
    console.warn(`[subscribe] ${label} 请求失败:`, (e as Error).message)
  }
}

/** 付款成功通知（mock 支付与微信回调两处调用） */
export function sendPaidSubscribeMessage(
  openid: string,
  order: {
    id: number
    orderNo: string
    actualAmount: number
    paidAt?: Date | null
    deliveryType?: string
    receiverName?: string
    receiverFullAddress?: string
  },
  productName?: string
): void {
  const { paidTemplateId, paidFields } = config.subscribe
  if (!paidTemplateId || !paidFields) return
  const deliveryLabel: Record<string, string> = { EXPRESS: '快递发货', LOCAL: '同城配送', PICKUP: '到店自取' }
  const data = buildData(
    {
      orderNo: order.orderNo,
      amount: `¥${(order.actualAmount / 100).toFixed(2)}`,
      time: fmtTime(order.paidAt ?? new Date()),
      shopName: '阿福凉菜',
      deliveryType: deliveryLabel[order.deliveryType ?? ''] ?? '快递发货',
      address: order.receiverFullAddress ?? '',
      receiverName: order.receiverName ?? '',
      productName: productName ?? '',
    },
    parseFieldMap(paidFields)
  )
  if (!data) return
  void send(openid, paidTemplateId, `pages/order/detail?id=${order.id}`, data, '下单成功通知')
}

export function sendShipSubscribeMessage(
  openid: string,
  order: { id: number; orderNo: string },
  shipment: { expressCompany?: string | null; expressNo?: string | null; remark?: string | null; shippedAt?: Date | null },
  productName?: string
): void {
  const { shipTemplateId, shipFields } = config.subscribe
  if (!shipTemplateId || !shipFields) return
  const data = buildData(
    {
      orderNo: order.orderNo,
      expressCompany: shipment.expressCompany ?? '',
      expressNo: shipment.expressNo ?? '',
      productName: productName ?? '',
      time: fmtTime(shipment.shippedAt ?? new Date()),
      remark: shipment.remark || '您的订单已发出，请注意查收',
    },
    parseFieldMap(shipFields)
  )
  if (!data) return
  void send(openid, shipTemplateId, `pages/order/detail?id=${order.id}`, data, '发货通知')
}

export function sendRefundSubscribeMessage(
  openid: string,
  order: { id: number; orderNo: string; cancelReason?: string | null },
  refund: { amount: number; reason?: string | null; successTime?: Date | null },
  productName?: string
): void {
  const { refundTemplateId, refundFields } = config.subscribe
  if (!refundTemplateId || !refundFields) return
  const data = buildData(
    {
      orderNo: order.orderNo,
      amount: `¥${(refund.amount / 100).toFixed(2)}`,
      reason: refund.reason || order.cancelReason || '商家退款',
      note: `已原路退回微信：${refund.reason || order.cancelReason || '商家退款'}`,
      productName: productName ?? '',
      time: fmtTime(refund.successTime ?? new Date()),
    },
    parseFieldMap(refundFields)
  )
  if (!data) return
  void send(openid, refundTemplateId, `pages/order/detail?id=${order.id}`, data, '退款通知')
}

/** 配送通知（快递100 回调 310：骑手已取货出发）。模板字段见 .env WECHAT_TMPL_DELIVER_FIELDS */
/**
 * 「预计到达」的取数。这条通知在 `310`（骑手已取货）时发出。
 *
 * 快递100 **不提供预计送达时间**（调研文档 §6：接口不返回，旧版的 `predictDeliveryTime`
 * 已经拿掉了）。它给的是**真实道路距离**，所以时间只能由我们自己换算：距离 ÷ 骑行均速。
 *
 * 这一刻骑手刚拿到货，**剩下的只有路上那一段，备餐已经结束了**——所以这里
 * **不再叠加备餐时间**，只算路程。这也是它与订单上 `estimatedDeliveryAt` 的区别：
 * 那个是接单时算的「备餐 + 路上」，此刻只剩后半段。
 *
 * 取两者里**更晚**的一个：接单时那个承诺已经发给顾客了，此刻若算出更早的时间就等于
 * 悄悄提前了承诺，顾客反而会觉得晚了。报晚了是惊喜，报早了是投诉。
 */
async function estimateArrival(order: { estimatedDeliveryAt?: Date | null }, providerDistanceM?: number | null): Promise<Date> {
  const now = Date.now()
  // 拿不到距离时退回固定 30 分钟——这是本函数唯一还留着魔数的分支，
  // 而它只在「配送单上没有 providerDistanceM」时才走到（下单超时留下的占位单等）。
  let byDistance = now + 30 * 60 * 1000
  if (providerDistanceM != null && providerDistanceM > 0) {
    const { getLocalSettings, rideMinutes } = await import('./local-settings')
    const s = await getLocalSettings()
    byDistance = now + rideMinutes(s, providerDistanceM) * 60 * 1000
  }
  const planned = order.estimatedDeliveryAt ? order.estimatedDeliveryAt.getTime() : 0
  return new Date(Math.max(byDistance, planned))
}

export function sendDeliverSubscribeMessage(
  openid: string,
  order: { id: number; orderNo: string; estimatedDeliveryAt?: Date | null },
  courier: { courierName?: string | null; courierMobile?: string | null; providerDistanceM?: number | null },
  productName?: string
): void {
  const { deliverTemplateId, deliverFields } = config.subscribe
  if (!deliverTemplateId || !deliverFields) return
  // fire-and-forget，与本函数其余部分一致：通知失败绝不能影响回调主流程
  void estimateArrival(order, courier.providerDistanceM).then((eta) => {
  const data = buildData(
    {
      orderNo: order.orderNo,
      productName: productName ?? '',
      courierName: courier.courierName || '配送员',
      courierMobile: courier.courierMobile ?? '',
      estimatedTime: fmtTime(eta),
    },
    parseFieldMap(deliverFields)
  )
    if (!data) return
    void send(openid, deliverTemplateId, `pages/order/detail?id=${order.id}`, data, '配送通知')
  }).catch((e) => {
    // send() 本身就是静默的（模板 ID/字段编号填错时顾客收不到、后台也不报错），
    // 至少别让「算 ETA 时抛了」这一步也无声无息。
    console.warn('[subscribe] 配送通知预计到达时间计算失败，本条未发出:', (e as Error)?.message ?? e)
  })
}

/** 供小程序读取：当前配置的模板 ID（顾客端 wx.requestSubscribeMessage 用） */
export function getSubscribeTemplateIds(): string[] {
  return [config.subscribe.paidTemplateId, config.subscribe.shipTemplateId, config.subscribe.refundTemplateId, config.subscribe.deliverTemplateId].filter(Boolean)
}
