# Native testing in the guest

## Running as SYSTEM

`tester` is an elevated admin, not SYSTEM. To run a script as
`NT AUTHORITY\SYSTEM`, register a one-shot scheduled task, run it, poll for the
file the script writes, then delete the task:

```powershell
$task = 'rig-myproj-run'
schtasks /create /tn $task /ru SYSTEM /sc once /st 23:59 /f /tr "powershell -NoProfile -ExecutionPolicy Bypass -File C:\ck\run.ps1" | Out-Null
schtasks /run /tn $task | Out-Null
for ($i = 0; $i -lt 300 -and -not (Test-Path C:\ck\out.txt); $i++) { Start-Sleep 1 }
schtasks /delete /tn $task /f | Out-Null
Get-Content C:\ck\out.txt
```

Name tasks `rig-*` so `rig cleanup` removes leftovers.

## Running as a standard user

A VM whose config defines `RIG_STD_USER` and `RIG_STD_PASSWORD` has a non-admin
local account (see
[provisioning.md](provisioning.md#a-standard-non-admin-user)). Read the values
from `~/.config/windows-test-rig/vms/NAME.env` into the guest script you
`rig put`, and never echo them. A test that runs as SYSTEM or as the admin can
then call `LogonUserW` (interactive logon) and impersonate the token on a locked
OS thread. Check the token's group list for Administrators rather than calling
`CheckTokenMembership`, which needs an impersonation token.

## Where to put toolchains and sources

SYSTEM must not execute anything a standard user can modify. On a default
install:

- `C:\Program Files\...` inherits a DACL that only TrustedInstaller, SYSTEM and
  Administrators can write. Unpack toolchain zips there.
- A new folder directly under `C:\` inherits modify rights for Authenticated
  Users, and one under `C:\ProgramData` inherits add-file and add-subfolder
  rights for Users. Before putting sources or caches in such a folder, lock it
  down:
  `icacls C:\ck /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"`.

Set tool paths and caches inside each script, not in the machine PATH. Give
SYSTEM its own cache directory (for example a separate `GOCACHE`).

## Go test binaries

- Cross-compiling on the host (`GOOS=windows go test -c -o pkg.test.exe ./pkg`)
  and `rig put` avoids installing Go in the guest.
- PS 5.1 splits `-test.v` into `-test` and `.v`. Pass flags through an array
  splat in their `=` form:
  `$a = @('-test.v=true', '-test.count=1'); & .\pkg.test.exe @a`.
- For an offline guest, `go mod vendor` on the host, copy the tree, and set
  `GOFLAGS=-mod=vendor GOPROXY=off GOTOOLCHAIN=local`.

## Go race detector

Observed on Windows 11 25H2 build 26200, amd64, with Go 1.26.6, 1.26.8 and
1.27.1. Go downloaded zips in the guest.

`-race` needs `CGO_ENABLED=1` and a C compiler with mingw-w64 runtime v8 or
later. The compiler passes Go's check if
`CC --print-file-name libsynchronization.a` prints a full path rather than
echoing the name.

zig 0.17.0 (`CC="zig cc -target x86_64-windows-gnu"`) fails that check and needs
two workarounds:

1. **Link error** `undefined symbol: WaitOnAddress`. zig has no
   `libsynchronization.a`. Set `CGO_LDFLAGS=-lapi-ms-win-core-synch-l1-2-0`,
   which provides the same symbols.
1. **Startup abort** `ThreadSanitizer failed to allocate ... (error code: 87)`,
   exit 66, even for hello world. The failing addresses sit just above 2^48.
   lld's linker driver rejects `--disable-dynamicbase` and
   `--disable-high-entropy-va`. Clearing both bits after the build makes the
   binary run: in the PE optional header, `DllCharacteristics` sits at
   `e_lfanew + 24 + 70`; clear `0x40` (DYNAMIC_BASE) and `0x20`
   (HIGH_ENTROPY_VA). Clearing only `0x20` is not enough. To patch test
   binaries, use `go test -race -c` and patch before running.

Because zig cross-compiles, the same build works on a macOS or Linux host, and
the guest needs no toolchain at all:

```bash
GOOS=windows GOARCH=amd64 CGO_ENABLED=1 \
  CC="zig cc -target x86_64-windows-gnu" CXX="zig c++ -target x86_64-windows-gnu" \
  CGO_LDFLAGS=-lapi-ms-win-core-synch-l1-2-0 \
  go test -race -c -o pkg.test.exe ./pkg
python3 - pkg.test.exe <<'EOF'
import struct, sys
b = bytearray(open(sys.argv[1], 'rb').read())
off = struct.unpack_from('<I', b, 0x3C)[0] + 24 + 70
struct.pack_into('<H', b, off, struct.unpack_from('<H', b, off)[0] & ~0x60)
open(sys.argv[1], 'wb').write(b)
EOF
rig put pkg.test.exe C:/rig/
```

Patch only test binaries. A shipped binary keeps ASLR.

For native builds in the guest, use a mingw-w64 GCC instead. WinLibs
`x86_64-posix-seh` UCRT (GCC 16.2.0, mingw-w64 14.0.0) passes the
`libsynchronization.a` check. With `CC=gcc`, `-race` builds and runs with no
extra flags and no patching, as tester and as SYSTEM. GNU ld does not set
DYNAMIC_BASE or HIGH_ENTROPY_VA (`DllCharacteristics` is `0x8100`), which is why
the startup abort does not occur.

Unpack WinLibs to a path without spaces, such as `C:\winlibs`. Under
`C:\Program Files`, ld splits the path and fails with `cannot find C:/Program`,
and an 8.3 short path does not help. Because `C:\` subfolders inherit
Authenticated Users modify rights, lock the folder down with the `icacls`
command above, plus Users read and execute (`"*S-1-5-32-545:(OI)(CI)RX"`).
