"""Offline real-server fixture for classification browser regressions."""
from __future__ import annotations

import json
from pathlib import Path
import sys

from browser_support import fixture, serve

if __name__ == '__main__':
    if sys.argv[1] == 'fixture':
        fixture(Path(sys.argv[2]))
    else:
        from easyread import classification
        calls = Path(sys.argv[3])

        def mocked_request(api, endpoint, messages, cancel):
            with calls.open('a', encoding='utf-8') as log:
                log.write(json.dumps({'endpoint': endpoint, 'messages': messages}) + '\n')
            payload = json.loads(messages[0]['content'].split('\n\n', 1)[1])
            return json.dumps({'suggestions': [
                {'paper_id': paper['paper_id'], 'folder_id': None,
                 'folder_name': 'AI 推荐资料', 'tags': ['城市热环境', 'GIS'], 'reason': '测试建议，请复核'}
                for paper in payload['papers']
            ]}, ensure_ascii=False)

        classification.request = mocked_request
        serve(Path(sys.argv[2]))
