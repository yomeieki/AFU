/**
 * 微信支付商户凭证自检 —— 不花钱、不产生订单。
 *
 * 直接复用 dist 里已编译的 generateWxPayAuthorization（与下单/退款走同一套签名代码），
 * 调两个只读接口，把"商户号 + 证书序列号 + 商户私钥 + APIv3 密钥"这一组配对验穿：
 *
 *   1. GET /v3/certificates                       —— 通用鉴权校验
 *   2. GET /v3/refund/domestic/refunds/{不存在的单号} —— 退款接口路径的鉴权校验
 *      期望 404 RESOURCE_NOT_EXISTS：说明签名被接受，只是单号不存在。
 *
 * 401 SIGN_ERROR / NO_AUTH 才表示凭证有问题。
 *
 * 注意：本脚本**验不了 AppID 与商户号的关联关系**（那要真正下单才暴露），
 * 也验不了回调验签（那要微信真的回调过来）。
 *
 * 用法（服务器上）：
 *   node /www/food-shop/apps/server/scripts/check-wechat-pay.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SERVER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const ENV_FILE = process.env.ENV_FILE ?? path.join(SERVER_DIR, '.env')

// 把 .env 灌进 process.env —— dist 里的服务是直接读 process.env 的
if (!fs.existsSync(ENV_FILE)) {
  console.error(`✘ 找不到 ${ENV_FILE}`)
  process.exit(1)
}
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
  if (m) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
}

const DIST = path.join(SERVER_DIR, 'dist', 'services', 'wechat-pay.js')
if (!fs.existsSync(DIST)) {
  console.error(`✘ 找不到 ${DIST}，请先 npm run build`)
  process.exit(1)
}
const { generateWxPayAuthorization } = require(DIST)

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ✔ ${m}`) }
const no = (m, extra) => { fail++; console.log(`  ✘ ${m}`); if (extra) console.log(`      ${String(extra).slice(0, 400)}`) }

console.log(`商户号　　：${process.env.WECHAT_MCH_ID}`)
console.log(`证书序列号：${process.env.WECHAT_PAY_SERIAL_NO}`)
console.log(`小程序 AppID：${process.env.WECHAT_APP_ID}`)
console.log('')

async function callGet(url, label) {
  let auth
  try {
    auth = generateWxPayAuthorization('GET', url, '')
  } catch (e) {
    no(`${label}：构造签名失败`, e.message)
    return null
  }
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: auth, 'User-Agent': 'afu-liangcai-selfcheck/1.0' },
    })
    const text = await resp.text()
    let body = {}
    try { body = JSON.parse(text) } catch { /* 非 JSON 原样看 */ }
    return { status: resp.status, code: body.code, message: body.message, text }
  } catch (e) {
    no(`${label}：请求失败（网络/DNS）`, e.message)
    return null
  }
}

// 1. 通用鉴权
const r1 = await callGet('https://api.mch.weixin.qq.com/v3/certificates', '平台证书接口')
if (r1) {
  if (r1.status === 200) ok('商户凭证有效（/v3/certificates 返回 200）')
  else if (r1.status === 401) no(`商户凭证被拒 401 ${r1.code}`, r1.message)
  else ok(`商户凭证被接受（HTTP ${r1.status} ${r1.code ?? ''}，非 401 即鉴权通过）`)
}

// 2. 退款接口路径鉴权（用一个必然不存在的单号）
const probe = `selfcheck_probe_${Date.now()}`
const r2 = await callGet(`https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/${probe}`, '退款查询接口')
if (r2) {
  if (r2.status === 401) {
    no(`退款接口鉴权失败 401 ${r2.code}`, r2.message)
  } else if (r2.status === 404 && r2.code === 'RESOURCE_NOT_EXISTS') {
    ok('退款接口鉴权通过（探针单号不存在，符合预期）')
  } else if (r2.status === 403 && r2.code === 'NO_AUTH') {
    no('退款接口无权限 403 NO_AUTH —— 商户号可能未开通退款权限', r2.message)
  } else {
    ok(`退款接口鉴权通过（HTTP ${r2.status} ${r2.code ?? ''}）`)
  }
}

console.log('')
console.log(`================ 通过 ${pass} / 失败 ${fail} ================`)
if (fail === 0) {
  console.log('商户号 + 序列号 + 私钥 + APIv3 密钥 这一组是对的。')
  console.log('')
  console.log('本脚本验不到的两件事，只能靠真机一分钱实测：')
  console.log('  · AppID 与商户号的关联（未关联时下单会报 APPID_MCHID_NOT_MATCH）')
  console.log('  · 回调验签（要微信真的回调过来才知道公钥配对是否正确）')
}
process.exit(fail === 0 ? 0 : 1)
