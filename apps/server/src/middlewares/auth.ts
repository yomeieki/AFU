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
