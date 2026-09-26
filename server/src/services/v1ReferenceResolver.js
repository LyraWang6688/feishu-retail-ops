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
