# 扫码页「扫一扫」的五处 —— 业务负责人口径（2026-10-16 21:2x 逐字）

## 口径（她逐字确认）
> 「**一共 5 处扫一扫**：① **标签打印的扫一扫** —— 为了打印标签；② **四个领域共用那一颗**（领域条上的全局扫一扫）—— **不带历史数据**；
>  ③④⑤ **三个领域的「再加一单」**（销售 / 补货 / 退货）—— 也是弹二维码，**扫完回到当前领域 ＋ 带着之前的数据**。
>  ⇒ **本质是一件事**：**点按钮 ⇒ 弹二维码框** ✓ **差别只有两处**：**① 扫完回到哪 ② 带不带之前的数据**」

## 落成可执行的样子
| # | 入口 | 扫完去哪 | 带不带之前的数据 |
|---|---|---|---|
| ① | 标签打印 | 去打印 | — |
| ② | 领域条那颗（全局扫一扫） | **不回** | **不带** |
| ③④⑤ | 销售 / 补货 / 退货的「＋ 再加一个货品」 | **回当前领域** | **带**（本单草稿） |

⭐ **本质 = 一处「点按钮 ⇒ 弹二维码」**；**参数只有两个**：`扫完回哪` · `带不带之前的数据`。
⇒ **不许一个领域一个领域地补** ✗ —— 新入口一律走**同一处**，只传这两个参数。

## 现状（2026-10-16 21:20 核）
- **A 套** = `views/scanRealmScan.js`（飞书 H5 JSSDK `tt.scanCode`）
  · 走这套的：③④⑤「再加一单」 —— **当前只接了补货 / 退货；销售没接** ✗
- **B 套** = `views/scanPage/layout.js`（**AppLink** 打开飞书扫一扫）= ② 领域条那颗，不带数据
- **C 套** = `public/workbench/features/labels/scan-print.js`（工作台前端自己那套）= ① 标签打印
⇒ ⭐ **三套机制**（不同页面 / 不同工具链）⇒ **代码级能真合并的是 A 套**；
  **B / C 保持各自实现，但「回哪 / 带不带数据 / 文案」收敛到一处配置**

---

## 实施落点（2026-10-16 夜 · 子代理 `five-scans` 落的这一轮）

### ✅ 已做（**不碰 `sales-scan` 正在改的三个文件** ✓）

| # | 做了什么 | 落点 |
|---|---|---|
| ① | ⭐ **五处登记表**（每处只登记她那两个参数：`returnsToRealm` / `keepDraft` ＋ `mechanism` / `mode`） | **新** `server/src/config/scanEntries.js`（真源） |
| ② | ⭐ **浏览器镜像**（C 套所在的前端读不到服务端 config ⇒ 逐字镜像 + 用例钉两端相同，先例 = `SCAN_APPLINK`） | **新** `server/public/workbench/config/scanEntries.js` |
| ③ | ⭐ **C 套（①标签打印）接上登记表**：行为参数从表取（今天 = `standalone` / `keepDraft:false` / `jsapi`）；**按钮名与标题文案从表取** | `server/public/workbench/features/labels/scan-print.js`（`SCAN_PRINT_PLACE` / `scanPrintPlaceParams()`） |
| ④ | ⭐ **判据**（每条都演示过"能真红"） | **新** `server/test/scanFivePlaces.test.js`（AC-5S1 / 5S1b / 5S2 / 5S3 / 5S3b / 5S3c / 5S4 / 5S5 / 5S6） |
| ⑤ | **回跳触发参数走配置**（`SCAN_ENTRIES.backParam`，默认 `scan_added`，env 可换） | 同上（A 套接线见下 ✗） |

### ✅ **A 套接线（2026-10-16 深夜补 · `routes/**` 让出之后）**

> 背景：上一轮 `config/realmScan.js` / `routes/scanPage/index.js` / `views/scanPage/paymentBlock.js`
> **正被 `sales-scan`（#769）改** ⇒ 按 Lead 令避让。**#769 与 #772 都已合并** ⇒ 这三个文件空出 ⇒ 本轮补齐 ✓。

| # | 逐处 before → after | 证据 |
|---|---|---|
| ① | `config/scanEntries.js`：`backParam: 'scan_added'` ⇒ **`backParam: 'scan'` ＋ 新增 `backValue: '1'`**（= 今天线上逐字那两个；env 可覆盖 `SCAN_ENTRY_BACK_PARAM` / `SCAN_ENTRY_BACK_VALUE`） | AC-5S2 / AC-5S8 |
| ② | `config/realmScan.js:105-106`：`readString(env, 'SCAN_REALM_SCAN_QUERY_KEY', 'scan')` ⇒ **默认值改成 `resolveScanEntriesConfig(env).backParam`**（值同理）——**登记表成为唯一真源**；`SCAN_REALM_SCAN_QUERY_*` 覆盖照旧 ✓ | AC-5S7 / AC-5S9（env 改登记表 ⇒ A 套跟着变，**能真红**） |
| ③ | `routes/scanPage/index.js`：**一个字没改** ✓ —— 它**本来就**从配置取（`addBackPath` 里 `realmScanConfig.triggerQueryKey` / `.triggerQueryValue`，`:653-656`），**没有硬编码那串**；既有 `added=1` 反馈参数逐字保留 ✗ | AC-5S7 源码哨兵（路由里不许有拼死的 `scan=1`）＋ AC-5S8 |
| ④ | `views/scanPage/paymentBlock.js`：**一个字没改** ✓ —— 它渲染的 `page.realmScan` 由路由喂、路由由 ② 的配置喂 ⇒ **传递性接上了**（渲染层不自己写触发键） | AC-5S7 源码哨兵 |

- ⚠️ **没碰 `routes/scanPage/index.js` / `views/**` 是有意的**：① 它俩本来就吃配置（改了才是重复实现 ✗）；
  ② 另一条线 `.local/money-split-wire` **正在同一个文件里加"货/钱分离"**（未提交 ✗）⇒ 我不碰 ⇒ **零重叠** ✓（已报 Lead）。
- **B 套实现**：按口径**保持不动** ✓（`views/scanPage/layout.js` 一个字没碰；AC-5S4 只读钉住"仍是 AppLink + 不带数据"）。

### 判据 → 证据（**能真红**，共 6 组变异都跑过）

```
AC-5S1  直接调 `tt.scanCode` 的只有 A/C 两处（闭集）   —— 变异：新写第三套实现 ⇒ 红 ✓
AC-5S1b 五处都登记齐（缺任一参数键 ⇒ 红）
AC-5S2  三处「再加一单」= 回领域 + 带草稿；backParam/backValue 走配置
AC-5S3  服务端登记表 ↔ 浏览器镜像逐字一致             —— 变异：只改镜像 ⇒ 红 ✓
AC-5S3b C 套行为参数 = 登记表里那一行
AC-5S3c 文案确实从配置取（只改配置副本 ⇒ 模块跟着变）  —— 变异：把文案写死回 scan-print.js ⇒ 红 ✓
AC-5S4  B 套仍是 AppLink + 不带数据（与今天逐字一致）
AC-5S5  零回归：C 套文案 / 两个 HTML 外壳 / 端点常量逐字节不变
AC-5S6  显式布尔（不设 ⇒ 默认 / 显式 false ⇒ 关得掉 / 非法值 ⇒ 抛 / 禁 `||` 兜底）
AC-5S7  ⭐ A 套触发参数只有登记表一个真源；路由/渲染层不自己拼
                                     —— 变异：realmScan 写死 'scan'/'1' ⇒ 红 ✓；路由写死 `'scan'` ⇒ 红 ✓
AC-5S8  ⭐⭐ 零回归：三条链 303 逐字（`?added=1&scan=1`）＋ 既有两把尺子仍在
                                     —— 变异：改登记表值 ⇒ 红 ✓
AC-5S9  ⭐ 登记表唯一真源：改它一处 ⇒ A/C 两个消费点跟着变
```

**既有两把尺子（本刀跑过，全绿）**：`test/salesRealmScan.test.js`（AC-SR1/AC-SR6 三张 303 表）＋
`test/multiItemLogsAndRealmScan.test.js`（**508,317 字节**那把尺子 / AC-ML5）⇒ 合跑 **21 / 21 绿** ✓
（#769 的销售那条 303 仍是 `/s/{编号}?added=1&scan=1` 逐字不变 ✓）

