import { Router, Request, Response, NextFunction } from 'express'
import bcrypt from 'bcryptjs'
import prisma from '../../utils/prisma'
import { signAdminToken } from '../../utils/jwt'
import { success } from '../../utils/response'
import { AppError } from '../../middlewares/error'

const router = Router()

// POST /api/admin/login
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      throw new AppError(40001, '用户名和密码不能为空')
    }

    const admin = await prisma.admin.findUnique({ where: { username } })
    if (!admin || admin.status === 0) {
      throw new AppError(40401, '账号不存在或已禁用', 404)
    }

    const valid = await bcrypt.compare(password as string, admin.passwordHash)
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
