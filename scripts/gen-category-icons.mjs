/**
 * 生成首页分类图标：5 张 144×144 透明 PNG，输出到 assets/category-icons/
 *
 * 用法：node scripts/gen-category-icons.mjs
 *
 * 风格与 tabBar / 空状态图一致：24×24 viewBox、2 单位描边、圆角连接，
 * 主色 #e5441e，点缀色 #ff9500。产物提交 git，脚本仅为可复现性保留。
 *
 * 144px 是按显示尺寸倒推的：首页 .category-icon 是 64rpx（≈32 CSS px），
 * 高分屏 3 倍图需要 96px，取 144 留一档余量。
 *
 * 上传到 COS 并写进 categories.icon_url 由
 * apps/server/scripts/upload-category-icons.mjs 完成——图标不放代码仓库当静态资源，
 * 是为了让店家之后能在后台直接换掉（后台改的是 icon_url）。
 */
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(__dirname, '..', 'assets', 'category-icons')

const BRAND = '#e5441e'
const ACCENT = '#ff9500'
const SIZE = 144

/** key 要与 categories 表里的分类名对得上（upload 脚本按名字匹配） */
const ICONS = {
  // 熟食：盖盘（上菜的盘子）。不用「盘子+肉」是因为线条画的肉块认不出来，
  // 盖盘是餐饮通用符号，且与卤味的锅形区分得开
  '熟食': `
    <path d="M4.2 15.4 a7.8 6.6 0 0 1 15.6 0" fill="none" stroke="${BRAND}" stroke-width="2" stroke-linecap="round"/>
    <path d="M2.8 15.4 h18.4" fill="none" stroke="${BRAND}" stroke-width="2" stroke-linecap="round"/>
    <path d="M6 18.6 h12" fill="none" stroke="${BRAND}" stroke-width="2" stroke-linecap="round"/>
    <path d="M12 8.8 v-1.6" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>
    <circle cx="12" cy="6" r="1.3" fill="${ACCENT}"/>`,

  // 礼盒：盒身 + 盒盖 + 丝带蝴蝶结
  '礼盒': `
    <rect x="4.5" y="10.2" width="15" height="9.3" rx="1.4" fill="none" stroke="${BRAND}" stroke-width="2"/>
    <rect x="3.2" y="6.8" width="17.6" height="3.4" rx="1.2" fill="none" stroke="${BRAND}" stroke-width="2"/>
    <path d="M12 6.8 V19.5" fill="none" stroke="${ACCENT}" stroke-width="2"/>
    <path d="M12 6.8 q-3.4 -3.4 -4.8 -0.9 q-0.8 1.6 4.8 0.9 q5.6 0.7 4.8 -0.9 q-1.4 -2.5 -4.8 0.9"
      fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round"/>`,

  // 预包装食品：封口袋
  '预包装食品': `
    <path d="M6.3 7.2 h11.4 v10.9 a2.4 2.4 0 0 1 -2.4 2.4 h-6.6 a2.4 2.4 0 0 1 -2.4 -2.4 Z"
      fill="none" stroke="${BRAND}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M5 3.9 h14 v3.3 h-14 Z" fill="none" stroke="${BRAND}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M9.4 12 h5.2 M9.4 15.2 h3.4" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>`,

  // 卤味：卤锅 + 热气
  '卤味': `
    <path d="M5 10.6 h14 v5.1 a4.3 4.3 0 0 1 -4.3 4.3 h-5.4 a4.3 4.3 0 0 1 -4.3 -4.3 Z"
      fill="none" stroke="${BRAND}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M3.2 10.6 h17.6" fill="none" stroke="${BRAND}" stroke-width="2" stroke-linecap="round"/>
    <path d="M9 8.4 q1.6 -1.5 0 -3 M12 7.9 q1.6 -1.5 0 -3 M15 8.4 q1.6 -1.5 0 -3"
      fill="none" stroke="${ACCENT}" stroke-width="1.8" stroke-linecap="round"/>`,

  // 素食：叶片 + 叶脉
  '素食': `
    <path d="M6 18.4 C6 10.2 11.2 5 19 5 C19 12.8 13.8 18.4 6 18.4 Z"
      fill="none" stroke="${BRAND}" stroke-width="2" stroke-linejoin="round"/>
    <path d="M6.4 18 C10.2 14 13.8 11 17.6 8.8" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round"/>`,
}

/** 文件名用拼音，避免 URL 里出现中文导致各端转义不一致 */
const SLUG = {
  '熟食': 'shushi',
  '礼盒': 'lihe',
  '预包装食品': 'yubaozhuang',
  '卤味': 'luwei',
  '素食': 'sushi',
}

mkdirSync(OUT_DIR, { recursive: true })

for (const [name, body] of Object.entries(ICONS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${SIZE}" height="${SIZE}">${body}</svg>`
  const file = path.join(OUT_DIR, `${SLUG[name]}.png`)
  await sharp(Buffer.from(svg)).png().toFile(file)
  console.log(`  ✔ ${name.padEnd(6)} → ${path.relative(path.join(__dirname, '..'), file)}`)
}
console.log(`\n共 ${Object.keys(ICONS).length} 张，${SIZE}×${SIZE} 透明 PNG`)
