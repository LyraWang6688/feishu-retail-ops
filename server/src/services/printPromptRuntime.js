'use strict';

/** 「是否打印」一次性令牌的服务端单例（销售/验收/打印页必须共用一个实例）。 */
const { createPrintPromptService } = require('./printPromptService');

let shared = null;

const getPrintPromptService = () => {
  if (!shared) shared = createPrintPromptService();
  return shared;
};

/** 用例用：清掉单例。 */
const resetPrintPromptServiceForTests = () => { shared = null; };

module.exports = { getPrintPromptService, resetPrintPromptServiceForTests };
