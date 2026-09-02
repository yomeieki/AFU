/**
 * 通知通道自检：验证 .env 里的「新订单推送」与「系统告警」能真的推到店员手机上。
 *
 * 零依赖（只用 node 内置 fetch），不需要 npm install、不需要重启服务。
 *
 * 会真的往群里发两条测试消息（内容标注了「测试」），店员手机会响，
 * 这正是要验证的东西 —— 跑之前先跟店里说一声。
 *
 * 用法（服务器上）：
 *   node /www/food-shop/apps/server/scripts/check-notify.mjs
 *   ENV_FILE=/path/to/.env node scripts/check-notify.mjs
 *
 * 为什么不能只看 HTTP 200：企微机器人 key 写错时照样返回 200，
 * 真正的结果在响应体 errcode 里（93000 = key 无效）。PushPlus 同理看 code。
 */
import fs from 'node:fs'

const ENV_FILE = process.env.ENV_FILE ?? '/www/food-shop/apps/server/.env'

function readEnv(file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
  return out
}

const env = readEnv(ENV_FILE)
const ORDER_WECOM = env.ORDER_NOTIFY_WECOM_WEBHOOK || ''
const ALERT_WECOM = env.SYSTEM_ALERT_WECOM_WEBHOOK || ''
const PUSHPLUS = env.ORDER_NOTIFY_PUSHPLUS_TOKEN || ''
const PUSHPLUS_TOPIC = env.ORDER_NOTIFY_PUSHPLUS_TOPIC || ''

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ✔ ${m}`) }
const no = (m, extra) => { fail++; console.log(`  ✘ ${m}`); if (extra) console.log(`      ${String(extra).slice(0, 300)}`) }
const skip = (m) => console.log(`  ○ ${m}`)

const now = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })

/** 企微机器人：HTTP 200 不代表成功，要看 errcode */
async function sendWecom(webhook, content, label) {
  if (!/^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=/.test(webhook)) {
    no(`${label}：webhook 地址格式不对`, '应形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx')
    return
  }
  try {
    const resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
    })
    const body = await resp.json().catch(() => ({}))
    if (body.errcode === 0) {
      ok(`${label}：已推送，请到群里确认收到`)
    } else if (body.errcode === 93000) {
      no(`${label}：机器人 key 无效（errcode 93000）`, '机器人可能已被删除，或 webhook 复制时截断了')
    } else {
      no(`${label}：企微返回 errcode ${body.errcode}`, body.errmsg)
    }
  } catch (e) {
    no(`${label}：请求失败（网络/DNS）`, e.message)
  }
}

async function sendPushplus(token, title, content, topic) {
  const body = { token, title, content, template: 'markdown' }
  if (topic) body.topic = topic
  try {
    const resp = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.json().catch(() => ({}))
    if (data.code === 200) {
      ok(`PushPlus：已推送${topic ? `（群组 ${topic}）` : ''}，请在微信里确认收到`)
    } else {
      no(`PushPlus：返回 code ${data.code}`, data.msg)
    }
  } catch (e) {
    no('PushPlus：请求失败（网络/DNS）', e.message)
  }
}

console.log(`配置文件：${ENV_FILE}`)
console.log(`新订单-企微：${ORDER_WECOM ? '已配置' : '未配置'}`)
console.log(`系统告警-企微：${ALERT_WECOM ? '已配置' : `未配置${ORDER_WECOM ? '（将回退到新订单群）' : ''}`}`)
console.log(`PushPlus：${PUSHPLUS ? '已配置' : '未配置'}`)
console.log('')

if (!ORDER_WECOM && !PUSHPLUS) {
  console.log('  ✘ 新订单推送一个通道都没配 —— 顾客付款后店员不会收到任何提醒')
  console.log('     用 bash /www/food-shop/scripts/set-env.sh ORDER_NOTIFY_WECOM_WEBHOOK 填写')
  process.exit(1)
}

// 1. 新订单推送（内容照抄真实模板，好确认排版）
const orderContent = [
  '**🔔 新订单待发货**（这是一条测试消息）',
  '订单号：TEST00000000000000',
  '金额：**¥0.01**',
  '- 招牌猪头肉（半斤装）× 1',
  '收货人：测试 138****0000',
  `时间：${now}`,
].join('\n')

if (ORDER_WECOM) await sendWecom(ORDER_WECOM, orderContent, '新订单推送')
else skip('新订单-企微：未配置，跳过')

if (PUSHPLUS) await sendPushplus(PUSHPLUS, '新订单 ¥0.01（测试）', orderContent, PUSHPLUS_TOPIC)
else skip('PushPlus：未配置，跳过')

// 2. 系统告警（真实告警走的就是这条路：SYSTEM_ALERT 优先，否则回退订单群）
const alertWebhook = ALERT_WECOM || ORDER_WECOM
const alertContent = [
  '**【阿福凉菜-告警】通道自检**（这是一条测试消息）',
  '> 这条消息说明服务出故障时你能第一时间收到',
  '> 真实告警包括：接口 500、退款异常、进程崩溃重启',
  `环境：production　时间：${now}`,
].join('\n')

if (alertWebhook) {
  if (!ALERT_WECOM) skip('系统告警：未单独配置，回退到新订单群（可用，但建议单独建告警群）')
  if (ALERT_WECOM && ALERT_WECOM === ORDER_WECOM) {
    skip('系统告警：与新订单用了同一个群（告警会混在订单里，容易被忽略）')
  }
  await sendWecom(alertWebhook, alertContent, '系统告警')
} else {
  no('系统告警：无可用 webhook')
}

console.log('')
console.log(`================ 通过 ${pass} / 失败 ${fail} ================`)
if (fail === 0) {
  console.log('通道已通。接下来确认三件事：')
  console.log('  1. 店员手机上收到了消息（不是只有你自己看到）')
  console.log('  2. 群里每个店员都开着「消息提醒」，别设成免打扰')
  console.log('  3. 改完 .env 记得 pm2 restart food-shop-server 让服务读到新值')
}
process.exit(fail === 0 ? 0 : 1)
