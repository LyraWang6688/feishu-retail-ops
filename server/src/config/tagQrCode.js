/**
 * 「货品信息.标签二维码」的可配参数 —— **配置先行**：二维码里的 URL（域名 / 路径 / 参数名）、
 * 出图尺寸 / 容错级别 / 颜色、上传点的 `parent_type`、附件**文件名模板**、
 * 事件触发动作、批量脚本的并发与间隔、以及整条链路的**开关**，
 * 全部在这一个文件里；逻辑里一个字符串一个数字都不写死。
 *
 * 业务负责人 2026-10-08 定的能力（逐字口径）：
 *   · 「货品信息」表上新建了一列 **`标签二维码`（字段类型 = 附件）**；
 *   · 二维码内容规范：`https://hm.bamamei.online/s/{编号}`，
 *     其中 `编号` = 该记录「编号」字段的值（形如 `YD6693-2|黑色|A`），**做 URL 编码**；
 *   · **存量 561 条**要批量补这一列（脚本 `scripts/backfill-product-tag-qr.js`）；
 *   · 以后**货品上新**（表单提交 → 表记录变更事件）后**自动**生成并写回。
 *
 * ⚠️ 域名是 **`hm.bamamei.online`**（2026-10-08 已从 workbench 切到 hm；证书已配、可用）。
 *    换域名 = 只改下面 `SCAN_URL.urlTemplate` 这一行。
 *
 * ⚠️ 与 `config/labelPrint.js` 的 `QR` **不是同一件事**，刻意不合并：
 *    · 那一处是**鞋盒标签打印页**的二维码（指向工作台将来 `/scan` 选鞋的页面，
 *      参数是货号/尺码/颜色三段 query）；
 *    · 这里那一处是**写进「货品信息」附件列**的二维码（指向 `hm` 的 `/s/{编号}`，
 *      整条「编号」当路径一段）。
 *    两条链路的消费者不同 ⇒ 各留各的模板；要一起改的时候**两处都要改**。
 */

const os = require('node:os');

/**
 * 二维码内容 = **一个能扫的 URL**。**唯一真源**：域名 / 路径 / 参数名都在这一行里。
 *
 * 可用占位符：`{number}` = 该记录「编号」字段的值（形如 `YD6693-2|黑色|A`）。
 * ⚠️ **只编码替换进去的值，不编码模板**（否则 `/` 会被编成 `%2F`，扫出来不是同一个地址）。
 * 实现见 `services/tagQrCodeService.js` 的 `buildScanUrl`。
 *
 * 例：编号 `YD6693-2|黑色|A` ⇒
 *     `https://hm.bamamei.online/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA`
 */
const SCAN_URL = Object.freeze({
  urlTemplate: 'https://hm.bamamei.online/s/{number}',
});

/**
 * 出图参数（用仓库里**已有**的 `qrcode@1.5.4`，不引新依赖）。
 *
 * `errorCorrectionLevel`：二维码被磨/被挡时的容错能力。写进附件的这张码是**给人扫的**
 *   （列表里点开看、或将来贴出来），M（15%）是常规选择；贴纸场景可调到 Q/H。
 * `widthPx`：出图边长（像素）。`qrcode` 的 `width` 选项 = 最终图片边长，够清晰又不会太大。
 * `marginModules`：四周留几个模块的白边（0 = 不留）。**建议 ≥1** ——
 *   完全不留白边的二维码在部分扫码器上识别率会掉。
 * 颜色：深色画点、浅色作底（对调 = 反色码，多数扫码器认不出来，别乱改）。
 */
const QR = Object.freeze({
  errorCorrectionLevel: 'M',
  widthPx: 512,
  marginModules: 1,
  darkColor: '#000000',
  lightColor: '#ffffff',
});

/**
 * 附件（`标签二维码` 是**附件字段**）的写回参数。
 *
 * ⚠️ `parentType` 是**查证过的**（官方文档，见 `docs` 里本轮报告引用的原文片段）：
 *   · 上传素材接口 `POST /open-apis/drive/v1/medias/upload_all` 的 `parent_type` 可选值里，
 *     多维表格图片 = **`bitable_image`**、多维表格文件 = `bitable_file`；
 *   · 两者 `parent_node` 都传**多维表格的唯一标识 `app_token`**（= 我们 schema 的 appToken，
 *     由网关自己带上，这里不用配）；
 *   · 这里出的是 **PNG 图片**，且本仓**已在生产验证**过同一条路
 *     （`V1BitableGateway.uploadAttachment` 的默认值就是它，采购单据图写回「报货批次.单据」
 *     走的就是这一个）。
 *   ⚠️ 写回附件字段的形状（官方 FAQ「如何在多维表格中上传附件」）：
 *     `{ 附件列: [{ file_token }] }` —— **只传 file_token 就够**。
 *   ⚠️ 官方「素材概述」里还有一句：多维表格上传场景可以带 `extra` =
 *     `{"drive_route_token":"<app_token>"}`。本仓**已在生产跑通的那条路没有带它**
 *     （`V1BitableGateway.uploadAttachment`，写「报货批次.单据」），
 *     所以这里**照它来**（少一个没验证过的请求字段）。哪天上传报
 *     `403 / 1061004 forbidden` 或 `400 / 1061044 parent node not exist`，
 *     这一个就是首先要试的旋钮（把它加进 `uploadAttachment` 的 data 里）。
 * `operation` 只用于报错文案（"上传标签二维码失败: …"）。
 */
const UPLOAD = Object.freeze({
  parentType: 'bitable_image',
  operation: '上传标签二维码',
});

/**
 * 附件文件名模板 —— 与二维码内容**同源**（都用 `{number}`）。
 *
 * ⚠️ 文件名**不是**幂等判据（幂等以"这一列有没有值"为准，见 service）；
 *    但它必须**由编号决定**、同一条记录每次生成都一样，这样她在表里一眼能看出
 *    这张码是哪条编号的，也不会因为重跑而堆出名字不同的重复附件。
 * ⚠️ 文件名要能落到本地临时文件上（服务端是"先写临时文件再上传"）⇒
 *    `/` `\` 这类路径字符、以及冒号/星号这类在别的系统上非法的字符，统一替换掉。
 */
const FILE_NAME = Object.freeze({
  template: 'tag-qr-{number}.png',
  // 会被替换成 `replacement` 的字符集（路径分隔符 + Windows 非法字符 + 空白）。
  invalidChars: /[\\/:*?"<>|\s]+/g,
  replacement: '_',
  // 官方限制：`file_name` 最大 250 字符。宁可截断，也不要整条上传失败。
  maxLength: 250,
});

/**
 * 临时文件目录（生成 PNG 后要先落盘，因为网关的上传接口吃文件路径）。
 * 每次调用都会 `mkdtemp` 一个**独占**子目录，跑完 `rm -rf` —— 不会串到别的记录。
 */
const TEMP = Object.freeze({
  dir: os.tmpdir(),
  prefix: 'tag-qr-code-',
});

/**
 * 事件触发口径 —— `routes/larkEvents.js` 把这个表上的 `action_list` 原样交给本 service，
 * 由这里决定"哪条动作要出码"。
 *
 * ⚠️ 飞书生产日志里「修改」的取值是 **`record_edited`**（见
 *    `docs/purchase-intake-batch-spec.md` 第 3.1 节的真实日志样例）；
 *    `record_updated` 是另一种可能的写法，一并认下来，避免"改个名就不触发"这种静默失效。
 * ⚠️ **删除**（`record_deleted`）不在表里：记录都没了，没有落点。
 */
const EVENTS = Object.freeze({
  created: Object.freeze(['record_added']),
  updated: Object.freeze(['record_edited', 'record_updated']),
});

/**
 * 整条链路的开关（显式布尔，**不用 `||` 兜底** —— 清空变量不等于关闭）。
 * 关掉 = 事件到达时只记一条 `product.tag_qr.disabled`，一个字都不写。
 * ⚠️ 批量补脚本**不看这个开关**：它是人手动跑的、走的是自己的闸门（见脚本文件头）。
 */
const ENABLED = true;

/**
 * 批量补脚本的默认节奏（`scripts/backfill-product-tag-qr.js` 的命令行参数覆盖这里）。
 * 刻意保守：飞书「上传素材」接口的频控是 **5 QPS / 10000 次每天**，
 * 而且**不支持并发调用**（并发会回 `1061045`）⇒ 默认只开 2 个并发、每批之间歇一下。
 */
const BATCH = Object.freeze({
  concurrency: 2,
  // 每批之间的间隔（毫秒）。0 = 不歇。
  intervalMs: 300,
  // 单次运行最多处理多少条（0 = 不限；`--limit=N` 覆盖）。
  limit: 0,
});

const TAG_QR_CODE = Object.freeze({
  enabled: ENABLED,
  scanUrl: SCAN_URL,
  qr: QR,
  upload: UPLOAD,
  fileName: FILE_NAME,
  temp: TEMP,
  events: EVENTS,
  batch: BATCH,
  // 物理列名只有一个去处：`config/v1BitableSchema.js` 的 `product.fields`。
  // 这里只放**语义键**（网关 update 收的就是它），避免同一个列名有两份真源。
  fields: Object.freeze({
    number: 'number',
    tagQrCode: 'tagQrCode',
  }),
});

module.exports = {
  TAG_QR_CODE,
  SCAN_URL,
  QR,
  UPLOAD,
  FILE_NAME,
  TEMP,
  EVENTS,
  BATCH,
};
