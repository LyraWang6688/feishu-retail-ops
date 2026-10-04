const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLlm, assertLlmConfigured } = require('../src/config/llmModels');

const ARK = { ARK_API_KEY: 'ark-key', ARK_API_BASE_URL: 'https://ark.example/api/v3', ARK_MODEL_ENDPOINT: 'doubao-x' };

test('两组模型各自独立：文字用 TEXT_LLM_*，图片用 VISION_LLM_*', () => {
  const env = { ...ARK,
    TEXT_LLM_API_KEY: 'ds-key', TEXT_LLM_BASE_URL: 'https://api.deepseek.com', TEXT_LLM_MODEL: 'deepseek-chat',
    VISION_LLM_API_KEY: 'ds-key', VISION_LLM_BASE_URL: 'https://api.deepseek.com', VISION_LLM_MODEL: 'deepseek-v4-flash-vision-exp' };
  assert.deepEqual(resolveLlm('text', env), {
    kind: 'text', label: '文字解析', apiKey: 'ds-key',
    baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', source: 'TEXT_LLM',
  });
  assert.equal(resolveLlm('vision', env).model, 'deepseek-v4-flash-vision-exp');
});

test('只换文字那一组时，图片那组仍走原来的模型', () => {
  const env = { ...ARK, TEXT_LLM_API_KEY: 'ds-key', TEXT_LLM_MODEL: 'deepseek-chat' };
  assert.equal(resolveLlm('text', env).source, 'TEXT_LLM');
  assert.equal(resolveLlm('text', env).baseURL, 'https://ark.example/api/v3', '没填 BASE_URL 就沿用回退值');
  assert.equal(resolveLlm('vision', env).source, 'ARK');
  assert.equal(resolveLlm('vision', env).model, 'doubao-x');
});

test('两组都不配置时全部回退 ARK_*：不配置就是现在的行为', () => {
  assert.equal(resolveLlm('text', ARK).model, 'doubao-x');
  assert.equal(resolveLlm('vision', ARK).model, 'doubao-x');
  assert.equal(resolveLlm('text', {}).baseURL, 'https://ark.cn-beijing.volces.com/api/v3');
});

test('缺配置时明确报错，并指明该配哪一组变量（不静默用另一组）', () => {
  assert.throws(() => assertLlmConfigured(resolveLlm('vision', { ...ARK, ARK_MODEL_ENDPOINT: '' })),
    /图片识别模型未配置：缺少 VISION_LLM_MODEL/);
  assert.throws(() => assertLlmConfigured(resolveLlm('text', {})),
    /文字解析模型未配置：缺少 TEXT_LLM_API_KEY \/ TEXT_LLM_MODEL/);
});

test('未知分组直接报错，不猜', () => {
  assert.throws(() => resolveLlm('audio', {}), /未知的模型分组/);
});
