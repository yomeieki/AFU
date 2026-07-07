import jwt from 'jsonwebtoken'
import { config } from '../config'

// 密钥由 config.ts 启动时强制校验，此处不再有任何硬编码回退
const USER_SECRET = config.jwt.userSecret
const USER_EXPIRES = config.jwt.userExpiresIn as jwt.SignOptions['expiresIn']
const ADMIN_SECRET = config.jwt.adminSecret
const ADMIN_EXPIRES = config.jwt.adminExpiresIn as jwt.SignOptions['expiresIn']

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
