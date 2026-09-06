/**
 * 小程序新增 js 的 ES5 语法闸门。
 *
 * 为什么不是 `grep -n "=>\|const \|let \|\`"`（M4 计划完成标准 #7 写的那条）：
 * 它会被**注释与字符串里的反引号**误报（本组件的注释里引用了 `coupons[].discount`
 * 就当场红了），也漏得掉 grep 看不见的 ES6（简写属性 `{ a }`、`for..of`、
 * 计算属性名、默认参数……）。用 acorn 以 ecmaVersion:5 真解析，误报漏报一起解决。
 *
 * 注意：**既有小程序代码本身并不是纯 ES5**（`pages/order/detail.js:1` 就是
 * `const` + 解构，`utils/request.js` 有十余处）。所以这道闸门只对**新增**文件生效，
 * 不去回头改既有文件——那是另一件事，不该混进会员功能里。
 *
 * 用法：node scripts/check-miniapp-es5.mjs <file...>
 */
import { parse } from 'acorn'
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('用法: node scripts/check-miniapp-es5.mjs <file...>')
  process.exit(2)
}
let bad = 0
for (const f of files) {
  try {
    parse(readFileSync(f, 'utf8'), { ecmaVersion: 5, sourceType: 'script' })
    console.log('  ES5 ✔ ' + f)
  } catch (e) {
    bad++
    console.log('  ES5 ✘ ' + f + '  → ' + e.message)
  }
}
console.log(bad === 0 ? `全部通过（${files.length} 个文件）` : `${bad} 个文件不是 ES5`)
process.exit(bad ? 1 : 0)
