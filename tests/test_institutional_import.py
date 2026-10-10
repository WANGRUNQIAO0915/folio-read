"""Institutional downloads are untrusted bytes, never browser session state."""
import hashlib
import io
import json
import os
import tempfile
import threading
from contextlib import contextmanager
import unittest
from pathlib import Path
from unittest.mock import patch

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Link
from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject, TextStringObject, DecodedStreamObject

from easyread import institutional_import as imports, organization as organization_module
from easyread.library import Library
from easyread.organization import Organization, assignment, paper_id


def make_pdf(edit=None, pages=1, password=None):
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=300, height=400)
    if edit:
        edit(writer)
    if password is not None:
        writer.encrypt(password)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def action(kind, **fields):
    return DictionaryObject({NameObject('/S'): NameObject(kind), **{NameObject('/' + k): TextStringObject(v) for k, v in fields.items()}})


class InstitutionalImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.path = self.home / 'download.tmp'
        self.lib = Library(self.home / 'library')
        self.raw = make_pdf()
        self.path.write_bytes(self.raw)

    def validate(self, raw):
        self.path.write_bytes(raw)
        return imports.validate_pdf(self.path)

    def folder(self, label):
        org = Organization(self.lib)
        state = org.folder(label)
        return next(fid for fid, entry in state['folders'].items() if entry['name'] == label)

    def reject(self, raw, message=None):
        self.path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, message or '.'):
            imports.import_download(self.path, 'paper.pdf', self.lib)
        self.assertEqual(self.lib.all(), [])

    def test_valid_pdf_original_bytes_hash_and_source_are_preserved(self):
        result = imports.import_download(self.path, 'Research paper.pdf', self.lib)
        self.assertEqual(set(result), {'id', 'fresh', 'message'})
        self.assertTrue(result['fresh'])
        self.assertEqual(result['id'], hashlib.sha256(self.raw).hexdigest()[:12])
        ws = self.lib.ws(result['id'])
        self.assertEqual((ws.root / 'source.pdf').read_bytes(), self.raw)
        meta = ws.load('paper')['meta']
        self.assertEqual(meta['source_sha256'], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(meta['source'], 'Research paper.pdf')
        self.assertFalse((ws.root / 'job.json').exists())
        # The browser owner cleans up its download; this helper never deletes it.
        self.assertTrue(self.path.exists())

    def test_validate_pdf_returns_bytes_without_library_mutation(self):
        self.assertEqual(imports.validate_pdf(self.path), self.raw)
        self.assertEqual(self.lib.all(), [])

    def test_html_empty_truncated_fake_pdf_and_bad_xref_are_rejected(self):
        cases = [b'', b'<html>Login required</html>', b'%PDF-1.7\n<html>login</html>\n%%EOF',
                 b'%PDF-X\n%%EOF', self.raw[:-6], self.raw.replace(b'startxref\n', b'startxxxx\n')]
        for raw in cases:
            with self.subTest(raw=raw[:30]):
                self.reject(raw, '完整有效')

    def test_empty_page_tree_and_false_count_are_rejected(self):
        self.reject(make_pdf(pages=0), '完整有效')
        raw = self.raw.replace(b'/Count 1', b'/Count 0')
        self.reject(raw, '完整有效')

    def test_encrypted_pdf_rejected_including_empty_password(self):
        for password in ('secret', ''):
            with self.subTest(password=password):
                self.reject(make_pdf(password=password), '加密')

    def test_oversize_rejected_before_parser_or_full_read(self):
        with self.path.open('wb') as file:
            file.truncate(imports.MAX_PDF_BYTES + 1)
        with patch.object(imports, 'PdfReader') as parser:
            with self.assertRaisesRegex(ValueError, '100 MiB'):
                imports.validate_pdf(self.path)
            parser.assert_not_called()

    def test_read_size_is_bounded_even_when_file_size_underreports(self):
        with patch.object(imports, 'MAX_PDF_BYTES', len(self.raw) - 1):
            real_stat = os.fstat
            def small_stat(fd):
                info = list(real_stat(fd)); info[6] = 1
                return os.stat_result(info)
            with patch.object(imports.os, 'fstat', side_effect=small_stat):
                with self.assertRaisesRegex(ValueError, '100 MiB'):
                    imports.validate_pdf(self.path)

    def test_exact_byte_limit_allowed(self):
        with patch.object(imports, 'MAX_PDF_BYTES', len(self.raw)):
            self.assertEqual(imports.validate_pdf(self.path), self.raw)

    def test_page_limit_actual_boundary(self):
        with patch.object(imports, 'MAX_PDF_PAGES', 2):
            self.assertEqual(len(PdfReader(io.BytesIO(self.validate(make_pdf(pages=2)))).pages), 2)
            self.reject(make_pdf(pages=3), '最多支持 2 页')
        self.assertEqual(imports.MAX_PDF_PAGES, 3000)

    def test_missing_directory_symlink_and_pipe_are_rejected(self):
        with self.assertRaisesRegex(ValueError, '无法读取'):
            imports.validate_pdf(self.home / 'missing.pdf')
        with self.assertRaises(ValueError):
            imports.validate_pdf(self.home)
        linked = self.home / 'link.pdf'
        try:
            linked.symlink_to(self.path)
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaisesRegex(ValueError, '路径无效'):
                imports.validate_pdf(linked)
        if hasattr(os, 'mkfifo'):
            fifo = self.home / 'pipe.pdf'
            os.mkfifo(fifo)
            with self.assertRaisesRegex(ValueError, '路径无效'):
                imports.validate_pdf(fifo)

    def test_javascript_name_tree_and_open_action_rejected(self):
        self.reject(make_pdf(lambda w: w.add_js("app.alert('hello')")), '脚本')
        self.reject(make_pdf(lambda w: w._root_object.update({NameObject('/OpenAction'): action('/JavaScript', JS='alert(1)')})), '脚本')

    def test_embedded_file_and_associated_file_rejected(self):
        self.reject(make_pdf(lambda w: w.add_attachment('payload.txt', b'data')), '附件')
        self.reject(make_pdf(lambda w: w._root_object.update({NameObject('/AF'): ArrayObject()})), '附件')

    def test_active_actions_rejected_even_when_indirect_or_unreferenced(self):
        for kind in ('/Launch', '/GoToR', '/GoToE', '/SubmitForm', '/ImportData', '/Rendition'):
            with self.subTest(kind=kind):
                self.reject(make_pdf(lambda w: w._add_object(action(kind, F='payload.exe'))), '主动操作')
        self.reject(make_pdf(lambda w: w.pages[0].update({NameObject('/AA'): DictionaryObject()})), '主动操作')

    def test_dangerous_uri_actions_rejected_but_ordinary_links_work(self):
        for url in ('javascript:alert(1)', 'file:///tmp/file', 'data:text/html,bad', 'https:\n//example.org', 'https:relative'):
            with self.subTest(url=url):
                self.reject(make_pdf(lambda w: w.add_annotation(0, Link(rect=(0, 0, 20, 20), url=url))), '主动操作')
        for url in ('https://doi.org/10.1234/paper', 'http://example.org/paper', 'mailto:author@example.org'):
            with self.subTest(url=url):
                raw = make_pdf(lambda w: w.add_annotation(0, Link(rect=(0, 0, 20, 20), url=url)))
                self.assertEqual(self.validate(raw), raw)

    def test_automatic_network_action_rejected_but_page_destination_allowed(self):
        self.reject(make_pdf(lambda w: w._root_object.update({NameObject('/OpenAction'): action('/URI', URI='https://example.org')})), '主动操作')
        raw = make_pdf(lambda w: w._root_object.update({NameObject('/OpenAction'): ArrayObject([w.pages[0].indirect_reference, NameObject('/Fit')])}))
        self.assertEqual(self.validate(raw), raw)

    def test_xfa_rich_media_and_external_streams_rejected(self):
        self.reject(make_pdf(lambda w: w._root_object.update({NameObject('/AcroForm'): DictionaryObject({NameObject('/XFA'): TextStringObject('xml')})})), '主动操作')
        self.reject(make_pdf(lambda w: w._add_object(DictionaryObject({NameObject('/Subtype'): NameObject('/RichMedia')}))), '主动操作')
        def external_stream(writer):
            stream = DecodedStreamObject(); stream.set_data(b'')
            stream[NameObject('/F')] = TextStringObject('external.bin')
            writer.pages[0][NameObject('/Contents')] = writer._add_object(stream)
        self.reject(make_pdf(external_stream), '主动操作')

    def test_action_names_in_text_do_not_trigger_raw_byte_false_positives(self):
        def content(writer):
            stream = DecodedStreamObject()
            stream.set_data(b'BT (/JavaScript /Launch /EmbeddedFiles in a research paper) Tj ET')
            writer.pages[0][NameObject('/Contents')] = writer._add_object(stream)
        raw = make_pdf(content)
        self.assertEqual(self.validate(raw), raw)

    def test_cyclic_page_tree_rejected_without_flattening(self):
        def cycle(writer):
            tree = writer._root_object['/Pages']
            tree[NameObject('/Kids')] = ArrayObject([writer._root_object.raw_get('/Pages')])
        self.reject(make_pdf(cycle), '完整有效')

    def test_nonpositive_page_geometry_rejected(self):
        def bad_box(writer):
            writer.pages[0][NameObject('/MediaBox')] = ArrayObject([NumberObject(0)] * 4)
        self.reject(make_pdf(bad_box), '完整有效')

    def test_selected_folder_assigned_under_lifecycle_lock(self):
        fid = self.folder('Reading')
        original_create = self.lib.create_from_pdf
        original_validate = Organization.validate_folder
        observed = []
        def create(*args, **kwargs):
            observed.append(('create', self.lib._lifecycle._is_owned()))
            self.assertTrue((self.lib.root / '.organization.lock').exists())
            return original_create(*args, **kwargs)
        def validate(organization, *args, **kwargs):
            observed.append(('validate', self.lib._lifecycle._is_owned()))
            self.assertTrue((self.lib.root / '.organization.lock').exists())
            return original_validate(organization, *args, **kwargs)
        with patch.object(self.lib, 'create_from_pdf', side_effect=create), patch.object(Organization, 'validate_folder', validate):
            result = imports.import_download(self.path, 'paper.pdf', self.lib, fid)
        ws = self.lib.ws(result['id'])
        self.assertEqual(assignment(Organization(self.lib).load(), paper_id(ws))['folder_id'], fid)
        self.assertTrue(all(held for _, held in observed), observed)
        self.assertEqual({operation for operation, _ in observed}, {'create', 'validate'})

    def test_folder_delete_waits_until_import_and_assignment_complete(self):
        fid = self.folder('Selected')
        started, attempted, acquired = threading.Event(), threading.Event(), threading.Event()
        errors, assignment_at_delete = [], []
        original_lock = organization_module.dir_lock
        original_create = self.lib.create_from_pdf
        @contextmanager
        def observed_lock(*args, **kwargs):
            deleting = threading.current_thread().name == 'delete-folder'
            if deleting:
                attempted.set()
            with original_lock(*args, **kwargs):
                if deleting:
                    acquired.set()
                    state = Organization(self.lib).load()
                    assignment_at_delete.append(assignment(state, hashlib.sha256(self.raw).hexdigest())['folder_id'])
                yield
        def delete():
            started.set()
            try:
                Organization(self.lib).delete_folder(fid)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=delete, name='delete-folder')
        def create(*args, **kwargs):
            thread.start()
            self.assertTrue(started.wait(2))
            self.assertTrue(attempted.wait(2))
            self.assertFalse(acquired.is_set())
            return original_create(*args, **kwargs)
        try:
            with patch.object(organization_module, 'dir_lock', observed_lock), patch.object(self.lib, 'create_from_pdf', side_effect=create):
                result = imports.import_download(self.path, 'paper.pdf', self.lib, fid)
                thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertTrue(result['fresh'])
            self.assertEqual(assignment_at_delete, [fid])
            self.assertTrue(Organization(self.lib).load()['folders'][fid]['deleted'])
        finally:
            if thread.ident is not None:
                thread.join(3)

    def test_missing_deleted_or_invalid_folder_creates_no_paper(self):
        deleted = self.folder('Deleted')
        Organization(self.lib).delete_folder(deleted)
        for fid in ('missing', deleted, {}, 42):
            with self.subTest(fid=fid), self.assertRaisesRegex(ValueError, '文件夹不存在'):
                imports.import_download(self.path, 'paper.pdf', self.lib, fid)
            self.assertEqual(self.lib.all(), [])

    def test_duplicate_retains_original_filename_folder_notes_and_translation(self):
        original_folder, other_folder = self.folder('Original'), self.folder('Other')
        first = imports.import_download(self.path, 'first.pdf', self.lib, original_folder)
        ws = self.lib.ws(first['id'])
        ws.update('paper', lambda p: p['blocks'].append({'id': 'p1', 'zh': '已翻译'}))
        ws.update('reader', lambda r: r['notes'].update({'n1': {'body': '保留笔记'}}))
        before = {path.name: path.read_bytes() for path in ws.root.iterdir()}
        org_before = Organization(self.lib).path.read_bytes()
        duplicate = imports.import_download(self.path, 'second.pdf', self.lib, other_folder)
        self.assertFalse(duplicate['fresh'])
        self.assertEqual(duplicate['id'], first['id'])
        self.assertIn('原有分类', duplicate['message'])
        self.assertEqual(before, {path.name: path.read_bytes() for path in ws.root.iterdir()})
        self.assertEqual(org_before, Organization(self.lib).path.read_bytes())
        self.assertEqual(len(self.lib.all()), 1)

    def test_duplicate_in_unfiled_stays_unfiled(self):
        first = imports.import_download(self.path, 'paper.pdf', self.lib)
        fid = self.folder('Selected')
        duplicate = imports.import_download(self.path, 'paper.pdf', self.lib, fid)
        self.assertFalse(duplicate['fresh'])
        self.assertIsNone(assignment(Organization(self.lib).load(), paper_id(self.lib.ws(first['id'])))['folder_id'])

    def test_no_url_query_fragment_or_browser_state_saved_in_metadata(self):
        result = imports.import_download(self.path, 'https://user:secret@proxy.edu/library/paper.pdf?session=secret-token#auth', self.lib)
        ws = self.lib.ws(result['id'])
        serialized = json.dumps(ws.load('paper'))
        self.assertEqual(ws.load('paper')['meta']['source'], 'paper.pdf')
        for forbidden in ('proxy.edu', 'secret', 'session', '#auth', 'https://'):
            self.assertNotIn(forbidden, serialized)
        for filename, expected in [(r'C:\Users\someone\article.PDF', 'article.pdf'), ('../../paper.pdf', 'paper.pdf'), ('\x00.pdf', 'paper.pdf'), (None, 'paper.pdf'), ('https://user:secret@proxy.edu', 'paper.pdf'), ('paper\u202e.pdf', 'paper.pdf')]:
            with self.subTest(filename=filename):
                self.assertEqual(imports.download_filename(filename), expected)

    def test_parser_exception_details_do_not_escape(self):
        with patch.object(imports, 'PdfReader', side_effect=RuntimeError('https://user:secret@publisher.example/token')):
            with self.assertRaisesRegex(ValueError, '完整有效') as error:
                imports.validate_pdf(self.path)
            self.assertNotIn('secret', str(error.exception))


if __name__ == '__main__':
    unittest.main()
