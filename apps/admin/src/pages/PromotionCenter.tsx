import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'

export default function PromotionCenter() {
  return (
    <BusinessCenter
      title="推广运营"
      description="轮播图是顾客打开小程序第一眼的门面，扫码统计是包装二维码带来的复购数据。"
      tabs={centerTabs.promotion}
    />
  )
}
