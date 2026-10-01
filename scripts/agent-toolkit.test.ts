import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { run } from "./agent-toolkit.mjs";
import { assertExcludes, assertIncludes } from "./test-support.ts";

let sandbox: string;
let repoRoot: string;
let home: string;
let overrides: Record<string, string[]>;

const roots = {
	pi: ".pi/agent/skills",
	prime: ".prime/agent/skills",
	codex: ".codex/skills",
	claude: ".claude/skills",
} as const;

const contextDestinations = {
	pi: ".pi/agent/APPEND_SYSTEM.md",
	prime: ".prime/agent/APPEND_SYSTEM.md",
	codex: ".codex/AGENTS.md",
	claude: ".claude/CLAUDE.md",
} as const;

async function writeConfig(value: unknown = { skills: overrides }): Promise<void> {
	await writeFile(join(repoRoot, "agent-toolkit.json"), `${JSON.stringify(value, null, 2)}
`);
}

async function addSkill(name: string, agents?: string[]): Promise<string> {
	const path = join(repoRoot, "skills", name);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "SKILL.md"), `---
name: ${name}
description: Use ${name} while testing.
---

# ${name}
`);
	if (agents !== undefined) {
		overrides[name] = agents;
		await writeConfig();
	}
	return path;
}

async function addContextSource(template = "# Working style\n"): Promise<string> {
	const path = join(repoRoot, "context/working-style.md.j2");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, template);
	return path;
}

function distPath(agent: keyof typeof contextDestinations): string {
	return join(repoRoot, "context/dist", `${agent}.md`);
}

async function capture(callback: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const out = mock.method(process.stdout, "write", ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write);
	const err = mock.method(process.stderr, "write", ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write);
	try {
		return { code: await callback(), stdout, stderr };
	} finally {
		out.mock.restore();
		err.mock.restore();
	}
}

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "agent-toolkit-installer-"));
	repoRoot = join(sandbox, "repo");
	home = join(sandbox, "home");
	overrides = {};
	await mkdir(join(repoRoot, "skills"), { recursive: true });
	await mkdir(home, { recursive: true });
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

describe("agent-toolkit installer", () => {
	test("defaults discovered skills to all agents and applies partial scope overrides", async () => {
		const portable = await addSkill("portable");
		const piOnly = await addSkill("pi-only", ["pi"]);

		assert.equal(await run(["install", "--home", home], repoRoot), 0);
		for (const [agent, relativeRoot] of Object.entries(roots)) {
			const portableLink = join(home, relativeRoot, "portable");
			assert.equal(resolve(join(portableLink, ".."), readlinkSync(portableLink)), portable);
			const piLink = join(home, relativeRoot, "pi-only");
			if (agent === "pi") {
				assert.equal(resolve(join(piLink, ".."), readlinkSync(piLink)), piOnly);
			} else {
				assert.equal(existsSync(piLink), false);
			}
		}
	});

	test("without config, --agent all and repeated selected agents use the four exact roots", async () => {
		await addSkill("example");
		const cases = [
			{ args: [], installationHome: join(sandbox, "default-home") },
			{ args: ["--agent", "all"], installationHome: join(sandbox, "all-home") },
			{ args: ["--agent", "pi,prime", "--agent", "codex,claude"], installationHome: join(sandbox, "selected-home") },
		];
		for (const { args, installationHome } of cases) {
			assert.equal(await run(["install", ...args, "--home", installationHome], repoRoot), 0);
			for (const relativeRoot of Object.values(roots)) {
				assert.equal(lstatSync(join(installationHome, relativeRoot, "example")).isSymbolicLink(), true);
			}
		}
	});

	test("rejects all combined with a named agent across repeated flags", async () => {
		await addSkill("example");
		for (const args of [
			["--agent", "all,pi"],
			["--agent", "all", "--agent", "pi"],
			["--agent", "pi", "--agent", "all"],
		]) {
			const result = await capture(() => run(["install", ...args, "--home", home], repoRoot));
			assert.equal(result.code, 2);
			assertIncludes(result.stderr, '"all" cannot be combined with named agents.');
		}
	});

	test("dry-run reports scoped changes without creating roots", async () => {
		await addSkill("pi-only", ["pi"]);
		const result = await capture(() => run(["sync", "--dry-run", "--home", home], repoRoot));
		assert.equal(result.code, 0);
		assertIncludes(result.stdout, "Dry run: 1 change(s) would be made.");
		for (const relativeRoot of Object.values(roots)) {
			assert.equal(existsSync(join(home, relativeRoot)), false);
		}
	});

	test("sync removes a checkout-owned link after its agent scope changes", async () => {
		const skill = await addSkill("scoped", ["pi", "prime"]);
		assert.equal(await run(["install", "--home", home], repoRoot), 0);
		overrides.scoped = ["pi"];
		await writeConfig();
		assert.equal(await run(["sync", "--agent", "prime", "--home", home], repoRoot), 0);
		assert.equal(existsSync(join(home, roots.prime, "scoped")), false);
		assert.equal(resolve(join(home, roots.pi, "scoped/.."), readlinkSync(join(home, roots.pi, "scoped"))), skill);
	});

	test("existing files, directories, and external links are conflicts and are not replaced", async () => {
		await addSkill("example");
		const destinations = [join(home, roots.pi, "example"), join(home, roots.prime, "example"), join(home, roots.codex, "example")];
		await mkdir(join(home, roots.pi), { recursive: true });
		await writeFile(destinations[0]!, "keep");
		await mkdir(destinations[1]!, { recursive: true });
		const external = join(sandbox, "external");
		await mkdir(external);
		await mkdir(join(home, roots.codex), { recursive: true });
		await symlink(external, destinations[2]!);
		assert.equal(await run(["sync", "--agent", "pi,prime,codex", "--home", home], repoRoot), 1);
		assert.equal(await readFile(destinations[0]!, "utf8"), "keep");
		assert.equal(lstatSync(destinations[1]!).isDirectory(), true);
		assert.equal(readlinkSync(destinations[2]!), external);
	});

	test("links from a moved checkout conflict and survive sync and uninstall", async () => {
		await addSkill("example");
		const oldSkill = join(sandbox, "old-checkout/skills/example");
		const destination = join(home, roots.claude, "example");
		await mkdir(oldSkill, { recursive: true });
		await mkdir(join(home, roots.claude), { recursive: true });
		await symlink(oldSkill, destination);
		assert.equal(await run(["sync", "--agent", "claude", "--home", home], repoRoot), 1);
		assert.equal(await run(["uninstall", "--agent", "claude", "--home", home], repoRoot), 0);
		assert.equal(resolve(join(destination, ".."), readlinkSync(destination)), oldSkill);
	});

	test("sync and uninstall preserve unmanaged and separately managed resources", async () => {
		await addSkill("managed");
		const root = join(home, roots.codex);
		await mkdir(join(root, "respec"), { recursive: true });
		await writeFile(join(root, "file"), "keep");
		await writeFile(join(root, "respec/SKILL.md"), "separate owner");
		const brokenExternal = join(sandbox, "missing-external");
		await symlink(brokenExternal, join(root, "external"));
		assert.equal(await run(["sync", "--agent", "codex", "--home", home], repoRoot), 0);
		assert.equal(await run(["uninstall", "--agent", "codex", "--home", home], repoRoot), 0);
		assert.equal(await readFile(join(root, "file"), "utf8"), "keep");
		assert.equal(await readFile(join(root, "respec/SKILL.md"), "utf8"), "separate owner");
		assert.equal(readlinkSync(join(root, "external")), brokenExternal);
		assert.equal(existsSync(join(root, "managed")), false);
	});

	test("uninstall removes even deleted-skill links owned by this checkout", async () => {
		await addSkill("current");
		const root = join(home, roots.pi);
		await mkdir(root, { recursive: true });
		await symlink(join(repoRoot, "skills/removed"), join(root, "removed"));
		assert.equal(await run(["install", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.equal(await run(["uninstall", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.equal(existsSync(join(root, "current")), false);
		assert.equal(existsSync(join(root, "removed")), false);
	});

	test("recognizes current and broken stale relative links owned by the checkout", async () => {
		const skill = await addSkill("relative");
		const destination = join(home, roots.pi, "relative");
		const stale = join(home, roots.pi, "removed");
		await mkdir(dirname(destination), { recursive: true });
		await symlink(relative(dirname(destination), skill), destination);
		await symlink(relative(dirname(stale), join(repoRoot, "skills/removed")), stale);
		assert.equal(await run(["sync", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.equal(readlinkSync(destination), relative(dirname(destination), skill));
		assert.throws(() => lstatSync(stale));
	});

	test("dry-run sync and uninstall report removals without removing links", async () => {
		await addSkill("scoped", ["prime"]);
		assert.equal(await run(["install", "--agent", "prime", "--home", home], repoRoot), 0);
		const destination = join(home, roots.prime, "scoped");
		overrides.scoped = ["pi"];
		await writeConfig();
		const sync = await capture(() => run(["sync", "--agent", "prime", "--dry-run", "--home", home], repoRoot));
		assertIncludes(sync.stdout, "Dry run: 1 change(s) would be made.");
		assert.equal(lstatSync(destination).isSymbolicLink(), true);
		const uninstall = await capture(() => run(["uninstall", "--agent", "prime", "--dry-run", "--home", home], repoRoot));
		assertIncludes(uninstall.stdout, "Dry run: 1 change(s) would be made.");
		assert.equal(lstatSync(destination).isSymbolicLink(), true);
	});

	test("status returns a conflict exit code without changing the destination", async () => {
		await addSkill("example", ["pi"]);
		const destination = join(home, roots.pi, "example");
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, "keep");
		const result = await capture(() => run(["status", "--agent", "pi", "--home", home], repoRoot));
		assert.equal(result.code, 1);
		assertIncludes(result.stdout, "1 conflicts");
		assert.equal(await readFile(destination, "utf8"), "keep");
	});

	test("status considers only skills scoped to the selected agent", async () => {
		await addSkill("pi-only", ["pi"]);
		await addSkill("portable");
		const result = await capture(() => run(["status", "--agent", "prime", "--home", home], repoRoot));
		assert.equal(result.code, 0);
		assertIncludes(result.stdout, "prime: 0 linked, 1 missing, 0 conflicts");
	});

	test("renders per-agent context and links exact destinations for selected agents", async () => {
		await addContextSource(
			'# Working style\n{% if agent in ["pi", "prime"] %}\nSerial.\n{% endif %}\n{% if agent == "claude" %}\nParallel.\n{% endif %}\nEnd.\n',
		);
		const expected = {
			pi: "# Working style\nSerial.\nEnd.\n",
			prime: "# Working style\nSerial.\nEnd.\n",
			codex: "# Working style\nEnd.\n",
			claude: "# Working style\nParallel.\nEnd.\n",
		};
		const allHome = join(sandbox, "all-context-home");
		assert.equal(await run(["install", "--home", allHome], repoRoot), 0);
		for (const agent of Object.keys(contextDestinations) as Array<keyof typeof contextDestinations>) {
			const destination = join(allHome, contextDestinations[agent]);
			assert.equal(lstatSync(destination).isSymbolicLink(), true);
			assert.equal(resolve(dirname(destination), readlinkSync(destination)), distPath(agent));
			assert.equal(await readFile(destination, "utf8"), expected[agent]);
		}

		const selectedHome = join(sandbox, "selected-context-home");
		assert.equal(await run(["install", "--agent", "pi,codex", "--home", selectedHome], repoRoot), 0);
		for (const agent of ["pi", "codex"] as const) {
			assert.equal(lstatSync(join(selectedHome, contextDestinations[agent])).isSymbolicLink(), true);
		}
		for (const agent of ["prime", "claude"] as const) {
			assert.equal(existsSync(join(selectedHome, contextDestinations[agent])), false);
		}
	});

	test("updates rendered context only on sync and is idempotent", async () => {
		const source = await addContextSource("first\n");
		assert.equal(await run(["sync", "--agent", "codex", "--home", home], repoRoot), 0);
		const destination = join(home, contextDestinations.codex);
		await writeFile(source, "second\n");
		assert.equal(await readFile(destination, "utf8"), "first\n");

		const status = await capture(() => run(["status", "--agent", "codex", "--home", home], repoRoot));
		assertIncludes(status.stdout, `  context: outdated (${destination})\n`);
		const preview = await capture(() => run(["sync", "--agent", "codex", "--dry-run", "--home", home], repoRoot));
		assertIncludes(preview.stdout, "Dry run: 1 change(s) would be made.");
		assert.equal(await readFile(destination, "utf8"), "first\n");

		assert.equal(await run(["sync", "--agent", "codex", "--home", home], repoRoot), 0);
		assert.equal(await readFile(destination, "utf8"), "second\n");
		const again = await capture(() => run(["sync", "--agent", "codex", "--dry-run", "--home", home], repoRoot));
		assertExcludes(again.stdout, "Dry run:");
	});

	test("sync repoints pre-template context links; install only reports them", async () => {
		await addContextSource();
		const legacy = join(repoRoot, "context/working-style.md");
		const destination = join(home, contextDestinations.claude);
		await mkdir(dirname(destination), { recursive: true });
		await symlink(relative(dirname(destination), legacy), destination);

		const status = await capture(() => run(["status", "--agent", "claude", "--home", home], repoRoot));
		assert.equal(status.code, 0);
		assertIncludes(status.stdout, `  context: outdated (${destination})\n`);
		const install = await capture(() => run(["install", "--agent", "claude", "--home", home], repoRoot));
		assert.equal(install.code, 0);
		assertIncludes(install.stdout, "outdated context link");
		assert.equal(resolve(dirname(destination), readlinkSync(destination)), legacy);

		const preview = await capture(() => run(["sync", "--agent", "claude", "--dry-run", "--home", home], repoRoot));
		assertIncludes(preview.stdout, `  relink context: ${destination}\n`);
		assert.equal(resolve(dirname(destination), readlinkSync(destination)), legacy);
		assert.equal(await run(["sync", "--agent", "claude", "--home", home], repoRoot), 0);
		assert.equal(resolve(dirname(destination), readlinkSync(destination)), distPath("claude"));
	});

	test("accepts an absent context source without creating context roots", async () => {
		const result = await capture(() => run(["install", "--home", home], repoRoot));
		assert.equal(result.code, 0);
		for (const relativeDestination of Object.values(contextDestinations)) {
			assert.equal(existsSync(dirname(join(home, relativeDestination))), false);
		}
		assert.equal(existsSync(join(repoRoot, "context/dist")), false);
	});

	test("status reports linked, missing, and conflicting context separately", async () => {
		await addContextSource();
		assert.equal(await run(["install", "--agent", "pi", "--home", home], repoRoot), 0);
		const piDestination = join(home, contextDestinations.pi);
		const conflictDestination = join(home, contextDestinations.codex);
		await mkdir(dirname(conflictDestination), { recursive: true });
		await writeFile(conflictDestination, "keep");

		const result = await capture(() =>
			run(["status", "--agent", "pi,prime,codex", "--home", home], repoRoot),
		);
		assert.equal(result.code, 1);
		assertIncludes(result.stdout, `  context: linked (${piDestination})\n`);
		assertIncludes(result.stdout, `  context: missing (${join(home, contextDestinations.prime)})\n`);
		assertIncludes(result.stdout, `  context: conflict (${conflictDestination})\n`);
		assert.equal(await readFile(conflictDestination, "utf8"), "keep");
	});

	test("preserves every context destination not owned by the current checkout", async () => {
		await addContextSource();
		const destinations = {
			pi: join(home, contextDestinations.pi),
			prime: join(home, contextDestinations.prime),
			codex: join(home, contextDestinations.codex),
			claude: join(home, contextDestinations.claude),
		};
		await mkdir(dirname(destinations.pi), { recursive: true });
		await writeFile(destinations.pi, "keep file");
		await mkdir(destinations.prime, { recursive: true });
		const external = join(sandbox, "external-context.md");
		await writeFile(external, "external");
		await mkdir(dirname(destinations.codex), { recursive: true });
		await symlink(external, destinations.codex);
		const moved = join(sandbox, "moved-checkout/context/dist/claude.md");
		await mkdir(dirname(moved), { recursive: true });
		await writeFile(moved, "moved");
		await mkdir(dirname(destinations.claude), { recursive: true });
		await symlink(moved, destinations.claude);

		for (const command of ["install", "sync"] as const) {
			assert.equal((await capture(() => run([command, "--home", home], repoRoot))).code, 1);
		}
		assert.equal(await run(["uninstall", "--home", home], repoRoot), 0);
		assert.equal(await readFile(destinations.pi, "utf8"), "keep file");
		assert.equal(lstatSync(destinations.prime).isDirectory(), true);
		assert.equal(readlinkSync(destinations.codex), external);
		assert.equal(readlinkSync(destinations.claude), moved);
	});

	test("does not own links to the template source itself", async () => {
		const source = await addContextSource();
		const destination = join(home, contextDestinations.pi);
		await mkdir(dirname(destination), { recursive: true });
		await symlink(source, destination);
		assert.equal((await capture(() => run(["sync", "--agent", "pi", "--home", home], repoRoot))).code, 1);
		assert.equal(await run(["uninstall", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.equal(readlinkSync(destination), source);
	});

	test("recognizes relative owned context links and removes them after source deletion", async () => {
		const contextSource = await addContextSource();
		const targets = { pi: distPath("pi"), prime: join(repoRoot, "context/working-style.md") };
		for (const agent of ["pi", "prime"] as const) {
			const destination = join(home, contextDestinations[agent]);
			await mkdir(dirname(destination), { recursive: true });
			await symlink(relative(dirname(destination), targets[agent]), destination);
		}
		await rm(contextSource);

		const syncPreview = await capture(() =>
			run(["sync", "--agent", "pi", "--dry-run", "--home", home], repoRoot),
		);
		assertIncludes(syncPreview.stdout, "Dry run: 1 change(s) would be made.");
		assert.equal(lstatSync(join(home, contextDestinations.pi)).isSymbolicLink(), true);
		assert.equal(await run(["sync", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.throws(() => lstatSync(join(home, contextDestinations.pi)));

		const uninstallPreview = await capture(() =>
			run(["uninstall", "--agent", "prime", "--dry-run", "--home", home], repoRoot),
		);
		assertIncludes(uninstallPreview.stdout, "Dry run: 1 change(s) would be made.");
		assert.equal(lstatSync(join(home, contextDestinations.prime)).isSymbolicLink(), true);
		assert.equal(await run(["uninstall", "--agent", "prime", "--home", home], repoRoot), 0);
		assert.throws(() => lstatSync(join(home, contextDestinations.prime)));
	});

	test("context dry-run counts render and link without writing anything", async () => {
		await addContextSource();
		const destination = join(home, contextDestinations.claude);
		const result = await capture(() =>
			run(["sync", "--agent", "claude", "--dry-run", "--home", home], repoRoot),
		);
		assertIncludes(result.stdout, "Dry run: 2 change(s) would be made.");
		assert.equal(existsSync(dirname(destination)), false);
		assert.equal(existsSync(join(repoRoot, "context/dist")), false);
	});

	test("a context-free checkout preserves links owned by another checkout", async () => {
		const personalSource = join(sandbox, "personal/context/dist/pi.md");
		const destination = join(home, contextDestinations.pi);
		await mkdir(dirname(personalSource), { recursive: true });
		await writeFile(personalSource, "personal");
		await mkdir(dirname(destination), { recursive: true });
		await symlink(personalSource, destination);

		assert.equal(await run(["sync", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.equal(await run(["uninstall", "--agent", "pi", "--home", home], repoRoot), 0);
		assert.equal(readlinkSync(destination), personalSource);
	});

	test("rejects invalid context sources before any mutation", async () => {
		await addSkill("valid");
		const contextSource = join(repoRoot, "context/working-style.md.j2");
		const invalidTargets = ["directory", "socket", "symlink", "broken-symlink"] as const;
		for (const invalid of invalidTargets) {
			await rm(join(repoRoot, "context"), { recursive: true, force: true });
			await mkdir(dirname(contextSource), { recursive: true });
			const server = invalid === "socket" ? createServer() : undefined;
			if (invalid === "directory") {
				await mkdir(contextSource);
			} else if (server !== undefined) {
				await new Promise<void>((resolveListen) => server.listen(contextSource, resolveListen));
			} else {
				const target = join(sandbox, invalid === "symlink" ? "external.md" : "missing.md");
				if (invalid === "symlink") await writeFile(target, "external");
				await symlink(target, contextSource);
			}
			const result = await capture(() => run(["install", "--agent", "pi", "--home", home], repoRoot));
			assert.equal(result.code, 1);
			assertIncludes(result.stderr, "context/working-style.md.j2: must be a regular file");
			assert.equal(existsSync(join(home, roots.pi)), false);
			assert.equal(existsSync(join(home, contextDestinations.pi)), false);
			if (server !== undefined) {
				await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			}
		}
	});

	test("rejects template syntax outside the Jinja agent-conditional subset before mutation", async () => {
		await addSkill("valid");
		const invalidTemplates = [
			["{{ agent }}\n", "line 1: only {% if agent ... %} blocks are supported"],
			["a\n{# note #}\n", "line 2: only {% if agent ... %} blocks are supported"],
			['{% if agent == "pi" %}\nx\n{% else %}\ny\n{% endif %}\n', "line 3: unsupported tag {% else %}"],
			["{% if agent == 'pi' %}\nx\n{% endif %}\n", "line 1: unsupported tag"],
			['{% if agent == "cursor" %}\nx\n{% endif %}\n', 'line 1: unknown agent "cursor"'],
			['{% if agent == "pi" %}\nx\n', "{% if %} without {% endif %}"],
			["x\n{% endif %}\n", "line 2: {% endif %} without {% if %}"],
		] as const;
		for (const [template, message] of invalidTemplates) {
			await addContextSource(template);
			const result = await capture(() => run(["sync", "--home", home], repoRoot));
			assert.equal(result.code, 1, template);
			assertIncludes(result.stderr, `context/working-style.md.j2: ${message}`);
			assert.equal(existsSync(join(home, roots.pi)), false);
			assert.equal(existsSync(join(repoRoot, "context/dist")), false);
		}
	});

	test("rejects invalid frontmatter and malformed config before mutation", async () => {
		await addSkill("valid");
		await writeFile(join(repoRoot, "skills/valid/SKILL.md"), "---\nname: wrong\ndescription: mismatch\n---\n");
		const frontmatter = await capture(() => run(["install", "--home", home], repoRoot));
		assertIncludes(frontmatter.stderr, "frontmatter name must match");
		assert.equal(existsSync(join(home, roots.pi)), false);

		await writeFile(join(repoRoot, "skills/valid/SKILL.md"), "---\nname: valid\ndescription: valid skill metadata\n---\n");
		await writeFile(join(repoRoot, "agent-toolkit.json"), "{broken");
		const malformed = await capture(() => run(["install", "--home", home], repoRoot));
		assertIncludes(malformed.stderr, "invalid JSON");
		assert.equal(existsSync(join(home, roots.pi)), false);
	});

	test("requires exactly the skills top-level config key but accepts partial inventories", async () => {
		await addSkill("valid");
		await writeConfig({ skills: {}, extra: true });
		const extra = await capture(() => run(["validate"], repoRoot));
		assertIncludes(extra.stderr, 'unknown top-level key "extra"');
		assertExcludes(extra.stderr, "is not configured");
		await writeConfig({});
		assertIncludes((await capture(() => run(["validate"], repoRoot))).stderr, "skills must be an object");
	});

	test("rejects whitespace descriptions and duplicate YAML frontmatter keys", async () => {
		await addSkill("valid");
		await writeFile(join(repoRoot, "skills/valid/SKILL.md"), "---\nname: valid\ndescription: '   '\n---\n");
		assertIncludes((await capture(() => run(["validate"], repoRoot))).stderr, "description is required");

		for (const duplicate of ["name: other", "description: second"]) {
			await writeFile(
				join(repoRoot, "skills/valid/SKILL.md"),
				`---\nname: valid\ndescription: first\n${duplicate}\n---\n`,
			);
			const result = await capture(() => run(["validate"], repoRoot));
			assert.equal(result.code, 1);
			assertIncludes(result.stderr, "duplicate top-level key");
		}
	});

	test("accepts only flat frontmatter with plain unindented keys and scalar values", async () => {
		await addSkill("valid");
		const invalidDocuments = [
			`---
name: valid
description: first
"descr\\x69ption": second
---
`,
			`---
{name: valid, name: valid, description: first}
---
`,
			`---
 name: valid
 description: first
 name: valid
---
`,
			`---
name: valid
description: first
"name": valid
---
`,
			`---
name: valid
description: first
metadata:
  nested: value
---
`,
			`---
name: valid
description: first
metadata: { nested: value }
---
`,
			`---
name: valid
description: first
true: one
True: two
---
`,
			`---
name: valid
description: first
null: one
Null: two
---
`,
			`---
name: valid
description: first
1: one
01: two
---
`,
		];
		for (const document of invalidDocuments) {
			await writeFile(join(repoRoot, "skills/valid/SKILL.md"), document);
			const result = await capture(() => run(["validate"], repoRoot));
			assert.equal(result.code, 1);
			assertIncludes(result.stderr, "invalid YAML frontmatter");
		}

		await writeFile(
			join(repoRoot, "skills/valid/SKILL.md"),
			`---
name: valid
description: "Use this: safely."
---
`,
		);
		assert.equal(await run(["validate"], repoRoot), 0);
	});

	test("rejects duplicate JSON object keys at every nesting level", async () => {
		await addSkill("valid");
		const documents = [
			'{"skills":{},"skills":{"valid":["pi"]}}',
			'{"skills":{"valid":["pi"],"valid":["prime"]}}',
			'{"skills":{"valid":["pi"]},"metadata":{"nested":{"x":1,"x":2}}}',
		];
		for (const document of documents) {
			await writeFile(join(repoRoot, "agent-toolkit.json"), document);
			const result = await capture(() => run(["validate"], repoRoot));
			assert.equal(result.code, 1);
			assertIncludes(result.stderr, "duplicate object key");
		}
	});

	test("rejects missing skills and malformed scope values before mutation", async () => {
		await addSkill("valid");
		await addSkill("scalar");
		await writeConfig({ skills: { valid: ["pi", "pi", "unknown"], scalar: "pi", empty: [], missing: ["pi"] } });
		const result = await capture(() => run(["install", "--home", home], repoRoot));
		assert.equal(result.code, 1);
		assertIncludes(result.stderr, 'lists agent "pi" more than once');
		assertIncludes(result.stderr, "has unknown agent");
		assertIncludes(result.stderr, "must have an agent array");
		assertIncludes(result.stderr, "must have at least one agent");
		assertIncludes(result.stderr, 'configured skill "missing" is missing');
		for (const relativeRoot of Object.values(roots)) {
			assert.equal(existsSync(join(home, relativeRoot)), false);
		}
	});
});

describe("package ownership", () => {
	test("all checked-in skill metadata satisfies the flat frontmatter contract", async () => {
		const actualRepo = resolve(import.meta.dirname, "..");
		const result = await capture(() => run(["validate"], actualRepo));
		assert.equal(result.code, 0);
		assert.equal(result.stderr, "");
	});

	test("the repository package exposes the installer and does not also deliver Pi skills", async () => {
		const manifest = JSON.parse(await readFile(join(import.meta.dirname, "../package.json"), "utf8"));
		assert.deepEqual(manifest.bin, { "agent-toolkit": "./scripts/agent-toolkit.mjs" });
		assert.deepEqual(manifest.engines, { node: ">=24.14.1" });
		assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
		assert.equal(manifest.pi.skills, undefined);
	});
});
