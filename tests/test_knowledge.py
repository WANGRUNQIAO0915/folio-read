import json
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread import config, engines, evidence, knowledge, research, study
from easyread.library import Library
from easyread.store import Workspace, write_json_atomic


class KnowledgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patches = [patch.object(config, 'HOME', self.root), patch.object(config, 'CONFIG_PATH', self.root / 'config.json')]
        for p in self.patches:
            p.start()
        self.lib = Library(self.root / 'library')
        self.one = self.paper('cooling-one', 'Urban vegetation reduced temperature by 2 degrees.', '城市植被使温度降低 2 度。', ['气候'])
        self.two = self.paper('cooling-two', 'Green space cooling depends on spatial scale.', '绿地降温取决于空间尺度。', ['气候'])
        self.other = self.paper('robot-paper', 'The robot uses reinforcement learning.', '机器人使用强化学习。', ['机器人'])

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def paper(self, pid, en, zh='', tags=None):
        ws = Workspace(self.lib.root / pid)
        ws.root.mkdir()
        write_json_atomic(ws.paper_path, {'meta': {'title_en': pid}, 'translation': {'done_pages': [1]},
                                         'blocks': [{'id': 'p1', 'type': 'para', 'page': 1, 'en': en, 'zh': zh}]})
        write_json_atomic(ws.item_path, {'tags': tags or []})
        return ws

    def task(self, question='降温与空间尺度', **options):
        return knowledge.scope(self.lib, {'question': question, **options})

    def test_scope_covers_more_than_eight_papers_and_category_is_respected(self):
        for i in range(10):
            self.paper('extra-paper-' + str(i), 'Vegetation provides cooling.')
        sources, task = study.prepare(self.lib, {'mode': 'knowledge', 'question': '降温'})
        self.assertEqual(len(task['papers']), 13)
        self.assertEqual(sources, [])
        result, report = knowledge.retrieve(self.lib, self.task(category='气候'), ['cooling', 'vegetation'])
        self.assertEqual({s['paper'] for s in result}, {'cooling-one', 'cooling-two'})
        self.assertEqual(report['scope_papers'], 2)

    def test_english_only_paper_is_found_with_bilingual_expansion(self):
        self.one.update('paper', lambda p: p['blocks'][0].update(zh=''))
        result, _ = knowledge.retrieve(self.lib, self.task('植被降温'), ['urban vegetation', 'cooling'])
        self.assertIn('cooling-one', {s['paper'] for s in result})

    def test_unrelated_query_has_no_random_paper_fallback(self):
        result, report = knowledge.retrieve(self.lib, self.task('xylophonequasar'))
        self.assertEqual(result, [])
        self.assertEqual(report['selected_passages'], 0)

    def test_index_incrementally_updates_changes_additions_and_deletions(self):
        first = knowledge.sync(self.lib)
        self.assertEqual(first['updated'], 3)
        self.assertEqual(knowledge.sync(self.lib)['updated'], 0)
        self.one.update('paper', lambda p: p['blocks'][0].update(en='Special evapotranspiration mechanism.', zh=''))
        self.paper('new-paper', 'A distinct evapotranspiration result.')
        shutil.rmtree(self.two.root)
        result, report = knowledge.retrieve(self.lib, self.task('evapotranspiration'))
        self.assertEqual({s['paper'] for s in result}, {'cooling-one', 'new-paper'})
        self.assertEqual(report['papers'], 3)
        self.assertEqual(report['updated'], 2)

    def test_notes_are_optional_and_are_never_labelled_paper_facts(self):
        write_json_atomic(self.one.reader_path, {'notes': {'n1': {'anchor': 'p1', 'body': 'My microclimate observation.'},
                                                          'deleted': {'body': 'Secret deleted note.', 'deleted': True}},
                                                'paper_note': {'body': 'My evapotranspiration idea.'}})
        result, _ = knowledge.retrieve(self.lib, self.task('microclimate'))
        note = next(s for s in result if s['type'] == 'reader_note')
        raw = {'sections': [{'title': '结果', 'claims': [{'text': '错误地称为论文结论', 'kind': 'source',
                                                       'citations': [{'id': note['id'], 'quote': note['zh']}]}]}]}
        checked = knowledge.validate(raw, result, self.task())['sections'][0]['claims'][0]
        self.assertEqual(checked['kind'], 'note')
        self.assertEqual(checked['citations'][0]['origin'], '我的笔记')
        self.assertEqual(checked['citations'][0]['note_id'], 'n1')
        excluded, _ = knowledge.retrieve(self.lib, self.task('microclimate', include_notes=False))
        self.assertEqual(excluded, [])
        deleted, _ = knowledge.retrieve(self.lib, self.task('Secret deleted'))
        self.assertEqual(deleted, [])

    def test_saved_note_provenance_is_checked_after_edit(self):
        write_json_atomic(self.one.reader_path, {'notes': {'n1': {'anchor': 'p1', 'body': 'Microclimate observation.'}}})
        sources, _ = knowledge.retrieve(self.lib, self.task('Microclimate'))
        src = next(s for s in sources if s['type'] == 'reader_note')
        checked = evidence.verify_claim({'text': '笔记', 'kind': 'source', 'citations': [{'id': src['id'], 'quote': src['zh']}]}, sources)
        topic = research.topic_save({'title': '笔记证据'})
        research.record_save({'topic': topic['id'], 'text': '笔记', '_evidence': checked['citations']})
        self.assertFalse(research.view(self.lib)['records'][0]['evidence'][0]['unresolved'])
        self.one.update('reader', lambda p: p['notes']['n1'].update(body='Updated note.'))
        self.assertTrue(research.view(self.lib)['records'][0]['evidence'][0]['unresolved'])

    def test_untranslated_extracted_pages_are_searchable(self):
        extract = self.other.root / 'extract'
        extract.mkdir()
        (extract / 'page-002.txt').write_text('Independent transferability validation.', encoding='utf-8')
        sources, _ = knowledge.retrieve(self.lib, self.task('transferability'))
        self.assertTrue(any(s['page'] == 2 and '?source_page=2' in s['url'] for s in sources))

    def test_missing_quote_cannot_be_saved_as_a_paper_fact(self):
        sources, _ = knowledge.retrieve(self.lib, self.task('cooling'))
        raw = {'sections': [{'claims': [{'text': 'Fabrication', 'kind': 'source', 'citations': [{'id': 'E999', 'quote': 'fake'}]}]}]}
        checked = knowledge.validate(raw, sources, self.task())['sections'][0]['claims'][0]
        self.assertEqual(checked['kind'], 'uncertain')
        self.assertEqual(checked['citations'], [])

    def test_general_knowledge_is_labelled_and_strict_mode_downgrades_it(self):
        raw = {'sections': [{'title': '补充', 'claims': [{'text': 'General background.', 'kind': 'general'}]}]}
        allowed = knowledge.validate(raw, [], self.task())
        strict = knowledge.validate(raw, [], self.task(allow_general=False))
        self.assertEqual(allowed['sections'][-1]['claims'][0]['kind'], 'general')
        self.assertEqual(strict['sections'][-1]['claims'][0]['kind'], 'uncertain')
        self.assertEqual(allowed['sections'][0]['title'], '库内检索结果')
        self.assertIn('不得使用', knowledge.prompt([], self.task(allow_general=False)))

    def test_invalid_options_and_empty_category_are_rejected(self):
        with self.assertRaises(ValueError):
            self.task(include_notes='false')
        with self.assertRaises(ValueError):
            self.task(category='不存在')
        with self.assertRaises(ValueError):
            self.task('')

    def test_query_punctuation_cannot_break_sql_and_expansion_failure_is_visible(self):
        knowledge.retrieve(self.lib, self.task('" OR * - cooling ; DROP TABLE papers'))
        with patch.object(engines, 'run', side_effect=RuntimeError('offline')):
            terms, warning = knowledge.expand('降温', {}, self.root)
        self.assertEqual(terms, [])
        self.assertTrue(warning)
        event = threading.Event()
        event.set()
        with self.assertRaises(engines.Cancelled):
            knowledge.sync(self.lib, event)

    def test_background_answer_automatically_retrieves_multiple_papers_and_persists(self):
        tasks = study.Tasks(self.lib)
        def respond(cfg, text, cwd, images, cancel):
            if '"terms"' in text:
                return '{"terms":["cooling","urban vegetation"]}'
            sources = json.loads(text.split('收藏资料：\n')[1])
            claims = [{'text': s['en'], 'kind': 'source', 'citations': [{'id': s['id'], 'quote': s['en']}]} for s in sources]
            claims.append({'text': 'General background.', 'kind': 'general'})
            return json.dumps({'sections': [{'title': '回答', 'claims': claims}]})
        try:
            with patch.object(engines, 'run', side_effect=respond):
                run = tasks.submit({'mode': 'knowledge', 'question': '降温机制'})
                tasks.pool.shutdown(wait=True)
            saved = study.saved(run['id'])
            self.assertEqual(saved['state'], 'done', saved.get('message'))
            self.assertEqual(saved['retrieval']['selected_papers'], 2)
            claims = saved['result']['sections'][0]['claims']
            self.assertTrue(all(c['citations'] for c in claims if c['kind'] == 'source'))
            self.assertEqual(claims[-1]['kind'], 'general')
            self.assertEqual(study.history()[0]['mode'], 'knowledge')
        finally:
            tasks.pool.shutdown(wait=True)


if __name__ == '__main__':
    unittest.main()
