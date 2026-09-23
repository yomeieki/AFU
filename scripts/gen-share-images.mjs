/**
 * 生成小程序分享图：转发卡片 500×400（card.png）+ 朋友圈封面 500×500（timeline.png）。
 *
 * 两张图的源图不同：
 * - card.png（转发卡片，列表里展示较大）用 30 周年横版 logo
 *   （docs/design/brand/logo-anniversary-share.png），先裁掉四周大片白边再铺正中，
 *   让「丹桂阿福凉菜 / 家的味道 / 30TH 老店」这些字在卡片里够大够清楚。
 * - timeline.png（朋友圈封面，微信里显示成很小的缩略图）继续用印章 logo
 *   （docs/design/brand/logo-seal.webp）：横版 logo 上的小字缩到缩略图尺寸会糊成一团，
 *   印章图形是圆形留白构图，缩小后依然认得出。
 *
 * 输出到 apps/miniapp/assets/share/，产物提交 git，脚本仅为可复现性保留。
 *
 * 用法：node scripts/gen-share-images.mjs
 */
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SEAL_SRC = path.join(__dirname, '..', 'docs', 'design', 'brand', 'logo-seal.webp')
const ANNIVERSARY_SRC = path.join(__dirname, '..', 'docs', 'design', 'brand', 'logo-anniversary-share.png')
const OUT_DIR = path.join(__dirname, '..', 'apps', 'miniapp', 'assets', 'share')

// 朋友圈封面：印章 logo 缩到「短边 × 0.86」的正方形内再居中，
// 留出的边距保证四周落在纯白画布上，不会被裁到边缘。
const TIMELINE_INNER_RATIO = 0.86
// 转发卡片：横版 logo 先切掉白边，再缩到画布 88% 大小，尽量占满卡片。
const CARD_INNER_RATIO = 0.88

mkdirSync(OUT_DIR, { recursive: true })

async function renderTimeline(width, height) {
  const inner = Math.round(Math.min(width, height) * TIMELINE_INNER_RATIO)
  const logo = await sharp(SEAL_SRC)
    .flatten({ background: '#ffffff' })
    .resize({ width: inner, height: inner, fit: 'inside' })
    .toBuffer()
  const canvas = sharp({
    create: { width: width, height: height, channels: 3, background: '#ffffff' },
  })
  return canvas
    .composite([{ input: logo, gravity: 'centre' }])
    .png({ palette: true, colours: 64, compressionLevel: 9 })
    .toBuffer()
}

async function renderCard(width, height) {
  // 源图四周白边较多，先拍平再按纯白阈值裁掉白边，让 logo 本体占满合成前的素材，
  // 之后再统一缩到画布的 88%，避免边距被原图里的白边吃掉。
  const trimmed = await sharp(ANNIVERSARY_SRC)
    .flatten({ background: '#ffffff' })
    .trim({ threshold: 20 })
    .toBuffer()
  const logo = await sharp(trimmed)
    .resize({ width: Math.round(width * CARD_INNER_RATIO), height: Math.round(height * CARD_INNER_RATIO), fit: 'inside' })
    .toBuffer()
  const canvas = sharp({
    create: { width: width, height: height, channels: 3, background: '#ffffff' },
  })
  return canvas
    .composite([{ input: logo, gravity: 'centre' }])
    .png({ palette: true, colours: 64, compressionLevel: 9 })
    .toBuffer()
}

const TARGETS = [
  { name: 'card.png', width: 500, height: 400, render: renderCard },
  { name: 'timeline.png', width: 500, height: 500, render: renderTimeline },
]

// 自检：解码回像素，确认最外圈一整圈（上下两行 + 左右两列）全是纯白 (255,255,255)。
// 不满足就说明 logo 被撑到了边缘或合成出了问题——不能悄悄提交一张四边不白的图。
async function assertWhiteBorder(buffer, width, height) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true })
  const channels = info.channels
  function pixelAt(x, y) {
    var offset = (y * width + x) * channels
    var out = []
    for (var c = 0; c < channels && c < 3; c++) out.push(data[offset + c])
    return out
  }
  function isWhite(px) {
    return px.every(function (v) { return v === 255 })
  }
  for (var x = 0; x < width; x++) {
    if (!isWhite(pixelAt(x, 0)) || !isWhite(pixelAt(x, height - 1))) return false
  }
  for (var y = 0; y < height; y++) {
    if (!isWhite(pixelAt(0, y)) || !isWhite(pixelAt(width - 1, y))) return false
  }
  return true
}

let allOk = true
for (const target of TARGETS) {
  const buffer = await target.render(target.width, target.height)
  const file = path.join(OUT_DIR, target.name)
  const white = await assertWhiteBorder(buffer, target.width, target.height)
  if (!white) {
    console.error('四边非纯白：' + target.name)
    allOk = false
    continue
  }
  const fs = await import('node:fs/promises')
  await fs.writeFile(file, buffer)
  const size = statSync(file).size
  console.log(
    'generated ' + path.relative(process.cwd(), file) +
    '  ' + target.width + 'x' + target.height +
    '  ' + size + ' bytes' +
    '  四边为纯白'
  )
}

if (!allOk) {
  process.exit(1)
}
