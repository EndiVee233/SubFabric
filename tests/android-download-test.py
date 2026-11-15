"""Offline boundary tests for the Android downloader; no models or external services."""
import importlib.util
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'asr'))
spec = importlib.util.spec_from_file_location('sf_download', ROOT / 'android/download.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Boundary(unittest.TestCase):
    def test_urls(self):
        for url in ['file:///etc/passwd', 'https://user:secret@example.com/v', 'http://example.com/v',
                    'javascript:alert(1)', 'https://example.com/\nsecret']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                worker.validate_url(url)
        self.assertEqual(worker.validate_url('http://127.0.0.1:19488/a.mp4#time'), 'http://127.0.0.1:19488/a.mp4')
        self.assertEqual(worker.validate_url('https://example.com/video?q=1'), 'https://example.com/video?q=1')

    def test_public_metadata(self):
        self.assertEqual(worker.public_url('https://www.youtube.com/watch?v=abc&token=private&p=2#secret'),
                         'https://www.youtube.com/watch?v=abc&p=2')

    def test_cookie_domains_and_security(self):
        text = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t2147483647\tSID\tprivate-test\n'
        jar = worker.cookie_jar('SESSDATA=isolated-test; bili_jct=csrf', text)
        self.assertTrue(len(jar) >= 2)
        self.assertTrue(all(cookie.secure for cookie in jar))
        self.assertTrue(all(cookie.domain.endswith(('bilibili.com', 'youtube.com')) for cookie in jar))
        with self.assertRaises(ValueError):
            worker.cookie_jar('', text.replace('.youtube.com', '.unrelated.example'))
        self.assertFalse(any(c.name == 'arbitrary' for c in worker.cookie_jar('arbitrary=value', '')))

    def test_shared_quality(self):
        expression = worker.selector.build_format_selector('https://www.bilibili.com/video/BV1xx', '1080')
        self.assertIn('1080', expression)
        self.assertEqual(worker.selector.site_of('https://www.youtube.com/watch?v=abc'), 'youtube')
        self.assertEqual(worker.selector.site_of('https://www.bilibili.com/video/BV1xx'), 'bilibili')


if __name__ == '__main__':
    unittest.main()
