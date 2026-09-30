---
name: macos-test-rig
description: Drive remote macOS test hosts over SSH - run commands, copy files, capture the screen, launch an app and capture it, and send synthetic keys - through the `mac` script and per-host config. Use when a change must be checked or built on real macOS.
---

# macOS test rig

Remote Macs reached over SSH, all driven through `scripts/mac` (relative to
this file). Each host is one config file,
`~/.config/macos-test-rig/hosts/NAME.env`:

```bash
MAC_ADDR=192.0.2.10            # IP or hostname (required)
MAC_USER=me                    # default: local $USER
MAC_KEY=~/.ssh/id_ed25519      # default shown
MAC_NOTE="what this host is for: installed tools, display size, known grants"
```

`scripts/mac list` shows the configured hosts and their notes. Choose a host by
its note. If none fits the task, ask the user rather than guessing.

## Start every session with

```bash
scripts/mac doctor HOST
```

It wakes the host and checks the OS and console user, screen capture,
synthetic input, and sudo. Read the capture it saves: if it shows only
wallpaper and no windows, the recording grant is missing.

## Commands

| Need | Command |
| -- | -- |
| Host may be asleep | `mac wake HOST` (a sleeping Mac accepts the login and then hangs) |
| Run something | `mac ssh HOST 'xcodebuild -version'` |
| Copy files | `mac put HOST LOCAL [REMOTE]`, `mac get HOST REMOTE LOCAL` |
| Screenshot | `mac shot HOST OUT.png`, then Read the PNG |
| Launch a GUI app and capture it | `mac show HOST [--settle S] OUT.png -- COMMAND ARGS` |
| Keyboard | `mac key HOST 36` (Return; Escape is 53), `mac key HOST 12 command` (Cmd+Q), `mac type HOST 'text'` |

## Rules

- **Launch and capture in one session.** Use `mac show`. A separate `mac ssh`
  followed by `mac shot` misses short-lived windows through timing skew.
- **Treat a hang as a pending consent prompt.** If `mac key` or `mac type`
  errors or hangs, TCC is waiting for Accessibility or Automation consent at
  the console. Screenshot it and ask the user to click Allow.
- **Only wallpaper in captures means TCC was reset**, usually by a macOS
  update. The user must re-grant Screen & System Audio Recording to
  `sshd-session` in System Settings.
- **Root steps belong to the user.** Without passwordless sudo, stage files in
  `/tmp` and give the user the exact command to run, for example
  `! ssh -t USER@ADDR "sudo installer -pkg /tmp/X.pkg -target /"`.
- **Record what you learn in the host's `MAC_NOTE`**, such as grants you
  verified or tools you installed. Project facts belong in that project's
  `AGENTS.md`.
