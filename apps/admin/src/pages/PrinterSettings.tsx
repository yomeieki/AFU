import { useEffect, useState } from 'react'
import { PlusCircle, Trash2, RefreshCw, Send, Eraser } from 'lucide-react'
import {
  getPrinterSettings, updatePrinterSettings, bindPrinter, unbindPrinter, testPrinter,
  clearPrinterQueue, getPrinterStatus, getPrintJobs, retryPrintJob,
} from '../api/admin'
import Button from '../components/ui/Button'
import { CenterAction } from '../components/BusinessCenter'
import { toast } from '../components/ui/Toast'
import { confirmDialog } from '../components/ui/ConfirmDialog'
import type { PrinterChannel, PrinterEntry, PrinterHealthEntry, PrinterSettings as PrinterSettingsT, PrintJob } from '../types'
import { fmtDateTimeSec } from '../utils/time'

// ── 与服务端 sanitizePrinterSettings / validatePrinterSettings 对齐的前端校验范围 ──────────
// （见服务端 services/printer-settings.ts）：越界值会被后端悄悄回落默认，为避免店主填了才被
// 打回，这里用同样的上下限约束输入框，且保存前再夹一遍，不依赖 <input min/max> 本身完全生效。
const clampInt = (v: number, min: number, max: number, fb: number) =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb

const CHANNEL_LABEL: Record<PrinterChannel, string> = { LOCAL: '同城', EXPRESS: '邮寄' }
const STATE_LABEL: Record<PrinterHealthEntry['state'], string> = {
  ONLINE: '在线', ABNORMAL: '异常（缺纸/开盖）', OFFLINE: '离线', UNKNOWN: '未知', ERROR: '查询失败',
}
const STATE_CLS: Record<PrinterHealthEntry['state'], string> = {
  ONLINE: 'bg-green-50 text-green-700 border-green-200',
  ABNORMAL: 'bg-amber-50 text-amber-700 border-amber-200',
  OFFLINE: 'bg-red-50 text-red-700 border-red-200',
  UNKNOWN: 'bg-gray-50 text-gray-600 border-gray-200',
  ERROR: 'bg-red-50 text-red-700 border-red-200',
}
const JOB_STATUS_LABEL: Record<PrintJob['status'], string> = {
  PENDING: '待发送', SENDING: '发送中', SENT: '已发送', PRINTED: '已打印', FAILED: '失败', SKIPPED: '已跳过',
}
const JOB_STATUS_CLS: Record<PrintJob['status'], string> = {
  PENDING: 'text-gray-500', SENDING: 'text-blue-600', SENT: 'text-blue-600',
  PRINTED: 'text-green-600', FAILED: 'text-red-600', SKIPPED: 'text-gray-400',
}
const JOB_KIND_LABEL: Record<string, string> = {
  NEW_ORDER: '新单', REPEAT: '催单', CANCEL: '取消', REPRINT: '重打', TEST: '测试页',
  CANCEL_REQUEST: '申请取消', RESUME: '恢复制作',
}

const inputCls = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400'
const Field = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div>
    <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
)

export default function PrinterSettings() {
  const [s, setS] = useState<PrinterSettingsT | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)

  // 绑定表单：KEY 只用于这一次调用，提交后立即清空、不落进 s / 不回显
  const [bindForm, setBindForm] = useState({ sn: '', key: '', name: '' })
  const [binding, setBinding] = useState(false)

  const [statusMap, setStatusMap] = useState<Record<string, PrinterHealthEntry>>({})
  const [statusLoading, setStatusLoading] = useState(false)
  const [statusFailed, setStatusFailed] = useState(false)

  const [jobs, setJobs] = useState<PrintJob[]>([])
  const [jobsTotal, setJobsTotal] = useState(0)
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobsFailed, setJobsFailed] = useState(false)
  const [retryingId, setRetryingId] = useState<number | null>(null)
  const [busySn, setBusySn] = useState<string | null>(null)

  const hydrate = (v: PrinterSettingsT) => setS(v)

  const loadStatus = () => {
    setStatusLoading(true)
    getPrinterStatus()
      .then((list) => {
        setStatusMap(Object.fromEntries(list.map((e) => [e.sn, e])))
        setStatusFailed(false)
      })
      .catch(() => { setStatusFailed(true); toast.error('打印机状态查询失败') })
      .finally(() => setStatusLoading(false))
  }

  const loadJobs = () => {
    setJobsLoading(true)
    getPrintJobs()
      .then((r) => { setJobs(r.list); setJobsTotal(r.total); setJobsFailed(false) })
      .catch(() => { setJobsFailed(true); toast.error('打印记录加载失败') })
      .finally(() => setJobsLoading(false))
  }

  // 没有 catch 的话接口一挂，页面就永远停在「加载中...」，店主只会以为后台坏了。
  useEffect(() => {
    getPrinterSettings()
      .then(hydrate)
      .catch(() => { setLoadFailed(true); toast.error('打印机设置加载失败') })
    loadStatus()
    loadJobs()
  }, [])

  if (loadFailed) {
    return (
      <div className="space-y-3">
        <div className="text-red-600">加载失败，下拉重试。</div>
        <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>重新加载</Button>
      </div>
    )
  }
  if (!s) return <div className="text-gray-500">加载中...</div>

  const patch = (p: Partial<PrinterSettingsT>) => setS({ ...s, ...p })
  const patchPrinter = (sn: string, p: Partial<PrinterEntry>) =>
    setS({ ...s, printers: s.printers.map((e) => (e.sn === sn ? { ...e, ...p } : e)) })
  const toggleChannel = (sn: string, ch: PrinterChannel) => {
    const printer = s.printers.find((e) => e.sn === sn)
    if (!printer) return
    const has = printer.channels.includes(ch)
    // 两个渠道都不选没有意义（后端 sanitize 会把空列表自动补全成两个），前端直接不让点到「都不选」
    if (has && printer.channels.length === 1) { toast.error('至少保留一个渠道'); return }
    patchPrinter(sn, { channels: has ? printer.channels.filter((c) => c !== ch) : [...printer.channels, ch] })
  }

  // 坑 1 的实证点：保存前先取一次服务端最新设置作为底稿，只把本页editable 的字段覆盖上去，
  // 其余（尤其是 printers 里绑定/解绑动作可能已经改动过的部分）以最新值为准再叠加本页的编辑，
  // 不能直接把本地 s 整个提交——那样如果本地 s 落后于服务端，等于用旧值把新值覆盖掉。
  const handleSave = async () => {
    setSaving(true)
    try {
      let fresh: PrinterSettingsT
      try {
        fresh = await getPrinterSettings()
      } catch {
        toast.error('读取最新设置失败，本次未保存，请刷新后重试')
        return
      }
      const printers = fresh.printers.map((p) => {
        const edited = s.printers.find((e) => e.sn === p.sn)
        return edited
          ? { ...p, copies: clampInt(edited.copies, 1, 10, 1), channels: edited.channels.length ? edited.channels : (['LOCAL', 'EXPRESS'] as PrinterChannel[]) }
          : p
      })
      const payload: PrinterSettingsT = {
        ...fresh,
        enabled: s.enabled,
        printCancel: s.printCancel,
        offlineAlertMin: clampInt(s.offlineAlertMin, 1, 120, fresh.offlineAlertMin),
        repeat: {
          ...fresh.repeat,
          localAfterMin: clampInt(s.repeat.localAfterMin, 1, 60, fresh.repeat.localAfterMin),
          expressAfterMin: clampInt(s.repeat.expressAfterMin, 1, 60, fresh.repeat.expressAfterMin),
          everyMin: clampInt(s.repeat.everyMin, 1, 60, fresh.repeat.everyMin),
          maxTimes: clampInt(s.repeat.maxTimes, 0, 20, fresh.repeat.maxTimes),
        },
        printers,
      }
      hydrate(await updatePrinterSettings(payload))
      toast.success('已保存')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleBind = async () => {
    const sn = bindForm.sn.trim()
    const key = bindForm.key.trim()
    if (!sn) { toast.error('请填写打印机编号（SN）'); return }
    if (!key) { toast.error('请填写打印机绑定密钥（KEY）'); return }
    setBinding(true)
    try {
      const result = await bindPrinter({ sn, key, name: bindForm.name.trim() || undefined })
      hydrate(result)
      setBindForm({ sn: '', key: '', name: '' }) // KEY 只用这一次，成功与否都清空、不回显
      toast.success('绑定成功')
      loadStatus()
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '绑定失败'
      // §8b：42240 CONFIG 的文案容易被误读成「SN/KEY 填错」，其实常见原因是服务端环境变量
      // FEIE_USER/FEIE_UKEY 未配置——这里补一句提示，别让店主对着一模一样的报错反复重填。
      toast.error(msg.includes('未配置') ? `${msg}（若已确认 SN/KEY 无误，请联系技术检查服务端飞鹅密钥配置）` : msg)
    } finally {
      setBinding(false)
    }
  }

  const handleUnbind = async (p: PrinterEntry) => {
    const ok = await confirmDialog({
      title: '解绑打印机',
      content: `确认解绑「${p.name}」（${p.sn}）？仅从本地设置移除，不会调用飞鹅侧解绑；解绑后该渠道的新单不会再发到这台机器。`,
      danger: true,
    })
    if (!ok) return
    setBusySn(p.sn)
    try {
      hydrate(await unbindPrinter(p.sn))
      toast.success('已解绑')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '解绑失败')
    } finally {
      setBusySn(null)
    }
  }

  const handleTest = async (p: PrinterEntry) => {
    setBusySn(p.sn)
    try {
      const r = await testPrinter(p.sn)
      toast.success(r.enqueued ? '测试页已发送，请查看该打印机是否出票' : `未发送：${r.reason ?? '未知原因'}`)
      loadJobs()
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '发送测试页失败')
    } finally {
      setBusySn(null)
    }
  }

  const handleClearQueue = async (p: PrinterEntry) => {
    const ok = await confirmDialog({
      title: '清空云端队列',
      content: `将清空「${p.name}」（${p.sn}）云端待打印队列里的全部票（不能按单删）。仅在确认队列堆积了陈年旧单时使用。`,
      danger: true,
      confirmText: '清空',
    })
    if (!ok) return
    setBusySn(p.sn)
    try {
      await clearPrinterQueue(p.sn)
      toast.success('已清空该机云端队列')
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '清空失败')
    } finally {
      setBusySn(null)
    }
  }

  const handleRetryJob = async (job: PrintJob) => {
    setRetryingId(job.id)
    try {
      const r = await retryPrintJob(job.id)
      if (r.ok) toast.success(`已重试，当前状态：${JOB_STATUS_LABEL[r.status as PrintJob['status']] ?? r.status}`)
      else toast.error(r.reason === 'NOT_RETRYABLE' ? '仅失败状态的打印记录可重试' : r.reason === 'CONCURRENT' ? '打印记录状态已变化，请刷新' : '重试失败')
      loadJobs()
    } catch (e) {
      toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? '重试失败')
    } finally {
      setRetryingId(null)
    }
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <CenterAction>
        <Button loading={saving} onClick={handleSave}>{saving ? '保存中...' : '保存'}</Button>
      </CenterAction>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-gray-800">总开关</h3>
          <label className={`inline-flex items-center gap-2 text-sm ${s.printers.length === 0 ? 'opacity-50' : ''}`}
            title={s.printers.length === 0 ? '请先绑定至少一台打印机' : ''}>
            <input
              type="checkbox"
              checked={s.enabled}
              disabled={s.printers.length === 0}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="w-4 h-4"
            />
            启用打印
          </label>
        </div>
        {!s.enabled && (
          <div className="rounded-md bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600">
            打印未启用，新订单不会出票。绑定打印机、勾选「启用打印」后点击右上角「保存」生效。
          </div>
        )}
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.printCancel} onChange={(e) => patch({ printCancel: e.target.checked })} className="w-4 h-4" />
          取消/退款也出提醒票
        </label>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-gray-800">打印机（{s.printers.length}/20）</h3>
          <Button size="sm" variant="ghost" onClick={loadStatus} title="重新查询在线状态">
            <RefreshCw className={`w-4 h-4 ${statusLoading ? 'animate-spin' : ''}`} />在线状态
          </Button>
        </div>
        {statusFailed && <p className="text-xs text-red-600">在线状态查询失败，下方状态可能不是最新的，点右上角重试。</p>}

        {s.printers.length === 0 ? (
          <p className="text-sm text-gray-500">尚未绑定任何打印机。</p>
        ) : (
          <div className="space-y-3">
            {s.printers.map((p) => {
              const health = statusMap[p.sn]
              const busy = busySn === p.sn
              return (
                <div key={p.sn} className="border border-gray-100 rounded-lg p-3 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-gray-800 truncate">{p.name}</span>
                      <span className="font-mono text-xs text-gray-400">{p.sn}</span>
                      {health && (
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${STATE_CLS[health.state]}`} title={health.raw}>
                          {STATE_LABEL[health.state]}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button size="sm" variant="secondary" loading={busy} onClick={() => handleTest(p)}>
                        <Send className="w-3.5 h-3.5" />测试页
                      </Button>
                      <Button size="sm" variant="secondary" loading={busy} onClick={() => handleClearQueue(p)}>
                        <Eraser className="w-3.5 h-3.5" />清空队列
                      </Button>
                      <Button size="sm" variant="danger" loading={busy} onClick={() => handleUnbind(p)}>
                        <Trash2 className="w-3.5 h-3.5" />解绑
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4">
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-gray-500">渠道</span>
                      {(['LOCAL', 'EXPRESS'] as PrinterChannel[]).map((ch) => (
                        <label key={ch} className="inline-flex items-center gap-1">
                          <input type="checkbox" checked={p.channels.includes(ch)} onChange={() => toggleChannel(p.sn, ch)} className="w-3.5 h-3.5" />
                          {CHANNEL_LABEL[ch]}
                        </label>
                      ))}
                    </div>
                    <label className="inline-flex items-center gap-1.5 text-sm">
                      <span className="text-gray-500">联数</span>
                      <input
                        type="number" min={1} max={10}
                        value={p.copies}
                        onChange={(e) => patchPrinter(p.sn, { copies: clampInt(Number(e.target.value), 1, 10, p.copies) })}
                        className="w-16 border border-gray-300 rounded-md px-2 py-1 text-sm"
                      />
                    </label>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <div className="rounded-md bg-gray-50 border border-gray-200 p-3 space-y-2">
          <p className="text-xs font-medium text-gray-600">绑定新打印机</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input className={inputCls} placeholder="打印机编号 SN" maxLength={32} value={bindForm.sn} onChange={(e) => setBindForm({ ...bindForm, sn: e.target.value })} />
            <input className={inputCls} placeholder="绑定密钥 KEY" maxLength={64} value={bindForm.key} onChange={(e) => setBindForm({ ...bindForm, key: e.target.value })} />
            <input className={inputCls} placeholder="名称（可选）" maxLength={64} value={bindForm.name} onChange={(e) => setBindForm({ ...bindForm, name: e.target.value })} />
          </div>
          <p className="text-xs text-gray-500">KEY 仅用于本次绑定调用，不会保存、不会回显。绑定成功后立即可用，若要「启用打印」请先绑定完成后再勾选并保存。</p>
          <Button size="sm" loading={binding} onClick={handleBind}><PlusCircle className="w-4 h-4" />绑定</Button>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">催单参数</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="同城首次延迟（分）" hint="1–60"><input className={inputCls} type="number" min={1} max={60} value={s.repeat.localAfterMin} onChange={(e) => patch({ repeat: { ...s.repeat, localAfterMin: Number(e.target.value) } })} /></Field>
          <Field label="邮寄首次延迟（分）" hint="1–60"><input className={inputCls} type="number" min={1} max={60} value={s.repeat.expressAfterMin} onChange={(e) => patch({ repeat: { ...s.repeat, expressAfterMin: Number(e.target.value) } })} /></Field>
          <Field label="重复间隔（分）" hint="1–60"><input className={inputCls} type="number" min={1} max={60} value={s.repeat.everyMin} onChange={(e) => patch({ repeat: { ...s.repeat, everyMin: Number(e.target.value) } })} /></Field>
          <Field label="最多重复次数" hint="0–20，耗尽后告警"><input className={inputCls} type="number" min={0} max={20} value={s.repeat.maxTimes} onChange={(e) => patch({ repeat: { ...s.repeat, maxTimes: Number(e.target.value) } })} /></Field>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <h3 className="font-medium text-gray-800">告警</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="离线告警阈值（分）" hint="1–120，连续离线超过此时长告警老板">
            <input className={inputCls} type="number" min={1} max={120} value={s.offlineAlertMin} onChange={(e) => patch({ offlineAlertMin: Number(e.target.value) })} />
          </Field>
        </div>
      </section>

      <section className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-gray-800">最近打印记录（最多 20 条，共 {jobsTotal}）</h3>
          <Button size="sm" variant="ghost" onClick={loadJobs}><RefreshCw className={`w-4 h-4 ${jobsLoading ? 'animate-spin' : ''}`} />刷新</Button>
        </div>
        {jobsFailed ? (
          <div className="text-sm text-red-600">打印记录加载失败，下拉重试。<button onClick={loadJobs} className="underline ml-1">重试</button></div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-gray-500">暂无打印记录</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-500">
                <tr>
                  <th className="text-left pb-1.5">订单号</th>
                  <th className="text-left pb-1.5">类型</th>
                  <th className="text-left pb-1.5">打印机</th>
                  <th className="text-left pb-1.5">状态</th>
                  <th className="text-left pb-1.5">失败原因</th>
                  <th className="text-left pb-1.5">时间</th>
                  <th className="text-right pb-1.5">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="py-1.5 font-mono text-gray-700">{j.orderNo}</td>
                    <td className="py-1.5 text-gray-600">{JOB_KIND_LABEL[j.kind] ?? j.kind}</td>
                    <td className="py-1.5 font-mono text-gray-500">{j.printerSn || '—'}</td>
                    <td className={`py-1.5 font-medium ${JOB_STATUS_CLS[j.status]}`}>{JOB_STATUS_LABEL[j.status]}</td>
                    <td className="py-1.5 text-gray-500 max-w-[16rem] truncate" title={j.lastError ?? ''}>{j.lastError ?? '—'}</td>
                    <td className="py-1.5 text-gray-400 whitespace-nowrap">{fmtDateTimeSec(j.createdAt)}</td>
                    <td className="py-1.5 text-right">
                      {j.status === 'FAILED' && (
                        <Button size="sm" variant="secondary" loading={retryingId === j.id} onClick={() => handleRetryJob(j)}>重试</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
