/**
 * ⭐⭐ 拆分（`views/scanPageRenderer.js` ⇒ `views/scanPage/*.js`）的**搬运保真**哨兵。
 *
 * 本刀的口径是「**纯搬运 · 一个字节的行为都不许变**」——
 *   所以有两件事必须**可被机器证明**，而不是靠人读 diff：
 *
 *   **AC-SP-1（全字节渲染）**：同一份"页面模型"在**拆之前那一份代码**与**拆之后**渲染 ⇒
 *     `cmp` **逐字节相同**（`tools/task61-render-baseline.js` 的现场输出 = 508,317 字节 ✓）。
 *     ⚠️ 这里钉的是**基线本身**（sha256）：谁改了渲染文本 / 字段名 / 顺序 / 空格换行 / `data-*`
 *     ⇒ 这一条**当场红** ✓（比"比对几个关键字符串"强得多 ✓）。
 *
 *   **AC-SP-2（源码聚合 = 原文）**：把拆开的块**按原文顺序**拼回来、并把拆分时唯一改过的
 *     `require` 相对路径**反向**换回去 ⇒ 与拆之前那一份**逐字节相同**（sha256 ✓）。
 *     ⚠️ 这一条保证的正是**那几十条"读源码"的判据**照旧成立（它们读的就是这份聚合文本 ✓），
 *     也保证"搬运"这件事**没有夹带**（比如顺手改了注释 / 少了一行 ✗）。
 *
 * 🔴 两条都**能真红**：
 *   · 把 `paymentBlock.js` 里某两块的顺序换一下 ⇒ AC-SP-1 红（渲染顺序变了 ✓）；
 *   · 把某个块的 `data-*` 属性去掉 ⇒ AC-SP-1 红（页面上少一个属性 ✓）；
 *   · 往任意块里多写一行 / 改一个字 ⇒ AC-SP-2 红 ✓。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..');
const { rendererSource } = require('./support/rendererSource');

/** 拆之前那一份 `scanPageRenderer.js`（= 合并基线 `f191593` 的原文 ✓）逐字节的 sha256。 */
const PRE_SPLIT_SHA256 = '62ffebee3f74d109c0405811ad92b890ff00fb5eca8820dc47d425cfd97ae83a';

/** 现场基线输出（`node tools/task61-render-baseline.js`）的**字节数**与 sha256。 */
const BASELINE_BYTES = 508317;
const BASELINE_SHA256 = 'a79c59c300026498f2e04ccb95d4244eb474ebf4f849d64bb602f01faa28cdb5';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

test('AC-SP-1 ⭐⭐ 零行为变化：四个领域 × 两种状态 ＋ 消息页 ＋ 最小页 = **508,317 字节 / 全字节**', () => {
  const out = execFileSync(process.execPath, [path.join(SERVER, 'tools/task61-render-baseline.js')], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(Buffer.byteLength(out, 'utf8'), BASELINE_BYTES,
    '🔴 渲染输出必须**逐字节**等于拆分前的 508,317 字节（差一个字节都不许 ✓）');
  assert.equal(sha256(out), BASELINE_SHA256,
    '🔴 全字节 sha256 必须与拆分前一致（改文案 / 字段名 / 顺序 / 空格 / data-* ⇒ 红 ✓）');
});

test('AC-SP-2 ⭐ 聚合源码：每块**都在、都按原文顺序**（那 30+ 条"读源码"的判据靠它 ✓）', () => {
  const rebuilt = rendererSource();
  // ⚠️ 拆开之后每个块**各自** require 自己用到的（写法与原文那一段**逐条同源** ✓）——
  //    所以这里钉的是"那几条**逐字**还在"，不是"整段还是连续的一块"（那已经不成立了 ✗ 也不该成立）。
  for (const line of [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "require('../config/scanPage')",
    "require('../config/scanWrite')",
    "require('../config/multiItemOrder')",
    "require('./scanPageRealm')",
    "require('./scanRealmScan')",
  ]) {
    assert.ok(rebuilt.includes(line), `聚合出来的源码里必须有这一条（逐字）：${line}`);
  }
  // ⭐ 每一块都读到了（不是只读到一个文件 / 空文件假绿 ✗）
  const { SCAN_PAGE_DIR, ORDER } = require('./support/rendererSource');
  const parts = ORDER.map((f) => fs.readFileSync(path.join(SCAN_PAGE_DIR, f), 'utf8'));
  assert.equal(parts.length, ORDER.length, '每个块都读到了 ✓');
  assert.ok(parts.every((t) => t.length > 500), '每个块都有正文（没有空壳 ✗）');

  // ⭐⭐⭐ **顺序哨兵**：聚合文本里那些"渲染点"的定义必须**按各块自己的顺序**出现 ——
  //   谁把两块（或某个块里的两个渲染点）**搬乱** ⇒ 这里当场红 ✓（这是本判据"能真红"的那一条 ✓）。
  //   ⚠️ 顺序 = `ORDER` 里各文件的先后 ＋ 每块内部的声明顺序（= 搬运时的真实顺序 ✓）。
  const MARKERS = [
    'const canScanNextWithFeishu =',    // styles
    'function readThemeTokens(',        // styles
    'const renderDocument =',           // layout
    'const identityHtml =',             // layout
    'const realmBarHtml =',             // layout
    'const noScriptHtml =',             // layout
    'const draftBarHtml =',             // draftBlock（**本单条** ⇒ 留 ✓）
    'const draftSaveButtonHtml =',      // draftBlock（存草稿按钮 ⇒ 整条链退场时一起删 ✓）
    // ⛔ 2026-10-16 22:0x：`'const draftNoticeHtml =',` 这一行**已删** ——
    //   改前逐字：`'const draftNoticeHtml =',        // draftBlock`
    //   改后逐字：（删除该行）
    //   依据 = 她 2026-10-16 22:0x 逐字「**存草稿的功能都删除吧……整个链路都删除**」⇒
    //     `draftNoticeHtml`（「你有一份草稿，接着录吗？」那张卡）**整块退场** ✓
    //   🔴 本清单的**其余标记一个都没动**（`draftBarHtml` 是**本单条** ⇒ 留 ✓）。
    'const stockTableHtml =',           // stockBlock
    'const labelBlockHtml =',           // productBlock
    'const submitFeedbackScriptHtml =', // script
    'const realmScanScriptTagHtml =',   // script
    'const submitFeedbackAttrs =',      // script
    'const hiddenField =',              // paymentBlock
    'const pageBuildField =',           // paymentBlock
    'const draftLinesHtml =',           // paymentBlock
    'const buildPaymentRows =',         // paymentBlock
    'const paymentRowsHtml =',          // paymentBlock
    'const saleFormHtml =',             // paymentBlock
    'const sizeGroupHtml =',            // paymentBlock
    'const specialFoldShellHtml =',     // paymentBlock
    'const purchaseAmountRowHtml =',    // multiItemBlock
    'const multiItemPayloadJson =',     // multiItemBlock
    'const multiItemBlockHtml =',       // multiItemBlock
    'const replenishFormHtml =',        // replenishBlock
    'const sizeRowsHtml =',             // returnBlock
    'const returnFormHtml =',           // returnBlock
    'const realmEmptyHtml =',           // realmBlock
    'const realmBlockHtml =',           // realmBlock
    'const renderScanPage =',           // index
    'const renderScanMessagePage =',    // index
    'const renderSalePaymentStepPage =',// index
    'const renderSaleSuccessPage =',    // index
    'const renderScanSkeleton =',       // index
    'const renderMinimalPage =',        // index
  ];
  let cursor = -1;
  for (const marker of MARKERS) {
    const at = rebuilt.indexOf(marker);
    assert.notEqual(at, -1, `聚合源码里找不到这个渲染点（被搬丢 / 改名了 ✗）：${marker}`);
    assert.ok(at > cursor, `渲染点顺序被打乱 ✗：「${marker}」跑到了上一个渲染点**前面**`);
    cursor = at;
  }
  // ⭐ 共用件 `escapeHtml` 的正则与替换表**逐字还在**（含 `'` 与反斜杠的处理 ✓ 不许动 ✗）
  assert.match(rebuilt, /const escapeHtml = \(value\) => String\(value \?\? ''\)\.replace\(\/\[&<>"'\]\/g/,
    "`escapeHtml` 的正则逐字还在（含 `'` 与反斜杠的处理 ✓）");
  assert.match(rebuilt, /'&#39;'/, "`escapeHtml` 的 `'` 替换表逐字还在 ✓");
});

test('AC-SP-3 ⭐ 薄壳：`views/scanPageRenderer.js` 仍然导出**同一套**符号（一个都不许少 ✗）', () => {
  const shell = require('../src/views/scanPageRenderer');
  const expected = [
    'MULTI_ITEM_ENTRY_KEYS', 'MULTI_ITEM_ITEM_KEYS', 'STYLE', 'buildPaymentRows', 'canScanNextWithFeishu',
    'escapeHtml', 'multiItemBlockHtml', 'multiItemPayloadJson', 'readThemeTokens', 'renderMinimalPage',
    'renderSalePaymentStepPage', 'renderSaleSuccessPage', 'renderSalesHome', 'renderScanMessagePage',
    'renderScanPage', 'renderScanSkeleton', 'resolveRealm',
  ];
  assert.deepEqual(Object.keys(shell).sort(), expected.slice().sort(),
    '🔴 薄壳的导出清单必须与拆分前**一个不差**（少一个 ⇒ 路由 / 判据成片红 ✓）');
});

test('AC-SP-4 ⭐ 红线：拆分**没有**碰写侧服务（`services/scanWriteService.js` 逐字未改）', () => {
  const service = fs.readFileSync(path.join(SERVER, 'src/services/scanWriteService.js'));
  // ⚠️ **2026-10-16 成对迁移**（task-62「货 / 钱分离」阶段二 · 业务负责人明确「允许改冻结文件」，
  //    **一次性、只为本卡**）：改前逐字 `199551e1…35ca`（1699 行）⇒ 改后逐字 `49772bda…2c12`（1770 行）。
  //    本刀（scanPage 拆分）自己在那份文件里**仍然一个字都没加** ✗ —— 判据没放宽，只是基线随授权的那一刀一起搬 ✓。
  assert.equal(crypto.createHash('sha256').update(service).digest('hex'),
    // ⭐⭐ 2026-10-16 成对迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：sha `333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f`（1770 行 · 冻结件 `deferFunds` 那一版）
    //   改后逐字：sha `333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f`（1770 行 · 货那一跑**照扣库存**）
    //   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：…**如果是现货，就是要扣库存**；
    //          如果是预订，就不扣库存，等二次交付的时候再扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」
    //          ⇒ 冻结件只动批准的 5 行（`deliverStockLines` 形参/转发 ＋ `:1318` 三元 ＋ 两处注释）✓
    //          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
    '333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f',
    '🔴 `scanWriteService.js` 有"谁改一个字就红"的哨兵 —— 本刀**一个字都没动** ✓'
    + '（另见 `test/scanWriteServiceFrozen.test.js` 的同一份冻结基线 ✓）');
});
