import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PaginationProps {
  page: number
  total: number
  pageSize: number
  onChange: (page: number) => void
  pageSizeOptions?: number[]
  onPageSizeChange?: (size: number) => void
}

// 生成页码窗口：1 ... p-2 p-1 p p+1 p+2 ... N（省略号用 -1 表示）
function pageWindow(page: number, totalPages: number): number[] {
  const pages = new Set<number>([1, totalPages])
  for (let p = page - 2; p <= page + 2; p++) {
    if (p >= 1 && p <= totalPages) pages.add(p)
  }
  const sorted = [...pages].sort((a, b) => a - b)
  const result: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push(-1)
    result.push(sorted[i])
  }
  return result
}

export default function Pagination({
  page,
  total,
  pageSize,
  onChange,
  pageSizeOptions,
  onPageSizeChange,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  return (
    <div className="px-4 py-3 border-t border-gray-100 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-500">
      <span className="flex items-center gap-3">
        共 {total} 条
        {pageSizeOptions && onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="border border-gray-200 rounded px-1.5 py-1 text-sm text-gray-600 focus:outline-none focus:border-brand-400"
          >
            {pageSizeOptions.map((s) => (
              <option key={s} value={s}>
                {s} 条/页
              </option>
            ))}
          </select>
        )}
      </span>
      <div className="flex items-center gap-1">
        <button
          disabled={page <= 1}
          onClick={() => onChange(page - 1)}
          className="inline-flex items-center px-2 py-1 sm:py-1 min-h-[2.25rem] sm:min-h-0 border border-gray-200 rounded disabled:opacity-40 hover:bg-gray-50 transition-colors"
          aria-label="上一页"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="sm:hidden ml-0.5">上一页</span>
        </button>
        {/* <sm：紧凑页码指示，不展开数字窗口 */}
        <span className="sm:hidden px-2 text-gray-600 select-none">
          {page} / {totalPages}
        </span>
        {pageWindow(page, totalPages).map((p, i) =>
          p === -1 ? (
            <span key={`e${i}`} className="hidden sm:inline px-1.5 select-none">
              …
            </span>
          ) : (
            <button
              key={p}
              onClick={() => p !== page && onChange(p)}
              className={`hidden sm:inline-block min-w-[2rem] px-2 py-1 border rounded transition-colors ${
                p === page
                  ? 'border-brand-500 bg-brand-500 text-white'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
          className="inline-flex items-center px-2 py-1 min-h-[2.25rem] sm:min-h-0 border border-gray-200 rounded disabled:opacity-40 hover:bg-gray-50 transition-colors"
          aria-label="下一页"
        >
          <span className="sm:hidden mr-0.5">下一页</span>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
