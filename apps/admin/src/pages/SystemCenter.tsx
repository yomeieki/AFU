import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function SystemCenter() {
  return (
    <BusinessCenter
      title="系统维护"
      description="小票没出先看打印机在不在线，再看系统状态里的服务端配置。"
      tabs={centerTabs.system}
    />
  )
}
