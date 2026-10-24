"""Deterministic agy process fixture. No network, login, or vendor binary."""
import json
import os
from pathlib import Path
import sys
import time

if '--version' in sys.argv:
    print('agy 1.4.6')
elif 'models' in sys.argv:
    if os.environ.get('FAKE_AGY_SIGNED_OUT'):
        print('You are not logged into Antigravity.', file=sys.stderr)
        sys.exit(1)
    print('gemini-4-argon-low  Gemini 4 Argon (Low)\ngemini-4-argon-medium  Gemini 4 Argon (Medium)\ngemini-4-argon-high  Gemini 4 Argon (High)\nclaude-proxied  Claude')
else:
    # Read to EOF deliberately: this catches forgotten stdin closure.
    raw = sys.stdin.read()
    if os.environ.get('FAKE_AGY_RECORD'):
        Path(os.environ['FAKE_AGY_RECORD']).write_text(json.dumps({'args': sys.argv[1:], 'stdin': raw, 'cwd': os.getcwd()}), encoding='utf-8')
    # Match the verified print-mode invocation and input envelope strictly.
    assert sys.argv[sys.argv.index('-p') + 1] == ''
    for flag in ('--input-format', '--output-format'):
        assert sys.argv[sys.argv.index(flag) + 1] == 'stream-json'
    lines = raw.splitlines()
    assert len(lines) == 1
    turn = json.loads(lines[0])
    assert set(turn) == {'event', 'message'} and turn['event'] == 'user'
    assert isinstance(turn['message'], dict)
    assert set(turn['message']) == {'role', 'content'}
    assert turn['message']['role'] == 'user' and isinstance(turn['message']['content'], str)
    conversation = 'agy-fixture-conversation'
    def emit(event, payload):
        payload = {'conversation_id': conversation, **payload}
        print(json.dumps({'event': event, event: payload}), flush=True)
    if os.environ.get('FAKE_AGY_WARNINGS'):
        print('warning: ignoring unsupported stream input message event', flush=True)
        print('warning: fixture stderr diagnostic', file=sys.stderr, flush=True)
    print(json.dumps({'event': 'init', 'conversation_id': conversation,
                     'init': {'model': 'gemini-4-argon-high', 'cwd': os.getcwd(), 'tools': []}}), flush=True)
    emit('step_update', {'step_index': 0, 'state': 'DONE', 'step_type': 'user_input'})
    def result(**overrides):
        emit('result', {'status': 'SUCCESS', 'response': '', 'duration_seconds': 1.7,
                        'num_turns': 1, 'usage': {}, **overrides})
    if os.environ.get('FAKE_AGY_HANG'):
        time.sleep(120)
    elif os.environ.get('FAKE_AGY_ERROR'):
        result(status='ERROR', error='fixture error')
    elif os.environ.get('FAKE_AGY_DENIED'):
        result(denied_actions=['command'])
    elif os.environ.get('FAKE_AGY_APPROVAL'):
        emit('step_update', {'step_index': 1, 'step_type': 'tool', 'state': 'ACTIVE', 'tool_name': 'ask_permission'})
    elif os.environ.get('FAKE_AGY_FINAL_ONLY'):
        result(response='Final response', usage={'total_tokens': 9999},
               num_turns=3 if os.environ.get('FAKE_AGY_CUMULATIVE') else 1)
    else:
        if os.environ.get('FAKE_AGY_UNKNOWN_STEP'):
            emit('step_update', {'step_index': 99, 'state': 'DONE', 'step_type': 'future_step'})
        emit('step_update', {'step_index': 1, 'state': 'ACTIVE', 'step_type': 'tool', 'tool_name': 'write_to_file', 'tool_info': {'parameters': {'TargetFile': 'example.txt'}}})
        outcome = {'error': {'type': 'failed', 'message': 'edit refused'}} if os.environ.get('FAKE_AGY_TOOL_ERROR') else {'output': 'saved'}
        emit('step_update', {'step_index': 1, 'state': 'DONE', 'step_type': 'tool', 'tool_name': 'write_to_file', 'tool_info': outcome})
        emit('step_update', {'step_index': 2, 'state': 'ACTIVE', 'step_type': 'agent_response', 'text_delta': 'Hello '})
        emit('step_update', {'step_index': 2, 'state': 'DONE', 'step_type': 'agent_response', 'text_delta': 'Gemini\n', 'duration_seconds': 1.7, 'usage': {'input_tokens': 10, 'cache_read_tokens': 2, 'output_tokens': 3, 'total_tokens': 13}})
        if os.environ.get('FAKE_AGY_SUBAGENT'):
            emit('step_update', {'step_index': 3, 'state': 'DONE', 'step_type': 'tool', 'tool_name': 'invoke_subagent', 'subagent_info': {'subagents': [{'conversation_id': 'child', 'type_name': 'researcher', 'role': 'Research', 'log_uri': 'private://do-not-forward'}]}})
        result(response='Hello Gemini\n', num_turns=25, usage={'total_tokens': 9999})
