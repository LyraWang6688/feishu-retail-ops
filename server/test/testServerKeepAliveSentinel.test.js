'use strict';

/**
 * ⭐⭐ 2026-10-15（task-17 · AC-P1）**源码哨兵**：凡是在用例里"起一个临时 HTTP 服务器"（`.listen(`）的
 *   文件，都必须把那条服务器设成**不保持 keep-alive 空闲连接**（`server.keepAliveTimeout = 1;`）。
 *
 * 为什么（根因，task-16 已实测确证，别重新论证）：
 *   ① Node 内置 `fetch`（undici）有**进程级全局 keep-alive 连接池**，按 origin（`host:port`）池化；
 *   ② `withServer` 这类助手每个用例 `app.listen(0)` 起临时服务器、收尾 `server.close()`；
 *   ③ **临时端口会被 OS 复用**给后面的服务器 ⇒ origin 逐字相同 ⇒ 下一次 `fetch` 挑到那条**已死 socket**
 *      ⇒ 对端不认识这个连接 ⇒ 内核回 **RST** ⇒ `TypeError: fetch failed` / `cause: read ECONNRESET`。
 *   设 `keepAliveTimeout = 1` ⇒ 响应一完连接就关（池里没有死 socket）⇒ 复现脚本 60/60 失败 → **0/60** ✓
 *   （只加 `closeAllConnections()` 救不了：仍 60/60；诊断脚本：`test/stabilityRepro.cjs`、`test/sseSubscriberOrderDiag.cjs`）
 *
 * 判据（能真红）：删掉任意一处 `server.keepAliveTimeout = 1;` ⇒ 本条红。
 * ⚠️ 真有"故意要 keep-alive"的用例：在该文件里写一行 `// keep-alive-exempt: <理由>`，本哨兵放行
 *    （**豁免要写理由**，不许静默跳过 ✗）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const EXEMPT_MARKER = 'keep-alive-exempt:';

/** 递归收集 `test/` 下所有被测/脚本文件（`.js` / `.cjs` / `.mjs`）。 */
const collectFiles = (dir) => {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (/\.(cjs|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
};

test('AC-P1 凡起临时服务器的用例文件都必须 `server.keepAliveTimeout = 1`（否则 ECONNRESET 偶发会回来）', () => {
  const offenders = [];
  const exempt = [];
  for (const full of collectFiles(TEST_DIR)) {
    // ⚠️ 跳过**本文件自己**：它源码里带着 `/\.listen\(/` 这个正则字面量与豁免标记字面量，
    //    不跳过的话会把自己当成"起了服务器又没设 keepAliveTimeout"的违规者 ✗
    if (path.basename(full) === path.basename(__filename)) continue;
    const source = fs.readFileSync(full, 'utf8');
    if (!/\.listen\(/.test(source)) continue;                     // 不起服务器 ⇒ 与本条无关
    const relative = path.relative(TEST_DIR, full);
    if (source.includes(EXEMPT_MARKER)) { exempt.push(relative); continue; }
    if (!source.includes('keepAliveTimeout = 1')) offenders.push(relative);
  }
  assert.deepEqual(offenders.sort(), [],
    `这些文件起了临时服务器却没有 \`keepAliveTimeout = 1\`（端口一复用就会偶发 ECONNRESET ✗）：`
    + `${JSON.stringify(offenders)} —— 修法见 test/stabilityRepro.cjs；`
    + `确有理由不设的，请在文件里写一行 \`// ${EXEMPT_MARKER} <理由>\``);
  // 豁免清单也钉住（**新增豁免 = 显式过一遍 review**）：目前只有一个 ——
  //   `larkHeartbeatEmptyBodyRepro.cjs` 要**对照** `keepAliveTimeout` 三档（1/默认/0）才能证明
  //   "空 body 与 keepAliveTimeout 无关"（task-25 · #600）⇒ 它不能一律设 1。
  assert.deepEqual(exempt.sort(), ['larkHeartbeatEmptyBodyRepro.cjs'],
    '豁免要逐个写明理由（文件里要有 `// keep-alive-exempt: <理由>`）并把这里一起更新');
});
