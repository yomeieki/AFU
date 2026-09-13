/**
 * 打包费纯计算（2026-09-13 打包费设计 §2.4）：同城外送 + 到店自取按份收，全国邮寄不收。
 *
 * **纯**函数，不 import prisma：调用方（下单、结算页预览、订单详情回填）各自取来
 * `LocalDeliverySettings` 与行数据传进来，`scripts/selftest-packing.ts` 才能不起数据库跑完整个矩阵
 * ——计费是最不该靠端到端测试来保证的一块（与 services/member/pricing.ts 同一个理由）。
 *
 * 公式逐字执行，本文件不重新讨论：
 *   perItem(product) = product.packingFeeFen ?? settings.packing.perItemFen
 *   packingFee = (settings.packing.enabled && deliveryType ∈ {LOCAL, PICKUP})
 *              ? Σ(非赠品行 quantity × perItem) : 0
 */
import { LocalDeliverySettings } from './local-settings'

/**
 * 单份打包费（分）。总开关关掉时整店为 0——即便某道菜自己覆盖了一个非零金额，
 * 开关是「临时不收」的总闸，商品上的覆盖值原样保留、只是暂不生效。
 */
export function packingFeeEach(s: LocalDeliverySettings, product: { packingFeeFen: number | null }): number {
  return s.packing.enabled ? (product.packingFeeFen ?? s.packing.perItemFen) : 0
}

/**
 * 一单的打包费合计（分）。`deliveryType` 不是 LOCAL/PICKUP（即全国邮寄 EXPRESS）恒为 0——
 * 箱费已经在运费里，打包费不重复收（design §1 P3）。赠品行（`isGift`）不计（P4）。
 */
export function calcPackingFee(
  s: LocalDeliverySettings,
  deliveryType: string,
  lines: { packingFeeFen: number | null; quantity: number; isGift?: boolean }[],
): number {
  if (!s.packing.enabled) return 0
  if (deliveryType !== 'LOCAL' && deliveryType !== 'PICKUP') return 0
  return lines.reduce((sum, line) => (line.isGift ? sum : sum + line.quantity * packingFeeEach(s, line)), 0)
}
