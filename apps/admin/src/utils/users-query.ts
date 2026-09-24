/**
 * 用户管理页的筛选/排序/弹窗状态 —— 全部迁到 URL 查询参数（2026-09-24），
 * 与 `pages/LocalOrders.tsx` 的 `useSearchParams` 同款用法。目的：从订单详情页
 * 「返回」时能落回同一个地址，用户页据此自动重开订单弹窗、恢复筛选条件。
 *
 * 键名：`kw`（关键词）、`hasOrders`（只写 `0`，省略即为 true）、`page`、
 * `sort`（只认字面量 `spend`）、`orders`（订单弹窗对应的 userId）。
 * 默认值一律不落 URL——地址栏只应该出现「偏离默认」的部分，保持干净、可分享。
 */
export interface UsersQuery {
  kw: string
  hasOrders: boolean
  page: number
  sort: 'created' | 'spend'
  ordersUserId: number | null
}

const DEFAULTS: UsersQuery = { kw: '', hasOrders: true, page: 1, sort: 'created', ordersUserId: null }

export function readUsersQuery(params: URLSearchParams): UsersQuery {
  const kw = (params.get('kw') ?? '').trim()
  const hasOrders = params.get('hasOrders') !== '0'
  const pageRaw = Number(params.get('page'))
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1
  const sort: UsersQuery['sort'] = params.get('sort') === 'spend' ? 'spend' : 'created'
  const ordersRaw = Number(params.get('orders'))
  const ordersUserId = Number.isInteger(ordersRaw) && ordersRaw > 0 ? ordersRaw : null
  return { kw, hasOrders, page, sort, ordersUserId }
}

/**
 * 在既有 `params` 基础上按 `patch` 写入，返回一份**新的** `URLSearchParams`（不改传入的那个）。
 * 不认识的既有键（不在本文件管的这五个之内）原样保留，不被清掉。
 */
export function writeUsersQuery(params: URLSearchParams, patch: Partial<UsersQuery>): URLSearchParams {
  const next = new URLSearchParams(params)
  const current = readUsersQuery(next)
  const merged: UsersQuery = { ...current, ...patch }

  if (merged.kw && merged.kw !== DEFAULTS.kw) next.set('kw', merged.kw)
  else next.delete('kw')

  if (merged.hasOrders !== DEFAULTS.hasOrders) next.set('hasOrders', '0')
  else next.delete('hasOrders')

  if (merged.page !== DEFAULTS.page) next.set('page', String(merged.page))
  else next.delete('page')

  if (merged.sort !== DEFAULTS.sort) next.set('sort', merged.sort)
  else next.delete('sort')

  if (merged.ordersUserId !== null && merged.ordersUserId !== DEFAULTS.ordersUserId) {
    next.set('orders', String(merged.ordersUserId))
  } else {
    next.delete('orders')
  }

  return next
}
