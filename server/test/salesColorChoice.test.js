// 「颜色候选上的有货 / 无货后缀」这份显示配置的取值规则（配置先行）。
// 取值规则与 `pendingDealPush` / `salesProcessingCard` / `productInfoGaps` 是**同一套**
// （`config/envValue`）：没设 → 默认值；设了（含空串）→ 就是显式取值。
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

test('默认后缀是「（有货）/（无货）」（她第一眼看到的那一版）', () => {
  const config = resolveSalesColorChoiceConfig({});
  assert.equal(config.availableLabel, '（有货）');
  assert.equal(config.unavailableLabel, '（无货）');
  assert.equal(config.stockLookupFailedText, '暂时读不到库存，请再点一次颜色～');
  assert.deepEqual(SALES_COLOR_CHOICE_DEFAULTS, {
    availableLabel: '（有货）', unavailableLabel: '（无货）',
    stockLookupFailedText: '暂时读不到库存，请再点一次颜色～',
  });
});

test('显式取值：环境变量设了就用它；后缀设成空串 = 不加那个后缀（不回退默认）', () => {
  const config = resolveSalesColorChoiceConfig({
    [AVAILABLE_KEY]: '·有货',
    [UNAVAILABLE_KEY]: '（缺货）',
  });
  assert.equal(config.availableLabel, '·有货');
  assert.equal(config.unavailableLabel, '（缺货）');
  const blank = resolveSalesColorChoiceConfig({ [AVAILABLE_KEY]: '', [UNAVAILABLE_KEY]: '' });
  assert.equal(blank.availableLabel, '');
  assert.equal(blank.unavailableLabel, '');
});

test('失败文案设成空串 → 用默认文案（它是失败时唯一可见的解释，留空 = 点了没反应）', () => {
  assert.equal(resolveSalesColorChoiceConfig({ [STOCK_LOOKUP_FAILED_TEXT_KEY]: '' }).stockLookupFailedText,
    '暂时读不到库存，请再点一次颜色～');
  assert.equal(resolveSalesColorChoiceConfig({ [STOCK_LOOKUP_FAILED_TEXT_KEY]: '稍后再点一次' }).stockLookupFailedText,
    '稍后再点一次');
});

test('有货 / 无货分别加对应后缀；不在这两个取值上的状态不加后缀', () => {
  const config = resolveSalesColorChoiceConfig({});
  assert.equal(colorOptionButtonText({ color: '黑', stock_status: SALES_COLOR_STOCK_STATUS.available }, config), '黑（有货）');
  assert.equal(colorOptionButtonText({ color: '白', stock_status: SALES_COLOR_STOCK_STATUS.unavailable }, config), '白（无货）');
  // 不跑 B 的交易类型（例如预付）候选上没有 stock_status ⇒ 纯颜色，不误导她。
  assert.equal(colorOptionButtonText({ color: '黑' }, config), '黑');
});

test('颜色为空时保留既有兜底「未命名颜色」（后缀照加）', () => {
  const config = resolveSalesColorChoiceConfig({});
  assert.equal(colorOptionButtonText({ color: '', stock_status: SALES_COLOR_STOCK_STATUS.unavailable }, config), '未命名颜色（无货）');
  assert.equal(colorOptionButtonText({}, config), '未命名颜色');
});
