import { useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, X } from 'lucide-react'
import type { SpecDimension } from '../types'
import {
  addDimension as addDimensionLogic,
  addValue as addValueLogic,
  confirmForAddDimension,
  confirmForRemoveDimension,
  confirmForRemoveValue,
  moveDimension as moveDimensionLogic,
  moveValue as moveValueLogic,
  removeDimension as removeDimensionLogic,
  removeValue as removeValueLogic,
  renameDimension as renameDimensionLogic,
  renameValue as renameValueLogic,
  rowKey,
  PLACEHOLDER,
  type DimensionTemplate,
  type RowDefaults,
  type SkuRow,
  type SpecEditorState,
} from './specLogic'
import * as msg from './specMessages'
import { confirmDialog } from './ui/ConfirmDialog'
import { toast } from './ui/Toast'

export type { SkuRow }

interface Props {
  dimensions: SpecDimension[]
  skuRows: SkuRow[]
  onChange: (dimensions: SpecDimension[], skuRows: SkuRow[]) => void
  /** 打开编辑时自动整理产生的提示（见 Products.tsx openEdit），显示在标题下方 */
  notice?: string | null
  /** 无规格商品第一次加规格项时，占位行带入的默认售价/原价/库存 */
  defaults?: RowDefaults
}

const inputCls =
  'border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const iconBtnCls = 'p-0.5 rounded text-gray-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-gray-400'

interface ValueEditing {
  dimIndex: number
  oldValue: string
  draft: string
}

/**
 * Esc 取消改名：不能只调用 React 合成事件的 stopPropagation。项目里的 Modal
 * （编辑商品弹窗）在 document 上单独注册了原生 keydown 监听来处理 Esc 关闭，
 * 那个监听器与 React 的事件委托是两条独立的原生事件路径，只有 stopPropagation
 * 不保证能拦住它；这里额外调用 nativeEvent.stopImmediatePropagation() 从源头
 * 掐断，确保编辑商品弹窗不会被规格值的 Esc 连带关掉。
 */
export function handleEscapeKey(e: {
  preventDefault: () => void
  stopPropagation: () => void
  nativeEvent?: { stopImmediatePropagation?: () => void }
}): void {
  e.preventDefault()
  e.stopPropagation()
  e.nativeEvent?.stopImmediatePropagation?.()
}

export default function SpecEditor({ dimensions, skuRows, onChange, notice, defaults }: Props) {
  // 每个维度一个「新选项」输入框的临时文本
  const [valueDrafts, setValueDrafts] = useState<string[]>([])
  // 正在改名的规格值
  const [editingValue, setEditingValue] = useState<ValueEditing | null>(null)
  // 给「当前无值的维度」加第一个值时的快照，供该维度后续再加值时找回默认价格/库存；
  // 只在编辑器内存活，保存或关闭编辑器（组件卸载）时随组件状态一起消失
  const [template, setTemplate] = useState<DimensionTemplate | null>(null)
  const [batchPrice, setBatchPrice] = useState('')
  const [batchStock, setBatchStock] = useState('')
  // 改名输入框「回车已成功提交」后，紧跟着的 onBlur 不再二次提交/二次提示（R7）
  const renameSettledRef = useRef(false)

  const currentState = (): SpecEditorState => ({ dimensions, rows: skuRows, template })

  const commit = (state: SpecEditorState) => {
    setTemplate(state.template)
    onChange(state.dimensions, state.rows)
  }

  // ---------- 规格项 ----------

  const handleAddDimension = async () => {
    const confirm = confirmForAddDimension(currentState())
    if (confirm && !(await confirmDialog(confirm))) return
    // 确认期间数据可能已变化，执行前重新取最新状态
    const state = currentState()
    if (state.dimensions.length >= 3) return
    commit(addDimensionLogic(state, '', defaults).state)
  }

  const handleRemoveDimension = async (i: number) => {
    const confirm = confirmForRemoveDimension(currentState(), i)
    if (confirm && !(await confirmDialog(confirm))) return
    setEditingValue(null)
    // 确认期间数据可能已变化，执行前重新取最新状态
    const state = currentState()
    commit(removeDimensionLogic(state, i).state)
  }

  const handleRenameDimension = (i: number, name: string) => {
    onChange(renameDimensionLogic(currentState(), i, name).dimensions, skuRows)
  }

  const handleMoveDimension = (i: number, direction: 'prev' | 'next') => {
    setEditingValue(null)
    commit(moveDimensionLogic(currentState(), i, direction).state)
  }

  // ---------- 选项 ----------

  const handleAddValue = (i: number) => {
    const raw = valueDrafts[i] ?? ''
    const clearDraft = () => {
      setValueDrafts((prev) => {
        const next = [...prev]
        next[i] = ''
        return next
      })
    }
    if (!raw.trim()) {
      clearDraft()
      return
    }
    const result = addValueLogic(currentState(), i, raw)
    if ('error' in result) {
      toast.error(result.error)
      clearDraft()
      return
    }
    clearDraft()
    commit(result.state)
  }

  const handleRemoveValue = async (i: number, v: string) => {
    const confirm = confirmForRemoveValue(currentState(), i, v)
    if (confirm && !(await confirmDialog(confirm))) return
    if (editingValue?.dimIndex === i && editingValue.oldValue === v) setEditingValue(null)
    // 确认期间数据可能已变化，执行前重新取最新状态
    const state = currentState()
    commit(removeValueLogic(state, i, v).state)
  }

  const handleMoveValue = (i: number, valueIndex: number, direction: 'prev' | 'next') => {
    commit(moveValueLogic(currentState(), i, valueIndex, direction).state)
  }

  const startRename = (i: number, v: string) => {
    renameSettledRef.current = false
    setEditingValue({ dimIndex: i, oldValue: v, draft: v })
  }

  /**
   * source='enter'：回车确认；source='blur'：失焦确认。两者都必须给出可见提示、
   * 都要让输入框回到确定的状态（不能停在「既非编辑态又没提示」的卡住状态，R7）：
   * - 成功：退出编辑态，标记本次改名已结束（避免紧跟着的 blur 二次提交/二次提示）。
   * - 为空：toast 提示 + 退出编辑态、恢复原名。
   * - 重复：toast 提示；回车时保持编辑态、焦点留在框内方便直接改；失焦时退出编辑态、恢复原名。
   */
  const commitRenameValue = (source: 'enter' | 'blur') => {
    if (!editingValue) return
    if (source === 'blur' && renameSettledRef.current) return
    const { dimIndex, oldValue } = editingValue
    const result = renameValueLogic(currentState(), dimIndex, oldValue, editingValue.draft)
    if ('error' in result) {
      toast.error(result.error)
      // 改成空白：不管回车还是失焦都直接恢复原名；改成重复的名字：回车保持编辑态方便
      // 直接改，失焦才恢复原名（避免用户还没看清提示，输入框就已经跳走）。
      if (result.error === msg.E3_EMPTY_RENAME || source === 'blur') setEditingValue(null)
      return
    }
    renameSettledRef.current = true
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
      skuRows.map((r) =>
        r.specValues.includes(PLACEHOLDER)
          ? r
          : {
              ...r,
              ...(batchPrice !== '' ? { price: batchPrice } : {}),
              ...(batchStock !== '' ? { stock: Number(batchStock) } : {}),
            }
      )
    )
  }

  // 规格项还没配好选项时，对应的组合行只是内部占位，不在表格/卡片里展示；
  // 用原始下标配对，updateRow 仍按 skuRows 的真实下标写入。
  const visibleEntries = skuRows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => !row.specValues.includes(PLACEHOLDER))

  return (
    <div className="border border-gray-200 rounded-lg p-3 space-y-3 bg-gray-50/50">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">{msg.T1_TITLE}</span>
        {dimensions.length < 3 && (
          <button
            type="button"
            onClick={handleAddDimension}
            className="inline-flex items-center gap-1 text-sm text-brand-600 hover:text-brand-700"
          >
            <Plus className="w-4 h-4" />
            {msg.T2_ADD_DIMENSION}
          </button>
        )}
      </div>

      {notice && <p className="text-xs text-amber-600 whitespace-pre-line">{notice}</p>}

      {dimensions.length === 0 ? (
        <p className="text-xs text-gray-400">{msg.T3_EMPTY_HINT}</p>
      ) : (
        <p className="text-xs text-gray-400">{msg.T4_HAS_DIM_HINT}</p>
      )}

      {/* 规格项编辑 */}
      {dimensions.map((dim, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-md p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <input
              value={dim.name}
              onChange={(e) => handleRenameDimension(i, e.target.value)}
              placeholder={msg.dimNamePlaceholder(i)}
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
                    title={msg.T6_MOVE_UP}
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveDimension(i, 'next')}
                    disabled={i === dimensions.length - 1}
                    className={iconBtnCls}
                    title={msg.T6_MOVE_DOWN}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => handleRemoveDimension(i)}
                className="p-0.5 text-gray-400 hover:text-red-500"
                title={msg.T6_REMOVE_DIM}
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
                    title={msg.T7_MOVE_PREV}
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
                          commitRenameValue('enter')
                        } else if (e.key === 'Escape') {
                          handleEscapeKey(e)
                          setEditingValue(null)
                        }
                      }}
                      onBlur={() => commitRenameValue('blur')}
                      className="bg-white border border-brand-300 rounded px-1 py-0.5 text-xs text-gray-800 w-20 focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startRename(i, v)}
                      className="px-1 py-0.5 hover:underline"
                      title={msg.T7_RENAME}
                    >
                      {v}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleMoveValue(i, vi, 'next')}
                    disabled={vi === dim.values.length - 1}
                    className={iconBtnCls}
                    title={msg.T7_MOVE_NEXT}
                  >
                    <ChevronRight className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveValue(i, v)}
                    className="p-0.5 text-brand-400 hover:text-red-500"
                    title={msg.T7_REMOVE_VALUE}
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
                  handleAddValue(i)
                }
              }}
              onBlur={() => handleAddValue(i)}
              placeholder={msg.T8_VALUE_PLACEHOLDER}
              className={`${inputCls} w-full sm:w-36`}
            />
          </div>
          {dim.values.length === 0 && <p className="text-xs text-amber-600">{msg.T9_NO_VALUES_HINT}</p>}
        </div>
      ))}

      {/* 组合表格 */}
      {visibleEntries.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-500">{msg.T10_BATCH_LABEL}</span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={batchPrice}
              onChange={(e) => setBatchPrice(e.target.value)}
              placeholder={msg.T10_BATCH_PRICE_PLACEHOLDER}
              className={`${inputCls} w-24 flex-1 min-w-[5rem] sm:flex-none`}
            />
            <input
              type="number"
              min="0"
              value={batchStock}
              onChange={(e) => setBatchStock(e.target.value)}
              placeholder={msg.T10_BATCH_STOCK_PLACEHOLDER}
              className={`${inputCls} w-20 flex-1 min-w-[4.5rem] sm:flex-none`}
            />
            <button
              type="button"
              onClick={batchFill}
              className="text-brand-600 hover:text-brand-700 font-medium"
            >
              {msg.T10_BATCH_BUTTON}
            </button>
          </div>
          <div className="hidden md:block overflow-x-auto border border-gray-200 rounded-md bg-white">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  {dimensions.map((d, i) => (
                    <th key={i} className="text-left px-3 py-2 whitespace-nowrap">
                      {d.name || msg.dimLabel(d.name, i)}
                    </th>
                  ))}
                  <th className="text-left px-3 py-2">{msg.T11_PRICE_HEADER}</th>
                  <th className="text-left px-3 py-2">{msg.T11_ORIGINAL_PRICE_HEADER}</th>
                  <th className="text-left px-3 py-2">{msg.T11_STOCK_HEADER}</th>
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map(({ row, idx }) => (
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
                        placeholder={msg.T11_PRICE_PLACEHOLDER}
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
                        placeholder={msg.T11_OPTIONAL_PLACEHOLDER}
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
            {visibleEntries.map(({ row, idx }) => (
              <div key={rowKey(row.specValues)} className="border border-gray-200 rounded-md bg-white p-3">
                <p className="text-sm font-medium text-gray-800 mb-2">{row.specValues.join(' / ')}</p>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block">
                    <span className="block text-xs text-gray-500 mb-1">{msg.T11_PRICE_HEADER}</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.price}
                      onChange={(e) => updateRow(idx, { price: e.target.value })}
                      placeholder={msg.T11_PRICE_PLACEHOLDER}
                      className={`${inputCls} w-full py-2`}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs text-gray-500 mb-1">{msg.T11_ORIGINAL_PRICE_HEADER}</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.originalPrice}
                      onChange={(e) => updateRow(idx, { originalPrice: e.target.value })}
                      placeholder={msg.T11_OPTIONAL_PLACEHOLDER}
                      className={`${inputCls} w-full py-2`}
                    />
                  </label>
                  <label className="block">
                    <span className="block text-xs text-gray-500 mb-1">{msg.T11_STOCK_HEADER}</span>
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
          <p className="text-xs text-gray-400">{msg.summaryText(visibleEntries.length)}</p>
        </div>
      )}
    </div>
  )
}
