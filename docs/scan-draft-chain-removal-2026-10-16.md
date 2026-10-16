# 「存草稿」整条链路删除 —— 决策与清单（2026-10-16）

> ⚠️ 本文件**只落口径与清单**（不改一行代码 ✗）。实现由另一条线（`.local/draft-removal`）承担。
> 状态：**进行中**（口径已定 ✓ / 代码未删 ✗）。

## 一、她怎么说的（原话 · 逐字）

> 「**存草稿的功能都删除吧，不需要了，前端和后端都不需要了，整个链路都删除**」
>
> —— 业务负责人，**2026-10-16 22:0x**（上海时间 +8）

## 二、要删的（按层，7 层）vs **要留的**

| # | 层 | **删**（=「存草稿 · 接着录」） | **留**（≠ 存草稿） |
|---|---|---|---|
| 1 | 配置 | `config/scanDraft.js` 整个文件（`SCAN_DRAFT_*` 全部）＋ `config/scanPage.js` 的 `DRAFT_ENTRY` / `resolveDraftEntryConfig` | `config/scanPage.js` 的 `DRAFT_BAR`（`draftBarLabel: '本单'` · `draftBarCount: '本单：{count} 双'`） |
| 2 | 服务 | `services/scanDraftService.js`（`readDraft` / `saveDraft` / 批次号沿用 / 明细行） | 会话级 `saveDraftLines`（`config/scanWrite.js` 的 `session.statuses.draft`）—— **本单**用的就是它 |
| 3 | 路由 | `routes/scanPage/index.js` 里的**三件事**：GET 喂 `page.draft` · 接住 `save_draft`（`draftEntry.saveAction`）· 接住 `?resume=1` | `clear_draft`（清空**本单**）· 提交链路 · `?saved=1` 之外的一切 |
| 4 | 视图 | `views/scanPage/draftBlock.js` 的 `draftUiOf` / `draftSaveButtonHtml`（三处入口）/ `draftNoticeHtml`（「接着录吗」提示条）＋ `views/scanPage/index.js` 里对 `draftNoticeHtml` 的拼装 | 同一个文件里的 **`draftBarHtml`（`data-view="draft-bar"`）** —— 整文件**不删**，只摘那三个函数 |
| 5 | 判据 | `test/scanDraftSaveResume.test.js` · `scanDraftRouteWiring.test.js` · `scanDraftRenderEntry.test.js` · `scanDraftClearAndInterrupted.test.js` | `test/scanPageDraftBar.test.js`（它自己写着「**测的不是草稿**」= 本单条 ✓） |
| 6 | 文档 | `docs/draft-save-resume-plan-2026-10-16.md` · `docs/draft-save-resume-s3-2026-10-16.md` ＋ `docs/README.md` 的那两行索引 | `docs/multi-item-order-design-2026-10-15.md` · `docs/supplier-split-at-generation-2026-10-16.md` |
| 7 | 本地数据 | `server/data/scan_drafts/`（运行时目录 · gitignored）；TTL 7 天 | `server/data/scan_sessions/`（会话 · 12 小时） |

## 三、⭐「存草稿」vs「本单草稿」的区分口径（**最容易删错的地方**）

| 判据 | 「存草稿」（**删**） | 「本单草稿」（**留**） |
|---|---|---|
| 开关 | `SCAN_DRAFT_ENABLED`（缺省 **true**） | 无开关 —— 会话天生带 |
| 活多久 / 存哪 | `data/scan_drafts/`，**7 天**，跨会话跨天 | `data/scan_sessions/`，会话 TTL（12 小时） |
| 写不写飞书表 | **写**：「报货批次」1 行（到货状态=未报货）＋「采购明细」N 行 | **一行都不写**（只写本地会话） |
| 怎么找回 | 提示条「你有一份草稿，接着录吗？」/ `?resume=1` | 停在同一个会话里继续填（刷新照旧） |
| 代码标识 | `SCAN_DRAFT_*` · `page.draft` · `save_draft` · `draftUiOf` / `draftSaveButtonHtml` / `draftNoticeHtml` | `draft-bar` · 文案「**本单**」· `saveDraftLines` · `statuses.draft` · `clear_draft` |

**一句话口诀**：看见 `SCAN_DRAFT_*` / `scan_drafts/` / `page.draft` / `save_draft` / `?resume=1` ⇒ **存草稿（删）**；
看见 `draft-bar` / 「本单」/ `saveDraftLines` / `statuses.draft` ⇒ **本单草稿（留）**。

## 四、不删的邻接件（易误删）

- `services/multiItemOrderService.js` ＋ `config/multiItemOrder.js` ＋ `test/multiItemOrder*.test.js`（一单多货品「加货 / 删货」）；
- `services/supplierSplitService.js` ＋ `config/supplierSplit.js` ＋ `test/supplierSplitAtGeneration.test.js`（**生成报货单**时按供应商分组）；
- `services/purchaseBatchNoGenerator.js` ＋ `config/purchaseBatchNo.js`（**真出单**的批次号生成器 —— 草稿只是**读过**它的口径）。

## 五、动手时的两个注意

1. 删掉「三处入口」那颗按钮会**改整页字节** ⇒ 凡按整页字符串/`deepEqual` 比的判据必须**成对迁移**（改前逐字→改后逐字→依据），**不许删断言** ✗。
2. `docs/draft-save-resume-s3-2026-10-16.md` 自己登记过一条：**工作台 arrivals 投影会读到「未报货」草稿行** ⇒ 删链路时一并核它的读路径。

## 六、边界

- 冻结件 `services/scanWriteService.js` **与本链路无关** ⇒ 一个字不动 ✓。
- 本清单由**只读**核对得出（`git grep` / 源码阅读）；**没有**改动任何业务代码 ✓。
