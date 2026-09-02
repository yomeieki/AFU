import { Router, Request, Response, NextFunction } from 'express'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { createImageUpload, storeImage } from '../../services/upload'

const router = Router()
const upload = createImageUpload(5 * 1024 * 1024) // 5MB

// POST /api/admin/upload — 单文件上传，返回可访问的绝对 URL（admin 与小程序均跨域访问）
router.post('/', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(40001, '未收到文件（字段名应为 file）')
    success(res, await storeImage(req.file, 'uploads'))
  } catch (e) {
    next(e)
  }
})

export default router
