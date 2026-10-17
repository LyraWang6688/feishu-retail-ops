/**
 * ⭐⭐ 工作台写操作的「即时交互反馈」 —— 验收标准（业务负责人 2026-10-12 定的《前端交互反馈纪律》，**先写后做**）。
 *
 * 她的原话（逐字）：
 *   「用户点击完之后一定要有交互：**要么按钮置灰 · 要么弹出 Toast · 要么更改当前的提示文案**……
 *    同样的逻辑和思路，也需要应用到扫码页和**工作台**……不然用户以为点了没反应，就会**多次提交**。」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC1 `pendingLabel`：慢任务从第 1 秒起显示「（已 N 秒）」，**1 秒内不加**（不要"已 0 秒"）。
 *   AC2 点击后**立刻**：按钮 `disabled = true` + 文案变化；结束后**恢复**。
 *   AC3 ⭐ **连点 N 次 ⇒ 只发 1 次请求**（同一颗按钮在跑时，后续点击直接忽略）。
 *   AC4 慢任务：**「（已 N 秒）」**（纯前端计时、**零额外请求**）。
 *   AC5 失败：**如实抛出 + 人话**（不吞），按钮**恢复可重试**（再点还能发）。
 *   AC6 ⭐ **逐按钮接线**：工作台**每一个会写表/发请求的按钮**都走了这个守卫（源码级逐条断言），
 *       且写按钮都是 `type="button"`（不是表单默认提交 ⇒ 回车也不会重复提交）。
 *   AC7 命中区仍 ≥44px（`.btn` 的 `--control-height`）· 置灰态有样式（`.btn:disabled`）。
 *   AC8 既有「正在读取订单…（已 N 秒）」**不回归**。
 *   AC9 三段分类与**写入语义一个字不变**（10 条写接口原样）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** `core/ui.js` 没有 import ⇒ 复制成 `.mjs` 直接跑（与既有用例同一套做法）。 */
async function loadUi() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-feedback-'));
  fs.writeFileSync(path.join(dir, 'ui.mjs'), read('core/ui.js'), 'utf8');
  return import(pathToFileURL(path.join(dir, 'ui.mjs')).href);
}

/** 假按钮：只实现守卫会用到的三样（`disabled` / `textContent` / 身份）。 */
const fakeButton = (text = '提交') => ({ disabled: false, textContent: text });

// ═══════════════════════════════════════════════════════════════════════════
// AC1 文案（纯函数）
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 pendingLabel：1 秒内不加秒数，之后显示「（已 N 秒）」', async () => {
  const ui = await loadUi();
  assert.equal(ui.SUBMIT_PENDING_TEXT, '正在提交，请不要重复点…', '基础文案逐字');
  assert.equal(ui.pendingLabel(ui.SUBMIT_PENDING_TEXT, 0), ui.SUBMIT_PENDING_TEXT, '0 秒不加（不要"已 0 秒"）');
  assert.equal(ui.pendingLabel(ui.SUBMIT_PENDING_TEXT, 0.9), ui.SUBMIT_PENDING_TEXT);
  assert.equal(ui.pendingLabel(ui.SUBMIT_PENDING_TEXT, 1), `${ui.SUBMIT_PENDING_TEXT}（已 1 秒）`);
  assert.equal(ui.pendingLabel(ui.SUBMIT_PENDING_TEXT, 3.7), `${ui.SUBMIT_PENDING_TEXT}（已 3 秒）`, '取整');
  assert.equal(ui.pendingLabel('正在调整…', 12), '正在调整…（已 12 秒）', '基础文案可以换（各按钮自己那句话）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 / AC3 点击后立刻置灰 + 连点只发一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 点击后**立刻** disabled + 文案变化；结束后恢复', async () => {
  const ui = await loadUi();
  const guard = ui.createSubmitGuard({ setInterval: () => 0, clearInterval: () => {} });
  const button = fakeButton('提交');

  let release;
  const task = () => new Promise((resolve) => { release = () => resolve({ ok: true }); });
  const running = guard.run(button, task);

  // ⭐ 还在飞的时候（await 之前）就已经置灰 + 换文案了 —— "点了没反应"就是这么没的
  assert.equal(button.disabled, true, '立刻置灰');
  assert.equal(button.textContent, ui.SUBMIT_PENDING_TEXT, '立刻换文案');

  release();
  await running;
  assert.equal(button.disabled, false, '结束后恢复可点');
  assert.equal(button.textContent, '提交', '文案恢复原样');
});

test('AC3 ⭐ 连点 3 次 ⇒ 只发 1 次请求（同一颗按钮在跑时后续点击直接忽略）', async () => {
  const ui = await loadUi();
  const guard = ui.createSubmitGuard({ setInterval: () => 0, clearInterval: () => {} });
  const button = fakeButton('提交');

  let calls = 0;
  let release;
  const slowTask = () => new Promise((resolve) => { calls += 1; release = () => resolve({ ok: true }); });

  const first = guard.run(button, slowTask);
  const second = guard.run(button, slowTask);
  const third = guard.run(button, slowTask);
  assert.equal(calls, 1, '连点 3 次：任务只被调 1 次');
  assert.equal(await second, undefined, '第 2 次点击什么都不做（不重复提交）');
  assert.equal(await third, undefined, '第 3 次点击什么都不做');
  assert.equal(guard.isPending(button), true, '守卫知道它还在跑');

  release();
  assert.deepEqual(await first, { ok: true }, '第 1 次照常拿到结果');
  assert.equal(guard.isPending(button), false, '跑完就不再 pending');

  // 跑完之后**再点**必须还能发（不是"一次性的"）
  const again = guard.run(button, async () => ({ ok: 2 }));
  assert.deepEqual(await again, { ok: 2 });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 慢任务「（已 N 秒）」
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 慢任务显示「处理中（已 N 秒）」——纯前端计时、零额外请求', async () => {
  const ui = await loadUi();
  let clock = 1_000_000;
  const tickers = new Map();
  let nextId = 1;
  const guard = ui.createSubmitGuard({
    now: () => clock,
    setInterval: (fn) => { const id = nextId += 1; tickers.set(id, fn); return id; },
    clearInterval: (id) => tickers.delete(id),
  });
  const button = fakeButton('提交');

  let release;
  const running = guard.run(button, () => new Promise((resolve) => { release = () => resolve({ ok: true }); }));
  assert.equal(button.textContent, ui.SUBMIT_PENDING_TEXT, '第 0 秒 = 基础文案');
  assert.equal(tickers.size, 1, '起了一个秒表（就是它，没有第二个请求）');

  clock += 3_000;
  for (const fn of [...tickers.values()]) fn();
  assert.equal(button.textContent, `${ui.SUBMIT_PENDING_TEXT}（已 3 秒）`, '第 3 秒显示已 3 秒');

  clock += 30_000;
  for (const fn of [...tickers.values()]) fn();
  assert.equal(button.textContent, `${ui.SUBMIT_PENDING_TEXT}（已 33 秒）`);

  release();
  await running;
  assert.equal(tickers.size, 0, '结束之后秒表停掉（不留定时器）');
  assert.equal(button.textContent, '提交', '文案恢复');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 失败：如实抛出 + 可重试
// ═══════════════════════════════════════════════════════════════════════════

test('AC5 失败：异常如实抛出（不吞）+ 按钮恢复可重试', async () => {
  const ui = await loadUi();
  const guard = ui.createSubmitGuard({ setInterval: () => 0, clearInterval: () => {} });
  const button = fakeButton('提交');

  let calls = 0;
  await assert.rejects(
    () => guard.run(button, async () => { calls += 1; throw new Error('这一单的数据不自洽'); }),
    /这一单的数据不自洽/,
    '失败原因要如实抛给调用方（页面用 describeError 显示人话）',
  );
  assert.equal(button.disabled, false, '失败后按钮恢复（她可以再试一次）');
  assert.equal(button.textContent, '提交');
  assert.equal(guard.isPending(button), false, '失败后不再 pending ⇒ 重试能发出去');

  const retry = await guard.run(button, async () => { calls += 1; return { ok: true }; });
  assert.deepEqual(retry, { ok: true });
  assert.equal(calls, 2, '重试**真的又发了一次**');
});

test('AC5b 没有按钮（拿不到触发元素）时也要照常执行，不许因为"没法置灰"就不发', async () => {
  const ui = await loadUi();
  const guard = ui.createSubmitGuard({ setInterval: () => 0, clearInterval: () => {} });
  let calls = 0;
  const result = await guard.run(null, async () => { calls += 1; return { ok: true }; });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 逐按钮接线（源码级）
// ═══════════════════════════════════════════════════════════════════════════

/** 工作台**每一个会写表/发请求的按钮**（她点名的那几个 + 其余写操作入口）。 */
const WRITE_ACTIONS = [
  { file: 'features/orders/index.js', action: 'submit-payment', what: '补记收款' },
  { file: 'features/orders/index.js', action: 'deliver', what: '交付并扣库存' },
  { file: 'features/orders/index.js', action: 'submit-after-sales', what: '售后（退货/换货/赔货）' },
  { file: 'features/orders/index.js', action: 'submit-second-delivery', what: '二次交付' },
  { file: 'features/orders/index.js', action: 'submit-detail-amount', what: '补实收金额' },
  { file: 'features/orders/index.js', action: 'submit-sample-fill', what: '补样品' },
  { file: 'features/orders/index.js', action: 'submit-arrival', what: '验收入库（全额到货）' },
  { file: 'features/inventory/adjustment.js', action: 'submit-count', what: '提交盘点调整' },
  { file: 'features/inventory/adjustment.js', action: 'submit-season', what: '提交换季调整' },
  { file: 'features/labels/queue.js', action: 'queue-print', what: '打印到店里那台电脑' },
  { file: 'features/labels/queue.js', action: 'queue-again', what: '再打一份' },
];

test('AC6a ⭐ 每一个写操作按钮都接了「提交守卫」（逐按钮断言）', () => {
  const orders = read('features/orders/index.js');
  const adjustment = read('features/inventory/adjustment.js');
  const queue = read('features/labels/queue.js');

  // ① orders 的六条：都走同一个 `runAction`（它内部就是守卫 —— 一处改、六条都受益）
  assert.match(orders, /async function runAction\([\s\S]{0,400}?runWriteAction\(/,
    'runAction 必须走守卫（它覆盖下面六条）');
  for (const [action, handler, what] of [
    ['submit-payment', 'submitPayment', '补记收款'],
    ['deliver', 'submitDelivery', '交付并扣库存'],
    ['submit-after-sales', 'submitAfterSales', '售后（退货/换货/赔货）'],
    ['submit-second-delivery', 'submitSecondDelivery', '二次交付'],
    ['submit-detail-amount', 'submitDetailAmount', '补实收金额'],
    ['submit-sample-fill', 'submitSampleFill', '补样品'],
  ]) {
    assert.ok(orders.includes(`'${action}'`), `${what} 的写按钮（${action}）不见了`);
    assert.match(orders, new RegExp(`async function ${handler}\\([\\s\\S]{0,700}?runAction\\(`),
      `${what}（${handler}）必须走 runAction（点了立刻有反馈 + 防连点）`);
  }
  // ② orders 的验收入库：单独走守卫（它有自己那段校验 + 表单）
  assert.ok(orders.includes("'submit-arrival'"));
  assert.match(orders, /async function submitArrival\([\s\S]{0,2000}?runWriteAction\(/,
    '验收入库（submitArrival）必须走守卫');

  // ③ 库存手工调整：两条写入口各自走守卫
  assert.match(adjustment, /async function submitCount\([\s\S]{0,1600}?runWriteAction\(/,
    '提交盘点调整必须走守卫');
  assert.match(adjustment, /async function submitSeason\([\s\S]{0,3500}?runWriteAction\(/,
    '提交换季调整必须走守卫');

  // ④ 标签打印队列：两颗按钮的点击监听都在守卫里
  assert.match(queue, /printButton\.addEventListener\('click', \(\) => runWriteAction\(printButton/,
    '「打印到店里那台电脑」必须走守卫');
  assert.match(queue, /againButton\.addEventListener\('click', \(\) => runWriteAction\(againButton/,
    '「再打一份」必须走守卫');

  // ⑤ 三个模块都从 core/ui.js 取**同一个**守卫（不各写一份）
  for (const file of ['features/orders/index.js', 'features/inventory/adjustment.js', 'features/labels/queue.js']) {
    assert.ok(read(file).includes('runWriteAction'), `${file} 要用共用的 runWriteAction`);
  }
});

test('AC6b 写按钮都是 type="button"（回车不会触发默认提交 ⇒ 不重复提交）', () => {
  for (const { file, action, what } of WRITE_ACTIONS) {
    const source = read(file);
    const tag = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(source);
    assert.ok(tag, `${file} 里找不到 ${action} 的 <button>`);
    assert.ok(tag[0].includes('type="button"'), `${what} 的按钮必须是 type="button"（现在是 ${tag[0]}）`);
  }
});

test('AC6c 守卫是"一处实现"（core/ui.js 导出工厂 + 默认单例），三个模块共用', async () => {
  const ui = await loadUi();
  assert.equal(typeof ui.createSubmitGuard, 'function');
  assert.equal(typeof ui.runWriteAction, 'function');
  assert.equal(typeof ui.submitGuard, 'object');
  assert.equal(ui.runWriteAction(ui.submitGuard ? fakeButton('x') : null, async () => ({ ok: true })) instanceof Promise, true,
    'runWriteAction 返回 Promise（调用方 await 它）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 命中区 ≥44px + 置灰态有样式
// ═══════════════════════════════════════════════════════════════════════════

test('AC7 按钮命中区仍 ≥44px；置灰态有可见样式', () => {
  const tokens = read('styles/tokens.css');
  const base = read('styles/base.css');
  assert.match(tokens, /--control-height:\s*44px;/);
  assert.match(base, /\.btn,\s*input,\s*select\s*\{[^}]*min-height:\s*var\(--control-height\)/, '按钮 ≥44px');
  assert.match(base, /\.btn:disabled\s*\{[^}]*opacity/, '置灰态要有可见样式（不是看不出禁用）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC8 「正在读取订单…（已 N 秒）」不回归
// ═══════════════════════════════════════════════════════════════════════════

test('AC8 既有「正在读取订单…（已 N 秒）」不回归', () => {
  const orders = read('features/orders/index.js');
  assert.ok(orders.includes('正在读取订单…（已 ${seconds} 秒）'), '读取中的秒表文案还在（上一批的成果不许弄丢）');
  assert.ok(orders.includes('startWaitingTicker'), '等待指示器还在');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC9 写入语义一个字不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC9 两段分类与 10 条写接口一个字不变（本次只加"点了有反馈"）', async () => {
  const config = read('config/orders.js');
  // ⭐ 2026-10-17 成对迁移：她逐字「只保留二次交割以及售后」⇒ 「补充信息单」退场（缺信息的单并入待交割）
  assert.equal(config.includes("{ key: 'supplement'"), false, '🔴「补充信息单」那段不许回来 ✗');
  assert.match(config, /key: 'pending', label: '待交割单', tag: '待交割'/);
  assert.match(config, /key: 'afterSales', label: '售后列表', tag: '已两清'/);
  for (const endpoint of [
    "'/api/workbench/sales/orders'", "'/api/workbench/sales/payments'", "'/api/workbench/sales/deliveries'",
    "'/api/workbench/sales/detail-amounts'", "'/api/workbench/sales/sample-fill'",
    "'/api/workbench/sales/after-sales'", "'/api/workbench/sales/second-delivery'",
    "'/api/workbench/purchase/arrivals/confirm'",
  ]) {
    assert.ok(config.includes(endpoint), `接口不受影响：${endpoint}`);
  }
  assert.ok(read('features/inventory/adjustment.js').includes("'/api/workbench/inventory/adjustments/count'"));
  assert.ok(read('features/inventory/adjustment.js').includes("'/api/workbench/inventory/adjustments/season'"));
  assert.ok(read('features/labels/queue.js').includes("'/api/workbench/label-print/jobs'"));
});
