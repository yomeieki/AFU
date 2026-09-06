/**
 * 小程序时间格式化 —— 一律按北京时间（UTC+8）。
 *
 * 为什么不用 `new Date(x).getHours()`：那按**运行设备**的时区解读。顾客手机基本都在
 * 自贡，暴露面小；但**微信开发者工具跑在别的时区的电脑上会看到错的时间**，店主联调时
 * 一定会撞到——首单排查时后台就是栽在同一件事上（那边已改，见 apps/admin/src/utils/time.ts）。
 *
 * 为什么不用 Intl + timeZone:'Asia/Shanghai'（后台那份的做法）：
 * 微信小程序各版本基础库对 `Intl` 的支持不齐，低版本上 `timeZone` 选项会被忽略甚至抛错，
 * 而这里没有降级余地——错了不会报错，只会安静地显示错时间。所以手算 +08:00：
 * 把时间戳加 8 小时后用 getUTC* 系列读，得到的就是北京时间的墙钟。
 *
 * ⚠️ 本文件必须保持 ES5（scripts/check-miniapp-es5.mjs 把守）：无 const/let、
 * 无箭头函数、无模板字符串、无简写属性。
 */

var OFFSET_MS = 8 * 3600 * 1000

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/** 解析成「北京时间墙钟」的 Date；拿不到有效时间返回 null */
function shDate(v) {
  if (v === null || v === undefined || v === '') return null
  var d = v instanceof Date ? v : new Date(v)
  var ms = d.getTime()
  if (isNaN(ms)) return null
  return new Date(ms + OFFSET_MS)
}

/** 'HH:mm' */
function fmtHHmm(v, empty) {
  var d = shDate(v)
  if (!d) return empty === undefined ? '' : empty
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
}

/** 'YYYY-MM-DD' */
function fmtDate(v, empty) {
  var d = shDate(v)
  if (!d) return empty === undefined ? '' : empty
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

/** 'YYYY-MM-DD HH:mm' */
function fmtDateTime(v, empty) {
  var d = shDate(v)
  if (!d) return empty === undefined ? '' : empty
  return fmtDate(v) + ' ' + fmtHHmm(v)
}

/** 从现在起 N 分钟后的 'HH:mm'（同城结算页「预计 HH:mm 送达」） */
function fmtAfterMinutes(minutes) {
  return fmtHHmm(Date.now() + (Number(minutes) || 0) * 60 * 1000)
}

module.exports = {
  fmtHHmm: fmtHHmm,
  fmtDate: fmtDate,
  fmtDateTime: fmtDateTime,
  fmtAfterMinutes: fmtAfterMinutes,
}
