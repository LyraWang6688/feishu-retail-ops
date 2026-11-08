#!/usr/bin/env python3
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

from fetch_trace import resolve_table_id  # noqa: E402


class ResolveTableIdTest(unittest.TestCase):
    def test_env_takes_precedence_over_literal(self):
        spec = {'label': '销售主表', 'table_id_env': 'FEISHU_V1_SALES_ENTRY_TABLE_ID',
                'table_id': 'tblLITERAL'}
        with patch.dict(os.environ, {'FEISHU_V1_SALES_ENTRY_TABLE_ID': 'tblFROMENV'}):
            self.assertEqual(resolve_table_id(spec), 'tblFROMENV')

    def test_env_without_literal(self):
        spec = {'label': '实时库存', 'table_id_env': 'FEISHU_V1_LIVE_INVENTORY_TABLE_ID'}
        with patch.dict(os.environ, {'FEISHU_V1_LIVE_INVENTORY_TABLE_ID': 'tblENVONLY'}):
            self.assertEqual(resolve_table_id(spec), 'tblENVONLY')

    def test_falls_back_when_env_unset(self):
        spec = {'label': '销售明细', 'table_id_env': 'FEISHU_V1_SALES_DETAIL_TABLE_ID',
                'table_id': 'tblFALLBACK'}
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(resolve_table_id(spec), 'tblFALLBACK')

    def test_falls_back_when_env_empty(self):
        spec = {'label': '库存流水', 'table_id_env': 'FEISHU_V1_INVENTORY_LEDGER_TABLE_ID',
                'table_id': 'tblFALLBACK'}
        with patch.dict(os.environ, {'FEISHU_V1_INVENTORY_LEDGER_TABLE_ID': '   '}):
            self.assertEqual(resolve_table_id(spec), 'tblFALLBACK')

    def test_literal_when_no_env_configured(self):
        spec = {'label': '旧配置表', 'table_id': 'tblPLAIN'}
        self.assertEqual(resolve_table_id(spec), 'tblPLAIN')

    def test_raises_when_nothing_available(self):
        spec = {'label': '缺失表', 'table_id_env': 'FEISHU_V1_MISSING_TABLE_ID'}
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                resolve_table_id(spec)


if __name__ == '__main__':
    unittest.main()
