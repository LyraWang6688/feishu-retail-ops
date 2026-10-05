const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLlm, assertLlmConfigured, KINDS } = require('../src/config/llmModels');

const DEEPSEEK = {
  TEXT_LLM_API_KEY: 'ds-key', TEXT_LLM_BASE_URL: 'https://api.deepseek.com', TEXT_LLM_MODEL: 'deepseek-chat',
  // 视觉那一组已随拍照识别退场删除；这里仍然把它放在 env 里，用来断言**没有任何读取点**。
  VISION_LLM_API_KEY: 'ds-key', VISION_LLM_BASE_URL: 'https://api.deepseek.com', VISION_LLM_MODEL: 'deepseek-v4-flash-vision-exp',
};

// 原先这里是「两组模型各自独立 / 可以指向不同供应商 / 缺哪组就哪组报错」三条用例。
// 2026-10-05 拍照识别链路退场、VISION_LLM_* 这一组被删掉，于是：
//   · 「两组独立」不再成立（只剩一组），换成下面这条"视觉组确实没了"的回归护栏；
//   · 「跨供应商兜底」这条红线在单组下无从谈起，但"缺配置就报错、不回退默认值"
//     仍然由下面两条用例钉住（同样的红线：不静默改用别的地址/模型）。
test('文字模型用 TEXT_LLM_*', () => {
  assert.deepEqual(resolveLlm('text', DEEPSEEK), {
    kind: 'text', label: '文字解析', prefix: 'TEXT_LLM', source: 'TEXT_LLM',
    apiKey: 'ds-key', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat',
  });
});

test('图片识别那一组已退场：VISION_LLM_* 不再有任何读取点', () => {
  // 这是这次退场的回归护栏：只要有人把 vision 组加回来，这条就会红。
  assert.equal(KINDS.vision, undefined);
  assert.throws(() => resolveLlm('vision', DEEPSEEK), /未知的模型分组/);
});

test('报错信息指出该补哪几个变量', () => {
  assert.throws(() => assertLlmConfigured(resolveLlm('text', { TEXT_LLM_API_KEY: 'k' })),
    /文字解析模型未配置：缺少 TEXT_LLM_BASE_URL \/ TEXT_LLM_MODEL/);
});

test('BASE_URL 与 MODEL 没有默认值：不回退到任何写死的地址', () => {
  const llm = resolveLlm('text', {});
  assert.equal(llm.baseURL, '');
  assert.equal(llm.model, '');
});

test('未知分组直接报错，不猜', () => {
  assert.throws(() => resolveLlm('audio', {}), /未知的模型分组/);
});
