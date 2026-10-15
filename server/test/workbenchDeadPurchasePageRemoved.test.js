/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：「**采购页的老文件是死代码，给删除了吧**」
 *
 * 删掉的是老「采购管理」页 —— `server/public/workbench/features/purchase/`（`index.js` / `links.css` /
 * `purchase.css`）。它**早已没有任何挂载点**（`standalone.js` 不注册、没有任何页面 import），
 * 但删之前它有**两条活引用**必须先摘/先迁（Lead 核出来的）：
 *   · 🔴 `index.html` 仍挂着 `<link rel="stylesheet" href="/workbench/features/purchase/purchase.css">`
 *     ⇒ 直接删目录 = 那一条 **404** ✗（本任务先摘掉）；
 *   · 🔴 6 个测试文件引着它，其中两条是**真判据**（表名 / 文案同步）⇒ 必须**迁到活页面上继续钉** ✗
 *     （迁移清单见 PR 正文与各自用例里的「改前逐字 → 改后逐字 → 依据」）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-DL1 ⭐ 全仓**源码 / HTML 里 0 处活引用**（`features/purchase` 只剩注释历史；目录不存在）
 *   AC-DL2 ⭐ 静态资源**真起一次**：那个目录下的 CSS 现在 404，而活着的资源照旧 200；
 *            `index.html` 也不再请求它（能真红：把 `<link>` 加回去 ⇒ 红）
 *   AC-DL3 ⭐ 判据**迁移**收口：两条真判据现在钉在**活着的**文件上（不再指向已删路径）
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const SERVER_ROOT = path.join(__dirname, '..');
const WORKBENCH = path.join(SERVER_ROOT, 'public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 去注释（JS / CSS / HTML 三种都去）——「注释里留沿革」不算活引用。 */
const stripComments = (source) => source
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

const walkWorkbench = () => {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(js|css|html)$/.test(entry.name)) out.push(full);
    }
  };
  walk(WORKBENCH);
  return out;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-DL1 死代码删干净：目录不存在 + 源码/HTML 0 处活引用
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DL1 ⭐⭐ 老「采购管理」页目录不存在；工作台源码 / HTML 里 0 处活引用（只剩注释历史）', () => {
  // ① 目录（三个文件一起）**不存在**
  assert.equal(fs.existsSync(path.join(WORKBENCH, 'features/purchase')), false,
    '`features/purchase/**` 必须整个删掉（index.js / links.css / purchase.css）');
  for (const gone of ['features/purchase/index.js', 'features/purchase/links.css', 'features/purchase/purchase.css']) {
    assert.equal(fs.existsSync(path.join(WORKBENCH, gone)), false, `${gone} 必须不存在`);
  }

  // ② **去注释后**，工作台里的 js / css / html 一处都不许再提这个路径（注释里留沿革可以 ✓）
  const offenders = [];
  for (const file of walkWorkbench()) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    if (code.includes('features/purchase')) offenders.push(path.relative(WORKBENCH, file));
  }
  assert.deepEqual(offenders, [], `这些文件里还有**活引用**：${offenders.join(' / ')}`);

  // ③ 那两条真实命中的**活引用**逐条再钉一次（她/Lead 点名的两处）
  assert.equal(read('index.html').includes('purchase.css'), false, 'index.html 的那行 <link> 已摘 ✓');
  assert.equal(read('standalone.js').includes('features/purchase'), false, 'standalone.js 不 import 它 ✓');

  // ④ 项目源码（`src/**`）里也不许有活引用（它只可能是前端件；保底扫一遍）
  const srcOffenders = [];
  const walkSrc = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walkSrc(full); continue; }
      if (!/\.(js|html|css)$/.test(entry.name)) continue;
      if (stripComments(fs.readFileSync(full, 'utf8')).includes('features/purchase')) {
        srcOffenders.push(path.relative(path.join(SERVER_ROOT, 'src'), full));
      }
    }
  };
  walkSrc(path.join(SERVER_ROOT, 'src'));
  assert.deepEqual(srcOffenders, [], `src 里不许再有活引用：${srcOffenders.join(' / ')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DL2 真起一次：那个 CSS 404，活着的资源 200；index.html 不再请求它
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DL2 ⭐⭐ 真起一次静态服务：`features/purchase/purchase.css` 现在 404；`index.html` 不再请求它', async () => {
  // 与生产同一条挂载（`src/app.js`：`app.use('/workbench', express.static(workbenchPath, { index: 'index.html' }))`）
  const app = express();
  app.use('/workbench', express.static(WORKBENCH, { index: 'index.html' }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  // ⚠️ 与 task-16 的诊断结论同一行加固（fetch 的 keep-alive 池 + 临时端口复用 ⇒ 偶发 ECONNRESET）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // ① 死代码那个资源：**404**（删之前它是 200 —— 这正是"直接 rm 会 404"那条活引用）
    for (const url of [
      '/workbench/features/purchase/purchase.css',
      '/workbench/features/purchase/links.css',
      '/workbench/features/purchase/index.js',
    ]) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 404, `${url} 必须 404（目录已删）`);
    }
    // ② 活着的资源照旧 **200**（证明 404 不是因为整个静态服务坏了 ✗）
    for (const url of ['/workbench/index.html', '/workbench/features/orders/orders.css']) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200, `${url} 必须还能打开（静态服务没被这次清理搞坏）`);
    }
    // ③ `index.html` 真的不再请求那个目录（能真红：把 <link> 加回去 ⇒ 红）
    const html = await (await fetch(`${base}/workbench/index.html`)).text();
    assert.equal(html.includes('features/purchase'), false, '工作台首页不再请求死目录下的任何静态资源');
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DL3 判据迁移收口（真判据**迁到活页面**上继续钉）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DL3 ⭐⭐ 判据迁移收口：两条**真判据**现在钉在活着的采购页 / 文案上（不再指向已删路径）', () => {
  const renameSync = fs.readFileSync(path.join(__dirname, 'purchaseTableRenameSync.test.js'), 'utf8');
  const inboundRemoval = fs.readFileSync(path.join(__dirname, 'purchaseInboundRemoval.test.js'), 'utf8');
  const renameCopy = fs.readFileSync(path.join(__dirname, 'purchaseTableRenameCopy.test.js'), 'utf8');

  // ① 三处都不许再**读**那具已删的源文件（`features/purchase/index.js`）
  for (const [name, source] of [
    ['purchaseTableRenameSync.test.js', renameSync],
    ['purchaseInboundRemoval.test.js', inboundRemoval],
    ['purchaseTableRenameCopy.test.js', renameCopy],
  ]) {
    const code = stripComments(source);
    // ⚠️ 只禁"**去读**那具已删的源文件"（`readFileSync(… 'purchase' …)`）——
    //   活文件里带 purchase 的名字多了（`purchaseWebhookService.js` 等），别误伤 ✗；
    //   `existsSync(… 'purchase')` 这种"**断言它不存在**"是**要的**（能真红）✓
    // 两种写法都要抓：`…features/purchase/…`（字面量路径）与 `…'features', 'purchase', …`（path.join 分段）
    assert.equal(/readFileSync\([^;]*(?:features\/purchase|['"]purchase['"])/.test(code), false,
      `${name} 不许再去读已删的老采购页（readFileSync 指到 features/purchase）`);
  }

  // ② ⭐ **表名 / 文案同步**那条判据仍被钉着：迁到活着的采购文案真源上
  for (const [name, source] of [
    ['purchaseTableRenameSync.test.js', renameSync],
    ['purchaseInboundRemoval.test.js', inboundRemoval],
  ]) {
    assert.ok(source.includes("workbench/features/orders/index.js") || source.includes("'public/workbench/features/orders/index.js'")
      || source.includes('workbench/config/orders.js'),
    `${name} 的迁移必须指向**活着的**验收页 / 采购文案（不许删掉了事 ✗）`);
  }
  assert.ok(inboundRemoval.includes('采购明细'), '「当下表名 = 采购明细」这条判据仍在 ✓');
  assert.ok(renameSync.includes('ARRIVAL_STATUS_PENDING'), '「到货状态取值」这条判据仍在 ✓');

  // ③ AC-W4（死链清掉）已改成"**目录已不存在**"（判据提升，不是消失）
  const onlyArrival = fs.readFileSync(path.join(__dirname, 'workbenchPurchaseOnlyArrival.test.js'), 'utf8');
  assert.ok(/assert\.equal\(fs\.existsSync\(dir\), false/.test(onlyArrival),
    'AC-W4 必须断言"目录整个不存在"（能真红）');
});
