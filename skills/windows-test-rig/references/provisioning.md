# Creating the Windows test VM

`rig provision` builds the VM from a Windows 11 ISO with no clicks. It takes
20-40 minutes and ends with a shut-off VM and a `clean` snapshot.

## 1. Host prerequisites

- libvirt with QEMU/KVM on `qemu:///system`, the `default` network active and
  set to autostart, and the `default` storage pool active. Your user must be
  in the `libvirtd` (or `libvirt`) group. On NixOS, set
  `virtualisation.libvirtd.enable = true;` (OVMF ships by default) and add the
  user to `libvirtd`. Use the `nixos` skill for that change.
- `virt-install`, `virsh`, `ssh`/`scp`, and ImageMagick `magick`.
- `xorriso`, or `nix` with flakes. The script falls back to
  `nix shell nixpkgs#xorriso`.
- An SSH key pair. The default is `~/.ssh/id_ed25519`. Only its public half is
  written into the unattend file.
- About 70 GB free in the pool (a 64 GB sparse disk plus the ISO), 8 GB RAM,
  and 6 vCPUs to spare. Change the sizes with `--memory`, `--vcpus` and
  `--disk`.

No swtpm or virtio driver ISO is needed. The unattend file bypasses the TPM,
Secure Boot and RAM checks, and the VM uses SATA and e1000e, which have inbox
drivers.

## 2. Get an ISO

The user downloads it, because it sits behind a form. Get the Windows 11 Enterprise
evaluation (x64, ISO, English) from the Microsoft Evaluation Center. Any
Windows 11 x64 ISO works, but a retail ISO needs a product key added to the
unattend file. Image index 1 must be the edition you want, and it is in the
Enterprise evaluation ISO.

## 3. Provision

```bash
scripts/rig -v win11-test provision --iso ~/Downloads/Win11_Enterprise_Eval.iso --dry-run   # renders and validates, creates nothing
scripts/rig -v win11-test provision --iso ~/Downloads/Win11_Enterprise_Eval.iso
scripts/rig -v win11-test up && scripts/rig -v win11-test doctor
```

The VM name is also the libvirt domain and the Windows computer name, so keep
it to 15 characters or fewer. If `vms/NAME.env` does not exist, provisioning
writes it with user `tester`, a generated password, a dated `RIG_NOTE`, and
mode 0600. To use other values, write the file first. Every VM needs its own
name. Once the VM exists, update `RIG_NOTE` with what it is for, because
`rig list` is how agents choose between VMs.

What happens:

1. The ISO is uploaded into the storage pool if libvirt cannot already see it
   there. This happens once.
1. `provision/autounattend.xml.in` is rendered with the names, password and
   public key, then packed into a small ISO that is attached as a second CD
   drive.
1. `virt-install` starts the VM. The script presses Enter while the console is dark, to catch
   "Press any key to boot from CD". The saved boot order is disk, then CD, so if
   the prompt is missed, `virsh destroy` and `virsh start` followed by
   `rig key KEY_ENTER` presses retry the CD boot.
1. Setup reboots several times. The install config powers off at the first
   reboot, and the script starts the VM again each time.
1. At first logon the unattend file installs OpenSSH (PowerShell as default
   shell), authorizes the key for administrators, sets the network to Private,
   sets the password to never expire, disables sleep and screen blanking, and
   creates `C:\rig`.
1. Once `C:\rig` is visible over SSH, the script shuts the VM down, ejects both
   ISOs, deletes the unattend ISO (it holds the password), and takes the `clean`
   snapshot.

## If it stalls

Start with `rig shot`.

| Screen | Fix |
| -- | -- |
| UEFI shell or "no bootable device" | The key press missed the CD prompt. `virsh destroy`, `virsh start`, then `rig key KEY_ENTER` repeatedly for 10 s. |
| Setup asks for disk, edition or key | The unattend ISO was not read. Check `virsh domblklist DOMAIN --details` for two cdroms. A retail ISO needs a key. |
| OOBE asks for network or Microsoft account | This Windows build ignores `HideOnlineAccountScreens`. Press Shift+F10, run `OOBE\BYPASSNRO`, and let it reboot. |
| Desktop is up but SSH never answers | A first-logon command failed. Open a terminal with `rig type`/`rig key` and rerun the failed step from the unattend file. |
| "Your password has expired" at logon | The VM predates the never-expire step. From a `.ps1` run `net accounts /maxpwage:unlimited; Set-LocalUser $env:USERNAME -PasswordNeverExpires $true`, then reboot. |

## Evaluation expiry

The Enterprise evaluation runs 90 days from install. After that, `rig doctor`
warns "not licensed (status 5)", the desktop shows "Windows License is
expired", and Windows shuts down about every hour, which breaks long test
runs. Reverting to `clean` does not help, because the clock is wall time. The
fix is to rebuild: `virsh undefine DOMAIN --nvram --snapshots-metadata --storage sda`,
then provision again from a current ISO. That destroys the VM, so confirm with
the user first. `slmgr /rearm` exists, but whether it extends an evaluation is
unverified here.

Do not use `--remove-all-storage` on a VM that still has CD media attached: it
deletes the attached install ISO from the pool too. `--storage sda` removes only
the system disk.
## Another host needs the same VM

Provision once, then copy. That is faster than a second install, and both
copies expire together, so they are rebuilt together.

```bash
rig -v win11-test down
rig -v win11-test copy qemu+ssh://USER@OTHERHOST/system   # writes vms/OTHERHOST-win11-test.env here
rig -v OTHERHOST-win11-test authorize ~/.ssh/id_ed25519.pub   # only if OTHERHOST's own rig key must drive it too; see below
```

`copy` streams the disk (the used size, about 13 GB for a fresh install)
through this host, defines the domain there, and re-registers the `clean`
snapshot. It drops everything tied to this host: firmware and NVRAM paths (the
guest boots through the UEFI fallback loader) and the CPU-vendor-only Hyper-V
features `evmcs` (Intel) and `avic` (AMD). QEMU refuses to start with the other
vendor's feature.

Every host that drives a VM needs, once:

- its SSH key authorized on each remote libvirt host (`~/.ssh/authorized_keys`),
  and the other host's key in its `known_hosts` under the name or IP its SSH
  config resolves to;
- its user in that host's `libvirtd` group, and the `default` network active
  with autostart (`virsh net-start default; virsh net-autostart default`);
- its rig key inside each guest: `rig -v NAME authorize KEY.pub`, then
  `rig -v NAME down && rig -v NAME snapshot clean` so a reset keeps it. The
  unattend file only authorizes the provisioning host's key.
- its own `vms/NAME.env` for each VM it drives. Configs are per host, and the
  file name is only a local label for the remote `RIG_DOMAIN`.

On NixOS hosts using `nixcfg`, `hrndz.roles.vmHost.windowsTestRig.enable`
installs the host tools.

## Adopting an existing VM

Write `~/.config/windows-test-rig/vms/NAME.env` by hand with that VM's
`RIG_DOMAIN` (if it differs from NAME), `RIG_USER`, `RIG_KEY` and `RIG_NOTE`.
Then run `rig -v NAME doctor`, fix what it reports, and finish with
`rig -v NAME down && rig -v NAME snapshot clean`.
