"""Naming/privacy, portable parity and original-PDF download tests, no model network."""
import copy
import hashlib
import http.client
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import unquote
from unittest.mock import Mock, patch

from easyread import classification, config, naming as N, portable as P
from easyread.drive import Drive
from easyread.library import Library
from easyread.server import Handler
from easyread.store import Workspace, empty_reader, write_json_atomic


class Fixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.home = Path(self.tmp.name)
        self.lib = Library(self.home / 'library'); self.ws = self.make_paper('test-paper', 'a')
        self.service = N.Naming(self.lib)
        self.cfg = copy.deepcopy(config.DEFAULTS)
        self.cfg['openai'].update(base_url='https://api.example.test/v1', model='mock', api_key='SECRET-KEY')

    def tearDown(self):
        self.tmp.cleanup()

    def make_paper(self, pid, digest='b'):
        ws = Workspace(self.lib.root / pid); ws.root.mkdir()
        write_json_atomic(ws.paper_path, {'meta': {'title_en': 'Original scholarly title', 'source': '1-s2.0-original.pdf',
                          'source_sha256': digest*64, 'abstract_en': 'DO-NOT-SEND-ABSTRACT'},
                          'blocks': [{'id': 'p1', 'en': 'DO-NOT-SEND-BODY', 'zh': '已有中文译文', 'page': 1}]})
        write_json_atomic(ws.item_path, {'status': 'reading', 'starred': True})
        write_json_atomic(ws.reader_path, dict(empty_reader(), paper_note={'body': 'DO-NOT-SEND-NOTES'}))
        write_json_atomic(ws.discussion_path, {'entries': []})
        import pypdf
        writer = pypdf.PdfWriter(); writer.add_blank_page(width=100, height=100)
        with (ws.root / 'source.pdf').open('wb') as stream:
            writer.write(stream)
        return ws

    def suggest(self, ws=None):
        return self.service.suggest({'paper_ids': [(ws or self.ws).id]})['suggestions'][0]

    def apply_name(self, value='中文名称', ws=None):
        row = self.suggest(ws); row.update(title=value, source='manual')
        return self.service.apply([row])

    def preview(self):
        return self.service.preview({'paper_ids': [self.ws.id]}, self.cfg)

    def response(self, **changes):
        return json.dumps({'suggestions': [dict(paper_id=self.ws.id, title='人工智能研究', **changes)]})


class NamingTest(Fixture, unittest.TestCase):
    def test_local_suggest_and_summary_never_send_or_mutate(self):
        before = {p: p.read_bytes() for p in self.ws.root.iterdir() if p.is_file()}
        with patch('easyread.classification.request') as send:
            row = self.suggest(); summary = self.lib.list()[0]
        send.assert_not_called()
        self.assertEqual(row['source'], 'bibliographic_metadata')
        self.assertEqual(row['original_title'], 'Original scholarly title')
        self.assertEqual(row['original_filename'], '1-s2.0-original.pdf')
        self.assertEqual(row['expected_version'], '')
        self.assertIsNone(summary['naming']); self.assertEqual(summary['display_title'], 'Original scholarly title')
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_existing_chinese_priority_and_preserved_provenance(self):
        self.ws.update('paper', lambda p: p['meta'].update(title_zh='已有中文标题'))
        self.assertEqual(self.suggest()['source'], 'existing_chinese')
        result = self.apply_name('审阅名称')
        row = result['suggestions'][0]; item = self.ws.load('item')
        self.assertEqual(item['naming']['title'], '审阅名称'); self.assertEqual(item['naming']['source'], 'manual')
        self.assertEqual(item['naming']['original_title'], 'Original scholarly title')
        self.assertEqual(result['items'][0]['display_title'], '审阅名称')
        self.ws.update('paper', lambda p: p['meta'].update(title_en='New metadata enrichment'))
        self.assertEqual(self.suggest()['original_title'], 'Original scholarly title')
        self.assertEqual(self.suggest()['source'], 'manual')
        self.assertEqual(self.suggest()['expected_version'], row['expected_version'])

    def test_apply_only_item_naming_and_keeps_status_and_bytes(self):
        before = {p.name: p.read_bytes() for p in self.ws.root.iterdir() if p.is_file()}
        self.apply_name('证据整理.pdf.PDF')
        for name, raw in before.items():
            if name != 'item.json':
                self.assertEqual((self.ws.root / name).read_bytes(), raw)
        item = self.ws.load('item'); self.assertEqual(item['naming']['title'], '证据整理')
        del item['naming']; self.assertEqual(item, json.loads(before['item.json']))

    def test_pdf_metadata_first_page_title_fallback_and_section_filter(self):
        self.ws.update('paper', lambda p: p['meta'].update(title_en='1-s2.0-original'))
        with patch('easyread.library._pdf_title', return_value='有效的 PDF 元数据标题'):
            self.assertEqual(self.suggest()['source'], 'pdf_metadata')
        self.ws.update('paper', lambda p: p['blocks'].insert(0, {'id': 'title', 'role': 'title', 'type': 'heading', 'level': 1, 'page': 1, 'en': 'Recovered page title'}))
        with patch('easyread.library._pdf_title', return_value=''):
            self.assertEqual(self.suggest()['source'], 'first_page_title')
        self.ws.update('paper', lambda p: p.update(blocks=[{'id': 'title', 'type': 'heading', 'level': 1, 'page': 1, 'zh': '方法'}]))
        with patch('easyread.library._pdf_title', return_value=''):
            self.assertEqual(self.suggest()['source'], 'filename')
        extract = self.ws.root / 'extract'; extract.mkdir()
        (extract / 'page-001.txt').write_text('Abstract\n123\n', encoding='utf-8')
        self.assertEqual(N._first_page(self.ws, self.ws.load('paper'))[0], '')

    def test_batch_validation_and_stale_apply_leave_all_rows_unchanged(self):
        second = self.make_paper('other-paper')
        rows = self.service.suggest({'paper_ids': [self.ws.id, second.id]})['suggestions']
        before = [self.ws.item_path.read_bytes(), second.item_path.read_bytes()]
        for invalid in ('', 'x'*201, 123):
            candidate = copy.deepcopy(rows); candidate[1]['title'] = invalid
            with self.assertRaises(ValueError):
                self.service.apply(candidate)
            self.assertEqual([self.ws.item_path.read_bytes(), second.item_path.read_bytes()], before)
        rows[1]['expected_version'] = 'stale'
        with self.assertRaisesRegex(ValueError, '另一处更新'):
            self.service.apply(rows)
        self.assertEqual([self.ws.item_path.read_bytes(), second.item_path.read_bytes()], before)
        for invalid_rows in ([], [None], [self.suggest(), self.suggest()], [{'paper_id': 'missing'}]):
            with self.assertRaises(ValueError):
                self.service.apply(invalid_rows)

    def test_concurrent_reviews_exactly_one_applies_and_unrelated_item_patch_survives(self):
        row = self.suggest(); barrier = threading.Barrier(3); results = []
        def work(label):
            barrier.wait()
            try:
                results.append(self.service.apply([dict(row, title=label, source='manual')]))
            except ValueError as error:
                results.append(error)
        a = threading.Thread(target=work, args=('版本甲',)); b = threading.Thread(target=work, args=('版本乙',))
        a.start(); b.start(); barrier.wait(); a.join(5); b.join(5)
        self.assertEqual(sum(isinstance(x, dict) for x in results), 1)
        self.assertEqual(sum(isinstance(x, ValueError) for x in results), 1)
        self.ws.patch_item({'starred': False})
        self.assertIn(self.ws.load('item')['naming']['title'], ('版本甲', '版本乙'))
        self.assertFalse(self.ws.load('item')['starred'])

    def test_io_failure_rolls_back_batch(self):
        second = self.make_paper('other-paper')
        rows = self.service.suggest({'paper_ids': [self.ws.id, second.id]})['suggestions']
        before = [self.ws.load('item'), second.load('item')]; counter = [0]
        def fail_once(path, data):
            counter[0] += 1
            if counter[0] == 2:
                raise OSError('simulated full disk')
            write_json_atomic(path, data)
        with patch('easyread.naming.write_json_atomic', side_effect=fail_once), self.assertRaises(OSError):
            self.service.apply(rows)
        self.assertEqual([self.ws.load('item'), second.load('item')], before)

    def test_preview_minimal_exact_frozen_payload_and_explicit_confirmation(self):
        with patch('easyread.classification.request') as send:
            preview = self.preview()
        send.assert_not_called()
        payload = json.dumps(preview)
        for secret in ('DO-NOT-SEND-ABSTRACT', 'DO-NOT-SEND-BODY', 'DO-NOT-SEND-NOTES', 'SECRET-KEY'):
            self.assertNotIn(secret, payload)
        preview['messages'][0]['content'] = 'changed outside preview'
        with patch('easyread.classification.request', return_value=self.response()) as send:
            for confirmed in (False, None, 'true', 1):
                with self.assertRaises(ValueError):
                    self.service.send(preview['id'], confirmed, self.cfg)
            send.assert_not_called()
            result = self.service.send(preview['id'], True, self.cfg)
            self.assertNotEqual(send.call_args.args[2], preview['messages'])
            self.assertEqual(self.service.send(preview['id'], True, self.cfg), result)
            self.assertEqual(send.call_count, 1)
        self.assertEqual(result['suggestions'][0]['source'], 'ai_translation')
        self.assertNotIn('confidence', result['suggestions'][0]); self.assertNotIn('naming', self.ws.load('item'))

    def test_preview_fallback_sends_only_bounded_first_page_excerpt(self):
        self.ws.update('paper', lambda p: p['meta'].update(title_en='1-s2.0-original'))
        extract = self.ws.root / 'extract'; extract.mkdir()
        (extract / 'page-001.txt').write_text('123\n'*900, encoding='utf-8')
        with patch('easyread.library._pdf_title', return_value=''):
            preview = self.preview()
        self.assertLessEqual(len(preview['papers'][0]['excerpt']), 1000)
        self.assertEqual(preview['papers'][0]['input_title'], '')
        self.assertNotIn('DO-NOT-SEND-BODY', preview['messages'][0]['content'])

    def test_send_config_change_cancel_failure_no_auto_retry(self):
        for field in ('base_url', 'model', 'api_key'):
            preview = self.preview(); changed = copy.deepcopy(self.cfg)
            changed['openai'][field] = 'https://new.example/v1' if field == 'base_url' else 'changed'
            with patch('easyread.classification.request') as send, self.assertRaisesRegex(ValueError, '配置已变化'):
                self.service.send(preview['id'], True, changed)
            send.assert_not_called()
        preview = self.preview(); self.service.cancel(preview['id'])
        with self.assertRaises(ValueError):
            self.service.send(preview['id'], True, self.cfg)
        preview = self.preview()
        def response(*args):
            self.service.cancel(preview['id']); return self.response()
        with patch('easyread.classification.request', side_effect=response):
            self.assertEqual(self.service.send(preview['id'], True, self.cfg)['state'], 'cancelled')
        for raw in ('no json', '{}', '{"suggestions":[]}', '{"suggestions":[{"paper_id":"unknown","title":"未知标题"}]}',
                    '{"suggestions":[{"paper_id":"test-paper","title":"English only"}]}'):
            preview = self.preview()
            with patch('easyread.classification.request', return_value=raw) as send:
                for _ in range(2):
                    with self.assertRaises(ValueError):
                        self.service.send(preview['id'], True, self.cfg)
                self.assertEqual(send.call_count, 1)
        self.assertNotIn('naming', self.ws.load('item'))

    def test_expired_removed_duplicate_and_parallel_send(self):
        for ids in ([], ['missing'], [self.ws.id]*2, [self.ws.id, 'a'*64], [str(i) for i in range(21)]):
            with self.assertRaises(ValueError):
                self.service.preview({'paper_ids': ids}, self.cfg)
        preview = self.preview(); self.service.previews[preview['id']]['created'] -= classification.TTL_SECONDS
        with self.assertRaisesRegex(ValueError, '过期'):
            self.service.send(preview['id'], True, self.cfg)
        entered, release = threading.Event(), threading.Event(); preview = self.preview(); result = []
        def response(*args):
            entered.set(); release.wait(3); return self.response()
        with patch('easyread.classification.request', side_effect=response) as send:
            worker = threading.Thread(target=lambda: result.append(self.service.send(preview['id'], True, self.cfg))); worker.start()
            self.assertTrue(entered.wait(2))
            with self.assertRaisesRegex(ValueError, '已发送'):
                self.service.send(preview['id'], True, self.cfg)
            release.set(); worker.join(3); self.assertEqual(send.call_count, 1)
        preview = self.preview(); self.ws.paper_path.unlink()
        with self.assertRaisesRegex(ValueError, '移除'):
            self.service.send(preview['id'], True, self.cfg)


class FilenameTest(unittest.TestCase):
    def test_cross_platform_sanitizer_and_unicode_byte_limit(self):
        cases = ['CON', 'nul.txt', 'COM¹', 'Lpt9.PDF.pdf', 'CON   .txt', 'CONIN$', 'CONOUT$', '论文.PDF.', '论文.pdf... ', '.. /a\\b:c*d?e"f<g>h|i\x00\u202e .', 'é e\u0301 中文', '汉'*300, '😀'*200, ' .pdf ', 'a\n\tb']
        for value in cases:
            filename = N.pdf_filename(value)
            self.assertTrue(filename.endswith('.pdf')); self.assertLessEqual(len(filename.encode()), 180)
            self.assertNotRegex(filename, r'[<>:"/\\|?*\x00-\x1f]')
            self.assertFalse(filename[:-4].endswith(('.', ' ')))
        from pathlib import PureWindowsPath
        for value in ('CON   .txt', 'CONIN$', 'CONOUT$', 'PRN .file', 'COM1 .doc'):
            self.assertFalse(PureWindowsPath(N.pdf_filename(value)).is_reserved())
        self.assertEqual(N.pdf_filename('CON'), '_CON.pdf')
        self.assertEqual(N.pdf_filename('é'), N.pdf_filename('e\u0301'))
        self.assertEqual(N.pdf_filename('a.PDF.pdf'), 'a.pdf')

    def test_stable_collision_suffixes_and_reserved_unique_names(self):
        rows = [('aaaa', '同名'), ('bbbb', '同名'), ('cccc', '同名 (aaaa)'), ('dddd', 'Name'), ('eeee', 'name')]
        result = N.pdf_filenames(rows)
        self.assertEqual(result, N.pdf_filenames(reversed(rows)))
        self.assertEqual(len(set(n.lower() for n in result.values())), len(rows))
        self.assertEqual(result['cccc'], '同名 (aaaa).pdf')
        self.assertEqual(result['aaaa'], '同名 (aaaa-2).pdf')

    def test_browser_filename_and_portable_naming_parity(self):
        if not shutil.which('node'):
            self.skipTest('Node unavailable')
        values = ['CON', 'nul.txt', 'COM¹', 'Lpt9.PDF.pdf', 'CON   .txt', 'CONIN$', 'CONOUT$', '论文.PDF.', '论文.pdf... ', '.. /a\\b:c*d?e"f<g>h|i\x00\u202e .', 'é e\u0301 中文', '汉'*300, '😀'*200, ' .pdf ', 'a\n\tb', 'a   b', '\n中文\t', '\uFEFFname', 'a\x85b', 'a\x1cb', 'a\ud800b']
        valid = dict(title='中文\n名称.PDF', source='manual', original_title='Original', original_filename='old.pdf', updated='2026-10-04T08:00:00.000Z', version='revision')
        invalid = [dict(valid, updated='2026-10-04'), dict(valid, version=1), dict(valid, title=''), dict(valid, source='official'), dict(valid, api_key='secret'), dict(valid, updated='2026-02-30T08:00:00Z'),
                   dict(valid, updated='2026-10-04T08:00:00.0001Z'), dict(valid, updated='2026-10-04T08:00:00,1Z'),
                   dict(valid, updated='2026-10-04T24:00:00Z'), dict(valid, updated='2026-10-04T08:00:00+24:00'), dict(valid, updated='2026-10-04T08:00:00+00:99'),
                   dict(valid, version='\ud800'), dict(valid, original_title='\ud800'), dict(valid, original_filename='\udc00'),
                   dict(valid, title='a\x85b中文'), dict(valid, title='a\x1cb中文')]
        code = "const C=require('./easyread/web/mobile/core.js');let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{const x=JSON.parse(s);console.log(JSON.stringify({files:x.values.map(v=>C.pdfFilename(v)),names:x.naming.map(v=>C.cleanNaming(v)),fields:C.FIELDS}));});"
        data = json.loads(subprocess.check_output(['node', '-e', code], input=json.dumps({'values': values, 'naming': [valid]+invalid}).encode(), cwd=Path(__file__).parents[1]))
        self.assertEqual(data['files'], [N.pdf_filename(v) for v in values])
        self.assertEqual(data['names'], [N.clean_naming(v) for v in [valid]+invalid])
        self.assertEqual(data['fields'], P.FIELDS)


class NamingServerTest(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp(); self.old_app = getattr(Handler, 'app', None)
        Handler.app = SimpleNamespace(lib=self.lib, token='token', naming=self.service, scholar=Mock(), jobs=Mock())
        Handler.app.jobs.small_status.return_value = []
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.cfg_patch = patch.object(config, 'load', return_value=self.cfg); self.cfg_patch.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); Handler.app = self.old_app
        self.cfg_patch.stop(); super().tearDown()

    def http(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=3)
        conn.request(method, path, json.dumps(body) if body is not None else None, headers or {'X-Token': 'token'})
        response = conn.getresponse(); result = response.status, dict(response.getheaders()), response.read(); conn.close()
        return result

    def test_review_flow_token_origin_and_utf8_pdf_download(self):
        self.assertEqual(self.http('POST', '/api/naming/suggest', {'paper_ids': [self.ws.id]}, {'X-Token': 'bad'})[0], 403)
        self.assertEqual(self.http('GET', '/api/p/test-paper/pdf', headers={'Origin': 'https://other.example'})[0], 403)
        code, _, raw = self.http('POST', '/api/naming/suggest', {'paper_ids': [self.ws.id]}); self.assertEqual(code, 200)
        rows = json.loads(raw)['suggestions']; rows[0].update(title='审阅：城市气候研究', source='manual')
        self.assertEqual(self.http('POST', '/api/naming/apply', {'suggestions': rows})[0], 200)
        code, headers, raw = self.http('GET', '/api/p/test-paper/pdf')
        self.assertEqual(code, 200); self.assertEqual(headers['Content-Type'], 'application/pdf')
        self.assertEqual(raw, (self.ws.root / 'source.pdf').read_bytes())
        self.assertIn('filename="export.pdf"', headers['Content-Disposition'])
        self.assertIn('审阅：城市气候研究.pdf', unquote(headers['Content-Disposition']))
        self.assertEqual(self.http('HEAD', '/api/p/test-paper/pdf')[2], b'')
        code, headers, inline = self.http('GET', '/p/test-paper/source.pdf')
        self.assertEqual(inline, raw); self.assertTrue(headers['Content-Disposition'].startswith('inline;'))
        self.assertIn('审阅：城市气候研究.pdf', unquote(headers['Content-Disposition']))
        self.assertEqual(self.http('POST', '/api/naming/apply', {'suggestions': rows})[0], 400)
        (self.ws.root / 'source.pdf').unlink()
        self.assertEqual(self.http('GET', '/api/p/test-paper/pdf')[0], 404)

    def test_http_ai_review_consent_and_cancel(self):
        code, _, raw = self.http('POST', '/api/naming/preview', {'paper_ids': [self.ws.id]}); self.assertEqual(code, 200)
        preview = json.loads(raw)
        with patch('easyread.classification.request', return_value=self.response()) as send:
            self.assertEqual(self.http('POST', '/api/naming/send', {'id': preview['id'], 'confirmed': False})[0], 400)
            send.assert_not_called()
            self.assertEqual(self.http('POST', '/api/naming/send', {'id': preview['id'], 'confirmed': True})[0], 200)
        self.assertNotIn('naming', self.ws.load('item'))
        self.assertEqual(self.http('POST', '/api/naming/cancel', {'id': preview['id']})[0], 200)
        self.assertEqual(self.http('POST', '/api/naming/suggest', [self.ws.id])[0], 400)


class NamingDriveTest(Fixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.drive = Drive(self.home, self.lib); self.drive.account = {'permissionId': 'acct'}
        self.files = []; self.payloads = {}; self.uploaded = []; self.hook = None
        self.patches = []
        for method, options in [('identify', {}), ('list_files', {'side_effect': lambda: copy.deepcopy(self.files)}),
                                ('download', {'side_effect': lambda f: copy.deepcopy(self.payloads[f['id']])}),
                                ('upload', {'side_effect': self.upload}), ('folder', {'return_value': 'folder'}),
                                ('upload_source', {}), ('source_bytes', {'return_value': None}), ('events', {'return_value': []})]:
            p = patch.object(self.drive, method, **options); p.start(); self.patches.append(p)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        super().tearDown()

    def upload(self, filename, data, props, parent):
        if self.hook:
            hook, self.hook = self.hook, None; hook(props)
        return self.add_file(data, props, recorded=True)

    def add_file(self, data, props=None, recorded=False):
        if props is None:
            props = {'folioType': 'paper', 'folioPaperId': data['paper_id'], 'folioContent': self.drive.content_hash(data)}
        file = {'id': 'file-' + str(len(self.files)), 'modifiedTime': f'2026-10-04T08:{len(self.files):02d}:00Z', 'appProperties': copy.deepcopy(props)}
        self.files.append(file); self.payloads[file['id']] = copy.deepcopy(data)
        if recorded:
            self.uploaded.append((props['folioType'], copy.deepcopy(data)))
        return copy.deepcopy(file)

    def sync(self):
        return self.drive._sync_workspace(self.ws, copy.deepcopy(self.files))

    def test_portable_naming_roundtrip_and_legacy_body_hash_stable(self):
        old = self.drive.bundle(self.ws); before = self.drive.content_hash(old)
        self.apply_name()
        data = self.drive.bundle(self.ws)
        data['item']['naming']['api_key'] = 'NOT-PORTABLE'
        clean = P.normalize(data)
        self.assertEqual(clean['item']['naming']['title'], '中文名称')
        self.assertNotIn('NOT-PORTABLE', json.dumps(clean))
        self.assertEqual(self.drive.content_hash(clean), before)
        self.assertEqual(self.drive.article_content_hash(clean), before)
        self.assertNotIn('naming', P.normalize(old)['item'])
        clean['item']['naming']['version'] = 1
        self.assertNotIn('naming', P.normalize(clean)['item'])

    def test_naming_only_sync_uploads_only_immutable_naming_snapshot(self):
        self.sync(); self.uploaded.clear()
        original_paper_hash = self.ws.paper_path.read_bytes(); original_pdf = (self.ws.root/'source.pdf').read_bytes()
        self.apply_name('已审阅中文标题'); self.sync()
        self.assertEqual([kind for kind, _ in self.uploaded], ['naming'])
        snapshot = self.uploaded[0][1]
        self.assertEqual(snapshot['kind'], 'folio-naming'); self.assertEqual(snapshot['paper_id'], 'a'*64)
        self.assertEqual(snapshot['naming']['title'], '已审阅中文标题')
        self.assertNotIn('paper', snapshot); self.assertNotIn('reader', snapshot)
        self.assertEqual(original_paper_hash, self.ws.paper_path.read_bytes())
        self.assertEqual(original_pdf, (self.ws.root/'source.pdf').read_bytes())
        self.uploaded.clear(); self.sync(); self.assertEqual(self.uploaded, [])

    def test_name_only_sync_preserves_remote_translation_arriving_before_sync(self):
        self.sync()
        remote = self.drive.bundle(self.ws); remote['paper']['blocks'][0]['zh'] = '远端新译文'
        self.add_file(remote); self.apply_name('本机已核对名称'); self.uploaded.clear()
        self.sync()
        self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], '远端新译文')
        self.assertEqual(self.ws.load('item')['naming']['title'], '本机已核对名称')
        self.assertNotIn('paper', [kind for kind, _ in self.uploaded])

    def test_name_upload_inflight_cannot_become_latest_stale_article(self):
        self.sync(); self.apply_name('只修改名称'); self.uploaded.clear()
        remote = self.drive.bundle(self.ws); remote['paper']['blocks'][0]['zh'] = '同步期间的新译文'
        def concurrent(props):
            self.assertEqual(props['folioType'], 'naming')
            self.add_file(remote)
        self.hook = concurrent; self.sync()
        latest = self.drive.latest(self.files, 'a'*64)
        self.assertEqual(self.payloads[latest['id']]['paper']['blocks'][0]['zh'], '同步期间的新译文')
        self.assertEqual([kind for kind, _ in self.uploaded], ['naming'])
        self.sync()
        self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], '同步期间的新译文')
        self.assertEqual(self.ws.load('item')['naming']['title'], '只修改名称')

    def test_no_baseline_named_local_never_overwrites_remote_translation(self):
        remote = self.drive.bundle(self.ws); remote['paper']['blocks'][0]['zh'] = '云端已有译文'
        self.add_file(remote); self.apply_name('本机名称')
        with self.assertRaisesRegex(ValueError, '缺少同步基线'):
            self.sync()
        self.assertEqual(self.uploaded, [])
        self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], '已有中文译文')

    def test_older_snapshot_or_old_client_absence_cannot_erase_reviewed_name(self):
        old = self.drive.bundle(self.ws); self.apply_name('当前名字')
        naming = self.ws.load('item')['naming']; older = dict(naming, title='旧名字', updated='2001-01-01T00:00:00Z', version='older')
        snapshot = dict(schema=1, kind='folio-naming', paper_id='a'*64, naming=older)
        props = dict(folioType='naming', folioPaperId='a'*64, folioContent=hashlib.sha256(P.canonical(snapshot).encode()).hexdigest())
        self.add_file(snapshot, props)
        file = self.add_file(old)
        expected = {n: (self.ws.root/(n+'.json')).read_bytes() for n in ('paper', 'discussion', 'item')}
        self.drive.pull(file['id'], files=copy.deepcopy(self.files), update_content=True, expected_content=expected)
        self.assertEqual(self.ws.load('item')['naming'], naming)

    def test_snapshot_receives_remote_name_and_malformed_snapshot_never_mutates(self):
        self.apply_name('本机名字'); original = self.ws.load('item')['naming']
        remote = dict(original, title='较新的远端名字', updated='2099-01-01T00:00:00Z', version='future')
        payload = dict(schema=1, kind='folio-naming', paper_id='a'*64, naming=remote)
        props = dict(folioType='naming', folioPaperId='a'*64, folioContent=hashlib.sha256(P.canonical(payload).encode()).hexdigest())
        file = self.add_file(payload, props)
        self.drive._sync_naming(self.ws, copy.deepcopy(self.files), publish=False)
        self.assertEqual(self.ws.load('item')['naming']['title'], '较新的远端名字')
        self.payloads[file['id']]['paper_id'] = 'b'*64
        before = self.ws.item_path.read_bytes()
        with self.assertRaisesRegex(ValueError, '标识无效'):
            self.drive._sync_naming(self.ws, copy.deepcopy(self.files), publish=False)
        self.assertEqual(self.ws.item_path.read_bytes(), before)

    def test_local_name_edit_during_snapshot_upload_survives(self):
        self.sync(); self.apply_name('名称甲')
        self.hook = lambda props: self.apply_name('名称乙')
        self.sync()
        self.assertEqual(self.ws.load('item')['naming']['title'], '名称乙')
        self.uploaded.clear(); self.sync()
        self.assertEqual([kind for kind, _ in self.uploaded], ['naming'])
        self.assertEqual(self.uploaded[0][1]['naming']['title'], '名称乙')

    def test_item_change_during_pull_prevents_body_or_name_overwrite(self):
        self.sync(); remote = self.drive.bundle(self.ws); remote['paper']['blocks'][0]['zh'] = '远端译文'
        file = self.add_file(remote)
        expected = {n: (self.ws.root/(n+'.json')).read_bytes() for n in ('paper', 'discussion', 'item')}
        def download(_):
            self.apply_name('下载期间修改名称'); return copy.deepcopy(remote)
        with patch.object(self.drive, 'download', side_effect=download), self.assertRaisesRegex(ValueError, '已保留本机修改'):
            self.drive.pull(file['id'], files=copy.deepcopy(self.files), update_content=True, expected_content=expected)
        self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], '已有中文译文')
        self.assertEqual(self.ws.load('item')['naming']['title'], '下载期间修改名称')
