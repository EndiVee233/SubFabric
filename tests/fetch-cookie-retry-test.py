"""Chrome/Edge Cookie 失败重试：无浏览器、真实 Cookie 或外部网络。"""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'asr'))
from fetch import fetch_cli as cli


class FakeYtdlp:
    def __init__(self, failure='Could not copy Chrome cookie database', retry_failure=''):
        self.failure, self.retry_failure, self.calls = failure, retry_failure, []

    def YoutubeDL(self, opts):
        outer = self

        class Downloader:
            def __enter__(self):
                outer.calls.append(dict(opts))
                if opts.get('cookiesfrombrowser') and outer.failure:
                    opts.get('logger', cli.make_logger()).error(outer.failure)
                    raise RuntimeError(outer.failure)
                return self

            def __exit__(self, *args):
                return False

            def extract_info(self, url, download):
                if outer.retry_failure:
                    raise RuntimeError(outer.retry_failure)
                return {'id': 'fixture', 'title': 'public fixture', 'url': url, 'downloaded': download}
        return Downloader()


class CookieRetryTest(unittest.TestCase):
    def test_both_chromium_browsers_and_options(self):
        for browser in ['chrome', 'edge']:
            for download in [False, True]:
                with self.subTest(browser=browser, download=download), redirect_stdout(io.StringIO()) as out:
                    fake = FakeYtdlp('ERROR: Could not copy %s cookie database' % browser.title())
                    opts = {'cookiesfrombrowser': (browser,), 'format': 'best', 'proxy': 'http://proxy.invalid', 'logger': cli.make_logger()}
                    info, warning = cli.extract_with_cookie_retry(fake, opts, 'https://www.youtube.com/watch?v=fixture', download)
                    self.assertTrue(warning)
                    self.assertEqual(info['downloaded'], download)
                    self.assertEqual(len(fake.calls), 2)
                    self.assertNotIn('cookiesfrombrowser', fake.calls[1])
                    self.assertEqual(fake.calls[1]['proxy'], opts['proxy'])
                    self.assertIn('cookiesfrombrowser', opts)
                    self.assertFalse(any(json.loads(line)['type'] == 'error' for line in out.getvalue().splitlines()))

    def test_failure_kinds_and_login_required(self):
        self.assertTrue(cli.browser_cookie_error(RuntimeError('ERROR: Failed to decrypt with DPAPI')))
        self.assertFalse(cli.browser_cookie_error(RuntimeError('HTTP Error 403: Forbidden')))
        with redirect_stdout(io.StringIO()):
            fake = FakeYtdlp(retry_failure='Sign in to confirm your age')
            with self.assertRaisesRegex(RuntimeError, 'cookies.txt'):
                cli.extract_with_cookie_retry(fake, {'cookiesfrombrowser': ('edge',)}, 'https://youtu.be/fixture', False)
            self.assertEqual(len(fake.calls), 2)

    def test_no_retry_for_other_errors_or_explicit_cookie_file(self):
        for opts, message in [({'cookiesfrombrowser': ('chrome',)}, 'HTTP Error 403'),
                              ({'cookiesfrombrowser': ('edge',), 'cookiefile': 'explicit.txt'}, 'Could not copy Edge cookie database')]:
            fake = FakeYtdlp(message)
            with self.assertRaises(RuntimeError):
                cli.extract_with_cookie_retry(fake, opts, 'https://youtu.be/fixture', False)
            self.assertEqual(len(fake.calls), 1)

    def test_cli_emits_only_final_success_after_cookie_failure(self):
        fake = FakeYtdlp()
        with tempfile.TemporaryDirectory() as root, redirect_stdout(io.StringIO()) as out, \
                patch.object(cli.ytdlp_mod, 'ensure', return_value=(True, '')), \
                patch.object(cli.ytdlp_mod, 'require', return_value=fake), \
                patch.object(cli.ytdlp_mod, 'installed_version', return_value='test'), \
                patch.object(cli, 'find_js_runtimes', return_value=[]), \
                patch.object(cli, 'find_ffmpeg', return_value=None):
            code = cli.main(['--url', 'https://youtu.be/fixture', '--out', root, '--simulate', '--cookies-from-browser', 'chrome'])
            events = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(code, 0)
            self.assertFalse(any(e['type'] == 'error' for e in events))
            self.assertTrue(next(e for e in events if e['type'] == 'done')['meta']['cookieWarning'])


if __name__ == '__main__':
    unittest.main()
