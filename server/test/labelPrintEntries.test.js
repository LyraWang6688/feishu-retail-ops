/**
 * 「货品 → 标签打印」入口 —— **2026-11-09 定稿后的形状**（业务负责人逐字）：
 *   · 入口只留**两颗卡**：扫码打印 / 批量打印（飞书表单）；
 *   · 「选择编号打印」整条删除（「点击批量打印的时候，只选择一个就可以了」）⇒
 *     它的页面（`label-print.html?keyword=`）、渲染模块、编号选择器、两个只读查询端点
 *     （`GET /api/workbench/labels`、`GET /api/workbench/products/numbers`）全部物理删除。
 *
 * 本文件是**反向哨兵**：把任何一件删掉的东西塞回来（文件 / 端点 / 入口字段 / 旧链接）⇒ 红。
 */
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const readSrc = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

/** 去掉注释再判「代码里有没有某件事」—— 注释里的历史沿革（"旧的是 targetTemplate"…）不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('AC-E1 标签打印子页只剩两颗卡：扫码打印 + 批量打印（飞书表单），没有任何入口表单', () => {
  const domains = readWorkbench('config/domains.js');
  const start = domains.indexOf("id: 'product-labels'");
  const end = domains.indexOf("id: 'product-info-config'");
  assert.ok(start !== -1 && end > start, '`config/domains.js` 里要能找到 product-labels 子页');
  const block = stripComments(domains.slice(start, end));

  assert.match(block, /kind: 'links'/, '这一页是纯卡片（旧的 `kind: \'entry\'` 表单页已删）');
  assert.equal(/targetTemplate|numberPicker|fieldLabel|buttonLabel|placeholder/.test(block), false,
    '旧的「选择编号打印」入口字段（落点模板 / 编号选择器 / 输入框）必须删干净');
  assert.equal((block.match(/title: '/g) || []).length, 2, '只有两颗卡');
  assert.match(block, /title: '扫码打印'/);
  assert.match(block, /href: '\/workbench\/label-print\.html\?scan=1'/);
  assert.match(block, /title: '批量打印'/);

  const links = readWorkbench('config/links.js');
  const formUrl = (links.match(/LABEL_BATCH_FORM_URL =\s*\n?\s*'([^']+)'/) || [])[1];
  assert.ok(formUrl, '`config/links.js` 里要有批量打印表单 URL（唯一来源）');
  assert.match(block, /href: LABEL_BATCH_FORM_URL/, '「批量打印」卡 = 飞书表单（URL 只从 links.js 引）');
});

test('AC-E2 删掉的东西真的不在了（文件 / 端点 / 页面引用 / 扫码页旧链接）', () => {
  for (const file of [
    'features/labels/render.js',
    'features/labels/queue.js',
    'features/labels/number-picker.js',
    'config/numberPicker.js',
  ]) {
    assert.equal(fs.existsSync(path.join(WORKBENCH, file)), false, `${file} 必须删除（不是隐藏）`);
  }

  // 两个只读查询端点：路由里一个 `router.get(` 都不许剩；扫码上报那条仍在。
  const route = readSrc('src/routes/workbench/labels.js');
  assert.equal(/router\.get\(/.test(route), false, '`GET /labels` 与 `GET /products/numbers` 必须删掉');
  assert.match(route, /router\.post\('\/labels\/scan-report'/, '扫码只读上报端点保留');

  // service 里那套编号清单逻辑也不许剩。
  const service = readSrc('src/services/labelPrintService.js');
  assert.equal(/listProductNumbers|productNumbersFilterOf/.test(service), false,
    '旧的编号清单逻辑必须删干净');

  // 标签页本身：不再查标签列表 / 编号清单，只剩扫码。
  const index = stripComments(readWorkbench('features/labels/index.js'));
  assert.equal(/api\/workbench\/labels\?|products\/numbers/.test(index), false,
    '页面不再查标签列表 / 编号清单');
  assert.match(index, /mountScanOnlyPage\(/, '剩下的入口 = 扫码打印聚焦屏');

  // 🔴 2026-11-09（业务负责人：「隐藏的旧「标签」领域块，可以删除」）：
  //   扫码页那个隐藏领域整块删除 ⇒ 渲染文件不存在、REALMS 里没有 `product`、
  //   扫码页路由也不再接打印队列（没有「打印这一款」那条动作）。
  assert.equal(fs.existsSync(path.join(__dirname, '../src/views/scanPage/productBlock.js')), false,
    '扫码页「标签」领域渲染文件必须删除');
  const realm = readSrc('src/views/scanPageRealm.js');
  assert.equal(/id: 'product'/.test(realm), false, '扫码页领域列表里不许再有 product');
  const actionRoutes = readSrc('src/routes/scanPage/actionRoutes.js');
  assert.equal(/printLabel|handlePrintLabel/.test(actionRoutes), false, '扫码页不再有「打印这一款」动作');
  const scanWrite = readSrc('src/config/scanWrite.js');
  assert.equal(/printLabel/.test(scanWrite), false, '写动作配置里也不许再有 printLabel');
});
