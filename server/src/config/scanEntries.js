'use strict';

/**
 * 「**扫一扫**」五处 —— **一份登记表**（业务负责人 2026-10-16 21:2x 逐字，口径见
 *   `docs/scan-five-places-2026-10-16.md`）。
 *
 * 她的原话（逐字）：
 *   「**一共 5 处扫一扫**：① **标签打印的扫一扫** —— 为了打印标签；② **四个领域共用那一颗**
 *    （领域条上的全局扫一扫）—— **不带历史数据**；③④⑤ **三个领域的「再加一单」**
 *    （销售 / 补货 / 退货）—— 也是弹二维码，**扫完回到当前领域 ＋ 带着之前的数据**。
 *    ⇒ **本质是一件事**：**点按钮 ⇒ 弹二维码框** ✓ **差别只有两处**：**① 扫完回到哪 ② 带不带之前的数据**」
 *
 * ⇒ 本文件的模型就是她那句：**每一处只登记两个参数** ——
 *    · `returnsToRealm`（**扫完回哪**：回当前领域 / 不回）
 *    · `keepDraft`（**带不带之前的数据**：本单草稿）
 *    ＋ 两个实现参数（`mechanism` = 用哪套机制、`mode` = 独立扫 / 领域内扫）**只用来对号入座**，
 *      不用来分叉业务语义 ✗。
 *
 * 🔴 四条纪律（Lead 2026-10-16 派活逐字）：
 *   ① **不许一个领域一个领域地补** ✗ —— 新入口一律走同一处件、只传上面那两个参数；
 *      要加第 6 处 ⇒ **先在本表登记**（`placeById` 认不出就**当场抛**，不猜 ✗）；
 *   ② **配置先行**：哪处用哪套 / 带不带 / 文案 ⇒ 全在这里（**显式布尔** ✓ **禁 `||` 兜底** ✗，
 *      取值走 `config/envValue.js` 那一套规则）；
 *   ③ 本文件**不认识打印 / 采购 / 销售**这些词 —— 它只回答"这一处是怎么个扫法" ✓
 *      （`services/labelPrint*` / `routes/scanPage/*` 各自实现，本文件不 import 它们 ✗）；
 *   ④ **三套机制并存是有意的**（A = 扫码页内联 JSAPI、B = 领域条 AppLink、C = 工作台前端 JSAPI）：
 *      不同页面 / 不同工具链，代码级合并**只发生在 A 套内部**；B / C 保持各自实现 ✓
 *      —— 收敛的是**参数与文案**，不是实现 ✗。
 */

const { readFlag, readString } = require('./envValue');

/** 实现机制（**只有两种**：飞书 H5 JSAPI 弹相机 / AppLink 打开飞书扫一扫）。 */
const MECHANISMS = Object.freeze({ jsapi: 'jsapi', applink: 'applink' });
/** 扫完的落点：`standalone` = 不回领域；`withinRealm` = 回当前领域。 */
const MODES = Object.freeze({ standalone: 'standalone', withinRealm: 'withinRealm' });

/**
 * 六处登记表（①标签打印 ②扫码页领域条 ③工作台扫一扫 ④销售再加 ⑤补货再加 ⑥退货再加）。
 * ⚠️ 每一行都**必须**写明 `mechanism` / `mode` / `returnsToRealm` / `keepDraft` 四个键
 *   —— 少了任何一个，`test/scanFivePlaces.test.js` 会红（"新入口忘了登记参数"）。
 */
const PLACES = Object.freeze([
  Object.freeze({
    id: 'label-print',
    label: '标签打印',
    realm: null,
    mechanism: MECHANISMS.jsapi,
    mode: MODES.standalone,
    returnsToRealm: false,
    keepDraft: false,
  }),
  Object.freeze({
    id: 'realm-bar',
    label: '领域条（全局扫一扫）',
    realm: null,
    mechanism: MECHANISMS.applink,
    mode: MODES.standalone,
    returnsToRealm: false,
    keepDraft: false,
  }),
  Object.freeze({
    id: 'workbench-scan',
    label: '工作台 · 扫一扫',
    realm: null,
    mechanism: MECHANISMS.applink,
    mode: MODES.standalone,
    returnsToRealm: false,
    keepDraft: false,
  }),
  Object.freeze({
    id: 'sales-add',
    label: '销售 · 再加一单',
    realm: 'sales',
    mechanism: MECHANISMS.jsapi,
    mode: MODES.withinRealm,
    returnsToRealm: true,
    keepDraft: true,
  }),
  Object.freeze({
    id: 'replenish-add',
    label: '补货 · 再加一单',
    realm: 'replenish',
    mechanism: MECHANISMS.jsapi,
    mode: MODES.withinRealm,
    returnsToRealm: true,
    keepDraft: true,
  }),
  Object.freeze({
    id: 'purchase-return-add',
    label: '退货 · 再加一单',
    realm: 'purchase_return',
    mechanism: MECHANISMS.jsapi,
    mode: MODES.withinRealm,
    returnsToRealm: true,
    keepDraft: true,
  }),
]);

const SCAN_ENTRIES = Object.freeze({
  places: PLACES,
  mechanisms: MECHANISMS,
  modes: MODES,
  /**
   * ③④⑤ 扫完回领域时，回跳 URL 上带的**触发参数**（`?<backParam>=<backValue>`）——
   * 领域页据此知道"这一发是**扫完回来的**"（该把相机收起来、把草稿接着用 ✓）。
   *
   * ⭐ **这里是唯一真源**（2026-10-16 夜 · A 套接线）：`config/realmScan.js` 的那两个键
   *   （`triggerQueryKey` / `triggerQueryValue`）**默认值取自本行** ⇒ 五处行为由一份登记表说了算 ✓；
   *   路由（`routes/scanPage/index.js` 的 `addBackPath`）与渲染层（`views/scanPage/paymentBlock.js`
   *   的 `page.realmScan`）**都不自己拼这个键**（都从配置来 ✓）。
   * ⚠️ **值 = 今天线上逐字那两个**（`scan` / `1`）⇒ 303 与今天**逐字节相同** ✓
   *   （`test/salesRealmScan.test.js` 的 **AC-SR6** 三张表逐字钉着 ✓；本刀**不改它们** ✗）。
   * ⚠️ **可配**：改名不用改代码（`SCAN_ENTRY_BACK_PARAM` / `SCAN_ENTRY_BACK_VALUE` ✓）。
   */
  backParam: 'scan',
  backValue: '1',
  /** 文案（**唯一真源**；页面/渲染层不许抄第二份 ✗）。 */
  texts: Object.freeze({
    labelPrintButton: '📷 扫码打印',
    labelPrintTitle: '📷 扫码打印',
    realmBarLabel: '扫一扫',
    addAnotherButton: '＋ 再加一个货品',
  }),
});

/** 按 id 取一处 —— **认不出当场抛**（不许静默回落到"最近一处" ✗，那会替她扫错地方）。 */
const placeById = (id, config = SCAN_ENTRIES) => {
  const wanted = String(id ?? '').trim();
  const found = (config.places || []).find((place) => place.id === wanted);
  if (!found) {
    throw new Error(`扫一扫登记表里没有「${wanted || '(空)'}」这一处（可选：${(config.places || []).map((p) => p.id).join(' / ')}）`);
  }
  return found;
};

/**
 * 从环境变量解析一份**运行期**配置（默认值 = 上面那张表）。
 * ⚠️ 规则与全仓同一套（`config/envValue.js`）：
 *   · **没设** ⇒ 用表里的默认值；
 *   · **设了** ⇒ 就是显式取值（布尔：空串 = false ⇒ **关得掉** ✓）；
 *   · 认不出来的值 ⇒ **当场抛**（不猜 ✗）。
 */
const resolveScanEntriesConfig = (env = process.env, base = SCAN_ENTRIES) => ({
  ...base,
  backParam: readString(env, 'SCAN_ENTRY_BACK_PARAM', base.backParam),
  backValue: readString(env, 'SCAN_ENTRY_BACK_VALUE', base.backValue),
  texts: {
    ...base.texts,
    labelPrintButton: readString(env, 'SCAN_ENTRY_LABEL_PRINT_BUTTON', base.texts.labelPrintButton),
    realmBarLabel: readString(env, 'SCAN_ENTRY_REALM_BAR_LABEL', base.texts.realmBarLabel),
    addAnotherButton: readString(env, 'SCAN_ENTRY_ADD_ANOTHER_BUTTON', base.texts.addAnotherButton),
  },
  places: base.places.map((place) => ({
    ...place,
    // 每一处的 `keepDraft` 都可以从 env 显式覆盖（键名由 id 派生 ⇒ 加第六处不用改这里 ✓）。
    keepDraft: readFlag(env, `SCAN_ENTRY_${place.id.replace(/-/g, '_').toUpperCase()}_KEEP_DRAFT`, place.keepDraft),
    returnsToRealm: readFlag(env, `SCAN_ENTRY_${place.id.replace(/-/g, '_').toUpperCase()}_RETURNS_TO_REALM`, place.returnsToRealm),
  })),
});

module.exports = {
  SCAN_ENTRIES,
  SCAN_PLACES: PLACES,
  MECHANISMS,
  MODES,
  placeById,
  resolveScanEntriesConfig,
};
