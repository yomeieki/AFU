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
 * 分类改渠道：同事务级联更新旗下商品 channel + 删除这些商品的购物车行。
 * 存在含该分类商品的待付款订单时拒绝（付款后会按旧渠道履约，状态机会错乱）。
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

    if (productIds.length > 0) {
      const unpaid = await tx.order.count({
        where: { status: 'PENDING_PAYMENT', items: { some: { productId: { in: productIds } } } },
      })
      if (unpaid > 0) {
        throw new AppError(42231, `该分类下有 ${unpaid} 笔待付款订单，请等其支付或超时取消后再改渠道`)
      }
    }

    await tx.category.update({ where: { id: categoryId }, data: { channel } })
    const updated = productIds.length
      ? await tx.product.updateMany({ where: { id: { in: productIds } }, data: { channel } })
      : { count: 0 }
    const carts = productIds.length
      ? await tx.cart.deleteMany({ where: { productId: { in: productIds } } })
      : { count: 0 }
    return { productsUpdated: updated.count, cartsDeleted: carts.count }
  })
}
