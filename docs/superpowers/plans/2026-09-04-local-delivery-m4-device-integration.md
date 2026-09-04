# 同城配送 M4：真机联调、订阅消息、文档同步与收尾 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行本计划。步骤用 checkbox（`- [ ]`）语法追踪。
> **前置**：M1（渠道与数据基础）、M2-A（配送引擎）、M2-B（接单工作台）、M3（小程序顾客端）已全部合入。本计划**只写 M4**：真机真钱联调、订阅消息模板、文档同步、以及 M3 遗留的收尾项；**不新增顾客端功能**。
> **本文档性质**：这是一份**规划文档**，由 Principal Engineer 角色撰写，本身不修改任何 `apps/` 代码。文档里给出的代码片段是给未来执行者（人或 subagent）的实施依据，执行时机在本计划被启动之后。

**Goal:** 让 M1–M3 已经写好的同城配送顾客端代码，在真机、真实运力（快递100）、真实小额资金下完整跑通一次，收口 M3 评审遗留的 F5–F8 与两个悬而未决的架构问题（幂等下单、骑手实时距离展示），并把设计文档、店员手册、API 文档、部署文档同步到「已上线」状态——使这条同城配送通道具备可以让店主自己验收上架的完整证据链。

**Non-goals（详见文末《明确不做》）：** 不做任何新顾客端功能；不碰 M2-B 工作台/打印机（已合入，遗留项另案）；不做二期项（预约配送、多骑手拆单等，spec §12）；不做后台 RBAC；不引入新运力。

---

## 现状快照 2026-09-04 晚

- **F1–F4**：已合入（`055c57d` + `22633d3`）；静态 VERIFY 过，F1/F3/F4 开发者工具/真机终判仍折入 Task 6。
- **F5/F6**：已关（`55a20a2`）+ 同城配送入口提前隐私（`c99ecb8` / `b5496c9` / `54386ab` 等）+ **PO DevTools 签收**。
- **F7**：已关（`81a003b`）。
- **F8**：脚本侧 AS1 / 全角括号修复（`e96ef3b` + `1714889`）；§34 曾绿；全量套件**非幂等**（第二轮 496/32、另一次崩溃）——**挂起 / open**，不阻塞 M4 文档任务；**禁止**把 spec §10 写成双绿 ✅。
- **封面页**：仍属 **PO 桌面轨**（见 `docs/superpowers/briefs/2026-09-04-cover-page.md`），**不在本 M4 计划范围内**。
- **本文件角色**：规划文档同步前置现实；Goal / Non-goals 不变。执行 Task 时以本表为准，勿按「写计划时」的 open 假设重做 F5–F7。

---

## Prerequisites（M3 Exit Criteria —— 必须先确认，未确认的先去确认，不要带着假设进 Task）

| # | 条件 | 现状（2026-09-04 晚核实） | 未满足时怎么办 |
|---|---|---|---|
| P1 | M3 Critical/Major F1–F4 已修复 | ✅ 已合入：`055c57d`（F1–F4 首轮）+ `22633d3`（F1 残留）。`docs/superpowers/reviews/2026-09-04-m3-F1-F4-VERIFY.md` 给出 F2/F3/F4 静态 PASS，F1 首轮 PARTIAL、残留已在 `22633d3` 补上 | 若执行时发现残留未合，先补齐再继续，不要绕过 |
| P2 | F1/F3/F4 的**开发者工具/真机验证** | 静态 VERIFY 已过；F1/F3/F4 三条最终判定仍应按 VERIFY 原文在开发者工具/真机再跑一遍（与 F5/F6 的 PO DevTools 签收分开记） | 折入本计划 **Task 6**（真机联调）的验收清单第一批，不单独起任务 |
| P3 | F5–F8 | ✅ **F5/F6 已关**：`55a20a2`（隐私 `buttonId` + 骑手卡距离语义）+ 同城入口提前隐私门（`c99ecb8` / `b5496c9` / `54386ab` 等）+ **PO DevTools 签收**；✅ **F7 已关**：`81a003b`；⚠️ **F8 挂起**（见 P5 / Task 3）——不阻塞 M4 文档类任务 | F5–F7 勿再重做；F8 留在 **Task 3**，未双绿前不要改 spec §10 |
| P4 | Task 0 地图探针（`<map>` 模拟器/真机可用性） | `docs/superpowers/notes/2026-09-04-map-probe.md` 两行仍是「待补测」。**F6 静态方案已先落地**（删误导距离 / `cover-view`→`view`），不再阻塞 F6；探针结论只决定是否升级为真 `<map>` | 本计划 **Task 2**；不再写「必须先于 F6」——可选升级路径 |
| P5 | e2e 第 34 段（顾客端字段契约锁）+ 全量幂等（F8） | 脚本 AS1 / 全角括号修复已合入：`e96ef3b` + `1714889`；**§34 曾跑绿**；全量套件**非幂等**（第二轮约 496/32，另一次崩溃）——**F8 仍 open/挂起**。**不要**声称 §10 双绿 ✅ | 本计划 **Task 3**；挂起不阻塞 Task 7–11 文档同步；未两轮全绿前 **spec §10 保持诚实标注，勿改 ✅** |
| P6 | 快递100 已开户、认证、充值、`KD100_KEY/SECRET` 已配置（spec §11 用户侧待办 #1） | ✅ PO 口头确认 2026-09-04 晚；密钥不入仓，执行 Task 6 前在服务器系统状态页再绿检一次 | — |
| P7 | 公众平台位置接口权限、隐私保护指引已生效（`docs/miniapp-release-checklist.md` 2.4 已勾选） | ✅ 已确认（checklist 第 71/79/80 行） | — |
| P8 | 「配送通知」（310 配送中）订阅模板已获批并在生产可用 | ✅ PO 口头确认 2026-09-04 晚；Task 6 Step 5 真机收推送再验证 | — |

---

## Tasks

### Task 1：收口 M3 遗留 F5–F8（顾客端代码，唯一允许修改 customer M3 实现的例外）

**范围声明**：除本 Task 列出的 F5–F8 外，`apps/miniapp/pages/local/*`、`apps/miniapp/pages/order/{list,detail}.*`、`apps/miniapp/pages/address/list.*`、`apps/miniapp/pages/cart/*`、`apps/miniapp/pages/product/detail.*`、`apps/miniapp/components/privacy-popup/*` 一律**代码冻结**，不做任何顺手重构。

**Files:**
- Modify: `apps/miniapp/components/privacy-popup/{index.js,index.wxml}`（F5）
- Modify: `apps/miniapp/pages/order/detail.{js,wxml}`（F6）
- Modify: `apps/miniapp/pages/local/confirm.js`、`apps/miniapp/pages/local/index.js`、`apps/miniapp/pages/order/detail.js`（F7 minor 打包）

**状态（2026-09-04 晚）**：F5/F6/F7 **已完成并合入**（见下方各 Step 注记）；本 Task 顾客端代码收口项已关。F8（e2e §34 + 全量幂等）归 **Task 3**，仍挂起。标题保留「F5–F8」仅对应 REVIEW 编号，勿再按未做项重跑 F5–F7。

**依赖（历史）**：原计划写「F6 依赖 Task 2 地图探针」。实际执行时 F6 已按本计划静态方案先落地（`55a20a2`）；Task 2 剩下变为「是否升级真 `<map>`」，不再回改已关的 F6 Done 判据。

- [x] **Step 1（F5）：隐私弹窗补 `buttonId`** ✅ 已合入 `55a20a2`；同城入口提前隐私门另见 `c99ecb8` / `b5496c9` / `54386ab` 等；**PO DevTools 已签收**

对应 REVIEW `M4`/Fix Task `F5`。`apps/miniapp/components/privacy-popup/index.wxml` 的同意按钮加 `id="privacy-agree-btn"`；`index.js` 的 `onAgree` 改为 `resolve({ event: 'agree', buttonId: 'privacy-agree-btn' })`，`onDisagree` 保持 `{ event: 'disagree' }`。同时处理两个边界（REVIEW 原文指出的悬空 Promise 风险）：
1. 弹层可见时页面被 `onUnload` —— 卸载前若 `privacyResolve` 仍未决，调用 `resolve({ event: 'disagree' })` 再清空。
2. 第二个授权请求到来时覆盖了未决的 `privacyResolve` —— 覆盖前同样先 `resolve({ event: 'disagree' })`。

**Done（已满足）**：代码已合入；PO 已在开发者工具签收。Task 6 真机联调仍可把隐私全链路再过一遍作回归，但不再当作 F5 未完成阻塞项。

- [x] **Step 2（F6）：骑手卡距离语义 + `cover-view` 标签** ✅ 已合入 `55a20a2`（静态方案：去掉误导性距离文案；未等地图探针、未升真 `<map>`）

对应 REVIEW `M5`/Fix Task `F6`，同时回答 REVIEW **Open Question 2**：

> 「骑手距您约 x.x km」需要在顾客端做一次 haversine（骑手坐标 → 收货坐标），这与 Global Constraints 里「唯一允许的距离计算是地址列表那一处」字面冲突。

**本计划的决定（工程判断，非资金/隐私类决策，不升级给用户）：骑手卡不显示会变化的实时距离数字，只显示状态文案。** 理由：
1. 加一次顾客端 haversine 只为了一个「骑手距您约」的粗略数字，收益小；
2. 现状的「距门店 x.x km」是**订单常量**（`order.distanceM`），放在「骑手位置」标题下会被顾客误读成骑手实时距离，这是 REVIEW 指出的真实 bug，必须删；
3. 保留 Global Constraints 「距离计算只在地址列表出现一次」这条更简单的规则，比为了一个次要信息破例更省心。

具体改动（`apps/miniapp/pages/order/detail.wxml:64-73` 一带）：
```xml
<!-- 删除「距门店 {{order.distanceText}} km」这一行；<cover-view> 全部换成 <view>（无原生组件可覆盖，cover-view 在此处是超出官方定义的用法，真机行为未定义） -->
<view class="card courier-route-card" wx:if="{{order.isLocal && courierLoc && storeLoc}}">
  <view class="card-title">骑手位置</view>
  <view class="courier-route"> <!-- 原 cover-view 三点示意图，标签改 view，样式不变 --> </view>
  <text class="courier-route-status">{{order.courierStatusText}}</text>
</view>
```
`detail.js` 里删除任何引用 `order.distanceText` 渲染进这张卡片的代码（`distanceM` 在「同城配送信息卡」——`pages/order/detail.wxml` 另一处——继续保留，那里显示的是常量距离，语境正确，不动）。

**若 Task 2 的地图探针证明真机 `<map>` 可用**：把这张卡片从「三点示意图」升级为真 `<map>`（markers：门店/收货点/骑手，`latitude/longitude` 取骑手点，无骑手点取收货点），删除示意图相关 wxss；此时 `cover-view` 问题自动消失（`<map>` 上叠 `cover-view` 才是官方定义用法，但本方案不需要在地图上叠加任何东西，用原生 `markers` 即可）。

**Done（已满足）**：静态方案已合入 `55a20a2`。若 Task 2 探针后升级真 `<map>`，另开提交；不回滚本 Step。Task 6 可再验 `210`/`310` 卡片文案。

- [x] **Step 3（F7）：Minor 打包修复** ✅ 已合入 `81a003b`

对应 REVIEW Fix Task `F7`，一次提交，逐条列出（执行前先重新 diff 一遍确认状态，`22633d3` 已经顺手改了地址列表空胶囊那条，不要重复改）：

| REVIEW 编号 | 文件 | 修法 |
|---|---|---|
| m1 | `pages/local/confirm.js:196-199` | `_retriedRateLimit` 只在**报价成功**（`refreshQuote` 的 `.then` 分支）时复位为 `false`，否则限流重试永远只发生一次 |
| m3 | `pages/local/confirm.wxml:26-29` | 「重新获取运费」的 `bindtap` 从借道 `onSubmit` 改成独立方法 `onRetryQuote`（内容就是 `this.refreshQuote('retry')`），避免未来改 `onSubmit` 守卫顺序时静默改掉重试行为 |
| m4/m5 | `pages/local/confirm.js` `payAmount` 写入处 | `quoteError` 或 `blockReason` 生效时，`payAmount` 不写入新值（保留 `null`/上一次值由 wxml 判断隐藏），底部合计与配送信息块一起显示「运费计算中」或直接不显示合计行——两处必须**同步降级**，不能一半新一半旧 |
| m7 | `pages/local/index.js:186-208` | 加购后发现 `result.channel !== 'LOCAL'`（渠道不符兜底路径）时，补一次 `app.updateCartCount()`，避免 tabBar 角标与真实邮寄车不一致 |
| m8 | `pages/order/detail.js:513-534` | `onRequestCancel` 加在途守卫（`this._cancelling` 标志位，参考页面里已有的 `_cartMutating` 范式）防双击发两次 POST；`requestCancelOrder` 改为非 `silent`，或在 `.catch` 里对非 42229 的失败也 toast 一次「提交失败，请重试」 |
| m9 | `pages/order/detail.wxml:79` | `graceMin` 为空（`/local/meta` 拉取失败）时，整句「接单后 N 分钟内可申请取消」降级为不显示这句副文案，只保留服务端下发的 `localCancelDeadlineText`（本身够用） |
| m10 | `pages/order/detail.wxml:37` | `order.distanceM` 为 `null` 时整行「距门店 ×× km」隐藏（`wx:if` 加判断），不渲染成「距门店&nbsp;&nbsp;km」 |

**不在本次打包范围**：m2/m6（`/local/meta` 失败地址列表空白、`distanceSource` 未使用）已被 F3 修复覆盖；m11/m12/m13 是防御性/测试覆盖类问题，分别归入 Task 3（m12，e2e §34）与本表之外的技术债，若顺手可修但不是 Done 判据。

**Done（已满足）**：`81a003b` 打包合入；勿重复改已修项（含 `22633d3` 已覆盖的地址列表空胶囊）。

- [x] **Step 4：提交** ✅ 实际提交拆为 `55a20a2`（F5/F6）+ `81a003b`（F7）及隐私门相关提交；下方原 commit 文案仅作历史模板，勿再照抄重提

```bash
git add apps/miniapp/components/privacy-popup apps/miniapp/pages/order/detail.js apps/miniapp/pages/order/detail.wxml apps/miniapp/pages/local/confirm.js apps/miniapp/pages/local/index.js
git commit -m "fix(miniapp): M3 遗留收尾 F5-F7（隐私弹窗 buttonId/骑手卡距离语义/minor 打包）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2：地图能力真机探针 + `<map>` 方案定稿

**状态更新（2026-09-04 晚）**：原「必须先于 F6」约束已过时——F6 静态方案已落地。本 Task 现在只决定是否把骑手卡**升级**为真 `<map>`；探针未完成前保持现状示意图即可。

**Files:**
- Modify: `docs/superpowers/notes/2026-09-04-map-probe.md`
- Modify: `docs/superpowers/specs/2026-09-03-local-delivery-design.md`（§2.1 结论行）

- [ ] **Step 1：按 M3 计划 Task 0 原定步骤跑探针（当时被跳过，现在补）**

微信开发者工具新建一页只放：
```xml
<map style="width:100%;height:400px" latitude="29.339" longitude="104.778"
     markers="{{[{id:1,latitude:29.339,longitude:104.778,width:24,height:24}]}}" />
```
不配置任何腾讯位置服务 key。记录：模拟器能否渲染、Console 有无 key 相关报错、地图上有无水印或授权提示。

- [ ] **Step 2：真机预览同一页面**（模拟器与真机的地图实现不同，两边都要看，这正是 M3 遗漏至今的一步）

- [ ] **Step 3：按结论定稿并回填**

三选一：
- **可用** → 更新 `map-probe.md` 结论为「可用，Task 1/F6 升级为真 `<map>`」；回到 Task 1 Step 2 把三点示意图换成真 `<map>`。
- **有 key 限制** → 结论写清具体报错/限制现象；`docs/superpowers/specs/2026-09-03-local-delivery-design.md` §2.1 的「2026-09-04 暂定结论」改为「2026-09-XX 确认结论」；**这是需要用户拍板的点**——是否去 lbs.qq.com 申请个人开发者 key（免费额度足够单店，spec §2.1 已核实商业授权条款不适用于此场景）。写进《需用户拍板的点》一节，不擅自申请。
- **完全不可用** → 同上升级为需拍板项，且注明 Task 1/F6 的 `cover-view`→`view` 静态方案是最终方案，非过渡态。

**Done**：`map-probe.md` 四行结论从「待补测」全部变成已测（写明模拟器/真机各自的实际现象，不是「预期可用」这类猜测）；spec §2.1 结论行同步更新，不再出现「暂定」二字。

- [ ] **Step 4：提交**

```bash
git add docs/superpowers/notes/2026-09-04-map-probe.md docs/superpowers/specs/2026-09-03-local-delivery-design.md
git commit -m "docs(local-delivery): 地图真机探针补测结论定稿

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3：e2e §13 `AS1` 根因修复 + 第 34 段（顾客端字段契约锁）双轮验证（= REVIEW **F8**）

**状态（2026-09-04 晚）**：AS1 / 全角括号脚本修复已合入（`e96ef3b` + `1714889`）；**§34 曾跑绿**；全量套件**尚未幂等**（第二轮约 496/32，另一次崩溃）——**F8 挂起 / open**。不阻塞 Task 7–11 文档任务；**在两轮全绿之前，禁止把 spec §10 改成 ✅，也不要对外声称 dual-green**。下列 Step 仍是收口清单（已完成的脚本修复可勾选，双轮幂等未过则 Done 不算）。

对应 REVIEW **Open Question 3**：「e2e §13 的 `AS1` 中止是本轮引入的还是既有的？spec §10 写的是『既有 §13』。若是既有问题，第 34 段会一直是死代码。」

**Files:**
- Modify: `scripts/e2e.sh`（定位并修复 §13 `AS1` 中止原因；不改第 34 段的断言逻辑本身，除非跑起来后发现断言本身有 bug——REVIEW m12 提示 `jq .data.delivery` 在 `delivery` 为 `null` 时 `has()` 会报错而非返回 `false`，顺手核实）
- Modify: `docs/superpowers/specs/2026-09-03-local-delivery-design.md`（§10 表格 §34 行状态）

- [x] **Step 1：定位 §13 `AS1` 中止原因** ✅ 已定位（macOS bash 3.2 + `set -u` 下全角括号吞进变量名；另有 `#$AS1` / delivery null 等）

`bash scripts/e2e.sh` 完整跑一遍，定位到 §13 具体在哪一行、因为什么变量未绑定而中止（`set -u` 下常见于前置步骤的响应字段名对不上、或某个变量在条件分支里没有被赋值就被引用）。**先确认这是不是本计划 Task 1 的改动引入的新问题**——如果 Task 1 没碰服务端或 e2e 脚本，理论上不会是新引入的，但仍要跑一遍确认。

- [x] **Step 2：修复** ✅ 已合入 `e96ef3b` + `1714889`

按定位到的根因改。如果根因是"某个前置断言假设了一个在当前数据状态下不成立的字段"，优先修数据准备步骤而不是放宽断言。

- [x] **Step 3：核实第 34 段断言本身** ✅ delivery 非 null 防御已合入；§34 曾单轮跑绿

对照 REVIEW m12：`for k in ...; do assert_eq "delivery.$k 存在" "$(jq -r "has(\"$k\")" <<<"$(jq .data.delivery <<<"$R")")" "true"; done` 这类写法在 `data.delivery` 本身为 `null` 时，`jq .data.delivery` 输出 `null`，再 `jq -r 'has(...)'` 对 `null` 调用 `has` 会报错退出，而不是返回 `false`。第 34 段测的是 **LOCAL 订单**（`$LOCAL_ORDER_ID`），只要该订单在测试流程里已经产生了配送单（`delivery` 非 null），这条就不会触发；但为稳妥起见，在 §34 段落顶部加一行防御性检查：
```bash
D=$(jq .data.delivery <<<"$R")
if [ "$D" = "null" ]; then echo "FAIL: LOCAL_ORDER_ID 的 delivery 为空，前置数据准备有误"; exit 1; fi
```
让失败原因在这里就报清楚，而不是让 `jq has` 的报错信息把人导向错误的排查方向。

- [ ] **Step 4：连跑两轮验证幂等** ⚠️ **未通过 / F8 挂起**

```bash
bash scripts/e2e.sh
# 等 60 秒
bash scripts/e2e.sh
```
Expected：两轮全绿，总断言数 = 原有 + 第 34 段新增条数，两轮结果一致。

**实测（2026-09-04）**：§34 曾绿，但全量第二轮约 **496/32**，另一次崩溃——**非幂等**。本 Step 保持 open；修好前不要勾选，也不要推进 Step 5 的 §10 ✅。

- [ ] **Step 5：spec 回填** ⛔ **禁止提前**：在 Step 4 两轮全绿之前，**不要**把 §10 改成 ✅，也不要对外声称 dual-green。可如实注明「AS1 脚本已修、§34 曾单轮绿、全量幂等未过」。

- [ ] **Step 6：提交**

```bash
git add scripts/e2e.sh docs/superpowers/specs/2026-09-03-local-delivery-design.md
git commit -m "fix(e2e): 修复 §13 AS1 中止根因，第34段顾客端字段契约锁双轮验绿

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4：下单幂等键——决策与最小实现

对应 REVIEW **Open Question 4**：「`createOrder` 超时（10s）但服务端已落库时，顾客再点一次会产生第二张订单……同城场景的下单频率与金额都更高，是否值得在 M4 之前给 `POST /orders` 加一个客户端生成的幂等键？」

**本计划的建议（非资金类决策，工程判断）：值得做，且应该在 Task 6 真机真钱联调之前落地**——真机联调本身就是用真实网络环境点「提交」，弱网重复提交的概率不是理论风险。范围上**两个渠道统一实现**（不要只给 LOCAL 加）：改动集中在同一个 `POST /orders` 端点，按渠道拆两套逻辑反而更容易漂移，而且 EXPRESS 场景理论上有同样的重复下单风险，只是发生频率更低。

**Files:**
- Modify: `apps/server/src/routes/orders.ts`（`POST /orders` 入口）
- Modify: `apps/server/prisma/schema.prisma`（`Order` 加一列）+ 对应迁移
- Modify: `apps/miniapp/pages/order/confirm.js`、`apps/miniapp/pages/local/confirm.js`（生成并透传幂等键）
- Modify: `apps/miniapp/api/order.js`（`createOrder` 参数）
- Modify: `scripts/e2e.sh`（新增一段幂等断言）

- [ ] **Step 1：数据模型**

```prisma
model Order {
  // ...既有字段
  idempotencyKey String? @unique @map("idempotency_key") @db.VarChar(64)
}
```
迁移文件命名沿用既有惯例（`YYYYMMDDHHMMSS_add_order_idempotency_key`）。

- [ ] **Step 2：服务端**

`POST /orders` 入参增加可选 `idempotencyKey`（顾客端生成的 UUID v4，字符串）。处理顺序：
1. 若带 `idempotencyKey`，先 `findUnique({ where: { idempotencyKey } })`；命中且属于当前 `userId` → **直接返回该订单**（与首次创建同样的响应结构），不重复创建、不重复扣库存。
2. 命中但 `userId` 不符（理论上不该发生，除非键碰撞或伪造）→ 视为未命中，走正常创建流程但**不携带该 key**（避免让攻击者用他人订单的 key 探测）。
3. 未命中 → 正常创建，若客户端带了 key 就写入这一列。
4. 不带 `idempotencyKey` 的调用（旧版本小程序、其他调用方）行为完全不变。

不设 TTL／清理任务——`idempotencyKey` 是 `Order` 表自身的一列，随订单生命周期存在即可，不是独立的幂等表，没有额外的存储与清理成本。

- [ ] **Step 3：顾客端**

`api/order.js` 的 `createOrder` 增加参数透传。两个确认页在**每次进入结算流程时**（而不是每次点提交时）生成一个 `idempotencyKey` 存在 `this.data.idempotencyKey`，提交失败允许重试时复用同一个 key；只有当购物车内容/地址/报价重新走过一轮（即用户主动改了要下的单）才重新生成。

- [ ] **Step 4：e2e 验证**

新增一段：用同一个 `idempotencyKey` 连续调用两次 `POST /orders`，断言两次返回的 `orderId` 相同，且数据库里该 `idempotencyKey` 只对应一条订单（用既有的 `req`/`assert_eq` 范式，段号紧接第 34 段之后）。

**Done**：e2e 新断言绿；手工测试「点提交 → 立即再点一次（模拟弱网重复点击）」只产生一张订单；不带 `idempotencyKey` 的旧调用路径（如果测试脚本里有）行为不变。

- [ ] **Step 5：提交**

```bash
git add apps/server apps/miniapp/pages/order/confirm.js apps/miniapp/pages/local/confirm.js apps/miniapp/api/order.js scripts/e2e.sh
git commit -m "feat(orders): POST /orders 支持客户端幂等键，防弱网重复下单

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5：「已送达」订阅消息模板——申请与接入（可选，需用户拍板是否值得）

对应 M3 计划「明确不做」第 6 条与 spec §6：「『已送达』若要做，须新增模板 ID 加入下单页 `requestSubscribe` 列表」。

**这是一个需要先问用户的决策，不要预设答案就去申请模板**——多一条订阅消息意味着顾客下单时多一次授权弹窗（当前只在提交订单时一次性请求 310 的模板），转化率与顾客体验需要店主自己权衡。把决策放在《需用户拍板的点》一节，本 Task 只描述**如果做，怎么做**。

**Files:**
- Modify: `apps/server/src/services/subscribe-message.ts`
- Modify: `apps/server/src/routes/orders.ts`（`GET /orders/meta` 返回的模板 ID 列表）
- Modify: `apps/miniapp/pages/local/confirm.js`（`subscribeTemplateIds` 已有此机制，加一个新 ID 即可，无需改交互逻辑）
- Modify: `docs/wechat-platform-local-delivery-setup.md`（记录申请结果）

- [ ] **Step 1：用户侧——公众平台申请模板**

在微信公众平台「订阅消息」类目下搜索「已送达」/「配送完成」相关模板并申请；若已有的「配送通知」模板本身支持多状态复用（同一模板 ID，`thing`/`phrase` 字段填不同文案），优先复用而不新增模板 ID——**先确认这一点，能省一次用户额外授权**。

- [ ] **Step 2（若获批新模板）：服务端接入**

`services/subscribe-message.ts` 参考现有 310（配送中）发送逻辑，在 Delivery 进入 `DELIVERED`（520 回调落地处，`Order.status → COMPLETED` 的同一事务后）发送。字段映射避免出现「单号:」等敏感格式化文案（沿用 M2 已定的规则）。

- [ ] **Step 3：顾客端接入**

`GET /orders/meta` 的 `subscribeTemplateIds` 列表加入新模板 ID（服务端配置驱动，顾客端 `pages/local/confirm.js` 的 `requestSubscribe` 调用不用改代码，因为它已经是读这个列表去请求授权）。

- [ ] **Step 4：e2e/真机验证**

e2e 里 mock 一次 520 回调，断言触发了订阅消息发送调用（沿用 310 那条已有断言的写法）；真机验证挪到 Task 6，实际收到一条「已送达」推送。

**Done（若决定做）**：新模板 ID 配置在 env/设置里；e2e 断言绿；Task 6 真机验证收到推送。
**Done（若决定不做）**：`docs/superpowers/specs/2026-09-03-local-delivery-design.md` §6 那一行的表述从「若要做」改为「已评估，决定不做，原因：<用户给出的理由>」，明确关闭这个悬而未决项，不要让它一直挂着。

- [ ] **Step 5：提交（若做了代码改动）**

```bash
git add apps/server/src/services/subscribe-message.ts apps/server/src/routes/orders.ts apps/miniapp/pages/local/confirm.js docs/wechat-platform-local-delivery-setup.md
git commit -m "feat(notify): 已送达订阅消息模板接入（M4）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6：顾客端真机真钱联调（核心任务）

**前提**：Task 1–5 已完成（Task 5 至少已做出「做/不做」的决策），P6（快递100 已开户充值配置密钥）已满足。这是本计划里**唯一涉及真实资金与真实运力调用**的任务，执行前必须与用户确认预算与时间窗口（spec §11.5 估算约 2 单运费 + 可能 2 元取消费）。

**Files:**
- Create: `docs/superpowers/notes/2026-09-0X-m4-realdevice-log.md`（联调记录，含每一步的实际现象、截图清单、发现的问题）

- [ ] **Step 1：`batchPrice` 探测（只读，不产生费用）**

跑 `apps/server/scripts/kd100-probe.mjs`（M0 阶段准备的脚本），确认真实 key/secret 下能拿到覆盖运力与报价，记录 `discountFee` 实际含义与各运力重量限制是否与文档假设一致。

- [ ] **Step 2：隐私弹窗全链路（验证 Task 1/F5 修复）**

开发者工具/真机：清缓存 → 进地址编辑页 → 点地图选点 → 弹窗出现 → 拒绝 → 地图不打开且无报错 → 再点 → 再弹 → 同意 → **地图打开**（这是 `buttonId` 缺失最可能出问题的一步，F5 的验收判据就是这里）。

- [ ] **Step 3：F1/F3/F4 的真机验证（P2，从未跑过）**

- F1：确认页连点「+」若干次，按钮从第一下起就变「计算运费中…」且不可点，直到最后一次报价返回；底部合计不显示旧数字。
- F3：断网或让 `/local/meta` 返回异常，地址列表仍完整显示全部地址（无空白页），只是没有距离标签。
- F4：Network 面板确认配送单进入 `DELIVERED`/`CANCELLED` 后，`/orders/:id/courier` 不再被轮询。

- [ ] **Step 4：完整下单 1 单（真实小额，建议店主自己下单自己收货）**

从首页临时入口 → 同城菜单 → 加购 → 确认页选地址 → 报价 → 提交 → 支付 → 观察后台接单 → 呼叫骑手 → 骑手接单/到店/配送中/已送达在小程序订单详情页的呈现是否与设计一致（时间线节点、骑手卡文案——含 Task 1/F6 的改动、地图或状态卡、轮询自停）。**记录每一步的 `statusDesc` 实际文案与「回调到达 — 页面刷新」之间的时延**，这是 docs sync（Task 7/8）需要的真实素材，spec 里目前很多状态文案是基于官方文档推断，未经真实回调验证。

- [ ] **Step 5：310（配送中）订阅消息验证**

确认顾客确实收到一条「配送中」推送（P8 前提：模板已获批）；若做了 Task 5，同时验证「已送达」推送。

- [ ] **Step 6：立即取消 1 单（呼叫后马上取消，验证 `cancelFee`）**

后台呼叫骑手后立刻发起取消（`precancel` → `cancel`），记录实际产生的 `cancelFee` 金额与快递100 账单是否一致，同时验证顾客端「申请取消」窗口（`acceptGraceMin` 内）的完整交互——二次确认弹窗、提交后灰条、店员确认后全额退款到账。

- [ ] **Step 7：异常态展示**

若条件允许（例如故意选一个边界地址触发 `510`/`515`），验证顾客端中性文案「配送正在协调中，如超过预计时间请联系商家」；若无法真实触发，用后台 mock 端点（`POST /api/admin/system/kd100-mock/*`，注意这是 M3 F4-VERIFY 文档里纠正过的真实路径，不是设计稿里写的 `delivery-mock`）在真机上推状态验证展示，而不是只看模拟器。

- [ ] **Step 8：整理联调记录**

`docs/superpowers/notes/2026-09-0X-m4-realdevice-log.md` 写清楚：每一步的实际结果（含截图文件名清单，图片本身不必进仓库，路径记录即可）、发现的问题列表（区分「阻断顾客端体验，需要立即小修」与「体验瑕疵，可留到下一版」）。**若发现阻断性 bug，另开一个小的 fix 分支处理，不要在本计划内直接改**——本计划的性质是联调与文档，混进去一个未经评审的紧急修复会让这次联调的证据链失真。

**Done**：联调记录文件存在且信息完整；Step 2–3（F5 与 F1/F3/F4 真机验证）全部通过；Step 4 完整走完一单且顾客端呈现与设计一致；Step 6 的 `cancelFee` 有实际数字记录在案。

- [ ] **Step 9：提交（仅文档）**

```bash
git add docs/superpowers/notes/2026-09-0X-m4-realdevice-log.md
git commit -m "docs(local-delivery): M4 真机真钱联调记录

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7：docs sync —— `docs/order-flow.md` 同城状态表 + Order×Delivery 非法组合矩阵

**Files:**
- Modify: `docs/order-flow.md`（替换第 250-256 行「七、配送方式说明」一节里 LOCAL 那一行的占位描述）

- [ ] **Step 1：Delivery 状态机全表**

把 spec §5.3 的 rank 表（`PENDING 0 < CALLING 10 < ACCEPTED 20 < ARRIVING 30 < ARRIVED 40 < DELIVERING 50 < DELIVERED 100`，旁路态 `REASSIGNING/ABNORMAL/CANCELLED/FAILED/UNKNOWN`）整理成一张面向阅读者（而非实现者）的表格：状态、含义、进入条件、是否终态。

- [ ] **Step 2：Order × Delivery 合法/非法组合矩阵**

对照 spec §5.3 的 Order 侧白名单表（310/520/720/自送/标记送达/作废 六行），画一张矩阵：Order.status（行）× Delivery.status（列），标出哪些组合是合法在途状态、哪些是「唯二回拨」（N8 的 REASSIGNING→ACCEPTED、720 的 SHIPPED→PREPARING）、哪些理论上不该出现（例如 `Order.COMPLETED` 配 `Delivery.CALLING`）。这张矩阵是给后续排查线上异常数据用的，不是重复 spec，要落到「哪个组合出现在数据库里意味着哪里的代码出了 bug」这个用途上。

- [ ] **Step 3：核对 Task 6 联调记录里的实际文案**

把 Task 6 记录的真实 `statusDesc` 文案填进表格备注列，与文档原先基于官方文档推断的措辞对照，不一致的地方以真实回调为准。

**Done**：新增内容与 spec §5.3、§4（Delivery 模型定义）逐条对照无遗漏；一个没读过 spec 的人能靠这张表判断一条 `(Order.status, Delivery.status)` 组合是否正常。

- [ ] **Step 4：提交**

```bash
git add docs/order-flow.md
git commit -m "docs(order-flow): 补齐同城配送状态表与 Order×Delivery 组合矩阵

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8：docs sync —— `docs/staff-guide.md` 同城章节补全

**Files:**
- Modify: `docs/staff-guide.md`（扩充既有「六点五、同城配送」一节，该节当前只覆盖骑手异常处理）

- [ ] **Step 1：补「接单」在同城的含义**

用大白话说明：同城的「接单」= 开始备餐，和呼叫骑手是两件事（对应 D5 决策），「接单并呼叫」按钮是把两步合成一步的快捷方式；不要让店员误以为点了「接单」骑手就自动来了。

- [ ] **Step 2：补无人接单处理优先级**

对照 D4 决策原文，写成店员能照着做的顺序：加小费重呼 → 重新呼叫 → 店内自送 → 联系顾客后退款；说明「店内自送」是常规备选（每周都可能用到），不是走投无路才用的兜底。

- [ ] **Step 3：补门店坐标设置、暂停接单开关**

各配一小段「在哪里点、点了之后顾客端会看到什么」，与 `pages/merchant/index` 的一键定位、`LocalSettings.tsx` 的暂停开关一一对应。

- [ ] **Step 4：常见问题 FAQ**

用 Task 6 真机联调实际遇到的问题反哺（例如某个 `statusDesc` 文案店员会误解、取消费什么情况下会产生），不要凭空编。

**Done**：店员能凭这一节独立完成一次「来单 → 接单 → 呼叫 → 处理异常 → 送达」全流程操作，不需要问开发或看代码。

- [ ] **Step 5：提交**

```bash
git add docs/staff-guide.md
git commit -m "docs(staff-guide): 同城配送章节补全（接单语义/无人接单顺序/门店坐标/FAQ）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9：docs sync —— `docs/api.md` 同城章节校对

`docs/api.md` 附录 B（M1）、附录 C（M2）已经相当完整，本 Task 是**核对性质**，不是从零写。

**Files:**
- Modify: `docs/api.md`

- [ ] **Step 1：逐条核对附录 B/C 与当前代码行为**

重点核对 Task 4（幂等键，若已实现）与 Task 5（已送达模板，若已实现）引入的字段/参数是否已经补进 `POST /orders` 与 `GET /orders/meta` 的文档条目。

- [ ] **Step 2：补 M3 顾客端相关的响应字段说明**

附录 B/C 目前偏服务端视角（校验规则、错误码），`GET /orders/:id` 的 `delivery` 白名单字段虽在 §5.7/附录 C 有提，但顾客端 `canRequestCancel`/`cancelRequestDeadline` 这两个字段的语义值得单独一行说明（M3 计划 Task 7 依赖它们，api.md 里目前没有专门条目）。

- [ ] **Step 3：核对错误码表**

对照 spec §5.10 的完整错误码列表（42220–42239），确认 `docs/api.md` 里「附录」错误码表没有遗漏或过时的描述（可委托 subagent 做逐码 grep 核对，本 Task 只需给出核对结果）。

**Done**：`docs/api.md` 与当前 `apps/server/src/routes/*` 的实际行为逐条核对无出入；新增/变更字段（若 Task 4/5 落地）已补全。

- [ ] **Step 4：提交**

```bash
git add docs/api.md
git commit -m "docs(api): 同城配送章节校对补全（M4）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10：docs sync —— `docs/deployment.md` 补同城运维章节

**Files:**
- Modify: `docs/deployment.md`

- [ ] **Step 1：env 变量清单**

补 `KD100_KEY`、`KD100_SECRET`、`LOCAL_DELIVERY_PROVIDER_MOCK`、`PUBLIC_BASE_URL`（回调 URL 拼接用）在 `.env` 里的位置与填法，指向 `scripts/set-env.sh` / `scripts/import-secrets.sh`（沿用 spec §11.1 已验证过的填写方式，不要重新发明一套流程）。

- [ ] **Step 2：`callbackUrl` 长度预算表**

原样照抄 spec §5.5 的长度表格（`…/api/kd/D123456-1` 48 字符、最坏情况 49 字符、上限 50）与推论（域名换长必须同步缩短路径前缀），这是运维换域名时唯一会踩的坑，必须留在部署文档而不是只留在设计 spec 里。

- [ ] **Step 3：nginx 说明**

明确写「无需新增 location，`/api/kd/:deliveryNo` 走现有 `/api/` 前缀反代」，避免运维习惯性地为新路由加一条新配置。

- [ ] **Step 4：curl 回调演练脚本**

给一段可直接执行的 `curl` 示例，手工构造一条符合签名规则的表单 POST 到 `/api/kd/:deliveryNo`，用于新环境部署后确认回调链路通（不依赖等真实骑手触发一次回调才能验证）。示例基于 `scripts/e2e.sh` 里已有的 `kd_cb` 辅助函数改写成独立可执行的 shell 片段。

**Done**：按文档操作，能在一台新部署的服务器上，不看代码，独立完成「填 env → 重启 → curl 验证回调路径通」这一套动作。

- [ ] **Step 5：提交**

```bash
git add docs/deployment.md
git commit -m "docs(deployment): 补同城配送运维章节（env/回调长度预算/curl演练）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11：docs sync —— `docs/miniapp-release-checklist.md` 隐私一致性检查章节

**Files:**
- Modify: `docs/miniapp-release-checklist.md`

- [ ] **Step 1：新增独立小节「隐私与位置能力一致性检查」**

汇总目前分散在 2.4 节与「上架前自查」里的几处相关内容，做成一张一次性可勾的清单：`__usePrivacyCheck__` 是否开启、`requiredPrivateInfos` 是否仍只有 `chooseLocation`（不能悄悄多出 `getLocation`）、`config/legal.js` 的位置信息与第三方共享条款是否与 checklist 2.4 的勾选一致、隐私弹窗 `buttonId`（Task 1/F5）是否已修（防止未来有人改动位置相关代码时又漏掉这一环）。

- [ ] **Step 2：补一条「改动检查」提示**

在这个小节末尾加一句话性质的提醒：任何改动 `pages/address/edit`、`pages/merchant/index`、`pages/local/confirm` 里位置接口调用的 PR，都要重新走一遍这张清单——这是本节存在的意义，不是走一次流程就完事。

**Done**：按新章节走一遍，与当前实现（含 Task 1 的 F5 修复）逐条一致，没有「需重新评估」字样残留。

- [ ] **Step 3：提交**

```bash
git add docs/miniapp-release-checklist.md
git commit -m "docs(checklist): 新增隐私与位置能力一致性检查章节

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Risks

| 风险 | 影响 | 缓解 |
|---|---|---|
| Task 6 涉及真实资金与真实运力调用，快递100 无沙箱，一旦触发呼叫就是真实费用 | 若联调步骤出错（例如重复呼叫、忘记取消测试单），可能产生超预算的费用 | 严格按 Task 6 的步骤顺序执行，每一步先确认前一步的状态再继续；预算与用户提前对齐（spec §11.5：约 2 单运费 + 2 元取消费），超预算前暂停并知会用户 |
| Task 2 若探针证明 `<map>` 真机不可用/有 key 限制 | Task 1/F6 已投入的「删除误导性距离数字」工作不受影响，但「是否申请个人 key」是需要用户决定的事，拖延会让这条一直悬而未决 | 明确列入《需用户拍板的点》，Task 2 完成后立即向用户呈报结论，不要等到整份 M4 都做完才问 |
| Task 4（幂等键）改动的是 `POST /orders` 主路径，EXPRESS 与 LOCAL 共用 | 实现不当可能引入邮寄下单的回归 | 不带 `idempotencyKey` 的旧行为必须逐字不变（Step 2 已写明分支）；上线前用邮寄路径过一遍既有 e2e 全量回归，不能只跑新增的幂等断言 |
| Task 5（已送达模板）若申请被拒 | 顾客端已经写好读取 `subscribeTemplateIds` 列表的机制不会浪费，但需要明确关闭这条开放项 | 无论获批与否都要在 Step 4 的「Done」两分支里选一个执行，不要让 spec §6 那一行永远挂着「若要做」 |
| e2e §13 `AS1` 的根因未知，可能牵连比预想更多的前置断言 | Task 3 的工作量可能超出「查一个变量」的量级 | 若发现根因牵连范围大，先只修复到「能跑到第 34 段」为止，把 §13 本身更深层的问题记录成独立的技术债条目，不在本计划内展开修复 |
| 文档同步任务（Task 7–11）依赖 Task 6 的联调记录作为真实素材 | 若 Task 6 因 P6/P8 未满足而推迟，文档任务会先用 spec 推断的内容打底，之后需要二次修订 | Task 7/8 明确写了「核对 Task 6 联调记录里的实际文案」这一步，允许先用推断内容起草，Task 6 完成后回头补一次订正提交，不阻塞文档任务先行推进 |

---

## 明确不做（本计划范围外）

1. **不做任何新顾客端功能**。Task 1 的改动全部是 M3 REVIEW 已经指出的 bug 修复（F5–F7），不新增交互、不新增页面。
2. **不碰 M2-B 工作台/打印机**。`docs/design/workbench-ui-spec.md` §11「已知待定」里的开放项（等待时长阈值是否可配置、快递100 六家运力拼单细节等）与本计划无关，如需处理请另开计划。
3. **不做 spec §12 二期项**：预约配送、节假日日历、独立打包费、精细餐具选项、多骑手拆单、后台 RBAC、微信同城配送作为第二运力。
4. **不引入新运力**。`DeliveryProvider` 仍只有 `KD100 / SELF / MOCK` 三种。
5. **不做「同城立即购买」**（M3 计划已明确不做，M4 不重新评估这条）。
6. **不动生产环境的密钥填写**。`KD100_KEY/SECRET` 等由用户自己在服务器上操作（spec §11.1 流程已验证），本计划不代为操作、不在聊天记录或文档里出现真实密钥。
7. **不擅自决定地图 key 是否付费申请**（Task 2）、**不擅自决定「已送达」模板是否申请**（Task 5）——这两条列入《需用户拍板的点》，等用户回复再执行对应分支。
8. **Task 4 的幂等键只做最小实现**：不做分布式锁、不做请求去重中间件这类通用基础设施，只在 `Order` 表加一列、在一个端点里加一次查重，YAGNI。
9. **不在本计划内直接修复 Task 6 联调中发现的新阻断性 bug**（若有）：另开小分支处理，保持这次联调记录的证据链干净（见 Task 6 Step 8）。

---

## 需用户拍板的点

1. **Task 2**：`<map>` 真机若不可用/有 key 限制，是否去 lbs.qq.com 申请个人开发者免费 key（spec §2.1 已核实免费额度足够单店用量）。
2. **Task 5**：是否值得为「已送达」多要顾客一次订阅消息授权（当前只在下单时一次性请求「配送中」这一个模板）；若公众平台的「配送通知」模板本身支持复用同一模板 ID 发不同状态文案，这条决策的成本会降低，Task 5 Step 1 会先确认这一点再回来问。
3. **Task 6 执行时机**：需要 P6（快递100 已开户充值配置密钥）与用户的真机联调时间窗口都就绪后才能开始；建议 Task 1–5、7–11 可以先并行推进，Task 6 卡在这个前提上。
