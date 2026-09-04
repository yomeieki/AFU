import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPendingOrderCount } from '../api/admin'
import { toast } from '../components/ui/Toast'

const POLL_INTERVAL = 30_000
const ORIGINAL_TITLE = document.title

// 挂在 Layout 上全局生效：轮询待发货订单数，发现新付款订单时三层提醒
// ① toast ② 系统 Notification（需授权，仅 localhost/HTTPS）③ 标签页失焦时标题闪烁
export function usePendingOrders() {
  const [count, setCount] = useState(0)
  const [afterSaleCount, setAfterSaleCount] = useState(0)
  const [localPendingCount, setLocalPendingCount] = useState(0)
  const lastPaidAtRef = useRef<string | null>(null)
  const initializedRef = useRef(false)
  const lowStockNotifiedRef = useRef(false)
  const flashTimerRef = useRef<number | null>(null)
  const navigate = useNavigate()

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
        const { count: c, latestPaidAt, lowStockCount, lowStockThreshold, afterSaleCount: asc, localPendingCount: lpc } = res.data.data
        setCount(c)
        setAfterSaleCount(asc ?? 0)
        setLocalPendingCount(lpc ?? 0)
        // 低库存预警：每次会话只提醒一次
        if (lowStockCount > 0 && !lowStockNotifiedRef.current) {
          lowStockNotifiedRef.current = true
          toast.info(`有 ${lowStockCount} 个商品库存不足（≤${lowStockThreshold}），请及时补货`)
        }
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
            navigate('/orders?status=PAID')
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

  return { count, afterSaleCount, localPendingCount }
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
