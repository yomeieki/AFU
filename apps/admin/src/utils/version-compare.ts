/** 服务端 X-App-Version 与本包编入版本的比对。'dev'（本地/取不到 git）永远不触发提示。 */
export function isNewerVersion(build: string, server: string | null | undefined): boolean {
  if (!build || !server || build === 'dev' || server === 'dev') return false
  return build.trim() !== server.trim()
}
