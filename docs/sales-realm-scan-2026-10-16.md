# 销售页接上「领域内扫一扫」（2026-10-16）

> 业务负责人 **2026-10-16 21:1x 弹窗拍板**（逐字）：「**要，销售也弹扫码框**」✓
> ＋ 同一天 **14:32** 的口径（逐字，代码注释里也引着）：
> 「**补货 / 销售 / 退货**里那颗『＋ 再加一个货品』**实际上也是扫一扫**；
>  在退货里点 ⇒ **扫完直接放到退货里的货品**」✓

## 一、结论（先给结论）

**销售的「＋ 再加一个货品」（草稿非空时）/「加入本单」（草稿为空时）现在也是领域内扫一扫** ✓：
点一下 ⇒ 那一件进**销售本单**（既有 `session.sale.lines` ✓）⇒ 303 回**销售页**并带上 `?scan=1`
⇒ 那一页调飞书原生扫一扫 ⇒ 扫到的那件带 `?from=sales` 落回**销售页** ⇒ 接着加进**同一单** ✓。

⭐ **与「五处扫一扫」那份口径对上**（`docs/scan-five-places-2026-10-16.md`，她 2026-10-16 21:2x 逐字）：
那份把 ③④⑤ 定义成「**销售 / 补货 / 退货的「＋ 再加一个货品」** ⇒ **回当前领域 ＋ 带之前的数据**」，
并定「**本质是一件事**（点按钮 ⇒ 弹二维码框）· **差别只有两处**：① 扫完回到哪 ② 带不带之前的数据」＋
「**不许一个领域一个领域地补** ✗ —— 新入口一律走**同一处**，只传这两个参数」——
⚠️ 那份文档落进 main 时（`#767`）**销售这一条正是它标的"没接"** ✗；
**本卡就是补上那一格** ✓，而且走的正是**同一处**（A 套 = `views/scanRealmScan.js` ＋ 同一段脚本 ＋
同一个 `addBackPath`），两个参数各自落在：
`回哪` = 领域 id（`sales` ✓，由 `config/realmScan.js` 的领域→链配置给）·
`带不带数据` = 各领域**自己那套本单草稿**（销售 = 既有 `session.sale.lines` ✓ 不动 ✗）。

⚠️ **本卡的关键发现（改动前必红的那一条）**：只改「领域→链」配置 ＋ 那条 303 **是不够的** ——
销售页**根本没有**那个"该弹扫码"的配置块（`data-view="realm-scan-config"`）：

```
renderScanPage(view, SCAN_PAGE, write, realm, { realmScan: {…, scanNow:true} })   # 改动前
  sales           → config-block=false  script=false  scan-now1=false   ← 必红
  replenish       → config-block=true   script=true   scan-now1=true
  purchase_return → config-block=true   script=true   scan-now1=true
```

那一块 DOM 此前**只在 `views/scanPage/multiItemBlock.js` 里拼**（补货 / 退货两块共用），
销售那一块走的是 `views/scanPage/paymentBlock.js` 的 `saleFormHtml` ⇒ **没有它** ✗
⇒ `layout.js` 也不会内联那一段脚本（它按同一个标记决定 ✓）⇒ 即使 `?scan=1` 回来**也不会弹** ✗
（与线上 `scan.realm.*` 事件**一次都没有**、真机"点了没弹"完全一致 ✓）。

## 二、只读核清的四件事（**不许猜** ✗ —— 每条都有出处）

| 问题 | 答案（出处） |
| --- | --- |
| 销售页那颗「＋ 再加一个货品」怎么走？ | **同一颗** `action=add_line` 的 `submit`（`views/scanPage/paymentBlock.js` 的 `saleFormHtml`）：草稿为空时文案 = `SCAN_WRITE.texts.addAnotherButton`（「➕ 还要加一双」），**草稿非空时**文案换成 `MULTI_ITEM_RENDER_TEXTS.addButton`（「＋ 再加一个货品」）＋ `data-multi-add` 钩子 ✓ **同一颗按钮、同一个 action** ✗ 不新增第二颗 |
| 销售页的草稿 = ？ | **`session.sale.lines`** ✓ —— 一条 = `{kind, number, item_no, product_record_id, size, amount, gift, added_at}`；**一件一行**（不按数量 ✓） |
| 加一件怎么加？ | 路由 `routes/scanPage/index.js` 的 `action === actions.addLine` 分支 ⇒ 既有 `writeService.addSaleLine({openId, requestId, productRecordId, number, itemNo, color, size, amount, gift, inStock})` ⇒ `sessions.addLine` ⇒ `session.sale.lines` ✓（**只写本地会话，不写业务表** ✓） |
| 扫完那件落哪？ | **不新造落点** ✓：落点 = `?from=<领域>`（既有 `views/scanPageRealm.js` 的 `resolveRealm` 读它 ✓）⇒ 落回**销售页**；真正"进本单"仍走**同一颗** `action=add_line`（既有落点 ✗ 不新造） |

**四个函数的确切语义**（`routes/scanPage/index.js`）：

| 函数 | 语义 |
| --- | --- |
| `realmScanActive(realm)` | ① 开关 `enabled === true` **且** ② `config.realms[realm]` 存在 ⇒ 这一页**配了链** |
| `realmScanTriggered(req, realm)` | 上面那条 **且** ③ URL 上**明确带**了触发参数（`?scan=<值>`）⇒ 才"接着扫" |
| `realmScanPageConfig(req, realm)` | 只有 ①②③ 全满足才**非 null**（= 喂给渲染层的 `page.realmScan` ✓）；否则 `null` ⇒ 页面一个字节都不多 ✓ |
| `addBackPath(page, realmId)` | **加货成功之后**那一发 303：要不要给回跳**追加触发参数**（①②③的前两条为判据 ✓ 缺一条 ⇒ **原样返回**） |

## 三、改了哪几处（4 个文件 ＋ 1 个新判据文件）

| # | 文件 | 改前逐字 → 改后逐字 | 依据 |
| --- | --- | --- | --- |
| ① | `server/src/config/realmScan.js` | `DEFAULT_REALM_CHAINS = { replenish:'replenish', purchase_return:'return' }` → **多一格 `sales: 'sales'`**；`SCAN_REALM_SCAN_CHAINS` 的缺省串同步加上 `,sales:sales`；那两段"销售是另一套 ⇒ 这里没有 sales"的注释按事实重写 | 她 2026-10-16 21:1x「要，销售也弹扫码框」＋ 14:32 三个领域的逐字 |
| ② | `server/src/routes/scanPage/index.js` | `addBackPath` 从多货品那一支**提到工厂层**，签名 `(realmId)` → `(page, realmId)`（页路径由调用方按**既有口径**算好传进来）；多货品那一支改成 `addBackPathFor(realmId) = addBackPath(backPathOf(realmId), realmId)`；**销售那一支**的 303 从"一行直拼"改成 `const addedBackPage = …'?added=1'; return res.redirect(303, addBackPath(addedBackPage, realm));` | 同上（**只有一处实现** ✓ 不写第二套 ✗） |
| ③ | `server/src/views/scanPage/paymentBlock.js` | `saleFormHtml` **新增** `realmScanConfigHtml({configJson, scanNow})`（与 `multiItemBlock.js` 那一份**逐字同形**，含 `<` ⇒ `\u003c` 的转义 ✓）并把它接进返回的 HTML（**空串时一个字节都不多** ✗ —— 第一版写成独立一行 ⇒ 多出 1 个换行 × 2 页 = `AC-SP-1` 当场红 508,319 ✗，已修 ✓） | 只改前两处"**不弹**"（见第一节的实测）⇒ 这一处是必要的视图小改 |
| ④ | `server/test/multiItemLogsAndRealmScan.test.js` | **成对迁移** AC-ML7 ② 的缺省集合断言：`{replenish, purchase_return}` → `{replenish, purchase_return, sales}`（断言强度不变 ✗ 只把集合本身搬了） | 同 ① |
| ⑤ | `server/test/salesRealmScan.test.js`（**新**） | AC-SR1…SR7（见第四节） | 本卡 |

**没碰的东西（红线）**：
· `services/scanWriteService.js` —— **逐字节未改**（sha256 `49772bda…2c12` ✓ 由 `AC-SR7` ＋ 既有冻结哨兵钉着 ✓）；
· `views/scanPage/multiItemBlock.js` / `replenishBlock.js` / `returnBlock.js` —— **一个字都没动** ✗（补货 / 退货那两条链零改动 ✓）；
· `views/scanPageRealm.js` / `config/scanPage.js` / `services/scanPageService.js` / `config/scanWrite.js` / `config/multiItemOrder.js` —— **一个字节都没动** ✗。

## 四、验收标准逐条对照（每条都**能真红**）

| 判据 | 内容 | 证据 |
| --- | --- | --- |
| **AC-SR1** ⭐⭐（核心） | 销售页点加货 ⇒ 303 **带 `?scan=1`**：`/s/{编号}?added=1&scan=1`（**相对地址**，逐字 `<br>` 既有 `?added=1` 一个字没动 ✓）；反方向：把 `sales` 从配置里去掉 ⇒ 回到 `/s/{编号}?added=1` | 真 HTTP 路由 ＋ **真 `scanWriteService`** ＋ 真会话存储 |
| **AC-SR2** ⭐ | 带 `?scan=1` 打开销售页 ⇒ `data-view="realm-scan-config"` ＋ `data-scan-now="1"` ＋ `data-view="realm-scan"`（脚本内联）＋ `data-view="realm-scan-notice"`（人话落点）＋ 配置里 `realm=sales` | 同上（从 HTML 里读，**不信源码** ✗） |
| **AC-SR2b** ⭐⭐ | 销售那一份 `data-config` 与**补货**那一份**逐字同形**（只有 `realm` 一格不同 ⇒ 归一后 `deepEqual`；键集也一致） | 「形状与补货一致」的**可执行**判据 ✓（哪一边漂了就红 ✓） |
| **AC-SR3** ⭐⭐⭐ | 扫完那件**落进销售本单**：把**真渲染出来**的配置喂给那段脚本（`node:vm` 真跑 ✓）⇒ 落点 = `{同源}/r/rec_K2?from=sales` ⇒ 顺着它走**真路由** ⇒ 落回 `realm-block--sales` ⇒ 在那一页加货 ⇒ **真 `session.sale.lines` 里出现那一件**（尺码 = 她选的、货号 = 扫到的那一件 ✓） | **拿真链路的返回值钉** ✓ 不猜 ✗ |
| **AC-SR4** ⭐⭐ | 不带触发参数打开（裸开 / `?from=sales` / `?from=sales&added=1`）⇒ **一个字节都不多**；＋ 仓库既有那把尺子 `tools/task61-render-baseline.js` = **508,317 字节 / sha `a79c59c3…cdb5`** 逐字节不变 ✓ ⚠️ 这两个数与 `test/scanPageSplitParity.test.js` 的 **AC-SP-1** 是**同一把尺子** ⇒ 谁改渲染基线（例：`#765` 那个"四 tab 库存口径"开关哪天翻成 `true`）⇒ **两处一起成对迁移** ✗（`docs/frozen-sha-pin-rule-2026-10-16.md` 的形状） | 不会乱弹 ✗（页面一加载就弹相机是最糟的 ✓） |
| **AC-SR5** 🔴 | 非飞书（没有 `tt`）⇒ 那段脚本写 `texts.noSdk` 那句人话（**真跑**那段脚本验的 ✓）且**绝不跳走**；＋ 销售页上**真有**那句人话的落点（`<p class="hint" data-view="realm-scan-notice">` ✓）⇒ **不留一个点了没反应的按钮** ✗ | 她最恨"点了没反应" ✓ |
| **AC-SR6** ⭐⭐ | 三条链的 303 `Location` **逐字**钉住（开关**关**：三条都不带触发参数 ＋ 销售逐字 `?added=1`；开关**开**：补货 `?from=replenish&scan=1`、退货 `?from=purchase_return&scan=1`、销售 `?added=1&scan=1`）＋ 配品那一颗（`add_accessory`）**不带**触发参数（本卡刻意不碰 ✓）＋ 渲染层那把 508,317 字节的尺子 ✓ | 补货 / 退货**一个字都没变** ✓ |
| **AC-SR6b** ⭐ | 配置先行：领域→链**可配**；`sales` 那一格 = `config/multiItemOrder.js` 的 `chains.sales.id`（**既有链名**，不是新发明 ✗）；`addBackPath` **只有一处定义**（源码哨兵 ✓） | 她定的"配置先行 / 不写第二套" ✓ |
| **AC-SR7** 🔴 | 冻结件 `scanWriteService.js` 逐字节未改（sha256 钉住 ✓）＋ 销售那一块**复用** `views/scanRealmScan.js` 的渲染件（不另写一份 HTML ✗） | 红线 ✓ |

### 变异（**4 组，都真红**）

| 变异 | 红了几条 |
| --- | --- |
| **A** 三处产品代码全部还原成 `origin/main`（= 本卡之前） | **8 / 9 红**（AC-SR1 / SR2 / SR2b / SR3 / SR5 / SR6 / SR6b / SR7；只有 AC-SR4 绿 —— 它测的是"不带 `?scan=1` 时不许变"，基线本来就成立 ✓） |
| **B** 只去掉配置里的 `sales` 那一格（其余不动） | **7 / 9 红**（AC-SR1 / SR2 / SR2b / SR3 / SR5 / SR6 / SR6b；AC-SR4 / SR7 绿 ✓） |
| **C** 只去掉销售页那一处配置块插值 | **4 / 9 红**（AC-SR2 / SR2b / SR3 / SR5）⇒ 证明"那 15 行视图小改"是**必要**的 ✓ |
| **D** 只把销售那条 303 写回本卡之前的形状 | **4 / 9 红**（AC-SR1 / SR3 / SR6 / SR6b）⇒ 证明核心判据真的钉在那一条上 ✓ |

**还原逐字节一致**：每次变异后 `cp` 回备份 ⇒ `git diff --cached | shasum -a 256`
= `e5f192379e5a8f42fc4cb57bccdc3ecfc5727f96fe8c3d895c0ea36b0b2172aa`（与变异前**同一个 sha** ✓）。

## 五、两遍全量

| 遍 | 命令 | 结果 |
| --- | --- | --- |
| 第 1 遍 | `CI=true /usr/local/bin/node --test --test-concurrency=1`（`server/`） | 见 PR 说明（`EXIT=0` ✓） |
| 第 2 遍 | 同上 | `EXIT=0` ✓ |
| 两遍之间 | `git diff --cached \| shasum -a 256` | 两次同一个 sha ✓ |

⚠️ 用**系统 node** `/usr/local/bin/node`（DSH 自带的那一个加载不了 `sharp` ⇒ 50+ 文件假红 ✗）。

## 六、如实登记的未做项

1. **真机未验**：本机跑不了飞书客户端 ⇒ "点一下真的弹出相机"只能靠**假 DOM 真跑那段脚本**（`AC-SR3` / `AC-SR5`）
   ＋ 领域内扫一扫既有那套判据（`test/realmScanClient.test.js`）—— **真机自测要她在飞书里点**。
2. **线上 `.env` 没动** ✗：`SCAN_REALM_SCAN_CHAINS` 没覆盖 ⇒ 缺省串生效（含 `sales` ✓）。
   要**只关销售**这一条 ⇒ 配 `SCAN_REALM_SCAN_CHAINS=replenish:replenish,purchase_return:return` ✓。
3. **配品那一颗（`add_accessory`）刻意不带触发参数**：她的口径点名的是「**货品**」那颗「＋ 再加一个货品」；
   配品不是货品扫描 ⇒ 本卡不碰（`AC-SR6` 反向钉着 ✓）。若她要把配品也接上 ⇒ 另一张卡 ✓。
4. **`?scan=1` 与"第一件（加入本单）"**：销售页草稿为空时那颗按钮文案是「➕ 还要加一双」，
   但它是**同一颗**按钮、同一个 action ⇒ 语义上无法区分"第一件 / 再加一件"，
   ⇒ 本卡对**两者一致**地带上触发参数（与补货 / 退货那两颗**同一行为** ✓ 她那颗入口在那边也是无条件的 ✓）。
   若她只要"第二件起才弹" ⇒ 需要按 `result.count > 1` 再分一档（**本卡没做** ✗ 如实登记）。
