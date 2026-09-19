// Page-coordinate geometry for the category page. All dimensions are measured CSS pixels.
function number(value) {
  return typeof value === 'number' && isFinite(value) ? value : 0
}

function positive(value) {
  return Math.max(0, number(value))
}

function layoutOf(input) {
  input = input || {}
  var viewportHeight = positive(input.viewportHeight)
  var pinnedHeight = positive(input.pinnedHeight)
  var bodyTop = positive(input.bodyTop)
  var scrollTop = positive(input.scrollTop)
  var dockHeight = positive(input.dockHeight)
  var lastGroupHeight = positive(input.lastGroupHeight)
  var top = Math.max(pinnedHeight, bodyTop - scrollTop)
  return {
    sidebarTop: top,
    sidebarHeight: Math.max(0, viewportHeight - dockHeight - top),
    tailHeight: Math.max(0, viewportHeight - pinnedHeight - dockHeight - lastGroupHeight),
  }
}

function pageTarget(groupTop, pinnedHeight) {
  return Math.max(0, number(groupTop) - positive(pinnedHeight))
}

function revealScrollTop(input) {
  input = input || {}
  var itemTop = positive(input.itemTop)
  var itemHeight = positive(input.itemHeight)
  var scrollTop = positive(input.scrollTop)
  var viewportHeight = positive(input.viewportHeight)
  if (itemTop < scrollTop) return itemTop
  if (itemTop + itemHeight > scrollTop + viewportHeight) {
    return Math.max(0, itemTop + itemHeight - viewportHeight)
  }
  return scrollTop
}

module.exports = { layoutOf: layoutOf, pageTarget: pageTarget, revealScrollTop: revealScrollTop }
