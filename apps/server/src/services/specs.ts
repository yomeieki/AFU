import { z } from 'zod'
import { AppError } from '../middlewares/error'

export const specDimensionSchema = z.object({
  name: z.string().min(1, '规格维度名不能为空').max(32),
  values: z.array(z.string().min(1).max(32)).min(1, '规格维度至少一个值').max(20),
})

export const skuSchema = z.object({
  id: z.number().int().positive().optional(),
  specText: z.string().min(1).max(128),
  specValues: z.array(z.string().min(1).max(32)).min(1),
  price: z.number().int().positive('规格价格必须大于 0'),
  originalPrice: z.number().int().positive().nullable().optional(),
  stock: z.number().int().min(0).default(0),
  sortOrder: z.number().int().min(0).default(0),
})

export type SpecDimensionInput = z.infer<typeof specDimensionSchema>
export type SkuInput = z.infer<typeof skuSchema>

/**
 * 校验维度与 SKU 组合一致性；返回规范化后的 dimensions（null=无规格）。
 * 同一维度内的值去首尾空格后不得为空、不得重复。
 */
export function validateSpecs(
  specDimensions: SpecDimensionInput[] | null | undefined,
  skus: SkuInput[] | undefined
): { dims: SpecDimensionInput[] | null; skuList: SkuInput[] } {
  const dims = specDimensions?.length ? specDimensions : null
  const skuList = skus ?? []
  if (dims && skuList.length === 0) {
    throw new AppError(40001, '配置了规格维度但未提供任何规格组合', 400)
  }
  if (!dims && skuList.length > 0) {
    throw new AppError(40001, '提供了规格组合但缺少规格维度定义', 400)
  }
  if (!dims) return { dims: null, skuList: [] }

  for (const dim of dims) {
    const seen = new Set<string>()
    for (const raw of dim.values) {
      const v = raw.trim()
      if (!v) {
        throw new AppError(40001, `维度「${dim.name}」存在空白的规格值`, 400)
      }
      if (seen.has(v)) {
        throw new AppError(40001, `维度「${dim.name}」存在重复的规格值「${v}」`, 400)
      }
      seen.add(v)
    }
  }

  const seenSpecText = new Set<string>()
  for (const sku of skuList) {
    if (sku.specValues.length !== dims.length) {
      throw new AppError(40001, `规格「${sku.specText}」的值数量与维度数不一致`, 400)
    }
    sku.specValues.forEach((v, i) => {
      if (!dims[i].values.includes(v)) {
        throw new AppError(40001, `规格值「${v}」不在维度「${dims[i].name}」中`, 400)
      }
    })
    const joined = sku.specValues.join('/')
    if (sku.specText !== joined) {
      throw new AppError(40001, `规格「${sku.specText}」与其值组合「${joined}」不一致`, 400)
    }
    if (seenSpecText.has(sku.specText)) {
      throw new AppError(40001, `规格「${sku.specText}」重复`, 400)
    }
    seenSpecText.add(sku.specText)
  }
  return { dims, skuList }
}

/** 有 SKU 时按 SKU 汇总回写商品冗余字段（price=min, stock=sum, originalPrice=min价 SKU 的原价） */
export function aggregateFromSkus(skuList: SkuInput[]) {
  const minPriceSku = skuList.reduce((m, s) => (s.price < m.price ? s : m), skuList[0])
  return {
    price: minPriceSku.price,
    originalPrice: minPriceSku.originalPrice ?? null,
    stock: skuList.reduce((sum, s) => sum + s.stock, 0),
  }
}

/**
 * syncProductSkus 用到的最小 Prisma 事务接口，只含用到的四个方法。
 * `Prisma.TransactionClient` 结构上兼容，可直接传入。
 */
export interface SkuTx {
  productSku: {
    findMany(args: { where: { productId: number } }): Promise<Array<{ id: number; specText: string }>>
    deleteMany(args: { where: { id: { in: number[] }; productId: number } }): Promise<unknown>
    update(args: { where: { id: number }; data: Record<string, unknown> }): Promise<unknown>
    create(args: { data: Record<string, unknown> }): Promise<unknown>
  }
}

/**
 * 两阶段同步商品 SKU：
 * 1. 删除本次未携带 id 的旧行（cascade 会清对应购物车项）；
 * 2. 阶段一：对「有 id 且 specText 有变化」的行先改成不会冲突的临时 specText——
 *    维度重排/改名后两个 SKU 的 specText 可能互换（A→B、B→A），逐条直接写会撞
 *    (product_id, spec_text) 唯一索引；
 * 3. 阶段二：按最终值 update（已有 id）或 create（无 id / id 不属于该商品）。
 */
export async function syncProductSkus(tx: SkuTx, productId: number, skuList: SkuInput[]): Promise<void> {
  const existing = await tx.productSku.findMany({ where: { productId } })
  const existingById = new Map(existing.map((e) => [e.id, e]))
  const keepIds = new Set(skuList.filter((s) => s.id).map((s) => s.id as number))
  const toDelete = existing.filter((e) => !keepIds.has(e.id)).map((e) => e.id)
  if (toDelete.length) {
    await tx.productSku.deleteMany({ where: { id: { in: toDelete }, productId } })
  }

  const renamed = skuList.filter(
    (s) => s.id && existingById.has(s.id) && existingById.get(s.id)!.specText !== s.specText
  )
  for (const s of renamed) {
    await tx.productSku.update({ where: { id: s.id as number }, data: { specText: `\u0001tmp:${s.id}` } })
  }

  for (let i = 0; i < skuList.length; i++) {
    const s = skuList[i]
    const payload = {
      specText: s.specText,
      specValues: s.specValues,
      price: s.price,
      originalPrice: s.originalPrice ?? null,
      stock: s.stock,
      sortOrder: s.sortOrder ?? i,
    }
    if (s.id && existingById.has(s.id)) {
      await tx.productSku.update({ where: { id: s.id }, data: payload })
    } else {
      await tx.productSku.create({ data: { ...payload, productId } })
    }
  }
}
