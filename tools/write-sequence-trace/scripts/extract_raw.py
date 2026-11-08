#!/usr/bin/env python3
"""从旧版单文件 HTML 中提取 `const RAW = {...};`，转成标准 events.json。"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def extract(html: str) -> dict:
    match = re.search(r'const\s+RAW\s*=\s*(\{.*?\});\s*(?:\n|$)', html, re.S)
    if not match:
        raise ValueError('没有找到 const RAW = {...};')
    return json.loads(match.group(1))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='从旧版单文件 HTML 提取标准 events.json')
    parser.add_argument('html', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        raw = extract(args.html.read_text(encoding='utf-8'))
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(args.out)
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f'error: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
