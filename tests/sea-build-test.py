"""Prevent console or incomplete SEA artifacts from being accepted for deployment."""
import importlib.util
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

with patch.dict(os.environ, {"SUBFABRIC_NODE": sys.executable}):
    spec = importlib.util.spec_from_file_location("sf_build_exe", Path(__file__).resolve().parents[1] / "build_exe.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)


class SeaBuildTest(unittest.TestCase):
    def fixture(self, path, subsystem=3, injected=True, certificate=False):
        data = bytearray(1024)
        data[:2] = b"MZ"
        struct.pack_into("<I", data, 0x3C, 64)
        data[64:68] = b"PE\x00\x00"
        struct.pack_into("<H", data, 88, 0x20B)
        struct.pack_into("<H", data, 88 + 68, subsystem)
        if certificate:
            struct.pack_into("<II", data, 88 + 112 + 32, 700, 32)
        fuse = b"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:" + (b"1" if injected else b"0")
        data[512:512 + len(fuse)] = fuse
        path.write_bytes(data)

    def test_console_output_is_rejected_then_gui_patch_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            exe = Path(directory) / "app.exe"
            self.fixture(exe)
            with self.assertRaisesRegex(RuntimeError, "CMD"):
                build.validate_sea_exe(exe)
            build.patch_gui_subsystem(exe)
            build.validate_sea_exe(exe)

    def test_missing_injection_and_invalid_signature_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            exe = Path(directory) / "app.exe"
            self.fixture(exe, subsystem=2, injected=False)
            with self.assertRaisesRegex(RuntimeError, "注入"):
                build.validate_sea_exe(exe)
            self.fixture(exe, subsystem=2, certificate=True)
            with self.assertRaisesRegex(RuntimeError, "签名"):
                build.validate_sea_exe(exe)
            build.strip_invalid_signature(exe)
            build.validate_sea_exe(exe)

    def test_invalid_executable_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            exe = Path(directory) / "app.exe"
            exe.write_bytes(b"MZ")
            with self.assertRaises(RuntimeError):
                build.validate_sea_exe(exe)


if __name__ == "__main__":
    unittest.main()
