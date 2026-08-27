import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PaginationProps {
  page: number
  total: number
  pageSize: number
  onChange: (page: number) => void
}

export default function Pagination({ page, total, pageSize, onChange }: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between text-sm text-gray-500">
      <span>共 {total} 条</span>
      <div className="flex items-center gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className="inline-flex items-center gap-0.5 px-2.5 py-1 border border-gray-200 rounded disabled:opacity-40 hover:bg-gray-50 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          上一页
        </button>
        <span className="px-2">
          {page} / {totalPages}
        </span>
        <button
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          className="inline-flex items-center gap-0.5 px-2.5 py-1 border border-gray-200 rounded disabled:opacity-40 hover:bg-gray-50 transition-colors"
        >
          下一页
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
