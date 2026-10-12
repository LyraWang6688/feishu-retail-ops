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
 *      ⭐ **"判不了"绝不许当成"没变"**（2026-10-09 生产事故，见 ④′ 的回归用例）；
 *   ⑤ **失败大声报错 + 可重试**：三步（出图/上传/写回）任何一步失败都
 *      `logError('product.tag_qr.failed')` 并把错误抛出去；同一包里失败不带走别的记录；
 *   ⑥ **兜底巡检**（2026-10-09 加）：`sweepStaleTagQrCodes` 全表找「文件名 ≠ 当前编号」的，
 *      只重生成那些（有上限、可干跑、有开关）—— 事件那条路判漏时的最后一道网。
 *
 * ⚠️ 全用例**不碰任何真表 / 真飞书接口**：网关是内存替身，出图可注入；
 *    唯一会碰到磁盘的是"生成 PNG 要先落临时文件"这一步（那是 service 的真实形状）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TAG_QR_CODE, resolveTagQrRecheckConfig } = require('../src/config/tagQrCode');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  createTagQrCodeService,
  buildScanUrl,
  buildFileName,
  numberFromFileName,
  attachmentsOf,
  findFieldValue,
  readableFieldText,
  generateQrPng,
} = require('../src/services/tagQrCodeService');

const F = V1_BITABLE_SCHEMA.tables.product.fields;
// 事件里 `before_value` / `after_value` 用的是**字段 id**，不是列名。
const NUMBER_FIELD_ID = 'fld_number_test';

// 规范里的那一个例子（brief 逐字给的）。
const NUMBER_SAMPLE = 'YD6693-2|黑色|A';
const URL_SAMPLE = 'https://hm.bamamei.online/r/rec1';

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
const SOURCE_FIELD_IDS = Object.freeze({ itemNo: 'fld_item_no', color: 'fld_color', category: 'fld_category' });
const fakeGateway = ({ records = {}, fieldId = NUMBER_FIELD_ID, sourceIds = SOURCE_FIELD_IDS } = {}) => {
  const calls = { get: [], update: [], uploads: [], listFields: 0, listAll: 0 };
  const timeline = [];
  return {
    calls,
    timeline,
    async listFields(tableKey) {
      calls.listFields += 1;
      return [
        { field_id: fieldId, field_name: F.number, type: 20 },
        { field_id: sourceIds.itemNo, field_name: F.itemNo, type: 1 },
        { field_id: sourceIds.color, field_name: F.color, type: 18 },
        { field_id: sourceIds.category, field_name: F.category, type: 3 },
      ];
    },
    // 整表读（**只读**）：巡调用。返回形状与 `V1BitableGateway.listAll` 一致（`{record_id, fields}`）。
    async listAll(tableKey) {
      calls.listAll += 1;
      return Object.entries(records).map(([recordId, record]) => ({ ...record, record_id: recordId }));
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

const recordWith = ({ number, tagQrCode, itemNo, color, category, ...rest }) => ({
  record_id: 'rec',
  fields: {
    ...(number === undefined ? {} : { [F.number]: number }),
    ...(tagQrCode === undefined ? {} : { [F.tagQrCode]: tagQrCode }),
    // ⭐ 2026-10-12：源字段（判据改成"看货号/颜色/类别"之后，夹具要能造它们）
    ...(itemNo === undefined ? {} : { [F.itemNo]: itemNo }),
    ...(color === undefined ? {} : { [F.color]: color }),
    ...(category === undefined ? {} : { [F.category]: category }),
    ...rest,
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
  assert.equal(upload.fileName, 'tag-qr-rec1.png', '文件名模板来自 config（非法字符替换掉）');
  assert.equal(upload.bytes, Buffer.byteLength(`png:${URL_SAMPLE}`), '落盘的就是 PNG 字节');
  assert.equal(fs.existsSync(upload.filePath), false, '跑完临时文件已清理');
});

// ── ② 幂等：已经有值就跳过 ────────────────────────────────────────────────

test('② 幂等：这一列**已经有值且与当前编号一致** → 跳过（不上传、不写库）', async () => {
  // ⚠️ 2026-10-12 改断言（**"真的同步过就不重复写"这条本意没变**）：
  //   改前：fixture 的附件名是随便写的 `x.png`，只要"有值"就断言跳过。
  //   改后：判据是"**附件名/反解出的编号 == 当前编号**才叫已同步"（真机 832-372-6H 那种旧名
  //         必须重写）⇒ fixture 换成**规范名**，才是在验"幂等"这件事。
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'old_token', name: buildFileName('rec1') }] }),
    },
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
  // ⭐ 顺带钉住：随便一个名字（旧码）**不再**算"已同步"
  const staleGateway = fakeGateway({
    records: { rec2: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'x', name: 'x.png' }] }) },
  });
  const staleResult = await serviceFor(staleGateway).syncRecord('rec2', { reason: 'record_added' });
  assert.equal(staleResult.status, 'written', '名字与当前编号对不上 ⇒ 那是旧码，必须重写');
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
  assert.deepEqual(order, ['upload:tag-qr-rec1.png', 'update:rec1'], '先上传再写回');
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

test('④ 事件里「编号」前后值相同（其他字段变更）⇒ 不写；但**要读一次**核附件（2026-10-12 改）', async () => {
  // ⚠️ 2026-10-12 改断言（"读一次"这一步**正是**修复本身）：
  //   改前：`assert.deepEqual(gateway.calls.get, [])`（"其他字段变了不该读这条记录"）——
  //         于是"附件早就是旧码、之后只改别的字段"这条路**永远**发现不了（生产 292 次跳过 / 0 次写回）。
  //   改后：**必须读一次**记录、拿规范文件名 / 反解出的编号核附件 ⇒ 核得上才 `skipped_number_unchanged`。
  //   代价：每次更新多一次**只读**（事件量很小）；换来"不会静默停在旧码上"。
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'f1', name: buildFileName('rec1') }] }),
    },
  });
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
    assert.deepEqual(result.results, [{
      record_id: 'rec1', status: 'skipped', reason: 'number_unchanged', scan_url: URL_SAMPLE,
    }]);
  });

  assert.deepEqual(gateway.calls.get, [['product', 'rec1']], '要读一次记录来核附件名（这是修复本身）');
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

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_edited' }]);
    // ⭐ 判不了 ⇒ 读一次记录、比文件名；比完**一致** ⇒ 结论就是"编号没变"
    //   （与快路径同一个事件名 `skipped_number_unchanged`，`verified_by: 'file_name'` 说明来路）。
    assert.deepEqual(result.results, [{
      record_id: 'rec1', status: 'skipped', reason: 'number_unchanged', scan_url: URL_SAMPLE,
    }]);
  });

  assert.ok(eventsOf(lines).includes('product.tag_qr.skipped_number_unchanged'));
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
  assert.equal(result.results[0].file_name, buildFileName('rec1'));
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

test('④ 快路径的**边界**（2026-10-12 改）：编号两边相同、但附件名是**旧码** ⇒ 必须修，不许跳过', async () => {
  // ⚠️ 2026-10-12 改断言（**"编号没变就不该乱写她的表"这条本意没变**）：
  //   改前：这条用例故意把附件名放成过期的，并断言"**仍然不该管它**"（`calls.get === []`）。
  //   改后：恰恰相反 —— 附件名与当前编号不符 ⇒ **就是**"这一列的码是旧的"这个事实，必须重写
  //         （真机那 5 条 QPL 就是这么漏的）。真的同步过（名字 = 规范名）时仍然跳过：
  //         见上一条用例与 AC-QR-STALE-3。
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({ number: NUMBER_SAMPLE, tagQrCode: [{ file_token: 'f1', name: 'tag-qr-过期的旧名字.png' }] }),
    },
  });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{
      record_id: 'rec1',
      action: 'record_edited',
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: NUMBER_SAMPLE }],
      after_value: [{ field_id: NUMBER_FIELD_ID, field_value: NUMBER_SAMPLE }],
    }]);
    assert.equal(result.results[0].status, 'written', '旧码必须被修');
  });

  assert.deepEqual(gateway.calls.get, [['product', 'rec1']], '要读一次记录核附件');
  assert.equal(gateway.calls.uploads.length, 1, '要重新出码上传');
  assert.equal(gateway.calls.update.length, 1, '要覆盖写回');
  assert.ok(eventsOf(lines).includes('product.tag_qr.overwriting'), '覆盖前先留证据');
});

// ── ④′ 回归（2026-10-09 生产事故）：判不了 ⇒ 退化成文件名比对；**绝不许当成"没变"** ──────────
//
// 现场：她在「货品信息」把颜色 `黑` 改成 `黑色` ⇒ 编号 `3357|黑|B` → `3357|黑色|B`，
// 附件还叫 `tag-qr-3357_黑_B.png`（**过期**），日志却是 `skipped_number_unchanged`。
// 根因：「编号」是**公式列**，事件里的 `field_value` 不是普通字符串 ——
// 旧实现 `String(before ?? '') !== String(after ?? '')` 两边都变成同一个串 ⇒ 判成"没变"。

test('④′ 回归 A：事件里是**富文本数组**（公式列形态）⇒ 按文本比较，不同就必须重生成', async () => {
  // 旧代码在这里 `String([{…}])` 两边都是 `'[object Object]'` ⇒ 漏判。
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        number: '3357|黑色|B',
        tagQrCode: [{ file_token: 'old', name: 'tag-qr-3357_黑_B.png' }],
      }),
    },
  });
  const service = serviceFor(gateway);

  const result = await service.handleTableChanges([{
    record_id: 'rec1',
    action: 'record_edited',
    before_value: [{ field_id: NUMBER_FIELD_ID, field_value: [{ type: 'text', text: '3357|黑|B' }] }],
    after_value: [{ field_id: NUMBER_FIELD_ID, field_value: [{ type: 'text', text: '3357|黑色|B' }] }],
  }]);

  assert.equal(result.results[0].status, 'written', '前后值读出来的文本不同 ⇒ 编号变了 ⇒ 重生成');
  assert.equal(result.results[0].reason, 'number_changed');
  assert.equal(gateway.calls.uploads.length, 1);
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-rec1.png');
  // 富文本数组**读得出**文本 ⇒ 走的是"比较"那一档，不是"判不了"那一档。
  assert.equal(gateway.calls.update.length, 1);
});

test('④′ 回归 B：事件里「编号」的值**读不出可比文本** ⇒ 退化成文件名比对', async () => {
  const unknownShapes = [
    { label: '两边都是 null', before: null, after: null, why: 'value_not_readable' },
    { label: '两边都是空串', before: '', after: '', why: 'value_empty' },
    { label: '字段是对象（没有 text）', before: { foo: 1 }, after: { foo: 2 }, why: 'value_not_readable' },
    { label: '富文本段里没有 text', before: [{ type: 'text' }], after: [{ type: 'text' }], why: 'value_not_readable' },
    { label: '整条 after_value 缺失', before: '3357|黑色|B', after: undefined, why: 'value_not_readable' },
  ];

  for (const shape of unknownShapes) {
    // B-1：文件名**过期** ⇒ 必须重生成（这就是本次生产 bug 的场景）。
    const staleGateway = fakeGateway({
      records: {
        rec1: recordWith({
          number: '3357|黑色|B',
          tagQrCode: [{ file_token: 'old', name: 'tag-qr-3357_黑_B.png' }],
        }),
      },
    });
    const staleService = serviceFor(staleGateway);
    const lines = await captureLogs(async () => {
      const result = await staleService.handleTableChanges([{
        record_id: 'rec1',
        action: 'record_edited',
        before_value: shape.before === undefined ? undefined : [{ field_id: NUMBER_FIELD_ID, field_value: shape.before }],
        after_value: shape.after === undefined ? undefined : [{ field_id: NUMBER_FIELD_ID, field_value: shape.after }],
      }]);
      assert.equal(result.results[0].status, 'written', `${shape.label}：判不了 + 文件名过期 ⇒ 必须重生成`);
      assert.equal(result.results[0].reason, 'number_changed', `${shape.label}：原因如实记 number_changed`);
      assert.deepEqual(staleGateway.calls.get, [['product', 'rec1']], `${shape.label}：要读一次记录`);
    });
    assert.equal(staleGateway.calls.uploads[0].fileName, 'tag-qr-rec1.png', `${shape.label}：新名按当前编号算`);
    assert.ok(
      eventsOf(lines).includes('product.tag_qr.number_change_unknown'),
      `${shape.label}：要留一条"判不了"的日志（含原始值，便于排查）`,
    );

    // B-2：文件名**对得上** ⇒ 跳过（"判不了"退化成比对之后，结论是"不用动"）。
    const okGateway = fakeGateway({
      records: {
        rec1: recordWith({
          number: '3357|黑色|B',
          tagQrCode: [{ file_token: 'f1', name: 'tag-qr-rec1.png' }],
        }),
      },
    });
    const okService = serviceFor(okGateway);
    const result = await okService.handleTableChanges([{
      record_id: 'rec1',
      action: 'record_edited',
      before_value: shape.before === undefined ? undefined : [{ field_id: NUMBER_FIELD_ID, field_value: shape.before }],
      after_value: shape.after === undefined ? undefined : [{ field_id: NUMBER_FIELD_ID, field_value: shape.after }],
    }]);
    assert.equal(result.results[0].status, 'skipped', `${shape.label}：文件名一致 ⇒ 跳过`);
    assert.equal(result.results[0].reason, 'number_unchanged', `${shape.label}：一致 ⇒ reason = number_unchanged`);
    assert.deepEqual(okGateway.calls.update, [], `${shape.label}：一致就一个字都不写`);
  }
});

test('④′ 「判不了」的日志里带**原始前后值**（这类漏判唯一的现场证据）', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    await service.handleTableChanges([{
      record_id: 'rec1',
      action: 'record_edited',
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: null }],
      after_value: [{ field_id: NUMBER_FIELD_ID, field_value: [{ type: 'text', text: NUMBER_SAMPLE }] }],
    }]);
  });

  const entry = lines.map((line) => JSON.parse(line))
    .find((item) => item.event === 'product.tag_qr.number_change_unknown');
  assert.ok(entry, '要有 product.tag_qr.number_change_unknown');
  assert.equal(entry.record_id, 'rec1');
  assert.equal(entry.action, 'record_edited');
  assert.equal(entry.why, 'value_not_readable');
  assert.equal(entry.before_value, 'null');
  assert.equal(entry.after_value, '[{"type":"text","text":"YD6693-2|黑色|A"}]');
});

test('④′ 没有附件（record_edited 且事件判不了）⇒ 按"要补"处理：直接生成', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);

  const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_edited' }]);

  assert.equal(result.results[0].status, 'written');
  assert.equal(result.results[0].file_name, buildFileName('rec1'));
  assert.equal(gateway.calls.uploads.length, 1);
  assert.equal(gateway.calls.update.length, 1);
});

test('④′ 多附件里**有一个**名字对得上 ⇒ 跳过（不去动她表里已有的东西）', async () => {
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        number: NUMBER_SAMPLE,
        tagQrCode: [
          { file_token: 'f1', name: 'tag-qr-别的编号.png' },
          { file_token: 'f2', name: buildFileName('rec1') },
        ],
      }),
    },
  });
  const service = serviceFor(gateway);

  const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_edited' }]);

  assert.equal(result.results[0].status, 'skipped');
  assert.equal(result.results[0].reason, 'number_unchanged', '比完文件名一致 ⇒ 记成"编号没变"');
  assert.deepEqual(gateway.calls.update, []);
  assert.deepEqual(gateway.calls.uploads, []);
});

test('④′ resolveNumberChange：只有"两边可读且相同"才是 false，其余一律 null（绝不当成没变）', async () => {
  const gateway = fakeGateway({ records: { rec1: recordWith({ number: NUMBER_SAMPLE }) } });
  const service = serviceFor(gateway);
  const at = (before, after) => ({
    record_id: 'rec1',
    action: 'record_edited',
    before_value: before === undefined ? undefined : [{ field_id: NUMBER_FIELD_ID, field_value: before }],
    after_value: after === undefined ? undefined : [{ field_id: NUMBER_FIELD_ID, field_value: after }],
  });

  assert.equal(await service.resolveNumberChange(at('A', 'A')), false, '可读且相同 ⇒ false');
  assert.equal(await service.resolveNumberChange(at('A', 'B')), true, '可读且不同 ⇒ true');
  assert.equal(await service.resolveNumberChange(at(null, null)), null, 'null ⇒ 判不了');
  assert.equal(await service.resolveNumberChange(at('', '')), null, '空串 ⇒ 判不了');
  assert.equal(await service.resolveNumberChange(at('A', undefined)), null, '缺一侧 ⇒ 判不了');
  assert.equal(await service.resolveNumberChange(at(undefined, undefined)), null, '两边都缺 ⇒ 判不了');
  assert.equal(await service.resolveNumberChange(at([{ text: 'A' }], [{ text: 'B' }])), true, '富文本数组按文本比');
  assert.equal(await service.resolveNumberChange(at([{ text: 'A' }], [{ text: 'A' }])), false);
  assert.equal(await service.resolveNumberChange(at([{ type: 'text' }], [{ type: 'text' }])), null, '读不出 ⇒ null');
});

test('④′ readableFieldText：读不出就是 null（不拿空串冒充"没有值"）', () => {
  assert.equal(readableFieldText('x'), 'x');
  assert.equal(readableFieldText(0), '0');
  assert.equal(readableFieldText(''), '');
  assert.equal(readableFieldText(null), null);
  assert.equal(readableFieldText(undefined), null);
  assert.equal(readableFieldText({ text: 'x' }), 'x');
  assert.equal(readableFieldText([{ text: 'a' }, { text: 'b' }]), 'a,b');
  assert.equal(readableFieldText([{}]), null);
  assert.equal(readableFieldText([{ text: 'a' }, null]), null, '任一段读不出就整条判"读不出"');
  assert.equal(readableFieldText(true), 'true');
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
  assert.equal(buildFileName('YD6693-2|黑色|A'), 'tag-qr-rec1.png');
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

// ── ⑥ 兜底巡检（sweepStaleTagQrCodes）：只看"当前事实" ────────────────────────
//
// 2026-10-09 加的兜底：事件那条路万一判漏（真漏了一次），巡检要能全表找回来。
// 判据只有一条：**现有附件文件名 ≠ 当前编号应有的文件名**（同一个 `buildFileName`）。

test('⑥ 巡检：只挑「文件名 ≠ 当前编号」的重生成，其余一条都不动', async () => {
  const gateway = fakeGateway({
    records: {
      rec_ok1: recordWith({ number: 'A|黑|B', tagQrCode: [{ file_token: 'f1', name: buildFileName('A|黑|B') }] }),
      rec_ok2: recordWith({
        number: 'C|黑|B',
        tagQrCode: [
          { file_token: 'f2', name: 'tag-qr-别的编号.png' },
          { file_token: 'f3', name: buildFileName('C|黑|B') },
        ],
      }),
      rec_stale: recordWith({ number: '3357|黑色|B', tagQrCode: [{ file_token: 'f4', name: 'tag-qr-3357_黑_B.png' }] }),
      rec_missing: recordWith({ number: 'D|黑色|A' }), // 一个附件都没有 ⇒ 要补
      rec_nonumber: recordWith({ tagQrCode: [{ file_token: 'f5', name: 'x.png' }] }),
    },
  });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const summary = await service.sweepStaleTagQrCodes({ intervalMs: 0 });
    assert.equal(summary.enabled, true);
    assert.equal(summary.dry_run, false);
    assert.equal(summary.scanned, 5);
    assert.equal(summary.consistent, 2, '名字对得上的两条不动');
    assert.equal(summary.number_missing, 1, '没有编号的跳过');
    assert.equal(summary.candidates, 2, '过期 1 条 + 缺附件 1 条');
    assert.equal(summary.written, 2);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(summary.failed, []);
  });

  assert.deepEqual(gateway.calls.get.map((call) => call[1]).sort(), ['rec_missing', 'rec_stale'], '只读要修的那两条');
  assert.deepEqual(gateway.calls.update.map((call) => call[1]).sort(), ['rec_missing', 'rec_stale']);
  assert.deepEqual(
    gateway.calls.uploads.map((upload) => upload.fileName).sort(),
    [buildFileName('D|黑色|A'), buildFileName('3357|黑色|B')].sort(),
  );
  const events = eventsOf(lines);
  assert.ok(events.includes('product.tag_qr.sweep_done'), '跑完要有汇总日志');
  assert.ok(events.includes('product.tag_qr.overwriting'), '覆盖前先留证据（沿用 service 既有口径）');
});

test('⑥ 巡检 dry-run：只报告要修哪些，一个字都不写', async () => {
  const gateway = fakeGateway({
    records: {
      rec_stale: recordWith({ number: '3357|黑色|B', tagQrCode: [{ file_token: 'f4', name: 'tag-qr-3357_黑_B.png' }] }),
    },
  });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const summary = await service.sweepStaleTagQrCodes({ dryRun: true, intervalMs: 0 });
    assert.equal(summary.dry_run, true);
    assert.equal(summary.candidates, 1);
    assert.equal(summary.planned, 1);
    assert.equal(summary.written, 0);
    assert.deepEqual(summary.results, [{
      record_id: 'rec_stale',
      number: '3357|黑色|B',
      expected_file_name: 'tag-qr-rec1.png',
      existing_file_names: ['tag-qr-3357_黑_B.png'],
      kind: 'stale',
      status: 'dry_run',
    }]);
  });

  assert.deepEqual(gateway.calls.get, [], '干跑连记录都不读');
  assert.deepEqual(gateway.calls.update, []);
  assert.deepEqual(gateway.calls.uploads, []);
  assert.ok(eventsOf(lines).includes('product.tag_qr.sweep_dry_run'));
});

test('⑥ 巡检上限（options.limit 覆盖 config.sweep.limit）：超出的留到下次，不一次打满频控', async () => {
  const records = {};
  for (let index = 0; index < 3; index += 1) {
    records[`rec_stale_${index}`] = recordWith({ number: `X${index}|黑|B` }); // 都没有附件 ⇒ 都要补
  }

  const gateway = fakeGateway({ records });
  const service = serviceFor(gateway);
  const summary = await service.sweepStaleTagQrCodes({ limit: 1, intervalMs: 0 });
  assert.equal(summary.candidates, 3);
  assert.equal(summary.planned, 1, '--limit 之外的不动');
  assert.equal(summary.written, 1);
  assert.equal(gateway.calls.update.length, 1);

  const configGateway = fakeGateway({ records });
  const configService = serviceFor(configGateway, {
    config: { ...TAG_QR_CODE, sweep: { ...TAG_QR_CODE.sweep, limit: 2 } },
  });
  const fromConfig = await configService.sweepStaleTagQrCodes({ intervalMs: 0 });
  assert.equal(fromConfig.planned, 2, 'config.sweep.limit 同样生效');
  assert.equal(fromConfig.written, 2);
});

test('⑥ 巡检开关：config.sweep.enabled = false ⇒ 一个字都不写、连表都不读', async () => {
  const gateway = fakeGateway({ records: { rec_stale: recordWith({ number: 'X|黑|B' }) } });
  const service = serviceFor(gateway, {
    config: { ...TAG_QR_CODE, sweep: { ...TAG_QR_CODE.sweep, enabled: false } },
  });

  const lines = await captureLogs(async () => {
    const summary = await service.sweepStaleTagQrCodes({ intervalMs: 0 });
    assert.deepEqual(summary, { enabled: false, dry_run: true, results: [] });
  });

  assert.equal(gateway.calls.listAll, 0, '开关关掉 ⇒ 不做整表读');
  assert.deepEqual(gateway.calls.update, []);
  assert.ok(eventsOf(lines).includes('product.tag_qr.sweep_disabled'));
});

test('⑥ 巡检：整条链路关掉（config.enabled = false）⇒ 连表都不读', async () => {
  const gateway = fakeGateway({ records: { rec_stale: recordWith({ number: 'X|黑|B' }) } });
  const service = serviceFor(gateway, { config: { ...TAG_QR_CODE, enabled: false } });

  const lines = await captureLogs(async () => {
    const summary = await service.sweepStaleTagQrCodes({ intervalMs: 0 });
    assert.deepEqual(summary, { enabled: false, dry_run: true, results: [] });
  });

  assert.equal(gateway.calls.listAll, 0);
  assert.ok(eventsOf(lines).includes('product.tag_qr.disabled'));
});

test('⑥ 巡检：单条失败不带走别的（失败进 failed + 汇总 error 日志）', async () => {
  const gateway = fakeGateway({
    records: {
      rec_stale_1: recordWith({ number: 'X|黑|B' }),
      rec_stale_2: recordWith({ number: 'Y|黑|B' }),
    },
  });
  gateway.uploadAttachment = async () => { throw new Error('上传炸了'); };
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const summary = await service.sweepStaleTagQrCodes({ intervalMs: 0 });
    assert.equal(summary.written, 0);
    assert.deepEqual(summary.failed.map((item) => item.record_id), ['rec_stale_1', 'rec_stale_2']);
  });

  assert.ok(eventsOf(lines).includes('product.tag_qr.sweep_failed'), '整轮失败要有一条汇总 error');
});

test('⑥ 巡检：config.sweep 的默认值（开关开、不限量、500ms 间隔、非干跑）', () => {
  assert.deepEqual(TAG_QR_CODE.sweep, { enabled: true, limit: 0, intervalMs: 500, dryRun: false });
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 业务负责人真机发现】改货号后**二维码没更新**（生产 292 次跳过 / 0 次写回）
//   只读干跑证据（5 条记录，附件名里都还带着旧前缀 `QPL`）：
//     rec28e1FtwQIPX 当前编号 2635-1|黑|A  ←  附件名 tag-qr-QPL2635-1_黑_A.png
//     rec28e1chI0MiM 当前编号 8809|黑|A    ←  附件名 tag-qr-QPL8809_黑_A.png
//   ⇒ 二维码停在旧编号上；日志却是 `product.tag_qr.skipped_number_unchanged`。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-QR-STALE-1 ⭐⭐ 真机形状：事件说"编号没变"、但附件名是**旧编号** ⇒ 必须重写（不许 skipped_number_unchanged）', async () => {
  const current = '2635-1|黑|A';
  const gateway = fakeGateway({
    records: {
      rec28e1FtwQIPX: recordWith({
        number: current,
        tagQrCode: [{ file_token: 'old1', name: 'tag-qr-QPL2635-1_黑_A.png' }],
      }),
    },
  });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{
      record_id: 'rec28e1FtwQIPX',
      action: 'record_edited',
      // ⚠️ 事件里这一列**前后值相同**（她这次改的是别的字段）——
      //    改前：这一档走"快路径"，**连表都不读** ⇒ 永远看不见附件名是旧的。
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: current }],
      after_value: [
        { field_id: NUMBER_FIELD_ID, field_value: current },
        { field_id: 'fld_price', field_value: '269' },
      ],
    }]);
    const first = result.results[0];
    assert.notEqual(first.reason, 'number_unchanged',
      `附件名与当前编号不符 ⇒ 不许判"没变"（实际 ${JSON.stringify(first)}）`);
    assert.equal(first.status, 'written', '必须重写这一列的二维码');
  });

  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-2635-1_黑_A.png', '上传的文件名按当前编号算');
  assert.equal(gateway.calls.update.length, 1, '要覆盖写回');
  assert.ok(eventsOf(lines).includes('product.tag_qr.overwriting'), '覆盖前先留证据');
});

test('AC-QR-STALE-1b ⭐⭐ 逐字复现 Lead 那条日志：QPL8809 ⇒ 必须 stale_by_file_name: true，覆盖日志带新旧名', async () => {
  // Lead 2026-10-12 拿到的真写日志里每条都写着：
  //   existing_file_names: ["tag-qr-QPL8809_黑_A.png"] / expected_file_name: "tag-qr-8809_黑_A.png"
  //   stale_by_file_name: **false**  ← 但那次是**回填脚本 + `--overwrite`**（`numberChanged: true`），
  //   而改前的公式要求 `numberChanged === null` ⇒ 那一档必然是 false（它只是"有没有靠文件名判出过期"）。
  //   ⇒ 真正该 false 的地方是**事件路径**：本用例钉住"事件路径 + 旧码"必须判过期。
  const current = '8809|黑|A';
  const gateway = fakeGateway({
    records: {
      rec28e1chI0MiM: recordWith({
        number: current,
        tagQrCode: [{ file_token: 'f8809', name: 'tag-qr-QPL8809_黑_A.png' }],
      }),
    },
  });
  const service = serviceFor(gateway);

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{
      record_id: 'rec28e1chI0MiM',
      action: 'record_edited',
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: current }],
      after_value: [{ field_id: NUMBER_FIELD_ID, field_value: current }],
    }]);
    assert.equal(result.results[0].status, 'written');
  });

  const overwriting = lines.map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).find((entry) => entry?.event === 'product.tag_qr.overwriting');
  assert.ok(overwriting, '覆盖前必须先记 product.tag_qr.overwriting（先留证据）');
  assert.deepEqual(overwriting.existing_file_names, ['tag-qr-QPL8809_黑_A.png']);
  assert.equal(overwriting.expected_file_name, 'tag-qr-8809_黑_A.png');
  assert.equal(overwriting.stale_by_file_name, true, '⚠️ 判据必须判出过期（QPL8809 ≠ 8809）');
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-8809_黑_A.png');
});

test('AC-QR-STALE-2 ⭐ "文件名里含有当前编号"**不够**：QPL 那条也**含有** 2635-1_黑_A ⇒ 判据必须是"规范名/反解编号"', () => {
  const current = '2635-1|黑|A';
  const expected = buildFileName(current);
  const old = 'tag-qr-QPL2635-1_黑_A.png';
  // 反例（必须钉住，防止以后有人把判据退化成 `includes`）：
  assert.equal(old.includes('2635-1_黑_A'), true,
    '旧名**确实包含**当前编号的片段 —— 所以"contains"这种判据会把它当成已经同步 ❌');
  assert.equal(old === expected, false, '但它与规范文件名不一致 ⇒ 必须判为过期');
  assert.equal(buildFileName(current), 'tag-qr-2635-1_黑_A.png');
  // ⭐ 语义判据：从名字里**反解出编号**再比 —— 这才是"以编号为准"
  assert.equal(numberFromFileName(old), 'QPL2635-1_黑_A', '反解出的是旧编号 ⇒ 过期');
  assert.equal(numberFromFileName(expected), '2635-1_黑_A', '规范名反解出的是当前编号 ⇒ 已同步');
  assert.equal(numberFromFileName('别人的.png'), null, '模板对不上 ⇒ 判为过期（宁严不松）');
});

test('AC-QR-STALE-3 ⭐ 名字与规范一致 ⇒ 仍然跳过（幂等不能被这次修复搞坏：不许每次事件都重传）', async () => {
  const current = '2635-1|黑|A';
  const gateway = fakeGateway({
    records: {
      rec_ok: recordWith({ number: current, tagQrCode: [{ file_token: 'ok1', name: buildFileName(current) }] }),
    },
  });
  const service = serviceFor(gateway);
  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{
      record_id: 'rec_ok',
      action: 'record_edited',
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: current }],
      after_value: [{ field_id: NUMBER_FIELD_ID, field_value: current }],
    }]);
    assert.equal(result.results[0].status, 'skipped');
    assert.equal(result.results[0].reason, 'number_unchanged');
  });
  assert.deepEqual(gateway.calls.uploads, [], '已经同步的不许重传');
  assert.deepEqual(gateway.calls.update, []);
  assert.ok(eventsOf(lines).includes('product.tag_qr.skipped_number_unchanged'));
});

test('AC-QR-STALE-4 ⭐ 附件是**别人的码**（名字完全不相干）⇒ 也要重写；没有附件 ⇒ 照常生成', async () => {
  const gateway = fakeGateway({
    records: {
      rec_other: recordWith({ number: '2635-1|黑|A', tagQrCode: [{ file_token: 'x', name: 'tag-qr-9999_白_A.png' }] }),
      rec_none: recordWith({ number: '2635-1|黑|A' }),
    },
  });
  const service = serviceFor(gateway);
  const changed = [{ field_id: NUMBER_FIELD_ID, field_value: '2635-1|黑|A' }];
  const result = await service.handleTableChanges([
    { record_id: 'rec_other', action: 'record_edited', before_value: changed, after_value: changed },
    { record_id: 'rec_none', action: 'record_edited', before_value: changed, after_value: changed },
  ]);
  assert.deepEqual(result.results.map((item) => item.status), ['written', 'written']);
  assert.deepEqual(gateway.calls.update.map((call) => call[1]).sort(), ['rec_none', 'rec_other']);
});

test('AC-QR-STALE-5 ⭐ 公式列读不出（事件里只有富文本数组 / 根本没带这一列）⇒ 落到第②层按编号判，不许静默跳过', async () => {
  // 真机形状：编号是**公式列**，事件里可能是 `[{text:…}]`（富文本数组）、也可能整列没被推过来。
  for (const [label, event] of [
    ['富文本数组', {
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: [{ text: '3357|黑|B' }] }],
      after_value: [{ field_id: NUMBER_FIELD_ID, field_value: [{ text: '3357|黑色|B' }] }],
    }],
    ['整列没带', { before_value: [], after_value: [{ field_id: 'fld_price', field_value: '199' }] }],
  ]) {
    const gateway = fakeGateway({
      records: {
        rec1: recordWith({ number: '3357|黑色|B', tagQrCode: [{ file_token: 'o', name: 'tag-qr-3357_黑_B.png' }] }),
      },
    });
    const service = serviceFor(gateway);
    const result = await service.handleTableChanges([{ record_id: 'rec1', action: 'record_edited', ...event }]);
    assert.equal(result.results[0].status, 'written', `${label}：判不了 ⇒ 必须落到第②层，且按当前编号判出旧码`);
    assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-rec1.png', `${label}：按当前编号出新名`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 真机第二轮】她 12:13 改货号 `832-372-6` ⇒ 二维码没更新
//   ① 写入路径（脚本 --write **不带** --overwrite / syncRecord 不带 numberChanged）
//      走的还是"已经有值就跳过" ⇒ `skipped_existing` ✗
//   ② 根因：**公式列延迟** —— 编辑那一刻记录里的「编号」还是旧值 `832-372-6H`，
//      事件**如实**判成"没变"，而那次之后再没有第二次事件 ⇒ 没人复核 ⇒ 旧码一直挂着
// ═══════════════════════════════════════════════════════════════════════════

test('AC-QR-STALE-6 ⭐⭐ 写入路径也必须按编号判过期：旧名 `…-6H…` + 期望 `…-6…` ⇒ **必须 written**', async () => {
  // 真机逐字形状（她那条 rec28e1ut0rRrC）：
  //   编号=832-372-6|棕色|A ／ 附件名=tag-qr-832-372-6H_棕色_A.png ／ 应有名=tag-qr-832-372-6_棕色_A.png
  // ⚠️ 这一档**不带 numberChanged**（= 回填脚本 `--write` 不带 `--overwrite` 传的就是 `undefined`）。
  const gateway = fakeGateway({
    records: {
      rec28e1ut0rRrC: recordWith({
        number: '832-372-6|棕色|A',
        tagQrCode: [{ file_token: 'oldH', name: 'tag-qr-832-372-6H_棕色_A.png' }],
      }),
    },
  });
  const service = serviceFor(gateway);
  const lines = await captureLogs(async () => {
    const result = await service.syncRecord('rec28e1ut0rRrC', { reason: 'backfill' });
    assert.equal(result.status, 'written',
      `旧码必须被写回（实际 ${JSON.stringify(result)}）—— 改前这里记的是 skipped_existing ✗`);
    assert.equal(result.reason, 'number_changed');
  });
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-832-372-6_棕色_A.png');
  assert.equal(gateway.calls.update.length, 1, '要覆盖写回');
  // ⭐ 口径统一：日志里的 `stale_by_file_name` 必须与干跑"待更新"一致（都判过期）
  const overwriting = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((entry) => entry?.event === 'product.tag_qr.overwriting');
  assert.ok(overwriting, '覆盖前先记 overwriting');
  assert.equal(overwriting.stale_by_file_name, true, '832-372-6H ≠ 832-372-6 ⇒ 必须 true（别和干跑打架）');
  assert.deepEqual(overwriting.existing_file_names, ['tag-qr-832-372-6H_棕色_A.png']);
  assert.equal(overwriting.expected_file_name, 'tag-qr-832-372-6_棕色_A.png');
});

test('AC-QR-STALE-6b ⭐ 真的已同步时，写入路径仍然跳过（幂等不能被修坏）', async () => {
  const current = '832-372-6|棕色|A';
  const gateway = fakeGateway({
    records: {
      r_ok: recordWith({ number: current, tagQrCode: [{ file_token: 'ok', name: buildFileName(current) }] }),
    },
  });
  const service = serviceFor(gateway);
  const result = await service.syncRecord('r_ok', { reason: 'backfill' });
  assert.deepEqual([result.status, result.reason], ['skipped', 'already_present']);
  assert.deepEqual(gateway.calls.uploads, [], '已同步的不许重传');
});

test('AC-QR-RECHECK-1 ⭐⭐ 公式列延迟：事件判"没变" ⇒ **延迟复核**（假时钟）后必须补写', async () => {
  // 真机现场：编辑那一刻记录里的「编号」还是**旧值**（`…6H`）⇒ 事件如实判"没变"、附件"看着是对的就跳过"。
  const OLD = '832-372-6H|棕色|A';
  const NEW = '832-372-6|棕色|A';
  const records = {
    rec1: recordWith({ number: OLD, tagQrCode: [{ file_token: 'old', name: 'tag-qr-832-372-6H_棕色_A.png' }] }),
  };
  const gateway = fakeGateway({ records });
  const timers = [];
  const service = serviceFor(gateway, {
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    config: { ...TAG_QR_CODE, recheck: { enabled: true, delayMs: 60000 } },
  });

  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([{
      record_id: 'rec1',
      action: 'record_edited',
      // 事件里前后值**相同**（都是编辑那一刻的旧编号）
      before_value: [{ field_id: NUMBER_FIELD_ID, field_value: OLD }],
      after_value: [{ field_id: NUMBER_FIELD_ID, field_value: OLD }],
    }]);
    assert.equal(result.results[0].reason, 'number_unchanged', '那一刻它**没判错**（编号确实还没算出来）');
  });
  assert.equal(service.recheck.pendingCount(), 1, '必须排一次延迟复核');
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 30000 && timers[0].ms <= 90000, `延迟应在 30~90 秒（实际 ${timers[0].ms}）`);
  assert.ok(eventsOf(lines).includes('product.tag_qr.recheck.scheduled'));

  // 过一会儿：飞书把公式列算完了（记录里的编号变成新值）—— 这时复核应该发现过期并补写
  records.rec1.fields[F.number] = NEW;
  await timers[0].fn();
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  assert.equal(gateway.calls.uploads.length, 1, '延迟复核必须把旧码补写掉');
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-832-372-6_棕色_A.png');
  assert.equal(service.recheck.pendingCount(), 0, '跑完就摘掉');
  assert.equal(gateway.calls.update.length, 1, '复核要真的写回（假网关只记调用、不改记录内容）');
  assert.equal(gateway.calls.update[0][1], 'rec1');
});

test('AC-QR-RECHECK-2 ⭐ 复核：同一条只排一次 / 已同步不重复写 / 失败只记日志（不抛）', async () => {
  const records = {};
  const gateway = fakeGateway({ records });
  const timers = [];
  const service = serviceFor(gateway, {
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: () => {},
    config: { ...TAG_QR_CODE, recheck: { enabled: true, delayMs: 60000 } },
  });

  // ① 关掉：不排
  const off = serviceFor(gateway, { config: { ...TAG_QR_CODE, recheck: { enabled: false, delayMs: 60000 } } });
  assert.deepEqual(off.recheck.schedule('r1'), { scheduled: false, reason: 'disabled' });

  // ② 同一条记录重复排 ⇒ 只排一次
  assert.equal(service.recheck.schedule('r1').scheduled, true);
  const again = service.recheck.schedule('r1');
  assert.equal(again.scheduled, false);
  assert.equal(again.reason, 'already_scheduled');
  assert.equal(service.recheck.pendingCount(), 1);
  assert.equal(timers.length, 1, '只应有一个定时器（排多了会重复读表）');

  // ③ 复核时记录已被别人修好（附件名与编号一致）⇒ 只记 done、不写
  records.r1 = recordWith({ number: '832-372-6|棕色|A', tagQrCode: [{ file_token: 'x', name: 'tag-qr-832-372-6_棕色_A.png' }] });
  const done = await service.recheck.runNow('r1');
  assert.equal(done.status, 'skipped');
  assert.deepEqual(gateway.calls.uploads, [], '已同步 ⇒ 不重复写');
  assert.equal(service.recheck.pendingCount(), 0);

  // ④ 复核失败（读表炸了）⇒ 只记日志、**不抛**
  gateway.get = async () => { throw new Error('飞书 500'); };
  await assert.doesNotReject(() => service.recheck.runNow('r2'), '复核失败绝不抛给事件路径');
});

test('AC-QR-RECHECK-3 ⭐ 配置先行：延迟复核可配（显式布尔 + 数值边界）', () => {
  const { resolveTagQrRecheckConfig, RECHECK_DEFAULTS } = require('../src/config/tagQrCode');
  assert.deepEqual(resolveTagQrRecheckConfig({}), { enabled: true, delayMs: 60000 });
  assert.equal(resolveTagQrRecheckConfig({ TAG_QR_RECHECK_ENABLED: '' }).enabled, false, '空串 = 关');
  assert.equal(resolveTagQrRecheckConfig({ TAG_QR_RECHECK_DELAY_MS: '30000' }).delayMs, 30000);
  assert.throws(() => resolveTagQrRecheckConfig({ TAG_QR_RECHECK_DELAY_MS: '100' }),
    '延迟小于 5 秒 ⇒ 当场抛（公式列都还没算完，等于白核）');
  assert.ok(RECHECK_DEFAULTS.delayMs >= 30000 && RECHECK_DEFAULTS.delayMs <= 90000,
    '默认延迟落在实测合适的 30~90 秒');
});

// ═══════════════════════════════════════════════════════════════════════════
// 【2026-10-12 业务负责人提的判据】别只盯公式列的「编号」—— 直接看**货号/颜色/类别**
//   为什么对：「编号」是**公式列 ⇒ 有延迟**（实测几秒~十几秒）；
//             货号/颜色/类别是**源字段**，事件里拿到就是新值 ⇒ 更快更准 ✓
//   她表里「编号」公式（2026-10-12 只读核过）：货号 & "|" & 颜色 & "|" & 类别
// ═══════════════════════════════════════════════════════════════════════════

/** 造一条"事件里改了某个源字段"的 action（公式列的值**故意留旧值**，模拟延迟）。 */
const sourceEditAction = ({ action = 'record_edited', itemNo, color, category, formulaOld, formulaNew }) => ({
  record_id: 'rec1',
  action,
  before_value: [
    { field_id: SOURCE_FIELD_IDS.itemNo, field_value: itemNo.before },
    { field_id: SOURCE_FIELD_IDS.color, field_value: color.before },
    { field_id: SOURCE_FIELD_IDS.category, field_value: category.before },
    { field_id: NUMBER_FIELD_ID, field_value: formulaOld },
  ],
  after_value: [
    { field_id: SOURCE_FIELD_IDS.itemNo, field_value: itemNo.after },
    { field_id: SOURCE_FIELD_IDS.color, field_value: color.after },
    { field_id: SOURCE_FIELD_IDS.category, field_value: category.after },
    { field_id: NUMBER_FIELD_ID, field_value: formulaNew },
  ],
});

test('AC-QR-SRC-1 ⭐⭐ 改**货号** ⇒ 事件那一刻就判"变了"并写回**新码**（公式列还停在旧值也要写）', async () => {
  // 真机形状：她 12:13 改了货号；事件到达时公式列还是旧编号（`832-372-6H`
  // 记录里的编号列在**读记录那一刻**也还是旧值（公式延迟）—— 但货号已经是新的 ✓
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        number: '832-372-6H|棕色|A', // ⚠️ 公式列**旧值**（延迟）
        itemNo: '832-372-6', color: '棕色', category: 'A',
        tagQrCode: [{ file_token: 'old', name: 'tag-qr-832-372-6H_棕色_A.png' }],
      }),
    },
  });
  const service = serviceFor(gateway);
  let outcome = null;
  const lines = await captureLogs(async () => {
    const result = await service.handleTableChanges([sourceEditAction({
      itemNo: { before: '832-372-6H', after: '832-372-6' },
      color: { before: '棕色', after: '棕色' },
      category: { before: 'A', after: 'A' },
      formulaOld: '832-372-6H|棕色|A',
      formulaNew: '832-372-6H|棕色|A', // 公式列**没变**（还没算完）
    })]);
    outcome = result.results[0];
    assert.equal(outcome.status, 'written',
      `改货号必须立刻写回（实际 ${JSON.stringify(outcome)}）—— 公式列延迟不该拖住我们`);
  });
  // ⭐ 写回的必须是**新编号**的码（拼装值兜底，因为公式列还停在旧值）
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-832-372-6_棕色_A.png');
  assert.equal(outcome.scan_url, 'https://hm.bamamei.online/s/832-372-6%7C%E6%A3%95%E8%89%B2%7CA');
  assert.equal(outcome.number_source, 'assembled_formula_stale');
  const events = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  assert.equal(events.find((e) => e.event === 'product.tag_qr.change_criteria')?.used, 'source_fields',
    '判据要走**源字段**那一路（不是公式列）');
  assert.equal(outcome.number_source, 'assembled_formula_stale', '公式列明显滞后 ⇒ 用拼装值');
  assert.ok(events.some((e) => e.event === 'product.tag_qr.number_mismatch'), '两份值不一致要记 warn');
});

test('AC-QR-SRC-2 ⭐ 改**颜色** ⇒ 同样立刻更新（源字段判据）', async () => {
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        number: 'XHB8095|棕色|A',
        itemNo: 'XHB8095', color: '黑色', category: 'A',
        tagQrCode: [{ file_token: 'o', name: 'tag-qr-XHB8095_棕色_A.png' }],
      }),
    },
  });
  const result = await serviceFor(gateway).handleTableChanges([sourceEditAction({
    itemNo: { before: 'XHB8095', after: 'XHB8095' },
    color: { before: '棕色', after: '黑色' },
    category: { before: 'A', after: 'A' },
    formulaOld: 'XHB8095|棕色|A',
    formulaNew: 'XHB8095|棕色|A',
  })]);
  assert.equal(result.results[0].status, 'written');
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-XHB8095_黑色_A.png');
});

test('AC-QR-SRC-3 ⭐ 改**类别** ⇒ 同样立刻更新', async () => {
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        number: 'XHB8095|棕色|A',
        itemNo: 'XHB8095', color: '棕色', category: 'B',
        tagQrCode: [{ file_token: 'o', name: 'tag-qr-XHB8095_棕色_A.png' }],
      }),
    },
  });
  const result = await serviceFor(gateway).handleTableChanges([sourceEditAction({
    itemNo: { before: 'XHB8095', after: 'XHB8095' },
    color: { before: '棕色', after: '棕色' },
    category: { before: 'A', after: 'B' },
    formulaOld: 'XHB8095|棕色|A',
    formulaNew: 'XHB8095|棕色|A',
  })]);
  assert.equal(result.results[0].status, 'written');
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-XHB8095_棕色_B.png');
});

test('AC-QR-SRC-4 ⭐ 公式列**读不出/为空** ⇒ 用源字段拼装兜底，码仍然正确', async () => {
  const gateway = fakeGateway({
    records: { rec1: recordWith({ number: '', itemNo: 'XHB8095', color: '棕色', category: 'A', tagQrCode: [] }) },
  });
  const service = serviceFor(gateway);
  assert.equal(service.assembleNumber({ [F.itemNo]: 'XHB8095', [F.color]: '棕色', [F.category]: 'A' }),
    'XHB8095|棕色|A', '拼装规则必须与她公式逐字一致（货号|颜色|类别）');
  assert.equal(service.assembleNumber({ [F.itemNo]: 'XHB8095', [F.color]: '', [F.category]: 'A' }), '',
    '任一源字段为空 ⇒ 拼不出（不硬凑 `a||c` 这种公式不会产出的串）');
  const result = await service.handleTableChanges([sourceEditAction({
    itemNo: { before: 'XHB8095', after: 'XHB8095' },
    color: { before: '棕色', after: '棕色' },
    category: { before: 'A', after: 'A' },
    formulaOld: '', formulaNew: '',
  })]);
  assert.equal(result.results[0].number_source, 'assembled_fallback');
  const written = await service.syncRecord('rec1', { reason: 'manual' });
  assert.equal(written.file_name, 'tag-qr-XHB8095_棕色_A.png');
});

test('AC-QR-SRC-5 ⭐ 公式值 ≠ 拼装值 ⇒ 记 warn；公式**不滞后**时以**公式值**为准', async () => {
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        // 公式值（`…|B`）与源字段拼装值（`…|A`）不一致，且**不等于现存附件的编号** ⇒ 不算滞后
        number: 'XHB8095|棕色|B',
        itemNo: 'XHB8095', color: '棕色', category: 'A',
        tagQrCode: [{ file_token: 'o', name: 'tag-qr-XHB8095_棕色_C.png' }],
      }),
    },
  });
  const service = serviceFor(gateway);
  const lines = await captureLogs(async () => {
    await service.syncRecord('rec1', { reason: 'manual' });
  });
  const events = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const warn = events.find((e) => e.event === 'product.tag_qr.number_mismatch');
  assert.ok(warn, '不一致必须记 warn');
  assert.equal(warn.formula_number, 'XHB8095|棕色|B');
  assert.equal(warn.assembled_number, 'XHB8095|棕色|A');
  assert.equal(warn.formula_looks_stale, false);
  assert.equal(gateway.calls.uploads[0].fileName, 'tag-qr-XHB8095_棕色_B.png',
    '⚠️ 不滞后时以**公式值**为准（保证与扫码页的键一致）');
  // 纯函数层面也钉一下四种取舍
  // ⚠️ `existingFileNameNumber` 是**文件名形态**（`numberFromFileName` 的结果：`|` → `_`）
  const pick = (formulaNumber, assembledNumber, existingFileNameNumber) =>
    service.resolveQrNumber({ formulaNumber, assembledNumber, existingFileNameNumber, recordId: 'r' }).source;
  assert.equal(pick('a|b|c', 'a|b|c', ''), 'both_agree');
  assert.equal(pick('', 'a|b|c', ''), 'assembled_fallback');
  assert.equal(pick('a|b|c', '', ''), 'formula_only');
  assert.equal(pick('old|x|y', 'new|x|y', 'old_x_y'), 'assembled_formula_stale');
  assert.equal(pick('other|x|y', 'new|x|y', 'again_x_y'), 'formula_mismatch');
});

test('AC-QR-SRC-6 ⭐ 幂等：三个源字段都没变 ⇒ 不写（且判据走源字段那一路）', async () => {
  const current = 'XHB8095|棕色|A';
  const gateway = fakeGateway({
    records: {
      rec1: recordWith({
        number: current, itemNo: 'XHB8095', color: '棕色', category: 'A',
        tagQrCode: [{ file_token: 'ok', name: buildFileName(current) }],
      }),
    },
  });
  const lines = await captureLogs(async () => {
    const result = await serviceFor(gateway).handleTableChanges([sourceEditAction({
      itemNo: { before: 'XHB8095', after: 'XHB8095' },
      color: { before: '棕色', after: '棕色' },
      category: { before: 'A', after: 'A' },
      formulaOld: current, formulaNew: current,
    })]);
    // ⚠️ 事件那一路（源字段明确判"没变"）记的是 `number_unchanged`；
    //    `already_present` 是"脚本/新增"那一路的幂等档（见 `syncRecord` 的注释）。
    assert.deepEqual([result.results[0].status, result.results[0].reason], ['skipped', 'number_unchanged']);
  });
  assert.deepEqual(gateway.calls.uploads, [], '没变就不许重传');
  const events = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const criteria = events.find((e) => e.event === 'product.tag_qr.change_criteria');
  assert.equal(criteria.source_changed, false, '源字段那一路要明确判"没变"');
  assert.equal(criteria.used, 'source_fields');
});
