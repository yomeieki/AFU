/**
 * 去掉规格项名字的首尾空格（全店扫描）。只改 specDimensions 里的 name，
 * 不碰 sku —— 组合的 specText/specValues 只含「值」不含「项名」。
 * 默认 dry-run，--apply 才写库。
 */
import 'dotenv/config'
import { PrismaClient, Prisma } from '@prisma/client'
const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')
type Dim = { name: string; values: string[] }

async function main() {
  const cats = await prisma.category.findMany()
  const cn = new Map(cats.map((c) => [c.id, `${c.name}/${c.channel === 'LOCAL' ? '同城' : '邮寄'}`]))
  const ps = await prisma.product.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, categoryId: true, specDimensions: true, _count: { select: { skus: true } } },
    orderBy: { id: 'asc' },
  })
  console.log(APPLY ? '### 实际写入 ###\n' : '### DRY-RUN（不写库）###\n')
  let n = 0
  for (const p of ps) {
    const dims = p.specDimensions as unknown as Dim[] | null
    if (!dims) continue
    if (!dims.some((d) => d.name !== d.name.trim())) continue
    const newDims: Dim[] = dims.map((d) => ({ ...d, name: d.name.trim() }))
    n++
    const from = dims.map((d) => `「${d.name}」`).join(' ')
    const to = newDims.map((d) => `「${d.name}」`).join(' ')
    console.log(`#${String(p.id).padEnd(4)} [${cn.get(p.categoryId)}] ${p.name.padEnd(8)} ${from} → ${to}   (${p._count.skus} 条组合不受影响)`)
    if (!APPLY) continue
    await prisma.product.update({ where: { id: p.id }, data: { specDimensions: newDims as unknown as Prisma.InputJsonValue } })
    console.log('      ✔ 已写入')
  }
  console.log(`\n${APPLY ? '已处理' : '计划处理'} ${n} 个商品`)
}
main().finally(() => prisma.$disconnect())
