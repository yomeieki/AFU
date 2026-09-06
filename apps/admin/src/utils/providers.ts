/**
 * 运力编码 → 中文名。快递100 的 kuaidicom 编码，与回调里带回的中标运力同一套。
 *
 * 服务端另有一份同表（services/delivery/state.ts 的 PROVIDER_LABEL），供事件文案与
 * 告警用。两处都只是**显示层**：唯一真相是 server services/local-settings.ts 的
 * KD100_PROVIDERS，编码本身以那份为准。
 *
 * 自贡实测只有 4 家有覆盖（达达/蜂鸟/顺丰同城/闪送），另外三家不返报价——但仍然全部
 * 收录：编码是全国通用的，将来它们进自贡时不该还要来改这张表。
 */
export const PROVIDER_LABEL: Record<string, string> = {
  dadatongcheng: '达达',
  fengniaotongcheng: '蜂鸟',
  shunfengtongcheng: '顺丰同城',
  shansongtongcheng: '闪送',
  meituantongcheng: '美团',
  uupaotui: 'UU跑腿',
  gxdtongcheng: '裹小递',
}

/** 未收录的编码原样返回——不猜、也不显示成空白（空白会让店员以为数据丢了） */
export function providerLabel(code: string | null | undefined): string {
  if (!code) return '—'
  return PROVIDER_LABEL[code] ?? code
}

/** 呼叫方式的人话。null = 策略上线前的历史单，那时一律并呼 */
export function callStrategyLabel(
  strategy: string | null | undefined,
  calledProviders: string[] | null | undefined,
  courierCompany?: string | null,
): string {
  const n = calledProviders?.length ?? 0
  switch (strategy) {
    case 'SOLO':
      return `只呼最低价（${providerLabel(calledProviders?.[0] ?? courierCompany)}）`
    case 'SOLO_HELD':
      return `只呼最低价（${providerLabel(calledProviders?.[0])}）· 已放弃自动并呼`
    case 'ALL':
      return `并呼 ${n || '全部'} 家`
    case 'MANUAL':
      return `指定 ${(calledProviders ?? []).map(providerLabel).join('、') || '—'}`
    default:
      return '并呼（旧）'
  }
}
