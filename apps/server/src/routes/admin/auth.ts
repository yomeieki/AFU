import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { signAdminToken } from '../../utils/jwt'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { loginLimiter } from '../../middlewares/rate-limit'
import crypto from 'crypto'

const router = Router()

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空').max(64),
  password: z.string().min(1, '密码不能为空').max(128),
})

// POST /api/admin/login
router.post('/login', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = loginSchema.parse(req.body)

    const admin = await prisma.admin.findUnique({ where: { username } })
    if (!admin || admin.status === 0) {
      throw new AppError(40401, '账号不存在或已禁用', 404)
    }

    const valid = await bcrypt.compare(password, admin.passwordHash)
    if (!valid) {
      throw new AppError(40001, '用户名或密码错误')
    }

    await prisma.admin.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    })

    const token = signAdminToken({
      adminId: admin.id,
      username: admin.username,
      role: admin.role,
    })

    success(res, {
      token,
      adminInfo: {
        id: admin.id,
        username: admin.username,
        name: admin.name,
        role: admin.role,
      },
    })
  } catch (e) {
    next(e)
  }
})

// ── 小程序 web-view 免登录：一次性换码 ────────────────────
// 商家在小程序里用账号密码登录后持有 admin token；打开内嵌后台时先换一个 60 秒一次性 code，
// 由 web-view 页面 /m?code= 用 code 换回 token（token 本身不进 URL）。
const WEBVIEW_CODE_TTL_MS = 60 * 1000
const webviewCodes = new Map<string, { adminId: number; username: string; role: string; expiresAt: number }>()

function pruneWebviewCodes() {
  const now = Date.now()
  for (const [k, v] of webviewCodes) if (v.expiresAt < now) webviewCodes.delete(k)
}

/** POST /api/admin/webview-code（需 admin token；挂在 verifyAdminToken 之后） */
export async function createWebviewCode(req: Request, res: Response, next: NextFunction) {
  try {
    pruneWebviewCodes()
    const code = crypto.randomBytes(24).toString('hex')
    webviewCodes.set(code, {
      adminId: req.adminId!,
      username: req.adminUsername!,
      role: req.adminRole ?? 'admin',
      expiresAt: Date.now() + WEBVIEW_CODE_TTL_MS,
    })
    success(res, { code, expiresIn: WEBVIEW_CODE_TTL_MS / 1000 })
  } catch (e) {
    next(e)
  }
}

// POST /api/admin/login/webview {code} — 公开路由，限流同登录
router.post('/login/webview', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = z.object({ code: z.string().min(16).max(128) }).parse(req.body ?? {})
    pruneWebviewCodes()
    const entry = webviewCodes.get(code)
    webviewCodes.delete(code) // 单次使用
    if (!entry) throw new AppError(40103, '登录凭证已失效，请重新进入', 401)
    const admin = await prisma.admin.findUnique({ where: { id: entry.adminId } })
    if (!admin || admin.status === 0) throw new AppError(40401, '账号不存在或已禁用', 404)
    const token = signAdminToken({ adminId: admin.id, username: admin.username, role: admin.role })
    success(res, { token, adminInfo: { id: admin.id, username: admin.username, name: admin.name, role: admin.role } })
  } catch (e) {
    next(e)
  }
})

export default router
