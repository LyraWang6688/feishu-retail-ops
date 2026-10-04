// 模型配置：文字一组、图片一组，各自独立。
//
// 为什么要拆成两组，而不是一组配置管全部：
//   · 文字解析（销售录单、采购数量说明）——纯文本，可以用便宜快的模型
//   · 图片识别（采购鞋盒照片）——**必须**是支持视觉的模型
// 合在一组里的话，换文字模型会把图片识别一起换掉；而这两件事的选型理由完全不同。
//
// 两组都缺省回退到 ARK_*（火山方舟 / 豆包），所以**不配置就是现在的行为**，
// 这也让"某一家模型不稳定"可以只切一半回去，不影响另一半。
//
// 环境变量：
//   TEXT_LLM_API_KEY   / TEXT_LLM_BASE_URL   / TEXT_LLM_MODEL
//   VISION_LLM_API_KEY / VISION_LLM_BASE_URL / VISION_LLM_MODEL
// 回退：
//   ARK_API_KEY        / ARK_API_BASE_URL    / ARK_MODEL_ENDPOINT

const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

const KINDS = Object.freeze({
  text: { prefix: 'TEXT_LLM', label: '文字解析' },
  vision: { prefix: 'VISION_LLM', label: '图片识别' },
});

const firstNonEmpty = (...values) =>
  values.map((value) => String(value ?? '').trim()).find(Boolean) || '';

/**
 * 取某一组模型的配置。
 *
 * 返回 source 是为了能在日志里看出"这一组现在实际用的哪一家"，
 * 换模型出问题时不用去翻 .env。
 */
const resolveLlm = (kind, env = process.env) => {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`未知的模型分组：${kind}（只支持 text / vision）`);
  const own = (name) => env[`${spec.prefix}_${name}`];
  const apiKey = firstNonEmpty(own('API_KEY'), env.ARK_API_KEY);
  const baseURL = firstNonEmpty(own('BASE_URL'), env.ARK_API_BASE_URL, DEFAULT_ARK_BASE_URL);
  const model = firstNonEmpty(own('MODEL'), env.ARK_MODEL_ENDPOINT);
  return {
    kind,
    label: spec.label,
    apiKey,
    baseURL,
    model,
    source: firstNonEmpty(own('API_KEY')) ? spec.prefix : 'ARK',
  };
};

/** 配置不全时明确报错，不静默回退到另一组模型。 */
const assertLlmConfigured = (llm) => {
  const missing = [];
  if (!llm.apiKey) missing.push('API_KEY');
  if (!llm.model) missing.push('MODEL');
  if (missing.length) {
    const prefix = llm.kind === 'vision' ? 'VISION_LLM' : 'TEXT_LLM';
    throw new Error(
      `${llm.label}模型未配置：缺少 ${missing.map((name) => `${prefix}_${name}`).join(' / ')}。` +
      '请在 .env 里配置这一组，或回退用的 ARK_API_KEY / ARK_MODEL_ENDPOINT。',
    );
  }
  return llm;
};

module.exports = { resolveLlm, assertLlmConfigured, KINDS };
