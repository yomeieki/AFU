import { create } from 'zustand'
import { isNewerVersion } from '../utils/version-compare'

export const BUILD_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

interface VersionState { serverVersion: string | null; outdated: boolean; noteServerVersion: (v: string | null | undefined) => void }
export const useVersionStore = create<VersionState>((set) => ({
  serverVersion: null,
  outdated: false,
  noteServerVersion: (v) => { if (!v) return; set({ serverVersion: v, outdated: isNewerVersion(BUILD_VERSION, v) }) },
}))
