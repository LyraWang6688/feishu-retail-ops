const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLlm, assertLlmConfigured } = require('../src/config/llmModels');

const DEEPSEEK = {
  TEXT_LLM_API_KEY: 'ds-key', TEXT_LLM_BASE_URL: 'https://api.deepseek.com', TEXT_LLM_MODEL: 'deepseek-chat',
  VISION_LLM_API_KEY: 'ds-key', VISION_LLM_BASE_URL: 'https://api.deepseek.com', VISION_LLM_MODEL: 'deepseek-v4-flash-vision-exp',
};

test('两组模型各自独立：文字用 TEXT_LLM_*，图片用 VISION_LLM_*', () => {
  assert.deepEqual(resolveLlm('text', DEEPSEEK), {
    kind: 'text', label: '文字解析', prefix: 'TEXT_LLM', source: 'TEXT_LLM',
    apiKey: 'ds-key', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat',
  });
  assert.equal(resolveLlm('vision', DEEPSEEK).model, 'deepseek-v4-flash-vision-exp');
  assert.equal(resolveLlm('vision', DEEPSEEK).label, '图片识别');
});

test('两组可以指向不同供应商：换一组不牵连另一组', () => {
  const env = { ...DEEPSEEK, VISION_LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/v3', VISION_LLM_MODEL: 'doubao-x' };
  assert.equal(resolveLlm('text', env).baseURL, 'https://api.deepseek.com');
  assert.equal(resolveLlm('vision', env).model, 'doubao-x');
});

test('没有跨供应商兜底：缺配置就让报错，不静默改用别家模型', () => {
  // 只配了文字那组时，图片那组必须报错，而不是悄悄去用文字那组的 key。
  assert.throws(() => assertLlmConfigured(resolveLlm('vision', {
    TEXT_LLM_API_KEY: 'ds-key', TEXT_LLM_BASE_URL: 'https://api.deepseek.com', TEXT_LLM_MODEL: 'deepseek-chat',
  })), /图片识别模型未配置：缺少 VISION_LLM_API_KEY \/ VISION_LLM_BASE_URL \/ VISION_LLM_MODEL/);
});

test('报错信息指出该补哪几个变量', () => {
  assert.throws(() => assertLlmConfigured(resolveLlm('text', { TEXT_LLM_API_KEY: 'k' })),
    /文字解析模型未配置：缺少 TEXT_LLM_BASE_URL \/ TEXT_LLM_MODEL/);
  assert.throws(() => assertLlmConfigured(resolveLlm('vision', {})),
    /缺少 VISION_LLM_API_KEY \/ VISION_LLM_BASE_URL \/ VISION_LLM_MODEL/);
});

test('BASE_URL 与 MODEL 没有默认值：不回退到任何写死的地址', () => {
  const llm = resolveLlm('text', {});
  assert.equal(llm.baseURL, '');
  assert.equal(llm.model, '');
});

test('未知分组直接报错，不猜', () => {
  assert.throws(() => resolveLlm('audio', {}), /未知的模型分组/);
});
