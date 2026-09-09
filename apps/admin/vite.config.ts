import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

const gitShort = () => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } }
const APP_VERSION = (process.env.APP_VERSION ?? '').trim() || gitShort() || 'dev'

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: {
    host: true, // 允许手机经局域网 IP 访问（移动端后台）
    port: 5173,
    proxy: {
      '/api': {
        // 本机 3000 端口被其他项目占用时，可用 VITE_PROXY_TARGET 指向实际后端（如 http://localhost:3100）
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
