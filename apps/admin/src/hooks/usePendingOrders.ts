import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPendingOrderCount } from '../api/admin'
import { toast } from '../components/ui/Toast'

const POLL_INTERVAL = 30_000

/** usePendingOrders 的返回值：Layout 挂一份后经 context 下发，页面只读计数、不再各自轮询 */
export interface PendingCounts {
  count: number
  afterSaleCount: number
  localPendingCount: number
  refundAttentionCount: number
  refundAttentionByChannel: { EXPRESS: number; LOCAL: number }
  /** 售罄或紧张的规格数（在架），门槛见 lowStockThreshold（2026-09-24 库存预警） */
  lowStockCount: number
  lowStockThreshold: number
}

const ZERO_COUNTS: PendingCounts = {
  count: 0, afterSaleCount: 0, localPendingCount: 0, refundAttentionCount: 0,
  refundAttentionByChannel: { EXPRESS: 0, LOCAL: 0 }, lowStockCount: 0, lowStockThreshold: 3,
}

/**
 * Layout 里那一份 usePendingOrders 的结果。Layout 下的页面（订单页、同城页）要用计数时**只能**从这里取，
 * 不得再调 usePendingOrders：每多挂一份就多一条 30s 轮询，新单 toast / 系统通知 / 库存不足提示都会
 * 各弹一次（复核 R13，邮寄页原本就有这个重复，同城页第二轮又被扩了一份）。
 * Workbench 渲染在 Layout 外、自己挂一份，是唯一的例外。
 */
export const PendingCountsContext = createContext<PendingCounts | null>(null)

/** 取 Layout 下发的计数；不在 Layout 内（理论上不该发生）时退化为全 0，不轮询 */
export function usePendingCounts(): PendingCounts {
  return useContext(PendingCountsContext) ?? ZERO_COUNTS
}
const ORIGINAL_TITLE = document.title

interface UsePendingOrdersOptions {
  /** 系统 Notification 被点击后的行为，默认跳转邮寄订单页。
   *  工作台（/workbench）本身就是店员整天待着的落地页，不该被这个提醒踢去邮寄订单页——
   *  传入的回调只应该把当前页面拉到前台/带回可见处，不导航离开（I8） */
  onNotificationClick?: () => void
}

// 挂在 Layout 上全局生效；Workbench 也单独挂一份（它渲染在 Layout 外，见 App.tsx）——
// 否则店员整天待着的那一页反而是唯一没有新单提醒的页面（I8）。
// 轮询待发货订单数，发现新付款订单时三层提醒：① toast ② 系统 Notification（需授权，仅 localhost/HTTPS）③ 标签页失焦时标题闪烁
export function usePendingOrders(options?: UsePendingOrdersOptions): PendingCounts {
  const [count, setCount] = useState(0)
  const [afterSaleCount, setAfterSaleCount] = useState(0)
  const [refundAttentionCount, setRefundAttentionCount] = useState(0)
  const [refundAttentionByChannel, setRefundAttentionByChannel] = useState<{ EXPRESS: number; LOCAL: number }>({ EXPRESS: 0, LOCAL: 0 })
  const [localPendingCount, setLocalPendingCount] = useState(0)
  const [lowStockCount, setLowStockCount] = useState(0)
  const [lowStockThreshold, setLowStockThreshold] = useState(3)
  const lastPaidAtRef = useRef<string | null>(null)
  const initializedRef = useRef(false)
  const flashTimerRef = useRef<number | null>(null)
  const navigate = useNavigate()
  // 用 ref 存最新的 options：轮询 effect 只跑一次（依赖数组是 []，避免调用方每次渲染新回调
  // 就把整个轮询重启一遍），但 onclick 触发时要拿到最新的回调，不是挂载那一刻的旧闭包
  const optionsRef = useRef(options)
  optionsRef.current = options

  const stopTitleFlash = () => {
    if (flashTimerRef.current !== null) {
      clearInterval(flashTimerRef.current)
      flashTimerRef.current = null
      document.title = ORIGINAL_TITLE
    }
  }

  const startTitleFlash = () => {
    if (flashTimerRef.current !== null || !document.hidden) return
    let on = false
    flashTimerRef.current = window.setInterval(() => {
      on = !on
      document.title = on ? `【新订单】${ORIGINAL_TITLE}` : ORIGINAL_TITLE
    }, 1000)
  }

  useEffect(() => {
    let disposed = false

    const poll = async () => {
      try {
        const res = await getPendingOrderCount()
        if (disposed) return
        const { count: c, latestPaidAt, lowStockCount: lsc, lowStockThreshold: lst, afterSaleCount: asc, localPendingCount: lpc, refundAttentionCount: rac, refundAttentionByChannel: rabc } = res.data.data
        setCount(c)
        setAfterSaleCount(asc ?? 0)
        setRefundAttentionCount(rac ?? 0)
        setRefundAttentionByChannel({ EXPRESS: rabc?.EXPRESS ?? 0, LOCAL: rabc?.LOCAL ?? 0 })
        setLocalPendingCount(lpc ?? 0)
        setLowStockCount(lsc ?? 0)
        setLowStockThreshold(lst ?? 3)
        // 登录时那条一次性 toast 已删除（2026-09-24）：改由「商品管理」页签/侧栏角标常驻提示，
        // 不再每次登录弹「有 N 个规格售罄或紧张」——同城三道菜的 100 克规格会长期保持上架且
        // 库存为 0，一次性 toast 会变成每次登录都弹的噪音。
        const prev = lastPaidAtRef.current
        lastPaidAtRef.current = latestPaidAt
        // 首次轮询只记基线，不提醒历史积压
        if (!initializedRef.current) {
          initializedRef.current = true
          return
        }
        const hasNew = latestPaidAt !== null && (prev === null || latestPaidAt > prev)
        if (!hasNew) return

        toast.info(`有新的待发货订单（共 ${c} 笔待发货）`)
        if ('Notification' in window && Notification.permission === 'granted') {
          const n = new Notification('新订单提醒', {
            body: `有 ${c} 笔订单待发货，点击查看`,
          })
          n.onclick = () => {
            window.focus()
            if (optionsRef.current?.onNotificationClick) optionsRef.current.onNotificationClick()
            else navigate('/orders/express?status=PAID')
            n.close()
          }
        }
        startTitleFlash()
      } catch {
        // 轮询失败静默（401 由 axios 拦截器统一处理）
      }
    }

    poll()
    const timer = window.setInterval(poll, POLL_INTERVAL)
    const onFocus = () => stopTitleFlash()
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      stopTitleFlash()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { count, afterSaleCount, localPendingCount, refundAttentionCount, refundAttentionByChannel, lowStockCount, lowStockThreshold }
}

// 铃铛点击时调用：在用户手势内请求 Notification 权限
export function requestNotifyPermission() {
  if (!('Notification' in window)) {
    toast.info('当前环境不支持系统通知，将使用页面内提醒')
    return
  }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then((p) => {
      if (p === 'granted') toast.success('已开启新订单系统通知')
    })
  } else if (Notification.permission === 'denied') {
    toast.info('系统通知被浏览器拦截，可在浏览器设置中开启')
  }
}
