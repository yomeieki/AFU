import { useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import type { SpecDimension } from '../types'
import {
  addDimension as addDimensionLogic,
  addValue as addValueLogic,
  moveDimension as moveDimensionLogic,
  moveValue as moveValueLogic,
  removeDimension as removeDimensionLogic,
  removeValue as removeValueLogic,
  renameDimension as renameDimensionLogic,
  renameValue as renameValueLogic,
  rowKey,
  type DimensionTemplate,
  type SkuRow,
  type SpecEditorState,
} from './specLogic'
import { confirmDialog } from './ui/ConfirmDialog'
import { toast } from './ui/Toast'

export type { SkuRow }

interface Props {
  dimensions: SpecDimension[]
  skuRows: SkuRow[]
  onChange: (dimensions: SpecDimension[], skuRows: SkuRow[]) => void
}

const inputCls =
  'border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const iconBtnCls = 'p-0.5 rounded text-gray-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-gray-400'

interface ValueEditing {
  dimIndex: number
  oldValue: string
  draft: string
}

export default function SpecEditor({ dimensions, skuRows, onChange }: Props) {
  // 每个维度一个「新值」输入框的临时文本
  const [valueDrafts, setValueDrafts] = useState<string[]>([])
  // 正在改名的规格值
  const [editingValue, setEditingValue] = useState<ValueEditing | null>(null)
  // 新增维度、还没有值时的旧行快照，用于给该维度补第一个值时找回价格/库存
  const [template, setTemplate] = useState<DimensionTemplate | null>(null)
  const [batchPrice, setBatchPrice] = useState('')
  const [batchStock, setBatchStock] = useState('')

  const currentState = (): SpecEditorState => ({ dimensions, rows: skuRows, template })

  const commit = (state: SpecEditorState) => {
    setTemplate(state.template)
    onChange(state.dimensions, state.rows)
  }

  // ---------- 维度 ----------

  const handleAddDimension = async () => {
    const state = currentState()
    if (state.dimensions.length >= 3) return
    const hasSavedRows = state.rows.some((r) => r.id !== undefined)
    if (hasSavedRows) {
      const ok = await confirmDialog({
        title: '新增规格维度',
        content:
          '新增维度后，原有规格组合会按当前价格/库存复制到新组合上，请保存前逐行核对。\n' +
          '保存后原有规格会重新创建，顾客购物车里选了这些规格的商品会被清空。确定新增？',
      })
      if (!ok) return
    }
    commit(addDimensionLogic(state, '').state)
  }

  const handleRemoveDimension = async (i: number) => {
    const state = currentState()
    const dim = state.dimensions[i]
    const hasSavedRows = state.rows.some((r) => r.id !== undefined)
    if (dim.values.length > 0 && hasSavedRows) {
      const isLast = state.dimensions.length === 1
      const content = isLast
        ? '删除最后一个维度后，商品会变成单规格。保存后所有规格都会被删除并重新创建，' +
          '顾客购物车里选了这些规格的商品会一起清空。确定删除？'
        : `删除维度「${dim.name || `维度${i + 1}`}」后，现有组合会按值合并，每组价格/库存取合并前第一行的，请保存前逐行核对。\n` +
          '保存后对应规格会被删除并重新创建，顾客购物车里选了这些规格的商品会一起清空。确定删除？'
      const ok = await confirmDialog({ title: '删除规格维度', content, danger: true })
      if (!ok) return
    }
    setEditingValue(null)
    commit(removeDimensionLogic(state, i).state)
  }

  const handleRenameDimension = (i: number, name: string) => {
    onChange(renameDimensionLogic(currentState(), i, name).dimensions, skuRows)
  }

  const handleMoveDimension = (i: number, direction: 'prev' | 'next') => {
    setEditingValue(null)
    commit(moveDimensionLogic(currentState(), i, direction).state)
  }

  // ---------- 规格值 ----------

  const handleAddValue = (i: number, notify: boolean) => {
    const raw = valueDrafts[i] ?? ''
    if (!raw.trim()) return
    const result = addValueLogic(currentState(), i, raw)
    if ('error' in result) {
      if (notify) toast.error(result.error)
      return
    }
    setValueDrafts((prev) => {
      const next = [...prev]
      next[i] = ''
      return next
    })
    commit(result.state)
  }

  const handleRemoveValue = async (i: number, v: string) => {
    const result = removeValueLogic(currentState(), i, v)
    if (result.affectedSavedRows > 0) {
      const ok = await confirmDialog({
        title: '删除规格值',
        content:
          `删除规格值「${v}」后，保存时会删除 ${result.affectedSavedRows} 个已保存的规格，` +
          '顾客购物车里选了这个规格的商品会一起清空。确定删除？',
        danger: true,
      })
      if (!ok) return
    }
    if (editingValue?.dimIndex === i && editingValue.oldValue === v) setEditingValue(null)
    commit(result.state)
  }

  const handleMoveValue = (i: number, valueIndex: number, direction: 'prev' | 'next') => {
    commit(moveValueLogic(currentState(), i, valueIndex, direction).state)
  }

  const startRename = (i: number, v: string) => setEditingValue({ dimIndex: i, oldValue: v, draft: v })

  const commitRenameValue = (notify: boolean) => {
    if (!editingValue) return
    const { dimIndex, oldValue } = editingValue
    const result = renameValueLogic(currentState(), dimIndex, oldValue, editingValue.draft)
    if ('error' in result) {
      if (notify) toast.error(result.error)
      return
    }
    setEditingValue(null)
    commit(result.state)
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

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50/50">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">商品规格</span>
        {dimensions.length < 3 && (
          <button
            type="button"
            onClick={handleAddDimension}
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
              onChange={(e) => handleRenameDimension(i, e.target.value)}
              placeholder={`维度名，如 ${['辣度', '重量', '骨型'][i] ?? '口味'}`}
              className={`${inputCls} flex-1 min-w-0 sm:flex-none sm:w-36`}
            />
            <div className="ml-auto flex items-center gap-1">
              {dimensions.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={() => handleMoveDimension(i, 'prev')}
                    disabled={i === 0}
                    className={iconBtnCls}
                    title="维度上移"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveDimension(i, 'next')}
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
                onClick={() => handleRemoveDimension(i)}
                className="p-0.5 text-gray-400 hover:text-red-500"
                title="删除该维度"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {dim.values.map((v, vi) => {
              const isEditing = editingValue?.dimIndex === i && editingValue.oldValue === v
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-0.5 bg-brand-50 text-brand-700 text-xs pl-1 pr-1.5 py-0.5 rounded-full"
                >
                  <button
                    type="button"
                    onClick={() => handleMoveValue(i, vi, 'prev')}
                    disabled={vi === 0}
                    className={iconBtnCls}
                    title="前移"
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </button>
                  {isEditing ? (
                    <input
                      autoFocus
                      value={editingValue.draft}
                      onChange={(e) => setEditingValue({ ...editingValue, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitRenameValue(true)
                        } else if (e.key === 'Escape') {
                          setEditingValue(null)
                        }
                      }}
                      onBlur={() => commitRenameValue(false)}
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
                    onClick={() => handleMoveValue(i, vi, 'next')}
                    disabled={vi === dim.values.length - 1}
                    className={iconBtnCls}
                    title="后移"
                  >
                    <ChevronRight className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveValue(i, v)}
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
                setValueDrafts((prev) => {
                  const next = [...prev]
                  next[i] = e.target.value
                  return next
                })
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleAddValue(i, true)
                }
              }}
              onBlur={() => handleAddValue(i, false)}
              placeholder="输入规格值后回车"
              className={`${inputCls} w-full sm:w-36`}
            />
          </div>
        </div>
      ))}

      {/* 组合表格 */}
      {skuRows.length > 0 && (
        <div className="space-y-2">
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

          {/* <md：组合卡片列表（触控友好） */}
          <div className="md:hidden space-y-2">
            {skuRows.map((row, idx) => (
              <div key={rowKey(row.specValues)} className="border border-gray-200 rounded-md bg-white p-3">
                <p className="text-sm font-medium text-gray-800 mb-2">{row.specValues.join(' / ')}</p>
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
