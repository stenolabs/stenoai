"""Chat provider calls must include the chart contract without a real model."""
import unittest
from unittest.mock import Mock, patch

from src.chat_agent import system_prompt
from src.chat_charts import CHART_INSTRUCTIONS
from src.chat_query import build_prompt, build_prompt_parts
from src.summarizer import OllamaSummarizer


class ChatChartPromptTests(unittest.TestCase):
    def setUp(self):
        self.summarizer = OllamaSummarizer.__new__(OllamaSummarizer)
        self.summarizer.ollama_process = None
        self.summarizer.ai_provider = 'adapter'

    def test_streaming_query_includes_chart_contract_and_source(self):
        with patch.object(self.summarizer, '_adapter_stream', return_value=iter(['answer'])) as stream:
            self.assertEqual(list(self.summarizer.query_transcript_streaming(
                'Planning: 3 actions.', 'Chart the action items.'
            )), ['answer'])
        prompt = stream.call_args.args[0]
        self.assertIn(CHART_INSTRUCTIONS, prompt)
        self.assertIn('Planning: 3 actions.', prompt)
        self.assertIn('QUESTION: Chart the action items.', prompt)

    def test_oneshot_query_includes_same_contract(self):
        self.summarizer._adapter_chat = Mock(return_value='answer')
        self.assertEqual(self.summarizer.query_transcript('Review: 5 actions.', 'Chart it.'), 'answer')
        self.assertIn(CHART_INSTRUCTIONS, self.summarizer._adapter_chat.call_args.args[0])


class ChatScopeChartPromptTests(unittest.TestCase):
    """Every chat scope renders markdown, so every scope must carry the chart contract."""

    def setUp(self):
        self.config = Mock()
        self.config.get_ai_provider.return_value = 'local'
        self.config.get_model.return_value = 'gemma4:e2b'
        self.config.get_language.return_value = 'auto'

    def test_general_scope_prompt_includes_chart_contract(self):
        loader = Mock(side_effect=AssertionError('general chat must not load notes'))
        prompt = build_prompt({'scope': 'general', 'question': 'Chart UK GDP growth'}, self.config, loader, loader)
        self.assertIn(CHART_INSTRUCTIONS, prompt)
        self.assertIn('never say you cannot display or create charts', prompt)

    def test_every_scope_and_the_agent_prompt_include_chart_contract(self):
        note = {'summary': 'Planning: 3 actions.', 'transcript': 'We agreed three actions.'}
        for scope, extra in (('notes', {}), ('meeting', {'file': 'm.json'}), ('live', {'transcript': 'Now.'})):
            with patch('src.chat_query._load_saved_note', return_value=note):
                parts = build_prompt_parts({'scope': scope, 'question': 'Chart it', **extra},
                                           self.config, Mock(), Mock(return_value='Corpus'))
            self.assertIn(CHART_INSTRUCTIONS, parts['instructions'], scope)
            for with_tools in (True, False):
                self.assertIn(CHART_INSTRUCTIONS, system_prompt(parts, with_tools), scope)
