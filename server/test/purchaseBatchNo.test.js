const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBatchNos, BATCH_NO_PATTERN } = require('../src/services/purchaseBatchNo');
const { isMentioned, mentionedOpenIds, stripMentionPlaceholders } = require('../src/utils/larkMessageText');

// 判据统一放在这里，是因为「群里算不算 @ 了机器人」只有一处实现；
// 真机验证过的事件形态是 `{ key: '@_user_1', id: 'ou_xxx', name: '来财' }`。

test('批次号从自然语言里抽取：识别 BH-日期-序号，抽出全部命中', () => {
  assert.deepEqual(extractBatchNos('BH-20261005-0001 这批到了'), ['BH-20261005-0001']);
  assert.deepEqual(extractBatchNos('这批到了'), []);
  // 一句话里说了两个号：**都要抽出来**（由定位函数判"说不清"，不在这里挑一个）。
  assert.deepEqual(
    extractBatchNos('BH-20261005-0001 和 BH-20261005-0002'),
    ['BH-20261005-0001', 'BH-20261005-0002'],
  );
  // 同一个号说两遍：去重，仍然是"一个号"。
  assert.deepEqual(extractBatchNos('BH-20261005-0001 BH-20261005-0001'), ['BH-20261005-0001']);
  // 形态不对的不认（不猜）：位数不对、分隔符不对、没有前缀。
  assert.deepEqual(extractBatchNos('BH-2026-1'), []);
  assert.deepEqual(extractBatchNos('bh-20261005-0001'), [], '大小写不同不当成同一个号');
  assert.deepEqual(extractBatchNos(''), []);
});

test('批次号正则带 g 且可重复调用：不会因为 lastIndex 状态漏掉第二次匹配', () => {
  // 这是"配置里的正则被复用"时最容易踩的坑：带 g 的正则有状态。
  const first = extractBatchNos('BH-20261005-0001');
  const second = extractBatchNos('BH-20261005-0001');
  assert.deepEqual(first, ['BH-20261005-0001']);
  assert.deepEqual(second, ['BH-20261005-0001']);
  assert.ok(BATCH_NO_PATTERN instanceof RegExp);
});

test('@ 判据：只看 mentions 里的 open_id，认得出嵌套与平铺两种 id 形态', () => {
  const bot = 'ou_bot';
  // 真机形态：id 是字符串
  assert.equal(isMentioned([{ key: '@_user_1', id: bot, name: '来财' }], bot), true);
  // SDK 可能给成对象：都要认
  assert.equal(isMentioned([{ key: '@_user_1', id: { open_id: bot } }], bot), true);
  assert.equal(isMentioned([{ key: '@_user_1', id: { user_id: bot } }], bot), true);
  // @ 了别人 ≠ @ 了机器人
  assert.equal(isMentioned([{ key: '@_user_1', id: 'ou_someone' }], bot), false);
  assert.equal(isMentioned([], bot), false);
  assert.equal(isMentioned(undefined, bot), false);
  // 没配 open_id（空串）时一律 false：绝不"可能是我"。
  assert.equal(isMentioned([{ key: '@_user_1', id: bot }], ''), false);
  assert.deepEqual([...mentionedOpenIds([{ id: bot }, { id: 'ou_x' }, { id: null }])], [bot, 'ou_x']);
});

test('剥 @ 占位符：按 mentions[].key 剥，剥完规整空白，不吞正文', () => {
  const mentions = [
    { key: '@_user_1', id: 'ou_bot' },
    { key: '@_user_2', id: 'ou_other' },
  ];
  assert.equal(stripMentionPlaceholders('@_user_1 8088 黑 38', mentions), '8088 黑 38');
  assert.equal(stripMentionPlaceholders('@_user_1 @_user_2 8088 黑 38', mentions), '8088 黑 38');
  assert.equal(stripMentionPlaceholders('@_user_1', mentions), '');
  // mentions 里没有的占位符不剥（不猜），正文原样。
  assert.equal(stripMentionPlaceholders('@_user_9 你好', mentions), '@_user_9 你好');
  assert.equal(stripMentionPlaceholders('', mentions), '');
});

test('富文本 post：@ 节点不吞正文，正文照常拼出来', () => {
  const { extractSalesMessageText } = require('../src/utils/larkMessageText');
  const message = {
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: '',
        content: [[
          { tag: 'at', user_id: 'ou_bot', text: '@机器人' },
          { tag: 'text', text: ' 8088 黑 38 两双' },
        ]],
      },
    }),
  };
  // ⚠️ 富文本与纯文本的 @ 形态**不一样**：纯文本是 `@_user_1` 占位符（按 mentions[].key 剥），
  // 富文本的 at 节点自带显示文本（"@机器人"），普通文字里出现一个 @ 称呼不影响解析。
  // 这条用例只钉住一件事：**不能把后面的正文吞掉**。
  assert.equal(extractSalesMessageText(message), '@机器人 8088 黑 38 两双');

  // at 节点没有 text 时（只带 user_id），也不能因为它是空节点就把整行丢掉。
  const noTextMessage = {
    message_type: 'post',
    content: JSON.stringify({ zh_cn: { content: [[{ tag: 'at', user_id: 'ou_bot' }, { tag: 'text', text: '8088 黑 38' }]] } }),
  };
  assert.equal(extractSalesMessageText(noTextMessage), '8088 黑 38');
});
