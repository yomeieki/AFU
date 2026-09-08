import { config } from './config' // 必须最先导入：加载 dotenv 并校验环境变量
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import { router } from './routes'
import { errorHandler } from './middlewares/error'
import { wechatPayNotifyHandler, wechatRefundNotifyHandler } from './routes/wechat-notify'
import kdCallbackRouter from './routes/kd-callback'
import kdExpressCallbackRouter from './routes/kd-express-callback'
import prisma from './utils/prisma'
import { notifySystemAlert } from './services/notify'
import { startScheduler } from './services/scheduler'

const app = express()
const PORT = config.port

// nginx 在前面做反向代理。不开 trust proxy 时 Express 认为客户端 IP 永远是
// 127.0.0.1，express-rate-limit 于是把所有人算作同一个来源——限流从"每 IP"退化成
// "全站共用一个桶"，任何一个人触发就会把所有人一起挡住（登录 5 次/分、支付 20 次/分）。
// 设为 1 = 只信任一层代理（本机 nginx），取 X-Forwarded-For 的最后一跳，
// 客户端无法通过伪造该头来绕过限流。
app.set('trust proxy', 1)

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
app.post('/api/wechat/pay/refund-notify', express.text({ type: '*/*' }), wechatRefundNotifyHandler)
// 快递100 状态回调：无鉴权（安全性来自 per-单 salt 验签），自带 urlencoded 中间件
app.use('/api/kd', kdCallbackRouter)
// 快递100 上门取件回调：同上，per-预约 salt 验签
app.use('/api/kd-express', kdExpressCallbackRouter)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 本地上传图片静态托管：开发回退 + 生产存量图片过渡期兼容（COS 迁移完成一个部署周期后可下线）
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')))

// 健康检查：带 DB 探活（3 秒超时），供 deploy.sh / UptimeRobot 拨测；DB 不可用返回 503，不暴露细节
app.get('/health', async (_req, res) => {
  const dbOk = await Promise.race([
    prisma.$queryRaw`SELECT 1`.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ]).catch(() => false)
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'ok' : 'fail',
    timestamp: new Date().toISOString(),
  })
})

app.use('/api', router)

app.use(errorHandler)

// 进程级兜底：未处理的 Promise 拒绝只告警不退出（多为通知类副作用）；
// 未捕获异常告警后退出，交给 PM2 重启（进程状态已不可信）
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason)
  notifySystemAlert('unhandledRejection', [String(reason instanceof Error ? reason.stack ?? reason.message : reason)], {
    key: 'unhandledRejection',
  })
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err)
  notifySystemAlert('uncaughtException（进程将重启）', [`${err.name}: ${err.message}`, (err.stack ?? '').split('\n')[1]?.trim() ?? ''], {
    key: 'uncaughtException',
  })
  setTimeout(() => process.exit(1), 1500)
})

app.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`)
  console.log(`[server] env: ${config.nodeEnv}`)
  startScheduler()
  if (config.isProduction) {
    // 生产启动打点：频繁收到即说明重启风暴
    notifySystemAlert('服务启动', [`端口 ${PORT}`], { key: 'boot', windowMs: 60 * 1000 })
  }
})

export default app
