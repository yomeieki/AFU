/**
 * 带修饰键的链接点击要交还给浏览器，不能 preventDefault。
 *
 * Cmd/Ctrl+点击开新标签、Shift+点击开新窗口、Alt+点击下载——这些都不会离开当前页，
 * 所以「未保存改动会丢」的守卫不该拦它们；拦了就等于把这些习惯用法废掉。
 * 判据与 react-router 的 shouldProcessLinkClick 对齐（它同样是 button === 0 且无修饰键
 * 才接管），保证我们放行的那些点击 react-router 自己也不会接管，最终落到浏览器默认行为。
 *
 * button !== 0 这条在现代浏览器里基本是死代码（中键点击派发的是 auxclick，React 的
 * onClick 收不到），保留是为了与上面那个判据逐字一致，不留下"为什么少一条"的疑问。
 */
export function isModifiedLinkClick(event: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  button: number
}): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0
}
