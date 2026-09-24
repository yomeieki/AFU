/**
 * 用户订单弹窗的请求过期保护——纯状态机（2026-09-24，复核 R1 阻断项修法）。
 *
 * 弹窗打开来源有三处（行内按钮、URL 按 orders=<id> 重开、点「加载更多」），三条网络响应
 * 谁先谁后完全不可控（弱网、并发点击）。BASE 早就有「首页晚到」的漏洞（切换到 B 之后 A 的
 * 首页请求才回来，把 B 的弹窗内容换成 A 的），本批新增「加载更多」后这个漏洞的后果更重：
 * 迟到的分页结果会把 `total`/`list` 改写成别的用户的。
 *
 * 做法：每次「打开/关闭/按 URL 重开」都从组件里的 `useRef` 计数器领一个新的会话号 `seq`，
 * 所有网络响应回调都带着「发出时的 seq」调这里的纯函数；`seq` 与当前会话号不一致，原样
 * 返回同一个 `state` 引用（React 用 `Object.is` 判断要不要重渲，同引用 = 什么都没发生）。
 * 这个文件不碰网络、不碰 React，只做「seq 对不对 → 要不要应用这次更新」的判断，可以脱离
 * 组件单独测试穷举所有到达顺序。
 */

export interface OrdersSession<U, O extends { id: number }> {
  /** 当前会话号；每次打开/关闭/按 URL 重开都 +1（由调用方的 useRef 计数器生成） */
  seq: number
  /** null = 弹窗不渲染：关闭状态，或「按 URL 重开、getUser 还没回来」 */
  user: U | null
  list: O[]
  total: number
  page: number
  loading: 'idle' | 'first' | 'more'
  failed: boolean
}

export function initialSession<U, O extends { id: number }>(): OrdersSession<U, O> {
  return { seq: 0, user: null, list: [], total: 0, page: 0, loading: 'idle', failed: false }
}

/**
 * 打开弹窗（行内按钮点击）或开始按 URL 重开（`user` 传 `null`，等 `getUser` 回来再
 * `applyUserLoaded`）。无条件重置 `list/total/page/failed`，`loading` 置 `'first'`。
 */
export function openSession<U, O extends { id: number }>(
  _s: OrdersSession<U, O>,
  seq: number,
  user: U | null
): OrdersSession<U, O> {
  return { seq, user, list: [], total: 0, page: 0, loading: 'first', failed: false }
}

/** 关闭弹窗：`user` 置 `null`（弹窗不渲染），其余重置为初始态。 */
export function closeSession<U, O extends { id: number }>(_s: OrdersSession<U, O>, seq: number): OrdersSession<U, O> {
  return { seq, user: null, list: [], total: 0, page: 0, loading: 'idle', failed: false }
}

/** 按 URL 重开时 `getUser` 的响应回填 `user`；`seq` 不符（已被关闭/切换）→ 原样丢弃。 */
export function applyUserLoaded<U, O extends { id: number }>(
  s: OrdersSession<U, O>,
  { seq, user }: { seq: number; user: U }
): OrdersSession<U, O> {
  if (seq !== s.seq) return s
  return { ...s, user }
}

/**
 * 一页订单到达：`seq` 不符 → 丢弃（同一引用）。`page === 1` 整体替换 `list`；
 * 其余页追加并按 `id` 去重（已存在的跳过，保持原顺序——已加载的在前，新到的接在后面）。
 * 成功即代表这次请求没有过期，顺带把 `loading` 收回 `'idle'`、清掉上一次的 `failed`
 * （否则一次失败重试成功后，失败提示会一直挂着）。
 */
export function applyOrdersPage<U, O extends { id: number }>(
  s: OrdersSession<U, O>,
  { seq, page, list, total }: { seq: number; page: number; list: O[]; total: number }
): OrdersSession<U, O> {
  if (seq !== s.seq) return s
  const nextList = page === 1 ? list : dedupeAppend(s.list, list)
  return { ...s, list: nextList, total, page, loading: 'idle', failed: false }
}

/** 点「加载更多」时先置 `loading:'more'`；`seq` 不符（弹窗已经换人/关闭）→ 丢弃。 */
export function beginMore<U, O extends { id: number }>(s: OrdersSession<U, O>, seq: number): OrdersSession<U, O> {
  if (seq !== s.seq) return s
  return { ...s, loading: 'more' }
}

/**
 * 请求失败：`seq` 不符 → 丢弃（不弹 toast，见组件里的调用点）。`page === 1` 失败才置
 * `failed: true`（首屏失败态会盖住整个弹窗内容）；分页失败只复位 `loading`，已加载的
 * `list` 原样保留——不能因为「加载更多」失败一次就把前面已经显示的订单也吞掉。
 */
export function applyOrdersError<U, O extends { id: number }>(
  s: OrdersSession<U, O>,
  { seq, page }: { seq: number; page: number }
): OrdersSession<U, O> {
  if (seq !== s.seq) return s
  if (page === 1) return { ...s, loading: 'idle', failed: true }
  return { ...s, loading: 'idle' }
}

function dedupeAppend<O extends { id: number }>(existing: O[], incoming: O[]): O[] {
  const seen = new Set(existing.map((o) => o.id))
  const appended = incoming.filter((o) => !seen.has(o.id))
  return [...existing, ...appended]
}
