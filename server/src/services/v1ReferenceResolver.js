const { linkedRecordIds, textValue } = require('./v1BitableGateway');

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[|｜._-]/g, '');

const normalizeColor = (value) => normalizeText(value).replace(/色$/, '');

const relation = (recordId) => (recordId ? [recordId] : undefined);
const person = (openId) => (openId ? [{ id: openId }] : undefined);

// OCR 相似字符映射：用于识别错误时的纠正
// 注意：normalizeText 会转小写，所以这里只处理小写字母和数字
const SIMILAR_CHARS = {
  'w': ['9'],
  '9': ['w'],
  'o': ['0'],
  '0': ['o'],
  'i': ['1'],
  'l': ['1'],
  '1': ['i', 'l'],
  's': ['5'],
  '5': ['s'],
  'z': ['2'],
  '2': ['z'],
  'b': ['8'],
  '8': ['b'],
  'g': ['6'],
  '6': ['g'],
};

/**
 * 生成货号的所有相似字符纠正组合
 * 例如："86w02" → ["86902", "86wo2", ...]
 * 不包含原始字符串
 */
function generateCorrections(text) {
  if (!text || text.length === 0) return [];
  const chars = text.split('');
  let results = [''];
  for (const char of chars) {
    const alternatives = SIMILAR_CHARS[char] || [];
    const currentLength = results.length;
    // 为每个已有结果添加替代字符
    for (let i = 0; i < currentLength; i++) {
      for (const alt of alternatives) {
        results.push(results[i] + alt);
      }
    }
    // 为每个已有结果添加原始字符
    for (let i = 0; i < currentLength; i++) {
      results[i] += char;
    }
  }
  // 去掉原始字符串（第一个），只返回纠正后的组合
  // 限制最多返回 32 种组合，避免指数爆炸
  return results.slice(1, 33);
}

class V1ReferenceResolver {
  constructor(gateway) {
    this.gateway = gateway;
  }

  async resolveProduct(input = {}) {
    if (input.productRecordId) {
      const record = await this.gateway.get('product', input.productRecordId);
      if (!record) throw new Error(`找不到货品记录：${input.productRecordId}`);
      return { recordId: input.productRecordId, record };
    }
    const table = this.gateway.table('product');
    const records = await this.gateway.listAll('product');
    const wantedNumber = normalizeText(input.productNumber || input.number);
    const wantedItemNo = normalizeText(input.itemNo);
    const wantedColor = normalizeColor(input.color);

    const candidates = records.map((record) => {
      const fields = record.fields || {};
      return {
        record,
        number: normalizeText(textValue(fields[table.fields.number])),
        itemNo: normalizeText(textValue(fields[table.fields.itemNo])),
        color: normalizeColor(textValue(fields[table.fields.color])),
        colorDisplay: textValue(fields[table.fields.color]),
      };
    });

    // “编号”可以包含品类等展示信息，而用户日常通常只说“货号+颜色”。
    // 先匹配完整编号；找不到时再使用配置字段“货号+颜色”作为唯一别名。
    let matches = wantedNumber
      ? candidates.filter((candidate) => candidate.number === wantedNumber)
      : [];
    if (matches.length === 0 && wantedNumber) {
      matches = candidates.filter(
        (candidate) => candidate.itemNo && candidate.color && `${candidate.itemNo}${candidate.color}` === wantedNumber,
      );
    }
    if (matches.length === 0 && wantedItemNo) {
      matches = candidates.filter(
        (candidate) => candidate.itemNo === wantedItemNo && (!wantedColor || candidate.color === wantedColor),
      );
    }

    // 相似字符纠正：如果正常匹配失败，尝试纠正货号后再匹配
    // 例如 OCR 把 "86902" 识别成 "86w02"，纠正后能匹配到
    if (matches.length === 0 && wantedItemNo) {
      const corrections = generateCorrections(wantedItemNo);
      for (const correctedItemNo of corrections) {
        const correctedMatches = candidates.filter(
          (candidate) => candidate.itemNo === correctedItemNo && (!wantedColor || candidate.color === wantedColor),
        );
        if (correctedMatches.length === 1) {
          matches = correctedMatches;
          console.log(`[v1ReferenceResolver] 货号相似字符纠正成功: "${wantedItemNo}" -> "${correctedItemNo}"`);
          break;
        }
      }
    }

    if (matches.length === 0) {
      throw new Error(`找不到货品：${input.productNumber || input.itemNo || ''}${input.color || ''}`);
    }
    if (matches.length > 1) {
      if (wantedItemNo) {
        const colors = [...new Set(matches.map((candidate) => candidate.colorDisplay).filter(Boolean))];
        const colorHint = colors.length ? `（${colors.join('、')}）` : '';
        throw new Error(`货号 ${input.itemNo} 对应多个货品，请补充颜色${colorHint}`);
      }
      throw new Error(`货品匹配不唯一：${input.productNumber || input.itemNo || ''}${input.color || ''}`);
    }
    return { recordId: matches[0].record.record_id, record: matches[0].record };
  }

  async resolveBehavior(code) {
    const record = await this.gateway.findOneByText('behavior', 'code', code);
    if (!record) throw new Error(`行为管理中找不到已配置行为：${code}`);
    return { recordId: record.record_id, record };
  }

  async resolvePaymentMethod(name) {
    if (!name) return null;
    const table = this.gateway.table('paymentMethod');
    const records = await this.gateway.listAll('paymentMethod');
    const wanted = normalizeText(name);
    const matches = records.filter(
      (record) => normalizeText(textValue(record.fields?.[table.fields.name])) === wanted
    );
    if (matches.length === 0) throw new Error(`收款方式管理中找不到：${name}`);
    if (matches.length > 1) throw new Error(`收款方式配置重复：${name}`);
    return { recordId: matches[0].record_id, record: matches[0] };
  }

  async resolveSupplier(name) {
    if (!name) return null;
    const table = this.gateway.table('supplier');
    const records = await this.gateway.listAll('supplier');
    const wanted = normalizeText(name);
    const matches = records.filter(
      (record) => normalizeText(textValue(record.fields?.[table.fields.name])) === wanted
    );
    if (matches.length === 0) throw new Error(`供应商管理中找不到：${name}`);
    if (matches.length > 1) throw new Error(`供应商配置重复：${name}`);
    return { recordId: matches[0].record_id, record: matches[0] };
  }

  async findLiveInventory(productRecordId, size) {
    const table = this.gateway.table('liveInventory');
    const records = await this.gateway.listAll('liveInventory');
    const expectedSize = Number(size);
    return (
      records.find((record) => {
        const fields = record.fields || {};
        const productIds = linkedRecordIds(fields[table.fields.product]);
        const actualSize = Number(textValue(fields[table.fields.size]));
        return productIds.includes(productRecordId) && actualSize === expectedSize;
      }) || null
    );
  }
}

module.exports = {
  V1ReferenceResolver,
  normalizeColor,
  normalizeText,
  person,
  relation,
};
