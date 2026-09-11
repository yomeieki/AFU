import type { ReactNode } from 'react'

/**
 * 「一行一段 + 删除键 + 底下再加一段」的通用编辑器（PO 2026-09-08）。
 *
 * 取代原来「一个文本框、一行一段」的写法。那种写法的错误全是格式性的——中文冒号、少个横杠、
 * `9:00`、金额和公里写反——而服务端 sanitize 会把不合法的行**静默丢掉**：保存成功，
 * 但那一段营业时间没了，谁也不知道。这里把每一段拆成独立输入框，格式错误从源头消失，
 * 剩下的业务错误（结束早于开始、两段重叠）就地标红，`errors` 非空时调用方把保存键置灰。
 *
 * 排序不在这里做：编辑时行位置跳动很烦人，调用方保存前再排。
 */
export function RowList<T>({ rows, onChange, blank, render, errors, addLabel, emptyHint }: {
  rows: T[]
  onChange: (rows: T[]) => void
  /** 点「再加一段」时新行的初值 */
  blank: () => T
  /** 渲染一行里的输入框；set 只改这一行 */
  render: (row: T, set: (patch: Partial<T>) => void, index: number) => ReactNode
  /** 每行的错误文案（与 rows 同长，无错为 '' 或 undefined） */
  errors?: (string | undefined)[]
  addLabel: string
  /** 一行都没有时显示的提示（比如「留空 = 关闭」） */
  emptyHint?: string
}) {
  const update = (i: number, patch: Partial<T>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i))
  return (
    <div className="space-y-2">
      {rows.length === 0 && emptyHint && <p className="text-xs text-gray-400">{emptyHint}</p>}
      {rows.map((row, i) => {
        const err = errors?.[i]
        return (
          <div key={i} className={`rounded-md border p-2 ${err ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-white'}`}>
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 flex-wrap gap-y-1 min-w-0">{render(row, (p) => update(i, p), i)}</div>
              <button type="button" onClick={() => remove(i)} aria-label="删除这一段"
                className="shrink-0 w-8 h-8 rounded-md border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-red-600">✕</button>
            </div>
            {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
          </div>
        )
      })}
      <button type="button" onClick={() => onChange([...rows, blank()])}
        className="w-full rounded-md border border-dashed border-gray-300 py-2 text-sm text-gray-600 hover:border-gray-400 hover:bg-gray-50">
        ＋ {addLabel}
      </button>
    </div>
  )
}

/** HH:mm → 分钟数；空串或格式不对给 NaN */
const toMin = (t: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(t ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN
}

/**
 * 时段列表的校验：每行开始/结束都要填、结束要晚于开始、两两不重叠。
 * 重叠的两行都标红——只标一行，员工会去改那一行，改完另一行又和别的撞上。
 */
export function validateRanges(rows: { start: string; end: string }[]): (string | undefined)[] {
  const errs: (string | undefined)[] = rows.map((r) => {
    const a = toMin(r.start), b = toMin(r.end)
    if (Number.isNaN(a) || Number.isNaN(b)) return '开始和结束时间都要选'
    if (b <= a) return '结束时间要晚于开始时间（首期不支持跨零点）'
    return undefined
  })
  rows.forEach((r, i) => {
    if (errs[i]) return
    rows.forEach((o, j) => {
      if (j <= i || errs[j]) return
      if (toMin(r.start) < toMin(o.end) && toMin(o.start) < toMin(r.end)) {
        errs[i] = errs[i] ?? `与第 ${j + 1} 段重叠`
        errs[j] = errs[j] ?? `与第 ${i + 1} 段重叠`
      }
    })
  })
  return errs
}

/** 保存前按开始时间排好，存进去的顺序就是顾客看到的顺序 */
export const sortRanges = <T extends { start: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => toMin(a.start) - toMin(b.start))

/** 两个时间框 + 「至」，营业时段与高峰时段共用 */
export function TimeRangeRow({ row, set, cls }: {
  row: { start: string; end: string }; set: (p: Partial<{ start: string; end: string }>) => void; cls: string
}) {
  return (
    <>
      <input className={`${cls} !w-36 shrink-0`} type="time" step={60} value={row.start} onChange={(e) => set({ start: e.target.value })} />
      <span className="text-sm text-gray-500 shrink-0">至</span>
      <input className={`${cls} !w-36 shrink-0`} type="time" step={60} value={row.end} onChange={(e) => set({ end: e.target.value })} />
    </>
  )
}
