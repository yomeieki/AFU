/** 进程启动时取一次版本：APP_VERSION 环境变量 > git 短 SHA > 'dev'。放进每个响应的 X-App-Version 头，
 *  后台拿它和自己构建时编入的版本比对，发版后挂着的旧页面才能知道该刷新（2026-09-09 iPad 事件）。 */
import { execSync } from 'child_process'
function gitShort(): string | null {
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null } catch { return null }
}
export const APP_VERSION: string = (process.env.APP_VERSION ?? '').trim() || gitShort() || 'dev'
