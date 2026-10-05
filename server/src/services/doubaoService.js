const OpenAI = require('openai');
const fs = require('fs');
const { getModuleDefinition } = require('../config/modules');
const { logError, logInfo } = require('../utils/logger');
const { applyGroupBuyVoucherPolicy } = require('./groupBuyVoucherPolicy');
const { parseUnitCost } = require('./arrivalCostPolicy');
const { resolveLlm, assertLlmConfigured } = require('../config/llmModels');

// Log only the sale fields needed to compare AI extraction with deterministic
// normalization. Never log the complete user message, prompt or raw model JSON.
const salesParseSnapshot = (result = {}) => ({
  intent: result.intent,
  trade_type: result.trade_type,
  items: (Array.isArray(result.items) && result.items.length ? result.items : [result]).map((item) => ({
    item_no: String(item.item_no || '').slice(0, 80),
    color: String(item.color || '').slice(0, 40),
    size: item.size,
    quantity: item.quantity,
    actual_amount: item.actual_amount,
    gift: item.gift,
    gift_description: String(item.gift_description || '').slice(0, 100),
  })),
  payments: (Array.isArray(result.payments) ? result.payments : []).map((payment) => ({
    method: String(payment.method || '').slice(0, 40), amount: payment.amount, status: payment.status,
  })),
  agreed_total: result.agreed_total,
  total_paid: result.total_paid,
  payment_method: result.payment_method,
  missing_fields: (Array.isArray(result.missing_fields) ? result.missing_fields : [])
    .map((field) => String(field).slice(0, 100)),
});

const explicitSingleShoeGifts = (sourceText) => [...String(sourceText || '')
  .matchAll(/(?:赠送?|送)(?:了)?\s*([^，,。；;、]+?)(?=[，,。；;、]|$)/g)]
  .map((match) => match[1].trim().replace(/^双(?=鞋垫|袜子|鞋带)/, '一双')).filter(Boolean);

const depositTerms = (sourceText) => {
  const source = String(sourceText || '');
  if (!/定金/.test(source)) return null;
  const deposit = source.match(/定金\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?|[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)\s*定金/);
  const tail = source.match(/尾款\s*(?:以后|之后|下次|到货后|取货时)?\s*(?:还要|再)?\s*(?:付|给|是|为)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块)?/);
  if (!deposit) return { issues: ['请明确已经收到的定金金额'] };
  const depositAmount = Number(deposit[1] || deposit[2]);
  if (!tail) return { depositAmount, issues: [] };
  if (!/下次|以后|之后|到货后|取货时|来拿时|还要|待付|未付|再付/.test(source)) {
    return { issues: ['请说明尾款是否已支付；若尚未支付，请写“尾款以后付”'] };
  }
  return { depositAmount, tailAmount: Number(tail[1]), issues: [] };
};

const positiveOrEmpty = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : '';
};
const moneyOrEmpty = (value) => {
  const number = positiveOrEmpty(value);
  return number && Math.abs(number * 100 - Math.round(number * 100)) < 1e-6 ? number : '';
};

const normalizeSalesResult = (result = {}, sourceText = '', { vouchers = [] } = {}) => {
  const rawItems = Array.isArray(result.items) && result.items.length ? result.items : [result];
  const items = [];
  for (const item of rawItems) {
    const giftDescription = String(item.gift_description || '').trim();
    const gift = item.gift === true || Boolean(giftDescription);
    // 配品（腰带、鞋油、袜子、包等）：没有货号、颜色、尺码，只有名字和金额。
    // 必须在「赠品归并」之前判断，否则一件配品会被当成上一件鞋的赠品。
    if (item.kind === 'accessory' || (!item.item_no && item.accessory_name)) {
      items.push({
        kind: 'accessory',
        accessory_name: String(item.accessory_name || item.name || '').trim(),
        quantity: positiveOrEmpty(item.quantity) || 1,
        actual_amount: moneyOrEmpty(item.actual_amount),
        gift,
        gift_description: giftDescription,
      });
      continue;
    }
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
  let payments = rawPayments.map((payment) => ({
    amount: moneyOrEmpty(payment.amount), method: String(payment.method || '').trim(),
  }));
  let agreedTotal = moneyOrEmpty(result.agreed_total);
  if (items.length === 1 && !items[0].actual_amount && agreedTotal) items[0].actual_amount = agreedTotal;
  if (!agreedTotal && items.length && items.every((item) => item.actual_amount)) {
    agreedTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount), 0) * 100) / 100;
  }
  const deposit = depositTerms(sourceText);
  if (deposit && !deposit.issues.length) {
    const matching = payments.filter((payment) => Number(payment.amount) === deposit.depositAmount);
    if (matching.length === 1) {
      const spokenMethod = sourceText.match(/(微信|现金|支付宝)\s*(?:支付|付|交|收)?\s*定金/)?.[1] ||
        sourceText.match(/定金\s*[¥￥]?\s*\d+(?:\.\d{1,2})?\s*(?:元|块)?\s*(微信|现金|支付宝)/)?.[1];
      payments = [{ ...matching[0], method: spokenMethod || matching[0].method }];
    }
    else deposit.issues.push('请明确本次定金的支付方式');
    if (deposit.tailAmount && items.length !== 1) {
      // 定金 + 尾款的推导只对「整单一条明细」成立：多行时无法判断尾款属于哪一件。
      // 以前是整块跳过，应收金额被静默算丢（不报错、金额却不对），所以改成明确拒绝。
      deposit.issues.push('定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额');
    } else if (deposit.tailAmount) {
      const expectedTotal = Math.round((deposit.depositAmount + deposit.tailAmount) * 100) / 100;
      const statedPrice = sourceText.match(/(?:成交价|成交金额|总价)\s*(?:是|为)?\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)/);
      if (statedPrice && Number(statedPrice[1]) !== expectedTotal) {
        deposit.issues.push('成交价与定金加尾款不一致，请核对');
      }
      agreedTotal = expectedTotal;
      items[0].actual_amount = agreedTotal;
    }
  }
  const voucherPolicy = applyGroupBuyVoucherPolicy({ sourceText, items, payments, vouchers });
  if (voucherPolicy?.items) {
    items.splice(0, items.length, ...voucherPolicy.items);
    payments = voucherPolicy.payments;
    agreedTotal = voucherPolicy.agreedTotal;
  }
  const first = items[0] || {};
  // 交易类型由 AI 从原话判断，但只认三种；说不清时按现货处理——
  // 门店绝大多数是"当场收钱当场交货"，不说不给钱就是现货（不是猜，是业务前提）。
  // 交付状态不在这里定：它由 SALES_MOVEMENTS 从交易类型推出来。
  const tradeType = ['现货', '未付', '预付'].includes(result.trade_type) ? result.trade_type : '现货';
  const normalized = {
    intent: result.intent === 'sale' ? 'sale' : 'unsupported',
    trade_type: tradeType,
    ...first,
    items,
    payments,
    agreed_total: agreedTotal,
    total_paid: payments.filter((payment) => payment.status !== '待平台结算')
      .reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || '',
    total_covered: payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0) || '',
    payment_method: payments.map((payment) => payment.method).filter(Boolean).join('＋'),
  };
  if (voucherPolicy?.voucher) normalized.voucher = voucherPolicy.voucher;
  normalized.voucher_policy_blocked = Boolean(voucherPolicy?.issues?.length);
  const missing = new Set([...(voucherPolicy?.issues || []), ...(deposit?.issues || [])]);
  if (normalized.intent !== 'sale') missing.add('当前只支持商品销售录单');
  for (const [index, item] of items.entries()) {
    // 配品没有货号、颜色和尺码，只要求名字、数量和金额。
    const requiredKeys = item.kind === 'accessory'
      ? ['accessory_name', 'quantity', ...(normalized.voucher_policy_blocked ? [] : ['actual_amount'])]
      : ['item_no', 'size', 'quantity', ...(normalized.voucher_policy_blocked ? [] : ['actual_amount'])];
    for (const key of requiredKeys) {
      if (!item[key]) missing.add(`items[${index}].${key}`);
    }
    if (item.quantity !== 1) missing.add(`第${index + 1}件请逐双列出成交金额；每条销售明细只能记录一双`);
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
 * 到货单（供应商出库单 / 送货单）上的尺码可能是欧码，也可能是毫米制（225~285）。
 *
 * 鞋盒标签的换算写在提示词里就够了；单据是**表格照片**，模型很容易把表头那一排
 * 尺码数字原样抄下来，所以这里再做一次确定性换算作为兜底，规则与鞋盒提示词一致：
 * 欧码 = (数值 - 50) / 5。换算只此一处，两条识别路径不会算出不同的码。
 */
const normalizeDocumentSize = (value) => {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const size = raw >= 225 && raw <= 285 ? (raw - 50) / 5 : raw;
  return Number.isInteger(size) && size > 0 ? size : 0;
};

/**
 * 把到货单识别的原始行整理成「一条明细 = 一个尺码」的扁平数组：
 *   [{ item_no, color, size, quantity, unit_cost? }]
 * 丢掉货号缺失、尺码或数量不是正整数的行——宁可少入库几双让她核对，
 * 也不能凭一个读不准的数字把货写进库存。
 *
 * unit_cost 是供应商单据上的单件价格（对我们就是成本）。它是**可选**的：
 * 单据上没有价格列时模型不回这个字段，行上就不会有 unit_cost，
 * 下游据此判断「这次没有可信价格，不写成本」（见 arrivalCostPolicy）。
 * 解析不出来的价格同样不挂到行上——宁可没有，也不能带个错值往下走。
 *
 * 只在真的解析出正数时才加这个 key：normalizeDocumentRows 的返回值被
 * deepEqual 断言逐字段比对，无脑加 `unit_cost: null` 会平白改变已有契约。
 */
const normalizeDocumentRows = (rows) => (Array.isArray(rows) ? rows : [])
  .map((row) => {
    const normalized = {
      item_no: String(row?.item_no ?? row?.itemNo ?? '').trim(),
      color: String(row?.color ?? '').trim(),
      size: normalizeDocumentSize(row?.size),
      quantity: Number(row?.quantity ?? 1),
    };
    // 模型可能把它叫 unit_cost / unitCost / cost / price（「销售价」列对我们是成本）。
    // 刻意不收 amount / 金额：那是整行合计，不是单件价。
    const unitCost = parseUnitCost(row?.unit_cost ?? row?.unitCost ?? row?.cost ?? row?.price);
    if (unitCost !== null) normalized.unit_cost = unitCost;
    return normalized;
  })
  .filter((row) => row.item_no && row.size > 0 && Number.isInteger(row.quantity) && row.quantity > 0);

/**
 * 图片识别的硬超时。
 *
 * OpenAI SDK 默认 `timeout = 600000`（10 分钟）且失败重试 2 次，也就是一次视觉调用
 * 最坏能挂半小时——而这段时间用户只会看到「识别中」。2026-10-05 的线上故障里，
 * 一次成功的到货单识别就用了 118 秒，期间记录、卡片、日志一片空白。
 *
 * 默认 60 秒：宁可超时失败并明确告诉她「重传一次」，也不要让她对着「识别中」干等。
 * 需要更宽就调 VISION_LLM_TIMEOUT_MS（毫秒）；调不动代码就往环境变量走。
 * 文字模型（销售录单）保持 SDK 默认值不变——那条链路不在这次修复范围内。
 */
const DEFAULT_VISION_TIMEOUT_MS = 60_000;
const visionTimeoutMs = (env = process.env) => {
  const raw = Number(env.VISION_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VISION_TIMEOUT_MS;
};

/**
 * Doubao (Volcengine Ark) Vision Service
 * Uses OpenAI SDK to interact with the Doubao LLM.
 */
class DoubaoService {
  constructor() {
    this.clients = Object.create(null);
  }

  /**
   * 取某一组模型的配置（文字 / 图片）。
   * 具体用哪家、哪个模型由 config/llmModels 决定，这里只负责取。
   */
  resolveModel(kind = 'text') {
    return assertLlmConfigured(resolveLlm(kind, process.env));
  }

  getClient(kind = 'text') {
    if (this.clients[kind]) return this.clients[kind];
    const { apiKey, baseURL } = this.resolveModel(kind);
    this.clients[kind] = new OpenAI({
      apiKey,
      baseURL,
      // 视觉这一组必须有上限，而且不重试：重试会把最坏耗时再乘一遍，
      // 而到货链路"卡住"的代价（用户以为系统死了）比一次失败大得多。
      ...(kind === 'vision' ? { timeout: visionTimeoutMs(), maxRetries: 0 } : {}),
    });
    return this.clients[kind];
  }

  async parseSalesText(text, { taskId, accessoryNames = [], vouchers = [] } = {}) {
    const llm = this.resolveModel('text');
    const originalText = String(text || '').trim();
    if (!originalText) throw new Error('销售原文不能为空');

    const prompt = `
你是鞋店销售首单录入助手。请把用户的一条销售原话解析为严格 JSON，不得猜测缺失信息。

一条消息表示一笔销售，可以包含多双鞋和多种付款方式。只解析事实，不计算售价。

输出结构：
{
  "intent": "sale",
  "trade_type": "现货",
  "items": [{"item_no":"8088-26","color":"棕","size":38,"quantity":1,"actual_amount":230,"gift":false,"gift_description":""}],
  "payments": [{"amount":230,"method":"微信"}],
  "agreed_total": 230
}

规则：
1. 商品销售（含当场收款、预付、先交货后付款）intent=\"sale\"；退货、换货、赔货 intent=\"unsupported\"。不输出销售行为字段。
2. trade_type 是这笔交易的**性质**，只能填「现货」「未付」「预付」三者之一：
   · 提到定金 / 先付 / 预定 → \"预付\"（货没拿走，之后来取）
   · 明确说未付 / 欠着 / 下次再给 → \"未付\"（鞋拿走，钱还没给）
   · 其余一律 \"现货\"（当场收款当场交货——门店绝大多数是这一种，不说不给钱就是现货）
   团购券只是一种**支付方式**（钱延期结算），不影响 trade_type；用券买走一双鞋仍然是现货。
   不要输出交付状态，后端会按 trade_type 决定是否交付。
3. item_no 只填写用户原话中的货号，不要把颜色、尺码或品类拼进货号。用户可能用任意顺序和标点表达，但货号中的数字和字母必须原样保留。
4. color 单独填写颜色；“棕色”规范为“棕”、“黑色”规范为“黑”。没有提到颜色时留空，不得猜测。
5. “628-6米紫361一双”是货号 628-6、颜色米紫、36码、数量1；末尾的 1 是数量，不是 361 码。
6. 多双鞋必须从原话分别提取每件成交金额，actual_amount 是该明细数量对应的成交总额。只给整单金额而未给各件金额时，各件 actual_amount 留空，要求补充；严禁按标价分摊或猜测。
7. “150元微信，100元现金”必须输出两笔 payments；“260元未付”是 agreed_total=260、payments=[]，不得输出已收款；“定金50元”但未说支付方式时，payments 包含 amount=50、method=""，供用户补充。
8. “一双”数量为 1；没写数量但语义明确为单件商品时，quantity=1。“赠”“送”后的物品是赠品，不是销售商品数量。赠品必须写进前一件销售商品的 gift=true、gift_description，不得作为新 item。例如“赠袜子一双”写 gift_description="袜子一双"；“赠鞋垫一双”写 gift_description="鞋垫一双"。
9. 单件商品明确说了总成交金额，可将其作为该件 actual_amount；仅有“定金”不能作为成交金额。多件逐件金额已知时可求和为 agreed_total。标价与自动公式不参与成交金额判断。
10. 遇到“89.9/89块9抵100”的团购券，只把实际付给门店的微信/现金等放入 payments；券的购买价 89.9 元和抵扣面额 100 元都不是门店已收现金，不要把它们当成 payments。不要猜测平台结算金额，后端会按已配置券种确定性换算。单鞋券后成交金额无法从原话直接确定时可留空，由后端结合实际支付和券种换算。
11. 配品（不是鞋，没有尺码）：${accessoryNames.length ? accessoryNames.join('、') : '（本租户未配置配品）'}。
    如果某件是上面列出的配品，输出 {"kind":"accessory","accessory_name":"名称","quantity":1,"actual_amount":金额}，
    不要填 item_no、color、size。accessory_name 必须与上面列表里的写法**完全一致**，不许改写、简写或自造名称；
    原话里的说法与列表对不上时，accessory_name 照抄原话，由后端判断。
12. 只输出 JSON，不输出 Markdown 或说明。

用户原话：${originalText}
    `.trim();

    const response = await this.getClient('text').chat.completions.create({
      model: llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      response_format: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content || '';
    try {
      const result = JSON.parse(content.replace(/```json/g, '').replace(/```/g, '').trim());
      logInfo('sales.ai.parsed', { task_id: taskId, ...salesParseSnapshot(result) });
      const normalized = normalizeSalesResult(result, originalText, { vouchers });
      // For one shoe, the original words are authoritative for every gift,
      // even when the model recognizes only the first one.
      if (normalized.items.length === 1) {
        const gifts = explicitSingleShoeGifts(originalText);
        if (gifts.length) {
          normalized.items[0].gift = true;
          normalized.items[0].gift_description = [...new Set(gifts)].join('、');
          normalized.gift = true;
          normalized.gift_description = normalized.items[0].gift_description;
        }
      }
      logInfo('sales.ai.normalized', { task_id: taskId, ...salesParseSnapshot(normalized),
        voucher: normalized.voucher });
      return normalized;
    } catch (error) {
      throw new Error(`销售文字解析失败: ${error.message}`);
    }
  }

  async parsePurchaseReportText(text, { selectedSizes = [] } = {}) {
    const llm = this.resolveModel('text');
    const originalText = String(text || '').trim();
    if (!originalText) throw new Error('采购报单说明不能为空');
    const allowedSizes = selectedSizes.map(Number);
    if (!allowedSizes.length || allowedSizes.some((size) => !Number.isSafeInteger(size) || size <= 0)) {
      throw new Error('采购报单已选尺码必须是正整数');
    }
    const prompt = `
你是鞋店采购数量说明解析助手。表单已经明确勾选尺码：${allowedSizes.join('、')}。
请只从数量说明中识别“数量不是默认一双”的例外，不要补充未勾选尺码，也不要输出没有特别说明的尺码。
输出格式：{"items":[{"size":39,"quantity":1}]}
规则：
1. 数量说明没有提到的已选尺码由后端保持默认一双，不需要输出。
2. 如果说明是在确认“全部按默认一双”（例如“各一双”“每个码一双”“都是一双”“按默认来”），
   必须输出全部已选尺码且数量都是 1，不能返回空数组——这种情况数量是明确的，不是语义不明确。
3. “40两双”只输出40码数量2；“每个码两双”输出全部已选尺码数量2。
4. 只能输出已选尺码列表中的正整数尺码；禁止输出42.5等小数尺码。
5. 数量必须是正整数。只有在完全无法判断数量时才返回空数组，不得猜测。
6. 只输出 JSON，不输出 Markdown 或说明。
数量说明：${originalText}`.trim();
    const response = await this.getClient('text').chat.completions.create({
      model: llm.model,
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
        if (!Number.isSafeInteger(size) || size <= 0 || !allowedSizes.includes(size)) {
          throw new Error(`数量说明包含未勾选或无效的尺码：${item.size}`);
        }
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('采购数量必须是正整数');
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
      // 图片识别单独一组模型：它必须是支持视觉的，跟文字解析的选型理由不同。
      const llm = this.resolveModel('vision');

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
3. size: 尺码（请输出标准欧码正整数；本业务不使用半码）。
   【判断与转换规则】：
   - 若识别到的尺码数值在 225–285 之间（如 240、250），视为毫米制，需转换：欧码 = (数值 - 50) / 5。示例：240 → 38，250 → 40。
   - 若识别到的尺码数值在 34–48 之间（如 38、40），视为欧码，无需转换。
   - 只返回最终欧码正整数（如 40），不要输出42.5等半码。若未识别到，返回空字符串 ""。
${supplierRule}
5. gender: 标签上的「品名」，只输出「男」或「女」（如「品名：女鞋」→「女」）；识别不到返回空字符串 ""。
   到货时用它判断这个新品该进男鞋还是女鞋，猜错比空着更麻烦。

请严格以 JSON 数组格式返回结果，不要包含任何解释性文字或 Markdown 代码块标记。
示例输出：
[
  {"item_no": "CW2288-111", "color": "白色", "size": "42", "supplier": "Nike", "gender": "男"},
  {"item_no": "EG4958", "color": "黑色", "size": "38", "supplier": "豪路", "gender": "女"}
]
      `.trim();

      // 3. Call Doubao API using OpenAI SDK
      const response = await this.getClient('vision').chat.completions.create({
        model: llm.model,
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

  /**
   * 识别**供应商到货单**（出库单 / 送货单）的照片。
   *
   * 与 recognizeLabels 的区别：鞋盒标签是「一张图 = 几个鞋盒」，到货单是
   * 「一张表格 = 很多个款号×颜色×尺码」，所以这里要求模型直接摊平成一条条明细。
   *
   * 刻意不加 response_format：契约要的是 **JSON 数组**，而 json_object 只保证
   * 返回对象（recognizeLabels 也是同样的取舍）。
   *
   * @param {string} filePath - 本地图片路径
   * @param {string} moduleKey - purchase / sales / inventory
   * @returns {Promise<Array>} - [{ item_no, color, size, quantity, unit_cost? }]
   */
  async recognizePurchaseDocument(filePath, moduleKey = 'purchase') {
    try {
      const llm = this.resolveModel('vision');
      const imageBase64 = fs.readFileSync(filePath, { encoding: 'base64' });
      const imageData = `data:image/jpeg;base64,${imageBase64}`;

      const moduleConfig = getModuleDefinition(moduleKey);
      const prompt = moduleConfig.recognition?.document?.prompt;
      if (!prompt) throw new Error('未配置到货单识别提示词（recognition.document.prompt）');

      const response = await this.getClient('vision').chat.completions.create({
        model: llm.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageData } },
            ],
          },
        ],
        temperature: 0.1,
      });

      const content = response.choices?.[0]?.message?.content || '';
      logInfo('recognition.document.raw_received', {
        module: moduleConfig.key,
        raw_length: String(content || '').length,
      });

      const cleanedContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
      try {
        const results = JSON.parse(cleanedContent);
        if (!Array.isArray(results)) throw new Error('AI 返回结果不是数组格式');
        const normalized = normalizeDocumentRows(results);
        // 单据上到底有没有价格列，只能靠线上日志回答：两列都不配置也没有可观测性。
        logInfo('recognition.document.normalized', {
          module: moduleConfig.key,
          row_count: normalized.length,
          rows_with_unit_cost: normalized.filter((row) => row.unit_cost !== undefined).length,
        });
        return normalized;
      } catch (parseError) {
        logError('recognition.document.parse_failed', {
          module: moduleConfig.key,
          raw_length: cleanedContent.length,
          error: parseError.message,
        });
        throw new Error('到货单响应格式错误，无法解析 JSON: ' + parseError.message);
      }
    } catch (error) {
      logError('recognition.document.failed', {
        module: moduleKey,
        error: error.message,
        status: error.status,
      });
      throw new Error('AI识别到货单失败: ' + error.message);
    }
  }
}

module.exports = new DoubaoService();
module.exports.normalizeSalesResult = normalizeSalesResult;
module.exports.normalizeDocumentRows = normalizeDocumentRows;
