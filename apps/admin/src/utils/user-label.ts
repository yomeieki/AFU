/**
 * 用户管理页「怎么称呼这个人 / 手机号从哪来」的唯一判定处。
 *
 * 背景（2026-09-22）：users.nickname/phone/avatarUrl 从登录起就没被写入过——登录只建
 * openid 行（routes/auth.ts），微信手机号授权也没接。列表上长期显示「用户 #12」+ 手机号
 * 「-」，店主没法用它对上一个真实顾客。真正有值的是订单收货人快照
 * orders.receiverName/receiverPhone（服务端已在 GET /api/admin/users 附带该用户「最近一单」，
 * 不排除任何状态，见 apps/server/src/routes/admin/users.ts）。
 *
 * 这里只是展示兜底，**不代表**用户改了昵称/绑了手机号——两个函数的注释和 types.ts 里的
 * AdminUser.latestOrder 注释要说的是同一件事，别在别处再抄一份判定逻辑。
 *
 * 纯逻辑文件：`node --test` 直接跑，不许 import 任何 `.tsx`。
 */

interface UserLike {
  id: number
  nickname: string | null
  latestOrder: { receiverName: string; createdAt: string } | null
}

/** 显示名：昵称 → 最近一单收货人姓名 → 「用户 #id」 */
export function userDisplayName(u: UserLike): string {
  return u.nickname ?? u.latestOrder?.receiverName ?? `用户 #${u.id}`
}

interface PhoneLike {
  phone: string | null
  latestOrder: { receiverPhone: string } | null
}

export type UserPhoneInfo = { phone: string; source: 'wechat' } | { phone: string; source: 'order' } | null

/**
 * 手机号：users.phone（微信绑定，目前实际总是空）优先；否则退到最近一单的收货人手机号。
 * source==='order' 时调用方自己从原始 latestOrder.createdAt 取下单时间标注
 * 「最近一单收货人 · MM-DD」——不在这里带出来，免得这个只判「显示什么号」的函数
 * 又要操心「这行小字怎么拼」，两件事分开改不容易互相踩。
 */
export function userPhoneInfo(u: PhoneLike): UserPhoneInfo {
  if (u.phone) return { phone: u.phone, source: 'wechat' }
  if (u.latestOrder) return { phone: u.latestOrder.receiverPhone, source: 'order' }
  return null
}
