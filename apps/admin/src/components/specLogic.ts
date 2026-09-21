/**
 * 商品规格编辑的纯逻辑层：不依赖 React / DOM，只做「维度 + 组合行」的状态变换。
 * 所有行匹配一律按 specValues 数组内容做 key（JSON.stringify），不用 join('/')
 * 拼接文本 —— 不同维度值拼接后可能产生相同字符串（如 ['a/b','c'] 与 ['a','b/c']），
 * 按文本匹配会互相覆盖，按内容匹配才是唯一的。
 *
 * 维度「还没有值」时不再把组合行整体清空：该位置用占位符 PLACEHOLDER 参与笛卡尔积，
 * 行（含 id、价格、库存）继续存在，只是那个位置暂时是占位符。这样在维度还没配好值
 * 期间对其它维度做改名/排序/增删，都是对这些真实存在的行做操作，不会出现「组合行」
 * 与「旧行快照」两份数据脱节的问题（第一轮复核 R2/R3）。
 */

/** 维度还没有任何值时，组合行里该位置用空串占位；保存前会被 validateSpecForm 拦下 */
export const PLACEHOLDER = ''

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

/**
 * 给「当前无值的维度」加第一个值时创建的快照：dimIndex 是该维度下标，
 * rows 是加值前的行（这些行在 dimIndex 位置都是 PLACEHOLDER）。
 * 后续再给同一个维度加值时，用它找回更早之前（该维度整体还是占位符时）的
 * 价格/库存默认值；对其它维度做任何操作，或 addDimension/moveDimension/
 * removeDimension，都会让它失效（置 null）。
 */
export interface DimensionTemplate {
  dimIndex: number
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

/**
 * 维度值笛卡尔积：只有 dims 为空（无规格商品）才返回空；
 * 某个维度暂无值时，该位置用 [PLACEHOLDER] 参与组合，行数不受影响。
 */
export function cartesian(dims: SpecDimension[]): string[][] {
  if (dims.length === 0) return []
  return dims.reduce<string[][]>((acc, d) => {
    const values = d.values.length ? d.values : [PLACEHOLDER]
    return acc.flatMap((combo) => values.map((v) => [...combo, v]))
  }, [[]])
}

export function createState(dimensions: SpecDimension[], rows: SkuRow[]): SpecEditorState {
  return { dimensions, rows, template: null }
}

/**
 * 按当前 dimensions 重新计算组合行：
 * 1. 优先用 rows 里内容完全匹配的行（保留 id/价格/库存）；
 * 2. 找不到、且传入了 template 时，把组合在 template.dimIndex 位置换成占位符
 *    去 template.rows 里找——命中说明这一行原本就是「该维度还没配值」时的行，
 *    复制其 price/originalPrice/stock（不带 id）；找不到就给空白默认值。
 * 3. 没有 template 时，找不到精确匹配一律空白默认值。
 */
function rebuildRows(dims: SpecDimension[], rows: SkuRow[], template: DimensionTemplate | null = null): SkuRow[] {
  const byKey = new Map(rows.map((r) => [rowKey(r.specValues), r]))
  const templateByKey = template ? new Map(template.rows.map((r) => [rowKey(r.specValues), r])) : null
  return cartesian(dims).map((values) => {
    const exact = byKey.get(rowKey(values))
    if (exact) return exact
    if (template && templateByKey) {
      const probe = values.map((v, i) => (i === template.dimIndex ? PLACEHOLDER : v))
      const hit = templateByKey.get(rowKey(probe))
      if (hit) {
        return { specValues: values, price: hit.price, originalPrice: hit.originalPrice, stock: hit.stock }
      }
    }
    return { specValues: values, price: '', originalPrice: '', stock: 0 }
  })
}

/** 维度改名：不影响组合行与 template */
export function renameDimension(state: SpecEditorState, dimIndex: number, name: string): SpecEditorState {
  return {
    ...state,
    dimensions: state.dimensions.map((d, i) => (i === dimIndex ? { ...d, name } : d)),
  }
}

/** 新增维度（无值）：现有行原样保留（含 id），只在末尾追加一个占位符位置；template 失效 */
export function addDimension(state: SpecEditorState, name = ''): { state: SpecEditorState } {
  if (state.dimensions.length >= MAX_DIMENSIONS) return { state }
  const dimensions = [...state.dimensions, { name, values: [] }]
  const expanded = state.rows.map((r) => ({ ...r, specValues: [...r.specValues, PLACEHOLDER] }))
  const rows = rebuildRows(dimensions, expanded, null)
  return { state: { dimensions, rows, template: null } }
}

/**
 * 删除维度：
 * - 删到只剩 0 个维度 → 行清空（无规格商品）。
 * - 被删维度还没有值（占位状态）→ 行只是去掉该位置，id/价格/库存原样保留，不合并。
 * - 被删维度已有值 → 按去掉该维度后的组合合并：同一份组合取当前行顺序里的第一行，
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
    const rows = state.rows.map((r) => ({ ...r, specValues: r.specValues.filter((_, i) => i !== dimIndex) }))
    return { state: { dimensions, rows, template: null }, mergedFrom: rows.length, mergedTo: rows.length }
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

  const rows = rebuildRows(dimensions, permutedRows, null)
  return { state: { dimensions, rows, template: null } }
}

/** 排完序后 template 是否还有效：只在这次操作的维度就是 template 所属维度时才保留 */
function keepTemplate(template: DimensionTemplate | null, dimIndex: number): DimensionTemplate | null {
  return template && template.dimIndex === dimIndex ? template : null
}

/** 规格值排序：交换维度内相邻两个值，组合表按新的笛卡尔积顺序重排 */
export function moveValue(state: SpecEditorState, dimIndex: number, valueIndex: number, direction: Direction): { state: SpecEditorState } {
  const dim = state.dimensions[dimIndex]
  const swapWith = direction === 'prev' ? valueIndex - 1 : valueIndex + 1
  if (swapWith < 0 || swapWith >= dim.values.length) return { state }

  const values = [...dim.values]
  ;[values[valueIndex], values[swapWith]] = [values[swapWith], values[valueIndex]]
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values } : d))
  const template = keepTemplate(state.template, dimIndex)
  const rows = rebuildRows(dimensions, state.rows, template)
  return { state: { ...state, dimensions, rows, template } }
}

/**
 * 新增规格值：去首尾空格后查重，重复或为空都拒绝。
 * 如果这是该维度「从无值到有第一个值」，把加值前的行存为新的 template（用于
 * 之后再给这个维度加值时也能找回同一批默认值）；如果该维度已有值，沿用现有
 * template（前提是它就是这个维度的），否则新出现的组合是空白默认值（A11）。
 * 对其它维度 addValue 会让已有 template 失效（keepTemplate 处理）。
 */
export function addValue(state: SpecEditorState, dimIndex: number, rawValue: string): MutationResult {
  const value = normalizeValue(rawValue)
  if (!value) return { error: '规格值不能为空' }
  const dim = state.dimensions[dimIndex]
  if (dim.values.includes(value)) return { error: `规格值「${value}」已存在` }

  const wasEmpty = dim.values.length === 0
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values: [...d.values, value] } : d))
  const template: DimensionTemplate | null = wasEmpty
    ? { dimIndex, rows: state.rows }
    : keepTemplate(state.template, dimIndex)
  const rows = rebuildRows(dimensions, state.rows, template)
  return { state: { ...state, dimensions, rows, template } }
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
  const template = keepTemplate(state.template, dimIndex)
  return { state: { ...state, dimensions, rows, template } }
}

/**
 * 删除规格值：返回受影响的「已保存」（带 id）行数，供 UI 生成确认文案。
 * 如果删的是该维度最后一个值，维度回到「没有值」的占位状态——对应行不删除，
 * 只是把该位置换回占位符（id/价格/库存原样保留），而不是把整张表清空。
 */
export function removeValue(state: SpecEditorState, dimIndex: number, value: string): { state: SpecEditorState; affectedSavedRows: number } {
  const dim = state.dimensions[dimIndex]
  const remainingValues = dim.values.filter((v) => v !== value)
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values: remainingValues } : d))
  const affectedSavedRows = state.rows.filter((r) => r.specValues[dimIndex] === value && r.id !== undefined).length

  const baseRows =
    remainingValues.length === 0
      ? state.rows.map((r) =>
          r.specValues[dimIndex] === value
            ? { ...r, specValues: r.specValues.map((v, i) => (i === dimIndex ? PLACEHOLDER : v)) }
            : r
        )
      : state.rows.filter((r) => r.specValues[dimIndex] !== value)

  const template = keepTemplate(state.template, dimIndex)
  const rows = rebuildRows(dimensions, baseRows, template)
  return { state: { ...state, dimensions, rows, template }, affectedSavedRows }
}

/**
 * 保存前校验：
 * 1. 维度值为空 / 去空格后重复 / 空白值；
 * 2. 组合行是否覆盖 cartesian(dims)：行数必须等于各维度值数之积，且每个组合
 *    恰好有一行（不缺、不多、不重复）——否则会出现某个规格值在小程序里永远
 *    选不出对应 SKU（第一轮复核 R6）；
 * 3. 组合行价格缺失或非正数。
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

  if (rows.some((r) => r.specValues.includes(PLACEHOLDER))) {
    return '请为每个规格维度添加规格值后再保存'
  }

  const expected = cartesian(dims)
  const rowKeys = rows.map((r) => rowKey(r.specValues))
  const rowKeySet = new Set(rowKeys)
  const expectedKeySet = new Set(expected.map(rowKey))
  const coversAll = expected.every((combo) => rowKeySet.has(rowKey(combo)))
  if (rows.length !== expected.length || rowKeySet.size !== rowKeys.length || !coversAll || rowKeys.some((k) => !expectedKeySet.has(k))) {
    return '规格组合与规格值不一致，请检查各维度的规格值后重试'
  }

  if (rows.length === 0) return '请为规格维度添加规格值'
  for (const r of rows) {
    if (!r.price || parseFloat(r.price) <= 0) return `规格「${r.specValues.join('/')}」价格必须大于 0`
  }
  return null
}
