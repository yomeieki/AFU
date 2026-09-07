// 本目录的静态文件服务器，只为在浏览器里看 preview.html。
//
// 为什么不用 `npm run preview:miniapp`：那个服务器的 ROOT 是 tools/miniapp-preview
// （serve.mjs:17），只能服务小程序页面镜像，服务不了 docs/ 下的文件。
//
// 用法：node docs/design/miniapp-local-v2/serve.mjs [--port 5190]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const i = process.argv.indexOf('--port')
const PORT = i !== -1 ? Number(process.argv[i + 1]) : 5190
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0])
  const file = path.join(ROOT, urlPath === '/' ? 'preview.html' : urlPath)
  if (!path.resolve(file).startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  })
}).listen(PORT, () => console.log(`[design-preview] http://localhost:${PORT}`))
