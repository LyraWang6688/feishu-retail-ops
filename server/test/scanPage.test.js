/**
 * 扫码页（第一版：只读查库存）的**取数与聚合**用例。
 *
 * 钉住的五件事（brief 点名）：
 *   ① 编号解码：URL 编码过的（含中文与 `|`）要解出来；未编码的中文照收；
 *      孤立的 `%`（`50%OFF`）不许抛；
 *   ② 按编号聚合的库存表：每个尺码一行 × 三种状态，**0 显示「—」**，
 *      缺码（「尺码管理」里该类别有、库存为 0）要高亮出来；
 *   ③ 没找到编号 → `found:false`（路由会渲染友好页，见 scanPageRoute.test.js）；
 *   ④ **只读**：假网关的 create/update/delete 一被碰就抛，而查询照常出结果 +
 *      源码扫描（四个文件里不许出现写调用）；
 *   ⑤ 降级：拿不到「尺码管理.类别」→ 只显示有库存的尺码 + 不编造缺码。
 *
 * 夹具照着**测试 Base 的真实列形状**写（本机只读实测）：
 *   · 「尺码管理」= 尺码(数字) + 类别(单选 A/B)；
 *   · 「货品信息」= 编号(公式 `货号|颜色|类别`) + 货号 + 颜色(关联) + 类别(单选) + 品类(关联) + 单价；
 *   · 「实时库存」= 编号(关联货品) + 尺码(关联尺码管理) + 所属状态(单选) + 库存键(公式) + 品类(公式)。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE, fillText } = require('../src/config/scanPage');
const {
  createScanPageService, decodeScanNumber, parseNumberSegments, formatPrice, shanghaiDateTimeText,
} = require('../src/services/scanPageService');

const SERVER_SRC = path.join(__dirname, '..', 'src');

// ── 夹具 ────────────────────────────────────────────────────────────────────
const NUMBER = 'YD6693-2|黑色|A';
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER,
    货号: 'YD6693-2',
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A',
    品类: { text: '休闲鞋', record_ids: ['cat_casual'] },
    单价: 399,
  },
};
const SIZE_RECORDS = [
  // ⚠️ 本机测试 Base（生产同形状）只读实测：「尺码管理.类别」是**多选**（type=4，选项 A/B），
  //    记录 API 回的是**数组** —— 夹具照真实形状写，别写成 'A' 字符串。
  { record_id: 'size_40', fields: { 尺码: 40, 类别: ['A'] } },
  { record_id: 'size_41', fields: { 尺码: 41, 类别: ['A'] } },
  { record_id: 'size_42', fields: { 尺码: 42, 类别: ['A'] } },
  // ⚠️ 女鞋（B）的尺码：**不许**出现在这个编号的缺码判定里。
  { record_id: 'size_38', fields: { 尺码: 38, 类别: ['B'] } },
];

const inventoryRow = (id, sizeRecordId, state, extra = {}) => ({
  record_id: id,
  fields: {
    编号: ['prod_1'],
    尺码: [sizeRecordId],
    所属状态: state,
    库存键: `YD6693-2|黑色|A|${extra.size ?? String(sizeRecordId).replace('size_', '')}`,
    品类: '休闲鞋',
    更新时间: extra.updatedAt ?? Date.UTC(2026, 9, 8, 12, 30),
    ...extra.fields,
  },
});

const DEFAULT_INVENTORY = [
  inventoryRow('inv_40_box', 'size_40', '门盒'),
  inventoryRow('inv_42_box', 'size_42', '门盒'),
  inventoryRow('inv_42_sample', 'size_42', '样品'),
];

/** 假网关：只实现**读**（`table`/`listAll`），写方法一被调用就抛（钉住"只读"）。 */
const fakeGateway = ({ products = [PRODUCT], inventory = DEFAULT_INVENTORY, sizes = SIZE_RECORDS } = {}) => {
  const writes = [];
  const boom = (name) => async () => {
    writes.push(name);
    throw new Error(`扫码页不许写：${name}`);
  };
  return {
    writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => ({ product: products, liveInventory: inventory, sizeManagement: sizes }[key] || []),
    create: boom('create'),
    update: boom('update'),
    delete: boom('delete'),
  };
};

const service = (options) => createScanPageService(fakeGateway(options), { config: SCAN_PAGE });

// ── ① 编号解码 ──────────────────────────────────────────────────────────────
test('① 编号解码：URL 编码（中文 + `|`）、未编码中文、以及孤立 `%` 都不出事', () => {
  assert.equal(decodeScanNumber('YD6693-2%7C%E9%BB%91%E8%89%B2%7CA'), NUMBER);
  assert.equal(decodeScanNumber('YD6693-2|黑色|A'), NUMBER);
  assert.equal(decodeScanNumber('  YD6693-2%7C%E9%BB%91%E8%89%B2%7CA  '), NUMBER);
  // 双重编码（有些客户端会把整段再编一次）
  assert.equal(decodeScanNumber('YD6693-2%257C%25E9%25BB%2591%25E8%2589%25B2%257CA'), NUMBER);
  // 编号里合法的空格**不许**被折叠：二维码里的空格是 `%20`
  assert.equal(decodeScanNumber('A%20B'), 'A B');
  // 孤立 `%`：decodeURIComponent 会抛 —— 必须退回原值，不许把整页打成 500
  assert.equal(decodeScanNumber('50%OFF'), '50%OFF');
  assert.equal(decodeScanNumber('50%25OFF'), '50%OFF');
  assert.equal(decodeScanNumber(''), '');
  assert.equal(decodeScanNumber(undefined), '');
});

test('① 编号切段：货号 / 颜色 / 类别（切不出第 3 段就是"没有类别"）', () => {
  assert.deepEqual(parseNumberSegments(NUMBER), { itemNo: 'YD6693-2', color: '黑色', categoryCode: 'A' });
  assert.deepEqual(parseNumberSegments('26812|黑色|A'), { itemNo: '26812', color: '黑色', categoryCode: 'A' });
  assert.deepEqual(parseNumberSegments('XHB8095|黑色'), { itemNo: 'XHB8095', color: '黑色', categoryCode: '' });
});

// ── ② 库存聚合 + 缺码 ───────────────────────────────────────────────────────
test('② 按编号聚合：每个尺码一行 × 门盒/样品/仓库，0 显示占位，缺码高亮', async () => {
  const view = await service().lookup({ number: NUMBER, requestId: 'req_1' });

  assert.equal(view.found, true);
  assert.equal(view.number, NUMBER);
  assert.equal(view.item_no, 'YD6693-2');
  assert.equal(view.color, '黑色');
  assert.equal(view.category_name, '休闲鞋');
  assert.equal(view.category_code, 'A');
  assert.equal(view.price_text, '¥399');
  assert.equal(view.total, 3, '共 N 双 = 「实时库存」里属于这个编号的记录条数');
  assert.deepEqual(view.columns.map((column) => column.label), ['门盒', '样品', '仓库']);

  assert.deepEqual(view.rows.map((row) => row.size_text), ['40', '41', '42'], '尺码按数字升序');
  const bySize = new Map(view.rows.map((row) => [row.size_text, row]));
  assert.deepEqual(bySize.get('40').cells.map((cell) => cell.count), [1, 0, 0]);
  assert.deepEqual(bySize.get('42').cells.map((cell) => cell.count), [1, 1, 0]);
  // 缺码：41 在「尺码管理」的 A 类里有、库存为 0
  assert.equal(bySize.get('41').missing, true);
  assert.deepEqual(bySize.get('41').cells.map((cell) => cell.count), [0, 0, 0]);
  assert.equal(bySize.get('40').missing, false);
  assert.equal(bySize.get('42').missing, false);
  assert.equal(view.missing_count, 1);
  assert.equal(view.sizes_degraded, false);

  // 女鞋（B）的 38 码**不许**被算成缺码（否则每个编号都会显示一堆别的品类的尺码）
  assert.equal(bySize.has('38'), false);

  // 每一行的合计与"共 N 双"必须自洽（本页最不能出的错）
  assert.equal(view.rows.reduce((sum, row) => sum + row.total, 0), view.total);
  assert.ok(view.notes.some((note) => note.includes('缺')));
  assert.equal(view.updated_at_text, shanghaiDateTimeText(Date.UTC(2026, 9, 8, 12, 30)));
});

test('② 降级：拿不到「尺码管理.类别」时**只显示有库存的尺码**，不编造缺码 + 页面写明', async () => {
  // 生产表上万一没有「类别」这一列（或被清空）——本机测试 Base 有，生产核不到，
  // 所以这条降级路径必须真的能走通，且**不猜**。
  const sizesWithoutCategory = SIZE_RECORDS.map((record) => ({ ...record, fields: { 尺码: record.fields.尺码 } }));
  const view = await service({ sizes: sizesWithoutCategory }).lookup({ number: NUMBER, requestId: 'req_2' });

  assert.equal(view.found, true);
  assert.equal(view.sizes_degraded, true);
  assert.equal(view.scope_reason, 'no_category_column');
  assert.deepEqual(view.rows.map((row) => row.size_text), ['40', '42'], '只显示有库存的尺码');
  assert.equal(view.missing_count, 0, '拿不到全部尺码时一个缺码都不许标');
  assert.equal(view.total, 3);
  assert.equal(view.rows.reduce((sum, row) => sum + row.total, 0), view.total);
  assert.ok(view.notes.includes(SCAN_PAGE.texts.degradedSizesNote));
});

test('② 降级：编号里没有类别（`货号|颜色`）→ 同样退回"只有库存的尺码"', async () => {
  const view = await service({
    products: [{ ...PRODUCT, fields: { ...PRODUCT.fields, 编号: 'YD6693-2|黑色' } }],
  }).lookup({ number: 'YD6693-2|黑色', requestId: 'req_3' });
  assert.equal(view.found, true);
  assert.equal(view.sizes_degraded, true);
  assert.equal(view.scope_reason, 'number_without_category');
  assert.equal(view.missing_count, 0);
});

test('② 类别是**多选**（A,B 同时勾）时按成员判定：男女鞋都用的尺码算男鞋有、女鞋专属的不算', async () => {
  const sizes = [
    { record_id: 'size_40', fields: { 尺码: 40, 类别: ['A', 'B'] } }, // 男女鞋都用
    { record_id: 'size_41', fields: { 尺码: 41, 类别: ['B'] } },      // 女鞋专属
    { record_id: 'size_42', fields: { 尺码: 42, 类别: 'A' } },        // 单选/文本形状也认
  ];
  const view = await service({
    sizes,
    inventory: [inventoryRow('inv_40_box', 'size_40', '门盒')],
  }).lookup({ number: NUMBER, requestId: 'req_multi' });

  assert.equal(view.sizes_degraded, false);
  assert.deepEqual(view.rows.map((row) => row.size_text), ['40', '42']);
  assert.equal(view.rows.find((row) => row.size_text === '40').missing, false);
  assert.equal(view.rows.find((row) => row.size_text === '42').missing, true,
    '42 在她的 A 类清单里、但一双库存都没有 ⇒ 缺码');
  assert.equal(view.missing_count, 1);
});

test('② 状态里出现配置外的取值 / 读不出尺码：**不丢**、另列，且"共 N 双"仍然对得上', async () => {
  const inventory = [
    ...DEFAULT_INVENTORY,
    inventoryRow('inv_41_warehouse', 'size_41', '仓库'),
    // 她在表里新加了一个状态
    { record_id: 'inv_40_other', fields: { 编号: ['prod_1'], 尺码: ['size_40'], 所属状态: '车里', 库存键: 'YD6693-2|黑色|A|40' } },
    // 尺码关联被清空、库存键也读不出尺码
    { record_id: 'inv_broken', fields: { 编号: ['prod_1'], 尺码: [], 所属状态: '门盒', 库存键: '' } },
  ];
  const view = await service({ inventory }).lookup({ number: NUMBER, requestId: 'req_4' });

  assert.equal(view.total, 6);
  assert.deepEqual(view.columns.map((column) => column.label), ['门盒', '样品', '仓库', '车里']);
  const bySize = new Map(view.rows.map((row) => [row.size_text, row]));
  assert.deepEqual(bySize.get('41').cells.map((cell) => cell.count), [0, 0, 1, 0]);
  assert.equal(bySize.get('41').missing, false, '有库存就不算缺码');
  // 读不出尺码的那一双：单独一行、照样计数
  const unresolved = view.rows.find((row) => row.unknown_size);
  assert.ok(unresolved, '读不出尺码的记录必须单独列出来，不许静默丢掉');
  assert.equal(unresolved.size_text, SCAN_PAGE.texts.unknownSizeLabel);
  assert.equal(unresolved.total, 1);
  assert.equal(view.rows.reduce((sum, row) => sum + row.total, 0), view.total);
  assert.ok(view.notes.some((note) => note.includes('所') || note.includes('状态')));
});

test('② 尺码关联损坏时退回「库存键」最后一段（关联单元格没有文本也能认出尺码）', async () => {
  const inventory = [
    { record_id: 'inv_1', fields: { 编号: ['prod_1'], 尺码: ['unknown_size_record'], 所属状态: '门盒', 库存键: 'YD6693-2|黑色|A|41' } },
  ];
  const view = await service({ inventory }).lookup({ number: NUMBER, requestId: 'req_5' });
  assert.equal(view.total, 1);
  assert.equal(view.rows.find((row) => row.size_text === '41').total, 1);
  assert.equal(view.rows.some((row) => row.unknown_size), false);
});

test('② 关联单元格为空时用「库存键」前缀认行（数据残缺也要看得见库存）', async () => {
  const inventory = [{ record_id: 'inv_1', fields: { 编号: [], 尺码: ['size_40'], 所属状态: '门盒', 库存键: 'YD6693-2|黑色|A|40' } }];
  const view = await service({ inventory }).lookup({ number: NUMBER, requestId: 'req_6' });
  assert.equal(view.total, 1);
  assert.equal(view.rows[0].size_text, '40');
});

test('② 大小写兜底：她照着标签手打一遍（大小写不一致）也能查到', async () => {
  const view = await service({
    products: [{ ...PRODUCT, fields: { ...PRODUCT.fields, 编号: 'XHB8095|黑色|A' } }],
    inventory: [{ record_id: 'inv_1', fields: { 编号: ['prod_1'], 尺码: ['size_40'], 所属状态: '门盒', 库存键: 'XHB8095|黑色|A|40' } }],
  }).lookup({ number: 'xhb8095|黑色|A', requestId: 'req_7' });
  assert.equal(view.found, true);
  assert.equal(view.total, 1);
});

// ── ③ 没找到 ────────────────────────────────────────────────────────────────
test('③ 没找到这个编号 / 空编号：`found:false`，不抛、不 500', async () => {
  const gateway = fakeGateway();
  const scan = createScanPageService(gateway, { config: SCAN_PAGE });

  const unknown = await scan.lookup({ number: 'NOPE|黑色|A', requestId: 'req_8' });
  assert.deepEqual(unknown, { found: false, number: 'NOPE|黑色|A', reason: 'unknown' });

  const empty = await scan.lookup({ number: '   ', requestId: 'req_9' });
  assert.equal(empty.found, false);
  assert.equal(empty.reason, 'empty');

  assert.deepEqual(gateway.writes, [], '查不到也不许写任何东西');
});

// ── ④ 只读 ─────────────────────────────────────────────────────────────────
test('④ 只读：查询成功时一次写调用都没有（假网关的写方法一碰就抛）', async () => {
  const gateway = fakeGateway();
  const view = await createScanPageService(gateway, { config: SCAN_PAGE }).lookup({ number: NUMBER, requestId: 'req_10' });
  assert.equal(view.found, true);
  assert.deepEqual(gateway.writes, []);
});

test('④ 只读（源码扫描）：config / service / view / route 四个文件里没有任何写调用', () => {
  const files = [
    path.join(SERVER_SRC, 'config', 'scanPage.js'),
    path.join(SERVER_SRC, 'services', 'scanPageService.js'),
    path.join(SERVER_SRC, 'views', 'scanPageRenderer.js'),
    path.join(SERVER_SRC, 'routes', 'scanPage.js'),
  ];
  const forbidden = [
    { pattern: /gateway\.(create|update|delete)\s*\(/, what: 'gateway 写调用' },
    { pattern: /appTableRecord\.(create|update|delete)/, what: '飞书写记录接口' },
    { pattern: /\.(applySale|applyPurchase|applyChange|applyReturn)\s*\(/, what: '库存写入口' },
    { pattern: /inventoryService|salesOrderService|purchaseWebhookService/, what: '写链路的服务' },
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { pattern, what } of forbidden) {
      assert.equal(pattern.test(source), false, `${path.basename(file)} 出现了${what}：${pattern}`);
    }
  }
});

// ── 取数上限 ────────────────────────────────────────────────────────────────
test('取数上限：超过上限**明确报错**（不许显示一张不完整的库存表）', async () => {
  const many = Array.from({ length: SCAN_PAGE.limits.inventoryRecords + 1 }, (_, index) => ({
    record_id: `inv_${index}`, fields: { 编号: ['prod_1'], 尺码: ['size_40'], 所属状态: '门盒' },
  }));
  await assert.rejects(
    () => service({ inventory: many }).lookup({ number: NUMBER, requestId: 'req_11' }),
    (error) => {
      assert.equal(error.scanLimitExceeded, true);
      assert.match(error.message, /可读上限/);
      return true;
    },
  );
});

// ── 小工具 ──────────────────────────────────────────────────────────────────
test('文案与格式：金额整数不补零、占位符替换不留空段、时间按上海 +8', () => {
  assert.equal(formatPrice(399), '¥399');
  assert.equal(formatPrice(399.5), '¥399.50');
  assert.equal(formatPrice(null), SCAN_PAGE.texts.missingValue);
  assert.equal(fillText('库存（共 {total} 双）', { total: 3 }), '库存（共 3 双）');
  // UTC 12:30 → 上海 20:30
  assert.equal(shanghaiDateTimeText(Date.UTC(2026, 9, 8, 12, 30)), '2026-10-08 20:30');
  assert.equal(SCAN_PAGE.route.basePath, '/s');
});
