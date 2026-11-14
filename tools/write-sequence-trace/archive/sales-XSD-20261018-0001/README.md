# 销售写入时序归档 · XSD-20261018-0001
> ⚠️ **2026-11-14：数据文件不再入库**。本目录只保留这份 README；
> `events-*.json` / `trace_chain-*.json` / `*.html` 已从 git 停止跟踪（仓库是 **PUBLIC**，
> 它们含**真实单号/金额/操作人**）。文件仍在原生成机器的本地目录里，复现方法见下文。


## 产物

| 文件 | 说明 |
|---|---|
| `sales-XSD-20261018-0001.html` | 单文件、离线可打开的时序图；数据内联，无 CDN |
| `events-XSD-20261018-0001.json` | 标准事件数据（17 个历史事件 + 1 个删除推断） |
| `trace_chain-XSD-20261018-0001.json` | 原始事件链（生成 HTML 前的中间形态） |

打开方式：

```bash
open tools/write-sequence-trace/archive/sales-XSD-20261018-0001/sales-XSD-20261018-0001.html
```

## 数据来源

销售单：`XSD-20261018-0001`

[销售主表](https://scnzoiwpgxik.feishu.cn/base/QrXlbwXMLaJ2TNsxSfFcIA3rnwh?table=tblLjFe3NjU61xKB)

## 这份图证明了什么

- 17 个可回放步骤直接来自「记录历史」接口：
  `record-history-list` 的 `create_time` / `rev` / `operator` / `before` / `after`；
- 事件按 `(create_time, rev)` 全局排序；
- 销售主表、销售明细、库存流水、S交易明细四张表的字段级变化在一条时间轴上；
- 实时库存的整条删除**不可回放**：记录已删除后没有 `record_id`，历史接口查不到；
- 删除节点单独放在 `deletes`，标 `inferred: true`，用快照差集 + 库存流水出库事件推断，不冒充历史事件。

## 边界

```text
这是 2026-10-18 这一单的静态快照，不是可切换单号的在线页面
换单号：重新跑 tools/write-sequence-trace/scripts/fetch_trace.py
删除节点：只证明“记录消失 + 出库时点”，精确删除秒不可考
```

## 重新生成

```bash
set -a
source .env
set +a
python3 tools/write-sequence-trace/scripts/fetch_trace.py XSD-20261018-0001 --config sales
python3 tools/write-sequence-trace/scripts/build_html.py \
  tools/write-sequence-trace/output/events-XSD-20261018-0001.json \
  --out tools/write-sequence-trace/archive/sales-XSD-20261018-0001/sales-XSD-20261018-0001.html
```

⚠️ `fetch_trace.py` 需要本机可用的 `lark-cli` 用户身份；只读。
