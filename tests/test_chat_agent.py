import json
import types
import unittest

from src import chat_agent


def _fn(**kw):
    return types.SimpleNamespace(**kw)


class FakeOpenAI:
    def __init__(self, message):
        self.calls = []
        self.message = message
        self.chat = _fn(completions=_fn(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return _fn(choices=[_fn(message=self.message)])


class FakeAnthropic:
    def __init__(self, content):
        self.calls = []
        self.content = content
        self.messages = _fn(create=self._create)

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return _fn(content=self.content)


PARTS = {'instructions': 'Be helpful.', 'scope': 'notes', 'context': 'CTX', 'history': '', 'question': 'Make an issue'}
TOOLS = [{'name': 'linear__create_issue', 'description': 'Create', 'parameters': {'type': 'object'}}]
TURNS = [
    {'type': 'assistant', 'text': '', 'tool_calls': [{'id': 'c1', 'name': 'linear__create_issue', 'arguments': {'title': 'A'}}]},
    {'type': 'tool_result', 'id': 'c1', 'name': 'linear__create_issue', 'content': 'Created ABC-1'},
]


class ProviderStepTests(unittest.TestCase):
    def test_openai_sends_tools_and_parses_calls(self):
        msg = _fn(content=None, tool_calls=[_fn(id='x', function=_fn(name='linear__create_issue', arguments='{"title": "B"}'))])
        client = FakeOpenAI(msg)
        s = _fn(ai_provider='cloud', cloud_provider='openai', model_name='m', cloud_client=client)
        out = chat_agent.run_step({'tools': TOOLS, 'turns': TURNS}, s, PARTS)
        self.assertEqual(out['tool_calls'], [{'id': 'x', 'name': 'linear__create_issue', 'arguments': {'title': 'B'}}])
        sent = client.calls[0]
        self.assertEqual(sent['tools'][0]['function']['name'], 'linear__create_issue')
        self.assertIn('untrusted data', sent['messages'][0]['content'])
        self.assertEqual(sent['messages'][2]['tool_calls'][0]['function']['arguments'], json.dumps({'title': 'A'}))
        self.assertEqual(sent['messages'][3], {'role': 'tool', 'tool_call_id': 'c1', 'content': 'Created ABC-1'})

    def test_calls_to_tools_not_offered_are_dropped(self):
        msg = _fn(content='ok', tool_calls=[_fn(id='x', function=_fn(name='drop_database', arguments='{}'))])
        s = _fn(ai_provider='cloud', cloud_provider='custom', model_name='m', cloud_client=FakeOpenAI(msg))
        out = chat_agent.run_step({'tools': TOOLS, 'turns': []}, s, PARTS)
        self.assertEqual(out, {'text': 'ok', 'tool_calls': []})

    def test_anthropic_groups_results_into_a_user_turn(self):
        client = FakeAnthropic([_fn(type='text', text='Done: ABC-1')])
        s = _fn(ai_provider='cloud', cloud_provider='anthropic', model_name='m', anthropic_client=client)
        out = chat_agent.run_step({'tools': TOOLS, 'turns': TURNS}, s, PARTS)
        self.assertEqual(out, {'text': 'Done: ABC-1', 'tool_calls': []})
        msgs = client.calls[0]['messages']
        self.assertEqual([m['role'] for m in msgs], ['user', 'assistant', 'user'])
        self.assertEqual(msgs[2]['content'][0]['type'], 'tool_result')
        self.assertEqual(client.calls[0]['tools'][0]['input_schema'], {'type': 'object'})

    def test_no_tools_means_no_tool_instructions(self):
        client = FakeAnthropic([_fn(type='text', text='final')])
        s = _fn(ai_provider='cloud', cloud_provider='anthropic', model_name='m', anthropic_client=client)
        chat_agent.run_step({'tools': [], 'turns': TURNS}, s, PARTS)
        self.assertNotIn('tools', client.calls[0])
        self.assertNotIn('You can call tools', client.calls[0]['system'])

    def test_org_adapter_does_not_get_tools(self):
        with self.assertRaises(chat_agent.ToolsUnsupported):
            chat_agent.provider_step(_fn(ai_provider='adapter'))


class ValidationTests(unittest.TestCase):
    def base(self, **kw):
        return {'scope': 'general', 'question': 'q', 'history': [], **kw}

    def test_rejects_bad_tool_names_and_turns(self):
        with self.assertRaises(ValueError):
            chat_agent.validate_agent_request(self.base(tools=[{'name': 'bad name!'}]))
        with self.assertRaises(ValueError):
            chat_agent.validate_agent_request(self.base(turns=[{'type': 'system'}]))
        chat_agent.validate_agent_request(self.base(tools=TOOLS, turns=TURNS))


NOTES = [
    ('2026_b', {'session_info': {'name': 'Website review', 'processed_at': '2026-11-20T10:00'},
                'summary': 'Trim the defence pages.', 'action_items': ['Create a Notion page called Website content cleanup']}),
    ('2026_a', {'session_info': {'name': 'Standup', 'processed_at': '2026-11-19T10:00'}, 'summary': 'Nothing much.'}),
]


class StenoToolTests(unittest.TestCase):
    def test_search_matches_every_word(self):
        out = chat_agent.search_meetings(NOTES, {'query': 'notion cleanup'})
        self.assertEqual([m['id'] for m in out['meetings']], ['2026_b'])
        self.assertEqual(len(chat_agent.search_meetings(NOTES, {'query': ''})['meetings']), 2)

    def test_get_note_by_id(self):
        md = chat_agent.get_note(NOTES, {'id': '2026_b'})['markdown']
        self.assertIn('# Website review', md)
        self.assertIn('- Create a Notion page called Website content cleanup', md)
        self.assertIn('error', chat_agent.get_note(NOTES, {'id': '../etc'}))


if __name__ == '__main__':
    unittest.main()
