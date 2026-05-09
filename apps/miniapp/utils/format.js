/**
 * Convert fen (integer cents) to yuan string.
 * e.g. 2990 → "29.90"
 */
function formatPrice(cents) {
  if (cents == null) return '0.00'
  return (cents / 100).toFixed(2)
}

/**
 * Human-readable stock label.
 */
function formatStock(stock) {
  if (stock <= 0) return '已售罄'
  if (stock <= 10) return '仅剩 ' + stock + ' 件'
  return '有货'
}

/**
 * Return url if truthy, otherwise empty string (image src won't error).
 */
function safeImage(url) {
  return url || ''
}

module.exports = { formatPrice, formatStock, safeImage }
