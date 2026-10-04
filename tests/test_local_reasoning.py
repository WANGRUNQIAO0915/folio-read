import io
import json
import unittest
from unittest.mock import patch

from easyread import engines


class LocalReasoningTest(unittest.TestCase):
    def request_body(self, preset, effort):
        config = {'preset': preset, 'model': 'test-model', 'base_url': 'http://127.0.0.1:8080/v1',
                  'api_key': '', 'reasoning_effort': effort}
        response = {'choices': [{'message': {'content': '{"ok":true}'}, 'finish_reason': 'stop'}]}
        with patch('easyread.engines.urllib.request.urlopen', return_value=io.BytesIO(json.dumps(response).encode())) as request:
            engines.run_openai(config, 'test', [])
            return json.loads(request.call_args.args[0].data)

    def test_llamacpp_translation_disables_reasoning_per_request(self):
        self.assertEqual(self.request_body('llamacpp', 'none')['reasoning_effort'], 'none')

    def test_model_default_has_no_override(self):
        self.assertNotIn('reasoning_effort', self.request_body('llamacpp', ''))

    def test_other_providers_do_not_receive_llamacpp_parameters(self):
        self.assertNotIn('reasoning_effort', self.request_body('deepseek', 'none'))
