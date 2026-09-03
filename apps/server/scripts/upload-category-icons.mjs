/**
 * 把 assets/category-icons/ 里的分类图标传到 COS，并写进 categories.icon_url。
 *
 * 用法（服务器上，先跑过一次 npm run build）：
 *   node /www/food-shop/apps/server/scripts/upload-category-icons.mjs
 *   DRY_RUN=1 node ... scripts/upload-category-icons.mjs   # 只看计划不改动
 *
 * 为什么图标要进 COS 而不是当仓库静态资源直接引用：
 * 后台「分类管理」改的是 icon_url，店家以后想换成实拍图时，
 * 走的是同一条上传路径，不需要改代码重新部署。
 *
 * 幂等：对象 key 固定（category-icons/<slug>.png），重跑覆盖同一对象；
 * 只有 icon_url 为空的分类才写库，已经手动换过图的不会被盖掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SERVER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const REPO_DIR = path.resolve(SERVER_DIR, '..', '..')
const ICON_DIR = path.join(REPO_DIR, 'assets', 'category-icons')
const DRY_RUN = process.env.DRY_RUN === '1'

// dist 里的服务读 process.env，先把 .env 灌进去
const ENV_FILE = process.env.ENV_FILE ?? path.join(SERVER_DIR, '.env')
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
  }
}

const { isCosEnabled, putObject, publicUrl } = require(path.join(SERVER_DIR, 'dist', 'services', 'cos.js'))
const prisma = require(path.join(SERVER_DIR, 'dist', 'utils', 'prisma.js')).default

// 分类名 → 文件名（与 scripts/gen-category-icons.mjs 保持一致）
const SLUG = {
  '熟食': 'shushi',
  '礼盒': 'lihe',
  '预包装食品': 'yubaozhuang',
  '卤味': 'luwei',
  '素食': 'sushi',
}

if (!isCosEnabled()) {
  console.error('✘ COS 未配置，无法上传。请检查 .env 里的 COS_*')
  process.exit(1)
}

let uploaded = 0
let linked = 0
let skipped = 0

const categories = await prisma.category.findMany({ orderBy: { sortOrder: 'asc' } })
console.log(`数据库里有 ${categories.length} 个分类${DRY_RUN ? '（DRY_RUN，不会改动任何东西）' : ''}\n`)

for (const cat of categories) {
  const slug = SLUG[cat.name]
  if (!slug) {
    console.log(`  ○ ${cat.name}：没有对应图标（不在 SLUG 表里），跳过`)
    skipped++
    continue
  }
  const file = path.join(ICON_DIR, `${slug}.png`)
  if (!fs.existsSync(file)) {
    console.log(`  ✘ ${cat.name}：找不到 ${file}`)
    skipped++
    continue
  }
  if (cat.iconUrl) {
    console.log(`  ○ ${cat.name}：已有图标，不覆盖（${cat.iconUrl}）`)
    skipped++
    continue
  }

  const key = `category-icons/${slug}.png`
  if (DRY_RUN) {
    console.log(`  · ${cat.name}：将上传 → ${publicUrl(key)}`)
    continue
  }
  const url = await putObject(key, fs.readFileSync(file), 'image/png')
  uploaded++
  await prisma.category.update({ where: { id: cat.id }, data: { iconUrl: url } })
  linked++
  console.log(`  ✔ ${cat.name} → ${url}`)
}

console.log(`\n上传 ${uploaded}　写库 ${linked}　跳过 ${skipped}`)
await prisma.$disconnect()
