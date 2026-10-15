'use strict';

/**
 * ⭐⭐ 2026-10-15（task-43 · 她逐字两条决定）：
 *   ①「Dockerfile + .dockerignore，**好的可以删除**」⇒ 容器化入口删除，部署仍走 **PM2 + Nginx** ✓
 *   ②「**「库存手工调整」 是的，可以是待优化**」⇒ 口径从"待开发/方案未定"改成 **待优化**（代码里**已有一套内嵌实现** ✓）
 *
 * 判据迁移（逐字）：
 *   · `Dockerfile` + `.dockerignore` ⇒ 当年承载「容器构建与部署入口」；**现在由 PM2 + Nginx 承载**
 *     （`server/scripts/deploy_run.sh` 读 `server/ecosystem.config.js`、`server/ops/nginx/**`）⇒ 删了**不丢** ✓
 *   · 两条**指向不存在路径**的忽略项（`.trae`、`server/test_feishu.js`）随文件一起走 ✓
 *   · 「库存手工调整」：**没有代码判据变化**（本刀一个字都没改代码 ✗），只是**口径 + 文档** ✓
 *
 * ⚠️ 本哨兵同时钉**反方向**（Lead 点名要的）：**部署路径不许被碰** ✗
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const grep = (pattern, paths) => require('node:child_process')
  .execSync(`grep -rl --exclude-dir=node_modules --exclude-dir=.git --exclude=prunedDockerSentinel.test.js -- "${pattern}" ${paths} || true`,
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);

test('AC-DD1 ① 两个文件已删（能真红：放回任一个 ⇒ 红）', () => {
  assert.equal(exists('Dockerfile'), false, '⛔ Dockerfile 不该还在 ✗');
  assert.equal(exists('.dockerignore'), false, '⛔ .dockerignore 不该还在 ✗');
});

test('AC-DD1 ② 代码侧 0 悬空引用（能真红：把目录树那行塞回 README ⇒ 红）', () => {
  // 判据范围 = **代码 / 文档入口侧**（README · AGENTS · 脚本 · CI · ops · 工作台）；docs 里记"历史/已执行"是应当的 ✓
  const paths = 'README.md AGENTS.md server/scripts .github server/ops ops server/package.json server/src server/public';
  assert.deepEqual(grep('Dockerfile', paths), [], '⛔ 代码侧不该再出现 Dockerfile ✗');
  assert.deepEqual(grep('dockerignore', paths), [], '⛔ 代码侧不该再出现 .dockerignore ✗');
  assert.deepEqual(grep('docker build', paths), [], '⛔ 不该有人开始搞容器化构建 ✗');
});

test('AC-DD2 ⭐⭐ 反方向：部署路径**逐字没被碰**（能真红：删掉其中一句 ⇒ 红）', () => {
  // 她/Lead 的红线：Dockerfile 删了**不影响**部署 —— 下面三条正是"部署仍然走 PM2 + Nginx"的判据
  assert.ok(exists('server/scripts/deploy_run.sh'), 'deploy_run.sh 必须在 ✓');
  assert.ok(exists('server/ecosystem.config.js'), 'ecosystem.config.js 必须在（PM2 入口 ✓）');
  assert.ok(exists('server/ops/nginx'), 'server/ops/nginx/** 必须在（Nginx 配置 ✓）');
  assert.match(read('server/scripts/deploy_run.sh'), /ecosystem\.config\.js/,
    '⭐ deploy_run.sh 仍然读 ecosystem.config.js ⇒ 部署方式没变 ✓');
  const ecosystem = read('server/ecosystem.config.js');
  assert.match(ecosystem, /pm2|apps\s*:/i, '⭐ ecosystem.config.js 仍是 PM2 配置 ✓');
  const nginxFiles = fs.readdirSync(path.join(ROOT, 'server/ops/nginx'));
  assert.ok(nginxFiles.length > 0, '⭐ Nginx 配置还在 ✓');
  // 两处目录树注释已同步（不是悬空引用 ✗）
  for (const rel of ['README.md', 'AGENTS.md']) {
    assert.equal(/Dockerfile/.test(read(rel)), false, `⛔ ${rel} 的目录树不该再提 Dockerfile ✗`);
  }
});

test('AC-DD3 「库存手工调整」口径 = **待优化**（能真红：把"待开发/方案未定"写回 ⇒ 红）', () => {
  const audit = read('docs/architecture-audit-2026-10-15.md');
  const tabs = read('docs/workbench-tabs-and-subpages-2026-10-15.md');
  assert.match(tabs, /待优化/, '⭐ 子页清单要写"待优化" ✓');
  assert.ok((tabs.match(/待优化/g) || []).length >= 2, '两处口径都改了 ✓');
  assert.match(audit, /她 2026-10-15 (确认|改口径)/, '⭐ 审计里要写清是**她当天确认**的 ✓');
  // ⛔ 手工调整那两处不许再留"待开发/方案未定"
  for (const line of (audit + tabs).split('\n')) {
    if (/手工调整|inventory-adjust/.test(line)) {
      assert.equal(/方案未定/.test(line), false, `⛔ 手工调整不应再写"方案未定"：${line.slice(0, 60)}`);
    }
  }
  // ⭐ 顺带把"已有内嵌实现"的落点钉住（issue #595 的评论引用的就是这几行）
  assert.match(audit, /已有内嵌实现|现有实现/, '审计里"已有内嵌实现"的证据要留着 ✓');
  assert.match(tabs, /adjustment\.js/, '前端内嵌实现的文件路径要留着 ✓');
});
