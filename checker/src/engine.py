"""Workers adapter. The upstream algorithms remain byte-for-byte unchanged."""
import hashlib
import sys
from pathlib import Path

from vendor.scripts import yomiyasu_lint as lint_module
from vendor.scripts import yomiyasu_diff as diff_module
from vendor.scripts.markdown_visibility import DOC_TYPES, READER_LEVELS
from vendor_data import REFERENCES, UPSTREAM

# Only public rule data is materialized. User manuscripts never enter the filesystem.
# Run this at request time: Python Workers snapshots do not preserve startup FS writes.
_DATA = Path('/tmp/yomiyasu-rules')


def prepare_rules():
    for name, text in REFERENCES.items():
        path = _DATA / name
        if not path.is_file():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
    (_DATA / 'scripts').mkdir(exist_ok=True)
    lint_module.__file__ = str(_DATA / 'scripts/yomiyasu_lint.py')
    diff_module.__file__ = str(_DATA / 'scripts/yomiyasu_diff.py')
    sys.modules['yomiyasu_lint'] = lint_module
    # The snapshot may have warmed builtin caches before the virtual files existed.
    diff_module._LIST_CACHE.clear()
    diff_module._LIST_PROBLEMS.clear()
    lint_module._V220_LIST_CACHE.clear()
    lint_module._V220_LIST_PROBLEMS.clear()
    # Missing or malformed rule lists must fail instead of silently using builtin data.
    for name in diff_module.BUILTIN_LISTS:
        _, source = diff_module._load_list(name)
        if source == 'builtin' or diff_module._LIST_PROBLEMS.get(name):
            raise RuntimeError('rule_data_unavailable')
    for name in lint_module._V220_BUILTIN_LISTS:
        _, source = lint_module._v220_load_list(name)
        if source == 'builtin' or lint_module._V220_LIST_PROBLEMS.get(name):
            raise RuntimeError('rule_data_unavailable')


LIMIT = 128 * 1024
DOC_VALUES = {row[0] for row in DOC_TYPES}
READER_VALUES = {row[0] for row in READER_LEVELS}


class InputError(ValueError):
    pass


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def execute(data):
    if not isinstance(data, dict):
        raise InputError('Expected an object')
    action = data.get('action')
    allowed = {'action', 'text', 'doc_type', 'reader'} if action == 'lint' else {'action', 'original', 'final', 'materials', 'doc_type', 'reader', 'stance'}
    if action not in ('lint', 'check') or set(data) - allowed:
        raise InputError('Invalid action or field')
    for key, choices in [('doc_type', DOC_VALUES), ('reader', READER_VALUES), ('stance', {'勧め', '決まり', '説明'})]:
        if key in data and data[key] not in choices:
            raise InputError('Invalid inspection option')
    fields = ['text'] if action == 'lint' else ['original', 'final']
    texts = [data.get(key) for key in fields]
    materials = data.get('materials', [])
    if not isinstance(materials, list) or len(materials) > 16:
        raise InputError('Invalid materials')
    texts += materials
    if any(not isinstance(text, str) for text in texts):
        raise InputError('Text inputs must be strings')
    try:
        size = sum(len(text.encode('utf-8')) for text in texts)
    except UnicodeEncodeError:
        raise InputError('Invalid Unicode') from None
    if size > LIMIT:
        raise InputError('Text exceeds 128 KiB')
    prepare_rules()
    context = {key: data.get(key) for key in ('doc_type', 'reader')}
    if action == 'lint':
        return {'status': 'completed', 'upstream': UPSTREAM, 'lint': lint_module.lint_text(data['text'], **context)}
    original, final = data['original'], data['final']
    # No newline/BOM normalization: the receipt covers the exact submitted UTF-8 text.
    result = {
        'status': 'completed', 'upstream': UPSTREAM,
        'original_lint': lint_module.lint_text(original, **context),
        'final_lint': lint_module.lint_text(final, **context),
        'diff': diff_module.diff(original, final, stance=data.get('stance'), materials=materials, **context),
        'ground': diff_module.ground(final, materials, original=original) if materials else None,
        'hashes': {'original': digest(original), 'final': digest(final), 'materials': [digest(x) for x in materials]},
    }
    if result['diff']['full_diff'].get('limits_applied'):
        raise RuntimeError('inspection_incomplete')
    return result
