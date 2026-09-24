/**
 * 金额格式化——千分位 + 两位小数 + `¥` 前缀。
 *
 * 不用 `toLocaleString`：与 `utils/time.ts` 顶部注释同样的理由——不同浏览器/不同 ICU 版本
 * 对分隔符的实现不完全一致，拼出来的字符串会随环境漂移。这里手动拼千分位，行为在所有
 * 环境下都是同一份代码算出来的同一个字符串。
 */
export function fmtYuanGrouped(fen: number): string {
  const negative = fen < 0
  const abs = Math.abs(fen)
  const yuan = (abs / 100).toFixed(2)
  const [intPart, decPart] = yuan.split('.')
  let grouped = ''
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) grouped += ','
    grouped += intPart[i]
  }
  return `${negative ? '-' : ''}¥${grouped}.${decPart}`
}
