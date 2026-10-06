// 「销售主表」旧字段 → 四个新状态字段的**一次性回填**口径（配置先行）。
//
// 背景（业务负责人 2026-10-06）：
//   · 旧的「确认状态」被她改名为「确认状态（旧）」（选项和历史值都还在，只是改了名）；
//   · 新的四个字段（确认状态 / 销售状态 / 资金状态 / 库存状态）是**本次新建的，
//     76 条历史单子全是空的**；
//   · 她明确：旧的两个字段（「确认状态（旧）」「订单状态」）**代码里解耦、后续不再使用**，
//     表里先留着、她之后自己删。
//
// ⇒ 所以「历史单子在新字段上是什么值」只能靠**一次性的回填**补上；本模块就是那次回填的
//   **口径 + 纯函数**（怎么算），CLI 在 `scripts/backfill-sales-status.js`（怎么跑）。
//   两者分开是为了让「会改哪几条、改成什么」可以被单测穷举，而不是埋在 IO 里。
//
// 🔴 本次**只回填 确认状态 / 资金状态**这两维：
//   · 资金状态 ← 旧「确认状态（旧）」的 已入账 / 入账失败；
//   · 确认状态 ← 旧「确认状态（旧）」的 待确认 / 已取消 / 待修改。
//   ⚠️ 「销售状态」「库存状态」**刻意不回填**：旧字段里没有它们的直接来源，
//      要从「销售明细」「库存流水」反推才行——那是另一件事，不在本次范围。
//
// ⚠️ 值域（BACKFILL_VALUES）必须与 config/salesStatusDimensions.js 的值域逐字一致：
//    回填写进去的值会**永久留在飞书单选的选项里**，写错一个就多一个脏选项。

// 旧字段：本次唯一的数据来源。**字段名钉死在这里**（她之后可能把这一列删掉，
// 删了之后这个脚本会先在前置检查里报"字段不存在"，而不是静默改成 0 条）。
const BACKFILL_LEGACY_CONFIRM_FIELD = '确认状态（旧）';

// 新字段：本次回填的两个目标列。语义键与 v1BitableSchema.tables.salesEntry.fields 对齐。
const BACKFILL_TARGET_FIELDS = Object.freeze({
  userAction: '确认状态',
  funds: '资金状态',
});

// 本次**不回填**的两个维度（写在这里是为了让"不回填"这件事也能被断言到）。
// 语义键给机器看，字段名给影响清单看（她要读的是「销售状态 / 库存状态」，不是 sales / stock）。
const BACKFILL_EXCLUDED_DIMENSIONS = Object.freeze(['sales', 'stock']);
const BACKFILL_EXCLUDED_FIELDS = Object.freeze(['销售状态', '库存状态']);

const BACKFILL_VALUES = Object.freeze({
  userAction: Object.freeze({
    PENDING: '未确认',
    CANCELLED: '已取消',
    TO_MODIFY: '待修改',
  }),
  funds: Object.freeze({
    WRITTEN: '已写入',
    FAILED: '写入失败',
  }),
});

/**
 * 回填规则。**顺序 = 影响清单里的展示顺序**。
 *
 * `dimension: null` = 这一条**刻意不写任何字段**，但要留一句人看得懂的理由
 * （她要看这份清单做决定，所以"为什么不改"必须和"改成什么"一样清楚）。
 */
const BACKFILL_RULES = Object.freeze([
  Object.freeze({
    legacy: '已入账',
    dimension: 'funds',
    value: BACKFILL_VALUES.funds.WRITTEN,
    note: '钱已经记上了 → 资金状态 = 已写入',
  }),
  Object.freeze({
    legacy: '入账失败',
    dimension: 'funds',
    value: BACKFILL_VALUES.funds.FAILED,
    note: '钱没记上 → 资金状态 = 写入失败',
  }),
  Object.freeze({
    legacy: '入账中',
    dimension: null,
    value: '',
    // 为什么留空、而不是写「未写入」：
    //   · 「入账中」只说明"当时开始写了"，**并不能说明收款明细到底写没写**。
    //     写「未写入」是替历史编一个事实；写「已写入」更没依据。
    //   · 留空时读取会**退回旧字段**（postedOf 的双读），读到的还是「入账中」，
    //     6 处闸门保持关闭 —— 与今天的行为**逐字一致**，不会因为回填把状态改错。
    //   · 留空是可逆的：她之后人工核对完，随时可以自己填。
    note: '状态未知 → 留空（不知道收款明细写没写；留空时读取会退回「入账中」，闸门保持关闭）',
  }),
  Object.freeze({
    legacy: '待确认',
    dimension: 'userAction',
    value: BACKFILL_VALUES.userAction.PENDING,
    note: '用户还没点确认 → 确认状态 = 未确认（资金状态留空）',
  }),
  Object.freeze({
    legacy: '已取消',
    dimension: 'userAction',
    value: BACKFILL_VALUES.userAction.CANCELLED,
    note: '用户点了取消 → 确认状态 = 已取消',
  }),
  Object.freeze({
    legacy: '待修改',
    dimension: 'userAction',
    value: BACKFILL_VALUES.userAction.TO_MODIFY,
    note: '用户点了修改 → 确认状态 = 待修改',
  }),
]);

// 本模块与 salesStatusDimensions 一样保持**纯函数、零依赖**（config 层不引 service）。
const cellText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

const ruleFor = (legacyValue) => BACKFILL_RULES.find((rule) => rule.legacy === legacyValue) || null;

/**
 * 把一张销售主表记录算成一条"回填计划"。
 *
 * 计划项的形状（`changes` 为空 = 这条不会被改）：
 *   { recordId, orderNo, legacyValue, action: 'update'|'skip', changes: [{semanticKey, field, from, to}], reason }
 */
const planRecord = (record, { fieldNames = {} } = {}) => {
  const legacyField = fieldNames.legacyConfirm || BACKFILL_LEGACY_CONFIRM_FIELD;
  const orderNoField = fieldNames.orderNo || '销售单号';
  const targets = {
    userAction: fieldNames.userAction || BACKFILL_TARGET_FIELDS.userAction,
    funds: fieldNames.funds || BACKFILL_TARGET_FIELDS.funds,
  };
  const fields = record?.fields || {};
  const recordId = record?.record_id || '';
  const legacyValue = cellText(fields[legacyField]).trim();
  const item = {
    recordId,
    orderNo: cellText(fields[orderNoField]).trim(),
    legacyValue,
    action: 'skip',
    changes: [],
    reason: '',
  };
  if (!recordId) {
    item.reason = '记录缺 record_id：跳过';
    return item;
  }
  if (!legacyValue) {
    // 旧字段是空的：这一列没有信息，**不猜**。
    item.reason = '旧字段为空：没有可回填的信息，跳过';
    return item;
  }
  const rule = ruleFor(legacyValue);
  if (!rule) {
    // 表里冒出规则之外的值（她手工改过、或以后加了新选项）：宁可什么都不写，
    // 也不要把一个没定义过的值映射到新字段上——写错的值会永久留在选项里。
    item.reason = `旧字段的值「${legacyValue}」没有回填规则：不猜，跳过`;
    return item;
  }
  if (!rule.dimension) {
    item.reason = rule.note;
    return item;
  }
  const field = targets[rule.dimension];
  const current = cellText(fields[field]).trim();
  if (current) {
    // 新字段已经有值 = 新链路已经写过它了。那次写入比这次回填更接近事实，**不覆盖**。
    // （这条同时让脚本可以安全地重复跑：第二次跑不会把第一次的结果改回去。）
    item.reason = `「${field}」已有值「${current}」：不覆盖（新链路写的事实比回填可信）`;
    return item;
  }
  item.action = 'update';
  item.dimension = rule.dimension;
  item.reason = rule.note;
  item.changes = [{ semanticKey: rule.dimension, field, from: current, to: rule.value }];
  return item;
};

/** 汇总：给影响清单用的计数（按维度、按旧值分布）。 */
const summarizePlan = (items = []) => {
  const byDimension = { userAction: 0, funds: 0 };
  let willUpdate = 0;
  for (const item of items) {
    if (item.action !== 'update') continue;
    willUpdate += 1;
    byDimension[item.dimension] = (byDimension[item.dimension] || 0) + 1;
  }
  // 旧值分布：先按规则顺序列已知值，再补上表里实际出现的其它值（例如空值、未定义值）。
  const counts = new Map();
  for (const item of items) counts.set(item.legacyValue, (counts.get(item.legacyValue) || 0) + 1);
  const ordered = [];
  for (const rule of BACKFILL_RULES) {
    if (!counts.has(rule.legacy)) continue;
    const rows = items.filter((item) => item.legacyValue === rule.legacy);
    ordered.push({
      legacyValue: rule.legacy,
      count: counts.get(rule.legacy),
      willUpdate: rows.filter((item) => item.action === 'update').length,
      outcome: rule.note,
    });
    counts.delete(rule.legacy);
  }
  for (const [legacyValue, count] of counts) {
    ordered.push({
      legacyValue,
      count,
      willUpdate: 0,
      outcome: legacyValue ? '未定义的值 → 不改' : '旧字段为空 → 不改',
    });
  }
  return {
    scanned: items.length,
    willUpdate,
    skipped: items.length - willUpdate,
    byDimension,
    byLegacyValue: ordered,
    notBackfilledDimensions: [...BACKFILL_EXCLUDED_FIELDS],
  };
};

/** 记录集合 → { items, summary }。 */
const planBackfill = (records, options = {}) => {
  const items = (records || []).map((record) => planRecord(record, options));
  return { items, summary: summarizePlan(items) };
};

// token 只以**指纹**出现：不打印任何 secret 值（连前 4 位都不给）。
const fingerprint = (token) => {
  const raw = String(token || '');
  if (!raw) return '(未配置)';
  // eslint-disable-next-line global-require
  const { createHash } = require('node:crypto');
  return `sha256:${createHash('sha256').update(raw).digest('hex').slice(0, 8)}`;
};

/**
 * 🔴 硬闸门：**真跑只允许打测试 Base**。
 *
 * 判据是"目标 app_token 与测试 Base 的 app_token **逐字相等**"——
 * 不依赖 FEISHU_TARGET_ENV，也不给 FEISHU_ALLOW_PRODUCTION_WRITE 留后门：
 * 哪一个 Base 是生产，只有运维知道，脚本不该替她猜。
 *
 * · dry-run（默认）任何时候都允许：它只读、不写。
 * · --apply 只在 `appToken === testAppToken` 时允许；否则当场抛错，
 *   错误信息里只说"不等于测试 Base"，不回显 token。
 */
const assertBackfillTarget = ({ appToken, testAppToken, apply = false, scriptName = 'backfill-sales-status' } = {}) => {
  const token = String(appToken || '').trim();
  const testToken = String(testAppToken || '').trim();
  if (!token) {
    throw new Error(`${scriptName}：没有配置目标 Base（FEISHU_V1_BITABLE_APP_TOKEN），拒绝运行`);
  }
  if (!apply) return { appToken: token, targetIsTestBase: Boolean(testToken) && token === testToken };
  if (!testToken) {
    throw new Error(`${scriptName}：没有配置测试 Base（FEISHU_V1_E2E_TEST_APP_TOKEN），`
      + '无法证明目标是测试 Base → 拒绝真跑（只允许 --dry-run）');
  }
  if (token !== testToken) {
    throw new Error(`${scriptName}：目标 Base 不是测试 Base → 拒绝真跑（生产只允许 --dry-run）。`
      + `目标 ${fingerprint(token)} ≠ 测试 ${fingerprint(testToken)}`);
  }
  return { appToken: token, targetIsTestBase: true };
};

/**
 * 人看得懂的影响清单（她要拿这个做决定）。
 *
 * ⚠️ 纯字符串拼装，方便单测钉住"哪几句话必须在"。
 */
const formatImpactList = ({
  plan,
  mode = 'dry-run',
  appToken = '',
  testAppToken = '',
  tableName = '销售主表',
  tableId = '',
  envLabel = '',
  sampleSize = 3,
} = {}) => {
  const { items = [], summary = summarizePlan([]) } = plan || {};
  const isTestBase = Boolean(appToken) && String(appToken) === String(testAppToken);
  const lines = [];
  lines.push('=== 销售主表「状态字段」回填 · 影响清单 ===');
  lines.push(`模式        : ${mode === 'apply' ? 'APPLY（会写入！）' : 'DRY-RUN（只读，一个字都不写）'}`);
  lines.push(`目标环境    : FEISHU_TARGET_ENV=${envLabel || '(未设置)'}`);
  lines.push(`目标 Base   : ${fingerprint(appToken)}${isTestBase ? '（= 测试 Base ✓）' : '（≠ 测试 Base：只允许干跑）'}`);
  lines.push(`目标表      : ${tableName}${tableId ? `（table_id ${tableId}）` : ''}`);
  lines.push(`数据来源    : 「${BACKFILL_LEGACY_CONFIRM_FIELD}」→ 「${BACKFILL_TARGET_FIELDS.userAction}」/「${BACKFILL_TARGET_FIELDS.funds}」`);
  lines.push('');
  lines.push(`扫描记录    : ${summary.scanned} 条`);
  lines.push(`会修改      : ${summary.willUpdate} 条`
    + `（确认状态 ${summary.byDimension.userAction || 0} 条 / 资金状态 ${summary.byDimension.funds || 0} 条）`);
  lines.push(`不改        : ${summary.skipped} 条`);
  lines.push('');
  lines.push('【按旧字段「确认状态（旧）」的值分布】');
  if (!summary.byLegacyValue.length) lines.push('  （无记录）');
  for (const row of summary.byLegacyValue) {
    const label = row.legacyValue ? `「${row.legacyValue}」` : '（空）';
    lines.push(`  ${label.padEnd(12, ' ')} ${String(row.count).padStart(4, ' ')} 条`
      + `  会改 ${String(row.willUpdate).padStart(4, ' ')} 条  → ${row.outcome}`);
  }
  lines.push('');
  lines.push('【本次刻意不回填的维度】');
  lines.push(`  ${summary.notBackfilledDimensions.join(' / ')}`
    + ' —— 旧字段里没有直接来源（要从「销售明细」「库存流水」反推），另做。');
  const samples = items.filter((item) => item.action === 'update').slice(0, Math.max(0, sampleSize));
  lines.push('');
  lines.push(`【示例（会改的前 ${samples.length} 条）】`);
  if (!samples.length) lines.push('  （没有会被修改的记录）');
  samples.forEach((item, index) => {
    const change = item.changes[0];
    lines.push(`  ${index + 1}) ${item.recordId}${item.orderNo ? `  销售单号 ${item.orderNo}` : ''}`
      + `  「${BACKFILL_LEGACY_CONFIRM_FIELD}」= ${item.legacyValue}`);
    lines.push(`       ${change.field}：「${change.from}」 → 「${change.to}」`);
  });
  const skippedReasons = items.filter((item) => item.action !== 'update' && item.legacyValue);
  if (skippedReasons.length) {
    lines.push('');
    lines.push('【会跳过、但有说法的记录（各举 1 条）】');
    const seen = new Set();
    for (const item of skippedReasons) {
      const key = `${item.legacyValue}|${item.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  · ${item.recordId}  「${item.legacyValue}」→ ${item.reason}`);
    }
  }
  return lines.join('\n');
};

module.exports = {
  BACKFILL_LEGACY_CONFIRM_FIELD,
  BACKFILL_TARGET_FIELDS,
  BACKFILL_EXCLUDED_DIMENSIONS,
  BACKFILL_EXCLUDED_FIELDS,
  BACKFILL_VALUES,
  BACKFILL_RULES,
  cellText,
  ruleFor,
  planRecord,
  summarizePlan,
  planBackfill,
  fingerprint,
  assertBackfillTarget,
  formatImpactList,
};
