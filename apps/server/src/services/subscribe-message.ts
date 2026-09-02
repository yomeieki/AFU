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
 *   发货：orderNo / expressCompany / expressNo / productName / time / remark
 *   退款：orderNo / amount / reason / productName / time
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

async function send(openid: string, templateId: string, page: string, data: Record<string, { value: string }>, label: string) {
  if (!isWechatApiConfigured()) return
  try {
    const token = await getAccessToken()
    const resp = await fetch(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ touser: openid, template_id: templateId, page, data, miniprogram_state: 'formal', lang: 'zh_CN' }),
    })
    const body = (await resp.json()) as { errcode?: number; errmsg?: string }
    if (body.errcode && body.errcode !== 0) {
      if ([40001, 40014, 42001].includes(body.errcode)) invalidateAccessToken()
      // 43101 用户拒绝/未授权 属正常情况，降噪
      if (body.errcode !== 43101) console.warn(`[subscribe] ${label} 发送失败 ${body.errcode}: ${body.errmsg}`)
    }
  } catch (e) {
    console.warn(`[subscribe] ${label} 请求失败:`, (e as Error).message)
  }
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
      productName: productName ?? '',
      time: fmtTime(refund.successTime ?? new Date()),
    },
    parseFieldMap(refundFields)
  )
  if (!data) return
  void send(openid, refundTemplateId, `pages/order/detail?id=${order.id}`, data, '退款通知')
}

/** 供小程序读取：当前配置的模板 ID（顾客端 wx.requestSubscribeMessage 用） */
export function getSubscribeTemplateIds(): string[] {
  return [config.subscribe.shipTemplateId, config.subscribe.refundTemplateId].filter(Boolean)
}
