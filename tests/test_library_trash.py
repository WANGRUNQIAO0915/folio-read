import json
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.jobs import Jobs
from easyread.library import Library
from easyread.store import Workspace, write_json_atomic


class LibraryTrashTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.lib = Library(self.root / 'library')

    def tearDown(self):
        self.tmp.cleanup()

    def paper(self, pid='paper001'):
        ws = Workspace(self.lib.root / pid)
        ws.root.mkdir(exist_ok=True)
        write_json_atomic(ws.paper_path, {'meta': {'title_en': 'A test paper', 'source_sha256': pid + '-source'}, 'translation': {'done_pages': [1, 2]}})
        write_json_atomic(ws.reader_path, {'notes': {'n1': {'body': 'Keep this note'}}, 'progress': {'ratio': .6}})
        write_json_atomic(ws.item_path, {'tags': ['绿洲'], 'naming': {}, 'starred': True})
        (ws.root / 'source.pdf').write_bytes(b'%PDF test data')
        (ws.root / 'pages').mkdir(exist_ok=True)
        (ws.root / 'pages' / 'page-001.webp').write_bytes(b'test image')
        return ws

    def test_restore_preserves_all_files_and_external_source(self):
        ws = self.paper()
        original = self.root / 'original.pdf'
        original.write_bytes(b'%PDF external')
        expected = {p.relative_to(ws.root): p.read_bytes() for p in ws.root.rglob('*') if p.is_file()}
        organization = self.lib.root / 'organization.json'
        organization.write_text('{"folder":"绿洲"}', encoding='utf-8')
        deleted = self.lib.trash(ws.id)
        self.assertIsNone(self.lib.ws(ws.id))
        row = self.lib.trash_list()[0]
        self.assertEqual((row['paper_id'], row['done_pages'], row['notes']), (ws.id, 2, 1))
        self.assertEqual(self.lib.restore(deleted.name), ws.id)
        actual = {p.relative_to(ws.root): p.read_bytes() for p in ws.root.rglob('*') if p.is_file()}
        self.assertEqual(expected, actual)
        self.assertEqual(organization.read_text(encoding='utf-8'), '{"folder":"绿洲"}')
        self.assertEqual(original.read_bytes(), b'%PDF external')

    def test_same_second_deletions_have_distinct_entries_and_restore_does_not_overwrite(self):
        ws = self.paper()
        first = self.lib.trash(ws.id)
        self.paper()
        second = self.lib.trash(ws.id)
        self.assertNotEqual(first, second)
        self.lib.restore(first.name)
        with self.assertRaisesRegex(ValueError, '不能覆盖'):
            self.lib.restore(second.name)
        self.assertFalse(self.lib.trash_list()[0]['can_restore'])

    def test_legacy_trash_restore_marks_old_running_job_stopped(self):
        ws = self.paper()
        legacy = self.lib.root / '.trash' / (ws.id + '-20261005010000')
        legacy.parent.mkdir()
        write_json_atomic(ws.root / 'job.json', {'state': 'running', 'failed': {'3': 'timeout'}})
        ws.root.rename(legacy)
        self.assertEqual(self.lib.trash_list()[0]['paper_id'], ws.id)
        self.lib.restore(legacy.name)
        self.assertEqual(ws.load('job')['state'], 'cancelled')
        self.assertEqual(ws.load('job')['failed'], {'3': 'timeout'})

    def test_busy_guard_covers_cancelled_but_still_writing_worker(self):
        ws = self.paper()
        for state in ['queued', 'running']:
            write_json_atomic(ws.root / 'job.json', {'state': state})
            with self.assertRaisesRegex(ValueError, '取消任务'):
                self.lib.trash(ws.id)
        write_json_atomic(ws.root / 'job.json', {'state': 'cancelled'})
        with self.lib.activity(ws.id):
            with self.assertRaisesRegex(ValueError, '正在处理'):
                self.lib.trash(ws.id)
        with self.lib.activity():
            with self.assertRaises(ValueError):
                self.lib.trash(ws.id)
        self.lib.trash(ws.id)
        with self.assertRaises(KeyError):
            with self.lib.activity(ws.id):
                self.fail('Deleted workspace was acquired')

    def test_partial_batch_preserves_busy_paper_and_deduplicates(self):
        one, two = self.paper(), self.paper('paper002')
        write_json_atomic(two.root / 'job.json', {'state': 'running'})
        result = self.lib.trash_batch('delete', [one.id, two.id, one.id])['results']
        self.assertEqual([row['ok'] for row in result], [True, False])
        self.assertIsNotNone(self.lib.ws(two.id))

    def test_purge_is_scoped_and_remembers_local_removal_for_sync(self):
        ws = self.paper()
        path = self.lib.trash(ws.id)
        self.assertIn(ws.id + '-source', self.lib.trashed_ids())
        for value in ['../outside', '/outside', '', 'missing-entry']:
            with self.assertRaises(ValueError):
                self.lib.purge(value)
        self.lib.purge(path.name)
        self.assertFalse(path.exists())
        self.assertEqual(self.lib.trash_list(), [])
        self.assertIn(ws.id + '-source', self.lib.trashed_ids())

    def test_symlink_cannot_move_or_delete_external_directory(self):
        external = self.root / 'external'
        external.mkdir()
        write_json_atomic(external / 'paper.json', {'meta': {}})
        link = self.lib.root / 'paperlink'
        try:
            link.symlink_to(external, target_is_directory=True)
        except OSError:
            self.skipTest('Symlinks require OS permission')
        self.assertIsNone(self.lib.ws(link.name))
        self.assertEqual(self.lib.all(), [])
        ws = self.paper()
        trashed = self.lib.trash(ws.id)
        (trashed / 'external-link').symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.lib.purge(trashed.name)
        self.assertTrue((external / 'paper.json').exists())

    def test_worker_holds_workspace_until_last_save(self):
        ws = self.paper()
        write_json_atomic(ws.root / 'job.json', {'state': 'queued'})
        jobs = Jobs.__new__(Jobs)
        jobs.lib, jobs.bulk, jobs.cancels = self.lib, queue.Queue(), {}
        started, release = threading.Event(), threading.Event()
        def run(current, job, cancel):
            jobs._write(current, state='cancelled')
            started.set()
            release.wait(3)
            current.patch_item({'starred': False})
        jobs._run_bulk = run
        jobs.bulk.put(ws.id)
        worker = threading.Thread(target=jobs._bulk_loop, daemon=True)
        worker.start()
        self.assertTrue(started.wait(2))
        try:
            with self.assertRaises(ValueError):
                self.lib.trash(ws.id)
        finally:
            release.set()
        # The worker's final item write completed before releasing its lease.
        for _ in range(100):
            if not self.lib._active:
                break
            threading.Event().wait(.01)
        path = self.lib.trash(ws.id)
        self.assertFalse(json.loads((path / 'item.json').read_text(encoding='utf-8'))['starred'])
