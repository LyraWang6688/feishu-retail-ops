/**
 * 工作台 401 的回归护栏（业务负责人 2026-10-06 遇到的那个）。
 *
 * 现象：`GET /api/auth/feishu/me` 返回 401 → 前端只显示「工作台启动失败：请求失败（401）」，
 * 三个 tab 点了没反应。
 *
 * 根因：`core/auth.js` 里那句 `if (!body.authenticated)` 永远走不到 ——
 * `api-client` 把**非 2xx 一律抛成 ApiError**，401 在上一行就抛了；
 * 而 `main.js` 的 tab 监听绑在鉴权**之后**，于是监听一个都没绑上。
 *
 * 这里真的把 `core/auth.js` 当 ES 模块跑起来（复制成 .mjs 到临时目录，
 * 只改 import 的文件名，逻辑一个字不改），配一个假的 fetch / DOM，
 * 断言"401 到底跳不跳登录"、"enabled=false 时绝不跳"。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench/core');

// 把 core/auth.js + core/api-client.js 复制到临时目录并当 ES 模块加载。
// ⚠️ 只改 `import ... from './api-client.js'` 的文件名（.mjs），不改任何逻辑：
//    测的必须是**仓库里那份源码**。
const loadAuthModule = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-auth-'));
  fs.copyFileSync(path.join(WORKBENCH, 'api-client.js'), path.join(dir, 'api-client.mjs'));
  const authSource = fs.readFileSync(path.join(WORKBENCH, 'auth.js'), 'utf8')
    .replace("from './api-client.js'", "from './api-client.mjs'");
  fs.writeFileSync(path.join(dir, 'auth.mjs'), authSource, 'utf8');
  return import(pathToFileURL(path.join(dir, 'auth.mjs')).href);
};

// 最小 DOM / location 假实现：auth.js 只用到这几样。
const installGlobals = () => {
  const location = { origin: 'https://workbench.test', href: 'https://workbench.test/workbench/index.html',
    pathname: '/workbench/index.html', search: '?tab=sales' };
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, textContent: '', hidden: true, listeners: {},
        classList: { remove() {}, add() {} },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        after() {},
      });
    }
    return elements.get(id);
  };
  global.window = { location };
  global.location = location;
  global.document = {
    // ⚠️ 未登记过的 id 一律返回 null：auth.js 用 `getElementById('go-login')` 判重，
    //    假 DOM 要是"问谁都给一个元素"，那个判重就永远成立、按钮永远造不出来。
    getElementById: (id) => elements.get(id) || null,
    createElement: () => element(`created_${elements.size}`),
    body: { prepend() {} },
  };
  return { location, element };
};

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  headers: { get: () => '' },
});

test('工作台 401：自动跳转 /api/auth/feishu/start（并带上 return_to）', async () => {
  const { location, element } = installGlobals();
  global.fetch = async () => jsonResponse(401, { success: false, enabled: true, authenticated: false, auth_required: true });
  const { requireFeishuAuth } = await loadAuthModule();

  const ready = await requireFeishuAuth({ statusElement: element('auth-status'), logoutButton: element('logout') });

  assert.equal(ready, false);
  assert.match(location.href, /^\/api\/auth\/feishu\/start\?return_to=/,
    '认证已启用但没 session（401）→ 必须自动去登录，不能只显示"启动失败"');
  assert.equal(decodeURIComponent(location.href.split('return_to=')[1]), '/workbench/index.html?tab=sales',
    '登录完要回到她原来那一页');
});

test('工作台 401：页面上还有一个能点的「去登录」（自动跳转的兜底）', async () => {
  const { element } = installGlobals();
  element('auth-status');
  global.fetch = async () => jsonResponse(401, { success: false, enabled: true, authenticated: false, auth_required: true });
  const { showLoginButton } = await loadAuthModule();

  const button = showLoginButton();
  assert.ok(button, '要能造出「去登录」按钮');
  assert.equal(button.textContent, '去登录');
  assert.equal(typeof button.listeners.click, 'function');
});

test('工作台 403（账号未被授权）→ 不跳登录，抛出去让页面显示真实原因', async () => {
  const { location, element } = installGlobals();
  global.fetch = async () => jsonResponse(403, { success: false, error: '当前飞书账号未被授权使用工作台' });
  const { requireFeishuAuth } = await loadAuthModule();

  await assert.rejects(
    () => requireFeishuAuth({ statusElement: element('auth-status'), logoutButton: element('logout') }),
    (error) => error.status === 403,
  );
  assert.equal(location.href, 'https://workbench.test/workbench/index.html',
    '403 不是"没登录"，不该把人送去重新登录（换账号才有意义，由页面上的按钮决定）');
});

test('工作台：LARK_WEB_AUTH_ENABLED=false（/me 返回 200）→ 不跳登录，明确报"尚未启用"', async () => {
  const { location, element } = installGlobals();
  global.fetch = async () => jsonResponse(200, { success: true, enabled: false, authenticated: false });
  const { requireFeishuAuth } = await loadAuthModule();

  await assert.rejects(
    () => requireFeishuAuth({ statusElement: element('auth-status'), logoutButton: element('logout') }),
    /尚未启用/,
  );
  assert.equal(location.href, 'https://workbench.test/workbench/index.html',
    '认证没启用时 /me 是 200，只有 enabled=true 且没 session 才该跳登录');
});
