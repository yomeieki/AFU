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
 *
 * 锁序 L1(product_skus 按 id 升序) → L2(products 按 id 升序)，与 `routes/orders.ts` 下单
 * 事务、`routes/admin/products.ts` 的 PUT /:id/stock 同一顺序（见
 * docs/superpowers/plans/2026-09-24-order-deadlock.md §0.4）。旧实现按 `items` 原始顺序
 * sku₁→product₁→sku₂→product₂ 交替加锁，两笔多规格订单的回滚若顺序相反可以成环；
 * 这里先把全部 sku 按 id 升序聚合处理完，再把全部 product 按 id 升序聚合处理，
 * 与其它路径同向，不会再和它们成环。
 */
export async function rollbackOrderStock(tx: Prisma.TransactionClient, items: RollbackItem[]) {
  // L1：按 skuId 聚合、升序逐条回滚（sku 可能已被删除——规格调整，updateMany 命中 0 行即可，语义不变）
  const skuAgg = new Map<number, number>()
  for (const item of items) {
    if (item.productId == null) continue // 商品已删除，跳过
    if (item.skuId == null) continue
    skuAgg.set(item.skuId, (skuAgg.get(item.skuId) ?? 0) + item.quantity)
  }
  for (const skuId of [...skuAgg.keys()].sort((a, b) => a - b)) {
    await tx.productSku.updateMany({
      where: { id: skuId },
      data: { stock: { increment: skuAgg.get(skuId)! } },
    })
  }

  // L2：按 productId 聚合、升序逐条回滚 + 减销量
  const productAgg = new Map<number, number>()
  for (const item of items) {
    if (item.productId == null) continue // 商品已删除，跳过
    productAgg.set(item.productId, (productAgg.get(item.productId) ?? 0) + item.quantity)
  }
  for (const productId of [...productAgg.keys()].sort((a, b) => a - b)) {
    await tx.product.update({
      where: { id: productId },
      data: {
        stock: { increment: productAgg.get(productId)! },
        salesCount: { decrement: productAgg.get(productId)! },
      },
    })
  }
}
