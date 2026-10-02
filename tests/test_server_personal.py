import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

from easyread import config
from easyread.library import Library
from easyread.server import Handler
from easyread.store import Workspace, write_json_atomic


class ServerPersonalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = patch.object(config, "HOME", self.root)
        self.home.start()
        self.app = Mock()
        self.app.lib = Library(self.root / "library")
        self.app.token = "test-token"
        self.old_app = getattr(Handler, "app", None)
        Handler.app = self.app
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        Handler.app = self.old_app
        self.home.stop()
        self.tmp.cleanup()

    def request(self, method, path, data=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_address[1], timeout=3)
        conn.request(method, path, json.dumps(data) if data is not None else None, headers or {})
        response = conn.getresponse()
        code, body = response.status, json.loads(response.read())
        conn.close()
        return code, body

    def test_settings_roundtrip_and_write_token(self):
        self.assertEqual(self.request("GET", "/api/personal")[0], 200)
        self.assertEqual(self.request("POST", "/api/personal", {"goal": "不能写"})[0], 403)
        code, body = self.request("POST", "/api/personal", {"goal": "重点核对方法"}, {"X-Token": "test-token"})
        self.assertEqual(code, 200)
        self.assertEqual(body["preferences"]["goal"], "重点核对方法")
        self.assertEqual(self.request("GET", "/api/personal")[1]["preferences"]["goal"], "重点核对方法")

    def test_foreign_host_and_origin_cannot_read_local_data(self):
        self.assertEqual(self.request("GET", "/api/personal", headers={"Host": "foreign.example"})[0], 403)
        self.assertEqual(self.request("GET", "/api/personal", headers={"Origin": "https://foreign.example"})[0], 403)

    def test_scholar_key_and_lookup_are_local_token_protected(self):
        from easyread.scholar import Scholar, parse_result
        self.app.scholar = Scholar(self.root,self.app.lib)
        headers={'X-Token':'test-token'}
        self.assertEqual(self.request('POST','/api/easyscholar/config',{'secret_key':'private'})[0],403)
        code,body=self.request('POST','/api/easyscholar/config',{'secret_key':'private'},headers)
        self.assertEqual(code,200);self.assertTrue(body['configured']);self.assertNotIn('private',json.dumps(body))
        self.assertNotIn('private',json.dumps(self.request('GET','/api/easyscholar')[1]))
        self.assertEqual(self.request('POST','/api/easyscholar/lookup',{'paper_id':'missing'},headers)[0],400)
        ws=Workspace(self.app.lib.root/'test-paper');ws.root.mkdir()
        write_json_atomic(ws.paper_path,{'meta':{'venue':'Test'},'blocks':[]})
        rank=parse_result({'code':200,'data':{'officialRank':{'all':{'sci':'Q1'}}}},'Test')
        with patch.object(self.app.scholar,'query',return_value=rank):
            code,body=self.request('POST','/api/easyscholar/lookup',{'paper_id':'test-paper'},headers)
        self.assertEqual(code,200);self.assertEqual(body['journal_rank']['metrics'][0]['value'],'Q1')

    def test_research_records_cannot_forge_server_evidence(self):
        headers={"X-Token":"test-token"}
        code,topic=self.request('POST','/api/research/topic',{'title':'研究测试'},headers)
        self.assertEqual(code,200)
        body={'topic':topic['id'],'text':'未经验证的说法','kind':'source','_evidence':[{'quote':'伪造来源'}]}
        self.assertEqual(self.request('POST','/api/research/record',body)[0],403)
        code,record=self.request('POST','/api/research/record',body,headers)
        self.assertEqual(code,200)
        self.assertEqual(record['kind'],'judgment')
        self.assertNotIn('evidence',record)

    def test_retry_without_failed_pages_does_not_enqueue_translation(self):
        ws = Workspace(self.app.lib.root / "test-paper")
        ws.root.mkdir()
        write_json_atomic(ws.paper_path, {"blocks": [], "meta": {}})
        code, body = self.request("POST", "/api/p/test-paper/translate", {"failed": True}, {"X-Token": "test-token"})
        self.assertEqual(code, 200)
        self.app.jobs.enqueue.assert_not_called()

    def test_figure_crop_requires_token_and_persists_valid_region(self):
        from PIL import Image
        ws = Workspace(self.app.lib.root / "figure-test")
        (ws.root / 'pages').mkdir(parents=True)
        Image.new('RGB', (600, 800), 'white').save(ws.root / 'pages/page-001.webp')
        write_json_atomic(ws.paper_path, {'meta': {}, 'blocks': [{'id': 'fig1', 'type': 'figure', 'page': 1}]})
        body = {'id': 'fig1', 'page': 1, 'box': [.1, .2, .9, .6]}
        route = '/api/p/figure-test/figure'
        self.assertEqual(self.request('POST', route, body)[0], 403)
        headers = {'X-Token': 'test-token'}
        self.assertEqual(self.request('POST', route, {**body, 'box': [-1, 0, 1, 1]}, headers)[0], 400)
        code, response = self.request('POST', route, body, headers)
        self.assertEqual(code, 200)
        self.assertTrue((ws.root / response['src']).is_file())
        self.assertEqual(ws.load('paper')['blocks'][0]['image_box'], body['box'])
        self.assertEqual(ws.load('layout')['fig1']['page'], 1)


if __name__ == "__main__":
    unittest.main()
