const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { isSalesTradeType } = require('../config/salesMovements');

const normalizeText = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[|｜._-]/g, '');

const normalizeColor = (value) => normalizeText(value).replace(/色$/, '');

// 关联字段的写入形状 = **记录 id 的数组**（飞书多选关联就是多个 id 并列，单选就是长度 1）。
// ⭐ 2026-10-07：`relation` 现在**也认数组** —— 「销售主表.交易类型」是**多选**关联字段，
//    一张单可以同时是「现货 + 预付」（业务负责人：「多种交易类型，你多选就行了」）。
//    以前只收单个 id，调用点就得自己拼 `[id1, id2]`；让这一个 helper 同时管单选与多选，
//    写入形状只有一处定义（既有调用点全传单个字符串，行为逐字不变）。
const relation = (recordId) => {
  if (Array.isArray(recordId)) return recordId.length ? recordId : undefined;
  return recordId ? [recordId] : undefined;
};
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

    // 销售口述的货号不能做 OCR 字符纠错；只允许在已配置的同一货号内解析颜色。
    // AI 偶尔把中文颜色并进货号（如 8882卡），因此仅在前缀为真实货号、
    // 剩余部分全是汉字时拆分。采购仍使用下方原有的 OCR 匹配流程。
    if (input.matchMode === 'sales' && wantedItemNo) {
      // 销售只看货号：用户录单时只给货号，颜色一律交给确认卡片让用户选。
      // 这里不做任何颜色匹配，也不从货号里剥离颜色——货号对不上就明确报错让用户核对，
      // 出问题时吵闹一点，比静默替用户"修好"更容易发现 AI 的提取问题。
      const sameSku = candidates.filter((candidate) => candidate.itemNo === wantedItemNo);
      if (!sameSku.length) {
        throw new Error(`找不到货品：${input.itemNo || ''}`);
      }
      if (sameSku.length === 1) {
        return { recordId: sameSku[0].record.record_id, record: sameSku[0].record };
      }
      // 该货号有多个颜色：不猜、也不看用户说了什么，把候选交给确认卡片让用户点。
      // ⭐ 每条候选**顺手带上「货品状态」**（飞书公式：在售 / 下架）—— 谁给候选、谁带状态：
      //    现货 / 未付的候选范围（只推在售）要用**这条记录上的状态**判定，
      //    而这张表在 A 里**已经整表读过一次**了 ⇒ 带上它**零新增远端请求**。
      //    ⚠️ 字段读不到（schema 没配 / 这条没算出来）时留空串：由调用方决定怎么处理，
      //       这里不猜（空 ≠ 下架）。
      const statusField = table.fields.status;
      return {
        needsColor: true,
        itemNo: wantedItemNo,
        options: sameSku
          .map((candidate) => ({
            recordId: candidate.record.record_id,
            color: candidate.colorDisplay,
            number: candidate.number,
            status: statusField
              ? textValue(candidate.record.fields?.[statusField]).trim()
              : '',
          }))
          .sort((left, right) => String(left.color).localeCompare(String(right.color), 'zh-CN')),
      };
    }

    // 采购到货链路（产品负责人 2026-10-05 定稿的临时规则，从简，不要加额外保护分支）：
    //   拿识别出的「货号 + 颜色」去「货品信息」匹配
    //     命中   → 用它（命中多条时取第一条继续，并把条数带回去让卡片标注）
    //     没命中 → 交给调用方建新品（到货链路走 ensureArrivalProduct）
    // 刻意没有「货号在、颜色对不上就先提示核对」这一步：没有就创建，就是这么简单。

    // 「编号」是「货号|颜色|类别」的拼接，单据上经常没有类别（编号残缺）。
    // 它只作为**可选加速**：识别出完整编号时一步命中；对不上也不影响下面的主路径，
    // 所以编号绝不是必经之路。
    let matches = wantedNumber
      ? candidates.filter((candidate) => candidate.number === wantedNumber)
      : [];
    // 这里原本还有一层「归一化后的 货号+颜色 拼接 === 编号」的别名匹配，已删除：
    // 它拿拼接结果去比完整编号，而表里编号是「货号|颜色|类别」，永远命中不了；
    // 而它所表达的「货号+颜色」本来就是下面主路径要做的事，留着只会误导排查。
    //
    // 主路径：货号精确匹配，且颜色也用 normalizeColor 归一后匹配（「棕」=「棕色」）。
    if (matches.length === 0 && wantedItemNo) {
      matches = candidates.filter(
        (candidate) => candidate.itemNo === wantedItemNo
          && (!wantedColor || candidate.color === wantedColor),
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
      // 给「确实没有这条货品」一个可判定的标记：到货链路要据此自动建档。
      // 靠 error.message 做前缀匹配太脆，改文案就会静默失效。
      const notFound = new Error(`找不到货品：${input.productNumber || input.itemNo || ''}${input.color || ''}`);
      notFound.code = 'PRODUCT_NOT_FOUND';
      throw notFound;
    }
    const chosen = matches[0];
    // 命中多条（男/女鞋常共用同一货号+颜色）：不报错、不停下，取第一条继续。
    // ambiguousCount / selectedColor / selectedNumber 带回去，让到货卡片能标注
    // 「该货号+颜色匹配到 N 条，已取 XXX」——产品负责人要求这种情况"要看得见"。
    return {
      recordId: chosen.record.record_id,
      record: chosen.record,
      ambiguousCount: matches.length,
      selectedColor: chosen.colorDisplay,
      selectedNumber: chosen.number,
    };
  }

  async resolveBehavior(code) {
    const record = await this.gateway.findOneByText('behavior', 'code', code);
    if (!record) throw new Error(`行为管理中找不到已配置行为：${code}`);
    return { recordId: record.record_id, record };
  }

  /**
   * 交易类型（现货 / 未付 / 预付）落在「销售主表.交易类型」上，它关联「行为管理」。
   *
   * 只认注册表里的三个编码：行为管理里还有「销售退货 / 换货 / 赔货」这些**售后**条目，
   * 它们不是交易类型——指到它们必须报错，不能静默按现货入账。
   */
  async resolveSalesTradeType(code) {
    if (!isSalesTradeType(code)) {
      throw new Error(`未声明的销售交易类型：${code || '(空)'}`);
    }
    const table = this.gateway.table('behavior');
    const records = await this.gateway.listAll('behavior');
    const matches = records.filter((record) => textValue(record.fields?.[table.fields.code]) === code);
    if (!matches.length) throw new Error(`行为管理里找不到交易类型：${code}`);
    if (matches.length > 1) throw new Error(`行为管理里交易类型重复：${code}`);
    return { recordId: matches[0].record_id, record: matches[0] };
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
