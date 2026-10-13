/**
 * ⭐⭐ 守门测试：**业务代码里不许新增硬编码的用户可见中文**（业务负责人 2026-10-12 点头的机制）。
 *
 * 为什么：她的口径是「用户可见文案逐步抽到 config」—— 但**只靠自觉会反弹**
 * （新写一个 service 顺手又把一句话写死）。这条闸门让"存量"看得见、**只许减少、不许增加**。
 *
 * 口径（她点头，逐条对齐）：
 *   · 扫描范围：`src/services/**` + `src/routes/**` + `src/views/**`
 *     ⚠️ **`src/config/**` 不扫** —— 文案的家就在那儿（抽过去的文案不该再被报）；
 *   · 🔴 **完全不扫**：① 注释 ② `logX/logger./console.` 所在的整条语句 ③ `throw … / new Error(…)` 的内部消息；
 *   · ⭐ **领域值 / 表选项**（如「门盒 / 仓库 / 减少 / 不影响」）**照扫**，进白名单当"可见的存量债"。
 *
 * 判据：**新增** ⇒ 红；白名单里已消失 ⇒ 只提示"可以删掉这一条"（不红，防白名单腐烂）。
 * 白名单：`test/fixtures/hardcodedChineseWhitelist.json`（**按「文件 → 中文串」，不用行号** —— 行号一动就假红）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { scanTree, scanSource } = require('./support/hardcodedChinese.js');

const SRC = path.join(__dirname, '../src');
const WHITELIST_PATH = path.join(__dirname, 'fixtures/hardcodedChineseWhitelist.json');
const whitelist = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));

/** ⚠️ 这里**故意没有** `config/`：文案的家不在扫描范围内。 */
const ROOTS = [
  { dir: path.join(SRC, 'services'), prefix: 'services/' },
  { dir: path.join(SRC, 'routes'), prefix: 'routes/' },
  { dir: path.join(SRC, 'views'), prefix: 'views/' },
];

/** 造一个临时"业务代码"目录，用来钉机制（不碰仓库真代码）。 */
const tempTree = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-hardcoded-cjk-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-1 / AC-2 白名单与现状
// ═══════════════════════════════════════════════════════════════════════════

test('AC-1 白名单文件写明「存量债，只许减少、不许增加」', () => {
  assert.ok(whitelist.files && typeof whitelist.files === 'object', '白名单要有 files 段');
  assert.match(whitelist._comment || '', /存量债/, '文件头要写清这是存量债');
  assert.match(whitelist._comment || '', /只许减少、不许增加/, '并写清"只许减少、不许增加"');
  assert.match(whitelist._comment || '', /按「文件 → 中文串」/, '并写清键的口径（不用行号）');
});

test('AC-2 ⭐ 业务代码里没有"新增"的硬编码用户可见中文（存量都在白名单里）', () => {
  const { added, stale } = scanTree({ roots: ROOTS, whitelist });
  const detail = added.slice(0, 20).map((item) => `  ${item.file}:${item.line}  ${item.text}`).join('\n');
  assert.equal(added.length, 0, `发现 ${added.length} 处**新增**的硬编码中文（抽到 config 里去）：\n${detail}`);
  assert.equal(stale.length, 0, `白名单里有 ${stale.length} 条已经不在代码里了（可以删掉，白名单只许减少）：`
    + `\n${stale.slice(0, 20).map((item) => `  ${item.file}  ${item.text}`).join('\n')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-3 机制有效：故意新增一句 ⇒ 报出来
// ═══════════════════════════════════════════════════════════════════════════

test('AC-3 ⭐ 故意新增一句中文 ⇒ 机制抓得到（新增即红）', () => {
  const dir = tempTree({
    'services/demoService.js': "const text = '这是一句新写的用户可见中文';\nmodule.exports = { text };\n",
  });
  const { added } = scanTree({ roots: [{ dir: path.join(dir, 'services'), prefix: 'services/' }], whitelist: { files: {} } });
  assert.equal(added.length, 1, '新增的中文必须被抓出来');
  assert.equal(added[0].text, '这是一句新写的用户可见中文');
  assert.equal(added[0].file, 'services/demoService.js');
  // 进了白名单就不再报（存量口径）
  const again = scanTree({
    roots: [{ dir: path.join(dir, 'services'), prefix: 'services/' }],
    whitelist: { files: { 'services/demoService.js': ['这是一句新写的用户可见中文'] } },
  });
  assert.equal(again.added.length, 0, '写进白名单后不再报（存量债口径）');
  assert.equal(again.stale.length, 0, '也没有 stale');
});

test('AC-4 白名单里的一句已从代码里删掉 ⇒ 提示"可以删白名单"（stale，不红）', () => {
  const dir = tempTree({ 'services/demoService.js': 'const text = 1;\nmodule.exports = { text };\n' });
  const { added, stale } = scanTree({
    roots: [{ dir: path.join(dir, 'services'), prefix: 'services/' }],
    whitelist: { files: { 'services/demoService.js': ['这句已经没有啦'] } },
  });
  assert.equal(added.length, 0, '没有新增 ⇒ 不红');
  assert.deepEqual(stale, [{ file: 'services/demoService.js', text: '这句已经没有啦' }], '要提示可以删白名单这一条');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-5 / AC-6 / AC-7 豁免口径
// ═══════════════════════════════════════════════════════════════════════════

test('AC-5 注释 / 日志 / throw 内部消息里的中文 ⇒ 一律不报（她点头的豁免）', () => {
  const source = [
    '// 这是注释里的中文，不算用户文案',
    '/* 块注释里的中文：门盒 */',
    '/**',
    " * JSDoc 里的中文：退货、换货",
    ' */',
    "logInfo('demo.event', { hint: '日志里的中文不算' });",
    "logger.warn('demo.warn', { hint: 'logger 里的中文不算' });",
    "console.log('控制台里的中文不算');",
    "throw new Error('内部错误消息：表里没这行');",
    "const bad = () => { throw new Error('内部错误：另一条'); };",
    'module.exports = {};',
  ].join('\n');
  assert.deepEqual(scanSource('services/demo.js', source), [], '注释/日志/内部错误都不该被报');
});

/** 一行是不是注释（含跨行块注释 `/* … *\/`）。 */
function commentLineFlags(source) {
  const lines = source.split('\n');
  let inBlock = false;
  return lines.map((line) => {
    const trimmed = line.trim();
    const wasInBlock = inBlock;
    if (inBlock && trimmed.includes('*/')) inBlock = false;
    else if (!inBlock && trimmed.startsWith('/*')) inBlock = !trimmed.includes('*/');
    return wasInBlock || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  });
}

test('AC-5b ⭐ 真文件：报出来的每一条都**不是注释**（本切片要治的"闸门说谎"）', () => {
  const relative = 'views/scanPageRenderer.js';
  const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
  const flags = commentLineFlags(source);
  const found = scanSource(relative, source);
  assert.ok(found.length > 5, `这个文件本来就是"文案大户"，应该扫出一堆（实际 ${found.length}）`);
  const fromComments = found.filter((item) => flags[item.line - 1]);
  assert.deepEqual(fromComments, [],
    `这些"中文"其实来自**注释**（状态机失步了）：\n${fromComments.slice(0, 12).map((i) => `  :${i.line} ${i.text}`).join('\n')}`);
  // 真 UI 文案必须**照报**（别把闸门修废）
  const texts = found.map((item) => item.text).join('\n');
  assert.ok(/打不开|请稍后再试/.test(texts), `真 UI 文案要照报（实际 ${JSON.stringify(found.slice(0, 5))}）`);
});

test('AC-5b2 给真文件**只加一行注释** ⇒ 报出来的集合**一个字都不变**（这才是"只挡新增"）', () => {
  const relative = 'views/scanPageRenderer.js';
  const source = fs.readFileSync(path.join(SRC, relative), 'utf8');
  const before = scanSource(relative, source).map((item) => item.text).sort();
  const after = scanSource(relative, `${source}\n// 她今天随手加的一行注释：门盒 / 仓库\n`).map((item) => item.text).sort();
  assert.deepEqual(after, before, '加注释不该改变扫描结果');
});

test('AC-5c ⭐ 模板串里的 `//` 不是注释（别把 URL 里的斜杠当注释起点）', () => {
  const source = "const url = `${base}/s/${id}`;\nconst tip = `看这里：https://x.cn/a`;\n// 真注释：不影响\n";
  const texts = scanSource('views/demoRenderer.js', source).map((item) => item.text);
  assert.deepEqual(texts, ['看这里：https://x.cn/a'], `只该报那一句文案（实际 ${JSON.stringify(texts)}）`);
});

test('AC-6 `src/config/**` 里的中文 ⇒ 不报（文案的家不在扫描范围内）', () => {
  assert.equal(ROOTS.some((root) => root.dir.includes(`${path.sep}config`)), false, '扫描根里不许有 config');
  const dir = tempTree({
    'config/demoTexts.js': "module.exports = { submit: '提交' };\n",
    'services/demoService.js': 'module.exports = {};\n',
  });
  const { added } = scanTree({ roots: [{ dir: path.join(dir, 'services'), prefix: 'services/' }], whitelist: { files: {} } });
  assert.equal(added.length, 0, '只扫 services ⇒ config 里的中文不参与（它没进扫描根）');
  const configScanned = scanSource('config/demoTexts.js', fs.readFileSync(path.join(dir, 'config/demoTexts.js'), 'utf8'));
  assert.equal(configScanned.length, 1, '（工具本身能扫出来，是"扫描范围"把它排除了）');
});

test('AC-7 领域值 / 表选项照扫 ⇒ 会以"存量债"进白名单（可见、只减不增）', () => {
  const found = scanSource('services/demoService.js', "const states = ['门盒', '仓库', '减少'];\n");
  assert.deepEqual(found.map((item) => item.text), ['门盒', '仓库', '减少'],
    '领域值/表选项**照扫**（口径：让存量债可见）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-8 它真的在跑（对全仓生效）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-8 扫描规模合理（三个根目录都被扫到，且不是 0 文件）', () => {
  const { added } = scanTree({ roots: ROOTS, whitelist: { files: {} } });
  assert.ok(added.length > 50, `应扫出大量存量（实际 ${added.length} 处）—— 说明真的扫到了三个目录`);
  const files = new Set(added.map((item) => item.file.split('/')[0]));
  for (const prefix of ['services', 'routes', 'views']) {
    assert.ok(files.has(prefix), `扫描结果里应该有 ${prefix}/ 下的文件`);
  }
});

test('AC-9 ⭐ 跨行 `throw new Error(...)` 里的中文 ⇒ 不扫（本次修的缺口）', () => {
  const source = [
    'function f(items) {',
    "  if (items.length) throw new Error(`有 ${items.length} 条没对应货品（${items",
    "    .map((i) => `${i.no || ''}${i.color || ''}`).join('、')}）。请再点一次「确认入库」`);",
    '}',
  ].join('\n');
  assert.deepEqual(scanSource('services/demo.js', source), [], '跨行 throw 的内部消息不许被扫进来');
});

test('AC-10 单行 `throw` ⇒ 不扫（回归）· 真·人话仍要扫到（回归，别扫漏）', () => {
  const source = ["throw new Error('内部错误：表里没这行');", "const tip = '真的会给她看的一句人话';"].join('\n');
  assert.deepEqual(scanSource('services/demo.js', source).map((i) => i.text), ['真的会给她看的一句人话']);
});
