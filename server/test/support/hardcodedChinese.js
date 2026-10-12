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
/** 这三类语句的中文**不算**用户可见文案（注释另外用状态机剥掉）。 */
const EXEMPT_STATEMENT = /(^|[\s(])throw[\s(]|new Error\(|\blog(?:Info|Warn|Error)\b|\blogger\.|\bconsole\./;

/** 把注释换成等量空白（保留换行与偏移）—— 这样"注释里的中文"天然不参与扫描。 */
function stripComments(source) {
  let out = '';
  let state = 'code'; // code | line | block | single | double | template
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; out += '  '; index += 1; continue; }
      if (char === '/' && next === '*') { state = 'block'; out += '  '; index += 1; continue; }
      if (char === "'") state = 'single';
      else if (char === '"') state = 'double';
      else if (char === '`') state = 'template';
      out += char;
      continue;
    }
    if (state === 'line') {
      if (char === '\n') { state = 'code'; out += '\n'; continue; }
      out += ' ';
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; out += '  '; index += 1; continue; }
      out += char === '\n' ? '\n' : ' ';
      continue;
    }
    // 字符串/模板里：只处理转义与结束符（**内容原样保留**）
    if (char === '\\') { out += char + (next ?? ''); index += 1; continue; }
    if ((state === 'single' && char === "'") || (state === 'double' && char === '"') || (state === 'template' && char === '`')) {
      state = 'code';
    }
    out += char;
  }
  return out;
}

/** 找出所有字符串字面量（含模板串）：返回 `{ start, end, text }`（text = 引号内的**原文**）。 */
function findLiterals(code) {
  const literals = [];
  for (let index = 0; index < code.length; index += 1) {
    const quote = code[index];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    const start = index;
    let text = '';
    index += 1;
    for (; index < code.length; index += 1) {
      const char = code[index];
      if (char === '\\') { text += char + (code[index + 1] ?? ''); index += 1; continue; }
      if (char === quote) break;
      text += char;
    }
    literals.push({ start, end: index, text });
  }
  return literals;
}

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
function scanSource(file, source) {
  const code = stripComments(source);
  const found = [];
  for (const literal of findLiterals(code)) {
    if (!CJK.test(literal.text)) continue;
    if (EXEMPT_STATEMENT.test(statementBefore(code, literal.start))) continue;
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

module.exports = { scanSource, scanTree, stripComments, normalizeText, CJK };
