import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock

from easyread.library import Library
from easyread.server import Handler
from easyread.store import Workspace, write_json_atomic


class ServerTrashTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = Mock()
        self.app.lib = Library(Path(self.tmp.name) / 'library')
        self.app.token = 'test-token'
        self.old_app = getattr(Handler, 'app', None)
        Handler.app = self.app
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.ws = Workspace(self.app.lib.root / 'paper001')
        self.ws.root.mkdir()
        write_json_atomic(self.ws.paper_path, {'meta': {'title_en': 'Test <title>'}})

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        Handler.app = self.old_app
        self.tmp.cleanup()

    def request(self, method, path, body=None, token=True):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=4)
        conn.request(method, path, json.dumps(body) if body is not None else None, {'X-Token': 'test-token'} if token else {})
        response = conn.getresponse()
        code, data = response.status, json.loads(response.read())
        conn.close()
        return code, data

    def test_delete_restore_purge_and_auth(self):
        body = {'ids': [self.ws.id]}
        self.assertEqual(self.request('POST', '/api/trash/delete', body, token=False)[0], 403)
        self.assertIsNotNone(self.app.lib.ws(self.ws.id))
        code, response = self.request('POST', '/api/trash/delete', body)
        self.assertEqual(code, 200)
        tid = response['results'][0]['result']
        self.assertNotIn(str(self.app.lib.root), json.dumps(response))
        self.assertEqual(self.request('GET', '/api/trash')[1]['items'][0]['id'], tid)
        self.assertEqual(self.request('POST', '/api/trash/restore', {'ids': [tid]})[1]['results'][0]['result'], self.ws.id)
        tid = self.request('POST', '/api/p/' + self.ws.id + '/delete', {})[1]['trash']
        self.assertEqual(self.request('POST', '/api/trash/purge', {'ids': [tid]})[0], 400)
        self.assertTrue((self.app.lib.root / '.trash' / tid).exists())
        self.assertEqual(self.request('POST', '/api/trash/purge', {'ids': [tid], 'confirm': True})[1]['results'][0]['ok'], True)
        self.assertEqual(self.request('GET', '/api/trash')[1]['items'], [])
        self.app.jobs.cancel.assert_not_called()

    def test_partial_results_and_invalid_payload(self):
        write_json_atomic(self.ws.root / 'job.json', {'state': 'running'})
        code, data = self.request('POST', '/api/trash/delete', {'ids': [self.ws.id, '../outside']})
        self.assertEqual(code, 200)
        self.assertEqual([r['ok'] for r in data['results']], [False, False])
        self.app.jobs.cancel.assert_not_called()
        for body in [[], {'ids': []}, {'ids': 'paper001'}, {'ids': [None]}]:
            self.assertEqual(self.request('POST', '/api/trash/delete', body)[0], 400)
