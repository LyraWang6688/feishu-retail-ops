#!/usr/bin/env python3
"""把标准 events.json 注入单文件时序模板，生成可离线打开的 HTML。

标准 schema（与具体业务无关）:
  meta: {order, date, start, end, total_sec, table_count, operators, kind_count,
         event_count, chain?, page_title?, page_heading?}
  tables: [str]
  phases: [{name, from, to}]
  events: [{ts?, rev?, table, operator?, kind, field, before, after, clock, elapsed,
            evidence?, evidence_note?}]
  deletes: [{table, kind:'record_del', inferred:true, before/after, clock, elapsed,
             operator?, evidence_note?}]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

RAW_PLACEHOLDER = '{{RAW_JSON}}'
TITLE_PLACEHOLDER = '{{PAGE_TITLE}}'
HEADING_PLACEHOLDER = '{{PAGE_HEADING}}'


def load_raw(path: Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict) or not isinstance(data.get('meta'), dict):
        raise ValueError('events.json 缺少 meta')
    if not isinstance(data.get('events'), list):
        raise ValueError('events.json 缺少 events')
    if not isinstance(data.get('tables'), list):
        raise ValueError('events.json 缺少 tables')
    return data


def render(template: str, raw: dict) -> str:
    meta = raw.setdefault('meta', {})
    order = str(meta.get('order') or '').strip()
    chain = str(meta.get('chain') or 'sales').strip()
    default_heading = '一个销售单的跨表写入时序' if chain == 'sales' else '一条记录链的跨表写入时序'
    page_title = str(meta.get('page_title') or f'跨表写入时序 · {order or "未命名"}')
    page_heading = str(meta.get('page_heading') or default_heading)
    raw_json = json.dumps(raw, ensure_ascii=False, separators=(',', ':'))
    # 防止数据里出现 </script> 提前闭合脚本；JSON 字符串中的 \/ 合法。
    raw_json = raw_json.replace('</', '<\\/')
    if TITLE_PLACEHOLDER not in template or HEADING_PLACEHOLDER not in template or RAW_PLACEHOLDER not in template:
        raise ValueError('模板缺少占位符')
    return (template
            .replace(TITLE_PLACEHOLDER, page_title)
            .replace(HEADING_PLACEHOLDER, page_heading)
            .replace(RAW_PLACEHOLDER, raw_json))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='生成单文件写入时序 HTML')
    parser.add_argument('events', type=Path, help='标准 events.json')
    parser.add_argument('--template', type=Path,
                        default=Path(__file__).resolve().parent.parent / 'templates' / 'trace.html.tmpl')
    parser.add_argument('--out', type=Path, help='输出 HTML；缺省 output/<order>.html')
    args = parser.parse_args(argv)
    try:
        raw = load_raw(args.events)
        out = args.out or (Path(__file__).resolve().parent.parent / 'output' / f"{raw['meta'].get('order') or 'trace'}.html")
        template = args.template.read_text(encoding='utf-8')
        html = render(template, raw)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(html, encoding='utf-8')
        print(out)
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
