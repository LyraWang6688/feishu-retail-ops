#!/usr/bin/env python3
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

from fetch_trace import build_phases, resolve_table_id  # noqa: E402


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


class BuildPhasesTest(unittest.TestCase):
    def _events(self):
        return [
            {'table_key': 'salesEntry', 'kind': 'record_add', 'field': '新建记录', 'elapsed': 0},
            {'table_key': 'salesEntry', 'kind': 'field_change', 'field': '销售状态', 'elapsed': 27},
            {'table_key': 'inventoryLedger', 'kind': 'record_add', 'field': '新建记录', 'elapsed': 61},
            {'table_key': 'paymentRecord', 'kind': 'record_add', 'field': '新建记录', 'elapsed': 112},
            {'table_key': 'salesEntry', 'kind': 'field_change', 'field': '资金状态', 'elapsed': 115},
        ]

    def test_stages_use_configured_table_boundaries(self):
        config = {'stages': [
            {'label': '① 建单', 'table': 'salesEntry'},
            {'label': '② 出库', 'table': 'inventoryLedger'},
            {'label': '③ 收款', 'table': 'paymentRecord'},
        ]}
        self.assertEqual(build_phases(config, self._events()), [
            {'name': '① 建单', 'from': 0, 'to': 61},
            {'name': '② 出库', 'from': 61, 'to': 112},
            {'name': '③ 收款', 'from': 112, 'to': 115},
        ])

    def test_stage_can_match_field_and_kind(self):
        config = {'stages': [
            {'label': '建单', 'table': 'salesEntry', 'kind': 'record_add'},
            {'label': '重试', 'table': 'salesEntry', 'field': '销售状态', 'kind': 'field_change'},
        ]}
        phases = build_phases(config, self._events())
        self.assertEqual([p['name'] for p in phases], ['建单', '重试'])

    def test_no_matching_stage_falls_back(self):
        config = {'stages': [{'label': '不存在', 'table': 'missing'}]}
        self.assertEqual(build_phases(config, self._events()), [
            {'name': '写入过程', 'from': 0, 'to': 115},
        ])
