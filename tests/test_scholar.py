import json
import os
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from unittest.mock import patch

from easyread.scholar import Scholar, clean_rank, parse_result, visible_rank
from easyread.library import Library
from easyread import portable
from easyread.store import Workspace, write_json_atomic


class ScholarTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.lib = Library(self.home / 'library')
        self.scholar = Scholar(self.home, self.lib)
        self.key = 'test-secret-never-export-1234567890'
        self.scholar.configure({'secret_key': self.key})
        self.result = parse_result({'code':200, 'data':{'officialRank':{'all':{'sci':'Q1','sciif':'12.3','sciUp':'1区','unknown':'ignore'}}}}, 'Journal A & B')

    def tearDown(self):
        self.tmp.cleanup()

    def test_key_local_and_status_redacted(self):
        self.assertNotIn(self.key, json.dumps(self.scholar.status()))
        self.assertNotIn(self.key, self.scholar.cfg_path.read_text())
        if os.name == 'nt':
            self.assertNotIn(self.key.encode(), self.scholar.key_path.read_bytes())
        self.assertEqual(self.scholar._key(),self.key)
        self.scholar.configure({'clear_key':True})
        self.assertFalse(self.scholar.status()['configured'])

    def test_cache_account_separation_and_rate(self):
        with patch.object(self.scholar, '_fetch', return_value=self.result) as fetch, patch('easyread.scholar.time.sleep') as sleep, patch('easyread.scholar.time.monotonic', return_value=100):
            self.scholar.query('Journal A & B')
            self.scholar.query('Journal A & B')
            self.assertEqual(fetch.call_count,1)
            self.scholar.query('Journal A & B',force=True)
            self.assertAlmostEqual(sleep.call_args[0][0],.6)
            self.scholar.configure({'secret_key':'different-account-secret'})
            self.scholar.query('Journal A & B')
            self.assertEqual(fetch.call_count,3)
        self.assertNotIn(self.key,self.scholar.cache_path.read_text())

    def test_url_encoding_and_network_error_redaction(self):
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'{"code":200,"data":{}}'
        with patch('easyread.scholar.urllib.request.urlopen',return_value=Response()) as request:
            self.scholar._fetch(self.key,'A & B / 中文')
            params=parse_qs(urlparse(request.call_args[0][0].full_url).query)
            self.assertEqual(params['publicationName'],['A & B / 中文'])
        with patch('easyread.scholar.urllib.request.urlopen',side_effect=OSError('https://secretKey='+self.key)):
            with self.assertRaises(ValueError) as exc:self.scholar._fetch(self.key,'Test')
            self.assertNotIn(self.key,str(exc.exception))

    def test_custom_and_malformed_provider_result(self):
        rank=parse_result({'code':200,'data':{'customRank':{'rankInfo':[{'uuid':'abc-123','abbName':'我的目录','threeRankText':'A类'}],'rank':['abc-123&&&3']}}},'Test')
        self.assertEqual(rank['metrics'][0]['value'],'A类')
        for payload in ({'code':40002,'msg':self.key},{'code':200,'data':{'officialRank':'bad'}},{'code':200,'data':{'customRank':{'rank':{}}}}):
            with self.assertRaises(ValueError):parse_result(payload,'Test')
        self.assertEqual(clean_rank({'source':'easyScholar','publication':'Test','metrics':{}})['metrics'],[])

    def test_venue_changes_and_preprints(self):
        self.assertIsNone(visible_rank({'venue':'Wrong journal','journal_rank':self.result}))
        for name in ('arXiv','arXiv: 1234.56789','bioRxiv','', 'OpenReview'):
            with self.assertRaises(ValueError):self.scholar.query(name)

    def test_portable_nested_allowlist_and_library_display(self):
        ws=Workspace(self.lib.root/'test-paper');ws.root.mkdir()
        write_json_atomic(ws.paper_path,{'meta':{'venue':'Journal A & B'},'blocks':[]})
        with patch.object(self.scholar,'query',return_value=self.result):self.scholar.lookup(ws)
        self.assertEqual(self.lib.summary(ws)['journal_rank'],self.result)
        paper=ws.load('paper');paper['meta']['journal_rank'].update(secret_key=self.key,raw={'secretKey':self.key})
        data=portable.normalize({'paper_id':ws.id,'paper':paper})
        self.assertNotIn(self.key,json.dumps(data))
        self.assertEqual(data['paper']['meta']['journal_rank'],self.result)

    def test_provider_cannot_echo_secret_into_export(self):
        payload={'code':200,'data':{'officialRank':{'all':{'sciif':self.key}}}}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return json.dumps(payload).encode()
        with patch('easyread.scholar.urllib.request.urlopen',return_value=Response()):
            with self.assertRaisesRegex(ValueError,'未保存'):self.scholar._fetch(self.key,'Test')
