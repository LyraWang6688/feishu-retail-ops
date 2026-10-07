// 「报货批次」表上的**到货状态**配置（业务负责人 2026-10-07 拍板）。
//
// 她的口径（逐字）：
//   「同步完之后，**采购批次这个数据表主要控制的是该批次的到货情况（是退货还是采购）**。
//    关于到货情况：
//    1. **每创建一条新记录时，默认值是「未到货」**
//    2. **当用户在话题群里说了到货之后，状态应该改成「已到货」**
//    所以**你每天 9 点发通知的时候，看未到货的情况就直接去那个表里查**」
//
// ── 为什么字面量放在这里、而不是写在 service 里 ───────────────────────────────
//   · 它是**业务口径**（会改：她哪天想把"未到货"改成"待到货"就改这里/环境变量）；
//   · 更关键：往飞书的**单选**字段里写一个不存在的取值，飞书会**自动新建一个选项**
//     —— 表被悄悄污染，而 9 点推送按「未到货」查会**静默查不到**（AGENTS.md 第 11 条① 的真实事故形态）。
//     所以这两个字面量必须**对着真表字段元数据核对**：`server/scripts/validate_v1_schema.js`
//     会把它们当作契约（`property.options` 必须含这两个名字），
//     **部署前跑 `pnpm run v1:schema-check:all` 就能拦住**。
//
// ⚠️ 与「报货信息」上那一列「到货状态」**不是同一列**（表名沿革：原「具体信息」→「单据信息」→「采购申请」）：
//    那一列业务负责人已从生产表删除，代码里指向它的映射与写入点也一并删掉了
//    （见 `config/v1BitableSchema.js` 的注释）。

const { readString } = require('./envValue');

const PURCHASE_ARRIVAL_STATUS_PENDING_ENV_KEY = 'PURCHASE_ARRIVAL_STATUS_PENDING';
const PURCHASE_ARRIVAL_STATUS_ARRIVED_ENV_KEY = 'PURCHASE_ARRIVAL_STATUS_ARRIVED';

// 新建「报货批次」记录时显式写的那个取值（她说字段默认值就是这个）。
const DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING = '未到货';
// 到货核对**确认成功之后**改成的那个取值。
const DEFAULT_PURCHASE_ARRIVAL_STATUS_ARRIVED = '已到货';

// schema 里的**语义键**（`V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.arrivalStatus`）。
// 放在这里是为了让"闸门要对哪一列做契约校验"与"service 要写哪一列"共用同一处声明。
const PURCHASE_ARRIVAL_STATUS_FIELD_KEY = 'arrivalStatus';

const resolvePurchaseArrivalStatusConfig = (env = process.env) => {
  const pending = readString(
    env, PURCHASE_ARRIVAL_STATUS_PENDING_ENV_KEY, DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING,
  );
  const arrived = readString(
    env, PURCHASE_ARRIVAL_STATUS_ARRIVED_ENV_KEY, DEFAULT_PURCHASE_ARRIVAL_STATUS_ARRIVED,
  );
  if (!String(pending || '').trim()) {
    throw new Error(`${PURCHASE_ARRIVAL_STATUS_PENDING_ENV_KEY} 不能是空串（新建批次记录时要显式写它）`);
  }
  if (!String(arrived || '').trim()) {
    throw new Error(`${PURCHASE_ARRIVAL_STATUS_ARRIVED_ENV_KEY} 不能是空串（到货确认成功之后要写它）`);
  }
  if (pending === arrived) {
    throw new Error(`「未到货」与「已到货」不能是同一个取值（当前都是「${pending}」），否则到货状态永远看不出变化`);
  }
  return Object.freeze({ pending: String(pending), arrived: String(arrived) });
};

/**
 * 部署闸门用的「单选取值契约」：`[{ tableKey, fieldKey, requiredOptions }]`。
 * 只回答「真表这一列是单选、且含这两个取值」——**只读**，不写任何东西。
 */
const purchaseArrivalStatusOptionContract = (env = process.env) => {
  const { pending, arrived } = resolvePurchaseArrivalStatusConfig(env);
  return [{
    tableKey: 'purchaseOrderBatch',
    fieldKey: PURCHASE_ARRIVAL_STATUS_FIELD_KEY,
    requiredOptions: [pending, arrived],
  }];
};

module.exports = {
  PURCHASE_ARRIVAL_STATUS_PENDING_ENV_KEY,
  PURCHASE_ARRIVAL_STATUS_ARRIVED_ENV_KEY,
  DEFAULT_PURCHASE_ARRIVAL_STATUS_PENDING,
  DEFAULT_PURCHASE_ARRIVAL_STATUS_ARRIVED,
  PURCHASE_ARRIVAL_STATUS_FIELD_KEY,
  resolvePurchaseArrivalStatusConfig,
  purchaseArrivalStatusOptionContract,
};
