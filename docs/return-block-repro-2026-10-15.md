# 退货块"还是一个退货按钮" —— 本地实测渲染报告（task-41）

**报告人**：scan-return · **时间**：2026-10-15 23:2x（上海时间）· **base**：`86e9909`
**她的原话（逐字）**：「另外我打开了退货，**还是一个退货按钮，bug 还是没有修复～**」
（截图：`HL92006 · 扫码`，领域条 `销售·补货·库存·退货` 选中「退货」，下面**只有一整颗蓝色「退货」按钮、没有尺码清单**）

---

## 一、结论（先说判定）

> ⭐ **判定：她看到的**不是**线上这份代码渲染出来的页面 —— 也就是「**她拿到的是旧页面**（飞书 webview 缓存 / 没重新扫）」这一侧，而不是"线上代码对她这款只画一颗按钮"** ✗

**三条实证（都在本机跑真路由 + 真渲染器，HTTP 200）**：

| # | 输入（她那种数据的形状） | `realm-block--purchase_return` 实测渲染 | 与截图是否吻合 |
|---|---|---|---|
| ① | 尺码 **40:3 · 41:0 · 42:1**（有货/缺码混着） | **2 个 `.size-row`**（40 / 42，41 已被滤掉 ✓）＋ 数量输入 ＋ 提交按钮 | ❌ **不吻合**（她截图没有尺码清单） |
| ③ | 有尺码行、**整款 0 库存** | **`data-view="return-no-stock"` 一句人话**，块内**没有按钮** | ❌ 不吻合（她截图有一颗按钮） |
| ④ | **连尺码行都没有**（`rows: []`） | 块**空的**（没有清单、没有人话、也没有按钮） | ❌ 不吻合（她截图有一颗按钮） |

⇒ **线上这份代码里，没有任何一种数据形状会渲染出"一整颗蓝色退货按钮、没有尺码清单"** ✗
⇒ 她那一页**不是**这份 HTML ⇒ **旧页面**（缓存 / 未重新扫码）是目前唯一能解释截图的假设 ✓

## 二、实测渲染片段（逐字，节选）

**① 她那种数据形状（40:3 / 41:0 / 42:1）** —— 退货块（节选，`.size-row` 逐字）：
```html
<section class="realm-block realm-block--purchase_return" ...>
  ... 每行：<label class="size-check"><input type="checkbox" data-stock="3" data-qty-name="..." name="return_sizes" value="40"> 40 码</label>
      <span class="hint" data-view="return-stock">3</span>
      <input class="size-qty" name="return_quantity_40" value="1" ...>
  ... 41 码**整行都不在**（`sellable === 0` 被滤掉 ✓ —— 这正是 #611/task-28 要的）
  ... 提交按钮在表单末尾
</section>
```
**③ 整款 0 库存** —— 退货块（节选）：
```html
<section class="realm-block realm-block--purchase_return" ...>
  <... data-view="return-no-stock"> 那句人话（来自 `SCAN_PAGE.returnForm` 配置）
  <!-- 块内没有 size-row、也没有提交按钮 ✓ 不给"点了没用的一颗按钮" -->
</section>
```
**④ 连尺码行都没有** —— 退货块：**空**（`<section class="realm-block realm-block--purchase_return" ...></section>`）

## 三、⚠️ 本报告的两条限制（如实说，不糊）

1. 🔴 **没用上"她的生产真数据"**：本机 `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` **就等于**
   `FEISHU_V1_E2E_TEST_APP_TOKEN`（我核过两个值相同 ⇒ 指向**测试 Base**）——
   这是 AGENTS §8 的**设计**（本机不配生产凭证，物理上够不着 ✗）。
   ⇒ 我渲染用的是「**她截图那种数据的形状**」（有货/缺码混着的尺码行），**不是** `HL92006` 那条记录本身。
   ⇒ **建议**：拿上面这份脚本在**服务器侧**（或生产只读口）跑一次同款复核；若生产里 `HL92006` 的尺码行**确实存在**，
   则判定不变；**若生产里它连一行尺码都没有** ⇒ 落到下面第 4 条（那是另一种形态，仍**不是**"一颗按钮"）。
2. ⚠️ **`return-sizes-unknown`（尺码这一读不到）这一档我没能在夹具里触发**：
   `rows: []` ＋ `sizes_degraded: true` 的渲染结果与 ④ 相同（空块）。该分支在既有用例
   `test/scanReturnStockFilter.test.js`（AC-RT11）里是用**假写服务给的 `sizes` 形状**钉住的 ✓ ——
   要精确复刻它需要真实 degraded 数据形状，本机拿不到 ⇒ **如实标注，不假装覆盖** ✗

## 四、🔴 更正（2026-10-15 深夜 · task-44）：本节原来的"附带发现"是**我看错了锚** —— 那一格**不是空的** ✗

**改前逐字**（本报告 v1，**已随 PR #634 合进 main** ✗）：
> `rows: []`（连一行尺码都没有）时，退货块渲染成**空块**：既没有清单、也没有 `return-no-stock` 那句人话 ✗。
> 判据侧：`#614` 补的人话只覆盖「有尺码行、但全是 0」这一种 ✗，没覆盖「一行尺码都没有」。
> 建议修法（具体到行）：`returnFormHtml` 里 `const noReturnableStock = declaredSizes.length > 0 && sizes.length === 0;` ⇒ 补一条分支 ✓

**改后逐字**（用**同一个真路由 + 真渲染器**重跑 `rows: []`，HTTP 200 实测）：
```html
<section class="realm-block realm-block--purchase_return" ...>
  <p class="hint" data-view="return-sizes-unknown">暂时取不到这一款的尺码，请稍后重试或手动核对</p>
  <p class="hint" data-view="return-form-hint" hidden>…</p>   <!-- 表单提示（隐藏，等脚本用） -->
</section>
```
⇒ **那一格有人话** ✓（`return-sizes-unknown`，文案来自 `config/scanPage.js` 的 `sizesUnknown`）✗ 不是空块。

**依据（我错在哪）**：v1 那次统计只看了 `return-no-stock` 与 **`return-stock-unknown`**（后者是**每一行**的锚 ✗），
**漏看了块级的 `return-sizes-unknown`**（`scanPageRenderer.js:1352` 那条 `sizes.length ? '' : …` 分支）——
"空块"是**我的统计口径漏了一个锚**造成的**误报** ✗，不是页面的真缺口。
🔴 **教训**：报"某格是空的"之前，必须把该块**所有** `data-view` 锚**逐个列出来**（本次已改成先列锚、再下结论 ✓）。

**另外更正一处措辞**：三句人话**本来就分得开** ✓（`task-28`/`#614` 已经做了）：
① 有货/缺码 ⇒ 每行 `return-stock`（＋行内"取不到"是 `return-stock-unknown`）；
② **整款 0** ⇒ `return-no-stock`（「这一款现在没有可退的库存」）；
③ **尺码整块读不到 / 一行都没有** ⇒ `return-sizes-unknown`（「暂时取不到这一款的尺码，请稍后重试或手动核对」）✓
（⇒ **不需要新增第三种文案** ✗ —— task-44 的第 1 项据此**撤单**：没有缺口要补 ✓）

## 五、她的操作建议（怎么拿到新页面）

1. **重新扫那张二维码**（不要用历史会话里的链接 —— 飞书 webview 会复用已缓存的页面）；
2. 若重扫后还是旧的：**在飞书里彻底关掉那个 webview**（返回聊天 → 从「最近」里划掉那个页面），再扫一次；
3. 仍不对：**退出飞书账号重进**（清 webview 的本地缓存）；
4. 复核判据：新页面上领域条选中「退货」时，**应该看到尺码清单（每行带"当前库存数量"）**，
   整款 0 库存时应看到**一句人话**——**都不是**"只有一颗按钮" ✓

## 六、复现方式（可复核）

本机（任一 worktree，含 `server/node_modules`）：
```bash
cd <worktree>/server
node return-repro-diag.cjs      # 脚本：真路由 createScanPageRouter + 真渲染器，四种形状各渲染一次
```
（脚本用 `createScanPageRouter({ service: { lookup }, gateway: {}, writeService: 假写服务, startSnapshot: false })`
＋ 会话 cookie，URL `${base}/s/<number>?from=purchase_return`，抓 `realm-block--purchase_return` 那一段 ✓
—— 与既有用例 `test/scanReturnStockFilter.test.js` 的夹具**同一套** ✓）

## 七、判据（本次报告的证据链）
- **AC-1** 用真路由 + 真渲染器渲染她的数据形状 ⇒ **有 2 行尺码**（40/42）＋ 41 被滤掉 ✓
- **AC-2** 「整款 0 库存」⇒ `data-view="return-no-stock"` 人话、块内无按钮 ✓
- **AC-3** 「一行尺码都没有」⇒ 空块（**附带发现**，见第四节）✓
- **AC-4** 三种情况在页面上**分得开**（清单 / 人话 / 空块）✓
- **AC-5** 未改任何代码（本 PR **只加这一份文档** ✓）；生产 Base **一个字都没写** ✓ · 未用飞书 CLI ✓
