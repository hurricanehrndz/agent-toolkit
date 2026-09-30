# Driving the Windows desktop

## Keys

`rig key` sends one chord through `virsh send-key`, using Linux input key names.
Keys in one call are held together.

| Key | Name |
| -- | -- |
| Enter, Esc, Tab, Space | `KEY_ENTER`, `KEY_ESC`, `KEY_TAB`, `KEY_SPACE` |
| Arrows, paging | `KEY_UP`, `KEY_DOWN`, `KEY_LEFT`, `KEY_RIGHT`, `KEY_PAGEDOWN`, `KEY_PAGEUP`, `KEY_HOME`, `KEY_END` |
| Modifiers | `KEY_LEFTSHIFT`, `KEY_LEFTCTRL`, `KEY_LEFTALT`, `KEY_LEFTMETA` (Windows key) |
| Function keys | `KEY_F1` … `KEY_F12` |

Examples: `rig key KEY_LEFTSHIFT KEY_TAB`, `rig key KEY_LEFTCTRL KEY_A`,
`rig key KEY_LEFTMETA KEY_R` (Run dialog).

`rig type` covers US-layout printable ASCII. It sends one chord per character,
so keep strings short. For long text, write a file with `rig put` instead.

## Walking a UI by keyboard

Tab order is the most reliable navigation. Press `KEY_TAB` and take a
screenshot until the focus ring sits on the target, then press `KEY_ENTER` or
`KEY_SPACE`. Tally the Tab presses once and replay the count on later runs.
Take a new screenshot after each state change. Do not chain presses blind
across a transition, because an animation can swallow keys.

## Checking a web frontend in the guest

The host has no browser for the agent. To check a dev server running on the
host in real Edge:

1. Start the dev server on the host. Vite binds IPv6 loopback, so tunnel it with
   `rig tunnel 5173 '[::1]:5173'`. Quote the brackets, or zsh globs them.
1. `rig run-it` a `.ps1` that runs
   `& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --user-data-dir=C:\rig\edge --no-first-run --no-default-browser-check --app=http://127.0.0.1:5173/`.
   Without these flags the first-run welcome page covers the app.

## Guest-to-host networking

On many hosts the firewall drops guest-to-host TCP on the libvirt bridge, even
though ping works. Do not debug that. Run `rig tunnel PORT` in the background
and point guest configuration at `http://127.0.0.1:PORT/`. The tunnel lasts as
long as its SSH process.

## Processes that run as SYSTEM

Services run in session 0 and never draw on the desktop. Check them with
`rig ssh 'Get-Service NAME'`. `Stop-Service` blocks on a service stuck in
`StopPending`, so stop it with `sc.exe stop NAME`, then kill
`(Get-CimInstance Win32_Service -Filter "Name='NAME'").ProcessId` from a
`.ps1`.
