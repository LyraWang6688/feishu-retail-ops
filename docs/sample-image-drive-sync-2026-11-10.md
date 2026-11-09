# 样例图 → 云盘自动同步（2026-11-10 实现）

> 业务负责人 2026-11-10 本轮口径（逐字）：
> 「是的，就是这个时候把样例图写入到云盘里，**但只有新增的时候**，
>  然后需要把**那个复选框勾选上**」
>
> 来源任务：`docs/task-sample-image-drive-sync-2026-10-13.md`（她 2026-10-13 交办）·
> issue #629「自动同步样例图到云盘」（OPEN）。
>
> 实现状态：**本轮只做"新增触发 + 勾复选框"这一条**（存量 184 条批量补齐不在本轮）。

## 一、做什么（一条链路，四步）

1. 事件入口 `drive.file.bitable_record_changed_v1` 收到**货品信息表**的变更；
2. 只挑 **`record_added`（新增）** —— `record_edited` / `record_deleted` **一条都不处理**；
3. 读该货品记录 → 取 **「样例图」附件**（0 张就跳过，不勾复选框）→ 逐张：
   - 下载素材（`drive/v1/medias/{file_token}/download`）
   - 上传到云盘文件夹（`drive/v1/files/upload_all`，`parent_type=explorer`）
   - 命名：`{货号}{颜色}` + 原扩展名；多张加 `-1` `-2`（例：`261175杏色.jpg` / `A1黑色-1.png`）
   - 同名已存在 ⇒ 默认**先删同名旧文件再传**（`replace`；只删与我们命名完全一致的那个）
4. **全部成功**后把「已同步云盘」复选框勾上；任何失败 ⇒ **不勾**，留给补跑。

## 二、落点（配置先行 + 分层）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 配置 | `server/src/config/sampleImageDrive.js` | 文件夹 token / 命名模板 / 触发动作（只有 `record_added`）/ 覆盖策略 / 单条最多几张 / 开关（`SAMPLE_IMAGE_DRIVE_*` 可覆盖，显式布尔） |
| 表字段 | `server/src/config/v1BitableSchema.js` | `product.fields.sampleImageSynced = '已同步云盘'`（复选框；本轮唯一新增映射） |
| 云盘层 | `server/src/services/driveApi.js` | `downloadMedia` / `uploadDriveFile` / `listDriveFolder` / `deleteDriveFile` 四个 drive 封装（不做业务判断）；网关构造器里挂成 `gateway.drive`（网关本身不塞这四段，避免单文件超 800 行棘轮） |
| 服务 | `server/src/services/sampleImageDriveService.js` | 判定 + 串行下载/上传 + 幂等（复选框）+ 日志 |
| 入口 | `server/src/routes/larkEvents.js` | 货品信息分支里**再分派一次**（与「标签二维码」并列、互不阻断、都异步） |
| 装配 | `server/src/services/larkMvpService.js` | `this.sampleImageDrive = createSampleImageDriveService({ gateway, config })` |

## 三、判据与幂等

- **触发**：只有 `record_added`（`config/sampleImageDrive.js` 的 `events.created`；`updated` 本轮刻意为空）。
- **幂等**：`已同步云盘 === true` ⇒ 跳过（重复事件 / 重试都只传一次）。
- **没图**：跳过且**不勾**复选框（不能假装同步过）。
- **失败**：记 `product.sample_image.drive.failed`，**不勾**；下一条记录照跑（单条失败不打断整批）。
- **串行**：drive 上传官方限制 5 QPS / 10000 次每天且不支持并发 ⇒ 一张一张传。
- **只传样例图**：附件先过筛（`image/*` 或图片扩展名），「标签二维码」等别的附件不会混进云盘。
- **不碰手工文件**：同名覆盖只删"与我们命名模板完全一致"的那个文件；她手工传的文件保留。

## 四、日志（自动进 `config/events.js`）

`product.sample_image.drive.{disabled,skipped,started,uploaded,synced,failed,partial,truncated,name_exists,not_wired,dispatch_failed}`

关键字段：`record_id` · `file_name` · `file_token`（云盘文件 token）· `reason` · `uploaded_count`。

## 五、验收（不连网的单测，`server/test/sampleImageDriveSync.test.js`）

| AC | 判据 |
| --- | --- |
| AC-SD1 | 只认新增：`record_edited` / `record_deleted` 连记录都不读 |
| AC-SD2 | 有图 ⇒ 下载 + 上传到配置文件夹 + 成功后 `update({ sampleImageSynced: true })` |
| AC-SD3 | 已勾 ⇒ 幂等跳过（不重复下载/上传） |
| AC-SD4 | 没图 ⇒ 跳过且**不勾** |
| AC-SD5 | 多张 ⇒ `-1` `-2`；同名先删旧文件（她手工传的 `261175杏色.jpg` 保留） |
| AC-SD6 | 上传失败 ⇒ 不勾、失败如实返回 |
| AC-SD7 | 命名口径（货号+颜色+扩展名、非法字符替换、缺省 `.jpg`、非图片附件不混入） |
| AC-SD8 | schema 契约：两个字段映射在货品信息 schema 里；默认文件夹 = `NIxifKs4ulS5uudlGP2cKtDBnkd` |
| AC-SD9 | 开关关掉 ⇒ 一个字节都不传 |

路由分派另有三条（`server/test/larkEvents.test.js` ⑥）：两条支路各收到同一份 `action_list`、别的表收不到、一条抛错不阻断另一条。

## 六、红线 / 边界

- 🔴 **成本**等内部字段永不进云盘（文件名只用货号+颜色，内容只有图片字节）；
- 🔴 只传「样例图」，不混「标签二维码」等附件；
- 🔴 不删云盘里**不是我们按模板命名**的文件；
- ⚠️ 本轮**不做**：存量补齐（184 条）、换图触发、失败自动重试/巡检。要补时：
  - 存量补齐 = 单独脚本，照旧「先干跑 → 给她看清单 → 点头后传」；
  - 换图触发 = 往 `events.updated` 加动作 + 幂等判据一起改（不是宽松匹配）；
  - 失败重试 = 走统一 `asyncJobs`（不要自建队列）。
- ⚠️ 部署前必须跑 `v1:schema-check:all`：本轮新增了 `sampleImageSynced → 已同步云盘` 映射，
  若生产列名不是这个（改名），闸门会当场红 —— **以生产真表为准**。

## 六½、两条链路（2026-11-10 第二轮：存量写入的入口）

业务负责人补充口径：

> 「我们实际上是有两个链路，一个是通过表单提交的时候…所以相当于货品上架，所以的话，是首次，
>  就写入到云盘里就可以，然后的话，还需要在配置里的数据配置里增加一个卡片，这个卡片是按钮，
>  卡片的具体样式你可以看下销售录单和采购录单的样式，点击这个，做的就是存量的写入」

| 链路 | 触发 | 做什么 | 入口代码 |
| --- | --- | --- | --- |
| ① 新增（上架首次） | 事件 `record_added` | 自动传这一条 + 勾「已同步云盘」 | `routes/larkEvents.js` → `sampleImageDriveService.handleTableChanges` |
| ② 存量补齐 | 她点「数据配置」里的按钮卡 | 扫全表挑「有图但未勾」逐条补传 + 勾选 | `features/domains/dataConfigAction.js` → `POST /api/workbench/data-config/sample-image-sync` → `services/sampleImageBackfillService.js` |

存量按钮的行为：
- 卡片外观与「销售录单 / 采购录单」那排 `.entry-card` 一致（按钮形态）；
- 点一下 ⇒ 启动一轮**后台**同步（HTTP 立刻返回，不挂几分钟）；
- 页面轮询 `GET /api/workbench/data-config/sample-image-sync` 显示「已处理 x/y、成功 n」；
- 幂等：已勾的跳过；失败的不勾 ⇒ **再点一次只补剩下的**（同名覆盖规则仍生效），不会堆重复文件；
- 一次最多处理条数可配：`SAMPLE_IMAGE_DRIVE_BACKFILL_MAX`（0 = 不限，默认 0）。

验收（`server/test/sampleImageBackfill.test.js`，不连网）：

| AC | 判据 |
| --- | --- |
| AC-BF1 | 只挑「有图且未勾」的记录（没图 / 已勾 / 非图片附件都不碰） |
| AC-BF2 | 逐条**串行**调用同一个 `syncRecord`，计数 = 成功/跳过/失败 |
| AC-BF3 | 已在跑 ⇒ 再点不并发（`started:false`） |
| AC-BF4 | 整表读失败 ⇒ `running:false` + `error` 如实（不假装完成） |
| AC-BF5 | `maxRecords` 生效 |

e2e（`test/e2e/workbench.spec.js`）：货品 → 数据配置 → 卡片在、点一下真的发 POST。
落点登记（`test/workbenchInputLanding.test.js`）：`DATA_CONFIG_API.sampleImageSync` → 只写 `product.sampleImageSynced`。

## 七、未做（等她拍板）

1. 存量 184 条"有图但未勾"的批量补齐（要不要现在做、按什么顺序、失败怎么退）；
2. 换图（`record_edited`）是否也要同步（她本轮明确"只有新增"）；
3. 同名覆盖策略是否改成"跳过"（当前默认 `replace`，来自 2026-10-13 任务底稿建议）。
