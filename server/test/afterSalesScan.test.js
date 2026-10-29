// 售后**扫一扫落地页**的读侧（`services/afterSalesScanService.js`）＋ 路由口径的测试。
//
// 验收标准（先写死，再跑）：
//   AC1 只回「这款货品 + 近 N 天 + 已入账 + 还没售后过」的销售明细；
//   AC2 每条候选带她点名要的三个事实：**销售日 / 尺码 / 该单总金额**；
//   AC3 排除了多少条、为什么 —— 如实回给页面（notDelivered / notPosted / outOfWindow / missingSalesDate）；
//   🔴 已退货/已换货/已赔货 **不排除**（她 2026-10-29：「其他状态我没有说呀」）；
//   AC4 「销售日」取明细的「销售日」，缺失才退回主表「录单日」（并如实标来源）；
//   AC5 货品不存在 / 缺参数 → 400（人话）；读库失败 → 502（不吞成成功）；
//   AC6 一条都不裸奔：已知的三种排除原因之外，不产出候选（宁可少，不许拿错行去做售后）。
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { AfterSalesScanService } = require('../src/services/afterSalesScanService');
const { createScanPageCache } = require('../src/services/scanPageCache');
const { createWorkbenchOrderActionsRouter } = require('../src/routes/workbenchOrderActions');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-29T10:00:00+08:00');

const fakeGateway = (overrides = {}) => {
  const records = {
    product: [
      { record_id: 'p1', fields: { 编号: 'XHB8095|全黑|A', 货号: 'XHB8095', 颜色: '全黑' } },
      { record_id: 'p2', fields: { 编号: 'OTHER|米色|B', 货号: 'OTHER', 颜色: '米色' } },
    ],
    salesEntry: [
      { record_id: 'e1', fields: { 销售单号: 'XSD-1', 写入状态: '成功', 录单日: NOW - DAY, 总金额: 300 } },
      { record_id: 'e2', fields: { 销售单号: 'XSD-2', 写入状态: '失败', 录单日: NOW - DAY, 总金额: 200 } },
      { record_id: 'e3', fields: { 销售单号: 'XSD-3', 写入状态: '成功', 录单日: NOW - 40 * DAY, 总金额: 100 } },
    ],
    salesDetail: [
      { record_id: 'd1', fields: { 销售单号: ['e1'], 编号: ['p1'], 尺码: [{ record_ids: ['s41'], text: '41' }], 销售日: NOW - DAY, 履约状态: '已交付', 实收金额: 100 } },
      { record_id: 'd2', fields: { 销售单号: ['e1'], 编号: ['p1'], 尺码: [{ record_ids: ['s42'], text: '42' }], 销售日: NOW - DAY, 履约状态: '未交付', 实收金额: 200 } },
      { record_id: 'd3', fields: { 销售单号: ['e2'], 编号: ['p1'], 尺码: [{ record_ids: ['s41'], text: '41' }], 销售日: NOW - DAY, 履约状态: '已交付', 实收金额: 100 } },
      { record_id: 'd4', fields: { 销售单号: ['e3'], 编号: ['p1'], 尺码: [{ record_ids: ['s41'], text: '41' }], 销售日: NOW - 40 * DAY, 履约状态: '已交付', 实收金额: 100 } },
      { record_id: 'd5', fields: { 销售单号: ['e1'], 编号: ['p1'], 尺码: [{ record_ids: ['s41'], text: '41' }], 销售日: NOW - DAY, 履约状态: '已退货', 实收金额: 100 } },
      { record_id: 'd6', fields: { 销售单号: ['e1'], 编号: ['p2'], 尺码: [{ record_ids: ['s41'], text: '41' }], 销售日: NOW - DAY, 履约状态: '已交付', 实收金额: 100 } },
      // ⭐ 2026-10-29 口径：已换货 **要列**、已赔货 **不列**（各钉一条）
      { record_id: 'd7', fields: { 销售单号: ['e1'], 编号: ['p1'], 尺码: [{ record_ids: ['s42'], text: '42' }], 销售日: NOW - DAY, 履约状态: '已换货', 实收金额: 200 } },
      { record_id: 'd8', fields: { 销售单号: ['e1'], 编号: ['p1'], 尺码: [{ record_ids: ['s42'], text: '42' }], 销售日: NOW - DAY, 履约状态: '已赔货', 实收金额: 200 } },
    ],
    ...overrides,
  };
  const calls = { get: [], listAll: [], getBatch: [] };
  return {
    records,
    calls,
    table(key) {
      const table = {
        product: { fields: { number: '编号', itemNo: '货号', color: '颜色' } },
        salesEntry: { fields: { orderNo: '销售单号', writeStatus: '写入状态', recordedAt: '录单日', totalAmount: '总金额' } },
        salesDetail: { fields: { product: '编号', salesEntry: '销售单号', size: '尺码', soldAt: '销售日', fulfillmentStatus: '履约状态', actualAmount: '实收金额' } },
      }[key];
      if (!table) throw new Error(`Unknown table: ${key}`);
      return table;
    },
    async get(key, id) {
      calls.get.push(`${key}:${id}`);
      return (records[key] || []).find((row) => row.record_id === id) || null;
    },
    async listAll(key) {
      calls.listAll.push(key);
      return records[key] || [];
    },
    // ⭐ 2026-10-29：主表改成**按 id 批量取**（不再整表读）。
    async getBatch(key, ids = []) {
      calls.getBatch.push(`${key}:${ids.length}`);
      return (records[key] || []).filter((row) => ids.includes(row.record_id));
    },
  };
};

const build = (overrides) => new AfterSalesScanService({ gateway: fakeGateway(overrides), now: () => NOW });

test('AC1/AC2 ⭐ 只回这款货品近 7 天已入账的销售明细，并带「销售日 / 尺码 / 总金额」', async () => {
  const out = await build().listCandidates({ productRecordId: 'p1' });
  assert.equal(out.product.item_no, 'XHB8095');
  assert.equal(out.product.color, '全黑');
  assert.equal(out.days, 7);
  // ⭐ 2026-10-29 最终口径：候选 = 排除「未交付 / 已退货 / 已赔货」后的明细
  //   ⇒ d1（已交付）＋ d7（已换货）在列表里；d2 未交付、d5 已退货、d8 已赔货 都不列。
  assert.deepEqual(out.candidates.map((item) => item.sales_detail_record_id), ['d1', 'd7']);
  const statuses = out.candidates.map((item) => item.fulfillment_status);
  assert.deepEqual(statuses, ['已交付', '已换货']);
  for (const excludedId of ['d2', 'd5', 'd8']) {
    assert.ok(!out.candidates.some((item) => item.sales_detail_record_id === excludedId), `${excludedId} 不该出现`);
  }
  const first = out.candidates[0];
  assert.equal(first.order_no, 'XSD-1');
  assert.equal(first.size, 41);
  assert.equal(first.size_record_id, 's41');
  assert.equal(first.total_amount, 300);
  assert.equal(first.sales_date, NOW - DAY);
  assert.equal(first.fulfillment_status, '已交付');
});

/**
 * ⭐⭐ 2026-10-29（业务负责人最终筛选口径）：
 *   列表 = **排除「未交付 / 已退货 / 已赔货」** ⇒ 已交付 和 已换货 在列表里。
 *   三种排除状态**各自如实计数**（配置里加一种状态会自动计数）。
 */
test('AC1b ⭐⭐ 口径：未交付 / 已退货 / 已赔货 不列；已交付 和 已换货 要列', async () => {
  const out = await build().listCandidates({ productRecordId: 'p1' });
  const statuses = out.candidates.map((item) => item.fulfillment_status).sort();
  assert.deepEqual(statuses, ['已交付', '已换货'].sort(), '列表里只有 已交付 和 已换货');
  assert.deepEqual(out.excluded.byFulfillment, { 未交付: 1, 已退货: 1, 已赔货: 1 }, '三种排除各自计数');
});

test('AC3 ⭐ 排除的几类都如实计数：三种履约状态 / 没入账 / 不在时间窗', async () => {
  const out = await build().listCandidates({ productRecordId: 'p1' });
  // d2 未交付 / d5 已退货 / d8 已赔货 ⇒ byFulfillment 三种各 1；
  // d3 主表写入失败 ⇒ notPosted；d4 40 天前 ⇒ outOfWindow。
  assert.deepEqual(out.excluded, {
    byFulfillment: { 未交付: 1, 已退货: 1, 已赔货: 1 },
    notPosted: 1,
    outOfWindow: 1,
    missingSalesDate: 0,
  });
  const ids = out.candidates.map((item) => item.sales_detail_record_id);
  for (const excludedId of ['d2', 'd3', 'd4', 'd5', 'd8']) {
    assert.ok(!ids.includes(excludedId), `${excludedId} 不该出现在候选里`);
  }
});

test('AC4 ⭐⭐ 销售日**只认销售明细的「销售日」**：缺了就不列（绝不拿「录单日」兜底）', async () => {
  const gateway = fakeGateway();
  delete gateway.records.salesDetail.find((row) => row.record_id === 'd1').fields['销售日'];
  const service = new AfterSalesScanService({ gateway, now: () => NOW });
  const out = await service.listCandidates({ productRecordId: 'p1' });
  assert.ok(!out.candidates.some((item) => item.sales_detail_record_id === 'd1'), '没有销售日的行不许出现在候选里');
  assert.equal(out.excluded.missingSalesDate, 1, '缺销售日单独计数（不静默吞）');
  // d1 的主表「录单日」是有的 —— 它**不许**被拿来当销售日（她：「不用你做兜底」）。
  assert.ok(!out.candidates.some((item) => item.sales_date === NOW - DAY && item.sales_detail_record_id === 'd1'));
});

test('AC4c ⭐⭐ 「近 7 天」= 上海自然日（今天 + 往前 6 天，含今天共 7 天），不是滚动 24 小时', async () => {
  const gateway = fakeGateway();
  const detail = (id) => gateway.records.salesDetail.find((row) => row.record_id === id);
  // NOW = 2026-10-29 10:00 (+08) ⇒ 窗口起点 = 2026-10-23 00:00 (+08)
  const start = Date.parse('2026-10-23T00:00:00+08:00');
  detail('d1').fields['销售日'] = start;            // 边界：正好在起点 ⇒ 算近 7 天
  detail('d2').fields['销售日'] = start - 1;        // 起点前 1 毫秒（即 10-22 深夜）⇒ 不算
  const service = new AfterSalesScanService({ gateway, now: () => NOW });
  const out = await service.listCandidates({ productRecordId: 'p1' });
  const ids = out.candidates.map((item) => item.sales_detail_record_id);
  assert.ok(ids.includes('d1'), '2026-10-23 00:00 的销售要算进「近 7 天」');
  assert.ok(!ids.includes('d2'), '2026-10-22 23:59 的销售不算「近 7 天」');
});

test('AC4b 天数参数：认不出的回默认 7，超上限按 30 封顶（不因参数打挂页面）', async () => {
  const gateway = fakeGateway();
  const service = new AfterSalesScanService({ gateway, now: () => NOW });
  assert.equal((await service.listCandidates({ productRecordId: 'p1', days: 'abc' })).days, 7);
  assert.equal((await service.listCandidates({ productRecordId: 'p1', days: '-3' })).days, 7);
  assert.equal((await service.listCandidates({ productRecordId: 'p1', days: '999' })).days, 30);
});

/**
 * ⭐⭐ 2026-10-29（业务负责人：「页面响应速度也能更快一些」／「跨月怎么实现」）：
 *   · 读模型短 TTL 缓存（复用扫码页那一份 `createScanPageCache`）⇒ 同一货品 TTL 内再看一次**零读表**；
 *   · **空结果不缓存**（她刚卖的一双要能立刻看到）；
 *   · 跨月**不需要特殊逻辑**：窗口起点是按上海自然日算出来的时间戳（例：11-02 看近 7 天 ⇒ 起点 10-27 00:00），
 *     `10-27 00:00` 那一笔算、`10-26 23:59` 不算。
 */
test('AC7 ⭐⭐ 缓存：同一货品 TTL 内第二次零读表；空结果不缓存；关掉缓存就真读', async () => {
  const gateway = fakeGateway();
  const cache = createScanPageCache({ ttlMs: 60_000, maxEntries: 10, now: () => NOW });
  const service = new AfterSalesScanService({ gateway, now: () => NOW, cache });

  await service.listCandidates({ productRecordId: 'p1' });
  const first = JSON.parse(JSON.stringify(gateway.calls));
  assert.equal(first.listAll.filter((key) => key === 'salesDetail').length, 1, '第一次：读 1 次销售明细');
  assert.equal(first.getBatch.length, 1, '第一次：主表按 id 批量取 1 次');
  assert.equal(first.get.length, 1, '第一次：货品 1 条');

  const again = await service.listCandidates({ productRecordId: 'p1' });
  const second = JSON.parse(JSON.stringify(gateway.calls));
  assert.deepEqual(second, first, 'TTL 内第二次：一次飞书请求都不打（命中读模型缓存）');
  assert.ok(again.candidates.length > 0);

  // 空结果不缓存：换成一个**一条明细都没有**的货品（p3）⇒ 两次都要真读。
  const emptyGateway = fakeGateway();
  emptyGateway.records.product.push({ record_id: 'p3', fields: { 编号: 'NONE|白|A', 货号: 'NONE', 颜色: '白' } });
  const emptyService = new AfterSalesScanService({
    gateway: emptyGateway, now: () => NOW,
    cache: createScanPageCache({ ttlMs: 60_000, maxEntries: 10, now: () => NOW }),
  });
  await emptyService.listCandidates({ productRecordId: 'p3' });
  await emptyService.listCandidates({ productRecordId: 'p3' });
  assert.equal(emptyGateway.calls.listAll.filter((key) => key === 'salesDetail').length, 2, '空结果不缓存 ⇒ 每次都真读');

  // 关掉缓存（ttl=0）：两次都真读。
  const noCacheGateway = fakeGateway();
  const noCacheService = new AfterSalesScanService({
    gateway: noCacheGateway, now: () => NOW,
    cache: createScanPageCache({ ttlMs: 0, maxEntries: 10, now: () => NOW }),
  });
  await noCacheService.listCandidates({ productRecordId: 'p1' });
  await noCacheService.listCandidates({ productRecordId: 'p1' });
  assert.equal(noCacheGateway.calls.listAll.filter((key) => key === 'salesDetail').length, 2, '关掉缓存 ⇒ 每次都真读');
});

test('AC7b ⭐ 主表不再整表读：只按候选明细的主表 id 批量取（660 行的表只取需要的那几行）', async () => {
  const gateway = fakeGateway();
  const service = new AfterSalesScanService({
    gateway, now: () => NOW, cache: createScanPageCache({ ttlMs: 0 }),
  });
  await service.listCandidates({ productRecordId: 'p1' });
  assert.ok(!gateway.calls.listAll.includes('salesEntry'), '不许再 listAll 销售主表（整表读 660 行）');
  // 先用明细就能判断的条件筛掉（未交付 / 已售后 / 超窗口），只剩 2 张主表要看
  // （e1 = d1 那张、e2 = 写入失败那张）⇒ 只批量取这 2 条，而不是整张表。
  assert.deepEqual(gateway.calls.getBatch, ['salesEntry:2']);
});

test('AC4d ⭐⭐ 跨月不需要特殊逻辑：窗口起点按上海自然日算（11-02 看近 7 天 ⇒ 10-27 00:00）', async () => {
  const gateway = fakeGateway();
  const detail = (id) => gateway.records.salesDetail.find((row) => row.record_id === id);
  const now = Date.parse('2026-11-02T10:00:00+08:00');
  const start = Date.parse('2026-10-27T00:00:00+08:00');
  detail('d1').fields['销售日'] = start;          // 跨月边界：正好起点 ⇒ 算
  detail('d2').fields['销售日'] = start - 1;      // 10-26 23:59 ⇒ 不算
  const service = new AfterSalesScanService({
    gateway, now: () => now, cache: createScanPageCache({ ttlMs: 0 }),
  });
  const out = await service.listCandidates({ productRecordId: 'p1' });
  const ids = out.candidates.map((item) => item.sales_detail_record_id);
  assert.ok(ids.includes('d1'), '10-27 00:00 的销售要算进「近 7 天」');
  assert.ok(!ids.includes('d2'), '10-26 23:59 的销售不算「近 7 天」');
});

test('AC5 缺货品 id / 货品不存在 → 400 人话（页面直接显示原因）', async () => {
  const service = build();
  await assert.rejects(
    () => service.listCandidates({}),
    (error) => error.statusCode === 400 && /重新扫码/.test(error.message),
  );
  await assert.rejects(
    () => service.listCandidates({ productRecordId: 'missing' }),
    (error) => error.statusCode === 400 && /不存在/.test(error.message),
  );
});

test('AC6 读库失败如实抛出（不当成"没有销售记录"）', async () => {
  const gateway = fakeGateway();
  gateway.listAll = async () => { throw new Error('Data not ready'); };
  const service = new AfterSalesScanService({ gateway, now: () => NOW });
  await assert.rejects(() => service.listCandidates({ productRecordId: 'p1' }), /Data not ready/);
});

// ── 路由口径：她那边的问题 400、读库失败 502，原因原样回页面（不许静默）────────
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  // 临时服务器必须关 keep-alive：端口一复用就会偶发 ECONNRESET（见 test/stabilityRepro.cjs）。
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const appWith = (scanService) => {
  const app = express();
  app.use('/api/workbench', (req, res, next) => { req.workbenchUser = { open_id: 'ou_test' }; next(); },
    createWorkbenchOrderActionsRouter({ scanService }));
  return app;
};

test('AC5b 路由：缺参数 → 400（success:false + 人话）；读库失败 → 502', async () => {
  await withServer(appWith(build()), async (base) => {
    const missing = await fetch(`${base}/api/workbench/sales/after-sales/scan-candidates`);
    assert.equal(missing.status, 400);
    const body = await missing.json();
    assert.equal(body.success, false);
    assert.match(body.error, /重新扫码/);

    const ok = await fetch(`${base}/api/workbench/sales/after-sales/scan-candidates?productRecordId=p1`);
    assert.equal(ok.status, 200);
    const data = await ok.json();
    assert.equal(data.success, true);
    assert.equal(data.candidates.length, 2, '已交付 + 已换货 ⇒ 2 条（d1 + d7）');
  });

  const broken = { async listCandidates() { throw new Error('TableIdNotFound'); } };
  await withServer(appWith(broken), async (base) => {
    const response = await fetch(`${base}/api/workbench/sales/after-sales/scan-candidates?productRecordId=p1`);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.match(body.error, /TableIdNotFound/);
  });
});
