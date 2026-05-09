import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'

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
  _req: Request,
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

  console.error('[Error]', err)
  return res.status(500).json({
    code: 50001,
    message: '服务器内部错误',
    data: null,
  })
}
