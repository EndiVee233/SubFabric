"""下载入口与 wheel 解包边界，纯标准库、临时目录、无网络。"""
import builtins
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'asr'))
from fetch import fetch_cli, selector, ytdlp


class FetchBoundaryTest(unittest.TestCase):
    def test_urls(self):
        allowed = ['https://www.youtube.com/watch?v=x', 'youtu.be/x',
                   'https://m.youtube.com./x', 'HTTPS://YOUTUBE.COM/x',
                   'https://youtube-nocookie.com/embed/x']
        for url in allowed:
            with self.subTest(url=url):
                self.assertEqual(selector.site_of(url), 'youtube')
        rejected = ['https://youtube.com.evil.invalid/x', 'https://evil.invalid/?youtube.com',
                    'https://youtube.com@evil.invalid/x', 'ftp://youtube.com/x',
                    'https://notyoutube.com/x', 'https://[invalid', '', None]
        for url in rejected:
            with self.subTest(url=url):
                self.assertEqual(selector.site_of(url), '')

    def test_rejected_cli_never_bootstraps_or_creates_output(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'not-created'
            with patch.object(ytdlp, 'ensure') as ensure, redirect_stdout(io.StringIO()) as output:
                result = fetch_cli.main(['--url', 'https://invalid.local/?youtube.com', '--out', str(destination)])
            self.assertEqual(result, 2)
            self.assertIn('"type": "error"', output.getvalue())
            ensure.assert_not_called()
            self.assertFalse(destination.exists())

    def test_wheel_paths(self):
        bad = ['/yt_dlp/escape.txt', '\\yt_dlp\\escape.txt', '//yt_dlp/escape.txt',
               'C:/yt_dlp/escape.txt', 'yt_dlp/C:/escape.txt', 'yt_dlp/file:stream',
               'yt_dlp/../../escape.txt', 'yt_dlp\\..\\..\\escape.txt', 'yt_dlp/./escape.txt']
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, member in enumerate(bad):
                with self.subTest(member=member):
                    destination = root / str(index)
                    archive = root / (str(index) + '.whl')
                    with zipfile.ZipFile(archive, 'w') as wheel:
                        wheel.writestr('yt_dlp/__init__.py', '# valid package')
                        # 保留原始反斜杠，不让 Windows 的 ZipInfo 构造器先归一化它。
                        info = zipfile.ZipInfo('placeholder')
                        info.filename = member
                        wheel.writestr(info, 'must never be written')
                    mkdir, open_file = Path.mkdir, builtins.open

                    def checked_mkdir(path, *args, _destination=destination, _mkdir=mkdir, **kwargs):
                        self.assertTrue(path.resolve().is_relative_to(_destination.resolve()))
                        return _mkdir(path, *args, **kwargs)

                    def checked_open(path, *args, _destination=destination, _open=open_file, **kwargs):
                        self.assertTrue(Path(path).resolve().is_relative_to(_destination.resolve()))
                        self.assertNotIn(':', Path(path).name)
                        return _open(path, *args, **kwargs)

                    with patch.object(ytdlp, '_PKG_DIR', destination), \
                            patch.object(Path, 'mkdir', checked_mkdir), \
                            patch.object(builtins, 'open', checked_open):
                        self.assertTrue(ytdlp._unpack_wheel(archive))
                    self.assertEqual((destination / 'yt_dlp/__init__.py').read_text(), '# valid package')
                    self.assertEqual([p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()],
                                     ['yt_dlp/__init__.py'])

    def test_normal_wheel_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'valid.whl'
            with zipfile.ZipFile(archive, 'w') as wheel:
                for name in ['yt_dlp/__init__.py', 'yt_dlp/utils/__init__.py', 'yt_dlp-1.dist-info/METADATA']:
                    wheel.writestr(name, name)
                wheel.writestr('yt_dlp-1.dist-info/RECORD', 'ignored')
                wheel.writestr('unrelated/data.txt', 'ignored')
            with patch.object(ytdlp, '_PKG_DIR', root / 'installed'):
                self.assertTrue(ytdlp._unpack_wheel(archive))
            self.assertEqual(len([p for p in (root / 'installed').rglob('*') if p.is_file()]), 3)


if __name__ == '__main__':
    unittest.main()
