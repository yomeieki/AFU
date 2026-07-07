import { create } from 'zustand'

interface AdminInfo {
  id: number
  username: string
  name?: string | null
  role: string
}

interface AuthState {
  token: string | null
  admin: AdminInfo | null
  setAuth: (token: string, admin: AdminInfo) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('admin_token'),
  admin: (() => {
    const raw = localStorage.getItem('admin_info')
    try {
      return raw ? (JSON.parse(raw) as AdminInfo) : null
    } catch {
      return null
    }
  })(),
  setAuth: (token, admin) => {
    localStorage.setItem('admin_token', token)
    localStorage.setItem('admin_info', JSON.stringify(admin))
    set({ token, admin })
  },
  clearAuth: () => {
    localStorage.removeItem('admin_token')
    localStorage.removeItem('admin_info')
    set({ token: null, admin: null })
  },
}))
