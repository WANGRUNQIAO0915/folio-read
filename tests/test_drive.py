import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import portable as P
from easyread.drive import Drive, _protect
from easyread.library import Library
from easyread.store import Workspace, empty_reader, write_json_atomic


class DriveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.lib = Library(self.home / 'library')
        self.drive = Drive(self.home, self.lib)
        self.note = dict(id='n-1', body='初稿', updated='2026-10-02T09:00:00+08:00', anchor='intro', quote='测试')
        self.reader = dict(empty_reader(), notes={'n-1': self.note})
        root = self.lib.root / 'test-paper'; root.mkdir()
        self.ws = Workspace(root)
        write_json_atomic(self.ws.paper_path, dict(meta={'source_sha256': 'a'*64, 'title_zh': '测试'}, blocks=[dict(id='intro', type='para', zh='测试')]))
        write_json_atomic(self.ws.reader_path, self.reader)
        write_json_atomic(self.ws.item_path, {})

    def tearDown(self):
        self.tmp.cleanup()

    def test_conflict_and_resolution(self):
        a = P.cloud_op(self.reader, dict(op='note', note=dict(self.note, body='手机', updated='2026-10-02T01:10:00Z')), 'a')
        b = P.cloud_op(self.reader, dict(op='note', note=dict(self.note, body='电脑', updated='2026-10-02T09:20:00+08:00')), 'b')
        merged = P.materialize([self.reader], [b, a, a])
        self.assertEqual(merged['notes']['n-1']['body'], '电脑')
        self.assertEqual(merged['notes']['n-1']['_syncConflicts'][0]['body'], '手机')
        note = dict(merged['notes']['n-1'], updated='2026-10-02T01:30:00Z'); del note['_syncConflicts']
        event = P.cloud_op(merged, dict(op='note', note=note, resolve_conflicts=True), 'resolved')
        self.assertNotIn('_syncConflicts', P.materialize([self.reader], [event, a, b])['notes']['n-1'])
        deleted = P.cloud_op(self.reader, dict(op='note_del', id='n-1', at='2026-10-02T01:25:00Z'), 'del')
        tombstone = P.materialize([self.reader], [deleted])['notes']['n-1']
        self.assertTrue(tombstone['deleted']); self.assertNotIn('_syncConflicts', tombstone)

    def test_credentials_excluded_and_dpapi(self):
        data = self.drive.bundle(self.ws)
        data['config'] = {'api_key': 'secret'}; data['paper']['meta']['api_key'] = 'secret'; data['reader']['_cloud'] = {'token': 'secret'}
        self.assertNotIn('secret', json.dumps(P.normalize(data)))
        if os.name == 'nt':
            secret = b'private refresh token'; encrypted = _protect(secret)
            self.assertNotIn(secret, encrypted); self.assertEqual(_protect(encrypted, True), secret)
        self.drive.cfg['client_secret'] = 'secret'
        self.assertNotIn('secret', json.dumps(self.drive.status()))

    def test_pagination_and_account_boundary(self):
        with patch.object(self.drive, 'request', side_effect=[{'files':[{'id':'1'}],'nextPageToken':'page2'},{'files':[{'id':'2'}]}]) as request:
            self.assertEqual([f['id'] for f in self.drive.list_files()], ['1','2'])
            self.assertIn('pageToken=page2', request.call_args[0][0])
        self.drive.account = {'permissionId': 'new'}
        self.reader['_cloud'] = dict(enabled=True, account='old', pending=[])
        write_json_atomic(self.ws.reader_path, self.reader)
        with patch.object(self.drive, 'identify'), patch.object(self.drive, 'list_files', return_value=[]), patch.object(self.drive, 'upload') as upload:
            with self.assertRaisesRegex(ValueError, '另一 Google'):
                self.drive.sync()
            upload.assert_not_called()

    def test_account_cannot_escape_cache_directory(self):
        for key in ('../outside', 'C:/outside', '', None):
            with self.subTest(key=key), patch.object(self.drive, 'request', return_value={'user': {'permissionId': key}}):
                with self.assertRaises(ValueError):
                    self.drive.identify()
                self.assertIsNone(self.drive.account)

    def test_sync_keeps_edits_during_upload(self):
        self.drive.account = {'permissionId':'acct'}
        self.drive.select([self.ws.id])
        original = self.drive.bundle(self.ws)
        file = dict(id='cloud1', modifiedTime='2026-10-02T02:00:00Z', appProperties=dict(folioType='paper', folioPaperId=original['paper_id']))
        uploaded = []
        def upload(name, data, props, parent):
            if props['folioType'] == 'ops':
                uploaded.extend(data['ops'])
                self.ws.apply_reader_ops([dict(op='note', note=dict(self.note, body='上传中的修改', updated='2026-10-02T02:30:00Z'))])
            return dict(file, appProperties=props)
        with patch.object(self.drive, 'identify'), patch.object(self.drive, 'list_files', return_value=[file]), patch.object(self.drive, 'folder', return_value='folder'), patch.object(self.drive, 'upload', side_effect=upload), patch.object(self.drive, 'download', return_value=original), patch.object(self.drive, 'events', side_effect=lambda files, pid: uploaded):
            self.drive.sync()
        result = self.ws.load('reader')
        self.assertEqual(result['notes']['n-1']['body'], '上传中的修改')
        self.assertEqual(len(result['_cloud']['pending']), 1)
        self.assertNotIn('_syncConflicts', result['notes']['n-1'])

    def test_python_matches_browser_protocol(self):
        node = shutil.which('node') or ('C:/Users/Administrator/nodejs/node-v22.23.2-win-x64/node.exe' if os.name == 'nt' else '')
        if not node or not Path(node).exists():
            self.skipTest('Node unavailable')
        a = P.cloud_op(self.reader, dict(op='note', note=dict(self.note, body='手机', updated='2026-10-02T01:10:00Z')), 'a')
        b = P.cloud_op(self.reader, dict(op='note', note=dict(self.note, body='电脑', updated='2026-10-02T09:20:00+08:00')), 'b')
        data = dict(bases=[self.reader], events=[a,b])
        code = "const C=require('./easyread/web/mobile/core.js');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const d=JSON.parse(s);process.stdout.write(JSON.stringify({notes:C.materialize(d.bases,d.events).notes,version:C.canonical(d.bases[0].notes['n-1']),fields:C.FIELDS}));});"
        result = json.loads(subprocess.check_output([str(node), '-e', code], input=json.dumps(data).encode(), cwd=Path(__file__).parents[1]))
        self.assertEqual(result['notes'], P.materialize(data['bases'],data['events'])['notes'])
        self.assertEqual(result['version'], P.canonical(self.note)); self.assertEqual(result['fields'], P.FIELDS)


if __name__ == '__main__':
    unittest.main()
