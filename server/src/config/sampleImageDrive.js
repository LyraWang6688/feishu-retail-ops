'use strict';

/**
 * 「货品信息.样例图」→ 云盘文件夹 自动同步（业务负责人 2026-11-10 指令）。
 *
 * 她的口径（逐字，本轮）：
 *   「是的，就是这个时候把样例图写入到云盘里，**但只有新增的时候**，
 *     然后需要把**那个复选框勾选上**」
 *
 * 之前的任务底稿：`docs/task-sample-image-drive-sync-2026-10-13.md`（她 2026-10-13 交办）
 * 与 issue #629「自动同步样例图到云盘」（OPEN）。
 *
 * ── 本轮范围（刻意收窄）──────────────────────────────────────────────────
 *   · **只在「货品信息」表 `record_added`（新增）时触发**（改图/编辑暂不触发 —— 她说的"只有新增"）；
 *   · 把该记录的「样例图」（附件，可多张）**下载后上传到指定云盘文件夹**；
 *   · 全部成功后把该记录的**「已同步云盘」复选框勾上**（= 幂等标记 + 她一眼看进度）；
 *   · 存量 184 条"有图但未勾"的批量补齐**不在本轮**（同一份配置下可另开脚本，照旧"先干跑再动手"）。
 *
 * ── 红线（2026-10-13 那张任务的第六节）────────────────────────────────────
 *   🔴 只上传「样例图」，**不把别的附件**（如「标签二维码」）混进这个文件夹；
 *   🔴 **成本**等内部字段永远不进云盘内容（只传图片字节 + 文件名 = 货号 + 颜色）；
 *   🔴 不删云盘里**不是我们传的**文件（同名覆盖只针对我们自己命名的文件）。
 *
 * ── 配置先行 ─────────────────────────────────────────────────────────────
 *   文件夹 token / 命名模板 / 触发动作 / 覆盖策略 / 单条最多几张 / 开关 全在这里；
 *   逻辑里一个字符串一个数字都不写死（`config/sampleImageDrive.js` 是唯一真源）。
 */

const { readFlag, readInt, readString } = require('./envValue');

/**
 * 目标云盘文件夹（业务负责人 2026-10-13 给的链接里的 token）：
 * `https://scnzoiwpgxik.feishu.cn/drive/folder/NIxifKs4ulS5uudlGP2cKtDBnkd`
 *
 * ⚠️ 换文件夹 = 只改 env / 这一行；文件夹里已有她手工传的 `261175杏色.jpg` 之类的文件
 *   —— **不删**（只覆盖"我们按命名模板生成的名字"）。
 */
const FOLDER = Object.freeze({
  token: readString(process.env, 'SAMPLE_IMAGE_DRIVE_FOLDER_TOKEN', 'NIxifKs4ulS5uudlGP2cKtDBnkd'),
  // `drive.file.upload_all` 的 parent_type：云空间文件夹 = `explorer`
  parentType: 'explorer',
  // 只用于日志 / 人话提示（不参与任何请求）
  displayUrl: readString(
    process.env,
    'SAMPLE_IMAGE_DRIVE_FOLDER_URL',
    'https://scnzoiwpgxik.feishu.cn/drive/folder/NIxifKs4ulS5uudlGP2cKtDBnkd',
  ),
});

/**
 * 触发动作（**只有新增**，2026-11-10 业务负责人）：
 *   · `record_added` = 新增；改图/换图**不触发**（她明确"只有新增的时候"）；
 *   · 删除没有落点 ⇒ 不列。
 * ⚠️ 以后要加"换图也同步" = 往 `updated` 里加动作 + 回填/幂等判据一起改，**不是**宽松匹配。
 */
const EVENTS = Object.freeze({
  created: Object.freeze(['record_added']),
  updated: Object.freeze([]),
});

/**
 * 文件命名（业务负责人 2026-10-13 的建议口径，本轮沿用）：
 *   `{货号}{颜色}` + 原扩展名（缺省 `.jpg`），例：`261175杏色.jpg`
 *   · 多张样例图 ⇒ 全部上传，加 `-1` `-2` 序号（`…-1.jpg`、`…-2.jpg`）；
 *   · 非法字符按 Windows/飞书通用规则替换成 `_`（不改变可读性）。
 */
const NAMING = Object.freeze({
  template: '{itemNo}{color}',
  multiSuffix: '-{index}',
  fallbackExtension: '.jpg',
  // 云盘文件名里不允许/容易出问题的字符
  illegalChars: Object.freeze(['/', '\\', ':', '*', '?', '"', '<', '>', '|']),
  replacement: '_',
  maxLength: 200,
});

/**
 * 同名处理：`replace` = 先删同名旧文件再传（一条货品一张图，不堆重复）；
 * `skip` = 同名已存在就不传（更保守，但换图后云盘会停旧图）。
 * ⚠️ 本轮"只新增"，同名极少；默认按 2026-10-13 任务底稿的建议 = `replace`。
 */
const OVERWRITE = readString(process.env, 'SAMPLE_IMAGE_DRIVE_OVERWRITE', 'replace');

/**
 * 单条记录最多处理几张样例图（防一张记录挂几十张图把事件拖死）。
 * 超出的不传、记一条 warn（**不静默**）；`0` = 不限。
 */
const MAX_IMAGES = readInt(process.env, 'SAMPLE_IMAGE_DRIVE_MAX_IMAGES', 10, { min: 0, max: 100 });

/**
 * 整条链路的开关（**显式布尔**，不用 `||` 兜底 —— 清空变量不等于关闭）。
 * 关掉 = 事件到达时只记一条 `product.sample_image.drive.disabled`，一个字节都不传。
 */
const ENABLED = readFlag(process.env, 'SAMPLE_IMAGE_DRIVE_SYNC_ENABLED', true);

/**
 * 存量补齐（数据配置 → 「同步存量样例图」卡片按钮，业务负责人 2026-11-10）：
 *   · `maxRecords`：一次最多处理多少条（0 = 不限；防一次点太多把进程占满）——
 *     默认 0：她点就是要"全部补齐"，184 条左右 ⇒ 串行约几分钟，后台跑；
 *   · 仍然**只处理「有图且未勾」**的记录（已勾的跳过）；幂等，重复点只会把剩下的补完。
 */
const BACKFILL = Object.freeze({
  maxRecords: readInt(process.env, 'SAMPLE_IMAGE_DRIVE_BACKFILL_MAX', 0, { min: 0, max: 10000 }),
});

/**
 * 只从语义键取字段（物理列名唯一真源 = `config/v1BitableSchema.js` 的 `product.fields`；
 * 这里**不复制列名**，只在渲染/写库时经网关的语义映射落地）。
 */
const FIELDS = Object.freeze({
  sampleImage: 'sampleImage',
  synced: 'sampleImageSynced',
});

/**
 * 网关调用时的「操作名」文案（只用于内部报错，例如"上传文件到云盘失败: xxx"）。
 * ⚠️ 中文文案放在 **config**（`views`/`services` 里新增中文会被硬编码中文闸门记成新增存量债；
 *    config 目录不在扫描范围内 ✓）。
 */
const DRIVE_OPERATIONS = Object.freeze({
  download: '下载样例图素材',
  upload: '上传样例图到云盘',
  list: '列出云盘文件夹',
  delete: '删除云盘同名旧文件',
});

const SAMPLE_IMAGE_DRIVE = Object.freeze({
  enabled: ENABLED,
  folder: FOLDER,
  events: EVENTS,
  naming: NAMING,
  overwrite: OVERWRITE,
  maxImages: MAX_IMAGES,
  fields: FIELDS,
  operations: DRIVE_OPERATIONS,
  backfill: BACKFILL,
});

module.exports = {
  SAMPLE_IMAGE_DRIVE,
  SAMPLE_IMAGE_DRIVE_EVENTS: EVENTS,
  SAMPLE_IMAGE_DRIVE_FIELDS: FIELDS,
  SAMPLE_IMAGE_DRIVE_FOLDER: FOLDER,
  SAMPLE_IMAGE_DRIVE_NAMING: NAMING,
  SAMPLE_IMAGE_DRIVE_OPERATIONS: DRIVE_OPERATIONS,
  SAMPLE_IMAGE_DRIVE_BACKFILL: BACKFILL,
};
