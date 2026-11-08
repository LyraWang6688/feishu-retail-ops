# 多维表格写入时序图（write-sequence-trace）

把一张真实单据在飞书多维表格里的**字段级写入历史**，还原成可离线打开的单文件 HTML 时序图。

当前包含：
- 销售链路的真实样例（`XSD-20261018-0001`）；
- 标准事件 schema + 纯渲染模板；
- 销售/采购两份链路配置（采购为待验证草稿）；
- `build_html.py`：标准 `events.json` → 单文件 HTML；
- `extract_raw.py`：旧版单文件 HTML → 标准 `events.json`；
- `fetch_trace.py`：按配置从飞书取数 → 标准 `events.json`；
- `merge_history_json.py`：旧版手动合并历史 JSON 的兜底脚本；
- `docs/bitable-cross-table-write-sequence.md`：豆包沉淀的跨表追踪经验。

## 目录

```text
write-sequence-trace/
├─ configs/
│  ├─ sales.config.json       销售：起点表、关联路径、阶段
│  └─ purchase.config.json    采购：草稿，资金端待验证
├─ templates/
│  └─ trace.html.tmpl         纯渲染器（只认标准 schema）
├─ scripts/
│  ├─ build_html.py           events.json → HTML
│  ├─ extract_raw.py          旧 HTML → events.json
│  ├─ fetch_trace.py          飞书取数 → events.json
│  └─ merge_history_json.py   旧版手动合并历史 JSON（兜底）
├─ docs/
│  └─ bitable-cross-table-write-sequence.md  跨表追踪经验

├─ examples/
│  ├─ sales-XSD-20261018-0001.html   现有真实样例
│  └─ events-XSD-20261018-0001.json  样例的标准数据
└─ output/                    生成结果（不提交）
```

## 标准事件 schema

```json
{
  "meta": {
    "order": "XSD-20261018-0001",
    "chain": "sales",
    "date": "2026-10-18",
    "start": "13:58:17",
    "end": "14:00:12",
    "total_sec": 115,
    "table_count": 5,
    "operators": ["来财"],
    "kind_count": {"record_add": 4, "field_change": 6, "field_add": 7},
    "event_count": 17,
    "page_title": "可选，默认「跨表写入时序 · 单号」",
    "page_heading": "可选，默认「一个销售单的跨表写入时序」"
  },
  "tables": ["销售主表", "销售明细", "库存流水", "实时库存", "S交易明细"],
  "phases": [{"name": "① 销售建单", "from": 0, "to": 28}],
  "events": [{
    "table": "销售主表",
    "kind": "record_add|field_add|field_change|field_clear|record_del",
    "field": "销售状态",
    "before": "未写入",
    "after": "已写入",
    "clock": "13:58:44",
    "elapsed": 27,
    "rev": 1667,
    "operator": "来财",
    "evidence": "history",
    "evidence_note": "记录历史接口可回放"
  }],
  "deletes": [{
    "table": "实时库存",
    "kind": "record_del",
    "inferred": true,
    "before": "92608|黑色|A|39",
    "clock": "约13:59",
    "elapsed": 62,
    "operator": "业务系统",
    "evidence_note": "快照差集推断，接口无法回溯"
  }]
}
```

## 使用

取数（需要本机已配置可用的 lark-cli 身份，且只读）：

```bash
export FEISHU_V1_BITABLE_APP_TOKEN='<base_token>'
python3 tools/write-sequence-trace/scripts/fetch_trace.py XSD-20261018-0001 --config sales
```

生成 HTML：

```bash
python3 tools/write-sequence-trace/scripts/build_html.py \
  tools/write-sequence-trace/examples/events-XSD-20261018-0001.json \
  --out tools/write-sequence-trace/output/XSD-20261018-0001.html
```

从旧版单文件 HTML 提取数据：

```bash
python3 tools/write-sequence-trace/scripts/extract_raw.py \
  tools/write-sequence-trace/examples/sales-XSD-20261018-0001.html \
  --out /tmp/events.json
```

## 环境变量与 Base 切换（不写死生产 ID）

- Base 令牌只从 `FEISHU_V1_BITABLE_APP_TOKEN` 读取，缺失即报错退出，脚本内无任何明文令牌。
- 每张表在 config 里同时给了 `table_id_env`（对应根目录 `.env.example` 的 `FEISHU_V1_*_TABLE_ID`）与离线兜底用的字面 `table_id`。解析顺序：
  1. 环境变量 `table_id_env` 有非空值 → 用它（本机 `.env` 指向测试 Base 时自动跟随测试表 ID）；
  2. 否则回退 config 里的 `table_id` 字面量（仅离线兜底）；
  3. 两者都缺 → 直接报错，不会静默打到错误的表。
- 取数开始前会在 stderr 打印一行 `TRACE_TABLES`，列出本次每张表实际解析到的 ID，便于核对当前连的是测试还是生产 Base。
- 工具始终只读（仅 `record-list` / `record-history-list`，且固定 `--as user`），不含任何写库动作。

## 本地测试

纯离线，不连飞书、不需要凭证：

```bash
python3 -m unittest discover -s tools/write-sequence-trace/scripts -p 'test_*.py'
```

覆盖：HTML 渲染与 `</script>` 转义、旧 HTML 提取往返、表 ID 的环境变量优先 / 字面回退 / 皆缺报错。

## 数据获取边界（真实能力）

`events.json` 可以由人工/Agent 通过飞书 `record-history-list` 逐条记录采集后归一化，脚本本身只负责渲染，不内置写库/取数副作用。

已确认：
- 记录历史只能按**现存 record_id** 逐条查，没有整表审计接口；
- 字段清空可回放；**整条记录删除无法从历史接口回溯**；
- 删除只能通过“启用前快照 + 事后差集”推断，必须在图上标注为推断、不能伪装成历史；
- 没有多维表格记录变更的实时推送通道。

## 采购适配（草稿）

`purchase.config.json` 是按销售链路的镜像草稿，尚未用真实采购单验证。已知风险：

- 采购 P交易明细字段很少，资金流水可能为空；
- 采购主表/明细的关联字段名需以当前生产 schema 为准；
- 先拿一张真实采购单只读跑通，确认哪几段有数据，再据实标注缺失段。

## 下一步

1. 用真实测试 Base 跑通 `fetch_trace.py`（本机 lark-cli 身份可用时）；
2. 采购单真实跑通后补 `purchase.config.json`；
3. 删除推断机制化：快照库 + 差集 + 证据等级；
4. 可选：定时巡检。
