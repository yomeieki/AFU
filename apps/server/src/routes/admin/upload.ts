import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { config } from '../../config'

const router = Router()

// 本地上传目录（TODO: 后续迁移腾讯云 COS）
const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = ALLOWED_TYPES[file.mimetype] ?? path.extname(file.originalname)
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(new AppError(40001, '仅支持 jpg/png/webp 格式图片'))
    }
    cb(null, true)
  },
})

// POST /api/admin/upload — 单文件上传，返回可访问 URL
router.post('/', upload.single('file'), (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(40001, '未收到文件（字段名应为 file）')
    // 返回绝对 URL：admin 与小程序均跨域访问图片资源
    success(res, { url: `${config.publicBaseUrl}/uploads/${req.file.filename}` })
  } catch (e) {
    next(e)
  }
})

export default router
