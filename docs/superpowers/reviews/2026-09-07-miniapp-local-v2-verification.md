# 小程序双渠道导航与同城结算 —— 验证报告（2026-09-07）

> 方案：`docs/superpowers/plans/2026-09-07-miniapp-dual-channel-navigation-checkout.md`（Task 10）
> 分支：`claude/mini-app-local-delivery-frontend-03df14`，HEAD `c658d8f`（main 之后 14 个提交，含两次并入 main）
> 环境：Node v25.9.0 · MySQL `food_shop_e2e`（本机 docker）· 服务端 `PORT=3107` 全 mock
> 开发者工具声明的基础库：`libVersion 2.25.0`（`project.config.json`）——**本报告没有在开发者工具里跑过任何一步**，见 §3。
>
> **这份报告分两半。§1–§2 是机器跑出来的，每条带命令与结果；§3 是机器跑不了的，
> 一条都没执行，列在这里是为了让人知道「绿了」不包括它们。** 没有执行的项目不会被写成通过。

---

## 1. 自动化：全部通过

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npm run test:miniapp`（= `node --test tests/miniapp/*.test.cjs`） | **76 / 76**，1.9 s |
| 2 | `node scripts/check-miniapp-es5.mjs <11 个文件>` | **11 / 11** |
| 3 | `npm run build:server`（= `tsc`） | 通过，无输出 |
| 4 | `cd apps/server && npx ts-node --transpile-only scripts/selftest-local-settings.ts` | **21 / 21** |
| 5 | `npm run build:admin`（= 时区闸门 + `tsc` + `vite build`） | 通过（并入的 codex 分支） |
| 6 | 全部 `apps/miniapp/**/*.js` 用 `vm.Script` 解析 | 55 个文件，0 个失败 |
| 7 | 全部 `apps/miniapp/**/*.json` 合法，且 `usingComponents` 指向的组件文件存在 | 35 个 json，0 个问题 |
| 8 | `app.json` 的 `pages` 每一项 js/wxml/json 三件齐全 | 24 个页面，0 个缺文件 |

### 1.1 单测 76 条按文件

| 文件 | 条数 | 守的是什么 |
|---|---|---|
| `channel.test.cjs` | 6 | 渠道归一化；storage 抛异常不上抛 |
| `local-checkout-state.test.cjs` | 12 | 结算按钮状态机全矩阵（含报价过期 / 优惠重算中）；幂等键 200 次无重复 |
| `navigation.test.cjs` | 12 | 封面两渠道入口顺序；`enterLocalChannel` 三条分支；旧路由兼容跳转 |
| `catalog.test.cjs` | 7 | 分类/商品查询串**必带渠道**、参数顺序、关键词与分类互斥 |
| `local-catalog.test.cjs` | 7 | 店头状态 / 购物车合计 / 起送线三段纯函数 |
| `channel-pages.test.cjs` | 7 | 主页与分类页**实际发出的 URL** 带对渠道；切渠道先清空；在途响应作废 |
| `cart-channel.test.cjs` | 7 | 购物车拉车带渠道、结算路由分流、同城起送线、跨渠道提示双向 |
| `address-flow.test.cjs` | 7 | 新增后自动回选、地图取消无副作用、**导入微信地址不再提交旧坐标**、报价走统一 API 层 |
| `order-channel.test.cjs` | 10 | 我的→订单列表带渠道；范围切换保状态归页码；在途响应作废；详情页三条源码级护栏 |

ES5 闸门只跑**新增文件 + 三个本来就是 ES5 的既有文件**（方案「执行期修正」第 2 条）；
其余既有 tab 页本来就不是 ES5，不在闸门内，也没有改成 ES5。

## 2. e2e：1158 通过 / 3 失败，3 条全是本分支没碰过的打印机用例

```
BASE=http://localhost:3107 DB_NAME=food_shop_e2e bash scripts/e2e.sh
================ 通过 1158 / 失败 3 ================
```

跑前做了两件事，都是记忆里记过的坑：重启服务端进程（打印机 mock 的状态在进程内存里，
跨轮不清会假红）；把库里残留的待付款单置 CANCELLED、`TRUNCATE print_jobs`。

### 2.1 本轮新增的 §53（订单契约）：23 / 23

`scripts/e2e.d/53-order-contract.sh`，三条服务端契约：
`quoteExpiresAt` 随报价下发且与 token 同源 · `GET /orders?deliveryType=` 服务端过滤（非法值 400、空串按不传）·
`clientRequestId` 幂等（同 id 同单、库存只扣一次、跨用户隔离、非 UUID 400、不传时老行为逐字节不变）。
本段收尾会把自己造的待付款单摘掉——否则**下一轮**的 §16 会红在一个跟本段毫无关系的地方。

### 2.2 三条失败与「不是本分支引入」的证据

| 断言 | 所在文件 |
|---|---|
| `FAILED 作业已被恢复补打成功` | `scripts/e2e.d/45-printer-offline.sh` |
| `D：首次超时（在线）安排 1 次重试，PENDING(attempts=1)` | 同上 |
| `D：第 2 次仍超时 → FAILED(attempts=2)，不是 CAPACITY/BUSINESS 那套 4 次上限` | 同上 |

证据三条，都是可复验的命令：

1. `git diff --name-only main..HEAD -- apps/server/src/services/ticket apps/server/src/services/scheduler.ts scripts/e2e.d/4*` → **空**。本分支没有碰过任何打印机 / 调度 / e2e.d 4x 文件。
2. `git log -1 -- scripts/e2e.d/45-printer-offline.sh` → `28be87d`，两天前，另一会话的打印机改动。
3. 第一条（`FAILED 作业已被恢复补打成功`）在本轮**改任何服务端代码之前**的第一次 e2e 就红着（Task 3 记录）。

结论：与本次改动无关，属另一会话在途的打印机工作。**但它们也没有被修好**，别把这份报告当成打印机那几条稳了的证据。

### 2.3 e2e 证明了什么、没证明什么

e2e 打的是**服务端**：三条新契约、双渠道下单/退款/会员/配送全链路在 mock 运力下通。
它**不跑小程序代码**——小程序页面的行为由 §1 的 76 条单测覆盖，而那些单测是用 `Page/wx` 桩在 node 里跑的，
不是真的微信渲染层。所以 §1 + §2 全绿，仍然不等于开发者工具里能用。

---

## 3. 没有执行的（一条都没跑，不得视为通过）

### 3.1 开发者工具完整操作矩阵（方案 Task 10 Step 4）

本会话没有可靠的自动化通道到微信开发者工具（记忆：automator 通道疑似卡在信任弹窗）。
下面 8 条**全部未执行**：

```
封面→全国邮寄→四个 tab→购物车→邮寄结算
封面→同城配送→四个 tab→LOCAL 加购→LOCAL 购物车→同城结算
无地址→新增→地图选点→保存→自动回结算→报价
更换地址→旧金额立即消失→新报价→选券→选赠品→改数量→重新报价
报价失败→重试；暂停/打烊/超范围/未达起送→按钮禁用且出口正确
双击提交→一张订单；模拟超时后同 ID 重试→仍是一张订单
支付取消→可重试支付；支付成功→订单详情→骑手状态→终态停止轮询
返回全国邮寄→EXPRESS 商品与购物车未被 LOCAL 数据污染
```

已逐条展开成 16 个可勾选项写进 `docs/miniapp-release-checklist.md` §四「双渠道导航与同城结算」，
店主或开发在开发者工具里过一遍时照那张勾。

### 3.2 视觉回归（方案 Task 10 Step 5）

320×568 / 375×812 / 430×932 三个视口 + 系统最大字号，检查营业胶囊、长地址、券名、固定结算栏、键盘、安全区、券弹层——**未执行**。
独立预览（`docs/design/miniapp-local-v2/`）在浏览器里做过 375 与 320 两个画布的全组合溢出自检（零溢出），
但那是**手写 HTML 复刻的设计稿**，不是真实 wxss 渲染，不能替代这一条。

### 3.3 只有真机能验的

隐私授权弹窗 · `wx.chooseLocation` 地图选点 · `wx.chooseAddress` 导入 · 微信支付取消/成功 · 骑手位置轮询在真实回调下停止。
这几项自动化连桩都是假的，本报告不涉及。

---

## 4. 方案执行期的偏离（详情在方案顶部「执行期修正」一节）

五处修正（`clientRequestId` 必须可选 · ES5 闸门只跑新增文件 · tabBar 页固定栏 `bottom:0` 不留偏移 ·
预览命令换 `serve.mjs` · 报价失败按店主选的方案 B 可点重试），加一处 Task 5 执行期多拆的两个组件
（`local-cart-bar` / `local-sku-picker`，主页与分类页共用），一处 Task 3 的迁移日期改为 `20260911`（排在 main 已有的两条之后）。

## 5. 当前状态与下一步

- **未部署、未上传体验版、未合进 main。** 分支在 Task 5 落地后已重新自洽（同城菜单可达）。
- 合进 main 之前要先删掉主仓工作区里三个**未跟踪**的同名文档副本
  （`docs/superpowers/{specs,plans,notes}/2026-09-07-*`），它们是另一会话留下的原始版本，
  本分支里提交的是修订版；不删 git 会以「untracked working tree files would be overwritten」挡住合并。
- 改了 `apps/miniapp/**`：合进 main 后还要 `git -C /Users/yumingyi/food-shop merge --ff-only`，
  开发者工具读的是主仓磁盘，不读 worktree。
- 下一道门：**店主在开发者工具里按 §3.1 的 16 项过一遍**。过了才谈上传体验版；上传与部署都要另行授权。
