// 「未知 / 已退场卡片动作」的兜底人话（业务负责人 2026-10-12 明确要的）。
//
// 背景：群聊入口退场之后，**线上还躺着老卡片** —— 群话题里的销售确认卡、到货核对卡
// （含刚被删掉的「否」）、采购确认卡、报表卡……它们身上的按钮指向的动作名，
// 有的**整条链路已经删除**、有的**从来就不属于本服务**。
//
// 她点下去的正确表现（三条缺一不可）：
//   ① **回一句人话** —— 告诉她这张卡已经用不了了；
//   ② **不报错** —— 不许把"不认识这个动作"变成异常 / 5xx；
//   ③ **不静默** —— 点了什么都不发生，她会以为"卡住了"（真机 2026-10-07 投诉过两次）。
//
// ⚠️ 取值规则与项目其它开关一致（`config/envValue`）：**显式布尔**，
//    空串 = 没配 = 用默认；认不出的值**当场抛错**，不静默取默认。
// ⚠️ 文案可配（`UNKNOWN_CARD_ACTION_TOAST`）：改一句话不用改代码。
const { readString } = require('./envValue');

const TOAST_ENV_KEY = 'UNKNOWN_CARD_ACTION_TOAST';
const DEFAULT_TOAST = '这张卡片已经不适用了哦～现在录入请用扫码页，查询和售后请到工作台～';

const UNKNOWN_CARD_ACTION_TOAST = readString(process.env, TOAST_ENV_KEY, DEFAULT_TOAST);

module.exports = {
  TOAST_ENV_KEY,
  DEFAULT_TOAST,
  UNKNOWN_CARD_ACTION_TOAST,
};
