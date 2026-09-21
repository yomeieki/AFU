import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import type { SpecDimension } from '../types'

/** 表单态 SKU 行：价格以「元」字符串保存，提交时统一转分 */
export interface SkuRow {
  id?: number
  specValues: string[]
  price: string
  originalPrice: string
  stock: number
}

interface Props {
  dimensions: SpecDimension[]
  skuRows: SkuRow[]
  onChange: (dimensions: SpecDimension[], skuRows: SkuRow[]) => void
}

/** 维度还没有任何值时，组合行里该位置用空串占位（保存前会被校验拦下） */
const PLACEHOLDER = ''

/** 内部匹配键：不用 "/" 拼接，避免规格值本身含 "/"（如 500g/袋）时串位 */
const rowKey = (values: string[]) => values.join('\u0000')

/** 维度值笛卡尔积；没有维度时返回空，某维度暂无值时该位置以占位符参与组合 */
function cartesian(dims: SpecDimension[]): string[][] {
  if (dims.length === 0) return []
  return dims.reduce<string[][]>(
    (acc, d) => {
      const values = d.values.length ? d.values : [PLACEHOLDER]
      return acc.flatMap((combo) => values.map((v) => [...combo, v]))
    },
    [[]]
  )
}

/**
 * 按新维度重新生成组合行，并尽量沿用旧行数据。
 * 1. 值完全一致 → 沿用整行（含 id，保存时是「更新」而非「删了重建」）
 * 2. 旧行在某些位置是占位符（维度刚加、还没值）→ 沿用价格/库存，不带 id
 * 3. 都匹配不上 → 空行
 * 调用方负责先把旧行的 specValues 按改名/换序同步好，这样改名和排序都不会丢数据。
 */
export function rebuildRows(dims: SpecDimension[], oldRows: SkuRow[]): SkuRow[] {
  const old = new Map<string, SkuRow>()
  for (const r of oldRows) {
    const k = rowKey(r.specValues)
    if (!old.has(k)) old.set(k, r)
  }
  return cartesian(dims).map((values) => {
    const exact = old.get(rowKey(values))
    if (exact) return { ...exact, specValues: values }
    // 逐个/成组把位置换成占位符去找（最多 3 维，穷举子集代价可忽略）
    const n = values.length
    for (let mask = 1; mask < 1 << n; mask++) {
      const probe = values.map((v, i) => ((mask >> i) & 1 ? PLACEHOLDER : v))
      const hit = old.get(rowKey(probe))
      if (hit) {
        return { specValues: values, price: hit.price, originalPrice: hit.originalPrice, stock: hit.stock }
      }
    }
    return { specValues: values, price: '', originalPrice: '', stock: 0 }
  })
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

const inputCls =
  'border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const iconBtnCls = 'p-0.5 rounded text-gray-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-gray-400'

interface ValueEditing {
  dim: number
  value: string
  draft: string
}

export default function SpecEditor({ dimensions, skuRows, onChange }: Props) {
  // 每个维度一个「新值」输入框的临时文本
  const [valueDrafts, setValueDrafts] = useState<string[]>([])
  // 正在改名的规格值
  const [editing, setEditing] = useState<ValueEditing | null>(null)
  const [batchPrice, setBatchPrice] = useState('')
  const [batchStock, setBatchStock] = useState('')

  /** 维度或行变化后统一重算组合行 */
  const apply = (dims: SpecDimension[], rows: SkuRow[] = skuRows) => {
    onChange(dims, rebuildRows(dims, rows))
  }

  /** 已保存（有 id）且含指定维度值的行数，用于删除前提示 */
  const savedRowsWith = (di: number, v: string) =>
    skuRows.filter((r) => r.id && r.specValues[di] === v).length

  // ---------- 维度 ----------

  const addDimension = () => {
    if (dimensions.length >= 3) return
    // 现有行在新位置补占位符，等该维度有值后按「占位符匹配」把价格/库存带过去
    const rows = skuRows.map((r) => ({ ...r, specValues: [...r.specValues, PLACEHOLDER] }))
    apply([...dimensions, { name: '', values: [] }], rows)
  }

  const removeDimension = (i: number) => {
    const dim = dimensions[i]
    const hasValues = dim.values.length > 0
    if (hasValues && dimensions.length > 1) {
      const groups = skuRows.length / Math.max(1, dim.values.length)
      const ok = window.confirm(
        `删除维度「${dim.name || `维度${i + 1}`}」后，现有 ${skuRows.length} 个组合会合并为 ${groups} 个，` +
          `每组价格/库存取原来第一行的，请保存前逐行核对。\n\n` +
          `保存后原有规格会被删除并重新创建，顾客购物车里对应的规格会被清空。确定删除？`
      )
      if (!ok) return
    } else if (hasValues && skuRows.some((r) => r.id)) {
      const ok = window.confirm(
        '删除最后一个维度后商品会变成单规格，保存后所有规格及顾客购物车里对应的规格都会被清空。确定删除？'
      )
      if (!ok) return
    }
    const dims = dimensions.filter((_, idx) => idx !== i)
    // 合并（或纯去占位）后按剩余值匹配；真正合并时去掉 id，让服务端重建 SKU
    const rows = skuRows.map((r) => {
      const { id, ...rest } = r
      const specValues = r.specValues.filter((_, idx) => idx !== i)
      return hasValues ? { ...rest, specValues } : { id, ...rest, specValues }
    })
    setEditing(null)
    apply(dims, rows)
  }

  const renameDimension = (i: number, name: string) => {
    // 改维度名不影响组合行，直接透传当前行
    onChange(
      dimensions.map((d, idx) => (idx === i ? { ...d, name } : d)),
      skuRows
    )
  }

  const moveDimension = (from: number, to: number) => {
    if (to < 0 || to >= dimensions.length) return
    const dims = moveItem(dimensions, from, to)
    const rows = skuRows.map((r) => ({ ...r, specValues: moveItem(r.specValues, from, to) }))
    setEditing(null)
    apply(dims, rows)
  }

  // ---------- 规格值 ----------

  /** notify=false 用于失焦自动添加：重复时静默保留草稿，不弹窗打断 */
  const addValue = (i: number, notify = true) => {
    const v = (valueDrafts[i] ?? '').trim()
    if (!v) return
    if (dimensions[i].values.includes(v)) {
      if (notify) window.alert(`规格值「${v}」已存在`)
      return
    }
    const drafts = [...valueDrafts]
    drafts[i] = ''
    setValueDrafts(drafts)
    apply(dimensions.map((d, idx) => (idx === i ? { ...d, values: [...d.values, v] } : d)))
  }

  const removeValue = (i: number, v: string) => {
    const saved = savedRowsWith(i, v)
    if (saved > 0) {
      const ok = window.confirm(
        `删除规格值「${v}」会删除 ${saved} 个已保存的规格（保存后生效），顾客购物车里对应的规格会被清空。确定删除？`
      )
      if (!ok) return
    }
    apply(
      dimensions.map((d, idx) => (idx === i ? { ...d, values: d.values.filter((x) => x !== v) } : d))
    )
  }

  const moveValue = (i: number, from: number, to: number) => {
    const dim = dimensions[i]
    if (to < 0 || to >= dim.values.length) return
    apply(dimensions.map((d, idx) => (idx === i ? { ...d, values: moveItem(d.values, from, to) } : d)))
  }

  const startRename = (i: number, v: string) => setEditing({ dim: i, value: v, draft: v })

  const commitRename = () => {
    if (!editing) return
    const { dim: i, value: oldV } = editing
    const newV = editing.draft.trim()
    setEditing(null)
    if (!newV || newV === oldV) return
    if (dimensions[i].values.includes(newV)) {
      window.alert(`规格值「${newV}」已存在`)
      return
    }
    // 维度值和每一行的对应位置同步改名，行 id/价格/库存全部保留
    const dims = dimensions.map((d, idx) =>
      idx === i ? { ...d, values: d.values.map((x) => (x === oldV ? newV : x)) } : d
    )
    const rows = skuRows.map((r) =>
      r.specValues[i] === oldV
        ? { ...r, specValues: r.specValues.map((x, idx) => (idx === i ? newV : x)) }
        : r
    )
    apply(dims, rows)
  }

  // ---------- 组合行 ----------

  const updateRow = (idx: number, patch: Partial<SkuRow>) => {
    onChange(
      dimensions,
      skuRows.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    )
  }

  const batchFill = () => {
    onChange(
      dimensions,
      skuRows.map((r) => ({
        ...r,
        ...(batchPrice !== '' ? { price: batchPrice } : {}),
        ...(batchStock !== '' ? { stock: Number(batchStock) } : {}),
      }))
    )
  }

  const hasPlaceholder = skuRows.some((r) => r.specValues.includes(PLACEHOLDER))
  const showValue = (v: string) => (v === PLACEHOLDER ? '—' : v)

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50/50">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">商品规格</span>
        {dimensions.length < 3 && (
          <button
            type="button"
            onClick={addDimension}
            className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
          >
            <Plus className="w-4 h-4" />
            添加规格维度
          </button>
        )}
      </div>

      {dimensions.length === 0 ? (
        <p className="text-xs text-gray-400">
          未配置规格：商品按下方「售价/库存」单规格出售。如需多规格（如 辣度、重量、去骨/带骨），点击右上角添加。
        </p>
      ) : (
        <p className="text-xs text-gray-400">
          点击规格值可改名，用箭头调整顺序；改名和换序都会保留已填的价格/库存，小程序按这里的顺序展示。
        </p>
      )}

      {/* 维度编辑 */}
      {dimensions.map((dim, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-md p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={dim.name}
              onChange={(e) => renameDimension(i, e.target.value)}
              placeholder={`维度名，如 ${['辣度', '重量', '骨型'][i] ?? '口味'}`}
              className={`${inputCls} flex-1 min-w-0 sm:flex-none sm:w-36`}
            />
            <div className="ml-auto flex items-center gap-1">
              {dimensions.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => moveDimension(i, i - 1)}
                    disabled={i === 0}
                    className={iconBtnCls}
                    title="维度上移"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDimension(i, i + 1)}
                    disabled={i === dimensions.length - 1}
                    className={iconBtnCls}
                    title="维度下移"
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => removeDimension(i)}
                className="p-0.5 text-gray-400 hover:text-red-500"
                title="删除该维度"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {dim.values.map((v, vi) => {
              const isEditing = editing?.dim === i && editing.value === v
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-0.5 bg-brand-50 text-brand-700 text-xs pl-1 pr-1.5 py-0.5 rounded-full"
                >
                  <button
                    type="button"
                    onClick={() => moveValue(i, vi, vi - 1)}
                    disabled={vi === 0}
                    className={iconBtnCls}
                    title="前移"
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </button>
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editing.draft}
                      onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitRename()
                        } else if (e.key === 'Escape') {
                          setEditing(null)
                        }
                      }}
                      onBlur={commitRename}
                      className="bg-white border border-brand-300 rounded px-1 py-0.5 text-xs text-gray-800 w-20 focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startRename(i, v)}
                      className="px-1 py-0.5 hover:underline"
                      title="点击改名"
                    >
                      {v}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => moveValue(i, vi, vi + 1)}
                    disabled={vi === dim.values.length - 1}
                    className={iconBtnCls}
                    title="后移"
                  >
                    <ChevronRight className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeValue(i, v)}
                    className="p-0.5 text-brand-400 hover:text-red-500"
                    title="删除该规格值"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )
            })}
            <input
              value={valueDrafts[i] ?? ''}
              onChange={(e) => {
                const drafts = [...valueDrafts]
                drafts[i] = e.target.value
                setValueDrafts(drafts)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addValue(i)
                }
              }}
              onBlur={() => addValue(i, false)}
              placeholder="输入规格值后回车"
              className={`${inputCls} w-full sm:w-36`}
            />
          </div>
        </div>
      ))}

      {/* 组合表格 */}
      {skuRows.length > 0 && (
        <div className="space-y-2">
          {hasPlaceholder && (
            <p className="text-xs text-amber-600">
              有维度还没有规格值（表中显示为 —），请为每个维度至少添加一个规格值后再保存。
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-500">批量填充</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={batchPrice}
              onChange={(e) => setBatchPrice(e.target.value)}
              placeholder="价格(元)"
              className={`${inputCls} w-24 flex-1 min-w-[5rem] sm:flex-none`}
            />
            <input
              type="number"
              min="0"
              value={batchStock}
              onChange={(e) => setBatchStock(e.target.value)}
              placeholder="库存"
              className={`${inputCls} w-20 flex-1 min-w-[4.5rem] sm:flex-none`}
            />
            <button
              type="button"
              onClick={batchFill}
              className="text-brand-600 hover:text-brand-700 font-medium"
            >
              应用到全部
            </button>
          </div>
          <div className="hidden md:block overflow-x-auto border border-gray-200 rounded-md bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  {dimensions.map((d, i) => (
                    <th key={i} className="text-left px-3 py-2 whitespace-nowrap">
                      {d.name || `维度${i + 1}`}
                    </th>
                  ))}
                  <th className="text-left px-3 py-2">价格(元) *</th>
                  <th className="text-left px-3 py-2">原价(元)</th>
                  <th className="text-left px-3 py-2">库存</th>
                </tr>
              </thead>
              <tbody>
                {skuRows.map((row, idx) => (
                  <tr key={rowKey(row.specValues)} className="border-t border-gray-100">
                    {row.specValues.map((v, vi) => (
                      <td key={vi} className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                        {showValue(v)}
                      </td>
                    ))}
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={row.price}
                        onChange={(e) => updateRow(idx, { price: e.target.value })}
                        placeholder="必填"
                        className={`${inputCls} w-24`}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={row.originalPrice}
                        onChange={(e) => updateRow(idx, { originalPrice: e.target.value })}
                        placeholder="可选"
                        className={`${inputCls} w-24`}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <input
                        type="number"
                        min="0"
                        value={row.stock}
                        onChange={(e) => updateRow(idx, { stock: Number(e.target.value) })}
                        className={`${inputCls} w-20`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* <md：组合卡片列表（触控友好） */}
          <div className="md:hidden space-y-2">
            {skuRows.map((row, idx) => (
              <div key={rowKey(row.specValues)} className="border border-gray-200 rounded-md bg-white p-3">
                <p className="text-sm font-medium text-gray-800 mb-2">
                  {row.specValues.map(showValue).join(' / ')}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="block text-xs text-gray-500 mb-1">价格(元) *</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.price}
                      onChange={(e) => updateRow(idx, { price: e.target.value })}
                      placeholder="必填"
                      className={`${inputCls} w-full py-2`}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs text-gray-500 mb-1">原价(元)</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.originalPrice}
                      onChange={(e) => updateRow(idx, { originalPrice: e.target.value })}
                      placeholder="可选"
                      className={`${inputCls} w-full py-2`}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs text-gray-500 mb-1">库存</span>
                    <input
                      type="number"
                      min="0"
                      value={row.stock}
                      onChange={(e) => updateRow(idx, { stock: Number(e.target.value) })}
                      className={`${inputCls} w-full py-2`}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-400">
            共 {skuRows.length} 个规格组合。商品售价将自动取最低规格价，总库存为各规格之和。
          </p>
        </div>
      )}
    </div>
  )
}
