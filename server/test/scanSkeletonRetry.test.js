require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ 2026-10-14 她真机：「页面已经打开、但内容迟迟不出来」（停留在「数据加载中」太久 ✗）
 *   代码根因之一：骨架那段脚本 **把错误吞掉了** ✗
 *     `fetch(...).then(...).then(function (html) { … }).catch(function () {});`
 *   ⇒ 取数失败 / 非 200 / 空响应 / **拿回的还是骨架** ⇒ 永远停在骨架、连一句人话都没有 ✗
 *   ⇒ 修：任何失败都给「**一句人话 + 重试按钮**」✓（点了再取一次 ✓ 不自动死磕 ✓）
 * AC：失败 ⇒ 人话 + 重试 ✓ · 拿回骨架 ⇒ **不写回** ✓（不循环 ✓）· 点重试 ⇒ 再发一次 ✓ · 成功 ⇒ 照旧 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_skel_retry';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'skel_retry_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanSkeleton } = require('../src/views/scanPageRenderer');

const VIEW = { number: 'MK31-1|咖色|B', item_no: 'X7303', color: '绿色' };
const HTML = renderScanSkeleton(VIEW, SCAN_PAGE);
const scriptOf = (html) => {
  const start = html.indexOf('<script');
  return html.slice(start, html.indexOf('</script>', start));
};
const SCRIPT = scriptOf(HTML);

test('AC-SR1 ⭐⭐ 不再静默吞错：失败 ⇒ 页面上有**人话 + 重试入口**（文案走配置 ✓）', () => {
  // ⚠️ 反向哨兵：改前那种写法必须被判红（见 AC-SR5 ✓）
  assert.equal(/catch\(function \(\) \{\}\)/.test(HTML), false, '空 catch（静默吞错）不许再有 ✗');
  // ⚠️ 脚本里 setAttribute 用的是**单引号** ⇒ 断言按**源码逐字**（我第一版引号假设错了 ✗）
  assert.ok(SCRIPT.includes("'scan-skeleton-error'"), '要有"人话"容器 ✓');
  assert.ok(SCRIPT.includes("'scan-skeleton-retry'"), '要有「重试」按钮 ✓');
  assert.ok(HTML.includes(SCAN_PAGE.texts.skeletonErrorText), '人话文案**来自配置** ✓（不写死 ✗）');
  assert.ok(HTML.includes(SCAN_PAGE.texts.skeletonRetryLabel), '按钮文案**来自配置** ✓');
  assert.match(HTML, /\.skeleton-retry \{[^}]*min-height: var\(--control-height\)/, '重试按钮 ≥44px（她的老规矩 ✓）');
});

test('AC-SR2 ⭐⭐ 拿回**还是骨架** ⇒ 不 document.write（保住"不循环" ✓ 且给人话 ✓）', () => {
  // ⚠️ 必须**剥注释**再判顺序 —— 脚本里 2026-10-13 的注释里也含 `document.write` 字样 ✗
  //   （我第一版就被它绊了 ⇒ 判出"write 在前"✗ 实际是注释在前 ✓）
  const code = SCRIPT.replace(/^\s*\/\/.*$/gm, '');
  const guardAt = code.indexOf("html.indexOf('data-view=\"scan-skeleton\"') !== -1");
  const writeAt = code.indexOf('document.write');
  assert.ok(guardAt > 0, '要有"拿回骨架"的判据 ✓（按源码逐字 ✓）');
  assert.ok(writeAt > guardAt, '判据必须在 document.write **之前**（否则又会写回骨架 ✗）');
  // ⚠️ ② 引入"自动重试一次"后，出口从 showProblem() 变成 retryOrProblem()（先自动、再人话 ✓）
  assert.ok(code.includes('catch(function () { window.clearTimeout(slowTimer); retryOrProblem(); })'),
    '请求异常 ⇒ 清计时器 + 走重试链（不再静默 ✗）');
  assert.ok(code.includes('if (!html) { retryOrProblem(); return; }'), '空响应 ⇒ 走重试链 ✓');
});

test('AC-SR3 ⭐ 点「重试」⇒ **再发一次取数请求**（不自动死磕 ✓）', () => {
  assert.match(SCRIPT, /addEventListener\('click', function \(\) \{[\s\S]{0,200}load\(\);/,
    '重试按钮必须再调一次 load() ✓');
  // 2026-10-14 改指向（**不许依赖"脚本长度/出现次数"** ✗ —— 脚本一演进就断 ✓ 我本人就踩过）：
  //   能力判断换成**结构**两条：① 不许有定时轮询（`setInterval` ✗）② 不许有"死磕循环"式自动重试 ✗
  //   改前逐字：assert.equal((CODE.match(/load\(\);/g) || []).length, 3, '只许这 3 处调用（不许自动死磕 ✗）');
  assert.equal(/setInterval/.test(CODE), false, '不许用 setInterval 轮询 ✗');
  assert.ok(CODE.includes("retry.addEventListener('click'"), '重试必须是**点击**触发（人点才重来 ✓）');
  // 自动重试**只许一次**（超时那条）—— 结构判据：`attempt === 1` 的分流只允许两处（超时 + 失败分流）
  assert.equal((CODE.match(/attempt === 1/g) || []).length, 2, '自动重试只许"超时"与"失败分流"两处 ✓');
});

test('AC-SR4 ⭐ 回归：成功路径照旧（document.write ✓ URL 含 data=1 ✓ 整页只有一段脚本 ✓）', () => {
  assert.ok(SCRIPT.includes('document.write(html)'), '成功时仍整页替换 ✓');
  assert.ok(SCRIPT.includes("dataQuery.push('data=1')"), '取数 URL 仍强制 data=1 ✓');
  assert.equal((HTML.match(/<script/g) || []).length, 1, '整页仍只有一段脚本 ✓');
  assert.ok(HTML.includes('数据加载中'), '骨架主文案仍是「数据加载中」✓');
});

// ══════════════════════════════════════════════════════════════════════════════
// ② 取数**超时自动重试一次**（她："停留在「数据加载中」的时间太长"）
//   超时 ⇒ 先给「还在读…」⇒ **自动再取一次** ⇒ 仍失败 ⇒ 走 ① 的人话 + 手动重试
//   ⚠️ 断言只用 includes / indexOf（我今晚在正则转义上翻过车 ✗）
// ══════════════════════════════════════════════════════════════════════════════
const CODE = SCRIPT.replace(/^\s*\/\/.*$/gm, ''); // 剥注释再判（脚本注释里也有历史用词 ✗）
const CFG = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'scanPage.js'), 'utf8');

test('AC-SR5 ⭐ 超时阈值与「还在读…」都在**配置**里（显式数字 ✓ 不用 `||` 兜底 ✗）', () => {
  assert.equal(SCAN_PAGE.texts.skeletonSlowMs, 2500, '默认阈值 2500ms（显式数字 ✓）');
  assert.ok(String(SCAN_PAGE.texts.skeletonSlowText).length > 0, '「还在读…」文案走配置 ✓');
  assert.ok(CFG.includes("skeletonSlowMs: readInt(process.env, 'SCAN_PAGE_SKELETON_SLOW_MS', 2500"),
    '配置里是**显式数字 + 环境变量**（不是 `|| 兜底` ✗）');
  assert.ok(HTML.includes(SCAN_PAGE.texts.skeletonSlowText), '提示语真的画进了这一页 ✓');
});

test('AC-SR6 ⭐⭐ 第一次超时 / 失败 ⇒ **自动再取一次**（只自动一次 ✓ 不自动死磕 ✗）', () => {
  assert.ok(CODE.includes('window.setTimeout(function () {'), '要有超时计时器 ✓');
  assert.ok(CODE.includes('if (attempt === 1) { load(); }'), '⭐ 超时 ⇒ 自动第二次请求 ✓');
  assert.ok(CODE.includes('function retryOrProblem() {'), '要有"第一次自动、第二次人话"的分流 ✓');
  assert.ok(CODE.includes("line.setAttribute('data-view', 'scan-skeleton-slow')"), '「还在读…」容器 ✓');
  // 只许一处 `attempt === 1` 的自动重试（超时那条）+ retryOrProblem 里的分流 ✓ ⇒ 不许有第三处 ✗
  assert.equal((CODE.match(/attempt === 1/g) || []).length, 2, '自动重试只许"超时"和"失败分流"两处 ✓');
});

test('AC-SR7 ⭐ 两次都失败 ⇒ 人话 + 手动重试（两条出口都清计时器 ✓）', () => {
  assert.equal((CODE.match(/clearTimeout\(slowTimer\)/g) || []).length, 2, '成功/失败两条出口都要清计时器 ✓');
  assert.ok(CODE.includes('catch(function () { window.clearTimeout(slowTimer); retryOrProblem(); })'),
    '请求异常 ⇒ 清计时器 + 走重试链（不再静默 ✗）');
  assert.ok(CODE.includes('showProblem();'), '第二次失败仍走 ① 的人话 + 「重试」✓');
});

test('AC-SR8 ⭐⭐ 反向哨兵：**没有超时/没有自动重试**的旧写法必须被判红（证明 AC-SR6 有牙齿 ✓）', () => {
  const oldCode = "fetch(u).then(function(r){return r.text();}).then(function(h){document.write(h);}).catch(function(){});";
  assert.equal(oldCode.includes('window.setTimeout'), false, '旧写法没有超时 ⇒ AC-SR6 会红 ✓');
  assert.equal(oldCode.includes('if (attempt === 1) { load(); }'), false, '旧写法没有自动重试 ⇒ AC-SR6 会红 ✓');
  // 旧写法正是"静默吞错"（保留这条对照 ✓）
  // 2026-10-14 改指向：**判"静默吞错"要归一化空白** ✓（夹具里写的是 `catch(function(){})` 没有空格 ✗
  //   原来拿带空格的字符串去 includes ⇒ 必然 false ⇒ 假红 ✓）
  //   改前逐字：assert.ok(oldCode.includes('catch(function () {})'), '旧写法是静默吞错 ✗');
  const compact = oldCode.replace(/\s+/g, '');
  assert.ok(compact.includes('catch(function(){})'), '旧写法是静默吞错 ✗（归一化空白后判 ✓）');
});
