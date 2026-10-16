/**
 * 「**扫一扫**」五处登记表的**客户端那一份**（C 套 = 工作台前端在用）。
 *
 * ⚠️ **真源是服务端** `server/src/config/scanEntries.js`（业务负责人 2026-10-16 21:2x 逐字口径，
 *   见 `docs/scan-five-places-2026-10-16.md`）；本文件是它在浏览器里的**逐字镜像**：
 *   · 浏览器拿不到服务端 `require` 的 config ⇒ 本仓既有做法就是"**两端各一份 + 用例钉逐字相同**"
 *     （先例：`config/links.js` 的 `SCAN_APPLINK` 与 `config/scanPage.js` 的 `SCAN_NEXT.applink`
 *      有 `workbenchScanEntry.test.js` 钉着逐字相等 ✓）；
 *   · `test/scanFivePlaces.test.js` 的 **AC-5S3** 会把这两份**逐字对比**（改一边忘另一边 ⇒ 红 ✓）。
 *
 * ⚠️ 本文件**不写死任何行为**：C 套只从这里取**已经登记好的那两个参数**（`returnsToRealm` / `keepDraft`）
 *   与文案 ⇒ 页面上**没有**"这一处要不要带草稿"的判断（判断在登记表里 ✓）。
 */

const freeze = (value) => Object.freeze(value);

export const MECHANISMS = freeze({ jsapi: 'jsapi', applink: 'applink' });
export const MODES = freeze({ standalone: 'standalone', withinRealm: 'withinRealm' });

export const SCAN_PLACES = freeze([
  freeze({
    id: 'label-print',
    label: '标签打印',
    realm: null,
    mechanism: MECHANISMS.jsapi,
    mode: MODES.standalone,
    returnsToRealm: false,
    keepDraft: false,
  }),
  freeze({
    id: 'realm-bar',
    label: '领域条（全局扫一扫）',
    realm: null,
    mechanism: MECHANISMS.applink,
    mode: MODES.standalone,
    returnsToRealm: false,
    keepDraft: false,
  }),
  freeze({
    id: 'sales-add',
    label: '销售 · 再加一单',
    realm: 'sales',
    mechanism: MECHANISMS.jsapi,
    mode: MODES.withinRealm,
    returnsToRealm: true,
    keepDraft: true,
  }),
  freeze({
    id: 'replenish-add',
    label: '补货 · 再加一单',
    realm: 'replenish',
    mechanism: MECHANISMS.jsapi,
    mode: MODES.withinRealm,
    returnsToRealm: true,
    keepDraft: true,
  }),
  freeze({
    id: 'purchase-return-add',
    label: '退货 · 再加一单',
    realm: 'purchase_return',
    mechanism: MECHANISMS.jsapi,
    mode: MODES.withinRealm,
    returnsToRealm: true,
    keepDraft: true,
  }),
]);

export const SCAN_ENTRIES = freeze({
  places: SCAN_PLACES,
  mechanisms: MECHANISMS,
  modes: MODES,
  backParam: 'scan_added',
  texts: freeze({
    labelPrintButton: '📷 扫码打印',
    labelPrintTitle: '📷 扫码打印',
    realmBarLabel: '扫一扫',
    addAnotherButton: '＋ 再加一个货品',
  }),
});

/** 按 id 取一处；认不出 ⇒ `null`（页面**不猜**：拿不到就不渲染那一块 ✗，绝不回落到别的入口）。 */
export const placeById = (id) => SCAN_PLACES.find((place) => place.id === String(id ?? '').trim()) || null;

/** C 套（①标签打印）在登记表里的那一行 —— `scan-print.js` 只认它（不自己写死行为参数 ✗）。 */
export const SCAN_LABEL_PRINT_PLACE = placeById('label-print');
