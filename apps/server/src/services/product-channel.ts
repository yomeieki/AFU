/**
 * 商品 channel 冗余的唯一写入点。
 *
 * Product.channel 冗余自 Category.channel，避免列表按渠道过滤时 join。
 * 冗余一旦漂移，同城菜单就会出现邮寄商品（或反之），所以：
 *  - 创建/改分类时都从这里取渠道，和 categoryId 同一事务；
 *  - 分类改渠道走 changeCategoryChannel 级联；
 *  - scripts/check-channel-consistency.mjs 定期校验。
 */
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'
import { Channel, CHANNELS } from '../utils/channel'

type Db = Prisma.TransactionClient | typeof prisma

export async function channelOfCategory(db: Db, categoryId: number): Promise<Channel> {
  const cat = await db.category.findUnique({ where: { id: categoryId }, select: { channel: true } })
  if (!cat) throw new AppError(40401, '分类不存在', 404)
  return (CHANNELS as readonly string[]).includes(cat.channel) ? (cat.channel as Channel) : 'EXPRESS'
}

/**
 * 商品跨渠道迁移前的两条防线，供「分类改渠道」（changeCategoryChannel）与
 * 「单商品换分类到跨渠道分类」（admin/products PUT /:id）共用：
 *  ①存在含这些商品的待付款订单则拒绝 42231（付款后会按旧渠道履约，状态机会错乱）；
 *  ②级联删除这些商品的购物车行（防止购物车里静默出现跨渠道商品，顾客刷新时商品无声消失
 *    好过继续显示一个已经不在当前渠道购物车逻辑里的商品）。
 * 调用方只应在「新渠道 !== 旧渠道」时调用本函数——同渠道换分类不受影响，不必跑这两条防线。
 */
export async function assertNoUnpaidAndPurgeCarts(
  tx: Db,
  productIds: number[]
): Promise<{ cartsDeleted: number }> {
  if (productIds.length === 0) return { cartsDeleted: 0 }
  const unpaid = await tx.order.count({
    where: { status: 'PENDING_PAYMENT', items: { some: { productId: { in: productIds } } } },
  })
  if (unpaid > 0) {
    throw new AppError(42231, `有 ${unpaid} 笔待付款订单包含这些商品，请等其支付或超时取消后再改渠道`)
  }
  const carts = await tx.cart.deleteMany({ where: { productId: { in: productIds } } })
  return { cartsDeleted: carts.count }
}

/**
 * 分类改渠道：同事务级联更新旗下商品 channel + 走上面两条防线。
 */
export async function changeCategoryChannel(
  categoryId: number,
  channel: Channel
): Promise<{ productsUpdated: number; cartsDeleted: number }> {
  return prisma.$transaction(async (tx) => {
    const cat = await tx.category.findUnique({ where: { id: categoryId } })
    if (!cat) throw new AppError(40401, '分类不存在', 404)
    if (cat.channel === channel) return { productsUpdated: 0, cartsDeleted: 0 }

    const products = await tx.product.findMany({
      where: { categoryId, deletedAt: null },
      select: { id: true },
    })
    const productIds = products.map((p) => p.id)

    const { cartsDeleted } = await assertNoUnpaidAndPurgeCarts(tx, productIds)

    await tx.category.update({ where: { id: categoryId }, data: { channel } })
    const updated = productIds.length
      ? await tx.product.updateMany({ where: { id: { in: productIds } }, data: { channel } })
      : { count: 0 }
    return { productsUpdated: updated.count, cartsDeleted }
  })
}
