import { useState } from 'react'
import { Plus, X } from 'lucide-react'
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

/** 维度值笛卡尔积；维度为空或任一维度无值时返回空 */
function cartesian(dims: SpecDimension[]): string[][] {
  if (dims.length === 0 || dims.some((d) => d.values.length === 0)) return []
  return dims.reduce<string[][]>(
    (acc, d) => acc.flatMap((combo) => d.values.map((v) => [...combo, v])),
    [[]]
  )
}

const inputCls =
  'border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'

export default function SpecEditor({ dimensions, skuRows, onChange }: Props) {
  // 每个维度一个「新值」输入框的临时文本
  const [valueDrafts, setValueDrafts] = useState<string[]>([])
  const [batchPrice, setBatchPrice] = useState('')
  const [batchStock, setBatchStock] = useState('')

  /** 维度变化后重算组合行，按 specText 匹配保留已填的价格/库存/id */
  const applyDims = (dims: SpecDimension[]) => {
    const old = new Map(skuRows.map((r) => [r.specValues.join('/'), r]))
    const rows = cartesian(dims).map((values) => {
      const kept = old.get(values.join('/'))
      return kept ?? { specValues: values, price: '', originalPrice: '', stock: 0 }
    })
    onChange(dims, rows)
  }

  const addDimension = () => {
    if (dimensions.length >= 3) return
    applyDims([...dimensions, { name: '', values: [] }])
  }

  const removeDimension = (i: number) => {
    applyDims(dimensions.filter((_, idx) => idx !== i))
  }

  const renameDimension = (i: number, name: string) => {
    // 改名不影响组合行，直接透传当前行
    onChange(
      dimensions.map((d, idx) => (idx === i ? { ...d, name } : d)),
      skuRows
    )
  }

  const addValue = (i: number) => {
    const v = (valueDrafts[i] ?? '').trim()
    if (!v || dimensions[i].values.includes(v)) return
    const drafts = [...valueDrafts]
    drafts[i] = ''
    setValueDrafts(drafts)
    applyDims(dimensions.map((d, idx) => (idx === i ? { ...d, values: [...d.values, v] } : d)))
  }

  const removeValue = (i: number, v: string) => {
    applyDims(
      dimensions.map((d, idx) => (idx === i ? { ...d, values: d.values.filter((x) => x !== v) } : d))
    )
  }

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

      {dimensions.length === 0 && (
        <p className="text-xs text-gray-400">
          未配置规格：商品按下方「售价/库存」单规格出售。如需多规格（如 辣度、重量、去骨/带骨），点击右上角添加。
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
              className={`${inputCls} w-36`}
            />
            <button
              type="button"
              onClick={() => removeDimension(i)}
              className="ml-auto text-gray-400 hover:text-red-500"
              title="删除该维度"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {dim.values.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-1 bg-brand-50 text-brand-700 text-xs px-2 py-1 rounded-full"
              >
                {v}
                <button
                  type="button"
                  onClick={() => removeValue(i, v)}
                  className="hover:text-red-500"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
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
              onBlur={() => addValue(i)}
              placeholder="输入规格值后回车"
              className={`${inputCls} w-36`}
            />
          </div>
        </div>
      ))}

      {/* 组合表格 */}
      {skuRows.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">批量填充</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={batchPrice}
              onChange={(e) => setBatchPrice(e.target.value)}
              placeholder="价格(元)"
              className={`${inputCls} w-24`}
            />
            <input
              type="number"
              min="0"
              value={batchStock}
              onChange={(e) => setBatchStock(e.target.value)}
              placeholder="库存"
              className={`${inputCls} w-20`}
            />
            <button
              type="button"
              onClick={batchFill}
              className="text-brand-600 hover:text-brand-700 font-medium"
            >
              应用到全部
            </button>
          </div>
          <div className="overflow-x-auto border border-gray-200 rounded-md bg-white">
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
                  <tr key={row.specValues.join('/')} className="border-t border-gray-100">
                    {row.specValues.map((v, vi) => (
                      <td key={vi} className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                        {v}
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
          <p className="text-xs text-gray-400">
            共 {skuRows.length} 个规格组合。商品售价将自动取最低规格价，总库存为各规格之和。
          </p>
        </div>
      )}
    </div>
  )
}
