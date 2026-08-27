/**
 * 把 scripts/svg-src/ 下的 SVG 转成 base64 data-uri，输出 CSS 片段方便粘贴进 wxss
 * 用法：node scripts/svg-to-datauri.mjs [文件名...]（缺省转换全部）
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(__dirname, 'svg-src')

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg'))

for (const f of files) {
  const svg = readFileSync(path.join(SRC_DIR, f), 'utf8')
    .replace(/\n\s*/g, ' ')
    .trim()
  const b64 = Buffer.from(svg).toString('base64')
  console.log(`/* ${f} (${Math.round(b64.length / 102.4) / 10}KB) */`)
  console.log(`background-image: url("data:image/svg+xml;base64,${b64}");\n`)
}
