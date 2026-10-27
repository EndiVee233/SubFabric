"""父进程看护：标准库单测与真实子进程验收，不加载模型。"""
import ctypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

ASR = Path(__file__).resolve().parents[1] / "asr"
PYTHON = getattr(sys, "_base_executable", sys.executable)  # Windows venv 启动器不是实际解释器进程
sys.path.insert(0, str(ASR))
import common


class ParentWatchTest(unittest.TestCase):
    def test_opt_in_and_polling(self):
        with patch.dict(os.environ, {"SUBFABRIC_PARENT_WATCH": "0"}), patch.object(common.threading, "Thread") as thread:
            common.watch_parent()
            thread.assert_not_called()
        with patch.dict(os.environ, {"SUBFABRIC_PARENT_WATCH": "1"}), \
                patch.object(common.threading, "Thread") as thread, \
                patch.object(common.os, "getppid", return_value=123):
            common.watch_parent()
            self.assertTrue(thread.call_args.kwargs["daemon"])
            thread.return_value.start.assert_called_once()
            run = thread.call_args.kwargs["target"]
        with patch.object(common.time, "sleep") as sleep, \
                patch.object(common, "parent_alive", return_value=False) as alive, \
                patch.object(common.os, "_exit", side_effect=SystemExit(0)) as terminate:
            with self.assertRaises(SystemExit):
                run()
            sleep.assert_called_once_with(1)
            alive.assert_called_once_with(123)
            terminate.assert_called_once_with(0)

    def test_windows_handle_contract_and_cleanup(self):
        from ctypes import wintypes
        kernel = Mock()
        handle = 0x123456789
        kernel.OpenProcess.return_value = handle
        with patch.object(common.os, "name", "nt"), \
                patch.object(ctypes, "WinDLL", return_value=kernel, create=True), \
                patch.object(ctypes, "get_last_error", return_value=5, create=True) as error:
            kernel.WaitForSingleObject.return_value = 258  # WAIT_TIMEOUT
            self.assertTrue(common.parent_alive(321))
            self.assertIs(kernel.OpenProcess.restype, wintypes.HANDLE)
            kernel.WaitForSingleObject.assert_called_with(handle, 0)
            kernel.CloseHandle.assert_called_once_with(handle)
            kernel.WaitForSingleObject.return_value = 0
            self.assertFalse(common.parent_alive(321))
            kernel.WaitForSingleObject.side_effect = RuntimeError("probe failed")
            with self.assertRaises(RuntimeError):
                common.parent_alive(321)
            self.assertEqual(kernel.CloseHandle.call_count, 3)
            kernel.OpenProcess.return_value = 0
            self.assertTrue(common.parent_alive(321))  # ACCESS_DENIED
            error.return_value = 87
            self.assertFalse(common.parent_alive(321))
            self.assertEqual(kernel.CloseHandle.call_count, 3)

    def test_native_live_and_exited_process(self):
        child = subprocess.Popen([PYTHON, "-B", "-c", "import time; time.sleep(60)"],
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            self.assertTrue(common.parent_alive(child.pid))
            child.terminate()
            child.wait(timeout=5)
            self.assertFalse(common.parent_alive(child.pid))
            self.assertTrue(common.parent_alive(os.getpid()))
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)

    def test_worker_exits_after_parent(self):
        with tempfile.TemporaryDirectory(prefix="sf-parent-watch-") as directory:
            self.check_worker_exit(Path(directory) / "exited")

    def check_worker_exit(self, marker):
        # 留一份退出凭证：Linux 的孤儿可能短暂成为 PID 1 尚未 reap 的 zombie，
        # kill(pid, 0) 此时仍成功，不能据此把已退出的 worker 判成仍在运行。
        worker = ("import os,sys,time\nfrom pathlib import Path\n"
                  "sys.path.insert(0, " + repr(str(ASR)) + ")\n"
                  "from common import watch_parent\noriginal_exit=os._exit\n"
                  "def stop(code):\n    Path(" + repr(str(marker)) + ").write_text(str(code))\n"
                  "    original_exit(code)\nos._exit=stop\nwatch_parent()\n"
                  "print('READY',flush=True)\ntime.sleep(60)")
        supervisor = ("import subprocess,sys,time; "
                      "p=subprocess.Popen([sys.executable,'-B','-c'," + repr(worker) + "],"
                      "stdout=subprocess.PIPE,text=True,creationflags="
                      "getattr(subprocess,'CREATE_NO_WINDOW',0)); "
                      "assert p.stdout.readline().strip()=='READY'; "
                      "print(p.pid,flush=True); time.sleep(60)")
        proc = subprocess.Popen([PYTHON, "-B", "-c", supervisor], stdout=subprocess.PIPE,
                                text=True, env={**os.environ, "SUBFABRIC_PARENT_WATCH": "1"},
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        worker_pid = None
        try:
            worker_pid = int(proc.stdout.readline().strip())
            self.assertTrue(common.parent_alive(worker_pid))
            proc.terminate()
            proc.wait(timeout=5)
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(marker.exists(), "orphan worker did not exit")
            self.assertEqual(marker.read_text(), "0")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
            proc.stdout.close()
            if worker_pid and not marker.exists() and common.parent_alive(worker_pid):
                try:
                    os.kill(worker_pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass  # 进程可能已在检查与收尾之间退出。


if __name__ == "__main__":
    unittest.main()
