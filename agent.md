# feishu-retail-ops Agent Guide

本文档面向“智能代理/自动化工具/二次开发脚本”，用于快速理解本仓库的业务目标、模块差异、接口契约与排错方式。默认读者不关心 UI 细节，只关心数据流、约束与可观测性。

## 1. 业务目标与边界

`feishu-retail-ops` 的通用产品名是“零售数智经营助手”，邯美部署名称是“邯美数智经营工作台”。当前核心能力是：
- 销售录入：用户在飞书私聊中发送销售文字 → 大模型解析 → 消息卡片确认 → 销售、库存和资金联动入账
- 采购录入：用户在飞书私聊中发送到货图片 → 大模型识别 → 消息卡片确认 → 采购、库存和供应商往来联动入账
- 数据查询与分析：后续由网页工作台和飞书多维表格视图共同承载

微信小程序属于冻结的遗留链路，暂时保留但不再维护；飞书 V1 禁止依赖微信路由、控制器或旧销售任务存储。

## 2. 模块（module）定义

数据录入包含三个模块：
- purchase：采购（数量累加）
- sales：销售（明细流水）
- inventory：库存（数量累加）

模块差异只体现在：
- 大模型输出字段集合（prompt/schema）
- 前端人工复核字段集合
- 写入飞书的目标表格与字段映射
- 写入口径（累加 upsert vs 明细 create）

## 3. 统一字段与约定

### 3.1 核心字段（大模型解析）
- item_no：货号（string）
- color：颜色（string）
- size：尺码（number/string，后端会规范化）
- supplier：供应商（string，仅 purchase 必需）

### 3.2 系统字段（自动生成）
- SKU_Code：用于 purchase/inventory 的唯一键。命名规则在后端 `generateSkuCode(item_no, color, size)` 中定义。
- quantity：数量。purchase/inventory 由聚合计算产生；sales 由人工输入。
- 对应图片：飞书附件字段。写入格式为 `[{ file_token: "..." }]`。

### 3.3 写入口径
- purchase / inventory：
  - 以 `SKU_Code` 为检索键
  - 若存在记录：数量累加（old + delta），附件字段可更新
  - 若不存在记录：创建新记录
- sales：
  - 明细流水：每条复核记录创建一条飞书记录
  - 不依赖 `SKU_Code` 作为唯一键

## 4. 图片写入飞书的标准链路

链路必须为：
1) 调用飞书 Drive 上传素材接口获取 `file_token`
2) 调用 Bitable 记录 create/update，将附件字段写入为 `[{file_token}]`

同一张图片若解析出多条记录，应复用同一个 `file_token` 写入多条记录，减少上传次数与限流风险。

## 5. 接口契约（后端）

### 5.1 健康检查

`GET /health`

### 5.2 识别上传（数据录入）

`POST /api/recognition/upload`（multipart/form-data）

字段：
- image：图片文件（必填）
- module：purchase / sales / inventory（必填）

响应（示例）：
```json
{
  "success": true,
  "task_id": "image-xxx.jpg",
  "file_token": "file_xxx",
  "results": [
    { "item_no": "3363-16", "color": "米", "size": "37", "supplier": "一代千金" }
  ]
}
```

### 5.3 同步写入飞书（数据录入）

`POST /api/sync`（application/json）

字段：
- reviewed_data：复核后的记录数组（必填）
- module：purchase / sales / inventory（必填）
- task_id：图片文件名（可选，用于同步阶段兜底上传）
- file_token / feishu_file_token：预上传得到的飞书附件 token（可选）

返回：
- 全部成功：HTTP 200，`success: true`
- 部分失败：HTTP 207，`success: false`，并返回 `results[]` 逐条状态

### 5.4 失败重试

`POST /api/sync/retry`

字段：
- reviewed_data / failed_records（必填，传需要重试的失败记录）
- task_id（可选）
- file_token / feishu_file_token（可选）
- module（必填）

### 5.5 库存查询（数据查询）

`GET /api/query/inventory?item_no=xxx`

响应（示例）：
```json
{
  "success": true,
  "item_no": "3363-16",
  "rows": [
    { "size": 37, "quantity": 2 },
    { "size": 38, "quantity": 5 }
  ]
}
```

## 6. 可观测性与排错（Agent 必读）

### 6.1 飞书附件写入排查顺序

排查必须基于证据链：
1. upload_all 的入参（file_name / parent_type / parent_node / size）
2. upload_all 的出参中是否拿到 `file_token`
3. 写入 bitable 的入参 fields 中是否包含 `对应图片: [{file_token}]`
4. create/update 的返回是否 `code=0`，否则读取 msg 定位权限/字段类型等问题

### 6.2 调试开关

默认开发环境会输出飞书相关请求入参/出参（token 脱敏）。可通过环境变量控制：
- `FEISHU_DEBUG=true`：强制输出飞书调试日志
- `FEISHU_DEBUG_SHOW_TOKENS=true`：输出 token 明文（仅本地排查使用）

## 7. 风险点与约束

- 飞书筛选 DSL 受字段名影响。为提高稳定性，本项目优先使用 `SKU_Code` 做检索键（避免多字段 AND 与中文列名脆弱性）。
- 销售的“支付方式”为单选字段，若写入报参数错误，需要将 label 映射为 option_id（可后续补齐）。

## 8. 变更指南（面向 agent 的改动策略）

当新增模块或新增字段时，优先按“配置驱动”扩展，不要复制三套 controller：
- 新增 module：扩展 prompt/schema、复核字段、写入表格配置与写入口径
- 新增查询：优先封装为后端查询接口，前端只负责展示
