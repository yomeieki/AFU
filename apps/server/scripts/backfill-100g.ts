/**
 * 邮寄分类#1 补 100 克档。价格照抄同城#6 同名/近名菜的 100 克档原价。
 * 默认 dry-run，只有加 --apply 才写库。
 * 不动任何现有 sku 的价格/库存；新档追加到重量维度末尾（默认选中项不变）。
 */
import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'
const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
const yuan = (f: number) => (f / 100).toFixed(2)
const norm = (s: string) => s.replace(/\s+/g, '')
const NEW_LABEL = '100克'
const ALIAS: Record<string, string> = {
  麻辣牛肉: '凉拌牛肉', 红油香嘴: '猪香嘴', 红油耳叶: '凉拌耳片', 红油兔肝: '红油兔干', 兔肚: '凉拌兔肚',
}
const MANUAL_PRICE: Record<number, number> = { 155: 2000 } // 红油猪心：同城无对应，店主定 20 元
const TYPO_FIX: Record<number, [string, string]> = { 155: ['150号', '150克'] }

type Dim = { name: string; values: string[] }

async function main() {
  const sel = { id: true, name: true, price: true, stock: true, specDimensions: true,
    skus: { select: { id: true, specText: true, specValues: true, price: true, stock: true, sortOrder: true } } } as const
  const exp = await prisma.product.findMany({ where: { deletedAt: null, categoryId: 1 }, select: sel, orderBy: { id: 'asc' } })
  const loc = await prisma.product.findMany({ where: { deletedAt: null, categoryId: 6 }, select: sel })

  const locPrice = new Map<string, number>()
  for (const p of loc) {
    const s = p.skus.find((x) => String((x.specValues as any)[1] ?? '').replace(/\s/g, '').startsWith('100'))
    if (s) locPrice.set(norm(p.name), s.price)
  }

  console.log(APPLY ? '### 实际写入模式 ###\n' : '### DRY-RUN（不写库）###\n')
  let planned = 0

  for (const p of exp) {
    const dims = p.specDimensions as unknown as Dim[] | null
    if (!dims) continue
    const wIdx = dims.findIndex((d) => d.name.trim() === '重量')
    const sIdx = dims.findIndex((d) => d.name.trim() !== '重量')
    if (wIdx < 0) continue
    if (dims[wIdx].values.length !== 2) { console.log(`#${p.id} ${p.name} 重量已有 ${dims[wIdx].values.length} 档，跳过`); continue }

    const price = MANUAL_PRICE[p.id] ?? locPrice.get(norm(p.name)) ?? locPrice.get(ALIAS[norm(p.name)] ?? '')
    if (price == null) { console.log(`#${p.id} ${p.name} ⚠ 找不到照抄价，跳过`); continue }

    const spicy = dims[sIdx].values
    const base = p.skus.find((s) => String((s.specValues as any)[wIdx]).includes('150'))
    const stock = base?.stock ?? 0
    let maxSort = Math.max(0, ...p.skus.map((s) => s.sortOrder))

    // 新维度值 & 错别字修正
    const newDims: Dim[] = dims.map((d, i) => (i === wIdx ? { ...d, values: [...d.values] } : d))
    const typo = TYPO_FIX[p.id]
    if (typo) {
      const ti = newDims[wIdx].values.indexOf(typo[0])
      if (ti >= 0) newDims[wIdx].values[ti] = typo[1]
    }
    newDims[wIdx].values.push(NEW_LABEL)

    console.log(`#${p.id} ${p.name}`)
    if (typo) console.log(`   [改错别字] 「${typo[0]}」→「${typo[1]}」，同步改 ${p.skus.filter((s) => String((s.specValues as any)[wIdx]) === typo[0]).length} 条组合`)
    console.log(`   [重量档] [${dims[wIdx].values.join(', ')}] → [${newDims[wIdx].values.join(', ')}]`)
    for (const sv of spicy) {
      const vals = wIdx === 0 ? [NEW_LABEL, sv] : [sv, NEW_LABEL]
      console.log(`   [新增组合] ${vals.join('/')}  ${yuan(price)} 元  库存${stock}`)
      planned++
    }

    if (!APPLY) continue

    await prisma.$transaction(async (tx) => {
      if (typo) {
        const olds = p.skus.filter((s) => String((s.specValues as any)[wIdx]) === typo[0])
        for (const s of olds) {
          const vals = [...(s.specValues as any)] as string[]
          vals[wIdx] = typo[1]
          await tx.productSku.update({ where: { id: s.id }, data: { specText: vals.join('/'), specValues: vals as unknown as Prisma.InputJsonValue } })
        }
      }
      await tx.product.update({ where: { id: p.id }, data: { specDimensions: newDims as unknown as Prisma.InputJsonValue } })
      for (const sv of spicy) {
        const vals = wIdx === 0 ? [NEW_LABEL, sv] : [sv, NEW_LABEL]
        const text = vals.join('/')
        const dup = await tx.productSku.findFirst({ where: { productId: p.id, specText: text } })
        if (dup) { console.log(`   已存在同名组合 ${text}，跳过`); continue }
        await tx.productSku.create({ data: { productId: p.id, specText: text, specValues: vals as unknown as Prisma.InputJsonValue, price, stock, sortOrder: ++maxSort } })
      }
      const all = await tx.productSku.findMany({ where: { productId: p.id }, select: { price: true, stock: true } })
      await tx.product.update({ where: { id: p.id },
        data: { price: Math.min(...all.map((s) => s.price)), stock: all.reduce((n, s) => n + s.stock, 0) } })
    })
    console.log('   ✔ 已写入')
  }
  console.log(`\n${APPLY ? '已写入' : '计划新增'} ${planned} 条组合`)
}
main().finally(() => prisma.$disconnect())
