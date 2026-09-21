/**
 * 店员可见文案集中管理：本文件只导出字符串常量与纯文案模板函数，不依赖 React/DOM。
 * specLogic.ts、SpecEditor.tsx、Products.tsx 一律从这里取字符串，不在别处另写
 * 店员可见的中文，避免同一句提示在多处改出不一致的版本。
 *
 * 术语约定（对店员）：本文件的文案统一使用「规格项」「选项」「组合」，不使用内部实现里的旧称呼。
 */

// ---------------------------------------------------------------------------
// T 组：编辑器静态文案
// ---------------------------------------------------------------------------

export const T1_TITLE = '商品规格'
export const T2_ADD_DIMENSION = '添加规格项'
export const T3_EMPTY_HINT =
  '这个商品没有分规格，按下面的「售价 / 库存」直接卖。要分规格卖（比如 辣度、重量、带骨/去骨），点右上角「添加规格项」。'
export const T4_HAS_DIM_HINT =
  '点一下选项的名字可以改名，用箭头调顺序；改名和调顺序都不会丢掉已经填好的价格和库存。顾客在小程序里看到的顺序和这里一样。'

const DIM_NAME_EXAMPLES = ['辣度', '重量', '骨型']
/** T5：规格项名输入框 placeholder，示例按下标轮换，超出用「口味」 */
export function dimNamePlaceholder(index: number): string {
  return `规格项名称，如 ${DIM_NAME_EXAMPLES[index] ?? '口味'}`
}

export const T6_MOVE_UP = '往上移'
export const T6_MOVE_DOWN = '往下移'
export const T6_REMOVE_DIM = '删掉这个规格项'

export const T7_MOVE_PREV = '往前移'
export const T7_MOVE_NEXT = '往后移'
export const T7_RENAME = '点一下改名'
export const T7_REMOVE_VALUE = '删掉这个选项'

export const T8_VALUE_PLACEHOLDER = '输入选项名，按回车添加'
export const T9_NO_VALUES_HINT = '这个规格项还没有选项，添加选项后下面会出现价格表。'

export const T10_BATCH_LABEL = '一次填好全部'
export const T10_BATCH_PRICE_PLACEHOLDER = '价格(元)'
export const T10_BATCH_STOCK_PLACEHOLDER = '库存'
export const T10_BATCH_BUTTON = '填到每一行'

export const T11_PRICE_HEADER = '价格(元) *'
export const T11_ORIGINAL_PRICE_HEADER = '原价(元)'
export const T11_STOCK_HEADER = '库存'
export const T11_PRICE_PLACEHOLDER = '必填'
export const T11_OPTIONAL_PLACEHOLDER = '可选'

/** T12：表格下方汇总 */
export function summaryText(n: number): string {
  return `一共 ${n} 个规格组合。商品展示的价格会自动取最低的那个，总库存是各组合库存加起来。`
}

export const T13_PRICE_PLACEHOLDER_HAS_SPECS = '分规格后自动取最低的价格'
export const T14_DIM_NAME_REQUIRED = '请给每个规格项起个名字（比如：辣度）'
export const T15_PRICE_REQUIRED = '请输入售价'

// ---------------------------------------------------------------------------
// N 组：打开编辑时的自动整理提示
// ---------------------------------------------------------------------------

export interface LoadFixes {
  addedRows: number
  trimmedValues: number
  droppedRows: number
}

function n1(n: number): string {
  return `系统发现这个商品少了 ${n} 个规格组合，已经自动补上（价格空着的那几行）。请把价格和库存填好再保存。`
}
const N2_TRIMMED = '系统已自动去掉了规格名称里多余的空格，保存后会一起更新。'
function n3(n: number): string {
  return `有 ${n} 个对不上的规格组合已自动清理，保存后会一起更新。`
}

/** 多条同时成立按 N1、N2、N3 顺序用 \n 连接；全为 0 返回 null（不显示） */
export function loadNoticeText(fixes: LoadFixes): string | null {
  const parts: string[] = []
  if (fixes.addedRows > 0) parts.push(n1(fixes.addedRows))
  if (fixes.trimmedValues > 0) parts.push(N2_TRIMMED)
  if (fixes.droppedRows > 0) parts.push(n3(fixes.droppedRows))
  return parts.length ? parts.join('\n') : null
}

// ---------------------------------------------------------------------------
// E 组：即时提示（addValue / renameValue 的 error 返回值）
// ---------------------------------------------------------------------------

export const E0_EMPTY_VALUE = '请先输入选项名'
export function msgDuplicateNewValue(v: string): string {
  return `「${v}」已经有了，不用再加`
}
export function msgDuplicateRename(v: string): string {
  return `已经有一个叫「${v}」的选项了，请换个名字`
}
export const E3_EMPTY_RENAME = '选项名不能是空的，已恢复原来的名字'

// ---------------------------------------------------------------------------
// V 组：保存前校验（validateSpecForm 返回值）
// ---------------------------------------------------------------------------

/** label = 规格项名去空格；为空时用「第 N 个规格项」 */
export function dimLabel(name: string, index: number): string {
  const trimmed = name.trim()
  return trimmed || `第 ${index + 1} 个规格项`
}
export function msgNoValues(label: string): string {
  return `规格项「${label}」还没有选项，请至少加一个`
}
export function msgBlankValue(label: string): string {
  return `规格项「${label}」里有空白的选项，请删掉或填上名字`
}
export function msgDuplicateValueInDim(label: string, v: string): string {
  return `规格项「${label}」里「${v}」出现了两次，请删掉一个`
}
export const V4_PLACEHOLDER_ROW = '有规格项还没有选项，请先添加选项再保存'
export const V5_MISMATCH = '规格组合和选项对不上，请关掉编辑窗口重新打开后再试'
export function msgRowPriceMissing(values: string[]): string {
  return `组合「${values.join(' / ')}」还没有填价格，价格要大于 0`
}

// ---------------------------------------------------------------------------
// C 组：确认框（confirmDialog() 的入参）
// ---------------------------------------------------------------------------

export interface ConfirmSpec {
  title: string
  content: string
  danger: boolean
  confirmText: string
  cancelText: string
}

export function confirmAddDimension(): ConfirmSpec {
  return {
    title: '添加规格项',
    content:
      '加了新的规格项以后，原来的每个规格会按新规格项拆成好几个，价格和库存会先照原来的填好，保存前请核对一遍。\n' +
      '保存以后，顾客购物车里原来选的这个商品会被清空。要继续吗？',
    danger: false,
    confirmText: '继续添加',
    cancelText: '先不加',
  }
}

export function confirmRemoveLastDimension(): ConfirmSpec {
  return {
    title: '删掉规格项',
    content:
      '删掉最后一个规格项后，这个商品就不分规格了，售价和库存要在下面的「售价 / 库存」里填。\n' +
      '保存以后，原来的规格都会被删掉，顾客购物车里选了这个商品的记录会被清空。确定删掉吗？',
    danger: true,
    confirmText: '删掉',
    cancelText: '不删了',
  }
}

export function confirmRemoveDimensionMerge(label: string, from: number, to: number): ConfirmSpec {
  return {
    title: '删掉规格项',
    content:
      `删掉「${label}」后，现在的 ${from} 个组合会合并成 ${to} 个，合并后的价格和库存取原来第一行的，保存前请核对一遍。\n` +
      '保存以后，原来的规格会被删掉重建，顾客购物车里选了这个商品的记录会被清空。确定删掉吗？',
    danger: true,
    confirmText: '删掉',
    cancelText: '不删了',
  }
}

export function confirmRemoveDimensionRestore(label: string): ConfirmSpec {
  return {
    title: '删掉规格项',
    content: `删掉「${label}」后，规格会恢复成加它之前的样子，原来的价格和库存都还在。确定删掉吗？`,
    danger: false,
    confirmText: '删掉',
    cancelText: '不删了',
  }
}

export function confirmRemoveValue(v: string, n: number): ConfirmSpec {
  return {
    title: '删掉选项',
    content: `删掉「${v}」后，保存时会一起删掉 ${n} 个已有的规格，顾客购物车里选了这些规格的记录会被清空。确定删掉吗？`,
    danger: true,
    confirmText: '删掉',
    cancelText: '不删了',
  }
}
