// 「群话题深链」的**真实格式**（业务负责人 2026-10-06 给的真实样例，记在
// docs/module-split-and-main-flow-2026-10-06.md 第八节 —— 那份是权威，本文件只是它的代码化）。
//
//   https://applink.feishu.cn/client/thread/open
//     ?open_chat_id=<群 chat_id>
//     &open_thread_id=<话题 thread_id>
//     &openchatid=<群 chat_id>
//     &openthreadid=<话题 thread_id>
//     &thread_position=-1
//
// 她的话：「**点开之后就直接可以看到那条消息的所有沟通内容**」。
// ⭐ 关键：`chat_id` 与 `thread_id` **我们手上都有**（群消息事件里有 chat_id；
//    `im.message.reply` 带 `reply_in_thread:true` 的响应里有 thread_id、事件里也有）
//    ⇒ **不用等发送响应的 `message_app_link`**（实测四：这个应用当前根本不回带它）。
//
// ⚠️ 与已删掉的 `PENDING_DEAL_PUSH_LINK_TEMPLATE` 的区别（别把两件事混起来）：
//   · 那个是"**运营自己编一条 URL** 当兜底" —— 拼出来的链接能不能用没人保证，**已删**；
//   · 这个是**她给的、真实可用的**话题深链格式，参数是**我们自己发消息时拿到的两个 id**，
//     拼出来的就是那条话题本身。所以这里是**唯一的拼链接处**，而且**缺 id 就返回空**。
//
// 配置先行：格式哪天变了（飞书改协议 / 她给新样例）→ **只改这一段模板**，逻辑不动。
// 模板可用占位符：`{chat_id}` / `{thread_id}` / `{thread_position}`。

const SALES_THREAD_LINK_TEMPLATE_ENV_KEY = 'SALES_THREAD_LINK_TEMPLATE';

// 她给的那一条（含两套参数名：下划线版与无下划线版，飞书两种都认；thread_position=-1 表示首条）。
const DEFAULT_SALES_THREAD_LINK_TEMPLATE =
  'https://applink.feishu.cn/client/thread/open'
  + '?open_chat_id={chat_id}&open_thread_id={thread_id}'
  + '&openchatid={chat_id}&openthreadid={thread_id}'
  + '&thread_position={thread_position}';

const DEFAULT_THREAD_POSITION = '-1';

/**
 * 拼一条群话题深链。
 *
 * 🔴 **两个 id 缺一个就返回空串** —— 不猜、不用空值拼一条点开是别的会话的链接
 *   （这正是她明确不要的"假链接"）。调用方拿到空就**留空**。
 */
const buildSalesThreadLink = ({ chatId = '', threadId = '', template, threadPosition = DEFAULT_THREAD_POSITION } = {}) => {
  const chat = String(chatId || '').trim();
  const thread = String(threadId || '').trim();
  if (!chat || !thread) return '';
  // ⚠️ `template` 不传（undefined）= 用她给的那条默认格式；**显式传空串 = 不要拼链接**（返回空）。
  const pattern = template === undefined || template === null
    ? DEFAULT_SALES_THREAD_LINK_TEMPLATE
    : String(template).trim();
  if (!pattern) return '';
  return pattern
    .replace(/\{chat_id\}/g, chat)
    .replace(/\{thread_id\}/g, thread)
    .replace(/\{thread_position\}/g, String(threadPosition));
};

/** 模板从环境变量读（没配就用她给的那条）；空串 = 显式不要拼链接。 */
const resolveSalesThreadLinkTemplate = (env = process.env) => {
  const raw = env ? env[SALES_THREAD_LINK_TEMPLATE_ENV_KEY] : undefined;
  if (raw === undefined || raw === null) return DEFAULT_SALES_THREAD_LINK_TEMPLATE;
  return String(raw).trim();
};

module.exports = {
  SALES_THREAD_LINK_TEMPLATE_ENV_KEY,
  DEFAULT_SALES_THREAD_LINK_TEMPLATE,
  DEFAULT_THREAD_POSITION,
  buildSalesThreadLink,
  resolveSalesThreadLinkTemplate,
};
