import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function OrderCenter() {
  return (
    <BusinessCenter
      title="订单管理"
      description="同城与邮寄订单的历史检索、退款与售后。"
      tabs={centerTabs.orders}
    />
  )
}
