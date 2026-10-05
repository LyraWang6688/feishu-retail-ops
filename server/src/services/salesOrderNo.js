const { textValue } = require('./v1BitableGateway');

// 销售单号：XSD-<东八区当天 YYYYMMDD>-<4 位序号>。
//
// 为什么这里要自己生成：这个号原来是飞书「销售主表 · 销售单号」上的**自动编号**
// （auto_number）字段，由飞书生成。产品负责人把该字段改成了文本字段（2026-10-05），
// 飞书从此不再生成任何值，而代码里也没有生成逻辑——结果就是新单的「销售单号」为空。
// 退货/换货整条设计都靠这个号找回原单，所以必须在**创建销售主表记录的那一处**自己生成。
const ORDER_NO_PREFIX = 'XSD';
const ORDER_NO_PATTERN = new RegExp(`^${ORDER_NO_PREFIX}-(\\d{8})-(\\d{4})$`);
const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
// 撞号重试上限：飞书没有事务，只能"写前写后各查一次"。几次就够，
// 再多说明不是并发抢占而是环境出了问题，继续重试只会让用户等。
const ORDER_NO_MAX_ATTEMPTS = 5;

// 日期必须按东八区算。跨 0 点时 UTC 还停在前一天（比如上海 2026-10-06 00:30 = UTC 2026-10-05 16:30），
// 用 UTC 算出来的日期段会把凌晨录入的单记到"昨天"的号段里，和第二天的号撞上。
const shanghaiDateStamp = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
};

/**
 * 纯函数：由「当天已有单号」+「当前时间」算出下一个销售单号。
 *
 * 为什么每天重置还不会撞号：完整单号里带着日期段，
 * `XSD-20261006-0001` 与 `XSD-20261005-0001` 是两个不同的号；每天重置的计数器
 * 只需要在**它自己那一天之内**唯一，跨天的唯一性由日期段负责。所以
 * 「今天第 1 单 = 0001、明天第 1 单也是 0001」不是冲突，而是格式本身要表达的信息。
 *
 * 为什么旧全局号不参与计算：改字段类型之前，序号是一个**全局递增**计数器
 * （`XSD-20261004-0168` → `XSD-20261005-0169`），历史 85 条记录里带着 0168/0169… 这种号。
 * 如果把它们也算进来，今天的第一个号会从 0173 开始，「每天重置」直接失效。
 * 更要命的是这些旧号会把 max 长期顶在几百，序号永远回不到"当天第几单"。
 * 所以只认「日期段 == 今天」的号；历史号原样保留，一个字不动。
 *
 * 为什么取「最大值 + 1」而不是「当天记录数 + 1」：当天已有 0001、0003（中间缺号）时，
 * 记录数 + 1 会算出 0003 —— 把空缺补上，等于把一个**可能已经发出过的号**再发一次。
 * 取最大值 + 1 = 0004，单调向前，不会产生歧义。
 *
 * @returns {{ orderNo: string, sequence: number, dateStamp: string, todayCount: number }}
 */
const nextSalesOrderNo = ({ existingNos = [], now = new Date() } = {}) => {
  const dateStamp = shanghaiDateStamp(now);
  let maxSequence = 0;
  let todayCount = 0;
  for (const raw of existingNos) {
    const matched = ORDER_NO_PATTERN.exec(textValue(raw).trim());
    if (!matched || matched[1] !== dateStamp) continue;
    todayCount += 1;
    maxSequence = Math.max(maxSequence, Number(matched[2]));
  }
  const sequence = maxSequence + 1;
  return {
    orderNo: `${ORDER_NO_PREFIX}-${dateStamp}-${String(sequence).padStart(4, '0')}`,
    sequence,
    dateStamp,
    todayCount,
  };
};

const countOrderNo = (existingNos, target) =>
  existingNos.reduce((total, raw) => total + (textValue(raw).trim() === target ? 1 : 0), 0);

/**
 * 防撞分配：飞书 Base 既没有事务也没有唯一约束。所以「读一次 → 算一个号 → 写下去」
 * 中间存在窗口，别人可能刚好把同一个号占走（两个门店同时录单就会）。
 *
 * 唯一能真正发现撞号的便宜办法，是**写完之后再读一次**：这个号在当天出现了两次，
 * 就说明它被别人抢了。此时按刚读回来的真实数据重算（必然 +1），改回**自己那条记录**
 * （而不是再建一条，避免留下垃圾记录），最多重试 maxAttempts 次；
 * 仍然撞就明确报错，宁可不写，也不留下两个同号的销售主表记录。
 *
 * 读与写都由调用方注入：这样"撞号"可以在单测里被精确模拟，不必真的并发。
 */
const allocateSalesOrderNo = async ({
  readExistingNos,
  writeOrderNo,
  now = new Date(),
  maxAttempts = ORDER_NO_MAX_ATTEMPTS,
  onCollision,
} = {}) => {
  if (typeof readExistingNos !== 'function' || typeof writeOrderNo !== 'function') {
    throw new Error('allocateSalesOrderNo 需要 readExistingNos 与 writeOrderNo');
  }
  let candidate = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    candidate = nextSalesOrderNo({ existingNos: await readExistingNos(), now });
    await writeOrderNo(candidate.orderNo, { attempt });
    const afterWrite = await readExistingNos();
    if (countOrderNo(afterWrite, candidate.orderNo) <= 1) {
      return { ...candidate, attempts: attempt };
    }
    onCollision?.({ attempt, order_no: candidate.orderNo });
  }
  throw new Error(`销售单号 ${candidate?.orderNo} 连续 ${maxAttempts} 次被并发写入占用，请稍后重试`);
};

module.exports = {
  nextSalesOrderNo,
  allocateSalesOrderNo,
  shanghaiDateStamp,
  ORDER_NO_MAX_ATTEMPTS,
  ORDER_NO_PATTERN,
};
