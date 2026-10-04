const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAccessoryPrice, resolveAccessory } = require('../src/services/accessoryMatchPolicy');

// 真实表里的配品名称：名称里带价格，`赠品鞋垫` / `女士包` 不带。
const ACCESSORIES = [
  { record_id: 'acc_oil', name: '15元鞋油', category: '鞋油' },
  { record_id: 'acc_sock', name: '9.9元袜子', category: '袜子' },
  { record_id: 'acc_belt_39', name: '39元腰带', category: '腰带' },
  { record_id: 'acc_belt_99', name: '99元腰带', category: '腰带' },
  { record_id: 'acc_belt_189', name: '189元腰带', category: '腰带' },
  { record_id: 'acc_pad_99', name: '9.9元鞋垫', category: '鞋垫' },
  { record_id: 'acc_pad_gift_1', name: '赠品鞋垫', category: '鞋垫' },
  { record_id: 'acc_pad_gift_2', name: '赠品鞋垫', category: '鞋垫' },
  { record_id: 'acc_bag', name: '女士包', category: '女士包' },
];

test('parses an integer price out of a name', () => {
  assert.equal(parseAccessoryPrice('39元腰带'), 39);
});

test('parses a decimal price out of a name', () => {
  assert.equal(parseAccessoryPrice('9.9元袜子'), 9.9);
  // 「元」两侧的空格不影响解析。
  assert.equal(parseAccessoryPrice('9.9 元袜子'), 9.9);
});

test('returns null when the name carries no price instead of guessing one', () => {
  assert.equal(parseAccessoryPrice('赠品鞋垫'), null);
  assert.equal(parseAccessoryPrice('女士包'), null);
  assert.equal(parseAccessoryPrice(''), null);
  assert.equal(parseAccessoryPrice(undefined), null);
});

test('a category with exactly one record is used directly', () => {
  const { match, issue } = resolveAccessory({ spoken: '鞋油', amount: 10, accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_oil');
  assert.equal(issue, '');
});

test('a category with one record matches even without a spoken amount', () => {
  const { match } = resolveAccessory({ spoken: '鞋油', amount: '', accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_oil');
});

test('a decimal amount picks the decimal tier', () => {
  const { match } = resolveAccessory({ spoken: '袜子', amount: 9.9, accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_sock');
});

test('a multi-tier category is resolved by the spoken amount', () => {
  const { match, issue } = resolveAccessory({ spoken: '腰带', amount: 99, accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_belt_99');
  assert.equal(issue, '');
  // 字符串金额同样能对上，避免调用方传进来的是文本就匹配失败。
  assert.equal(resolveAccessory({ spoken: '腰带', amount: '189', accessories: ACCESSORIES }).match.record_id,
    'acc_belt_189');
});

test('a multi-tier category with an unmatched amount refuses to guess and lists the tiers', () => {
  const { match, issue } = resolveAccessory({ spoken: '腰带', amount: 88, accessories: ACCESSORIES });
  assert.equal(match, null);
  assert.match(issue, /腰带有 39 元、99 元、189 元 这几档/);
  assert.match(issue, /你卖的是哪一档/);
});

test('a multi-tier category without a spoken amount also refuses to guess', () => {
  const { match, issue } = resolveAccessory({ spoken: '腰带', amount: '', accessories: ACCESSORIES });
  assert.equal(match, null);
  assert.match(issue, /这几档/);
});

test('non-priced tiers are listed by name and duplicates are collapsed', () => {
  const { match, issue } = resolveAccessory({ spoken: '鞋垫', amount: 88, accessories: ACCESSORIES });
  assert.equal(match, null);
  // 9.9 元那一档写价，赠品那两档写名称；两条同名「赠品鞋垫」只列一次。
  assert.match(issue, /鞋垫有 9\.9 元、赠品鞋垫 这几档/);
});

test('the non-priced tier can still be reached by its exact name', () => {
  const { match } = resolveAccessory({ spoken: '赠品鞋垫', amount: 0, accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_pad_gift_1');
});

test('an amount that matches several records does not pick one arbitrarily', () => {
  const rows = [
    { record_id: 'a', name: '39元腰带', category: '腰带' },
    { record_id: 'b', name: '39元腰带', category: '腰带' },
  ];
  const { match, issue } = resolveAccessory({ spoken: '腰带', amount: 39, accessories: rows });
  assert.equal(match, null);
  assert.match(issue, /这几档/);
});

test('a word that is not a category falls back to exact name matching', () => {
  const { match } = resolveAccessory({ spoken: '39元腰带', amount: 39, accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_belt_39');
});

test('with no category mapping at all the old name matching still works (backward compatible)', () => {
  const rows = [{ record_id: 'only', name: '39元腰带' }];
  assert.equal(resolveAccessory({ spoken: '39元腰带', accessories: rows }).match.record_id, 'only');
  assert.match(resolveAccessory({ spoken: '腰带', accessories: rows }).issue, /没有「腰带」这一件/);
});

test('neither category nor name matches -> the original "no such item" wording', () => {
  const { match, issue } = resolveAccessory({ spoken: '袜子', amount: 9.9, accessories: ACCESSORIES.slice(0, 1) });
  assert.equal(match, null);
  assert.equal(issue, '其他配品里没有「袜子」这一件，请核对名称');
});

test('the amount is never read back from the accessory name', () => {
  // 名称里写 15 元，用户说 10 元：解析结果只给出记录，不产出任何金额。
  const { match } = resolveAccessory({ spoken: '鞋油', amount: 10, accessories: ACCESSORIES });
  assert.equal(match.record_id, 'acc_oil');
  assert.equal(match.name, '15元鞋油');
  assert.equal('price' in match, false);
});
