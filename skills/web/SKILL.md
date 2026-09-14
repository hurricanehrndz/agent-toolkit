---
name: web
description: Search the public web or read an HTTP(S) URL as static Markdown when the user explicitly requests web search, current external information, or URL inspection.
---

# Web

Use this skill only when the user explicitly asks for web/current information or
asks to read, inspect, summarize, or extract a URL. Do not invoke it
speculatively when local files or supplied context are enough. The CLI does not
enforce consent; you must.

Run commands from this skill directory so `./scripts/web` resolves consistently
in Pi, Prime, Codex, and Claude.

## Prerequisites

- [`uv`](https://docs.astral.sh/uv/). Run `./scripts/web` directly: its PEP 723
  header selects exactly CPython 3.14.7 (and may download it if unavailable);
  the helper otherwise uses only the standard library.
- [`gh`](https://cli.github.com/) for recognized GitHub URLs. Authenticate with
  `gh auth login` when needed.
- `html2markdown` only when an ordinary page does not support Cloudflare
  Markdown-for-Agents and static HTML must be converted.
- A POSIX host (macOS or Linux) for direct `./scripts/web` execution and the
  `gh` and `html2markdown` paths. On Windows, invoke HTTP-only search or direct
  Markdown-for-Agents extraction with `uv run --script scripts\web`; external
  command extraction remains unsupported there.

No client-side code or dynamic rendering is used.

## Search

Search the configured SearXNG instance. The default is `http://localhost:7888`
when the hostname is exactly `chernand-main`, and `https://search.hrndz.ca` on
other hosts:

```bash
./scripts/web search --query "current Python release notes"
```

Set `WEB_SEARCH_BASE_URL` or pass `--base-url` to use another SearXNG endpoint.
Useful options include `--limit`, `--page`, repeatable `--categories` and
`--engines`, `--language`, and `--time-range day|week|month|year`.

## Fetch

Fetch one HTTP(S) URL as Markdown:

```bash
./scripts/web fetch https://example.com/docs
./scripts/web fetch https://example.com/docs   --include-selector 'main' --exclude-selector '.navigation'
./scripts/web fetch https://github.com/cli/cli/pull/123
```

Recognized GitHub repository, blob, tree, issue, pull-request, and raw-file URLs
use `gh api` and do not fall back to GitHub HTML. Other URLs first request
Cloudflare Markdown-for-Agents. If unavailable, the helper makes a separate
static HTML request and pipes that response to `html2markdown`; selectors apply
only to this fallback.

Acquisition has fixed safety ceilings: 10 MiB per HTTP body and command stdin,
20 MiB for command stdout, and 256 KiB for command stderr. The
per-request/per-command timeout defaults to 20 seconds and may not exceed 300
seconds. Displayed output and error details have smaller bounds. When displayed
output is truncated, the complete acquired Markdown is saved to a temporary path
printed by the command.

## Limitations

Extraction is static. Pages that require JavaScript, interactive login, anti-bot
challenges, or session state may return incomplete content or fail. Explain that
limitation rather than attempting dynamic extraction.

## Maintenance

This skill lives at `skills/web/` in the `agent-toolkit` repository.
