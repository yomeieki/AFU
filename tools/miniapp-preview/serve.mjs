/**
 * 小程序 HTML 预览台服务（零依赖）
 *
 * 机制：把真实 wxss 转成浏览器可渲染 CSS（page→.mp-page、rpx→calc），
 * 生成 *.generated.css；静态服务镜像 HTML；fs.watch 源 wxss 变更即重生成；
 * 页面注入轮询脚本，检测到 CSS 版本变化自动刷新。
 *
 * 用法：node tools/miniapp-preview/serve.mjs [--port 5180]
 * 边界：视觉近似，无交互/wxs/真实数据，真机验证仍走微信开发者工具。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = __dirname
const MINIAPP = path.join(__dirname, '..', '..', 'apps', 'miniapp')

const argPort = process.argv.indexOf('--port')
const PORT = argPort !== -1 ? Number(process.argv[argPort + 1]) : 5180

// 每个预览页用到的组件 wxss（随 usingComponents 手工登记）
const PAGE_COMPONENTS = {
  cover: ['privacy-popup'],
  index: ['empty-state'],
  'product-detail': ['sku-popup'],
  'product-list': ['empty-state'],
  cart: ['empty-state'],
  'order-list': ['empty-state', 'order-status-tag'],
  'address-list': ['empty-state'],
  'local-index': ['sku-popup', 'empty-state'],
}

// wxss → 浏览器 CSS
function transformWxss(css) {
  return css
    // page {  →  .mp-page {  （变量作用域挂到根容器）
    .replace(/\bpage\s*\{/g, '.mp-page {')
    // 123rpx / 1.5rpx  →  calc(123 * var(--rpx))
    .replace(/(\d*\.?\d+)rpx/g, 'calc($1 * var(--rpx))')
}

function readWxss(p) {
  try {
    return transformWxss(fs.readFileSync(p, 'utf8'))
  } catch {
    return ''
  }
}

// 生成一个页面的组合 CSS：app.wxss（token+公共类）+ 组件 wxss + 页面 wxss
function buildPageCss(pageKey, pageWxssPath) {
  const parts = [
    `/* ===== app.wxss (token + 公共类) ===== */`,
    readWxss(path.join(MINIAPP, 'app.wxss')),
  ]
  for (const comp of PAGE_COMPONENTS[pageKey] || []) {
    parts.push(`/* ===== component: ${comp} ===== */`)
    parts.push(readWxss(path.join(MINIAPP, 'components', comp, 'index.wxss')))
  }
  parts.push(`/* ===== page: ${pageKey} ===== */`)
  parts.push(readWxss(pageWxssPath))
  return parts.join('\n\n')
}

// 页面 key → 源 wxss 路径
const PAGE_WXSS = {
  cover: 'pages/cover/index.wxss',
  index: 'pages/index/index.wxss',
  'product-detail': 'pages/product/detail.wxss',
  'product-list': 'pages/product/list.wxss',
  cart: 'pages/cart/index.wxss',
  user: 'pages/user/index.wxss',
  'order-list': 'pages/order/list.wxss',
  'order-detail': 'pages/order/detail.wxss',
  'after-sale': 'pages/order/after-sale.wxss',
  'order-confirm': 'pages/order/confirm.wxss',
  'address-list': 'pages/address/list.wxss',
  'address-edit': 'pages/address/edit.wxss',
  // 同城模式与邮寄模式是同一个页面（channel 参数区分），共用一份 wxss
  'address-edit-local': 'pages/address/edit.wxss',
  about: 'pages/about/index.wxss',
  legal: 'pages/legal/index.wxss',
  'local-index': 'pages/local/index.wxss',
  'local-confirm': 'pages/local/confirm.wxss',
}

let version = Date.now()

function regenerate() {
  for (const [key, rel] of Object.entries(PAGE_WXSS)) {
    const css = buildPageCss(key, path.join(MINIAPP, rel))
    fs.writeFileSync(path.join(ROOT, `${key}.generated.css`), css)
  }
  version = Date.now()
  console.log(`[preview] css regenerated @ ${new Date().toLocaleTimeString()}`)
}

regenerate()

// 监听源 wxss 变更 → 重生成
const watchDirs = [
  path.join(MINIAPP),
  path.join(MINIAPP, 'components'),
]
let debounce
function onChange(_e, file) {
  if (file && !file.endsWith('.wxss')) return
  clearTimeout(debounce)
  debounce = setTimeout(regenerate, 120)
}
try {
  fs.watch(MINIAPP, { recursive: true }, onChange)
} catch {
  // recursive 在个别平台不支持时，退化为浅层监听
  for (const d of watchDirs) {
    try { fs.watch(d, onChange) } catch {}
  }
}

// 自动刷新脚本：轮询 /__version，变化则 reload
const RELOAD_SNIPPET = `<script>
  let _v = null;
  setInterval(async () => {
    try {
      const v = await (await fetch('/__version')).text();
      if (_v !== null && v !== _v) location.reload();
      _v = v;
    } catch {}
  }, 1000);
</script>`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0])

  if (urlPath === '/__version') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end(String(version))
  }

  // tabBar 图标等静态资源：/assets/* → apps/miniapp/assets/*
  if (urlPath.startsWith('/assets/')) {
    const file = path.join(MINIAPP, urlPath)
    return serveFile(file, res)
  }

  if (urlPath === '/') urlPath = '/index.html'
  const file = path.join(ROOT, urlPath)
  // 防目录穿越
  if (!file.startsWith(ROOT) && !file.startsWith(MINIAPP)) {
    res.writeHead(403); return res.end('forbidden')
  }
  // 自动刷新脚本只注入画廊页（顶层 index.html）；页面镜像由画廊统一重载，
  // 避免 10 个 iframe 各自轮询 /__version（网络不空闲会拖垮截图/性能）。
  serveFile(file, res, urlPath === '/index.html')
})

function serveFile(file, res, injectReload = false) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end('not found: ' + file)
    }
    const ext = path.extname(file)
    let body = data
    if (ext === '.html' && injectReload) {
      body = data.toString().replace('</body>', `${RELOAD_SNIPPET}\n</body>`)
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    res.end(body)
  })
}

server.listen(PORT, () => {
  console.log(`[preview] miniapp preview → http://localhost:${PORT}`)
})
