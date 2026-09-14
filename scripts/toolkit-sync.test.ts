import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

let sandbox: string;
let fakeBin: string;
let commandLog: string;
const script = resolve(import.meta.dir, "toolkit-sync.mjs");

async function writeExecutable(name: string, body: string): Promise<void> {
	const path = join(fakeBin, name);
	await writeFile(path, `#!/bin/sh\nset -eu\n${body}`);
	await chmod(path, 0o755);
}

function sync(home: string, args: string[] = []) {
	return spawnSync(process.execPath, [script, ...args, "--home", home], {
		encoding: "utf8",
		env: {
			...process.env,
			COMMAND_LOG: commandLog,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
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
[ "$1" = clone ]
mkdir -p "$3"
touch "$3/justfile"
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

		expect(result.status, result.stderr).toBe(0);
		const checkout = join(home, "src/me/respec");
		const log = await Bun.file(commandLog).text();
		expect(log).toContain(`git:clone https://github.com/hurricanehrndz/respec ${checkout}\n`);
		expect(log).toContain(`mise:${checkout}:${home}:install\n`);
		expect(log).toContain(`mise:${checkout}:${home}:exec -- just install\n`);
		expect(log).toContain(`just:${checkout}:${home}:install\n`);
		expect(await Bun.file(join(home, ".local/bin/respec")).exists()).toBeTrue();
	});

	test("uses an existing checkout without cloning it", async () => {
		const home = join(sandbox, "home");
		const checkout = join(home, "src/me/respec");
		await mkdir(checkout, { recursive: true });
		await writeFile(join(checkout, "justfile"), "install:\n");

		const result = sync(home);

		expect(result.status, result.stderr).toBe(0);
		const log = await Bun.file(commandLog).text();
		expect(log).not.toContain("git:");
		expect(log).toContain(`mise:${checkout}:${home}:install\n`);
		expect(log).toContain(`mise:${checkout}:${home}:exec -- just install\n`);
		expect(log).toContain(`just:${checkout}:${home}:install\n`);
	});

	test("dry-run previews clone and install without mutation", () => {
		const home = join(sandbox, "dry-run-home");
		const result = sync(home, ["--dry-run"]);

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(
			`clone respec: https://github.com/hurricanehrndz/respec -> ${join(home, "src/me/respec")}\n`,
		);
		expect(result.stdout).toContain(`install respec tools: ${join(home, "src/me/respec")}\n`);
		expect(result.stdout).toContain(`install respec: ${join(home, "src/me/respec")}\n`);
		expect(Bun.file(commandLog).size).toBe(0);
		expect(Bun.file(home).size).toBe(0);
	});

	test("does not replace a non-directory checkout path", async () => {
		const home = join(sandbox, "conflict-home");
		const checkout = join(home, "src/me/respec");
		await mkdir(dirname(checkout), { recursive: true });
		await writeFile(checkout, "keep");

		const result = sync(home);

		expect(result.status).toBe(2);
		expect(result.stderr).toContain(`respec checkout path is not a directory: ${checkout}`);
		expect(await Bun.file(checkout).text()).toBe("keep");
		expect(Bun.file(commandLog).size).toBe(0);
	});
});
