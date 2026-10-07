// 颜色候选这份显示配置的取值规则（配置先行）。
// 取值规则与 `pendingDealPush` / `salesProcessingCard` / `productInfoGaps` 是**同一套**
// （`config/envValue`）：没设 → 默认值；设了（含空串）→ 就是显式取值。
//
// 🔴 2026-10-07 口径（业务负责人逐字）：「**甲 去掉**（推荐，贴合你的口径）：候选只显示颜色
//   （黑色 / 绿色），**选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"**」
//   ⇒ 候选按钮上**不再**打「有货 / 无货」预览标注：
//     · `SALES_COLOR_STOCK_LABEL_AVAILABLE` / `…_UNAVAILABLE` 两个环境变量**删除**（不留死配置）；
//     · `SALES_COLOR_STOCK_STATUS` 常量**删除**；
//     · `colorOptionButtonText` 只回颜色名（**即便**传进来的候选上还带着 `stock_status`，
//       也**不加**后缀 —— 渲染层不再认识那个字段）。
//   ⭐ 选完颜色之后那一次实时库存查询**不变**（它在 `services/larkMvpService` 的
//     `choose_sale_color` 里，属于"类型判据"，与本文件无关）。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AVAILABLE_KEY,
  UNAVAILABLE_KEY,
  STOCK_LOOKUP_FAILED_TEXT_KEY,
  SALES_COLOR_STOCK_STATUS,
  SALES_COLOR_CHOICE_DEFAULTS,
  resolveSalesColorChoiceConfig,
  colorOptionButtonText,
} = require('../src/config/salesColorChoice');

test('默认配置只剩「读不到库存」那一句 —— 两个「有货 / 无货」后缀键已随预览标注删除', () => {
  const config = resolveSalesColorChoiceConfig({});
  assert.equal(config.stockLookupFailedText, '暂时读不到库存，请再点一次颜色～');
  assert.deepEqual(SALES_COLOR_CHOICE_DEFAULTS, {
    stockLookupFailedText: '暂时读不到库存，请再点一次颜色～',
  });
  // 🔴 死配置清理：后缀键、后端值域常量都不该还在（加回来 = 预览标注又被接上了）。
  assert.equal(AVAILABLE_KEY, undefined, 'SALES_COLOR_STOCK_LABEL_AVAILABLE 不许再加回来');
  assert.equal(UNAVAILABLE_KEY, undefined, 'SALES_COLOR_STOCK_LABEL_UNAVAILABLE 不许再加回来');
  assert.equal(SALES_COLOR_STOCK_STATUS, undefined, '候选上的 stock_status 取值表不许再加回来');
  assert.equal(config.availableLabel, undefined);
  assert.equal(config.unavailableLabel, undefined);
  // ⭐ 2026-10-07：候选**给全部颜色**（撤掉"只推在售"）⇒ 这一段不再有"全下架"那句文案。
  assert.equal(config.scopeEmptyText, undefined);
});

test('显式取值：环境变量设了就用它', () => {
  const config = resolveSalesColorChoiceConfig({
    [STOCK_LOOKUP_FAILED_TEXT_KEY]: '稍后再点一次',
  });
  assert.equal(config.stockLookupFailedText, '稍后再点一次');
});

test('失败文案设成空串 → 用默认文案（它是失败时唯一可见的解释，留空 = 点了没反应）', () => {
  assert.equal(resolveSalesColorChoiceConfig({ [STOCK_LOOKUP_FAILED_TEXT_KEY]: '' }).stockLookupFailedText,
    '暂时读不到库存，请再点一次颜色～');
  assert.equal(resolveSalesColorChoiceConfig({ [STOCK_LOOKUP_FAILED_TEXT_KEY]: '稍后再点一次' }).stockLookupFailedText,
    '稍后再点一次');
});

// ── 候选按钮文字：**只有颜色名**（反向断言 = 收严，不是放宽）──────────────────
// 为什么不是放宽：旧断言是"等于带后缀的字串"；现在①**逐字等于纯颜色名**（多一个字符就红），
// ②再显式禁止「有货 / 无货」出现，③并且**故意传入带 `stock_status` 的候选**证明渲染层
// 已经完全不认识这个字段 —— 三条信息量只增不减。
test('⭐ 候选按钮只有颜色名：即便候选上还带着 stock_status，也不许拼「有货 / 无货」', () => {
  const config = resolveSalesColorChoiceConfig({});
  assert.equal(colorOptionButtonText({ color: '黑', stock_status: 'available' }, config), '黑');
  assert.equal(colorOptionButtonText({ color: '白', stock_status: 'unavailable' }, config), '白');
  assert.equal(colorOptionButtonText({ color: '绿' }, config), '绿');
  for (const option of [
    { color: '黑', stock_status: 'available' },
    { color: '白', stock_status: 'unavailable' },
  ]) {
    const text = colorOptionButtonText(option, config);
    assert.doesNotMatch(text, /有货|无货/, '候选按钮上不许出现「有货 / 无货」');
    assert.equal(text, option.color, '按钮文字逐字 = 颜色名');
  }
});

test('颜色为空时保留既有兜底「未命名颜色」（不再有后缀）', () => {
  const config = resolveSalesColorChoiceConfig({});
  assert.equal(colorOptionButtonText({ color: '', stock_status: 'unavailable' }, config), '未命名颜色');
  assert.equal(colorOptionButtonText({}, config), '未命名颜色');
  assert.equal(colorOptionButtonText(), '未命名颜色');
});

test('⭐ 旧的"候选范围 / 全下架文案"那套配置已整体退场（撤掉 #230 的证据）', () => {
  const colorChoice = require('../src/config/salesColorChoice');
  assert.equal(colorChoice.SALES_PRODUCT_STATUS_OFF_SHELF, undefined);
  assert.equal(colorChoice.SCOPE_EMPTY_TEXT_KEY, undefined);
  assert.equal(colorChoice.formatColorOptionsScopeEmptyText, undefined);
  const policy = require('../src/config/salesTradeTypePolicy');
  assert.equal(policy.salesColorOptionsScopeFor, undefined);
  assert.equal(policy.SALES_COLOR_OPTIONS_SCOPE, undefined);
});
