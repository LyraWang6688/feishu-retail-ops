'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { setSalesDraftServiceForTests } = require('../src/services/salesDraftRuntime');

test('销售提交成功后才消费草稿；失败路径不删', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-consume-'));
  const removed = [];
  setSalesDraftServiceForTests({ remove: async (input) => { removed.push(input); return true; } });
  try {
    const sessions = createScanSessionService({ config: SCAN_WRITE, dir });
    const openId = 'ou_draft_consume';
    await sessions.saveSaleProgress(openId, { draft_id: 'd1' });
    await sessions.completeSale(openId, { key: 'scan_sale:test:1', result: {} });
    assert.equal(removed.length, 1);
    assert.equal(removed[0].draftId, 'd1');
    assert.equal(removed[0].openId, openId);
    const after = await sessions.get(openId);
    assert.equal(after.sale.draft_id, '', '会话里的 draft_id 已清掉');
  } finally {
    setSalesDraftServiceForTests(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
