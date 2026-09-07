import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { confirmDialog } from './ui/ConfirmDialog'

export interface UnsavedSettingsValue {
  dirty: boolean
  setDirty: (dirty: boolean) => void
  confirmLeave: () => Promise<boolean>
}

export const UnsavedSettingsContext = createContext<UnsavedSettingsValue | null>(null)

export function UnsavedSettingsProvider({ children }: { children: ReactNode }) {
  const [dirty, setDirty] = useState(false)

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
  if (!value) throw new Error('useUnsavedSettings must be used inside SettingsCenter')
  return value
}
