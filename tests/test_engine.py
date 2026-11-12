import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'checker/src'))
from engine import execute, InputError
from vendor.scripts import yomiyasu_diff

CASES = [
    ('これは、強固な土台です。', 'これは基盤です。'),
    ('# 手順\n\n> 3回だけ実行する\n\n```py\nx = 3\n```\n', '# 手順\n\n> 2回だけ実行する\n\n```py\nx = 2\n```\n'),
    ('失敗した場合だけ3回実行します。必ず通知するとは限りません。', '常に2回実行します。必ず通知します。'),
    ('変更はありません。', '変更はありません。'),
]


class EngineTests(unittest.TestCase):
    def test_matches_upstream_cli(self):
        for original, final in CASES:
            with self.subTest(original=original), tempfile.TemporaryDirectory() as tmp:
                old, new = Path(tmp) / 'old.md', Path(tmp) / 'new.md'
                old.write_text(original); new.write_text(final)
                result = execute({'action': 'check', 'original': original, 'final': final, 'doc_type': 'article'})
                for module, args, expected in [
                    ('yomiyasu_lint', [str(old)], result['original_lint']),
                    ('yomiyasu_lint', [str(new)], result['final_lint']),
                    ('yomiyasu_diff', [str(old), str(new)], result['diff']),
                ]:
                    command = [sys.executable, str(ROOT / f'checker/src/vendor/scripts/{module}.py'), '--json', '--no-words', '--doc-type', 'article', *args]
                    run = subprocess.run(command, capture_output=True, check=True, cwd=tmp)
                    actual = json.loads(run.stdout)
                    self.assertEqual(actual, expected)

    def test_materials(self):
        original, final = '設定を変更します。', '担当者は設定を3回変更します。'
        materials = ['担当者は設定を3回変更します。']
        result = execute({'action': 'check', 'original': original, 'final': final, 'materials': materials})
        self.assertEqual(result['ground'], yomiyasu_diff.ground(final, materials, original=original))
        self.assertEqual(result['diff'], yomiyasu_diff.diff(original, final, materials=materials))

    def test_validation(self):
        for data in [None, {}, {'action':'lint','text':3}, {'action':'lint','text':'あ' * 43691}, {'action':'lint','text':'a','reader':'unknown'}, {'action':'check','original':'a','final':'b','materials':'x'}, {'action':'lint','text':'\ud800'}, {'action':'lint','text':'a','unexpected':1}]:
            with self.subTest(data_type=type(data)):
                with self.assertRaises(InputError): execute(data)
        self.assertEqual(execute({'action':'lint','text':'a' * 131072})['status'], 'completed')

    def test_incomplete_diff_is_not_success(self):
        with patch.object(yomiyasu_diff, 'diff', return_value={'full_diff': {'limits_applied': ['budget']}}):
            with self.assertRaisesRegex(RuntimeError, 'inspection_incomplete'):
                execute({'action':'check', 'original':'原文', 'final':'本文'})

    def test_exact_hash_and_concurrency(self):
        def run(i):
            final = f'本文{i}\r\n'
            result = execute({'action':'check','original':f'原文{i}\n','final':final})
            return result['hashes']['final'], hashlib.sha256(final.encode()).hexdigest()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            for actual, expected in pool.map(run, range(8)):
                self.assertEqual(actual, expected)


if __name__ == '__main__': unittest.main()
