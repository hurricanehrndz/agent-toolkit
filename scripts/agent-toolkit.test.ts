import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";

import { run } from "./agent-toolkit.mjs";

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
	const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	try {
		return { code: await callback(), stdout, stderr };
	} finally {
		out.mockRestore();
		err.mockRestore();
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

		expect(await run(["install", "--home", home], repoRoot)).toBe(0);
		for (const [agent, relativeRoot] of Object.entries(roots)) {
			const portableLink = join(home, relativeRoot, "portable");
			expect(resolve(join(portableLink, ".."), readlinkSync(portableLink))).toBe(portable);
			const piLink = join(home, relativeRoot, "pi-only");
			if (agent === "pi") {
				expect(resolve(join(piLink, ".."), readlinkSync(piLink))).toBe(piOnly);
			} else {
				expect(existsSync(piLink)).toBeFalse();
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
			expect(await run(["install", ...args, "--home", installationHome], repoRoot)).toBe(0);
			for (const relativeRoot of Object.values(roots)) {
				expect(lstatSync(join(installationHome, relativeRoot, "example")).isSymbolicLink()).toBeTrue();
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
			expect(result.code).toBe(2);
			expect(result.stderr).toContain('"all" cannot be combined with named agents.');
		}
	});

	test("dry-run reports scoped changes without creating roots", async () => {
		await addSkill("pi-only", ["pi"]);
		const result = await capture(() => run(["sync", "--dry-run", "--home", home], repoRoot));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Dry run: 1 change(s) would be made.");
		for (const relativeRoot of Object.values(roots)) {
			expect(existsSync(join(home, relativeRoot))).toBeFalse();
		}
	});

	test("sync removes a checkout-owned link after its agent scope changes", async () => {
		const skill = await addSkill("scoped", ["pi", "prime"]);
		expect(await run(["install", "--home", home], repoRoot)).toBe(0);
		overrides.scoped = ["pi"];
		await writeConfig();
		expect(await run(["sync", "--agent", "prime", "--home", home], repoRoot)).toBe(0);
		expect(existsSync(join(home, roots.prime, "scoped"))).toBeFalse();
		expect(resolve(join(home, roots.pi, "scoped/.."), readlinkSync(join(home, roots.pi, "scoped")))).toBe(skill);
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
		expect(await run(["sync", "--agent", "pi,prime,codex", "--home", home], repoRoot)).toBe(1);
		expect(await Bun.file(destinations[0]!).text()).toBe("keep");
		expect(lstatSync(destinations[1]!).isDirectory()).toBeTrue();
		expect(readlinkSync(destinations[2]!)).toBe(external);
	});

	test("links from a moved checkout conflict and survive sync and uninstall", async () => {
		await addSkill("example");
		const oldSkill = join(sandbox, "old-checkout/skills/example");
		const destination = join(home, roots.claude, "example");
		await mkdir(oldSkill, { recursive: true });
		await mkdir(join(home, roots.claude), { recursive: true });
		await symlink(oldSkill, destination);
		expect(await run(["sync", "--agent", "claude", "--home", home], repoRoot)).toBe(1);
		expect(await run(["uninstall", "--agent", "claude", "--home", home], repoRoot)).toBe(0);
		expect(resolve(join(destination, ".."), readlinkSync(destination))).toBe(oldSkill);
	});

	test("sync and uninstall preserve unmanaged and separately managed resources", async () => {
		await addSkill("managed");
		const root = join(home, roots.codex);
		await mkdir(join(root, "respec"), { recursive: true });
		await writeFile(join(root, "file"), "keep");
		await writeFile(join(root, "respec/SKILL.md"), "separate owner");
		const brokenExternal = join(sandbox, "missing-external");
		await symlink(brokenExternal, join(root, "external"));
		expect(await run(["sync", "--agent", "codex", "--home", home], repoRoot)).toBe(0);
		expect(await run(["uninstall", "--agent", "codex", "--home", home], repoRoot)).toBe(0);
		expect(await Bun.file(join(root, "file")).text()).toBe("keep");
		expect(await Bun.file(join(root, "respec/SKILL.md")).text()).toBe("separate owner");
		expect(readlinkSync(join(root, "external"))).toBe(brokenExternal);
		expect(existsSync(join(root, "managed"))).toBeFalse();
	});

	test("uninstall removes even deleted-skill links owned by this checkout", async () => {
		await addSkill("current");
		const root = join(home, roots.pi);
		await mkdir(root, { recursive: true });
		await symlink(join(repoRoot, "skills/removed"), join(root, "removed"));
		expect(await run(["install", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(await run(["uninstall", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(existsSync(join(root, "current"))).toBeFalse();
		expect(existsSync(join(root, "removed"))).toBeFalse();
	});

	test("recognizes current and broken stale relative links owned by the checkout", async () => {
		const skill = await addSkill("relative");
		const destination = join(home, roots.pi, "relative");
		const stale = join(home, roots.pi, "removed");
		await mkdir(dirname(destination), { recursive: true });
		await symlink(relative(dirname(destination), skill), destination);
		await symlink(relative(dirname(stale), join(repoRoot, "skills/removed")), stale);
		expect(await run(["sync", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(readlinkSync(destination)).toBe(relative(dirname(destination), skill));
		expect(() => lstatSync(stale)).toThrow();
	});

	test("dry-run sync and uninstall report removals without removing links", async () => {
		await addSkill("scoped", ["prime"]);
		expect(await run(["install", "--agent", "prime", "--home", home], repoRoot)).toBe(0);
		const destination = join(home, roots.prime, "scoped");
		overrides.scoped = ["pi"];
		await writeConfig();
		const sync = await capture(() => run(["sync", "--agent", "prime", "--dry-run", "--home", home], repoRoot));
		expect(sync.stdout).toContain("Dry run: 1 change(s) would be made.");
		expect(lstatSync(destination).isSymbolicLink()).toBeTrue();
		const uninstall = await capture(() => run(["uninstall", "--agent", "prime", "--dry-run", "--home", home], repoRoot));
		expect(uninstall.stdout).toContain("Dry run: 1 change(s) would be made.");
		expect(lstatSync(destination).isSymbolicLink()).toBeTrue();
	});

	test("status returns a conflict exit code without changing the destination", async () => {
		await addSkill("example", ["pi"]);
		const destination = join(home, roots.pi, "example");
		await mkdir(dirname(destination), { recursive: true });
		await writeFile(destination, "keep");
		const result = await capture(() => run(["status", "--agent", "pi", "--home", home], repoRoot));
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("1 conflicts");
		expect(await Bun.file(destination).text()).toBe("keep");
	});

	test("status considers only skills scoped to the selected agent", async () => {
		await addSkill("pi-only", ["pi"]);
		await addSkill("portable");
		const result = await capture(() => run(["status", "--agent", "prime", "--home", home], repoRoot));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("prime: 0 linked, 1 missing, 0 conflicts");
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
		expect(await run(["install", "--home", allHome], repoRoot)).toBe(0);
		for (const agent of Object.keys(contextDestinations) as Array<keyof typeof contextDestinations>) {
			const destination = join(allHome, contextDestinations[agent]);
			expect(lstatSync(destination).isSymbolicLink()).toBeTrue();
			expect(resolve(dirname(destination), readlinkSync(destination))).toBe(distPath(agent));
			expect(await Bun.file(destination).text()).toBe(expected[agent]);
		}

		const selectedHome = join(sandbox, "selected-context-home");
		expect(await run(["install", "--agent", "pi,codex", "--home", selectedHome], repoRoot)).toBe(0);
		for (const agent of ["pi", "codex"] as const) {
			expect(lstatSync(join(selectedHome, contextDestinations[agent])).isSymbolicLink()).toBeTrue();
		}
		for (const agent of ["prime", "claude"] as const) {
			expect(existsSync(join(selectedHome, contextDestinations[agent]))).toBeFalse();
		}
	});

	test("updates rendered context only on sync and is idempotent", async () => {
		const source = await addContextSource("first\n");
		expect(await run(["sync", "--agent", "codex", "--home", home], repoRoot)).toBe(0);
		const destination = join(home, contextDestinations.codex);
		await writeFile(source, "second\n");
		expect(await Bun.file(destination).text()).toBe("first\n");

		const status = await capture(() => run(["status", "--agent", "codex", "--home", home], repoRoot));
		expect(status.stdout).toContain(`  context: outdated (${destination})\n`);
		const preview = await capture(() => run(["sync", "--agent", "codex", "--dry-run", "--home", home], repoRoot));
		expect(preview.stdout).toContain("Dry run: 1 change(s) would be made.");
		expect(await Bun.file(destination).text()).toBe("first\n");

		expect(await run(["sync", "--agent", "codex", "--home", home], repoRoot)).toBe(0);
		expect(await Bun.file(destination).text()).toBe("second\n");
		const again = await capture(() => run(["sync", "--agent", "codex", "--dry-run", "--home", home], repoRoot));
		expect(again.stdout).not.toContain("Dry run:");
	});

	test("sync repoints pre-template context links; install only reports them", async () => {
		await addContextSource();
		const legacy = join(repoRoot, "context/working-style.md");
		const destination = join(home, contextDestinations.claude);
		await mkdir(dirname(destination), { recursive: true });
		await symlink(relative(dirname(destination), legacy), destination);

		const status = await capture(() => run(["status", "--agent", "claude", "--home", home], repoRoot));
		expect(status.code).toBe(0);
		expect(status.stdout).toContain(`  context: outdated (${destination})\n`);
		const install = await capture(() => run(["install", "--agent", "claude", "--home", home], repoRoot));
		expect(install.code).toBe(0);
		expect(install.stdout).toContain("outdated context link");
		expect(resolve(dirname(destination), readlinkSync(destination))).toBe(legacy);

		const preview = await capture(() => run(["sync", "--agent", "claude", "--dry-run", "--home", home], repoRoot));
		expect(preview.stdout).toContain(`  relink context: ${destination}\n`);
		expect(resolve(dirname(destination), readlinkSync(destination))).toBe(legacy);
		expect(await run(["sync", "--agent", "claude", "--home", home], repoRoot)).toBe(0);
		expect(resolve(dirname(destination), readlinkSync(destination))).toBe(distPath("claude"));
	});

	test("accepts an absent context source without creating context roots", async () => {
		const result = await capture(() => run(["install", "--home", home], repoRoot));
		expect(result.code).toBe(0);
		for (const relativeDestination of Object.values(contextDestinations)) {
			expect(existsSync(dirname(join(home, relativeDestination)))).toBeFalse();
		}
		expect(existsSync(join(repoRoot, "context/dist"))).toBeFalse();
	});

	test("status reports linked, missing, and conflicting context separately", async () => {
		await addContextSource();
		expect(await run(["install", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		const piDestination = join(home, contextDestinations.pi);
		const conflictDestination = join(home, contextDestinations.codex);
		await mkdir(dirname(conflictDestination), { recursive: true });
		await writeFile(conflictDestination, "keep");

		const result = await capture(() =>
			run(["status", "--agent", "pi,prime,codex", "--home", home], repoRoot),
		);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain(`  context: linked (${piDestination})\n`);
		expect(result.stdout).toContain(`  context: missing (${join(home, contextDestinations.prime)})\n`);
		expect(result.stdout).toContain(`  context: conflict (${conflictDestination})\n`);
		expect(await Bun.file(conflictDestination).text()).toBe("keep");
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
			expect((await capture(() => run([command, "--home", home], repoRoot))).code).toBe(1);
		}
		expect(await run(["uninstall", "--home", home], repoRoot)).toBe(0);
		expect(await Bun.file(destinations.pi).text()).toBe("keep file");
		expect(lstatSync(destinations.prime).isDirectory()).toBeTrue();
		expect(readlinkSync(destinations.codex)).toBe(external);
		expect(readlinkSync(destinations.claude)).toBe(moved);
	});

	test("does not own links to the template source itself", async () => {
		const source = await addContextSource();
		const destination = join(home, contextDestinations.pi);
		await mkdir(dirname(destination), { recursive: true });
		await symlink(source, destination);
		expect((await capture(() => run(["sync", "--agent", "pi", "--home", home], repoRoot))).code).toBe(1);
		expect(await run(["uninstall", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(readlinkSync(destination)).toBe(source);
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
		expect(syncPreview.stdout).toContain("Dry run: 1 change(s) would be made.");
		expect(lstatSync(join(home, contextDestinations.pi)).isSymbolicLink()).toBeTrue();
		expect(await run(["sync", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(() => lstatSync(join(home, contextDestinations.pi))).toThrow();

		const uninstallPreview = await capture(() =>
			run(["uninstall", "--agent", "prime", "--dry-run", "--home", home], repoRoot),
		);
		expect(uninstallPreview.stdout).toContain("Dry run: 1 change(s) would be made.");
		expect(lstatSync(join(home, contextDestinations.prime)).isSymbolicLink()).toBeTrue();
		expect(await run(["uninstall", "--agent", "prime", "--home", home], repoRoot)).toBe(0);
		expect(() => lstatSync(join(home, contextDestinations.prime))).toThrow();
	});

	test("context dry-run counts render and link without writing anything", async () => {
		await addContextSource();
		const destination = join(home, contextDestinations.claude);
		const result = await capture(() =>
			run(["sync", "--agent", "claude", "--dry-run", "--home", home], repoRoot),
		);
		expect(result.stdout).toContain("Dry run: 2 change(s) would be made.");
		expect(existsSync(dirname(destination))).toBeFalse();
		expect(existsSync(join(repoRoot, "context/dist"))).toBeFalse();
	});

	test("a context-free checkout preserves links owned by another checkout", async () => {
		const personalSource = join(sandbox, "personal/context/dist/pi.md");
		const destination = join(home, contextDestinations.pi);
		await mkdir(dirname(personalSource), { recursive: true });
		await writeFile(personalSource, "personal");
		await mkdir(dirname(destination), { recursive: true });
		await symlink(personalSource, destination);

		expect(await run(["sync", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(await run(["uninstall", "--agent", "pi", "--home", home], repoRoot)).toBe(0);
		expect(readlinkSync(destination)).toBe(personalSource);
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
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("context/working-style.md.j2: must be a regular file");
			expect(existsSync(join(home, roots.pi))).toBeFalse();
			expect(existsSync(join(home, contextDestinations.pi))).toBeFalse();
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
			expect(result.code, template).toBe(1);
			expect(result.stderr).toContain(`context/working-style.md.j2: ${message}`);
			expect(existsSync(join(home, roots.pi))).toBeFalse();
			expect(existsSync(join(repoRoot, "context/dist"))).toBeFalse();
		}
	});

	test("rejects invalid frontmatter and malformed config before mutation", async () => {
		await addSkill("valid");
		await writeFile(join(repoRoot, "skills/valid/SKILL.md"), "---\nname: wrong\ndescription: mismatch\n---\n");
		const frontmatter = await capture(() => run(["install", "--home", home], repoRoot));
		expect(frontmatter.stderr).toContain("frontmatter name must match");
		expect(existsSync(join(home, roots.pi))).toBeFalse();

		await writeFile(join(repoRoot, "skills/valid/SKILL.md"), "---\nname: valid\ndescription: valid skill metadata\n---\n");
		await writeFile(join(repoRoot, "agent-toolkit.json"), "{broken");
		const malformed = await capture(() => run(["install", "--home", home], repoRoot));
		expect(malformed.stderr).toContain("invalid JSON");
		expect(existsSync(join(home, roots.pi))).toBeFalse();
	});

	test("requires exactly the skills top-level config key but accepts partial inventories", async () => {
		await addSkill("valid");
		await writeConfig({ skills: {}, extra: true });
		const extra = await capture(() => run(["validate"], repoRoot));
		expect(extra.stderr).toContain('unknown top-level key "extra"');
		expect(extra.stderr).not.toContain("is not configured");
		await writeConfig({});
		expect((await capture(() => run(["validate"], repoRoot))).stderr).toContain("skills must be an object");
	});

	test("rejects whitespace descriptions and duplicate YAML frontmatter keys", async () => {
		await addSkill("valid");
		await writeFile(join(repoRoot, "skills/valid/SKILL.md"), "---\nname: valid\ndescription: '   '\n---\n");
		expect((await capture(() => run(["validate"], repoRoot))).stderr).toContain("description is required");

		for (const duplicate of ["name: other", "description: second"]) {
			await writeFile(
				join(repoRoot, "skills/valid/SKILL.md"),
				`---\nname: valid\ndescription: first\n${duplicate}\n---\n`,
			);
			const result = await capture(() => run(["validate"], repoRoot));
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("duplicate top-level key");
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
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("invalid YAML frontmatter");
		}

		await writeFile(
			join(repoRoot, "skills/valid/SKILL.md"),
			`---
name: valid
description: "Use this: safely."
---
`,
		);
		expect(await run(["validate"], repoRoot)).toBe(0);
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
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("duplicate object key");
		}
	});

	test("rejects missing skills and malformed scope values before mutation", async () => {
		await addSkill("valid");
		await addSkill("scalar");
		await writeConfig({ skills: { valid: ["pi", "pi", "unknown"], scalar: "pi", empty: [], missing: ["pi"] } });
		const result = await capture(() => run(["install", "--home", home], repoRoot));
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('lists agent "pi" more than once');
		expect(result.stderr).toContain("has unknown agent");
		expect(result.stderr).toContain("must have an agent array");
		expect(result.stderr).toContain("must have at least one agent");
		expect(result.stderr).toContain('configured skill "missing" is missing');
		for (const relativeRoot of Object.values(roots)) {
			expect(existsSync(join(home, relativeRoot))).toBeFalse();
		}
	});
});

describe("package ownership", () => {
	test("all checked-in skill metadata satisfies the flat frontmatter contract", async () => {
		const actualRepo = resolve(import.meta.dir, "..");
		const result = await capture(() => run(["validate"], actualRepo));
		expect(result.code).toBe(0);
		expect(result.stderr).toBe("");
	});

	test("the repository package exposes the installer and does not also deliver Pi skills", async () => {
		const manifest = await Bun.file(join(import.meta.dir, "../package.json")).json();
		expect(manifest.bin).toEqual({ "agent-toolkit": "./scripts/agent-toolkit.mjs" });
		expect(manifest.engines).toEqual({ node: ">=24.14.1" });
		expect(manifest.pi.extensions).toEqual(["./extensions"]);
		expect(manifest.pi.skills).toBeUndefined();
	});
});
