# agent-toolkit

A one-stop shop for [pi.dev](https://pi.dev) extensions, portable Agent Skills,
and personal global agent context. The production installer runs on Node 24; Bun
remains the development test runner.

## Resources and ownership

| Resource | Delivery | Scope |
| -- | -- | -- |
| `extensions/` | The `agent-toolkit` Pi package (`package.json` → `pi.extensions`) | Pi only |
| `skills/` | Per-skill symlinks managed only by `scripts/agent-toolkit.mjs`; optional `agent-toolkit.json` overrides the default scope | All four agents by default, with per-skill exceptions |
| `context/working-style.md` | One fixed global-context symlink per agent, managed by the same CLI | All four agents when the source file exists |

The package and installer deliberately do not both own Pi skill installation.

### Extensions

| Name | Description |
| -- | -- |
| [custom-footer](extensions/custom-footer/index.ts) | Compact footer with path, branch, context usage, cost, model, and thinking level |
| [protected-paths](extensions/protected-paths/index.ts) | Prevents overwrite of an existing `.env` through Pi's write/edit tools |
| [system-prompt](extensions/system-prompt/index.ts) | Shows the current Pi system prompt and tool list |

### Skills

| Name | Harnesses | Description |
| -- | -- | -- |
| [bro](skills/bro/SKILL.md) | Pi, Prime, Codex, Claude | Restates the previous message in concise, jargon-free language |
| [obsidian-cli](skills/obsidian-cli/SKILL.md) | Pi, Prime, Codex, Claude | Reads, searches, and safely edits the primary Obsidian vault |
| [review](skills/review/SKILL.md) | Pi | Runs an explicitly invoked, read-only subagent review of the current branch |
| [subagent](skills/subagent/SKILL.md) | Pi | Spawns an isolated Pi process for delegated work |
| [unslop](skills/unslop/SKILL.md) | Pi, Prime, Codex, Claude | Removes common AI-writing patterns and adds a more human voice |
| [web](skills/web/SKILL.md) | Pi, Prime, Codex, Claude | Explicit-consent static web search and URL-to-Markdown extraction |
| [writing-for-agents](skills/writing-for-agents/SKILL.md) | Pi, Prime, Codex, Claude | Writes and reviews concise, effective documents intended for agents |

Every discovered skill defaults to all four agents. The optional
`agent-toolkit.json` contains only exceptions; here it narrows `review` and
`subagent` to Pi. Unlisted skills keep the all-agent default.

## Prerequisites

- [mise](https://mise.jdx.dev) and [direnv](https://direnv.net) for the pinned
  development environment.
- [uv](https://docs.astral.sh/uv/) for the executable web helper, which is
  pinned to CPython 3.14.7 and otherwise uses only the standard library.
- [Node.js](https://nodejs.org) 24.14.1 for the dependency-free skill installer.
- [Bun](https://bun.sh) 1.3.13 for development dependencies, TypeScript tooling,
  tests, and personal Pi extensions.
- Git for cloning `respec`; its locked Go and just versions are installed by
  mise during `mise run toolkit:sync`.
- [Pi](https://pi.dev), when using the Pi-only extensions or the `review` and
  `subagent` skills.
- `obsidian`, when using `obsidian-cli`.
- `gh`, when the web skill reads recognized GitHub URLs.
- `html2markdown`, only for the web skill's ordinary static-HTML conversion
  path.
- A POSIX host (macOS or Linux) for direct `./scripts/web` execution and the
  bounded `gh` and `html2markdown` subprocess paths. On Windows, HTTP-only
  search and Markdown-for-Agents extraction can be invoked explicitly with
  `uv run --script scripts\web`.

## Install the Pi extensions

Install the package from Git or point Pi at a local checkout:

```bash
pi install git:github.com/hurricanehrndz/agent-toolkit
# or, from a clone:
pi add /path/to/agent-toolkit
```

Only `extensions/` is declared in the Pi package manifest. Skills are installed
separately so that their cross-agent scope has one owner.

For one-off extension development, use `pi -e ./extensions/<name>/index.ts` and
`/reload` after edits.

## Install and manage toolkit resources

Clone the repository, approve its local tool configuration, and install the
locked dependencies:

```bash
git clone https://github.com/hurricanehrndz/agent-toolkit
cd agent-toolkit
mise trust
mise install
direnv allow
mise run setup
mise run toolkit:validate
mise run toolkit:sync -- --dry-run
mise run toolkit:sync
```

`toolkit:sync` reconciles both resource types. It installs expected links and
removes stale links owned by this checkout. It also clones
`https://github.com/hurricanehrndz/respec` to `~/src/me/respec` when absent,
runs `mise install`, then runs `mise exec -- just install` from that checkout.
Pass `--dry-run` to preview both parts without cloning, installing tools,
building, or installing. The resource CLI uses these eight fixed destinations:

| Agent | Skills | Global context |
| -- | -- | -- |
| Pi | `~/.pi/agent/skills` | `~/.pi/agent/APPEND_SYSTEM.md` |
| Prime | `~/.prime/agent/skills` | `~/.prime/agent/APPEND_SYSTEM.md` |
| Codex | `~/.codex/skills` | `~/.codex/AGENTS.md` |
| Claude | `~/.claude/skills` | `~/.claude/CLAUDE.md` |

Every discovered skill defaults to all four agents unless `agent-toolkit.json`
narrows its scope. The presence of `context/working-style.md` makes global
context expected for every selected agent. A checkout without that file does not
own global context and will not remove a link installed by another checkout.

Select agents with repeatable `--agent` flags or a comma-separated value:

```bash
mise run toolkit:status -- --agent prime
mise run toolkit:sync -- --agent pi,codex --dry-run
mise run toolkit:sync -- --agent all
mise run toolkit:uninstall -- --agent claude --dry-run
```

The executable and package bin manage skills and context when mise is
unavailable: `./scripts/agent-toolkit.mjs <command> [options]` or
`agent-toolkit <command> [options]`. The separate respec installation is part of
only the `toolkit:sync` mise task.

- `sync` reconciles skills and optional context. It removes only links owned by
  this checkout.

- `status` reports linked, missing, and conflicting resources without mutation.

- `uninstall` removes only links owned by this checkout.

- `validate` checks every skill, the optional scope config, and the optional
  context source.

- `install` is available only through the direct CLI or package bin. It adds
  missing expected links without removing anything:

  ```bash
  agent-toolkit install --dry-run
  ```

- `--dry-run` previews changes without creating destination roots or mutating
  files.

- `--home <path>` overrides the home directory, primarily for tests.

Context ownership requires an exact link target of this checkout's
`context/working-style.md`. Skill ownership remains limited to direct children
of this checkout's `skills/` directory. Files, directories, external links,
links from a moved checkout, and separately managed resources are preserved. A
conflict produces a nonzero exit rather than replacing content.

## Web skill

From `skills/web/`, after the user has explicitly requested web access or URL
reading:

```bash
./scripts/web search --query "current project documentation"
./scripts/web fetch https://example.com/docs
./scripts/web fetch https://example.com/docs --include-selector main --exclude-selector nav
```

Search defaults to `https://search.hrndz.ca`; set `WEB_SEARCH_BASE_URL` or pass
`--base-url` to change it. See [the skill instructions](skills/web/SKILL.md) for
consent, GitHub handling, prerequisites, and static-extraction limitations.

## Development

Use the repository's mise tasks rather than selecting runtimes directly:

```bash
mise run fmt              # Format repository-authored root and skill Markdown
mise run typecheck        # Type-check Python and TypeScript
mise run toolkit:validate # Validate skills, optional context, and scope overrides
mise run test             # Run the Python and Bun suites
mise run check            # Run the complete repository gate
mise run hooks:install    # Explicitly install pre-commit hooks
```

Pi loads extensions from TypeScript source, so type checking is the build check.
The root peer dependencies provide Pi API types without bundling Pi itself. The
web helper remains standard-library-only at runtime; its root Python packages
are development-only type-checking and formatting tools.

Portable Python helpers are direct uv-script entry points pinned to CPython
3.14.7. Invoke `./skills/web/scripts/web` directly, including through an
installed skill symlink, rather than selecting an ambient `python3`. uv may
download the exact interpreter when it is not already installed; set
`UV_PYTHON_DOWNLOADS=never` when fail-closed offline behavior is required.

### Add an extension

Create `extensions/<name>/index.ts` with a default `ExtensionAPI` factory, add
extension-specific dependencies only when needed, test it, and list it above.
Extensions remain Pi-only package resources.

### Add or change a skill

1. Create `skills/<name>/SKILL.md` with Agent Skills frontmatter whose `name`
   matches the directory. Frontmatter is a flat mapping with unindented plain
   keys and plain, single- or double-quoted scalar values. Comments,
   collections, block values, tags, anchors, aliases, duplicate keys, and
   ambiguous unquoted colons are rejected.
1. Put helpers under `skills/<name>/scripts/` and use relative invocations in
   the skill documentation.
1. Leave an all-agent skill out of `agent-toolkit.json`. Add an override only
   when its scope differs from the default.
1. Add focused offline tests for helpers and installer behavior.
1. Run `mise run check`.

## Tech stack

| Tool | Role |
| -- | -- |
| Node.js 24.14.1 | Dependency-free installer runtime |
| Bun 1.3.13 | Development package manager and TypeScript test runner |
| TypeScript | Pi extensions and development tests |
| Python standard library | Portable web helper |
| Agent Skills | Cross-harness skill format |

## License

MIT
