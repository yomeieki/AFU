import { Prisma } from '@prisma/client'

interface RollbackItem {
  productId: number | null
  skuId?: number | null
  quantity: number
}

/**
 * 订单取消/退款时回滚库存与销量。
 * 有 SKU 的行同时回滚 SKU 库存，维持 product.stock = sum(sku.stock) 约定。
 * 必须在事务内调用。
 */
export async function rollbackOrderStock(tx: Prisma.TransactionClient, items: RollbackItem[]) {
  for (const item of items) {
    if (item.productId == null) continue // 商品已删除，跳过
    if (item.skuId != null) {
      // SKU 可能已被删除（规格调整），存在才回滚
      await tx.productSku.updateMany({
        where: { id: item.skuId },
        data: { stock: { increment: item.quantity } },
      })
    }
    await tx.product.update({
      where: { id: item.productId },
      data: {
        stock: { increment: item.quantity },
        salesCount: { decrement: item.quantity },
      },
    })
  }
}
