#!/usr/bin/env node
/**
 * 管理端时区闸门。
 *
 * 背景（2026-09-06 首单排查时抓到）：后台所有时间都跟着**看的人那台电脑**的时区走。
 * 库里存的是 UTC，`new Date(iso).getHours()` 在东七区的电脑上就少一小时——首单
 * 19:59 发生的事，在那台电脑上显示 18:59。两个人用不同时区的电脑看同一张单会看到
 * 不同的时间，而小票、语音播报、订阅消息都是对的（服务端一律按 Asia/Shanghai 算），
 * **只有后台网页错**，于是没人怀疑过它。
 *
 * 更糟的一类不是显示错而是**查错数据**：`ScanStats` 用浏览器本地日拼查询区间，
 * 而服务端按 Asia/Shanghai 分桶（utils/local-day.ts）。浏览器换了时区，「今日」
 * 会去查昨天或明天那个桶，页面上不会有任何异常提示。
 *
 * 所以这里禁掉一切「按本地时区解读 Date」的 API，统一走 utils/time.ts
 * （内部固定 timeZone:'Asia/Shanghai'）。
 *
 * 为什么用 TypeScript 编译器 API 真解析而不是 grep（同 check-miniapp-es5.mjs 的理由）：
 * grep 会被注释、字符串、以及 `foo.getDate` 这类同名但无关的属性名误报漏报。
 * 这里只看**属性访问表达式**的名字，注释与字符串天然不在其中。
 *
 * 用法：node scripts/check-admin-timezone.mjs
 * 已挂进 apps/admin/package.json 的 build 前置——deploy.sh 在生产机上 build admin，
 * 回归即部署失败，不必指望有人记得手动跑。
 */
import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// typescript 是 admin 的 devDependency。锚点必须是 apps/admin/ 里**确实存在的一个文件**
// 而不是目录路径——createRequire 内部取 dirname(锚点)，锚在目录上会跳过
// apps/admin/node_modules（详见 check-channel-consistency.mjs 里同一处坑的完整论述）。
const require = createRequire(new URL('../apps/admin/package.json', import.meta.url))
const ts = require('typescript')

const SRC = fileURLToPath(new URL('../apps/admin/src', import.meta.url))
// utils/time.ts 是这道规则的**唯一实现处**，它必须能用这些 API，否则规则无处落地。
const ALLOW_FILES = new Set([path.join(SRC, 'utils', 'time.ts')])

/**
 * 禁用名单 = 「按运行环境的本地时区解读一个时间戳」的 API。
 * 放行 getTime / Date.now / Date.parse：它们是**瞬时值**（毫秒数），与时区无关。
 * toLocaleString 系列即使传了 locale，不显式给 timeZone 一样跟着电脑走，所以一并禁掉。
 */
const BANNED = new Set([
  'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
  'getHours', 'getMinutes', 'getSeconds', 'getDate', 'getDay', 'getMonth', 'getFullYear',
  'setDate', 'setHours', 'setMonth', 'setFullYear',
])

function walkDir(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walkDir(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

const violations = []
for (const file of walkDir(SRC).sort()) {
  if (ALLOW_FILES.has(file)) continue
  const src = ts.createSourceFile(file, require('node:fs').readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && BANNED.has(node.name.text)) {
      const { line } = src.getLineAndCharacterOfPosition(node.getStart(src))
      violations.push({ file: path.relative(path.join(SRC, '..', '..', '..'), file), line: line + 1, name: node.name.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
}

if (violations.length) {
  console.error(`✘ 管理端有 ${violations.length} 处按浏览器本地时区解读时间（应改用 src/utils/time.ts）：`)
  for (const v of violations) console.error(`  ${v.file}:${v.line}  .${v.name}()`)
  console.error('\n  为什么不能留：库里存 UTC，这些 API 按**看的人那台电脑**的时区解读，')
  console.error('  换个时区的电脑看同一张单会看到不同的时间；用来拼查询区间时还会查错数据桶。')
  process.exit(1)
}
console.log('✔ 管理端时间渲染全部走 Asia/Shanghai（无本地时区解读）')
