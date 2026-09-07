// 把 preview.html + preview.css + preview-icons.js + preview.js 合成单文件 preview.single.html。
//
// 为什么需要：预览要发给店主（微信里点开、手机上看），也要能发布成 Artifact——
// 两种场景都拿不到相对路径的 css/js。单文件版是**产物**，别手改，改源文件后重跑本脚本。
//
// 用法：node docs/design/miniapp-local-v2/build-single.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(join(here, f), 'utf8')

const out = read('preview.html')
  .replace('<link rel="stylesheet" href="preview.css">', `<style>\n${read('preview.css')}\n</style>`)
  .replace('<script src="preview-icons.js"></script>', `<script>\n${read('preview-icons.js')}\n</script>`)
  .replace('<script src="preview.js"></script>', `<script>\n${read('preview.js')}\n</script>`)

if (out.includes('href="preview.css"') || out.includes('src="preview.js"')) {
  console.error('内联失败：preview.html 里的引用标签与本脚本的匹配串不一致')
  process.exit(1)
}
writeFileSync(join(here, 'preview.single.html'), out)
console.log('preview.single.html 已生成，' + Math.round(out.length / 1024) + ' KB')
