const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1_SCHEMA_SCOPES } = require('../src/config/v1SchemaScopes');

// ═══════════════════════════════════════════════════════════════════════════
// 验收标准（2026-10-09）
//
// 业务负责人的原话：「我对数据表的字段和结构又改变了一下，你再和 schema 核对一下」。
// 核对方式（**只读**）：在**服务器**上用项目自己的 SDK 客户端（`appTable.list` /
// `appTableField.list`，凭证从线上 `.env` 读）把生产 Base 的 **46 张表 + 每张表的全部字段**
// （名字 / `type` / `ui_type` / 单多选选项 / 关联对端表）拉下来，再与 `v1BitableSchema`
// **双向**对照（闸门只做"schema 的名字 ⊆ 真表的名字"，看不见"多出来的列"，也不校验表名）。
// ⚠️ 全程没有用飞书 CLI、**一个字都没写**。
//
// 本批**只做加法**：真表**新增**的东西 → 加映射。
//
// ⭐⭐ 2026-10-09 收尾（**已拍板**）：「销售主表」那 5 列不再只是"注释里记着"，
//    业务负责人当天给了口径 —— 「当前这个状态下，现有的一些字段已经不太适配我们当前的决定了，
//    也就是我们要用**扫码**」＋「**解析状态就是我们对于原话的解析**」
//    ⇒ 原话 / 解析状态 / 解析结果摘要 / 失败原因 / 消息链接 = **语音+文字录入时代的产物**，
//      扫码时代不要了 ⇒ **映射 + 写入点一起删**（验收标准 AC-B1/B2/B3 见下）。
// ⚠️ 仍**刻意没有动**的两处（都是"整条链路要不要退场"的业务决定，等下一句拍板）：
//    · 「报货批次」少「验收原话 / 确认状态」两列；
//    · 「信息填写」整表被删（供应商报单入口，全仓 30+ 处引用）。
//   详见 `v1BitableSchema.js` 里 `purchaseOrderBatch` / `purchaseReport` 两段的 2026-10-09 说明，
//   以及收尾报告里的两条处置方案（甲：整条链路退场 / 乙：换表）。
// ═══════════════════════════════════════════════════════════════════════════

const SERVER_ROOT = path.join(__dirname, '..');

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

/** 取 `fromIndex` 之后**第一个花括号对象字面量**的原文（按花括号配对，不再靠固定窗口截断）。 */
const objectLiteralAfter = (source, fromIndex) => {
  const start = source.indexOf('{', fromIndex);
  if (start < 0) return '';
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
};

// ⭐⭐ 2026-10-09 收尾的**唯一**改动对象：这 5 个语义键（真表那 5 列已被她删掉）。
const REMOVED_SALES_ENTRY_KEYS = ['originalText', 'parseStatus', 'parseSummary', 'failureReason', 'messageLink'];

test('A(2026-10-09) 新表「付款明细」登记进 schema：只登记表，不编字段映射、不进闸门范围', () => {
  const table = V1_BITABLE_SCHEMA.tables.paymentDetail;
  assert.ok(table, '「付款明细」是她 2026-10-09 在生产 Base 新建的表，schema 必须登记');

  // 表名 + table_id 都按**生产真表**的只读核对结果。
  assert.equal(table.tableName, '付款明细');
  // ⚠️ table_id 照旧走环境变量（本机 .env 指向测试 Base，不能写死成"生产 id 才对"）。
  assert.equal(
    table.tableId,
    process.env.FEISHU_V1_PAYMENT_DETAIL_TABLE_ID || 'tblWaafeodl2oILI',
    '默认值 = 生产真表的 table_id（服务器只读核对：tblWaafeodl2oILI）',
  );

  // 🔴 真表现在**只有 1 列**，而且是主字段「文本」（type=1）—— 一个业务列都没有。
  //    ⇒ 一个字段映射都不许编（编了就是"凭空造逻辑"）。
  assert.deepEqual(table.fields, {}, '真表还没有业务列 ⇒ fields 必须是空的');

  // ⚠️ 刻意**不进闸门范围**：列还没定，现在纳入只会让"她还在建表"变成部署红。
  //    （与 `groupBuyVoucher` 同一处置：可选项不拦部署。）
  assert.equal(
    V1_SCHEMA_SCOPES.all.includes('paymentDetail'),
    false,
    '「付款明细」列还没定 ⇒ 不进 V1_SCHEMA_SCOPES.all',
  );
});

test('A(2026-10-09) 「报货批次」新增列「供应商」：建只读映射，全仓没有任何写入点', () => {
  const batch = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
  assert.equal(batch.supplier, '供应商', '真表新增的「供应商」（SingleLink → 供应商管理）必须映射');

  // 只读列 ⇒ 全仓不许有「往『报货批次』写 supplier」的点。
  // 判据收窄到 `gateway.create/update('purchaseOrderBatch', { … })` 的入参里出现 `supplier:`，
  // 免得把渲染层的 `supplier`（出图/推送文案里的一个变量名）误判成写入点。
  const offenders = [];
  for (const file of walk(path.join(SERVER_ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const codeOnly = stripComments(fs.readFileSync(file, 'utf8'));
    const calls = codeOnly.matchAll(/gateway\.(?:create|update)\(\s*'purchaseOrderBatch'[\s\S]{0,800}?\)/g);
    for (const call of calls) {
      if (/\bsupplier\s*:/.test(call[0])) offenders.push(path.relative(SERVER_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `「报货批次.供应商」只读，不许有写入点：${offenders.join('、')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 验收标准 B（2026-10-09 收尾）：**「销售主表」那 5 列：映射 + 写入点一起下线**
//
// 事实（服务器只读核对，见 `v1BitableSchema.salesEntry` 段）：生产「销售主表」里
// **已经没有**这 5 列 —— 原话 / 解析状态 / 解析结果摘要 / 失败原因 / 消息链接。
// 她 2026-10-09 的口径（逐字）：「当前这个状态下，现有的一些字段已经不太适配我们当前的决定了，
// 也就是我们要用**扫码**」＋「**解析状态就是我们对于原话的解析**」
// ⇒ 这 5 列是**语音+文字录入时代**的产物，扫码时代不要了。
//
// 仓库规矩（AGENTS.md「时间字段」那一节的同一条）：**删映射必须同时删写入点**，
// 只删一个会留坑 ——
//   · 只删写入、留映射 → 那一列永远空着（而且闸门不报错，静默）；
//   · 只删映射、留写入 → 写库时抛「未配置语义字段」/ `FieldNameNotFound`。
//
// AC-B1：`salesEntry.fields` 里这 5 个键**一个都不许留**；建单要写的列**仍在**。
// AC-B2：全仓 `src/**` 再也没有对这 5 列的 `gateway.create/update('salesEntry', …)` 写入
//        （扫的是**对象字面量里作为键出现**，注释里的名字不算 —— 注释要留着记历史）。
// AC-B3：**读取点**也不许再读（读一个已删除的列**只会拿到空**）——
//        `afterSalesService.verifyMaster` 原来拿「原话」做"这条主表是不是这次请求写的"的判据，
//        映射删掉后 `fields.originalText` 是 `undefined` ⇒ 判据会**每一次都判「原话不一致」**、
//        售后重试**必抛**。所以它必须随映射一起删（这条是"删映射"的**功能依赖**，不是顺手清理）。
// ═══════════════════════════════════════════════════════════════════════════

test('B1(2026-10-09) 销售主表 5 列已随真表删除：映射一个都不留，建单要写的列仍在', () => {
  const fields = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  for (const key of REMOVED_SALES_ENTRY_KEYS) {
    assert.equal(fields[key], undefined,
      `${key} 的物理列已被她 2026-10-09 删掉 ⇒ 映射必须一起删（留映射 = 那一列永远空）`);
  }
  // 建单链路还在写这几列 —— 少一个映射就是「未配置语义字段」当场炸。
  for (const key of ['orderNo', 'sender', 'userAction']) {
    assert.ok(fields[key], `${key} 仍必须映射（建销售主表时还在写它）`);
  }
});

test('B2(2026-10-09) 全仓 src 没有对这 5 列的写入点（删映射不删写入 = 写库抛错）', () => {
  const offenders = [];
  for (const file of walk(path.join(SERVER_ROOT, 'src')).filter((f) => f.endsWith('.js'))) {
    const codeOnly = stripComments(fs.readFileSync(file, 'utf8'));
    for (const call of codeOnly.matchAll(/gateway\.(?:create|update)\(\s*'salesEntry'/g)) {
      const body = objectLiteralAfter(codeOnly, call.index + call[0].length);
      for (const key of REMOVED_SALES_ENTRY_KEYS) {
        if (new RegExp(`\\b${key}\\s*:`).test(body)) {
          offenders.push(`${path.relative(SERVER_ROOT, file)} → ${key}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    `这 5 列已被她删除 ⇒ 写入点必须一起删：${offenders.join('、')}`);
});

test('B3(2026-10-09) 「原话」的读取点也删了（读已删除的列只会拿到空 ⇒ 售后重试必抛）', () => {
  const source = stripComments(
    fs.readFileSync(path.join(SERVER_ROOT, 'src/services/afterSalesService.js'), 'utf8'),
  );
  assert.doesNotMatch(source, /fields\s*\??\.\s*originalText\b/,
    '「原话」列已删除：verifyMaster 不许再拿它做判据（undefined !== 请求原话 ⇒ 每次重试都判不一致）');
  // ⚠️ 请求里的 `originalText` **必须留着** —— 它是幂等指纹（`fingerprintOf`）的一部分，
  //    只是不再落业务表；所以这里**不断言**它消失（"不再写表"由 B2 的写入点扫描守）。
  assert.match(source, /originalText: request\.originalText,/,
    '售后请求里的「原话」仍要进幂等指纹（删了会把两笔不同的售后当成同一笔）');
});
