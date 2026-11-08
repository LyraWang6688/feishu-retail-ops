#!/usr/bin/env python3
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))

from build_html import load_raw, render  # noqa: E402
from extract_raw import extract  # noqa: E402


class BuildHtmlTest(unittest.TestCase):
    def setUp(self):
        self.template = (ROOT / 'templates' / 'trace.html.tmpl').read_text(encoding='utf-8')
        self.raw = load_raw(ROOT / 'examples' / 'events-XSD-20261018-0001.json')

    def test_renders_standard_schema(self):
        html = render(self.template, self.raw)
        self.assertNotIn('{{RAW_JSON}}', html)
        self.assertIn('const KIND=', html)
        match = re.search(r'const RAW = (\{.*?\});\n', html, re.S)
        self.assertIsNotNone(match)
        self.assertEqual(json.loads(match.group(1))['meta']['order'], 'XSD-20261018-0001')

    def test_escapes_script_close(self):
        raw = json.loads(json.dumps(self.raw))
        raw['events'][0]['after'] = '</script><script>alert(1)</script>'
        html = render(self.template, raw)
        self.assertNotIn('</script><script>alert(1)</script>', html)

    def test_extract_roundtrip(self):
        html = (ROOT / 'examples' / 'sales-XSD-20261018-0001.html').read_text(encoding='utf-8')
        data = extract(html)
        self.assertEqual(data['meta']['order'], 'XSD-20261018-0001')
        self.assertEqual(len(data['events']), 17)


if __name__ == '__main__':
    unittest.main()
