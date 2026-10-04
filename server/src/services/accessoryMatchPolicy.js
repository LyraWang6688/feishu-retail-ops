// 「其他配品」的匹配规则：先按「种类」找，再退回按名称精确匹配。
//
// 为什么不能一直按名称精确匹配：「其他配品」的名称里带价格（`15元鞋油`、`9.9元袜子`），
// 而用户嘴里说的是品类（`鞋油`）加成交金额（10 元）。拿「鞋油」去精确匹配「15元鞋油」
// 必然失败，于是"配品明明有，系统却说没有"，整单录不进来。
//
// 为什么多档时要用金额去对：`腰带` 有 39/49/…/189 共 9 档，名称只差一个数字。
// 金额对不上任何一档时什么都不选（不退回第一条、也不模糊匹配）——那会把 39 元的腰带
// 记成 99 元那一条记录，属于串货，比"让用户补一句话"贵得多。

// 价位从名称里解析：数字紧挨着「元」（`39元腰带`、`9.9元袜子`、`9.9 元袜子` 都算）。
// 解析不出来（如 `赠品鞋垫`、`女士包`）返回 null，由调用方按"这一档没有价位"处理。
const PRICE_IN_NAME = /(\d+(?:\.\d+)?)\s*元/;

const parseAccessoryPrice = (name) => {
  const matched = PRICE_IN_NAME.exec(String(name ?? ''));
  if (!matched) return null;
  const price = Number(matched[1]);
  return Number.isFinite(price) ? price : null;
};

// 金额比较统一折成分，避免 9.9 这类小数在浮点上对不齐。
// 缺失、0、非数字都算"用户没说金额"（返回 null），绝不把"没说"当成 0 元去对档。
const toCents = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100);
};

const formatPrice = (price) => String(Number(Number(price).toFixed(2)));

// 提示用户"有哪几档"：有价位的写「39 元」，没价位的（赠品）直接写名称。
// 去重是因为表里存在两条同名「赠品鞋垫」，重复列出来只会让人困惑。
const categoryTiers = (candidates) => {
  const labels = candidates.map((item) => {
    const price = parseAccessoryPrice(item.name);
    return price == null ? String(item.name ?? '').trim() : `${formatPrice(price)} 元`;
  });
  return [...new Set(labels.filter(Boolean))].join('、');
};

/**
 * 把用户说的一件配品解析到「其他配品」的具体记录。
 *
 * @param {string} spoken   用户/解析器给出的配品说法（如 `鞋油`、`腰带`、`15元鞋油`）
 * @param {number|string} amount 用户说的成交金额，只在多档时用来定位是哪一档
 * @param {Array} accessories  listAccessories() 的产物：{ record_id, name, category }
 * @returns {{ match: object|null, issue: string }} issue 为面向用户的一句话（不含"第 N 件"前缀）
 */
const resolveAccessory = ({ spoken, amount, accessories = [] } = {}) => {
  const word = String(spoken ?? '').trim();
  const list = Array.isArray(accessories) ? accessories : [];
  if (!word) return { match: null, issue: '这一件没听清配品名称，请核对名称' };

  // 1) 先在该表的「种类」里精确匹配。
  const byCategory = list.filter((item) => String(item.category ?? '').trim() === word);

  // 2) 该分类下只有一条 → 直接用它。金额仍以用户说的为准（调用方不碰 actual_amount）。
  if (byCategory.length === 1) return { match: byCategory[0], issue: '' };

  // 3) 该分类下有多条 → 用用户说的金额去对价位。
  if (byCategory.length > 1) {
    const cents = toCents(amount);
    if (cents != null) {
      const hit = byCategory.filter((item) => toCents(parseAccessoryPrice(item.name)) === cents);
      if (hit.length === 1) return { match: hit[0], issue: '' };
      // 对上多条（表里同价位有多条记录）同样不猜：选错记录就是串货。
    }
    return { match: null, issue: `${word}有 ${categoryTiers(byCategory)} 这几档，你卖的是哪一档？` };
  }

  // 4) 「种类」里没有这个词 → 退回改动前的行为：按主字段名称精确匹配（向后兼容）。
  const byName = list.find((item) => item.name === word);
  if (byName) return { match: byName, issue: '' };

  // 5) 名称也匹配不到 → 仍然报"没有这一件"。
  return { match: null, issue: `其他配品里没有「${word}」这一件，请核对名称` };
};

module.exports = {
  parseAccessoryPrice,
  resolveAccessory,
};
