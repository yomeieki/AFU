import { useEffect, useState } from 'react'

export const PHONE_QUERY = '(max-width: 700px)'

/** ≤700px 视为手机（工作台与经营概览共用同一分界） */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const onChange = (e: MediaQueryListEvent) => setPhone(e.matches)
    mq.addEventListener('change', onChange)
    setPhone(mq.matches) // 挂载与首帧之间可能已经转过屏
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return phone
}
