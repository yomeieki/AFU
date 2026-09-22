# 预约送达批次二（小程序）复核记录 · Sonnet 新会话

【工序】复核 【模型】Sonnet 【等级】M
结论：存在阻断项

## 问题

### R1 [阻塞/需改]
位置：`apps/miniapp/pages/local/confirm.js:220-247`（loadMeta 的「报价先回、meta 后到」竞态纠正块）配合 `apps/miniapp/pages/local/confirm.wxml:3-5`（headNotice 渲染）
触发条件：结算页首次进入（或换地址后重新报价）时，若 `/local/quote` 先于 `/local/meta` 返回，且此刻门店打烊（`quote.isOpen=false`）、商家已开启预约（`meta.delivery.scheduleEnabled=true`）。这条竞态正是该代码块自己要处理的场景（注释与 `confirm-page.test.cjs` 用例⑦都在验证它），且在移动网络下是真实可能发生的时序，不是构造出来的边界。
依据：
- 报价先到达时，`refreshQuote` 因当时 `self.data.meta` 还没落地，算出 `scheduleAvailable=false`，落入 `!quote.isOpen && !scheduleAvailable` 分支：`patch.blockReason = quote.nextOpenText`、`headNotice = notice.text`（旧的阻塞文案）、`headBlocking = true`（`confirm.js:344-350` 附近 `getHeadNotice(quote, scheduleAvailable)` 的调用与 patch 写入）。
- meta 随后到达，`loadMeta` 的 `.then` 里判断 `self.data.closedNow && scheduleAvailable && !self.data.scheduleAvailable && self.data.quote` 成立，`setData({ scheduleAvailable: true, scheduleMode: 'SCHEDULED', blockReason: '', quoteToken: ... })`（`confirm.js:240-243`）——这个 `setData` **没有包含 `headNotice` / `headBlocking`**。
- `confirm.wxml:3-5` 的头条完全由 `headNotice`/`headBlocking` 驱动：纠正之后 `headNotice` 仍是旧的阻塞文案（如「明天 09:00 营业」），`headBlocking` 仍是 `true`，因此头条继续以警示样式显示旧文案，且「改用全国邮寄」按钮（`wx:if="{{headBlocking}}"`）继续可点、可跳走。
- 此时页面其余状态其实已经correct：`blockReason=''`，送达时间卡（`wx:if="{{quote && !quoting && !quoteError && !blockReason}}"`）会展示，`scheduleMode='SCHEDULED'` 且已自动选中最早格，主按钮是可点的「预约下单」——头条与真实状态互相矛盾，顾客看到的是「打烊，去邮寄」的旧警示，同时下面又是一个已经可提交的预约单，且没有任何后续动作会自动刷新它（不会再次触发这段纠正逻辑，`self.data.scheduleAvailable` 已经是 `true`），要等顾客手动换地址或返回重进页面触发新一轮 `refreshQuote` 才会被覆盖。
- `confirm-page.test.cjs` 的用例⑦断言了 `blockReason`/`scheduleMode`/`quoteToken`/`slotSelected`，唯独没有断言 `headNotice`/`headBlocking`，因此测试没有暴露这个缺口。
- 与 spec §5.2「头条：打烊可预约时软提示『本单为预约配送』」矛盾。

### R2 [规划缺口]
位置：`apps/miniapp/pages/order/detail.wxml:344`（action-bar 里 `canSelfCancel` 按钮的文案三元表达式）；`apps/miniapp/utils/schedule-order.js:54-61`（`scheduleCancelCopy` 的「两小时外」分支未被任何 wxml 引用）
触发条件：预约单在 `now < selfCancelUntil`（即 spec §4.6 的自助取消窗口）时打开订单详情页。
依据：
- spec §5.3 明确写「按钮按 §4.6：`selfCancelUntil` 前『取消订单』，之后到已备好前『申请取消』，再后『申请售后』」，即预约单在这一窗口内的按钮文案应为「取消订单」。
- 实际渲染是 `detail.wxml:344-346`：`<view class="cancel-btn" wx:if="{{order.canSelfCancel}}" bindtap="onCancelOrder"><text>{{order.status === 'PENDING_PAYMENT' || order.isPickup ? '取消订单' : '申请退款'}}</text></view>`。预约单是同城外送（非自取）、状态是 `PAID`（非 `PENDING_PAYMENT`），三元表达式落到「申请退款」，本批未做任何改动。
- `scheduleCancelCopy(order, fmtHHmm)` 的第一段（两小时外，`order.canSelfCancel` 为真时返回 `HH:mm 前可直接取消`）虽然写了纯函数与单测，但在 `local-cancel-card` 的显示条件（`wx:if="{{order.canRequestCancel || order.cancelRequestedAt || order.showLocalCancelRejected || order.showLocalCancelUnavailable}}"`）下没有对应分支——`canSelfCancel` 为真且 `canRequestCancel` 为假时该卡片根本不出现，这段文案永远渲染不到任何位置。
- 该计划（本文件 Task 6）从未提及要调整这个按钮文案三元表达式，是规划遗漏，不是执行者对方案的偏离；执行者自己在「偏离方案」里已指出这一点并写明「供复核确认是否需要在批次三或后续任务里补一个展示位」——本条即该确认的回复：现状确实与 spec §4.6/§5.3 字面要求不一致。

### R3 [规划缺口]
位置：`apps/miniapp/pages/local/confirm.js:509-517`（`pickMode`）配合 `apps/miniapp/pages/local/confirm.wxml:47`（`schedule-section` 的 `wx:if` 未含 `scheduleAvailable` 条件）
触发条件：门店营业中（`quote.isOpen=true`，无 `blockReason`）且商家尚未打开「预约配送」开关（`meta.delivery.scheduleEnabled=false`）——这正是本批小程序审核通过后、店主在后台手动开开关之前的默认状态（交付报告的发布顺序里写明「过审后店主在后台开开关即对顾客可见」）。
依据：
- `pickMode` 只对 `mode === 'ASAP' && this.data.closedNow` 做了保护（打烊时「尽快送达」置灰不可点），没有对 `mode === 'SCHEDULED' && !this.data.scheduleAvailable` 做任何保护。这与本计划 Task 4 Step 3 给出的代码原文逐字一致（计划文件第 390-398 行），执行者是照抄，不是偏离。
- `confirm.wxml:47` 的 `schedule-section` 只按 `quote && !quoting && !quoteError && !blockReason` 判断是否渲染，不含 `scheduleAvailable`；`mode-opt` 的 `disabled` 类（`confirm.wxss:38` `.mode-opt.disabled{opacity:.45}`）只改透明度，`bindtap="pickMode"` 没有被禁用。
- 实测路径：营业中、`scheduleAvailable=false` 时，「预约时段」选项仍整块渲染且可点；点击后 `pickMode` 把 `scheduleMode` 切到 `'SCHEDULED'` 并调用 `loadSlots(quote.distanceM, false)`——这一步会真的去请求 `/local/delivery-slots` 并拿回时段（该接口不看 `scheduleEnabled`）；顾客选完一格后，`checkoutAction` 的 `sched` 分支（`local-checkout-state.js`）只看 `scheduleMode`/`hasSlot`，不看 `scheduleAvailable`，于是主按钮变成完全可点的「预约下单 ¥xx」；提交后才会被服务端拒（对应 `confirm.js` 里已实现的 `42290` 处理，退回尽快模式并提示"预约配送暂未开通"）。
- 结果：一个商家从未开启过的功能，在营业时段的默认状态下不是真正禁用，而是可以走完整个选时段、看到"可提交"的预约下单按钮，直到最后一步才被拒绝退回——与 spec 及本计划描述的"营业中默认尽快，可切预约"（隐含预约应仅在功能真正开启时可切）不符，属于计划未考虑到的状态组合。
- `tests/miniapp/confirm-page.test.cjs` 没有覆盖"营业中 + `scheduleAvailable=false`"下点击「预约时段」这条路径，验收标准里也没有对应用例，属于测试空白（与代码空白同源）。

## 已核实
- `npm run test:miniapp`（本会话独立运行，worktree 根目录）→ `tests 305 / pass 305 / fail 0`，与编排者提供的结果一致。
- `git diff c81f15c..d19feb6` 全量读过；38 个改动文件与 `allow.txt` 逐条比对，全部命中授权范围；`deny.txt` 逐条比对，零命中；`tests/miniapp/pickup-page.test.cjs` 在本次 diff 中零改动（最后一次改动的提交 `bad481d` 是 BASE 的祖先）。
- `apps/miniapp/pages/local/pickup.js` 的改动确实只限于 `selectDay`/`selectSlot` 两处读 `idx` 的表达式，与授权范围的限定逐字符对上；`selectDay` 原有的 `|| 0` 兜底也保留了。
- `utils/local-checkout-state.js` 的预约分支插入位置（`closedNow` 判断在 `blockReason` 之前；`sched` 判断在报价有效之后、餐具判断之前）与计划一致；未传 `scheduleMode`/`closedNow` 等新字段时，`sched` 为 `false`、`st.closedNow` 为假，新增分支不生效，八种旧结果不受影响（测试已钉住，且我读过完整函数体确认逻辑）。
- `invalidateCheckout` 正确清空 `slotSelected`/`slotStale` 并递增 `_slotSeq`，防止在途的旧 `loadSlots` 响应覆盖清空后的状态。
- `doSubmit` 在 `!quoteToken` 与预约模式未选格/格已失效两处都有前置 `return`；`onSubmit` 严格按 `act.action`（`tableware`/`retry`/`slot`/其余）分派，没有"按钮没禁用就提交"的路径；`quoteToken` 为空时没有发现任何可以走到 `createOrder` 的路径。
- `components/slot-picker/index.js`/`.json` 与计划给出的代码逐字一致；`pickup.wxml`/`pickup.wxss` 的弹层结构、样式已整体迁移，未见残留重复定义。
- `components/order-status-tag/index.js` 的 `scheduled && status==='PAID'` 判断，及 `pages/order/list.wxml` 改用该组件、删除 `list.wxss` 里同名旧配色规则：色值/变量名/内边距/圆角与组件自带的 `.tag-*` 一一对应；全仓搜索确认没有其它文件依赖被删的 `.order-status-*` 类名，非预约单视觉不受影响。
- `apps/miniapp/utils/schedule-order.js` 五个纯函数逐一读过：不读 `wx`/不算时区，全部读服务端已算好的字段，非预约单分支返回空值，调用方用 `|| 原表达式` 回退，立即单/自取/邮寄路径不受影响。
- `tests/miniapp/confirm-page.test.cjs` 的 `loadPage`/`makeCtx` 真的 `require` 了 `pages/local/confirm.js` 并驱动其注册的 `Page` 对象方法（`onLoad`/`onTablewareConfirm`/`onSubmit`/`invalidateCheckout` 等），不是只测 mock；已确认它是页面级行为锁，不是纯桩测试。
- `git diff --stat` 确认 `apps/miniapp/pages/order/confirm*`、`apps/miniapp/pages/local/index.js`、`apps/miniapp/utils/channel.js` 零改动，符合计划验收标准第 2 条；`pages/local/index.wxml`、`pages/product/list.wxml` 也是零改动。
- `storeStatusOf`/`headNoticeOf` 在 `deliveryScheduleOnly(meta)` 为假（预约关闭）时走原有分支，与改前逐字节一致（对照代码与 `local-catalog.test.cjs` 新增用例核实）。

## 无法核实
- 真机（微信开发者工具）走查、支付流程、飞鹅真机出票：协议限定只读只跑 `npm run test:miniapp`，未在真机验证，也不在本次复核授权范围内。
- `bash scripts/e2e.sh` 的原始输出未亲自重跑（协议不允许跑 e2e），采信编排者提供的「通过 2010 / 失败 0」一行结论作为背景事实，未验证其完整日志。
- `storeStatusOf` 在 `closedKind==='BREAK'`（午间休息）且 `deliveryScheduleOnly(meta)` 同时为真时会被新分支抢先命中、覆盖掉原有「午间休息」胶囊——已读代码确认该顺序问题存在（`local-catalog.js:38-42`），但这是否是业务上可接受的行为（打烊可预约的提示优先于午间休息提示）无法从 spec/计划中找到明确决策，且没有测试覆盖这一组合；因严重度低、不影响下单正确性，未单独列为阻断项，供编排者视情况追加确认。

## 第二轮

【工序】复核 【模型】Sonnet 【等级】M
结论：无阻断项

### R1 复核结果：已解决
`apps/miniapp/pages/local/confirm.js:236-254`。loadMeta 的竞态纠正块内新增 `var correctedNotice = getHeadNotice(self.data.quote, true)`，并把 `headNotice: correctedNotice.text, headBlocking: correctedNotice.blocking` 并入同一次 `setData`。已读代码确认：`getHeadNotice` 内部对 `!quote.enabled`/`quote.paused` 的判断优先于 `scheduleAvailable` 参数，传 `true` 不会绕过这两条真正的阻塞原因（这两种情形下依旧返回 `blocking:true`），只在真正"仅因打烊"的场景下才改写为「本单为预约配送」的非阻塞文案，与报价成功分支（`refreshQuote` 的 `.then`）用的是同一个函数、同一口径。新增页面级用例 `confirm-page.test.cjs` ⑦b 覆盖了"报价先回时头条仍是旧阻塞文案 → meta 落地后头条同步改为非阻塞的预约软提示、`blockReason`/`quoteToken`/`payAmount` 均已恢复、选完餐具后按钮为「预约下单」"，已独立运行 `npm run test:miniapp` 确认该用例通过。

### R2 复核结果：已解决
`apps/miniapp/pages/order/detail.wxml:107,120-124,344-346`(现行文件行号，实测过)。三处改动逐一核对：
1. 取消卡外层 `wx:if` 补了 `|| order.scheduleCancelCopy`，覆盖了"仅 `canSelfCancel` 为真、`canRequestCancel`/`showLocalCancelUnavailable` 均为假"这一原先卡片完全不出现的状态（PAID 且在两小时外窗口的预约单）。
2. 新增 `wx:elif="{{order.canSelfCancel && order.scheduleCancelCopy}}"` 分支，插在 `canRequestCancel` 分支与旧 `wx:else`（已备好兜底）之间，显示"可直接取消"标题 + `scheduleCancelCopy` 的两小时外文案；已读完整 wxml 确认分支顺序互斥（`canSelfCancel`/`canRequestCancel` 两个窗口按 §4.6 时间边界互斥，不会同时为真），不会被前面的 `canRequestCancel` 分支截胡，也不会漏判进旧的 `wx:else`。
3. action-bar 自助取消按钮文案三元表达式补上 `|| order.schedule`，预约单（`order.schedule` 非空）在 `canSelfCancel` 窗口内显示「取消订单」而非「申请退款」，与 spec §4.6/§5.3 一致；该分支只在外层 `wx:if="{{order.canSelfCancel}}"` 已经为真时才会求值，天然限定在正确的时间窗口内。
未新增自动化测试（wxml 无渲染测试基建，与仓库现状一致，纯函数 `scheduleCancelCopy` 本身已有单测覆盖三段文案）——可接受。

### R3 复核结果：已解决
`apps/miniapp/pages/local/confirm.js:521`。`pickMode` 新增 `if (mode === 'SCHEDULED' && !this.data.scheduleAvailable) return`，与既有 `ASAP && closedNow` 守卫同款、插在同一位置（早于 `loadSlots`/`openPicker` 调用），彻底阻断了"预约未开通时点击仍会拉真实时段、让主按钮变为可提交"的路径。新增用例 ⑧ 断言营业中 + `scheduleEnabled:false` 时点击「预约时段」后 `scheduleMode` 仍为 `'ASAP'`、`/local/delivery-slots` 未被请求、按钮文案仍是「提交订单」；已独立运行确认通过。

### 修复是否引入新问题
未发现。读过本轮完整 diff（`confirm.js`、`detail.wxml`、`confirm-page.test.cjs` 三个文件），改动均落在授权范围内，未触碰 `deny.txt` 任何文件；R1 的纠正块新写入的两个字段（`headNotice`/`headBlocking`）不影响其余已有字段的写入时机；R2 新增的 wxml 分支互斥、不影响非预约单与其余两个既有分支；R3 新增守卫只是提前 `return`，不改变其后代码路径的语义。

## 已核实（追加）
- `npm run test:miniapp`（本会话独立重跑）→ `tests 307 / pass 307 / fail 0`，与编排者提供的结果一致。
- `getHeadNotice` 函数体完整读过，确认 `!quote.enabled`/`quote.paused` 优先于 `scheduleAvailable` 参数，R1 的修复不会掩盖"未开通/暂停"这两种真实阻塞原因。
- `detail.wxml` 取消卡三个分支（`canRequestCancel` / 新增 `canSelfCancel && scheduleCancelCopy` / `wx:else`）与 §4.6 的时间窗口一一对应，互斥不重叠。
- 本轮 diff 的三个改动文件（`apps/miniapp/pages/local/confirm.js`、`apps/miniapp/pages/order/detail.wxml`、`tests/miniapp/confirm-page.test.cjs`）均在 `allow.txt` 授权范围内，`deny.txt` 零命中。

## 无法核实（追加）
- 真机/微信开发者工具验证、`bash scripts/e2e.sh` 完整原始日志：本轮仍未重跑，采信编排者给出的 `npm run test:miniapp → pass 307 / fail 0` 一行结论。
- 第一轮遗留的"无法核实"事项（`storeStatusOf` 在 `closedKind==='BREAK'` 与 `deliveryScheduleOnly` 同时为真时的优先级取舍）本轮未涉及改动，维持第一轮结论（未列为阻断项，供编排者视情况追加确认）。
