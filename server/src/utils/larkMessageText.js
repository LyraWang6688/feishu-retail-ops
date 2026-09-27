const parseMessageContent = (content) => {
  try {
    return typeof content === 'string' ? JSON.parse(content) : content || {};
  } catch (_error) {
    return {};
  }
};

const postBody = (content) => {
  const post = content.post || content;
  if (Array.isArray(post.content)) return post;
  for (const locale of ['zh_cn', 'zh-CN', 'zh_CN', 'en_us', 'en-US']) {
    if (Array.isArray(post[locale]?.content)) return post[locale];
  }
  return Object.values(post).find((value) => Array.isArray(value?.content)) || null;
};

const postLine = (line) => {
  if (!Array.isArray(line)) return '';
  return line.filter((node) => ['text', 'a'].includes(node?.tag))
    .map((node) => String(node.text || '')).join('').trim();
};

const extractSalesMessageText = (message) => {
  const content = parseMessageContent(message?.content);
  if (message?.message_type === 'text') return String(content.text || '').trim();
  if (message?.message_type !== 'post') return '';
  const body = postBody(content);
  if (!body) return '';
  return [String(body.title || '').trim(), ...body.content.map(postLine)]
    .filter(Boolean).join('\n').trim();
};

module.exports = { extractSalesMessageText };
