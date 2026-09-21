/**
 * 克数规格按数值升序重排；同城那套「100」统一改写成「100克」。
 * 默认 dry-run，--apply 才写库。不动价格/库存/组合数量。
 * 注意：默认选中由 skus 数组顺序决定（sku-popup/index.js initSelection），本次不动 sku 排序。
 */
import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'
const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
type Dim = { name: string; values: string[] }
const numOf = (v: string) => { const m = String(v).match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN }
const isWeighty = (d: Dim) => d.values.length > 1 && d.values.every((v) => !isNaN(numOf(v)))
const unify = (v: string) => (/^\s*\d+(\.\d+)?\s*$/.test(String(v)) ? String(v).trim() + '克' : String(v))

async function main() {
  const cats = await prisma.category.findMany()
  const cn = new Map(cats.map((c) => [c.id, `${c.name}/${c.channel === 'LOCAL' ? '同城' : '邮寄'}`]))
  const ps = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, categoryId: true, specDimensions: true,
              skus: { select: { id: true, specText: true, specValues: true } } },
    orderBy: { id: 'asc' },
  })
  console.log(APPLY ? '### 实际写入 ###\n' : '### DRY-RUN（不写库）###\n')
  let dimCount = 0, skuCount = 0

  for (const p of ps) {
    const dims = p.specDimensions as unknown as Dim[] | null
    if (!dims) continue
    const newDims: Dim[] = dims.map((d) => ({ ...d, values: [...d.values] }))
    const renames: Array<{ di: number; from: string; to: string }> = []
    let changed = false

    newDims.forEach((d, di) => {
      if (!isWeighty(d)) return
      const before = d.values.join('|')
      d.values.forEach((v, i) => { const u = unify(v); if (u !== v) { renames.push({ di, from: v, to: u }); d.values[i] = u } })
      d.values.sort((a, b) => numOf(a) - numOf(b))
      if (d.values.join('|') !== before) changed = true
    })
    if (!changed) continue
    dimCount++

    // sku 文案随改名同步（只改被重写的那个维度值）
    const skuEdits: Array<{ id: number; text: string; vals: string[] }> = []
    for (const s of p.skus) {
      const vals = [...(s.specValues as any)] as string[]
      let touched = false
      for (const r of renames) if (String(vals[r.di]) === r.from) { vals[r.di] = r.to; touched = true }
      if (touched) skuEdits.push({ id: s.id, text: vals.join('/'), vals })
    }
    skuCount += skuEdits.length

    const wd = newDims.find((d) => isWeighty(d))!
    const od = dims.find((d) => d.name === wd.name)!
    console.log(`#${String(p.id).padEnd(4)} [${cn.get(p.categoryId)}] ${p.name.padEnd(8)} [${od.values.join(', ')}] → [${wd.values.join(', ')}]${skuEdits.length ? `  同步改 ${skuEdits.length} 条组合文案` : ''}`)

    if (!APPLY) continue
    await prisma.$transaction(async (tx) => {
      for (const e of skuEdits) {
        await tx.productSku.update({ where: { id: e.id },
          data: { specText: e.text, specValues: e.vals as unknown as Prisma.InputJsonValue } })
      }
      await tx.product.update({ where: { id: p.id },
        data: { specDimensions: newDims as unknown as Prisma.InputJsonValue } })
    })
  }
  console.log(`\n${APPLY ? '已处理' : '计划处理'} ${dimCount} 个商品的克数规格，同步改写 ${skuCount} 条组合文案`)
}
main().finally(() => prisma.$disconnect())
