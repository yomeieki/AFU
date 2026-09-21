/**
 * 规格数据只读体检：对照「规格改名/排序」版本（PR #10）的新校验规则，扫描生产库里
 * 已有的商品规格数据，列出会被新版本自动整理、或需要店员/老板留意的商品。
 *
 * 只做 SELECT，不改任何数据。可以在部署前或部署后运行，结果一样。
 *
 * 用法（apps/server 目录下，需 .env 已配置 DATABASE_URL）：
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/audit-specs.ts
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/audit-specs.ts --json report.json
 *
 * 检查项（与后台打开编辑时的自动整理、保存时的服务端校验一一对应）：
 *   1. 规格项/选项首尾带空格、去空格后为空、去空格后重复、含控制字符
 *   2. 规格项超过 3 个、单个规格项超过 20 个选项、名字或选项超过 32 个字、组合超过 60 个
 *   3. 组合行与规格项对不上：值的个数不对、spec_text 与值不一致、值不在规格项里、内容重复
 *   4. 缺组合（新版本打开编辑会自动补空白行，店员填价格即可）
 *   5. 多余组合（新版本打开编辑会丢弃，保存后对应组合被删除，顾客购物车里对应行会被清掉）
 *   6. 有规格项但没有组合 / 有组合但没有规格项
 *   7. 商品冗余字段（price=min、stock=sum）与组合汇总不一致（仅提示）
 */
import 'dotenv/config'
import fs from 'fs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const MAX_DIMENSIONS = 3
const MAX_VALUES_PER_DIMENSION = 20
const MAX_NAME_LENGTH = 32
const MAX_COMBINATIONS = 60
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

interface Dim {
  name: string
  values: string[]
}

interface Finding {
  level: 'auto' | 'warn' | 'error'
  code: string
  detail: string
}

interface ProductReport {
  id: number
  name: string
  status: string
  dims: number
  skus: number
  findings: Finding[]
}

function cartesian(dims: Dim[]): string[][] {
  if (dims.length === 0) return []
  return dims.reduce<string[][]>(
    (acc, d) => acc.flatMap((combo) => d.values.map((v) => [...combo, v])),
    [[]]
  )
}

const key = (values: string[]) => values.join('\u0000')

function parseDims(raw: unknown): Dim[] | null {
  if (!Array.isArray(raw)) return null
  const dims: Dim[] = []
  for (const d of raw) {
    if (!d || typeof d !== 'object') return null
    const name = (d as { name?: unknown }).name
    const values = (d as { values?: unknown }).values
    if (typeof name !== 'string' || !Array.isArray(values) || values.some((v) => typeof v !== 'string')) {
      return null
    }
    dims.push({ name, values: values as string[] })
  }
  return dims
}

function auditProduct(p: {
  id: number
  name: string
  status: string
  price: number
  stock: number
  specDimensions: unknown
  skus: { id: number; specText: string; specValues: unknown; price: number; stock: number; cartRefs: number }[]
}): ProductReport {
  const findings: Finding[] = []
  const add = (level: Finding['level'], code: string, detail: string) => findings.push({ level, code, detail })

  const dims = p.specDimensions == null ? null : parseDims(p.specDimensions)
  if (p.specDimensions != null && dims === null) {
    add('error', 'DIMS_MALFORMED', 'spec_dimensions 不是 [{name, values[]}] 结构，新版本无法解析')
  }

  const hasDims = !!dims && dims.length > 0
  const hasSkus = p.skus.length > 0
  if (hasDims && !hasSkus) add('error', 'DIMS_WITHOUT_SKUS', '有规格项但没有任何组合，小程序无法选购；新版本打开编辑会补出空白组合')
  if (!hasDims && hasSkus) add('error', 'SKUS_WITHOUT_DIMS', '有组合但没有规格项定义，新版本保存时会报「提供了规格组合但缺少规格项」')

  const report: ProductReport = {
    id: p.id,
    name: p.name,
    status: p.status,
    dims: dims?.length ?? 0,
    skus: p.skus.length,
    findings,
  }
  if (!hasDims || !dims) return report

  // ---- 1 & 2：规格项/选项本身 ----
  if (dims.length > MAX_DIMENSIONS) add('error', 'TOO_MANY_DIMS', `规格项 ${dims.length} 个，超过 ${MAX_DIMENSIONS} 个`)
  const cleanedDims: Dim[] = dims.map((d, i) => {
    const label = d.name.trim() || `第${i + 1}个规格项`
    if (d.name !== d.name.trim()) add('auto', 'DIM_NAME_SPACES', `规格项「${d.name}」首尾带空格，新版本打开编辑会自动去掉`)
    if (!d.name.trim()) add('error', 'DIM_NAME_EMPTY', `第${i + 1}个规格项名字为空`)
    if (d.name.trim().length > MAX_NAME_LENGTH) add('warn', 'DIM_NAME_LONG', `规格项「${d.name}」超过 ${MAX_NAME_LENGTH} 个字，保存时会要求改短`)
    if (CONTROL_CHAR.test(d.name)) add('error', 'DIM_NAME_CONTROL', `规格项「${JSON.stringify(d.name)}」含控制字符，新版本保存会被拒绝`)
    if (d.values.length > MAX_VALUES_PER_DIMENSION) add('warn', 'TOO_MANY_VALUES', `规格项「${label}」有 ${d.values.length} 个选项，超过 ${MAX_VALUES_PER_DIMENSION} 个`)
    if (d.values.length === 0) add('error', 'DIM_NO_VALUES', `规格项「${label}」没有任何选项`)
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const v of d.values) {
      const t = v.trim()
      if (v !== t) add('auto', 'VALUE_SPACES', `规格项「${label}」的选项「${v}」首尾带空格，新版本打开编辑会自动去掉`)
      if (!t) {
        add('auto', 'VALUE_EMPTY', `规格项「${label}」有一个空白选项，新版本打开编辑会自动去掉`)
        continue
      }
      if (t.length > MAX_NAME_LENGTH) add('warn', 'VALUE_LONG', `规格项「${label}」的选项「${t}」超过 ${MAX_NAME_LENGTH} 个字，保存时会要求改短`)
      if (CONTROL_CHAR.test(v)) add('error', 'VALUE_CONTROL', `规格项「${label}」的选项「${JSON.stringify(v)}」含控制字符，新版本保存会被拒绝`)
      if (seen.has(t)) {
        add('auto', 'VALUE_DUP', `规格项「${label}」的选项「${t}」重复，新版本打开编辑会自动合并`)
        continue
      }
      seen.add(t)
      cleaned.push(t)
    }
    return { name: d.name.trim(), values: cleaned }
  })

  const combos = cartesian(cleanedDims)
  if (combos.length > MAX_COMBINATIONS) {
    add('warn', 'TOO_MANY_COMBOS', `规格组合共 ${combos.length} 个，超过 ${MAX_COMBINATIONS} 个；新版本保存时会要求减少选项（删选项会删掉对应组合并清顾客购物车）`)
  }

  // ---- 3：组合行本身 ----
  const expected = new Map<string, string[]>()
  for (const c of combos) expected.set(key(c), c)
  const seenRows = new Map<string, number>()
  const validRows = new Set<string>()
  for (const s of p.skus) {
    const values = Array.isArray(s.specValues) && s.specValues.every((v) => typeof v === 'string') ? (s.specValues as string[]) : null
    if (!values) {
      add('error', 'SKU_VALUES_MALFORMED', `组合 #${s.id}「${s.specText}」的 spec_values 不是字符串数组`)
      continue
    }
    if (values.length !== dims.length) {
      add('error', 'SKU_ARITY', `组合 #${s.id}「${s.specText}」有 ${values.length} 个值，规格项有 ${dims.length} 个`)
      continue
    }
    if (s.specText !== values.join('/')) add('warn', 'SKU_TEXT_MISMATCH', `组合 #${s.id} spec_text「${s.specText}」与值「${values.join('/')}」不一致`)
    const cleaned = values.map((v) => v.trim())
    const k = key(cleaned)
    if (seenRows.has(k)) {
      add('auto', 'SKU_DUP', `组合 #${s.id}「${s.specText}」与组合 #${seenRows.get(k)} 内容重复，新版本打开编辑只保留先出现的那条，另一条保存后会被删除` + (s.cartRefs ? `（顾客购物车有 ${s.cartRefs} 行引用）` : ''))
      continue
    }
    seenRows.set(k, s.id)
    if (!expected.has(k)) {
      add('auto', 'SKU_EXTRA', `组合 #${s.id}「${s.specText}」不在规格项的组合里，新版本打开编辑会丢弃，保存后被删除` + (s.cartRefs ? `（顾客购物车有 ${s.cartRefs} 行引用，会一起清掉）` : ''))
      continue
    }
    validRows.add(k)
  }

  // ---- 4：缺组合 ----
  const missing = combos.filter((c) => !validRows.has(key(c)))
  if (missing.length > 0 && combos.length <= MAX_COMBINATIONS) {
    add('auto', 'SKU_MISSING', `缺 ${missing.length} 个组合（如「${missing[0].join('/')}」），新版本打开编辑会自动补成空白行，店员填价格后保存即可`)
  }

  // ---- 7：冗余字段 ----
  if (p.skus.length > 0) {
    const minPrice = Math.min(...p.skus.map((s) => s.price))
    const sumStock = p.skus.reduce((a, s) => a + s.stock, 0)
    if (p.price !== minPrice) add('warn', 'PRICE_AGG', `商品售价 ${p.price} 分 ≠ 组合最低价 ${minPrice} 分，下次保存会自动改正`)
    if (p.stock !== sumStock) add('warn', 'STOCK_AGG', `商品库存 ${p.stock} ≠ 组合库存之和 ${sumStock}，下次保存会自动改正`)
  }
  return report
}

async function main() {
  const jsonIdx = process.argv.indexOf('--json')
  const jsonPath = jsonIdx >= 0 ? process.argv[jsonIdx + 1] : null

  const products = await prisma.product.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      status: true,
      price: true,
      stock: true,
      specDimensions: true,
      skus: { select: { id: true, specText: true, specValues: true, price: true, stock: true } },
    },
    orderBy: { id: 'asc' },
  })
  const cartRefs = await prisma.cart.groupBy({
    by: ['skuId'],
    where: { skuId: { not: null } },
    _count: { _all: true },
  })
  const refsBySku = new Map<number, number>()
  for (const r of cartRefs) if (r.skuId != null) refsBySku.set(r.skuId, r._count._all)

  const reports: ProductReport[] = []
  let withSpecs = 0
  for (const p of products) {
    if (p.specDimensions == null && p.skus.length === 0) continue
    withSpecs++
    const r = auditProduct({
      ...p,
      skus: p.skus.map((s) => ({ ...s, cartRefs: refsBySku.get(s.id) ?? 0 })),
    })
    if (r.findings.length > 0) reports.push(r)
  }

  const count = (level: Finding['level']) => reports.reduce((n, r) => n + r.findings.filter((f) => f.level === level).length, 0)
  console.log('==========================================')
  console.log(' 规格数据体检（只读）')
  console.log(` 商品总数 ${products.length}，其中有规格的 ${withSpecs}，有发现的 ${reports.length}`)
  console.log('==========================================')
  for (const r of reports) {
    console.log(`\n#${r.id} ${r.name}（${r.status === 'ON_SHELF' ? '上架' : '下架'}，${r.dims} 个规格项，${r.skus} 个组合）`)
    for (const f of r.findings) {
      const tag = f.level === 'auto' ? '[自动整理]' : f.level === 'warn' ? '[需留意]  ' : '[需处理]  '
      console.log(`  ${tag} ${f.code}: ${f.detail}`)
    }
  }
  console.log('\n------------------------------------------')
  console.log(` [自动整理] ${count('auto')} 项：新版本打开编辑时自动处理，店员按黄色提示填价格保存即可`)
  console.log(` [需留意]   ${count('warn')} 项：不影响现在售卖，下次编辑该商品时会看到中文提示`)
  console.log(` [需处理]   ${count('error')} 项：数据本身有问题，请把这份报告发给开发处理`)
  if (reports.length === 0) console.log(' 没有发现任何问题，可以直接使用新版本。')

  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), products: products.length, withSpecs, reports }, null, 2))
    console.log(`\n 明细已写入 ${jsonPath}`)
  }
}

main()
  .catch((e) => {
    console.error('体检失败：', e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
