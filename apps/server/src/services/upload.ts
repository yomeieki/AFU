/**
 * 图片上传公共层：multer 内存接收 + COS（生产）/本地 uploads/（开发回退）落盘。
 * 后台上传与顾客售后传图共用；两端仅 multer 限制（大小）不同。
 */
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { AppError } from '../middlewares/error'
import { config } from '../config'
import { isCosEnabled, putObject, buildObjectKey } from './cos'

// 本地回退目录（仅开发环境未配置 COS 时使用；生产由 config.ts 强制要求 COS）
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads')

export const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

export function createImageUpload(maxBytes: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_IMAGE_TYPES[file.mimetype]) {
        return cb(new AppError(40001, '仅支持 jpg/png/webp 格式图片'))
      }
      cb(null, true)
    },
  })
}

async function saveLocal(buffer: Buffer, ext: string, folder: string): Promise<string> {
  const dir = path.join(UPLOAD_DIR, folder)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`
  await fs.promises.writeFile(path.join(dir, filename), buffer)
  return `${config.publicBaseUrl}/uploads/${folder}/${filename}`
}

/** 落盘并返回可公开访问的绝对 URL。folder：uploads（后台）/ after-sale（顾客售后图） */
export async function storeImage(
  file: { buffer: Buffer; mimetype: string; originalname: string },
  folder: 'uploads' | 'after-sale' = 'uploads'
): Promise<{ url: string; storage: 'cos' | 'local' }> {
  const ext = ALLOWED_IMAGE_TYPES[file.mimetype] ?? path.extname(file.originalname)
  if (isCosEnabled()) {
    const url = await putObject(buildObjectKey(folder, ext), file.buffer, file.mimetype)
    return { url, storage: 'cos' }
  }
  return { url: await saveLocal(file.buffer, ext, folder), storage: 'local' }
}
