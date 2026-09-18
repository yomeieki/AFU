import { toast } from '../ui/Toast'

/** 复制到剪贴板；两个订单列表页与详情页共用（原在 pages/Orders.tsx） */
export function copyText(text: string) {
  // 局域网 http 打开后台时 navigator.clipboard 就是 undefined（店员手机常见场景）；
  // 原先 `?.` 把整条链短路成 undefined，既不报错也不提示，像是什么都没发生。
  if (!navigator.clipboard) {
    toast.error('当前环境不支持复制，请长按选择')
    return
  }
  navigator.clipboard.writeText(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败')
  )
}
