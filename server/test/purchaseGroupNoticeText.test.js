// 采购群那条话术的守卫用例（2026-10-07 业务负责人逐字改的）。
//
// 她的原话（逐字）：
//   「我需要你改一下机器人的话术，就是**不用说几条，只给出多少双就可以了**～」
// 她在群里看到的（逐字）：
//   `@王颖 未标注供应商 这批 5 条（共 5 双），图可以直接转给供应商。`
//   `@王颖 三星 这批 12 条（共 13 双），图可以直接转给供应商。`
// 要的：
//   `@王颖 未标注供应商 这批 5 双，图可以直接转给供应商。`
//   `@王颖 三星 这批 13 双，图可以直接转给供应商。`
//
// 本文件钉四件事（验收标准 AC-1~AC-4 / AC-6 / AC-7 / AC-11）：
//   ① 有供应商名 → 逐字 `@… 三星 这批 13 双，图可以直接转给供应商。`
//   ② 未标注供应商 → 逐字 `@… 未标注供应商 这批 5 双，图可以直接转给供应商。`
//   ③ 双数为 1 时 → `@… 金猴 这批 1 双，图可以直接转给供应商。`
//   ④ 文案**不含「条」**（也不含「共」）
//   ＋ @经办人保留 / 拿不到 open_id 时不 @ / 供应商名与尾句保留（AC-6）
//   ＋ 文案（含 @ 模板、供应商占位、双数占位、兜底写法）全在配置里、可用 env 覆盖（AC-7）
//   ＋ `.env.example` 与配置默认值逐字一致（AC-11）
//
// ⚠️ **双数口径不在本文件**（AC-5）：`pairs` = 这一组明细的 `quantity` 求和，算法在
//    `services/purchaseWebhookService.deliverSupplierImagesInner`（本次**一个字没改**）。
//    走真实链路的那几处逐字断言在：
//    · `server/test/purchaseWebhookService.test.js`（2 条明细 2+1 双 ⇒「这批 3 双」· 奥康 1 双）
//    · `server/test/purchaseReturn.test.js`（退货单共用这同一行 ⇒「这批 3 双」· 未标注供应商 1 双）

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KEYS,
  PURCHASE_GROUP_NOTICE_DEFAULTS_BY_KEY,
  resolvePurchaseGroupNoticeConfig,
  supplierLabel,
  renderPurchaseGroupNoticeText,
  renderPurchaseGroupNoticeMention,
  renderPurchaseGroupNotice,
} = require('../src/config/purchaseGroupNoticeText');

const OPERATOR = 'ou_user_1';
// 业务负责人实际看到的那两条（她给的原话里就是这两个供应商 / 两个双数）。
const SAMSUNG = { supplierName: '三星', pairs: 13, operatorOpenId: OPERATOR };
const UNKNOWN = { supplierName: '', pairs: 5, operatorOpenId: OPERATOR };

// ── ① 有供应商名：逐字 ───────────────────────────────────────────────────────
test('① 有供应商名：逐字「@… 三星 这批 13 双，图可以直接转给供应商。」', () => {
  assert.equal(
    renderPurchaseGroupNotice(SAMSUNG),
    `<at user_id="${OPERATOR}"></at> 三星 这批 13 双，图可以直接转给供应商。`,
  );
});

// ── ② 未标注供应商：逐字 ─────────────────────────────────────────────────────
test('② 未标注供应商：逐字「@… 未标注供应商 这批 5 双，图可以直接转给供应商。」', () => {
  assert.equal(
    renderPurchaseGroupNotice(UNKNOWN),
    `<at user_id="${OPERATOR}"></at> 未标注供应商 这批 5 双，图可以直接转给供应商。`,
  );
});

// ── ③ 双数为 1 ──────────────────────────────────────────────────────────────
test('③ 双数为 1：逐字「@… 金猴 这批 1 双，图可以直接转给供应商。」（不加别的量词）', () => {
  assert.equal(
    renderPurchaseGroupNotice({ supplierName: '金猴', pairs: 1, operatorOpenId: OPERATOR }),
    `<at user_id="${OPERATOR}"></at> 金猴 这批 1 双，图可以直接转给供应商。`,
  );
});

// ── ④ 不含「条」（也不含「共」）─────────────────────────────────────────────
test('④ 文案不含「条」也不含「共」（各种双数都扫一遍）', () => {
  for (const pairs of [1, 2, 5, 13, 100]) {
    const text = renderPurchaseGroupNotice({ supplierName: '三星', pairs, operatorOpenId: OPERATOR });
    assert.ok(!text.includes('条'), `文案里不许再有「N 条」：${text}`);
    assert.ok(!text.includes('共'), `「共」也要去掉：${text}`);
  }
  // 供应商名 / @ / 尾句**都还在**（AC-6：只删「N 条」，别的都保留）。
  const text = renderPurchaseGroupNotice(SAMSUNG);
  assert.ok(text.startsWith(`<at user_id="${OPERATOR}"></at> 三星 `), '@经办人 + 供应商名要在最前面');
  assert.ok(text.endsWith('，图可以直接转给供应商。'), '尾句必须逐字保留');
});

// ── AC-6：拿不到经办人 open_id → 不加 @（正文照发，绝不 @所有人）────────────
test('⑤ 拿不到经办人 open_id：不加 @，正文照旧（绝不 @所有人）', () => {
  assert.equal(renderPurchaseGroupNoticeMention(''), '');
  assert.equal(renderPurchaseGroupNoticeMention(undefined), '');
  assert.equal(
    renderPurchaseGroupNotice({ supplierName: '金猴', pairs: 2, operatorOpenId: '' }),
    '金猴 这批 2 双，图可以直接转给供应商。',
  );
  assert.ok(!renderPurchaseGroupNotice(UNKNOWN).includes('user_id="all"'), '不允许 @所有人');
});

// ── AC-7：配置先行（env 覆盖 / 空串回落 / 未知占位符原样留着）───────────────
test('⑥ 文案全在配置里：env 可覆盖；空串回落默认；未知占位符原样留着', () => {
  // 没设 → 默认值（逐字 = 她要的那句）。
  const defaults = resolvePurchaseGroupNoticeConfig({});
  assert.equal(defaults.text, '{supplier} 这批 {pairs} 双，图可以直接转给供应商。');
  assert.equal(defaults.mention, '<at user_id="{openId}"></at> ');
  assert.equal(defaults.unknownSupplier, '未标注供应商');

  // 设了 → 用设的值（三处都能改）。
  const custom = resolvePurchaseGroupNoticeConfig({
    [KEYS.text]: '【{supplier}】{pairs} 双',
    [KEYS.mention]: '@{openId}',
    [KEYS.unknownSupplier]: '没写供应商',
  });
  assert.equal(custom.text, '【{supplier}】{pairs} 双');
  assert.equal(custom.mention, '@{openId}');
  assert.equal(custom.unknownSupplier, '没写供应商');
  assert.equal(
    renderPurchaseGroupNotice({ supplierName: '', pairs: 4, operatorOpenId: OPERATOR }, custom),
    '@ou_user_1【没写供应商】4 双',
  );

  // 设成空串 / 只有空白 → **回落默认值**（那句话是她唯一能看到的信息，留空 = 信息丢了）。
  const blank = resolvePurchaseGroupNoticeConfig({
    [KEYS.text]: '   ',
    [KEYS.mention]: '',
    [KEYS.unknownSupplier]: '',
  });
  assert.equal(blank.text, defaults.text);
  assert.equal(blank.mention, defaults.mention);
  assert.equal(blank.unknownSupplier, defaults.unknownSupplier);

  // 未知占位符**原样留着**（一眼看出模板写错了，而不是静默变成 `undefined`）。
  const typo = resolvePurchaseGroupNoticeConfig({ [KEYS.text]: '{supplier} 这批 {pairs} 双 {oops}' });
  assert.equal(renderPurchaseGroupNoticeText({ label: '三星', pairs: 13 }, typo), '三星 这批 13 双 {oops}');
});

// ── AC-7：逻辑里不许再写死这句中文 ─────────────────────────────────────────
test('⑦ service 里不再写死这句文案（拼接点只剩配置渲染）', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'purchaseWebhookService.js'), 'utf8',
  );
  assert.ok(!source.includes('条（共'), '旧文案「N 条（共 M 双）」必须从 service 里消失');
  assert.ok(!/这批 \$\{/.test(source), '这句文案不许再在 service 里用模板串拼');
  assert.ok(!source.includes("|| '未标注供应商'"), '「未标注供应商」的兜底已进配置');
  assert.ok(!source.includes('<at user_id="'), '那段飞书 @ 标记也已进配置');
});

// ── AC-11：`.env.example` 与配置默认值逐字一致（忘了写文档 → 红）───────────
test('⑧ `.env.example` 里那一段与配置默认值逐字一致', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const documented = new Map();
  for (const line of envExample.split('\n')) {
    const match = line.match(/^(PURCHASE_GROUP_NOTICE_[A-Z0-9_]+)=(.*)$/);
    if (match) documented.set(match[1], match[2]);
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(PURCHASE_GROUP_NOTICE_DEFAULTS_BY_KEY).sort(),
    '`.env.example` 的键集合与配置的键集合必须一致');
  for (const [key, fallback] of Object.entries(PURCHASE_GROUP_NOTICE_DEFAULTS_BY_KEY)) {
    assert.equal(documented.get(key), fallback, `${key} 的默认值与 .env.example 里写的不一致`);
  }
});

// ── 供应商名占位：有名字用名字，取不到才用兜底写法（绝不编）──────────────────
test('⑨ 供应商名占位：有名字用名字；空 / 空白才用配置里的兜底写法', () => {
  const config = resolvePurchaseGroupNoticeConfig({});
  assert.equal(supplierLabel('三星', config), '三星');
  assert.equal(supplierLabel('  三星  ', config), '三星');
  assert.equal(supplierLabel('', config), '未标注供应商');
  assert.equal(supplierLabel('   ', config), '未标注供应商');
  assert.equal(supplierLabel(undefined, config), '未标注供应商');
  // ⚠️ 明确传 `label` 时**原样用**（service 就是这么调的：标签只算一次）。
  assert.equal(
    renderPurchaseGroupNoticeText({ label: '三星', pairs: 13 }, config),
    '三星 这批 13 双，图可以直接转给供应商。',
  );
});
