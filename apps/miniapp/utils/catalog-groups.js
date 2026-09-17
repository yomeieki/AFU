// 分类页分组与高亮判定的纯函数（2026-09-17 分组锚点设计 §5.1）。
// 页面只负责量位置和 setData；「哪段该亮」「菜归哪段」全在这里，tests/miniapp/catalog-groups.test.cjs 钉住。
// ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）。
var OTHER_ID = 'other'
var OTHER_NAME = '其他'

/** 按 categories 给定顺序分段；空分类保留（items 为 []）；对不上分类的菜进末尾「其他」段，不丢菜 */
function groupByCategory(categories, products) {
  var cats = categories || []
  var list = products || []
  var groups = []
  var byId = {}
  var i
  for (i = 0; i < cats.length; i++) {
    var g = { id: cats[i].id, name: cats[i].name, items: [] }
    groups.push(g)
    byId[String(cats[i].id)] = g
  }
  var other = null
  for (i = 0; i < list.length; i++) {
    var p = list[i]
    var g2 = p && p.categoryId != null ? byId[String(p.categoryId)] : null
    if (!g2) {
      if (!other) other = { id: OTHER_ID, name: OTHER_NAME, items: [] }
      other.items.push(p)
    } else {
      g2.items.push(p)
    }
  }
  if (other) groups.push(other)
  return groups
}

/** 「段顶 <= scrollTop + 容差」的最后一段；一段都不满足取第一段；没有段返回 null */
function activeGroupOf(offsets, scrollTop, tolerance) {
  var list = offsets || []
  if (!list.length) return null
  var limit = (Number(scrollTop) || 0) + (typeof tolerance === 'number' ? tolerance : 0)
  var active = list[0].id
  for (var i = 0; i < list.length; i++) {
    if (list[i].top <= limit) active = list[i].id
    else break
  }
  return active
}

module.exports = { OTHER_ID: OTHER_ID, groupByCategory: groupByCategory, activeGroupOf: activeGroupOf }
