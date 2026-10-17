> ⛔ **作废（2026-10-16 22:0x · 业务负责人逐字）**：
> 「**存草稿的功能都删除吧，不需要了，前端和后端都不需要了，整个链路都删除**」
> ⇒ 本文记录的 S3（路由半：GET 喂 `page.draft` / 接住 `save_draft` / 接住 `?resume=1`）**已随整条链一起退场** ✗。
> ⚠️ **本文仅供历史追溯** —— 不要再据它接线 ✗。
> 🔴 **没退场**的是「一单多货」那套**本单草稿** ✓。

# 「存草稿 · 接着录」**S3（路由半）** 落地记录 —— 2026-10-16

> **本步是什么**：S1（独立存储层 `services/scanDraftService.js` · #732）＋ S2（渲染半
> `views/scanPageRenderer.js` ＋ `config/scanPage.js` · #735）**都已在 main** ✓
> ⇒ 本刀补上最后那一半：**`routes/scanPage.js` 里的接线**（GET 喂 `page.draft` /
> 接住 `save_draft` / 接住 `?resume=1`）＋ `config/scanDraft.js` 的存成功那一句 ✓。
>
> **口径的唯一来源**（**不自己解释** ✗）：业务负责人 2026-10-16 逐字
> —— 见 `docs/draft-save-resume-plan-2026-10-16.md` 的文首追加节。

---

## 1. 她的话（逐字 · 决定本刀的形状）

```
· 「我们的**补货和退货需要支持存草稿**功能…需要支持**存草稿后续再处理**」
· 「我们的**销售货品页上面也需要加一个按钮，叫「存报货草稿」**」
· ⭐ **两种草稿**：「1. 销售页和补货页存补货草稿   2. 退货页存退货草稿」
· **保留 7 天** ✓ **只留一份** ✓（第二次存覆盖 ＋ 留痕 `scan.draft.overwritten` ✓）
· ⭐「**草稿也写明细**」⇒ 存草稿 = 「采购主表」1 行（`到货状态=未报货`）＋「采购明细」N 行
· **接着录**：进页面若有草稿 ⇒ 提示条「你有一份草稿，接着录吗？」✓ **不点就正常新建** ✓
```

---

## 2. 本刀改了什么（**逐条能指到一行**）

| # | 改哪 | 干了什么 |
| --- | --- | --- |
| ① | `routes/scanPage.js` 的 GET 渲染路径 | 喂 `page.draft`（**只有这一处** ✓）：`{ enabled, hasDraft, productCount, lineCount, updatedAt }`；**五个字段全部来自 S1 的 `readDraft`**（不另读文件、不读表 ✗） |
| ② | 同上 · POST | 接住 `DRAFT_ENTRY.saveAction`（`save_draft`）：**只调 S1 的 `saveDraft`** ⇒ 成功 **303 回本领域那一页** ＋ `?saved=1`（PRG ✓ **有形反馈** ✓）；失败 ⇒ 写层那一句人话（**不许无声 / 不许假成功** ✗） |
| ③ | 同上 · GET ＋ `?resume=1` | **她点了【接着录】才走**：把草稿那几件填回**同一个落点**（补货 / 退货 = 会话暂存 `multi_items`；销售 = 本单 `sale.lines`）⇒ 之后的"加货 / 提交"与"一次性录完"**完全同一条路** ✓（零分叉） |
| ④ | `config/scanDraft.js` | 新增 `texts.saved`（存成功那一句；文案的家在配置 ⇒ 路由里**一个中文都不写** ✗） |
| ⑤ | `config/scanPage.js` | `DRAFT_ENTRY` 新增 `savedQueryKey` / `savedQueryValue`（回跳标记也走配置 ✓）；删掉那句"**S3 还没接住**"的过期注释 |
| ⑥ | `views/scanPageRenderer.js` | 三处"待接线"的**过期注释**改成"已接"（**渲染逻辑一行没动** ✗） |
| ⑦ | `test/scanDraftRouteWiring.test.js`（新建） | 13 条判据（AC-D3a…AC-D3i2） |
| ⑧ | `test/scanDraftRenderEntry.test.js` | **成对迁移一条**（见 §5） |

### 2.1 ⭐ `page.draft` 的那五个字段**从哪来**（"喂了什么 = 读了什么"的可核对证据）

```js
// routes/scanPage.js · draftUiFor()  —— 读的就是 S1 那一个方法
const loaded = await service_.readDraft({ openId: openIdOf(req), requestId: req.requestId });
//   loaded.status === 'draft' ⇒ { enabled: true, hasDraft: true,
//                                  productCount: items.length,
//                                  lineCount: draft.line_count,
//                                  updatedAt:  draft.updated_at }
//   loaded.status !== 'draft' ⇒ { enabled: true, hasDraft: false }   ← 只有按钮、没有提示条
//   !draftRealmEnabled(realm) / 开关关着 ⇒ null                       ← 一个字节都不出
```

判据怎么证明它**不是**另读一份：`AC-D3b` 把**真写下去的明细行数**、
`readDraft().draft.line_count`、**提示条上那个数字**三处**并排比**（见 §4）。

---

## 3. ⭐⭐ 一个不显然的设计点：「接着录」的草稿**当前这一件要排掉**

她那一页的表单里，**当前扫到的这一款**就是 hidden `multi_items` 的**首件**（`entries` 为空、
由路由在提交时合并 —— 渲染层与引擎**同一条既有口径** ✓）。草稿里那份**也含**这一款。

⇒ 如果【接着录】把草稿**原样**灌进暂存，页面上同一件会出现两次（首件空 entries ＋ 暂存那份旧的），
提交时 `addItem`/`mergeFirstItemEntries` 会让**渲染层那份空的**覆盖她刚填的 ⇒ **静默丢值** ✗✗。

⇒ 本刀：**resume 时把"当前这一件"从暂存里排掉**（与渲染层 `others` 过滤、`mergeFirstItemEntries`
`AC-MIRW-3` **同一条口径** ✓）。她那一份**内容**没丢（它就在表单里，看得见、改得动 ✓）。

⚠️ 同理，`draftItemsOf`（存草稿时收口）里"她这一页刚填的"**排在最后**（同一件**后写的赢** ✓）
—— 否则会被上一次草稿里的那份旧值盖掉 ✗。

---

## 4. 判据（`test/scanDraftRouteWiring.test.js` · 13 条全绿）

| 判据 | 钉什么 | 去掉哪一句就红 |
| --- | --- | --- |
| **AC-D3a** | 三处入口（销售 / 补货 / 退货）**真出现** 且那颗 submit 的 `name/value` = 既有 `action` / 配置的 `saveAction`；库存 / 标签页**不出** | GET 里不喂 `page.draft` |
| **AC-D3a2** | `SCAN_DRAFT_ENABLED=false` ⇒ **一个字节都不出**（影子 / 回滚位 ✓） | 把开关判断去掉 |
| **AC-D3b** | 存草稿 ⇒ **主表 1 行（未报货）＋ 明细 N 行**；303 回本领域 ＋ `saved=1`；再 GET ⇒ **提示条出现**；⭐ 明细行数 = `readDraft().line_count` = 提示条上那个数字 | `save_draft` 分派 / `hasDraft` 那一位 |
| **AC-D3c** | 同一份存两次 ⇒ 明细**不翻倍**（同一把幂等键）；主表两次**同一把**草稿行键 | 幂等键里塞时间/随机 |
| **AC-D3d** | 零副作用：**只碰**「采购主表 ＋ 采购明细」两张表（`update` 0 次；库存 / 资金表 0 次） | 顺手写库存 / 发群 |
| **AC-D3h** | 草稿**不碰**收款 / 实收 / 资金状态（不落资金页、多货品提交引擎 0 次） | 把 `save_draft` 接到资金那条路 |
| **AC-D3e** | 存 → 重进带 `?resume=1` ⇒ 已加货品 / 尺码 / 数量 / 供应商**逐字 deepEqual**（与**草稿那一份**比，不拿手写夹具比）；不带 `?resume=1` ⇒ 草稿**一个字都不进页面**、也**不许被改** | `hydrateDraftForResume` 那一段 |
| **AC-D3e2** | 【接着录】之后点「＋ 再加一个货品」⇒ 草稿那件**一件都不丢**、她刚填的那份**真进了暂存**、草稿**一个字节没动** | resume 时只填"当前这一件" |
| **AC-D3f** | **不点提示条** ⇒ 去掉草稿入口那一段之后与"今天（不喂 `page.draft`）"**逐字节相同** | 提示条 / 入口无条件渲染 |
| **AC-D3g** | 9 点推送候选（`未到货`）**捡不到**草稿行；⭐ 反向钉：把草稿行的状态改成 `未到货` ⇒ **立刻捡到**（⇒ 判据不是空跑 ✓） | 草稿行写成 `未到货` |
| **AC-D3g2** | 草稿行是 `未报货` ＋ 幂等键**自己的独立前缀**（不冒充已提交事实 ✓） | 前缀改成 `purchase_batch:` |
| **AC-D3i** | 🔴 冻结件 `services/scanWriteService.js` 与 main **逐字节一致**（sha256） | 动它一个字 |
| **AC-D3i2** | 接线里的领域清单 / 动作名 / 查询键**都从配置取**；路由不直连写链路服务、不散写中文 | 在路由里写死 `save_draft` / 中文文案 |

---

## 5. ⭐ 成对迁移（**改前逐字 → 改后逐字 → 依据**）—— 一条，且**不是放宽**

`test/scanDraftRenderEntry.test.js` 的 **AC-D2f3**（S2 那一刀自己写的哨兵）：

```
改前逐字（S2 当时成立，S3 之后就成了"拿一句谎当哨兵" ✗）：
  assert.equal(/(?:resumeQueryKey|\bresume\b)/.test(src), false,
    '🔴 routes/scanPage.js 里**还没有**读 ?resume（S3 才接）⇒ 本刀如实标「待接线」✓');
  assert.match(RENDERER_SRC, /待接线/, '渲染层要如实写明这一步的接线在 S3（不假装已经接上 ✗）');

改后逐字：
  assert.match(src, /draftEntry\.resumeQueryKey/,
    '⭐ 路由按**配置**里的查询键读 ?resume（S3 已接；不写死 resume 字面量 ✓）');
  assert.equal(/待接线/.test(RENDERER_SRC), false,
    '渲染层**不再**标"待接线"（S3 已接上 ⇒ 那句话已经过期 ✗）');

依据：S3 落地了（`routes/scanPage.js` 读 `resumeQueryKey` 并把草稿填回页面 ✓
      —— 判据在 `test/scanDraftRouteWiring.test.js` 的 AC-D3e ✓）。

⚠️ **不是放宽**：本测试真正要保的两条不变量**一个字都没动** ——
  ① 不传 `page.draft` ⇒ 一个草稿字节都不出；
  ② 两道闸门（`draft.enabled !== true` / `draft.hasDraft !== true`）还在 ✓。
```

`test/scanDraftSaveResume.test.js`（S1 的 15 条）· `test/scanDraftRenderEntry.test.js` 其余 6 条
· 其余全仓用例：**一条都没删 / 没 skip / 没放宽** ✓。

---

## 6. 验证（两遍 × 全量 ＋ 变异）

* **全量两遍**：`node --test --test-concurrency=1`（数字见 PR 说明）· 两遍取**真 EXIT**（不接管道 ✗）
  · 两遍之间 `git diff | shasum -a 256` **逐字节相同** ✓。
* **变异 2 组**（每组单独跑、确认**真红**，跑完逐字节还原 ✓）：
  1. 删掉 GET 里喂 `page.draft` 那一段 ⇒ **AC-D3a** 红（三处入口不出现）＋ **AC-D3b** 红（提示条不出现）；
  2. 删掉 `save_draft` 那条分派 ⇒ **AC-D3b / AC-D3c / AC-D3d** 红（POST 落到 unknown_action，400）。
* 🔴 **冻结件**：`services/scanWriteService.js` 的 sha256 与 main **逐字节一致**
  （`AC-D3i` ＋ 既有 `test/scanWriteServiceFrozen.test.js` 两处都绿 ✓）—— **本刀一个字没碰它** ✓。

---

## 7. 如实登记：**没做 / 待决策**（不许含混 ✗）

| # | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| ① | **总开关翻真**（`SCAN_DRAFT_ENABLED=true`） | 🔴 **未做**（缺省仍 `false`） | 计划里的 **S4**：配置 ＋ `.env.example` ＋ 先测试 Base 真跑 1 轮。⚠️ 开关是**显式布尔** ⇒ 线上要开必须由 Lead 下命令（**本刀不翻** ✗） |
| ② | `.env.example` 补 `SCAN_DRAFT_*` | ⏳ **未做**（属 S4） | 本刀只加了 `SCAN_DRAFT_TEXT_SAVED` / `SCAN_DRAFT_SAVED_QUERY_KEY` / `SCAN_DRAFT_SAVED_QUERY_VALUE` 三个**有缺省值**的键，同样留给 S4 一起写 |
| ③ | **生成报货单**那一下（`未报货 ⇒ 未到货` ＋ 按供应商拆分） | ✅ **已在 main**（#736 / #737） | 本刀**不重复做** ✗ —— 见 `docs/supplier-split-at-generation-2026-10-16.md` |
| ④ | ⚠️ **工作台「到货验收情况」投影会把草稿行读进去** | 🔴 **已核实的事实 · 未改** | `services/purchaseQueryService.js` 的 `listPurchaseArrivals` 只过滤"**没有任何到货状态**"的行 ⇒ `未报货`（草稿）**会**出现在 `GET /api/workbench/purchase/arrivals` 的返回里。⚠️ 但**前端没有任何调用方**（`server/public/workbench/config/*` 里没有这个 URL ⇒ 现状是**够不着**的）⇒ 本刀**不动那个服务**（不在本刀写作用域；现有用例也没钉这一条）**如实登记**给 Lead 决策 ✓ |
| ⑤ | 销售页草稿的**配品行** | ⚠️ **如实留白** | 销售本单里那一行"其他配品"**不进**采购草稿（草稿那一份的形状只有货品 × 尺码，没有配品位）⇒ 只存**鞋**那几行；要支持配品 = 改 S1 的草稿形状 ⇒ Lead 排期 |
| ⑥ | 销售草稿**没有供应商** | ⚠️ **如实留空** | 销售本单那一份里本来就没有供应商（那是采购口径）⇒ 草稿里 `supplier_record_id` 为空，**不编** ✗（生成报货单时按供应商拆分那一步要拿它 ⇒ 需要她补口径） |
| ⑦ | `clearMultiItemPending`（"存草稿之后把暂存清掉"） | 🔴 **刻意不做** | 见 §3 的取舍：存草稿是**单向投影**（取页面现状 ⇒ 写草稿），**页面上看得见的那份一个字都不动** ✓（清了反而会让她"刚加的那件不见了" ✗） |

---

## 8. 红线对照（**逐条**）

| 红线 | 本刀 |
| --- | --- |
| 🔴 `services/scanWriteService.js` 一个字不加/删/改 | ✅ **零改动**（sha256 哨兵绿 ✓，判据 `AC-D3i`） |
| 🔴 不碰 `routes/workbench.js` · `public/workbench/**` · `config/scanWrite.js` | ✅ 一处未碰（判据 `AC-D3i2` 反向钉"路由不直连写链路服务"） |
| 🔴 不动别人 worktree | ✅ 只在 `.local/draft-s3` 里改 |
| 🔴 **严禁部署** · 飞书 CLI · `--admin` · 合并 PR | ✅ 都没有（**只开 PR**） |
| 生产 Base 只读 | ✅ 本刀**一次表都没读**（全部判据走**假 gateway 记账**） |
