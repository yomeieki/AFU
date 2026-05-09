import { Request, Response, NextFunction } from 'express'
import { verifyUserJwt } from '../utils/jwt'

// TODO: 阶段 7 接入微信登录后，用 verifyUserToken 替换此中间件并删除
// 开发模式：有有效 Bearer token 则解析真实 userId；无 token 则默认 userId=1（seed dev user）
export function devUserMiddleware(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const payload = verifyUserJwt(token)
      req.userId = payload.userId
      req.openid = payload.openid
    } catch {
      // 无效 token → 降级到 dev user
    }
  }
  if (!req.userId) {
    req.userId = 1 // DEV_USER_ID — 对应 seed.ts 中 openid=dev_openid_001 的用户
  }
  next()
}
