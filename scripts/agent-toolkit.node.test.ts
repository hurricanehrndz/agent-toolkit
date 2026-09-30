import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

let sandbox: string;
const repoRoot = resolve(import.meta.dir, "..");
const installer = join(repoRoot, "scripts/agent-toolkit.mjs");

function command(command: string, args: string[], cwd = repoRoot, env = process.env) {
	return spawnSync(command, args, { cwd, encoding: "utf8", env });
}

function npmEnvironment() {
	return {
		...process.env,
		HOME: join(sandbox, "npm-home"),
		npm_config_cache: join(sandbox, "npm-cache"),
		npm_config_userconfig: join(sandbox, "npmrc"),
	};
}

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "agent-toolkit-node-smoke-"));
});

afterEach(async () => {
	await rm(sandbox, { recursive: true, force: true });
});

describe("Node production command path", () => {
	test("uses the pinned Node 24 runtime for a temporary-home reconciliation", () => {
		expect(command("node", ["--version"]).stdout.trim()).toBe("v24.14.1");

		const home = join(sandbox, "home");
		const dryRun = command("node", [installer, "sync", "--dry-run", "--home", home]);
		expect(dryRun.status).toBe(0);
		expect(existsSync(home)).toBeFalse();

		const sync = command(installer, ["sync", "--agent", "prime", "--home", home]);
		expect(sync.status).toBe(0);
		const firstSkill = readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()[0]!;
		const destination = join(home, ".prime/agent/skills", firstSkill);
		expect(lstatSync(destination).isSymbolicLink()).toBeTrue();
		expect(resolve(dirname(destination), readlinkSync(destination))).toBe(join(repoRoot, "skills", firstSkill));
	});

	test("matches pinned Bun YAML numeric typing under Node", async () => {
		const cases: Array<[string, boolean]> = [
			[".nan", false],
			[".NaN", false],
			[".NAN", false],
			[".inf", false],
			["+.INF", false],
			["-.Inf", false],
			["0x10", false],
			["+0x10", false],
			["-0x10", false],
			["0o7", false],
			["+0o7", false],
			["-0o7", false],
			[".5", false],
			["+.5", true],
			["-.5", true],
			["+.nan", true],
			["-.nan", true],
			["0X10", true],
			["0b10", true],
		];
		const probe = command("node", [
			"--input-type=module",
			"--eval",
			`import { parseFlatYamlFrontmatter } from ${JSON.stringify(pathToFileURL(installer).href)};
const scalars = ${JSON.stringify(cases.map(([scalar]) => scalar))};
const normalized = scalars.map((scalar) => {
  const value = parseFlatYamlFrontmatter(\`value: \${scalar}\n\`).value;
  if (typeof value !== "number") return [scalar, "string", value];
  if (Number.isNaN(value)) return [scalar, "number", "NaN"];
  if (!Number.isFinite(value)) return [scalar, "number", value < 0 ? "-Infinity" : "Infinity"];
  return [scalar, "number", value];
});
console.log(JSON.stringify(normalized));`,
		]);
		expect(probe.status, probe.stderr).toBe(0);
		expect(JSON.parse(probe.stdout)).toEqual([
			[".nan", "number", "NaN"],
			[".NaN", "number", "NaN"],
			[".NAN", "number", "NaN"],
			[".inf", "number", "Infinity"],
			["+.INF", "number", "Infinity"],
			["-.Inf", "number", "-Infinity"],
			["0x10", "number", 16],
			["+0x10", "number", 16],
			["-0x10", "number", -16],
			["0o7", "number", 7],
			["+0o7", "number", 7],
			["-0o7", "number", -7],
			[".5", "number", 0.5],
			["+.5", "string", "+.5"],
			["-.5", "string", "-.5"],
			["+.nan", "string", "+.nan"],
			["-.nan", "string", "-.nan"],
			["0X10", "string", "0X10"],
			["0b10", "string", "0b10"],
		]);

		const fixture = join(sandbox, "numeric-frontmatter");
		await mkdir(join(fixture, "skills/valid"), { recursive: true });
		await mkdir(join(fixture, "scripts"));
		const fixtureInstaller = join(fixture, "scripts/agent-toolkit.mjs");
		await cp(installer, fixtureInstaller);
		for (const [scalar, accepted] of cases) {
			await writeFile(join(fixture, "skills/valid/SKILL.md"), `---\nname: valid\ndescription: ${scalar}\n---\n`);
			const result = command("node", [fixtureInstaller, "validate"], fixture);
			expect(result.status, `${scalar}: ${result.stderr}`).toBe(accepted ? 0 : 1);
		}
	});

	test("packs only runtime resources", () => {
		const packed = command("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], repoRoot, npmEnvironment());
		expect(packed.status, packed.stderr).toBe(0);
		const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
		const paths = report[0]!.files.map((file) => file.path).sort();
		const allowedExact = new Set(["LICENSE", "README.md", "agent-toolkit.json", "package.json", "scripts/agent-toolkit.mjs"]);
		const allowedPrefixes = ["context/", "extensions/", "skills/"];
		for (const path of paths) {
			expect(allowedExact.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix)), path).toBeTrue();
			expect(path).not.toMatch(/(?:^|\/)\.tmp(?:\/|$)|(?:^|\/)node_modules(?:\/|$)|__pycache__|\.pyc$|(?:^|\/)(?:tests?|[^/]*[._-]test)(?:[._/-]|$)/);
		}
		expect(paths).toContain("scripts/agent-toolkit.mjs");
		expect(paths).toContain("agent-toolkit.json");
		expect(paths.some((path) => path.startsWith("context/"))).toBeTrue();
		expect(paths.some((path) => path.startsWith("extensions/"))).toBeTrue();
		expect(paths.some((path) => path.startsWith("skills/"))).toBeTrue();
		expect(paths).toContain("context/working-style.md.j2");
		expect(paths.some((path) => path.startsWith("context/dist/")), "rendered context must not be packed").toBeFalse();
		expect(paths).toContain("extensions/system-prompt/index.ts");
		expect(paths).toContain("extensions/protected-paths/index.ts");
		expect(paths).toContain("extensions/custom-footer/index.ts");
		expect(paths).toContain("extensions/custom-footer/renderers.ts");
		expect(paths).toContain("skills/review/SKILL.md");
		expect(paths).toContain("skills/web/scripts/web");
		expect(paths).toContain("skills/writing-for-agents/SKILL-MECHANICS.md");
	});

	test("runs as a packed package bin without runtime dependencies", async () => {
		const packDirectory = join(sandbox, "pack");
		await mkdir(packDirectory);
		const packed = command(
			"npm",
			["pack", "--ignore-scripts", "--pack-destination", packDirectory],
			repoRoot,
			npmEnvironment(),
		);
		expect(packed.status).toBe(0);
		const archive = readdirSync(packDirectory).find((entry) => entry.endsWith(".tgz"));
		expect(archive).toBeDefined();

		const extracted = join(sandbox, "extracted");
		await mkdir(extracted);
		const unpacked = command("tar", ["-xzf", join(packDirectory, archive!), "-C", extracted]);
		expect(unpacked.status).toBe(0);

		const packageRoot = join(sandbox, "fixture/node_modules/agent-toolkit");
		await mkdir(dirname(packageRoot), { recursive: true });
		await cp(join(extracted, "package"), packageRoot, { recursive: true });
		expect(existsSync(join(packageRoot, "node_modules"))).toBeFalse();

		const binRoot = join(sandbox, "fixture/node_modules/.bin");
		await mkdir(binRoot, { recursive: true });
		const bin = join(binRoot, "agent-toolkit");
		await symlink("../agent-toolkit/scripts/agent-toolkit.mjs", bin);
		const validated = command(bin, ["validate"], join(sandbox, "fixture"));
		expect(validated.status).toBe(0);
		expect(validated.stdout).toMatch(/^Validated \d+ skills\.\n$/);
		expect(validated.stderr).toBe("");
	});
});
