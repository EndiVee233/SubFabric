"""Diarization status/heartbeat tests without models or accelerator dependencies."""
import importlib.util
from pathlib import Path
import threading
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sf_diarize", Path(__file__).resolve().parents[1] / "asr/diarize.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ProgressTest(unittest.TestCase):
    def test_heartbeat_keeps_real_model_counters_and_percent(self):
        messages = []
        received = threading.Event()

        def capture(message):
            messages.append(message)
            if message.get("heartbeat"):
                received.set()

        with patch.object(worker, "emit", capture):
            status = worker.DiarizeProgress(interval=0.01)
            try:
                status.update(52, "声纹提取与聚类…", phase="inference", provider="cpu", done=4, total=10)
                self.assertTrue(received.wait(1), "the worker should report even without another native callback")
            finally:
                status.close()
        self.assertFalse(status.thread.is_alive())
        self.assertTrue(any(message["heartbeat"] for message in messages))
        self.assertTrue(all((m["pct"], m["done"], m["total"]) == (52, 4, 10) for m in messages))
        self.assertTrue(all(m["elapsedSec"] >= 0 and m["phaseElapsedSec"] >= 0 for m in messages))

    def test_phase_transition_removes_obsolete_counts_but_keeps_device(self):
        messages = []
        with patch.object(worker, "emit", messages.append):
            status = worker.DiarizeProgress()
            try:
                status.update(85, "推理", phase="inference", provider="cuda", done=10, total=10)
                status.update(90, "写入", phase="write_result")
            finally:
                status.close()
        self.assertEqual(messages[-1]["phase"], "write_result")
        self.assertNotIn("done", messages[-1])
        self.assertNotIn("total", messages[-1])
        self.assertEqual(messages[-1]["provider"], "cuda")
        self.assertFalse(status.thread.is_alive())

    def test_failure_stops_heartbeat_and_emits_actionable_error(self):
        messages = []
        workers = []
        original = worker.DiarizeProgress

        def make_status():
            status = original()
            workers.append(status)
            return status

        argv = ["diarize.py", "--segmentation", "fixture", "--embedding", "fixture",
                "--audio", "fixture", "--out", "unused"]
        with patch.object(sys, "argv", argv), patch.object(worker, "watch_parent"), \
                patch.object(worker, "DiarizeProgress", make_status), patch.object(worker, "emit", messages.append), \
                patch.dict(sys.modules, {"sherpa_onnx": SimpleNamespace()}), \
                patch.object(worker, "read_wav_mono16k", side_effect=MemoryError()):
            self.assertEqual(worker.main(), 1)
        self.assertFalse(workers[0].thread.is_alive())
        self.assertEqual(messages[-1]["type"], "error")
        self.assertIn("MemoryError", messages[-1]["msg"])


if __name__ == "__main__":
    unittest.main()
