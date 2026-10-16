/**
 * ⭐⭐ **「存草稿 · 接着录」的配置**（业务负责人 2026-10-16 的口径；设计见
 *   `docs/draft-save-resume-plan-2026-10-16.md` ＋ Lead 的两页追加便条
 *   `.local/draft-plan/LEAD-ADDENDUM-2.md` / `LEAD-ADDENDUM-3.md`）。
 *
 * 为什么单独一个文件（AGENTS.md《底层工程原则》的「配置先行」）：
 *   · 草稿留多久 / 同时留几份 / 上几行 / **批次号沿用还是新建** / 事件名
 *     —— **全是会改的口径**，改的时候只动这里（或环境变量），逻辑里一行都不许写死 ✗；
 *   · 🔴 **不碰 `config/scanWrite.js`**（红线：那个文件一个字不动 ✗）——
 *     共用值**只读地复用**它（`SCAN_WRITE.session`），两边**永远不会漂移** ✓；
 *   · 与本需求无关的链路（销售 / 补货 / 退货各自的写侧）**一个字节都不参与** ✗。
 *
 * ── 她定的两条核心逻辑（逐字，**本文件是它们的唯一落点**）─────────────────────
 *
 * ① **批次号逻辑**（Lead 便条 3 逐字）：
 *    「系统需要看一下在我们的采购主表里面，**有没有未报货的批次号**。
 *      (a) **如果有，就沿用这个未报货的批次号**。(b) **如果没有，就新建一个批次号**。」
 *    ⇒ 落成 `reusePendingBatchNo`（默认 **true** = 照她说的做）；
 *      `batchNoSource` 说明号源是**既有生成器**（`services/purchaseBatchNoGenerator.js`，
 *      格式配置在 `config/purchaseBatchNo.js`）—— 本文件**不新造号格式** ✗。
 *    ⚠️ 并发口径（同一个问题她的两个草稿同时"都没有"）：`serialKey` —— 得号那一整段
 *      （回查 ⇒ 取号 ⇒ 建行）必须**整体串行**，不许各建一个新号 ✗（见 service 文件头 ③）。
 *
 * ② **供应商拆分逻辑**（同一页便条逐字）：
 *    「在**同一个报货批次号**里面，有可能会**混杂着不同的供应商**。我们在**生成报货单**的时候，
 *      需要**按照供应商进行拆分和分组**。」
 *    ⇒ **存草稿阶段【不拆】** ✓（草稿行只记 `draftScope` 与 `supplierRecordId`）；
 *      **拆的那一下是「生成报货单」** ✓（`supplierSplit.stage` = `generate_report`）。
 *      ⭐⭐ **2026-10-16 已落定**（她当天拍板 **ⓐ**：**同一批次号下**按供应商分组 ✓）：
 *        改前逐字：`batchNoPolicy: 'undecided'`（S1 当时**如实标未决** —— "拆成几单 / 几个批次号
 *          要列成问题问她"，真源在 `docs/pending-confirmations.md` 第 ② 条）；
 *        改后逐字：**从 `config/supplierSplit.js` 读**（那边是**唯一真源** ⇒ 本文件不抄第二份 ✗）；
 *        依据：业务负责人 2026-10-16 拍板 **ⓐ「同一批次号下按供应商分组」** ✓
 *          （**不是** ⓑ「每个供应商各开一个新批次号」✗）。
 *
 * ── 其余口径的出处 ────────────────────────────────────────────────────────
 *   · **存哪**：`「报货批次」/「采购主表」表的一行**（她的"草稿状态"= 到货状态「未报货」）；
 *   · **找回**：「进去就提示，接着录」⇒ 本文件给 `events.resumeNotice` / `events.expiredNotice`
 *     两个**事件名**；页面那句人话住在渲染层（S2），**配置先行** ⇒ 事件名只在这里定义 ✓；
 *   · **同时留几份**：她选的是「只留一份当前草稿」⇒ 缺省 `draftScope = 'single'` ✓
 *     （⚠️ 但同一段对话里她前一句说过「补货往往分几个供应商」⇒ 做成开关，
 *       **不替她决定成 `per_supplier`** ✗）；
 *   · **上限**：`「照 SESSION.maxLines = 50」` ⇒ 与销售本单上限**同一个数**（复用既有值 ✓）。
 */

const path = require('node:path');
const { readFlag, readInt, readString } = require('./envValue');
const { SCAN_WRITE } = require('./scanWrite');
// ⭐ 供应商拆分口径的**唯一真源**（本文件只读它 ⇒ 两边不会漂 ✓；**单向** require，不成环 ✗）。
const { SUPPLIER_SPLIT: DECIDED_SUPPLIER_SPLIT } = require('./supplierSplit');

// ── 取值域（**字面量只在这里**；逻辑里只认这些常量 ✓）────────────────────────
/** 同时留几份草稿：她选的是「只留一份当前草稿」⇒ 缺省 **single** ✓。 */
const DRAFT_SCOPE = Object.freeze({ single: 'single', perSupplier: 'per_supplier' });

/** 草稿落在「报货批次 / 采购主表」这一行的哪个语义键上（= 她的"草稿状态"）。 */
const DRAFT_STATUS_FIELD_KEY = 'arrivalStatus';

/** 草稿行的幂等键前缀 —— ⚠️ **刻意独立**：不与 `purchase_batch:*` / `purchase_request:*` 撞 ✓。 */
const DEFAULT_DRAFT_IDEMPOTENCY_PREFIX = 'scan_draft';

/**
 * ⭐⭐ 2026-10-16（本刀 S2 · **改 S1 的明细口径**）：**草稿也写明细**。
 *
 * 她的口径（**逐字** = Lead 弹窗问「草稿会不会写到采购明细」时她选的那一个）：
 *   「**草稿也写明细**」✓
 * ⚠️ 这一条**推翻了 #732 的一个假设** ✗（S1 的 `AC-D1` 当时按"**采购明细 0 次**"写 ✗）
 *   ⇒ 判据已**成对迁移**（改前逐字 → 改后逐字 → 依据，见 `test/scanDraftSaveResume.test.js`
 *     的 AC-D1 那一段）。
 *
 * 明细行的幂等键前缀 —— ⚠️ **刻意独立**：不与草稿行（`scan_draft:*`）撞、
 * 也不与真出单那两套（`purchase_request:*` / `purchase_return_doc:*`）撞 ✓。
 * ⇒ 同一份草稿存两次 ⇒ 明细**不翻倍**（`createOnceByKey` 按这把键回查）✓。
 */
const DEFAULT_DRAFT_DETAIL_IDEMPOTENCY_PREFIX = 'scan_draft_detail';

/**
 * 批次号沿用/新建的取值域。
 *   · `reuse_pending` = 她的原话（有未报货的号 ⇒ 沿用；没有 ⇒ 新建）✓ **缺省**；
 *   · 其余值**刻意不提供**：写成"总是新建"就等于违背她的口径 ⇒ 认不出的值**当场抛** ✓。
 */
const BATCH_NO_POLICIES = Object.freeze({ reusePending: 'reuse_pending' });

/** 号源（**只用于自检/文档**，值不参与逻辑 —— 免得后来人以为本文件自己造号）。 */
const BATCH_NO_SOURCE = 'services/purchaseBatchNoGenerator.js';

/**
 * 供应商拆分：她说「**生成报货单**那一下拆」✓；**批次号口径她 2026-10-16 已拍板 = ⓐ**（同一批次号下分组）。
 *
 * ⚠️ 真源在 `config/supplierSplit.js`（那边还管每组的幂等键 / "没标注供应商"的桶 / 事件名）——
 *    本文件**只读它**，**不抄第二份** ✗（抄了就一定会漂）。
 */
const SUPPLIER_SPLIT = Object.freeze({
  stage: DECIDED_SUPPLIER_SPLIT.stage,
  batchNoPolicy: DECIDED_SUPPLIER_SPLIT.batchNoPolicy,
});

/**
 * 共用块（与哪条链无关的那些）。**每次调用都重新读 env** ⇒ 用例可以传不同的 env 验
 * 「改配置即改行为」（与 `resolveMultiItemOrderConfig` 同一种形状 ✓）。
 */
const resolveShared = (env) => {
  // 🔴 **总开关**：显式布尔（`readFlag` ✓ 空串 = 关掉 ⇒ **关得掉**；认不出的值当场抛 ✗ 不静默）。
  //   缺省 **false**（先关）：S1 只有存储层，页面/路由那两半（S2/S3）还没接 ——
  //   在没有入口的时候把开关打开，等于"存草稿"这件事**没人调得到**，反而看不出没接。
  const enabled = readFlag(env, 'SCAN_DRAFT_ENABLED', false);
  const scope = readString(env, 'SCAN_DRAFT_SCOPE', DRAFT_SCOPE.single);
  if (![DRAFT_SCOPE.single, DRAFT_SCOPE.perSupplier].includes(scope)) {
    throw new Error(
      `SCAN_DRAFT_SCOPE 只能是 ${DRAFT_SCOPE.single}（只留一份，她选的）或 ${DRAFT_SCOPE.perSupplier}`
      + `（按供应商各留一份），当前值无法识别：${scope}`,
    );
  }
  const batchNoPolicy = readString(env, 'SCAN_DRAFT_BATCH_NO_POLICY', BATCH_NO_POLICIES.reusePending);
  if (batchNoPolicy !== BATCH_NO_POLICIES.reusePending) {
    throw new Error(
      `SCAN_DRAFT_BATCH_NO_POLICY 只认 ${BATCH_NO_POLICIES.reusePending}`
      + `（她 2026-10-16 逐字：有未报货的批次号 ⇒ 沿用；没有 ⇒ 新建），当前值无法识别：${batchNoPolicy}`,
    );
  }
  return {
    enabled,
    scope,
    // 草稿留多久（**她的原话**：「往往不会在当下把所有要补或要退的货一次性想好」
    //   ⇒ 12 小时（会话 TTL）太短；缺省 **7 天**，上限 90 天（防"半年前的草稿还冒出来"）。
    //   ⚠️ 与 `config/scanWrite.js` 的 `SCAN_SESSION_TTL_MS` **刻意分开**：
    //     会话过期会 `freshSession()` 把 `orders` 整段丢掉 ✗ ⇒ 草稿必须活在会话之外 ✓
    //     （这正是新开 `data/scan_drafts/` 的原因）。
    ttlMs: readInt(env, 'SCAN_DRAFT_TTL_MS', 7 * 24 * 60 * 60 * 1000, {
      min: 60_000, max: 90 * 24 * 60 * 60 * 1000,
    }),
    // 本地草稿目录（**与会话分开**：`data/scan_sessions/` 是别人的目录 ✗）。
    dir: readString(env, 'SCAN_DRAFT_DIR', path.join(__dirname, '../../data/scan_drafts')),
    dirEnvKey: 'SCAN_DRAFT_DIR',
    // 过期草稿**归档而不是删除**（便于排查；删掉就再也说不清"她那份去哪了" ✗）。
    archiveDirName: readString(env, 'SCAN_DRAFT_ARCHIVE_DIR_NAME', 'expired'),
    // 上限：**与销售本单上限同一个数**（`SESSION.maxLines` = `SCAN_SALE_MAX_LINES`，缺省 50 ✓）。
    //   ⚠️ 不写死 50（两处写死必漂 ✗）；她再改那个变量时这里跟着走 ✓。
    maxLines: SCAN_WRITE.session.maxLines,
    maxLinesEnvKey: 'SCAN_SALE_MAX_LINES',
    // 草稿行的幂等键前缀（**独立前缀** ⇒ 不与 `purchase_batch:*` 撞 ✓）。
    idempotencyPrefix: readString(env, 'SCAN_DRAFT_IDEMPOTENCY_PREFIX', DEFAULT_DRAFT_IDEMPOTENCY_PREFIX),
    // 批次号口径
    reusePendingBatchNo: batchNoPolicy === BATCH_NO_POLICIES.reusePending,
    batchNoPolicy,
    batchNoSource: BATCH_NO_SOURCE,
    // 得号那一整段（回查 ⇒ 取号 ⇒ 建行）的**串行键**（并发保护的落点；见 service 文件头 ③）。
    serialKey: readString(env, 'SCAN_DRAFT_SERIAL_KEY', 'scan_draft_batch_no'),
    // 存草稿要写的那个"草稿状态"取值（**不写死中文** ✗ —— 它是她在表里加的选项）。
    //   ⚠️ 取值必须与真表 `property.options` 一致（往单选里写不存在的取值，飞书会**自动新建选项**、
    //     把表污染掉 —— AGENTS.md 第 11 条① 的真实事故形态）。
    statusValue: readString(env, 'SCAN_DRAFT_STATUS_VALUE', '未报货'),
    // 供应商拆分（未决项**如实标**，不许替她定 ✗）
    supplierSplit: readString(env, 'SCAN_DRAFT_SUPPLIER_SPLIT_STAGE', SUPPLIER_SPLIT.stage),
    // 表侧落点（表 / 字段全部从 `config/v1BitableSchema.js` 取 ⇒ 本文件**不写中文列名** ✗）
    tableKey: readString(env, 'SCAN_DRAFT_TABLE_KEY', 'purchaseOrderBatch'),
    statusFieldKey: readString(env, 'SCAN_DRAFT_STATUS_FIELD_KEY', DRAFT_STATUS_FIELD_KEY),
    // ⭐⭐ 2026-10-16（她：「**草稿也写明细**」）：明细那一半的落点 ——
    //   表 / 列名同样**只从 schema 的语义键取**（本文件一个中文列名都不写 ✗）。
    detailTableKey: readString(env, 'SCAN_DRAFT_DETAIL_TABLE_KEY', 'purchaseRequest'),
    detailIdempotencyPrefix: readString(
      env, 'SCAN_DRAFT_DETAIL_IDEMPOTENCY_PREFIX', DEFAULT_DRAFT_DETAIL_IDEMPOTENCY_PREFIX,
    ),
  };
};

/** 事件名（日志口径；排查时按它们 grep ✓）。全部可配 ⇒ 改名不用改逻辑 ✓。 */
const resolveEvents = (env) => Object.freeze({
  saved: readString(env, 'SCAN_DRAFT_EVENT_SAVED', 'scan.draft.saved'),
  // ⭐ `single` 下第二次存**覆盖**第一份 ⇒ **必须留痕**（不许静默覆盖 ✗，设计 §3.4）
  overwritten: readString(env, 'SCAN_DRAFT_EVENT_OVERWRITTEN', 'scan.draft.overwritten'),
  resumed: readString(env, 'SCAN_DRAFT_EVENT_RESUMED', 'scan.draft.resumed'),
  missing: readString(env, 'SCAN_DRAFT_EVENT_MISSING', 'scan.draft.missing'),
  expired: readString(env, 'SCAN_DRAFT_EVENT_EXPIRED', 'scan.draft.expired'),
  corrupt: readString(env, 'SCAN_DRAFT_EVENT_CORRUPT', 'scan.draft.corrupt'),
  // 她主动点【不管它，重新开一单】⇒ **归档不删除**（"删/留"她还没拍，别替她定 ✗）
  discarded: readString(env, 'SCAN_DRAFT_EVENT_DISCARDED', 'scan.draft.discarded'),
  batchReused: readString(env, 'SCAN_DRAFT_EVENT_BATCH_REUSED', 'scan.draft.batch_reused'),
  batchCreated: readString(env, 'SCAN_DRAFT_EVENT_BATCH_CREATED', 'scan.draft.batch_created'),
  tableWriteFailed: readString(env, 'SCAN_DRAFT_EVENT_TABLE_WRITE_FAILED', 'scan.draft.table_write_failed'),
  writeRejected: readString(env, 'SCAN_DRAFT_EVENT_WRITE_REJECTED', 'scan.draft.write_rejected'),
  // ⭐⭐ 她 2026-10-16「草稿也写明细」那一半的两条留痕：
  //   · 写成功（几条新建 / 几条命中幂等）；
  //   · 这一行**没写成**（尺码解析不到 / 数量不是正整数 / 写库失败）—— **不静默** ✗。
  detailsWritten: readString(env, 'SCAN_DRAFT_EVENT_DETAILS_WRITTEN', 'scan.draft.details_written'),
  detailSkipped: readString(env, 'SCAN_DRAFT_EVENT_DETAIL_SKIPPED', 'scan.draft.detail_skipped'),
  detailWriteFailed: readString(env, 'SCAN_DRAFT_EVENT_DETAIL_WRITE_FAILED', 'scan.draft.detail_write_failed'),
});

/**
 * 全部**用户可见文案**（渲染层 / service 都不许散写中文 ✗）。
 * ⚠️ S1 只把话说**算好放在返回值里**（`message`）—— 页面怎么渲（S2）不在这里 ✗。
 */
const resolveTexts = (env) => Object.freeze({
  emptyDraft: readString(env, 'SCAN_DRAFT_TEXT_EMPTY', '这一份草稿里还什么都没有，先加一件再存。'),
  tooManyLines: readString(
    env, 'SCAN_DRAFT_TEXT_TOO_MANY_LINES',
    '这一份草稿最多 {max} 行（现在 {count} 行）——拆成两单再存。',
  ),
  missing: readString(env, 'SCAN_DRAFT_TEXT_MISSING', '没有找到没录完的草稿，重新开一单就行。'),
  expired: readString(
    env, 'SCAN_DRAFT_TEXT_EXPIRED',
    '上一份草稿已经过期了（留着超过 {days} 天），已经帮你归档，重新开一单就行。',
  ),
  corrupt: readString(
    env, 'SCAN_DRAFT_TEXT_CORRUPT',
    '这一份草稿读不出来了（文件坏了），已经原样留着，先重新开一单。',
  ),
  overwritten: readString(
    env, 'SCAN_DRAFT_TEXT_OVERWRITTEN',
    '上一份草稿已经被这一次覆盖（{scope} 口径：同时只留一份）。',
  ),
  tableWriteFailed: readString(
    env, 'SCAN_DRAFT_TEXT_TABLE_WRITE_FAILED',
    '草稿没能存进飞书表，先别关这一页 —— 本地那一份还在。',
  ),
  tableKeyMissing: readString(
    env, 'SCAN_DRAFT_TEXT_TABLE_KEY_MISSING',
    '草稿存不进飞书表（这一列还没配上），先别关这一页。',
  ),
});

/**
 * 解析一份配置。
 * @param {object} [env] 默认 `process.env`
 */
const resolveScanDraftConfig = (env = process.env) => {
  const shared = resolveShared(env);
  return Object.freeze({
    ...shared,
    events: resolveEvents(env),
    texts: resolveTexts(env),
    // 并发保护的那把键的**兜底**（调用方可以注入 `keyOf` 覆盖 —— 用例就靠它把两个并发调用
    //   逼到**同一把键**上，从而证明"串行真的生效"✓）。
    concurrentKeyFallback: readString(env, 'SCAN_DRAFT_CONCURRENT_KEY', 'scan_draft'),
  });
};

/** 默认那一份（进程级；跟 `process.env` 走）。 */
const SCAN_DRAFT = resolveScanDraftConfig();

module.exports = {
  resolveScanDraftConfig,
  resolveShared,
  resolveEvents,
  resolveTexts,
  SCAN_DRAFT,
  DRAFT_SCOPE,
  BATCH_NO_POLICIES,
  DRAFT_STATUS_FIELD_KEY,
  DEFAULT_DRAFT_IDEMPOTENCY_PREFIX,
  DEFAULT_DRAFT_DETAIL_IDEMPOTENCY_PREFIX,
  BATCH_NO_SOURCE,
  SUPPLIER_SPLIT,
};
