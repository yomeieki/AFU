import { Request, Response, NextFunction } from 'express'
import { verifyUserJwt, verifyAdminJwt } from '../utils/jwt'
import { AppError } from './error'

export function verifyUserToken(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(40101, '未登录', 401))
  }
  try {
    const token = authHeader.slice(7)
    const payload = verifyUserJwt(token)
    req.userId = payload.userId
    req.openid = payload.openid
    next()
  } catch {
    next(new AppError(40102, 'Token 已过期或无效', 401))
  }
}

// 可选认证：有有效 token 则解析 userId/openid，无 token 或无效则匿名放行
// 用于扫码日志等不强制登录的场景（ScanLog.userId 可空）
export function optionalUserAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = verifyUserJwt(authHeader.slice(7))
      req.userId = payload.userId
      req.openid = payload.openid
    } catch {
      // 无效 token 视为匿名，不阻断请求
    }
  }
  next()
}

export function verifyAdminToken(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return next(new AppError(40101, '管理员未登录', 401))
  }
  try {
    const token = authHeader.slice(7)
    const payload = verifyAdminJwt(token)
    req.adminId = payload.adminId
    req.adminUsername = payload.username
    req.adminRole = payload.role
    next()
  } catch {
    next(new AppError(40102, '管理员 Token 已过期或无效', 401))
  }
}
