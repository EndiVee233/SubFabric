"""NPU TDT decoder semantics without models, drivers or network."""
import importlib.util
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "asr"))
spec = importlib.util.spec_from_file_location("npu_worker", ROOT / "asr" / "asr_npu.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def recognizer(token_duration, cap=10):
    rec = worker.NpuRecognizer.__new__(worker.NpuRecognizer)
    rec.ov = SimpleNamespace(Tensor=lambda x: x)
    rec.joint_req = SimpleNamespace(set_input_tensor=lambda *args: None)
    rec.enc_hidden, rec.dec_hidden = 1024, 640
    rec.blank_penalty, rec.max_symbols_per_frame = 0.0, cap
    rec.normalization_scope = 'global'
    rec.calls = 0

    def joint(token, hidden, cell):
        best, duration = token_duration(rec.calls, token)
        rec.calls += 1
        rows = np.full((188, 1030), -20, dtype=np.float32)
        rows[:, best] = 10
        rows[:, 1025 + duration] = 10
        return rows, hidden, cell

    rec._joint_step = joint
    return rec


def decode(rec, valid=1, last=False):
    state = {"last_token": 1024, "hidden": np.zeros((2, 1, 640)),
             "cell": np.zeros((2, 1, 640))}
    return rec._tdt_loop(np.zeros((188, 1024)), valid, state, last)


class TdtTests(unittest.TestCase):
    def test_features_match_independent_torch_nemo_oracle(self):
        oracle = json.loads((ROOT / 'tests/fixtures/npu-mel-reference.json').read_text())
        t = np.arange(16083) / 16000
        samples = (.13 * np.sin(2*np.pi*440*t) + .07 * np.sin(2*np.pi*1234*t)
                   + .01 * np.cos(2*np.pi*32*t)).astype(np.float32)
        before = samples.copy()
        features = worker.MelFrontend().log_mel(samples)
        self.assertEqual(list(features.shape), oracle['shape'])
        np.testing.assert_array_equal(samples, before)
        for mel, frame, expected in oracle['points']:
            self.assertAlmostEqual(float(features[mel, frame]), expected, delta=.002)

    def test_window_normalization_is_local_and_padding_stays_zero(self):
        rec = recognizer(lambda *_: (1024, 1))
        rec.normalization_scope = 'window'
        seen = []
        rec._enc_cache = {}

        def encode(window, size):
            seen.append((window.copy(), size))
            return np.zeros((188, 1024)), 188

        rec._encode = encode
        rec._tdt_loop = lambda *args, **kwargs: ([], [], [])
        rec.is_punctuation = lambda _: False
        mel = np.tile(np.linspace(0, 20, 3000), (128, 1)).astype(np.float32)
        rec._decode_windows(mel)
        for window, size in seen:
            np.testing.assert_allclose(window[:, :size].mean(1), 0, atol=2e-5)
            np.testing.assert_array_equal(window[:, size:], 0)

    def test_nonblank_zero_duration_emits_more_than_one_token_at_same_frame(self):
        rec = recognizer(lambda n, _: (1, 0) if n == 0 else (2, 1))
        tokens, timings, probs = decode(rec)
        self.assertEqual(tokens, [1, 2])
        self.assertEqual([t["frame"] for t in timings], [0, 0])
        self.assertEqual(len(probs), len(tokens))

    def test_blank_zero_duration_always_advances(self):
        rec = recognizer(lambda *_: (1024, 0))
        self.assertEqual(decode(rec, valid=3)[0], [])
        self.assertEqual(rec.calls, 3)

    def test_zero_duration_loop_has_a_symbol_limit(self):
        rec = recognizer(lambda *_: (1, 0), cap=4)
        tokens, timings, _ = decode(rec, valid=2)
        self.assertEqual(len(tokens), 8)
        self.assertEqual([t["frame"] for t in timings], [0] * 4 + [8] * 4)

    def test_last_window_does_not_invent_tail_tokens(self):
        rec = recognizer(lambda n, _: (n + 1, 1))
        self.assertEqual(decode(rec, last=True)[0], [1])
        self.assertEqual(rec.calls, 1)

    def test_window_crop_is_in_encoder_frames(self):
        rec = recognizer(lambda *_: (1024, 1))
        rec._enc_cache = {}
        rec._encode = lambda window, size: (np.zeros((188, 1024)), 188)
        rec.is_punctuation = lambda _: False
        limits = []

        def record(acts, valid, state, is_last, **kwargs):
            limits.append((is_last, kwargs["frame_limit"]))
            return [], [], []

        rec._tdt_loop = record
        rec._decode_windows(np.zeros((128, 3000)))
        self.assertEqual(limits[0], (False, 167))
        self.assertIsNone(limits[-1][1])


if __name__ == "__main__":
    unittest.main()
