'use strict';

/** 「是否打印」轻页的**用户可见文案**（唯一真源；页面/服务里不写中文）。 */
const PRINT_PROMPT_TEXTS = Object.freeze({
  pageTitle: '是否打印',
  title: '是否打印最新库存标签？',
  hint: '默认全选，可以取消；已无库存的款会自动跳过。',
  noPrint: '不打印',
  printSelected: '打印选中',
  // 点「打印选中」成功后直接 303 回工作台；只有打印意图提交失败才用这句 toast。
  printFailedRedirect: '打印提交失败，请回工作台重新打印。',
  back: '回工作台',
  invalidTitle: '这个打印页已经用过了或过期了',
  invalidHint: '请回到工作台重新操作；已经提交的打印不受影响。',
});

module.exports = { PRINT_PROMPT_TEXTS };
