/**
 * 通知通道自检：验证 .env 里的「新订单推送」与「系统告警」能真的推到手机上。
 *
 * 零依赖（只用 node 内置 fetch），不需要 npm install、不需要重启服务。
 *
 * 会真的发出测试消息（内容标注了「测试」）：
 *   · 订单推送 → 店员群（PushPlus 群组 / 企微群）
 *   · 系统告警 → 只发本人（PushPlus 不带 topic）
 * 跑之前先跟店里说一声，别让店员以为真来单了。
 *
 * 用法（服务器上）：
 *   node /www/food-shop/apps/server/scripts/check-notify.mjs
 *   ENV_FILE=/path/to/.env node scripts/check-notify.mjs
 *
 * 为什么不能只看 HTTP 200：两边接口失败时都返回 200，
 * 真正的结果在响应体里（企微看 errcode，PushPlus 看 code）。
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
const ORDER_PUSH = env.ORDER_NOTIFY_PUSHPLUS_TOKEN || ''
const ORDER_TOPIC = env.ORDER_NOTIFY_PUSHPLUS_TOPIC || ''
// 告警 token 缺省回退订单 token —— 与 services/notify.ts 的取值顺序保持一致
const ALERT_PUSH = env.SYSTEM_ALERT_PUSHPLUS_TOKEN || ORDER_PUSH

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ✔ ${m}`) }
const no = (m, extra) => { fail++; console.log(`  ✘ ${m}`); if (extra) console.log(`      ${String(extra).slice(0, 300)}`) }
const note = (m) => console.log(`  ○ ${m}`)

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
    if (body.errcode === 0) ok(`${label}：已推送，请到群里确认收到`)
    else if (body.errcode === 93000) no(`${label}：机器人 key 无效（errcode 93000）`, '机器人可能已被删除，或 webhook 复制时截断了')
    else no(`${label}：企微返回 errcode ${body.errcode}`, body.errmsg)
  } catch (e) {
    no(`${label}：请求失败（网络/DNS）`, e.message)
  }
}

/** PushPlus：code 200 才算成功；带 topic 发群组，不带 topic 只发 token 本人 */
async function sendPushplus(token, title, content, topic, label) {
  if (!/^[0-9a-f]{32}$/i.test(token)) {
    no(`${label}：token 格式不对（应为 32 位十六进制）`, `当前长度 ${token.length}，多半是复制时少了几位或带了空格`)
    return
  }
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
      ok(`${label}：已推送${topic ? `到群组「${topic}」` : '（一对一）'}，请在微信里确认收到`)
    } else if (data.code === 999) {
      no(`${label}：token 无效或已过期（code 999）`, data.msg)
    } else {
      no(`${label}：PushPlus 返回 code ${data.code}`, data.msg)
    }
  } catch (e) {
    no(`${label}：请求失败（网络/DNS）`, e.message)
  }
}

console.log(`配置文件：${ENV_FILE}`)
console.log(`订单-PushPlus：${ORDER_PUSH ? `已配置${ORDER_TOPIC ? `（群组 ${ORDER_TOPIC}）` : '（无群组，只推本人）'}` : '未配置'}`)
console.log(`告警-PushPlus：${ALERT_PUSH ? (env.SYSTEM_ALERT_PUSHPLUS_TOKEN ? '已配置（独立 token）' : '回退订单 token，一对一') : '未配置'}`)
console.log(`订单-企微：${ORDER_WECOM ? '已配置' : '未配置'}`)
console.log(`告警-企微：${ALERT_WECOM ? '已配置' : '未配置'}`)
console.log('')

if (!ORDER_WECOM && !ORDER_PUSH) {
  console.log('  ✘ 新订单推送一个通道都没配 —— 顾客付款后店员不会收到任何提醒')
  console.log('     用 bash /www/food-shop/scripts/set-env.sh ORDER_NOTIFY_PUSHPLUS_TOKEN 填写')
  process.exit(1)
}

// ── 1. 新订单推送（内容照抄真实模板，好确认排版）─────────────────────────────
const orderContent = [
  '**🔔 新订单待发货**（这是一条测试消息）',
  '订单号：TEST00000000000000',
  '金额：**¥0.01**',
  '- 招牌猪头肉（半斤装）× 1',
  '收货人：测试 138****0000',
  `时间：${now}`,
].join('\n')

if (ORDER_PUSH) {
  if (!ORDER_TOPIC) note('订单-PushPlus 未配群组编码：只有你本人会收到，店员收不到')
  await sendPushplus(ORDER_PUSH, '新订单 ¥0.01（测试）', orderContent, ORDER_TOPIC, '新订单推送')
} else note('订单-PushPlus：未配置，跳过')

if (ORDER_WECOM) await sendWecom(ORDER_WECOM, orderContent, '新订单推送-企微')
else note('订单-企微：未配置，跳过')

// ── 2. 系统告警（真实告警走的就是这条路）────────────────────────────────────
const alertContent = [
  '**【阿福凉菜-告警】通道自检**（这是一条测试消息）',
  '> 这条消息说明服务出故障时你能第一时间收到',
  '> 真实告警包括：接口 500、退款异常、进程崩溃重启、每日备份结果',
  `环境：production　时间：${now}`,
].join('\n')

if (ALERT_PUSH) {
  // 故意不传 topic：告警只推本人，不进店员群
  await sendPushplus(ALERT_PUSH, '【阿福凉菜-告警】通道自检', alertContent, undefined, '系统告警')
} else note('告警-PushPlus：未配置，跳过')

const alertWecom = ALERT_WECOM || ORDER_WECOM
if (alertWecom) {
  if (!ALERT_WECOM) note('告警-企微：未单独配置，回退到订单群')
  await sendWecom(alertWecom, alertContent, '系统告警-企微')
}

if (!ALERT_PUSH && !alertWecom) no('系统告警：无可用通道，告警只会写进 pm2 日志')

console.log('')
console.log(`================ 通过 ${pass} / 失败 ${fail} ================`)
if (fail === 0) {
  console.log('通道已通。接下来确认三件事（脚本验不了）：')
  console.log('  1. 店员手机上收到了订单那条（不是只有你自己收到 → 说明群组编码没生效）')
  console.log('  2. 告警那条只有你收到、店员没收到')
  console.log('  3. 改完 .env 已执行 pm2 restart food-shop-server，服务才读得到新值')
}
process.exit(fail === 0 ? 0 : 1)
