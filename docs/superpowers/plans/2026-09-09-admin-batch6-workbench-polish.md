# 后台工作台 · 批次六：预约弹窗重量重报价、版本更新提示、邮寄卡尾号 —— 实施计划

> **工序 00 规划 · 模型 fable。** 改动等级 **M**（多文件 + 新增一个响应头，不动数据结构、不动支付/权限、无不可逆操作），链路 `fable → sonnet → haiku`。
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**原始需求**（店主 2026-09-09 三条反馈）：
1. 预约取件弹窗：默认重量已是订单重量，但店员手改重量后报价没有跟着刷新。要么输入后自动重报价，要么给个刷新按钮。
2. iPad 上的工作台只有「填单号发货」没有「预约取件」——查明是该标签页挂着好几天没重载、跑的还是旧版包；要让挂着的页面在发版后能知道并刷新。
3. 全国邮寄的卡片没像同城那样显示手机尾号。

**Goal:** 改重量后报价一定跟着变、店员看得见；后台发新版后挂着的页面会提示并（在回到前台时）自动刷新；邮寄卡与抽屉标题带手机尾号。

**Architecture:** ① 弹窗内：输入停顿 600 ms 或回车或失焦触发重报价，加「重新报价」按钮，报价行写明「按 X kg · 时间」，输入重量与已报价重量不一致时禁止提交。② 版本：服务端启动时取 git 短 SHA（或 `APP_VERSION` 环境变量）放到每个响应的 `X-App-Version` 头；后台构建时把同一个 SHA 编进包（vite `define`）；axios 响应拦截器比对，不一致就点亮全局标记，`VersionBanner` 在 Layout 与工作台头部显示「后台已更新，点击刷新」，标签页从后台切回前台时自动 `location.reload()`。③ nginx 给 `index.html` 加 `Cache-Control: no-cache`。④ 尾号：去掉两处 `local &&` 门控。

**Tech Stack:** React + Vite（admin）、Express（server，只加一个中间件与一个工具文件）、node:test（admin 单测）。无迁移、不动小程序、不动同城业务逻辑。

## 未决歧义（默认已定）

| # | 歧义 | 默认 |
|---|---|---|
| Q1 | 发现新版本后要不要在店员操作中途强制刷新？ | **不强制**。可见时只显示横幅（点击刷新）；只有标签页从隐藏切回可见那一刻自动刷新（此时没有进行中的操作） |
| Q2 | 版本号来源 | 服务端与后台都用 **git 短 SHA**（`git rev-parse --short HEAD`），拿不到时 `dev`；`dev` 与任何值都不算「不一致」，避免本地开发一直弹横幅 |
| Q3 | 重量输入触发重报价的时机 | 停顿 600 ms 自动 + 回车 + 失焦 + 按钮四条路都通；同一重量在途时不重复请求 |

## Global Constraints

- **同城 LOCAL 行为零变化**（尾号本来就显示；其余改动不涉及同城逻辑）；**小程序零 diff**；**不加迁移**；**不改任何 API 的 body 形状**（只加响应头）。
- 版本比对规则：`isNewerVersion(build, server)` 仅当两者都非空、都不是 `'dev'`、且不相等时为真。
- 弹窗提交规则：`canSubmit` 必须额外要求「输入框重量（四舍五入到 0.1）=== 当前报价的 `weightKg`」且没有报价在途。
- nginx：`index.html` 返回 `Cache-Control: no-cache`；`/assets/` 保持 `immutable` 一年；加 location 时必须重复 `X-Frame-Options`/`X-Content-Type-Options`（nginx 的 `add_header` 在子 location 里不继承）。
- e2e 干净库 `SCHEDULER_DISABLED=true` 全量：断言只增不减（基线 **1504/0**）。
- 每次交接声明「当前工序 · 模型」。

## 允许修改的文件白名单

```
apps/admin/src/components/ExpressBookingModal.tsx
apps/admin/src/utils/weight.ts                      # 新建
apps/admin/src/utils/weight.test.ts                 # 新建
apps/admin/src/utils/version-compare.ts             # 新建（纯函数，不引用全局）
apps/admin/src/utils/version-compare.test.ts        # 新建
apps/admin/src/store/version.ts                     # 新建
apps/admin/src/components/VersionBanner.tsx         # 新建
apps/admin/src/components/Layout.tsx                # 仅挂 <VersionBanner/>
apps/admin/src/pages/Workbench.tsx                  # 仅挂 <VersionBanner/> + 两处尾号去 local 门控
apps/admin/src/api/client.ts                        # 响应拦截器读头
apps/admin/src/vite-env.d.ts                        # declare const __APP_VERSION__（文件不存在则新建）
apps/admin/vite.config.ts                           # define
apps/admin/package.json                             # 仅 test 脚本改为跑 src 下全部 *.test.ts
apps/server/src/utils/app-version.ts                # 新建
apps/server/src/app.ts                              # 仅加一个 setHeader 中间件（放在 cors 之后、支付回调之前）
scripts/nginx.conf                                  # admin server 块加 location = /index.html
docs/deployment.md                                  # nginx 段 + 「发版后旧页面」说明
docs/api.md                                         # 响应头一行
```

## 上报触发条件（执行方必须停下）

1. 需要改白名单外的任何文件（含 `apps/miniapp`、任何 `services/delivery/*`、`schema.prisma`、`e2e.d`）。
2. `npm test`/`tsc`/`build`/e2e 出现与本次改动无关的失败，且重跑仍红。
3. 发现 `usePendingOrders` 的轮询或任何页面因为响应拦截器改动而抛错/中断。
4. `git rev-parse` 在构建环境不可用且没有 `APP_VERSION` 时无法回落到 `dev`（构建失败）。

## 验收标准（只在这里定义）

| # | 命令 / 用例 | 期望 |
|---|---|---|
| A1 | `cd apps/server && npx tsc --noEmit` | 无输出、退出码 0 |
| A2 | `cd apps/admin && npx tsc --noEmit && npm test && npm run build` | tsc 干净；`npm test` ≥ 12 + 9 = 21 条 pass、0 fail；build 成功 |
| A3 | dev 服务器（3100）：`curl -sI http://localhost:3100/health \| grep -i x-app-version` | 有 `X-App-Version:` 头且值非空（本机为 git 短 SHA 或 `dev`） |
| A4 | `grep -c "local && card.receiver.phone" apps/admin/src/pages/Workbench.tsx` / `grep -c "尾号" apps/admin/src/pages/Workbench.tsx` | 0 / ≥ 2 |
| A5 | `cd apps/admin && APP_VERSION=b6test npm run build && grep -l "b6test" dist/assets/index-*.js` | 命中（版本编进包）；`grep -c "__APP_VERSION__" dist/assets/index-*.js` 为 0 |
| A6 | `grep -n -A4 "location = /index.html" scripts/nginx.conf` | 含 `Cache-Control "no-cache"`、`X-Frame-Options DENY`、`X-Content-Type-Options nosniff` |
| A7 | 干净库全量 `DB_NAME=food_shop_e2e bash scripts/e2e.sh` | `失败 0`，通过数 ≥ 1504 |
| A8 | `git diff main --stat -- apps/miniapp apps/server/src/services apps/server/prisma scripts/e2e.d` | 空 |
| A9 | 控制方浏览器走查（admin-3100 预览 + 3100 后端）：① 预约弹窗把重量 1.1 改成 3.5 后不点别处，600 ms 内出现「查价中…」，报价行变成「按 3.5 kg 刚查的价 · HH:mm」，列表价格变化；② 改成 0.05 → 红字「重量需在 0.1–50 kg」且不查价；③ 改重量后立刻点「确认预约」不会提交（按钮置灰或提示「等报价刷新」）；④ 后端以 `APP_VERSION=b6old` 启动、后台以 `APP_VERSION=b6new` 构建预览时，30 秒内顶部出现「后台已更新到新版本」横幅，点击刷新后页面重载；⑤ 邮寄卡片显示「尾号XXXX」，同城卡片不变 | 五项全过，截图留档 |

---

### Task 1: 预约弹窗——重量改动即重报价、刷新按钮、报价标签、提交守卫

**工序 01 执行 · sonnet。**

**Files:**
- Create: `apps/admin/src/utils/weight.ts`、`apps/admin/src/utils/weight.test.ts`
- Modify: `apps/admin/src/components/ExpressBookingModal.tsx`
- Modify: `apps/admin/package.json`（`"test": "node --test src/*.test.ts src/utils/*.test.ts"`）

**Interfaces:**
- Produces（`utils/weight.ts`）:
  ```ts
  export const WEIGHT_MIN_KG = 0.1
  export const WEIGHT_MAX_KG = 50
  /** 输入框字符串 → 四舍五入到 0.1 kg 的数；空/非数/越界 → null */
  export function normalizeWeightKg(input: string): number | null
  ```

- [ ] **Step 1: 先写测试 `apps/admin/src/utils/weight.test.ts`**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeWeightKg, WEIGHT_MIN_KG, WEIGHT_MAX_KG } from './weight.ts'

test('normalizeWeightKg：四舍五入到 0.1', () => {
  assert.equal(normalizeWeightKg('1.14'), 1.1)
  assert.equal(normalizeWeightKg('1.15'), 1.2)
  assert.equal(normalizeWeightKg(' 3.5 '), 3.5)
  assert.equal(normalizeWeightKg('50'), 50)
})
test('normalizeWeightKg：空、非数、越界都是 null', () => {
  assert.equal(normalizeWeightKg(''), null)
  assert.equal(normalizeWeightKg('abc'), null)
  assert.equal(normalizeWeightKg('0.04'), null)   // 四舍五入后 0.0 < 0.1
  assert.equal(normalizeWeightKg('50.01'), 50)     // 四舍五入后 50.0，仍在上限内
  assert.equal(normalizeWeightKg('50.06'), null)
  assert.equal(normalizeWeightKg('-1'), null)
  assert.equal(WEIGHT_MIN_KG, 0.1); assert.equal(WEIGHT_MAX_KG, 50)
})
```

- [ ] **Step 2: 跑 `cd apps/admin && node --test src/utils/weight.test.ts`** → 期望 `Cannot find module`。

- [ ] **Step 3: `apps/admin/src/utils/weight.ts`**

```ts
/** 预约弹窗的重量输入归一：与服务端 createBooking 的 `Math.round(w*10)/10` 同口径 */
export const WEIGHT_MIN_KG = 0.1
export const WEIGHT_MAX_KG = 50
export function normalizeWeightKg(input: string): number | null {
  const n = Number(input.trim())
  if (input.trim() === '' || !Number.isFinite(n)) return null
  const w = Math.round(n * 10) / 10
  if (w < WEIGHT_MIN_KG || w > WEIGHT_MAX_KG) return null
  return w
}
```

- [ ] **Step 4: 改 `ExpressBookingModal.tsx`**（以下按文件顺序；未提到的代码不动）

(a) import 增加 `import { normalizeWeightKg } from '../utils/weight'`；组件内增加：

```ts
  const inFlightWeight = useRef<number | null>(null)   // 同一重量的报价在途时不重复请求
  const debounceRef = useRef<number | null>(null)
```

(b) `load` 改为接受可选重量并记录在途：

```ts
  const load = useCallback(async (w?: number) => {
    if (w !== undefined && inFlightWeight.current === w) return
    inFlightWeight.current = w ?? null
    setLoading(true); setError('')
    try {
      …原有 try 体不变…
    } catch (e) { setError(apiMessage(e, '报价加载失败，可点「重新报价」重试')) }
    finally { setLoading(false); inFlightWeight.current = null }
  }, [orderId, kuaidicom])
```

(c) 替换原来的 `weightNum/weightValid/canSubmit/onWeightBlur` 四行为：

```ts
  const wNorm = normalizeWeightKg(weight)
  const weightValid = wNorm !== null
  const weightSynced = !!q && wNorm !== null && wNorm === q.weightKg
  const canSubmit = !!q && !!kuaidicom && !err && !busy && !loading && weightValid && weightSynced && chosen?.priceFen != null
  const requote = () => { if (wNorm !== null && q && wNorm !== q.weightKg) void load(wNorm) }
  // 输入停顿 600 ms 自动重报价；回车/失焦/按钮走同一个 requote。q 变了（一次报价刚落地）不再触发。
  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(requote, 600)
    return () => { if (debounceRef.current !== null) window.clearTimeout(debounceRef.current) }
  }, [weight])   // eslint-disable-line react-hooks/exhaustive-deps
```

(d) 重量输入行改为（一行两控件 + 状态字）：

```tsx
          <label className="wb__field"><span>重量（kg）</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="wb__input" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} onBlur={requote}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); requote() } }} />
              <button type="button" className="wb__btn wb__btn--ghost" onClick={requote} disabled={loading || !weightValid || weightSynced}>{loading ? '查价中…' : '重新报价'}</button>
            </span>
          </label>
          {!loading && !weightValid && <div className="wb__redbar">重量需在 0.1–50 kg</div>}
          {!loading && weightValid && !weightSynced && q && <div className="wb__muted">重量已改为 {wNorm} kg，正在按新重量重新报价…（报价刷新前不能提交）</div>}
```

(e) 「顾客付」那一行右侧的说明改为带重量与时间：

```tsx
          {q && <div className="wb__line"><span>顾客付</span><strong>¥{yuan(q.customerFeeFen)}</strong><span className="wb__muted">按 {q.weightKg} kg {q.fromSnapshot ? '取下单快照' : '刚查的价'} · {q.quotedAt ? new Date(q.quotedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }) : ''}</span></div>}
```

（`ExpressBookingQuotes.quotedAt` 已在 `types.ts` 中，若类型里没有则补 `quotedAt: string | null`——该文件不在白名单，若确实缺失则**停止回报**。）

(f) 报价列表加载态保留原样；报价失败时不清空 `q`（原代码已如此）。

- [ ] **Step 5: `package.json` test 脚本改为** `"test": "node --test src/*.test.ts src/utils/*.test.ts"`

- [ ] **Step 6: 验收 A2（tsc / test 应 12 + 2 = 14 / build）**

- [ ] **Step 7: Commit**

```bash
git add apps/admin/src/utils/weight.ts apps/admin/src/utils/weight.test.ts apps/admin/src/components/ExpressBookingModal.tsx apps/admin/package.json
git commit -m "预约弹窗：改重量后 600ms 自动重报价（回车/失焦/按钮同路）、重量未同步禁止提交、报价行写明重量与时间"
```

---

### Task 2: 版本更新提示 + nginx no-cache + 邮寄卡尾号 + 文档

**工序 01 执行 · sonnet。**

**Files:**
- Create: `apps/server/src/utils/app-version.ts`；Modify: `apps/server/src/app.ts`
- Create: `apps/admin/src/utils/version-compare.ts`、`.test.ts`、`apps/admin/src/store/version.ts`、`apps/admin/src/components/VersionBanner.tsx`
- Modify: `apps/admin/vite.config.ts`、`apps/admin/src/vite-env.d.ts`、`apps/admin/src/api/client.ts`、`apps/admin/src/components/Layout.tsx`、`apps/admin/src/pages/Workbench.tsx`
- Modify: `scripts/nginx.conf`、`docs/deployment.md`、`docs/api.md`

- [ ] **Step 1: 测试先行 `apps/admin/src/utils/version-compare.test.ts`**

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { isNewerVersion } from './version-compare.ts'

test('isNewerVersion：两边都有真实版本且不等才算新', () => {
  assert.equal(isNewerVersion('abc1234', 'def5678'), true)
  assert.equal(isNewerVersion('abc1234', 'abc1234'), false)
})
test('isNewerVersion：dev / 空 / undefined 一律不算', () => {
  assert.equal(isNewerVersion('dev', 'abc1234'), false)
  assert.equal(isNewerVersion('abc1234', 'dev'), false)
  assert.equal(isNewerVersion('abc1234', ''), false)
  assert.equal(isNewerVersion('abc1234', undefined), false)
  assert.equal(isNewerVersion('abc1234', null), false)
  assert.equal(isNewerVersion('', 'abc1234'), false)
})
```

- [ ] **Step 2: `apps/admin/src/utils/version-compare.ts`**

```ts
/** 服务端 X-App-Version 与本包编入版本的比对。'dev'（本地/取不到 git）永远不触发提示。 */
export function isNewerVersion(build: string, server: string | null | undefined): boolean {
  if (!build || !server || build === 'dev' || server === 'dev') return false
  return build.trim() !== server.trim()
}
```

- [ ] **Step 3: 服务端 `apps/server/src/utils/app-version.ts`**

```ts
/** 进程启动时取一次版本：APP_VERSION 环境变量 > git 短 SHA > 'dev'。放进每个响应的 X-App-Version 头，
 *  后台拿它和自己构建时编入的版本比对，发版后挂着的旧页面才能知道该刷新（2026-09-09 iPad 事件）。 */
import { execSync } from 'child_process'
function gitShort(): string | null {
  try { return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null } catch { return null }
}
export const APP_VERSION: string = (process.env.APP_VERSION ?? '').trim() || gitShort() || 'dev'
```

`app.ts`：在 `app.use(cors(...))` 之后、微信支付回调挂载之前加：

```ts
import { APP_VERSION } from './utils/app-version'
// 每个响应带版本头：后台据此发现自己是发版前的旧包（见 apps/admin/src/store/version.ts）
app.use((_req, res, next) => { res.setHeader('X-App-Version', APP_VERSION); next() })
```

并在启动日志 `[server] env:` 那行附近追加 `console.log(\`[server] version: ${APP_VERSION}\`)`（找到现有 `console.log('[server] env:` 所在处，加一行）。

- [ ] **Step 4: 后台构建编入版本**

`apps/admin/vite.config.ts`：

```ts
import { execSync } from 'node:child_process'
const gitShort = () => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } }
const APP_VERSION = (process.env.APP_VERSION ?? '').trim() || gitShort() || 'dev'
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  …原有 plugins/server 不变…
})
```

`apps/admin/src/vite-env.d.ts`（无则新建，有则追加）：

```ts
/// <reference types="vite/client" />
declare const __APP_VERSION__: string
```

- [ ] **Step 5: 全局标记与横幅**

`apps/admin/src/store/version.ts`（与 `store/auth.ts` 同一套 zustand `create`；先读 `store/auth.ts` 确认导入方式）：

```ts
import { create } from 'zustand'
import { isNewerVersion } from '../utils/version-compare'

export const BUILD_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

interface VersionState { serverVersion: string | null; outdated: boolean; noteServerVersion: (v: string | null | undefined) => void }
export const useVersionStore = create<VersionState>((set) => ({
  serverVersion: null,
  outdated: false,
  noteServerVersion: (v) => { if (!v) return; set({ serverVersion: v, outdated: isNewerVersion(BUILD_VERSION, v) }) },
}))
```

`apps/admin/src/api/client.ts` 响应拦截器成功分支改为：

```ts
  (res) => {
    useVersionStore.getState().noteServerVersion(res.headers?.['x-app-version'] as string | undefined)
    return res
  },
```

并在错误分支开头也读一次（401/500 的响应同样带头）：`if (err.response) useVersionStore.getState().noteServerVersion(err.response.headers?.['x-app-version'])`。import `useVersionStore`。

`apps/admin/src/components/VersionBanner.tsx`：

```tsx
import { useEffect } from 'react'
import { useVersionStore } from '../store/version'

/** 发版后挂着的旧页面：可见时只提示；从后台切回前台那一刻自动刷新（此时没有进行中的操作）。 */
export default function VersionBanner() {
  const outdated = useVersionStore((s) => s.outdated)
  useEffect(() => {
    if (!outdated) return
    const onVis = () => { if (document.visibilityState === 'visible') window.location.reload() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [outdated])
  if (!outdated) return null
  return (
    <div role="status" style={{ background: '#fff7e6', color: '#8a5a00', borderBottom: '1px solid #ffd591', padding: '6px 12px', fontSize: 13, display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'center' }}>
      <span>后台已更新到新版本，当前页面是旧版</span>
      <button type="button" onClick={() => window.location.reload()} style={{ border: '1px solid #8a5a00', borderRadius: 6, padding: '2px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer' }}>点击刷新</button>
    </div>
  )
}
```

挂载：`Layout.tsx` 在 `<header …>` 之前插入 `<VersionBanner />`；`Workbench.tsx`（它不在 Layout 内）：`export default function Workbench()` 的 `return (` 根元素是 `<div className={\`wb ${focus ? 'wb--focus' : ''}\`} data-theme=… ref={rootRef}>`（约 2160 行），在它的第一个子元素 `{isPhone ? (` 之前插入 `<VersionBanner />`。

- [ ] **Step 6: 尾号**——`Workbench.tsx` 两处 `{local && card.receiver.phone && <span className="wb__tail"> 尾号…` 改为 `{card.receiver.phone && <span className="wb__tail"> 尾号…`，并把 1028 行注释改为「骑手/快递员在柜台报的是手机尾号，两个渠道都要」。若 `local` 变量因此无引用，删除其声明。

- [ ] **Step 7: nginx 模板 `scripts/nginx.conf`**——admin server 块 `location / {` 之前插入：

```nginx
    # index.html 不缓存：发版后挂着的页面下一次重载必须拿到新 index（JS/CSS 走 /assets/ 的 immutable）。
    # 子 location 里写了 add_header 就不再继承 server 级的那两条安全头，必须重复。
    location = /index.html {
        add_header Cache-Control "no-cache";
        add_header X-Frame-Options DENY;
        add_header X-Content-Type-Options nosniff;
    }
```

- [ ] **Step 8: 文档**——`docs/api.md` 「通用约定」或响应头相关处加一行：「所有响应带 `X-App-Version`（git 短 SHA 或 `dev`），后台据此提示刷新」；`docs/deployment.md` nginx 段加 `location = /index.html` 说明 + 「发版后店员挂着的后台页面会在 30 秒内看到『后台已更新』横幅，切回前台自动刷新；本次上线前生产 nginx 要按模板补这一段」。

- [ ] **Step 9: 验收 A1、A2（test 应 14 + 7 = 21）、A3、A4、A5、A6、A8，再 A7 全量**

- [ ] **Step 10: Commit**

```bash
git add apps/server/src/utils/app-version.ts apps/server/src/app.ts apps/admin/src/utils/version-compare.ts apps/admin/src/utils/version-compare.test.ts apps/admin/src/store/version.ts apps/admin/src/components/VersionBanner.tsx apps/admin/vite.config.ts apps/admin/src/vite-env.d.ts apps/admin/src/api/client.ts apps/admin/src/components/Layout.tsx apps/admin/src/pages/Workbench.tsx scripts/nginx.conf docs/deployment.md docs/api.md
git commit -m "后台版本更新提示：服务端 X-App-Version 头 + 构建编入版本 + 横幅/切回前台自动刷新；nginx index.html no-cache；邮寄卡显示手机尾号"
```

---

### 收尾（工序 04 + 控制方走查 + 发布）

- **04 机械核对 · haiku**：A1、A2、A4、A5、A6、A8、提交数与白名单对照、`git status` 干净。
- **控制方走查 A9**（fable，浏览器预览）。
- `superpowers:finishing-a-development-branch`：ff 合入 main；主仓库根 tsc。
- **发布**（店主授权后）：先用 patch 脚本给生产 nginx 补 `location = /index.html`（备份 + `nginx -t`），再 `DEPLOY_REF=<sha> bash /home/ubuntu/deploy.sh`；发布后用 `curl -sI https://admin.yuegui-hotel.online/ | grep -i cache-control` 与 `curl -sI https://api.yuegui-hotel.online/health | grep -i x-app-version` 验证。
