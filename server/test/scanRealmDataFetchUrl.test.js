/**
 * ⭐⭐ 「取数 URL **必须含 `data=1`**」的闸（2026-10-14 她真机**扫码死循环** ✗ v0.4.40 被回滚）：
 *
 * 循环的形状：骨架页里那段脚本 fetch 自己的数据片段 ⇒ 若 URL **没带 `data=1`**
 *   ⇒ 服务端又回**骨架**（`routes/scanPage.js`：`data !== '1'` ⇒ 骨架 ✓）
 *   ⇒ `document.write` 把骨架再写回来 ⇒ 脚本再跑 ⇒ **无限循环** ✗✗
 *
 * ⚠️ 之前的断言钉的是**字面量**（`location.pathname + '?data=1'` ✗）⇒ 一改成"带 query"就没人
 *    再钉"**最终一定含 data=1**"这件事 ✗（这正是今晚漏掉的那道闸 ✓）。
 * ⇒ 本文件用**行为**钉住：把渲染出来的那段 URL 构造逻辑抽出来，在 5 种 `location.search` 下真跑一遍 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_data_fetch_url';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'data_fetch_url_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanSkeleton } = require('../src/views/scanPageRenderer');

/** 从骨架 HTML 里抽出「构造取数 URL」那几行（`var dataSearch` … `dataQuery.push('data=1');`） */
function extractUrlBuilder(html) {
  // ⚠️ 2026-10-14 改指向（本支新增了 `showProblem()` / `load()` ⇒ 脚本变长 ✗）：
  //   原来切到 `fetch(` 为止 ✗ —— 而 `fetch(` 现在**在 `function load() {` 里面** ⇒
  //   抽出来的是"半截函数体 + 我们自己接的 `return`" ⇒ `new Function` 里那句 return
  //   落在函数内部 ⇒ **永远返回 undefined** ⇒ 三条 AC 才红 ✗（不是"data=1 丢了" ✓ 我核过 ✓）
  //   ⇒ 改成**只抽"拼 URL 的那三句"**（起点 `var dataSearch`，终点**含** `dataQuery.push('data=1');`）✓
  const start = html.indexOf('var dataSearch');
  assert.ok(start > 0, '骨架里必须有构造取数 URL 的那段（`var dataSearch`）');
  const marker = "dataQuery.push('data=1');";
  const markAt = html.indexOf(marker, start);
  assert.ok(markAt > start, '这段里必须有兜底的那一句 `dataQuery.push(\'data=1\');`（死循环的闸 ✗）');
  return html.slice(start, markAt + marker.length);
}

/** 用给定的 `location` **真跑一遍**那段逻辑 ⇒ 返回它最终拼出来的 URL */
function runUrlBuilder(builderSource, { pathname, search }) {
  const window = { location: { pathname, search } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', `${builderSource}\nreturn window.location.pathname + '?' + dataQuery.join('&');`);
  return fn(window);
}

const SKELETON = renderScanSkeleton({ number: 'MK31-1|咖色|B' }, SCAN_PAGE);
const BUILDER = extractUrlBuilder(SKELETON);

test('AC1 ⭐⭐ 五种 location.search 下，最终 URL **都含 `data=1`**（这就是死循环的闸 ✗）', () => {
  const cases = [
    { search: '', pathname: '/r/rec28ecwwTJv8s', label: '**空 query**（死循环的根因场景 ✗）' },
    { search: '?from=inventory', pathname: '/r/rec28ecwwTJv8s', label: '只带领域' },
    { search: '?from=sales&data=1', pathname: '/r/rec28ecwwTJv8s', label: '已带 data=1（不许变成两个 ✗）' },
    { search: '?data=1', pathname: '/r/66133-17', label: '首页那条老路径' },
    { search: '?from=purchase_return&foo=bar', pathname: '/r/recX', label: '多参数' },
  ];
  for (const c of cases) {
    const url = runUrlBuilder(BUILDER, c);
    assert.ok(url.includes('data=1'), `${c.label} ⇒ URL 必须含 data=1（实际 ${url}）`);
    assert.equal((url.match(/data=1/g) || []).length, 1, `${c.label} ⇒ data=1 只许一次（实际 ${url}）`);
    assert.ok(url.startsWith('/'), `${c.label} ⇒ 必须是本站相对路径（实际 ${url}）`);
  }
  // 逐字：领域保留、顺序稳定
  assert.equal(runUrlBuilder(BUILDER, { search: '', pathname: '/r/x' }), '/r/x?data=1');
  assert.equal(runUrlBuilder(BUILDER, { search: '?from=inventory', pathname: '/r/x' }), '/r/x?from=inventory&data=1');
  assert.equal(runUrlBuilder(BUILDER, { search: '?from=sales&data=1', pathname: '/r/x' }), '/r/x?from=sales&data=1');
});

test('AC2 ⭐ 骨架源码层：既有 `dataQuery`、又有**兜底** `dataQuery.push(\'data=1\')`', () => {
  assert.match(SKELETON, /var dataSearch = /, '要有 dataSearch（取当前 query）✓');
  assert.match(SKELETON, /dataQuery\.push\('data=1'\)/, '⭐ 缺了这一句 ⇒ URL 可能不含 data=1 ⇒ 死循环 ✗');
  assert.match(SKELETON, /window\.location\.search/, '要读当前 query（`from` 不许丢 ✓）');
  assert.equal(/location\.pathname \+ '\?data=1'/.test(SKELETON), false, '旧写法（丢 query）不许回来 ✗');
});

test('AC3 ⭐⭐ 反向哨兵：喂"只拼 search、没有兜底 data=1"的写法 ⇒ 这条闸必须红', () => {
  const naive = "var dataQuery = (window.location.search || '').replace(/^\\?/, '').split('&').filter(function (p) { return p && p.indexOf('data=') !== 0; });\n";
  assert.equal(runUrlBuilder(naive, { search: '', pathname: '/r/rec1' }).includes('data=1'), false,
    '夹具必须能构造出**不含 data=1** 的 URL ⇒ 证明 AC1 有牙齿 ✓');
  assert.equal(runUrlBuilder(BUILDER, { search: '', pathname: '/r/rec1' }), '/r/rec1?data=1', '真实现不会漏 ✓');
});

test('AC4 ⭐ `/r/<记录ID>` 与 `/r/<编号>` 都按**自己的 pathname** 取数（不写死 /r/ ✓ 回归）', () => {
  assert.equal(runUrlBuilder(BUILDER, { search: '', pathname: '/r/rec1' }).startsWith('/r/rec1?'), true);
  assert.equal(runUrlBuilder(BUILDER, { search: '', pathname: '/r/66133-17' }).startsWith('/r/66133-17?'), true);
  assert.equal(SKELETON.includes("'/r/' + encodeURIComponent"), false, '不许写死 /r/ ✗');
});

test('AC5 骨架里只有**一处**取数点（唯一来源 ✓）', () => {
  assert.equal((SKELETON.match(/fetch\(window\.location\.pathname/g) || []).length, 1, '骨架里只许一处取数 ✓');
});
