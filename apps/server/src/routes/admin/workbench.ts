/**
 * 接单工作台快照：五列归类与排序都在服务端做——排序硬规则（同城恒上）是产品规则不是展示偏好，
 * 放服务端保证小程序端未来复用同一口径。3 秒缓存挡 10s×N 店员的轮询洪峰；?fresh=1 供操作后强刷。
 */
import { Router, Request, Response, NextFunction } from 'express'
import prisma from '../../utils/prisma'
import { success } from '../../utils/response'
import { DELIVERY_STATUS_LABEL } from '../../services/delivery/state'
import { getCircuitState } from '../../services/delivery/circuit'
import { getLocalSettings, isOpenNow } from '../../services/local-settings'
import { REAL_ORDERS } from '../../utils/stats-scope'
import { getWorkbenchPrinterHealth, PrinterHealthEntry } from '../../services/ticket'

const router = Router()
const WAITING_STATUSES = ['CALLING', 'ACCEPTED', 'ARRIVING', 'ARRIVED', 'REASSIGNING', 'ABNORMAL', 'UNKNOWN']
let cache: { at: number; data: unknown } | null = null

/**
 * 多台打印机时取「最差」状态作为工作台顶栏那一个状态灯的口径：任何一台离线/查询出错就算 OFFLINE，
 * 否则任何一台缺纸/开盖/未知就算 ABNORMAL，全部在线才是 ONLINE；未启用或未绑定任何打印机则是
 * NOT_CONNECTED（对应旧硬编码值，前端「未接入」文案继续可用）。这个四态归并规则规格没有写死，是本批
 * 自行做的选择——多打印机场景目前只有「同城/邮寄分渠道各一台」，先给个够用的合并口径，
 * 后续如果需要逐台展示，`printers` 字段已经带了明细，前端可以不经服务端改动就切换成逐台展示。
 */
function summarizePrinterStatus(entries: PrinterHealthEntry[]): 'NOT_CONNECTED' | 'ONLINE' | 'ABNORMAL' | 'OFFLINE' {
  if (entries.length === 0) return 'NOT_CONNECTED'
  if (entries.some((e) => e.state === 'OFFLINE' || e.state === 'ERROR')) return 'OFFLINE'
  if (entries.some((e) => e.state === 'ABNORMAL' || e.state === 'UNKNOWN')) return 'ABNORMAL'
  return 'ONLINE'
}

function startOfToday(): Date { const d = new Date(); d.setHours(0, 0, 0, 0); return d }

type OrderRow = Awaited<ReturnType<typeof loadOrders>>[number]
async function loadOrders() {
  return prisma.order.findMany({
    where: {
      OR: [
        { status: { in: ['PAID', 'PREPARING', 'SHIPPED'] } },
        { status: 'COMPLETED', completedAt: { gte: startOfToday() } },
      ],
    },
    include: {
      items: { select: { productName: true, quantity: true, isGift: true } },
      shipment: { select: { expressCompany: true, expressNo: true, shippedAt: true } },
    },
    orderBy: { id: 'desc' },
    take: 300,
  })
}

function toCard(o: OrderRow, waitSince: Date | null, d: { status: string; courierName: string | null; courierMobile: string | null; providerDistanceM: number | null; pickedUpAt?: Date | null } | null): Record<string, unknown> {
  const units = o.items.reduce((n, it) => n + it.quantity, 0)
  return {
    orderId: o.id, orderNo: o.orderNo, channel: o.deliveryType, status: o.status,
    waitSince: (waitSince ?? o.createdAt).toISOString(), amountFen: o.actualAmount,
    // 赠品在卡片上也要标：工作台卡片是店员接单时看的第一眼，漏标就可能整单少备一份
    items: { first: o.items.slice(0, 2).map((it) => `${it.isGift ? '赠 ' : ''}${it.productName} ×${it.quantity}`), kinds: o.items.length, units },
    note: o.remark || null,
    receiver: { name: o.receiverName, phone: o.receiverPhone },
    express: o.deliveryType === 'EXPRESS'
      ? { province: o.receiverProvince, city: o.receiverCity, expressCompany: o.shipment?.expressCompany ?? null, expressNo: o.shipment?.expressNo ?? null }
      : null,
    local: o.deliveryType === 'LOCAL'
      ? {
          distanceM: d?.providerDistanceM ?? null,
          estimatedDeliveryAt: o.estimatedDeliveryAt?.toISOString() ?? null,
          cancelRequested: !!o.cancelRequestedAt && !['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(o.status),
          delivery: d ? { status: d.status, statusLabel: DELIVERY_STATUS_LABEL[d.status] ?? d.status, courierName: d.courierName, courierMobile: d.courierMobile } : null,
        }
      : null,
  }
}

/** 规格 §2：同城恒排邮寄之上；同渠道内等待久的在上（done 列新在上） */
function sortColumn(cards: { channel: string; waitSince: string }[], newestFirst = false) {
  cards.sort((a, b) => {
    if (a.channel !== b.channel) return a.channel === 'LOCAL' ? -1 : 1
    return newestFirst ? b.waitSince.localeCompare(a.waitSince) : a.waitSince.localeCompare(b.waitSince)
  })
}

router.get('/snapshot', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 命中缓存要返回副本：缓存对象会被 3 秒内的每一个请求共享，
    // 将来任何一个中间件顺手往响应体上挂个字段，就会污染所有后续读者。
    if (req.query.fresh !== '1' && cache && Date.now() - cache.at < 3000) return success(res, structuredClone(cache.data))
    const [orders, settings] = await Promise.all([loadOrders(), getLocalSettings()])
    const localIds = orders.filter((o) => o.deliveryType === 'LOCAL').map((o) => o.id)
    const actives = localIds.length
      ? await prisma.delivery.findMany({ where: { activeOrderId: { in: localIds } }, select: { activeOrderId: true, status: true, courierName: true, courierMobile: true, providerDistanceM: true, calledAt: true, pickedUpAt: true } })
      : []
    const byOrder = new Map(actives.map((d) => [d.activeOrderId!, d]))

    const cols: Record<string, ReturnType<typeof toCard>[]> = { pending: [], preparing: [], waitingCourier: [], delivering: [], done: [] }
    for (const o of orders) {
      const d = byOrder.get(o.id) ?? null
      if (o.status === 'PAID') cols.pending.push(toCard(o, o.paidAt, d))
      else if (o.status === 'PREPARING') {
        if (o.deliveryType === 'LOCAL' && d && WAITING_STATUSES.includes(d.status)) cols.waitingCourier.push(toCard(o, d.calledAt, d))
        else cols.preparing.push(toCard(o, o.acceptedAt, d))
      }
      // Order 没有 shippedAt 列——同城取配送单的取货时间，邮寄取运单的发货时间，都缺则退回接单时间
      else if (o.status === 'SHIPPED') cols.delivering.push(toCard(o, d?.pickedUpAt ?? o.shipment?.shippedAt ?? o.acceptedAt, d))
      else if (o.status === 'COMPLETED') cols.done.push(toCard(o, o.completedAt, d))
    }
    for (const k of ['pending', 'preparing', 'waitingCourier', 'delivering'] as const) sortColumn(cols[k] as never)
    sortColumn(cols.done as never, true)
    cols.done = cols.done.slice(0, 30)

    const today = startOfToday()
    const [todayOrders, revenue, doneLocal, cancelReqCount, badDeliveries, printerEntries] = await Promise.all([
      // 三个经营数字都排除测试单（口径见 utils/stats-scope）。上面的五列卡片故意**不**排除：
      // 联调时店员要在工作台上看到自己造的那一单走完流程，那是操作视图不是统计。
      prisma.order.count({ where: { ...REAL_ORDERS, paidAt: { gte: today } } }),
      prisma.order.aggregate({ where: { ...REAL_ORDERS, paidAt: { gte: today } }, _sum: { actualAmount: true } }),
      // paidAt 也必须限定今天：跨零点完成的单（昨晚下单、今早送达）会把「平均送达时长」拉成好几小时，
      // 而它的真实配送时长并不长——店主读到的那个数就废了。
      prisma.order.findMany({ where: { ...REAL_ORDERS, deliveryType: 'LOCAL', status: 'COMPLETED', completedAt: { gte: today }, paidAt: { gte: today } }, select: { paidAt: true, completedAt: true }, take: 200 }),
      prisma.order.count({ where: { deliveryType: 'LOCAL', cancelRequestedAt: { not: null }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REFUNDED'] } } }),
      prisma.delivery.count({ where: { activeOrderId: { not: null }, status: { in: ['ABNORMAL', 'UNKNOWN'] } } }),
      getWorkbenchPrinterHealth(),
    ])
    const durations = doneLocal.filter((o) => o.paidAt && o.completedAt).map((o) => (o.completedAt!.getTime() - o.paidAt!.getTime()) / 60000)
    const circuit = getCircuitState()
    const data = {
      columns: cols,
      stats: {
        todayOrders,
        todayRevenueFen: revenue._sum.actualAmount ?? 0,
        avgDeliverMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      },
      circuit: { tripped: circuit.tripped },
      localEnabled: settings.enabled, localOpenNow: isOpenNow(settings),
      paused: settings.paused ? { reason: settings.paused.reason, until: settings.paused.until } : null,
      printer: {
        status: summarizePrinterStatus(printerEntries),
        printers: printerEntries.map((e) => ({ sn: e.sn, name: e.name, state: e.state })),
      },
      pendingAlerts: cancelReqCount + badDeliveries + (circuit.tripped ? 1 : 0),
      now: new Date().toISOString(),
    }
    cache = { at: Date.now(), data }
    success(res, data)
  } catch (e) { next(e) }
})
export default router
