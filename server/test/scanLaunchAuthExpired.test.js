/**
 * 扫一扫启动：**登录过期（401）必须去登录，不能显示「扫一扫没有成功」**（2026-11-11 线上真事）。
 *
 * 真实现象：工作台页面开了一夜（session 8 小时到期），点「售后单」→
 *   `GET /api/workbench/lark/jsapi-signature` 回 401 → 前端 catch 把 401 也当成扫码失败
 *   ⇒ 页面只显示「扫一扫没有成功，请再试一次。」（业务负责人截图）。
 *
 * 判据：401 ⇒ `location.href` 跳到 `/api/auth/feishu/start?return_to=…`，且调用方拿到
 *      `status=401` 的 ApiError（orders 那边据此不再显示扫码失败文案）。
 * 对照：500 / 网络错误 ⇒ **不跳登录**，仍按失败抛。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');

/** 把 launch.js 依赖的三个 core 文件复制成 .mjs（只改 import 后缀，不改逻辑）。 */
const loadLaunchModule = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-launch-auth-'));
  const core = path.join(WORKBENCH, 'core');
  fs.copyFileSync(path.join(core, 'api-client.js'), path.join(dir, 'api-client.mjs'));
  fs.copyFileSync(path.join(core, 'formatters.js'), path.join(dir, 'formatters.mjs'));
  const authSource = fs.readFileSync(path.join(core, 'auth.js'), 'utf8')
    .replace("from './api-client.js'", "from './api-client.mjs'");
  fs.writeFileSync(path.join(dir, 'auth.mjs'), authSource, 'utf8');
  const launchSource = fs.readFileSync(path.join(WORKBENCH, 'features/scan/launch.js'), 'utf8')
    .replace("from '../../core/api-client.js'", "from './api-client.mjs'")
    .replace("from '../../core/formatters.js'", "from './formatters.mjs'")
    .replace("from '../../core/auth.js'", "from './auth.mjs'");
  fs.writeFileSync(path.join(dir, 'launch.mjs'), launchSource, 'utf8');
  return import(pathToFileURL(path.join(dir, 'launch.mjs')).href);
};

const installGlobals = () => {
  const location = {
    origin: 'https://workbench.test',
    href: 'https://workbench.test/workbench/index.html',
    pathname: '/workbench/index.html',
    search: '?tab=orders',
  };
  // `feishuLoginUrl()` 读的正是 location.pathname + location.search（登录后回到这一页）。
  global.window = { location };
  global.location = location;
  return location;
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: () => '' },
});

test('401（session 过期）⇒ 跳飞书登录（带 return_to），不是「扫一扫没有成功」', async () => {
  const location = installGlobals();
  global.fetch = async () => jsonResponse(401, {
    success: false, error: '请先通过飞书身份登录工作台', auth_required: true,
  });
  const { scanCodeRaw } = await loadLaunchModule();

  await assert.rejects(scanCodeRaw('after_sales'), (error) => {
    assert.equal(error.status, 401);
    return true;
  });
  assert.match(location.href, /^\/api\/auth\/feishu\/start\?return_to=/,
    '401 必须自动去登录（并带回跳），不能显示扫码失败');
  assert.ok(location.href.includes(encodeURIComponent('/workbench/index.html?tab=orders')),
    'return_to 要带当前页（含 query）');
});

test('非 401 的签名失败 ⇒ 不跳登录（仍抛给人话处理）', async () => {
  const location = installGlobals();
  global.fetch = async () => jsonResponse(500, { success: false, error: '签名服务暂时不可用' });
  const { scanCodeRaw } = await loadLaunchModule();

  await assert.rejects(scanCodeRaw('after_sales'), (error) => {
    assert.equal(error.status, 500);
    return true;
  });
  assert.equal(location.href, 'https://workbench.test/workbench/index.html', '500 不跳登录');
});
