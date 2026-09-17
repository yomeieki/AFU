import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

// 未保存拦截已内置在 BusinessCenter（对所有中心一致生效），这里不再自己接 onTabClick。
export default function SettingsCenter() {
  return (
    <BusinessCenter
      title="店铺设置"
      description="按配送方式分别维护规则；营业时间全店统一。保存只作用于当前设置页。"
      tabs={centerTabs.settings}
    />
  )
}
