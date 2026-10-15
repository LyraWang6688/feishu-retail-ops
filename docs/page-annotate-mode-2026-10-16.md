# 页面标注模式（业务负责人 2026-10-16 亲口点的功能）

> 业务负责人原话（逐字）：
> 「我在**页面上**加一个小开关：你打开后，**点页面上的哪一块，那一块就高亮**，
>  并弹出它的**名字**（比如"退货折叠条"/"整单金额输入框"）⇒ 你截给我，我就**不用猜**了」
> 她选的范围（逐字）：**扫码页 + 工作台都做** ✓

## 1. 怎么用

打开任意扫码页 / 工作台页面，在 URL 后面加 `?annotate=1`：

- `https://<域名>/r/<recordId>?annotate=1`（新二维码那条；旧 `/s/{编号}` 一样可用）
- `https://<域名>/workbench?annotate=1`

打开后：

1. 鼠标移到任何元素上 ⇒ 该元素**高亮描边**（主色 + 半透明，颜色取主题令牌 `--primary` / `--primary-soft`，**没有写死颜色**）；
2. 点一下 ⇒ 底部弹一个 `position: fixed` 的小浮层，显示那一块的**名字**；
3. 浮层上有 **复制** 按钮（把那段名字复制走）与 **关闭** 按钮（关掉浮层）。

## 2. 名字怎么取（优先级）

| 顺序 | 判据 | 例子 |
| --- | --- | --- |
| ① | 这一块**自己**的 `data-view` | `data-view="purchase-return"` |
| ② | 往上最近的 `data-view`（点的是块里的一格） | `data-view="purchase-return"` |
| ③ | `tag + class`（最多 3 个 class） | `div.disclosure` |
| ④ | 往上最近的别的 `data-*` | `data-module="scan"` |
| ⑤ | 只剩标签名（**绝不返回空串**） | `div` |

## 3. 唯一真源与两种装载方式

- 文件：`server/public/workbench/shared/annotate.js`（**唯一真源**）。
- **扫码页**：`views/scanPageRenderer.js` 在渲染时把该文件**内联**进 `<script data-view="annotate">`
  （这一页不引外部资源 —— "一次请求打开"的初衷还在）。
- **工作台**：`public/workbench/index.html` 里 `<script src="/workbench/shared/annotate.js" defer>`。
- ⚠️ 两处**绝不各抄一份**：`test/pageAnnotate.test.js` 的 **AC-M6** 钉住"内联的 == 那个文件"逐字一致。

## 4. 🔴 闸门：只在 `?annotate=1` 时才出现（真实用户看不到）

脚本**开头就判 `location.search`、判完立刻 `return`**：

```js
if (!enabled()) return; // no ?annotate=1 => stop here: zero DOM, zero listeners.
```

不带参数 ⇒ **零 DOM / 零监听 / 不动任何表单**（运行时逐字无痕 ✓）。

### ⚠️ 为什么闸门落在**脚本内部**（而不是服务端按查询串决定注不注入）

查询串只有 `routes/scanPage.js` 拿得到，而那个文件**不在本任务写作用域内**（另有主）
⇒ 扫码页只能**无条件**带上这一段脚本、由它自己判。
⇒ 代价：不带参数时**渲染输出里**确实多了一行脚本标签（它什么都不做）。

**另一条路（未采用，留给以后）**：若允许在 `routes/scanPage.js` 加一处查询串透传
（`req.query.annotate` → 渲染层），就能做到"不带参数时 HTML **逐字节不变**"、
且既有哨兵几乎不用动。本 PR 按派活口径**没碰那个文件**。

## 5. 零 JS 哨兵的成对迁移（**不是放宽**）

「扫码页一行 `<script>` 都不许有」是**我方（agent 侧）**的约束，**不是她的口径** ——
她 2026-10-12 两次纠正：「我可没有说过，**我们是能够进行动态交互的**」。

按「**改前逐字 → 改后逐字 → 依据**」成对迁移的既有哨兵（每条都在测试里留了逐字对照）：

| 文件 | 迁移前 | 迁移后 |
| --- | --- | --- |
| `scanPageRealmServerSide.test.js`（**AC-W2**） | 全部脚本 ≤1 / =0（按有没有写按钮）＋ `不许再读 location.search` | **业务**脚本 ≤1 / =0 照旧 ＋ 那一段标注脚本**必须在且必须早退** ＋ `location.search` 只禁**正文** |
| `scanPageSixRealms.test.js`（**AC-6R5**） | 全部脚本 ≤1 / =0 | 同 AC-W2 口径 |
| `scanPageRealms.test.js` | 库存页 0 段 / 销售页 1 段 | **业务**脚本 0 / 1 段 ＋ 标注脚本必须早退 |
| `scanPrintFeedback.test.js`（AC-PF3 / AC-PF6 / AC-PF7） | 全部脚本 1 段 / 其余领域 0 段 | **业务**脚本同口径 ＋ 标注脚本必须早退 |
| `scanSaleTwoLayerMoney.test.js`（AC-1⑦） | 1 段 | 同上 |
| `scanSaleE2E.test.js`（第7步 / 资金页 / 不许新增脚本） | 1 / 1 / ≤1 | 同上（**上限一个字没动**） |
| `labelPrintScanEntry.test.js` | 1 段 ＋ 结果页正文零脚本 ＋ `location.search` 禁 | 同上（正文零**业务**脚本） |
| `uiTapTelemetry.test.js`（AC-UT4c） | "只有一段" | "只有一段**业务**脚本" ＋ 标注脚本必须早退 |
| `workbenchFourTabs.test.js`（AC5 / 结果页） | 全部脚本 ≤1 / =0 | 同上 |

⚠️ **没有一条判据被删或 skip**；迁移只做两件事：
① 把"脚本"点明成"**业务**脚本"（正则加 `(?! data-view="annotate")`）；
② **新增**一条"那一段标注脚本**必须在**且**必须早退**"。

## 6. 判据（`server/test/pageAnnotate.test.js`，全部能真红）

- **AC-M1** 不带 `?annotate=1` ⇒ 页面上**没有**浮层/描边结构，脚本**立刻早退**
  （在最小 DOM 沙箱里**真跑一遍**：零元素、零监听、body 零挂载）；
- **AC-M1b** ⭐ **探针**：把闸门那一句删掉 ⇒ 不带参数也会建 DOM ⇒ AC-M1 红；
- **AC-M2** 带 `?annotate=1` ⇒ 有标注脚本 ＋ 有名字的浮层结构；
- **AC-M3** 取名字：`data-view` 优先 ⇒ `class` 兜底（删任一分支 ⇒ 红）；
- **AC-M4** 浮层 `position: fixed` ＋ **复制按钮** ＋ **关闭按钮**；
- **AC-M5** 不打扰：新增一段、既有反馈脚本与表单提交一个字不动；
- **AC-M6** 工作台引**同一份**实现（内联的逐字 == 那个文件）；
- **AC-M7** ⭐ **探针**：删「复制」/「关闭」任一 ⇒ 对应判据红。

## 7. 不打扰（她的红线）

- 不改任何现有表单行为、不改提交、不加链接；
- 浮层 / 描边都是 `position: fixed` ⇒ **不挤动、不挡**正常页面结构；
- ⚠️ 标注模式下点一下会 `preventDefault` + 停传播 —— 这是**刻意的**：
  她正在指着某一块问"这是哪一块"，若那一下顺带把表单提交了/跳走了，标注就没法做。
  要正常操作 ⇒ 不带 `annotate=1`（或关掉浮层）。
