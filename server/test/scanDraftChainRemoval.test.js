'use strict';

/**
 * ⭐⭐ 2026-10-16 22:0x（业务负责人逐字）：
 *   「**存草稿的功能都删除吧，不需要了，前端和后端都不需要了，整个链路都删除**」
 * ⇒ 本文件是**这条命令的反向哨兵**（退役口径：**退役 = 删代码，不是翻开关** ✓
 *   见 `AGENTS.md`「恢复这条链路 = 重新实现那条链路，不是翻一个开关」✓）
 *
 * 要删的是【**存（报货）草稿**】那条**用户可见**的链（受 `SCAN_DRAFT_ENABLED` 控制的三处入口）✓
 * 🔴 **绝不是**「一单多货」内部那套**本单草稿**（`draftBarHtml` / `multiItemOrder*` /
 *    `config.supplierSplit.js`）—— 那是"这一单已加了几件"，**她【要】一单多货** ✗（AC-DEL3 钉住 ✓）
 *
 * ── 判据（都能真红 ✓）────────────────────────────────────────────────────────
 *  AC-DEL1 `SCAN_DRAFT_` 这一族 env 键在 `src/**` **0 处**（退役 = 没人读 ✓）
 *  AC-DEL2 **反向哨兵**：草稿链的**每一个名字/文件**回来 ⇒ 红（逐个钉 ✓）
 *  AC-DEL3 **一单多货不受影响**：本单条那一套**必须还在**（删错方向 ⇒ 红 ✓）
 *  AC-DEL4 **尺子不许被偷偷改**：`508,317` 那把尺子（`AC-SP-1`）**逐字还在** ✓
 *          （⚠️ 字节级零回归由那把尺子**自己**在 `test/scanPageSplitParity.test.js` 里证 ✓）
 *  AC-DEL5 **文档/环境同步**：`docs/README.md` 已把两份草稿文档标作废 · `.env.example` 本来就没有这行 ✓
 *  AC-DEL6  扫描器**自检**：合成源码里塞一个名字 ⇒ **必须**被认出来 ✓（否则上面全是空跑 ✗）
 *
 * 🔴 只动 `server/test/**` ＋ 这一刀的实现文件 ✓ · `services/scanWriteService.js` **一个字没碰** ✗
 *    （它此刻正被授权改动中 ✗）· 未部署 ✓ · 生产 Base 只读 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const SRC = path.join(SERVER, 'src');
const DOCS = path.join(SERVER, '..', 'docs');

/** 把 `src/**` 下所有 js 读成 [{file, source}]（退役哨兵要扫**全仓源码** ✓ 不是只看几个文件 ✗）。 */
const srcFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        out.push({ file: path.relative(SERVER, full), source: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
};
const SRC_FILES = srcFiles();

/** ⭐ 草稿链的"名字"（**回来即红** ✓）—— 每个都单独钉，红的时候直接告诉你谁回来了 ✓ */
const BANNED = Object.freeze([
  'SCAN_DRAFT_ENABLED',
  'scanDraftService',
  'createScanDraftService',
  'draftSaveButtonHtml',
  'draftNoticeHtml',
  '存报货草稿',
  'save_draft',
]);

/** ⭐ 「本单草稿」（**一单多货**）的"名字" —— 这些**必须还在** ✓（她【要】一单多货 ✗） */
const MUST_KEEP = Object.freeze([
  ['src/views/scanPage/draftBlock.js', 'draftBarHtml'],
  ['src/views/scanPage/multiItemBlock.js', 'MULTI_ITEM_ORDER'],
  ['src/services/multiItemOrderService.js', 'readDraft'],
  ['src/services/multiItemOrderService.js', 'openDraft'],
]);
const MUST_KEEP_FILES = Object.freeze([
  'src/config/multiItemOrder.js',
  'src/config/supplierSplit.js',
  'src/services/supplierSplitService.js',
  'src/services/multiItemOrderService.js',
]);

/** 在给定的 [{file, source}] 里找某个名字 ⇒ 命中清单（空 = 干净 ✓）。 */
const hitsOf = (files, needle) => files
  .filter(({ source }) => source.includes(needle))
  .map(({ file }) => file);

// ═══════════════════════════════════════════════════════════════════════════

test('AC-DEL1 ⭐ `SCAN_DRAFT_` 这一族 env 键 ⇒ `src/**` **0 处读取**（退役 = 删代码，不是翻开关 ✓）', () => {
  const files = SRC_FILES.filter(({ file }) => !file.endsWith('scanDraft.js'));
  const leftovers = files.filter(({ source }) => /SCAN_DRAFT_[A-Z_]+/.test(source)).map(({ file }) => file);
  assert.deepEqual(leftovers, [],
    `🔴 还有文件在读 \`SCAN_DRAFT_*\`（她 22:0x：「**整个链路都删除**」）⇒ 留着 = "没人读的开关" ✗`);
  // 配置模块本身必须**整个不在**（不是"加个 enabled=false" ✓）
  assert.equal(fs.existsSync(path.join(SRC, 'config', 'scanDraft.js')), false,
    '🔴 `src/config/scanDraft.js` 必须**整件退场**（不是把它关掉 ✗）');
});

test('AC-DEL2 🔴 反向哨兵：草稿链的每个名字/文件**回来 ⇒ 红**（逐个钉 ✓）', () => {
  for (const needle of BANNED) {
    const hits = hitsOf(SRC_FILES, needle);
    assert.deepEqual(hits, [],
      `🔴 「${needle}」**不许回来**（她 22:0x：「前端和后端都不需要了，整个链路都删除」）—— 命中：${hits.join(', ')}`);
  }
  assert.equal(fs.existsSync(path.join(SRC, 'services', 'scanDraftService.js')), false,
    '🔴 `src/services/scanDraftService.js` 必须**整件退场** ✗');
});

test('AC-DEL3 ⭐ **删的是"存草稿"，不是"本单草稿"** ⇒ 一单多货那一套**必须还在** ✓', () => {
  for (const [file, needle] of MUST_KEEP) {
    const source = fs.readFileSync(path.join(SERVER, file), 'utf8');
    assert.ok(source.includes(needle),
      `🔴 ${file} 里的 \`${needle}\` **必须还在**（那是"这一单已加了几件"⇒ **她【要】一单多货** ✗ 删错方向了 ✗）`);
  }
  for (const file of MUST_KEEP_FILES) {
    assert.equal(fs.existsSync(path.join(SERVER, file)), true, `🔴 ${file} **必须还在**（一单多货 / 报货拆单的真源 ✓）`);
  }
  // 「本单」那条 bar 的文案键也还在（它是本单条，不是存草稿 ✓）
  const scanPage = fs.readFileSync(path.join(SRC, 'config', 'scanPage.js'), 'utf8');
  assert.ok(scanPage.includes("'本单'"), '🔴 「本单」条的文案键**必须还在**（正文是"本单：{count} 双"✓）');
});

test('AC-DEL4 ⭐ **尺子不许被偷偷改**：`508,317` 那把零回归尺子逐字还在（字节级校验由它自己证 ✓）', () => {
  const parity = fs.readFileSync(path.join(SERVER, 'test', 'scanPageSplitParity.test.js'), 'utf8');
  const realm = fs.readFileSync(path.join(SERVER, 'test', 'salesRealmScan.test.js'), 'utf8');
  assert.ok(parity.includes('508317'),
    '🔴 `test/scanPageSplitParity.test.js` 的 **AC-SP-1** 那把尺子（`508317`）**不许被改** ✗ —— '
    + '删功能时"顺手把尺子重新基线化"是**假零回归** ✗（她 22:0x 只让删存草稿，别的页面输出必须逐字节不变 ✓）');
  assert.ok(realm.includes('508317'),
    '🔴 `test/salesRealmScan.test.js` 里**同一把尺子**（`508317` 字节 / 全字节）也必须逐字还在 ✓');
});

test('AC-DEL5 ⭐ 文档 / 环境同步：两份草稿文档已标作废 · `.env.example` 本来就没有这一行 ✓', () => {
  const index = fs.readFileSync(path.join(DOCS, 'README.md'), 'utf8');
  for (const doc of ['draft-save-resume-plan-2026-10-16.md', 'draft-save-resume-s3-2026-10-16.md']) {
    const line = index.split('\n').find((row) => row.includes(doc));
    assert.ok(line, `🔴 \`docs/README.md\` 里**必须**还有这两份文档的索引行（AC-DI1 逼着索引完整 ✓）：${doc}`);
    assert.match(line, /作废/,
      `🔴 ${doc} 的索引行**必须标「作废」**（她 22:0x 删了整条链 ⇒ 文档不许再当"现行"✗）—— 实际：${line.trim().slice(0, 120)}`);
    const body = fs.readFileSync(path.join(DOCS, doc), 'utf8');
    assert.match(body.slice(0, 600), /作废/,
      `🔴 ${doc} 的**文首**要有作废横幅（"现行"的帽子必须摘掉 ✗）`);
  }
  const envExample = fs.readFileSync(path.join(SERVER, '..', '.env.example'), 'utf8');
  assert.equal(/SCAN_DRAFT_[A-Z_]+/.test(envExample), false,
    '🔴 `.env.example` 里**不许**留 `SCAN_DRAFT_*`（它原来就没有这一行 ✓ 谁加回来 ⇒ 红 ✗）');
});

test('AC-DEL6 ⭐ 扫描器自检：合成源码里塞一个名字 ⇒ **必须**被认出来（否则上面全是空跑 ✗）', () => {
  const synthetic = [{ file: 'synthetic.js', source: "const enabled = readFlag(env, 'SCAN_DRAFT_ENABLED', true);" }];
  assert.notDeepEqual(hitsOf(synthetic, 'SCAN_DRAFT_ENABLED'), [], '塞回 env 键 ⇒ **必须**报红 ✓');
  assert.notDeepEqual(hitsOf([{ file: 'synthetic2.js', source: "if (action === 'save_draft') { return; }" }], 'save_draft'), [],
    '塞回 `save_draft` ⇒ **必须**报红 ✓');
  assert.deepEqual(hitsOf([{ file: 'clean.js', source: 'const bar = draftBarHtml(write);' }], 'SCAN_DRAFT_ENABLED'), [],
    '干净源码（只有本单条）⇒ **不许**误报 ✓');
});
