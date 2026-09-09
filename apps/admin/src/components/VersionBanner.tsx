import { useEffect } from 'react'
import { useVersionStore } from '../store/version'

/** 发版后挂着的旧页面：可见时只提示；从后台切回前台那一刻自动刷新（此时没有进行中的操作）。 */
export default function VersionBanner() {
  const outdated = useVersionStore((s) => s.outdated)
  useEffect(() => {
    if (!outdated) return
    const onVis = () => { if (document.visibilityState === 'visible') window.location.reload() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [outdated])
  if (!outdated) return null
  return (
    <div role="status" style={{ background: '#fff7e6', color: '#8a5a00', borderBottom: '1px solid #ffd591', padding: '6px 12px', fontSize: 13, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center' }}>
      <span>后台已更新到新版本，当前页面是旧版</span>
      <button type="button" onClick={() => window.location.reload()} style={{ border: '1px solid #8a5a00', borderRadius: 6, padding: '2px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>点击刷新</button>
    </div>
  )
}
