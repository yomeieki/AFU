import { toast } from '../ui/Toast'

/** 复制到剪贴板；两个订单列表页与详情页共用（原在 pages/Orders.tsx） */
export function copyText(text: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast.success('已复制'),
    () => toast.error('复制失败')
  )
}
