/**
 * COS 配置自检：验证 .env 里的 COS_* 能否真正上传，且对象能被匿名公开读取。
 *
 * 零依赖（只用 node 内置 crypto + fetch），因此**不需要先 npm install**，
 * 填完密钥就能立刻验，不必等部署。
 *
 * 用法（服务器上）：
 *   node /www/food-shop/apps/server/scripts/check-cos.mjs
 *   ENV_FILE=/path/to/.env node scripts/check-cos.mjs
 *
 * 会往桶里写一个固定 key `_healthcheck/cos-check.txt`（每次覆盖同一个对象，
 * 不会越堆越多），然后用小程序将来取图的那个公网 URL 匿名 GET 回来比对内容。
 */
import crypto from 'node:crypto'
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
const SECRET_ID = env.COS_SECRET_ID
const SECRET_KEY = env.COS_SECRET_KEY
const BUCKET = env.COS_BUCKET
const REGION = env.COS_REGION
const BASE_URL = (env.COS_BASE_URL || '').replace(/\/+$/, '')

const missing = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION'].filter((k) => !env[k])
if (missing.length) {
  console.error(`✘ ${ENV_FILE} 缺少：${missing.join(', ')}`)
  console.error(`  用 bash /www/food-shop/scripts/set-env.sh <KEY> 填写。`)
  process.exit(1)
}

const HOST = `${BUCKET}.cos.${REGION}.myqcloud.com`
const PUBLIC_BASE = BASE_URL || `https://${HOST}`
const KEY = '_healthcheck/cos-check.txt'
const BODY = `afu-images cos healthcheck ${new Date().toISOString()}\n`

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex')
const hmac = (k, s) => crypto.createHmac('sha1', k).update(s).digest('hex')
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** COS 请求签名（q-sign-algorithm=sha1），见腾讯云「请求签名」文档 */
function authorization(method, pathname, headers) {
  const now = Math.floor(Date.now() / 1000)
  const keyTime = `${now - 60};${now + 600}`
  const signKey = hmac(SECRET_KEY, keyTime)
  const keys = Object.keys(headers).map((k) => k.toLowerCase()).sort()
  const map = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const headerList = keys.join(';')
  const headerString = keys.map((k) => `${enc(k)}=${enc(String(map[k]))}`).join('&')
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${headerString}\n`
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`
  return `q-sign-algorithm=sha1&q-ak=${SECRET_ID}&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
         `&q-header-list=${headerList}&q-url-param-list=&q-signature=${hmac(signKey, stringToSign)}`
}

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  ✔ ${m}`) }
const no = (m, extra) => { fail++; console.log(`  ✘ ${m}`); if (extra) console.log(`      ${String(extra).slice(0, 300)}`) }

console.log(`配置文件：${ENV_FILE}`)
console.log(`存储桶　：${BUCKET}（${REGION}）`)
console.log(`公网前缀：${PUBLIC_BASE}${BASE_URL ? '' : '（未配 COS_BASE_URL，用桶默认域名）'}`)
console.log('')

// 1. 带签名上传
//    只签 host：Node 的 fetch 会把字符串 body 的 content-type 自动改成
//    "text/plain;charset=UTF-8"，若把 content-type 也纳入签名，签的和发的不一致
//    会得到 SignatureDoesNotMatch。COS 允许只签 host。
const pathname = `/${KEY}`
const signedHeaders = { host: HOST }
const auth = authorization('PUT', pathname, signedHeaders)
let resp
try {
  resp = await fetch(`https://${HOST}${pathname}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain', Authorization: auth },
    body: BODY,
  })
} catch (e) {
  no('上传请求发送失败（网络/DNS）', e.message)
}
if (resp) {
  if (resp.ok) {
    ok(`上传成功（密钥有效、策略允许 PutObject）`)
  } else {
    const t = await resp.text()
    no(`上传失败 HTTP ${resp.status}`, t)
    if (/AccessDenied/.test(t)) console.log('      → 多半是 CAM 策略没覆盖这个桶，或密钥属于别的子用户')
    if (/InvalidAccessKeyId|SignatureDoesNotMatch/.test(t)) console.log('      → SecretId/SecretKey 填错了')
  }
}

// 2. 匿名公开读取（小程序取图走的就是这条路）
try {
  const pub = await fetch(`${PUBLIC_BASE}/${KEY}`, { headers: { 'Cache-Control': 'no-cache' } })
  if (!pub.ok) {
    no(`匿名读取失败 HTTP ${pub.status}`, await pub.text())
    console.log('      → 桶的访问权限可能不是「公有读私有写」，小程序会看不到图片')
  } else {
    const text = await pub.text()
    if (text === BODY) ok('匿名公开读取成功，且内容一致（小程序能正常取图）')
    else no('匿名读到了内容但与刚上传的不一致（可能是 CDN 缓存）', text.slice(0, 80))
    const ct = pub.headers.get('content-type')
    ct && ct.includes('text/plain') ? ok(`Content-Type 正确（${ct}）`) : no(`Content-Type 异常：${ct}`)
  }
} catch (e) {
  no('匿名读取请求失败', e.message)
}

console.log('')
console.log(`================ 通过 ${pass} / 失败 ${fail} ================`)
if (fail === 0) {
  console.log('COS 已就绪。提醒：把下面这个域名加进微信公众平台的 downloadFile 合法域名：')
  console.log(`  ${PUBLIC_BASE}`)
}
process.exit(fail === 0 ? 0 : 1)
