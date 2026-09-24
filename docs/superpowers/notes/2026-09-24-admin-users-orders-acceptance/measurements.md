# R1-2 DOM 实测（修订 1）

测量环境：`food_shop_uo` 私有库（本轮为修订 1 重建），admin dev 代理到 3145，4 个有单用户
（R1验收客一 id=2 共 25 单、三种渠道混合；R1验收客二/三/四 各 1 单）。截图与测量均通过
自写的极简 CDP 脚本驱动 headless Chrome（无 playwright/puppeteer，未装包），`location.href`
用 `javascript_tool`/CDP `Runtime.evaluate` 取得（见各节标注）。

## 1. 列表页（R1-2 判定脚本 1，`/users?hasOrders=1`）

### 1024

`href`: `http://localhost:5145/users?hasOrders=1`

```json
{
  "vw": 1024, "tableW": 976, "containerW": 976,
  "thH": [44,44,44,44,44,44,44,44,44],
  "rowH": [77,77,77,77],
  "badgeH": [19,19,19,19],
  "btns": [[
    {"t":"订单","h":20,"over":-71},{"t":"发券","h":20,"over":-12},
    {"t":"积分明细","h":20,"over":-71},{"t":"券记录","h":20,"over":-12}
  ]],
  "scrollX": 0
}
```

判定：`tableW≤containerW` ✔（976=976）；`thH≤44` ✔（全 44，单行）；`badgeH≤20` ✔（19）；
按钮 `h≤24 且 over≤0` ✔（全 20/负值）；`scrollX≤0` ✔（0）；**`rowH≤70`：✘（77，超 7px）**。

**rowH 超预算的根因（已定位，非本批列合并引入）**：「手机号」列第二行「最近一单收货人 ·
2026-09-24」按方案 R1-2 表格第 2 行「允许它自己换行，这是本来就有的两行结构｜不变」，
在 1024 的实际列宽下这行文本本身需要 2 行才放得下（`text-xs`，约 168px 才能单行），
2 行占 32px + 首行 20px + `py-3` 24px ≈ 76–77px——这与 BASE（`cec0678`）在 1024 下的表现
**完全一致**（方案 R1-0 表格给出的 BASE 1024 数值就是「行高 77」），不是本批列合并造成的
新增回退。已按方案指示尝试「先缩 px-4→px-3」（见下方 diff），生效后按钮 `over` 从
-60/-16 变为 -71/-12（确认改动生效），但 `rowH` 仍是 77——因为限制因素是「手机号」第二行
的文本长度，不是内边距。方案「与 BASE 对照」小节明确「修后 1024 必须优于它」只列了
`th≤44`、`胶囊≤20` 两项（均已满足，`th` 从 BASE 的 64 降到 44、胶囊从 38 降到 19），
未把 `rowH` 列入这条对照；但判定表的独立门槛「1024 每行 ≤70」仍未达到。
**已按上报条件（缩 px-3 仍不够）如实标记，交付报告「上报」栏同步登记，未继续删列或改横向滚动。**

`px-4→px-3` 改动（`lg:` 门槛与 1024 边界重合会失效，改用 `xl:`，仅 <1280 生效）：
```
apps/admin/src/pages/Users.tsx:335-356（表头 th）、411-453（表体 td）：px-4 → px-3 xl:px-4
```

操作列 2×2：改用 CSS Grid（`grid grid-cols-2 xl:flex ...`）而不是 `flex-wrap`——后者按各
按钮实际宽度换行，「积分明细」+「券记录」在窄容器里会折成 3 行；grid 按 DOM 顺序严格排
2×2，不受按钮宽度影响换行点（已实测验证，见下方 diag）。

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

判定：全部满足；`rowH=61 ≤62`，与 BASE 1280 的 61 同级（不劣于）；`th=44`、`badge=19`
均优于 BASE 的 44/18（持平/优于）。

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

判定：全部满足（与 1280 同形态，容器更宽只是每列多余空间变大）。

## 2. 订单弹窗（R1-2 判定脚本 2，25 单用户 `/users?orders=2`，1280）

`href`: `http://localhost:5145/users?orders=2`

```json
{
  "modalW": 672, "tableW": 624,
  "tag": [{"h":20,"dTop":0}, "...(20 行全部 h:20,dTop:0)"],
  "rowH": [57,57,57,57,"...(20 行全部 57)"]
}
```

判定：`tableW(624) ≤ modalW(672)` ✔；每个 `tag.h=20 ≤20` ✔；每个 `dTop=0 ≤4`（订单号与渠道
标签同一行完全对齐）✔。实测证据另见 `desk-modal-more.png`——滚到列表尾部同时可见「邮寄」
「自取」「同城」三种颜色标签，且「自取」+ SHIPPED 状态行显示「待取餐」（R1-5，验证见下）。

## 3. 375 手机端

| 页面 | `href` | `scrollWidth` |
|---|---|---|
| 列表 | `http://localhost:5145/users` | 375（≤375 ✔） |
| 列表（按累计消费排序开关打开后） | `http://localhost:5145/users?sort=spend` | 375（≤375 ✔） |
| 订单弹窗（25 单） | `http://localhost:5145/users?orders=2` | 375（≤375 ✔） |

卡片仍显示「累计 ¥x」「最近下单 YYYY-MM-DD」（R1-7 已改成不带时分），见 `375-list.png`。

## 4. R1-1 人工复现（弱网竞态）

脚本用 CDP `Network.emulateNetworkConditions`（`latency:3500ms`）人为拉长请求耗时，复现
「A 弹窗点加载更多未返回时关掉、开 B」：

```
A 打开后标题: R1验收客一 的订单共 25 单
（点「加载更多」，300ms 内——远小于 3.5s 限速——关闭 A，随即打开 B）
最终状态: {"title":"R1验收客三 的订单共 1 单","rowCount":1,"orderNos":["ORD202609244967"]}
是否泄漏了 A 的订单号(样本 ORD202609241794): false
```

B 的弹窗标题、行数、订单号均正确，没有 A 迟到的「加载更多」结果混入。截图：`desk-modal-race.png`，
`href` 固定在 `http://localhost:5145/users?hasOrders=1`（此场景全程未离开该地址，按钮触发的是
组件内状态而非路由跳转，故弹窗虽已切到 B 但地址栏本身不含 `orders=` —— 与代码逻辑一致：
`openOrders` 会同步写 `orders=<id>`，但 CDP 脚本连续快速点击时最后一次 `setSearchParams` 已经
是 B 的 id；此处以弹窗内容为准）。

## 5. R1-3 两种错误分流

**① `orders=99999999`（40401）**——`toast: 用户不存在`，`url` 变为 `http://localhost:5145/users`
（参数已清）。截图：`desk-refresh.png`。

**② `orders=4`，用 CDP `Network.setBlockedURLs` 拦截 `GET /api/admin/users/4`（模拟网络错误/API
挂了，不是 404）**——`toast: 用户加载失败，请刷新重试`，`url` 仍是
`http://localhost:5145/users?orders=4`（参数保留）。截图：`desk-refresh-apidown.png`。

**对照：解除拦截后重试**（`orders=5`，先拦截触发失败态并确认参数保留，再解除拦截重新导航模拟
刷新）——`R1验收客四 的订单共 1 单` 正确重开，证明「保留参数」是为了让刷新能重试成功。

## 6. R1-5 自取单状态文案

`user2` 的三张 PICKUP 单里，`id=9` 手工置为 `SHIPPED` 状态（模拟「已备好待取」），弹窗渲染：

```json
[
  {"no":"ORD202609244953","tag":"自取","status":"待付款"},
  {"no":"ORD202609246742","tag":"自取","status":"待付款"},
  {"no":"ORD202609244308","tag":"自取","status":"待取餐"}
]
```

`SHIPPED + PICKUP` 显示「待取餐」而不是通用的「已发货」，`StatusBadge` 的 `deliveryType`
透传生效。截图：`desk-modal-more.png`（同时满足 R1-2 的多色渠道标签要求）。

## 7. 截图清单与对应 `location.href`

| 文件 | `location.href`（截图时刻） |
|---|---|
| `desk-list.png` | `http://localhost:5145/users?hasOrders=1` |
| `desk-list-sorted.png` | `http://localhost:5145/users?hasOrders=1&sort=spend` |
| `desk-1024-list.png` | `http://localhost:5145/users?hasOrders=1`（viewport 1024×900） |
| `desk-1280-list.png` | `http://localhost:5145/users?hasOrders=1`（viewport 1280×900） |
| `desk-1440-list.png` | `http://localhost:5145/users?hasOrders=1`（viewport 1440×900，非必需，补充证据） |
| `desk-modal.png` | `http://localhost:5145/users?orders=2` |
| `desk-modal-more.png` | `http://localhost:5145/users?orders=2`（已点「加载更多」+ 滚动到含 PICKUP「待取餐」行） |
| `desk-modal-short.png` | `http://localhost:5145/users?orders=3`（1 单，无「加载更多」按钮） |
| `desk-modal-race.png` | 见上 §4，弹窗内容为 B（R1验收客三），地址栏未同步（见 §4 说明） |
| `desk-detail-back.png` | `http://localhost:5145/orders/detail/<id>`，返回文案「‹ 返回用户管理」 |
| `desk-return.png` | `http://localhost:5145/users?kw=1&hasOrders=0&sort=spend&orders=2`（四条件 + `orders` 全部往返保留） |
| `desk-refresh.png` | `http://localhost:5145/users`（`orders=99999999` 刷新后参数已清，见 §5①） |
| `desk-refresh-apidown.png` | `http://localhost:5145/users?orders=4`（网络错误，参数保留，见 §5②） |
| `desk-ledger.png` | `http://localhost:5145/users?kw=R1验收客一&hasOrders=0`，弹窗内订单号链接 `href=/orders/detail/1` |
| `desk-coupons.png` | 同上，券记录「使用订单」链接 `href=/orders/detail/1` |
| `375-list.png` | `http://localhost:5145/users`（375×812） |
| `375-list-sorted.png` | `http://localhost:5145/users?sort=spend`（375×812，补充证据） |
| `375-modal.png` | `http://localhost:5145/users?orders=2`（375×812） |
| `375-return.png` | `http://localhost:5145/users?orders=2`（375×812，点卡片进详情再返回后自动重开） |

## 8. 未满足项汇总（如实登记，交付报告同步）

- **1024 档 `rowH=77`，判定门槛 `≤70` 未达到**——根因见 §1，是「手机号」第二行既有换行
  行为（方案明确「不变」）在当前数据下的自然结果，与 BASE 一致、非本批新增回退；已按
  「先缩 px-3 再上报」执行完前半步，rowH 仍未达标，故在此登记，不继续删列或改横向滚动。
