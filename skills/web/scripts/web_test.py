from __future__ import annotations

import argparse
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from email.message import Message
import pathlib
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("web")
REPO_ROOT = SCRIPT.parents[3]
LOADER = importlib.machinery.SourceFileLoader("agent_toolkit_web", str(SCRIPT))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
web = importlib.util.module_from_spec(SPEC)
sys.modules[LOADER.name] = web
LOADER.exec_module(web)


def response(body: str, *, status: int = 200, url: str = "https://example.com/", content_type: str = "text/html", headers=None):
    return web.HttpResponse(status, url, content_type, headers or {}, body)


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        status: int = 200,
        url: str = "https://example.com/",
        location: str | None = None,
        content_length: int | None = None,
        charset: str = "utf-8",
        chunk_size: int | None = None,
    ):
        self._body = body
        self._offset = 0
        self._chunk_size = chunk_size
        self._url = url
        self.status = status
        self.headers = Message()
        self.headers["content-type"] = f"text/plain; charset={charset}"
        if location is not None:
            self.headers["location"] = location
        if content_length is not None:
            self.headers["content-length"] = str(content_length)
        self.timeouts: list[float] = []
        self.read_calls: list[int] = []
        self.closed = False

    def read(self, size: int) -> bytes:
        self.read_calls.append(size)
        if self._chunk_size is not None:
            size = min(size, self._chunk_size)
        chunk = self._body[self._offset : self._offset + size]
        self._offset += len(chunk)
        return chunk

    def settimeout(self, timeout: float) -> None:
        self.timeouts.append(timeout)

    def geturl(self) -> str:
        return self._url

    def close(self) -> None:
        self.closed = True


class ArgumentTests(unittest.TestCase):
    def test_root_and_subcommand_help(self):
        for argv in (["--help"], ["search", "--help"], ["fetch", "--help"]):
            output = io.StringIO()
            with self.assertRaisesRegex(SystemExit, "0"), contextlib.redirect_stdout(output):
                web.main(argv)
            self.assertIn("usage:", output.getvalue().lower())

    def test_required_arguments_and_invalid_bounds_are_rejected(self):
        for argv in ([], ["search"], ["fetch"], ["search", "--query", "x", "--page", "0"]):
            with self.subTest(argv=argv), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                web.main(argv)

    def test_development_configuration_pins_toolset_and_python_exactly(self):
        mise = tomllib.loads((REPO_ROOT / "mise.toml").read_text())
        self.assertEqual(
            mise["tools"],
            {
                "bun": "1.3.13",
                "node": "24.14.1",
                "python": "3.14.7",
                "uv": "0.11.21",
                "aqua:numtide/treefmt": "2.5.0",
                "aqua:j178/prek": "0.4.12",
            },
        )
        self.assertTrue(mise["settings"]["locked"])
        self.assertIn("uv sync --python 3.14.7 --locked", mise["tasks"]["setup"]["run"])
        project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())
        self.assertEqual(project["project"]["requires-python"], "==3.14.7")
        self.assertEqual(project["tool"]["mypy"]["python_version"], "3.14")
        self.assertIn('requires-python = "==3.14.7"', (REPO_ROOT / "uv.lock").read_text().splitlines()[:4])

    def test_cli_file_is_executable_and_has_exact_uv_python_pin(self):
        self.assertTrue(SCRIPT.stat().st_mode & 0o111)
        lines = SCRIPT.read_text().splitlines()
        self.assertEqual(lines[0], "#!/usr/bin/env -S uv run --script")
        self.assertEqual(lines[1:4], ['# /// script', '# requires-python = "==3.14.7"', '# ///'])
        self.assertEqual(sys.version_info[:3], (3, 14, 7))

    def test_help_works_through_an_installed_skill_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            link = pathlib.Path(directory, "web")
            link.symlink_to(SCRIPT.parent.parent, target_is_directory=True)
            result = subprocess.run(
                [str(link / "scripts/web"), "--help"],
                text=True,
                capture_output=True,
                timeout=5,
                env={
                    **os.environ,
                    "PYTHONDONTWRITEBYTECODE": "1",
                    "UV_PYTHON": sys.executable,
                    "UV_PYTHON_DOWNLOADS": "never",
                },
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage:", result.stdout.lower())

    def test_timeout_must_be_finite_and_within_documented_maximum(self):
        for value in ("nan", "inf", "-inf", str(web.MAX_TIMEOUT + 1)):
            with self.subTest(value=value), self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                web.parser().parse_args(["search", "--query", "x", "--timeout", value])
        self.assertEqual(web.parser().parse_args(["search", "--query", "x", "--timeout", "0.25"]).timeout, 0.25)


class HttpTests(unittest.TestCase):
    def request(self, fake: FakeResponse, **kwargs):
        with mock.patch.object(web.HTTP_OPENER, "open", return_value=fake):
            return web.http_request("https://example.com", "text/plain", 1, **kwargs)

    def test_content_length_over_limit_is_rejected_before_read(self):
        fake = FakeResponse(b"small", content_length=6)
        with self.assertRaisesRegex(web.WebError, "5-byte limit"):
            self.request(fake, body_limit=5)
        self.assertEqual(fake._offset, 0)
        self.assertTrue(fake.closed)

    def test_missing_or_dishonest_content_length_is_chunk_bounded(self):
        for declared in (None, 1):
            fake = FakeResponse(b"123456")
            if declared is not None:
                fake.headers["content-length"] = str(declared)
            with self.subTest(declared=declared), self.assertRaisesRegex(web.WebError, "5-byte limit"):
                self.request(fake, body_limit=5)
            self.assertEqual(fake._offset, 6)

    def test_total_read_deadline_is_checked_after_each_chunk(self):
        fake = FakeResponse(b"ok", chunk_size=1)
        with mock.patch.object(web.HTTP_OPENER, "open", return_value=fake) as opener, mock.patch.object(
            web.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 0.3, 1.1]
        ):
            with self.assertRaisesRegex(web.WebError, "timed out after 1 seconds"):
                web.http_request("https://example.com", "text/plain", 1, body_limit=5)
        self.assertAlmostEqual(opener.call_args.kwargs["timeout"], 0.9)
        self.assertEqual(fake.timeouts, [0.7])
        self.assertTrue(fake.closed)

    def test_relative_multi_hop_redirects_are_followed_without_reading_intermediate_bodies(self):
        first = FakeResponse(b"x" * 1000, status=302, url="https://example.com/start", location="/middle")
        second = FakeResponse(b"y" * 1000, status=307, url="https://example.com/middle", location="final")
        final = FakeResponse(b"done", url="https://example.com/final")
        with mock.patch.object(web.HTTP_OPENER, "open", side_effect=[first, second, final]) as opener:
            result = web.http_request("https://example.com/start", "text/plain", 1)
        self.assertEqual(result.body, "done")
        self.assertEqual([call.args[0].full_url for call in opener.call_args_list], [
            "https://example.com/start", "https://example.com/middle", "https://example.com/final"
        ])
        self.assertEqual(first.read_calls, [])
        self.assertEqual(second.read_calls, [])
        self.assertTrue(first.closed and second.closed and final.closed)

    def test_redirect_handler_returns_intermediate_response_without_reading_it(self):
        fake = FakeResponse(b"never", status=302, location="/next")
        returned = web.ManualRedirectHandler().http_error_302(None, fake, 302, "Found", fake.headers)
        self.assertIs(returned, fake)
        self.assertEqual(fake.read_calls, [])

    def test_redirect_targets_require_a_valid_location_and_http_scheme(self):
        cases = [
            (None, "missing a valid Location"),
            ("file:///tmp/nope", "invalid Location"),
        ]
        for location, message in cases:
            fake = FakeResponse(b"never", status=302, location=location)
            with self.subTest(location=location), mock.patch.object(web.HTTP_OPENER, "open", return_value=fake):
                with self.assertRaisesRegex(web.WebError, message):
                    web.http_request("https://example.com/start", "text/plain", 1)
            self.assertEqual(fake.read_calls, [])
            self.assertTrue(fake.closed)

    def test_redirect_count_is_bounded(self):
        first = FakeResponse(b"never", status=302, url="https://example.com/one", location="/two")
        second = FakeResponse(b"never", status=302, url="https://example.com/two", location="/three")
        with mock.patch.object(web.HTTP_OPENER, "open", side_effect=[first, second]):
            with self.assertRaisesRegex(web.WebError, "1-redirect limit"):
                web.http_request("https://example.com/one", "text/plain", 1, redirect_limit=1)
        self.assertEqual(first.read_calls, [])
        self.assertEqual(second.read_calls, [])
        self.assertTrue(first.closed and second.closed)

    def test_one_deadline_covers_every_redirect_hop(self):
        first = FakeResponse(b"never", status=302, url="https://example.com/one", location="/two")
        with mock.patch.object(web.HTTP_OPENER, "open", return_value=first) as opener, mock.patch.object(
            web.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 1.1]
        ):
            with self.assertRaisesRegex(web.WebError, "timed out after 1 seconds"):
                web.http_request("https://example.com/one", "text/plain", 1)
        self.assertEqual(opener.call_count, 1)
        self.assertAlmostEqual(opener.call_args.kwargs["timeout"], 0.9)
        self.assertEqual(first.read_calls, [])
        self.assertTrue(first.closed)

    def test_each_redirect_open_and_final_read_get_only_the_remaining_deadline(self):
        first = FakeResponse(b"never", status=302, url="https://example.com/one", location="/two")
        second = FakeResponse(b"never", status=302, url="https://example.com/two", location="/three")
        final = FakeResponse(b"", url="https://example.com/three")
        with mock.patch.object(web.HTTP_OPENER, "open", side_effect=[first, second, final]) as opener, mock.patch.object(
            web.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
        ):
            web.http_request("https://example.com/one", "text/plain", 1)
        for actual, expected in zip([call.kwargs["timeout"] for call in opener.call_args_list], [0.9, 0.7, 0.5]):
            self.assertAlmostEqual(actual, expected)
        self.assertAlmostEqual(final.timeouts[0], 0.3)
        self.assertEqual(first.read_calls, [])
        self.assertEqual(second.read_calls, [])

    def test_invalid_socket_timeout_and_unknown_charset_are_clean_errors(self):
        with mock.patch.object(web.HTTP_OPENER, "open", side_effect=ValueError("bad timeout")):
            with self.assertRaisesRegex(web.WebError, "Request failed"):
                web.http_request("https://example.com", "text/plain", 1)
        fake = FakeResponse(b"ok", charset="not-a-real-charset")
        with self.assertRaisesRegex(web.WebError, "Unsupported response charset"):
            self.request(fake)


class SearchTests(unittest.TestCase):
    def args(self, *extra: str):
        return web.parser().parse_args(["search", "--query", "  useful query  ", *extra])

    def test_search_default_depends_on_hostname_and_allows_overrides(self):
        with mock.patch.dict(web.os.environ):
            web.os.environ.pop("WEB_SEARCH_BASE_URL", None)
            with mock.patch.object(web.socket, "gethostname", return_value="chernand-main"):
                self.assertEqual(self.args().base_url, "http://localhost:7888")
            with mock.patch.object(web.socket, "gethostname", return_value="another-host"):
                self.assertEqual(self.args().base_url, "https://search.hrndz.ca")
            with mock.patch.object(web.socket, "gethostname", return_value="chernand-main"):
                self.assertEqual(self.args("--base-url", "https://search.example").base_url, "https://search.example")

        with mock.patch.dict(web.os.environ, {"WEB_SEARCH_BASE_URL": "https://env-search.example"}):
            with mock.patch.object(web.socket, "gethostname", return_value="chernand-main"):
                self.assertEqual(self.args().base_url, "https://env-search.example")

    def test_search_url_normalizes_base_and_pagination_options(self):
        args = self.args("--page", "3", "--categories", "news", "--categories", "science", "--engines", "bing", "--language", "en", "--time-range", "week")
        url = web.build_search_url("https://search.example/prefix", args)
        parsed = __import__("urllib.parse").parse.urlsplit(url)
        self.assertEqual(parsed.path, "/prefix/search")
        query = __import__("urllib.parse").parse.parse_qs(parsed.query)
        self.assertEqual(query["q"], ["useful query"])
        self.assertEqual(query["pageno"], ["3"])
        self.assertEqual(query["categories"], ["news,science"])
        self.assertEqual(query["engines"], ["bing"])
        self.assertEqual(query["time_range"], ["week"])

    def test_normalizes_results_skips_bad_entries_and_limits(self):
        payload = {"results": [None, {"title": " ", "url": "x"}, {"title": " One ", "url": " https://one ", "engines": "a, b", "published_date": "today", "score": 2}, {"title": "Two", "url": "https://two"}]}
        self.assertEqual(web.normalize_search_results(payload, 1), [{"title": "One", "url": "https://one", "engines": ["a", "b"], "published": "today", "score": 2}])
        with self.assertRaisesRegex(web.WebError, "results array"):
            web.normalize_search_results({}, 8)

    def test_search_formats_payload_and_honors_limit(self):
        payload = {"results": [{"title": "A ] title", "url": "https://a", "content": "summary", "engines": ["google"]}, {"title": "B", "url": "https://b"}]}
        with mock.patch.object(web, "http_request", return_value=response(json.dumps(payload), content_type="application/json")) as request:
            output = web.search(self.args("--limit", "1"))
        self.assertIn("Search results for: useful query", output)
        self.assertIn(r"[A \] title](https://a)", output)
        self.assertNotIn("https://b", output)
        self.assertEqual(request.call_args.args[1], "application/json")

    def test_search_reports_http_and_json_errors(self):
        with mock.patch.object(web, "http_request", return_value=response("private\x00error", status=503)):
            with self.assertRaisesRegex(web.WebError, "HTTP 503"):
                web.search(self.args())
        with mock.patch.object(web, "http_request", return_value=response("not-json", content_type="application/json")):
            with self.assertRaisesRegex(web.WebError, "invalid JSON"):
                web.search(self.args())


class FetchTests(unittest.TestCase):
    def args(self, url: str = "https://example.com/docs", *extra: str):
        return web.parser().parse_args(["fetch", url, *extra])

    def test_url_validation_accepts_only_http_with_host(self):
        self.assertEqual(web.validate_http_url("https://example.com/a"), "https://example.com/a")
        for value in ("file:///etc/passwd", "javascript:alert(1)", "https:///missing"):
            with self.subTest(value=value), self.assertRaises(web.WebError):
                web.validate_http_url(value)
        redirect = FakeResponse(b"never read", status=302, location="file:///tmp/nope")
        with mock.patch.object(web.HTTP_OPENER, "open", return_value=redirect):
            with self.assertRaisesRegex(web.WebError, "invalid Location"):
                web.http_request("https://example.com", "text/plain", 1)
        self.assertEqual(redirect.read_calls, [])

    def test_cloudflare_markdown_success_uses_one_request(self):
        cloudflare = response("# Markdown", content_type="text/markdown; charset=utf-8", headers={"x-markdown-tokens": "12"})
        with mock.patch.object(web, "http_request", return_value=cloudflare) as request:
            output = web.fetch(self.args())
        self.assertEqual(request.call_count, 1)
        self.assertIn("Extraction method: cloudflare-markdown", output)
        self.assertIn("x-markdown-tokens: 12", output)
        self.assertIn("# Markdown", output)

    def test_static_fallback_makes_separate_html_request_and_passes_selectors_on_stdin(self):
        cloudflare = response("<html>first</html>", content_type="text/html")
        html = response("<main>second</main>", url="https://example.com/final", content_type="text/html")
        with mock.patch.object(web, "http_request", side_effect=[cloudflare, html]) as request, mock.patch.object(web, "run_command", return_value="# Converted") as command:
            output = web.fetch(self.args("https://example.com/start", "--include-selector", " main ", "--exclude-selector", ".nav"))
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].args[1], "text/markdown")
        self.assertTrue(request.call_args_list[1].args[1].startswith("text/html"))
        self.assertEqual(command.call_args.args[0], ["html2markdown", "--domain", "https://example.com/final", "--plugin-table", "--include-selector", "main", "--exclude-selector", ".nav"])
        self.assertEqual(command.call_args.kwargs["input_text"], "<main>second</main>")
        self.assertIn("Final URL: https://example.com/final", output)
        self.assertIn("Extraction method: html2markdown", output)

    def test_cloudflare_network_failure_still_attempts_static_html(self):
        with mock.patch.object(web, "http_request", side_effect=[web.WebError("timed out"), response("<p>x</p>")]), mock.patch.object(web, "run_command", return_value="x"):
            output = web.fetch(self.args())
        self.assertIn("Cloudflare markdown request failed", output)

    def test_static_http_failure_is_nonzero_at_main_boundary(self):
        with mock.patch.object(web, "http_request", side_effect=[response("no", status=406), response("secret\x00", status=500)]):
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = web.main(["fetch", "https://example.com"])
        self.assertEqual(code, 1)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("HTTP 500", stderr.getvalue())
        self.assertNotIn("\x00", stderr.getvalue())


class GitHubTests(unittest.TestCase):
    def test_parses_representative_github_urls(self):
        cases = {
            "https://github.com/o/r": ("repo", "", "", 0),
            "https://github.com/o/r/blob/main/a.py": ("blob", "main", "a.py", 0),
            "https://github.com/o/r/tree/dev/docs": ("tree", "dev", "docs", 0),
            "https://github.com/o/r/issues/7": ("issue", "", "", 7),
            "https://github.com/o/r/pull/8": ("pull", "", "", 8),
            "https://raw.githubusercontent.com/o/r/main/a.md": ("blob", "main", "a.md", 0),
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                target = web.parse_github_url(url)
                self.assertIsNotNone(target)
                self.assertEqual((target.kind, target.ref, target.path, target.number), expected)
        self.assertIsNone(web.parse_github_url("https://github.com/o/r/actions"))

    def test_blob_extraction_uses_gh_api_and_decodes_content(self):
        payload = {"encoding": "base64", "content": "cHJpbnQoJ2hpJyk=", "html_url": "https://github.com/o/r/blob/main/a.py"}
        with mock.patch.object(web, "gh_api", return_value=payload) as api:
            output = web.fetch(web.parser().parse_args(["fetch", "https://github.com/o/r/blob/main/a.py"]))
        self.assertEqual(api.call_args.args[0], "repos/o/r/contents/a.py?ref=main")
        self.assertIn("Extraction method: github", output)
        self.assertIn("```python\nprint('hi')\n```", output)

    def test_issue_extraction_includes_bounded_comment_endpoint(self):
        issue = {"title": "Bug", "body": "Details", "user": {"login": "alice"}}
        comments = [{"body": "Reply", "user": {"login": "bob"}}]
        with mock.patch.object(web, "gh_api", side_effect=[issue, comments]) as api:
            output = web.github_markdown(web.GitHubTarget("issue", "o", "r", number=3), 2)
        self.assertEqual(api.call_args_list[1].args[0], "repos/o/r/issues/3/comments?per_page=50")
        self.assertIn("Comment 1 by bob", output)

    def test_unsupported_github_form_never_falls_back_to_html(self):
        with mock.patch.object(web, "http_request") as request:
            with self.assertRaisesRegex(web.WebError, "Unsupported GitHub URL"):
                web.fetch(web.parser().parse_args(["fetch", "https://github.com/o/r/actions"]))
        request.assert_not_called()

    def test_auth_error_is_actionable_and_bounded(self):
        with mock.patch.object(web, "run_command", side_effect=web.WebError("HTTP 403 rate limit " + "x" * 2000)):
            with self.assertRaises(web.WebError) as caught:
                web.gh_api("repos/o/r", 1)
        self.assertIn("gh auth login", str(caught.exception))
        self.assertLess(len(str(caught.exception)), 1100)


class ProcessAndOutputTests(unittest.TestCase):
    def test_external_commands_fail_cleanly_off_posix(self):
        with mock.patch.object(web.os, "name", "nt"), mock.patch.object(web.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(web.WebError, "requires a POSIX host"):
                web.run_command(["gh", "api", "repos/o/r"])
        popen.assert_not_called()

    def python_command(self, source: str) -> list[str]:
        return [sys.executable, "-c", source]

    def test_command_timeout_terminates_and_reaps_process(self):
        launched: list[subprocess.Popen[bytes]] = []
        real_popen = subprocess.Popen

        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            launched.append(process)
            return process

        with mock.patch.object(web.subprocess, "Popen", side_effect=launch):
            with self.assertRaisesRegex(web.WebError, "timed out"):
                web.run_command(self.python_command("import time; time.sleep(5)"), timeout=0.05)
        self.assertEqual(len(launched), 1)
        self.assertIsNotNone(launched[0].poll())

    def test_missing_binary_is_a_clean_error(self):
        with self.assertRaisesRegex(web.WebError, "Required command not found"):
            web.run_command(["/definitely/not/a/real/agent-toolkit-command"])

    def test_subprocess_uses_argv_and_stdin_without_a_shell(self):
        source = "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"
        self.assertEqual(web.run_command(self.python_command(source), input_text="body", timeout=2), "body")

    def test_oversized_stdout_and_stderr_are_rejected_and_reaped(self):
        cases = [
            ("stdout", "import os; os.write(1, b'x' * 20)", {"stdout_limit": 8}),
            ("stderr", "import os; os.write(2, b'x' * 20)", {"stderr_limit": 8}),
        ]
        for stream, source, limits in cases:
            with self.subTest(stream=stream), self.assertRaisesRegex(web.WebError, f"{stream} exceeds"):
                web.run_command(self.python_command(source), timeout=2, **limits)

    def test_both_output_pipes_are_drained_concurrently(self):
        source = "import os; os.write(1, b'o' * 4096); os.write(2, b'e' * 4096)"
        self.assertEqual(len(web.run_command(self.python_command(source), timeout=2, stdout_limit=8192, stderr_limit=8192)), 4096)

    def test_full_output_pipes_and_input_are_pumped_concurrently(self):
        size = 2 * 1024 * 1024
        source = (
            "import os, sys; "
            f"os.write(1, b'o' * {size}); "
            f"os.write(2, b'e' * {size}); "
            "sys.stdin.buffer.read()"
        )
        output = web.run_command(
            self.python_command(source),
            input_text="i" * size,
            timeout=5,
            stdout_limit=size + 1,
            stderr_limit=size + 1,
        )
        self.assertEqual(len(output), size)

    @unittest.skipUnless(os.name == "posix", "process-group regression is POSIX-specific")
    def test_inherited_pipe_handles_cannot_outlive_the_command_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_path = pathlib.Path(directory, "descendant.pid")
            source = (
                "import pathlib, subprocess, sys; "
                "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); "
                "pathlib.Path(sys.argv[1]).write_text(str(child.pid))"
            )
            launched: list[subprocess.Popen[bytes]] = []
            real_popen = subprocess.Popen

            def launch(*args, **kwargs):
                process = real_popen(*args, **kwargs)
                launched.append(process)
                return process

            started = __import__("time").monotonic()
            with mock.patch.object(web.subprocess, "Popen", side_effect=launch):
                with self.assertRaisesRegex(web.WebError, "timed out"):
                    web.run_command(
                        [sys.executable, "-c", source, str(pid_path)],
                        input_text="i" * (1024 * 1024),
                        timeout=0.25,
                    )
            elapsed = __import__("time").monotonic() - started
            self.assertLess(elapsed, 1.5)
            self.assertEqual(len(launched), 1)
            self.assertIsNotNone(launched[0].poll())
            self.assertFalse(any(thread.name.startswith("web-") and thread.is_alive() for thread in __import__("threading").enumerate()))

            descendant_pid = int(pid_path.read_text())
            for _ in range(50):
                try:
                    os.kill(descendant_pid, 0)
                except ProcessLookupError:
                    break
                __import__("time").sleep(0.01)
            else:
                try:
                    os.kill(descendant_pid, 9)
                except ProcessLookupError:
                    pass
                self.fail("descendant remained alive after process-group cleanup")

    def test_oversized_stdin_is_rejected_before_process_start(self):
        with mock.patch.object(web.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(web.WebError, "stdin exceeds the 5-byte limit"):
                web.run_command(["tool"], input_text="123456", stdin_limit=5)
        popen.assert_not_called()

    def test_truncation_saves_full_output_to_temporary_file(self):
        content = "one\ntwo\nthree\n"
        displayed, path = web.bounded_output(content, 2, 100)
        self.assertIsNotNone(path)
        self.assertIn("Output truncated", displayed)
        self.assertEqual(pathlib.Path(path).read_text(), content)
        pathlib.Path(path).unlink()
        pathlib.Path(path).parent.rmdir()

    def test_untruncated_output_creates_no_file(self):
        displayed, path = web.bounded_output("short", 10, 100)
        self.assertEqual((displayed, path), ("short", None))

    def test_broken_pipe_is_a_clean_success(self):
        original_stdout = sys.stdout
        replacement = None
        try:
            with mock.patch.object(web, "main", side_effect=BrokenPipeError):
                self.assertEqual(web.cli(), 0)
                replacement = sys.stdout
        finally:
            if replacement is not None and replacement is not original_stdout:
                replacement.close()
            sys.stdout = original_stdout


if __name__ == "__main__":
    unittest.main()
