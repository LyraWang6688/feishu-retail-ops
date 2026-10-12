#!/usr/bin/env node
/**
 * audit-purchase-behavior.mjs —— **只读**审计：「报货批次.采购行为」有没有写成**库存**行为。
 *
 * 为什么要有它（2026-10-12 的真机 bug，业务负责人逐字：「**为什么你选成了采购增加了呢？**」）：
 *   · 配置原来把采购单的「采购行为」写成了**库存环节**的行为
 *     （补货 → `STOCK_PURCHASE_INCREASE`「采购增加」✗ / 退货 → `STOCK_PURCHASE_DECREASE`「采购减少」✗）；
 *   · 真表事实（她只读核过）：「报货」`PURCHASE_ORDER` 与「退货」`PURCHASE_RETURN` 都是**采购环节** ✓，
 *     而「采购增加 / 采购减少」是**库存环节**的行为（只有「库存流水」那一列该用它 ✗）。
 *   · 代码已修（`config/scanWrite.js` 两处默认值）⇒ **新单自动写对**；
 *     但**历史批次**那一列已经错了 ⇒ 需要一份"哪几行、改成哪条"的清单让她自己改。
 *
 * 它做什么（**全部只读**）：
 *   · `listAll('purchaseOrderBatch')` + `listAll('behavior')` —— **只有这两个读**；
 *   · 逐行给出五列：`批次号 · 记录 record_id · 现在写的（行为名称）· 应该写的（报货/退货）· 目标行为记录 id`；
 *   · 汇总一行：`共 N 行 · 需要改 M 行（其中"采购增加→报货" a 行、"采购减少→退货" b 行）`。
 *
 * 🔴 安全（照 `env-selfcheck.mjs` 那一套）：
 *   · **只读**：一处 `create/update/delete` 都没有；测试里用"没有写方法的假网关"把这条钉住 ✓；
 *   · **不打印明文 token / secret**（日志走静默 logger；本脚本本来就不打印凭证）；
 *   · **读失败 ⇒ 非零退出**（不许"读不到就当成没问题"✗）。
 *
 * 用法（在服务器上、有 `.env` 的那台）：
 *   node scripts/audit-purchase-behavior.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 采购单的「采购行为」应该指向的**采购环节**编码（真表事实，2026-10-12）。 */
export const PURCHASE_SIDE = Object.freeze({
  ORDER: 'PURCHASE_ORDER', // 名字「报货」
  RETURN: 'PURCHASE_RETURN', // 名字「退货」
});

/** 被误写进来的**库存环节**编码 ⇒ 应该改成谁。 */
const WRONG_TO_RIGHT = Object.freeze({
  STOCK_PURCHASE_INCREASE: PURCHASE_SIDE.ORDER,
  STOCK_PURCHASE_DECREASE: PURCHASE_SIDE.RETURN,
});

/**
 * 🔴🔴 2026-10-12 **真表实测的形状**（业务负责人在服务器上跑出来的，逐字）：
 *   `采购行为: [{ record_ids: ["recvwcl7trmDGz"], text: "采购增加", type: "text" }]`
 *   ⇒ 关联字段是「**数组包对象**」：名字在 `[0].text`，记录 id 在 `[0].record_ids[]` ✓
 *   ⚠️ 这正是上一版**测试绿、现实红**的原因：夹具用了字符串（`'bh_order'`）⇒ 与真表形状不一致 ✗。
 *      教训（已落项目经验）：**假网关夹具必须与真表形状一致**。
 */
const linkIds = (value) => {
  const list = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const item of list) {
    if (typeof item === 'string') { ids.push(item.trim()); continue; }
    if (item && typeof item === 'object') {
      for (const id of (Array.isArray(item.record_ids) ? item.record_ids : [])) ids.push(String(id || '').trim());
      if (item.record_id) ids.push(String(item.record_id).trim());
      if (item.id) ids.push(String(item.id).trim());
    }
  }
  return ids.filter(Boolean);
};

/**
 * 从字段值里取**人话名字**（真表形状：数组 → 对象 → `text` / `text_arr`）。
 * 认不出就返回空串（调用方据此决定说"(空)"还是"（有值但没名字）"）——**绝不编**。
 */
const fieldText = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    for (const item of value) { const text = fieldText(item); if (text) return text; }
    return '';
  }
  if (typeof value === 'object') {
    for (const key of ['text', 'name', 'value']) { const text = fieldText(value[key]); if (text) return text; }
    if (Array.isArray(value.text_arr)) return fieldText(value.text_arr);
    return '';
  }
  return String(value).trim();
};

/**
 * ⭐ 纯逻辑（用例直接调它，不需要凭证）：算出每一行"现在写的 / 应该写的"。
 * @returns {{rows: Array, summary: {total: number, needFix: number, increaseToOrder: number, decreaseToReturn: number, unknown: number}}}
 */
export const classifyBatches = ({ batchRecords = [], behaviorRecords = [], schema }) => {
  const batchFields = schema.tables.purchaseOrderBatch.fields;
  const behaviorFields = schema.tables.behavior.fields;
  const byId = new Map(behaviorRecords.map((record) => [record.record_id, record]));
  // 「行为管理」那两列是普通文本 ⇒ 但**同法**取名字（形状变了也不会瞎）✓
  const recordIdOfCode = (code) => (behaviorRecords
    .find((record) => fieldText(record.fields?.[behaviorFields.code]) === code) || {}).record_id || '(没找到这条行为记录)';

  const targetIds = {
    [PURCHASE_SIDE.ORDER]: recordIdOfCode(PURCHASE_SIDE.ORDER),
    [PURCHASE_SIDE.RETURN]: recordIdOfCode(PURCHASE_SIDE.RETURN),
  };

  const rows = [];
  const summary = { total: 0, needFix: 0, increaseToOrder: 0, decreaseToReturn: 0, unknown: 0 };
  for (const record of batchRecords) {
    summary.total += 1;
    const rawValue = record.fields?.[batchFields.behavior];
    const currentIds = linkIds(rawValue);
    const current = byId.get(currentIds[0]);
    const currentCode = fieldText(current?.fields?.[behaviorFields.code]);
    // 名字优先查「行为管理」（表里是权威值）；查不到就退回**这一列自己的 text**（真表就有）；
    // 两者都没有但确实有 id ⇒ 如实说"有值但没名字"（**不说"(空)"** ✗ 那是误报）
    const currentName = fieldText(current?.fields?.[behaviorFields.name])
      || fieldText(rawValue)
      || (currentIds.length ? '（有值但没名字）' : '');
    const target = WRONG_TO_RIGHT[currentCode];

    let should = '—';
    let targetId = '—';
    let verdict = 'ok';
    if (target) {
      should = target === PURCHASE_SIDE.ORDER ? '报货' : '退货';
      targetId = targetIds[target];
      verdict = 'fix';
      summary.needFix += 1;
      if (target === PURCHASE_SIDE.ORDER) summary.increaseToOrder += 1;
      else summary.decreaseToReturn += 1;
    } else if (currentCode === PURCHASE_SIDE.ORDER || currentCode === PURCHASE_SIDE.RETURN) {
      should = currentCode === PURCHASE_SIDE.ORDER ? '报货（已对）' : '退货（已对）';
      targetId = record.record_id ? currentIds[0] : '—';
    } else {
      // 空 / 认不出的行为 ⇒ **不猜**：只如实标出来让她看（绝不自动说"该改成什么"）
      should = '(认不出，需人工看)';
      verdict = 'unknown';
      summary.unknown += 1;
    }

    rows.push({
      batchNo: String(record.fields?.[batchFields.batchNo] || '').trim() || '(空)',
      recordId: record.record_id,
      currentName: currentName || (currentIds.length ? `(认不出的行为记录 ${currentIds[0]})` : '(空)'),
      should,
      targetId,
      verdict,
    });
  }
  return { rows, summary };
};

/** 五列 + 一行汇总（纯字符串，用例可断言）。 */
export const renderReport = ({ rows, summary }) => {
  const lines = ['批次号\t那条记录 record_id\t现在写的（行为名称）\t应该写的\t目标行为记录 id'];
  for (const row of rows) {
    lines.push([row.batchNo, row.recordId, row.currentName, row.should, row.targetId].join('\t'));
  }
  lines.push('');
  lines.push(`共 ${summary.total} 行 · 需要改 ${summary.needFix} 行`
    + `（其中"采购增加→报货" ${summary.increaseToOrder} 行、"采购减少→退货" ${summary.decreaseToReturn} 行）`
    + (summary.unknown ? ` · 认不出需要人工看 ${summary.unknown} 行` : ''));
  return lines.join('\n');
};

/** 只读执行体（用例传假网关进来，就能钉住"只读"这件事）。 */
export const runAudit = async ({ gateway, schema }) => {
  // ⚠️ 只有这两个读；本函数里**没有**任何写调用。
  const [batchRecords, behaviorRecords] = await Promise.all([
    gateway.listAll('purchaseOrderBatch'),
    gateway.listAll('behavior'),
  ]);
  return classifyBatches({ batchRecords, behaviorRecords, schema });
};

const main = async () => {
  dotenv.config({ path: path.join(HERE, '../../.env'), quiet: true }); // 仓库根的 .env（server 的上一级）
  const lark = require('@larksuiteoapi/node-sdk');
  const { V1BitableGateway } = require('../src/services/v1BitableGateway');
  const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
  const { getLarkAgentCredentials } = require('../src/config/larkAgent');
  // 静默 logger：**不打凭证**，也不把 SDK 的请求详情刷到屏幕上（照 env-selfcheck 的约定）。
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const { appId, appSecret } = getLarkAgentCredentials();
  const gateway = new V1BitableGateway({ client: new lark.Client({ appId, appSecret, logger }) });
  const { rows, summary } = await runAudit({ gateway, schema: V1_BITABLE_SCHEMA });
  process.stdout.write(`${renderReport({ rows, summary })}\n`);
};

// 只在"直接被跑"时执行（被 import 时不跑 ⇒ 用例无需凭证）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`审计失败（只读也没读成）：${error.message}\n`);
    process.exit(1); // ⚠️ 读失败必须非零退出（不许当成"没问题"）
  });
}
