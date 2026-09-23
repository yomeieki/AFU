【工序】规划 【模型】Claude Fable 5.1 【等级】M

# 第三批：小程序修复（M1–M6 必修 + M7/M8/M9/M10/M11/M12/M15/M16 纳入）

BASE：ad316faefd6929fccede401a0af815120b9fa340（`git rev-parse HEAD` 实测一致，`git status --porcelain` 为空）
工作区：/Users/yumingyi/food-shop/.claude/worktrees/miniapp-fix-batch3（分支 claude/miniapp-fix-batch3）
基线：`npm run -s test:miniapp` → 308 / 0（本次实跑）。

规划者亲自核实的事实（全部 文件:行号 或本次实跑）：
- M1：`apps/miniapp/pages/local/confirm.js:444-447` invalidateCheckout 清 `slotSelected/slotStale`；`:392-393` 报价回来 `loadSlots(quote.distanceM, !quote.isOpen)`；`:498-500` loadSlots 已有「已有选择只判 stale、不覆盖」分支；`:501-503` 无选择且 autoPick 才选最早格。服务端时段只依赖 distanceM 与设置（`apps/server/src/services/delivery/schedule.ts:44-49, 62`），改数量不改 distanceM，`:442-443` 注释前提不成立。
- M2：`apps/miniapp/pages/order/list.wxml:47` 渲染 `<order-status-tag>`；组件 `components/order-status-tag/index.js:2-13,28-31` 只有 PICKUP 特例，无 LOCAL SHIPPED→「配送中」；`list.js:26-28, 80` 的 LOCAL_STATUS_LABEL/statusLabel 无人使用；`tests/miniapp/order-channel.test.cjs:228` 断言的是 decorate 数据（假绿）。另：`pages/order/detail.js:337` 详情页顶部 statusLabel 对 LOCAL SHIPPED 也是「已发货」（`detail.wxml:6`），这是上线前就有的旧行为，不属复审 M2 范围，见「待用户决定」D3。
- M3：`detail.wxml:107` 取消卡条件含 `|| order.scheduleCancelCopy`（无状态限制）；`utils/schedule-order.js:63-65` readyAt 非空即返回文案；服务端只在 PREPARING 写 readyAt（`apps/server/src/routes/admin/delivery.ts:157`）；`detail.js:376-378` 原 showLocalCancelUnavailable 仅 PREPARING。
- M4：`utils/local-checkout-state.js:73` NO_SLOT 判定排在 `:74` blockReason 之前；本次实跑复现：打烊+预约开+未达起送 → `action:{text:"请选择送达时段",amountState:"pending",action:"slot"}`，onSubmit 后 pickerOpen=false；`confirm.wxml:170` 阻塞条要求 amountState==='blocked' 故不显示。
- **M4b（规划者新发现，随 M4 一并修）**：`confirm.js:236-256` loadMeta 竞态纠正无条件清 blockReason 并取回 quoteToken。实跑复现（报价先回：打烊+未达起送，meta 后到）：纠正前 `blockReason:"明天 09:00 营业", text:"暂不可配送"`；纠正后 `blockReason:"", scheduleMode:"SCHEDULED", quoteToken:null, text:"正在计算运费", amountState:"pending"` —— 「还差 ¥X 起送」被抹掉，按钮永久停在「正在计算运费」。
- M5：`components/promo-bar/index.wxml:6` 遮罩无 catchtouchmove；同仓惯例 `pages/product/list.wxml:157`、`components/sku-popup/index.wxml:1`、`components/privacy-popup/index.wxml:1` 都有 `catchtouchmove="noop"`。
- M6：`tests/miniapp/promo-sheet.test.cjs:113-122` 只查遮罩 catchtap 与 onCloseSheet 出现次数；组件 `promo-bar/index.js:36-39` 的 onCloseSheet/noop 无运行时断言。
- M8：实跑复现：营业中 pickMode('SCHEDULED') 后 `pickerOpen=false, hasAnySlot=false`；settle 后 `hasAnySlot=true` 但 `pickerOpen` 仍 false（`confirm.js:530-531, 534-536`）。
- M15：实跑（scratchpad 复制 category-scroll 夹具）：先滚到 560（高亮→2）、再点第 3 组、无后续滚动，锁到期后高亮保持 3；把 `_pendingScrollTop` 复原为 560（等价删掉 `list.js:252`）则锁到期后高亮变 2。
- ES5 闸门确切命令：`node scripts/check-miniapp-es5.mjs <file...>`（acorn ecmaVersion:5 真解析，`scripts/check-miniapp-es5.mjs:13`，退出码非 0 即失败）。本次实跑基线：confirm.js / local-checkout-state.js / schedule-order.js / promo-bar/index.js / promo-bar/sheet.js / slot-picker/index.js / utils/promo.js / local-cart-bar/index.js / pickup-checkout-state.js 皆 ✔；**order-status-tag/index.js（2:0 const）、pages/order/list.js、pages/order/detail.js、pages/product/list.js、pages/cart/index.js 基线即 ✘**，不入闸门，但本批新增行不得引入 const/let/箭头函数/模板串/解构（沿用仓库既有做法，见 docs/superpowers/plans/2026-09-19-miniapp-promo-and-cartbar.md A9）。
- 42222 = 服务端建单时「当前非营业时间，<nextOpenText>」（`apps/server/src/routes/orders.ts:383`，仅非预约单触发）。
- utils/time.js 现有 fmtHHmm/fmtDate('YYYY-MM-DD')/fmtDateTime/fmtAfterMinutes，无「今天/明天 + HH:mm」；`detail.js:99-101` deadlineText 仅 fmtHHmm；`pickup-checkout-state.js:160-165` pickupDateText 给 'M月D日' 与星期（按日历日）。

---

## 验收标准

A1. `npm run -s test:miniapp` → `pass ≥ 330, fail 0`（基线 308 + 本批至少 22 条新用例，下列 T-编号用例必须全部存在且通过；不得删除或放宽既有断言，除本方案明示的 ④ / schedule-order 第三例 / order-channel :226-228 三处改写）。

A2. **先红后绿证据**：每个 T-用例在写完测试、未改实现前先跑一次（`node --test tests/miniapp/<file>`），执行者「验证」栏必须贴出该次红的原始输出（失败用例名 + 断言信息），再贴修复后的绿。M15 用例例外（它锁的是既有正确行为，红的证据用「临时把 `list.js:252` 注释掉跑一次」的输出代替，跑完必须还原）。

A3. ES5 闸门：`node scripts/check-miniapp-es5.mjs apps/miniapp/pages/local/confirm.js apps/miniapp/utils/local-checkout-state.js apps/miniapp/utils/schedule-order.js apps/miniapp/utils/time.js apps/miniapp/components/slot-picker/index.js apps/miniapp/utils/promo.js apps/miniapp/components/promo-bar/index.js apps/miniapp/components/promo-bar/sheet.js; echo EXIT=$?` → 每行 `ES5 ✔`，`EXIT=0`。
    基线即非 ES5 的五个文件另用 diff 检查：`git diff ad316fa -- apps/miniapp/components/order-status-tag/index.js apps/miniapp/pages/order/list.js apps/miniapp/pages/order/detail.js apps/miniapp/pages/cart/index.js apps/miniapp/pages/product/list.js | grep '^+' | grep -vE '^\+\+\+' | grep -E "(\bconst\b|\blet\b|=>|\`)"; echo GREP_EXIT=$?` → 无输出，`GREP_EXIT=1`。

A4. 范围：`git diff --name-only ad316fa; git status --porcelain --untracked-files=all` → 每个路径都在 allow.txt 内、不在 deny.txt 内（check-scope.sh 不存在，由编排者人工核对并在交付报告写「未运行范围检查」）。

A5. 逐项行为验收（用例名可微调，断言内容不可少）：

**M1（tests/miniapp/confirm-page.test.cjs）**
- 新增夹具 `slotsWithTwoSlots()`：明天两格 04:00 / 05:00（UTC）。
- T1a「打烊+预约开：改成较晚一格后改数量，已选格保留」：settle 后自动选中 04:00 → `onSlotPick({detail:{idx:1}})` 选中 05:00 → `onIncrease({currentTarget:{dataset:{id:1}}})` → `await new Promise(r=>setTimeout(r,600))`（scheduleQuote 500ms 去抖）→ `settleAll()` → 断言 `slotSelected.startAt === '2026-09-23T05:00:00.000Z'`、`slotStale === false`、选餐具后 `action.text === '预约下单'`。回退修复（invalidateCheckout 仍清 slotSelected）→ startAt 变回 04:00 → 红。
- T1b「营业中：主动选预约并选格，改数量后不被清空」：isOpen true、scheduleEnabled true；pickMode SCHEDULED → settle → onSlotPick idx 0 → onIncrease → 等 600ms + settle → `slotSelected` 非 null 且 startAt 不变。回退 → null → 红。
- T1c「改数量后重拉列表里没有该格：标 stale、按钮『时段已过，请重选』」：`slotsSecond: slotsWithoutFirst()`，其余同 T1a 但不换格；改数量后 `slotStale === true`，选餐具后 `action.text === '时段已过，请重选'`、`action.action === 'slot'`。（证明修复不是「不再校验」。）
- 既有 ④（:233-243）按新需求改写为「选好格后 invalidateCheckout：slotSelected 保留、`_slotSeq` 递增、quoteToken 清空」。这是需求本身的变化（时段不随报价作废），执行者输出必须写明。

**M2（新文件 tests/miniapp/order-status-tag.test.cjs + tests/miniapp/order-channel.test.cjs）**
- T2a 组件运行时：用 node:vm 加载 `components/order-status-tag/index.js`（照 freeship-bar.test.cjs:140-151 的 promoBarComponent 写法，`Component: c => { config = c }`），构造 `{data:{label:''}, setData}` 后调用 `config.observers['status, deliveryType, scheduled'].call(c, status, deliveryType, scheduled)`，断言 label：`('SHIPPED','LOCAL',false)→'配送中'`；`('SHIPPED','LOCAL',true)→'配送中'`；`('SHIPPED','PICKUP',false)→'待取餐'`；`('SHIPPED','EXPRESS',false)→'已发货'`；`('PAID','LOCAL',true)→'已预约'`；`('PAID','LOCAL',false)→'待发货'`；`('COMPLETED','LOCAL',false)→'已完成'`；`('REFUNDING','LOCAL',false)→'退款中'`。回退 → 第一条得「已发货」→ 红。
- T2b 源码级：`pages/order/list.wxml` 含 `<order-status-tag`、其标签内含 `delivery-type="{{item.deliveryType}}"` 与 `scheduled="{{!!item.scheduledAt}}"`，且全文不含 `{{item.statusLabel}}`。
- order-channel.test.cjs:214-230「自取单卡片」用例：把三处 `statusLabel` 断言改为经组件算出的标签（在该文件加一个 `tagLabelOf(order)` 小助手，用与 T2a 同一套 vm 加载），断言 LOCAL SHIPPED → '配送中'、PICKUP SHIPPED → '待取餐'、PICKUP COMPLETED → '已取餐'；typeLabel/typeClass 断言保留。

**M3（tests/miniapp/schedule-order.test.cjs + tests/miniapp/order-channel.test.cjs）**
- T3a：`scheduleCancelCopy({status:S, canSelfCancel:false, canRequestCancel:false, schedule:{selfCancelUntil:'SELF_CANCEL', readyAt:'2026-09-23T05:00:00Z'}}, fakeFmt)` 对 S ∈ {SHIPPED, COMPLETED, REFUNDED, CANCELLED, REFUNDING} 全部 `=== ''`；S = PREPARING → `'餐品已在准备，如有问题请联系商家'`。回退 → SHIPPED 返回文案 → 红。
- 既有第三例（:65-69）补 `status: 'PREPARING'`（需求变化：已备好文案只在备餐中显示，执行者输出写明）。
- T3b 页面级（order-channel.test.cjs，照 :232-264「自取单详情」写法）：LOCAL 预约单 `status:'SHIPPED'`，`scheduledAt` 非空，`schedule:{slotLabel:'明天 12:00–12:30', selfCancelUntil:'…', readyAt:'2026-09-23T05:00:00Z', acceptDueAt, prepStartAt}`，`readyAt` 顶层也给，`canSelfCancel:false, canRequestCancel:false, cancelRequestedAt:null, cancelRequestRejectedAt:null` → 断言 `o.scheduleCancelCopy === ''`、`o.showLocalCancelUnavailable === false`、`o.showLocalCancelRejected === false`、`o.canRequestCancel === false`、`!o.cancelRequestedAt`（即 `detail.wxml:107` 五个析取项全假）；再用源码级正则锁住 `detail.wxml:107` 的 wx:if 仍恰由这五项析取组成（`canRequestCancel|cancelRequestedAt|showLocalCancelRejected|showLocalCancelUnavailable|scheduleCancelCopy` 各出现一次、无其它 `order.` 项）。同时断言 `o.scheduleBanner` 非空（横幅不受影响）。

**M4 / M4b（tests/miniapp/local-checkout-state.test.cjs + tests/miniapp/confirm-page.test.cjs）**
- T4a 纯函数：`checkoutAction(on({closedNow:true, scheduleAvailable:true, scheduleMode:'ASAP', blockReason:'还差 ¥52.50 起送'}))` deepEqual `{disabled:true, text:'暂不可配送', amountState:'blocked', action:'none'}`；同时 `checkoutAction(on({closedNow:true, scheduleAvailable:true, scheduleMode:'ASAP'}))` 仍是 `{disabled:true, text:'请选择送达时段', amountState:'pending', action:'slot'}`。回退（顺序换回）→ 前者得「请选择送达时段」→ 红。
- T4b 页面级：meta 打烊+scheduleEnabled；quote `{isOpen:false, belowMin:true, minOrderAmount:10000, quoteToken:null}` → settle → `action.text==='暂不可配送'`、`action.amountState==='blocked'`、`/起送/.test(blockReason)`；`onSubmit()` 后 `pickerOpen===false` 且无 POST /orders。再来一组 `inRange:false` 同断言（blockReason 匹配 /超出配送范围/）。
- T4c 页面级（M4b 竞态）：`holdMeta:true` + 同 T4b 的 belowMin 报价 → settle → `releaseMeta()` → settle → 断言 `blockReason` 仍匹配 /起送/、`action.text==='暂不可配送'`、`action.amountState==='blocked'`、`scheduleMode==='ASAP'`。回退（纠正分支无守卫）→ blockReason '' → 红。既有 ⑦/⑦b（不阻塞的打烊报价）必须继续绿。
- T4d 出路（可与 T4b 合并）：夹具支持 `quoteSeq:[q1,q2,…]`（第 n 次 /local/quote 返回 quoteSeq[min(n-1,len-1)]）与 `cartSeq`；T4b 之后触发 `onIncrease` → 等 600ms + settle → 第二次报价 `{isOpen:false, belowMin:false}` → `blockReason===''`、`scheduleMode==='SCHEDULED'`、`slotSelected` 已自动选中最早格、选餐具后 `action.text==='预约下单'`。

**M5（tests/miniapp/promo-sheet.test.cjs）**
- T5：`assert.match(wxml, /class="promo-sheet-mask"[^>]*catchtouchmove="noop"/)`。回退 → 红。

**M6（tests/miniapp/promo-sheet.test.cjs）**
- T6a 源码级：`assert.match(wxml, /class="promo-sheet"[^>]*catchtap="noop"/)`（注意 `class="promo-sheet"` 后紧跟引号，不会误配 mask）；并解析 wxml 里所有 `(catchtap|bindtap)="(\w+)"`，逐个断言 `typeof config.methods[name] === 'function'`（config 来自 vm 加载）。回退（删面板 catchtap）→ 红。
- T6b 运行时：vm 加载组件（复制 freeship-bar.test.cjs:140-151 的助手到本文件），设 `properties={kind:'freeship', meta:liveMeta, promotion:null, deliveryType:'LOCAL'}`、跑 observer、`onTapDetail()` → `sheetOpen===true`；`const snap = JSON.stringify(c.data)`；`c.noop()` → `JSON.stringify(c.data)===snap`（点面板不改任何状态）；`c.onCloseSheet()` → `sheetOpen===false`。回退（onCloseSheet 改 setData({sheetOpen:true})）→ 红。

**M7（tests/miniapp/confirm-page.test.cjs）**
- T7a：`quoteSeq:[defaultQuote({isOpen:true}), defaultQuote({isOpen:false, nextOpenText:'明天 09:00 营业'})]`，meta isOpen true + scheduleEnabled true，`createOrderFail:{code:42222, message:'当前非营业时间，明天 09:00 营业'}` → settle → 选餐具 → `action.action==='submit'` → `onSubmit()` → settle → 断言 `blockReason===''`、`headBlocking===false`、`scheduleMode==='SCHEDULED'`、`closedNow===true`、`slotSelected` 已自动选最早格、`action.text==='预约下单'`、`ctx.urls` 里 /local/quote 至少 2 次。回退 → blockReason 等于报错文案、headBlocking true → 红。
- T7b 回归：同上但 meta `scheduleEnabled:false`（quoteSeq 第二个也 isOpen:false）→ 42222 走老路：`blockReason==='当前非营业时间，明天 09:00 营业'`、`headBlocking===true`、`action.amountState==='blocked'`。

**M8（tests/miniapp/confirm-page.test.cjs）**
- T8：营业中 + scheduleEnabled；`pickMode('SCHEDULED')` 只调一次 → `settleAll()` → `pickerOpen===true`。回退 → false → 红。（既有「onSubmit 在 action:slot 时只打开选择器」用例在 settle 后先 closePicker，仍应绿。）

**M9（tests/miniapp/confirm-page.test.cjs）**
- 夹具支持 `slotsSeq:[{fail:{code:50001,message:'时段获取失败'}}, slotsWithOneSlot()]`（第 n 次 /local/delivery-slots 按序返回）。
- T9：打烊+预约开 → settle → `slotsError` 非空、`hasAnySlot===false`、`slotSelected===null`、`action.action==='slot'`；记下 delivery-slots 请求数 n → `openPicker()`（或 `onSubmit()`，两者都走 openPicker）→ settle → delivery-slots 请求数 === n+1、`slotsError===''`、`hasAnySlot===true`、`pickerOpen===true`。回退 → 请求数不变 → 红。

**M10（新文件 tests/miniapp/slot-picker.test.cjs）**
- T10：源码级：`components/slot-picker/index.wxml` 不含「无可取时段」字面量，含 `{{emptyLabel}}` 与 `{{dayEmptyLabel}}`；vm 加载 `components/slot-picker/index.js`，`config.properties.emptyLabel.value === '无可取时段'`、`config.properties.dayEmptyLabel.value === '这一天已无可取时段'`（默认值 = 旧文案，自取页逐字不变）；`pages/local/confirm.wxml` 的 `<slot-picker` 标签含 `empty-label="…"` 与 `day-empty-label="…"`（文案按 D4 决定）；`pages/local/pickup.wxml` 的 `<slot-picker` 标签不含 `empty-label`。回退 → 红。

**M11（新文件 tests/miniapp/time.test.cjs + tests/miniapp/order-channel.test.cjs 源码级）**
- T11a：`fmtDayHHmm(v, now)`（now 仅测试用，页面不传）：`fmtDayHHmm('2026-09-23T02:00:00Z','2026-09-23T01:00:00Z')==='10:00'`（同一北京日）；`fmtDayHHmm('2026-09-24T02:00:00Z','2026-09-23T01:00:00Z')==='明天 10:00'`；`fmtDayHHmm('2026-09-25T02:00:00Z','2026-09-23T01:00:00Z')==='9月25日 10:00'`；跨零点：`fmtDayHHmm('2026-09-23T16:30:00Z','2026-09-23T15:30:00Z')==='明天 00:30'`（北京 23:30 看次日 00:30）；无效输入返回 ''。
- T11b 源码级（order-channel.test.cjs）：`pages/order/detail.js` 里 `scheduleCancelCopy(` 与 `schedulePaidExtra(` 的第二实参都是 `fmtDayHHmm`，且不再以 `fmtHHmm` 作为它们的实参。回退 → 红。
- 既有 schedule-order.test.cjs 的 fakeFmt 用例不变（格式化函数由调用方注入）。

**M12（tests/miniapp/cart-bar-page.test.cjs）**
- T12：照 :71-97 写法，但 `getPromoPreview: () => Promise.reject(new Error('down'))`、`promotion:{active:true, channels:{}}` → `await config.loadPromo()` → `promoTip.show===true`、`promoTip.text==='再买 ¥20 免运费（2 km 内）'`。回退 → show false → 红。

**M15（tests/miniapp/category-scroll.test.cjs，只加测试）**
- T15：`fixture()` → measureOffsets+flush → `onPageScroll({scrollTop:560})` → 等 150ms（高亮 2）→ `locateGroup(3)`（高亮 3）→ 等 600ms 无任何滚动事件 → `activeGroupId===3`；`_clearTimers()`。临时删 `list.js:252` 复跑 → 变 2 → 红（A2 例外条款）。

**M16（tools/miniapp-preview，无单测，grep + 人工）**
- `grep -n "scrolledSinceTap" tools/miniapp-preview/pages/product-list-preview.js` ≥ 3 处（声明、scroll 监听置 true、selectCategory 置 false、锁到期回调判断）；`grep -n "配送范围 5 km · 满 ¥30 起送 · 基础运费 ¥6 起" tools/miniapp-preview/pages/product-list-preview.js` 命中 1 处，且 `grep -c "公里" …` 为 0。人工：`node tools/miniapp-preview/serve.mjs --port 5181` 打开 /pages/product-list-local.html，点左侧分类后不动 → 500ms 后高亮不跳。

A6. 预览台同步：`git diff --stat ad316fa -- tools/miniapp-preview` 只含 product-list-preview.js（M16）、可选的 order-list.html（M2 登记一张「同城 · 配送中」卡）与 README.md；M5/M10/M11 不需要镜像改动（M5 属事件属性、浏览器无对应；M10 自取镜像文案不变；M11 详情镜像为静态示例）。执行者在「偏离方案」写明是否登记了 order-list.html。

A7. 主仓 /Users/yumingyi/food-shop 不得被改动：`git -C /Users/yumingyi/food-shop status --porcelain` 与开工前一致。

## 实现方向

所有新增行一律 `var`/`function`/字符串拼接；不 `npm install`；不 cd 到主仓。建议顺序：M4→M4b→M1→M7→M8→M9（同一文件 confirm.js，一起改一起跑）→ M2→M3→M11（订单页）→ M5/M6/M10/M12/M15/M16。每项按 A2 先写红测试。

1. **M4 纯函数**（apps/miniapp/utils/local-checkout-state.js:69-74）：把 `if (st.closedNow && st.scheduleAvailable && !sched) return NO_SLOT` 挪到 `if (st.blockReason) return BLOCKED` 之后；改写 :69-71 注释（「业务阻塞优先于『只能预约』：超范围/未达起送时没有『送达时间』可选，先把原因和出口给顾客」）。confirm.js:362-369 的超范围/未达起送分支不动（blockReason 非空时 wxml:47 已隐藏送达时间卡、:170 阻塞条显示）。
2. **M4b 竞态守卫**（confirm.js:236）：纠正条件追加 `&& self.data.quote.enabled && !self.data.quote.paused && self.data.quote.inRange && !self.data.quote.belowMin`（quote 是 decorateQuote 的 Object.assign 拷贝，原始字段都在），并在注释里写明原因（否则会把「还差 ¥X 起送」抹掉、quoteToken 取回 null、按钮永远「正在计算运费」）。超范围/未达起送在打烊时的 UI 仍是阻塞条 + 「换个地址/改用全国邮寄」，顾客加够金额后 refreshQuote 成功分支（:382）自动切预约。
3. **M1**（confirm.js:432-449）：invalidateCheckout 的 setData 去掉 `slotSelected: null, slotStale: false`；保留 `_slotSeq++`（在途旧时段响应仍作废）；:442-443 注释改为「已选时段不随报价作废：时段只取决于 distanceM 与设置，改数量不影响；换地址后由下一次 loadSlots(:498-500) 判该格是否仍可选，不在则标 stale」。无需改 loadSlots。**D1 若用户选 B**：改为 `if (reason === 'address') patch.slotSelected = null, patch.slotStale = false`，并把 ④ 改回「换地址清空」、T1a/T1b 仍按改数量断言。
4. **M7**（confirm.js:891）：在该分支之前加 `if (code === 42222 && this.data.scheduleAvailable) { wx.showToast({ title: <D2 文案>, icon: 'none', duration: 2500 }); this.loadMeta(); this.refreshQuote('retry'); return }`。refreshQuote 成功分支已会因 `!quote.isOpen` 切 SCHEDULED 并 `loadSlots(distanceM, true)` 自动预选（:382, :392-393）。42220/42226 与 scheduleAvailable=false 的 42222 保持原样。
5. **M8 + M9**（confirm.js:534-536 openPicker）：改为
   - `hasAnySlot` → `setData({pickerOpen:true})`；
   - 否则若 `slotsLoading` → `this._openPickerAfterLoad = true`（等本轮拉完再开）；
   - 否则若 `this.data.quote && this.data.quote.distanceM != null` → `this._openPickerAfterLoad = true; this.loadSlots(this.data.quote.distanceM, false)`（slotsError / 已选格失效且一格不剩 / 列表为空 三种情形都走这条重试）。
   loadSlots 成功分支（:508 后）：`var open = self._openPickerAfterLoad; self._openPickerAfterLoad = false; if (open && hasAny && !view.blocked) patch.pickerOpen = true`（在 setData(patch) 前合并）；失败分支同样清 `_openPickerAfterLoad`；invalidateCheckout 与 pickMode 切回 ASAP 时清该标记。pickMode(:529-531) 顺序不变（先 loadSlots 再 openPicker，openPicker 会走「slotsLoading → 等」分支）。注意 :512 失败分支 `hasAnySlot:false` 保持。
6. **M2**（components/order-status-tag/index.js）：加 `var LOCAL_LABEL = { SHIPPED: '配送中' }`（用 var，见 A3 diff 规则）；observer 顺序：scheduled&&PAID → PICKUP 表 → `deliveryType === 'LOCAL' && LOCAL_LABEL[status]` → STATUS_LABEL。更新 :12 注释（「自取与同城：同一套状态、不同说法」）。pages/order/list.js：删 :15-35 三张标签表与 :73 `statusLabels`、:80 `statusLabel:` 行（渲染已改走组件，`list.wxml:47`），保留 TYPE_META/AFTER_SALE_LABEL；`git grep -n 'statusLabel' apps/miniapp/pages/order/list.*` 应为空。**D3 若用户选「顺带改详情页」**：detail.js:337 改为 `(isPickup ? PICKUP_STATUS_LABEL : isLocal ? LOCAL_STATUS_LABEL : STATUS_LABEL)`，加 `var LOCAL_STATUS_LABEL = Object.assign({}, STATUS_LABEL, { SHIPPED: '配送中' })`，并在 order-channel.test.cjs 的 T3b 单里加断言 `o.statusLabel === '配送中'`。
7. **M3**（utils/schedule-order.js:63-65）：第三段改为 `if (schedule.readyAt && order.status === 'PREPARING')`，注释补「服务端只在 PREPARING 写 readyAt（admin/delivery.ts:157），之后的 SHIPPED/COMPLETED/REFUNDED/CANCELLED 详情仍会下发 schedule.readyAt，取消卡不该再出现」。前两段仍以服务端 canSelfCancel/canRequestCancel 为准。detail.wxml:107 不动。
8. **M11**（utils/time.js + pages/order/detail.js）：time.js 新增 `fmtDayHHmm(v, now)`：`shDate(v)`、`shDate(now || Date.now())`，比较两者的 `getUTCFullYear/Month/Date`（北京日）——同日 → `fmtHHmm(v)`；相差 1 日 → `'明天 ' + HH:mm`；其它 → `M月D日 HH:mm`（月日不补零，与 pickupDateText 一致）；无效 → ''。导出。detail.js:216、:220、:370 把 `fmtHHmm` 换成 `fmtDayHHmm`（`var fmtDayHHmm = timeUtil.fmtDayHHmm`）。schedule-order.js 不改（格式化由调用方注入）。**D5 若用户否决**：跳过 M11，T11 不写。
9. **M5**（components/promo-bar/index.wxml:6）：`<view wx:if="{{sheetOpen}}" class="promo-sheet-mask" catchtap="onCloseSheet" catchtouchmove="noop">`（noop 已存在 :39）。不改 wxss/js。
10. **M6**：只加测试（promo-sheet.test.cjs），不改实现。
11. **M10**（components/slot-picker）：index.js properties 加 `emptyLabel: { type: String, value: '无可取时段' }`、`dayEmptyLabel: { type: String, value: '这一天已无可取时段' }`；wxml:12 → `{{emptyLabel}}`、:21 → `{{dayEmptyLabel}}`；confirm.wxml:208 的 `<slot-picker` 加 `empty-label="<D4>" day-empty-label="<D4>"`。pickup.wxml 不动。
12. **M12**（pages/cart/index.js:138-140）：失败回调改 `if (seq === self._promoSeq) self.setData({ promoTip: promo.progressTipOf(null, opts) })`（opts 已在 :126 定义），注释指向 local-cart-bar/index.js:120 的 apply(null)。
13. **M15**：只加测试（category-scroll.test.cjs）。
14. **M16**（tools/miniapp-preview/pages/product-list-preview.js）：(a) 在 :36 附近声明 `var scrolledSinceTap = false`；:272 scroll 监听内置 `scrolledSinceTap = true`；selectCategory(:186) 置 `false`；:194 锁到期回调改 `if (!state.search && scrolledSinceTap) updateActive(...)`。(b) :71 外送规则行文案改为 `配送范围 5 km · 满 ¥30 起送 · 基础运费 ¥6 起`（与 local-store-header/index.js:85-91 buildRules 格式一致；示例值）。README.md 可加一句说明（可选）。
15. **夹具扩展**（confirm-page.test.cjs makeCtx）：`quoteSeq`、`slotsSeq`（元素可为 `{fail:{code,message}}`）、`cartSeq`；默认行为不变，既有 `quote/slots/slotsSecond/cart` 选项照旧。
16. 不做：M13（记后续：`.promo-sheet` 超高裁切，需把行区改成 `<scroll-view scroll-y>` + max-height，并同步 index-local.html / index-local-schedule.html / product-list-preview.js 三处镜像；纯 CSS overflow-y 会被 M5 的 catchtouchmove 一起挡住，故不能顺手做）、M14（同门槛档去重属服务端/后台校验，`local-settings.ts:477-485` 只排序截断；wx:key 重复仅开发者工具告警）、已决定不修的两条文案。

## 授权范围
apps/miniapp/pages/local/confirm.js
apps/miniapp/pages/local/confirm.wxml
apps/miniapp/utils/local-checkout-state.js
apps/miniapp/utils/schedule-order.js
apps/miniapp/utils/time.js
apps/miniapp/components/order-status-tag/index.js
apps/miniapp/components/promo-bar/index.wxml
apps/miniapp/components/slot-picker/index.js
apps/miniapp/components/slot-picker/index.wxml
apps/miniapp/pages/order/list.js
apps/miniapp/pages/order/detail.js
apps/miniapp/pages/cart/index.js
tests/miniapp/confirm-page.test.cjs
tests/miniapp/local-checkout-state.test.cjs
tests/miniapp/order-status-tag.test.cjs
tests/miniapp/order-channel.test.cjs
tests/miniapp/schedule-order.test.cjs
tests/miniapp/promo-sheet.test.cjs
tests/miniapp/slot-picker.test.cjs
tests/miniapp/time.test.cjs
tests/miniapp/cart-bar-page.test.cjs
tests/miniapp/category-scroll.test.cjs
tools/miniapp-preview/pages/product-list-preview.js
tools/miniapp-preview/pages/order-list.html
tools/miniapp-preview/README.md

## 禁止修改
apps/server/**
apps/admin/**
scripts/**
.claude/**
.agent/**
docs/superpowers/**
docs/**
package.json
package-lock.json
apps/miniapp/app.json
apps/miniapp/app.js
apps/miniapp/project.config.json
apps/miniapp/api/**
apps/miniapp/config/**
apps/miniapp/utils/request.js
apps/miniapp/utils/pickup-checkout-state.js
apps/miniapp/utils/promo.js
apps/miniapp/pages/local/pickup.js
apps/miniapp/pages/local/pickup.wxml
apps/miniapp/pages/order/list.wxml
apps/miniapp/pages/order/detail.wxml
apps/miniapp/pages/product/list.js
apps/miniapp/pages/product/list.wxml
apps/miniapp/components/promo-bar/index.js
apps/miniapp/components/promo-bar/index.wxss
apps/miniapp/components/promo-bar/sheet.js
apps/miniapp/components/local-cart-bar/**
tools/miniapp-preview/serve.mjs
tools/miniapp-preview/pages/index-local.html
tools/miniapp-preview/pages/index-local-schedule.html
（另：主仓 /Users/yumingyi/food-shop 任何写操作一律禁止，见 A7；它不是仓库内 glob，故不写入 deny.txt）

## 上报条件
- 某条 T-用例在未改实现前就是绿的（无法先红）：停下，贴出输出，由规划者裁决用例是否有证伪力（M15 除外，按 A2 例外条款）。
- 修 M1 后既有 ⑤/⑥/⑦/⑦b/⑨ 任一变红且不是断言本身需随需求改写：停下上报，不得放宽这些用例。
- M4/M4b 修完后发现还有其它路径让「打烊 + 阻塞」按钮落成 pending（例如 42223/42226 的 catch 分支）：只报不改（那些分支本就 headBlocking，不在复审范围）。
- M2 删 list.js 标签表时发现 list.wxml/其它文件仍引用 `statusLabel`：停下上报（说明 :47 之外还有渲染点）。
- M3 需要服务端不再对终态单下发 schedule.readyAt 才能收口（客户端按 status 门控不够，例如出现 PREPARING 以外还会写 readyAt 的路径）：写进上报，不动 apps/server。
- M7 实测 refreshQuote 后服务端报价在打烊+预约开时不返回 quoteToken（导致切预约后仍 pending）：上报，不改服务端；此时 M7 退回只做 toast。
- M11 的「明天」判断需要服务端下发日期字段才准确（例如 selfCancelUntil 缺失时区信息）：上报。
- 任何改动触及禁止清单（含 pickup.js/pickup.wxml、promo.js、detail.wxml、list.wxml、serve.mjs）：停下，说明为什么必须改，等编排者扩大授权；不得先改。
- ES5 闸门（A3）对授权内文件报 ✘，且原因是既有行（非本批新增）：上报，不回头改既有行。
- `npm run -s test:miniapp` 出现与本批无关的偶发红（例如 category-scroll 的定时用例）：复跑一次，仍红则上报原始输出，不得改那条用例。

## 待用户决定
- **D1（M1，换地址是否保留已选时段）**：A = 改数量/删商品/换地址一律保留已选格，下一次时段拉取若该格不再可选则标「时段已过，请重选」（服务端 42291 仍是最后一道闸）；B = 只在改数量/删商品时保留，换地址仍清空。**建议 A**：换地址后距离变了，服务端重算的列表本来就会把不再可选的格剔掉，保留能省顾客一次重选；B 多一条分支、多一种「悄悄清空」。
- **D2（M7 toast 文案）**：建议「已到打烊时间，已为您改为预约送达，请确认送达时段」；备选：直接用服务端文案 err.message（「当前非营业时间，明天 09:00 营业」）。影响：只改 toast，一处字符串。
- **D3（M2 顺带修详情页顶部状态）**：详情页 `detail.wxml:6` 对同城 SHIPPED 单也显示「已发货」，与列表修好后的「配送中」不一致（这是旧行为，不是本轮回归）。建议顺带改（一行 + 一条断言，见实现方向 6）；不改则列表「配送中」、详情「已发货」并存。
- **D4（M10 外送弹层空态文案）**：建议 `无可选时段` / `这一天已无可选时段`（与 confirm.wxml:64 既有「暂无可选时段」同词）；自取页维持「无可取时段」。
- **D5（M11 取消/确认文案带日期）**：建议纳入，格式：同日 `HH:mm`，次日 `明天 HH:mm`，更远 `M月D日 HH:mm`，套用于「X 前可直接取消」「商家将在 X 前确认」「商家已确认，X 开始备餐」三处。服务端 daysAhead 默认 1（`local-settings.ts:311`），「明天」是主要场景。若否决则跳过 M11。
- **D6（M9 底部按钮文案）**：已选格失效且一格不剩时按钮仍写「时段已过，请重选」，点它现在会重新拉取时段（若拉到就直接开弹层）。建议不加新文案（按钮宽度按现有十一种文案定，`local-checkout-state.js:23`）；备选：新增第十二种「暂无可选时段」，需在 320 宽机器上核宽度。
