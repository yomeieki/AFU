import * as msg from './specMessages'
import type { LoadFixes } from './specMessages'
export type { LoadFixes }

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
/** 与服务端 zod（services/specs.ts）保持一致的上限：单规格项最多选项数 */
const MAX_VALUES_PER_DIMENSION = 20
/** 与服务端 zod 保持一致的上限：规格项名 / 选项名最多字数（按 JS string.length 计） */
const MAX_NAME_LENGTH = 32
/** 与服务端 zod 保持一致的上限：规格组合总数（skus 数组上限） */
const MAX_COMBINATIONS = 60

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
 * 打开编辑时自动整理（不需要店员做任何前移/后移之类的维护动作）：
 * 1. 规格项名与选项统一去首尾空格；去空格后为空的选项丢弃；同规格项内去空格后
 *    重复的选项只保留首次出现；每个被 trim 实际改变的名字/选项计 1 到 trimmedValues。
 * 2. 组合行的每个值逐项去空格；按内容去重（保留首次出现，其余计 droppedRows）；
 *    按整理后的 cartesian(dims) 顺序重排：命中的行原样保留（含 id/价格/库存），
 *    缺的补一行空白默认值并计 addedRows；对不上任何组合的行丢弃并计 droppedRows。
 * 规格项为空（无规格商品）时原样返回空状态，不做任何整理。
 */
export function prepareLoadedState(
  dims: SpecDimension[],
  rows: SkuRow[]
): { state: SpecEditorState; fixes: LoadFixes } {
  if (dims.length === 0) {
    return { state: { dimensions: [], rows: [], template: null }, fixes: { addedRows: 0, trimmedValues: 0, droppedRows: 0 } }
  }

  let trimmedValues = 0
  const newDims: SpecDimension[] = dims.map((d) => {
    const name = normalizeValue(d.name)
    if (name !== d.name) trimmedValues++
    const seen = new Set<string>()
    const values: string[] = []
    for (const raw of d.values) {
      const v = normalizeValue(raw)
      if (v !== raw) trimmedValues++
      if (!v || seen.has(v)) continue
      seen.add(v)
      values.push(v)
    }
    return { name, values }
  })

  const normalizedRows = rows.map((r) => ({ ...r, specValues: r.specValues.map(normalizeValue) }))
  const byKey = new Map<string, SkuRow>()
  let droppedRows = 0
  for (const r of normalizedRows) {
    const key = rowKey(r.specValues)
    if (byKey.has(key)) {
      droppedRows++
      continue
    }
    byKey.set(key, r)
  }

  let addedRows = 0
  const expected = cartesian(newDims)
  const expectedKeys = new Set(expected.map(rowKey))
  const combinedRows = expected.map((values) => {
    const hit = byKey.get(rowKey(values))
    if (hit) return hit
    addedRows++
    return { specValues: values, price: '', originalPrice: '', stock: 0 }
  })
  for (const key of byKey.keys()) {
    if (!expectedKeys.has(key)) droppedRows++
  }

  return {
    state: { dimensions: newDims, rows: combinedRows, template: null },
    fixes: { addedRows, trimmedValues, droppedRows },
  }
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

/** 无规格商品第一次加规格项时，占位行带入的默认售价/原价/库存 */
export interface RowDefaults {
  price: string
  originalPrice: string
  stock: number
}

/**
 * 商品级默认值 → 占位行默认值：售价/原价原样带入，库存一律 0（不带商品原库存），
 * 需要店员自己按各组合实际数量填，避免加了规格项之后商品总库存被“无中生有”地
 * 乘倍，造成超卖（第一轮裁决 R16）。
 */
export function productLevelDefaults(form: { price: string; originalPrice: string; stock: number }): RowDefaults {
  return { price: form.price, originalPrice: form.originalPrice, stock: 0 }
}

/**
 * 新增维度（无值）：现有行原样保留（含 id），只在末尾追加一个占位符位置；template 失效。
 * 仅当这是从 0 个维度开始新增（无规格商品第一次加规格项）且传入 defaults 时，
 * 占位行的价格/原价/库存用 defaults 填好，不需要店员逐行手填（对已有维度的商品
 * 传 defaults 不生效，因为此时占位行不止一条，直接套用商品级默认值没有意义）。
 */
export function addDimension(state: SpecEditorState, name = '', defaults?: RowDefaults): { state: SpecEditorState } {
  if (state.dimensions.length >= MAX_DIMENSIONS) return { state }
  const wasEmpty = state.dimensions.length === 0
  const dimensions = [...state.dimensions, { name, values: [] }]
  const expanded = state.rows.map((r) => ({ ...r, specValues: [...r.specValues, PLACEHOLDER] }))
  let rows = rebuildRows(dimensions, expanded, null)
  if (wasEmpty && defaults) {
    rows = rows.map((r) => ({ ...r, price: defaults.price, originalPrice: defaults.originalPrice, stock: defaults.stock }))
  }
  return { state: { dimensions, rows, template: null } }
}

/**
 * 删除维度：
 * - 删到只剩 0 个维度 → 行清空（无规格商品）。
 * - 被删维度还没有值（占位状态）→ 行只是去掉该位置，id/价格/库存原样保留，不合并。
 * - 被删维度是刚加的、还带着「加它之前」的 template（R13：反悔删掉刚加的维度）→
 *   直接用 template.rows 去掉该位置恢复原状，不触发合并、不重建 SKU、不清购物车。
 * - 其它情况（被删维度已有值、且不是可恢复的路径）→ 按去掉该维度后的组合合并：
 *   同一份组合取当前行顺序里的第一行，价格/库存取自该行，合并后的行一律不带 id
 *   （对应 SKU 保存时会重建，购物车按需清空）。
 * 返回 mergedFrom/mergedTo（供 UI 生成确认文案）与 restored（是否走了 R13 恢复路径）。
 */
export function removeDimension(
  state: SpecEditorState,
  dimIndex: number
): { state: SpecEditorState; mergedFrom: number; mergedTo: number; restored: boolean } {
  const dim = state.dimensions[dimIndex]
  const dimensions = state.dimensions.filter((_, i) => i !== dimIndex)

  if (dimensions.length === 0) {
    return { state: { dimensions: [], rows: [], template: null }, mergedFrom: state.rows.length, mergedTo: 0, restored: false }
  }

  if (dim.values.length === 0) {
    const rows = state.rows.map((r) => ({ ...r, specValues: r.specValues.filter((_, i) => i !== dimIndex) }))
    return { state: { dimensions, rows, template: null }, mergedFrom: rows.length, mergedTo: rows.length, restored: false }
  }

  if (state.template && state.template.dimIndex === dimIndex) {
    const rows = state.template.rows.map((r) => ({ ...r, specValues: r.specValues.filter((_, i) => i !== dimIndex) }))
    return {
      state: { dimensions, rows, template: null },
      mergedFrom: state.rows.length,
      mergedTo: rows.length,
      restored: true,
    }
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
    restored: false,
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
 * 新增规格值：去首尾空格后依次校验空值(E0)→长度(E5)→重复(E1)→该维度选项数上限(E4)→
 * 加上后的组合总数上限(E6)，任一不通过都拒绝、状态不变（第一轮裁决 R17，数量/字数
 * 上限与服务端 zod 一致，提前在前端拦成大白话提示，不让店员看到英文报错）。
 * 如果这是该维度「从无值到有第一个值」，把加值前的行存为新的 template（用于
 * 之后再给这个维度加值时也能找回同一批默认值）；如果该维度已有值，沿用现有
 * template（前提是它就是这个维度的），否则新出现的组合是空白默认值（A11）。
 * 对其它维度 addValue 会让已有 template 失效（keepTemplate 处理）。
 */
export function addValue(state: SpecEditorState, dimIndex: number, rawValue: string): MutationResult {
  const value = normalizeValue(rawValue)
  if (!value) return { error: msg.E0_EMPTY_VALUE }
  if (value.length > MAX_NAME_LENGTH) return { error: msg.E5_TOO_LONG }
  const dim = state.dimensions[dimIndex]
  // 已有值也按去首尾空格比较（R8）：库里可能存在带空格的历史数据
  if (dim.values.some((v) => normalizeValue(v) === value)) return { error: msg.msgDuplicateNewValue(value) }
  if (dim.values.length >= MAX_VALUES_PER_DIMENSION) {
    return { error: msg.msgTooManyValues(msg.dimLabel(dim.name, dimIndex)) }
  }

  const wasEmpty = dim.values.length === 0
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values: [...d.values, value] } : d))
  const comboCount = cartesian(dimensions).length
  if (comboCount > MAX_COMBINATIONS) return { error: msg.msgTooManyCombos(value, comboCount) }
  const template: DimensionTemplate | null = wasEmpty
    ? { dimIndex, rows: state.rows }
    : keepTemplate(state.template, dimIndex)
  const rows = rebuildRows(dimensions, state.rows, template)
  return { state: { ...state, dimensions, rows, template } }
}

/**
 * 规格值改名：同时更新维度定义与所有含该值的行，行对象其它字段（含 id）原样保留，
 * 不经过笛卡尔积重建，因此其余行完全不受影响、顺序不变。改名不会增加选项数或组合数，
 * 所以只校验空值(E3)→长度(E5)→重复(E2)，不查 E4/E6（第一轮裁决 R17）。
 */
export function renameValue(state: SpecEditorState, dimIndex: number, oldValue: string, rawNewValue: string): MutationResult {
  const newValue = normalizeValue(rawNewValue)
  if (!newValue) return { error: msg.E3_EMPTY_RENAME }
  const dim = state.dimensions[dimIndex]
  if (newValue === oldValue) return { state } // 无变化
  if (newValue.length > MAX_NAME_LENGTH) return { error: msg.E5_TOO_LONG }
  // 已有值也按去首尾空格比较（R8）；排除自己，允许「把自己改成去空格版本」
  if (dim.values.some((v) => v !== oldValue && normalizeValue(v) === newValue)) {
    return { error: msg.msgDuplicateRename(newValue) }
  }

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
 * R13：如果这正好是刚加的维度（template.dimIndex === dimIndex），删到没有值时
 * 直接用 template.rows 恢复成加它之前的样子，并保留 template——这样「新加维度→
 * 加值→把值又都删掉→删掉这个维度」同样能一路恢复回原状，不需要店员重建。
 */
export function removeValue(state: SpecEditorState, dimIndex: number, value: string): { state: SpecEditorState; affectedSavedRows: number } {
  const dim = state.dimensions[dimIndex]
  const remainingValues = dim.values.filter((v) => v !== value)
  const dimensions = state.dimensions.map((d, i) => (i === dimIndex ? { ...d, values: remainingValues } : d))
  const affectedSavedRows = state.rows.filter((r) => r.specValues[dimIndex] === value && r.id !== undefined).length

  if (remainingValues.length === 0 && state.template && state.template.dimIndex === dimIndex) {
    return { state: { ...state, dimensions, rows: state.template.rows, template: state.template }, affectedSavedRows }
  }

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
/**
 * 保存前校验，顺序固定为：V7（规格项总数）→ 逐规格项 [V8（名字长度）→ V1（无选项）→
 * V2/V3（空白/重复选项）→ V9（该规格项选项数）→ V10（单个选项长度）] → V4（占位行兜底）
 * → V11（组合总数）→ V5（行集合与笛卡尔积不一致兜底）→ V6（价格缺失）。
 * V7-V11 是保存前的兜底（第一轮裁决 R17）：正常操作已经在 addValue/renameValue 里
 * 拦住了（E4/E5/E6），这里主要防打开旧数据、或绕过输入框直接构造超限状态。
 */
export function validateSpecForm(dims: SpecDimension[], rows: SkuRow[]): string | null {
  if (dims.length === 0) return null
  if (dims.length > MAX_DIMENSIONS) return msg.V7_TOO_MANY_DIMENSIONS

  for (let i = 0; i < dims.length; i++) {
    const d = dims[i]
    const label = msg.dimLabel(d.name, i)
    if (normalizeValue(d.name).length > MAX_NAME_LENGTH) return msg.msgDimNameTooLong(label)
    if (d.values.length === 0) return msg.msgNoValues(label)
    const seen = new Set<string>()
    for (const raw of d.values) {
      const v = normalizeValue(raw)
      if (!v) return msg.msgBlankValue(label)
      if (seen.has(v)) return msg.msgDuplicateValueInDim(label, v)
      seen.add(v)
    }
    if (d.values.length > MAX_VALUES_PER_DIMENSION) return msg.msgTooManyValuesInDim(label)
    for (const raw of d.values) {
      const v = normalizeValue(raw)
      if (v.length > MAX_NAME_LENGTH) return msg.msgValueTooLong(label, v)
    }
  }

  if (rows.some((r) => r.specValues.includes(PLACEHOLDER))) {
    return msg.V4_PLACEHOLDER_ROW
  }

  const expected = cartesian(dims)
  if (expected.length > MAX_COMBINATIONS) return msg.msgTooManyCombosTotal(expected.length)

  const rowKeys = rows.map((r) => rowKey(r.specValues))
  const rowKeySet = new Set(rowKeys)
  const expectedKeySet = new Set(expected.map(rowKey))
  const coversAll = expected.every((combo) => rowKeySet.has(rowKey(combo)))
  if (rows.length !== expected.length || rowKeySet.size !== rowKeys.length || !coversAll || rowKeys.some((k) => !expectedKeySet.has(k))) {
    return msg.V5_MISMATCH
  }

  for (const r of rows) {
    if (!r.price || parseFloat(r.price) <= 0) return msg.msgRowPriceMissing(r.specValues)
  }
  return null
}

// ---------------------------------------------------------------------------
// 确认框决策（纯函数，返回 confirmDialog() 的入参或 null=不弹）
// ---------------------------------------------------------------------------

/** 点「添加规格项」：当前行里有带 id 的行（已保存过）才需要提醒会拆分重建、清购物车 */
export function confirmForAddDimension(state: SpecEditorState): msg.ConfirmSpec | null {
  if (state.dimensions.length >= MAX_DIMENSIONS) return null
  const hasSavedRows = state.rows.some((r) => r.id !== undefined)
  return hasSavedRows ? msg.confirmAddDimension() : null
}

/**
 * 删除规格项：判定顺序固定为
 * (1) 只剩这一个规格项 → 有带 id 行则提醒会变成单规格，否则不弹；
 * (2) 该规格项还没有选项 → 不弹（不影响任何已保存数据）；
 * (3) 这正是刚加的、还能用 template 恢复的规格项 → 提醒会恢复原状（不危险，不弹红色按钮）；
 * (4) 其它情况：有带 id 行则提醒会合并重建、清购物车，否则不弹（新商品还没保存过）。
 */
export function confirmForRemoveDimension(state: SpecEditorState, dimIndex: number): msg.ConfirmSpec | null {
  const dim = state.dimensions[dimIndex]
  if (!dim) return null
  const label = msg.dimLabel(dim.name, dimIndex)
  const hasSavedRows = state.rows.some((r) => r.id !== undefined)

  if (state.dimensions.length === 1) {
    return hasSavedRows ? msg.confirmRemoveLastDimension() : null
  }
  if (dim.values.length === 0) return null
  if (state.template && state.template.dimIndex === dimIndex) {
    return msg.confirmRemoveDimensionRestore(label)
  }
  if (!hasSavedRows) return null
  const preview = removeDimension(state, dimIndex)
  return msg.confirmRemoveDimensionMerge(label, preview.mergedFrom, preview.mergedTo)
}

/** 删除选项：只有会连带删掉已保存（带 id）的组合时才提醒会清购物车 */
export function confirmForRemoveValue(state: SpecEditorState, dimIndex: number, value: string): msg.ConfirmSpec | null {
  const preview = removeValue(state, dimIndex, value)
  return preview.affectedSavedRows > 0 ? msg.confirmRemoveValue(value, preview.affectedSavedRows) : null
}
