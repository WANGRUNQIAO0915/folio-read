import tempfile
import unittest
from pathlib import Path

from easyread.library import Library
from easyread.store import Workspace, empty_reader, write_json_atomic


class ReadingStatusTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lib = Library(Path(self.tmp.name))
        root = self.lib.root / "paper-test"
        root.mkdir()
        self.ws = Workspace(root)
        write_json_atomic(root / "paper.json", {"meta": {}, "blocks": []})
        write_json_atomic(root / "reader.json", empty_reader())
        write_json_atomic(root / "item.json", {"status": "unread"})

    def tearDown(self):
        self.tmp.cleanup()

    def status(self):
        return self.lib.summary(self.ws)["status"]

    def progress(self, at="2026-10-02T01:00:00Z", active=True):
        return {"op": "progress", "at": at, "block": "intro", "ratio": .02, "active": active}

    def test_legacy_progress_is_reading(self):
        reader = empty_reader()
        reader["progress"] = {"block": "intro", "ratio": .02}
        write_json_atomic(self.ws.reader_path, reader)
        self.assertEqual(self.status(), "reading")

    def test_opening_at_header_keeps_unread(self):
        self.ws.apply_reader_ops([{"op": "progress", "block": "head", "ratio": 0}])
        self.assertEqual(self.status(), "unread")

    def test_manual_unread_survives_restoration(self):
        self.ws.apply_reader_ops([self.progress()])
        self.ws.patch_item({"status": "unread"})
        self.ws.apply_reader_ops([self.progress("2026-10-02T02:00:00Z", active=False)])
        self.assertEqual(self.status(), "unread")

    def test_intentional_reading_promotes_manual_unread(self):
        self.ws.patch_item({"status": "unread"})
        self.ws.apply_reader_ops([self.progress()])
        self.assertEqual(self.status(), "reading")
        self.assertEqual(self.ws.load("item")["status"], "reading")

    def test_completed_status_is_preserved(self):
        self.ws.patch_item({"status": "done"})
        self.ws.apply_reader_ops([self.progress()])
        self.assertEqual(self.status(), "done")

    def test_stale_or_replayed_progress_cannot_change_manual_unread(self):
        self.ws.apply_reader_ops([self.progress("2026-10-02T03:00:00Z")])
        self.ws.patch_item({"status": "unread"})
        self.ws.apply_reader_ops([self.progress("2026-10-02T02:00:00Z")])
        self.ws.apply_reader_ops([self.progress("2026-10-02T03:00:00Z")])
        self.assertEqual(self.status(), "unread")

    def test_progress_without_timestamp_still_promotes(self):
        op = self.progress()
        del op["at"]
        self.ws.apply_reader_ops([op])
        self.assertEqual(self.ws.load("item")["status"], "reading")


if __name__ == "__main__":
    unittest.main()
