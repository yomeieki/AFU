/**
 * 生成小程序 tabBar 图标：4 个图标 × 普通/选中两态 = 8 张 81×81 PNG
 * 输出到 apps/miniapp/assets/tabbar/，产物提交 git（脚本仅为可复现性保留）
 *
 * 用法：node scripts/gen-tabbar-icons.mjs
 */
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'apps', 'miniapp', 'assets', 'tabbar')

const NORMAL = '#999999'
const ACTIVE = '#e5441e'

// 统一 24×24 viewBox、2 单位描边圆角线性风格
const ICONS = {
  home: `
    <path d="M4 10.5 L12 4 L20 10.5 V19 a1.5 1.5 0 0 1 -1.5 1.5 H15 v-5.5 a1 1 0 0 0 -1 -1 h-4 a1 1 0 0 0 -1 1 V20.5 H5.5 A1.5 1.5 0 0 1 4 19 Z"
      fill="none" stroke="{{c}}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
  category: `
    <rect x="4" y="4" width="7" height="7" rx="1.8" fill="none" stroke="{{c}}" stroke-width="2"/>
    <rect x="13" y="4" width="7" height="7" rx="1.8" fill="none" stroke="{{c}}" stroke-width="2"/>
    <rect x="4" y="13" width="7" height="7" rx="1.8" fill="none" stroke="{{c}}" stroke-width="2"/>
    <rect x="13" y="13" width="7" height="7" rx="3.5" fill="none" stroke="{{c}}" stroke-width="2"/>`,
  cart: `
    <path d="M3.5 5 h2 l2.2 10.5 a1.5 1.5 0 0 0 1.47 1.2 h7.9 a1.5 1.5 0 0 0 1.45 -1.1 L20.5 9 H7"
      fill="none" stroke="{{c}}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="10" cy="20" r="1.6" fill="{{c}}"/>
    <circle cx="17" cy="20" r="1.6" fill="{{c}}"/>`,
  user: `
    <circle cx="12" cy="8.5" r="4" fill="none" stroke="{{c}}" stroke-width="2"/>
    <path d="M4.5 20.5 a7.5 7.5 0 0 1 15 0" fill="none" stroke="{{c}}" stroke-width="2" stroke-linecap="round"/>`,
}

function svg(body, color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="81" height="81">${body.replaceAll('{{c}}', color)}</svg>`
}

mkdirSync(OUT_DIR, { recursive: true })

for (const [name, body] of Object.entries(ICONS)) {
  for (const [suffix, color] of [['', NORMAL], ['-active', ACTIVE]]) {
    const file = path.join(OUT_DIR, `${name}${suffix}.png`)
    await sharp(Buffer.from(svg(body, color))).resize(81, 81).png().toFile(file)
    console.log('generated', path.relative(process.cwd(), file))
  }
}
