'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');
const { LABEL_PRINT_V5 } = require('../src/config/labelPrint');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const artifact = require('../src/services/labelPrintArtifactService');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');
const { formatPrintTime } = require('../src/services/labelPrintTime');

const label = (patch = {}) => ({
  key: 'XHB8095|棕色|男',
  number: 'XHB8095|棕色|男',
  item_no: 'XHB8095',
  color: '棕色',
  category_code: '男',
  sizes: [{ size: 36, qty: 1 }, { size: 37, qty: 2 }, { size: 38, qty: 1 }],
  size_lines: [[{ size: 36, qty: 1 }, { size: 37, qty: 2 }, { size: 38, qty: 1 }]],
  total_qty: 4,
  price: 198,
  price_text: '¥198',
  brand_text: '邯美皮鞋',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
  ...patch,
});

test('打印时间固定按上海时区格式化为 YYYY-MM-DD HH:mm', () => {
  assert.equal(formatPrintTime(new Date('2026-11-20T16:05:00.000Z'), LABEL_PRINT_V5.printTime),
    '2026-11-21 00:05');
});

test('V5 标签：打印时间在二维码上方一行，字号 2mm，间距 0.65mm，横向压缩避免压到价格', () => {
  const svg = artifact.labelSvg({ ...label(), print_time: '2026-11-21 00:05' }, LABEL_PRINT_V5, { dpi: 203 });
  assert.match(svg, /translate\(8\.2 9\.9\) scale\(0\.86 1\)/, '时间组位置 = 二维码中心、二维码顶部上方 0.65mm');
  assert.match(svg, /font-size="2"[^>]*text-anchor="middle">2026-11-21 00:05<\/text>/, '一行、2mm、居中');
  assert.equal(svg.includes('<tspan'), false, '不拆成两行');
});

test('入队时把生成打印文件的时间传给产物渲染（同一批任务共用同一个时间）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-print-time-'));
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  let captured = null;
  const service = createLabelPrintQueueService({
    store,
    labelPrint: {
      async listLabels() {
        return {
          labels: [label()], total_matched: 1, total_returned: 1, total_pairs: 4, layout: LABEL_PRINT_V5,
        };
      },
    },
    config: { ...LABEL_PRINT_QUEUE, artifact: { ...LABEL_PRINT_QUEUE.artifact, keepPng: false } },
    now: () => Date.parse('2026-11-20T16:05:00.000Z'),
    idFactory: () => 'job_print_time_1',
    renderLabels: async (input) => {
      captured = input;
      return {
        pdf: Buffer.from('%PDF-1.4 print time'),
        pngFirst: Buffer.from('png'),
        pages: [{ number: 'XHB8095|棕色|男' }],
        meta: { page_count: 1, pdf_bytes: 22, dpi: 203, width_mm: 40, height_mm: 30, width_pt: 113.4, height_pt: 85, canvas: 'landscape', rotate: 0 },
      };
    },
  });
  try {
    await service.enqueueSingle({ number: 'XHB8095|棕色|男' });
    assert.equal(captured.printTime, '2026-11-21 00:05');
  } finally {
    // 入队后的清理是 fire-and-forget；等它跑完再删临时目录，避免噪声日志。
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
