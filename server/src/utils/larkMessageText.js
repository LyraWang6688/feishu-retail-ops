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
  // 'at' 是富文本里的 @ 节点。@ 机器人时她通常还会打字，所以 @ 节点本身不取字，
  // 但必须让 `@机器人 8088黑38` 里的正文照样拼出来——不列进来也不影响正文，
  // 列进来是为了将来只 @ 不说话时（空正文）能看出"这条其实是 @ 了谁"。
  return line.filter((node) => ['text', 'a', 'at'].includes(node?.tag))
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

/**
 * 一条消息 @ 了哪些人（返回 open_id 集合）。
 *
 * 飞书事件的 `message.mentions[]` 里，机器人 @ 的形态真机验证过是
 * `{ key: '@_user_1', id: 'ou_xxx', name: '来财' }`（见 larkEvents.js 的事件日志）。
 * 这里同时兜住 `id.open_id` / `id.user_id` 两种嵌套写法：SDK 或飞书改结构时，
 * 判据不会因为拿不到 open_id 而静默失效。
 */
const mentionedOpenIds = (mentions) => {
  const ids = new Set();
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const raw = mention?.id;
    const id = typeof raw === 'string' ? raw : (raw?.open_id || raw?.user_id || '');
    if (id) ids.add(String(id));
  }
  return ids;
};

/** 这条消息有没有 @ 指定的 open_id（判「@机器人」用的唯一判据）。 */
const isMentioned = (mentions, openId) => {
  const target = String(openId || '').trim();
  if (!target) return false;
  return mentionedOpenIds(mentions).has(target);
};

/**
 * 把 @ 占位符从正文里剥掉，得到"她真正说的那句话"。
 *
 * 为什么必须剥：@ 在正文里是 `@_user_1` 这种占位符（真机验证过：
 * `{"text":"@_user_1 欢迎进群"}`），直接送进 AI 会被当成货号/乱码，
 * 拆出来的意图和数量都不可信。
 *
 * 为什么用 `mentions[].key` 而不是写死 `@_user_\d+`：
 * key 是飞书给的**唯一对应关系**（她 @ 了谁、正文里哪个串代表那次 @），
 * 写死正则在多个人 @、或飞书改命名规则时会剥错/漏剥。
 *
 * 剥完顺手规整空白：`'@_user_1 8088 黑 38'` → `'8088 黑 38'`。
 */
const stripMentionPlaceholders = (text, mentions) => {
  let value = String(text || '');
  if (!value) return '';
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const key = String(mention?.key || '').trim();
    if (!key) continue;
    value = value.split(key).join(' ');
  }
  return value.replace(/[ \t]{2,}/g, ' ').trim();
};

module.exports = { extractSalesMessageText, mentionedOpenIds, isMentioned, stripMentionPlaceholders };
