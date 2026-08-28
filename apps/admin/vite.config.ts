import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
