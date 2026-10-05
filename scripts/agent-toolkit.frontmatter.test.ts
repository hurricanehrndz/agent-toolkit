import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import { parseFlatYamlFrontmatter, run } from "./agent-toolkit.mjs";
import { assertIncludes } from "./test-support.ts";

let sandbox: string;
let repoRoot: string;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

async function validate(document: string): Promise<{ code: number; stderr: string }> {
	await writeFile(join(repoRoot, "skills/valid/SKILL.md"), document);
	let stderr = "";
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		return { code: await run(["validate"], repoRoot), stderr };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

beforeEach(async () => {
	sandbox = await mkdtemp(join(tmpdir(), "agent-toolkit-frontmatter-"));
	repoRoot = join(sandbox, "repo");
	await mkdir(join(repoRoot, "skills/valid"), { recursive: true });
});

afterEach(async () => {
	process.stdout.write = originalStdoutWrite;
	process.stderr.write = originalStderrWrite;
	await rm(sandbox, { recursive: true, force: true });
});

describe("flat frontmatter parser", () => {
	const accepted = [
		"name: valid\ndescription: Plain metadata.\n",
		'name: "valid"\ndescription: "A quoted colon: stays text."\n',
		"name: 'valid'\ndescription: 'It''s a YAML single-quoted string.'\n",
		"name: valid\ndescription: Plain C# and https://example.com/#fragment\ndisable-model-invocation: true\nuser-invocable: false\n",
		"name: valid\ndescription: Plain metadata.\nmetadata-version: 2\noptional: null\n",
		'name: valid\ndescription: "A # marker in quotes is text."\n',
	];

	for (const [index, frontmatter] of accepted.entries()) {
		test(`accepts supported scalar case ${index + 1}`, async () => {
			const result = await validate(`---\n${frontmatter}---\n`);
			assert.deepEqual(result, { code: 0, stderr: "" });
		});
	}

	// Pinned YAML typing: numeric forms must be rejected as descriptions, and
	// near-misses must stay plain strings.
	const yamlNumberCompatibility: Array<[string, number | string]> = [
		[".nan", Number.NaN],
		[".NaN", Number.NaN],
		[".NAN", Number.NaN],
		[".inf", Number.POSITIVE_INFINITY],
		["+.INF", Number.POSITIVE_INFINITY],
		["-.Inf", Number.NEGATIVE_INFINITY],
		["0x10", 16],
		["+0x10", 16],
		["-0x10", -16],
		["0o7", 7],
		["+0o7", 7],
		["-0o7", -7],
		[".5", 0.5],
		["+.5", "+.5"],
		["-.5", "-.5"],
		["+.nan", "+.nan"],
		["-.nan", "-.nan"],
		["0X10", "0X10"],
		["0b10", "0b10"],
	];

	for (const [scalar, expected] of yamlNumberCompatibility) {
		test(`types ${scalar} as ${typeof expected}`, async () => {
			assert.equal(parseFlatYamlFrontmatter(`description: ${scalar}\n`).description, expected);
			const result = await validate(`---\nname: valid\ndescription: ${scalar}\n---\n`);
			assert.equal(result.code, typeof expected === "string" ? 0 : 1);
		});
	}

	const rejected: Array<[string, string, string]> = [
		["duplicate keys", "name: valid\nname: valid\ndescription: duplicate\n", "duplicate top-level key"],
		["implicit boolean keys", "name: valid\ndescription: metadata\ntrue: value\n", "must resolve to a string"],
		["indentation", " name: valid\ndescription: indented\n", "must not be indented"],
		["nested mappings", "name: valid\ndescription: nested\nmetadata:\n  child: value\n", "must not be indented"],
		["flow mappings", "name: valid\ndescription: flow\nmetadata: {child: value}\n", "unsupported YAML scalar form"],
		["flow sequences", "name: valid\ndescription: flow\nmetadata: [one, two]\n", "unsupported YAML scalar form"],
		["sequence indicators", "name: valid\ndescription: - item\n", "unsupported YAML scalar form"],
		["literal blocks", "name: valid\ndescription: |\n  multiline\n", "unsupported YAML scalar form"],
		["folded blocks", "name: valid\ndescription: >\n  multiline\n", "unsupported YAML scalar form"],
		["tags", "name: valid\ndescription: !text tagged\n", "unsupported YAML scalar form"],
		["anchors", "name: valid\ndescription: &description anchored\n", "unsupported YAML scalar form"],
		["aliases", "name: valid\ndescription: *description\n", "unsupported YAML scalar form"],
		["malformed double quotes", 'name: valid\ndescription: "bad\\xescape"\n', "invalid double-quoted scalar"],
		["malformed single quotes", "name: valid\ndescription: 'isn't escaped'\n", "invalid single-quoted scalar"],
		["whole-line comments", "name: valid\n# comment\ndescription: commented\n", "comments are not supported"],
		["inline comments", "name: valid\ndescription: value # comment\n", "comments are not supported"],
		["ambiguous colons", "name: valid\ndescription: unquoted: value\n", "ambiguous unquoted colon"],
		["trailing colons", "name: valid\ndescription: unquoted:\n", "ambiguous unquoted colon"],
		["quoted keys", '"name": valid\ndescription: quoted key\n', "plain-key mapping entry"],
		["numeric names", "name: 123\ndescription: number name\n", "frontmatter name must match"],
		["leading-zero numeric descriptions", "name: valid\ndescription: 01\n", "description is required"],
		["boolean descriptions", "name: valid\ndescription: false\n", "description is required"],
		["empty descriptions", "name: valid\ndescription:\n", "description is required"],
	];

	for (const [label, frontmatter, message] of rejected) {
		test(`rejects ${label}`, async () => {
			const result = await validate(`---\n${frontmatter}---\n`);
			assert.equal(result.code, 1);
			assertIncludes(result.stderr, message);
		});
	}
});

test("every checked-in skill satisfies the frontmatter contract", async () => {
	let stderr = "";
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		assert.equal(await run(["validate"], resolve(import.meta.dirname, "..")), 0);
		assert.equal(stderr, "");
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
});
