import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { getMemberSettings, updateMemberSettings, getCouponTemplates } from '../api/admin'
import Button from '../components/ui/Button'
import { toast } from '../components/ui/Toast'
import type { CouponTemplate, MemberSettings as MemberSettingsT } from '../types'

// ── 与服务端对齐的取值范围 ──────────────────────────────────────────────
// 路由层 zod（routes/admin/settings.ts memberSettingsSchema）越界直接 400；
// service 层 sanitize（services/member/settings.ts）越界则**静默回落默认值**，
// 店主填的数字会不声不响地变回 100/365。两边都不能指望，所以前端保存前自己拦一道。
const RATE_MIN = 1, RATE_MAX = 100
const DAYS_MIN = 1, DAYS_MAX = 3650
const RULES_MAX = 2000

const toYuan = (fen: number) => (fen / 100).toFixed(2)
/** 只认纯十进制整数：'12.5' / '1e3' / '' / ' ' 一律判非法，不做四舍五入替店主猜 */
const parseIntStrict = (v: string): number | null => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null)

type FormState = {
  enabled: boolean
  earnRate: string
  validDays: string
  /** '' = 不发新客券（对应服务端 templateId: null） */
  templateId: string
  rulesText: string
}
type FieldKey = 'earnRate' | 'validDays' | 'rulesText'

const inputBase = 'w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const inputCls = (bad?: string) => `${inputBase} ${bad ? 'border-red-400 bg-red-50' : 'border-gray-300'}`

const Field = ({ label, hint, error, children }: {
  label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode
}) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
  </div>
)

const tplLabel = (t: CouponTemplate) =>
  `${t.name}｜¥${toYuan(t.amount)}${t.threshold > 0 ? ` 满${toYuan(t.threshold)}可用` : ' 无门槛'}｜领后 ${t.validDays} 天有效`

export default function MemberSettings() {
  /** 服务端最新真值（sanitize 后的），顶部状态条和「未保存」判定都以它为准 */
  const [saved, setSaved] = useState<MemberSettingsT | null>(null)
  const [form, setForm] = useState<FormState>({ enabled: false, earnRate: '', validDays: '', templateId: '', rulesText: '' })
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({})
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  const [templates, setTemplates] = useState<CouponTemplate[]>([])
  const [tplLoading, setTplLoading] = useState(true)
  const [tplFailed, setTplFailed] = useState(false)

  const hydrate = (v: MemberSettingsT) => {
    setSaved(v)
    setForm({
      enabled: v.points.enabled,
      earnRate: String(v.points.earnRatePerYuan),
      validDays: String(v.points.validDays),
      templateId: v.newcomer.templateId === null ? '' : String(v.newcomer.templateId),
      rulesText: v.rulesText,
    })
    setErrors({})
  }

  const edit = (p: Partial<FormState>, clear?: FieldKey) => {
    setForm((f) => ({ ...f, ...p }))
    // 边改边把这一格的红字撤掉，省得店主在「已经改对了但还是红的」上纠结；保存时会重新校验
    if (clear) setErrors((e) => (e[clear] ? { ...e, [clear]: undefined } : e))
  }

  // 拉**全部** NEWCOMER 模板（不带 status 过滤）。只拉 ON 的话，一张被停用的模板
  // 与一张被删掉的模板在页面上长得一模一样，而这两件事的处理办法完全不同
  // （前者去「优惠券」页重新上架即可，后者只能改选别的）。
  // 下拉里仍然只提供上架中的（选一张停用的存下去等于配了个死配置）。
  const loadTemplates = () => {
    setTplLoading(true)
    getCouponTemplates({ source: 'NEWCOMER' })
      .then((list) => { setTemplates(list); setTplFailed(false) })
      .catch(() => { setTplFailed(true); toast.error('新客券模板加载失败') })
      .finally(() => setTplLoading(false))
  }

  // 没有 catch 的话接口一挂，页面就永远停在「加载中...」，店主只会以为后台坏了。
  useEffect(() => {
    getMemberSettings()
      .then(hydrate)
      .catch(() => { setLoadFailed(true); toast.error('会员设置加载失败，请刷新重试') })
    loadTemplates()
  }, [])

  if (loadFailed) {
    return (
      <div className="space-y-3">
        <h2 className="text-xl font-semibold text-gray-800">会员设置</h2>
        <div className="text-red-600">会员设置加载失败，请刷新页面重试。</div>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>重新加载</Button>
      </div>
    )
  }
  if (!saved) return <div className="text-gray-500">加载中...</div>

  const selectedId = form.templateId === '' ? null : Number(form.templateId)
  const onTemplates = templates.filter((t) => t.status === 'ON')
  const selectedTpl = selectedId === null ? null : (templates.find((t) => t.id === selectedId) ?? null)
  const selectedInList = selectedId !== null && onTemplates.some((t) => t.id === selectedId)

  /**
   * 新客券配置的**实时健康状态**。这是这一页最要紧的一块信息：
   * 「保存成功但新客一张券都收不到」是可达状态，而且从这个页面上原本完全看不出来
   * ——让它变成死配置的更常见路径是「当时选的是好的，后来在『优惠券』页顺手停用了」，
   * 那个操作根本不经过本页。所以状态必须常驻可见，而不是靠保存时校验。
   */
  const newcomerHealth: { level: 'off' | 'ok' | 'warn'; text: string } =
    selectedId === null
      ? { level: 'off', text: '当前不发新客券。新顾客注册后不会自动收到任何优惠券。' }
      : tplLoading
        ? { level: 'off', text: '模板加载中…' }
        : tplFailed
          ? { level: 'warn', text: '模板列表加载失败，暂时无法确认新客券是否生效。' }
          : selectedTpl === null
            ? { level: 'warn', text: `模板 #${selectedId} 已被删除（或类型已不是「新客券」）。新顾客注册后收不到任何券。` }
            : selectedTpl.status === 'OFF'
              ? { level: 'warn', text: `「${selectedTpl.name}」已停用。停用的模板发不出券——新顾客注册后收不到任何券。` }
              : { level: 'ok', text: `生效中：新顾客注册后会自动收到「${selectedTpl.name}」。` }
  // 选中的模板不在「NEWCOMER 且上架中」列表里：可能已下架/已删，也可能只是列表没加载出来。
  // 两种情况都得补一个 option，否则 <select> 会显示成第一项「不发新客券」，
  // 而 form.templateId 其实还是旧 id —— 看到的和会保存的不是一回事。
  const strayId = selectedId !== null && !selectedInList ? selectedId : null
  const strayText = tplLoading
    ? '模板加载中…'
    : tplFailed
      ? '模板列表加载失败，暂不可更改'
      : selectedTpl
        ? `${selectedTpl.name}（已停用）`
        : '已删除'

  const rateNum = parseIntStrict(form.earnRate)
  const ratePreview = rateNum !== null && rateNum >= RATE_MIN && rateNum <= RATE_MAX
    ? `例：实付 ¥58.50 的一单得 ${58 * rateNum} 分（按实付金额取整到元，不足 1 元的零头不计分）`
    : `${RATE_MIN}–${RATE_MAX} 的整数。默认 100，即 1 元 = 100 分`

  const dirty =
    form.enabled !== saved.points.enabled ||
    form.earnRate !== String(saved.points.earnRatePerYuan) ||
    form.validDays !== String(saved.points.validDays) ||
    form.templateId !== (saved.newcomer.templateId === null ? '' : String(saved.newcomer.templateId)) ||
    form.rulesText !== saved.rulesText

  const handleSave = async () => {
    // 前端先拦一道：范围与服务端 zod 完全一致，非法值根本不发请求
    const next: Partial<Record<FieldKey, string>> = {}
    const rate = parseIntStrict(form.earnRate)
    if (rate === null || rate < RATE_MIN || rate > RATE_MAX) next.earnRate = `请填 ${RATE_MIN}–${RATE_MAX} 之间的整数`
    const days = parseIntStrict(form.validDays)
    if (days === null || days < DAYS_MIN || days > DAYS_MAX) next.validDays = `请填 ${DAYS_MIN}–${DAYS_MAX} 之间的整数（天）`
    if (form.rulesText.length > RULES_MAX) next.rulesText = `最多 ${RULES_MAX} 字，当前 ${form.rulesText.length} 字，请删掉 ${form.rulesText.length - RULES_MAX} 字`
    setErrors(next)
    if (Object.keys(next).length > 0) { toast.error('有填写不合法的项，已标红，未提交'); return }

    setSaving(true)
    try {
      // 服务端 PUT 是整包覆盖（照抄 printer 的写法）：必须先取一次完整对象当底稿，
      // 只把本页的字段叠上去再写回。日后 MemberSettings 加了本页管不到的字段时，
      // 直接提交本地表单会把那些字段一起抹掉。
      let fresh: MemberSettingsT
      try {
        fresh = await getMemberSettings()
      } catch {
        toast.error('读取最新设置失败，本次未保存，请刷新后重试')
        return
      }
      const payload: MemberSettingsT = {
        ...fresh,
        points: { ...fresh.points, enabled: form.enabled, earnRatePerYuan: rate!, validDays: days! },
        newcomer: { ...fresh.newcomer, templateId: selectedId },
        rulesText: form.rulesText,
      }
      // 用返回值回填：服务端 sanitize 过（比如 rulesText 会被截断），显示真值而不是我提交的值
      hydrate(await updateMemberSettings(payload))
      toast.success('已保存')
    } catch (err) {
      toast.error((err as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-500">修改积分和新客券后，需要保存才会对顾客侧生效。</p>
        <div className="flex items-center gap-2">
          {dirty && <span className="text-xs text-amber-700">有未保存的修改</span>}
          <Button loading={saving} onClick={handleSave}>{saving ? '保存中...' : '保存'}</Button>
        </div>
      </div>

      {/* 积分默认是关的（服务端 DEFAULT_MEMBER_SETTINGS.points.enabled=false），要店主自己打开，
          所以「现在到底发不发分」必须一眼可见，而且看的是服务端真值、不是表单里还没保存的勾选 */}
      <div className={`rounded-md border p-3 text-sm ${saved.points.enabled
        ? 'bg-green-50 border-green-200 text-green-800'
        : 'bg-gray-50 border-gray-200 text-gray-600'}`}>
        <p className="font-medium">
          当前状态：积分{saved.points.enabled ? '发放中' : '未开启'}
        </p>
        <p className="mt-0.5 text-xs">
          {saved.points.enabled
            ? `每消费 1 元得 ${saved.points.earnRatePerYuan} 分，有效期 ${saved.points.validDays} 天。`
            : '顾客消费不会产生新积分（已有积分不受影响）。'}
          {dirty && <span className="text-amber-700">　改动尚未保存，点右上角「保存」后才生效。</span>}
        </p>
      </div>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">积分发放</h3>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => edit({ enabled: e.target.checked })}
            className="w-4 h-4"
          />
          开启积分发放（顾客订单完成后按下面的比例得分）
        </label>
        {/* PO 逐字定的语义，别改写：关开关只停「发」，不动顾客手里已有的分 */}
        <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600">
          关闭后不再发放新积分；顾客<strong className="font-semibold text-gray-800">已有</strong>的积分仍然可以正常兑换券、加购赠品，直到自然过期。
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="每消费 1 元得分" hint={ratePreview} error={errors.earnRate}>
            <input
              className={inputCls(errors.earnRate)}
              type="number" inputMode="numeric" min={RATE_MIN} max={RATE_MAX} step={1}
              value={form.earnRate}
              onChange={(e) => edit({ earnRate: e.target.value }, 'earnRate')}
            />
          </Field>
          <Field
            label="积分有效期（天）"
            hint={`${DAYS_MIN}–${DAYS_MAX}，默认 365。从最后一次消费起算：顾客每下一单，账上未过期的积分到期日一起顺延（只延后、不提前），改这里不会缩短顾客已有积分的有效期。`}
            error={errors.validDays}
          >
            <input
              className={inputCls(errors.validDays)}
              type="number" inputMode="numeric" min={DAYS_MIN} max={DAYS_MAX} step={1}
              value={form.validDays}
              onChange={(e) => edit({ validDays: e.target.value }, 'validDays')}
            />
          </Field>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-gray-800">新客券</h3>
          <Button size="sm" variant="ghost" onClick={loadTemplates} title="重新拉取新客券模板">
            <RefreshCw className={`w-4 h-4 ${tplLoading ? 'animate-spin' : ''}`} />刷新模板
          </Button>
        </div>
        <Field
          label="新客首单券"
          hint="新顾客第一次微信登录时自动发一张，每人只发一次。只能选来源为「新客券」且上架中的模板。"
        >
          <select
            className={inputCls()}
            value={form.templateId}
            disabled={tplFailed}
            onChange={(e) => edit({ templateId: e.target.value })}
          >
            <option value="">不发新客券</option>
            {onTemplates.map((t) => (
              <option key={t.id} value={String(t.id)}>{tplLabel(t)}</option>
            ))}
            {strayId !== null && <option value={String(strayId)}>{`模板 #${strayId}（${strayText}）`}</option>}
          </select>
        </Field>
        {tplFailed && (
          <p className="text-xs text-red-600">
            模板列表加载失败，暂时无法更改新客券（其余项仍可保存，会原样带回当前模板）。
            <button onClick={loadTemplates} className="underline ml-1">重试</button>
          </p>
        )}
        {/* 健康状态条常驻。三态各有各的处理办法，文案里直接写出来——
            店主看到告警时最需要的是「那我现在该点哪儿」，不是「出错了」。 */}
        <div
          className={`text-xs rounded-md px-3 py-2 border ${
            newcomerHealth.level === 'ok'
              ? 'bg-green-50 border-green-200 text-green-700'
              : newcomerHealth.level === 'warn'
                ? 'bg-amber-50 border-amber-300 text-amber-800'
                : 'bg-gray-50 border-gray-200 text-gray-500'
          }`}
        >
          {newcomerHealth.level === 'ok' ? '✅ ' : newcomerHealth.level === 'warn' ? '⚠️ ' : ''}
          {newcomerHealth.text}
          {newcomerHealth.level === 'warn' && (
            <>
              {' '}
              请到 <Link to="/promotion/coupons?source=NEWCOMER" className="underline">「优惠券」</Link> 页把它重新上架，
              或在上面改选别的模板 / 改成「不发新客券」。
            </>
          )}
        </div>
        {!tplFailed && !tplLoading && onTemplates.length === 0 && strayId === null && (
          <p className="text-xs text-gray-500">
            还没有上架中的新客券模板。先到 <Link to="/promotion/coupons?source=NEWCOMER" className="underline">「优惠券」</Link> 页新建一个来源为「新客券」的模板并上架，再回来选。
          </p>
        )}
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">规则说明补充文案</h3>
        <Field
          label="补充说明"
          hint="会显示在小程序『会员中心 → 积分规则』说明的末尾。留空则只显示系统默认的规则说明。"
          error={errors.rulesText}
        >
          <textarea
            className={inputCls(errors.rulesText)}
            rows={6}
            value={form.rulesText}
            placeholder="例：积分不可折现、不可转赠；活动期间的额外赠分以活动页说明为准。"
            onChange={(e) => edit({ rulesText: e.target.value }, 'rulesText')}
          />
        </Field>
        <p className={`text-xs text-right ${form.rulesText.length > RULES_MAX ? 'text-red-600' : 'text-gray-400'}`}>
          {form.rulesText.length} / {RULES_MAX} 字
        </p>
      </section>

      <div className="flex justify-end">
        <Button loading={saving} onClick={handleSave}>{saving ? '保存中...' : '保存'}</Button>
      </div>
    </div>
  )
}
