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
   - 命名：⭐ **用「编号」**（= `货号|颜色|类别`，业务负责人 2026-11-10：「需要用编号」）——
     编号里的 `|` 在文件名里换成 `_`，例 `261175_杏色_A.jpg` / `A1_黑色_B-1.png`（多张加 `-1` `-2`）；
     编号公式为空（新增瞬间还没算完）⇒ ⭐ **重试直到有**（业务负责人 2026-11-10）：
     隔 `SAMPLE_IMAGE_DRIVE_NUMBER_WAIT_MS`（默认 2s）重读记录，最多
     `SAMPLE_IMAGE_DRIVE_NUMBER_WAIT_ATTEMPTS`（默认 8 次 ≈16s）；仍没有 ⇒ **跳过不传、不勾**
     （等记录补全后由存量按钮补；**不再用货号/颜色兜底**）；
     ⚠️ 这样同货号同色、类别 A/B 两条记录**不会撞名互相覆盖**
   - 同名已存在 ⇒ 默认**先删同名旧文件再传**（`replace`；只删与我们命名完全一致的那个）
4. **全部成功**后把「已同步云盘」复选框勾上；任何失败 ⇒ **不勾**，留给补跑。

## 二、落点（配置先行 + 分层）

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 配置 | `server/src/config/sampleImageDrive.js` | 文件夹 token / 命名模板 / 触发动作（只有 `record_added`）/ 覆盖策略 / 单条最多几张 / 等编号参数（`SAMPLE_IMAGE_DRIVE_*` 可覆盖）；⭐ **没有开关**（业务负责人 2026-11-10：「不需要加开关」，AC-SD12 钉住） |
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
| AC-SD5 | 多张 ⇒ `-1` `-2`；同名先删旧文件（她手工传的 `261175杏色.jpg` 这类不同名文件保留） |
| AC-SD6 | 上传失败 ⇒ 不勾、失败如实返回 |
| AC-SD7 | 命名口径（**编号 `货号|颜色|类别` → `_` 分隔**；编号空 ⇒ **空串**、不兜底；非法字符替换；缺省 `.jpg`；非图片附件不混入） |
| AC-SD12 | ⭐ 源码哨兵：不许再出现 `SAMPLE_IMAGE_DRIVE_SYNC_ENABLED` / `enabled` 开关字段（塞回即红） |
| AC-SD10 | 新增瞬间编号为空 ⇒ **重试直到有编号**再用它命名（读 3 次，文件名 `A1_黑色_A.jpg`，不是 `A1黑色A.jpg`） |
| AC-SD11 | 一直等不到编号 ⇒ 跳过不传、**不勾**（留给存量补） |
| AC-SD8 | schema 契约：两个字段映射在货品信息 schema 里；默认文件夹 = `NIxifKs4ulS5uudlGP2cKtDBnkd` |

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

### 异步与轻量 toast（2026-11-10 第二轮补充）

业务负责人：「也需要实现异步和轻量 toast，你看下代码有统一配置逻辑」⇒ 存量按钮**接统一异步任务层**，不自己造状态机：

- **job 类型**：`config/asyncJobs.js` 新增 `sample_image_backfill`（id 前缀 `sample_image_backfill_job_`，
  中文类型名「存量样例图同步」）；重试次数/退避/失败通知群全部沿用 `ASYNC_JOB_*` 配置；
- **状态可查**：`GET /api/workbench/async-jobs/:jobId`（既有统一接口，只能查自己的；只回状态不返 payload）；
- **失败处理**：单条失败 ⇒ 整轮落 `partial_failed` 终态 ⇒ 统一层**发运营群**（页面**不显示失败提示**）；
- **页面轮询**：`GET /api/workbench/data-config/sample-image-sync` 返回计数 + `job_id/job_status`；
- **轻量 toast**：`features/shared/toast.js` 的 `showToast`（3 秒、复用 `.workbench-toast` 样式）——
  点一下弹「已开始同步存量样例图…」，跑完弹「同步结束：成功 x，跳过 y，失败 z」；交割单页原来那份
  toast 实现**收口到同一个**（`ui-feedback.js` 只 re-export，行为逐字不变）。

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

## 六¾、真机事故与修复（2026-11-10 04:19，上线首次点「同步存量样例图」）

- **现象**：云盘里全是同名 `[object Object].jpeg`（每条记录互相覆盖），表里逐条被勾「已同步云盘」。
- **根因**：「编号」是**公式列**，接口返回富文本数组 `[{ "text": "66888|黑色|男", "type": "text" }]`；
  旧 `textOf` 用 `String(value)` ⇒ `[object Object]` ⇒ 文件名全撞一起。
- **止损**：业务负责人同意「暂停」⇒ 重启服务（`pm2 restart`）中断循环；最后一笔同步 04:21:33，重启 04:21:36。
- **损伤**（可控）：12 条被误勾「已同步云盘」、云盘里 2 个垃圾文件（`[object Object].jpg` / `.jpeg`）；
  **原始样例图仍在多维表格附件里，没有丢**。
- **修复**：`textOf` 改为能解富文本数组/对象（`[{text}]` / `{text}` / 纯字符串）；
  判据 **AC-SD13** 用真机形状 `[{"text":"66888|黑色|男","type":"text"}]` 钉住：
  `buildFileName` 与 `syncRecord` 都必须产出 `66888_黑色_男.jpg`，且**不许**再出现 `object Object`。
- **善后**（待业务负责人指令）：清掉这 12 条误勾 → 删 2 个垃圾文件 → 部署修复 → 重新点按钮补 343 条。

## 六⅘、固定所有者 = 赵瑞玲（2026-11-10 追加，业务负责人定稿）

**需求**：所有样例图文件的所有者**固定为赵瑞玲**（不能算应用「来财」，也不按点击人/录入人）。

**做法**：飞书有「**转移云盘文档所有者**」接口（`drive.permission.member.transferOwner`，`type=file`）——
每张图上传成功后，立刻把所有者转移给固定的人：

| 环节 | 做法 |
| --- | --- |
| 配置 | `SAMPLE_IMAGE_DRIVE_OWNER_OPEN_ID`（推荐）或 `SAMPLE_IMAGE_DRIVE_OWNER_EMAIL`（跨应用更稳）；两个都空 ⇒ 不转移（所有者=应用） |
| 上传后 | `services/sampleImageDriveService.js` 对**每一张上传成功**的文件调 `transferFileOwner`（`need_notification:false`，不叮人） |
| 失败 | 转移失败 ⇒ 这条记录**不勾**、记 `failed`（如实；下次点按钮会重传+重转） |
| 两条链路 | 新增自动同步 + 存量按钮**都走同一套**（同一处上传后逻辑） |

⚠️ 赵瑞玲的测试账号 open_id 属于**测试应用**；生产要配**本应用**口径的 open_id，
或直接用**邮箱**（`member_type: 'email'`，与哪个应用无关，最稳）。

判据：AC-SD16（配置 owner ⇒ 每个文件都转移；转移失败不勾）＋ AC-OT6（transferOwner 参数形状 / openid 与 email / 缺 owner 抛错）。

## 六⅚、真机事故 2：转移所有者 SDK 路径写错（2026-11-10 06:55）

- 现象：点按钮后日志全是 `product.sample_image.drive.failed`，
  `error: "Cannot read properties of undefined (reading 'member')"`；**一条都没勾**。
- 根因：SDK 资源名是 `client.drive.permissionMember.transferOwner`
  （camelCase），写成了 `client.drive.permission.member` ⇒ `permission` 为 undefined。
- 影响：**上传其实成功了**（云盘会看到正确命名的文件），但转移所有者那步抛错 ⇒ 记录被判失败、不勾；
  整轮终态 `partial_failed`（统一层会给运营群发一条失败通知）。
- 修复：改成 `permissionMember`；判据 AC-OT6 用**与 SDK 相同的结构**（`drive.permissionMember`）钉住，
  假客户端里不再用错误结构（塞回旧结构必红）。
- 处置：等部署修复后**再点一次按钮** ⇒ 同名覆盖重传 + 转移所有者（不会重复堆文件）。

## 七、未做（等她拍板）

1. 存量 184 条"有图但未勾"的批量补齐（要不要现在做、按什么顺序、失败怎么退）；
2. 换图（`record_edited`）是否也要同步（她本轮明确"只有新增"）；
3. 同名覆盖策略是否改成"跳过"（当前默认 `replace`，来自 2026-10-13 任务底稿建议）。
