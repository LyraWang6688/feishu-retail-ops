'use strict';

/**
 * ⭐⭐ **「提交成功」统一回执 = toast**（业务负责人 2026-10-29 定稿）的判据。
 *
 * 她的口径（逐字）：
 *   「**数据提交成功，后台自动写入**，统一都是这个」
 *   ＋「以后就没有成功页了」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件钉四件事（**先写预期，再跑** —— 她定的流程）：
 *
 *  **AC-ST1 · 配置先行**：那句统一文案是**唯一真源**（`config/submitToast.js`）；
 *      换一句话只改 env / 只改配置，**代码不用动**；空串 env ⇒ 回到缺省那一句（文案不是开关）。
 *  **AC-ST2 · 共用件**：`utils/submitToast.js` 产出的 URL = `/workbench/?toast=<统一文案>`
 *      （303 + `no-store` 缓存头）；带单号时另给 `done=<单号>`（**只作排查关联，不进文案**）；
 *      **落点不许出站**（跨站 / `//host` / 反斜杠 / 绝对 URL ⇒ 回落缺省工作台）。
 *  **AC-ST3 · 四条提交链都走它**：销售 / 补货 / 采购退货 / 采购多货的**成功落点**都调共用件
 *      ⇒ 源码里那几处**不许再出现** `sendSuccess(` / `renderSaleSuccessPage`。
 *  **AC-ST4 · 成功页整件退场（反向哨兵 · 塞回即红）**：
 *      `config/scanSuccessPage.js` 文件**不存在**、视图层**没有** `renderSaleSuccessPage`、
 *      渲染上下文**没有** `successReturnFields` ⇒ 谁把成功页塞回来 ⇒ 本文件红 ✓。
 *
 * ⚠️ 行为面（真路由 303）在 `test/purchaseAsyncAcceptance.test.js`（补货/退货）与
 *    `test/scanSalePaymentStepPay.test.js` / `test/multiItemOrder*.test.js`（销售/多货）里一起钉 ✓
 *    —— 本文件只钉**配置 / 共用件 / 源码边界**，不重复造路由替身（避免两份夹具漂）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const SRC = path.join(SERVER, 'src');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');
/** 只留代码：去掉块注释与整行 `//` 注释（本仓既有哨兵做法 —— 迁移注释里提到旧名字不算"还在"✓）。 */
const stripComments = (text) => String(text)
  .replace(/\/\*(?=\s|\*|!)[\s\S]*?\*\//g, '')
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
const readCode = (rel) => stripComments(read(rel));
const exists = (rel) => fs.existsSync(path.join(SERVER, rel));

const { SUBMIT_TOAST, DEFAULT_SUBMIT_TOAST_TEXT } = require('../src/config/submitToast');
const {
  isSafeInternalPath, normalizeToastText, submitToastQuery, submitToastUrl,
} = require('../src/utils/submitToast');

test('AC-ST1 ⭐ 统一文案 = 「数据提交成功，后台自动写入」（唯一真源在 config）', () => {
  assert.equal(SUBMIT_TOAST.text, '数据提交成功，后台自动写入',
    '业务负责人 2026-10-29 逐字定的那一句（改这句 = 改口径 ⇒ 必须她点头）');
  assert.equal(DEFAULT_SUBMIT_TOAST_TEXT, '数据提交成功，后台自动写入');
  // 文案只在**一处**是字面量：配置里（别处再抄一份 ⇒ 改一处漏一处 ⇒ 红）
  const cfg = read('src/config/submitToast.js');
  assert.ok(cfg.includes('数据提交成功，后台自动写入'));
  // 落点 / 参数名也走配置（换页面/换参数名不用改逻辑）
  assert.equal(SUBMIT_TOAST.path, '/workbench/');
  assert.equal(SUBMIT_TOAST.param, 'toast');
  assert.equal(SUBMIT_TOAST.noticeKey, 'done');
  // 前端那一半必须是**同一份**共用件（各自读 `?toast=`）——不许前端另写一个 toast 实现
  const front = read('public/workbench/shared/toast.js');
  assert.match(front, /params\.get\('toast'\)/, '前端 toast 读的就是这个参数名');
  assert.match(read('public/workbench/index.html'), /shared\/toast\.js/, '工作台首页要加载它');
});

test('AC-ST2a ⭐ 共用件产出的 URL：303 落点 + 统一文案 + 单号只进 done', () => {
  const query = submitToastQuery({ orderNo: 'XSD-20261029-0001' });
  assert.equal(query.get('toast'), '数据提交成功，后台自动写入');
  assert.equal(query.get('done'), 'XSD-20261029-0001');
  // ⚠️ 文案里**不带单号**（她要求统一那一句）—— 单号只在 done 里、不在页面上
  assert.equal(query.get('toast').includes('XSD'), false, 'toast 文案不许夹单号');

  assert.equal(submitToastUrl({ orderNo: '' }), '/workbench/?toast=%E6%95%B0%E6%8D%AE%E6%8F%90%E4%BA%A4%E6%88%90%E5%8A%9F%EF%BC%8C%E5%90%8E%E5%8F%B0%E8%87%AA%E5%8A%A8%E5%86%99%E5%85%A5');
  assert.equal(submitToastUrl({ orderNo: 'XSD-1' }),
    '/workbench/?done=XSD-1&toast=%E6%95%B0%E6%8D%AE%E6%8F%90%E4%BA%A4%E6%88%90%E5%8A%9F%EF%BC%8C%E5%90%8E%E5%8F%B0%E8%87%AA%E5%8A%A8%E5%86%99%E5%85%A5');
});

test('AC-ST2b ⭐ 文案可配 + 截断 + 空白规整（改一句话不用改代码）', () => {
  assert.equal(normalizeToastText('  数据提交成功，\n后台自动写入  '), '数据提交成功， 后台自动写入',
    '多空白折成一个空格（文案里换行会把 URL/显示搞花）');
  const long = 'x'.repeat(500);
  assert.equal(normalizeToastText(long, 20).length, 20, '超长截断（不报错 —— 回执不该因为文案太长拦她）');
  const custom = submitToastQuery({ text: '自定义回执' });
  assert.equal(custom.get('toast'), '自定义回执', '调用方可传 text 覆盖（默认 = 统一那一句）');
});

test('AC-ST2c ⭐ 落点只许站内：跨站 / //host / 反斜杠 / 绝对 URL ⇒ 回落缺省工作台', () => {
  const bad = ['https://evil.example.com/', '//evil.example.com/', '/\\evil.com', 'evil', '', '   ',
    'javascript:alert(1)', '/workbench/ x', 'http://127.0.0.1:3000/'];
  for (const value of bad) {
    assert.equal(isSafeInternalPath(value), false, `不合法落点：${JSON.stringify(value)}`);
    assert.equal(submitToastUrl({ path: value }).startsWith('/workbench/'), true,
      `不合法落点必须回落缺省工作台：${JSON.stringify(value)}`);
  }
  assert.equal(submitToastUrl({ path: '/workbench/' }).startsWith('/workbench/'), true);
  assert.equal(submitToastUrl({ path: '/' }).startsWith('/?toast'), true);
});

test('AC-ST3 ⭐⭐ 四条提交链的成功落点都调共用件（原文位置逐个点名）', () => {
  const chains = {
    '销售（资金页异步那一按）': 'src/routes/scanPage/handlers/payment.js',
    '补货': 'src/routes/scanPage/handlers/purchase.js',
    '采购退货': 'src/routes/scanPage/handlers/purchase.js',
    '采购多货': 'src/routes/scanPage/flowHelpers.js',
  };
  for (const [name, file] of Object.entries(chains)) {
    const src = read(file);
    assert.ok(src.includes('redirectWithSubmitToast('), `${name}：${file} 必须调统一共用件`);
    assert.ok(src.includes("utils/submitToast"), `${name}：${file} 的 require 必须指向共用件`);
  }
  // 补货 / 退货两条**都在** purchase.js 里 ⇒ 至少两处调用（一个文件里两处）
  const purchase = read('src/routes/scanPage/handlers/purchase.js');
  assert.ok((purchase.match(/redirectWithSubmitToast\(/g) || []).length >= 2,
    '补货与退货两条都要回 toast（各一处）');
  // 销售提交兜底（资金页渲染抛错时）也必须回 toast，不许退回成功页
  assert.ok(read('src/routes/scanPage/handlers/salesSubmit.js').includes('redirectWithSubmitToast('));
});

test('AC-ST4 ⭐⭐ 成功页整件退场（反向哨兵 · 塞回即红）', () => {
  // ① 配置文件不存在
  assert.equal(exists('src/config/scanSuccessPage.js'), false, '成功页配置已退场 ⇒ 不许回来');
  // ② 视图层没有成功页渲染器 / 也不再吃那份配置
  const views = read('src/views/scanPage/index.js');
  assert.equal(views.includes('renderSaleSuccessPage'), false, '成功页渲染器已退场');
  assert.equal(views.includes('scanSuccessPage'), false, '视图层不许再 require 成功页配置');
  // ③ 渲染上下文不再产出成功页回跳字段
  assert.equal(readCode('src/routes/scanPage/renderContext.js').includes('successReturnFields'), false);
  assert.equal(readCode('src/routes/scanPage/index.js').includes('successReturnFields'), false);
  // ④ 路由层不许再有"发一张成功页"的出口
  for (const file of [
    'src/routes/scanPage/flowHelpers.js',
    'src/routes/scanPage/index.js',
    'src/routes/scanPage/handlers/payment.js',
    'src/routes/scanPage/handlers/purchase.js',
    'src/routes/scanPage/handlers/salesSubmit.js',
  ]) {
    assert.equal(/sendSuccess\s*\(/.test(readCode(file)), false, `${file} 里不许再有 sendSuccess(`);
  }
});

test('AC-ST5 ⭐ 成功页那一句旧文案不许再被当成"回执"引用（口径已换成 toast 那句）', () => {
  // ⚠️ `SCAN_PAGE.saleSuccess.message`（「已提交成功，数据会更新」）**还活着**：
  //    它被工作台「验收回执」正文用着（`config/workbenchArrival.js`）—— 那是**别的界面**，不动它 ✓
  assert.ok(read('src/config/workbenchArrival.js').includes('saleSuccess.message'),
    '验收回执仍用它 ⇒ 不许把这条配置一起删掉（删了会红在别处）');
  // 但**提交回执（toast）**必须是新那一句 —— 两件事不许混：
  assert.equal(SUBMIT_TOAST.text.includes('已提交成功，数据会更新'), false,
    'toast 文案是新那一句（数据提交成功，后台自动写入），不是旧成功页那句');
});
