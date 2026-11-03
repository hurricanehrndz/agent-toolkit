import assert from "node:assert/strict";
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, test } from "node:test";

import { assertExcludes, assertIncludes } from "./test-support.ts";

let sandbox: string;
let fakeBin: string;
let commandLog: string;
const script = resolve(import.meta.dirname, "toolkit-sync.mjs");

async function writeExecutable(name: string, body: string): Promise<void> {
	const path = join(fakeBin, name);
	await writeFile(path, `#!/bin/sh\nset -eu\n${body}`);
	await chmod(path, 0o755);
}

function sync(home: string, args: string[] = [], env: Record<string, string> = {}) {
	return spawnSync(process.execPath, [script, ...args, "--home", home], {
		encoding: "utf8",
		env: {
			...process.env,
			COMMAND_LOG: commandLog,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			...env,
		},
	});
}

beforeEach(async () => {
	sandbox = realpathSync(await mkdtemp(join(tmpdir(), "agent-toolkit-respec-sync-")));
	fakeBin = join(sandbox, "bin");
	commandLog = join(sandbox, "commands.log");
	await mkdir(fakeBin);
	await writeExecutable(
		"git",
		`printf 'git:%s\\n' "$*" >> "$COMMAND_LOG"
case "$1" in
    clone)
        mkdir -p "$3"
        touch "$3/justfile"
        ;;
    -C)
        checkout="$2"
        shift 2
        case "$1" in
            rev-parse)
                [ "$2" = --show-toplevel ]
                [ "\${RESPEC_TEST_NOT_GIT:-}" != 1 ] || exit 128
                printf '%s\\n' "\${RESPEC_TEST_ROOT:-$checkout}"
                ;;
            remote)
                [ "$2" = get-url ]
                [ "$3" = origin ]
                printf '%s\\n' "\${RESPEC_TEST_ORIGIN:-https://github.com/hurricanehrndz/respec}"
                ;;
            status)
                [ "$2" = --porcelain=v1 ]
                printf '%s' "\${RESPEC_TEST_STATUS:-}"
                ;;
            pull)
                [ "$2" = --ff-only ]
                ;;
            *)
                exit 1
                ;;
        esac
        ;;
    *)
        exit 1
        ;;
esac
`,
	);
	await writeExecutable(
		"mise",
		`printf 'mise:%s:%s:%s\\n' "$PWD" "$HOME" "$*" >> "$COMMAND_LOG"
if [ "$1" = install ]; then
    exit 0
fi
[ "$1" = exec ]
shift
[ "$1" = -- ]
shift
exec "$@"
`,
	);
	await writeExecutable(
		"just",
		`printf 'just:%s:%s:%s\\n' "$PWD" "$HOME" "$*" >> "$COMMAND_LOG"
mkdir -p "$HOME/.local/bin"
touch "$HOME/.local/bin/respec"
`,
	);
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

describe("toolkit respec sync", () => {
	test("clones a missing checkout, installs its tools, and installs respec", async () => {
		const home = join(sandbox, "home");
		const result = sync(home);

		assert.equal(result.status, 0, result.stderr);
		const checkout = join(home, "src/me/respec");
		const log = await readFile(commandLog, "utf8");
		assertIncludes(log, `git:clone https://github.com/hurricanehrndz/respec ${checkout}\n`);
		assertIncludes(log, `mise:${checkout}:${home}:install\n`);
		assertIncludes(log, `mise:${checkout}:${home}:exec -- just install\n`);
		assertIncludes(log, `just:${checkout}:${home}:install\n`);
		assert.equal(existsSync(join(home, ".local/bin/respec")), true);
	});

	test("fast-forwards a clean existing checkout before installing", async () => {
		const home = join(sandbox, "home");
		const checkout = join(home, "src/me/respec");
		await mkdir(checkout, { recursive: true });
		await writeFile(join(checkout, "justfile"), "install:\n");

		const result = sync(home);

		assert.equal(result.status, 0, result.stderr);
		const log = await readFile(commandLog, "utf8");
		assertIncludes(log, `git:-C ${checkout} pull --ff-only\n`);
		assertIncludes(log, `mise:${checkout}:${home}:install\n`);
		assertIncludes(log, `mise:${checkout}:${home}:exec -- just install\n`);
		assertIncludes(log, `just:${checkout}:${home}:install\n`);
	});

	test("does not update a dirty existing checkout", async () => {
		const home = join(sandbox, "dirty-home");
		const checkout = join(home, "src/me/respec");
		await mkdir(checkout, { recursive: true });

		const result = sync(home, [], { RESPEC_TEST_STATUS: " M justfile\n" });

		assert.equal(result.status, 0, result.stderr);
		assertIncludes(result.stdout, `respec checkout has local changes; skip update: ${checkout}\n`);
		const log = await readFile(commandLog, "utf8");
		assertExcludes(log, `git:-C ${checkout} pull --ff-only\n`);
		assertIncludes(log, `mise:${checkout}:${home}:install\n`);
	});

	test("rejects a directory that is not a Git checkout", async () => {
		const home = join(sandbox, "not-git-home");
		const checkout = join(home, "src/me/respec");
		await mkdir(checkout, { recursive: true });

		const result = sync(home, [], { RESPEC_TEST_NOT_GIT: "1" });

		assert.equal(result.status, 2);
		assertIncludes(result.stderr, `respec checkout is not a Git checkout: ${checkout}`);
		const log = await readFile(commandLog, "utf8");
		assertExcludes(log, "mise:");
	});

	test("rejects an existing checkout with an unexpected origin", async () => {
		const home = join(sandbox, "wrong-origin-home");
		const checkout = join(home, "src/me/respec");
		await mkdir(checkout, { recursive: true });

		const result = sync(home, [], { RESPEC_TEST_ORIGIN: "https://github.com/other/respec" });

		assert.equal(result.status, 2);
		assertIncludes(result.stderr, `respec checkout has unexpected origin 'https://github.com/other/respec': ${checkout}`);
		const log = await readFile(commandLog, "utf8");
		assertExcludes(log, "mise:");
	});

	test("dry-run previews clone and install without mutation", () => {
		const home = join(sandbox, "dry-run-home");
		const result = sync(home, ["--dry-run"]);

		assert.equal(result.status, 0, result.stderr);
		assertIncludes(result.stdout, `clone respec: https://github.com/hurricanehrndz/respec -> ${join(home, "src/me/respec")}\n`);
		assertIncludes(result.stdout, `install respec tools: ${join(home, "src/me/respec")}\n`);
		assertIncludes(result.stdout, `install respec: ${join(home, "src/me/respec")}\n`);
		assert.equal(existsSync(commandLog), false);
		assert.equal(existsSync(home), false);
	});

	test("dry-run previews a clean checkout update without pulling", async () => {
		const home = join(sandbox, "dry-run-existing-home");
		const checkout = join(home, "src/me/respec");
		await mkdir(checkout, { recursive: true });

		const result = sync(home, ["--dry-run"]);

		assert.equal(result.status, 0, result.stderr);
		assertIncludes(result.stdout, `update respec checkout: ${checkout}\n`);
		const log = await readFile(commandLog, "utf8");
		assertExcludes(log, `git:-C ${checkout} pull --ff-only\n`);
		assertExcludes(log, "mise:");
	});

	test("does not replace a non-directory checkout path", async () => {
		const home = join(sandbox, "conflict-home");
		const checkout = join(home, "src/me/respec");
		await mkdir(dirname(checkout), { recursive: true });
		await writeFile(checkout, "keep");

		const result = sync(home);

		assert.equal(result.status, 2);
		assertIncludes(result.stderr, `respec checkout path is not a directory: ${checkout}`);
		assert.equal(await readFile(checkout, "utf8"), "keep");
		assert.equal(existsSync(commandLog), false);
	});
});

describe("toolkit bin links", () => {
	const skills = resolve(import.meta.dirname, "../skills");
	const rig = join(skills, "windows-test-rig/scripts/rig");
	const mac = join(skills, "macos-test-rig/scripts/mac");

	test("links each requested test-rig command into ~/.local/bin", () => {
		const home = join(sandbox, "bins-home");
		const result = sync(home, ["--bin", "rig,mac"]);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(readlinkSync(join(home, ".local/bin/rig")), rig);
		assert.equal(readlinkSync(join(home, ".local/bin/mac")), mac);
	});

	// Turning an option off must take the command away, including a link made
	// by hand through another path, but nothing that points elsewhere.
	test("removes links to commands that are no longer requested and keeps foreign ones", async () => {
		const home = join(sandbox, "unrequested-home");
		const bin = join(home, ".local/bin");
		await mkdir(bin, { recursive: true });
		await symlink(skills, join(sandbox, "skills-alias"));
		await symlink(join(sandbox, "skills-alias/windows-test-rig/scripts/rig"), join(bin, "rig"));
		await symlink("/usr/bin/true", join(bin, "mac"));

		const result = sync(home);

		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(join(bin, "rig")), false);
		assert.equal(readlinkSync(join(bin, "mac")), "/usr/bin/true");
	});

	test("refuses to replace a regular file", async () => {
		const home = join(sandbox, "file-home");
		const bin = join(home, ".local/bin");
		await mkdir(bin, { recursive: true });
		await writeFile(join(bin, "rig"), "keep");

		const result = sync(home, ["--bin", "rig"]);

		assert.equal(result.status, 2);
		assertIncludes(result.stderr, `${join(bin, "rig")} is not a symlink; left unchanged`);
		assert.equal(await readFile(join(bin, "rig"), "utf8"), "keep");
	});

	test("rejects an unknown command", () => {
		const result = sync(join(sandbox, "unknown-home"), ["--bin", "nope"]);

		assert.equal(result.status, 2);
		assertIncludes(result.stderr, 'Unknown bin "nope"');
	});

	test("dry-run previews links without creating them", () => {
		const home = join(sandbox, "bins-dry-run-home");
		const result = sync(home, ["--bin", "mac", "--dry-run"]);

		assert.equal(result.status, 0, result.stderr);
		assertIncludes(result.stdout, `link mac: ${join(home, ".local/bin/mac")} -> ${mac}\n`);
		assert.equal(existsSync(join(home, ".local/bin/mac")), false);
	});
});
