/**
 * ⭐⭐ 2026-10-12 二维码标识迁移 AC：**编号（会变）→ 记录 ID（永不变）**
 *
 * 【她今天亲自提的方案（逐字）】
 *   「我在扫码之前，那个类别是没有的；扫完码之后……发现类别是空的，所以我就把它补充上了。
 *    也就是说，**扫码前后类别变了，它就没法对上了，是吗**？
 *    如果必须得要一个**完全不变的标识**，那我们是不是可以用**记录 ID**呀？」
 *   ⇒ 正解：编号 `货号|颜色|类别` 是**会变的快照**；`record_id` 是**永不变的身份证**。
 *
 * 【接口约定（与扫码线已对齐，不许改）】
 *   新 = `https://hm.bamamei.online/r/{recordId}` · 旧 = `https://hm.bamamei.online/s/{编号}`（继续兼容）
 *   模板落 `config/tagQrCode.js` 的 `scanUrl`（**不写死**）。
 *
 * 本文件先写 AC（红）→ 再实现（见 `tagQrCodeService.js`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const { buildScanUrl, buildRecordIdScanUrl, createTagQrCodeService } = require('../src/services/tagQrCodeService');

const RECORD_ID = 'recvQk8mZ1aB2cD3e';
const NUMBER = 'MK31-1|咖色|B';

test('AC-1 ⭐ 新码 URL 逐字 = 配置模板 + recordId（**不是编号**）', () => {
  // ① 模板来自配置（不写死）
  assert.equal(TAG_QR_CODE.scanUrl.recordIdTemplate, 'https://hm.bamamei.online/r/{recordId}',
    '新格式模板必须落在 config.scanUrl（配置先行）');
  // ② 老模板逐字保留（旧码继续兼容）
  assert.equal(TAG_QR_CODE.scanUrl.numberTemplate, 'https://hm.bamamei.online/s/{number}',
    '旧格式模板不许改（旧标签还在她手里）');
  // ③ 逐字拼出来
  assert.equal(
    buildRecordIdScanUrl(RECORD_ID),
    `https://hm.bamamei.online/r/${RECORD_ID}`,
  );
  // ④ 反例哨兵：新 URL 里**不许**出现编号（否则又变成"会变的快照"）
  assert.ok(!buildRecordIdScanUrl(RECORD_ID).includes('|'));
});

test('AC-2 ⭐ 两条模板的占位符各自认（`{number}` / `{recordId}`），写错占位符**当场抛**', () => {
  assert.equal(buildScanUrl('https://x/s/{number}', NUMBER), 'https://x/s/MK31-1%7C%E5%92%96%E8%89%B2%7CB');
  assert.equal(buildRecordIdScanUrl(RECORD_ID), `https://hm.bamamei.online/r/${RECORD_ID}`);
  assert.throws(() => buildRecordIdScanUrl(''), /record_id/);
  // 模板里没有 {recordId} ⇒ 当场抛（不静默出空码）
  assert.throws(() => buildRecordIdScanUrl(RECORD_ID, { scanUrl: { recordIdTemplate: 'https://x/nope' } }), /recordId/);
});

test('AC-3 ⭐ 缺 record_id（异常数据）⇒ **不静默**：记 warn + 回退编号格式（保证还能印）', () => {
  const { resolveQrIdentity } = createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('p') });
  const pick = resolveQrIdentity({ recordId: '', number: NUMBER });
  assert.equal(pick.url, `https://hm.bamamei.online/s/${encodeURIComponent(NUMBER)}`,
    '没有 record_id ⇒ 回退**编号**格式（旧标签那条路，保证还能印出来）');
  assert.equal(pick.identity, 'number');
  assert.equal(pick.fallback, true, '要标出"这是回退"，便于记 warn（不静默）');

  const ok = resolveQrIdentity({ recordId: RECORD_ID, number: NUMBER });
  assert.equal(ok.url, `https://hm.bamamei.online/r/${RECORD_ID}`, '有 record_id ⇒ 一律用新格式');
  assert.equal(ok.identity, 'record_id');
  assert.equal(ok.fallback, false);
});

test('AC-4 ⭐ 编号变了**不再**因为编号就重写（新格式以 record_id 为锚）', () => {
  const { resolveQrIdentity } = createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('p') });
  // 同一记录的两次：编号从 `MK31-1|咖色|` 变成 `MK31-1|咖色|B`（她补了类别）
  const before = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|咖色|' });
  const after = resolveQrIdentity({ recordId: RECORD_ID, number: NUMBER });
  assert.equal(before.url, after.url, 'record_id 没变 ⇒ 二维码内容**逐字不变**');
  // ⭐ 标识本身（record_id）没变 ⇒ URL 逐字不变 ⇒ **不必重写**（这就是「以 record_id 为锚」）
  assert.equal(before.value, after.value, '标识 = record_id，永不变');
  // ⇒ 由 `resolveQrIdentity` 的 url 相等即可判定"不必重写"（内容锚定在 record_id 上）
});

test('AC-5 ⭐ 旧格式码 ⇒ 升级判定：`/s/` ⇒ `/r/`，带旧编号（供记 `upgraded_to_record_id`）', () => {
  const { resolveQrIdentity } = createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('p') });
  const legacy = `https://hm.bamamei.online/s/${encodeURIComponent(NUMBER)}`;
  const pick = resolveQrIdentity({ recordId: RECORD_ID, number: NUMBER, existingUrl: legacy });
  assert.equal(pick.url, `https://hm.bamamei.online/r/${RECORD_ID}`);
  assert.equal(pick.upgrade, true, '旧格式 ⇒ 要升级');
  assert.equal(pick.previousNumber, NUMBER, '带出旧编号（事件里要它）');
  assert.equal(pick.previousIdentity, 'number');

  // 已经是新格式 ⇒ 不重复升级（幂等）
  const already = resolveQrIdentity({
    recordId: RECORD_ID, number: NUMBER, existingUrl: `https://hm.bamamei.online/r/${RECORD_ID}`,
  });
  assert.equal(already.upgrade, false, '已经是 /r/ ⇒ 不再升级（幂等，不重复记事件）');
});

test('AC-6 二维码可读性：新格式的模块数**不比旧格式差**（并给出 13mm 下的模块边长）', () => {
  const { qrMatrixSize } = createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('p') });
  const oldUrl = buildScanUrl(TAG_QR_CODE.scanUrl.numberTemplate, NUMBER);
  const newUrl = buildRecordIdScanUrl(RECORD_ID);
  const oldSize = qrMatrixSize(oldUrl);
  const newSize = qrMatrixSize(newUrl);
  // ⭐ 实测反转（见报告）：编号含中文要 URL 编码 ⇒ 新格式 URL **并不更长**，模块数不变或更少
  assert.ok(newSize <= oldSize, `模块数不该变多：new=${newSize} old=${oldSize}`);
  // 可读性口径：13mm 标签下每模块边长（< 0.30mm 就要提一档尺寸）
  const LABEL_MM = 13;
  const moduleMm = LABEL_MM / newSize;
  assert.ok(newSize > 0);
  console.log(`      [可读性] 旧=${oldUrl.length}字符/${oldSize}模块 · 新=${newUrl.length}字符/${newSize}模块 · 13mm 下每模块 ${moduleMm.toFixed(3)}mm`);
  assert.ok(moduleMm >= 0.30,
    `13mm/${newSize} 模块 = ${moduleMm.toFixed(3)}mm 已低于 0.30mm 下限 ⇒ 必须提一档标签尺寸`);
});
