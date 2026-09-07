import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function MembershipCenter() {
  return (
    <BusinessCenter
      title="会员营销"
      description="集中维护优惠券、积分赠品和顾客会员权益规则。"
      tabs={centerTabs.membership}
    />
  )
}
