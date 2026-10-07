// ⚠️ 这个文件是【测试专用的显式开关】——本仓库唯一一处"把私聊入口打开"的地方。
//
// 背景：2026-10-07 业务负责人要求「以后私聊这条链路我们就没有了」，所以
//   **生产默认**是 `PRIVATE_CHAT_INTAKE_ENABLED=false` —— 私聊消息不建任务、不跑链路。
// 但本仓库有**一批历史用例是拿"私聊录单/私聊售后"当输入**来测下游链路的，
//   它们是很有价值的回归覆盖，不该因为"入口没了"就删掉。
// 所以：这些用例在文件顶部 require 本模块，**显式把两个开关打开**，
//   转为回归「**开关打开时行为与改动前逐字不变**」。
//   （另一半方向 —— "默认关 = 私聊不处理" —— 由**不 require 本模块**的用例钉住，
//     见 test/larkMvpService.test.js 的「私聊入口已移除」那一组。）
//
// ⚠️ 为什么**不再要求**它必须是第一个 require：
//   `config/privateChat.js` 导出的是**解析函数**（每次调用时读 env），
//   不是加载时定死的常量 —— 所以 require 顺序**不影响**结果。
//   （旧版本靠"ESM import 顺序"来保证先跑；那是隐式的，重排一次就静默失效。）
//   放在文件顶部只是**读起来清楚**：一眼能看到"这个文件是在私聊开启的档位下跑的"。
//
// ⚠️ 本仓库全部是 **CommonJS**（`server/package.json` 没有 `"type": "module"`），
//   所以这里是 `process.env` 赋值 + `module.exports`，不是 ESM。
//
// ⚠️ `node --test` **每个测试文件一个子进程** —— 这里的全局赋值不会污染别的用例文件。
const enablePrivateChatForTests = () => {
  // 入口：私聊消息照旧建任务、进 AI、走链路。
  process.env.PRIVATE_CHAT_INTAKE_ENABLED = 'true';
  // 发送：没有群上下文时仍然往私聊发（= 改动前的行为）。
  process.env.PRIVATE_CHAT_SEND_ENABLED = 'true';
};

// 被 `require` 时立刻生效：用例文件只要在顶部写一行
//   `require('./helpers/enablePrivateChatForTests');`
// 就表示"这个文件跑在私聊开启的档位下"。
enablePrivateChatForTests();

module.exports = { enablePrivateChatForTests };
