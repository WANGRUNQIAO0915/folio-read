"""Privacy gating, exact disclosure and review-only API behavior (no network)."""
import copy
import http.client
import json
import tempfile
import threading
import unittest
import urllib.error
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from easyread import classification as C, config, organization as O
from easyread.library import Library
from easyread.server import Handler
from easyread.store import Workspace, empty_reader, write_json_atomic


class _Fixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.home = Path(self.tmp.name)
        self.lib = Library(self.home / 'library')
        self.ws = Workspace(self.lib.root / 'test-paper'); self.ws.root.mkdir()
        write_json_atomic(self.ws.paper_path, {'meta': {'source_sha256': 'b'*64, 'title_en': 'Title'*200, 'abstract_en': 'Abstract'*1000},
                                             'blocks': [{'id': 'b1', 'en': 'excerpt'*1000}]})
        write_json_atomic(self.ws.item_path, {'tags': ['old']})
        write_json_atomic(self.ws.reader_path, dict(empty_reader(), paper_note={'body': 'NEVER-SEND-NOTES'}))
        self.cfg = copy.deepcopy(config.DEFAULTS)
        self.cfg['openai'].update(base_url='https://api.example.test/v1', model='mock-model', api_key='NEVER-DISCLOSE-KEY')
        self.service = C.Classification(self.lib)
        self.org = O.Organization(self.lib)

    def tearDown(self):
        self.tmp.cleanup()

    def preview(self, **options):
        return self.service.preview({'paper_ids': [self.ws.id], **options}, self.cfg)

    def response(self, **changes):
        row = {'paper_id': self.ws.id, 'folder_id': None, 'folder_name': 'Suggested folder', 'tags': ['one'], 'reason': 'Title evidence'}
        row.update(changes)
        return json.dumps({'suggestions': [row]})

class ClassificationTest(_Fixture, unittest.TestCase):
    def test_preview_discloses_exact_bounded_payload_never_contacts_provider(self):
        with patch('easyread.classification.request') as send:
            preview = self.preview()
        send.assert_not_called()
        self.assertEqual(preview['endpoint'], 'https://api.example.test/v1/chat/completions')
        self.assertEqual(preview['model'], 'mock-model')
        self.assertEqual((len(preview['papers'][0]['title']), len(preview['papers'][0]['abstract']), len(preview['papers'][0]['excerpt'])), (300, 2000, 1000))
        serialized = json.dumps(preview)
        self.assertNotIn('NEVER-SEND-NOTES', serialized); self.assertNotIn('NEVER-DISCLOSE-KEY', serialized)
        self.assertIn('messages', preview)
        self.assertFalse(self.org.path.exists())

    def test_confirmation_required_and_send_is_once_review_only(self):
        preview = self.preview(); before = self.org.load()
        with patch('easyread.classification.request', return_value=self.response()) as send:
            for confirmed in (False, None, 'true', 1):
                with self.assertRaises(ValueError):
                    self.service.send(preview['id'], confirmed, self.cfg)
            send.assert_not_called()
            result = self.service.send(preview['id'], True, self.cfg)
            self.assertEqual(send.call_args.args[2], preview['messages'])
            self.assertEqual(self.service.send(preview['id'], True, self.cfg), result)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(before, self.org.load())
        self.assertEqual(result['suggestions'][0]['expected_version'], preview['papers'][0]['expected_version'])
        self.org.assign(result['suggestions'])
        self.assertEqual(self.lib.list()[0]['tags'], ['one'])

    def test_ai_tags_are_sparse_bounded_and_reuse_existing_names(self):
        self.org.assign([{'paper_id': self.ws.id, 'tags': ['Remote Sensing']}])
        preview = self.preview()
        self.assertFalse(preview['allow_new_folders'])
        self.assertIn('0–4', preview['messages'][0]['content'])
        self.assertIn('不要凑满', preview['messages'][0]['content'])
        self.assertIn('Remote Sensing', preview['existing_tags'])
        for given, expected in (([], []), (['one'], ['one']),
                                (['remote sensing', 'A', 'B', 'C', 'D', 'E'], ['Remote Sensing', 'A', 'B', 'C'])):
            rows = C._suggestions(self.response(tags=given), preview)
            self.assertEqual(rows[0]['tags'], expected)
        self.assertEqual(self.lib.list()[0]['tags'], ['Remote Sensing'])

    def test_new_folder_suggestions_are_opt_in_and_existing_names_reuse_ids(self):
        state = self.org.folder('Existing topic'); fid = next(iter(state['folders']))
        self.org.assign([{'paper_id': self.ws.id, 'folder_id': fid}])
        preview = self.preview()
        row = C._suggestions(self.response(), preview)[0]
        self.assertEqual((row['folder_id'], row['folder_name']), (fid, ''))
        row = C._suggestions(self.response(folder_name='existing TOPIC'), preview)[0]
        self.assertEqual((row['folder_id'], row['folder_name']), (fid, ''))
        row = C._suggestions(self.response(), self.preview(allow_new_folders=True))[0]
        self.assertEqual(row['folder_name'], 'Suggested folder')
        for value in ('true', 1):
            self.assertFalse(self.preview(allow_new_folders=value)['allow_new_folders'])
        self.assertEqual(len(self.org.load()['folders']), 1)

    def test_batch_can_suggest_only_one_new_topic(self):
        preview = self.preview(allow_new_folders=True)
        preview['papers'].append(dict(preview['papers'][0], paper_id='second'))
        first = json.loads(self.response())['suggestions'][0]
        second = dict(first, paper_id='second', folder_name='Another topic')
        with self.assertRaisesRegex(ValueError, '最多建议 1'):
            C._suggestions(json.dumps({'suggestions': [first, second]}), preview)
        second['folder_name'] = 'suggested FOLDER'
        self.assertEqual(len(C._suggestions(json.dumps({'suggestions': [first, second]}), preview)), 2)

    def test_config_change_endpoint_model_or_key_requires_new_preview(self):
        for field, value in (('base_url', 'https://changed.example/v1'), ('model', 'changed'), ('api_key', 'different')):
            preview = self.preview(); changed = copy.deepcopy(self.cfg); changed['openai'][field] = value
            with patch('easyread.classification.request') as send, self.assertRaisesRegex(ValueError, '配置已变化'):
                self.service.send(preview['id'], True, changed)
            send.assert_not_called()

    def test_cli_unknown_models_and_unsafe_urls_are_rejected(self):
        for engine in ('claude', 'codex'):
            cfg = dict(self.cfg, engine=engine)
            with self.assertRaisesRegex(ValueError, 'API'):
                self.service.preview({'paper_ids': [self.ws.id]}, cfg)
        with self.assertRaisesRegex(ValueError, '不存在'):
            self.service.preview({'paper_ids': [self.ws.id], 'model': 'unknown'}, self.cfg)
        for url in ('http://remote.example/v1', 'https://u:p@remote.example/v1', 'https://remote.example/v1?key=secret', 'https://remote.example/#secret'):
            cfg = copy.deepcopy(self.cfg); cfg['openai']['base_url'] = url
            with self.assertRaises(ValueError):
                self.service.preview({'paper_ids': [self.ws.id]}, cfg)

    def test_limits_missing_duplicate_expiry_and_removed_paper(self):
        for ids in ([], ['missing'], [self.ws.id]*2, [str(n) for n in range(21)], [{'bad': True}], [self.ws.id, 'b'*64]):
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.service.preview({'paper_ids': ids}, self.cfg)
        preview = self.preview(); self.service.previews[preview['id']]['created'] -= C.TTL_SECONDS
        with self.assertRaisesRegex(ValueError, '过期'):
            self.service.send(preview['id'], True, self.cfg)
        preview = self.preview(); self.ws.paper_path.unlink()
        with self.assertRaisesRegex(ValueError, '移除'):
            self.service.send(preview['id'], True, self.cfg)

    def test_cancel_before_send_and_cancel_inflight_discard_output(self):
        preview = self.preview(); self.service.cancel(preview['id'])
        with patch('easyread.classification.request') as send, self.assertRaises(ValueError):
            self.service.send(preview['id'], True, self.cfg)
        send.assert_not_called()
        preview = self.preview()
        def response(*args):
            self.service.cancel(preview['id'])
            return self.response()
        with patch('easyread.classification.request', side_effect=response):
            result = self.service.send(preview['id'], True, self.cfg)
        self.assertEqual(result, {'id': preview['id'], 'state': 'cancelled', 'suggestions': []})
        self.assertFalse(self.org.path.exists())

    def test_repeated_cancel_reopen_does_not_exhaust_preview_capacity(self):
        for _ in range(40):
            preview = self.preview()
            self.service.cancel(preview['id'])
        self.assertEqual(self.preview()['state'], 'preview')
        self.assertLess(len(self.service.previews), 3)

    def test_concurrent_duplicate_send_only_one_request(self):
        preview = self.preview(); entered = threading.Event(); release = threading.Event(); results = []
        def response(*args):
            entered.set(); release.wait(3); return self.response()
        with patch('easyread.classification.request', side_effect=response) as send:
            worker = threading.Thread(target=lambda: results.append(self.service.send(preview['id'], True, self.cfg)))
            worker.start(); self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ValueError, '已发送'):
                self.service.send(preview['id'], True, self.cfg)
            release.set(); worker.join(3)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(results[0]['state'], 'done')

    def test_malformed_response_unknown_ids_and_failures_never_mutate(self):
        bad = ['not json', '{}', '{"suggestions":[]}', self.response(paper_id='other'), self.response(folder_id='unknown', folder_name=''), self.response(tags=['x']*13), self.response(folder_name='x'*81)]
        for raw in bad:
            preview = self.preview()
            with patch('easyread.classification.request', return_value=raw) as send:
                with self.assertRaises(ValueError):
                    self.service.send(preview['id'], True, self.cfg)
                with self.assertRaises(ValueError):
                    self.service.send(preview['id'], True, self.cfg)
                self.assertEqual(send.call_count, 1)
            self.assertFalse(self.org.path.exists())
        preview = self.preview()
        with patch('easyread.classification.request', side_effect=ValueError('offline')):
            with self.assertRaisesRegex(ValueError, 'offline'):
                self.service.send(preview['id'], True, self.cfg)
        self.assertFalse(self.org.path.exists())

    def test_transport_no_redirect_no_retry_and_sanitized_error(self):
        api = {'model': 'model', 'api_key': 'secret'}; cancel = threading.Event()
        opener = Mock(); opener.open.side_effect = urllib.error.HTTPError('url', 401, 'bad secret', {}, None)
        with patch('easyread.classification.urllib.request.build_opener', return_value=opener):
            with self.assertRaisesRegex(ValueError, 'HTTP 401') as error:
                C.request(api, 'https://api.example.test/chat/completions', [{'role': 'user', 'content': 'disclosed'}], cancel)
        self.assertNotIn('secret', str(error.exception)); self.assertEqual(opener.open.call_count, 1)
        with self.assertRaisesRegex(ValueError, '重定向'):
            C._NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example')


class ClassificationServerTest(_Fixture, unittest.TestCase):
    # Keep API tests separate from direct service tests to avoid duplicated tests.
    def setUp(self):
        super().setUp()
        self.old_app = getattr(Handler, 'app', None)
        self.app = SimpleNamespace(lib=self.lib, token='token', classification=self.service, jobs=Mock(), scholar=Mock())
        self.app.jobs.small_status.return_value = []
        Handler.app = self.app
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.worker = threading.Thread(target=self.server.serve_forever, daemon=True); self.worker.start()
        self.cfg_patch = patch.object(config, 'load', return_value=self.cfg); self.cfg_patch.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.worker.join()
        Handler.app = self.old_app; self.cfg_patch.stop(); super().tearDown()

    def http(self, method, path, body=None, headers=None, raw=False):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=3)
        data = body if raw else json.dumps(body) if body is not None else None
        conn.request(method, path, data, headers or {'X-Token': 'token'})
        response = conn.getresponse(); status, data = response.status, json.loads(response.read()); conn.close()
        return status, data

    def test_http_token_origin_folder_and_classification_review_flow(self):
        self.assertEqual(self.http('POST', '/api/organization/folder', {'name': 'Blocked'}, {'X-Token': 'bad'})[0], 403)
        self.assertEqual(self.http('GET', '/api/organization', headers={'Origin': 'https://foreign.example'})[0], 403)
        code, state = self.http('POST', '/api/organization/folder', {'name': 'Folder'})
        self.assertEqual(code, 200); fid = next(iter(state['folders']))
        self.assertEqual(self.http('POST', '/api/organization/assign', {'assignments': [{'paper_id': self.ws.id, 'folder_id': fid, 'tags': ['test']} ]})[0], 200)
        library = self.http('GET', '/api/library')[1]
        self.assertEqual(library['items'][0]['folder_id'], fid); self.assertIn(fid, library['organization']['folders'])
        code, preview = self.http('POST', '/api/classification/preview', {'paper_ids': [self.ws.id]})
        self.assertEqual(code, 200)
        with patch('easyread.classification.request', return_value=self.response()) as send:
            self.assertEqual(self.http('POST', '/api/classification/send', {'id': preview['id'], 'confirmed': False})[0], 400)
            send.assert_not_called()
            code, result = self.http('POST', '/api/classification/send', {'id': preview['id'], 'confirmed': True})
            self.assertEqual(code, 200)
        self.assertEqual(self.lib.list()[0]['tags'], ['test'])
        self.assertEqual(self.http('POST', '/api/organization/assign', {'assignments': result['suggestions']})[0], 200)
        self.assertEqual(self.lib.list()[0]['tags'], ['one'])
        self.assertEqual(self.http('POST', '/api/organization/folder-delete', {'id': fid})[0], 200)
        self.assertTrue(self.ws.paper_path.exists())

    def test_http_import_target_validation_and_duplicate_preserves_assignment(self):
        initial = len(self.lib.all())
        self.assertEqual(self.http('POST', '/api/import?folder_id=missing', b'%PDF-1.7 file', raw=True)[0], 400)
        self.assertEqual(len(self.lib.all()), initial)
        _, state = self.http('POST', '/api/organization/folder', {'name': 'Import folder'}); fid = next(iter(state['folders']))
        _, data = self.http('POST', '/api/import?translate=0&folder_id='+fid, b'%PDF-1.7 unique fixture', raw=True)
        self.assertTrue(data['new'])
        self.assertEqual(next(x for x in self.lib.list() if x['id'] == data['id'])['folder_id'], fid)
        _, duplicate = self.http('POST', '/api/import?translate=0', b'%PDF-1.7 unique fixture', raw=True)
        self.assertFalse(duplicate['new'])
        self.assertEqual(next(x for x in self.lib.list() if x['id'] == data['id'])['folder_id'], fid)


if __name__ == '__main__':
    unittest.main()
