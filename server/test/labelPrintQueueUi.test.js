/**
 * 工作台「货品 → 标签打印」页上**「打印到店里那台电脑」**那一块的验收标准。
 *
 * 业务负责人 2026-10-11：手机点打印 ⇒ 店里那台 Windows 电脑出纸；工作台这一页的
 * **批量打印照旧**（也接**同一条队列**）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-U1  这一块与**服务端挂载的路径**对得上（`/api/workbench/label-print/{status,jobs}`）——
 *          改挂载点忘了改页面 ⇒ 这条用例红（不是等她在手机上点了没反应才发现）；
 *   AC-U2  ⭐ **没有定时轮询**（她明令"不要每 2-3 秒轮询"）：这两个文件里不许出现
 *          `setInterval` / 自递归 `setTimeout`；刷新只有"进页面 / 查完 / 点【刷新状态】/ 提交后"；
 *   AC-U3  文案**随接口下来**（`config/labelPrintQueue.js` 的 `texts`），页面只留一份兜底；
 *   AC-U4  在线 / 未连接两种状态各有自己的样式（未连接那句就是她定的那句）；
 *   AC-U5  提交 = `POST {mode:'batch', filters}`，**用的是她当前筛选条件**；
 *          提交后**说出打了几张**（不静默）；
 *   AC-U6  最近任务人话：`编号 · N 张 · 状态`；**失败要把原因摆出来**；
 *   AC-U7  移动端：按钮 ≥44px、单列不横滑（CSS 里 `.label-queue-bar .btn { min-height: 44px }`）；
 *   AC-U8  没查到可打印的标签时**两颗按钮都不许点**（与旁边那颗「打印这些标签」同一条口径）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把 queue.js（ESM）当模块加载（复制成 .mjs，只改 import 的文件名）。 */
async function loadQueueModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-queue-ui-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/formatters.js'), path.join(dir, 'formatters.mjs'));
  fs.writeFileSync(path.join(dir, 'queue.mjs'),
    read('features/labels/queue.js').split("from '../../core/formatters.js'").join("from './formatters.mjs'"), 'utf8');
  return import(pathToFileURL(path.join(dir, 'queue.mjs')).href);
}

/** 一个够用的假 DOM 容器（这一块只用到 querySelector / textContent / className / disabled / 事件）。 */
const fakeContainer = () => {
  const make = () => ({
    textContent: '', className: '', disabled: false, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  });
  const elements = {
    '[data-action="queue-print"]': make(),
    '[data-action="queue-refresh"]': make(),
    '[data-view="queue-badge"]': make(),
    '[data-view="queue-jobs"]': make(),
    '[data-view="queue-notice"]': make(),
  };
  return { elements, querySelector: (selector) => elements[selector] || null };
};

const fakeApi = (options = {}) => {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push({ method: 'GET', url });
      if (options.statusError) throw new Error('查询失败');
      return options.status || {
        success: true,
        online: true,
        jobs: [],
        texts: { printBatch: '打印到店里那台电脑', refresh: '刷新状态', online: '打印电脑在线', offline: '未连接（任务已排队，打开小助手就会打）' },
      };
    },
    async post(url, body) {
      calls.push({ method: 'POST', url, body });
      if (options.postError) throw options.postError;
      return options.postResult || { success: true, job_id: 'job-1', total_labels: 3 };
    },
  };
};

// ── AC-U1 / AC-U2 / AC-U3 / AC-U7：静态接线 ────────────────────────────────

test('AC-U1 页面调的路径与服务端挂载点一致（`/api/workbench/label-print/{status,jobs}`）', () => {
  const queue = read('features/labels/queue.js');
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.ok(app.includes("app.use('/api/workbench/label-print'"), 'app.js 必须挂在这个前缀上');
  assert.ok(queue.includes("'/api/workbench/label-print/status'"), '页面读状态的路径');
  assert.ok(queue.includes("'/api/workbench/label-print/jobs'"), '页面提交的路径');
});

test('AC-U2 ⭐ 没有定时轮询：两个文件里不许出现 setInterval / 自递归 setTimeout', () => {
  for (const file of ['features/labels/queue.js', 'features/labels/index.js']) {
    const code = read(file);
    assert.equal(/setInterval/.test(code), false, `${file} 不许有 setInterval`);
    assert.equal(/setTimeout/.test(code), false, `${file} 不许有 setTimeout（刷新只能由她点 / 提交后触发）`);
  }
});

test('AC-U3 文案随接口下来（页面只留一份兜底），且按钮/徽标都有落点', () => {
  const queue = read('features/labels/queue.js');
  assert.ok(queue.includes('data.texts'), '要用接口下来的 texts');
  assert.ok(queue.includes('QUEUE_FALLBACK_TEXTS'), '接口没下来时要有兜底');
  const server = fs.readFileSync(path.join(__dirname, '../src/routes/labelPrintQueue.js'), 'utf8');
  assert.ok(server.includes('texts:'), 'status 接口必须把 texts 带下来');
  assert.ok(queue.includes('data-action="queue-print"') && queue.includes('data-action="queue-refresh"'));
  assert.ok(queue.includes('data-view="queue-badge"'));
});

test('AC-U7 移动端：这一块的按钮 ≥44px 命中区（并复用整行按钮样式）', () => {
  const css = read('features/labels/labels.css');
  assert.match(css, /\.label-queue-bar \.btn \{ min-height: 44px; \}/);
  assert.match(css, /\.queue-badge--online/);
  assert.match(css, /\.queue-badge--offline/);
});

// ── AC-U4 / AC-U5 / AC-U6 / AC-U8：行为 ──────────────────────────────────

test('AC-U4 徽标：在线 / 未连接两句与两套样式都是对的（未连接那句来自配置）', async () => {
  const ui = await loadQueueModule();
  const texts = { online: '打印电脑在线', offline: '未连接（任务已排队，打开小助手就会打）' };
  assert.equal(ui.queueBadgeText({ online: true }, texts), texts.online);
  assert.equal(ui.queueBadgeText({ online: false }, texts), texts.offline);
  assert.equal(ui.queueBadgeText({ online: false }, {}), ui.QUEUE_FALLBACK_TEXTS.offline, '兜底也是那句话');

  const api = fakeApi();
  const panel = ui.createLabelQueuePanel({ api });
  const container = fakeContainer();
  panel.mount(container, () => ({}));
  await panel.refresh();
  const badge = container.elements['[data-view="queue-badge"]'];
  assert.equal(badge.textContent, '打印电脑在线');
  assert.match(badge.className, /queue-badge--online/);

  // 未连接
  const offlineApi = fakeApi({ status: { online: false, jobs: [], texts } });
  const offlinePanel = ui.createLabelQueuePanel({ api: offlineApi });
  const offlineContainer = fakeContainer();
  offlinePanel.mount(offlineContainer, () => ({}));
  await offlinePanel.refresh();
  assert.equal(offlineContainer.elements['[data-view="queue-badge"]'].textContent, texts.offline);
  assert.match(offlineContainer.elements['[data-view="queue-badge"]'].className, /queue-badge--offline/);
});

test('AC-U5 提交：POST {mode:"batch", filters}（用她当前的筛选条件）+ 提交后说出打了几张', async () => {
  const ui = await loadQueueModule();
  const api = fakeApi();
  const panel = ui.createLabelQueuePanel({ api });
  const container = fakeContainer();
  const filters = { keyword: 'XHB8095', state: '门盒', size: '42', sort: 'shelf' };
  panel.mount(container, () => filters);
  panel.setEnabled(true);
  await panel.refresh();

  const result = await panel.submit();
  assert.deepEqual(result, { success: true, job_id: 'job-1', total_labels: 3 });
  const post = api.calls.find((call) => call.method === 'POST');
  assert.equal(post.url, '/api/workbench/label-print/jobs');
  assert.deepEqual(post.body, { mode: 'batch', filters });
  assert.match(container.elements['[data-view="queue-notice"]'].textContent, /3 张/, '提交了要说打了几张（不静默）');
});

test('AC-U6 最近任务人话：编号 · N 张 · 状态；失败把原因摆出来', async () => {
  const ui = await loadQueueModule();
  assert.equal(ui.queueJobsText([], {}), '');
  const line = ui.queueJobsText([{ numbers: ['XHB8095|棕色|A'], total_labels: 2, status: 'queued', status_label: '待打印' }], {});
  assert.equal(line, 'XHB8095|棕色|A · 2 张 · 待打印');
  const failed = ui.queueJobsText([{
    numbers: ['XHB8095|棕色|A'], total_labels: 1, status: 'failed', status_label: '失败', failure_reason: '打印机没开',
  }], {});
  assert.match(failed, /打印机没开/, '失败必须给原因');
  // 最多显示最近 3 条
  const many = ui.queueJobsText(Array.from({ length: 6 }, (unused, index) => ({
    numbers: [`n${index}`], total_labels: 1, status: 'done', status_label: '已打印',
  })), {});
  assert.equal(many.split('｜').length, 3);
});

test('AC-U8 没查到可打印的标签 / 状态还没拿到 ⇒ 按钮点不动；状态拿到且有条可打 ⇒ 能点', async () => {
  const ui = await loadQueueModule();
  const api = fakeApi();
  const panel = ui.createLabelQueuePanel({ api });
  const container = fakeContainer();
  panel.mount(container, () => ({}));
  const button = container.elements['[data-action="queue-print"]'];

  assert.equal(button.disabled, true, '状态还没拿到 ⇒ 不许点');
  panel.setEnabled(true);
  assert.equal(button.disabled, true, '状态还没拿到 ⇒ 仍然不许点');
  await panel.refresh();
  assert.equal(button.disabled, false, '在线 + 有条可打 ⇒ 能点');
  panel.setEnabled(false);
  assert.equal(button.disabled, true, '一张都没有 ⇒ 不许点');
  panel.setEnabled(true);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '打印到店里那台电脑');
});

test('AC-U5 提交失败（她条件超过上限）⇒ 把原因显示出来，且按钮恢复可点（不是卡住）', async () => {
  const ui = await loadQueueModule();
  const api = fakeApi({ postError: Object.assign(new Error('一次最多打 100 张'), { status: 400 }) });
  const messages = [];
  const panel = ui.createLabelQueuePanel({ api, onError: (error) => messages.push(error.message) });
  const container = fakeContainer();
  panel.mount(container, () => ({}));
  panel.setEnabled(true);
  await panel.refresh();
  const result = await panel.submit();
  assert.equal(result, null);
  assert.deepEqual(messages, ['一次最多打 100 张'], '错误要她看得见');
  assert.equal(container.elements['[data-action="queue-print"]'].disabled, false, '失败后按钮要恢复（不然她就卡在那儿了）');
  assert.equal(container.elements['[data-view="queue-notice"]'].textContent, '');
});
