import jwt from 'jsonwebtoken'

const USER_SECRET = process.env.JWT_SECRET || 'user-dev-secret'
const USER_EXPIRES = (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn']
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || 'admin-dev-secret'
const ADMIN_EXPIRES = (process.env.ADMIN_JWT_EXPIRES_IN || '24h') as jwt.SignOptions['expiresIn']

export function signUserToken(payload: { userId: number; openid: string }) {
  return jwt.sign(payload, USER_SECRET, { expiresIn: USER_EXPIRES })
}

export function signAdminToken(payload: {
  adminId: number
  username: string
  role: string
}) {
  return jwt.sign(payload, ADMIN_SECRET, { expiresIn: ADMIN_EXPIRES })
}

export function verifyUserJwt(token: string) {
  return jwt.verify(token, USER_SECRET) as {
    userId: number
    openid: string
  }
}

export function verifyAdminJwt(token: string) {
  return jwt.verify(token, ADMIN_SECRET) as {
    adminId: number
    username: string
    role: string
  }
}
