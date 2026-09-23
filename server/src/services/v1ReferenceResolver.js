const { linkedRecordIds, textValue } = require('./v1BitableGateway');

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[|｜._-]/g, '');

const relation = (recordId) => (recordId ? [recordId] : undefined);
const person = (openId) => (openId ? [{ id: openId }] : undefined);

class V1ReferenceResolver {
  constructor(gateway) {
    this.gateway = gateway;
  }

  async resolveProduct(input = {}) {
    if (input.productRecordId) return { recordId: input.productRecordId };
    const table = this.gateway.table('product');
    const records = await this.gateway.listAll('product');
    const wantedNumber = normalizeText(input.productNumber || input.number);
    const wantedItemNo = normalizeText(input.itemNo);
    const wantedColor = normalizeText(input.color);

    const matches = records.filter((record) => {
      const fields = record.fields || {};
      const number = normalizeText(textValue(fields[table.fields.number]));
      const itemNo = normalizeText(textValue(fields[table.fields.itemNo]));
      const color = normalizeText(textValue(fields[table.fields.color]));
      if (wantedNumber && number === wantedNumber) return true;
      return Boolean(wantedItemNo && itemNo === wantedItemNo && (!wantedColor || color === wantedColor));
    });

    if (matches.length === 0) {
      throw new Error(`找不到货品：${input.productNumber || input.itemNo || ''}${input.color || ''}`);
    }
    if (matches.length > 1) {
      throw new Error(`货品匹配不唯一：${input.productNumber || input.itemNo || ''}${input.color || ''}`);
    }
    return { recordId: matches[0].record_id, record: matches[0] };
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
  normalizeText,
  person,
  relation,
};
