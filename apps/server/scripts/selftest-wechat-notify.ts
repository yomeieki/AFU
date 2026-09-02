/**
 * 微信支付回调验签 / 退款回调 脱机自测（无需真实商户号）。
 *
 * 单元模式（默认）：
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/selftest-wechat-notify.ts
 *   - 生成一对 RSA 密钥模拟「微信平台」，写到 .selftest/（gitignore）
 *   - 公钥模式：验签通过 / 篡改 body 失败 / serial 不匹配失败 / 时间戳过期失败
 *   - 平台证书模式：用 openssl 自签 X509，按序列号命中验签通过
 *   - 商户侧签名：generateWxPayAuthorization 产出的签名能被同一公钥验证
 *
 * 集成模式（需后端已按 .selftest/env.sh 的变量启动，且 DB 可连）：
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/selftest-wechat-notify.ts --integration http://localhost:3100
 *   - 造一笔 PAID 订单 + PENDING Refund，POST 伪造的 REFUND.SUCCESS 回调 → 期望 SUCCESS 且订单 REFUNDED
 *   - 重放同一请求 → 仍 SUCCESS（幂等）；金额改小 → FAIL
 */
import 'dotenv/config'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const DIR = path.join(__dirname, '..', '.selftest')
fs.mkdirSync(DIR, { recursive: true })

const PUB_KEY_PATH = path.join(DIR, 'wx_pub_key.pem')
const PRIV_KEY_PATH = path.join(DIR, 'wx_priv_key.pem') // 模拟微信平台私钥（签回调）
const MCH_KEY_PATH = path.join(DIR, 'apiclient_key.pem') // 模拟商户私钥
const CERT_PATH = path.join(DIR, 'platform_cert.pem')
const API_V3_KEY = 'selftest_api_v3_key_32bytes_long!'.slice(0, 32)
const PUB_KEY_ID = 'PUB_KEY_ID_SELFTEST0001'

function ensureKeys() {
  if (!fs.existsSync(PUB_KEY_PATH) || !fs.existsSync(PRIV_KEY_PATH)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    fs.writeFileSync(PUB_KEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }))
    fs.writeFileSync(PRIV_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  }
  if (!fs.existsSync(MCH_KEY_PATH)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    fs.writeFileSync(MCH_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  }
  if (!fs.existsSync(CERT_PATH)) {
    // 用平台私钥自签一张 X509 证书（平台证书模式）
    execSync(
      `openssl req -x509 -new -key "${PRIV_KEY_PATH}" -days 3650 -subj "/CN=Tenpay.com selftest" -out "${CERT_PATH}" 2>/dev/null`
    )
  }
  fs.writeFileSync(
    path.join(DIR, 'env.sh'),
    [
      `export WECHAT_PAY_PUBLIC_KEY_PATH="${PUB_KEY_PATH}"`,
      `export WECHAT_PAY_PUBLIC_KEY_ID="${PUB_KEY_ID}"`,
      `export WECHAT_PAY_PLATFORM_CERT_PATH="${CERT_PATH}"`,
      `export WECHAT_PAY_PRIVATE_KEY_PATH="${MCH_KEY_PATH}"`,
      `export WECHAT_PAY_API_V3_KEY="${API_V3_KEY}"`,
      `export WECHAT_MCH_ID="1900000001"`,
      `export WECHAT_PAY_SERIAL_NO="SELFTESTMCHSERIAL"`,
      `export WECHAT_PAY_CERT_AUTO_DOWNLOAD="false"`,
      '',
    ].join('\n')
  )
}

function applyEnv() {
  process.env.WECHAT_PAY_PUBLIC_KEY_PATH = PUB_KEY_PATH
  process.env.WECHAT_PAY_PUBLIC_KEY_ID = PUB_KEY_ID
  process.env.WECHAT_PAY_PLATFORM_CERT_PATH = CERT_PATH
  process.env.WECHAT_PAY_PRIVATE_KEY_PATH = MCH_KEY_PATH
  process.env.WECHAT_PAY_API_V3_KEY = API_V3_KEY
  process.env.WECHAT_MCH_ID = '1900000001'
  process.env.WECHAT_PAY_SERIAL_NO = 'SELFTESTMCHSERIAL'
  process.env.WECHAT_PAY_CERT_AUTO_DOWNLOAD = 'false'
}

function encryptResource(plain: string) {
  const nonce = crypto.randomBytes(12).toString('hex').slice(0, 12)
  const aad = 'refund'
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY), nonce)
  cipher.setAAD(Buffer.from(aad))
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { algorithm: 'AEAD_AES_256_GCM', ciphertext: Buffer.concat([enc, tag]).toString('base64'), associated_data: aad, nonce }
}

function signBody(body: string, ts = String(Math.floor(Date.now() / 1000))) {
  const nonce = crypto.randomBytes(16).toString('hex')
  const message = `${ts}\n${nonce}\n${body}\n`
  const s = crypto.createSign('RSA-SHA256')
  s.update(message)
  const signature = s.sign(fs.readFileSync(PRIV_KEY_PATH, 'utf8'), 'base64')
  return { timestamp: ts, nonce, signature }
}

function buildRefundNotify(outRefundNo: string, amount: number, total: number) {
  const resource = encryptResource(
    JSON.stringify({
      mchid: '1900000001',
      out_trade_no: 'order_0_0',
      transaction_id: '4200000000000000000000000000',
      out_refund_no: outRefundNo,
      refund_id: '50000000000000000000000000',
      refund_status: 'SUCCESS',
      success_time: new Date().toISOString(),
      amount: { total, refund: amount, payer_total: total, payer_refund: amount },
    })
  )
  return JSON.stringify({
    id: crypto.randomUUID(),
    create_time: new Date().toISOString(),
    resource_type: 'encrypt-resource',
    event_type: 'REFUND.SUCCESS',
    summary: '退款成功',
    resource,
  })
}

let pass = 0
let fail = 0
function check(desc: string, cond: boolean, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${desc}`)
  } else {
    fail++
    console.log(`  ✘ ${desc} ${extra}`)
  }
}

async function unitTests() {
  applyEnv()
  const verify = await import('../src/services/wechat-pay-verify')
  const pay = await import('../src/services/wechat-pay')

  console.log('== 公钥模式 ==')
  const body = buildRefundNotify('refund_1_1', 100, 100)
  const h = signBody(body)
  const headers = (o: Record<string, string>) => ({
    'wechatpay-timestamp': o.timestamp,
    'wechatpay-nonce': o.nonce,
    'wechatpay-signature': o.signature,
    'wechatpay-serial': o.serial ?? PUB_KEY_ID,
  })
  let r = await verify.verifyWechatNotify(headers(h), body)
  check('正确签名通过', r.ok, JSON.stringify(r))
  r = await verify.verifyWechatNotify(headers(h), body.replace('REFUND.SUCCESS', 'REFUND.SUCCESX'))
  check('篡改 body 失败', !r.ok)
  r = await verify.verifyWechatNotify(headers({ ...h, serial: 'PUB_KEY_ID_OTHER' }), body)
  check('公钥 ID 不匹配失败', r.ok === false && r.reason.includes('公钥 ID'))
  const old = signBody(body, String(Math.floor(Date.now() / 1000) - 600))
  r = await verify.verifyWechatNotify(headers(old), body)
  check('时间戳过期失败', r.ok === false && r.reason.includes('时间戳'))
  r = await verify.verifyWechatNotify({ 'wechatpay-timestamp': h.timestamp } as never, body)
  check('缺头失败', !r.ok)

  console.log('== 平台证书模式 ==')
  verify._resetVerifyCache()
  const serial = new crypto.X509Certificate(fs.readFileSync(CERT_PATH)).serialNumber
  r = await verify.verifyWechatNotify(headers({ ...h, serial }), body)
  check(`证书序列号 ${serial.slice(0, 8)}… 命中并验签通过`, r.ok && r.mode === 'platform-cert', JSON.stringify(r))
  r = await verify.verifyWechatNotify(headers({ ...h, serial: 'DEADBEEF' }), body)
  check('未知序列号失败（自动拉取已关闭）', !r.ok)
  const st = verify.getVerifyStatus()
  check('getVerifyStatus mode=both', st.mode === 'both', JSON.stringify(st))

  console.log('== 解密 ==')
  const parsed = JSON.parse(body)
  const plain = pay.decryptNotifyResource(parsed.resource.ciphertext, parsed.resource.associated_data, parsed.resource.nonce, API_V3_KEY)
  check('resource 解密得到 out_refund_no', JSON.parse(plain).out_refund_no === 'refund_1_1')

  console.log('== 商户侧签名 ==')
  const auth = pay.generateWxPayAuthorization('POST', 'https://api.mch.weixin.qq.com/v3/refund/domestic/refunds', '{"a":1}')
  const m = auth.match(/nonce_str="([^"]+)",timestamp="(\d+)",serial_no="([^"]+)",signature="([^"]+)"/)
  check('Authorization 头格式', !!m && auth.startsWith('WECHATPAY2-SHA256-RSA2048 mchid="1900000001"'))
  if (m) {
    const msg = `POST\n/v3/refund/domestic/refunds\n${m[2]}\n${m[1]}\n{"a":1}\n`
    const v = crypto.createVerify('RSA-SHA256')
    v.update(msg)
    const mchPub = crypto.createPublicKey(fs.readFileSync(MCH_KEY_PATH, 'utf8')).export({ type: 'spki', format: 'pem' })
    check('签名可被商户公钥验证', v.verify(mchPub, m[4], 'base64'))
  }
  check('getRefundNotifyUrl 派生', (() => {
    process.env.WECHAT_PAY_NOTIFY_URL = 'https://api.example.com/api/wechat/pay/notify'
    delete process.env.WECHAT_PAY_REFUND_NOTIFY_URL
    return pay.getRefundNotifyUrl() === 'https://api.example.com/api/wechat/pay/refund-notify'
  })())
}

async function integrationTests(base: string) {
  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()
  console.log(`== 集成：${base} ==`)
  const user = await prisma.user.findFirst()
  if (!user) throw new Error('无用户，先 seed')
  const stamp = Date.now()
  const order = await prisma.order.create({
    data: {
      orderNo: `ST${stamp}`,
      userId: user.id,
      status: 'REFUNDING',
      totalAmount: 100,
      actualAmount: 100,
      deliveryType: 'LOCAL',
      receiverName: '自测',
      receiverPhone: '13800000000',
      receiverProvince: '四川省',
      receiverCity: '成都市',
      receiverDistrict: '武侯区',
      receiverDetail: '测试',
      receiverFullAddress: '四川省成都市武侯区测试',
      paidAt: new Date(),
      payment: {
        create: { orderNo: `ST${stamp}`, paymentType: 'WECHAT', outTradeNo: `order_0_${stamp}`, amount: 100, status: 'SUCCESS', wxTransactionId: `tx_${stamp}` },
      },
    },
  })
  const outRefundNo = `refund_${order.id}_${stamp}`
  await prisma.refund.create({
    data: { orderId: order.id, orderNo: order.orderNo, outRefundNo, amount: 100, totalAmount: 100, status: 'PENDING', mode: 'WECHAT', activeOrderId: order.id },
  })

  const post = async (body: string, h = signBody(body)) => {
    const resp = await fetch(`${base}/api/wechat/pay/refund-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Wechatpay-Timestamp': h.timestamp,
        'Wechatpay-Nonce': h.nonce,
        'Wechatpay-Signature': h.signature,
        'Wechatpay-Serial': PUB_KEY_ID,
      },
      body,
    })
    return { status: resp.status, json: (await resp.json()) as { code: string; message?: string } }
  }

  const good = buildRefundNotify(outRefundNo, 100, 100)
  let r = await post(good)
  check('REFUND.SUCCESS 回调 200 SUCCESS', r.status === 200 && r.json.code === 'SUCCESS', JSON.stringify(r))
  let o = await prisma.order.findUnique({ where: { id: order.id }, include: { refunds: true, payment: true } })
  check('订单 → REFUNDED', o?.status === 'REFUNDED')
  check('Refund → SUCCESS 且写入 wxRefundId', o?.refunds[0]?.status === 'SUCCESS' && !!o?.refunds[0]?.wxRefundId)
  check('Payment → REFUNDED', o?.payment?.status === 'REFUNDED')
  r = await post(good)
  check('重放 → 仍 SUCCESS（幂等）', r.status === 200 && r.json.code === 'SUCCESS')
  const bad = buildRefundNotify(outRefundNo, 1, 100)
  // 先把 refund 置回 PENDING 让金额校验路径可达
  await prisma.refund.updateMany({ where: { outRefundNo }, data: { status: 'PENDING' } })
  r = await post(bad)
  check('金额不符 → 400 FAIL', r.status === 400 && r.json.code === 'FAIL', JSON.stringify(r))
  const tampered = signBody(good)
  r = await post(good.replace('REFUND.SUCCESS', 'REFUND.SUCCESX'), tampered)
  check('签名不匹配 → 400', r.status === 400)
  r = await post(buildRefundNotify('refund_unknown_0', 100, 100))
  check('未知退款单 → 200 SUCCESS（ack 不重试）', r.status === 200 && r.json.code === 'SUCCESS')

  // 清理
  await prisma.refund.deleteMany({ where: { orderId: order.id } })
  await prisma.payment.deleteMany({ where: { orderId: order.id } })
  await prisma.order.delete({ where: { id: order.id } })
  await prisma.$disconnect()
}

async function main() {
  ensureKeys()
  const idx = process.argv.indexOf('--integration')
  if (idx !== -1) {
    applyEnv()
    await integrationTests(process.argv[idx + 1] || 'http://localhost:3100')
  } else {
    await unitTests()
  }
  console.log(`\n================ 通过 ${pass} / 失败 ${fail} ================`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
