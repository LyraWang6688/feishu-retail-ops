#!/usr/bin/env python3
"""按配置从飞书多维表格只读取数，生成标准 events.json。

当前实现：销售链路（单号锚定 → 关联记录 → 逐条 record-history-list）。
采购链路使用同一脚本；table/link 差异只写在 configs/purchase.config.json。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def cli_json(args: list[str]) -> dict:
    result = subprocess.run(['lark-cli', 'base', *args, '--as', 'user'], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"lark-cli 失败: {' '.join(args)}\n{result.stderr[:500]}")
    return json.loads(result.stdout)


def dump_records(base: str, table: str, work_dir: Path) -> list[dict]:
    work_dir.mkdir(parents=True, exist_ok=True)
    output = work_dir / f"{table}.ndjson"
    result = subprocess.run([
        'lark-cli', 'base', '+record-list', '--base-token', base, '--table-id', table,
        '--format', 'ndjson', '--output', str(output), '--overwrite', '--as', 'user',
    ], capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"record-list {table} 失败:\n{result.stderr[:500]}")
    return [json.loads(line) for line in output.read_text(encoding='utf-8').splitlines() if line.strip()]


def links(cell) -> list[str]:
    return [item['id'] for item in (cell or []) if isinstance(item, dict) and item.get('id')]


def fmt(value, idmap: dict) -> str:
    if value is None:
        return '空'
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                rid = item.get('id')
                parts.append(idmap.get(rid, item.get('text') or item.get('name') or rid or ''))
            else:
                parts.append(str(item))
        return '、'.join(str(part) for part in parts)
    if isinstance(value, str) and value in idmap:
        return idmap[value]
    return str(value)


def record_name(record: dict, fields: list[str]) -> str:
    for field in fields:
        value = record.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list) and value:
            text = '、'.join(str(item.get('text') if isinstance(item, dict) else item) for item in value)
            if text.strip():
                return text.strip()
    return record.get('record_id', '')


def history(base: str, table: str, record_id: str) -> list[dict]:
    items, max_version = [], None
    while True:
        args = ['+record-history-list', '--base-token', base, '--table-id', table,
                '--record-id', record_id, '--page-size', '50']
        if max_version:
            args += ['--max-version', str(max_version)]
        data = cli_json(args)['data']
        batch = data.get('items') or []
        items += batch
        if not data.get('has_more') or not batch:
            break
        max_version = min(item['rev'] for item in batch)
    return items


def event_kind(field_change: dict) -> str:
    before, after = field_change.get('before'), field_change.get('after')
    if not before and after:
        return 'field_add'
    if before and not after:
        return 'field_clear'
    return 'field_change'


def collect_targets(config: dict, records: dict[str, list[dict]]) -> dict[str, list[dict]]:
    start = config['start']
    start_rows = records[start['table']]
    start_row = next((row for row in start_rows if row.get(start['order_field']) == config['_order']), None)
    if not start_row:
        raise RuntimeError(f"未找到 {start['order_field']}={config['_order']}")
    selected = {start['table']: [start_row]}
    # 按配置顺序逐层扩展；link 字段在子表上，指向父表 record_id。
    for spec in config.get('tables', []):
        if spec.get('role') != 'linked':
            continue
        parent = spec.get('from')
        if not parent or parent not in selected:
            continue
        parent_ids = {row.get('record_id') for row in selected[parent]}
        rows = [row for row in records[spec['table']]
                if parent_ids & set(links(row.get(spec.get('link_field', ''))))]
        selected[spec['table']] = rows
    return selected


def build_raw(config: dict, selected: dict[str, list[dict]], base: str, work_dir: Path) -> dict:
    labels = {spec['table']: spec['label'] for spec in config.get('tables', [])}
    idmap = {}
    for spec in config.get('tables', []):
        fields = [spec.get('display_field'), '销售单号', '采购单号', '库存键', '交易明细ID']
        for row in selected.get(spec['table'], []):
            idmap[row.get('record_id')] = record_name(row, [f for f in fields if f])
    events = []
    for spec in config.get('tables', []):
        for row in selected.get(spec['table'], []):
            for item in history(base, spec['table'], row['record_id']):
                changes = item.get('field_changes') or []
                if not changes:
                    events.append({
                        'ts': item['create_time'], 'rev': item['rev'], 'table': labels.get(spec['table'], spec['table']),
                        'operator': item.get('operator', ''), 'kind': 'record_add', 'field': '新建记录',
                        'before': '', 'after': record_name(row, [spec.get('display_field') or '']) or row['record_id'],
                    })
                    continue
                for change in changes:
                    events.append({
                        'ts': item['create_time'], 'rev': item['rev'], 'table': labels.get(spec['table'], spec['table']),
                        'operator': item.get('operator', ''), 'kind': event_kind(change),
                        'field': change.get('field_name', ''), 'before': fmt(change.get('before'), idmap),
                        'after': fmt(change.get('after'), idmap),
                    })
    events.sort(key=lambda event: (event['ts'], event['rev']))
    if not events:
        raise RuntimeError('没有读到任何历史事件')
    first = events[0]['ts']
    for event in events:
        event['elapsed'] = event['ts'] - first
        event['clock'] = dt.datetime.fromtimestamp(event['ts']).strftime('%H:%M:%S')
    last = events[-1]
    tables = [spec['label'] for spec in config.get('tables', [])]
    phases = []
    try:
        inv = next(event for event in events if event['table'] == labels.get('inventoryLedger', '库存流水'))
        pay = next(event for event in events if event['table'] == labels.get('paymentRecord', 'S交易明细'))
        phases = [
            {'name': '① 销售建单', 'from': 0, 'to': inv['elapsed']},
            {'name': '② 库存出库', 'from': inv['elapsed'], 'to': pay['elapsed']},
            {'name': '③ 资金收款', 'from': pay['elapsed'], 'to': last['elapsed']},
        ]
    except StopIteration:
        phases = [{'name': '写入过程', 'from': 0, 'to': last['elapsed']}]
    kind_count = {}
    for event in events:
        kind_count[event['kind']] = kind_count.get(event['kind'], 0) + 1
    return {
        'meta': {
            'order': config['_order'], 'chain': config.get('chain', 'sales'),
            'date': dt.datetime.fromtimestamp(first).strftime('%Y-%m-%d'),
            'start': events[0]['clock'], 'end': last['clock'], 'total_sec': last['elapsed'],
            'table_count': len(tables), 'operators': sorted({event['operator'] for event in events if event['operator']}),
            'kind_count': kind_count, 'event_count': len(events),
        },
        'tables': tables, 'phases': phases, 'events': events, 'deletes': [],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='按配置生成标准 events.json')
    parser.add_argument('order', help='业务单号，如 XSD-20261018-0001')
    parser.add_argument('--config', default='sales', help='sales|purchase 或配置文件路径')
    parser.add_argument('--base-token', default=os.environ.get('FEISHU_V1_BITABLE_APP_TOKEN', ''))
    parser.add_argument('--out', type=Path)
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'output' / '.work')
    args = parser.parse_args(argv)
    if not args.base_token:
        print('error: 缺少 --base-token 或 FEISHU_V1_BITABLE_APP_TOKEN', file=sys.stderr)
        return 1
    config_path = Path(args.config)
    if not config_path.exists():
        config_path = ROOT / 'configs' / f'{args.config}.config.json'
    config = json.loads(config_path.read_text(encoding='utf-8'))
    config['_order'] = args.order
    try:
        records = {spec['table']: dump_records(args.base_token, spec['table'], args.work_dir)
                   for spec in config.get('tables', [])}
        selected = collect_targets(config, records)
        raw = build_raw(config, selected, args.base_token, args.work_dir)
        out = args.out or ROOT / 'output' / f'events-{args.order}.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(out)
        return 0
    except (OSError, RuntimeError, KeyError, json.JSONDecodeError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
