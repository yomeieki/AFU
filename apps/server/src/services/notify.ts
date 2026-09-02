/**
 * 通知公共层：企微机器人 / PushPlus 的 HTTP 投递 + 系统告警（带限频）。
 *
 * - postJson：fire-and-forget，失败 5 秒后重试一次，绝不 throw
 * - notifySystemAlert：系统级告警（500 / 进程异常 / 支付退款异常），
 *   同 key 在窗口期内只发一次（默认 5 分钟），防止告警风暴。
 *   告警投给所有已配置的渠道：
 *     · 企微：SYSTEM_ALERT_WECOM_WEBHOOK → 回退 ORDER_NOTIFY_WECOM_WEBHOOK
 *     · PushPlus：SYSTEM_ALERT_PUSHPLUS_TOKEN → 回退 ORDER_NOTIFY_PUSHPLUS_TOKEN
 *       **不带 topic**——告警只发给账号本人，不进店员群。店员看订单，老板看告警。
 */

const ALERT_WINDOW_MS = 5 * 60 * 1000
const MAX_TRACKED_KEYS = 500

interface AlertRecord {
  lastSentAt: number
  suppressed: number
}

const alertRecords = new Map<string, AlertRecord>()

export async function postJson(url: string, body: unknown, label: string, retried = false): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  } catch (e) {
    if (!retried) {
      setTimeout(() => {
        postJson(url, body, label, true).catch(() => undefined)
      }, 5000)
    } else {
      console.warn(`[notify] ${label} 推送失败（已重试）:`, (e as Error).message)
    }
  }
}

export function sendWecomMarkdown(webhook: string, content: string, label = '企微机器人'): void {
  void postJson(webhook, { msgtype: 'markdown', markdown: { content } }, label)
}

export function sendPushPlus(token: string, title: string, content: string, topic?: string): void {
  const body: Record<string, string> = { token, title, content, template: 'markdown' }
  if (topic) body.topic = topic
  void postJson('https://www.pushplus.plus/send', body, 'PushPlus')
}

function fmtNow(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
}

function pruneAlertRecords(now: number): void {
  if (alertRecords.size <= MAX_TRACKED_KEYS) return
  for (const [k, v] of alertRecords) {
    if (now - v.lastSentAt > ALERT_WINDOW_MS) alertRecords.delete(k)
  }
}

/**
 * 系统告警。不 await 也安全。
 * @param key 限频键，缺省用 title；同 key 在 windowMs 内只发一次，被抑制的次数会附在下次消息里
 */
export function notifySystemAlert(
  title: string,
  lines: string[],
  opts: { key?: string; windowMs?: number } = {}
): void {
  const key = opts.key ?? title
  const windowMs = opts.windowMs ?? ALERT_WINDOW_MS
  const now = Date.now()

  const record = alertRecords.get(key)
  if (record && now - record.lastSentAt < windowMs) {
    record.suppressed += 1
    return
  }
  const suppressed = record?.suppressed ?? 0
  alertRecords.set(key, { lastSentAt: now, suppressed: 0 })
  pruneAlertRecords(now)

  const env = process.env.NODE_ENV ?? 'development'
  const content = [
    `**【阿福凉菜-告警】${title}**`,
    ...lines.filter(Boolean).map((l) => `> ${l}`),
    suppressed > 0 ? `> （期间抑制 ${suppressed} 次同类告警）` : '',
    `环境：${env}　时间：${fmtNow()}`,
  ]
    .filter(Boolean)
    .join('\n')

  const webhook = process.env.SYSTEM_ALERT_WECOM_WEBHOOK || process.env.ORDER_NOTIFY_WECOM_WEBHOOK
  const pushplusToken = process.env.SYSTEM_ALERT_PUSHPLUS_TOKEN || process.env.ORDER_NOTIFY_PUSHPLUS_TOKEN
  if (!webhook && !pushplusToken) {
    console.error('[alert]', title, lines.join(' | '))
    return
  }
  if (webhook) sendWecomMarkdown(webhook, content, '系统告警')
  // 故意不传 topic：告警一对一推给账号本人
  if (pushplusToken) sendPushPlus(pushplusToken, `【阿福凉菜-告警】${title}`, content)
}
