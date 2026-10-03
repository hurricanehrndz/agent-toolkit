---
name: windows-test-rig
description: Drive libvirt Windows 11 test VMs on this host or other Linux hosts - list and select VMs, boot, reset to a clean snapshot, run PowerShell over SSH, launch GUI apps on the visible desktop, send keys, screenshot, and tunnel host services into the guest. Use when a change must be validated on real Windows, or when creating the VM on a new host.
---

# Windows test rig

Windows 11 VMs under libvirt, driven entirely by `scripts/rig` (relative to this
file). Each VM autologs on to an interactive desktop, and the host key in
`RIG_KEY` has admin SSH access. A VM on another Linux host has
`RIG_URI=qemu+ssh://USER@HOST/system`, and guest SSH hops through that host
automatically, so every command works the same way.

Each VM is one config file, `~/.config/windows-test-rig/vms/NAME.env`, holding
its libvirt domain, user, key, URI and a `RIG_NOTE` that says what the VM is
for. Pass `-v NAME` before any command. `-v` may be omitted only when exactly
one VM is configured. `scripts/rig env` shows the resolved values.

## Start every session with

```bash
scripts/rig list
scripts/rig -v NAME doctor
```

Choose the VM by its note. If no note fits the task, ask the user. `doctor`
checks every layer from libvirt to the desktop session and names the fix for
each failure. If no VM exists, create one by following
[references/provisioning.md](references/provisioning.md). If the VM is shut off,
run `scripts/rig -v NAME up`.

## Commands

| Need | Command |
| -- | -- |
| Clean state before a test | `rig reset` (reverts to the `clean` snapshot, about 30 s) |
| Run PowerShell, capture output | write a `.ps1`, then `rig ps FILE.ps1` |
| One-line query | `rig ssh 'Get-Service sshd'` (single-quote it locally) |
| Copy files | `rig put LOCAL [C:/dest/]`, `rig get REMOTE LOCAL` |
| Launch a GUI app visibly | write a `.ps1` that starts it, then `rig run-it FILE.ps1` |
| Wait for a desktop script to finish | `rig run-it --wait FILE.ps1` |
| Keyboard | `rig key KEY_TAB`, `rig key KEY_LEFTSHIFT KEY_TAB`, `rig type 'text'`, `rig type --enter` |
| Refocus a window | `rig focus PROCESSNAME` |
| Screenshot | `rig shot OUT.png`, then Read the PNG |
| Guest reaches a host service | `rig tunnel PORT` in the background; the guest uses `http://127.0.0.1:PORT/` |
| Same VM on another host, or another host driving this one | `rig copy`, `rig authorize`: see [references/provisioning.md](references/provisioning.md) |
| Finish | `rig cleanup` (removes `rig-*` tasks), then `rig down` unless told to leave it up |

## Rules the script cannot enforce

- **Never inline complex PowerShell in `rig ssh`.** The local shell eats `$` and
  PS 5.1 mangles nested quotes. Put anything with variables, pipes or quotes in
  a `.ps1` and use `rig ps` or `rig run-it`.
- **GUI apps started over SSH are invisible.** They run in the SSH session, not
  on the desktop. Use `rig run-it` for anything you need to see or screenshot.
  It runs as the logged-on user with a standard token. Add `--elevated` only
  when the app must run as admin.
- **Pass multi-word arguments with an array splat.** In the `.ps1`, write
  `$a = @('--title', 'Two Words'); & $exe @a`. Both
  `Start-Process -ArgumentList` and cmd `start ""` split quoted arguments at
  spaces on PS 5.1.
- **GUI-subsystem executables return immediately.** To wait for exit and capture
  stdout over SSH, pipe them: `& $exe @a | Out-String`.
- **Distrust the first screenshot after motion.** Frames captured during a
  scroll, dialog open, or window animation are torn and look like layout bugs.
  Before reporting a visual defect, capture again with `rig shot --settle 5`.
- **Keys go to the focused window.** If a screenshot shows another window in
  front, run `rig focus` before sending keys. Alt+Tab through `rig key` is
  unreliable.

Keyboard names, browser-in-guest checks and other GUI-driving details are in
[references/gui-driving.md](references/gui-driving.md). Running tests as SYSTEM,
safe toolchain locations, and Go test and race-detector setup are in
[references/native-testing.md](references/native-testing.md).

## Where project workflows live

This skill covers the VM, not any product. Build, deploy and smoke-test steps
for a project belong in that project's `AGENTS.md`, written in terms of `rig`
commands.
