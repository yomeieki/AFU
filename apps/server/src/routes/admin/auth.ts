import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import prisma from '../../utils/prisma'
import { signAdminToken } from '../../utils/jwt'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'
import { loginLimiter } from '../../middlewares/rate-limit'

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

export default router
