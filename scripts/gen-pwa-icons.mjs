// 生成管理后台 PWA 图标：以 icon-shop.svg 为源，白底圆角/留边输出多尺寸 PNG
// 用法：npm run gen:pwa-icons
import sharp from 'sharp'
import { mkdirSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'apps/admin/public/icons')
mkdirSync(outDir, { recursive: true })

const shopSvg = readFileSync(join(root, 'scripts/svg-src/icon-shop.svg'), 'utf8')

// 包一层带白色圆角背景的外框；inner = 图标占比
function framedSvg(size, innerRatio, radiusRatio) {
  const inner = Math.round(size * innerRatio)
  const offset = Math.round((size - inner) / 2)
  const radius = Math.round(size * radiusRatio)
  const body = shopSvg.replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" x="${offset}" y="${offset}" width="${inner}" height="${inner}">`)
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" fill="#ffffff"/>` +
      body.replace('</svg>', '</svg>') +
      `</svg>`
  )
}

const tasks = [
  { file: 'icon-192.png', size: 192, inner: 0.72, radius: 0.18 },
  { file: 'icon-512.png', size: 512, inner: 0.72, radius: 0.18 },
  // maskable：安全区更大（图标只占 60%），系统会自行裁圆
  { file: 'icon-maskable-512.png', size: 512, inner: 0.6, radius: 0 },
  { file: 'apple-touch-icon.png', size: 180, inner: 0.72, radius: 0 },
]

for (const t of tasks) {
  await sharp(framedSvg(t.size, t.inner, t.radius)).png().toFile(join(outDir, t.file))
  console.log('generated', t.file)
}
