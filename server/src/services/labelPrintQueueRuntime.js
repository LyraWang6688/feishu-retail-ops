/**
 * 打印队列的**运行期单例** —— 手机侧路由与电脑侧路由**必须共用同一个实例**。
 *
 * 为什么必须是同一个实例：
 *   · `subscribe`（SSE 的订阅者集合）与 `devices`（心跳）都是**进程内状态**；
 *     两个路由各建一个实例 ⇒ 手机入队的任务**推不到**正开着长连接的小助手（会变成"排队但不触发"），
 *     在线状态也会永远显示"未连接"。这正是这条链路的命门，所以共享这件事单独一个文件写明。
 *
 * ⚠️ **懒创建**：`get()` 在**第一次真的被用到**时才建目录、建 service。
 *    这样"只是 require app.js"的用例（例如 `appDotenvLoadOrder.test.js`）**不会**在磁盘上创建跑数据目录。
 *
 * ⚠️ 环境变量在**第一次 get() 时**读一次（之后固定）。改 `.env` 要重启服务才生效 —— 与仓库其它模块一致。
 */
const { logError, logInfo } = require('../utils/logger');
const { resolveLabelPrintQueueConfig, artifactsDirOf } = require('../config/labelPrintQueue');
const { LabelPrintJobStore } = require('../infrastructure/labelPrintJobStore');
const { createLabelPrintService } = require('./labelPrintService');
const { createLabelPrintQueueService } = require('./labelPrintQueueService');
const { V1BitableGateway } = require('./v1BitableGateway');

let shared = null;

/**
 * 取（必要时创建）共享的打印队列 service。
 * @param {object} [options] `{ service }` 直接给一个（用例注入）；`{ config, gateway, labelPrint }` 覆盖默认构造。
 */
const getLabelPrintQueue = (options = {}) => {
  if (options.service) return options.service;
  if (shared) return shared;
  const config = options.config || resolveLabelPrintQueueConfig();
  const gateway = options.gateway || new V1BitableGateway();
  const store = new LabelPrintJobStore({
    dir: config.storeDir,
    artifactsDir: artifactsDirOf(config),
  });
  shared = createLabelPrintQueueService({
    store,
    labelPrint: options.labelPrint || createLabelPrintService(gateway),
    config,
  });
  if (!config.device.token) {
    // ⚠️ **大声报错**（不是静默）：没配令牌 ⇒ 店里那台电脑**永远连不上**，而现象只是"点了没反应"。
    logError('label_print.device.token_missing', {
      env: config.device.tokenEnv,
      hint: '没配设备令牌 ⇒ 电脑侧（/api/label-print/*）会全部回 503；请在服务器 .env 里配 LABEL_PRINT_DEVICE_TOKEN',
    });
  } else {
    logInfo('label_print.queue.ready', {
      store_dir: config.storeDir,
      transport: config.transport,
      online_timeout_ms: config.onlineTimeoutMs,
      claim_timeout_ms: config.claimTimeoutMs,
      max_labels_per_job: config.maxLabelsPerJob,
    });
  }
  return shared;
};

/** 用例用：把单例清掉（每个用例自己注入 service 时不必调它）。 */
const resetLabelPrintQueue = () => {
  shared = null;
};

module.exports = { getLabelPrintQueue, resetLabelPrintQueue };
