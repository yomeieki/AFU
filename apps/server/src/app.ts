import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { router } from './routes'
import { errorHandler } from './middlewares/error'
import { wechatPayNotifyHandler } from './routes/wechat-notify'

const app = express()
const PORT = Number(process.env.PORT) || 3000

app.use(cors())

// Mount before express.json() so wechat-pay notify receives raw body for signature verification
app.post('/api/wechat/pay/notify', express.text({ type: '*/*' }), wechatPayNotifyHandler)

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api', router)

app.use(errorHandler)

app.listen(PORT, () => {
  console.log(`[server] running on http://localhost:${PORT}`)
  console.log(`[server] env: ${process.env.NODE_ENV || 'development'}`)
})

export default app
