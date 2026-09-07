// 把 apps/miniapp/assets/tabbar/*.png 转成 data URI，生成 preview-icons.js。
// 预览要能单文件分发（发给店主 / 发布成 Artifact），不能依赖相对路径去读仓库里的 png。
// 用法：node docs/design/miniapp-local-v2/gen-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '../../../apps/miniapp/assets/tabbar')
const names = ['home', 'home-active', 'category', 'category-active', 'cart', 'cart-active', 'user', 'user-active']

const out = {}
for (const n of names) out[n] = 'data:image/png;base64,' + readFileSync(join(src, n + '.png')).toString('base64')

const head = `/* 自动生成，勿手改。源：apps/miniapp/assets/tabbar/*.png
 * 重新生成：node docs/design/miniapp-local-v2/gen-icons.mjs
 */
window.TABBAR_ICONS = `
writeFileSync(join(here, 'preview-icons.js'), head + JSON.stringify(out, null, 2) + ';\n')
console.log('preview-icons.js 已生成')
