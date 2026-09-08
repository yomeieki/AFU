/**
 * 下单行的组装与可售校验。从 routes/orders.ts 抽出（2026-09-08），供下单与邮寄报价共用：
 * 报价必须按**同一份**清单算重量，否则凭证里的指纹对不上。搬出来时逻辑一字未改。
 */
import { Prisma } from '@prisma/client'
import prisma from '../utils/prisma'
import { AppError } from '../middlewares/error'

export interface OrderLine {
  productId: number
  skuId: number | null
  quantity: number
  product: Prisma.ProductGetPayload<Record<string, never>>
  sku: Prisma.ProductSkuGetPayload<Record<string, never>> | null
}
export interface DirectItemInput { productId: number; skuId?: number; quantity: number }

/** 购物车项 或 立即购买单品（不经购物车，避免与已加购数量合并）——二选一 */
export async function loadOrderLines(userId: number, src: { cartItemIds?: number[]; directItem?: DirectItemInput }): Promise<OrderLine[]> {
  if (src.cartItemIds) {
    const cartItems = await prisma.cart.findMany({
      where: { id: { in: src.cartItemIds }, userId },
      include: { product: true, sku: true },
    })
    if (cartItems.length === 0) throw new AppError(40001, '购物车商品不存在或不属于当前用户')
    return cartItems.map((c) => ({ productId: c.productId, skuId: c.skuId, quantity: c.quantity, product: c.product, sku: c.sku }))
  }
  const item = src.directItem
  if (!item) throw new AppError(40001, '请选择商品')
  const product = await prisma.product.findFirst({ where: { id: item.productId, deletedAt: null }, include: { skus: true } })
  if (!product) throw new AppError(40401, '商品不存在')
  let sku: OrderLine['sku'] = null
  if (product.skus.length > 0) {
    if (!item.skuId) throw new AppError(40001, '请选择商品规格')
    sku = product.skus.find((s) => s.id === item.skuId) ?? null
    if (!sku) throw new AppError(40401, '商品规格不存在', 404)
  } else if (item.skuId) {
    throw new AppError(40001, '该商品无规格')
  }
  const { skus: _skus, ...plain } = product
  return [{ productId: product.id, skuId: sku?.id ?? null, quantity: item.quantity, product: plain, sku }]
}

/** 逐个验证商品（有 SKU 的行按 SKU 库存校验）——与下单时的判定完全一致 */
export function assertLinesSellable(lines: OrderLine[], channel: 'EXPRESS' | 'LOCAL'): void {
  for (const line of lines) {
    const p = line.product
    if (!p || p.deletedAt) throw new AppError(40401, '商品不存在')
    if (p.channel !== channel) {
      throw new AppError(42224, channel === 'LOCAL' ? `${p.name} 不是同城配送商品` : `${p.name} 是同城配送商品，请到同城页面下单`)
    }
    if (p.status !== 'ON_SHELF') throw new AppError(42202, `${p.name} 已下架`)
    if (line.skuId && !line.sku) throw new AppError(40401, `${p.name} 所选规格已失效`)
    const stock = line.sku?.stock ?? p.stock
    const label = line.sku ? `${p.name}（${line.sku.specText}）` : p.name
    if (stock < line.quantity) throw new AppError(42201, `${label} 库存不足（剩余 ${stock}）`)
  }
}
