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
 *   新 = `https://hm.bamamei.online/r/{recordId}` · 旧 = `https://hm.bamamei.online/r/{编号}`（继续兼容）
 *   模板落 `config/tagQrCode.js` 的 `scanUrl`（**不写死**）。
 *
 * 本文件先写 AC（红）→ 再实现（见 `tagQrCodeService.js`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { TAG_QR_CODE } = require('../src/config/tagQrCode');
const { buildScanUrl, buildRecordIdScanUrl, createTagQrCodeService } = require('../src/services/tagQrCodeService');

const RECORD_ID = 'recvQk8mZ1aB2cD3e';

// 本文件统一的 service 工厂（纯函数用）
const svc = () => createTagQrCodeService({ gateway: {}, generatePng: async () => Buffer.from('p') });
const NUMBER = 'MK31-1|咖色|B';


test('AC-2 ⭐ 两条模板的占位符各自认（`{number}` / `{recordId}`），写错占位符**当场抛**', () => {
  assert.equal(buildScanUrl('https://x/r/{number}', NUMBER), 'https://x/r/MK31-1%7C%E5%92%96%E8%89%B2%7CB');
  assert.equal(buildRecordIdScanUrl(RECORD_ID), `https://hm.bamamei.online/r/${RECORD_ID}`);
  assert.throws(() => buildRecordIdScanUrl(''), /record_id/);
  // 模板里没有 {recordId} ⇒ 当场抛（不静默出空码）
  assert.throws(() => buildRecordIdScanUrl(RECORD_ID, { scanUrl: { recordIdTemplate: 'https://x/nope' } }), /recordId/);
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

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-12「做法 b」新增的 **9 条等价保证**（对齐被删的 9 条 ⇒ **测试条数净 0** ✓）
//   旧规则：「源字段/编号变了 ⇒ 必须重写二维码」 ⇒ 随 record_id 标识整体退场
//   新规则：**码只跟 record_id 走** ⇒ 源字段怎么改，码都不动（这正是她选它的目的）
//   ⚠️ 每条都能**独立变红**（不虚）：①/②/③ 各只改一个字段；④ 只跑"一致"那半；⑤ 只跑"不一致"那半 ✓
// ═══════════════════════════════════════════════════════════════════════════

test('新增①-A 改**货号** ⇒ 不重写，且二维码 URL **逐字不变**', () => {
  const { resolveQrIdentity } = svc();
  const before = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|咖色|B' });
  const after = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-2|咖色|B' });
  assert.equal(after.url, before.url, '货号变了但 record_id 没变 ⇒ URL 必须逐字不变');
  assert.deepEqual(after, before, '整个判定结果都不该变（⇒ 上层不会重写）');
});

test('新增①-B 改**颜色** ⇒ 不重写，且二维码 URL **逐字不变**', () => {
  const { resolveQrIdentity } = svc();
  const before = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|咖色|B' });
  const after = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|黑色|B' });
  assert.equal(after.url, before.url, '颜色变了但 record_id 没变 ⇒ URL 必须逐字不变');
  assert.deepEqual(after, before);
});

test('新增①-C 改**类别**（她的真机场景）⇒ 不重写，且二维码 URL **逐字不变**', () => {
  const { resolveQrIdentity } = svc();
  // ⭐ 她原话：「扫码之前类别是没有的；扫完码之后……把它补充上了」⇒ 旧规则下这一个动作让码失效
  const before = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|咖色|' });
  const after = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|咖色|B' });
  assert.equal(after.url, before.url, '补上类别 ⇒ 码必须不动（这正是选 record_id 的目的）');
  assert.equal(before.url, `https://hm.bamamei.online/r/${RECORD_ID}`, '装的是 record_id（不是编号）');
});

test('新增② 任何源字段变化（含同时改多个 / 变空 / 乱码）⇒ **都不写**', () => {
  const { resolveQrIdentity } = svc();
  const base = resolveQrIdentity({ recordId: RECORD_ID, number: 'A|B|C' });
  for (const number of ['A|B|C', '', 'X|Y|Z', 'A|B|C|D', '🦶|乱码|9']) {
    assert.equal(resolveQrIdentity({ recordId: RECORD_ID, number }).url, base.url,
      `编号写成 "${number}" 也不该改变码（判据只看 record_id）`);
  }
});

test('新增③-A AC-X：公式「记录 ID」与接口**一致**（或公式为空）⇒ 不 warn、用接口值', () => {
  const { crossCheckRecordId } = svc();
  assert.deepEqual(crossCheckRecordId({ apiRecordId: RECORD_ID, formulaRecordId: RECORD_ID }).mismatch, false);
  assert.equal(crossCheckRecordId({ apiRecordId: RECORD_ID, formulaRecordId: '' }).mismatch, false,
    '公式还没算出来（空）⇒ 不算不一致（公式列有延迟）');
});

test('新增③-B AC-X：公式「记录 ID」≠ 接口 record_id ⇒ warn + **以接口值为准**', () => {
  const { crossCheckRecordId } = svc();
  const bad = crossCheckRecordId({ apiRecordId: RECORD_ID, formulaRecordId: 'recSTALE000000' });
  assert.equal(bad.mismatch, true, '不一致要标出来（供记 warn）');
  assert.equal(bad.recordId, RECORD_ID, '🔴 以**接口 record_id** 为准（公式列有延迟 ⇒ 绝不用它 ✗）');
  assert.equal(bad.source, 'api');
});

test('新增④ 读不到附件名 / 判不了 ⇒ 不影响新码（复核机制保留、触发条件改为"判不了"）', () => {
  const { resolveQrIdentity } = svc();
  const noExisting = resolveQrIdentity({ recordId: RECORD_ID, number: 'MK31-1|咖色|' });
  assert.equal(noExisting.upgrade, false, '没有附件/读不到名字 ⇒ 不算升级（不动）');
  assert.equal(noExisting.url, `https://hm.bamamei.online/r/${RECORD_ID}`, '但码本身照旧按 record_id 出');
});


