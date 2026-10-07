/**
 * 「常用功能」首页的入口清单 —— **配置先行：加 / 减 / 改入口只改这一个文件**。
 *
 * 业务负责人 2026-10-07 的要求（逐字）：
 *   「另外**常用功能首页就单独出来采购和退货**吧，这样**不需要多点一次**～」
 * ⇒ 原先是【一个】「采购和退货」入口 → 进 `purchase-return.html` 再点一次卡片；
 *    现在是首页【采购】【退货】两张独立卡，**各点一次直接落在对应的飞书表单上**。
 *
 * ⚠️ 表单链接的**唯一来源仍然是 `config/links.js`**（口径留档见
 *    `docs/workbench-requirements-2026-10-06.md` 一①）—— 这里只**引用**，不复制 URL。
 * ⚠️ `href` 是**同窗口跳转**（不加 `target="_blank"`，见 `features/common/index.js` 的说明）：
 *    她把工作台开在手机 / 飞书内置浏览器里，新窗口体验差、还可能被拦。
 *    要让某个入口"先回工作台内页"只改这里的 href，`features/common/index.js` 不用动。
 */

import { PURCHASE_FORMS } from './links.js';

/** 按 id 取飞书表单；配置写错时**当场报错**，不要静默少一个入口。 */
function form(id) {
  const found = PURCHASE_FORMS.find((item) => item.id === id);
  if (!found) throw new Error(`config/home.js：links.js 里找不到 id 为「${id}」的飞书表单`);
  return found;
}

/**
 * 首页卡片，**按这个顺序渲染**（她 2026-10-06：「采购放在库存上面」）。
 *
 * 字段：
 *   `id`    稳定标识（测试 / 排重用，不渲染）
 *   `icon`  卡片图标
 *   `title` 卡片标题（逐字）
 *   `desc`  一句话说明
 *   `href`  目标（外链飞书表单，或工作台内页）
 *   `arrow` 右下角动作文案（可选，缺省「进入 →」）
 *   `wide`  手机上是否**整行**（默认两张并排；「库存手工调整」文字长，整行）
 */
export const COMMON_ENTRIES = [
  {
    id: 'purchase',
    icon: '🛒',
    title: '采购',
    desc: '供应商报货——点一下直接打开飞书表单',
    href: form('purchase-request').url,
    arrow: '去填写 →',
  },
  {
    id: 'purchase-return',
    icon: '↩️',
    title: '退货',
    desc: '把货退给供应商——点一下直接打开飞书表单',
    href: form('purchase-return').url,
    arrow: '去填写 →',
  },
  {
    id: 'inventory-adjustment',
    icon: '🧮',
    title: '库存手工调整',
    desc: '盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）',
    href: '/workbench/inventory-adjustment.html',
    arrow: '进入 →',
    wide: true,
  },
];
