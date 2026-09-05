#!/usr/bin/env node
// 只读校验：每个用户的 users.points_balance 必须等于该用户全部入账行（不带到期过滤）的
// remaining 之和（type IN ('EARN','GIFT_REVERT') AND remaining > 0）。
//
// H8：代码真正维持的不变式是「pointsBalance == Σ remaining，不带到期过滤」——四条写路径
// （settle 建行+increment、consume 减 remaining+decrement、expire 清零+decrement、
// refund 减 remaining+decrement）全部在同一事务内等量增减，这条恒真，且与 expirePoints
// 每日任务是否已经跑过无关。旧版本判据里的 `and l.expires_at > now()` 是多余条件：
// 从积分到期那一刻到次日 expirePoints 任务跑完之间（最长约 24 小时），带过滤的判据会
// 持续误报——那批行的 remaining 还没被清零，balance 里也还没扣，两边本来就应该「暂时」
// 不等于「已过滤掉这批行的账面」。
// 不一致则列出用户与差额并以非 0 退出；另附一列「在世 Σremaining」（带到期过滤）仅供
// 诊断参考，不参与判定。
//
// 用法：DATABASE_URL=mysql://... node scripts/check-points-consistency.mjs（默认读 apps/server/.env）
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

// 见 scripts/check-channel-consistency.mjs 头注释：npm workspaces 下 @prisma/client 的落地位置
// 不确定（提升到根 node_modules 或就地生成于 apps/server/node_modules），用 bare specifier +
// 以 apps/server/package.json 为锚点的 createRequire 让两种布局都能解析到。
const require = createRequire(new URL('../apps/server/package.json', import.meta.url))
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const rows = await prisma.$queryRaw`
  select u.id as userId, u.points_balance as balance,
         coalesce(sum(case when l.remaining > 0 then l.remaining else 0 end), 0) as ledgerSum,
         coalesce(sum(case when l.remaining > 0 and l.expires_at > now() then l.remaining else 0 end), 0) as liveSum
  from users u
  left join points_ledgers l
    on l.user_id = u.id and l.type in ('EARN', 'GIFT_REVERT')
  group by u.id, u.points_balance
  having balance <> ledgerSum`

if (rows.length) {
  console.error(`✘ ${rows.length} 个用户的 pointsBalance 与积分账本（不带到期过滤）不一致：`)
  for (const r of rows) {
    const balance = Number(r.balance)
    const ledgerSum = Number(r.ledgerSum)
    const liveSum = Number(r.liveSum)
    console.error(
      `  用户 #${r.userId}: pointsBalance=${balance} Σremaining=${ledgerSum} 差额=${balance - ledgerSum}` +
        `（informational：在世 Σremaining（到期日>now）=${liveSum}）`
    )
  }
  process.exitCode = 1
} else {
  console.log('✔ 所有用户的 pointsBalance 与积分账本一致')
}
await prisma.$disconnect()
