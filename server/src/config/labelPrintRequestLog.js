/**
 * 「打印请求 → 飞书『标签打印』表」的配置（唯一真源）。
 *
 * 业务负责人 2026-11-17 的口径：
 *   「扫码打印、库存调整打印的打印请求，也写进这张『标签打印』数据表；**只是记录请求**」。
 *   ⇒ **一个新建打印任务 = 一行**，只写「打印货号 + 来源」；
 *     不查历史、不合并、不累加次数；队列复用（防连点）不重复写。
 *
 * ⚠️ **为什么必须加「来源」字段**：
 *   这张表同时是「批量打印」表单的**输入表** —— 后端监听该表的 `record_added`，
 *   任何新记录都会被 `labelPrintFormIntakeService` 当成一次批量打印请求。
 *   若把扫码/库存的请求记录也写进去，**不加以区分就会再打一遍**（死循环）。
 *   ⇒ 服务端写的记录一律带「来源」；监听端只处理「来源为空 / 批量打印」的记录。
 *
 * ⚠️ 字段真源仍在 `config/v1BitableSchema.js`：本文件只放**语义键**与**来源文案**，
 *    不重复写物理列名。
 */
const { readFlag } = require('./envValue');
const { SOURCES } = require('./labelPrintQueue');

const LABEL_PRINT_REQUEST_LOG = Object.freeze({
  // 显式布尔开关（需要时可由环境变量关掉；关掉后队列照常打印，只是不写飞书）。
  enabled: readFlag(process.env, 'LABEL_PRINT_REQUEST_LOG_ENABLED', true),
  // 目标表：与批量打印表单同一张「标签打印」表（语义键，见 v1BitableSchema）。
  tableKey: 'labelPrintRequest',
  // 语义字段键（不是物理列名）；物理列名只在 v1BitableSchema 里。
  fields: Object.freeze({
    product: 'product',
    source: 'source',
  }),
  // 队列来源 → 「来源」单选值。表单来源不写第二行（表单记录本身就是请求）。
  // ⚠️ 来源值必须与业务负责人表里的「来源」选项逐字一致。
  //   当前选项：表单打印 / 扫码打印 / 库存调整打印 / 销售录单打印 / 验收录单打印。
  //   旧「按编号打印」接口没有页面入口，表里也没有这个选项 ⇒ 不写（没有 recordId 时本来就跳过）。
  sourceLabels: Object.freeze({
    [SOURCES.scan]: '扫码打印',
    [SOURCES.inventory]: '库存调整打印',
    [SOURCES.sale]: '销售录单打印',
    [SOURCES.acceptance]: '验收录单打印',
    [SOURCES.form]: '表单打印',
  }),

  // 表单来源：跳过写记录（已有表单那一行）。
  formSource: SOURCES.form,
  // 表单监听端认的「批量打印」值（与上面的 sourceLabels[form] 同一份文案）。
  formSourceLabel: '表单打印',
  // 日志里给排查用的人话（service 层不写中文）。
  texts: Object.freeze({}),
});

module.exports = { LABEL_PRINT_REQUEST_LOG };
