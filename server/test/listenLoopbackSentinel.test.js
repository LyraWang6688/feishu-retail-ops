/**
 * ⭐⭐ 2026-10-15（task-29 · Lead 定）：**用例侧不许再用通配绑定** ✗
 *
 * 为什么：`app.listen(0, cb)` 让 Node **默认绑通配地址**（`TCP *:PORT`）；
 *   本机桌面应用（现场：豆包 `Electron … TCP 127.0.0.1:61150`）可能占着**同一个端口的 127.0.0.1**
 *   —— 两者**能共存**（地址范围不同）⇒ 客户端打 `127.0.0.1:PORT` 时，内核把连接交给**更具体的那个**
 *   （**别人的应用** ✗）⇒ 拿到别人的 **404 + 空 body** ⇒ `Unexpected json input` 偶发红。
 *   🔴 铁证：失败响应**没有**我们的头、本用例服务器收到请求数 **0**（`#600`/`#608` 已确证）。
 * ⇒ 用例一律写 **`app.listen(0, '127.0.0.1', cb)`** ✓（这样内核**不会**把一个被她应用占着的端口分给我们）
 *
 * 例外：确实必须通配的，**紧邻上一行**写 `// listen-wildcard-exempt: <理由>` ✓
 * ⚠️ 本文件自己也要守规矩：下面的探针字符串是**拼**出来的（不写字面量），免得自伤 ✗
 */
// keep-alive-exempt: **本文件不启任何服务器** —— 源码里的那个调用形状只是**拼出来的探针字符串**
//   （AC-LB1b 用来证明哨兵真能红 ✗），不是 `createServer`/`listen` 调用 ⇒ 无需 keepAliveTimeout ✓
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
// 拼出来（本文件里不出现字面量 `.listen(0` ＋ 非回环，免得哨兵扫到自己 ✗）
const DOT = '.';
const CALL = `${DOT}listen(`;
const EXEMPT = '// listen-wildcard-exempt:';

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
};

/** 这一行是不是"通配绑定的临时服务器"（已经写了回环的不算 ✓）。 */
const isWildcardListen = (line) => {
  const trimmed = line.trim();
  // ⚠️ **注释 / 文档 / 字符串**里提到它不算（那些正是"改前逐字"的留痕，要留着 ✓）
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
  const at = line.indexOf(`${CALL}0`);
  if (at < 0) return false;
  // ⚠️ 必须是**真调用**：`.listen(` 前面得是标识符/`)`/`]`（`app.listen`、`server.listen`）
  //    —— 这样 `'…' + '.listen(0)' + '…'` 这种**拼出来的字符串**不会被当成调用 ✓
  if (!/[A-Za-z0-9_$)\]]$/.test(line.slice(0, at).trimEnd())) return false;
  const rest = line.slice(at + `${CALL}0`.length);
  // 紧跟的必须是 `)` 或 `,`（真调用）；`listen(0, '127.0.0.1'` ⇒ 已经是回环 ✓ 不算
  if (!/^\s*[,)]/.test(rest)) return false;
  if (/^\s*,\s*['"`]/.test(rest)) return false;
  return true;
};

test('AC-LB1 🔴 用例侧**不再有通配绑定**（`' + '.listen(0)' + '` 一律要写回环；例外必须带豁免注释）', () => {
  const offences = [];
  const exemptions = [];
  for (const file of walk(TEST_DIR)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!isWildcardListen(line)) return;
      const previous = lines[index - 1] || '';
      if (previous.includes(EXEMPT)) { exemptions.push(`${path.relative(TEST_DIR, file)}:${index + 1}`); return; }
      offences.push(`${path.relative(TEST_DIR, file)}:${index + 1} → ${line.trim()}`);
    });
  }
  assert.deepEqual(offences, [],
    `用例侧还有通配绑定 ✗（每个都要改成 \`.listen(0, '127.0.0.1', …)\`，或写 \`${EXEMPT} <理由>\`）：\n${offences.join('\n')}`);
  // 豁免清单：如实打出来（PR 里要逐个写理由 ✓）
  if (exemptions.length) console.log('listen-wildcard-exempt:', exemptions.join(', '));
});

test('AC-LB1b ⭐ 探针：哨兵**真能红**（放一行通配探针 ⇒ 判据失败）—— 证明它不是在空跑', () => {
  const probe = `const app = {}; app${CALL}0, () => {});`;
  assert.equal(isWildcardListen(probe), true, '通配探针必须被判为违规 ✓（否则哨兵是空的 ✗）');
  const ok = `app${CALL}0, '127.0.0.1', () => {});`;
  assert.equal(isWildcardListen(ok), false, '已绑回环的不算违规 ✓');
  const noCall = `// 说明：每个用例一个 ${CALL}0) 服务器`;
  assert.equal(isWildcardListen(noCall), false, '纯文字（没有点号调用）不算 ✓');
});
