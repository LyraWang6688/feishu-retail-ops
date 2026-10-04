// 模型配置：文字一组、图片一组，各自独立。
//
// 为什么要拆成两组，而不是一组配置管全部：
//   · 文字解析（销售录单、采购数量说明）——纯文本
//   · 图片识别（采购鞋盒照片）——**必须**是支持视觉的模型
// 两者的选型理由不同，换一组不该牵连另一组。比如视觉模型不稳定时，
// 只把 VISION_LLM_* 换掉即可，文字那边一点不动。
//
// **刻意不做跨供应商兜底**：哪一组缺配置就让调用直接报错，不静默改用另一家的模型。
// 静默兜底会造成"以为在用 A、实际在用 B"，这种问题只能在事后翻日志才发现——
// 跟"目标 Base 不再硬编码兜底"是同一条理由。
//
// 环境变量（两组都必须配齐，没有默认值）：
//   TEXT_LLM_API_KEY   / TEXT_LLM_BASE_URL   / TEXT_LLM_MODEL
//   VISION_LLM_API_KEY / VISION_LLM_BASE_URL / VISION_LLM_MODEL
//
// 例：两组都走 DeepSeek
//   TEXT_LLM_BASE_URL=https://api.deepseek.com
//   TEXT_LLM_MODEL=deepseek-chat
//   VISION_LLM_BASE_URL=https://api.deepseek.com
//   VISION_LLM_MODEL=deepseek-v4-flash-vision-exp

const KINDS = Object.freeze({
  text: { prefix: 'TEXT_LLM', label: '文字解析' },
  vision: { prefix: 'VISION_LLM', label: '图片识别' },
});

const FIELD_NAMES = Object.freeze({
  apiKey: 'API_KEY',
  baseURL: 'BASE_URL',
  model: 'MODEL',
});

const clean = (value) => String(value ?? '').trim();

/** 取某一组模型的配置。返回 prefix 便于报错时指明该配哪一组。 */
const resolveLlm = (kind, env = process.env) => {
  const spec = KINDS[kind];
  if (!spec) throw new Error(`未知的模型分组：${kind}（只支持 text / vision）`);
  return {
    kind,
    label: spec.label,
    prefix: spec.prefix,
    source: spec.prefix,
    apiKey: clean(env[`${spec.prefix}_API_KEY`]),
    baseURL: clean(env[`${spec.prefix}_BASE_URL`]),
    model: clean(env[`${spec.prefix}_MODEL`]),
  };
};

/** 配置不全时明确报错，并指出该补哪几个变量；不回退到别的模型。 */
const assertLlmConfigured = (llm) => {
  const missing = Object.keys(FIELD_NAMES).filter((key) => !llm[key]);
  if (missing.length) {
    const names = missing.map((key) => `${llm.prefix}_${FIELD_NAMES[key]}`);
    throw new Error(`${llm.label}模型未配置：缺少 ${names.join(' / ')}`);
  }
  return llm;
};

module.exports = { resolveLlm, assertLlmConfigured, KINDS };
