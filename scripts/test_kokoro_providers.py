"""Kokoro's execution provider: the best one for this machine, and the processor whenever the graphics card fails.

No real Kokoro model and no graphics card needed: providers are stood in for. The DirectML model rewrite is checked
for exactness on a small hand-built ONNX model on the processor (skipped when onnxruntime is not installed).
"""
import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

DATA = tempfile.TemporaryDirectory(prefix='kairos-kokoro-providers-')
os.environ['JARVIS_DATA_DIR'] = DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import numpy as np
from core import kokoro_voice, onnx_providers as op, speech_optional

CPU, DML, COREML = op.CPU, op.DML, op.COREML


class RuntimeFailure(Exception):
    """Looks like onnxruntime's own error class (module onnxruntime.capi...), which is what counts against a provider."""


RuntimeFailure.__module__ = 'onnxruntime.capi.onnxruntime_pybind11_state'


class FakeEngine:
    def __init__(self, provider, fail_runs=0, error=RuntimeFailure):
        self.provider, self.fail_runs, self.error, self.calls = provider, fail_runs, error, []

    def get_voices(self):
        return ['af_heart']

    def create(self, text, voice, speed, lang):
        self.calls.append(text)
        if self.fail_runs:
            self.fail_runs -= 1
            raise self.error('device removed')
        return np.zeros(2400, dtype=np.float32) + 0.1, 24000


class Base(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(dir=DATA.name)
        self.patches = [patch.object(speech_optional, 'OPTIONAL_DIR', self.folder),
                        patch.object(kokoro_voice, 'ENGINE_FACTORY', None), patch.object(kokoro_voice, 'FORCE_PROVIDER', None),
                        patch.object(speech_optional, 'module_available', return_value=True)]
        for p in self.patches:
            p.start()
        for spec in speech_optional.entry('kokoro')['files']:
            Path(self.folder, spec['file']).write_bytes(b'')
        kokoro_voice.reset(forget_failures=True)
        self.opened = []
        self.engines = {}

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        kokoro_voice.reset(forget_failures=True)

    def machine(self, providers, platform='win32', broken=(), engines=None):
        """Stand in for this machine's onnxruntime: which providers it has, which fail to load, and the engines."""
        self.engines = engines or {}

        def opener(provider):
            self.opened.append(provider)
            if provider in broken:
                raise RuntimeFailure(f'{provider} could not create a device')
            return self.engines.setdefault(provider, FakeEngine(provider))
        return [patch.object(op, 'available', return_value=list(providers)), patch.object(op.sys, 'platform', platform),
                patch.object(kokoro_voice, '_open', side_effect=opener)]

    def run_with(self, patches, fn):
        for p in patches:
            p.start()
        try:
            return fn()
        finally:
            for p in reversed(patches):
                p.stop()


class Choice(unittest.TestCase):
    def test_best_provider_per_platform_with_the_processor_last(self):
        self.assertEqual(op.candidates('win32', [DML, CPU]), [DML, CPU])
        self.assertEqual(op.candidates('win32', ['AzureExecutionProvider', CPU]), [CPU], 'the plain CPU build: processor only')
        self.assertEqual(op.candidates('darwin', [COREML, CPU]), [COREML, CPU])
        self.assertEqual(op.candidates('darwin', [CPU]), [CPU])
        self.assertEqual(op.candidates('linux', ['CUDAExecutionProvider', CPU]), [CPU], 'only providers users get are tried')
        self.assertEqual(op.candidates('win32', [DML, CPU], skip={DML: 'failed'}), [CPU])
        self.assertEqual(op.candidates('win32', []), [CPU], 'no runtime at all still names the processor')

    def test_labels_are_plain(self):
        self.assertEqual(op.label(DML), 'the graphics card (DirectML)')
        self.assertEqual(op.label(CPU), 'the processor')
        self.assertEqual(op.label(None), 'the processor')


class KokoroProvider(Base):
    def test_uses_directml_when_the_machine_has_it(self):
        def go():
            self.assertEqual(kokoro_voice.device()['text'], 'Will run on the graphics card (DirectML).')
            pcm = kokoro_voice.synthesize('Sure thing.', 'af_heart')
            self.assertEqual(len(pcm), 4800)
            self.assertEqual(self.opened, [DML])
            self.assertEqual(kokoro_voice.device()['text'], 'Runs on the graphics card (DirectML).')
        self.run_with(self.machine([DML, CPU]), go)

    def test_processor_when_the_runtime_has_no_graphics_provider(self):
        def go():
            kokoro_voice.synthesize('Sure thing.', 'af_heart')
            self.assertEqual(self.opened, [CPU])
            self.assertEqual(kokoro_voice.device()['text'], 'Runs on the processor.')
        self.run_with(self.machine(['AzureExecutionProvider', CPU]), go)

    def test_falls_back_to_the_processor_when_the_card_will_not_load(self):
        def go():
            kokoro_voice.synthesize('Sure thing.', 'af_heart')
            self.assertEqual(self.opened, [DML, CPU])
            info = kokoro_voice.device()
            self.assertEqual(info['provider'], CPU)
            self.assertEqual(info['text'], 'Runs on the processor. The graphics card (DirectML) could not run it on this PC.')
            self.assertIn(DML, info['failed'])
            # Remembered for the session: a reload (e.g. after the model is removed and fetched again) skips the card.
            kokoro_voice.reset()
            kokoro_voice.synthesize('Again.', 'af_heart')
            self.assertEqual(self.opened, [DML, CPU, CPU])
        self.run_with(self.machine([DML, CPU], broken={DML}), go)

    def test_a_card_failure_mid_call_speaks_the_same_sentence_on_the_processor(self):
        engines = {DML: FakeEngine(DML, fail_runs=1)}

        def go():
            kokoro_voice.synthesize('First.', 'af_heart')          # loads on DirectML; this run fails, retried on the CPU
            self.assertEqual(engines[DML].calls, ['First.'])
            self.assertEqual(engines[CPU].calls, ['First.'], 'the same sentence, not a skipped one')
            kokoro_voice.synthesize('Second.', 'af_heart')
            self.assertEqual(engines[DML].calls, ['First.'], 'the card is not tried again this session')
            self.assertEqual(engines[CPU].calls, ['First.', 'Second.'])
            self.assertEqual(kokoro_voice.device()['provider'], CPU)
        self.run_with(self.machine([DML, CPU], engines=engines), go)

    def test_a_bad_voice_is_not_blamed_on_the_card(self):
        engines = {DML: FakeEngine(DML, fail_runs=1, error=KeyError)}

        def go():
            with self.assertRaises(kokoro_voice.KokoroUnavailable):
                kokoro_voice.synthesize('Hello.', 'nobody')
            self.assertEqual(self.opened, [DML])
            self.assertEqual(kokoro_voice.device()['provider'], DML)
            self.assertEqual(kokoro_voice.device()['failed'], {})
        self.run_with(self.machine([DML, CPU], engines=engines), go)

    def test_processor_failure_is_unavailable_not_a_crash(self):
        def go():
            with self.assertRaises(kokoro_voice.KokoroUnavailable):
                kokoro_voice.synthesize('Hello.', 'af_heart')
            self.assertFalse(kokoro_voice.warm())
        self.run_with(self.machine([DML, CPU], broken={DML, CPU}), go)

    def test_core_ml_on_a_mac(self):
        def go():
            kokoro_voice.synthesize('Sure thing.', 'af_heart')
            self.assertEqual(self.opened, [COREML])
            self.assertEqual(kokoro_voice.device()['text'], "Runs on Apple's Core ML (graphics and Neural Engine).")
        self.run_with(self.machine([COREML, CPU], platform='darwin'), go)

    def test_the_benchmark_can_pin_a_provider(self):
        def go():
            kokoro_voice.FORCE_PROVIDER = CPU
            kokoro_voice.synthesize('Sure thing.', 'af_heart')
            self.assertEqual(self.opened, [CPU])
        self.run_with(self.machine([DML, CPU]), go)

    def test_settings_row_says_where_it_runs(self):
        def go():
            row = speech_optional.state('kokoro')
            self.assertEqual(row['state'], 'ready')
            self.assertEqual(row['runs_on'], 'Will run on the graphics card (DirectML).')
            kokoro_voice.synthesize('Sure thing.', 'af_heart')
            self.assertEqual(speech_optional.state('kokoro')['runs_on'], 'Runs on the graphics card (DirectML).')
            self.assertIsNone(speech_optional.state('smart-turn')['runs_on'], 'Smart Turn: not downloaded here, and its description says processor')
            self.assertNotIn('—', row['runs_on'])
        self.run_with(self.machine([DML, CPU]), go)


# -- the DirectML rewrite, on a hand-built model ---------------------------------------------------------------------

def _value_info(name, dims):
    """ValueInfoProto: name=1, type=2 -> TypeProto tensor_type=1 -> elem_type=1 (FLOAT), shape=2 -> dim=1 (value=1 or param=2)."""
    shape = b''.join(op._len(1, op._str(2, d) if isinstance(d, str) else op._int(1, d)) for d in dims)
    return op._str(1, name) + op._len(2, op._len(1, op._int(1, 1) + op._len(2, shape)))


def _initializer(name, array):
    array = np.asarray(array, dtype=np.float32)
    return b''.join(op._int(1, d) for d in array.shape) + op._int(2, 1) + op._str(8, name) + op._len(9, array.tobytes())


def tiny_model(channels, group, kernel=3, stride=2, pads=(1, 1), output_padding=(1,), seed=0):
    rng = np.random.default_rng(seed)
    weight = rng.standard_normal((channels, channels // group, kernel)).astype(np.float32)
    bias = rng.standard_normal(channels).astype(np.float32)
    attrs = (op._attr_ints('dilations', [1]) + op._attr_int('group', group) + op._attr_ints('kernel_shape', [kernel])
             + op._attr_ints('output_padding', list(output_padding)) + op._attr_ints('pads', list(pads)) + op._attr_ints('strides', [stride]))
    node = op._node('ConvTranspose', ['x', 'w', 'b'], ['y'], '/pool/ConvTranspose', attrs)
    graph = (node + op._str(2, 'g') + op._len(5, _initializer('w', weight)) + op._len(5, _initializer('b', bias))
             + op._len(11, _value_info('x', [1, channels, 'L'])) + op._len(12, _value_info('y', [1, channels, 'M'])))
    return op._int(1, 9) + op._len(8, op._str(1, '') + op._int(2, 20)) + op._len(7, graph)


try:
    import onnxruntime as ort
except Exception:     # pragma: no cover - the plain test environment may not have it
    ort = None


@unittest.skipIf(ort is None, 'onnxruntime is not installed')
class DirectMLRewrite(unittest.TestCase):
    def run_model(self, data, x):
        session = ort.InferenceSession(data, providers=['CPUExecutionProvider'])
        return session.run(None, {'x': x})[0]

    def test_depthwise_upsampling_is_rewritten_exactly(self):
        original = tiny_model(8, 8)
        rewritten, names = op.dml_compatible_model(original)
        self.assertEqual(names, ['/pool/ConvTranspose'])
        self.assertNotEqual(rewritten, original)
        for length in (1, 2, 7, 31):
            x = np.random.default_rng(length).standard_normal((1, 8, length)).astype(np.float32)
            want, got = self.run_model(original, x), self.run_model(rewritten, x)
            self.assertEqual(want.shape, (1, 8, 2 * length))
            self.assertEqual(got.shape, want.shape)
            np.testing.assert_allclose(got, want, rtol=1e-5, atol=1e-5)

    def test_other_layers_are_left_alone(self):
        for model in (tiny_model(4, 1), tiny_model(4, 4, stride=3, output_padding=(0,)), tiny_model(4, 4, pads=(0, 0), output_padding=(0,), kernel=1)):
            data, names = op.dml_compatible_model(model)
            self.assertEqual(names, [])
            self.assertIs(data, model, 'unchanged models come back as the same bytes')


if __name__ == '__main__':
    unittest.main(verbosity=2)
