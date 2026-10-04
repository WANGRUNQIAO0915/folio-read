"""Folder/assignment protocol, migration, portable and mocked Drive regressions."""
import copy
import hashlib
import itertools
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import organization as O, portable as P
from easyread.drive import Drive
from easyread.library import Library
from easyread.store import Workspace, empty_reader, write_json_atomic


def v(at='2026-10-04T03:00:00.000Z', event='a'):
    return {'at': at, 'id': event}


class OrganizationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.lib = Library(self.home / 'library')
        self.ws = Workspace(self.lib.root / 'test-paper'); self.ws.root.mkdir()
        write_json_atomic(self.ws.paper_path, {'meta': {'source_sha256': 'a'*64, 'title_en': 'Paper'}, 'blocks': [{'id': 'b1', 'type': 'para', 'en': 'Evidence'}]})
        write_json_atomic(self.ws.item_path, {'tags': ['Existing'], 'status': 'reading', 'starred': True})
        write_json_atomic(self.ws.reader_path, dict(empty_reader(), notes={'n1': {'id': 'n1', 'body': 'Private note', 'updated': '2026-10-04T01:00:00Z'}}))
        (self.ws.root / 'source.pdf').write_bytes(b'%PDF-1.7 fixture')
        self.org = O.Organization(self.lib)

    def tearDown(self):
        self.tmp.cleanup()

    def folder(self, label='Methods'):
        state = self.org.folder(label)
        return next(f['id'] for f in state['folders'].values() if f['name'] == label)

    def test_legacy_migration_preserves_many_long_tags_and_reader(self):
        labels = ['label-' + str(i) for i in range(25)] + ['X'*100]
        self.ws.patch_item({'status': 'read'})
        write_json_atomic(self.ws.item_path, {'tags': labels})
        self.assertEqual(self.lib.list()[0]['tags'], labels)
        self.assertFalse(self.org.path.exists())
        self.org.folder('Empty folder')
        self.assertEqual(self.org.load()['assignments']['a'*64]['tags'], labels)
        self.assertEqual(self.ws.load('reader')['notes']['n1']['body'], 'Private note')

    def test_create_rename_delete_does_not_move_pdf_or_touch_notes(self):
        original = {p.name: p.read_bytes() for p in self.ws.root.iterdir()}
        fid = self.folder()
        self.org.assign([{'paper_id': self.ws.id, 'folder_id': fid, 'tags': ['Method']}])
        self.org.folder('Renamed', fid)
        self.assertEqual(self.lib.list()[0]['folder_id'], fid)
        self.org.delete_folder(fid)
        self.assertIsNone(self.lib.list()[0]['folder_id'])
        self.assertEqual(self.lib.list()[0]['tags'], ['Method'])
        self.assertTrue(O.Organization(Library(self.lib.root)).load()['folders'][fid]['deleted'])
        self.org.delete_folder(fid)  # Idempotent deletion does not create new version.
        self.assertEqual(original, {p.name: p.read_bytes() for p in self.ws.root.iterdir()})

    def test_assignment_validation_is_atomic_and_stale_guarded(self):
        initial = self.org.load()
        with self.assertRaises(ValueError):
            self.org.assign([{'paper_id': self.ws.id, 'folder_name': 'Not created', 'tags': []}, {'paper_id': 'unknown', 'tags': []}])
        self.assertEqual(initial, self.org.load())
        prior = O.assignment(initial, 'a'*64)['version']
        state = self.org.assign([{'paper_id': self.ws.id, 'folder_name': 'Same', 'tags': ['x'], 'expected_version': prior}])
        fid = O.assignment(state, 'a'*64)['folder_id']
        state = self.org.assign([{'paper_id': self.ws.id, 'folder_name': ' same ', 'tags': ['y']}])
        self.assertEqual(fid, O.assignment(state, 'a'*64)['folder_id'])
        with self.assertRaisesRegex(ValueError, '更新'):
            self.org.assign([{'paper_id': self.ws.id, 'folder_id': None, 'tags': [], 'expected_version': prior}])
        self.assertEqual(state, self.org.load())
        for rows in ([], [{'paper_id': self.ws.id, 'tags': 'x'}], [{'paper_id': self.ws.id, 'tags': ['x']*501}], [{'paper_id': self.ws.id, 'folder_id': 'missing'}], [{'paper_id': self.ws.id}, {'paper_id': 'a'*64}]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.org.assign(rows)

    def test_old_item_tags_flow_into_assignment_without_erasing_folder(self):
        fid = self.folder()
        self.org.assign([{'paper_id': self.ws.id, 'folder_id': fid, 'tags': ['new']}])
        self.ws.patch_item({'tags': ['manual'], 'starred': False})
        result = self.lib.list()[0]
        self.assertEqual((result['tags'], result['folder_id']), (['manual'], fid))
        self.ws.patch_item({'status': 'read'})
        self.assertEqual(self.lib.list()[0]['tags'], ['manual'])

    def test_merge_commutative_associative_idempotent_and_delete_wins(self):
        a = {'schema': 1, 'folders': {'f': {'id': 'f', 'name': 'Original', 'deleted': False, 'version': v()}}, 'assignments': {'p': {'folder_id': 'f', 'tags': ['a'], 'version': v()}}}
        b = copy.deepcopy(a); b['folders']['f'].update(name='Renamed', version=v('2030-01-01T00:00:00Z', 'z')); b['assignments']['p'].update(tags=['b'], version=v(event='b'))
        c = copy.deepcopy(a); c['folders']['f'].update(deleted=True, version=v(event='c')); c['assignments']['other'] = {'folder_id': None, 'tags': ['other'], 'version': v()}
        expected = O.merge(a, b, c)
        for states in itertools.permutations([a, b, c]):
            self.assertEqual(O.merge(*states), expected)
        self.assertEqual(O.merge(expected, expected), expected)
        self.assertEqual(O.merge(O.merge(a, b), c), O.merge(a, O.merge(b, c)))
        self.assertTrue(expected['folders']['f']['deleted'])
        self.assertIsNone(O.assignment(expected, 'p')['folder_id'])
        self.assertEqual(expected['assignments']['p']['tags'], ['b'])

    def test_portable_optional_schema_preserves_notes_and_strips_secrets(self):
        fid = self.folder()
        self.org.assign([{'paper_id': self.ws.id, 'folder_id': fid, 'tags': ['portable']}])
        drive = Drive(self.home, self.lib)
        with patch('easyread.links.for_reader', return_value=self.ws.load('paper')):
            data = drive.bundle(self.ws)
        self.assertEqual(data['organization']['assignments']['a'*64]['folder_id'], fid)
        self.assertEqual(data['item']['tags'], ['portable'])
        data['organization']['api_key'] = 'secret'
        data['organization']['folders'][fid]['token'] = 'secret'
        clean = P.normalize(data)
        self.assertNotIn('secret', json.dumps(clean))
        self.assertEqual(clean['reader']['notes'], data['reader']['notes'])
        del data['organization']
        self.assertNotIn('organization', P.normalize(data))
        changed = copy.deepcopy(clean); changed['organization']['assignments']['a'*64]['tags'] = ['changed']; changed['item']['tags'] = ['changed']
        self.assertEqual(drive.content_hash(clean), drive.content_hash(changed))

    def test_corrupt_disk_state_never_overwritten(self):
        for raw in ('not json', '{"schema":99,"folders":{},"assignments":{}}'):
            self.org.path.write_text(raw)
            with self.assertRaises(ValueError):
                self.org.folder('New')
            self.assertEqual(self.org.path.read_text(), raw)

    def test_search_and_knowledge_use_live_tags_without_touching_content(self):
        from easyread import search, knowledge
        before = self.ws.item_path.read_bytes()
        self.org.assign([{'paper_id': self.ws.id, 'tags': ['LiveCategory']}])
        self.assertEqual(search.find(self.lib, 'LiveCategory')['matches'][0]['id'], self.ws.id)
        self.assertEqual(search.find(self.lib, 'Existing')['matches'], [])
        self.assertEqual(knowledge.scope(self.lib, {'question': 'What?', 'category': 'LiveCategory'})['papers'], [self.ws.id])
        with self.assertRaises(ValueError):
            knowledge.scope(self.lib, {'question': 'What?', 'category': 'Existing'})
        self.assertEqual(before, self.ws.item_path.read_bytes())

    def test_portable_export_only_includes_referenced_folder(self):
        fid = self.folder('Included')
        other = self.folder('Private unrelated project')
        self.org.assign([{'paper_id': self.ws.id, 'folder_id': fid}])
        state = self.org.load()
        self.assertIn(other, O.subset(state, ['a'*64])['folders'])
        self.assertEqual(list(O.export_subset(state, ['a'*64])['folders']), [fid])
        self.org.delete_folder(fid)
        portable = O.export_subset(self.org.load(), ['a'*64])
        self.assertTrue(portable['folders'][fid]['deleted'])
        self.assertIsNone(O.assignment(portable, 'a'*64)['folder_id'])
        self.assertNotIn(other, portable['folders'])

    def test_empty_organization_sync_does_not_bind_account(self):
        write_json_atomic(self.ws.item_path, {'tags': []})
        drive = Drive(self.home, self.lib); drive.account = {'permissionId': 'first'}
        with patch.object(drive, 'upload') as upload:
            drive._sync_organization([])
            self.assertFalse((self.lib.root / '.organization-account.json').exists())
            drive.account = {'permissionId': 'second'}
            drive._sync_organization([])
            upload.assert_not_called()
        self.folder('Now real metadata')
        with patch.object(drive, 'folder', return_value='root'), patch.object(drive, 'upload', return_value={'id': 's', 'appProperties': {'folioType': 'organization'}}):
            drive._sync_organization([])
        self.assertEqual(json.loads((self.lib.root / '.organization-account.json').read_text())['account'], 'second')

    def test_two_device_sync_converges_without_content_or_note_loss(self):
        self.ws.root.joinpath('source.pdf').unlink()
        home2 = self.home / 'second'; home2.mkdir()
        lib2 = Library(home2 / 'library'); shutil.copytree(self.ws.root, lib2.root / self.ws.id)
        ws2 = lib2.ws(self.ws.id)
        other = ws2.load('paper'); other['blocks'][0]['zh'] = 'Concurrent translation'; write_json_atomic(ws2.paper_path, other)
        ws2.apply_reader_ops([{'op': 'note', 'note': {'id': 'n2', 'body': 'Phone note', 'updated': '2026-10-04T04:00:00Z'}}])
        fid = self.folder('Shared')
        self.org.assign([{'paper_id': self.ws.id, 'folder_id': fid, 'tags': ['Desktop']}])
        org2 = O.Organization(lib2); org2.merge(self.org.load()); org2.assign([{'paper_id': ws2.id, 'tags': ['Phone']}])
        drives = [Drive(self.home, self.lib), Drive(home2, lib2)]
        files, payloads, calls = [], {}, []
        def upload(filename, data, props, parent):
            calls.append(props['folioType'])
            file = {'id': 'cloud-' + str(len(files)), 'modifiedTime': '2026-10-04T05:00:00Z', 'appProperties': props}
            files.append(file); payloads[file['id']] = copy.deepcopy(data)
            return copy.deepcopy(file)
        from contextlib import ExitStack
        with ExitStack() as stack:
            for drive in drives:
                drive.account = {'permissionId': 'acct'}
                for method, options in [('identify', {}), ('list_files', {'side_effect': lambda: copy.deepcopy(files)}), ('upload', {'side_effect': upload}),
                                        ('download', {'side_effect': lambda f: copy.deepcopy(payloads[f['id']])}), ('folder', {'return_value': 'root'}),
                                        ('upload_source', {}), ('source_bytes', {'return_value': None}), ('import_folder_pdfs', {'return_value': (0, [])})]:
                    stack.enter_context(patch.object(drive, method, **options))
            drives[0].sync(); drives[1].sync(); drives[0].sync()
            self.assertEqual(self.org.load(), org2.load())
            self.assertEqual(self.lib.list()[0]['tags'], ['Phone'])
            self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], 'Concurrent translation')
            self.assertEqual(set(self.ws.load('reader')['notes']), {'n1', 'n2'})
            papers_before = calls.count('paper')
            indexes_before = calls.count('index')
            self.org.delete_folder(fid)
            drives[0].sync(); drives[1].sync()
            self.assertEqual(calls.count('paper'), papers_before)
            self.assertEqual(calls.count('index'), indexes_before)
            self.assertIsNone(lib2.list()[0]['folder_id'])
            self.assertEqual(self.org.load(), org2.load())

    def _upgrade_legacy_hash_flow(self, change_tags=False, missing_baseline=False):
        self.ws.root.joinpath('source.pdf').unlink()
        paper = self.ws.load('paper'); paper['blocks'][0]['zh'] = 'Previously translated'; write_json_atomic(self.ws.paper_path, paper)
        drive = Drive(self.home, self.lib); drive.account = {'permissionId': 'acct'}
        original = drive.bundle(self.ws); original.pop('organization', None)
        reader = self.ws.load('reader')
        reader['_cloud'] = {'account': 'acct', 'enabled': True, 'synced_once': True, 'content_hash': drive.legacy_content_hash(original)}
        write_json_atomic(self.ws.reader_path, reader)
        if change_tags == 'item':
            self.ws.patch_item({'tags': ['New local category']})
        elif change_tags:
            self.org.assign([{'paper_id': self.ws.id, 'tags': ['New local category']}])
        remote = copy.deepcopy(original); remote['paper']['blocks'][0]['zh'] = 'Updated on old phone'
        remote_file = {'id': 'old-client-new-content', 'appProperties': {'folioType': 'paper', 'folioPaperId': 'a'*64, 'folioContent': drive.legacy_content_hash(remote)}}
        old_file = {'id': 'old-baseline', 'modifiedTime': '2026-10-03T00:00:00Z', 'appProperties': {'folioType': 'paper', 'folioPaperId': 'a'*64, 'folioContent': drive.legacy_content_hash(original)}}
        remote_file['modifiedTime'] = '2026-10-04T00:00:00Z'
        files = [remote_file] if missing_baseline else [old_file, remote_file]
        uploaded = []
        def upload(filename, data, props, parent):
            uploaded.append(props['folioType'])
            return {'id': 'index', 'appProperties': props}
        with patch.object(drive, 'identify'), patch.object(drive, 'list_files', return_value=files), patch.object(drive, 'download', side_effect=lambda f: original if f['id'] == 'old-baseline' else remote), \
                patch.object(drive, 'events', return_value=[]), patch.object(drive, 'upload_source'), patch.object(drive, 'source_bytes', return_value=None), \
                patch.object(drive, 'folder', return_value='root'), patch.object(drive, 'upload', side_effect=upload), patch.object(drive, 'pull', wraps=drive.pull) as pull:
            if missing_baseline:
                with self.assertRaisesRegex(ValueError, '基线缺失'):
                    drive._sync_workspace(self.ws, files)
                self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], 'Previously translated')
                self.assertNotIn('paper', uploaded)
                return
            drive._sync_workspace(self.ws, files)
            self.assertEqual(pull.call_count, 1)
            self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], 'Updated on old phone')
            self.assertNotIn('paper', uploaded)
            drive._sync_workspace(self.ws, files)
            self.assertEqual(pull.call_count, 1)  # Legacy remote hashes do not cause an endless pull loop.
            if change_tags:
                self.assertEqual(self.lib.list()[0]['tags'], ['New local category'])

    def test_upgrade_legacy_hash_pulls_new_remote_translation_without_overwrite(self):
        self._upgrade_legacy_hash_flow()

    def test_upgrade_legacy_hash_preserves_local_classification_and_remote_translation(self):
        self._upgrade_legacy_hash_flow(change_tags=True)

    def test_upgrade_legacy_hash_recovers_baseline_after_old_item_tag_patch(self):
        self._upgrade_legacy_hash_flow(change_tags='item')

    def test_upgrade_missing_baseline_never_overwrites_ambiguous_remote_content(self):
        self._upgrade_legacy_hash_flow(change_tags='item', missing_baseline=True)

    def test_remote_arriving_mid_sync_is_pulled_on_next_sync(self):
        self.ws.root.joinpath('source.pdf').unlink()
        paper = self.ws.load('paper'); paper['blocks'][0]['zh'] = 'Original body'; write_json_atomic(self.ws.paper_path, paper)
        drive = Drive(self.home, self.lib); drive.account = {'permissionId': 'acct'}
        original = drive.bundle(self.ws); original_hash = drive.content_hash(original)
        updated = copy.deepcopy(original); updated['paper']['blocks'][0]['zh'] = 'Arrived during sync'
        old_file = {'id': 'a', 'modifiedTime': '2026-10-03T00:00:00Z', 'appProperties': {'folioType': 'paper', 'folioPaperId': 'a'*64, 'folioContent': original_hash}}
        new_file = {'id': 'b', 'modifiedTime': '2026-10-04T00:00:00Z', 'appProperties': {'folioType': 'paper', 'folioPaperId': 'a'*64, 'folioContent': drive.content_hash(updated)}}
        reader = self.ws.load('reader'); reader['_cloud'] = {'account': 'acct', 'enabled': True, 'synced_once': True, 'content_hash': original_hash, 'remote_content_hash': original_hash}
        write_json_atomic(self.ws.reader_path, reader)
        fresh = [old_file, new_file]
        with patch.object(drive, 'identify'), patch.object(drive, 'list_files', return_value=fresh), patch.object(drive, 'download', side_effect=lambda f: original if f['id'] == 'a' else updated), \
                patch.object(drive, 'events', return_value=[]), patch.object(drive, 'upload_source'), patch.object(drive, 'source_bytes', return_value=None), \
                patch.object(drive, 'folder', return_value='root'), patch.object(drive, 'upload', return_value={'id': 'index', 'appProperties': {'folioType': 'index'}}), patch.object(drive, 'pull', wraps=drive.pull) as pull:
            drive._sync_workspace(self.ws, [old_file])
            self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], 'Original body')
            self.assertEqual(self.ws.load('reader')['_cloud']['remote_content_hash'], original_hash)
            drive._sync_workspace(self.ws, fresh)
            self.assertEqual(pull.call_count, 1)
            self.assertEqual(self.ws.load('paper')['blocks'][0]['zh'], 'Arrived during sync')

    def test_python_javascript_merge_parity(self):
        if not shutil.which('node'):
            self.skipTest('Node unavailable')
        states = [{'schema': 1, 'folders': {'folder': {'id': 'folder', 'name': ' 文献 📚 ', 'version': v(), 'deleted': False}}, 'assignments': {'p': {'folder_id': 'folder', 'tags': ['A', 'a', ' x '*30], 'version': v(event='😀')}}},
                  {'schema': 1, 'folders': {'folder': {'id': 'folder', 'name': ' 文献 📚 ', 'version': v(), 'deleted': True}}, 'assignments': {'p': {'folder_id': None, 'tags': ['B'], 'version': v(event='z')}}}]
        code = "const O=require('./easyread/web/js/common/organization.js');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(O.merge(...JSON.parse(s)))));"
        result = json.loads(subprocess.check_output(['node', '-e', code], input=json.dumps(states).encode(), cwd=Path(__file__).parents[1]))
        self.assertEqual(result, O.merge(*states))

    def test_drive_empty_folder_snapshot_merge_retry_and_account_boundary(self):
        fid = self.folder('Empty')
        drive = Drive(self.home, self.lib); drive.account = {'permissionId': 'acct'}
        drive.cfg['sync_all'] = False
        files, payloads = [], {}
        def upload(filename, data, props, parent):
            result = {'id': 'file-' + str(len(files)), 'appProperties': props}
            payloads[result['id']] = copy.deepcopy(data)
            return result
        with patch.object(drive, 'folder', return_value='root'), patch.object(drive, 'upload', side_effect=upload) as send, patch.object(drive, 'download', side_effect=lambda f: payloads[f['id']]):
            drive._sync_organization(files)
            self.assertEqual(send.call_count, 1)
            self.assertEqual(payloads[files[0]['id']]['organization']['assignments'], {})
            self.assertIn(fid, payloads[files[0]['id']]['organization']['folders'])
            drive._sync_organization(files)
            self.assertEqual(send.call_count, 1)
            remote = O.normalize(payloads[files[0]['id']]['organization'])
            remote['folders'][fid].update(deleted=True, version=v('2030-01-01T00:00:00Z'))
            files.append({'id': 'remote', 'appProperties': {'folioType': 'organization'}})
            payloads['remote'] = {'schema': 1, 'kind': 'folio-organization', 'organization': remote}
            drive._sync_organization(files)
            self.assertTrue(self.org.load()['folders'][fid]['deleted'])
            drive.account = {'permissionId': 'other'}
            with self.assertRaisesRegex(ValueError, '另一 Google'):
                drive._sync_organization(files)

    def test_drive_snapshot_upload_race_keeps_local_change_for_next_sync(self):
        fid = self.folder()
        drive = Drive(self.home, self.lib); drive.account = {'permissionId': 'acct'}
        uploaded = []
        def upload(filename, data, props, parent):
            uploaded.append(copy.deepcopy(data))
            self.org.folder('Updated during upload', fid)
            return {'id': 'snapshot', 'appProperties': props}
        with patch.object(drive, 'folder', return_value='root'), patch.object(drive, 'upload', side_effect=upload):
            drive._sync_organization([])
        self.assertEqual(uploaded[0]['organization']['folders'][fid]['name'], 'Methods')
        self.assertEqual(self.org.load()['folders'][fid]['name'], 'Updated during upload')


if __name__ == '__main__':
    unittest.main()
