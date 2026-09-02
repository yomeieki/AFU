import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'
import { notifySystemAlert } from '../services/notify'

export class AppError extends Error {
  constructor(
    public code: number,
    message: string,
    public httpStatus: number = 400
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json({
      code: err.code,
      message: err.message,
      data: null,
    })
  }

  if (err instanceof ZodError) {
    const message = err.issues.map((i) => i.message).join('；')
    return res.status(400).json({
      code: 40001,
      message: `参数错误：${message}`,
      data: null,
    })
  }

  // 路径参数非法（如 /orders/abc → id=NaN）导致的 Prisma 校验错误：属客户端错误，不算 500、不告警
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({ code: 40001, message: '参数错误：请求参数无效', data: null })
  }

  console.error('[Error]', err)
  // 未预期的 500 推企微告警（同路由 5 分钟内只发一次）
  const routePath = (req.route as { path?: string } | undefined)?.path ?? req.path
  notifySystemAlert(
    '接口 500',
    [`${req.method} ${req.originalUrl}`, `${err.name}: ${err.message}`, (err.stack ?? '').split('\n')[1]?.trim() ?? ''],
    { key: `500:${req.method}:${routePath}` }
  )
  return res.status(500).json({
    code: 50001,
    message: '服务器内部错误',
    data: null,
  })
}
