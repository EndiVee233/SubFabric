"""Deterministic WhisperX adapter tests; no models, GPU or package installation."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / "asr" / "whisperx_asr.py"
spec = importlib.util.spec_from_file_location("sf_whisperx_adapter", WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class AdapterTest(unittest.TestCase):
    def test_nltk_validation_uses_only_local_data(self):
        calls = []
        nltk = SimpleNamespace(sent_tokenize=lambda text, **kw: calls.append((text, kw)))
        with patch.dict(sys.modules, {"nltk": nltk}):
            worker.validate_nltk()
        self.assertEqual(calls[0][1]["language"], "english")

    def test_missing_nltk_data_requires_runtime_repair(self):
        def missing(*args, **kwargs):
            raise LookupError("punkt_tab")
        with patch.dict(sys.modules, {"nltk": SimpleNamespace(sent_tokenize=missing)}):
            with self.assertRaisesRegex(RuntimeError, "punkt_tab"):
                worker.validate_nltk()

    def test_complete_word_timing_and_confidence(self):
        result = worker.normalized_segments({"segments": [{"start": 1, "end": 3, "text": "Okay. now",
            "words": [{"word": "Okay.", "start": 1, "end": 1.5, "score": 0.9},
                      {"word": "now", "start": 2, "end": 3, "score": 1.3}]}]}, 4)
        self.assertEqual([w["word"] for w in result[0]["words"]], ["Okay.", "now"])
        self.assertEqual(result[0]["words"][1]["score"], 1)
        self.assertFalse(result[0]["alignmentIncomplete"])

    def test_unaligned_words_keep_full_text(self):
        for words in [[], [{"word": "In", "start": 0, "end": 0.5}, {"word": "2014"}],
                      [{"word": "In", "start": 0, "end": 0.5}],
                      [{"word": "In", "start": 0, "end": 1}, {"word": "2014", "start": 0.5, "end": 2}]]:
            result = worker.normalized_segments({"segments": [{"start": 0, "end": 2, "text": "In 2014", "words": words}]}, 3)
            self.assertEqual(result[0]["text"], "In 2014")
            self.assertEqual(result[0]["words"], [])
            self.assertTrue(result[0]["alignmentIncomplete"])

    def test_invalid_sentence_times_are_not_written(self):
        for start, end in [(2, 1), (float("nan"), 3), (0, float("inf")), (None, 2)]:
            with self.assertRaises(ValueError):
                worker.normalized_segments({"segments": [{"start": start, "end": end, "text": "Keep"}]}, 3)

    def test_transcription_then_local_english_alignment(self):
        with tempfile.TemporaryDirectory() as temp:
            align_dir = Path(temp) / "align" / "en"
            align_dir.mkdir(parents=True)
            (align_dir / "model.safetensors").write_bytes(b"fixture")
            calls = []
            class Audio:
                def __len__(self):
                    return 32000
            class Matrix:
                def mean(self, axis):
                    return Audio()
            class Model:
                def transcribe(self, audio, **kwargs):
                    calls.append(("transcribe", kwargs))
                    return {"language": "en", "segments": [{"start": 0, "end": 2, "text": "Okay."}]}
            def load_model(path, device, **kwargs):
                calls.append(("load", path, device, kwargs))
                return Model()
            def load_align(**kwargs):
                calls.append(("alignment", kwargs))
                return "align-model", {"type": "fixture"}
            def align(segments, model, metadata, audio, device, **kwargs):
                calls.append(("align", device))
                return {"segments": [{"start": 0, "end": 2, "text": "Okay.",
                                      "words": [{"word": "Okay.", "start": 0.1, "end": 1.8}]}]}
            torch = SimpleNamespace(set_num_threads=lambda n: None, cuda=SimpleNamespace(empty_cache=lambda: calls.append("free")))
            sf = SimpleNamespace(read=lambda *a, **kw: (Matrix(), 16000))
            np = SimpleNamespace(ascontiguousarray=lambda x: x)
            args = worker.parser().parse_args(["--model", temp, "--audio", "fixture.wav", "--batch-size", "2", "--cache-dir", temp])
            result = worker.transcribe(args, (torch, None, load_model, load_align, align, None, sf, np))
            self.assertEqual(result["segments"][0]["words"][0]["start"], 0.1)
            self.assertEqual(calls[0][2], "cuda")
            self.assertTrue(calls[0][3]["local_files_only"])
            self.assertEqual(calls[1][1]["batch_size"], 2)
            self.assertEqual(calls[3][1]["model_name"], str(align_dir))
            self.assertTrue(calls[3][1]["model_cache_only"])
            self.assertLess(calls.index("free"), next(i for i, c in enumerate(calls) if isinstance(c, tuple) and c[0] == "alignment"))

    def test_cli_cuda_failure_is_json_and_nonzero(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = str(Path(temp) / "cache")
            marker = Path(temp) / "ready.json"
            marker.write_text(json.dumps({"version": worker.VERSION, "python": sys.executable}), encoding="utf-8")
            bootstrap = ("import sys,types,runpy;sys.modules['torch']=types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda:False));"
                         "sys.argv=[sys.argv[1],'--probe','--cache-dir',sys.argv[2]];runpy.run_path(sys.argv[0],run_name='__main__')")
            result = subprocess.run([sys.executable, "-c", bootstrap, str(WORKER), cache], capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            error = json.loads(result.stderr.strip().splitlines()[-1])
            self.assertEqual(error["type"], "error")
            self.assertIn("CUDA", error["msg"])
            self.assertFalse(marker.exists(), "a failed runtime import invalidates only its own marker")
            marker.write_text('[]', encoding="utf-8")
            subprocess.run([sys.executable, "-c", bootstrap, str(WORKER), cache], capture_output=True, timeout=30)
            self.assertEqual(marker.read_text(encoding="utf-8"), '[]', "unrelated files remain untouched")


if __name__ == "__main__":
    unittest.main()
