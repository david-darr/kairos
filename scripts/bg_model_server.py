"""Loopback-only OpenAI fixture shared by the scripted harness and tests.

No model SDK, subprocess or outbound request. Helpers wait for an explicit
release in tests; the UI harness releases them after twenty seconds.
"""
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import uuid


class ScriptedModelServer:
    def __init__(self, calls=None, helper_delay=None):
        self.calls = calls or []
        self.helper_delay = helper_delay
        self.release = threading.Event()
        self.helper_started = threading.Event()
        self.requests = []
        self.errors = []
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                try:
                    assert self.path == '/v1/chat/completions', self.path
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    fixture.requests.append(body)
                    if body['model'] == 'scripted-helper':
                        fixture.helper_started.set()
                        if not fixture.release.wait(fixture.helper_delay if fixture.helper_delay is not None else 30):
                            assert fixture.helper_delay is not None, 'Test did not release helper'
                        message = {'role': 'assistant', 'content': 'Finished scripted research.'}
                    else:
                        offered = {t['function']['name'] for t in body.get('tools', [])}
                        searches, descriptions, calls = [], [], []
                        for name, arguments in fixture.calls:
                            if name in offered:
                                calls.append((name, arguments))
                            else:
                                # Exercise the actual small-window discovery bridge.
                                assert 'kairos_tool_search' in offered, (name, offered)
                                searches.append(('kairos_tool_search', {'query': name}))
                                descriptions.append(('kairos_tool_describe', {'name': name}))
                                calls.append(('kairos_tool_call', {'name': name, 'arguments': arguments}))
                        plan = [batch for batch in (searches, descriptions, calls) if batch]
                        messages = body['messages']
                        start = max(i for i, m in enumerate(messages) if m['role'] == 'user')
                        step = sum(bool(m.get('tool_calls')) for m in messages[start + 1:])
                        if step < len(plan):
                            message = {'role': 'assistant', 'content': None, 'tool_calls': [
                                {'id': 'scripted-' + uuid.uuid4().hex, 'type': 'function',
                                 'function': {'name': name, 'arguments': json.dumps(arguments)}}
                                for name, arguments in plan[step]]}
                        else:
                            message = {'role': 'assistant', 'content': 'Started the helpers.'}
                    payload = json.dumps({'choices': [{'message': message, 'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop'}],
                                          'usage': {'prompt_tokens': 10, 'completion_tokens': 5}}).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                    pass  # A stopped chat may close an outstanding helper response.
                except Exception as error:
                    fixture.errors.append(str(error))
                    self.send_error(500, str(error))

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.base_url = f'http://127.0.0.1:{self.server.server_port}/v1'

    def start(self):
        self.thread.start()
        return self

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def demo_calls(agent_id=None):
    calls = [('delegate', {'jobs': [{'goal': 'Survey the repository TODOs'}, {'goal': 'Review the test coverage'}]}),
             ('create_task', {'name': 'Review scripted findings', 'prompt': 'Review the findings', 'schedule_kind': 'once',
                              'run_at': (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()})]
    if agent_id:
        calls.append(('hand_to_agent', {'agent': agent_id, 'work': 'Review the background work'}))
    return calls
