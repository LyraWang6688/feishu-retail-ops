/**
 * 货品信息「标签二维码」service 的回归护栏（业务负责人 2026-10-08 定的能力）。
 *
 * 钉住的几件事：
 *   ① **二维码内容 = 规范里的 URL**：域名/路径来自 config，`编号` 做 URL 编码
 *      （中文必须编成 `%E9%BB%91%E8%89%B2` 这种），模板自身的 `https://` `/s/` 不许被编码；
 *   ② **幂等**：这一列已经有值就跳过（不上传、不写库）；只有显式覆盖才重写，且**先记日志再写**；
 *   ③ **写回形状**：`{ tagQrCode: [{ file_token }] }`（附件字段的官方写法），
 *      上传用的是 config 里的 `parent_type` + 文件名模板，真 PNG 字节进了临时文件；
 *   ④ **编号变了才重生成**：事件里 `编号` 列的前后值不同 ⇒ 覆盖；相同 ⇒ 连读表都不读；
 *      事件没带字段值时退回"文件名对不对"，对得上就不写（不盲写）；
 *   ⑤ **失败大声报错 + 可重试**：三步（出图/上传/写回）任何一步失败都
 *      `logError('product.tag_qr.failed')` 并把错误抛出去；同一包里失败不带走别的记录。
 *
 * ⚠️ 全用例**不碰任何真表 / 真飞书接口**：网关是内存替身，出图可注入；
 *    唯一会碰到磁盘的是"生成 PNG 要先落临时文件"这一步（那是 service 的真实形状）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  createTagQrCodeService,
  buildScanUrl,
  buildFileName,
  attachmentsOf,
  findFieldValue,
  generateQrPng,
} = require('../src/services/tagQrCodeService');

const F = V1_BITABLE_SCHEMA.tables.product.fields;
// 事件里 `before_value` / `after_value` 用的是**字段 id**，不是列名。
const NUMBER_FIELD_ID = 'fld_number_test';

// 规范里的那一个例子（brief 逐字给的）。
const NUMBER_SAMPLE = 'YD6693-2|黑色|A';
const URL_SAMPLE = 'https://hm.bamamei.online/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA';

/** 捕获结构化日志（info→log / warn→warn / error→error），保持顺序。 */
const captureLogs = async (run) => {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (l) => lines.push(String(l));
  console.warn = (l) => lines.push(String(l));
  console.error = (l) => lines.push(String(l));
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const eventsOf = (lines) => lines.map((line) => {
  try { return JSON.parse(line).event; } catch { return ''; }
});

/**
 * 内存假网关 —— 记下每一次 get / update / uploadAttachment / listFields。
 * `uploadAttachment` 会**在临时文件还在的时候**把字节数读出来（顺便证明"真出了图"），
 * 并把路径留档，供用例断言"跑完临时目录被清掉了"。
 */
const fakeGateway = ({ records = {}, fieldId = NUMBER_FIELD_ID } = {}) => {
  const calls = { get: [], update: [], uploads: [], listFields: 0 };
  const timeline = [];
  return {
    calls,
    timeline,
    async listFields(tableKey) {
      calls.listFields += 1;
      return [{ field_id: fieldId, field_name: F.number, type: 1 }];
    },
    async get(tableKey, recordId) {
      calls.get.push([tableKey, recordId]);
      const record = records[recordId];
      if (!record) throw new Error(`假网关里没有这条记录：${recordId}`);
      return record;
    },
    async update(tableKey, recordId, values, options) {
      calls.update.push([tableKey, recordId, values, options]);
      timeline.push(`update:${recordId}`);
      return { record_id: recordId };
    },
    async uploadAttachment(filePath, options) {
      calls.uploads.push({
        fileName: path.basename(filePath),
        bytes: fs.readFileSync(filePath).length,
        filePath,
        options,
      });
      timeline.push(`upload:${path.basename(filePath)}`);
      return `file_token_${calls.uploads.length}`;
    },
  };
};

const recordWith = ({ number, tagQrCode }) => ({
  record_id: 'rec',
  fields: {
    ...(number === undefined ? {} : { [F.number]: number }),
    ...(tagQrCode === undefined ? {} : { [F.tagQrCode]: tagQrCode }),
  },
});

const serviceFor = (gateway, overrides = {}) => createTagQrCodeService({
  gateway,
  // 默认注入"不出图"的实现：单测里不必每次都真的编码一张 PNG（真出图那条另有专门用例）。
  generatePng: async (text) => Buffer.from(`png:${text}`),
  ...overrides,
});

// ── 契约：schema 的映射 ───────────────────────────────────────────────────

test('契约：「货品信息」schema 里有 tagQrCode → 「标签二维码」（附件列）', () => {
  assert.equal(F.tagQrCode, '标签二维码', '只加映射，物理列名就是她新建的那一列');
  assert.equal(TAG_QR_CODE.fields.tagQrCode, 'tagQrCode', 'service 用的语义键与 schema 对齐');
  assert.equal(TAG_QR_CODE.fields.number, 'number');
});

// ── ① 二维码内容 = 规范里的 URL ───────────────────────────────────────────

test('① 二维码 URL：hm 域名 + /s/ 路径 + 编号 URL 编码（中文正确编码）', () => {
  assert.equal(buildScanUrl(TAG_QR_CODE.scanUrl.urlTemplate, NUMBER_SAMPLE), URL_SAMPLE);
  // 域名必须是 hm（2026-10-08 从 workbench 切过来的），路径是 /s/
  assert.match(URL_SAMPLE, /^https:\/\/hm\.bamamei\.online\/s\//);
  // 逐段核一遍编码：`|` → %7C，`黑色` → %E9%BB%91%E8%89%B2
  assert.equal(encodeURIComponent(NUMBER_SAMPLE), 'YD6693-2%7C%E9%BB%91%E8%89%B2%7CA');
  // 模板自身的协议与路径**不许**被编码
  assert.equal(buildScanUrl(TAG_QR_CODE.scanUrl.urlTemplate, 'A B').includes('%2F'), false);
  assert.equal(buildScanUrl(TAG_QR_CODE.scanUrl.urlTemplate, 'A B'), 'https://hm.bamamei.online/s/A%20B');
});

test('① 模板里出现不认识的占位符 / 没有 {number} → 当场报错，不静默出空码', () => {
  assert.throws(() => buildScanUrl('https://hm.bamamei.online/s/{nope}', 'A'), /占位符不认识：\{nope\}/);
  assert.throws(() => buildScanUrl('https://hm.bamamei.online/s/', 'A'), /没有 \{number\} 占位符/);
  assert.throws(() => buildScanUrl(TAG_QR_CODE.scanUrl.urlTemplate, '   '), /没有「编号」/);
});

test('① 出的是真 PNG（用仓库已有的 qrcode，不引新依赖）', async () => {
  const png = await generateQrPng(URL_SAMPLE, TAG_QR_CODE.qr);
  assert.ok(Buffer.isBuffer(png), '应当是 Buffer');
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG 魔数');
  assert.ok(png.length > 200 && png.length < 20000, `尺寸合理（实际 ${png.length} 字节）`);
});

test('① 走完一条记录：上传的临时文件里就是那张 PNG，二维码内容 = 规范 URL', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const generated = [];
  const service = serviceFor(gateway, {
    generatePng: async (text, qrConfig) => {
      generated.push([text, qrConfig]);
      return Buffer.from(`png:${text}`);
    },
  });

  const result = await service.syncRecord('rec1', { reason: 'record_added' });

  assert.deepEqual(generated, [[URL_SAMPLE, TAG_QR_CODE.qr]], '出图用的就是规范里的 URL + config 的尺寸/容错');
  assert.equal(result.status, 'written');
  assert.equal(result.scan_url, URL_SAMPLE);
  assert.equal(gateway.calls.uploads.length, 1, '只上传一次');
  const upload = gateway.calls.uploads[0];
  assert.equal(upload.fileName, 'tag-qr-YD6693-2_黑色_A.png', '文件名模板来自 config（非法字符替换掉）');
  assert.equal(upload.bytes, Buffer.byteLength(`png:${URL_SAMPLE}`), '落盘的就是 PNG 字节');
  assert.equal(fs.existsSync(upload.filePath), false, '跑完临时文件已清理');
});

// ── ② 幂等：已经有值就跳过 ────────────────────────────────────────────────

test('② 幂等：这一列已经有值 → 跳过（不上传、不写库）', async () => {
  const gateway = fakeGateway({
    records: { rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'old_token', name: 'x.png' }] }) },
  });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.syncRecord('rec1', { reason: 'record_added' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'already_present');
  });

  assert.deepEqual(gateway.calls.uploads, [], '跳过 = 连素材都不上传');
  assert.deepEqual(gateway.calls.update, [], '跳过 = 不写库');
  assert.ok(eventsOf(lines).includes('product.tag_qr.skipped_existing'), '要留下"跳过了、为什么"的日志');
});

test('② 显式覆盖（编号变更）：先记 overwriting 日志，再写', async () => {
  const gateway = fakeGateway({
    records: { rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'old_token', name: 'x.png' }] }) },
  });
  const service = serviceFor(gateway);
  const order = [];

  const lines = await captureLogs(async () => {
    const result = await service.syncRecord('rec1', { reason: 'number_changed', numberChanged: true });
    order.push(...gateway.timeline);
    assert.equal(result.status, 'written');
  });

  const events = eventsOf(lines);
  const overwritingAt = events.indexOf('product.tag_qr.overwriting');
  assert.ok(overwritingAt >= 0, '覆盖前必须有一条 product.tag_qr.overwriting');
  assert.ok(events.includes('product.tag_qr.written'), '写成功也要有日志');
  assert.deepEqual(order, ['upload:tag-qr-YD6693-2_黑色_A.png', 'update:rec1'], '先上传再写回');
  // 日志顺序：overwriting 出现在 written 之前
  assert.ok(overwritingAt < events.indexOf('product.tag_qr.written'));
});

test('② 幂等：没有「编号」的记录跳过并记 warn（重试也生不出码）', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({}) } });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.syncRecord('rec1', { reason: 'backfill' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'number_missing');
  });

  assert.deepEqual(gateway.calls.uploads, []);
  assert.deepEqual(gateway.calls.update, []);
  assert.ok(eventsOf(lines).includes('product.tag_qr.number_missing'));
});

// ── ③ 写回的调用形状（附件字段 = [{ file_token }]）────────────────────────

test('③ 写回形状：gateway.update(product, id, { tagQrCode: [{ file_token }] })', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  await service.syncRecord('rec1', { reason: 'record_added' });

  assert.deepEqual(gateway.calls.update, [
    ['product', 'rec1', { tagQrCode: [{ file_token: 'file_token_1' }] }, undefined],
  ]);
  // 语义键 → 物理列名由网关负责；这里钉住"我们传的是语义键、值是附件字段的官方形状"
  assert.equal(F.tagQrCode, '标签二维码');
});

test('③ 上传参数来自 config：parent_type = bitable_image、报错文案带上操作名', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  await service.syncRecord('rec1', { reason: 'record_added' });

  assert.deepEqual(gateway.calls.uploads[0].options, {
    parentType: 'bitable_image',
    operation: '上传标签二维码',
  });
  assert.equal(TAG_QR_CODE.upload.parentType, 'bitable_image');
});

// ── ④ 编号变更才重生成；其他字段不变不触发 ────────────────────────────────

test('④ 事件里「编号」前后值不同 ⇒ 覆盖（generate 一次、update 一次）', async () => {
  // ⚠️ 事件是**写完之后**才推来的 ⇒ 表里读到的已经是**新**编号（B），事件里的 before/after
  //    才是"A → B"这一对。service 用的是**读到的当前值**，不是事件里的 after_value。
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({ number: 'YD6693-2|黑色|B', tagQrCode: [{ file_token: 'old_token', name: 'tag-qr-old.png' }] }),
    },
  });
  const generated = [];
  const service = createTagQrCodeService({
    gateway,
    generatePng: async (text) => { generated.push(text); return Buffer.from(`png:${text}`); },
  });

  const result = await service.handleTableChanges([{
    record_id: 'rec1',
    action: 'record_edited',
    before_value: [{ field_id: NUMBER_FIELD_ID, field_value: 'YD6693-2|黑色|A' }],
    after_value: [{ field_id: NUMBER_FIELD_ID, field_value: 'YD6693-2|黑色|B' }],
  }]);

  assert.equal(gateway.calls.uploads.length, 1, '编号变了要重新出码');
  assert.equal(gateway.calls.update.length, 1, '并且覆盖写回');
  assert.equal(generated.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(buildScanUrl(TAG_QR_CODE.scanUrl.urlTemplate, 'YD6693-2|黑色|B'), generated[0]);
});

test('④ 事件里「编号」前后值相同（其他字段变更）⇒ 不触发：连读表都不读', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{
      record_id: 'rec1',
      action: 'record_edited',
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: NUMBER_SAMPLE }],
      after_value: [
        { field_id: NUMBER_FIELD_ID, field_value: NUMBER_SAMPLE },
        { field_id: 'fld_price', field_value: '199' },
      ],
    }]);
    assert.deepEqual(result.results, [{ record_id: 'rec1', status: 'skipped', reason: 'number_unchanged' }]);
  });

  assert.deepEqual(gateway.calls.get, [], '其他字段变了不该读这条记录');
  assert.deepEqual(gateway.calls.uploads, []);
  assert.deepEqual(gateway.calls.update, []);
  assert.ok(eventsOf(lines).includes('product.tag_qr.skipped_number_unchanged'));
});

test('④ 事件里没带「编号」字段值 ⇒ 退回文件名判据：名字对得上就不写', async () => {
  const expectedName = buildFileName(NUMBER_SAMPLE);
  const gateway = fakeGateway({
    records: { rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'f1', name: expectedName }] }) },
  });
  const service = serviceFor(gateway);

  const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_edited' }]);

  assert.deepEqual(result.results, [{
    record_id: 'rec1', status: 'skipped', reason: 'already_present', scan_url: URL_SAMPLE,
  }]);
  assert.deepEqual(gateway.calls.update, []);
  assert.deepEqual(gateway.calls.uploads, []);
});

test('④ 事件里没带「编号」字段值、而现存附件名与当前编号不符 ⇒ 认定过期并覆盖', async () => {
  const gateway = fakeGateway({
    records: { rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'f1', name: 'tag-qr-OLD.png' }] }) },
  });
  const service = serviceFor(gateway);

  const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_edited' }]);

  assert.equal(result.results[0].status, 'written');
  assert.equal(gateway.calls.update.length, 1);
  assert.equal(result.results[0].file_name, buildFileName(NUMBER_SAMPLE));
});

test('④ 新增记录（record_added）⇒ 出码写回；删除/其他动作 ⇒ 什么都不做', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  const result = await service.handleTableChanges([
    { record_id: 'rec1', action: 'record_added' },
    { record_id: 'rec2', action: 'record_deleted' },
    { record_id: 'rec3', action: 'record_removed' },
    { action: 'record_added' }, // 没有 record_id
  ]);

  assert.deepEqual(result.results.map((item) => [item.record_id, item.status]), [['rec1', 'written']]);
  assert.deepEqual(gateway.calls.get, [['product', 'rec1']]);
});

// ── ⑤ 失败要大声报错 + 可重试 ─────────────────────────────────────────────

test('⑤ 出图失败 / 上传失败 / 写回失败：三步各自 logError(product.tag_qr.failed) 并把错误抛出去', async () => {
  const cases = [
    { step: 'generate', overrides: { generatePng: async () => { throw new Error('出图炸了'); } } },
    { step: 'upload', gatewayPatch: (gateway) => { gateway.uploadAttachment = async () => { throw new Error('上传炸了'); }; } },
    { step: 'write_back', gatewayPatch: (gateway) => { gateway.update = async () => { throw new Error('写回炸了'); }; } },
  ];
  for (const item of cases) {
    const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
    if (item.gatewayPatch) item.gatewayPatch(gateway);
    const service = serviceFor(gateway, item.overrides || {});

    const lines = await captureLogs(async () => {
      await assert.rejects(
        () => service.syncRecord('rec1', { reason: 'backfill' }),
        /炸了/,
        `${item.step} 失败必须抛出去（脚本据此计失败数）`,
      );
    });

    const failedLogs = lines
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry?.event === 'product.tag_qr.failed');
    assert.equal(failedLogs.length, 1, `${item.step}：要且只要一条 product.tag_qr.failed`);
    assert.equal(failedLogs[0].step, item.step);
    assert.equal(failedLogs[0].level, 'error');
  }
});

test('⑤ 同一包里一条失败不带走别的记录（失败进 failed 数组 + 汇总日志）', async () => {
  const gateway = fakeGateway({ records: { rec_ok: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([
      { record_id: 'rec_missing', action: 'record_added' }, // 假网关里没有这条 → get 抛错
      { record_id: 'rec_ok', action: 'record_added' },
    ]);
    assert.deepEqual(result.failed.map((item) => item.record_id), ['rec_missing']);
    assert.deepEqual(result.results.map((item) => item.record_id), ['rec_ok']);
    assert.equal(result.results[0].status, 'written', '后面那条照常处理');
  });

  const events = eventsOf(lines);
  assert.ok(events.includes('product.tag_qr.record_failed'), '单条失败要有 error 日志');
  assert.ok(events.includes('product.tag_qr.batch_failed'), '整包总结也要有 error 日志（大声）');
  assert.equal(gateway.calls.update.length, 1);
});

// ── 开关 / 文件名 ─────────────────────────────────────────────────────────

test('开关：config.enabled = false 时一个字都不写（只记一条 disabled）', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = createTagQrCodeService({
    gateway,
    config: { ...TAG_QR_CODE, enabled: false },
    generatePng: async () => Buffer.from('x'),
  });

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_added' }]);
    assert.deepEqual(result, { enabled: false, results: [] });
    const single = await service.syncRecord('rec1', { reason: 'backfill' });
    assert.deepEqual(single, { record_id: 'rec1', status: 'skipped', reason: 'disabled' });
  });

  assert.deepEqual(gateway.calls.get, []);
  assert.deepEqual(gateway.calls.update, []);
  assert.deepEqual(gateway.calls.uploads, []);
  assert.equal(eventsOf(lines).filter((event) => event === 'product.tag_qr.disabled').length, 2);
});

test('文件名模板：来自 config、非法字符替换、超长截断', () => {
  assert.equal(buildFileName('YD6693-2|黑色|A'), 'tag-qr-YD6693-2_黑色_A.png');
  assert.equal(buildFileName('A/B C:D'), 'tag-qr-A_B_C_D.png');
  const long = buildFileName('X'.repeat(400));
  assert.equal(long.length, TAG_QR_CODE.fileName.maxLength);
  assert.ok(long.startsWith('tag-qr-'));
});

test('附件格解析：只认有 file_token 的元素（文本/空值/别的东西都算"没有附件"）', () => {
  assert.deepEqual(attachmentsOf([{ file_token: 'a', name: 'n' }]), [{ file_token: 'a', name: 'n' }]);
  assert.deepEqual(attachmentsOf([{ name: 'x' }, null, 'y']), []);
  assert.deepEqual(attachmentsOf(undefined), []);
  assert.deepEqual(findFieldValue([{ field_id: 'f1', field_value: 'v' }], 'f1'), 'v');
  assert.equal(findFieldValue([{ field_id: 'f1', field_value: 'v' }], 'f2'), undefined);
  assert.equal(findFieldValue(undefined, 'f1'), undefined);
});

test('契约缺失时当场抛（schema 里没有 tagQrCode 映射 ⇒ 不许静默跑）', () => {
  const saved = V1_BITABLE_SCHEMA.tables.product.fields.tagQrCode;
  try {
    delete V1_BITABLE_SCHEMA.tables.product.fields.tagQrCode;
    assert.throws(
      () => createTagQrCodeService({ gateway: fakeGateway({ records: {} }) }),
      /没有 tagQrCode 字段映射/,
    );
  } finally {
    V1_BITABLE_SCHEMA.tables.product.fields.tagQrCode = saved;
  }
});
