import { ReactNode } from 'react'
import EmptyState from './EmptyState'

interface TableProps {
  /** 表头行（<tr>...</tr>） */
  head: ReactNode
  /** 表头列数，用于 loading 骨架与空态的 colSpan */
  columns: number
  loading?: boolean
  isEmpty?: boolean
  emptyText?: string
  /** tbody 内容（<tr> 列表） */
  children: ReactNode
}

/**
 * 表格外壳：卡片容器 + 统一表头样式 + loading 骨架行 + 空态行。
 * 列 JSX 由页面自持（不做泛型列配置）。
 */
export default function Table({
  head,
  columns,
  loading = false,
  isEmpty = false,
  emptyText = '暂无数据',
  children,
}: TableProps) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 text-gray-600">{head}</thead>
      <tbody className="divide-y divide-gray-100">
        {loading ? (
          [...Array(5)].map((_, i) => (
            <tr key={i}>
              <td colSpan={columns} className="px-4 py-3">
                <div className="h-4 bg-gray-100 rounded animate-pulse" />
              </td>
            </tr>
          ))
        ) : isEmpty ? (
          <tr>
            <td colSpan={columns}>
              <EmptyState text={emptyText} />
            </td>
          </tr>
        ) : (
          children
        )}
      </tbody>
    </table>
  )
}
