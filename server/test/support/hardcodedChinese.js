/**
 * 守门工具：从业务代码里挑出「**硬编码的用户可见中文**」。
 *
 * 为什么要有它：她的口径是「用户可见文案逐步抽到 config」——但**只靠自觉会反弹**
 * （新写一个 service 顺手又把一句话写死）。这条守门测试让"存量"看得见、**只许减少、不许增加**。
 *
 * 口径（业务负责人 2026-10-12 点头）：
 *   · 扫描范围：`src/services/**` + `src/routes/**` + `src/views/**`
 *     ⚠️ **`src/config/**` 不扫** —— 文案的家就在那儿（抽过去的中文不该再被报）；
 *   · 🔴 **完全不扫**这三类（"内部消息留在代码里更合适"）：
 *       ① 注释（`//` 与 `/* … *\/`）
 *       ② 日志（`logInfo/logWarn/logError/logger./console.` 所在的整条语句）
 *       ③ 内部错误消息（`throw …` / `new Error(…)` 所在的整条语句）
 *   · ⭐ **领域值 / 表选项**（如「门盒 / 仓库 / 减少 / 不影响」）**照扫**，进白名单 ——
 *     让它们以"存量债"的形式**可见**（将来真搬走了，白名单自然缩短）。
 *
 * 判据（见 `test/noHardcodedChinese.test.js`）：
 *   · 代码里有、白名单里没有 ⇒ **新增** ⇒ 红；
 *   · 白名单里有、代码里已经没有了 ⇒ **stale** ⇒ 只提示"可以删掉这一条"（不红）。
 */
const fs = require('node:fs');
const path = require('node:path');

const CJK = /[\u4e00-\u9fff]/;
/** 正则字面量前面允许出现的字符（`= /…/`、`(/…/)`、`return /…/`…）—— 用来把正则和除号区分开。 */
const REGEX_PRECEDES = /(^|[=(,:;[!&|?{};]|\breturn|\btypeof)\s*$/;
/** 这三类语句的中文**不算**用户可见文案（注释另外用状态机剥掉）。 */
const EXEMPT_STATEMENT = /(^|[\s(])throw[\s(]|new Error\(|\blog(?:Info|Warn|Error)\b|\blogger\.|\bconsole\./;

/**
 * ⭐⭐ 一次遍历的状态机（注释 / 字符串 / 模板串 / **模板串里的 `${}` 嵌套**）。
 *
 * 🔴 2026-10-12 修的真 bug（另一位同事在扫码线撞到）：朴素机器**不认识模板串里的 `${}` 嵌套**，
 *   而且模板串里的**撇号**（如 `` `<span>it's</span>` ``）会让它错当成"单引号字符串"开始 ⇒
 *   **永久失步** ⇒ 后面整段代码被当成串内容 ⇒ **连注释里的中文都被报成"新增硬编码文案"** ✗
 *   （后果：别人哪怕只加一行注释，闸门都会红 —— 那是**闸门在说谎**。）
 * ⇒ 现在用**上下文栈**：`${` 压栈、与之匹配的 `}` 弹栈；模板串只在**栈顶是 template** 时才闭合；
 *   注释只在**代码上下文**里才算注释（模板串里的 `//` 是普通文本 ✓）。
 *
 * 返回：`blanked`（注释换成等量空白、其余原样，保留换行与偏移）+ `literals`（顶层字面量，模板串含其 `${}` 内部原文）。
 */
function walk(source) {
  let blanked = '';
  const literals = [];
  const stack = []; // 'template' | 'interp'
  let state = 'code'; // code | single | double | template | line | block
  let literalStart = -1;
  let literalText = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'line') {
      if (char === '\n') { state = 'code'; blanked += '\n'; continue; }
      blanked += ' '; continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; blanked += '  '; index += 1; continue; }
      blanked += char === '\n' ? '\n' : ' '; continue;
    }
    if (state === 'single' || state === 'double') {
      literalText += char;
      if (char === '\\') { literalText += next ?? ''; blanked += char + (next ?? ''); index += 1; continue; }
      if ((state === 'single' && char === "'") || (state === 'double' && char === '"')) {
        state = 'code';
        literals.push({ start: literalStart, end: index, text: literalText.slice(1, -1) });
      }
      blanked += char; continue;
    }
    if (state === 'template') {
      if (char === '\\') { literalText += char + (next ?? ''); blanked += char + (next ?? ''); index += 1; continue; }
      if (char === '$' && next === '{') { stack.push('interp'); state = 'code'; literalText += '${'; blanked += '${'; index += 1; continue; }
      if (char === '`') {
        stack.pop(); state = 'code';
        literalText += char; blanked += char;
        literals.push({ start: literalStart, end: index, text: literalText.slice(1, -1) });
        continue;
      }
      literalText += char; blanked += char; continue;
    }
    // ── code 上下文 ──
    if (char === '/' && next === '/') { state = 'line'; blanked += '  '; index += 1; continue; }
    if (char === '/' && next === '*') { state = 'block'; blanked += '  '; index += 1; continue; }
    // ⚠️ **正则字面量**（`/[\'"]/`、`/(Lark|Feishu)\//i`…）：里面的引号/斜杠**不是**字符串或注释。
    //    上一版漏了它 ⇒ 在引号处误入字符串状态 ⇒ 一整段代码（含注释）被当成"字符串",注释中文被报 ✗。
    if (char === '/' && REGEX_PRECEDES.test(blanked)) {
      let scan = index + 1;
      let inClass = false;
      let closed = false;
      for (; scan < source.length; scan += 1) {
        const inner = source[scan];
        if (inner === '\\') { scan += 1; continue; }
        if (inner === '\n') break; // 没找到结尾 ⇒ 是除号，不是正则
        if (inner === '[') inClass = true;
        else if (inner === ']') inClass = false;
        else if (inner === '/' && !inClass) { closed = true; break; }
      }
      if (closed) {
        blanked += source.slice(index, scan + 1);
        index = scan;
        continue;
      }
    }
    if (char === '`') { stack.push('template'); state = 'template'; literalStart = index; literalText = '`'; blanked += char; continue; }
    if (char === '}' && stack[stack.length - 1] === 'interp') { stack.pop(); state = 'template'; literalText += char; blanked += char; continue; }
    if (char === "'" || char === '"') {
      state = char === "'" ? 'single' : 'double';
      literalStart = index; literalText = char; blanked += char; continue;
    }
    blanked += char;
  }
  return { blanked, literals };
}

/** 把注释换成等量空白（保留换行与偏移）—— 这样"注释里的中文"天然不参与扫描。 */
const stripComments = (source) => walk(source).blanked;

/** 找出所有**顶层**字面量（含模板串；模板串里的 `${}` 嵌套算同一条原文）。 */
const findLiterals = (code) => walk(code).literals;

/**
 * 这条字面量所在的"语句"（从最近的 `;` / `}` 到字面量）—— 用来判断是不是日志/内部错误。
 * ⚠️ 边界**只认 `;` 与 `}`**、**不认 `{` 也不认换行** —— 否则
 *   `logInfo('x', { hint: '中文' })` 与**跨行的日志调用**会被当成"用户文案"误报（实测踩过）。
 * 窗口封顶 600 字符：防止一条超长语句把"上一条日志"也裹进来。
 */
function statementBefore(code, start) {
  let from = start;
  const floor = Math.max(0, start - 600);
  while (from > floor && !';}'.includes(code[from - 1])) from -= 1;
  return code.slice(from, start);
}

/** 归一化：多行/连续空白压成一个空格，便于白名单按"串"比对（不按行号 —— 行号一动就假红）。 */
const normalizeText = (text) => text.replace(/\s+/g, ' ').trim();

/** 扫一个文件 ⇒ `[{ text, line }]`（只回"用户可见"的中文串，已归一化）。 */

/**
 * ⭐⭐ 2026-10-12 修的缺口（**只这一处**）：跨行 `throw new Error(...)` 里的中文原来会被扫进来 ✗
 * 判据：字面量**落在最近一个 `new Error(` 的括号内**（括号配对；模板 `${}` 里的 `}` 不算边界 ✓）
 * ⚠️ 不用"前 400 字里有 throw"那种粗暴兜底 —— 实测会把真文案一起豁免（闸门变瞎 ✗）
 */
function insideThrow(code, start) {
  const at = code.lastIndexOf('new Error(', start);
  if (at < 0) return false;
  let depth = 0;
  let i = at + 'new Error'.length;
  let state = 'code';
  while (i < code.length) {
    const char = code[i];
    if (state === 'code') {
      if (char === '\\') { i += 2; continue; }
      if (char === "'" || char === '"' || char === '`') state = char;
      else if (char === '(') depth += 1;
      else if (char === ')') { depth -= 1; if (depth === 0) return start < i; }
    } else if (char === state) state = 'code';
    i += 1;
  }
  return false;
}

function scanSource(file, source) {
  const code = stripComments(source);
  const found = [];
  for (const literal of findLiterals(code)) {
    if (!CJK.test(literal.text)) continue;
    if (EXEMPT_STATEMENT.test(statementBefore(code, literal.start)) || insideThrow(code, literal.start)) continue;
    const text = normalizeText(literal.text);
    if (!text) continue;
    const line = code.slice(0, literal.start).split('\n').length;
    found.push({ text, line });
  }
  return found;
}

/** 目录里所有 `.js`（递归，跳过 `node_modules`）。 */
function listSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...listSources(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * 扫一批根目录，与白名单比对。
 * `roots`：`[{ dir, prefix }]`（prefix = 白名单里的键前缀，如 `services/`）。
 * `whitelist.files`：`{ "services/x.js": ["中文串", …] }`。
 */

/**
 * ⭐⭐ 2026-10-13 改造（业务负责人批准）：**只拦「新增」，不拦「存量」**。
 * · `added`（代码里有、清单里没有）⇒ **红** ✓（这条是我们要的：新写的用户可见文案必须进配置）
 * · `stale`（清单里有、代码里没有）⇒ **只记一条 info，不红** ✗
 *   ⇒ 原因：改前两者都红 ⇒ 搬走一句存量文案、或两条分支合并顺序不同，就会红
 *     （2026-10-13 一天拦了三次 ✗）⇒ 每次都要手工重生成清单 ⇒ 总有人忘 ⇒ CI 红。
 *   ⇒ 改后「清单不同步」这件事**不再阻塞任何 PR** ✓
 */
function evaluateGuard({ roots, whitelist }) {
  const { added, stale } = scanTree({ roots, whitelist });
  const preview = stale.slice(0, 20).map((item) => `  ${item.file}  ${item.text}`).join('\n');
  return {
    ok: added.length === 0,
    added,
    stale,
    info: stale.length
      ? `[info] 白名单里有 ${stale.length} 条已不在代码里（可以删掉，**不影响 CI**）：\n${preview}`
      : '',
  };
}

/**
 * 生成清单（**有意**新增存量文案时才用；日常 PR **不再需要**同步它 ✓）。
 * 用法（在 server/ 下）：node -e "…buildWhitelist({roots})…" 见 noHardcodedChinese.test.js 的 AC-2c。
 */
function buildWhitelist({ roots, comment }) {
  const files = {};
  for (const { dir, prefix } of roots) {
    for (const file of listSources(dir)) {
      const key = `${prefix}${path.relative(dir, file).split(path.sep).join('/')}`;
      const texts = [...new Set(scanSource(key, fs.readFileSync(file, 'utf8')).map((item) => item.text))].sort();
      if (texts.length) files[key] = texts;
    }
  }
  const sorted = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  const texts = Object.values(sorted).reduce((n, list) => n + list.length, 0);
  return { ...(comment ? { _comment: comment } : {}), counts: { files: Object.keys(sorted).length, texts }, files: sorted };
}

function scanTree({ roots, whitelist = {} }) {
  const known = whitelist.files || {};
  const added = [];
  const seen = new Map();
  for (const { dir, prefix } of roots) {
    for (const file of listSources(dir)) {
      const key = `${prefix}${path.relative(dir, file).split(path.sep).join('/')}`;
      const texts = scanSource(key, fs.readFileSync(file, 'utf8'));
      const allowed = new Set(known[key] || []);
      seen.set(key, new Set(texts.map((item) => item.text)));
      for (const item of texts) {
        if (!allowed.has(item.text)) added.push({ file: key, text: item.text, line: item.line });
      }
    }
  }
  const stale = [];
  for (const [file, texts] of Object.entries(known)) {
    for (const text of texts) {
      if (!(seen.get(file) || new Set()).has(text)) stale.push({ file, text });
    }
  }
  return { added, stale };
}

module.exports = { scanSource, scanTree, evaluateGuard, buildWhitelist, stripComments, normalizeText, CJK };
