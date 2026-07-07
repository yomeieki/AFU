import { config } from './config' // 必须最先导入：加载 dotenv 并校验环境变量
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import { router } from './routes'
import { errorHandler } from './middlewares/error'
import { wechatPayNotifyHandler } from './routes/wechat-notify'

const app = express()
const PORT = config.port

// crossOriginResourcePolicy 放开：/uploads 图片需被 admin/小程序跨域加载
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))

// CORS：配置了 CORS_ORIGINS 则按白名单，否则开发环境放开（小程序端不走浏览器 CORS）
app.use(
  cors(
    config.corsOrigins
      ? { origin: config.corsOrigins }
      : config.isProduction
        ? { origin: false }
        : {}
  )
)

// Mount before express.json() so wechat-pay notify receives raw body for signature verification
app.post('/api/wechat/pay/notify', express.text({ type: '*/*' }), wechatPayNotifyHandler)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 本地上传的图片静态托管（后续迁移 COS）
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api', router)

app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`)
  console.log(`[server] env: ${config.nodeEnv}`)
})

export default app
