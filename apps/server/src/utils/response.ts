import { Response } from 'express'

export function success(res: Response, data: unknown = null, message = 'success') {
  return res.json({ code: 0, message, data })
}

export function paginate(
  res: Response,
  list: unknown[],
  total: number,
  page: number,
  pageSize: number
) {
  return res.json({
    code: 0,
    message: 'success',
    data: { list, total, page, pageSize },
  })
}
