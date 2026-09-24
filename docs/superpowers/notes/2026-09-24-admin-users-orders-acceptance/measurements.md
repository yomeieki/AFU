# R1-2 DOM 实测（修订 1 + 修订 2）

测量环境：`food_shop_uo` 私有库（本轮为修订 2 重建），admin dev 代理到 3145，4 个有单用户
（R1验收客一 id=2 共 25 单、三种渠道混合；R1验收客二/三/四 各 1 单）。截图与测量均通过
自写的极简 CDP 脚本驱动 headless Chrome（无 playwright/puppeteer，未装包），`location.href`
用 CDP `Runtime.evaluate` 取得。

修订 2 变更：`Users.tsx` 手机号第二行小字「最近一单收货人 · 日期」去掉日期（同一行「最近
下单」列已经是同一个值），电脑表格与手机卡片两处同改，均加 `whitespace-nowrap`。

## 1. 列表页（R1-2 判定脚本 1，`/users?hasOrders=1`）

### 1024

`href`: `http://localhost:5145/users?hasOrders=1`

```json
{
  "vw": 1024, "tableW": 976, "containerW": 976,
  "thH": [44,44,44,44,44,44,44,44,44],
  "rowH": [61,61,61,61],
  "badgeH": [19,19,19,19],
  "btns": [[
    {"t":"订单","h":20,"over":-76},{"t":"发券","h":20,"over":-12},
    {"t":"积分明细","h":20,"over":-76},{"t":"券记录","h":20,"over":-12}
  ]],
  "scrollX": 0
}
```

补充脚本（小字高度）：
```js
[...document.querySelectorAll('div')].find(d => d.innerText.trim().startsWith('最近一单收货人'))
  .getBoundingClientRect().height
```
→ `16`；文本内容 `最近一单收货人`（不含日期）。

判定（修订 2 门槛）：`tableW≤containerW` ✔（976=976）；`thH≤44` ✔（全 44）；`badgeH≤20` ✔（19）；
按钮 `h≤24 且 over≤0` ✔（全 20/负值）；`scrollX≤0` ✔（0）；**`rowH≤62`：✔（61）**；
**「最近一单收货人」元素高 `≤18`：✔（16，单行）**。

根因回顾（修订 1 遗留、本轮已解）：手机号列第二行原文案「最近一单收货人 · 日期」在 1024
列宽下需要两行才放得下，导致 `rowH=77`；日期与同一行「最近下单」列完全重复，去掉后零信
息损失、小字收回单行，`rowH` 从 77 降到 61，与 1280/1440 同级。

### 1280

`href`: `http://localhost:5145/users?hasOrders=1`

```json
{
  "vw": 1280, "tableW": 1232, "containerW": 1232,
  "thH": [44,44,44,44,44,44,44,44,44],
  "rowH": [61,61,61,61],
  "badgeH": [19,19,19,19],
  "btns": [[
    {"t":"订单","h":20,"over":-178},{"t":"发券","h":20,"over":-138},
    {"t":"积分明细","h":20,"over":-70},{"t":"券记录","h":20,"over":-16}
  ]],
  "scrollX": 0
}
```

判定：全部满足；`rowH=61≤62`，与 BASE 1280 的 61 同级；`th=44`、`badge=19` 优于/持平 BASE 的 44/18。

### 1440

`href`: `http://localhost:5145/users?hasOrders=1`

```json
{
  "vw": 1440, "tableW": 1392, "containerW": 1392,
  "thH": [44,44,44,44,44,44,44,44,44],
  "rowH": [61,61,61,61],
  "badgeH": [19,19,19,19],
  "scrollX": 0
}
```

判定：全部满足（与 1280 同形态）。

## 2. 订单弹窗（R1-2 判定脚本 2，25 单用户 `/users?orders=2`，1280）—— 本轮未改，复测确认不受影响

`href`: `http://localhost:5145/users?orders=2`

```json
{
  "modalW": 672, "tableW": 624,
  "tag": [{"h":20,"dTop":0}, "...(20 行全部 h:20,dTop:0)"],
  "rowH": [57,57,57,57,"...(20 行全部 57)"]
}
```

判定：`tableW(624) ≤ modalW(672)` ✔；每个 `tag.h=20≤20` ✔；每个 `dTop=0≤4` ✔。

## 3. 375 手机端 —— 本轮未改整体结构，复测确认

| 页面 | `href` | `scrollWidth` |
|---|---|---|
| 列表 | `http://localhost:5145/users` | 375（≤375 ✔） |
| 列表（排序开关打开） | `http://localhost:5145/users?sort=spend` | 375（≤375 ✔） |
| 订单弹窗（25 单） | `http://localhost:5145/users?orders=2` | 375（≤375 ✔） |

卡片「最近一单收货人」同样去掉日期（见 `375-list.png`），「最近下单 YYYY-MM-DD」仍在上一行显示。

## 4. R1-1 人工复现（弱网竞态）—— 修订 2 未涉及 `user-orders-session.ts`，沿用修订 1 的证据

原始记录（未重新执行，代码零改动）：
```
A 打开后标题: R1验收客一 的订单共 25 单
最终状态: {"title":"R1验收客三 的订单共 1 单","rowCount":1,"orderNos":["ORD202609244967"]}
是否泄漏了 A 的订单号(样本 ORD202609241794): false
```
截图：`desk-modal-race.png`（修订 1 留存，未重拍——场景与代码均未变）。

## 5. R1-3 两种错误分流 —— 修订 2 未涉及，沿用修订 1 的证据

截图：`desk-refresh.png`（40401，参数已清）、`desk-refresh-apidown.png`（网络错误，参数保留），
均为修订 1 留存，未重拍——涉及的 `Users.tsx` 重开 effect 逻辑本轮零改动。

## 6. R1-5 自取单状态文案 —— 修订 2 未涉及，沿用修订 1 的证据

`desk-modal-more.png`（修订 1 留存）：PICKUP + SHIPPED 显示「待取餐」。

## 7. 截图清单与对应 `location.href`

要求明确重拍的三张（字节均已变，已核实）：

| 文件 | `location.href`（截图时刻） |
|---|---|
| `desk-list.png` | `http://localhost:5145/users?hasOrders=1` |
| `desk-1024-list.png` | `http://localhost:5145/users?hasOrders=1`（viewport 1024×900，`rowH` 61） |
| `375-list.png` | `http://localhost:5145/users`（375×812，小字无日期） |

以下几张不在本轮要求重拍清单内，但复用了同一批测量脚本（`measure-list.mjs`/`measure-modal.mjs`），
脚本重新跑时**顺带**用新数据覆盖了它们，字节因此也变了（如实登记，非本轮刻意改动，内容与
当前代码一致，只是不在修订 2 的必需清单里）：`desk-1280-list.png`、`desk-1440-list.png`、
`desk-modal.png`、`375-list-sorted.png`、`375-modal.png`。

以下文件本轮完全未触碰（既没在重拍清单里，运行的脚本也没写到这些路径），内容仍是修订 1
拍摄时的状态，其中手机号小字仍显示旧版「最近一单收货人 · 日期」——不影响本轮验收判定
（判定只看 DOM 实测数字，不看截图文案），如需要可另行安排全量重拍：
`desk-list-sorted.png`、`desk-modal-more.png`、`desk-modal-short.png`、`desk-modal-race.png`、
`desk-detail-back.png`、`desk-return.png`、`desk-refresh.png`、`desk-refresh-apidown.png`、
`desk-ledger.png`、`desk-coupons.png`、`375-return.png`。

## 8. 未满足项汇总（更新）

- 修订 1 遗留的「1024 档 `rowH=77 > 70`」问题：**已解决**。裁决判定成立，修法（去掉手机号
  小字里与「最近下单」列重复的日期）已实现，1024 档 `rowH` 从 77 降到 61（判定门槛已改为
  `≤62`），「最近一单收货人」元素高 16（判定门槛 `≤18`）。其余门槛（`th≤44`、`badge≤20`、
  按钮 `h≤24 且 over≤0`、`tableW≤containerW`、`scrollX≤0`）三档均满足。
- 无新的未满足项。
