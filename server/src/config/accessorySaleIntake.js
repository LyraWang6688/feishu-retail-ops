'use strict';

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：她新建了一张「**配品销售**」表
 *   ——「我新增了一个数据表，叫做**配品销售**……**这就相当于实际上我们只是换了一个让用户交互的入口**。
 *      但是我们**一旦收到这样的一个请求，还是要做同样的处理：销售主表、销售明细以及收款明细**」
 *
 * 本模块只放"**入口那半边**"的配置（配置先行 ✓ 一个字都不硬编码 ✗）：
 *   · 哪张表（`tableId`）· 哪几列（`fields`）· 哪个动作才处理（`events`）· 总开关（`enabled`）
 *   · **回写**（她 2026-10-15 拍板要那两列 ⇒ **默认开**）：列名与两个取值都可配 ✓
 *
 * 取值规则沿用 `config/envValue`：**没设 → 默认值**；**设了（含空串）→ 显式取值**；认不出**当场抛**。
 *
 * 🔴 三条纪律（照 task-19 / Lead 裁决）：
 *   ① **「销售日」一个字都不写**（她逐字：「**销售日不用管，自动字段**」）——
 *      她的总规矩是"**只有收款时间由代码写**，其它时间列一律飞书自动" ✓ 本模块只**声明**它（只为读事件用），
 *      **绝不**把它写进任何请求 ✗
 *   ② **回写默认开**，但**列不在 ⇒ 不报错、只记日志**（**不许假写** ✗）：
 *      飞书对"写不存在的列"是报错的 ⇒ 调用方只能"试写 + 失败只记日志"（见 service）✓
 *   ③ `tableId` **可配**（不是硬编码常量）⇒ 她换表/换环境只改 env ✓
 */
const { readString, readFlag } = require('./envValue');

// 她那张表的 table_id（Lead 已按 table_id 只读核过 ✓）。**可配**，这个只是默认值。
const DEFAULT_ACCESSORY_SALE_TABLE_ID = 'tblkT1QTUsESnl5b';

const ACCESSORY_SALE_TABLE_ID_ENV_KEY = 'ACCESSORY_SALE_INTAKE_TABLE_ID';
const ACCESSORY_SALE_ENABLED_ENV_KEY = 'ACCESSORY_SALE_INTAKE_ENABLED';
const ACCESSORY_SALE_WRITEBACK_ENABLED_ENV_KEY = 'ACCESSORY_SALE_INTAKE_WRITEBACK_ENABLED';

/** 列名（照她那张表的真列名；**全部可配** ⇒ 她改列名只改配置 ✓）。 */
const ACCESSORY_SALE_FIELDS = Object.freeze({
  name: '名称',                 // 关联 ⇒ 拿配品 **record_id**
  quantity: '数量',             // 数字（缺省 1）
  paymentMethod: '收款方式',     // 关联 ⇒ 拿**名字/值**（写收款明细用）
  amount: '金额',               // 数字（缺失 / ≤0 ⇒ 拒单）
  saleDate: '销售日',           // 🔴 **只声明、绝不写**（她：「不用管，自动字段」）
});

/** 回写那两列（她 2026-10-15 确认要加 ⇒ **默认开**）。 */
const ACCESSORY_SALE_WRITEBACK = Object.freeze({
  enabled: true,
  statusField: '写入状态',
  reasonField: '失败原因',
  doneValue: '已写入',
  failedValue: '写入失败',
});

/**
 * ⭐ 拒单时**写回「失败原因」那一列的原文**（她能在表里直接读到 ⇒ 属于**用户可见文案**）。
 *
 * ⚠️ 为什么放在 config 而不是 service 里：`test/noHardcodedChinese.test.js` 的守门口径
 *   ——「`src/services/**` 里**不许新增**硬编码的用户可见中文；文案的家在 `src/config/**`」。
 *   2026-10-15 第一版把这几句写死在 service 里 ⇒ 那条闸门**当场红**（如实报了 6 处），
 *   这一版按同一条纪律抽到这里 ✓ 顺序仍是「先写后做」：口径在文件里，不在谁的记忆里 ✓。
 */
const ACCESSORY_SALE_REASONS = Object.freeze({
  nameMissing: '「名称」没填（或关联记录取不到）⇒ 不知道卖的是哪件配品',
  amountInvalid: (raw) => `「金额」缺失或不合法（${raw == null || raw === '' ? '空' : raw}）⇒ 不记这一笔`,
  quantityInvalid: (raw) => `「数量」不合法（${raw}）⇒ 不记这一笔`,
  // 🔴 数量 > 1 ⇒ **如实拒单**（绝不静默按 1 记 ✗）；原因里必须说清"一次只记 1 件"（她/Lead 点名）
  quantityMultiple: (raw) => `这一版一次只记 1 件（她填了 ${raw} 件）⇒ 多件待支持`,
  paymentMethodMissing: '「收款方式」取不到 ⇒ 不敢猜一个方式',
  fallbackUnavailable: (missing) => `事件未带全（缺：${(missing || []).join('/')}）且无法回退读表`,
});

/**
 * 解析入口配置。
 * ⚠️ `events.created` 取值与「货品信息 → 标签二维码」那条**同一口径**（`record_added` ✓
 *    `config/tagQrCode.js:132`）——她那张表是**新增一行**就办，编辑不重复办 ✗。
 */
const resolveAccessorySaleIntakeConfig = (env = process.env) => ({
  enabled: readFlag(env, ACCESSORY_SALE_ENABLED_ENV_KEY, true),
  tableId: readString(env, ACCESSORY_SALE_TABLE_ID_ENV_KEY, DEFAULT_ACCESSORY_SALE_TABLE_ID),
  fields: ACCESSORY_SALE_FIELDS,
  // ⚠️ 事件 `after_value` 里带的是**飞书列 id**（`fldxxxx`）⇒ 想走"主路径零读取"就要在这里
  //   配列 id（可配 ✓，不写死 ✗）。**没配** ⇒ 事件里的值认不出 ⇒ 自动走 `getByTableId` 兜底读表
  //   （**如实 warn**，不是静默、也不是错 ✗）—— 两条路都能办成事 ✓
  fieldIds: Object.freeze({
    // ⭐ Lead 2026-10-15 只读核过她那张表拿到的真列 id ⇒ **写进默认值**（配置先行：默认在 config 里，
    //   **不要求她配环境变量** ✓；列 id 将来若有变，改配置即可 ✓）。env 仍可覆盖 ✓
    name: readString(env, 'ACCESSORY_SALE_INTAKE_FIELD_ID_NAME', 'fld0V3ausF'),
    quantity: readString(env, 'ACCESSORY_SALE_INTAKE_FIELD_ID_QUANTITY', 'fldlFzpHKn'),
    paymentMethod: readString(env, 'ACCESSORY_SALE_INTAKE_FIELD_ID_PAYMENT_METHOD', 'fldxPeh9zl'),
    amount: readString(env, 'ACCESSORY_SALE_INTAKE_FIELD_ID_AMOUNT', 'fldVfSOmDg'),
    // ⚠️「销售日」(`fldyGccTWp`, 日期) 只**声明读用**；**零写入点** ✓（她：「销售日不用管，自动字段」）
    saleDate: readString(env, 'ACCESSORY_SALE_INTAKE_FIELD_ID_SALE_DATE', 'fldyGccTWp'),
  }),
  events: { created: Object.freeze(['record_added']) },
  // 写回「失败原因」那一列的人话原文（**可注入/可覆盖** ✓，与字段名同一套配置先行口径）
  reasons: ACCESSORY_SALE_REASONS,
  writeBack: Object.freeze({
    ...ACCESSORY_SALE_WRITEBACK,
    enabled: readFlag(env, ACCESSORY_SALE_WRITEBACK_ENABLED_ENV_KEY, ACCESSORY_SALE_WRITEBACK.enabled),
  }),
});

module.exports = {
  ACCESSORY_SALE_TABLE_ID_ENV_KEY,
  ACCESSORY_SALE_ENABLED_ENV_KEY,
  ACCESSORY_SALE_WRITEBACK_ENABLED_ENV_KEY,
  DEFAULT_ACCESSORY_SALE_TABLE_ID,
  ACCESSORY_SALE_FIELDS,
  ACCESSORY_SALE_WRITEBACK,
  ACCESSORY_SALE_REASONS,
  resolveAccessorySaleIntakeConfig,
};
