import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import prisma from '../utils/prisma'
import { signUserToken } from '../utils/jwt'
import { success } from '../utils/response'
import { AppError } from '../middlewares/error'
import { loginLimiter } from '../middlewares/rate-limit'
import { config } from '../config'

const router = Router()

const loginSchema = z.object({
  code: z.string().min(1, '缺少微信 code'),
})

// POST /api/auth/wechat-login
router.post('/wechat-login', loginLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = loginSchema.parse(req.body)
    // 生产环境缺 WECHAT_APP_ID 直接报错，绝不静默降级到 mock（config.ts 已保证生产不允许 WECHAT_LOGIN_MOCK=true）
    if (!process.env.WECHAT_APP_ID && config.isProduction) {
      throw new AppError(50001, '服务配置错误：缺少 WECHAT_APP_ID', 500)
    }
    const useMock = !process.env.WECHAT_APP_ID || config.mock.login

    let openid: string

    if (useMock) {
      // Dev mock: derive a stable openid from the code prefix
      openid = `mock_openid_${code.slice(0, 8)}`
    } else {
      const appId = process.env.WECHAT_APP_ID!
      const appSecret = process.env.WECHAT_APP_SECRET!
      const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(appId)}&secret=${encodeURIComponent(appSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
      const resp = await fetch(url)
      const data = (await resp.json()) as {
        openid?: string
        session_key?: string
        errcode?: number
        errmsg?: string
      }
      if (!data.openid) {
        throw new AppError(40001, `微信登录失败: ${data.errmsg ?? '未知错误'}`)
      }
      openid = data.openid
    }

    const user = await prisma.user.upsert({
      where: { openid },
      update: { lastLoginAt: new Date() },
      create: { openid, status: 1 },
    })

    const token = signUserToken({ userId: user.id, openid: user.openid })

    success(res, {
      token,
      userId: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
    })
  } catch (e) {
    next(e)
  }
})

export default router
