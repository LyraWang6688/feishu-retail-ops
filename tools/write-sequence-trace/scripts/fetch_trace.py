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


def resolve_table_id(spec: dict) -> str:
    """解析表 ID：优先 table_id_env 指向的环境变量，回退配置里的字面 table_id。

    本机 .env 指向测试 Base 时自动跟随测试表 ID；环境变量为空才用字面量离线兜底，
    两者都缺则报错，避免脚本写死生产 ID 在换 Base 后静默取错表。
    """
    env_name = spec.get('table_id_env')
    if env_name:
        env_value = os.environ.get(env_name, '').strip()
        if env_value:
            return env_value
    literal = str(spec.get('table_id') or '').strip()
    if literal:
        return literal
    label = spec.get('label') or spec.get('table') or '?'
    raise RuntimeError(
        f"表 {label} 无法解析表 ID：环境变量 {env_name or '（未配置 table_id_env）'} 为空，且未提供 table_id"
    )


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


def spec_field_names(spec: dict) -> list[str]:
    """配置里的字段白名单：兼容字符串和 {name,label} 两种写法。"""
    names = []
    for field in spec.get('fields') or []:
        if isinstance(field, str):
            names.append(field)
        elif isinstance(field, dict) and field.get('name'):
            names.append(str(field['name']))
    return names


def event_matches(stage: dict, event: dict) -> bool:
    """判断一个事件是不是某个阶段的起点。

    支持 table（配置 key）/ field / kind / event 四种条件；未写的条件不限制。
    """
    if stage.get('table') and event.get('table_key') != stage['table']:
        return False
    if stage.get('field') and event.get('field') != stage['field']:
        return False
    if stage.get('kind') and event.get('kind') != stage['kind']:
        return False
    wanted_event = stage.get('event')
    if wanted_event == 'record_add' and event.get('kind') != 'record_add':
        return False
    return True


def build_phases(config: dict, events: list[dict]) -> list[dict]:
    """按配置的 stages 找每个阶段的起点；终点 = 下一个阶段起点。"""
    stages = config.get('stages') or []
    starts = []
    for stage in stages:
        index = next((i for i, event in enumerate(events) if event_matches(stage, event)), None)
        if index is not None:
            starts.append((stage, index))
    if not starts:
        return [{'name': '写入过程', 'from': 0, 'to': events[-1]['elapsed']}]
    phases = []
    for pos, (stage, index) in enumerate(starts):
        start = 0 if pos == 0 else events[index]['elapsed']
        end = events[starts[pos + 1][1]]['elapsed'] if pos + 1 < len(starts) else events[-1]['elapsed']
        if end < start:
            end = events[-1]['elapsed']
        phases.append({'name': stage.get('label') or stage.get('key') or '阶段', 'from': start, 'to': end})
    return phases


def collect_targets(config: dict, records: dict[str, list[dict]]) -> dict[str, list[dict]]:
    specs = config.get('tables', [])
    start_spec = next((spec for spec in specs if spec.get('role') == 'start'), None)
    if not start_spec:
        raise RuntimeError('配置缺少 role=start 的起点表')
    start = config['start']
    start_rows = records[start['table']]
    start_row = next((row for row in start_rows if row.get(start['order_field']) == config['_order']), None)
    if not start_row:
        raise RuntimeError(f"未找到 {start['order_field']}={config['_order']}")
    selected = {start_spec['key']: [start_row]}
    # 按配置顺序逐层扩展；link 字段在子表上，指向父表 record_id。
    for spec in specs:
        if spec.get('role') != 'linked':
            continue
        parent = spec.get('from')
        if not parent or parent not in selected:
            continue
        parent_ids = {row.get('record_id') for row in selected[parent]}
        rows = [row for row in records[spec['table']]
                if parent_ids & set(links(row.get(spec.get('link_field', ''))))]
        selected[spec['key']] = rows
    return selected


def build_raw(config: dict, selected: dict[str, list[dict]], base: str, work_dir: Path) -> dict:
    specs = config.get('tables', [])
    labels = {spec['key']: spec['label'] for spec in specs}
    keys = {spec['key']: spec['key'] for spec in specs}
    idmap = {}
    # 配置 fields 时按白名单采集；未配置则保留全部字段（向后兼容）。
    configured = {spec['key']: spec_field_names(spec) for spec in specs}
    for spec in specs:
        fields = configured.get(spec['key']) or []
        fields += [spec.get('display_field'), '销售单号', '销售明细ID', '采购单号', '库存键', '交易明细ID']
        for row in selected.get(spec['key'], []):
            idmap[row.get('record_id')] = record_name(row, [f for f in fields if f])
    events = []
    for spec in specs:
        allowed = set(configured.get(spec['key']) or [])
        for row in selected.get(spec['key'], []):
            for item in history(base, resolve_table_id(spec), row['record_id']):
                changes = item.get('field_changes') or []
                if not changes:
                    events.append({
                        'ts': item['create_time'], 'rev': item['rev'], 'table': labels.get(spec['key'], spec['table']), 'table_key': spec['key'],
                        'operator': item.get('operator', ''), 'kind': 'record_add', 'field': '新建记录',
                        'before': '', 'after': record_name(row, [spec.get('display_field') or '', '销售明细ID', '交易明细ID', '库存键', '销售单号']) or row['record_id'],
                    })
                    continue
                for change in changes:
                    field_name = change.get('field_name', '')
                    if allowed and field_name not in allowed:
                        continue
                    events.append({
                        'ts': item['create_time'], 'rev': item['rev'], 'table': labels.get(spec['key'], spec['table']), 'table_key': spec['key'],
                        'operator': item.get('operator', ''), 'kind': event_kind(change),
                        'field': field_name, 'before': fmt(change.get('before'), idmap),
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
    phases = build_phases(config, events)
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
    parser.add_argument('order', nargs='?', help='业务单号，如 XSD-20261018-0001')
    parser.add_argument('--order', dest='order_option', help='业务单号（与位置参数二选一）')
    parser.add_argument('--config', default='sales', help='sales|purchase 或配置文件路径')
    parser.add_argument('--base-token', default=os.environ.get('FEISHU_V1_BITABLE_APP_TOKEN', ''))
    parser.add_argument('--out', type=Path)
    parser.add_argument('--work-dir', type=Path, default=ROOT / 'output' / '.work')
    args = parser.parse_args(argv)
    order = args.order or args.order_option
    if not order:
        print('error: 缺少业务单号（位置参数或 --order）', file=sys.stderr)
        return 1
    if not args.base_token:
        print('error: 缺少 --base-token 或 FEISHU_V1_BITABLE_APP_TOKEN', file=sys.stderr)
        return 1
    config_path = Path(args.config)
    if not config_path.exists():
        config_path = ROOT / 'configs' / f'{args.config}.config.json'
    config = json.loads(config_path.read_text(encoding='utf-8'))
    config['_order'] = order
    try:
        print('TRACE_TABLES', {spec['label']: resolve_table_id(spec)
                               for spec in config.get('tables', [])}, file=sys.stderr)
        records = {spec['table']: dump_records(args.base_token, resolve_table_id(spec), args.work_dir)
                   for spec in config.get('tables', [])}
        selected = collect_targets(config, records)
        print('TRACE_SELECTED', {k: len(v) for k, v in selected.items()}, file=sys.stderr)
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
