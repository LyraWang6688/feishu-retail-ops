// 模型配置：当前**只剩文字一组**。
//
// 历史与为什么现在是这样：原先拆成两组——文字解析（销售录单、采购数量说明）与
// 图片识别（采购鞋盒照片 / 供应商到货单照片）。两者的选型理由确实不同，
// 所以当时分开配置、互不牵连（谁缺配置就谁报错，**不做跨供应商兜底**）。
//
// 2026-10-05 业务负责人把「采购到货」表的识别字段（类型/识别状态/识别失败原因）删掉，
// 并决定「拍照 → 识别 → 入库」这条链路整体退场（改成纯对话驱动），
// 于是 VISION_LLM_* 这一组**没有任何读取点**了：鞋盒识别与到货单识别的两个方法、
// 它们的提示词、以及视觉客户端的硬超时都一并删除。这一组配置随之删掉，
// 而不是留着一组"配了也没人用"的变量——那会让人以为系统还在读图片。
//
// ⚠️ 跨供应商兜底这条红线依然有效：缺 TEXT_LLM_* 就直接报错，不静默改用别家模型
// （跟"目标 Base 不硬编码兜底"是同一条理由）。
//
// 环境变量（必须配齐，没有默认值）：
//   TEXT_LLM_API_KEY / TEXT_LLM_BASE_URL / TEXT_LLM_MODEL
//
// 例：
//   TEXT_LLM_BASE_URL=https://api.deepseek.com
//   TEXT_LLM_MODEL=deepseek-chat

const KINDS = Object.freeze({
  text: { prefix: 'TEXT_LLM', label: '文字解析' },
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
  if (!spec) throw new Error(`未知的模型分组：${kind}（只支持 text）`);
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
