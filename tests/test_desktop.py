import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from easyread.desktop import data_home, existing_server, run_desktop


class DesktopDataTests(unittest.TestCase):
    def test_uses_existing_source_data_without_copying(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {}, clear=True):
            root = Path(directory)
            for name in ('easyread-personal', 'folio-personal', 'folio-read', 'FolioRead'):
                with self.subTest(name=name):
                    project = root / name
                    (project / 'library').mkdir(parents=True)
                    (project / 'pyproject.toml').write_text('[project]', encoding='utf-8')
                    self.assertEqual(data_home(root), project.resolve())
                    (project / 'library').rmdir()
                    (project / 'pyproject.toml').unlink()
                    project.rmdir()

    def test_standalone_data_stays_beside_exe_and_override_wins(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {}, clear=True):
            root = Path(directory)
            self.assertEqual(data_home(root), (root / 'FolioRead数据').resolve())
            self.assertEqual(data_home(root, str(root / 'selected')), (root / 'selected').resolve())

    def test_rebrand_keeps_existing_standalone_library(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict('os.environ', {}, clear=True):
            root = Path(directory)
            for name in ('EasyRead数据', 'Folio数据', 'FolioRead数据'):
                with self.subTest(name=name):
                    legacy = root / name
                    (legacy / 'library').mkdir(parents=True)
                    self.assertEqual(data_home(root), legacy.resolve())
                    (legacy / 'library').rmdir()
                    legacy.rmdir()

    def test_server_marker_cannot_send_requests_outside_localhost(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for url in ['https://example.com', 'http://localhost:8766', 'http://user:secret@127.0.0.1:8766', 'http://127.0.0.1:8766/other']:
                (root / '.server.json').write_text(json.dumps({'url': url}), encoding='utf-8')
                with patch('urllib.request.urlopen') as request:
                    self.assertIsNone(existing_server(root))
                    request.assert_not_called()

    def test_valid_local_server_reused_and_other_apps_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.server.json').write_text(json.dumps({'url': 'http://127.0.0.1:8766'}), encoding='utf-8')
            for payload, expected in [({'items': [], 'version': '1.0', 'token': 'test'}, 'http://127.0.0.1:8766'), ({'name': 'another app'}, None)]:
                with patch('urllib.request.urlopen', return_value=io.BytesIO(json.dumps(payload).encode())):
                    self.assertEqual(existing_server(root), expected)


class DesktopLifecycleTests(unittest.TestCase):
    def test_repeated_launch_activates_existing_window(self):
        kernel = MagicMock()
        with patch('easyread.desktop.acquire_mutex', return_value=(kernel, 1, True)), \
             patch('easyread.desktop.activation_event', return_value=2), \
             patch('easyread.desktop.create_window') as create, \
             patch('easyread.desktop.start_server') as start:
            self.assertEqual(run_desktop(Path('example')), 0)
        kernel.SetEvent.assert_called_once_with(2)
        create.assert_not_called()
        start.assert_not_called()
        self.assertEqual(kernel.CloseHandle.call_count, 2)

    def test_reused_source_service_belongs_to_source_process(self):
        kernel = MagicMock()
        with patch('easyread.desktop.acquire_mutex', return_value=(kernel, 1, False)), \
             patch('easyread.desktop.activation_event', return_value=2), \
             patch('easyread.desktop.existing_server', return_value='http://127.0.0.1:8766'), \
             patch('easyread.desktop.create_window', return_value=MagicMock()) as create, \
             patch('easyread.desktop.start_window') as gui, \
             patch('easyread.desktop.start_server') as start, \
             patch('easyread.desktop.stop_server') as stop:
            self.assertEqual(run_desktop(Path('example')), 0)
        create.assert_called_once_with(Path('example'), 'http://127.0.0.1:8766')
        gui.assert_called_once()
        start.assert_not_called()
        stop.assert_not_called()

    def test_owned_service_stops_even_when_window_start_fails(self):
        kernel, server, app = MagicMock(), MagicMock(), MagicMock()
        with patch('easyread.desktop.acquire_mutex', return_value=(kernel, 1, False)), \
             patch('easyread.desktop.activation_event', return_value=2), \
             patch('easyread.desktop.existing_server', return_value=None), \
             patch('easyread.desktop.create_window', return_value=MagicMock()), \
             patch('easyread.desktop.start_server', return_value=(server, app, 'http://127.0.0.1:10000')), \
             patch('easyread.desktop.start_window', side_effect=RuntimeError('window failed')), \
             patch('easyread.desktop.stop_server') as stop:
            with self.assertRaisesRegex(RuntimeError, 'window failed'):
                run_desktop(Path('example'))
        stop.assert_called_once_with(server, app)
        self.assertEqual(kernel.CloseHandle.call_count, 2)
