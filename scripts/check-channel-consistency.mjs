#!/usr/bin/env node
// 只读校验：products.channel 必须等于所属 categories.channel；不一致即退出码 1。
// 用法：DATABASE_URL=mysql://... node scripts/check-channel-consistency.mjs（默认读 apps/server/.env）
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

if (!process.env.DATABASE_URL) {
  const envPath = new URL('../apps/server/.env', import.meta.url)
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/)
      if (m) process.env.DATABASE_URL = m[1]
    }
  }
}

// 本仓库是 npm workspaces：@prisma/client 通常被提升到根 node_modules，
// 但也可能就地留在 apps/server/node_modules（未提升时）。用 bare specifier
// 让 Node 的模块解析从 apps/server/ 逐级向上查找，两种布局都能命中，
// 不要写死相对路径（那样只会精确匹配一处，另一种布局下必炸）。
//
// 锚点必须是 apps/server/ 目录内「确实存在的一个文件」（这里用 package.json），
// 不能直接锚在目录路径上：createRequire 内部用 path.dirname(锚点) 决定搜索起点，
// 而带尾斜杠的目录路径会被先剥离尾斜杠再取 dirname，结果是上一级目录
// （dirname('/repo/apps/server/') === '/repo/apps'，而不是 '/repo/apps/server'）。
// 用目录路径当锚点会导致搜索链跳过 apps/server/node_modules，
// 在 @prisma/client 未被提升、就地生成于 apps/server/node_modules 时直接报错。
const require = createRequire(new URL('../apps/server/package.json', import.meta.url))
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()
const rows = await prisma.$queryRaw`
  select p.id, p.name, p.channel as productChannel, c.id as categoryId, c.channel as categoryChannel
  from products p join categories c on c.id = p.category_id
  where p.deleted_at is null and p.channel <> c.channel`
if (rows.length) {
  console.error(`✘ ${rows.length} 个商品的 channel 与分类不一致：`)
  for (const r of rows) console.error(`  #${r.id} ${r.name}: product=${r.productChannel} category#${r.categoryId}=${r.categoryChannel}`)
  process.exitCode = 1
} else {
  console.log('✔ 商品渠道与分类一致')
}
await prisma.$disconnect()
