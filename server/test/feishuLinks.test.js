'use strict';

/** 飞书 Base「记录链接」的唯一生成器：带视图 / 不带视图两种形状。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordUrl } = require('../src/utils/feishuLinks');

const env = {}; // 空 env ⇒ tenantDomain 走默认值，用例不依赖本机 .env

test('AC-LINK1 不带 viewId：形状与改前逐字一致', () => {
  const url = recordUrl({ appToken: 'app', tableId: 'tbl', recordId: 'rec1' }, env);
  assert.equal(url, 'https://scnzoiwpgxik.feishu.cn/base/app?table=tbl&record=rec1');
});

test('AC-LINK2 带 viewId：table → view → record', () => {
  const url = recordUrl({ appToken: 'app', tableId: 'tbl', viewId: 'vew1', recordId: 'rec1' }, env);
  assert.equal(url, 'https://scnzoiwpgxik.feishu.cn/base/app?table=tbl&view=vew1&record=rec1');
});

test('AC-LINK3 viewId 为空串 = 链接不带 view', () => {
  const url = recordUrl({ appToken: 'app', tableId: 'tbl', viewId: '', recordId: 'rec1' }, env);
  assert.equal(url, 'https://scnzoiwpgxik.feishu.cn/base/app?table=tbl&record=rec1');
});

test('AC-LINK4 缺任一必填项 ⇒ 空串（不拼半条链接）', () => {
  assert.equal(recordUrl({ appToken: 'app', tableId: 'tbl' }, env), '');
  assert.equal(recordUrl({ appToken: '', tableId: 'tbl', recordId: 'rec1' }, env), '');
  assert.equal(recordUrl({ appToken: 'app', tableId: '', recordId: 'rec1' }, env), '');
});
