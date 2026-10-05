#!/usr/bin/env node
// @ts-check
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
/** @typedef {"pi" | "prime" | "codex" | "claude"} Agent */
/** @typedef {"install" | "sync" | "status" | "uninstall" | "validate"} Command */
/** @typedef {{ command: Command, agents: Agent[], home: string, dryRun: boolean }} Options */
/** @typedef {{ name: string, path: string }} Skill */
/** @typedef {Map<string, Agent[]>} SkillScopes */
/** @typedef {{ changed: number, conflicts: number }} Summary */
/** @typedef {{ type: "text", value: string } | { type: "if", agents: Agent[] } | { type: "endif" }} TemplateToken */
/** @typedef {{ tokens: TemplateToken[] | undefined, distRoot: string, legacySource: string }} Context */
/** @typedef {"present" | "owned" | "missing" | "conflict"} ContextLinkState */

/** @type {Record<Agent, string>} */
const AGENT_SKILL_PATHS = {
    pi: ".pi/agent/skills",
    prime: ".prime/agent/skills",
    codex: ".codex/skills",
    claude: ".claude/skills",
};
/** @type {Record<Agent, string>} */
const AGENT_CONTEXT_PATHS = {
    pi: ".pi/agent/APPEND_SYSTEM.md",
    prime: ".prime/agent/APPEND_SYSTEM.md",
    codex: ".codex/AGENTS.md",
    claude: ".claude/CLAUDE.md",
};
const CONTEXT_SOURCE_PATH = "context/working-style.md.j2";
// Rendered per agent on install/sync; home context links point here.
const CONTEXT_DIST_PATH = "context/dist";
// Pre-template checkouts linked every agent to this file; sync repoints those links.
const LEGACY_CONTEXT_SOURCE_PATH = "context/working-style.md";
/** @type {Agent[]} */
const ALL_AGENTS = /** @type {Agent[]} */ (Object.keys(AGENT_SKILL_PATHS));
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function usage() {
    return `Usage: agent-toolkit <command> [options]

Commands:
  validate                 Validate optional config, context, and skill frontmatter
  status                   Show managed resource state for selected agents
  install                  Link missing managed resources without removing anything
  sync                     Reconcile resources and remove stale checkout-owned links
  uninstall                Remove links owned by this checkout

Options:
  --agent <name[,name...]>  pi, prime, codex, claude, or all (repeatable)
  --home <path>             Override the home directory (useful for testing)
  --dry-run                 Print changes without applying them
  -h, --help                Show this help
`;
}
/** @param {string} value @returns {Agent[]} */
function parseAgents(value) {
    const requested = value.split(",").map((part) => part.trim());
    if (requested.includes("all")) {
        if (requested.length !== 1) {
            throw new Error('"all" cannot be combined with named agents.');
        }
        return [...ALL_AGENTS];
    }
    for (const agent of requested) {
        if (!ALL_AGENTS.includes(/** @type {Agent} */ (agent))) {
            throw new Error(`Unknown agent "${agent}". Expected: ${ALL_AGENTS.join(", ")}, or all.`);
        }
    }
    return /** @type {Agent[]} */ (requested);
}
/** @param {string[]} argv @returns {Options} */
export function parseOptions(argv) {
    if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
        process.stdout.write(usage());
        process.exit(0);
    }
    const command = /** @type {Command} */ (argv[0]);
    if (!["install", "sync", "status", "uninstall", "validate"].includes(command)) {
        throw new Error(`Unknown command "${argv[0]}".

${usage()}`);
    }
    let home = homedir();
    let dryRun = false;
    let agents = [];
    let selectedAll = false;
    let selectedNamedAgent = false;
    for (let index = 1; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--dry-run") {
            dryRun = true;
            continue;
        }
        if (argument === "--home" || argument === "--agent") {
            const value = argv[index + 1];
            if (!value) {
                throw new Error(`${argument} requires a value.`);
            }
            index += 1;
            if (argument === "--home") {
                home = resolve(value);
            }
            else {
                const selectsAll = value.split(",").map((part) => part.trim()).includes("all");
                if ((selectsAll && selectedNamedAgent) || (!selectsAll && selectedAll)) {
                    throw new Error('"all" cannot be combined with named agents.');
                }
                agents.push(...parseAgents(value));
                selectedAll ||= selectsAll;
                selectedNamedAgent ||= !selectsAll;
            }
            continue;
        }
        throw new Error(`Unknown option "${argument}".`);
    }
    if (agents.length === 0) {
        agents = ALL_AGENTS;
    }
    return { command, agents: /** @type {Agent[]} */ ([...new Set(agents)]), home, dryRun };
}
/** @param {string} skillsRoot @returns {Promise<Skill[]>} */
export async function discoverSkills(skillsRoot) {
    const skills = [];
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
            continue;
        }
        const path = join(skillsRoot, entry.name);
        if (existsSync(join(path, "SKILL.md"))) {
            skills.push({ name: entry.name, path });
        }
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name));
}
const YAML_NON_STRING_KEYS = new Set(["false", "no", "null", "off", "on", "true", "yes"]);

/** @typedef {string | boolean | number | null} FrontmatterScalar */

/**
 * Parse the deliberately small frontmatter language accepted by this toolkit.
 * It is a flat mapping with plain or quoted scalar values, not general YAML.
 *
 * @param {string} source
 * @returns {Record<string, FrontmatterScalar>}
 */
export function parseFlatYamlFrontmatter(source) {
    /** @type {Record<string, FrontmatterScalar>} */
    const metadata = {};
    const seen = new Set();
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        const lineNumber = index + 1;
        if (line.length === 0) {
            continue;
        }
        if (/^\s/.test(line)) {
            throw new SyntaxError(`line ${lineNumber} must not be indented`);
        }
        if (line.startsWith("#")) {
            throw new SyntaxError(`line ${lineNumber} comments are not supported`);
        }
        const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/);
        if (!match) {
            throw new SyntaxError(`line ${lineNumber} must be an unindented plain-key mapping entry`);
        }
        const key = match[1] ?? "";
        if (YAML_NON_STRING_KEYS.has(key.toLowerCase())) {
            throw new SyntaxError(`line ${lineNumber} key ${JSON.stringify(key)} must resolve to a string`);
        }
        if (seen.has(key)) {
            throw new SyntaxError(`duplicate top-level key ${JSON.stringify(key)}`);
        }
        seen.add(key);
        const rawValue = match[2] ?? "";
        metadata[key] = parseFlatYamlScalar(rawValue, lineNumber);
    }
    return metadata;
}

/**
 * @param {string} source
 * @param {number} lineNumber
 * @returns {FrontmatterScalar}
 */
function parseFlatYamlScalar(source, lineNumber) {
    if (source.length === 0 || /^(?:null|Null|NULL|~)$/.test(source)) {
        return null;
    }
    if (/^(?:true|True|TRUE)$/.test(source)) {
        return true;
    }
    if (/^(?:false|False|FALSE)$/.test(source)) {
        return false;
    }
    if (source.startsWith('"')) {
        try {
            const value = JSON.parse(source);
            if (typeof value !== "string") {
                throw new SyntaxError("double-quoted value must be a string");
            }
            return value;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new SyntaxError(`line ${lineNumber} has an invalid double-quoted scalar: ${message}`);
        }
    }
    if (source.startsWith("'")) {
        if (!source.endsWith("'") || source.length < 2) {
            throw new SyntaxError(`line ${lineNumber} has an unterminated single-quoted scalar`);
        }
        const inner = source.slice(1, -1);
        for (let index = 0; index < inner.length; index += 1) {
            if (inner[index] !== "'") {
                continue;
            }
            if (inner[index + 1] !== "'") {
                throw new SyntaxError(`line ${lineNumber} has an invalid single-quoted scalar`);
            }
            index += 1;
        }
        return inner.replace(/''/g, "'");
    }
    if (/^\.(?:nan|NaN|NAN)$/.test(source)) {
        return Number.NaN;
    }
    if (/^[+-]?\.(?:inf|Inf|INF)$/.test(source)) {
        return source.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    const baseNumber = source.match(/^([+-]?)(0x[0-9a-fA-F]+|0o[0-7]+)$/);
    if (baseNumber) {
        const sign = baseNumber[1] === "-" ? -1 : 1;
        const unsigned = baseNumber[2] ?? "";
        return sign * Number.parseInt(unsigned.slice(2), unsigned.startsWith("0x") ? 16 : 8);
    }
    if (/^(?:[+-]?\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)) {
        return Number(source);
    }
    if (/^(?:[-?:](?:[ \t]|$)|[!&*|>@`%\[\]{},])/.test(source)) {
        throw new SyntaxError(`line ${lineNumber} uses an unsupported YAML scalar form`);
    }
    if (/(?:^|[ \t])#/.test(source)) {
        throw new SyntaxError(`line ${lineNumber} comments are not supported`);
    }
    if (/:(?:[ \t]|$)/.test(source)) {
        throw new SyntaxError(`line ${lineNumber} has an ambiguous unquoted colon`);
    }
    if (/\t/.test(source) || source.endsWith(" ")) {
        throw new SyntaxError(`line ${lineNumber} has unsupported scalar whitespace`);
    }
    return source;
}

class StrictJsonDuplicateScanner {
    source;
    index = 0;
    /** @param {string} source */
    constructor(source) {
        this.source = source;
    }
    scan() {
        this.skipWhitespace();
        this.scanValue();
    }
    skipWhitespace() {
        while (/\s/.test(this.source[this.index] ?? "")) {
            this.index += 1;
        }
    }
    scanString() {
        const start = this.index;
        this.index += 1;
        while (this.index < this.source.length) {
            const character = this.source[this.index];
            if (character === "\\") {
                this.index += 2;
                continue;
            }
            this.index += 1;
            if (character === '"') {
                return JSON.parse(this.source.slice(start, this.index));
            }
        }
        throw new SyntaxError("unterminated string");
    }
    scanValue() {
        this.skipWhitespace();
        const character = this.source[this.index];
        if (character === "{") {
            this.scanObject();
            return;
        }
        if (character === "[") {
            this.scanArray();
            return;
        }
        if (character === '"') {
            this.scanString();
            return;
        }
        const start = this.index;
        while (this.index < this.source.length && !/[\s,\]}]/.test(this.source[this.index] ?? "")) {
            this.index += 1;
        }
        if (this.index === start) {
            throw new SyntaxError("expected a JSON value");
        }
    }
    scanObject() {
        this.index += 1;
        this.skipWhitespace();
        const keys = new Set();
        if (this.source[this.index] === "}") {
            this.index += 1;
            return;
        }
        while (this.index < this.source.length) {
            if (this.source[this.index] !== '"') {
                throw new SyntaxError("expected an object key");
            }
            const key = this.scanString();
            if (keys.has(key)) {
                throw new SyntaxError(`duplicate object key ${JSON.stringify(key)}`);
            }
            keys.add(key);
            this.skipWhitespace();
            if (this.source[this.index] !== ":") {
                throw new SyntaxError("expected ':' after an object key");
            }
            this.index += 1;
            this.scanValue();
            this.skipWhitespace();
            if (this.source[this.index] === "}") {
                this.index += 1;
                return;
            }
            if (this.source[this.index] !== ",") {
                throw new SyntaxError("expected ',' between object entries");
            }
            this.index += 1;
            this.skipWhitespace();
        }
        throw new SyntaxError("unterminated object");
    }
    scanArray() {
        this.index += 1;
        this.skipWhitespace();
        if (this.source[this.index] === "]") {
            this.index += 1;
            return;
        }
        while (this.index < this.source.length) {
            this.scanValue();
            this.skipWhitespace();
            if (this.source[this.index] === "]") {
                this.index += 1;
                return;
            }
            if (this.source[this.index] !== ",") {
                throw new SyntaxError("expected ',' between array values");
            }
            this.index += 1;
            this.skipWhitespace();
        }
        throw new SyntaxError("unterminated array");
    }
}
/** @param {string} source @returns {unknown} */
function parseStrictJson(source) {
    new StrictJsonDuplicateScanner(source).scan();
    return JSON.parse(source);
}
/** @param {string} skillsRoot @returns {Promise<string[]>} */
export async function validateSkills(skillsRoot) {
    /** @type {string[]} */
    const errors = [];
    for (const skill of await discoverSkills(skillsRoot)) {
        const document = await readFile(join(skill.path, "SKILL.md"), "utf8");
        const match = document.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!match) {
            errors.push(`${skill.name}: SKILL.md must start with YAML frontmatter`);
            continue;
        }
        const frontmatter = match[1] ?? "";
        let metadata;
        try {
            metadata = parseFlatYamlFrontmatter(frontmatter);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${skill.name}: invalid YAML frontmatter: ${message}`);
            continue;
        }
        const name = typeof metadata.name === "string" ? metadata.name : undefined;
        const description = typeof metadata.description === "string" ? metadata.description : undefined;
        if (name !== skill.name) {
            errors.push(`${skill.name}: frontmatter name must match its directory`);
        }
        if (!NAME_PATTERN.test(skill.name) || skill.name.length > 64) {
            errors.push(`${skill.name}: name must be <=64 lowercase letters, numbers, and single hyphens`);
        }
        if (!description || description.trim().length === 0) {
            errors.push(`${skill.name}: description is required`);
        }
        else if (description.length > 1024) {
            errors.push(`${skill.name}: description must be <=1024 characters`);
        }
    }
    return errors;
}
/** @param {string} configPath @param {Skill[]} skills @returns {Promise<{scopes: SkillScopes, errors: string[]}>} */
export async function loadConfig(configPath, skills) {
    /** @type {SkillScopes} */
    const scopes = new Map(skills.map((skill) => [skill.name, [...ALL_AGENTS]]));
    /** @type {string[]} */
    const errors = [];
    if (!existsSync(configPath)) {
        return { scopes, errors };
    }
    let parsed;
    try {
        parsed = parseStrictJson(await readFile(configPath, "utf8"));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { scopes, errors: [`agent-toolkit.json: invalid JSON: ${message}`] };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { scopes: new Map(), errors: ["agent-toolkit.json: top level must be an object"] };
    }
    const config = /** @type {Record<string, unknown>} */ (parsed);
    for (const key of Object.keys(config)) {
        if (key !== "skills") {
            errors.push(`agent-toolkit.json: unknown top-level key "${key}"`);
        }
    }
    if (typeof config.skills !== "object" || config.skills === null || Array.isArray(config.skills)) {
        errors.push("agent-toolkit.json: skills must be an object");
        return { scopes: new Map(), errors };
    }
    const configured = /** @type {Record<string, unknown>} */ (config.skills);
    const discoveredNames = new Set(skills.map((skill) => skill.name));
    for (const [skillName, rawAgents] of Object.entries(configured)) {
        if (!discoveredNames.has(skillName)) {
            errors.push(`agent-toolkit.json: configured skill "${skillName}" is missing from skills/`);
        }
        if (!Array.isArray(rawAgents)) {
            errors.push(`agent-toolkit.json: ${skillName} must have an agent array`);
            continue;
        }
        if (rawAgents.length === 0) {
            errors.push(`agent-toolkit.json: ${skillName} must have at least one agent`);
            continue;
        }
        /** @type {Agent[]} */
        const agents = [];
        const seen = new Set();
        for (const rawAgent of rawAgents) {
            if (typeof rawAgent !== "string" || !ALL_AGENTS.includes(/** @type {Agent} */ (rawAgent))) {
                errors.push(`agent-toolkit.json: ${skillName} has unknown agent ${JSON.stringify(rawAgent)}`);
                continue;
            }
            if (seen.has(rawAgent)) {
                errors.push(`agent-toolkit.json: ${skillName} lists agent "${rawAgent}" more than once`);
                continue;
            }
            seen.add(rawAgent);
            agents.push(/** @type {Agent} */ (rawAgent));
        }
        scopes.set(skillName, agents);
    }
    return { scopes, errors };
}
/** @param {string} path @returns {string | undefined} */
function targetOfLink(path) {
    try {
        if (!lstatSync(path).isSymbolicLink()) {
            return undefined;
        }
        return resolve(dirname(path), readlinkSync(path));
    }
    catch {
        return undefined;
    }
}
/**
 * Parse the Jinja subset accepted by the context template: `{% if agent == "x" %}`,
 * `{% if agent in ["x", "y"] %}`, and `{% endif %}`, using Jinja's trim_blocks and
 * lstrip_blocks whitespace rules. Every other tag or expression is rejected so the
 * template stays renderable by real Jinja.
 * CEILING: conditionals on the agent name only. Switch to minijinja-cli pinned in
 * mise (aqua:mitsuhiko/minijinja) when the template needs else, includes, loops,
 * or variables.
 *
 * @param {string} source
 * @returns {TemplateToken[]}
 */
export function parseContextTemplate(source) {
    /** @type {TemplateToken[]} */
    const tokens = [];
    /** @param {number} index */
    const lineOf = (index) => source.slice(0, index).split("\n").length;
    /** @param {string} value @param {number} index */
    const pushText = (value, index) => {
        const expression = value.search(/\{\{|\{#/);
        if (expression !== -1) {
            throw new SyntaxError(`line ${lineOf(index + expression)}: only {% if agent ... %} blocks are supported`);
        }
        tokens.push({ type: "text", value });
    };
    let depth = 0;
    let cursor = 0;
    for (const match of source.matchAll(/(?:^[ \t]*)?\{%(.*?)%\}(?:\r?\n)?/gm)) {
        pushText(source.slice(cursor, match.index), cursor);
        cursor = match.index + match[0].length;
        const tag = (match[1] ?? "").trim();
        if (tag === "endif") {
            if (depth === 0) {
                throw new SyntaxError(`line ${lineOf(match.index)}: {% endif %} without {% if %}`);
            }
            depth -= 1;
            tokens.push({ type: "endif" });
            continue;
        }
        const single = tag.match(/^if agent == "([a-z]+)"$/);
        const list = tag.match(/^if agent in \[\s*("[a-z]+"(?:\s*,\s*"[a-z]+")*)\s*\]$/);
        const names = single ? [single[1] ?? ""] : list?.[1]?.split(",").map((part) => part.trim().slice(1, -1));
        if (names === undefined) {
            throw new SyntaxError(`line ${lineOf(match.index)}: unsupported tag {% ${tag} %}`);
        }
        for (const name of names) {
            if (!ALL_AGENTS.includes(/** @type {Agent} */ (name))) {
                throw new SyntaxError(`line ${lineOf(match.index)}: unknown agent "${name}"`);
            }
        }
        depth += 1;
        tokens.push({ type: "if", agents: /** @type {Agent[]} */ (names) });
    }
    pushText(source.slice(cursor), cursor);
    if (depth > 0) {
        throw new SyntaxError("{% if %} without {% endif %}");
    }
    return tokens;
}
/** @param {TemplateToken[]} tokens @param {Agent} agent @returns {string} */
export function renderContextTemplate(tokens, agent) {
    /** @type {boolean[]} */
    const active = [];
    let output = "";
    for (const token of tokens) {
        if (token.type === "if") {
            active.push(token.agents.includes(agent));
        }
        else if (token.type === "endif") {
            active.pop();
        }
        else if (active.every(Boolean)) {
            output += token.value;
        }
    }
    return output;
}
/** @param {string} contextSource @returns {{tokens: TemplateToken[] | undefined, errors: string[]}} */
function validateContextSource(contextSource) {
    try {
        if (!lstatSync(contextSource).isFile()) {
            return { tokens: undefined, errors: [`${CONTEXT_SOURCE_PATH}: must be a regular file`] };
        }
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
            return { tokens: undefined, errors: [] };
        }
        throw error;
    }
    try {
        return { tokens: parseContextTemplate(readFileSync(contextSource, "utf8")), errors: [] };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { tokens: undefined, errors: [`${CONTEXT_SOURCE_PATH}: ${message}`] };
    }
}
/** @param {Context} context @param {Agent} agent @returns {string} */
function contextDistPath(context, agent) {
    return join(context.distRoot, `${agent}.md`);
}
/** @param {string} destination @param {Context} context @returns {boolean} */
function isOwnedContextLink(destination, context) {
    const target = targetOfLink(destination);
    return target === context.legacySource
        || ALL_AGENTS.some((agent) => target === contextDistPath(context, agent));
}
/** @param {string} destination @param {Context} context @param {Agent} agent @returns {ContextLinkState} */
function contextLinkState(destination, context, agent) {
    const target = targetOfLink(destination);
    if (target === contextDistPath(context, agent)) {
        return "present";
    }
    if (isOwnedContextLink(destination, context)) {
        return "owned";
    }
    return existsSync(destination) || target !== undefined ? "conflict" : "missing";
}
/** @param {Context} context @param {TemplateToken[]} tokens @param {Agent} agent @returns {Promise<boolean>} */
async function isRenderedContextCurrent(context, tokens, agent) {
    const path = contextDistPath(context, agent);
    return existsSync(path) && await readFile(path, "utf8") === renderContextTemplate(tokens, agent);
}
/** @param {string} path @param {string} parent @returns {boolean} */
function isWithin(path, parent) {
    const pathFromParent = relative(parent, path);
    return pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}
/** @param {string} path @param {string} skillsRoot @returns {boolean} */
function isManagedLink(path, skillsRoot) {
    const target = targetOfLink(path);
    return target !== undefined && isWithin(target, skillsRoot) && dirname(target) === skillsRoot;
}
/** @param {Skill} skill @param {string} destinationRoot @param {boolean} dryRun @returns {Promise<"linked" | "present" | "conflict">} */
async function ensureLink(skill, destinationRoot, dryRun) {
    const destination = join(destinationRoot, skill.name);
    const currentTarget = targetOfLink(destination);
    if (currentTarget === skill.path) {
        return "present";
    }
    if (existsSync(destination) || currentTarget !== undefined) {
        return "conflict";
    }
    if (!dryRun) {
        await mkdir(destinationRoot, { recursive: true });
        await symlink(skill.path, destination, "dir");
    }
    return "linked";
}
/** @param {string} destinationRoot @param {Skill[]} skills @param {string} skillsRoot @param {boolean} dryRun @returns {Promise<number>} */
async function removeStaleLinks(destinationRoot, skills, skillsRoot, dryRun) {
    if (!existsSync(destinationRoot)) {
        return 0;
    }
    const expected = new Set(skills.map((skill) => skill.name));
    let removed = 0;
    for (const entry of readdirSync(destinationRoot)) {
        const path = join(destinationRoot, entry);
        if (!expected.has(entry) && isManagedLink(path, skillsRoot)) {
            process.stdout.write(`remove ${path}
`);
            if (!dryRun) {
                await rm(path);
            }
            removed += 1;
        }
    }
    return removed;
}
/** @param {Skill[]} skills @param {SkillScopes} scopes @param {Agent} agent @returns {Skill[]} */
function skillsForAgent(skills, scopes, agent) {
    return skills.filter((skill) => scopes.get(skill.name)?.includes(agent) === true);
}
/** @param {Options} options @param {Context} context @param {TemplateToken[]} tokens @param {Agent} agent @param {string} destination @returns {Promise<Summary>} */
async function ensureContext(options, context, tokens, agent, destination) {
    const state = contextLinkState(destination, context, agent);
    if (state === "conflict") {
        process.stderr.write(`  conflict context: ${destination} already exists
`);
        return { changed: 0, conflicts: 1 };
    }
    let changed = 0;
    const rendered = contextDistPath(context, agent);
    if (!await isRenderedContextCurrent(context, tokens, agent)) {
        process.stdout.write(`  render context: ${rendered}
`);
        if (!options.dryRun) {
            await mkdir(context.distRoot, { recursive: true });
            await writeFile(rendered, renderContextTemplate(tokens, agent));
        }
        changed += 1;
    }
    if (state === "owned" && options.command !== "sync") {
        process.stdout.write(`  outdated context link: ${destination} (run sync to repoint)
`);
    }
    else if (state !== "present") {
        process.stdout.write(`  ${state === "owned" ? "relink" : "link"} context: ${destination}
`);
        if (!options.dryRun) {
            if (state === "owned") {
                await rm(destination);
            }
            await mkdir(dirname(destination), { recursive: true });
            await symlink(rendered, destination, "file");
        }
        changed += 1;
    }
    return { changed, conflicts: 0 };
}
/** @param {string} destination @param {Context} context @param {boolean} dryRun @returns {Promise<number>} */
async function removeOwnedContextLink(destination, context, dryRun) {
    if (!isOwnedContextLink(destination, context)) {
        return 0;
    }
    process.stdout.write(`remove context: ${destination}
`);
    if (!dryRun) {
        await rm(destination);
    }
    return 1;
}
/** @param {Options} options @param {Skill[]} skills @param {SkillScopes} scopes @param {string} skillsRoot @param {Context} context @returns {Promise<Summary>} */
async function installOrSync(options, skills, scopes, skillsRoot, context) {
    let changed = 0;
    let conflicts = 0;
    for (const agent of options.agents) {
        const destinationRoot = join(options.home, AGENT_SKILL_PATHS[agent]);
        const scopedSkills = skillsForAgent(skills, scopes, agent);
        process.stdout.write(`${agent}: ${destinationRoot}
`);
        for (const skill of scopedSkills) {
            const result = await ensureLink(skill, destinationRoot, options.dryRun);
            if (result === "linked") {
                process.stdout.write(`  link ${skill.name}
`);
                changed += 1;
            }
            else if (result === "conflict") {
                process.stderr.write(`  conflict ${skill.name}: destination already exists
`);
                conflicts += 1;
            }
        }
        if (options.command === "sync") {
            changed += await removeStaleLinks(destinationRoot, scopedSkills, skillsRoot, options.dryRun);
        }
        const contextDestination = join(options.home, AGENT_CONTEXT_PATHS[agent]);
        if (context.tokens !== undefined) {
            const result = await ensureContext(options, context, context.tokens, agent, contextDestination);
            changed += result.changed;
            conflicts += result.conflicts;
        }
        else if (options.command === "sync") {
            changed += await removeOwnedContextLink(contextDestination, context, options.dryRun);
        }
    }
    return { changed, conflicts };
}
/** @param {Options} options @param {Skill[]} skills @param {SkillScopes} scopes @param {Context} context @returns {Promise<Summary>} */
async function showStatus(options, skills, scopes, context) {
    let conflicts = 0;
    for (const agent of options.agents) {
        const destinationRoot = join(options.home, AGENT_SKILL_PATHS[agent]);
        let linked = 0;
        let missing = 0;
        let agentConflicts = 0;
        for (const skill of skillsForAgent(skills, scopes, agent)) {
            const destination = join(destinationRoot, skill.name);
            const target = targetOfLink(destination);
            if (target === skill.path) {
                linked += 1;
            }
            else if (!existsSync(destination) && target === undefined) {
                missing += 1;
            }
            else {
                agentConflicts += 1;
            }
        }
        conflicts += agentConflicts;
        process.stdout.write(`${agent}: ${linked} linked, ${missing} missing, ${agentConflicts} conflicts (${destinationRoot})
`);
        if (context.tokens !== undefined) {
            const contextDestination = join(options.home, AGENT_CONTEXT_PATHS[agent]);
            const linkState = contextLinkState(contextDestination, context, agent);
            let state;
            if (linkState === "present") {
                state = await isRenderedContextCurrent(context, context.tokens, agent) ? "linked" : "outdated";
            }
            else if (linkState === "owned") {
                state = "outdated";
            }
            else {
                state = linkState;
                if (state === "conflict") {
                    conflicts += 1;
                }
            }
            process.stdout.write(`  context: ${state} (${contextDestination})
`);
        }
    }
    return { changed: 0, conflicts };
}
/** @param {Options} options @param {string} skillsRoot @param {Context} context @returns {Promise<Summary>} */
async function uninstall(options, skillsRoot, context) {
    let changed = 0;
    for (const agent of options.agents) {
        const destinationRoot = join(options.home, AGENT_SKILL_PATHS[agent]);
        if (existsSync(destinationRoot)) {
            for (const entry of readdirSync(destinationRoot)) {
                const path = join(destinationRoot, entry);
                if (!isManagedLink(path, skillsRoot)) {
                    continue;
                }
                process.stdout.write(`remove ${agent}/${entry}
`);
                if (!options.dryRun) {
                    await rm(path);
                }
                changed += 1;
            }
        }
        const contextDestination = join(options.home, AGENT_CONTEXT_PATHS[agent]);
        changed += await removeOwnedContextLink(contextDestination, context, options.dryRun);
    }
    return { changed, conflicts: 0 };
}
/** @param {string[]} argv @param {string} [repoRoot] @returns {Promise<number>} */
export async function run(argv, repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
    try {
        const options = parseOptions(argv);
        const skillsRoot = join(repoRoot, "skills");
        const skills = await discoverSkills(skillsRoot);
        const validationErrors = await validateSkills(skillsRoot);
        const config = await loadConfig(join(repoRoot, "agent-toolkit.json"), skills);
        validationErrors.push(...config.errors);
        const contextSource = validateContextSource(resolve(repoRoot, CONTEXT_SOURCE_PATH));
        validationErrors.push(...contextSource.errors);
        /** @type {Context} */
        const context = {
            tokens: contextSource.tokens,
            distRoot: resolve(repoRoot, CONTEXT_DIST_PATH),
            legacySource: resolve(repoRoot, LEGACY_CONTEXT_SOURCE_PATH),
        };
        if (validationErrors.length > 0) {
            for (const error of validationErrors) {
                process.stderr.write(`error: ${error}
`);
            }
            return 1;
        }
        if (options.command === "validate") {
            process.stdout.write(`Validated ${skills.length} skills.
`);
            return 0;
        }
        let summary;
        if (options.command === "status") {
            summary = await showStatus(options, skills, config.scopes, context);
        }
        else if (options.command === "uninstall") {
            summary = await uninstall(options, skillsRoot, context);
        }
        else {
            summary = await installOrSync(options, skills, config.scopes, skillsRoot, context);
        }
        if (options.dryRun && summary.changed > 0) {
            process.stdout.write(`Dry run: ${summary.changed} change(s) would be made.
`);
        }
        return summary.conflicts > 0 ? 1 : 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`error: ${message}
`);
        return 2;
    }
}
if (import.meta.main) {
    process.exitCode = await run(process.argv.slice(2));
}
