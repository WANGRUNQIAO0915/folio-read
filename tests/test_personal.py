import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import chat_models, config, personal, search
from easyread.build import build
from easyread.library import Library
from easyread.store import Workspace, write_json_atomic
from easyread.validation import batch_problems


class PersonalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = patch.object(config, "HOME", self.root)
        self.home.start()

    def tearDown(self):
        self.home.stop()
        self.tmp.cleanup()

    def test_explicit_glossary_overrides_paper_and_profile(self):
        personal.save({"profile": "geo", "glossary": [{"en": "Land Cover", "zh": "我的译法"}], "goal": "测试目标"})
        terms = {t["en"].casefold(): t["zh"] for t in personal.glossary([{"en": "land cover", "zh": "模型译法"}])}
        self.assertEqual(terms["land cover"], "我的译法")
        self.assertEqual(terms["remote sensing"], "遥感")
        self.assertIn("测试目标", personal.reading_context())
        self.assertNotIn("api_key", personal.load())

    def test_invalid_settings_do_not_replace_saved_preferences(self):
        personal.save({"goal": "保留内容"})
        with self.assertRaises(ValueError):
            personal.save({"glossary": [{"en": "empty", "zh": ""}]})
        self.assertEqual(personal.load()["goal"], "保留内容")

    def test_chat_follows_selected_translation_model(self):
        cfg = {"engine": "openai", "openai": {"preset": "deepseek", "model": "deepseek-chat", "api_key": "test-only"}, "chat": {"default": "translation"}}
        selected, model = chat_models.engine_cfg(cfg, None)
        self.assertEqual(selected["openai"], cfg["openai"])
        self.assertTrue(model["follow_translation"])
        self.assertNotIn("api_key", model)

    def make_ws(self):
        ws = Workspace(self.root / "library" / "test-paper")
        ws.root.mkdir(parents=True)
        write_json_atomic(ws.paper_path, {"meta": {"title_en": "Study"}, "blocks": [
            {"id": "p2-1", "type": "para", "page": 2, "en": "spatial leakage", "zh": "空间泄漏"}]})
        return ws

    def test_search_finds_body_and_notes_with_source_anchors(self):
        ws = self.make_ws()
        write_json_atomic(ws.reader_path, {"notes": {"n1": {"anchor": "p2-1", "body": "独立验证样本"},
                                                       "n2": {"body": "已删除秘密", "deleted": True}}})
        lib = Library(self.root / "library")
        hit = search.find(lib, "空间泄漏")["matches"][0]["hits"][0]
        self.assertEqual((hit["anchor"], hit["page"]), ("p2-1", 2))
        self.assertEqual(search.find(lib, "独立验证")["matches"][0]["hits"][0]["kind"], "笔记")
        self.assertEqual(search.find(lib, "已删除秘密")["matches"], [])

    def test_search_finds_multithread_chat_and_reports_corrupt_files(self):
        ws = self.make_ws()
        write_json_atomic(ws.root / "chat.json", {"threads": [{"messages": [{"role": "assistant", "content": "跨区验证"}]}]})
        lib = Library(self.root / "library")
        self.assertTrue(search.find(lib, "跨区验证")["matches"])
        ws.paper_path.write_text("broken json", encoding="utf-8")
        result = search.find(lib, "任意")
        self.assertEqual(result["errors"][0]["id"], ws.id)

    def test_export_blocks_path_escape_and_includes_conversations(self):
        ws = self.make_ws()
        ws.update("paper", lambda p: p["blocks"].append({"id": "bad", "type": "figure", "src": "../../personal.json"}))
        with self.assertRaises(ValueError):
            build(ws)
        ws.update("paper", lambda p: p.__setitem__("blocks", p["blocks"][:1]))
        write_json_atomic(ws.root / "chat.json", {"threads": [{"title": "对话测试", "messages": [{"role": "assistant", "content": "需保留的回答"}]}]})
        self.assertIn("需保留的回答", build(ws).read_text(encoding="utf-8"))

    def test_batch_coverage_rejects_missing_and_unrequested_pages(self):
        data = {"blocks": [{"id": "p1", "type": "para", "page": 1, "zh": "译文"}]}
        self.assertTrue(batch_problems(data, [1, 2]))
        self.assertTrue(batch_problems(data, [2]))
        self.assertEqual(batch_problems(data, [1]), [])
        self.assertEqual(batch_problems({"blocks": [{"id": "refs", "type": "references", "page": 3}]}, [3]), [])


if __name__ == "__main__":
    unittest.main()
