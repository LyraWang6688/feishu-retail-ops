/**
 * 「**手机点打印 ⇒ 店里那台电脑执行打印**」—— 服务器侧的验收标准（AC）护栏。
 *
 * 业务负责人 2026-10-11 的口径（唯一权威）：
 *   「这个打印小助手，**不一定会常开着机，需要打标签的时候才会开**，所以**可以做事件触发吗**？」
 * ⇒ 下面每一条用例名就是一条 AC，逐条钉住那句话的落地：
 *
 *   · AC1  产物在**服务器**画好：40×30mm ⇒ PNG 恰好 320×240px、PDF 每页 `/MediaBox` = 113.3858×85.0394pt
 *          （**一页一张 40×30 标签**，Windows 侧不用做任何缩放）；
 *   · AC2  手写的 PDF **结构正确**：xref 每个偏移都真的指回 `N 0 obj`、`/Count` 对得上、`%%EOF` 收尾
 *          （手写 PDF 最容易错的就是偏移 —— 这条不是"点一下"，是把文件当真 PDF 逐字节验）；
 *   · AC3  **防漂移**：产物里的行高与 `features/labels/labels.css` 一致；
 *          与 `features/labels/render.js` 的"货号+颜色"排版**逐字段一致**（两份实现不许走歪）；
 *   · AC4  入队 ⇒ `queued` + 产物**已落盘** + **订阅者被唤醒**（事件推送的落点）；
 *   · AC5  ⭐ **电脑离线 ⇒ 任务排队保留**，手机上 `status.online=false`；
 *   · AC6  ⭐⭐ **启动补拉**：电脑没开时入队的任务，小助手一起来 `listPending` **立刻**取回；
 *   · AC7  状态流转 `queued → claimed → done`（含时间与"谁打的"）；
 *   · AC8  ⭐ **幂等**：重复回执不报错、不改时间；**已打印的任务再也领不到**（绝不会重复打印）；
 *   · AC9  **失败必须带原因**（空原因 ⇒ 400）—— 她要在手机上看清为什么没打出来；
 *   · AC10 迟到/冲突的回执不许篡改事实（`done` 之后来的 `failed` 被忽略）；
 *   · AC11 ⭐ **认领超时可重投**（电脑打一半断电）但**不重打**（小助手本地台账那道在 print-helper 里）；
 *   · AC12 ⭐ **补打**生成**新任务**、原任务一个字不改；产物过期 ⇒ 明确报错（不静默重生成）；
 *   · AC13 **不静默**：编号没库存 / 超过一次上限 ⇒ 400 + 人话；产物渲染失败 ⇒ 502 且不留半条任务；
 *   · AC14 **保留期**：`done`/`failed` 过期连产物一起清；🔴 `queued`/`claimed` **永不清理**；
 *   · AC15 **配置先行**：超时 / 上限 / 开关全部来自配置，改一个值行为就变（用例改配置驱动）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { LABEL_PRINT_QUEUE, resolveLabelPrintQueueConfig, artifactsDirOf } = require('../src/config/labelPrintQueue');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const artifact = require('../src/services/labelPrintArtifactService');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');

const WORKBENCH = path.join(__dirname, '../public/workbench');

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一份 label（= `labelPrintService.listLabels` 输出的形状，只留产物需要的字段）。 */
const label = (patch = {}) => ({
  key: 'XHB8095|棕色|A',
  number: 'XHB8095|棕色|A',
  item_no: 'XHB8095',
  color: '棕色',
  category: '休闲鞋',
  category_code: 'A',
  sizes: [{ size: 36, qty: 1 }, { size: 37, qty: 2 }, { size: 38, qty: 1 }, { size: 39, qty: 1 }],
  size_lines: [
    [{ size: 36, qty: 1 }, { size: 37, qty: 2 }, { size: 38, qty: 1 }],
    [{ size: 39, qty: 1 }],
  ],
  size_overflow: false,
  total_qty: 5,
  states: ['门盒'],
  state_text: '门盒',
  price: 198,
  price_text: '¥198',
  brand_text: '邯美皮鞋',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
  footer_text: 'XHB8095|棕色|A',
  ...patch,
});

/** 服务端 `config/labelPrint.js` 的默认 layout（页面/产物两边都读它）。 */
const layout = (patch = {}) => ({
  ...LABEL_PRINT,
  label: { ...LABEL_PRINT.label, ...(patch.label || {}) },
  typography: { ...LABEL_PRINT.typography, ...(patch.typography || {}) },
  body: { ...LABEL_PRINT.body, ...(patch.body || {}) },
  fields: { ...LABEL_PRINT.fields, ...(patch.fields || {}) },
  sizes: { ...LABEL_PRINT.sizes, ...(patch.sizes || {}) },
  texts: { ...LABEL_PRINT.texts, ...(patch.texts || {}) },
});

/** 一个只回固定标签的 `labelPrint` 桩（**只读**：只要 `listLabels`）。 */
const labelPrintStub = (labels, extra = {}) => ({
  calls: [],
  async listLabels(filters) {
    this.calls.push(filters);
    return {
      labels, total_matched: labels.length, total_returned: labels.length, total_pairs: 5, layout: layout(),
      ...extra,
    };
  },
});

const tmpStore = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-print-queue-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  return { dir, store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const serviceFor = ({ labels = [label()], store, config, now, idFactory } = {}) => createLabelPrintQueueService({
  store,
  labelPrint: labelPrintStub(labels),
  config: { ...LABEL_PRINT_QUEUE, ...(config || {}) },
  now,
  idFactory,
});

/** 逐字节解析 xref，断言每个偏移真的指回 `N 0 obj`（手写 PDF 最容易错的地方）。 */
const assertPdfStructure = (buf, { pages }) => {
  const text = buf.toString('latin1');
  assert.match(text, /^%PDF-1\.4/, 'PDF 头');
  const tail = /startxref\s+(\d+)\s*\n%%EOF\s*$/.exec(text);
  assert.ok(tail, 'PDF 必须以 startxref + %%EOF 收尾');
  const xrefOffset = Number(tail[1]);
  assert.equal(text.slice(xrefOffset, xrefOffset + 4), 'xref', 'startxref 必须指向 xref 表');
  const lines = text.slice(xrefOffset).split('\n');
  const size = Number(lines[1].split(/\s+/)[1]);
  assert.ok(size > 1, 'xref 子段必须声明对象数');
  for (let id = 1; id < size; id += 1) {
    const match = /^(\d{10}) (\d{5}) ([nf])\s*$/.exec(lines[2 + id]);
    assert.ok(match, `第 ${id} 条 xref 行的形状`);
    const at = Number(match[1]);
    assert.equal(text.slice(at, at + `${id} 0 obj`.length), `${id} 0 obj`,
      `xref 第 ${id} 条的偏移 ${at} 必须指回 "${id} 0 obj"`);
  }
  assert.match(text, new RegExp(`/Count ${pages}\\b`), 'Pages 的 /Count');
  return { text, size };
};

// ── AC1 / AC2：产物 ────────────────────────────────────────────────────────

test('AC1 产物尺寸：40×30mm ⇒ PNG 恰好 320×240px、PDF 每页 /MediaBox 113.3858×85.0394pt（一页一张）', async () => {
  const out = await artifact.renderLabels({ labels: [label()], layout: layout(), config: { dpi: 203, jpegQuality: 92 } });
  const meta = await require('sharp')(out.pngFirst).metadata();
  assert.equal(meta.width, 320, '40mm @203dpi = 320px');
  assert.equal(meta.height, 240, '30mm @203dpi = 240px');
  assert.equal(out.meta.width_pt, 113.3858);
  assert.equal(out.meta.height_pt, 85.0394);
  const text = out.pdf.toString('latin1');
  assert.equal((text.match(/\/MediaBox \[0 0 113\.3858 85\.0394\]/g) || []).length, 1, '一页一个 MediaBox');
  assert.match(text, /\/Filter \/DCTDecode/, '图片流是 JPEG');
  assert.match(text, /\/Subtype \/Image/);
});

test('AC1 换配置就换纸：A5 之外的 50×25mm ⇒ 像素与 MediaBox 都跟着变（产物不写死 mm）', async () => {
  const out = await artifact.renderLabels({
    labels: [label()],
    layout: layout({ label: { widthMm: 50, heightMm: 25 } }),
    config: { dpi: 300, jpegQuality: 92 },
  });
  const meta = await require('sharp')(out.pngFirst).metadata();
  assert.equal(meta.width, Math.round(50 / 25.4 * 300));
  assert.equal(meta.height, Math.round(25 / 25.4 * 300));
  assert.equal(out.meta.width_pt, Number((50 * 72 / 25.4).toFixed(4)));
});

test('AC1 多张标签 ⇒ PDF 的页数 = 标签张数（一页一张），且每张页一张图', async () => {
  const labels = [label(), label({ number: 'XHB8095|黑色|A', color: '黑色', key: 'XHB8095|黑色|A' })];
  const out = await artifact.renderLabels({ labels, layout: layout(), config: { dpi: 203 } });
  assert.equal(out.meta.page_count, 2);
  assert.deepEqual(out.pages.map((page) => page.number), ['XHB8095|棕色|A', 'XHB8095|黑色|A']);
  assertPdfStructure(out.pdf, { pages: 2 });
});

test('AC2 手写 PDF 结构正确：xref 逐条偏移指回对象头 / Count 对得上 / %%EOF 收尾', async () => {
  const out = await artifact.renderLabels({
    labels: [label(), label({ number: 'b' }), label({ number: 'c' })],
    layout: layout(),
    config: { dpi: 203 },
  });
  const { text } = assertPdfStructure(out.pdf, { pages: 3 });
  assert.equal((text.match(/\/Type \/Page[^s]/g) || []).length, 3, '三个 Page 对象');
  assert.equal((text.match(/\/Subtype \/Image/g) || []).length, 3, '三个图片对象');
});

test('AC1 中文真的画出来了（品牌那行不是空白）—— 字体名必须显式写 CJK 链', async () => {
  const sharp = require('sharp');
  const withBrand = await artifact.renderLabels({ labels: [label()], layout: layout(), config: { dpi: 203 } });
  const withoutBrand = await artifact.renderLabels({
    labels: [label({ brand_text: '' })], layout: layout(), config: { dpi: 203 },
  });
  const ink = async (buf) => {
    const { data } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
    return data.reduce((sum, value) => sum + (value < 128 ? 1 : 0), 0);
  };
  const a = await ink(withBrand.pngFirst);
  const b = await ink(withoutBrand.pngFirst);
  assert.ok(a > b, `有品牌那一行的墨比没有的多（${a} vs ${b}）—— 说明中文真的被画出来了（不是空白）`);
  // ⚠️ 「画成方框」这种失败**单测抓不到**（方框也有墨），只能人眼看 —— 见报告里的打样例图。
  assert.ok(withBrand.pdf.length > 1000);
});

// ── AC3：防漂移 ────────────────────────────────────────────────────────────

test('AC3 防漂移①：产物的行高与 `features/labels/labels.css` 逐条一致（改一处必须改两处）', () => {
  const css = fs.readFileSync(path.join(WORKBENCH, 'features/labels/labels.css'), 'utf8');
  const lineHeightOf = (selector) => {
    const block = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(block, `labels.css 里找不到 ${selector}`);
    const match = /line-height:\s*([\d.]+)/.exec(block[1]);
    assert.ok(match, `${selector} 没有 line-height`);
    return Number(match[1]);
  };
  assert.equal(artifact.LINE_HEIGHTS.brand, lineHeightOf('.label-brand'));
  assert.equal(artifact.LINE_HEIGHTS.itemNo, lineHeightOf('.label-item-no'));
  assert.equal(artifact.LINE_HEIGHTS.color, lineHeightOf('.label-color'));
  assert.equal(artifact.LINE_HEIGHTS.state, lineHeightOf('.label-state'));
  assert.equal(artifact.LINE_HEIGHTS.sizes, lineHeightOf('.label-sizes'));
  assert.equal(artifact.LINE_HEIGHTS.price, lineHeightOf('.label-price'));
  assert.equal(artifact.LINE_HEIGHTS.footer, lineHeightOf('.label-footer'));
});

test('AC3 防漂移②：「货号 + 颜色」的排版与 `features/labels/render.js` 逐字段一致', async () => {
  // 把 render.js 当模块跑起来（复制成 .mjs，只改 import 文件名 —— 与 labelPrintRender.test.js 同一套做法）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-print-drift-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/formatters.js'), path.join(dir, 'formatters.mjs'));
  fs.writeFileSync(path.join(dir, 'render.mjs'),
    fs.readFileSync(path.join(WORKBENCH, 'features/labels/render.js'), 'utf8')
      .split("from '../../core/formatters.js'").join("from './formatters.mjs'"), 'utf8');
  const render = await import(pathToFileURL(path.join(dir, 'render.mjs')).href);

  const cases = [
    ['正常短货号', label()],
    ['超长货号（要缩字号）', label({ item_no: 'XHB8095-LONG-NAME-9999' })],
    ['超长到要截断', label({ item_no: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })],
    ['带品类（开关打开）', label({ category: '休闲鞋' })],
    ['颜色很长', label({ color: '深棕褐色（限量版）' })],
    ['取不到货号（占位）', label({ item_no: '' })],
  ];
  for (const [name, fixture] of cases) {
    for (const fields of [{ ...LABEL_PRINT.fields }, { ...LABEL_PRINT.fields, category: true }]) {
      const currentLayout = layout({ fields });
      const mine = artifact.planItemNoColor(fixture, currentLayout);
      const theirs = render.planItemNoColor(fixture, currentLayout);
      for (const key of ['itemNoText', 'itemNoSizeMm', 'itemNoTruncated', 'colorText', 'colorTruncated', 'categoryIncluded', 'gapMm']) {
        assert.deepEqual(mine[key], theirs[key], `${name} / ${key}`);
      }
      assert.ok(Math.abs(mine.estimatedWidthMm - theirs.estimatedWidthMm) < 1e-9, `${name} / estimatedWidthMm`);
      assert.ok(Math.abs(mine.availableWidthMm - theirs.availableWidthMm) < 1e-9, `${name} / availableWidthMm`);
    }
  }
  assert.ok(Math.abs(artifact.availableWidthMm(layout()) - 20.1) < 1e-9, '右栏可用宽度 = 20.1mm');
});

test('AC3 产物几何只认 config：品牌位置 / 右栏行序 / 字段开关一改，SVG 跟着变', () => {
  const base = artifact.labelSvg(label(), layout(), { dpi: 203 });
  // ① 品牌从"顶部"改成"右栏内" ⇒ 顶部那行的 y 不再出现在品牌文字上（结构变了）。
  const inline = artifact.labelSvg(label(), layout({ body: { brandRow: 'inline', rows: ['itemNoColor', 'brand'] } }), { dpi: 203 });
  assert.notEqual(base, inline);
  // ② 关掉二维码 ⇒ SVG 里不再有内联的那个二维码 svg。
  const noQr = artifact.labelSvg(label(), layout({ fields: { qr: false } }), { dpi: 203 });
  assert.ok(base.includes('<path'), '默认有二维码');
  assert.ok(!noQr.includes('<path'), '关掉二维码后没有它');
  // ③ 关掉价格 ⇒ 不画 ¥198。
  const noPrice = artifact.labelSvg(label(), layout({ fields: { price: false } }), { dpi: 203 });
  assert.ok(base.includes('¥198'));
  assert.ok(!noPrice.includes('¥198'));
  // ④ 像素尺寸跟着 dpi 走（同一张纸、不同分辨率的打印机）。
  assert.match(artifact.labelSvg(label(), layout(), { dpi: 300 }), /width="472" height="354"/);
});

test('AC3 文字一律转义：货号/颜色里的 & < > 不许破坏 SVG', () => {
  const svg = artifact.labelSvg(label({ item_no: 'A&B', color: '<棕>' }), layout(), { dpi: 203 });
  assert.ok(svg.includes('A&amp;B'));
  assert.ok(svg.includes('&lt;棕&gt;'));
  assert.ok(!svg.includes('<棕>'));
});

// ── AC11 / AC14：仓库（认领 + 清理）───────────────────────────────────────

test('AC11 并发认领只有一个赢家（10 个同时抢同一条，不会两个人拿到同一个任务）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    await store.create({ job_id: 'job-1', status: 'queued', created_at: new Date().toISOString() });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.claim('job-1', {
      deviceId: 'pc', now: Date.now(), claimTimeoutMs: 60_000,
    })));
    assert.equal(results.filter((item) => item.claimed).length, 1, '只有一个人能拿到');
    const job = await store.get('job-1');
    assert.equal(job.status, 'claimed');
    assert.equal(job.claim_count, 1);
  } finally {
    cleanup();
  }
});

test('AC11 认领未超时 ⇒ 别人领不到；超时 ⇒ 可以重投（且标记 redelivered）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    await store.create({ job_id: 'job-1', status: 'queued', created_at: new Date().toISOString() });
    const t0 = 1_000_000;
    const first = await store.claim('job-1', { deviceId: 'pc', now: t0, claimTimeoutMs: 60_000 });
    assert.equal(first.claimed, true);
    assert.equal(first.redelivered, false, '第一次领取不是重投');
    const second = await store.claim('job-1', { deviceId: 'other', now: t0 + 30_000, claimTimeoutMs: 60_000 });
    assert.equal(second.claimed, false, '没超时不许抢');
    assert.equal(second.reason, 'not_claimable:claimed');
    const third = await store.claim('job-1', { deviceId: 'other', now: t0 + 61_000, claimTimeoutMs: 60_000 });
    assert.equal(third.claimed, true, '超时后可以重投（电脑打一半断电了）');
    assert.equal(third.redelivered, true);
    assert.equal((await store.get('job-1')).claim_count, 2);
  } finally {
    cleanup();
  }
});

test('AC14 保留期：done 过期连产物一起清；🔴 queued / claimed 永不清理', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const old = new Date(1_000_000_000_000).toISOString();
    for (const [id, status] of [['done-old', 'done'], ['failed-old', 'failed'], ['queued-old', 'queued'], ['claimed-old', 'claimed']]) {
      // 形状照着真实任务来（真实任务一定有 `artifact`：产物名就记在那儿）。
      await store.create({
        job_id: id,
        status,
        created_at: old,
        created_at_ms: 1_000_000_000_000,
        artifact: { pdf: `${id}.pdf`, png: '' },
      });
      await fs.promises.writeFile(store.artifactPath(`${id}.pdf`), 'x');
    }
    const service = serviceFor({ store, config: { retentionMs: 60_000 }, now: () => 2_000_000_000_000 });
    await service.cleanup({ force: true });
    const left = (await store.listAll()).map((job) => job.job_id).sort();
    assert.deepEqual(left, ['claimed-old', 'queued-old'], '只有 done/failed 被清');
    assert.ok(!fs.existsSync(store.artifactPath('done-old.pdf')), '过期任务的产物一起删');
    assert.ok(fs.existsSync(store.artifactPath('queued-old.pdf')), '排队任务的产物必须留着');
  } finally {
    cleanup();
  }
});

// ── AC4 ~ AC13：队列服务 ───────────────────────────────────────────────────

test('AC4 入队（按编号）：状态 queued + 产物已落盘 + 唤醒订阅者（事件推送的落点）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    const events = [];
    service.subscribe((event) => events.push(event));
    const result = await service.enqueueSingle({ number: 'XHB8095|棕色|A', actor: 'ou_她' });
    assert.equal(result.job.status, 'queued');
    assert.equal(result.job.status_label, '待打印');
    assert.equal(result.total_labels, 1);
    const job = await service.getJob(result.job_id);
    assert.equal(job.status, 'queued');
    assert.ok(fs.existsSync(store.artifactPath(job.artifact.pdf)), 'PDF 已落盘');
    assert.ok(fs.existsSync(store.artifactPath(job.artifact.png)), '预览 PNG 已落盘');
    assert.ok(job.artifact.sha256 && job.artifact.sha256.length === 64);
    assert.deepEqual(job.numbers, ['XHB8095|棕色|A']);
    assert.equal(events.length, 1, '入队立刻推给长连接');
    assert.equal(events[0].type, 'job');
    assert.equal(events[0].payload.job_id, result.job_id);
  } finally {
    cleanup();
  }
});

test('AC5 ⭐ 电脑离线 ⇒ 任务排队保留 + 手机看到「未连接（任务已排队）」', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const t = { value: 1_000_000 };
    const service = serviceFor({ store, now: () => t.value, config: { onlineTimeoutMs: 90_000 } });
    const enqueued = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    // 从没心跳过 ⇒ 未连接；任务仍然好好排着。
    let status = await service.status();
    assert.equal(status.online, false);
    assert.equal(status.counts.queued, 1, '任务在排队（不是丢了）');
    assert.equal((await service.getJob(enqueued.job_id)).status, 'queued');

    // 来一次心跳 ⇒ 在线；超过 onlineTimeoutMs 没心跳 ⇒ 又变回未连接。
    service.heartbeat({ deviceId: 'store-pc', info: { printer: 'HPRT' } });
    status = await service.status();
    assert.equal(status.online, true);
    assert.equal(status.device_id, 'store-pc');
    assert.deepEqual(status.devices[0].info, { printer: 'HPRT' });

    t.value += 90_001;
    status = await service.status();
    assert.equal(status.online, false, '超时未心跳 = 未连接');
    assert.equal(status.counts.queued, 1);
  } finally {
    cleanup();
  }
});

test('AC6 ⭐⭐ 启动补拉：电脑关着时入队的任务，小助手一起来 listPending 立刻取回（不是等下一个周期）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    // ① 电脑关着，她先在手机上点了两次打印。
    const first = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    const second = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    assert.equal((await service.status()).online, false);
    // ② 电脑开机：小助手第一件事就是补拉 —— 两条一次全拿到。
    const pending = await service.listPending({ deviceId: 'store-pc' });
    assert.deepEqual(pending.map((job) => job.job_id), [first.job_id, second.job_id], '先进先出');
    // ③ 补拉**不认领**：还没开始打，任务必须还留在"待打印"（列完就崩了也不该算已取走）。
    assert.equal((await service.getJob(first.job_id)).status, 'queued');
    // ④ 逐个认领 —— 与长连接收到事件后做的事一模一样。
    const claimed = await service.claimNext({ deviceId: 'store-pc' });
    assert.equal(claimed.job_id, first.job_id);
    assert.equal(claimed.status, 'claimed');
  } finally {
    cleanup();
  }
});

test('AC6 补拉与事件推送是同一份数据：入队后再补拉，看到的还是同一条', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    const events = [];
    service.subscribe((event) => events.push(event.payload));
    await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    const pending = await service.listPending({});
    assert.equal(pending.length, 1);
    assert.equal(pending[0].job_id, events[0].job_id);
  } finally {
    cleanup();
  }
});

test('AC7 状态流转 queued → claimed → done（记下时间与"谁打的"）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    let clock = 1_000_000;
    const service = serviceFor({ store, now: () => clock });
    const { job_id: jobId } = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    assert.equal((await service.getJob(jobId)).status, 'queued');
    clock += 5_000;
    const claimed = await service.claimNext({ deviceId: 'store-pc' });
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.claimed_by, 'store-pc');
    clock += 3_000;
    const done = await service.ack({ jobId, status: 'done', deviceId: 'store-pc' });
    assert.equal(done.job.status, 'done');
    assert.equal(done.job.status_label, '已打印');
    assert.equal(done.job.printed_by, 'store-pc');
    assert.ok(done.job.printed_at);
    const status = await service.status();
    assert.deepEqual(status.counts, { queued: 0, claimed: 0, done: 1, failed: 0 });
  } finally {
    cleanup();
  }
});

test('AC8 ⭐ 幂等：同一条任务绝不会被领第二次；重复回执是 no-op（不改状态、不改时间）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    const { job_id: jobId } = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    await service.claimNext({ deviceId: 'store-pc' });
    const done = await service.ack({ jobId, status: 'done', deviceId: 'store-pc' });
    // 小助手回执丢了 ⇒ 它重发一次：不许报错、不许把时间刷新、不许变成失败。
    const again = await service.ack({ jobId, status: 'done', deviceId: 'store-pc' });
    assert.equal(again.duplicate, true);
    assert.equal(again.job.printed_at, done.job.printed_at, '时间不许被刷成"第二次回执的时间"');
    // 已经打完的任务再也不会被领到 ⇒ **绝不会重复打印**。
    assert.equal(await service.claimNext({ deviceId: 'store-pc' }), null);
    assert.equal(await service.claimNext({ deviceId: 'store-pc' }), null);
    // 另一台电脑/另一轮补拉也拿不到它。
    assert.deepEqual(await service.listPending({ deviceId: 'other-pc' }), []);
  } finally {
    cleanup();
  }
});

test('AC9 失败必须带原因（空原因 ⇒ 400）；带原因时原因原样留在任务上给手机看', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    const { job_id: jobId } = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    await service.claimNext({ deviceId: 'store-pc' });
    await assert.rejects(() => service.ack({ jobId, status: 'failed', deviceId: 'store-pc' }),
      (error) => error.statusCode === 400 && /原因/.test(error.message));
    const failed = await service.ack({
      jobId, status: 'failed', reason: '打印机没开（SumatraPDF 退出码 2）', deviceId: 'store-pc',
    });
    assert.equal(failed.job.status, 'failed');
    assert.equal(failed.job.status_label, '失败');
    assert.equal(failed.job.failure_reason, '打印机没开（SumatraPDF 退出码 2）');
    assert.ok(failed.job.failed_at);
    await assert.rejects(() => service.ack({ jobId, status: 'weird', deviceId: 'store-pc' }),
      (error) => error.statusCode === 400);
  } finally {
    cleanup();
  }
});

test('AC10 迟到/冲突的回执不许篡改事实：done 之后来的 failed 被忽略', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    const { job_id: jobId } = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    await service.claimNext({ deviceId: 'store-pc' });
    await service.ack({ jobId, status: 'done', deviceId: 'store-pc' });
    const late = await service.ack({ jobId, status: 'failed', reason: '迟到的失败', deviceId: 'store-pc' });
    assert.equal(late.ignored, true);
    const job = await service.getJob(jobId);
    assert.equal(job.status, 'done', '成功的事实不许被迟到的失败改掉');
    assert.equal(job.failure_reason, null);
  } finally {
    cleanup();
  }
});

test('AC11 认领超时后才能被别人重投；未超时 claimNext 拿不到它（不会两个人同时打同一张）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    let clock = 1_000_000;
    const service = serviceFor({ store, now: () => clock, config: { claimTimeoutMs: 120_000 } });
    const { job_id: jobId } = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    const claimed = await service.claimNext({ deviceId: 'store-pc' });
    assert.equal(claimed.job_id, jobId);
    // 电脑正在打（没超时）⇒ 谁也别想再领走。
    assert.equal(await service.claimNext({ deviceId: 'other' }), null);
    // 超时（电脑打一半断电了）⇒ 任务可以被重新领走，但**重投不等于重打**（小助手本地台账挡住重打）。
    clock += 120_001;
    const redelivered = await service.claimNext({ deviceId: 'store-pc' });
    assert.equal(redelivered.job_id, jobId);
    assert.equal(redelivered.claim_count, 2);
    assert.equal(redelivered.claimed_by, 'store-pc');
  } finally {
    cleanup();
  }
});

test('AC12 ⭐ 补打生成新任务（reprint_of 指向原任务），原任务一个字不改；产物过期则明确报错', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    const { job_id: jobId } = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    await service.claimNext({ deviceId: 'store-pc' });
    await service.ack({ jobId, status: 'failed', reason: '纸卡住了', deviceId: 'store-pc' });
    const before = await service.getJob(jobId);

    const again = await service.reprint({ jobId, actor: 'ou_她' });
    assert.notEqual(again.job_id, jobId);
    assert.equal(again.job.reprint_of, jobId);
    assert.equal(again.job.status, 'queued');
    assert.equal(again.job.failure_reason, '', '新任务不带旧任务的失败原因');
    const after = await service.getJob(jobId);
    assert.equal(after.status, 'failed', '原任务一个字不改');
    assert.equal(after.failure_reason, before.failure_reason);
    // 补打的产物是**复制**的（同一份内容，不重新查库存），所以新任务能直接被打出来。
    const newJob = await service.getJob(again.job_id);
    assert.ok(fs.existsSync(store.artifactPath(newJob.artifact.pdf)));
    assert.equal(fs.readFileSync(store.artifactPath(newJob.artifact.pdf)).length, before.artifact.pdf_bytes);
    // 原产物没了（过了保留期）⇒ 明确报错，不静默重新生成"现在的"数据。
    await fs.promises.rm(store.artifactPath(before.artifact.pdf), { force: true });
    await assert.rejects(() => service.reprint({ jobId }), (error) => error.statusCode === 400 && /过期/.test(error.message));
  } finally {
    cleanup();
  }
});

test('AC13 不静默①：编号没有库存 ⇒ 400 说清；mode 写错 ⇒ 400', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store, labels: [label()] });
    await assert.rejects(() => service.enqueueSingle({ number: 'NOT-EXIST|黑色|A' }),
      (error) => error.statusCode === 400 && /没有找到编号/.test(error.message));
    await assert.rejects(() => service.enqueue({ mode: 'whatever' }),
      (error) => error.statusCode === 400 && /mode/.test(error.message));
    await assert.rejects(() => service.enqueueSingle({ number: '  ' }),
      (error) => error.statusCode === 400);
  } finally {
    cleanup();
  }
});

test('AC13 不静默②：一批超过上限 ⇒ 400 + 人话（绝不静默截断）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const many = Array.from({ length: 5 }, (unused, index) => label({ number: `n${index}`, key: `n${index}` }));
    const service = serviceFor({ store, labels: many, config: { maxLabelsPerJob: 3 } });
    await assert.rejects(() => service.enqueueBatch({ filters: {} }),
      (error) => error.statusCode === 400 && /一次最多打 3 张/.test(error.message) && /匹配 5 张/.test(error.message));
    assert.equal((await store.listAll()).length, 0, '被拒的请求不许留下半条任务');
  } finally {
    cleanup();
  }
});

test('AC13 不静默③：条件下一张都没有 ⇒ 400；产物渲染失败 ⇒ 502 且不留半条任务', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const empty = serviceFor({ store, labels: [] });
    await assert.rejects(() => empty.enqueueBatch({ filters: {} }),
      (error) => error.statusCode === 400 && /一张标签都没有/.test(error.message));

    // 让"画产物"这一步真的失败（渲染器可注入）⇒ 必须 502，并且**不留半条任务、不留垃圾文件**。
    const broken = createLabelPrintQueueService({
      store,
      labelPrint: labelPrintStub([label()]),
      config: LABEL_PRINT_QUEUE,
      renderLabels: async () => { throw new Error('sharp 说这张图画不出来'); },
    });
    await assert.rejects(() => broken.enqueueSingle({ number: 'XHB8095|棕色|A' }),
      (error) => error.statusCode === 502 && /打印文件生成失败/.test(error.message));
    assert.equal((await store.listAll()).length, 0, '渲染失败不许留下半条任务');
    assert.deepEqual(await fs.promises.readdir(store.artifactsDir), [], '也不许留下垃圾产物文件');
  } finally {
    cleanup();
  }
});

test('AC15 配置先行：认领超时 / 在线超时 / 一次上限 / 开关，改配置就改行为（不用改代码）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    // ① 关掉队列 ⇒ 503（不是 404、不是静默）。
    const off = serviceFor({ store, config: { enabled: false } });
    await assert.rejects(() => off.enqueueSingle({ number: 'XHB8095|棕色|A' }),
      (error) => error.statusCode === 503);

    // ② 在线超时改成 1 秒 ⇒ 心跳 1.5 秒后就算离线。
    let clock = 1_000_000;
    const quick = serviceFor({ store, now: () => clock, config: { onlineTimeoutMs: 1_000 } });
    quick.heartbeat({ deviceId: 'store-pc' });
    assert.equal((await quick.status()).online, true);
    clock += 1_500;
    assert.equal((await quick.status()).online, false);

    // ③ 列表条数可配。
    const limited = serviceFor({ store, config: { listLimit: 1 } });
    await limited.enqueueSingle({ number: 'XHB8095|棕色|A' });
    await limited.enqueueSingle({ number: 'XHB8095|棕色|A' });
    assert.equal((await limited.listJobs({})).length, 1);
  } finally {
    cleanup();
  }
});

test('AC15 环境变量：显式布尔 / 非法传输方式当场抛错（不许静默回退）', () => {
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_QUEUE_ENABLED: '' }).enabled, false, '空串 = 关掉');
  assert.equal(resolveLabelPrintQueueConfig({}).enabled, true, '没设 = 默认开');
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_TRANSPORT: 'longpoll' }).transport, 'longpoll');
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_TRANSPORT: 'ws' }), /sse 或 longpoll/);
  assert.throws(() => resolveLabelPrintQueueConfig({ LABEL_PRINT_QUEUE_ENABLED: 'maybe' }), /显式布尔/);
  // ⚠️ 令牌：没配 = 空串（电脑侧接口据此回 503，**不回退到任何默认令牌**）。
  assert.equal(resolveLabelPrintQueueConfig({}).device.token, '');
  assert.equal(resolveLabelPrintQueueConfig({ LABEL_PRINT_DEVICE_TOKEN: 't0k' }).device.token, 't0k');
  assert.equal(artifactsDirOf({ storeDir: '/tmp/x', artifactsSubdir: 'artifacts' }), path.join('/tmp/x', 'artifacts'));
});

test('AC4 按编号入队：精确匹配那一个编号（同货号别的颜色不许混进来）', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const labels = [
      label({ number: 'XHB8095|棕色|A', color: '棕色' }),
      label({ number: 'XHB8095|黑色|A', color: '黑色' }),
    ];
    const service = serviceFor({ store, labels });
    const result = await service.enqueueSingle({ number: 'XHB8095|黑色|A' });
    const job = await service.getJob(result.job_id);
    assert.deepEqual(job.numbers, ['XHB8095|黑色|A']);
    assert.equal(job.total_labels, 1);
  } finally {
    cleanup();
  }
});

test('最近一次任务（扫码页零 JS 靠它）：latestJobForNumber 找得到 / 找不到回 null', async () => {
  const { store, cleanup } = tmpStore();
  try {
    const service = serviceFor({ store });
    assert.equal(await service.latestJobForNumber('XHB8095|棕色|A'), null, '还没打过 = null（不是错误）');
    const first = await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    await service.enqueueSingle({ number: 'XHB8095|棕色|A' });
    const latest = await service.latestJobForNumber('XHB8095|棕色|A');
    assert.ok(latest);
    assert.notEqual(latest.job_id, first.job_id, '取最近一条');
    assert.equal(await service.latestJobForNumber('NOT-EXIST|X|A'), null);
  } finally {
    cleanup();
  }
});
