import io
import json
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from easyread import config, engines, evidence, research, study
from easyread.library import Library
from easyread.store import Workspace, write_json_atomic


class StudyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.patches = [patch.object(config, 'HOME', self.root), patch.object(config, 'CONFIG_PATH', self.root/'config.json')]
        for p in self.patches:
            p.start()
        self.lib = Library(self.root/'library')
        self.ws = self.make_paper('paper-one', 'Accuracy was 85% with 20 samples.', '准确率为 85%，样本量为 20。')
        self.other = self.make_paper('paper-two', 'Accuracy was 70% on a different dataset.', '另一数据集准确率为 70%。')

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def make_paper(self, pid, en, zh):
        ws = Workspace(self.lib.root/pid)
        ws.root.mkdir()
        write_json_atomic(ws.paper_path, {'meta': {'title_en': pid, 'authors': 'A. One, B. Two', 'doi': '10.1000/test', 'pages': [{'n':1,'img':'pages/one.jpg'}]},
                                          'translation': {'done_pages':[1]}, 'blocks': [
            {'id':'s1','type':'heading','page':1,'en':'Results','zh':'结果'},
            {'id':'p1','type':'para','page':1,'en':en,'zh':zh},
            {'id':'eq1','type':'math','page':1,'tex':'x = 1','tag':'1'}]})
        return ws

    def claim(self, src, text='论文报告该结果'):
        return {'text':text,'kind':'source','citations':[{'id':src['id'],'quote':src['en']}]}

    def test_exact_quotes_and_unknown_citations_are_checked(self):
        src = evidence.numbered(evidence.passages(self.ws))[1]
        claim = evidence.verify_claim(self.claim(src), [src])
        self.assertEqual(claim['kind'], 'source')
        self.assertEqual(claim['citations'][0]['page'], 1)
        bad = self.claim(src)
        bad['citations'][0]['quote'] = 'The model proved universal superiority.'
        result = evidence.verify_claim(bad, [src])
        self.assertEqual(result['kind'], 'uncertain')
        self.assertEqual(result['citations'], [])

    def test_translation_quote_is_labelled_as_translation(self):
        src = evidence.numbered(evidence.passages(self.ws))[1]
        claim = self.claim(src)
        claim['citations'][0]['quote'] = src['zh']
        self.assertEqual(evidence.verify_claim(claim,[src])['citations'][0]['origin'],'译文')

    def test_paper_facts_without_evidence_become_uncertain(self):
        claim = evidence.verify_claim({'text':'假定事实','kind':'source'},[])
        self.assertEqual(claim['kind'],'uncertain')

    def test_note_blocks_are_not_paper_evidence(self):
        self.ws.update('paper', lambda p:p['blocks'].append({'id':'ai','type':'note','page':1,'zh':'AI 推测'}))
        self.assertNotIn('ai',[s['anchor'] for s in evidence.passages(self.ws)])

    def test_long_passage_tail_and_untranslated_pages_are_available(self):
        self.ws.update('paper',lambda p:p['blocks'].append({'id':'long','type':'para','page':1,'en':'a'*5000+' distinctive_tail'}))
        extract=self.ws.root/'extract';extract.mkdir()
        (extract/'page-002.txt').write_text('Untranslated independent validation.',encoding='utf-8')
        items=evidence.passages(self.ws)
        self.assertTrue(any('distinctive_tail' in s['en'] for s in items))
        self.assertTrue(any(s['page']==2 and '?source_page=2' in s['url'] for s in items))

    def test_section_filter_and_visual_neighbours(self):
        items=evidence.passages(self.ws)
        self.assertTrue(all(s['section']=='s1' for s in evidence.select(items,'','section','s1')))
        self.assertIn('eq1',[s['anchor'] for s in evidence.select(items,'','visual',asset='eq1')])

    def test_parent_section_includes_subsections(self):
        self.ws.update('paper',lambda p:p['blocks'].extend([
            {'id':'s1-1','type':'heading','page':1,'level':2,'en':'Details','zh':'细节'},
            {'id':'detail','type':'para','page':1,'en':'Nested argument.'}]))
        items=evidence.select(evidence.passages(self.ws),'','section','s1')
        self.assertIn('detail',[s['anchor'] for s in items])

    def test_overview_includes_abstract_body(self):
        self.ws.update('paper',lambda p:p['blocks'].insert(1,{'id':'abstract','type':'para','page':1,'role':'abstract','en':'Essential research question.'}))
        self.assertIn('abstract',[s['anchor'] for s in evidence.select(evidence.passages(self.ws),'','overview')])

    def test_page_level_reading_works_without_translated_headings(self):
        extract=self.other.root/'extract';extract.mkdir()
        (extract/'page-002.txt').write_text('Important text on page two.',encoding='utf-8')
        sources,task=study.prepare(self.lib,{'mode':'section','papers':['paper-two'],'section':'page:2'})
        self.assertTrue(sources)
        self.assertTrue(all(s['page']==2 for s in sources))

    def test_saved_quotes_are_marked_when_source_changes(self):
        topic=research.topic_save({'title':'来源变化'})
        src=evidence.numbered(evidence.passages(self.ws))[1]
        claim=evidence.verify_claim(self.claim(src),[src])
        research.record_save({'topic':topic['id'],'text':claim['text'],'_evidence':claim['citations']})
        self.assertFalse(research.view(self.lib)['records'][0]['evidence'][0]['unresolved'])
        self.ws.update('paper',lambda p:p['blocks'][1].update(en='Replaced source text.',zh='更新了'))
        self.assertTrue(research.view(self.lib)['records'][0]['evidence'][0]['unresolved'])
        extract=self.other.root/'extract';extract.mkdir()
        page=extract/'page-002.txt'
        page.write_text('Original extracted page text.',encoding='utf-8')
        raw=next(s for s in evidence.numbered(evidence.passages(self.other)) if s['type']=='raw')
        checked=evidence.verify_claim(self.claim(raw),[raw])
        research.record_save({'topic':topic['id'],'text':checked['text'],'_evidence':checked['citations']})
        self.assertFalse(research.view(self.lib)['records'][-1]['evidence'][0]['unresolved'])
        page.write_text('New page text without the old quote.',encoding='utf-8')
        self.assertTrue(research.view(self.lib)['records'][-1]['evidence'][0]['unresolved'])

    def test_compare_requires_two_distinct_papers(self):
        with self.assertRaises(ValueError):
            study.prepare(self.lib,{'mode':'compare','papers':['paper-one','paper-one'],'question':'比较'})

    def test_comparison_cannot_cite_another_paper_in_cell(self):
        sources,task=study.prepare(self.lib,{'mode':'compare','papers':['paper-one','paper-two'],'question':'比较准确率'})
        one=next(s for s in sources if s['paper']=='paper-one' and s['anchor']=='p1')
        raw={'sections':[{'title':'比较','claims':[self.claim(one)]}],
             'rows':[{'dimension':'结果','cells':[{'paper':'paper-two',**self.claim(one)}]}]}
        checked=study.validate(raw,sources,task)
        self.assertTrue(all(c['kind']=='uncertain' for c in checked['rows'][0]['cells']))

    def test_crop_bounds_and_path_escape(self):
        (self.ws.root/'pages').mkdir()
        Image.new('RGB',(200,100),'white').save(self.ws.root/'pages/one.jpg')
        raw=study.image_bytes(self.ws,'eq1',[.1,.1,.9,.9])
        self.assertEqual(Image.open(io.BytesIO(raw)).size,(160,80))
        with self.assertRaises(ValueError):study.image_bytes(self.ws,'eq1',[-1,0,1,1])
        self.ws.update('paper',lambda p:p['blocks'].append({'id':'bad','type':'figure','page':1,'src':'../../config.json'}))
        with self.assertRaises(ValueError):study.image_bytes(self.ws,'bad')

    def test_pinned_result_keeps_verified_source_and_is_idempotent(self):
        sources,task=study.prepare(self.lib,{'mode':'question','papers':['paper-one'],'question':'样本量'})
        src=next(s for s in sources if s['anchor']=='p1')
        rid='run-'+'a'*16
        write_json_atomic(study.run_dir()/(rid+'.json'),{'id':rid,'state':'done','result':{'sections':[{'claims':[evidence.verify_claim(self.claim(src),sources)]}]}})
        topic=research.topic_save({'title':'测试主题'})
        body={'run':rid,'path':'sections:0:0','topic':topic['id']}
        a,b=study.pin(body),study.pin(body)
        self.assertEqual(a['id'],b['id'])
        self.assertEqual(a['evidence'][0]['paper'],'paper-one')
        self.assertEqual(len(research.load()['records']),1)

    def test_reader_notes_import_preserves_other_notes_and_deduplicates(self):
        write_json_atomic(self.ws.reader_path,{'notes':{'n':{'anchor':'p1','body':'我的判断'},'del':{'body':'不要导出','deleted':True}},'paper_note':{'body':'整篇笔记'}})
        topic=research.topic_save({'title':'测试'})
        self.assertEqual(research.collect_reader(self.ws,topic['id']),2)
        self.assertEqual(research.collect_reader(self.ws,topic['id']),0)
        self.assertNotIn('不要导出',json.dumps(research.load(),ensure_ascii=False))

    def test_obsidian_bundle_and_ris_include_quotes_and_provenance(self):
        topic=research.topic_save({'title':'研究/主题','question':'方法有效吗'})
        src=evidence.numbered(evidence.passages(self.ws))[1]
        claim=evidence.verify_claim(self.claim(src),[src])
        research.record_save({'topic':topic['id'],'text':claim['text'],'kind':'source','_evidence':claim['citations']})
        raw=research.export_bundle(topic['id'],self.lib,'http://127.0.0.1:8766')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertIsNone(archive.testzip())
            self.assertIn('研究-主题.md',archive.namelist())
            text=archive.read('研究-主题.md').decode()
            self.assertIn(src['en'],text)
            self.assertIn('#b-p1',text)
            ris=archive.read('Zotero-研究笔记.ris').decode()
            self.assertIn('DO  - 10.1000/test',ris)
            self.assertIn('N1  -',ris)

    def test_zotero_unavailable_has_actionable_fallback(self):
        with patch('urllib.request.urlopen',side_effect=OSError('offline')):
            result=research.zotero_search('test')
        self.assertFalse(result['available'])
        self.assertIn('RIS',result['message'])

    def test_background_task_persists_checked_results(self):
        tasks=study.Tasks(self.lib)
        sources,_=study.prepare(self.lib,{'mode':'question','papers':['paper-one'],'question':'准确率'})
        src=next(s for s in sources if s['anchor']=='p1')
        output=json.dumps({'sections':[{'title':'结果','claims':[self.claim(src)]}]})
        try:
            with patch.object(engines,'run',return_value=output):
                task=tasks.submit({'mode':'question','papers':['paper-one'],'question':'准确率'})
                tasks.pool.shutdown(wait=True)
            result=study.saved(task['id'])
            self.assertEqual(result['state'],'done')
            self.assertEqual(result['result']['sections'][0]['claims'][0]['kind'],'source')
            self.assertEqual(study.history('paper-one')[0]['id'],task['id'])
        finally:
            tasks.pool.shutdown(wait=True)

    def test_cancellation_is_persisted(self):
        tasks=study.Tasks(self.lib)
        started=threading.Event()
        def blocking(cfg,text,cwd,images,cancel):
            started.set()
            cancel.wait(3)
            raise engines.Cancelled()
        try:
            with patch.object(engines,'run',side_effect=blocking):
                task=tasks.submit({'mode':'question','papers':['paper-one'],'question':'准确率'})
                self.assertTrue(started.wait(2))
                tasks.cancel(task['id']);tasks.pool.shutdown(wait=True)
            self.assertEqual(study.saved(task['id'])['state'],'cancelled')
        finally:
            tasks.pool.shutdown(wait=True)


if __name__=='__main__':unittest.main()
