import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function PromotionCenter() {
  return (
    <BusinessCenter
      title="推广运营"
      description="发给顾客的优惠都在这儿：优惠券、满减活动、积分赠品；轮播图是顾客打开小程序第一眼的门面，会员设置是这些优惠依据的规则。"
      tabs={centerTabs.promotion}
    />
  )
}
