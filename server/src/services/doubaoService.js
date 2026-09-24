const OpenAI = require('openai');
const fs = require('fs');
const { getModuleDefinition } = require('../config/modules');
const { logError, logInfo } = require('../utils/logger');

const positiveOrEmpty = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : '';
};

const normalizeSalesResult = (result = {}) => {
  const normalized = {
    intent: result.intent === 'sale' ? 'sale' : 'unsupported',
    sales_behavior: String(result.sales_behavior || '').trim(),
    behavior_code: String(result.behavior_code || '').trim(),
    item_no: String(result.item_no || '').trim(),
    color: String(result.color || '').trim(),
    size: positiveOrEmpty(result.size),
    quantity: positiveOrEmpty(result.quantity) || 1,
    gift: result.gift === true,
    gift_description: String(result.gift_description || '').trim(),
    total_paid: positiveOrEmpty(result.total_paid),
    payment_method: String(result.payment_method || '').trim(),
  };
  const missing = new Set();
  if (normalized.intent !== 'sale' || normalized.behavior_code !== 'SALE_CASH') {
    missing.add('当前只支持现货销售');
  }
  for (const key of ['item_no', 'size', 'quantity', 'total_paid', 'payment_method']) {
    if (!normalized[key]) missing.add(key);
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
你是鞋店现货销售录入助手。请把用户的一条销售原话解析为严格 JSON，不得猜测缺失信息。

当前 V1 的业务边界：一条消息只表示一笔销售、一种商品和一个尺码，只处理“现货销售”。

输出结构：
{
  "intent": "sale",
  "sales_behavior": "现货销售",
  "behavior_code": "SALE_CASH",
  "item_no": "8088-26",
  "color": "棕",
  "size": 38,
  "quantity": 1,
  "gift": false,
  "gift_description": "",
  "total_paid": 230,
  "payment_method": "微信",
  "missing_fields": []
}

规则：
1. 普通当场交货的销售：intent=\"sale\"，sales_behavior=\"现货销售\"，behavior_code=\"SALE_CASH\"。
2. 退货、换货、赔货、预付或抖音团购券等非现货销售，intent=\"unsupported\"；仍要在 sales_behavior 中识别出行为名称，behavior_code 留空。
3. item_no 只填写用户原话中的货号，不要把颜色、尺码或品类拼进货号。用户可能用任意顺序和标点表达，但货号中的数字和字母必须原样保留。
4. color 单独填写颜色；“棕色”规范为“棕”、“黑色”规范为“黑”。没有提到颜色时留空，不得猜测。
5. 示例：“8088-26棕38，230元微信，赠袜子一双”中，item_no=\"8088-26\"，color=\"棕\"，size=38，quantity=1，gift=true，gift_description=\"袜子一双\"，total_paid=230，payment_method=\"微信\"。
6. “一双”数量为 1；没写数量但语义明确为单件商品时，quantity=1。“赠”“送”后的物品是赠品，不是销售商品数量。
7. 必填业务要素为 item_no、size、quantity、total_paid、payment_method。缺少时在 missing_fields 中使用这些字段名。color 不是全局必填项；如果同一货号对应多个颜色，后端会要求用户补充。gift 未提及时为 false，gift_description 为空字符串。
8. 销售单价、应收金额、优惠金额等由多维表格公式自动计算，不要输出。
9. 只输出 JSON，不输出 Markdown 或说明。

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
      return normalizeSalesResult(result);
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
5. 尺码必须是数字，数量必须是正整数；无法确定时不要猜测，返回空数组。
6. 只输出 JSON，不输出 Markdown 或说明。
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
        const size = Number(item.size);
        const quantity = Number(item.quantity);
        if (!Number.isFinite(size) || !Number.isFinite(quantity) || size <= 0 || quantity <= 0) {
          throw new Error('采购报单中的尺码或数量无效');
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
