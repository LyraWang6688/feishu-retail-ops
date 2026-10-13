/**
 * ⭐⭐ 「整页空白」的 CI 哨兵（2026-10-13 晚真事故）：
 *
 * 她那晚浏览器控制台逐字报：
 *   `Uncaught SyntaxError: The requested module './core/tabs.js' does not provide an export named 'MAIN_TABS'`
 * ⇒ `main.js` **整个不执行** ⇒ 工作台**整页空白**（只剩静态文字"正在检查飞书登录状态…"）
 * ⇒ 根因：`core/tabs.js` 只 `import { MAIN_TABS } from '../config/tabs.js'`、**没有 re-export**，
 *    而 `main.js` 从它 import ✗ —— **模块级失败是静默的**（页面什么都不说，只在控制台报）
 *
 * ⇒ 本文件把这类错**在 CI 就拦住**：静态解析 `public/workbench` 下所有 js 的 `import { … } from './x.js'`，
 *   （⚠️ 注释里别写 glob 通配连写斜杠星 —— 会提前关掉块注释 ✗）
 *    **逐个导入名**去目标文件里找同名 `export` ✓
 * ⚠️ 只读静态文件 ✓（不起服务、不读表、不写表 ✓ CI 里很快 ✓）
 * ⚠️ `export *` 按「不支持」处理（不判）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKBENCH_ROOT = path.join(__dirname, '..', 'public', 'workbench');

/** 列出目录下所有 `.js`（递归） */
function listJsFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.js$/.test(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

/** 一个文件**导出**了哪些名字（`export const/let/var/function/async function/class 名` + `export { 名 | 名 as 别名 }`） */
function exportedNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      names.add((piece.split(/\s+as\s+/).pop() || '').trim()); // `A as B` ⇒ 导出名是 B
    }
  }
  return names;
}

/** 一个文件里所有 `import … from '…'`（只要带 `{ }` 具名导入；默认导入不判 —— 与本哨兵目标无关） */
function namedImportsOf(source) {
  const found = [];
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    const raw = (m[2] || '').trim();
    if (!raw) continue;
    const names = raw.split(',').map((x) => x.trim()).filter(Boolean)
      .map((x) => (x.split(/\s+as\s+/)[0] || '').trim()) // `A as B` ⇒ 要检查的是**原名** A
      .filter(Boolean);
    if (names.length) found.push({ names, spec: m[3] });
  }
  return found;
}

/**
 * 检查一棵树里的"具名导入 ⇒ 目标真的有这个 export"。
 * ⚠️ 路径**按文件真实目录**解析（`./` 与 `../` 都走 `path.resolve`）✓
 */
function checkImports(root) {
  const files = listJsFiles(root);
  const problems = [];
  let checked = 0;
  for (const file of files) {
    for (const { names, spec } of namedImportsOf(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue; // 裸包名（node: / npm）不归本哨兵
      const target = path.resolve(path.dirname(file), spec);
      const rel = path.relative(root, file);
      const relTarget = path.relative(root, target);
      if (!fs.existsSync(target)) {
        problems.push({ file: rel, name: names.join(', '), target: relTarget, reason: '目标文件不存在' });
        continue;
      }
      const available = exportedNames(fs.readFileSync(target, 'utf8'));
      for (const name of names) {
        checked += 1;
        if (!available.has(name)) {
          problems.push({
            file: rel,
            name,
            target: relTarget,
            reason: `${rel} imports {${name}} from ${relTarget} — 但目标没有 export ${name}`,
          });
        }
      }
    }
  }
  return { files, checked, problems };
}

// ═══════════════════════════════════════════════════════════════════════════
// 真实树
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 ⭐⭐ 工作台每个具名 import 的目标都真的 export 了它（= 今晚"整页空白"那类错）', () => {
  const { problems } = checkImports(WORKBENCH_ROOT);
  const detail = problems.slice(0, 20).map((p) => `  ${p.reason}`).join('\n');
  assert.equal(problems.length, 0, `发现 ${problems.length} 处"导入了不存在的 export"（这会让整个脚本静默不执行 ⇒ 整页空白）：\n${detail}`);
});

test('AC2 ⭐ 覆盖下限：证明这条测试不是空跑（文件数 / 已核导入名都要够）', () => {
  const { files, checked } = checkImports(WORKBENCH_ROOT);
  assert.ok(files.length >= 20, `至少扫到 20 个 js 文件（实际 ${files.length}）`);
  assert.ok(checked >= 80, `至少核过 80 个导入名（实际 ${checked}）—— 太少了说明解析退化/漏报 ✗`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 反向哨兵：这条检查**必须能真的红**（否则它只是一段自我安慰 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 ⭐⭐ 反向哨兵：造一个"导入了不存在的 export"的夹具 ⇒ 检查器**必须报出来**', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-imports-'));
  fs.writeFileSync(path.join(dir, 'b.js'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(dir, 'a.js'), "import { MISSING, ok } from './b.js';\n");
  const { problems } = checkImports(dir);
  assert.equal(problems.length, 1, '只该报 MISSING 那一条（ok 是存在的 ✓）');
  assert.match(problems[0].reason, /a\.js imports \{MISSING\} from b\.js — 但目标没有 export MISSING/,
    '失败信息要**逐字**说清是谁导入了什么、目标缺什么');
});

test('AC4 ⭐ 路径解析按真实目录：`../b.js`（跨目录）也要解析对', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-imports-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'b.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'sub', 'a.js'), "import { x } from '../b.js';\n");
  assert.equal(checkImports(dir).problems.length, 0, '../ 解析必须对（别像我今晚那样解析错 ⇒ 漏报 ✗）');
  // 反向：把 b.js 的名字改掉 ⇒ 必须报
  fs.writeFileSync(path.join(dir, 'b.js'), 'export const y = 1;\n');
  const { problems } = checkImports(dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /sub\/a\.js imports \{x\} from b\.js — 但目标没有 export x/);
});
