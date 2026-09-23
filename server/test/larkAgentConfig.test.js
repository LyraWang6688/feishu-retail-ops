const test = require('node:test');
const assert = require('node:assert/strict');
const { getLarkAgentCredentials } = require('../src/config/larkAgent');

test('new Lark app id and secret must be configured as a pair', () => {
  const previousId = process.env.LARK_AGENT_APP_ID;
  const previousSecret = process.env.LARK_AGENT_APP_SECRET;
  process.env.LARK_AGENT_APP_ID = 'cli_new';
  delete process.env.LARK_AGENT_APP_SECRET;
  assert.throws(() => getLarkAgentCredentials(), /必须同时配置/);
  if (previousId === undefined) delete process.env.LARK_AGENT_APP_ID;
  else process.env.LARK_AGENT_APP_ID = previousId;
  if (previousSecret === undefined) delete process.env.LARK_AGENT_APP_SECRET;
  else process.env.LARK_AGENT_APP_SECRET = previousSecret;
});

test('new Lark workflow never falls back to legacy tenant credentials', () => {
  const previous = {
    id: process.env.LARK_AGENT_APP_ID,
    secret: process.env.LARK_AGENT_APP_SECRET,
    legacyId: process.env.FEISHU_APP_ID,
    legacySecret: process.env.FEISHU_APP_SECRET,
  };
  delete process.env.LARK_AGENT_APP_ID;
  delete process.env.LARK_AGENT_APP_SECRET;
  process.env.FEISHU_APP_ID = 'cli_legacy';
  process.env.FEISHU_APP_SECRET = 'legacy_secret';
  assert.throws(() => getLarkAgentCredentials(), /禁止回退到旧租户凭证/);
  for (const [key, value] of [
    ['LARK_AGENT_APP_ID', previous.id],
    ['LARK_AGENT_APP_SECRET', previous.secret],
    ['FEISHU_APP_ID', previous.legacyId],
    ['FEISHU_APP_SECRET', previous.legacySecret],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
