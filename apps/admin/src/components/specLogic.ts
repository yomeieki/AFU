/**
 * 商品规格编辑的纯逻辑层：不依赖 React / DOM，只做「维度 + 组合行」的状态变换。
 * 所有行匹配一律按 specValues 数组内容做 key（JSON.stringify），不用 join('/')
 * 拼接文本 —— 不同维度值拼接后可能产生相同字符串（如 ['a/b','c'] 与 ['a','b/c']），
 * 按文本匹配会互相覆盖，按内容匹配才是唯一的。
 */

/** 表单态 SKU 行：价格以「元」字符串保存，提交时统一转分 */
export interface SkuRow {
  id?: number
  specValues: string[]
  price: string
  originalPrice: string
  stock: number
}

export interface SpecDimension {
  name: string
  values: string[]
}

/** 新增维度尚未有值期间保留的「旧行快照」，用于给该维度补第一个值时找回价格/库存默认值 */
export interface DimensionTemplate {
  /** 快照对应的新维度在 dimensions 数组中的下标 */
  dimIndex: number
  /** 新增该维度之前的行（含 id） */
  rows: SkuRow[]
}

export interface SpecEditorState {
  dimensions: SpecDimension[]
  rows: SkuRow[]
  template: DimensionTemplate | null
}

export type MutationResult = { state: SpecEditorState } | { error: string }

const MAX_DIMENSIONS = 3

/** 去首尾空格，规格值/维度名统一按此规范化后比较 */
export function normalizeValue(v: string): string {
  return v.trim()
}

/** 行内容匹配 key；不能用 join('/')，理由见文件头注释 */
export function rowKey(values: string[]): string {
  return JSON.stringify(values)
}

/** 维度值笛卡尔积；维度为空或任一维度无值时返回空（该维度还没配好，组合表暂不显示） */
export function cartesian(dims: SpecDimension[]): string[][] {
  if (dims.length === 0 || dims.some((d) => d.values.length === 0)) return []
  return dims.reduce<string[][]>(
    (acc, d) => acc.flatMap((combo) => d.values.map((v) => [...combo, v])),
    [[]]
  )
}

export function createState(dimensions: SpecDimension[], rows: SkuRow[]): SpecEditorState {
  return { dimensions, rows, template: null }
}

/**
 * 按当前 dimensions 重新计算组合行：
 * 1. 优先用 rows 里内容完全匹配的行（保留 id/价格/库存）；
 * 2. 找不到时，如果提供了 template（新增维度还没值时的旧行快照），
 *    用去掉 template.dimIndex 位置后的值去快照里找模板行，复制价格/库存（不带 id）；
 * 3. 都找不到则给空白默认值。
 */
function rebuildRows(dims: SpecDimension[], rows: SkuRow[], template: DimensionTemplate | null): SkuRow[] {
  const byKey = new Map(rows.map((r) => [rowKey(r.specValues), r]))
  const templateByKey = template ? new Map(template.rows.map((r) => [rowKey(r.specValues), r])) : null
  return cartesian(dims).map((values) => {
    const exact = byKey.get(rowKey(values))
    if (exact) return exact
    if (templateByKey && template) {
      const trimmed = values.filter((_, i) => i !== template.dimIndex)
      const fromTemplate = templateByKey.get(rowKey(trimmed))
      if (fromTemplate) {
        return {
          specValues: values,
          price: fromTemplate.price,
          originalPrice: fromTemplate.originalPrice,
          stock: fromTemplate.stock,
        }
      }
    }
    return { specValues: values, price: '', originalPrice: '', stock: 0 }
  })
}

/** 维度改名：不影响组合行 */
export function renameDimension(state: SpecEditorState, dimIndex: number, name: string): SpecEditorState {
  return {
    ...state,
    dimensions: state.dimensions.map((d, i) => (i === dimIndex ? { ...d, name } : d)),
  }
}

/** 新增维度（无值），保留旧行快照供后续补值时找回默认价格/库存 */
export function addDimension(state: SpecEditorState, name = ''): { state: SpecEditorState } {
  if (state.dimensions.length >= MAX_DIMENSIONS) return { state }
  const dimensions = [...state.dimensions, { name, values: [] }]
  const rows = rebuildRows(dimensions, state.rows, null)
  return {
    state: {
      dimensions,
      rows,
      template: { dimIndex: dimensions.length - 1, rows: state.rows },
    },
  }
}

/**
 * 删除维度：
 * - 删到只剩 0 个维度 → 行清空（无规格商品）。
 * - 删的是「刚新增还没有值」的维度，且快照仍指向它 → 直接恢复快照（不合并、不丢 id）。
 * - 否则按当前行内容合并：同一份「去掉该维度值」的组合取当前行顺序中的第一行，
 *   价格/库存取自该行，合并后的行一律不带 id（对应 SKU 保存时会重建，购物车按需清空）。
 * 返回 mergedFrom/mergedTo 供 UI 生成确认文案。
 */
export function removeDimension(
  state: SpecEditorState,
  dimIndex: number
): { state: SpecEditorState; mergedFrom: number; mergedTo: number } {
  const dim = state.dimensions[dimIndex]
  const dimensions = state.dimensions.filter((_, i) => i !== dimIndex)

  if (dimensions.length === 0) {
    return { state: { dimensions: [], rows: [], template: null }, mergedFrom: state.rows.length, mergedTo: 0 }
  }

  if (dim.values.length === 0) {
    if (state.template && state.template.dimIndex === dimIndex) {
      const rows = state.template.rows
      return { state: { dimensions, rows, template: null }, mergedFrom: rows.length, mergedTo: rows.length }
    }
    // 没有可用快照：按当前（通常为空）行重建，不合并
    const rows = rebuildRows(
      dimensions,
      state.rows.map((r) => ({ ...r, specValues: r.specValues.filter((_, i) => i !== dimIndex) })),
      null
    )
    return { state: { dimensions, rows, template: null }, mergedFrom: state.rows.length, mergedTo: rows.length }
  }

  const order: string[] = []
  const groups = new Map<string, SkuRow[]>()
  for (const r of state.rows) {
    const trimmed = r.specValues.filter((_, i) => i !== dimIndex)
    const k = rowKey(trimmed)
    if (!groups.has(k)) {
      groups.set(k, [])
      order.push(k)
    }
    groups.get(k)!.push(r)
  }
  const rows = order.map((k) => {
    const group = groups.get(k)!
    const first = group[0]
    return {
      specValues: first.specValues.filter((_, i) => i !== dimIndex),
      price: first.price,
      originalPrice: first.originalPrice,
      stock: first.stock,
    }
  })
  return {
    state: { dimensions, rows, template: null },
    mergedFrom: state.rows.length,
    mergedTo: rows.length,
  }
}

type Direction = 'prev' | 'next'

/** 维度排序：交换相邻两个维度，行的 specValues 按新维度顺序重排（内容不变，只调位置） */
export function moveDimension(state: SpecEditorState, dimIndex: number, direction: Direction): { state: SpecEditorState } {
  const swapWith = direction === 'prev' ? dimIndex - 1 : dimIndex + 1
  if (swapWith < 0 || swapWith >= state.dimensions.length) return { state }

  const dimensions = [...state.dimensions]
  ;[dimensions[dimIndex], dimensions[swapWith]] = [dimensions[swapWith], dimensions[dimIndex]]

  // 新顺序里第 k 个维度，是原顺序里的第几个 —— 按对象引用定位（swap 后引用没变）
  const oldIndexOfNew = dimensions.map((d) => state.dimensions.indexOf(d))
  const permutedRows = state.rows.map((r) => ({
    ...r,
    specValues: oldIndexOfNew.map((oi) => r.specValues[oi]),
  }))

  // 维度顺序变了，旧快照的 dimIndex 语义失效，直接丢弃
  const rows = rebuildRows(dimensions, permutedRows, null)
  return { state: { dimensions, rows, template: null } }
}

/** 规格值排序：交换维度内相邻两个值，组合表按新的笛卡尔积顺序重排 */
export function moveValue(state: SpecEditorState, dimIndex: number, valueIndex: number, direction: Direction): { state: SpecEditorState } {
  const dim = state.dimensions[dimIndex]
  const swapWith = direction === 'prev' ? valueIndex - 1 : valueIndex + 1
  if (swapWith < 0 || swapWith >= dim.values.length) return { state }

  const values = [...dim.values]
  ;[values[valueIndex], values[swapWith]] = [values[swapWith], values[valueIndex]]
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values } : d))
  const rows = rebuildRows(dimensions, state.rows, state.template)
  return { state: { ...state, dimensions, rows } }
}

/** 新增规格值：去首尾空格后查重，重复或为空都拒绝 */
export function addValue(state: SpecEditorState, dimIndex: number, rawValue: string): MutationResult {
  const value = normalizeValue(rawValue)
  if (!value) return { error: '规格值不能为空' }
  const dim = state.dimensions[dimIndex]
  if (dim.values.includes(value)) return { error: `规格值「${value}」已存在` }

  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values: [...d.values, value] } : d))
  const rows = rebuildRows(dimensions, state.rows, state.template)
  return { state: { ...state, dimensions, rows } }
}

/**
 * 规格值改名：同时更新维度定义与所有含该值的行，行对象其它字段（含 id）原样保留，
 * 不经过笛卡尔积重建，因此其余行完全不受影响、顺序不变。
 */
export function renameValue(state: SpecEditorState, dimIndex: number, oldValue: string, rawNewValue: string): MutationResult {
  const newValue = normalizeValue(rawNewValue)
  if (!newValue) return { error: '规格值不能为空' }
  const dim = state.dimensions[dimIndex]
  if (newValue === oldValue) return { state } // 无变化
  if (dim.values.includes(newValue)) return { error: `规格值「${newValue}」已存在` }

  const dimensions = state.dimensions.map((d, i) =>
    i === dimIndex ? { ...d, values: d.values.map((v) => (v === oldValue ? newValue : v)) } : d
  )
  const rows = state.rows.map((r) =>
    r.specValues[dimIndex] === oldValue
      ? { ...r, specValues: r.specValues.map((v, i) => (i === dimIndex ? newValue : v)) }
      : r
  )
  return { state: { ...state, dimensions, rows } }
}

/** 删除规格值：返回受影响的「已保存」（带 id）行数，供 UI 生成确认文案 */
export function removeValue(state: SpecEditorState, dimIndex: number, value: string): { state: SpecEditorState; affectedSavedRows: number } {
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values: d.values.filter((v) => v !== value) } : d))
  const affectedSavedRows = state.rows.filter((r) => r.specValues[dimIndex] === value && r.id !== undefined).length
  const remainingRows = state.rows.filter((r) => r.specValues[dimIndex] !== value)
  const rows = rebuildRows(dimensions, remainingRows, state.template)
  return { state: { ...state, dimensions, rows }, affectedSavedRows }
}

/**
 * 保存前校验：维度值为空/重复/空白、组合行价格缺失或非正数。
 * 无规格（dims 为空）时不做检查，交给上层的单规格校验。
 */
export function validateSpecForm(dims: SpecDimension[], rows: SkuRow[]): string | null {
  if (dims.length === 0) return null

  for (const d of dims) {
    const label = d.name.trim() || '未命名维度'
    if (d.values.length === 0) return `请为规格维度「${label}」至少添加一个规格值`
    const seen = new Set<string>()
    for (const raw of d.values) {
      const v = normalizeValue(raw)
      if (!v) return `规格维度「${label}」存在空白的规格值`
      if (seen.has(v)) return `规格维度「${label}」存在重复的规格值「${v}」`
      seen.add(v)
    }
  }

  if (rows.length === 0) return '请为规格维度添加规格值'
  for (const r of rows) {
    if (!r.price || parseFloat(r.price) <= 0) return `规格「${r.specValues.join('/')}」价格必须大于 0`
  }
  return null
}
