// 分类内商品手动排序：拖拽与「↑ / ↓」按钮共用的纯函数（2026-09-17 分类内排序设计 §5）。
// 不改入参；越界/同位这类「什么都没变」的调用原样返回入参的引用，调用方据此判断
// 要不要发保存请求（applyOrder 里用 `next === list` 短路，同位/越界不发请求）。

/** 把 list[from] 移动到下标 to（其余元素顺移）。from/to 越界或相等时原样返回 list（同一引用）。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) {
    return list as T[]
  }
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** 把 index 与 index+dir 交换（dir=-1 上移，+1 下移）。首项上移/末项下移原样返回 list（同一引用）。 */
export function moveAdjacent<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  return moveItem(list, index, index + dir)
}
