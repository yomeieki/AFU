import { Router, Request, Response, NextFunction } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { config } from '../../config'
import { isCosEnabled, putObject, buildObjectKey } from '../../services/cos'

const router = Router()

// 本地回退目录（仅开发环境未配置 COS 时使用；生产由 config.ts 强制要求 COS）
const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads')

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES[file.mimetype]) {
      return cb(new AppError(40001, '仅支持 jpg/png/webp 格式图片'))
    }
    cb(null, true)
  },
})

async function saveLocal(buffer: Buffer, ext: string): Promise<string> {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buffer)
  return `${config.publicBaseUrl}/uploads/${filename}`
}

// POST /api/admin/upload — 单文件上传，返回可访问的绝对 URL（admin 与小程序均跨域访问）
router.post('/', upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) throw new AppError(40001, '未收到文件（字段名应为 file）')
    const ext = ALLOWED_TYPES[req.file.mimetype] ?? path.extname(req.file.originalname)
    const url = isCosEnabled()
      ? await putObject(buildObjectKey('uploads', ext), req.file.buffer, req.file.mimetype)
      : await saveLocal(req.file.buffer, ext)
    success(res, { url, storage: isCosEnabled() ? 'cos' : 'local' })
  } catch (e) {
    next(e)
  }
})

export default router
