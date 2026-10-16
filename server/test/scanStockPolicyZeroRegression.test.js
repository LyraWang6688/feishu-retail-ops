'use strict';

/**
 * ⭐⭐⭐ **AC-ST7 零回归**：**开关关着 ⇒ 四页 HTML 与今天逐字节相同**（业务负责人 2026-10-16 20:5x 定的口径）。
 *
 * 为什么这条最重要：「统一口径」是一次**行为变更**；它必须**只在显式打开开关时**发生。
 *   关着（缺省）时，四个 tab 的产物必须**一个字节都不许差** ✗ —— 否则这次重构就顺手改了线上行为。
 *
 * 两层证据（**都是改前留档，不是我事后编的**）：
 *   ① `fixtures/scanStockPolicy.legacyHtml.json` —— **整页 HTML 的 sha256**（3 份夹具 × 4 个 tab = 12 个），
 *      由**改口径之前**那一份渲染器跑出来（两个独立进程各跑一次、逐字相同 ⇒ 见该文件 `_comment`）；
 *      ⇒ 覆盖**整页**（head / 顶栏 / 领域块 / 页脚）——任何一处多一个字节都会红 ✓
 *   ② `fixtures/stockStateConsistency.golden.json` —— **四个领域块的逐字原文**（前一位执行者的诊断留档，
 *      本刀之前 AC-ST3 在这份代码上跑过是绿的 ⇒ 它就是"今天"的逐字）⇒ 用 `assert.equal` **逐字**比 ✓
 *
 * 刷新办法（**只有真改了页面才该动它**）：改完确认那是有意为之 ⇒ 重跑
 *   `FX=server/test/fixtures/scanStockPolicyViews.js node -e "…"`（见 `docs/scan-stock-policy-2026-10-16.md`）
 *   并把新哈希写回 `scanStockPolicy.legacyHtml.json`；🔴 **不许**为了让红变绿而删判据 ✗。
 *
 * ⚠️ 本文件**不设** `SCAN_STOCK_POLICY_ENABLED`（缺省 = 关着）⇒ 跑的就是"今天"那条路。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('./fixtures/scanStockPolicyViews');
const { SCAN_STOCK_POLICY, ENABLED_KEY } = require('../src/config/scanStockPolicy');

const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scanStockPolicy.legacyHtml.json'), 'utf8'));
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stockStateConsistency.golden.json'), 'utf8'));

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** 旧版逐字快照的三个夹具（键名 = `stockStateConsistency.golden.json` 里的键）。 */
const GOLDEN_CASES = [
  { key: 'blocks', view: fx.THREE_STATE_VIEW, label: '门盒/样品/仓库 三种状态' },
  { key: 'blankStateBlocks', view: fx.FULL_SIZES_BLANK_VIEW, label: '她的现象（44 码 1 双在「未标状态」）' },
  { key: 'blankStateThreeSizeBlocks', view: fx.BLANK_STATE_VIEW, label: '未标状态 + 仓库 + 门盒样品 混在一款上' },
];

test('AC-ST7-pre ⭐ 本进程开关**真的关着**（缺省 = 今天）', () => {
  assert.equal(process.env[ENABLED_KEY], undefined, '本文件不许设那个变量（缺省那条路）');
  assert.equal(SCAN_STOCK_POLICY.enabled, false, '配置解析出来是关着');
});

test('AC-ST7a ⭐⭐ 开关关着 ⇒ **整页 HTML 的 sha256 与改前逐字相同**（12 个，`assert.equal`）', () => {
  assert.deepEqual(Object.keys(LEGACY.fullPageSha256).sort(), Object.keys(fx.VIEWS).sort(),
    '留档要覆盖三份夹具');
  let compared = 0;
  for (const [key, view] of Object.entries(fx.VIEWS)) {
    assert.deepEqual(Object.keys(LEGACY.fullPageSha256[key]).sort(), fx.REALM_IDS.slice().sort(),
      `${key}：四个 tab 都要有留档`);
    for (const realm of fx.REALM_IDS) {
      assert.equal(sha256(fx.fullPageOf(view, realm)), LEGACY.fullPageSha256[key][realm],
        `${key} · ${realm}：整页 HTML 与改口径之前逐字节相同（${LEGACY.capturedFrom}）`);
      compared += 1;
    }
  }
  assert.equal(compared, 12, '12 个整页哈希都比过（防"夹具少一份就静默少比"✗）');
  assert.equal(LEGACY.pageBuildToken, fx.PAGE_BUILD_TOKEN, '动态位占位符口径一致');
});

test('AC-ST7b ⭐⭐ 开关关着 ⇒ 四个领域块与今天的**逐字原文**相同（`assert.equal` 逐字）', () => {
  for (const { key, view, label } of GOLDEN_CASES) {
    assert.deepEqual(Object.keys(GOLDEN[key] || {}).sort(), fx.REALM_IDS.slice().sort(),
      `${label}：快照要四块齐全`);
    for (const realm of fx.REALM_IDS) {
      assert.equal(fx.blockOfFull(view, realm), GOLDEN[key][realm],
        `${label} · ${realm} tab 与今天逐字一致`);
    }
  }
  // 快照里确实留着「未标状态」那一列（没被静默吞掉 —— 它是她看到的那一行）
  assert.ok(GOLDEN.blankStateBlocks.inventory.includes('<th>未标状态</th>'), '快照里那 1 双还在');
});

test('AC-ST7c ⭐⭐ 判据**是活的**：改一个格子 ⇒ 哈希与逐字快照**当场变**（防"随便改都绿" ✗）', () => {
  // ⚠️ 变的那一格必须**四页都看得见**：把 41（缺码、三种状态都没有）改成「门盒 1」
  //    ⇒ 销售页它从"预订"挪进"现货"、库存页那一行少一个 `⚠️ 缺`、补货页 `0 双/缺码` → `1 双/现货`、
  //      退货页它变得可退 —— 四个 tab 都必须跟着变 ✓
  //    （⚠️ 别拿"40 的数量 1 → 2"当变异：销售页**只分组、不显示数量** ⇒ 它那一页一个字都不会变，
  //      那是**页面真的没变**，不是判据空跑 —— 2026-10-16 晚第一版就踩了这个坑 ✓）
  const mutated = {
    ...fx.THREE_STATE_VIEW,
    rows: fx.THREE_STATE_VIEW.rows.map((row) => (row.size_text === '41'
      ? { ...row, cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false }
      : row)),
  };
  for (const realm of fx.REALM_IDS) {
    assert.notEqual(sha256(fx.fullPageOf(mutated, realm)), LEGACY.fullPageSha256.threeState[realm],
      `${realm}：41 从"缺码"变成"有货" ⇒ 整页哈希必须变（否则 AC-ST7a 什么都没钉 ✗）`);
  }
  assert.notEqual(fx.blockOfFull(mutated, 'sales'), GOLDEN.blocks.sales,
    '销售页那一块也必须跟着变（逐字快照不是空跑 ✓）');
  assert.notEqual(fx.blockOfFull(mutated, 'inventory'), GOLDEN.blocks.inventory,
    '库存页那一块也必须跟着变（41 那一行的 `⚠️ 缺` 该没了 ✓）');
});

test('AC-ST7d ⭐ 留档自证：夹具/哈希/快照三者的**身份对得上**（防张冠李戴 ✗）', () => {
  assert.equal(LEGACY.viewModule, 'server/test/fixtures/scanStockPolicyViews.js', '留档写明了夹具模块');
  assert.match(LEGACY.capturedFrom, /e1657f1/, '留档写明取自哪个提交（改口径之前的那一份）');
  // 三份夹具确实**各不相同**（否则"三份"是假的）
  const hashes = Object.values(fx.VIEWS).map((view) => sha256(fx.fullPageOf(view, 'inventory')));
  assert.equal(new Set(hashes).size, 3, '三份夹具在库存页上必须产生三份不同的 HTML ✓');
  // 快照里的 page_build 占位符真用上了（否则本地绿、CI 红）
  assert.ok(Object.values(GOLDEN.blocks).some((text) => text.includes(fx.PAGE_BUILD_TOKEN)),
    '`page_build` 确实被换成了占位符');
});
