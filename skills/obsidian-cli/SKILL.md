---
name: obsidian-cli
description: Read, search, analyze, and safely edit the user's Obsidian vaults using the obsidian CLI. Use when users ask to inspect notes, backlinks, tags, tasks, daily notes, bases, or make targeted vault changes.
---

# Obsidian CLI

## Find the vault

1. List vaults with `obsidian vaults verbose` (name and path). If the CLI
   reports it is not enabled, read the `vaults` map in Obsidian's
   `obsidian.json` (`~/Library/Application Support/obsidian/` on macOS,
   `~/.config/obsidian/` on Linux) and ask the user to turn the CLI on
   (Settings, General, Advanced).
1. Use the vault the user names. If they name none and more than one exists, ask
   which.
1. Pass `vault=<name>` on every command. Below, `<vault>` is its path.

## Learn its layout before acting

Vaults differ; never assume folder names or conventions.

- Read any `AGENTS.md`, `CLAUDE.md`, or `README.md` at the vault root and follow
  it.
- `obsidian folders vault=<name>` for structure.
- `<vault>/.obsidian/app.json`: `newFileFolderPath` (where new notes go),
  `attachmentFolderPath`, and `useMarkdownLinks` (markdown links vs wikilinks).
  `templates.json` names the templates folder.
- Match the link style, frontmatter keys, and filename style of neighbouring
  notes.

## Ground rules

- Read-only unless the user asks for a change.
- Confirm before `delete`, `permanent`, `overwrite`, `move`, `rename`,
  `history:restore`, `sync:restore`, or plugin, theme, or sync changes. Never
  use `permanent` without an explicit request after a warning.
- Search narrowly; read only relevant notes; don't dump note contents unasked.
- Preserve Markdown, frontmatter, links, tags, block IDs, and task markers.

## CLI syntax

Arguments are `key=value`, not flags. `path=` is exact and vault-relative;
`file=` resolves like a wikilink and can be ambiguous, so use `path=` for
writes.

```bash
obsidian files vault=<name> folder="<dir>" ext=md
obsidian search:context vault=<name> query="terms" path="<dir>" limit=20
obsidian search vault=<name> query="#tag" format=json
obsidian read|file|outline vault=<name> path="<note>.md"
obsidian backlinks|links vault=<name> path="<note>.md"
obsidian unresolved|orphans|deadends|aliases|tags vault=<name>
obsidian tasks vault=<name> todo verbose
obsidian task vault=<name> ref="<note>.md:<line>" done
obsidian daily:path|daily:read vault=<name>
obsidian daily:append|daily:prepend vault=<name> content="..."
obsidian bases|base:views|base:query vault=<name> path="<x>.base"
obsidian create vault=<name> path="<dir>/<note>.md" content="..."
obsidian append|prepend vault=<name> path="<note>.md" content="..."
obsidian move vault=<name> path="<old>.md" to="<new>.md"
obsidian rename vault=<name> path="<old>.md" name="<New Name>"
obsidian delete vault=<name> path="<note>.md"
```

`rg`/`find` under `<vault>` are fine for regex or path searches.

## Editing

For anything beyond a one-line append: resolve the path, read `<vault>/<path>`,
make the smallest change with the normal edit/write tools (shell quoting mangles
multiline content), then verify with `obsidian read` or `backlinks`. If a note
name is ambiguous, list candidates and ask.

## Reporting

Cite vault-relative paths for what you read; for changes, list each path changed
and how you verified it.

## Maintenance

This skill lives in the `agent-toolkit` repo at `skills/obsidian-cli/`. If you
find a bug while using it, fix it and commit the change to the repo first,
before relying on the skill further.
