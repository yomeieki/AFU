/**
 * 微信退款查询 queryRefund + pay-mock 自测（无需 DB）：
 *   cd apps/server && npx ts-node --transpile-only scripts/selftest-wechat-pay-query.ts
 *
 * ① 签名：generateWxPayAuthorization('GET', url, '') 的签名串以 '\n\n' 结尾（GET 用空 body），
 *    用与 selftest-wechat-notify.ts 同法生成一对临时 RSA 密钥，用公钥反向验证 Authorization
 *    头里的 signature 确实是对那条 message 签的。
 * ② monkeypatch global.fetch：200 → found；404 + RESOURCE_NOT_EXISTS → not_found；
 *    500 → 抛 WechatRefundError 且 httpStatus===500；TimeoutError → 抛错且 message 含「超时」。
 * ③ mock（services/wechat-pay-mock.ts）：无指令 → 默认 PROCESSING；按 outRefundNo 的指令
 *    优先于 '*' 通配；指令出队后再次调用回到默认（队空）；calls 记录条数正确。
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const DIR = path.join(__dirname, '..', '.selftest')
fs.mkdirSync(DIR, { recursive: true })
const PRIV_KEY_PATH = path.join(DIR, 'pay_query_mch_priv.pem')
const PUB_KEY_PATH = path.join(DIR, 'pay_query_mch_pub.pem')

function ensureKeys() {
  if (!fs.existsSync(PRIV_KEY_PATH) || !fs.existsSync(PUB_KEY_PATH)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    fs.writeFileSync(PRIV_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    fs.writeFileSync(PUB_KEY_PATH, publicKey.export({ type: 'spki', format: 'pem' }))
  }
}

function applyEnv() {
  process.env.WECHAT_PAY_PRIVATE_KEY_PATH = PRIV_KEY_PATH
  process.env.WECHAT_MCH_ID = '1900000001'
  process.env.WECHAT_PAY_SERIAL_NO = 'SELFTESTMCHSERIAL'
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

async function main() {
  ensureKeys()
  applyEnv()
  const pay = await import('../src/services/wechat-pay')

  console.log('== ① 签名 ==')
  const url = 'https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/refund_1_1'
  const auth = pay.generateWxPayAuthorization('GET', url, '')
  const m = auth.match(/nonce_str="([^"]+)",timestamp="(\d+)",serial_no="([^"]+)",signature="([^"]+)"/)
  check('Authorization 头格式', !!m && auth.startsWith('WECHATPAY2-SHA256-RSA2048 mchid="1900000001"'))
  if (m) {
    // GET 时 body 传空串，签名串结尾应为 `${urlPath}\n${ts}\n${nonce}\n\n\n`（body 为空串 + 换行）
    const msg = `GET\n/v3/refund/domestic/refunds/refund_1_1\n${m[2]}\n${m[1]}\n\n`
    check('签名串以空 body + 换行结尾（GET 空串规范）', msg.endsWith('\n\n'))
    const v = crypto.createVerify('RSA-SHA256')
    v.update(msg)
    const pub = fs.readFileSync(PUB_KEY_PATH, 'utf8')
    check('签名可被商户公钥验证', v.verify(pub, m[4], 'base64'))
  }

  console.log('== ② HTTP 响应分支（monkeypatch fetch） ==')
  const origFetch = global.fetch
  const mockResp = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response

  global.fetch = (async () => mockResp(200, { refund_id: 'r1', out_refund_no: 'refund_1_1', status: 'SUCCESS', amount: { refund: 100, total: 100 } })) as typeof fetch
  let r = await pay.queryRefund('refund_1_1')
  check('200 → found', r.kind === 'found' && r.refund.status === 'SUCCESS', JSON.stringify(r))

  global.fetch = (async () => mockResp(404, { code: 'RESOURCE_NOT_EXISTS', message: '查无此单' })) as typeof fetch
  r = await pay.queryRefund('refund_missing')
  check('404 + RESOURCE_NOT_EXISTS → not_found', r.kind === 'not_found', JSON.stringify(r))

  global.fetch = (async () => mockResp(404, { code: 'OTHER', message: 'x' })) as typeof fetch
  try {
    await pay.queryRefund('refund_x')
    check('404 + 其它 code 应抛错', false)
  } catch (e) {
    check('404 + 其它 code → WechatRefundError', e instanceof pay.WechatRefundError, (e as Error).message)
  }

  global.fetch = (async () => mockResp(500, { code: 'SYSTEM_ERROR', message: '系统繁忙' })) as typeof fetch
  try {
    await pay.queryRefund('refund_1_1')
    check('500 应抛错', false)
  } catch (e) {
    check('500 → WechatRefundError 且 httpStatus===500', e instanceof pay.WechatRefundError && (e as InstanceType<typeof pay.WechatRefundError>).httpStatus === 500, (e as Error).message)
  }

  global.fetch = (async () => {
    const err = new DOMException('The operation was aborted', 'TimeoutError')
    throw err
  }) as typeof fetch
  try {
    await pay.queryRefund('refund_1_1')
    check('超时应抛错', false)
  } catch (e) {
    check('超时 → 抛错且 message 含「超时」', (e as Error).message.includes('超时'), (e as Error).message)
  }

  global.fetch = origFetch

  console.log('== ③ mock ==')
  const mockMod = await import('../src/services/wechat-pay-mock')
  mockMod.resetPayMock()
  let mr = await mockMod.mockQueryRefund('refund_a')
  check('无指令 → 默认 PROCESSING', mr.kind === 'found' && mr.refund.status === 'PROCESSING', JSON.stringify(mr))
  check('默认响应不带 amount', mr.kind === 'found' && mr.refund.amount === undefined)

  mockMod.resetPayMock()
  mockMod.queueRefundQueryDirective({ kind: 'ok', status: 'CLOSED' }, '*')
  mockMod.queueRefundQueryDirective({ kind: 'ok', status: 'SUCCESS', amount: 100 }, 'refund_b')
  mr = await mockMod.mockQueryRefund('refund_b')
  check('具体 outRefundNo 指令优先于通配', mr.kind === 'found' && mr.refund.status === 'SUCCESS' && mr.refund.amount?.refund === 100, JSON.stringify(mr))
  mr = await mockMod.mockQueryRefund('refund_b')
  check('该单指令出队后落回通配队列', mr.kind === 'found' && mr.refund.status === 'CLOSED', JSON.stringify(mr))
  mr = await mockMod.mockQueryRefund('refund_b')
  check('通配队列也空后回到默认 PROCESSING', mr.kind === 'found' && mr.refund.status === 'PROCESSING', JSON.stringify(mr))

  mockMod.resetPayMock()
  mockMod.queueRefundQueryDirective({ kind: 'not_found' }, 'refund_c')
  mr = await mockMod.mockQueryRefund('refund_c')
  check('not_found 指令生效', mr.kind === 'not_found')

  mockMod.resetPayMock()
  mockMod.queueRefundQueryDirective({ kind: 'error', code: 'SYSTEM_ERROR', httpStatus: 500 }, 'refund_d')
  try {
    await mockMod.mockQueryRefund('refund_d')
    check('error 指令应抛错', false)
  } catch (e) {
    check('error 指令 → WechatRefundError', e instanceof pay.WechatRefundError)
  }

  mockMod.resetPayMock()
  mockMod.queueRefundQueryDirective({ kind: 'timeout' }, 'refund_e')
  try {
    await mockMod.mockQueryRefund('refund_e')
    check('timeout 指令应抛错', false)
  } catch (e) {
    check('timeout 指令 → 抛错且含「超时」', (e as Error).message.includes('超时'))
  }

  mockMod.resetPayMock()
  await mockMod.mockQueryRefund('refund_f')
  await mockMod.mockQueryRefund('refund_g')
  check('calls 记录条数正确', mockMod.getPayMockCalls().length === 2, String(mockMod.getPayMockCalls().length))

  console.log(`\n================ 通过 ${pass} / 失败 ${fail} ================`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
