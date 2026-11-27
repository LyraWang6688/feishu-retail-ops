'use strict';

require('./support/scanPageReadRedirect');   // 拆分后：按旧路径读 routes/scanPage.js 重定向到聚合文本

/**
 * 2026-11-27：资金页接管已退场，改成独立地址 /r/{id}/pay。
 * 旧口径：会话里 paymentStep=pending 时，GET 会按销售上下文接管成资金页。
 * 新口径：GET 不再接管；资金页只由 /r/{id}/pay 渲染。
 * 反向哨兵：salesContext / 旧接管判据 塞回即红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');

test('AC-PS1 支付中接管已退场：GET 不再按 salesContext 改给资金页', () => {
  assert.equal(SRC.includes('salesContext'), false, 'salesContext 必须删除（塞回即红）');
  assert.equal(/pendingMark === 'pending' && salesContext/.test(SRC), false, '接管判据必须删除（塞回即红）');
  assert.match(SRC, /config\.route\.payPath/, '资金页必须有独立地址（payPath）');
  assert.match(SRC, /renderedTrigger: 'pay_route'/, '/pay 渲染要有自己的 trigger');
});
