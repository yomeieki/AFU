import { useLocation, useNavigate } from 'react-router-dom'
import BusinessCenter from '../components/BusinessCenter'
import { useUnsavedSettings } from '../components/UnsavedSettings'
import { centerTabs } from '../navigation'

export default function SettingsCenter() {
  const location = useLocation()
  const navigate = useNavigate()
  const { confirmLeave } = useUnsavedSettings()

  // 两个设置页各自保存，切页签前先问一句，别把没保存的改动丢了
  const leave = async (to: string) => {
    if (to === location.pathname) return
    if (!(await confirmLeave())) return
    navigate(to)
  }

  return (
    <BusinessCenter
      title="店铺设置"
      description="按配送方式分别维护规则，保存只作用于当前设置页。"
      tabs={centerTabs.settings}
      onTabClick={(to) => void leave(to)}
    />
  )
}
