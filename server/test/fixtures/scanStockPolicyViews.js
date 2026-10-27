'use strict';

/**
 * ⭐⭐ **扫码页「库存口径」证据用例共用的三份视图模型夹具**（2026-10-16 晚）。
 *
 * 来源：`server/test/stockStateConsistency.test.js`（前一位执行者 2026-10-16 20:35 的只读诊断）
 *   —— 那三份夹具**逐字照她真机那一款的形状**（货品 8516），本模块只是把它们**搬出来共用**
 *   （那边仍留着自己那一份，**一条判据都没动** ✗）。
 *
 *   · `THREE_STATE_VIEW`         门盒 / 样品 / 仓库 三种状态（= 今天线上那条路，**没有空状态列**）
 *   · `FULL_SIZES_BLANK_VIEW`    她截图那一幕：**只有 44 码 1 双，且「所属状态」为空**
 *   · `BLANK_STATE_VIEW`         未标状态 + 仓库 + 门盒/样品 混在一款上
 *
 * ⚠️ 本文件只**造数据**，不 require 任何业务写入口。
 */
const path = require('node:path');
const { SCAN_WRITE } = require(path.join(__dirname, '..', '..', 'src', 'config', 'scanWrite'));
const { SCAN_PAGE } = require(path.join(__dirname, '..', '..', 'src', 'config', 'scanPage'));
const { renderScanPage } = require(path.join(__dirname, '..', '..', 'src', 'views', 'scanPageRenderer'));

/** 四个 tab（渲染入口 = `?from=`）。 */
const REALM_IDS = ['inventory', 'sales', 'replenish', 'purchase_return'];

/** 空白状态列（服务层按 `config.states.emptyLabel` 追加的那一列）。 */
const BLANK_COLUMN = { key: '', label: SCAN_PAGE.states.emptyLabel };

/** 三态：40 门盒 1 / 41 缺 / 42 门盒 1＋样品 1 / 43 只有仓库 2 / 44 缺。 */
const THREE_STATE_VIEW = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }], total: 2, missing: false },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 2,
  sizes_degraded: false,
  notes: ['缺码说明'],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

/** ⭐ 她截图那一幕：男 A 段 38–48 全列，**只有 44 码 1 双（所属状态为空）**。 */
const FULL_SIZES_BLANK_VIEW = {
  found: true,
  number: '8516|黑色|A',
  item_no: '8516',
  color: '黑色',
  category_name: '凉鞋',
  category_code: 'A',
  price_text: '¥99',
  total: 1,
  columns: [
    { key: '门盒', label: '门盒' }, { key: '样品', label: '样品' },
    { key: '仓库', label: '仓库' }, BLANK_COLUMN,
  ],
  rows: [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48].map((size) => ({
    size_text: String(size),
    cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 },
      { key: '', count: size === 44 ? 1 : 0 }],
    total: size === 44 ? 1 : 0,
    missing: size !== 44,
  })),
  missing_count: 10,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 20:35',
  product_record_id: 'prod_8516',
};

/** 未标状态 + 仓库 + 门盒/样品 混在一款上（40 门盒1＋样品1 / 43 仓库2 / 44 未标1）。 */
const BLANK_STATE_VIEW = {
  found: true,
  number: '8516|黑色|A',
  item_no: '8516',
  color: '黑色',
  category_name: '凉鞋',
  category_code: 'A',
  price_text: '¥99',
  total: 5,
  columns: [
    { key: '门盒', label: '门盒' }, { key: '样品', label: '样品' },
    { key: '仓库', label: '仓库' }, BLANK_COLUMN,
  ],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }, { key: '', count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }, { key: '', count: 0 }], total: 2, missing: false },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 20:35',
  product_record_id: 'prod_8516',
};

/** 最小写上下文（字段名 / 动作 / 文案照 `config/scanWrite.js` 的形状 —— 与既有用例一致）。 */
const WRITE = {
  ...SCAN_WRITE,
  enabled: true,
  sizes: [],
  draft: { lines: [] },
  postAction: '/r/8516',
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
};

/** ⚠️ `page_build` 是**唯一动态位**（本地 / CI 不同）⇒ 比对前换成占位符，其余一个字节都不许差。 */
const PAGE_BUILD_TOKEN = '«page_build»';
const normalize = (text) => String(text).split(SCAN_PAGE.pageBuild).join(PAGE_BUILD_TOKEN);

const fullPageOf = (view, realm) => normalize(renderScanPage(view, SCAN_PAGE, WRITE, realm));

/** 取某一份 HTML 里领域那一块（到页脚 `<p class="foot">` 之前）。 */
const blockOf = (html, id) => {
  const page = html.slice(html.indexOf('</head>'));
  const start = page.indexOf(`realm-block--${id}"`);
  if (start < 0) throw new Error(`缺 ${id} 块`);
  const foot = page.indexOf('<p class="foot">', start);
  return page.slice(start, foot > -1 ? foot : page.length);
};

const blockOfFull = (view, realm) => blockOf(fullPageOf(view, realm), realm);

/** 三份夹具（键名 = 零回归快照里的夹具名）。 */
const VIEWS = Object.freeze({
  threeState: THREE_STATE_VIEW,
  fullSizesBlank: FULL_SIZES_BLANK_VIEW,
  blankState: BLANK_STATE_VIEW,
});

module.exports = {
  REALM_IDS,
  VIEWS,
  THREE_STATE_VIEW,
  FULL_SIZES_BLANK_VIEW,
  BLANK_STATE_VIEW,
  WRITE,
  PAGE_BUILD_TOKEN,
  normalize,
  fullPageOf,
  blockOf,
  blockOfFull,
};
