import { create } from 'zustand'
import { CheckCircle2, XCircle, Info } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  type: ToastType
  message: string
}

interface ToastState {
  items: ToastItem[]
  push: (type: ToastType, message: string) => void
  remove: (id: number) => void
}

let nextId = 1

const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (type, message) => {
    const id = nextId++
    set((s) => ({ items: [...s.items, { id, type, message }] }))
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
    }, 3000)
  },
  remove: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

// 命令式 API：可在任意模块（含 api 层）直接调用，无需 hook
export const toast = {
  success: (message: string) => useToastStore.getState().push('success', message),
  error: (message: string) => useToastStore.getState().push('error', message),
  info: (message: string) => useToastStore.getState().push('info', message),
}

const ICON: Record<ToastType, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
}

const COLOR: Record<ToastType, string> = {
  success: 'text-green-500',
  error: 'text-red-500',
  info: 'text-brand-500',
}

export function ToastHost() {
  const items = useToastStore((s) => s.items)
  const remove = useToastStore((s) => s.remove)
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-2 pointer-events-none">
      {items.map((t) => {
        const Icon = ICON[t.type]
        return (
          <div
            key={t.id}
            onClick={() => remove(t.id)}
            className="pointer-events-auto flex items-center gap-2 bg-white shadow-lg border border-gray-100 rounded-lg px-4 py-2.5 text-sm text-gray-800 animate-toast-in cursor-pointer"
          >
            <Icon className={`w-4 h-4 shrink-0 ${COLOR[t.type]}`} />
            <span>{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}
