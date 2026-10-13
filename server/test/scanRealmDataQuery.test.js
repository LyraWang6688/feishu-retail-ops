/**
 * 「取数据那一步把 from 丢了」的哨兵（2026-10-14 真机 + 线上日志）：
 *   日志逐字：`GET /r/<ID>?from=purchase_return => 200 (7428)` 之后
 *             `GET /r/<ID>?data=1 => 200 (10300)`  ← ⚠️ **没带 from** ✗
 *   ⇒ 页面被 `document.write` 换成"**默认领域**"的片段 ⇒ 点了六格看着都"没反应" ✓✓
 *   ⇒ 根因就在渲染器里这一行：`fetch(window.location.pathname + '?data=1')` —— **把当前 query 丢了** ✗
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js');
const source = fs.readFileSync(RENDERER, 'utf8');

/** 取数据那一行是否**丢了当前 query**（旧写法 = `pathname + '?data=1'` ✗） */
function dropsCurrentQuery(text) {
  return /location\.pathname\s*\+\s*'\?data=1'/.test(text);
}

test('AC1 ⭐⭐ 取数据时必须**带上当前 query**（`from=` 不许丢）＋ 只强制 `data=1`', () => {
  assert.equal(dropsCurrentQuery(source), false, "不许再有 `location.pathname + '?data=1'`（那会把 from 丢掉 ✗）");
  assert.match(source, /window\.location\.search/, '要读当前 query ✓');
  assert.match(source, /indexOf\('data='\)\s*!==\s*0/, '已有的 data= 参数要排掉，避免重复 ✓');
  assert.match(source, /dataQuery\.push\('data=1'\)/, '最后强制 data=1 ✓');
  assert.match(source, /fetch\(window\.location\.pathname \+ '\?' \+ dataQuery\.join\('&'\)/,
    '最终 fetch = 同一个 pathname + 原 query + data=1 ✓');
});

test('AC2 ⭐⭐ 反向哨兵：把**旧写法**放回夹具 ⇒ 这条检查必须红（否则它是自我安慰 ✗）', () => {
  const oldFragment = "fetch(window.location.pathname + '?data=1', { credentials: 'same-origin' })";
  assert.equal(dropsCurrentQuery(oldFragment), true, '旧写法必须被判为"丢 query" ✗');
  assert.equal(dropsCurrentQuery(source), false, '现在这份必须判为"带上 query" ✓');
});

test('AC3 ⭐ `?from=` 的领域映射仍在（认不出回落默认，不白屏 ✓）', () => {
  const realm = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'scanPageRealm.js'), 'utf8');
  assert.match(realm, /REALMS\.some\(\(realm\) => realm\.id === raw\) \? raw : DEFAULT_REALM;/, '认得出就用自己的、认不出回落默认 ✓');
  assert.match(realm, /Object\.freeze\(\{ id: 'inventory', label: '库存' \}\)/, '库存这一格存在 ✓');
});

test('AC4 ⭐ 脚本模板里**不许有中文**（硬编码中文守门的前置条件 ✓）', () => {
  // 取脚本段（从数据脚本开头到它自己的 </script>）
  const start = source.indexOf('var dataQuery');
  assert.ok(start > 0, '定位到数据脚本 ✓');
  const segment = source.slice(start, source.indexOf('</script>', start));
  assert.equal(/[\u4e00-\u9fff]/.test(segment), false, '这段模板必须 ASCII-only ✓');
});
