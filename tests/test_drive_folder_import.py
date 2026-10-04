"""Drive folder drop-ins: permission boundaries, local parse, dedup, retries."""
import copy
import hashlib
import io
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from easyread import engines, knowledge, pdfwork
from easyread.drive import Drive, SCOPE, FOLDER_READ_SCOPE, MAX_SOURCE
from easyread.library import Library
from easyread.store import read_json, write_json_atomic


def sample_pdf(text='Folio folder import searchable vegetation cooling'):
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject(); stream.set_data(('BT /F1 10 Tf 15 270 Td (' + text + ') Tj ET').encode())
    page[NameObject('/Contents')] = writer._add_object(stream)
    out = io.BytesIO(); writer.write(out); return out.getvalue()


class DriveFolderImportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.home = Path(self.temp.name)
        self.lib = Library(self.home / 'library')
        with patch('easyread.drive.threading.Thread'):
            self.drive = Drive(self.home, self.lib)
        self.drive.account = {'permissionId': 'account-one'}
        self.drive.granted_scopes = {SCOPE, FOLDER_READ_SCOPE}
        self.drive.cfg.update(folder_import_enabled=True, client_id='client.apps.googleusercontent.com')
        self.raw = sample_pdf(); self.pid = hashlib.sha256(self.raw).hexdigest()
        self.folder = {'id': 'folder-main', 'appProperties': {'folioApp': 'mobile-v1', 'folioType': 'folder'}}
        self.external = self.file('external-1', self.raw)

    def tearDown(self):
        self.temp.cleanup()

    def file(self, file_id, raw, **fields):
        return dict(id=file_id, name='paper.pdf', mimeType='application/pdf', parents=['folder-main'], size=str(len(raw)),
                    version='1', modifiedTime='2026-10-03T10:00:00Z', md5Checksum=hashlib.md5(raw).hexdigest(), **fields)

    def import_files(self, files=None, raws=None, managed=None):
        files = files or [self.external]; raws = raws or {self.external['id']: self.raw}
        def download(url, **kwargs):
            return raws[url.split('/files/')[1].split('?')[0]], {}
        with patch.object(self.drive, 'list_folder_pdfs', return_value=files), patch.object(self.drive, 'binary_request', side_effect=download), patch.object(engines, 'run') as ai:
            result = self.drive.import_folder_pdfs([self.folder] + (managed or []))
            ai.assert_not_called()
            return result

    def test_default_off_and_preference_cannot_forge_scope(self):
        self.drive.cfg['folder_import_enabled'] = False
        with patch.object(self.drive, 'list_folder_pdfs') as listing:
            self.assertEqual(self.drive.import_folder_pdfs([self.folder]), (0, []))
            self.drive.cfg['folder_import_enabled'] = True; self.drive.granted_scopes = {SCOPE}
            count, errors = self.drive.import_folder_pdfs([self.folder])
            self.assertEqual(count, 0); self.assertIn('授权', errors[0]['error']); listing.assert_not_called()
        self.assertFalse(self.drive.status()['folder_read_granted'])

    def test_listing_targets_only_known_direct_pdf_children_and_paginates(self):
        managed = dict(self.external, appProperties={'folioApp': 'mobile-v1', 'folioType': 'source'})
        with patch.object(self.drive, 'request', side_effect=[{'files': [managed], 'nextPageToken': 'more'}, {'files': [self.external]}]) as request:
            self.assertEqual(self.drive.list_folder_pdfs('folder-main'), [self.external])
        for call in request.call_args_list:
            params = urllib.parse.parse_qs(urllib.parse.urlparse(call.args[0]).query)
            self.assertIn("'folder-main' in parents", params['q'][0]); self.assertIn("mimeType != 'application/vnd.google-apps.folder'", params['q'][0])
            self.assertNotIn('fullText', params['q'][0])
        self.assertIn('pageToken=more', request.call_args.args[0])
        with patch.object(self.drive, 'request') as request:
            with self.assertRaises(ValueError): self.drive.list_folder_pdfs("folder' or 'x")
            request.assert_not_called()

    def test_real_pdf_is_parsed_indexed_without_ai_and_original_unchanged(self):
        count, errors = self.import_files(); self.assertEqual((count, errors), (1, []))
        ws = self.lib.all()[0]; paper = ws.load('paper')
        self.assertEqual((ws.root / 'source.pdf').read_bytes(), self.raw)
        self.assertEqual(paper['meta']['source_sha256'], self.pid)
        self.assertEqual(paper['meta']['text_status'], 'original')
        self.assertIn('vegetation', paper['blocks'][0]['en'])
        self.assertTrue((ws.root / paper['meta']['pages'][0]['img']).is_file())
        self.assertNotIn('synced_once', ws.load('reader')['_cloud'])
        self.assertEqual(knowledge.sync(self.lib)['updated'], 1)
        self.assertEqual([p for p in self.lib.root.iterdir() if p.name.startswith('.drive-pdf-')], [])

    def test_every_import_pdfium_lifecycle_holds_shared_lock(self):
        import pypdfium2 as pdfium
        constructor = pdfium.PdfDocument
        observed = []
        def record(operation):
            observed.append((operation, pdfwork._PDF_LOCK._is_owned()))
        class CheckedDocument:
            def __init__(self, *args, **kwargs):
                record('construct')
                self.doc = constructor(*args, **kwargs)
            def __enter__(self):
                record('enter')
                self.doc.__enter__()
                return self
            def __len__(self):
                record('count')
                return len(self.doc)
            def __getitem__(self, index):
                record('page')
                return self.doc[index]
            def __exit__(self, *args):
                record('close')
                return self.doc.__exit__(*args)
        with patch.object(pdfium, 'PdfDocument', CheckedDocument):
            self.assertEqual(self.import_files(), (1, []))
        # Preflight, rendering, and extraction all open native documents.
        self.assertEqual(sum(op == 'construct' for op, held in observed), 3)
        self.assertEqual(sum(op == 'close' for op, held in observed), 3)
        self.assertTrue(all(held for op, held in observed), observed)

    def test_oversized_page_count_closes_native_document_under_lock(self):
        from unittest.mock import MagicMock
        import pypdfium2 as pdfium
        observed = []
        def record(*args):
            observed.append(pdfwork._PDF_LOCK._is_owned())
        doc = MagicMock()
        doc.__enter__.return_value = doc
        doc.__len__.side_effect = lambda: (record(), 301)[1]
        doc.__exit__.side_effect = record
        def open_doc(*args):
            record()
            return doc
        with patch.object(pdfium, 'PdfDocument', side_effect=open_doc), patch.object(pdfwork, 'render_pages') as render:
            count, errors = self.import_files()
            self.assertEqual(count, 0)
            self.assertIn('300', errors[0]['error'])
            render.assert_not_called()
        self.assertEqual(observed, [True, True, True])
        self.assertEqual(self.lib.all(), [])

    def test_repeat_rename_and_app_import_deduplicate_without_losing_edits(self):
        self.import_files(); ws = self.lib.all()[0]
        ws.update('paper', lambda p: p['blocks'][0].update(zh='已翻译正文'))
        ws.update('reader', lambda r: r['notes'].update({'note-one': {'body': '保留笔记'}}))
        paper_before = ws.paper_path.read_bytes()
        same = dict(self.external, name='renamed.pdf')
        with patch.object(self.drive, 'list_folder_pdfs', return_value=[same]), patch.object(self.drive, 'binary_request') as download:
            self.assertEqual(self.drive.import_folder_pdfs([self.folder]), (0, [])); download.assert_not_called()
        twin = dict(self.external, id='external-copy', name='another-name.pdf')
        with patch.object(self.drive, '_import_pdf_bytes') as parser:
            self.assertEqual(self.import_files([twin], {'external-copy': self.raw}), (0, [])); parser.assert_not_called()
        self.assertEqual(len(self.lib.all()), 1); self.assertEqual(ws.paper_path.read_bytes(), paper_before)
        self.assertEqual(ws.load('reader')['notes']['note-one']['body'], '保留笔记')

    def test_changed_pdf_same_id_imports_new_hash_without_overwriting_old(self):
        self.import_files(); new_raw = sample_pdf('Different replacement content')
        changed = self.file('external-1', new_raw); changed['version'] = '2'
        self.assertEqual(self.import_files([changed], {'external-1': new_raw}), (1, []))
        self.assertEqual(len(self.lib.all()), 2)
        self.assertIn(self.pid, {w.load('paper')['meta']['source_sha256'] for w in self.lib.all()})

    def test_bad_encrypted_oversized_and_changed_files_are_isolated(self):
        writer = PdfWriter(); writer.add_blank_page(width=200, height=200); writer.encrypt('never-saved')
        out = io.BytesIO(); writer.write(out); protected = out.getvalue()
        bad = b'%PDF-1.7\nbroken'
        damaged = self.file('damaged', bad)
        encrypted = self.file('encrypted', protected)
        too_large = dict(self.external, id='oversized', size=str(MAX_SOURCE + 1))
        changed = dict(self.external, id='changed', md5Checksum='0' * 32)
        files = [damaged, encrypted, too_large, changed, self.external]
        count, errors = self.import_files(files, {'damaged': bad, 'encrypted': protected, 'changed': self.raw, 'external-1': self.raw})
        self.assertEqual(count, 1); self.assertEqual(len(errors), 4); self.assertEqual(len(self.lib.all()), 1)
        self.assertEqual([p for p in self.lib.root.iterdir() if p.name.startswith('.drive-pdf-')], [])
        cache = read_json(self.home / '.drive-cache/account-one/folder-imports.json')
        self.assertEqual(set(cache), {'external-1'})

    def test_existing_local_other_account_is_not_rebound(self):
        self.import_files(); ws = self.lib.all()[0]
        ws.update('reader', lambda r: r['_cloud'].update(account='other-account'))
        external = dict(self.external, id='external-copy')
        count, errors = self.import_files([external], {'external-copy': self.raw})
        self.assertEqual(count, 0); self.assertIn('另一 Google', errors[0]['error'])
        self.assertEqual(ws.load('reader')['_cloud']['account'], 'other-account')

    def test_cache_is_account_scoped_and_deleted_local_copy_is_reimported(self):
        self.import_files(); ws = self.lib.all()[0]; self.lib.trash(ws.id)
        self.assertEqual(self.import_files(), (1, []))
        self.drive.account = {'permissionId': 'different'}
        count, errors = self.import_files()
        self.assertEqual(count, 0); self.assertEqual(len(errors), 1)
        self.assertFalse((self.home / '.drive-cache/different/folder-imports.json').exists())

    def test_cloud_existing_translation_is_pulled_instead_of_reparsed(self):
        remote = {'id': 'reading', 'appProperties': {'folioType': 'paper', 'folioPaperId': self.pid}}
        def pull(*args, **kwargs):
            ws, _ = self.lib.create_from_pdf(self.raw, 'known.pdf')
            ws.update('paper', lambda p: p.update(blocks=[{'id': 'translated', 'type': 'para', 'zh': '云端翻译'}]))
        with patch.object(self.drive, 'pull', side_effect=pull) as pulled, patch.object(self.drive, '_import_pdf_bytes') as parser:
            self.assertEqual(self.import_files(managed=[remote]), (0, [])); pulled.assert_called_once(); parser.assert_not_called()
        self.assertEqual(self.lib.all()[0].load('paper')['blocks'][0]['zh'], '云端翻译')

    def test_optional_oauth_url_requests_readonly_only_after_opt_in(self):
        self.drive.cfg['folder_import_enabled'] = False
        for enabled in (False, True):
            with self.subTest(enabled=enabled), patch('easyread.drive.webbrowser.open', side_effect=ValueError('stop before account action')) as launch:
                with self.assertRaisesRegex(ValueError, 'stop before'): self.drive.login(enabled)
                params = urllib.parse.parse_qs(urllib.parse.urlparse(launch.call_args.args[0]).query)
                self.assertEqual(set(params['scope'][0].split()), {SCOPE, FOLDER_READ_SCOPE} if enabled else {SCOPE})
        self.drive._tokens({'access_token': 'mock', 'scope': SCOPE})
        self.assertFalse(self.drive.status()['folder_read_granted'])
        self.drive._tokens({'access_token': 'mock', 'scope': SCOPE + ' ' + FOLDER_READ_SCOPE})
        self.assertTrue(self.drive.status()['folder_read_granted'])
        self.drive.disable_folder_import(); self.assertFalse(self.drive.cfg['folder_import_enabled'])
        self.assertTrue(self.drive.status()['folder_read_granted'])  # Stopping a scan does not falsely claim revocation.

    def test_partial_upload_does_not_mark_cloud_success_and_other_papers_continue(self):
        self.import_files(); first = self.lib.all()[0]
        other, _ = self.lib.create_from_pdf(sample_pdf('Second paper'), 'second.pdf')
        def sync(ws, files):
            if ws.id == first.id: raise ValueError('network offline')
            return files
        with patch.object(self.drive, 'identify'), patch.object(self.drive, 'list_files', return_value=[self.folder]), patch.object(self.drive, 'import_folder_pdfs', return_value=(0, [])), patch.object(self.drive, '_sync_workspace', side_effect=sync) as run:
            self.drive.sync()
            self.assertEqual(run.call_count, 2)
        self.assertEqual(len(self.drive.import_errors), 1); self.assertNotIn('last_sync', self.drive.cfg)
        self.assertNotIn('synced_once', first.load('reader')['_cloud'])
        self.assertIn('需重试', self.drive.message)

    def test_dropin_sync_creates_compatible_pdf_reading_and_index_once(self):
        cloud = [copy.deepcopy(self.folder)]; payloads = {}; calls = []
        def list_files(): return copy.deepcopy(cloud)
        def create(data, raw=None):
            entry = dict(data, id='managed-' + str(len(cloud)), modifiedTime='2026-10-03T11:00:00Z')
            cloud.append(entry)
            if raw is not None: payloads[entry['id']] = raw
            return entry
        def request(url, body=None, *args):
            calls.append((url, args[-1] if args else 'GET'))
            return create(json.loads(body))
        session_meta = {}
        def binary(url, body=None, headers=None, method=None, **kwargs):
            calls.append((url, method or 'GET'))
            if 'external-1?alt=media' in url: return self.raw, {}
            if 'uploadType=resumable' in url:
                session_meta.update(json.loads(body)); return b'', {'Location': 'https://www.googleapis.com/upload/drive/session'}
            if method == 'PUT':
                entry = create(dict(session_meta, size=str(len(body))), body)
                return json.dumps(entry).encode(), {}
            raise AssertionError(url)
        def upload(name, data, properties, folder):
            return create(dict(name=name, parents=[folder], appProperties=dict(folioApp='mobile-v1', **properties)), copy.deepcopy(data))
        with patch.object(self.drive, 'identify'), patch.object(self.drive, 'list_files', side_effect=list_files), patch.object(self.drive, 'list_folder_pdfs', return_value=[self.external]), patch.object(self.drive, 'binary_request', side_effect=binary), patch.object(self.drive, 'request', side_effect=request), patch.object(self.drive, 'upload', side_effect=upload), patch.object(self.drive, 'download', side_effect=lambda file: copy.deepcopy(payloads[file['id']])):
            self.drive.sync(); self.assertEqual(self.drive.import_errors, [])
            self.drive.sync(); self.assertEqual(self.drive.import_errors, [])
        kinds = [f['appProperties']['folioType'] for f in cloud]
        self.assertEqual(kinds.count('source'), 1); self.assertEqual(kinds.count('paper'), 1); self.assertEqual(kinds.count('index'), 1)
        source = next(f for f in cloud if f['appProperties']['folioType'] == 'source')
        source_folder = next(f for f in cloud if f['appProperties']['folioType'] == 'source-folder')
        self.assertEqual(source['parents'], [source_folder['id']]); self.assertEqual(source_folder['parents'], ['folder-main'])
        self.assertEqual(payloads[source['id']], self.raw)
        self.assertTrue(self.lib.all()[0].load('reader')['_cloud']['synced_once'])
        self.assertEqual([method for url, method in calls if 'external-1' in url], ['GET'])


if __name__ == '__main__': unittest.main()
