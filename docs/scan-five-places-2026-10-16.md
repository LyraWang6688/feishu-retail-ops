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

### ⏸ **因避让未做**（如实 ✗ —— 要动那三个文件得先报 Lead）

- **A 套那三处"接线到本登记表"**：`routes/scanPage/index.js` 的返回 URL（`backParam`）、
  `config/realmScan.js`、`views/scanPage/paymentBlock.js` —— 这三个文件**正被 `sales-scan` 改**
  （`.local/sales-scan` 有未提交改动 ✓ Lead 明令避让 ✗）⇒ **本轮的登记表只做"声明 + 只读判据"**，
  真正的接线等它合并后再补（补的时候只需把三处的 `scan_added` / 领域参数改成读 `scanEntries` ✓）。
- **B 套实现**：按口径**保持不动** ✓（`views/scanPage/layout.js` 一个字没碰；AC-5S4 只读钉住"仍是 AppLink + 不带数据"）。
- ⚠️ **`sales-scan` 正在做的"销售页接上领域内扫一扫"本身就是 A 套收敛的一半**（三个领域走同一个 `scanRealmScan` 件）
  ⇒ 本轮**不重复做** ✓。

### 判据 → 证据（**能真红**，3 组变异都跑过）

```
AC-5S1  直接调 `tt.scanCode` 的只有 A/C 两处（闭集）   —— 变异：新写第三套实现 ⇒ 红 ✓
AC-5S1b 五处都登记齐（缺任一参数键 ⇒ 红）
AC-5S2  三处「再加一单」= 回领域 + 带草稿；backParam 走配置
AC-5S3  服务端登记表 ↔ 浏览器镜像逐字一致             —— 变异：只改镜像 ⇒ 红 ✓
AC-5S3b C 套行为参数 = 登记表里那一行
AC-5S3c 文案确实从配置取（只改配置副本 ⇒ 模块跟着变）  —— 变异：把文案写死回 scan-print.js ⇒ 红 ✓
AC-5S4  B 套仍是 AppLink + 不带数据（与今天逐字一致）
AC-5S5  零回归：C 套文案 / 两个 HTML 外壳 / 端点常量逐字节不变
AC-5S6  显式布尔（不设 ⇒ 默认 / 显式 false ⇒ 关得掉 / 非法值 ⇒ 抛 / 禁 `||` 兜底）
```
。
