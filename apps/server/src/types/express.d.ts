declare global {
  namespace Express {
    interface Request {
      userId?: number
      openid?: string
      adminId?: number
      adminUsername?: string
      adminRole?: string
    }
  }
}

export {}
