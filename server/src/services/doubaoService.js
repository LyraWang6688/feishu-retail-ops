const OpenAI = require('openai');
const fs = require('fs');
const { getModuleDefinition } = require('../config/modules');
const { logError, logInfo } = require('../utils/logger');

const positiveOrEmpty = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : '';
};
const moneyOrEmpty = (value) => {
  const number = positiveOrEmpty(value);
  return number && Math.abs(number * 100 - Math.round(number * 100)) < 1e-6 ? number : '';
};

const normalizeSalesResult = (result = {}) => {
  const rawItems = Array.isArray(result.items) && result.items.length ? result.items : [result];
  const items = [];
  for (const item of rawItems) {
    const giftDescription = String(item.gift_description || '').trim();
    const gift = item.gift === true || Boolean(giftDescription);
    // Some model responses turn a free gift into a separate shoe item. It is
    // not a sold SKU; attach it to the preceding sold item instead.
    if (gift && !positiveOrEmpty(item.size) && items.length) {
      items[items.length - 1].gift = true;
      items[items.length - 1].gift_description = giftDescription || String(item.item_no || '').trim();
      continue;
    }
    items.push({
      item_no: String(item.item_no || '').trim(),
      color: String(item.color || '').trim(),
      size: positiveOrEmpty(item.size),
      quantity: positiveOrEmpty(item.quantity) || 1,
      actual_amount: moneyOrEmpty(item.actual_amount),
      gift,
      gift_description: giftDescription,
    });
  }
  const rawPayments = Array.isArray(result.payments)
    ? result.payments
    : result.total_paid || result.payment_method
      ? [{ amount: result.total_paid, method: result.payment_method }]
      : [];
  const payments = rawPayments.map((payment) => ({
    amount: moneyOrEmpty(payment.amount), method: String(payment.method || '').trim(),
  }));
  let agreedTotal = moneyOrEmpty(result.agreed_total);
  if (items.length === 1 && !items[0].actual_amount && agreedTotal) items[0].actual_amount = agreedTotal;
  if (!agreedTotal && items.length && items.every((item) => item.actual_amount)) {
    agreedTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) * 100) / 100;
  }
  const first = items[0] || {};
  const normalized = {
    intent: result.intent === 'sale' ? 'sale' : 'unsupported',
    delivery_status: ['已交付', '未交付'].includes(result.delivery_status) ? result.delivery_status : '待确认',
    ...first,
    items,
    payments,
    agreed_total: agreedTotal,
    total_paid: payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || '',
    payment_method: payments.map((payment) => payment.method).filter(Boolean).join('＋'),
  };
  const missing = new Set();
  if (normalized.intent !== 'sale') missing.add('当前只支持商品销售录单');
  for (const [index, item] of items.entries()) {
    for (const key of ['item_no', 'size', 'quantity', 'actual_amount']) {
      if (!item[key]) missing.add(`items[${index}].${key}`);
    }
  }
  if (items.length && items.every((item) => item.actual_amount) && agreedTotal &&
    Math.abs(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) - agreedTotal) > 0.005) {
    missing.add('逐双成交金额合计与整单成交金额不一致');
  }
  for (const [index, payment] of payments.entries()) {
    if (!payment.amount) missing.add(`payments[${index}].amount`);
    if (!payment.method) missing.add(`payments[${index}].method`);
  }
  normalized.missing_fields = [...missing];
  return normalized;
};

/**
 * Doubao (Volcengine Ark) Vision Service
 * Uses OpenAI SDK to interact with the Doubao LLM.
 */
class DoubaoService {
  constructor() {
    this.apiKey = process.env.ARK_API_KEY;
    this.endpointId = process.env.ARK_MODEL_ENDPOINT; // The model custom endpoint ID
    this.baseURL = process.env.ARK_API_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
    this.client = null;
  }

  getClient() {
    if (this.client) return this.client;
    const apiKey = process.env.ARK_API_KEY;
    const baseURL = process.env.ARK_API_BASE_URL || this.baseURL;
    this.client = new OpenAI({ apiKey, baseURL });
    return this.client;
  }

  async parseSalesText(text) {
    this.apiKey = process.env.ARK_API_KEY;
    this.endpointId = process.env.ARK_MODEL_ENDPOINT;
    if (!this.apiKey || !this.endpointId) {
      throw new Error('ARK_API_KEY or ARK_MODEL_ENDPOINT is not configured in .env');
    }
    const originalText = String(text || '').trim();
    if (!originalText) throw new Error('销售原文不能为空');

    const prompt = `
你是鞋店销售首单录入助手。请把用户的一条销售原话解析为严格 JSON，不得猜测缺失信息。

一条消息表示一笔销售，可以包含多双鞋和多种付款方式。只解析事实，不计算售价或猜测交付。

输出结构：
{
  "intent": "sale",
  "delivery_status": "待确认",
  "items": [{"item_no":"8088-26","color":"棕","size":38,"quantity":1,"actual_amount":230,"gift":false,"gift_description":""}],
  "payments": [{"amount":230,"method":"微信"}],
  "agreed_total": 230
}

规则：
1. 商品销售（含当场收款、预付、先交货后付款）intent=\"sale\"；退货、换货、赔货 intent=\"unsupported\"。不输出销售行为字段。
2. 明确说已拿走/已交给顾客时 delivery_status=\"已交付\"；明确说还没货、之后来拿时为\"未交付\"；否则为\"待确认\"。最终由用户在确认卡选择，不凭付款情况推断交付。
3. item_no 只填写用户原话中的货号，不要把颜色、尺码或品类拼进货号。用户可能用任意顺序和标点表达，但货号中的数字和字母必须原样保留。
4. color 单独填写颜色；“棕色”规范为“棕”、“黑色”规范为“黑”。没有提到颜色时留空，不得猜测。
5. “628-6米紫361一双”是货号 628-6、颜色米紫、36码、数量1；末尾的 1 是数量，不是 361 码。
6. 多双鞋必须从原话分别提取每件成交金额，actual_amount 是该明细数量对应的成交总额。只给整单金额而未给各件金额时，各件 actual_amount 留空，要求补充；严禁按标价分摊或猜测。
7. “150元微信，100元现金”必须输出两笔 payments；“260元未付”是 agreed_total=260、payments=[]，不得输出已收款；“定金50元”但未说支付方式时，payments 包含 amount=50、method=""，供用户补充。
8. “一双”数量为 1；没写数量但语义明确为单件商品时，quantity=1。“赠”“送”后的物品是赠品，不是销售商品数量。赠品必须写进前一件销售商品的 gift=true、gift_description，不得作为新 item。例如“赠袜子一双”写 gift_description="袜子一双"；“赠鞋垫一双”写 gift_description="鞋垫一双"。
9. 单件商品明确说了总成交金额，可将其作为该件 actual_amount；仅有“定金”不能作为成交金额。多件逐件金额已知时可求和为 agreed_total。标价与自动公式不参与成交金额判断。
10. 只输出 JSON，不输出 Markdown 或说明。

用户原话：${originalText}
    `.trim();

    const response = await this.getClient().chat.completions.create({
      model: this.endpointId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content || '';
    try {
      const result = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
      const normalized = normalizeSalesResult(result);
      // For the one-shoe MVP, a gift explicitly present in the source text
      // must not disappear just because the model omitted gift fields.
      if (normalized.items.length === 1 && !normalized.items[0].gift) {
        const explicitGift = originalText.match(/(?:赠送?|送)([^，,。；;、]+?)(?=[，,。；;、]|$)/);
        if (explicitGift) {
          normalized.items[0].gift = true;
          normalized.items[0].gift_description = explicitGift[1].trim();
          normalized.gift = true;
          normalized.gift_description = normalized.items[0].gift_description;
        }
      }
      return normalized;
    } catch (error) {
      throw new Error(`销售文字解析失败: ${error.message}`);
    }
  }

  async parsePurchaseReportText(text) {
    this.apiKey = process.env.ARK_API_KEY;
    this.endpointId = process.env.ARK_MODEL_ENDPOINT;
    if (!this.apiKey || !this.endpointId) throw new Error('ARK_API_KEY or ARK_MODEL_ENDPOINT is not configured in .env');
    const originalText = String(text || '').trim();
    if (!originalText) throw new Error('采购报单说明不能为空');
    const prompt = `
你是鞋店采购报单解析助手。请把一段采购报单说明解析为严格 JSON 数组，只识别尺码和数量，不要猜测未出现的内容。
输出格式：{"items":[{"size":39,"quantity":1}]}
规则：
1. “39-42各一双”表示39、40、41、42，每个数量1。
2. “39到42各两双”表示39、40、41、42，每个数量2。
3. “4042各一双”表示40和42各1双。
4. “39一双、40两双”分别输出两条。
5. 鞋码通常在35-48之间。如果出现"421双"、"441双"这样的写法，表示"42码1双"、"44码1双"（最后一位数字是数量，前面的数字是尺码）。类似地，"402双"=40码2双，"383双"=38码3双。
6. 尺码必须是数字且在35-48之间，数量必须是正整数；无法确定时不要猜测，返回空数组。
7. 只输出 JSON，不输出 Markdown 或说明。
采购报单说明：${originalText}`.trim();
    const response = await this.getClient().chat.completions.create({
      model: this.endpointId,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content || '';
    try {
      const parsed = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(items) || !items.length) throw new Error('未识别出有效尺码数量');
      return items.map((item) => {
        let size = Number(item.size);
        let quantity = Number(item.quantity);
        // 兜底：如果尺码超出35-48范围，尝试拆分为"尺码+数量"（如421=42码1双）
        if (Number.isFinite(size) && size > 48 && String(size).length >= 2) {
          const sizeStr = String(size);
          const possibleSize = Number(sizeStr.slice(0, -1));
          const possibleQty = Number(sizeStr.slice(-1));
          if (possibleSize >= 35 && possibleSize <= 48 && possibleQty > 0) {
            size = possibleSize;
            quantity = possibleQty;
          }
        }
        if (!Number.isFinite(size) || !Number.isFinite(quantity) || size < 35 || size > 48 || quantity <= 0) {
          throw new Error('采购报单中的尺码或数量无效（尺码需在35-48之间）');
        }
        return { size, quantity };
      });
    } catch (error) {
      throw new Error(`采购报单解析失败: ${error.message}`);
    }
  }

  /**
   * Recognize shoe box labels from a local image file.
   * @param {string} filePath - Path to the image file.
   * @param {string} moduleKey - purchase / sales / inventory
   * @returns {Promise<Array>} - List of recognized shoe box objects.
   */
  async recognizeLabels(filePath, moduleKey = 'purchase') {
    try {
      this.apiKey = process.env.ARK_API_KEY;
      this.endpointId = process.env.ARK_MODEL_ENDPOINT;
      this.baseURL = process.env.ARK_API_BASE_URL || this.baseURL;
      if (!this.apiKey || !this.endpointId) {
        throw new Error('ARK_API_KEY or ARK_MODEL_ENDPOINT is not configured in .env');
      }

      // 1. Convert image to base64
      const imageBase64 = fs.readFileSync(filePath, { encoding: 'base64' });
      const imageData = `data:image/jpeg;base64,${imageBase64}`;

      const moduleConfig = getModuleDefinition(moduleKey);
      const supplierRule = moduleConfig.recognition.requireSupplier
        ? '4. supplier: 供应商（即标签上的品牌或厂家名称，如 豪路, Nike, 耐克旗舰店 等）'
        : '4. supplier: 供应商（可选字段，若未识别到返回空字符串 ""）';

      // 2. Prepare the prompt for shoe box recognition
      const prompt = `
你是一个专业的仓库盘点助手。请识别图片中所有的鞋盒标签。
一张图片中可能包含多个鞋盒标签，请务必提取出每一个标签的信息。

对于每一个识别出的标签，请提取以下字段：
1. item_no: 货号（通常是字母和数字的组合，如 CW2288-111, DD1391-100）
2. color: 颜色（如 纯白, 黑白, 灰/白 等）
3. size: 尺码（请输出标准欧码）。
   【判断与转换规则】：
   - 若识别到的尺码数值在 225–285 之间（如 240、250），视为毫米制，需转换：欧码 = (数值 - 50) / 5。示例：240 → 38，250 → 40。
   - 若识别到的尺码数值在 34–48 之间（如 38、40），视为欧码，无需转换。
   - 只返回最终欧码数值（如 40），不要输出任何解释。若未识别到，返回空字符串 ""。
${supplierRule}

请严格以 JSON 数组格式返回结果，不要包含任何解释性文字或 Markdown 代码块标记。
示例输出：
[
  {"item_no": "CW2288-111", "color": "白色", "size": "42.5", "supplier": "Nike"},
  {"item_no": "EG4958", "color": "黑色", "size": "38", "supplier": "豪路"}
]
      `.trim();

      // 3. Call Doubao API using OpenAI SDK
      const response = await this.getClient().chat.completions.create({
        model: this.endpointId,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: { url: imageData }
              }
            ]
          }
        ],
        temperature: 0.1, // Lower temperature for more stable JSON output
      });

      // 4. Parse the JSON response
      const content = response.choices[0].message.content;
      logInfo('recognition.doubao.raw_received', {
        module: moduleConfig.key,
        raw_length: String(content || '').length,
      });

      // Clean the response (sometimes AI wraps it in ```json ... ```)
      const cleanedContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
      
      try {
        const results = JSON.parse(cleanedContent);
        if (!Array.isArray(results)) {
          throw new Error('AI 返回结果不是数组格式');
        }
        return results;
      } catch (parseError) {
        logError('recognition.doubao.parse_failed', {
          module: moduleConfig.key,
          raw_length: cleanedContent.length,
          error: parseError.message,
        });
        throw new Error('AI 响应格式错误，无法解析 JSON: ' + parseError.message);
      }
    } catch (error) {
      logError('recognition.doubao.failed', {
        module: moduleKey,
        error: error.message,
        status: error.status,
      });
      if (error.status) {
        logError('recognition.doubao.api_status', { module: moduleKey, status: error.status });
      }
      throw new Error('AI识别失败: ' + error.message);
    }
  }
}

module.exports = new DoubaoService();
module.exports.normalizeSalesResult = normalizeSalesResult;
