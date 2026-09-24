import BusinessCenter from '../components/BusinessCenter'
import { centerTabs } from '../navigation'
import { usePendingCounts } from '../hooks/usePendingOrders'

export default function CatalogCenter() {
  const { lowStockCount } = usePendingCounts()
  return (
    <BusinessCenter
      title="商品管理"
      description="按销售渠道维护商品和分类，商品只能归入同一渠道下的分类。"
      tabs={centerTabs.catalog}
      badges={{ '/catalog/low-stock': lowStockCount }}
    />
  )
}
