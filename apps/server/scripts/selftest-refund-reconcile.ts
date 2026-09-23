/**
 * 退款补查 + initiateRefund 同步返回三态（2026-09-21 统筹裁定后）DB 集成自测。
 * 运行方式（需 DB；不要设 WECHAT_PAY_MOCK=true——见下方说明）：
 *
 *   cd apps/server && TZ=Asia/Shanghai DATABASE_URL=<库> JWT_SECRET=<≥16位> ADMIN_JWT_SECRET=<≥16位> \
 *     npx ts-node --transpile-only scripts/selftest-refund-reconcile.ts
 *
 * 为什么不设 WECHAT_PAY_MOCK=true：本文件「initiateRefund 同步返回四态」这组用例
 * 需要 `config.mock.pay === false` 才能走到真正调用 `createRefund` 的 WECHAT 分支
 * （mock.pay=true 时 initiateRefund 直接 MOCK 模式秒成功，永远到不了那段代码）。
 * `reconcileRefund`/`reconcileStuckRefunds` 的全部用例都显式传入 query 桩，不依赖
 * `defaultRefundQuery()`，所以不受这个开关影响，可以放心共用同一次进程。
 * 微信支付相关的 env（WECHAT_APP_ID/WECHAT_MCH_ID/…/WECHAT_PAY_PRIVATE_KEY_PATH）
 * 由本文件自动生成一把临时私钥并注入，`createRefund` 本身也会被 monkeypatch 成桩，
 * 从不发真实请求，`validatePayConfig()` 只检查这些 env 是否「存在」，不校验内容。
 *
 * 造数据参照 scripts/selftest-wechat-notify.ts 的集成模式：直接用 PrismaClient 造
 * User 关联的 Order/Payment/Refund，每个用例独立造单（stamp 保证唯一），结束时自行清理。
 *
 * 覆盖：
 *  1-10：reconcileRefund / reconcileStuckRefunds（2026-09-21 00 规划 §5 T2 原定用例）
 *  11-14：initiateRefund 同步返回 ABNORMAL/CLOSED/SUCCESS/抛错 四态（2026-09-21 统筹裁定
 *         §10 补的验收——证明「先落 PROCESSING 再由 mark* / finalize 做唯一一次终态转移」
 *         这一改法下，通知各恰好触发一次；SUCCESS 分支与改动前逐字节一致）。
 *         2026-09-23 P3 收口后，用例 14 拆成 4xx（明确拒绝→FAILED）与 5xx（结果未知→PENDING+50202）两条。
 *  15-16：markRefundAbnormal/markRefundClosed 的「回调路径」调用形态（第二个参数传 rawBody，
 *         模拟 wechat-notify.ts:380-382）：首次到达（PROCESSING→终态）通知一次，
 *         微信重推同一封回调（终态→同终态）不重复通知
 *  17-19：2026-09-21 03 回判修补轮 F1-F3 新增：
 *         17（F3）：ABNORMAL 行重查仍 ABNORMAL → reconcileRefund 报 'SKIPPED'（mark* 命中 0 行），
 *                   reconcileStuckRefunds 的 advanced 不计入这一行
 *         18（F2）：PENDING 行本轮查得 PROCESSING 且 reconcileCount 达阈值 →「退款长时间未到账」
 *                   detail 含「微信侧仍处理中」、不含「查询失败」（按 outcome 判，不按 fresh.status）
 *         19（F2）：并发场景——reconcileRefund 返回 outcome='PROCESSING' 期间该行被别的路径
 *                   （模拟回调）并发推成 SUCCESS → 不发「退款长时间未到账」
 *  2026-09-23（第一批：退款资金一致性修复，P1-P5）新增：
 *  用例 8/9：ReconcileOutcome 已删除 NOT_FOUND/AMOUNT_MISMATCH 成员，对齐 9264170 之后的行为
 *            （PROCESSING 查无 / SUCCESS 金额不符 → ABNORMAL）；9 新增 D4（CLOSED+金额不符→直接释放）
 *  用例 14：拆成 4xx 明确拒绝（FAILED）与 5xx 结果未知（PENDING + AppError 50202 + UNCERTAIN_ 前缀）
 *  用例 P3：createRefund 抛普通 Error（超时/网络）同 5xx 处理，之后补查 not_found → FAILED
 *  用例 P2：initiateRefund 同步回写条件写（count=0 不 dispatch）——正向（回调抢先 SUCCESS）与
 *           反向（回调抢先 CLOSED）各一条，验证 refundedAmount 恰好累加一次 / 不累加
 *  用例 markRefundFailed-guard：守卫收窄为仅 PENDING，对 PROCESSING 行调用无效
 *  用例 P1：finalizeRefundSuccess/markRefundClosed 的 expectStatus='ABNORMAL' 人工出口
 *           （一正一反）、D2 amountOverride 按实退金额落账（一正一反，超余额抛 42206 且事务回滚）
 */
import 'dotenv/config'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import assert from 'assert'

const DIR = path.join(__dirname, '..', '.selftest')
fs.mkdirSync(DIR, { recursive: true })
const PRIV_KEY_PATH = path.join(DIR, 'refund_reconcile_mch_priv.pem')

function ensureKeys() {
  if (!fs.existsSync(PRIV_KEY_PATH)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    fs.writeFileSync(PRIV_KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  }
}

function applyPayEnv() {
  process.env.WECHAT_APP_ID = process.env.WECHAT_APP_ID || 'wx_selftest_rtz'
  process.env.WECHAT_MCH_ID = process.env.WECHAT_MCH_ID || '1900000001'
  process.env.WECHAT_PAY_SERIAL_NO = process.env.WECHAT_PAY_SERIAL_NO || 'SELFTESTSERIALRTZ'
  process.env.WECHAT_PAY_PRIVATE_KEY_PATH = PRIV_KEY_PATH
  process.env.WECHAT_PAY_API_V3_KEY = process.env.WECHAT_PAY_API_V3_KEY || 'selftest_api_v3_key_32bytes_long!'.slice(0, 32)
  process.env.WECHAT_PAY_NOTIFY_URL = process.env.WECHAT_PAY_NOTIFY_URL || 'https://api.example.com/api/wechat/pay/notify'
}

let pass = 0
let fail = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function runCheck(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    pass++
    console.log('  ✔', name)
  } catch (e) {
    fail++
    console.error('  ✘', name, '\n     ', (e as Error).stack ?? (e as Error).message)
  }
  // finalizeRefundSuccess/markRefund* 的通知都是事务外 fire-and-forget（不 await）；
  // 给每个用例结束后一小段时间让上一例的后台 .then() 落地，避免它的计数溢出到下一例的
  // resetCounters() 之后（跨用例污染计数器，而不是本函数被测代码本身有问题）。
  await sleep(30)
}
let seq = 0
function stamp() {
  seq++
  return `${Date.now()}${seq}`
}

async function main() {
  ensureKeys()
  applyPayEnv()

  const { PrismaClient } = await import('@prisma/client')
  const prisma = new PrismaClient()

  // require（不用 await import）：要拿到与业务代码里 require('./notify') 同一个
  // module.exports 对象才能真的 monkeypatch 生效（TS 的 dynamic import 在部分场景会
  // 经 __importStar 包出一份新对象，写在那份新对象上业务代码看不到）。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const notifyMod = require('../src/services/notify')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const orderNotifyMod = require('../src/services/order-notify')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wechatPayMod = require('../src/services/wechat-pay')

  const refundMod = await import('../src/services/refund')
  const reconcileMod = await import('../src/services/refund-reconcile')

  let alertCalls: { title: string; key?: string; windowMs?: number; lines: string[] }[] = []
  const origNotifySystemAlert = notifyMod.notifySystemAlert
  notifyMod.notifySystemAlert = (title: string, lines: string[], opts: { key?: string; windowMs?: number } = {}) => {
    alertCalls.push({ title, key: opts.key, windowMs: opts.windowMs, lines })
  }
  let refundResultCalls: { status: string }[] = []
  const origNotifyRefundResult = orderNotifyMod.notifyRefundResult
  orderNotifyMod.notifyRefundResult = (_order: unknown, _refund: unknown, status: string) => {
    refundResultCalls.push({ status })
  }
  function resetCounters() {
    alertCalls = []
    refundResultCalls = []
  }
  let createRefundStub: ((params: unknown) => Promise<unknown>) | null = null
  const origCreateRefund = wechatPayMod.createRefund
  wechatPayMod.createRefund = (params: unknown) => {
    if (!createRefundStub) throw new Error('createRefundStub 未设置')
    return createRefundStub(params)
  }

  function restoreAll() {
    notifyMod.notifySystemAlert = origNotifySystemAlert
    orderNotifyMod.notifyRefundResult = origNotifyRefundResult
    wechatPayMod.createRefund = origCreateRefund
  }

  const user = await prisma.user.findFirst()
  if (!user) throw new Error('无用户，先 seed')

  // 每个用例各自的订单 id：reconcileStuckRefunds 扫的是全表，某个用例若不在自己结束时清掉
  // 造出来的行，会一直留在 refunds 表里，被后面用例（尤其用例 10 的全表扫描断言）当成
  // 「别的待查退款」误统计进去——所以清理必须挂在每个用例自己身上，不能拖到 main() 末尾一次性做。
  let currentTestOrderIds: number[] = []
  async function cleanupIds(ids: number[]) {
    if (ids.length === 0) return
    await prisma.refund.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.payment.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.order.deleteMany({ where: { id: { in: ids } } })
  }
  async function t(name: string, fn: () => Promise<void>) {
    currentTestOrderIds = []
    await runCheck(name, fn)
    await cleanupIds(currentTestOrderIds)
  }

  async function makeOrder(opts: {
    status?: string
    actualAmount?: number
    refundedAmount?: number
    paymentType?: string
    outTradeNo?: string | null
  } = {}) {
    const s = stamp()
    const amount = opts.actualAmount ?? 100
    const order = await prisma.order.create({
      data: {
        orderNo: `RTZ${s}`,
        userId: user!.id,
        status: opts.status ?? 'PAID',
        totalAmount: amount,
        actualAmount: amount,
        refundedAmount: opts.refundedAmount ?? 0,
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
          create: {
            orderNo: `RTZ${s}`,
            paymentType: opts.paymentType ?? 'WECHAT',
            outTradeNo: opts.outTradeNo === undefined ? `order_rtz_${s}` : opts.outTradeNo,
            amount,
            status: 'SUCCESS',
            wxTransactionId: `tx_rtz_${s}`,
          },
        },
      },
    })
    currentTestOrderIds.push(order.id)
    return order
  }

  async function makeRefund(
    orderId: number,
    opts: {
      status?: string
      amount?: number
      totalAmount?: number
      activeOrderId?: number | null
      createdAt?: Date
      reconcileCheckedAt?: Date | null
      reconcileCount?: number
    } = {}
  ) {
    const s = stamp()
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    return prisma.refund.create({
      data: {
        orderId,
        orderNo: order.orderNo,
        outTradeNo: `order_rtz_${s}`,
        outRefundNo: `refund_rtz_${orderId}_${s}`,
        amount: opts.amount ?? order.actualAmount,
        totalAmount: opts.totalAmount ?? order.actualAmount,
        status: opts.status ?? 'PENDING',
        mode: 'WECHAT',
        activeOrderId: opts.activeOrderId === undefined ? orderId : opts.activeOrderId,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.reconcileCheckedAt !== undefined ? { reconcileCheckedAt: opts.reconcileCheckedAt } : {}),
        ...(opts.reconcileCount !== undefined ? { reconcileCount: opts.reconcileCount } : {}),
      },
    })
  }

  // ────────────────────────────────────────────────────────────────
  console.log('== 1. 幂等：SUCCESS 之后回调后到 / 再补查都不重复记账 ==')
  await t('用例 1', async () => {
    resetCounters()
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 100 })
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr1', status: 'SUCCESS', amount: { refund: 100, total: 100 }, success_time: new Date().toISOString() },
    }))
    assert.strictEqual(outcome, 'SUCCESS')
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    let o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    let p = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })
    assert.strictEqual(r.status, 'SUCCESS')
    assert.strictEqual(r.activeOrderId, null)
    assert.strictEqual(o.refundedAmount, 100)
    assert.strictEqual(o.status, 'REFUNDED')
    assert.strictEqual(p.status, 'REFUNDED')

    // 模拟回调后到（同一笔已经被补查推成 SUCCESS 之后，微信回调才到）。
    // 这里刻意不用「已经退到实付上限」的这单来验证——那样即使幂等守卫被拿掉，
    // LEAST(refunded_amount+amount, actual_amount) 的封顶也会把二次累加悄悄吃掉，
    // 查不出问题（R1 回退验证专门踩过这个坑）。改用一笔尚未到上限的部分退款：
    // 若幂等守卫失效，refundedAmount 会从 100 变成 200，可靠地被下面的断言抓到。
    const order2 = await makeOrder({ actualAmount: 1000, status: 'PAID' })
    const refund2 = await makeRefund(order2.id, { status: 'PENDING', amount: 100, totalAmount: 1000 })
    await reconcileMod.reconcileRefund(refund2.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr1b', status: 'SUCCESS', amount: { refund: 100, total: 1000 } },
    }))
    let o2 = await prisma.order.findUniqueOrThrow({ where: { id: order2.id } })
    assert.strictEqual(o2.refundedAmount, 100)
    await refundMod.finalizeRefundSuccess({ refundId: refund2.id })
    o2 = await prisma.order.findUniqueOrThrow({ where: { id: order2.id } })
    assert.strictEqual(o2.refundedAmount, 100, '回调后到不应再次累加')

    const outcome2 = await reconcileMod.reconcileRefund(refund.id, async () => {
      throw new Error('不应再被调用')
    })
    assert.strictEqual(outcome2, 'SKIPPED')
    r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.reconcileCount, 1)
  })

  console.log('== 2. 部分退款：refundedAmount 正确、订单状态不变 ==')
  await t('用例 2', async () => {
    const order = await makeOrder({ actualAmount: 300, status: 'PAID' })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 300, activeOrderId: order.id })
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr2', status: 'SUCCESS', amount: { refund: 100, total: 300 } },
    }))
    assert.strictEqual(outcome, 'SUCCESS')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.refundedAmount, 100)
    assert.strictEqual(o.status, 'PAID')
  })

  console.log('== 3. 互斥：已 SUCCESS 的行不被 mark* 改回 ==')
  await t('用例 3', async () => {
    const order = await makeOrder({ actualAmount: 100 })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 100 })
    await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr3', status: 'SUCCESS', amount: { refund: 100, total: 100 } },
    }))
    // finalizeRefundSuccess 的 notifyRefundResult 是事务外 fire-and-forget，
    // 等它落地再重置计数器，否则会把「这次 SUCCESS 转移自己的那条通知」误记成
    // 后面三个 mark* 调用产生的（intra-test race，不是被测代码的问题）。
    await sleep(50)
    resetCounters()
    await refundMod.markRefundClosed(refund.id)
    await refundMod.markRefundAbnormal(refund.id)
    await refundMod.markRefundFailed(refund.id, 'X', 'y')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(r.status, 'SUCCESS')
    assert.strictEqual(r.activeOrderId, null)
    assert.strictEqual(o.refundedAmount, 100)
    assert.strictEqual(alertCalls.length, 0, `不应有告警，实际 ${JSON.stringify(alertCalls)}`)
    assert.strictEqual(refundResultCalls.length, 0)
  })

  console.log('== 4. 并发占坑：CAS 只放行一个 ==')
  await t('用例 4', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 100 })
    let calls = 0
    const q = async () => {
      calls++
      await sleep(50)
      return { kind: 'found' as const, refund: { refund_id: 'wxr4', status: 'PROCESSING' as const } }
    }
    const [a, b] = await Promise.all([reconcileMod.reconcileRefund(refund.id, q), reconcileMod.reconcileRefund(refund.id, q)])
    const outcomes = [a, b].sort()
    assert.deepStrictEqual(outcomes, ['PROCESSING', 'SKIPPED'])
    assert.strictEqual(calls, 1)
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.reconcileCount, 1)
  })

  console.log('== 5. CLOSED ==')
  await t('用例 5', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 100 })
    resetCounters()
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr5', status: 'CLOSED' },
    }))
    assert.strictEqual(outcome, 'CLOSED')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(r.status, 'CLOSED')
    assert.strictEqual(r.activeOrderId, null)
    assert.strictEqual(o.status, 'REFUNDING')
    assert.ok(alertCalls.some((c) => c.key === `refund-closed:${refund.id}`))
  })

  console.log('== 6. ABNORMAL：再查一次不重复告警 ==')
  await t('用例 6', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 100 })
    resetCounters()
    let outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr6', status: 'ABNORMAL' },
    }))
    assert.strictEqual(outcome, 'ABNORMAL')
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.activeOrderId, order.id)
    const alertCountAfterFirst = alertCalls.filter((c) => c.key === `refund-abnormal:${refund.id}`).length
    assert.strictEqual(alertCountAfterFirst, 1)

    outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr6', status: 'ABNORMAL' },
    }))
    // F3（修补轮）：markRefundAbnormal 命中 0 行（已是 ABNORMAL），reconcileRefund 改报 'SKIPPED'，
    // 不再谎称 'ABNORMAL'（那会被 reconcileStuckRefunds 错记进 advanced，见用例 17）。
    assert.strictEqual(outcome, 'SKIPPED')
    const alertCountAfterSecond = alertCalls.filter((c) => c.key === `refund-abnormal:${refund.id}`).length
    assert.strictEqual(alertCountAfterSecond, 1, '重复 ABNORMAL 不应新增告警（守卫 count=0）')
  })

  console.log('== 7. 查询失败 ==')
  await t('用例 7', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => {
      throw new Error('boom')
    })
    assert.strictEqual(outcome, 'QUERY_FAILED')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'PROCESSING')
    assert.strictEqual(r.reconcileLastError, 'boom')
    assert.strictEqual(r.reconcileCount, 1)
  })

  console.log('== 8. not_found ==')
  await t('用例 8（PENDING → FAILED）', async () => {
    const order = await makeOrder({ actualAmount: 100 })
    const refund = await makeRefund(order.id, { status: 'PENDING', amount: 100, totalAmount: 100 })
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({ kind: 'not_found' }))
    assert.strictEqual(outcome, 'FAILED')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'FAILED')
    assert.strictEqual(r.errorCode, 'RECONCILE_NOT_FOUND')
    assert.strictEqual(r.activeOrderId, null)
  })
  await t('用例 8（PROCESSING 查无 → ABNORMAL，2026-09-22 起）', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    resetCounters()
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({ kind: 'not_found' }))
    assert.strictEqual(outcome, 'ABNORMAL', 'ReconcileOutcome 已删除 NOT_FOUND 成员，2026-09-22 起 PROCESSING 查无标 ABNORMAL')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'ABNORMAL')
    assert.strictEqual(r.activeOrderId, order.id, 'ABNORMAL 仍占位')
    assert.ok(r.reconcileLastError?.includes('查无'))
    const notfoundAlert = alertCalls.find((c) => c.key === `refund-reconcile-notfound:${refund.id}`)
    assert.ok(notfoundAlert)
    assert.strictEqual(notfoundAlert!.windowMs, 6 * 60 * 60 * 1000, 'F1：查无此单告警应带 6 小时限频窗口')
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-abnormal:${refund.id}`).length, 1, 'markRefundAbnormal 自带的告警应恰好一次')
  })

  console.log('== 9. 金额不符（SUCCESS→ABNORMAL；D4 选 A：CLOSED→直接释放）==')
  await t('用例 9（SUCCESS + 金额不符 → ABNORMAL）', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    resetCounters()
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr9', status: 'SUCCESS', amount: { refund: 999, total: 999 } },
    }))
    assert.strictEqual(outcome, 'ABNORMAL', 'ReconcileOutcome 已删除 AMOUNT_MISMATCH 成员，金额不符标 ABNORMAL')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(r.status, 'ABNORMAL')
    assert.strictEqual(o.refundedAmount, 0)
    assert.ok(r.reconcileLastError?.includes('金额'))
    const mismatchAlert = alertCalls.find((c) => c.key === `refund-reconcile-mismatch:${refund.id}`)
    assert.ok(mismatchAlert)
    assert.strictEqual(mismatchAlert!.windowMs, 6 * 60 * 60 * 1000, 'F1：金额不一致告警应带 6 小时限频窗口')
  })
  await t('用例 9（D4：CLOSED + 金额不符 → 直接按 CLOSED 释放）', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    resetCounters()
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({
      kind: 'found',
      refund: { refund_id: 'wxr9b', status: 'CLOSED', amount: { refund: 999, total: 999 } },
    }))
    assert.strictEqual(outcome, 'CLOSED', 'D4 选 A：CLOSED 无资金变动，金额不符也直接释放')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'CLOSED')
    assert.strictEqual(r.activeOrderId, null)
    assert.ok(r.reconcileLastError?.includes('金额'), '金额不一致仍要记录，只是不卡人')
    assert.ok(alertCalls.some((c) => c.key === `refund-reconcile-mismatch:${refund.id}`))
  })

  console.log('== 10. 扫描与告警（reconcileStuckRefunds） ==')
  await t('用例 10', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
    const r1 = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100, createdAt: tenMinAgo, activeOrderId: null })
    // 同订单同时只能一笔在途，故三笔各用独立订单
    const order2 = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const r2 = await makeRefund(order2.id, { status: 'PROCESSING', amount: 100, totalAmount: 100, createdAt: tenMinAgo, activeOrderId: null })
    const order3 = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const r3 = await makeRefund(order3.id, { status: 'PROCESSING', amount: 100, totalAmount: 100, createdAt: tenMinAgo, activeOrderId: null })

    resetCounters()
    let calls = 0
    const stubProcessing = async () => {
      calls++
      return { kind: 'found' as const, refund: { refund_id: 'wxrs', status: 'PROCESSING' as const } }
    }
    let advanced = await reconcileMod.reconcileStuckRefunds({ afterMin: 5, intervalMin: 5, batch: 2, alertAfter: 1, query: stubProcessing })
    assert.strictEqual(advanced, 0)
    assert.strictEqual(calls, 2, '限量 batch=2')
    const stuckAlerts = alertCalls.filter((c) => c.title === '退款长时间未到账')
    assert.strictEqual(stuckAlerts.length, 2)

    calls = 0
    await reconcileMod.reconcileStuckRefunds({ afterMin: 5, intervalMin: 5, batch: 2, alertAfter: 1, query: stubProcessing })
    assert.strictEqual(calls, 1, '前两行在 5 分钟间隔内不重查，只剩第三行')

    calls = 0
    await reconcileMod.reconcileStuckRefunds({ afterMin: 5, intervalMin: 0, batch: 10, alertAfter: 1, query: stubProcessing })
    assert.strictEqual(calls, 3, 'intervalMin:0 三行都被查')

    // afterMin 边界：新造的行（createdAt=now）不该被扫到
    const order4 = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    await makeRefund(order4.id, { status: 'PROCESSING', amount: 100, totalAmount: 100, activeOrderId: null })
    calls = 0
    await reconcileMod.reconcileStuckRefunds({ afterMin: 5, intervalMin: 0, batch: 10, alertAfter: 1, query: stubProcessing })
    assert.strictEqual(calls, 3, '新造的行未满 afterMin 不应被扫到（仍是前三行）')

    // ABNORMAL 复查间隔
    const order5 = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const rAbnormal = await makeRefund(order5.id, {
      status: 'ABNORMAL',
      amount: 100,
      totalAmount: 100,
      activeOrderId: order5.id,
      reconcileCheckedAt: new Date(Date.now() - 5 * 60 * 1000),
    })
    calls = 0
    await reconcileMod.reconcileStuckRefunds({ afterMin: 5, intervalMin: 0, abnormalIntervalMin: 60, batch: 10, alertAfter: 1, query: stubProcessing })
    assert.strictEqual(calls, 3, '默认 abnormalIntervalMin=60，5 分钟前查过的 ABNORMAL 行不该被扫到')
    calls = 0
    await reconcileMod.reconcileStuckRefunds({ afterMin: 5, intervalMin: 0, abnormalIntervalMin: 0, batch: 10, alertAfter: 1, query: stubProcessing })
    assert.strictEqual(calls, 4, 'abnormalIntervalMin:0 时 ABNORMAL 行应被扫到')
    const rAbnormalAfter = await prisma.refund.findUniqueOrThrow({ where: { id: rAbnormal.id } })
    assert.strictEqual(rAbnormalAfter.status, 'ABNORMAL')
    const stuckAlertForAbnormal = alertCalls.filter((c) => c.title === '退款长时间未到账' && c.key === `refund-reconcile-stuck:${rAbnormal.id}`)
    assert.strictEqual(stuckAlertForAbnormal.length, 0, 'ABNORMAL 行不发「长时间未到账」告警')

    void r1
    void r2
    void r3
  })

  // ────────────────────────────────────────────────────────────────
  // 2026-09-21 统筹裁定补的验收：initiateRefund 同步返回四态
  // ────────────────────────────────────────────────────────────────
  console.log('== 11. initiateRefund 同步返回 ABNORMAL：终态 ABNORMAL，通知各恰好一次 ==')
  await t('用例 11', async () => {
    const order = await makeOrder({ actualAmount: 150, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async () => ({
      refund_id: 'wxr11',
      out_refund_no: 'ignored',
      status: 'ABNORMAL',
      amount: { refund: 150, total: 150 },
    })
    const result = await refundMod.initiateRefund({ orderId: order.id, amount: 150, operator: 'selftest' })
    assert.strictEqual(result.refund.status, 'ABNORMAL')
    assert.strictEqual(result.refund.activeOrderId, order.id, 'ABNORMAL 不释放在途位')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.status, 'REFUNDING')
    assert.strictEqual(refundResultCalls.filter((c) => c.status === 'ABNORMAL').length, 1)
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-abnormal:${result.refund.id}`).length, 1)
  })

  console.log('== 12. initiateRefund 同步返回 CLOSED：终态 CLOSED，通知各恰好一次，在途位释放 ==')
  await t('用例 12', async () => {
    const order = await makeOrder({ actualAmount: 120, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async () => ({
      refund_id: 'wxr12',
      out_refund_no: 'ignored',
      status: 'CLOSED',
      amount: { refund: 120, total: 120 },
    })
    const result = await refundMod.initiateRefund({ orderId: order.id, amount: 120, operator: 'selftest' })
    assert.strictEqual(result.refund.status, 'CLOSED')
    assert.strictEqual(result.refund.activeOrderId, null, 'CLOSED 释放在途位')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.status, 'REFUNDING', 'CLOSED 不改订单状态，留给店员重试')
    assert.strictEqual(refundResultCalls.filter((c) => c.status === 'CLOSED').length, 1)
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-closed:${result.refund.id}`).length, 1)
  })

  console.log('== 13. initiateRefund 同步返回 SUCCESS：与改动前逐字节一致 ==')
  await t('用例 13', async () => {
    const order = await makeOrder({ actualAmount: 80, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async () => ({
      refund_id: 'wxr13',
      out_refund_no: 'ignored',
      status: 'SUCCESS',
      success_time: new Date().toISOString(),
      amount: { refund: 80, total: 80 },
    })
    const result = await refundMod.initiateRefund({ orderId: order.id, amount: 80, operator: 'selftest' })
    assert.strictEqual(result.refund.status, 'SUCCESS')
    assert.strictEqual(result.mode, 'wechat')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    const p = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } })
    assert.strictEqual(o.status, 'REFUNDED')
    assert.strictEqual(o.refundedAmount, 80)
    assert.strictEqual(p.status, 'REFUNDED')
    // finalizeRefundSuccess 的通知在事务外 fire-and-forget，等一拍
    await sleep(150)
    assert.strictEqual(refundResultCalls.filter((c) => c.status === 'SUCCESS').length, 1)
  })

  console.log('== 14. createRefund 抛错：明确拒绝（4xx）→ FAILED；结果未知（5xx）→ 保留 PENDING ==')
  await t('用例 14（4xx 明确拒绝 → FAILED，告警一次）', async () => {
    const order = await makeOrder({ actualAmount: 60, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async () => {
      throw new wechatPayMod.WechatRefundError('NOT_ENOUGH', '商户余额不足', 403)
    }
    let threw: unknown = null
    try {
      await refundMod.initiateRefund({ orderId: order.id, amount: 60, operator: 'selftest' })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, '应抛出 AppError(50201)')
    assert.strictEqual((threw as { code: number }).code, 50201)
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } })
    assert.strictEqual(refund.status, 'FAILED')
    assert.strictEqual(refund.activeOrderId, null)
    assert.strictEqual(refund.errorCode, 'NOT_ENOUGH')
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-failed:${order.id}`).length, 1)
  })
  await t('用例 14（5xx 结果未知 → 保留 PENDING，AppError 50202）', async () => {
    const order = await makeOrder({ actualAmount: 60, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async () => {
      throw new wechatPayMod.WechatRefundError('SYSTEM_ERROR', '系统繁忙', 500)
    }
    let threw: unknown = null
    try {
      await refundMod.initiateRefund({ orderId: order.id, amount: 60, operator: 'selftest' })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, '应抛出 AppError(50202)')
    assert.strictEqual((threw as { code: number }).code, 50202, '5xx 是「结果未知」，不是明确拒绝')
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } })
    assert.strictEqual(refund.status, 'PENDING', '结果未知不改状态，保留占位交补查')
    assert.strictEqual(refund.activeOrderId, order.id, '在途位仍占着')
    assert.ok(refund.errorCode?.startsWith('UNCERTAIN_'), `errorCode 应以 UNCERTAIN_ 开头，实际 ${refund.errorCode}`)
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-uncertain:${refund.id}`).length, 1)
  })

  console.log('== P3. createRefund 抛普通 Error（超时/网络）：同 5xx 处理，之后补查 not_found → FAILED ==')
  await t('用例 P3', async () => {
    const order = await makeOrder({ actualAmount: 70, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async () => {
      throw new Error('微信支付请求超时')
    }
    let threw: unknown = null
    try {
      await refundMod.initiateRefund({ orderId: order.id, amount: 70, operator: 'selftest' })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, '应抛出 AppError(50202)')
    assert.strictEqual((threw as { code: number }).code, 50202)
    let refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } })
    assert.strictEqual(refund.status, 'PENDING')
    assert.strictEqual(refund.activeOrderId, order.id)
    assert.ok(refund.errorCode?.startsWith('UNCERTAIN_'))
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-uncertain:${refund.id}`).length, 1)

    // 补查查无此单：PENDING → FAILED，释放在途位
    const outcome = await reconcileMod.reconcileRefund(refund.id, async () => ({ kind: 'not_found' }))
    assert.strictEqual(outcome, 'FAILED')
    refund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(refund.status, 'FAILED')
    assert.strictEqual(refund.activeOrderId, null)
  })

  console.log('== P2. initiateRefund 同步回写不得把已被回调抢先推进的行改回 PROCESSING（条件写 count=0）==')
  await t('用例 P2（正向：回调抢先 SUCCESS，同步返回 PROCESSING，count=0 不 dispatch）', async () => {
    const order = await makeOrder({ actualAmount: 1000, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async (params: unknown) => {
      const { outRefundNo } = params as { outRefundNo: string }
      const row = await prisma.refund.findUniqueOrThrow({ where: { outRefundNo } })
      // 模拟「微信回调已抢先到达」：在 initiateRefund 的同步回写落库之前，回调先把行推成 SUCCESS。
      await refundMod.finalizeRefundSuccess({ refundId: row.id, wxRefundId: 'wxrp2', rawData: JSON.stringify({ source: 'preempt' }), rawField: 'wxNotifyData' })
      return { refund_id: 'wxrp2', out_refund_no: outRefundNo, status: 'PROCESSING', amount: { refund: 100, total: 1000 } }
    }
    const result = await refundMod.initiateRefund({ orderId: order.id, amount: 100, operator: 'selftest' })
    assert.strictEqual(result.refund.status, 'SUCCESS', '同步回写的 count=0 分支不改变回调已经落定的结果')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.refundedAmount, 100, '恰好一次累加（若 :273 无条件写把行拽回 PROCESSING，5 分钟补查再 finalize 一次会变 200）')
    assert.strictEqual(refundResultCalls.filter((c) => c.status === 'SUCCESS').length, 1, 'SUCCESS 通知恰好一次')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: result.refund.id } })
    assert.ok(r.wxResponseData, '同步回写落空分支仍应补写 wxResponseData')
  })
  await t('用例 P2（反向：回调抢先 CLOSED，同步返回 SUCCESS，count=0 不 dispatch）', async () => {
    const order = await makeOrder({ actualAmount: 200, status: 'PAID', paymentType: 'WECHAT' })
    resetCounters()
    createRefundStub = async (params: unknown) => {
      const { outRefundNo } = params as { outRefundNo: string }
      const row = await prisma.refund.findUniqueOrThrow({ where: { outRefundNo } })
      await refundMod.markRefundClosed(row.id, JSON.stringify({ source: 'preempt' }))
      return { refund_id: 'wxrp2b', out_refund_no: outRefundNo, status: 'SUCCESS', amount: { refund: 200, total: 200 } }
    }
    const result = await refundMod.initiateRefund({ orderId: order.id, amount: 200, operator: 'selftest' })
    assert.strictEqual(result.refund.status, 'CLOSED', '回调已经把行推成 CLOSED，同步返回的 SUCCESS 不应覆盖')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.refundedAmount, 0, 'CLOSED 分支从未被 dispatch，不应累加')
    assert.strictEqual(refundResultCalls.filter((c) => c.status === 'SUCCESS').length, 0, 'SUCCESS 通知不应触发')
  })

  console.log('== markRefundFailed 守卫收窄：对 PROCESSING 行调用应无效（count=0） ==')
  await t('用例 markRefundFailed-guard', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    resetCounters()
    await refundMod.markRefundFailed(refund.id, 'X', 'y')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'PROCESSING', 'PROCESSING 已拿到 refund_id，不该再被标 FAILED')
    assert.strictEqual(alertCalls.length, 0, '守卫未通过，不应告警')
  })

  console.log('== P1. finalizeRefundSuccess/markRefundClosed 的人工出口（expectStatus/amountOverride/manual）==')
  await t('用例 P1（finalizeRefundSuccess：ABNORMAL → SUCCESS，写三列留痕，一正一反）', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'ABNORMAL', amount: 100, totalAmount: 100, activeOrderId: order.id })
    resetCounters()
    const at = new Date()
    const applied1 = await refundMod.finalizeRefundSuccess({
      refundId: refund.id,
      expectStatus: 'ABNORMAL',
      manual: { by: 'selftest', note: 'n', at },
    })
    assert.deepStrictEqual(applied1, { applied: true })
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'SUCCESS')
    assert.strictEqual(r.manualResolvedBy, 'selftest')
    assert.strictEqual(r.manualResolveNote, 'n')
    assert.ok(r.manualResolvedAt)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.status, 'REFUNDED')

    const applied2 = await refundMod.finalizeRefundSuccess({ refundId: refund.id, expectStatus: 'ABNORMAL', manual: { by: 'x', note: 'n2', at: new Date() } })
    assert.deepStrictEqual(applied2, { applied: false }, '已是 SUCCESS，expectStatus 守卫不再命中')
  })
  await t('用例 P1（finalizeRefundSuccess：expectStatus=ABNORMAL 对 PROCESSING 行不生效）', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100, activeOrderId: order.id })
    resetCounters()
    const applied = await refundMod.finalizeRefundSuccess({ refundId: refund.id, expectStatus: 'ABNORMAL', manual: { by: 'selftest', note: 'n', at: new Date() } })
    assert.deepStrictEqual(applied, { applied: false }, 'PROCESSING 不是 ABNORMAL，守卫不命中')
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'PROCESSING')
    assert.strictEqual(refundResultCalls.length, 0, '未真正翻转，不应发通知')
  })
  await t('用例 P1（D1：markRefundClosed 的人工出口，ABNORMAL → CLOSED，一正一反）', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'ABNORMAL', amount: 100, totalAmount: 100, activeOrderId: order.id })
    resetCounters()
    const at = new Date()
    const applied1 = await refundMod.markRefundClosed(refund.id, undefined, { expectStatus: 'ABNORMAL', manual: { by: 'selftest', note: 'closed-n', at } })
    assert.deepStrictEqual(applied1, { applied: true })
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'CLOSED')
    assert.strictEqual(r.activeOrderId, null)
    assert.strictEqual(r.manualResolvedBy, 'selftest')
    assert.strictEqual(r.manualResolveNote, 'closed-n')

    const applied2 = await refundMod.markRefundClosed(refund.id, undefined, { expectStatus: 'ABNORMAL', manual: { by: 'x', note: 'n2', at: new Date() } })
    assert.deepStrictEqual(applied2, { applied: false }, '已是 CLOSED，expectStatus 守卫不再命中')
  })
  await t('用例 P1（D2：amountOverride 按实退金额落账，一正一反）', async () => {
    const order = await makeOrder({ actualAmount: 1000, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'ABNORMAL', amount: 300, totalAmount: 1000, activeOrderId: order.id })
    resetCounters()
    const applied = await refundMod.finalizeRefundSuccess({
      refundId: refund.id,
      expectStatus: 'ABNORMAL',
      amountOverride: 200,
      manual: { by: 'selftest', note: '实退 2 元', at: new Date() },
    })
    assert.deepStrictEqual(applied, { applied: true })
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.amount, 200, '按实退金额落账，覆盖原记录的 300')
    assert.strictEqual(r.status, 'SUCCESS')
    const o = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    assert.strictEqual(o.refundedAmount, 200, '按 amountOverride 累加，不是原记录的 300')

    // 反向：超过可退余额（此时余额已被上面那笔占用 200，actualAmount-refundedAmount=800）
    const order2 = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund2 = await makeRefund(order2.id, { status: 'ABNORMAL', amount: 100, totalAmount: 100, activeOrderId: order2.id })
    let threw: unknown = null
    try {
      await refundMod.finalizeRefundSuccess({ refundId: refund2.id, expectStatus: 'ABNORMAL', amountOverride: 101, manual: { by: 'x', note: 'n', at: new Date() } })
    } catch (e) {
      threw = e
    }
    assert.ok(threw, '实退金额超过可退余额应抛错')
    assert.strictEqual((threw as { code: number }).code, 42206)
    const r2 = await prisma.refund.findUniqueOrThrow({ where: { id: refund2.id } })
    assert.strictEqual(r2.status, 'ABNORMAL', '抛错后事务回滚，状态不变')
    assert.strictEqual(r2.amount, 100, '抛错后事务回滚，金额不变')
  })

  // ────────────────────────────────────────────────────────────────
  // 回调路径调用形态（markRefundAbnormal/markRefundClosed 的第二个参数=rawBody，
  // 与 routes/wechat-notify.ts:380-382 的调用完全一致）：首次到达通知一次，
  // 微信重推同一封回调（duplicate delivery）不重复通知。
  // ────────────────────────────────────────────────────────────────
  console.log('== 15. 回调路径 ABNORMAL：首次通知一次，重复到达不重复 ==')
  await t('用例 15', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    resetCounters()
    await refundMod.markRefundAbnormal(refund.id, 'raw-first')
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'ABNORMAL')
    assert.strictEqual(refundResultCalls.length, 1)
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-abnormal:${refund.id}`).length, 1)

    await refundMod.markRefundAbnormal(refund.id, 'raw-duplicate')
    r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'ABNORMAL')
    assert.strictEqual(refundResultCalls.length, 1, '重复回调不应再次推送')
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-abnormal:${refund.id}`).length, 1, '重复回调不应再次告警')
  })

  console.log('== 16. 回调路径 CLOSED：首次通知一次，重复到达不重复 ==')
  await t('用例 16', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, { status: 'PROCESSING', amount: 100, totalAmount: 100 })
    resetCounters()
    await refundMod.markRefundClosed(refund.id, 'raw-first')
    let r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'CLOSED')
    assert.strictEqual(refundResultCalls.length, 1)
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-closed:${refund.id}`).length, 1)

    await refundMod.markRefundClosed(refund.id, 'raw-duplicate')
    r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'CLOSED')
    assert.strictEqual(refundResultCalls.length, 1, '重复回调不应再次推送')
    assert.strictEqual(alertCalls.filter((c) => c.key === `refund-closed:${refund.id}`).length, 1, '重复回调不应再次告警')
  })

  // ────────────────────────────────────────────────────────────────
  // 2026-09-21 03 回判修补轮验收：F1-F3 的新增用例（先红后绿，详见方案 §13/§14）
  // ────────────────────────────────────────────────────────────────
  console.log('== 17. F3：ABNORMAL 行重查仍 ABNORMAL → SKIPPED，不计入 advanced ==')
  await t('用例 17', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, {
      status: 'ABNORMAL',
      amount: 100,
      totalAmount: 100,
      activeOrderId: order.id,
      reconcileCheckedAt: new Date(Date.now() - 5 * 60 * 1000),
    })
    resetCounters()
    const stubAbnormal = async () => ({ kind: 'found' as const, refund: { refund_id: 'wxr17', status: 'ABNORMAL' as const } })

    const outcome = await reconcileMod.reconcileRefund(refund.id, stubAbnormal)
    assert.strictEqual(outcome, 'SKIPPED', 'markRefundAbnormal 命中 0 行（已是 ABNORMAL），reconcileRefund 应报 SKIPPED')
    assert.strictEqual(
      alertCalls.filter((c) => c.key === `refund-abnormal:${refund.id}`).length,
      0,
      'markRefundAbnormal 守卫未通过（count=0），不应再告警'
    )

    const advanced = await reconcileMod.reconcileStuckRefunds({
      afterMin: 0,
      intervalMin: 0,
      abnormalIntervalMin: 0,
      batch: 10,
      alertAfter: 999,
      query: stubAbnormal,
    })
    assert.strictEqual(advanced, 0, 'SKIPPED 不应被 reconcileStuckRefunds 计入 advanced（本轮状态推进条数）')
  })

  console.log('== 18. F2：PENDING 行仍 PROCESSING 时「退款长时间未到账」按 outcome 判 detail ==')
  await t('用例 18', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'REFUNDING' })
    const refund = await makeRefund(order.id, {
      status: 'PENDING',
      amount: 100,
      totalAmount: 100,
      activeOrderId: order.id,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      reconcileCount: 5, // 本轮 CAS 会 +1 → 6，命中 alertAfter=6
    })
    resetCounters()
    const advanced = await reconcileMod.reconcileStuckRefunds({
      afterMin: 5,
      intervalMin: 0,
      batch: 10,
      alertAfter: 6,
      query: async () => ({ kind: 'found' as const, refund: { refund_id: 'wxr18', status: 'PROCESSING' as const } }),
    })
    assert.strictEqual(advanced, 0)
    const r = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })
    assert.strictEqual(r.status, 'PENDING', 'PROCESSING 结果不改行的 status（仍是 PENDING）——这正是旧 bug 的根源')
    const stuckAlert = alertCalls.find((c) => c.key === `refund-reconcile-stuck:${refund.id}`)
    assert.ok(stuckAlert, '应发出「退款长时间未到账」告警')
    assert.ok(
      stuckAlert!.lines.some((l) => l.includes('微信侧仍处理中')),
      `detail 应含「微信侧仍处理中」，实际 ${JSON.stringify(stuckAlert!.lines)}`
    )
    assert.ok(
      !stuckAlert!.lines.some((l) => l.includes('查询失败')),
      `PROCESSING 场景不应出现「查询失败」，实际 ${JSON.stringify(stuckAlert!.lines)}`
    )
  })

  console.log('== 19. F2：并发场景——reconcileRefund 返回 PROCESSING 时行已被并发推成 SUCCESS，不发「未到账」告警 ==')
  await t('用例 19', async () => {
    const order = await makeOrder({ actualAmount: 100, status: 'PAID' })
    const refund = await makeRefund(order.id, {
      status: 'PENDING',
      amount: 100,
      totalAmount: 100,
      activeOrderId: order.id,
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      reconcileCount: 5,
    })
    resetCounters()
    const advanced = await reconcileMod.reconcileStuckRefunds({
      afterMin: 5,
      intervalMin: 0,
      batch: 10,
      alertAfter: 6,
      query: async () => {
        // 模拟并发：查询期间该行已被别的路径（例如回调）推成 SUCCESS，
        // 但 wechat 侧此刻返回的仍是 PROCESSING（查询发起时行还是 PENDING）。
        await prisma.refund.update({ where: { id: refund.id }, data: { status: 'SUCCESS', activeOrderId: null } })
        return { kind: 'found' as const, refund: { refund_id: 'wxr19', status: 'PROCESSING' as const } }
      },
    })
    assert.strictEqual(advanced, 0, 'reconcileRefund 对这一行返回的是 PROCESSING，不计入 advanced')
    const stuckAlert = alertCalls.find((c) => c.key === `refund-reconcile-stuck:${refund.id}`)
    assert.strictEqual(stuckAlert, undefined, '行已被并发推成 SUCCESS，不应再发「退款长时间未到账」')
  })

  restoreAll()
  await prisma.$disconnect()

  console.log(`\n================ 通过 ${pass} / 失败 ${fail} ================`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
