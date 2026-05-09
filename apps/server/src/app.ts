import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { router } from './routes'
import { errorHandler } from './middlewares/error'

const app = express()
const PORT = Number(process.env.PORT) || 3000

app.use(cors())
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
