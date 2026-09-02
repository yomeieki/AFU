/**
 * 存量图片迁移：apps/server/uploads/ → 腾讯云 COS，并把数据库中的旧 URL 前缀改写为 COS 前缀。
 *
 * 用法（apps/server 目录下，需 .env 已配置 COS_* 与 DATABASE_URL）：
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-uploads-to-cos.ts --dry-run
 *   npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/migrate-uploads-to-cos.ts \
 *       --old-prefix https://api.yuegui-hotel.online/uploads/ --report ./migrate-report.json
 *
 * 行为：
 *   1. 扫描 uploads/ 下的文件，逐个 headObject 判断是否已在 COS（已存在跳过），否则 putObject 到 uploads/<原文件名>
 *   2. 任一上传失败 → 不改数据库，exit 1
 *   3. 对 7 个 (表,列) 执行 UPDATE ... SET col = REPLACE(col, old, new) WHERE col LIKE 'old%'
 *   4. 孤儿检查：数据库引用了但磁盘不存在的文件（切换后会 404）列入报告
 *   幂等：重跑时上传全部 skip、UPDATE 影响 0 行。
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { PrismaClient, Prisma } from '@prisma/client'
import { isCosEnabled, putObject, headObject, getCosBaseUrl } from '../src/services/cos'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const oldPrefixes: string[] = []
let reportPath: string | null = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--old-prefix' && args[i + 1]) oldPrefixes.push(args[++i])
  if (args[i] === '--report' && args[i + 1]) reportPath = args[++i]
}
if (oldPrefixes.length === 0) {
  const base = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '')
  oldPrefixes.push(`${base}/uploads/`)
}

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads')
const NEW_PREFIX = `${getCosBaseUrl()}/uploads/`
const CONCURRENCY = 5

// 表名/列名为常量白名单，值走参数化
const TARGETS: Array<[string, string]> = [
  ['users', 'avatar_url'],
  ['categories', 'icon_url'],
  ['products', 'cover_image'],
  ['products', 'qr_code_url'],
  ['product_images', 'image_url'],
  ['order_items', 'product_image'],
  ['banners', 'image_url'],
]

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

interface Report {
  dryRun: boolean
  oldPrefixes: string[]
  newPrefix: string
  files: { total: number; uploaded: string[]; skipped: string[]; failed: Array<{ file: string; error: string }> }
  db: Array<{ table: string; column: string; oldPrefix: string; matched: number; updated: number }>
  missingFiles: Array<{ table: string; column: string; url: string }>
}

async function uploadAll(files: string[], report: Report): Promise<void> {
  let index = 0
  const worker = async () => {
    while (index < files.length) {
      const file = files[index++]
      const key = `uploads/${file}`
      try {
        if (await headObject(key)) {
          report.files.skipped.push(file)
          continue
        }
        if (dryRun) {
          report.files.uploaded.push(file)
          continue
        }
        const buf = await fs.promises.readFile(path.join(UPLOAD_DIR, file))
        const ct = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
        await putObject(key, buf, ct)
        report.files.uploaded.push(file)
      } catch (e) {
        report.files.failed.push({ file, error: (e as Error).message })
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
}

async function main() {
  if (!isCosEnabled()) {
    console.error('COS_* 未配置齐全，无法迁移')
    process.exit(1)
  }
  const prisma = new PrismaClient()
  const report: Report = {
    dryRun,
    oldPrefixes,
    newPrefix: NEW_PREFIX,
    files: { total: 0, uploaded: [], skipped: [], failed: [] },
    db: [],
    missingFiles: [],
  }

  const diskFiles = fs.existsSync(UPLOAD_DIR)
    ? fs.readdirSync(UPLOAD_DIR).filter((f) => fs.statSync(path.join(UPLOAD_DIR, f)).isFile())
    : []
  report.files.total = diskFiles.length
  console.log(`[migrate] ${dryRun ? 'DRY-RUN ' : ''}uploads/ 文件 ${diskFiles.length} 个，旧前缀 ${oldPrefixes.join(' | ')} → ${NEW_PREFIX}`)

  await uploadAll(diskFiles, report)
  console.log(`[migrate] 上传：新传 ${report.files.uploaded.length}，已存在跳过 ${report.files.skipped.length}，失败 ${report.files.failed.length}`)

  if (report.files.failed.length > 0) {
    console.error('[migrate] 有文件上传失败，跳过数据库改写：')
    for (const f of report.files.failed) console.error(`  - ${f.file}: ${f.error}`)
  } else {
    const diskSet = new Set(diskFiles)
    for (const [table, column] of TARGETS) {
      for (const oldPrefix of oldPrefixes) {
        const like = `${oldPrefix}%`
        const rows = await prisma.$queryRaw<Array<{ v: string }>>(
          Prisma.sql`SELECT DISTINCT ${Prisma.raw('`' + column + '`')} AS v FROM ${Prisma.raw('`' + table + '`')} WHERE ${Prisma.raw('`' + column + '`')} LIKE ${like}`
        )
        for (const r of rows) {
          const name = r.v.slice(oldPrefix.length)
          if (!diskSet.has(name)) report.missingFiles.push({ table, column, url: r.v })
        }
        const countRows = await prisma.$queryRaw<Array<{ c: bigint }>>(
          Prisma.sql`SELECT COUNT(*) AS c FROM ${Prisma.raw('`' + table + '`')} WHERE ${Prisma.raw('`' + column + '`')} LIKE ${like}`
        )
        const matched = Number(countRows[0]?.c ?? 0)
        let updated = 0
        if (!dryRun && matched > 0) {
          updated = await prisma.$executeRaw(
            Prisma.sql`UPDATE ${Prisma.raw('`' + table + '`')} SET ${Prisma.raw('`' + column + '`')} = REPLACE(${Prisma.raw('`' + column + '`')}, ${oldPrefix}, ${NEW_PREFIX}) WHERE ${Prisma.raw('`' + column + '`')} LIKE ${like}`
          )
        }
        report.db.push({ table, column, oldPrefix, matched, updated })
        if (matched > 0) console.log(`[migrate] ${table}.${column}: 匹配 ${matched} 行${dryRun ? '（dry-run 不改写）' : `，改写 ${updated} 行`}`)
      }
    }
    if (report.missingFiles.length > 0) {
      console.warn(`[migrate] 警告：${report.missingFiles.length} 条记录引用的文件在磁盘不存在（切换后 404）：`)
      for (const m of report.missingFiles.slice(0, 20)) console.warn(`  - ${m.table}.${m.column}: ${m.url}`)
    }
  }

  await prisma.$disconnect()
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    console.log(`[migrate] 报告已写入 ${reportPath}`)
  }
  process.exit(report.files.failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('[migrate] 异常退出:', e)
  process.exit(1)
})
