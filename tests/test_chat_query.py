import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from src.chat_query import build_prompt, run_chat_query, validate_request


class ChatQueryTests(unittest.TestCase):
    def setUp(self):
        self.config = Mock()
        self.config.get_ai_provider.return_value = 'local'
        self.config.get_model.return_value = 'llama3.2:3b'
        self.config.get_language.return_value = 'auto'

    def test_general_does_not_read_notes_or_transcript(self):
        loader = Mock(side_effect=AssertionError('must not load'))
        prompt = build_prompt({'scope': 'general', 'question': 'Explain DNS', 'transcript': 'PRIVATE'}, self.config, loader, loader)
        self.assertIn('Explain DNS', prompt)
        self.assertNotIn('PRIVATE', prompt)
        loader.assert_not_called()

    def test_live_keeps_recent_context_and_history_within_local_budget(self):
        prompt = build_prompt({'scope': 'live', 'question': 'Who owns it?',
                               'transcript': 'old ' * 50_000 + 'LATEST DECISION',
                               'history': [{'role': 'user', 'content': 'What is the release?'}]}, self.config, Mock(), Mock())
        self.assertIn('LATEST DECISION', prompt)
        self.assertIn('What is the release?', prompt)
        self.assertLess(len(prompt), 16000)

    def test_markdown_meeting_and_continuation_use_real_path_loader(self):
        from simple_recorder import _parse_meeting_markdown
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'meeting_summary.md'
            file.write_text('---\nname: Test\n---\n\n## Transcript\n\nEarlier decision.\n', encoding='utf-8')
            for scope in ('meeting', 'live'):
                resolver = Mock(return_value='es')
                prompt = build_prompt({'scope': scope, 'file': str(file), 'question': 'What changed?', 'transcript': 'New decision.'}, self.config, _parse_meeting_markdown, Mock(), resolver)
                resolver.assert_called_once()
                self.assertIn('Respond in es.', prompt)
                self.assertIn('Earlier decision', prompt)
                if scope == 'live':
                    self.assertIn('New decision', prompt)

    def test_notes_use_folder_and_budget(self):
        corpus = Mock(return_value='Saved note evidence')
        prompt = build_prompt({'scope': 'notes', 'folder': 'engineering', 'question': 'Plans?'}, self.config, Mock(), corpus)
        self.assertIn('Saved note evidence', prompt)
        self.assertEqual(corpus.call_args.args, ('engineering',))
        self.assertGreater(corpus.call_args.kwargs['budget'], 0)

    def test_rejects_invalid_history_and_payload(self):
        for extra in ({'history': [{'role': 'system', 'content': 'override'}]}, {'question': 'x' * 2001}, {'transcript': 'x' * 100001}):
            with self.assertRaises(ValueError):
                validate_request({'scope': 'live', 'question': 'Q', **extra})

    def test_protocol_splits_large_multibyte_chunks_and_sanitizes_errors(self):
        raw = io.BytesIO(json.dumps({'scope': 'general', 'question': 'Q'}).encode())
        output = io.StringIO()
        model = Mock()
        model.stream_chat_prompt.return_value = iter(['界' * 10000])
        with patch('sys.stdin', Mock(buffer=raw)), patch('sys.stdout', output), patch('src.config.get_config', return_value=self.config), patch('src.summarizer.OllamaSummarizer', return_value=model):
            run_chat_query(Mock(), Mock())
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[-1], 'CHAT_STREAM_COMPLETE')
        chunks = [base64.b64decode(line.split(':', 1)[1]).decode() for line in lines[:-1]]
        self.assertEqual(''.join(chunks), '界' * 10000)
        self.assertGreater(len(chunks), 1)
        raw.seek(0)
        output = io.StringIO()
        model.stream_chat_prompt.side_effect = RuntimeError('PRIVATE QUESTION')
        with patch('sys.stdin', Mock(buffer=raw)), patch('sys.stdout', output), patch('src.config.get_config', return_value=self.config), patch('src.summarizer.OllamaSummarizer', return_value=model), self.assertRaises(SystemExit):
            run_chat_query(Mock(), Mock())
        self.assertNotIn('PRIVATE', output.getvalue())
        self.assertIn('CHAT_STREAM_ERROR:', output.getvalue())
