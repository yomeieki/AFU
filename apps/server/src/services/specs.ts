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
/** 选项里不允许出现的控制字符；兜住临时 specText（\u0001tmp:id）与提交值可能相同的理论碰撞 */
const CONTROL_CHAR = /[\u0000-\u001f]/

export function validateSpecs(
  specDimensions: SpecDimensionInput[] | null | undefined,
  skus: SkuInput[] | undefined
): { dims: SpecDimensionInput[] | null; skuList: SkuInput[] } {
  const dims = specDimensions?.length ? specDimensions : null
  const skuList = skus ?? []
  if (dims && skuList.length === 0) {
    throw new AppError(40001, '设置了规格项但没有任何规格组合', 400)
  }
  if (!dims && skuList.length > 0) {
    throw new AppError(40001, '有规格组合但没有设置规格项', 400)
  }
  if (!dims) return { dims: null, skuList: [] }

  for (const dim of dims) {
    const seen = new Set<string>()
    for (const raw of dim.values) {
      const v = raw.trim()
      if (!v) {
        throw new AppError(40001, `规格项「${dim.name}」里有空白的选项`, 400)
      }
      if (seen.has(v)) {
        throw new AppError(40001, `规格项「${dim.name}」里的选项「${v}」重复了`, 400)
      }
      if (CONTROL_CHAR.test(v)) {
        throw new AppError(40001, `选项「${v}」里有不能用的字符`, 400)
      }
      seen.add(v)
    }
  }

  const seenSpecText = new Set<string>()
  const seenId = new Set<number>()
  for (const sku of skuList) {
    if (sku.id !== undefined) {
      if (seenId.has(sku.id)) {
        throw new AppError(40001, '同一个规格被提交了两次', 400)
      }
      seenId.add(sku.id)
    }
    if (sku.specValues.length !== dims.length) {
      throw new AppError(40001, `规格「${sku.specText}」的选项个数和规格项个数对不上`, 400)
    }
    sku.specValues.forEach((v, i) => {
      if (!dims[i].values.includes(v)) {
        throw new AppError(40001, `选项「${v}」不在规格项「${dims[i].name}」里`, 400)
      }
    })
    const joined = sku.specValues.join('/')
    if (sku.specText !== joined) {
      throw new AppError(40001, `规格「${sku.specText}」和它的选项组合「${joined}」对不上`, 400)
    }
    if (seenSpecText.has(sku.specText)) {
      throw new AppError(40001, `规格「${sku.specText}」重复了`, 400)
    }
    seenSpecText.add(sku.specText)
  }

  // 组合行必须恰好覆盖 dims 的完整笛卡尔积（不缺、不多），否则小程序里会出现
  // 永远选不出对应 SKU 的规格值组合（第一轮裁决 R6，用户选定服务端也校验）。
  const expectedCombos = dims.reduce<string[][]>(
    (acc, d) => acc.flatMap((combo) => d.values.map((v) => [...combo, v])),
    [[]]
  )
  if (skuList.length !== expectedCombos.length) {
    throw new AppError(40001, '规格组合的个数和选项对不上，请关掉编辑窗口重新打开后再保存', 400)
  }
  const expectedKeys = new Set(expectedCombos.map((c) => JSON.stringify(c)))
  for (const sku of skuList) {
    if (!expectedKeys.has(JSON.stringify(sku.specValues))) {
      throw new AppError(40001, '规格组合和选项对不上，请关掉编辑窗口重新打开后再保存', 400)
    }
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
 * 2. 阶段一：只对「有 id、specText 有变化、且它当前的 specText 正好被本次提交里
 *    某一行（不论是它自己以外的已有行还是新行）的最终 specText 占用」的行先改成
 *    不会冲突的临时 specText——维度重排/改名后两个 SKU 的 specText 可能互换
 *    （A→B、B→A），逐条直接写会撞 (product_id, spec_text) 唯一索引；其余「有变化
 *    但旧名没人要」的行不需要经过临时名，直接在阶段二一次 update 到位（第二轮
 *    复核 R11：链式改名场景下能省下一半的 UPDATE，60 SKU 上限时最多能省约 60 次）。
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

  // 本次提交里所有行最终 specText 的计数：只要某个旧 specText 在这里出现过
  // （不管是被它自己还是被别的行盯上），直接改到最终值就有撞索引的风险。
  const finalTextCount = new Map<string, number>()
  for (const s of skuList) finalTextCount.set(s.specText, (finalTextCount.get(s.specText) ?? 0) + 1)

  const changed = skuList.filter(
    (s) => s.id && existingById.has(s.id) && existingById.get(s.id)!.specText !== s.specText
  )
  const needsTemp = changed.filter((s) => finalTextCount.has(existingById.get(s.id as number)!.specText))
  for (const s of needsTemp) {
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
