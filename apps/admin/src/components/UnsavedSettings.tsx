import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { confirmDialog } from './ui/ConfirmDialog'

export interface UnsavedSettingsValue {
  dirty: boolean
  setDirty: (dirty: boolean) => void
  confirmLeave: () => Promise<boolean>
}

export const UnsavedSettingsContext = createContext<UnsavedSettingsValue | null>(null)

export function UnsavedSettingsProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false)
  const { pathname } = useLocation()

  // 换页就清零。dirty 的语义是「当前这一页有没保存的改动」，而它是个全局单例：
  // 没有这一步，只要在任何设置页动过一下输入框，dirty 就永远是 true——
  // 之后在毫不相干的页面点顶栏会弹出假的「放弃未保存的修改？」，刷新还会被
  // beforeunload 拦一下。拦截本身发生在 navigate 之前（confirmLeave 确认后自己会置
  // false），所以能走到这里说明页面已经真的换了，此时清零不会吞掉任何一次拦截；
  // 未被守卫覆盖的离开方式（浏览器前进/后退）也一并收口。
  useEffect(() => {
    setDirty(false)
  }, [pathname])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const confirmLeave = async () => {
    if (!dirty) return true
    const confirmed = await confirmDialog({
      title: '放弃未保存的修改？',
      content: '当前设置尚未保存，切换页面后这些修改会丢失。',
      confirmText: '放弃并切换',
      danger: true,
    })
    if (confirmed) setDirty(false)
    return confirmed
  }

  return (
    <UnsavedSettingsContext.Provider value={{ dirty, setDirty, confirmLeave }}>
      {children}
    </UnsavedSettingsContext.Provider>
  )
}

export function useUnsavedSettings() {
  const value = useContext(UnsavedSettingsContext)
  if (!value) throw new Error('useUnsavedSettings 必须在 UnsavedSettingsProvider 内使用（挂在 App 的 Layout 层）')
  return value
}
