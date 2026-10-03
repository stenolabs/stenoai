"""Chat provider calls must include the chart contract without a real model."""
import unittest
from unittest.mock import Mock, patch

from src.chat_charts import CHART_INSTRUCTIONS
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
