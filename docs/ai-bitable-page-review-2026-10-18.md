# AI 多维表格页面：**校验** 与 **改法**（Lead 定位 · 2026-10-18 业务负责人拍板）

> 本文是**角色与工作方法**的落档（她 2026-10-18 逐字确认），不是业务口径、也不是需求单。
> 业务口径以 `docs/sales-query-page-and-system-caliber-2026-10-08.md` 与她的当场口述为准。

## 0. 我的定位（她 2026-10-18 拍板）

- ✅ **负责**：**校验「AI 多维表格搭建出来的页面」** —— 把页面**现在的真实数据口径**说清楚，
  和她预期比对，指出偏差；再给出 **「在已有源码上改哪几处、怎么改」** 的改法。
- ❌ **不负责**：**直接写业务需求**（需求由她给）；**不从零重做页面**
  —— 她逐字：「**是在已有源代码的基础上怎么修改，不是重新创建**」。
- 顺序固定：**① 先说数据口径 → ② 她确认/纠正 → ③ 才说怎么改**。
  ⚠️ 不许跳过 ①②、直接出"需求文档"或直接改代码。

## 1. 两个页面（现行 · 工作台「信息查询」两个板块）

| 板块 | 分享链接（发布态，她 2026-10-08 逐字给的，**严禁换**） | 配置位置 |
|---|---|---|
| **销售查询** | `https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnY3ZG9LAjrArEe5RzfS8UGh` | `server/public/workbench/config/links.js` 的 `SALES_QUERY_PAGE_URL` |
| **库存查询 / 全仓查询** | `https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnaSFKbJAci7YxvC1AXpweBc` | 同上 `INVENTORY_QUERY_PAGE_URL` |

- 这两个页面**不在我们仓库**、**不进 CI**、**不受 `v1:schema-check` 闸门保护** ⇒ 生产表改名/删列后
  它们会**静默算错或变空**，我们这边**没有任何告警** ⇒ 所以每次页面改版都要按 §4 复查。
- 页面的实际源码托管在 `vibe.basevibepage.com`（飞书多维表格「AI 页面」），
  **本地改不了线上那一份**（见 §6 两条路径）。

## 2. 怎么获取源码（**可复现** · 关键在 Referer）

**⚠️ 直接 curl 会 403**（对象存储 `AccessDenied`）；**带 Referer 就 200**。

```bash
cd <repo>
mkdir -p .local/pages          # ⚠️ .local 是 gitignored，源码副本不进仓库

BASE='https://vibe.basevibepage.com/yZcIiyx5Zm6nU6gF3AGZyA/wbpzfEmPGK/v7/1791975825822'
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'

# 1) 外壳（里面只有 <script src="./assets/index-XXXX.js">）
curl -sS -L -H "Referer: https://scnzoiwpgxik.feishu.cn/" -H "User-Agent: $UA" \
  -o .local/pages/sales-index.html "$BASE/index.html"

# 2) 从外壳里取 JS 资源名，再下（这才是真正的逻辑，几百 KB~1MB）
JS=$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' .local/pages/sales-index.html | head -1)
curl -sS -L -H "Referer: https://scnzoiwpgxik.feishu.cn/" -H "User-Agent: $UA" \
  -o .local/pages/sales-app.js "$BASE/$JS"
```

**拿到 `BASE` 的办法（页面改版后路径会变，v7 这种版本号会涨）**：
1. 用 Chrome MCP（见 §5 前置）打开分享链接；
2. `list_network_requests` 里找 `.../index.html` 与 `.../assets/index-*.js` 两条请求；
3. 从请求 URL 里剥出上面的 `BASE`；或直接 `get_network_request` 看 body。

**别指望「扒站工具」**：SingleFile / HTTrack / wget -m / Puppeteer 都能扒，
但**这个站的拦点是 Referer、不是 JS 渲染** ⇒ 工具未必带对 Referer，反而绕远。
最稳的是**从浏览器网络请求里取 body**。

## 3. 源码结构（2026-10-18 已核）

- 形态：**Vite 打包的 React 单文件 bundle**（`index.html` 外壳 5KB + `assets/index-*.js` 单文件
  销售 961KB / 库存 571KB + 一个 CSS）。
- **数据不来自我们的接口**，而是走**飞书多维表格的查询 DSL**直接读表，形状：
  ```js
  { dsl: {
      datasource: { table: { tableId } },
      dimensions: [{ fieldId }],
      measures:   [{ fieldId, aggregation: 'Sum'|'Count'|'CountAll' }],
      filters:    { conjunction: 'and',
                    conditions: [{ fieldId, operator: 'is'|'RangeDate'|'contains', value: [...] }] } },
    pageSize, pageIndex }
  ```
- **时间过滤两种写法**：
  - 区间：`operator:"is"`，`value:["RangeDate", String(start.startOf('day').valueOf()), String(end.endOf('day').valueOf())]`
  - 当天：`operator:"is"`，`value:["Today"]`
- **表 / 字段一律用 ID**（`tbl…` / `fld…`），**不是中文名** ⇒ 读口径要靠 ID 反查 schema。
- **界面文案硬编码在 bundle 里** ⇒ `grep` 中文串就能判断某个维度/口径**在不在**。
- 库存页状态枚举：`doorBox / sample / warehouse` ＝ **门盒 / 样品 / 仓库**。

## 4. 每次页面改版后的**校验方法**（固定动作）

1. **拿源码**（§2）。
2. **口径关键词计数**（出现 0 次＝这个口径根本没做）：
   ```bash
   for k in 收款明细 收款时间 支付方式 履约状态 更新时间 已交付 已收款 交易方向 退回; do
     printf '%s: ' "$k"; grep -o "$k" .local/pages/sales-app.js | wc -l
   done
   ```
3. **找默认值**：`grep -o 'subtract([0-9]*,"day")'`（默认区间）、`grep -o 'Today'`。
4. **找校验**：搜「开始时间不能 / 结束时间不能 / 早于 / 晚于」等 → **0 命中 = 没做校验**。
5. **实测对照**：Chrome MCP 打开页面，截图 ＋ 读快照，和源码结论互相印证。
6. **对照应有口径**：`docs/sales-query-page-and-system-caliber-2026-10-08.md` §3 的表。

## 5. 前置：Chrome MCP 要能连上她已登录的 Chrome

- 现象：`Could not find DevToolsActivePort for chrome at ~/Library/Application Support/Google/Chrome/DevToolsActivePort`。
- 真因：那个文件**存在但读不了**（`Operation not permitted`），是 macOS 对浏览器数据目录的隐私保护。
- 修法（她 2026-10-18 已授权并生效）：**系统设置 → 隐私与安全性 → 完全磁盘访问权限** → 加
  `/Applications/DeepSeek Harness.app` → **⌘Q 完全退出再重开**。
- 修好后的行为：`list_pages` 能看到她的标签页；`new_page` **在她现有窗口里开新标签**（带她的登录态）。
- ⚠️ **纪律**：连不上时**先报她**，**不许退到 Playwright 另起一个浏览器**（那会新开窗口、且没有她的登录态）。

## 6. 两条修改路径（**是两件不同的事**，别混）

### 🅰 改线上页面（页面归那个「AI 页面搭建」所有）
- 源码托管在 `vibe.basevibepage.com`，**我们本地改不了线上那一份**。
- ⇒ 只能给它下指令，而且必须是 **「在现有页面上改这几处」**，不能说"重新做一版"。
- 指令要写清：**改哪个位置、现在是什么、应该是什么、验收怎么验**。

### 🅱 Copy 一份到我们项目（自己维护）
- 技术可行：查询 DSL 与我们 `V1BitableGateway` 的能力对得上。
- ⚠️ **但这是反转她 2026-10-08 的决定** —— 她当时逐字：「在这个维度上我们**不用自己搭建接口**」
  ⇒ **要做必须先得到她明确同意**。
- ⚠️ 也**不许把 961KB 压缩 bundle 直接拷进仓库**（不可维护、不进 CI）⇒ 正确做法是
  **按口径重写**、配置先行、可测。

## 7. 红线

- 生产 Base **只读**；**不改她的表**、不写任何生产数据。
- **不擅自部署**；下载的源码副本**只放 `.local/`**（不进 git）。
- 校验结论必须**指到源码证据**（`tableId`/`fieldId`/具体字符串/行数），不许凭印象。
- 页面口径**必须像本文一样落文件**；她不确认的，标「待她确认」，不替她下结论。

## 8. 已知偏差（2026-10-18 核 · **待她确认**，不是结论）

销售查询页（当前 v7）：

| # | 口径项 | 现在 | 她 2026-10-08 的原话 |
|---|---|---|---|
| 1 | 默认时间区间 | **今天−29天 ~ 今天（30 天）**：`e.subtract(29,"day")` | （2026-10-18 她说）**默认显示当天** |
| 2 | 开始/结束先后校验 | **无** | （2026-10-18 她说）**开始必须早于结束** |
| 3 | 销售金额 | **销售明细 · 已交付**（页脚："数据来源 · 销售明细表 · 按销售日/已交付统计"） | 「销售金额看**收款时间为已收款**的」 |
| 4 | 支付方式维度 | **没有**（`收款明细`/`收款时间`/`支付方式` 各 0 次） | 「**支付方式维度**……且**按支付方式分类**」 |
| 5 | 销售数量 | 销售明细 · **履约状态=已交付** · 按**更新时间** | 同（✓ 一致） |
| 6 | 品类/类别维度 | 有（品类 5 个；类别 A/B 占比） | 同（✓ 一致） |

库存查询页：

| # | 口径项 | 现在 |
|---|---|---|
| 1 | 明细列表 | **必须输入编号才查**（默认只显示"请输入编号进行查询"） |
| 2 | 卡片 | 库存总量/样品/门盒 三块；**488+820=1308，与总量 1361 差 53**（差异应在"仓库"或未标状态） |
| 3 | 数据源 | 实时库存表 `tbl7Xo4OPmaN2NdP` ＋ `tblTr5qgiZXPADLP` |
| 4 | 今日变动 | filter `fldFUZqD3D = ["Today"]`，分「采购增加 / 销售减少」 |

---

## 9. ✅ 已定稿：销售查询页「日期区间」两处改法（她 2026-10-18 15:59 认可「做的不错」）

> 状态：**改法已定稿，尚未执行**（要由页面 AI 在现有页面上改，或我方 copy 后自己改）。

### 9.1 现状（源码证据）

| 项 | 现在 |
|---|---|
| 默认区间 | `Qde()` 里 `useState(e.subtract(29,"day").format("YYYY-MM-DD"))` ⇒ **今天−29天 ~ 今天（30 天）** |
| 日期先后 | **不是没校验，而是"静默互换"**：`z.isAfter(Q) ? {rangeStart:Q, rangeEnd:z} : …` ⇒ 开始晚于结束时**悄悄对调再查、无任何提示** |
| 日期控件 | **原生 `<input type="date">`**（`type:"date", value, onChange`），**当前没设 `min`/`max`** |

### 9.2 定稿改法（三层）

| # | 位置 | 改动 |
|---|---|---|
| **1** | 开始 `<input type="date">` | 加 `max = 结束日期`（选不到"晚于结束"） |
| **2** | 结束 `<input type="date">` | 加 `min = 开始日期`（选不到"早于开始"） |
| **3** | 区间派生 `useMemo` | **删掉静默对调** ⇒ 直接 `{rangeStart:z, rangeEnd:Q}`；加 `bad = z.isAfter(Q)`；`bad` 时**不发查询**（数字不刷新、不显示 0）＋ 红字提示「开始时间不能晚于结束时间」＋ 旁边给一个「对调」按钮（`onClick` 里互换两个 state 后正常查） |
| **4** | 默认值 | `e.subtract(29,"day")` ⇒ **`e`**（默认当天；天数变 1；卡片角标从「30天」变「1天」） |

### 9.3 为什么不选「自动对调」/「纯拦住」

- ❌ **自动对调**：现在的毛病就是"悄悄对调"；加提示也可能被忽略（手机快速操作），**拿到错区间数据比查不到更危险**；
  且她原话「**开始必须早于结束**」语义是**约束**，不是"系统替她纠正"（与她"不要让系统替我做主"的一贯口径一致）。
- ❌ **纯拦住**：手机上手选两个日期很烦 ⇒ 所以 **`min`/`max` 做主（根本发生不了）**，拦住只当兜底。
- ✅ **拦住 ＋ 一键对调**：既不给错数据，又不用她重选两个日期。

### 9.4 验收标准（改完按这 7 条核）

1. 打开页面 ⇒ 开始 = 结束 = **今天**，角标「1天」
2. 点开始框日历 ⇒ **结束之后/今天之后的日期选不了**
3. 点结束框日历 ⇒ **开始之前的日期选不了**
4. 手输非法 ⇒ **红字「开始时间不能晚于结束时间」＋ 数字不刷新**（**不许显示 0**）
5. 点「对调」⇒ 两个日期互换、立刻正常出数
6. 开始 = 结束 ⇒ **允许**（单日查询），不报错
7. 源码核对：`subtract(29,"day")` = **0 处**；`isAfter(Q)?{rangeStart:Q` = **0 处**；两个 date 框各有 `min`/`max`

### 9.5 可直接发给「页面 AI」的指令（定稿 · 已她认可）

```
在现有销售查询页面上改三处，不要重做页面、不要动其它口径与数据表：

【改 1】默认时间区间 = 当天
- 位置：日期区间组件的初始 state
- 现在：开始日期 = 今天减 29 天（代码 e.subtract(29,"day")），结束 = 今天
- 改成：开始 = 今天，结束 = 今天（默认当天，天数为 1）

【改 2】两个日期框互约束（原生 input[type=date] 加 min/max）
- 开始时间框：加 max = 结束日期（不能晚于结束）
- 结束时间框：加 min = 开始日期（不能早于开始）
- 目标：在日期选择器里根本选不出"开始晚于结束"

【改 3】删掉"静默对调"，改成"拦住 + 提示 + 一键对调"
- 现在：开始晚于结束时，代码把两个日期悄悄对调再查询（isAfter 判断后交换 rangeStart/rangeEnd），用户无感知
- 改成：
  1) 删除静默对调：rangeStart/rangeEnd 直接取用户填的值
  2) 发生「开始 > 结束」时：不发起查询、数字保持不刷新（不要显示 0），并在日期行下方显示红字「开始时间不能晚于结束时间」
  3) 提示旁边给一个「对调」按钮，点一下把开始与结束互换后正常查询
  4) 「开始 = 结束」允许（单日查询），不报错

【不要动】销售数量/金额/品类/类别/趋势的现有口径，也不要动数据表与字段。改完请告知，我会按验收标准逐条核对。
```

### 9.6 还没定的一条（等页面改完再谈）

- 默认改成"当天"后，**趋势图只剩 1 个点** ⇒ 是否让趋势图单独固定看最近 7/30 天（卡片与明细仍按当天）。她尚未表态。
