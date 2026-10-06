const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 自检脚本的**行为契约**（不真发消息）：只看退出码与 --json 输出。
// ⚠️ 一律带 --dry-run，并把 LARK_EVENT_ALERT_ENABLED 显式置空
//    （空串 = 关；脚本用的是显式布尔，不会被 .env 里的值以外的兜底打开）。
const serverRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(serverRoot, 'scripts/check-lark-events.mjs');

const tempFile = (contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-events-script-'));
  const file = path.join(dir, 'hb.json');
  if (contents !== undefined) fs.writeFileSync(file, JSON.stringify(contents));
  return file;
};

const runScript = (...args) => {
  const result = spawnSync(process.execPath, [scriptPath, '--json', '--dry-run', ...args], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: { ...process.env, LARK_EVENT_ALERT_ENABLED: '' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const parseJson = (stdout) => JSON.parse(stdout.slice(stdout.indexOf('{')));

test('自检脚本：没有心跳数据时不误报（退出码 0，不发送）', () => {
  const { status, stdout } = runScript('--file', tempFile());
  assert.equal(status, 0, stdout);
  const payload = parseJson(stdout);
  assert.equal(payload.outcome, 'no_data');
  assert.equal(payload.alerted, false);
  assert.equal(payload.hasData, false);
  assert.equal(payload.status, 'ok');
});

test('自检脚本：文件不存在同样按"没有数据"处理', () => {
  const { status, stdout } = runScript('--file', path.join(os.tmpdir(), `missing-${Date.now()}.json`));
  assert.equal(status, 0, stdout);
  assert.equal(parseJson(stdout).outcome, 'no_data');
});

test('自检脚本：新鲜心跳 → 正常，退出码 0', () => {
  const file = tempFile({ lastEventAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  const { status, stdout } = runScript('--file', file);
  assert.equal(status, 0, stdout);
  const payload = parseJson(stdout);
  assert.equal(payload.outcome, 'ok');
  assert.equal(payload.status, 'ok');
  assert.equal(payload.alerted, false);
});

test('自检脚本：超过阈值 + 开关关着 → 退出码 2，绝不发送', () => {
  const file = tempFile({ lastEventAt: new Date(Date.now() - 400 * 60 * 1000).toISOString() });
  const { status, stdout } = runScript('--file', file);
  assert.equal(status, 2, stdout);
  const payload = parseJson(stdout);
  assert.equal(payload.outcome, 'stale_dry_run');
  assert.equal(payload.alerted, false);
  assert.ok(payload.alertText.includes('https://api.bamamei.online/api/lark/events'));
});

test('自检脚本：--minutes 可临时覆盖阈值', () => {
  const file = tempFile({ lastEventAt: new Date(Date.now() - 90 * 60 * 1000).toISOString() });
  assert.equal(runScript('--file', file).status, 0, '默认 180 分钟下 90 分钟是正常的');
  assert.equal(runScript('--file', file, '--minutes', '60').status, 2, '--minutes 60 时应判定为超时');
});
