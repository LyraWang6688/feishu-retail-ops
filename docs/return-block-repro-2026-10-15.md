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

## 四、⭐ 附带发现（**不是她这次的形态**，但属"不撒谎"的同类缺口 —— **未改代码，等你派** ✗）

`rows: []`（连一行尺码都没有）时，退货块渲染成**空块**：既没有清单、也没有 `return-no-stock` 那句人话 ✗。
判据侧：`#614` 补的人话只覆盖「**有尺码行、但全是 0**」这一种 ✗，没覆盖「**一行尺码都没有**」。
建议修法（**具体到行**）：`src/views/scanPageRenderer.js` 的 `returnFormHtml` 里
`const noReturnableStock = declaredSizes.length > 0 && sizes.length === 0;`
⇒ 补一条"`declaredSizes.length === 0` ⇒ 也给一句人话（例如"这一款没有可退的尺码"）"的分支 ✓
（与 `return-no-stock` 同一套配置驱动 ✓ 不写死文案 ✗）

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
