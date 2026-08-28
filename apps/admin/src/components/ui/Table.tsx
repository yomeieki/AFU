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
  /**
   * 移动端卡片渲染（<md 显示）。传入时：表格在 <md 隐藏、卡片在 ≥md 隐藏；
   * loading 骨架与空态两侧共用。不传则行为与原来完全一致。
   */
  mobileCards?: ReactNode
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
  mobileCards,
}: TableProps) {
  const table = (
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

  if (!mobileCards) return table

  return (
    <>
      <div className="hidden md:block">{table}</div>
      <div className="md:hidden p-3 space-y-3">
        {loading ? (
          [...Array(4)].map((_, i) => (
            <div key={i} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
          ))
        ) : isEmpty ? (
          <EmptyState text={emptyText} />
        ) : (
          mobileCards
        )}
      </div>
    </>
  )
}
