/**
 * 骑手实时位置：取数 + 20 秒进程内缓存。顾客端与管理端**共用这一份**。
 *
 * 原来这段逻辑内联在 routes/orders.ts 的顾客端路由里，管理端一处都没接——
 * 于是 2026-09-06 首单时出现了「顾客能看到骑手在哪，店员看不到」的倒挂
 * （实际上那天顾客端也是坏的，见下）。抽出来是为了让管理端接上时不必复制一份，
 * 两份缓存与两份负缓存迟早会 drift。
 *
 * ⚠️ 两条踩过的坑，改这里之前先读：
 *  1. `queryCourier` 认的是 **orderId**（快递100 侧订单号 = Delivery.providerOrderId），
 *     不是并呼下单返回的 taskId。只传 taskId 会被拒 30001「orderId不能为空」，而失败被
 *     调用方的 catch 吞成 location:null，页面只是不显示卡片、不报错——所以从上线起
 *     一次都没成功过也没人发现（修于 806c2a3，详见 kd100.ts 的 queryCourier 注释）。
 *  2. **失败也要写缓存（负缓存）**：否则运力方故障时每次轮询都真打一发外部 API，
 *     把对方的故障放大成我们这边的持续压测。
 *
 * 进程内缓存对得起现在的部署形态：PM2 单实例 fork（ecosystem.config.js）。
 * 真起多实例时这里会变成「每个实例各缓存一份」——上限仍是 N × 3 次/分钟，可接受，
 * 但值得知道。
 */
import prisma from '../../utils/prisma'
import { getDeliveryProvider } from './provider'

export const COURIER_CACHE_TTL_MS = 20 * 1000
/** 只有骑手真的上路了才有位置可查；CALLING/PENDING 阶段还没有骑手 */
export const COURIER_LIVE_STATUSES = ['ACCEPTED', 'ARRIVING', 'ARRIVED', 'DELIVERING']

const cache = new Map<number, { at: number; loc: Loc | null }>()
export interface Loc { latE6: number; lngE6: number }

/** 缓存里能用来判断「这份位置是什么时候取的」——管理端要把它显示给店员看 */
export interface CourierLocation { location: Loc | null; fetchedAt: string | null }

type DeliveryLike = { id: number; status: string; providerTaskId: string | null; providerOrderId: string | null }

/**
 * 取一次骑手位置。永不抛异常——拿不到就是 `location: null`，由调用方决定是隐藏卡片
 * 还是显示「暂无位置」。
 */
export async function getCourierLocation(delivery: DeliveryLike | null): Promise<CourierLocation> {
  if (!delivery || !delivery.providerTaskId || !COURIER_LIVE_STATUSES.includes(delivery.status)) {
    return { location: null, fetchedAt: null }
  }
  // 顺手清理过期项，避免 Map 随进程寿命无限增长（本店量级无害，但没有回收逻辑总不太好）
  const now = Date.now()
  for (const [key, v] of cache) {
    if (now - v.at >= COURIER_CACHE_TTL_MS) cache.delete(key)
  }
  const cached = cache.get(delivery.id)
  if (cached && now - cached.at < COURIER_CACHE_TTL_MS) {
    return { location: cached.loc, fetchedAt: new Date(cached.at).toISOString() }
  }
  let loc: Loc | null
  try {
    loc = await getDeliveryProvider().queryCourier({ taskId: delivery.providerTaskId, orderId: delivery.providerOrderId })
  } catch (e) {
    // 负缓存：见文件头第 2 条
    console.warn('[courier] 查询骑手位置失败:', (e as Error).message)
    loc = null
  }
  const at = Date.now()
  cache.set(delivery.id, { at, loc })
  return { location: loc, fetchedAt: new Date(at).toISOString() }
}

/** 按 orderId 取在途配送单并查位置（顾客端与管理端的公共前半段） */
export async function getCourierLocationByOrder(orderId: number): Promise<CourierLocation & { delivery: DeliveryLike | null }> {
  const delivery = await prisma.delivery.findFirst({
    where: { activeOrderId: orderId },
    select: { id: true, status: true, providerTaskId: true, providerOrderId: true },
  })
  return { ...(await getCourierLocation(delivery)), delivery }
}
