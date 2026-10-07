const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ENABLED_KEY,
  MISSING_TEXT_KEY,
  ITEM_NO_PLACEHOLDER,
  SALES_PRODUCT_REGISTRATION_DEFAULTS,
  SALES_PRODUCT_REGISTRATION_EVENTS,
  resolveSalesProductRegistrationConfig,
  formatMissingProductText,
} = require('../src/config/salesProductRegistration');

// 「A 之后：这个货号有没有在「货品信息」里建档」那道判据的**配置面**（配置先行）。
// 这几条守的是"改开关 / 改文案只改配置，不改逻辑"，以及几个踩过的坑：
//   · 开关必须是**显式布尔**（空串 = 关掉，不能靠 `|| 默认值` 回退成开）；
//   · 认不出来的值**当场抛错**（静默按 true/false 处理是最坏的一种）；
//   · 取值**调用时才解析**（不在模块加载时求值，避免 dotenv 加载顺序事故）。
// 单测直接传 env 进来（不碰全局 process.env），并发跑用例不会互相污染。

test('没设环境变量 → 用默认值（默认开着、文案带 {item_no} 占位符）', () => {
  const config = resolveSalesProductRegistrationConfig({});
  assert.equal(config.enabled, true, '默认要拦 —— 这是她拍的"必须当场提示"');
  assert.equal(config.missingText, SALES_PRODUCT_REGISTRATION_DEFAULTS.missingText);
  assert.match(config.missingText, /\{item_no\}/, '默认文案必须能按货号粒度说话');
});

test('开关是显式布尔：设成空串 = 关掉（不许回退成默认的开）', () => {
  assert.equal(resolveSalesProductRegistrationConfig({ [ENABLED_KEY]: '' }).enabled, false,
    '空串 = 显式关掉，不能因为用了 `|| 默认值` 而"关不掉"');
  for (const raw of ['false', '0', 'no', 'off']) {
    assert.equal(resolveSalesProductRegistrationConfig({ [ENABLED_KEY]: raw }).enabled, false, raw);
  }
  for (const raw of ['true', '1', 'yes', 'on']) {
    assert.equal(resolveSalesProductRegistrationConfig({ [ENABLED_KEY]: raw }).enabled, true, raw);
  }
});

test('开关设成认不出来的值 → 当场抛错（不猜）', () => {
  assert.throws(() => resolveSalesProductRegistrationConfig({ [ENABLED_KEY]: 'maybe' }),
    /SALES_PRODUCT_REGISTRATION_GUARD_ENABLED/);
});

test('文案可配：设了就用设的（含空串 = 那句话为空）；{item_no} 换成这一条的货号', () => {
  assert.equal(resolveSalesProductRegistrationConfig({ [MISSING_TEXT_KEY]: '没建档：{item_no}' }).missingText,
    '没建档：{item_no}');
  assert.equal(resolveSalesProductRegistrationConfig({ [MISSING_TEXT_KEY]: '' }).missingText, '');
  assert.equal(formatMissingProductText('货品信息里没有 {item_no}，请先建档～', { itemNo: 'B26002-52' }),
    '货品信息里没有 B26002-52，请先建档～');
  // 货号里可能带 `$&` 这类替换串会咬的字符：用 split/join 而不是 RegExp，原样换进去。
  assert.equal(formatMissingProductText('缺 {item_no}', { itemNo: '$&x' }), '缺 $&x');
  // 模板里没有占位符 / 没有货号时都不许抛错。
  assert.equal(formatMissingProductText('缺货号', { itemNo: 'B1' }), '缺货号');
  assert.equal(formatMissingProductText(`缺 ${ITEM_NO_PLACEHOLDER}`, {}), '缺 ');
});

test('事件名在这里单点声明（拦截 / 关掉 / 不下结论 三条痕迹）', () => {
  assert.equal(SALES_PRODUCT_REGISTRATION_EVENTS.blocked, 'lark.sales.product_missing.blocked');
  assert.equal(SALES_PRODUCT_REGISTRATION_EVENTS.guardDisabled, 'lark.sales.product_missing.guard_disabled');
  assert.equal(SALES_PRODUCT_REGISTRATION_EVENTS.undetermined, 'lark.sales.product_missing.undetermined');
});

test('调用时才解析 process.env（不在模块加载时求值）—— 换一个 env 对象就换一份结论', () => {
  const on = resolveSalesProductRegistrationConfig({ [ENABLED_KEY]: 'true' });
  const off = resolveSalesProductRegistrationConfig({ [ENABLED_KEY]: 'false' });
  assert.equal(on.enabled, true);
  assert.equal(off.enabled, false);
});
