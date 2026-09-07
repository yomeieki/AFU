import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function OrderCenter() {
  return (
    <BusinessCenter
      title="订单管理"
      description="同城配送用于查询配送历史，全国邮寄用于发货、退款和售后管理。"
      tabs={centerTabs.orders}
    />
  )
}
