import { Router, Request, Response, NextFunction } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { createImageUpload, storeImage } from '../services/upload'

const router = Router()
const upload = createImageUpload(3 * 1024 * 1024) // 顾客端 3MB（小程序 chooseMedia 压缩后一般 <1MB）

// 每用户每分钟 10 张，防刷（挂在 verifyUserToken 之后，按 userId 计数）
const userUploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? `u:${req.userId}` : ipKeyGenerator(req.ip ?? '')),
  message: { code: 42901, message: '上传过于频繁，请稍后再试', data: null },
})

// POST /api/upload — 顾客上传售后凭证图片
router.post('/', userUploadLimiter, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(40001, '未收到文件（字段名应为 file）')
    success(res, await storeImage(req.file, 'after-sale'))
  } catch (e) {
    next(e)
  }
})

export default router
