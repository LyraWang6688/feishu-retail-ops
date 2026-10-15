'use strict';

/**
 * ⭐⭐ 2026-10-15（task-39 · PR-B · 她逐字：「和这些功能无关的代码都可以删除了」）
 *
 * 删掉的是**一整条 `/api/sync` 时代的老链**（审计 §3.3 第 2 项 + `docs/handoff.md:300`）：
 *   `server/src/config/modules.js` · `config/modules.shared.js` · `config/module-manifest.json` ·
 *   `server/scripts/generate_modules.js` · `package.json` 的 `generate:modules` ·
 *   以及**它自己那 2 个测试**（`modules.test.js` / `moduleGeneration.test.js`）。
 *
 * 🔴 为什么连那 2 个测试一起删（**逐条说明** ✓）：
 *   ① `modules.test.js` 只断言 `MODULES` / `getModuleDefinition` / `normalizeModule` 三个符号**自己**的形状；
 *   ② `moduleGeneration.test.js` 只断言 `generate_modules.js` 生成的 `module-manifest.json` **自己**的内容；
 *   ③ 它们**都不测业务判据**（不碰销售 / 采购 / 库存 / 收款任何一条链路）⇒ 属"**随它一起退场的自测**" ✓
 *      （活的业务判据都在别的用例里，本次**一行都没动** ✓）
 *
 * 活引用检查（删之前复跑）：`MODULES` / `getModuleDefinition` / `normalizeModule` /
 *   `config/modules` / `generate_modules` / `generate:modules` / `module-manifest`
 *   ⇒ 唯一命中者就是**这条链自己 + 它那 2 个测试** ✓ **生产零消费者** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
// ⚠️ 哨兵**自己**会提到这些符号（它就是钉它们的那个文件）⇒ grep 必须排除它自己 ✓
const grep = (pattern, paths) => require('node:child_process')
  .execSync(`grep -rl --exclude-dir=node_modules --exclude-dir=.git --exclude=prunedModulesChainSentinel.test.js -- "${pattern}" ${paths} || true`,
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

test('哨兵-6 `/api/sync` 老链的文件已删（能真红：放回任一个 ⇒ 红）', () => {
  for (const rel of ['server/src/config/modules.js', 'config/modules.shared.js', 'config/module-manifest.json',
    'server/scripts/generate_modules.js', 'server/test/modules.test.js', 'server/test/moduleGeneration.test.js']) {
    assert.equal(exists(rel), false, `⛔ ${rel} 不该还在 ✗`);
  }
});

test('哨兵-7 老链的符号 / 脚本名在代码侧 0 残留（能真红：塞回一个 ⇒ 红）', () => {
  // 判据范围 = **代码侧**（src / scripts / test / package.json / .github）；docs 里写"历史"是应当的 ✓
  const paths = 'server/src server/scripts server/test server/package.json .github scripts';
  for (const symbol of ['getModuleDefinition', 'normalizeModule', 'generate:modules', 'generate_modules', 'module-manifest']) {
    assert.deepEqual(grep(symbol, paths), [], `⛔ 代码侧不该再出现 ${symbol} ✗`);
  }
  // ⚠️ `MODULES` 是个宽词（可能被别处正常使用）⇒ 只钉"这条链的那两个文件没了"即可（哨兵-6 ✓）
  assert.match(fs.readFileSync(path.join(ROOT, 'server/package.json'), 'utf8'), /"test":/, 'package.json 仍然合法 ✓');
});
