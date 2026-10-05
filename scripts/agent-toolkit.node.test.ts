import assert from "node:assert/strict";
import { existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, test } from "node:test";

import { assertIncludes } from "./test-support.ts";

let sandbox: string;
const repoRoot = resolve(import.meta.dirname, "..");
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
		assert.equal(command("node", ["--version"]).stdout.trim(), "v24.14.1");

		const home = join(sandbox, "home");
		const dryRun = command("node", [installer, "sync", "--dry-run", "--home", home]);
		assert.equal(dryRun.status, 0);
		assert.equal(existsSync(home), false);

		const sync = command(installer, ["sync", "--agent", "prime", "--home", home]);
		assert.equal(sync.status, 0);
		const firstSkill = readdirSync(join(repoRoot, "skills"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort()[0]!;
		const destination = join(home, ".prime/agent/skills", firstSkill);
		assert.equal(lstatSync(destination).isSymbolicLink(), true);
		assert.equal(resolve(dirname(destination), readlinkSync(destination)), join(repoRoot, "skills", firstSkill));
	});

	test("packs only runtime resources", () => {
		const packed = command("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], repoRoot, npmEnvironment());
		assert.equal(packed.status, 0, packed.stderr);
		const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
		const paths = report[0]!.files.map((file) => file.path).sort();
		const allowedExact = new Set(["LICENSE", "README.md", "agent-toolkit.json", "package.json", "scripts/agent-toolkit.mjs"]);
		const allowedPrefixes = ["context/", "extensions/", "skills/"];
		for (const path of paths) {
			assert.equal(allowedExact.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix)), true, path);
			assert.doesNotMatch(path, /(?:^|\/)\.tmp(?:\/|$)|(?:^|\/)node_modules(?:\/|$)|__pycache__|\.pyc$|(?:^|\/)tests?(?:\/|$)|[._-]test(?:\.[^/]*)?$/);
		}
		assertIncludes(paths, "scripts/agent-toolkit.mjs");
		assertIncludes(paths, "agent-toolkit.json");
		assert.equal(paths.some((path) => path.startsWith("context/")), true);
		assert.equal(paths.some((path) => path.startsWith("extensions/")), true);
		assert.equal(paths.some((path) => path.startsWith("skills/")), true);
		assertIncludes(paths, "context/working-style.md.j2");
		assert.equal(paths.some((path) => path.startsWith("context/dist/")), false, "rendered context must not be packed");
		assertIncludes(paths, "extensions/system-prompt/index.ts");
		assertIncludes(paths, "extensions/protected-paths/index.ts");
		assertIncludes(paths, "extensions/custom-footer/index.ts");
		assertIncludes(paths, "extensions/custom-footer/renderers.ts");
		assertIncludes(paths, "skills/review/SKILL.md");
		assertIncludes(paths, "skills/web/scripts/web");
		assertIncludes(paths, "skills/writing-for-agents/SKILL-MECHANICS.md");
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
		assert.equal(packed.status, 0);
		const archive = readdirSync(packDirectory).find((entry) => entry.endsWith(".tgz"));
		assert.notEqual(archive, undefined);

		const extracted = join(sandbox, "extracted");
		await mkdir(extracted);
		const unpacked = command("tar", ["-xzf", join(packDirectory, archive!), "-C", extracted]);
		assert.equal(unpacked.status, 0);

		const packageRoot = join(sandbox, "fixture/node_modules/agent-toolkit");
		await mkdir(dirname(packageRoot), { recursive: true });
		await cp(join(extracted, "package"), packageRoot, { recursive: true });
		assert.equal(existsSync(join(packageRoot, "node_modules")), false);

		const binRoot = join(sandbox, "fixture/node_modules/.bin");
		await mkdir(binRoot, { recursive: true });
		const bin = join(binRoot, "agent-toolkit");
		await symlink("../agent-toolkit/scripts/agent-toolkit.mjs", bin);
		const validated = command(bin, ["validate"], join(sandbox, "fixture"));
		assert.equal(validated.status, 0);
		assert.match(validated.stdout, /^Validated \d+ skills\.\n$/);
		assert.equal(validated.stderr, "");
	});
});
