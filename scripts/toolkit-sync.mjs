#!/usr/bin/env node
// @ts-check
import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { parseOptions, run } from "./agent-toolkit.mjs";

const RESPEC_REMOTE = "https://github.com/hurricanehrndz/respec";
const RESPEC_CHECKOUT_PATH = "src/me/respec";
const RESPEC_REMOTES = new Set([
    RESPEC_REMOTE,
    `${RESPEC_REMOTE}.git`,
    "git@github.com:hurricanehrndz/respec",
    "git@github.com:hurricanehrndz/respec.git",
    "ssh://git@github.com/hurricanehrndz/respec",
    "ssh://git@github.com/hurricanehrndz/respec.git",
]);

// Test-rig commands that --bin can link into ~/.local/bin.
const BINS = {
    rig: resolve(import.meta.dirname, "../skills/windows-test-rig/scripts/rig"),
    mac: resolve(import.meta.dirname, "../skills/macos-test-rig/scripts/mac"),
};

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, home: string}} options
 */
function runCommand(command, args, options) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: { ...process.env, HOME: options.home },
        stdio: "inherit",
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
    }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, home: string}} options
 */
function captureCommand(command, args, options) {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: options.home },
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const detail = result.stderr.trim();
        throw new Error(`${command} exited with status ${result.status ?? "unknown"}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.trim();
}

/** @param {string} home @param {boolean} dryRun */
export async function syncRespec(home = homedir(), dryRun = false) {
    const checkout = join(home, RESPEC_CHECKOUT_PATH);
    let checkoutExists = true;
    try {
        lstatSync(checkout);
    }
    catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
            throw error;
        }
        checkoutExists = false;
    }
    if (checkoutExists) {
        try {
            if (!statSync(checkout).isDirectory()) {
                throw new Error();
            }
        }
        catch {
            throw new Error(`respec checkout path is not a directory: ${checkout}`);
        }

        let checkoutRoot;
        try {
            checkoutRoot = captureCommand("git", ["-C", checkout, "rev-parse", "--show-toplevel"], { home });
        }
        catch {
            throw new Error(`respec checkout is not a Git checkout: ${checkout}`);
        }
        if (realpathSync(checkoutRoot) !== realpathSync(checkout)) {
            throw new Error(`respec checkout is not the checkout root: ${checkout}`);
        }

        const origin = captureCommand("git", ["-C", checkout, "remote", "get-url", "origin"], { home });
        if (!RESPEC_REMOTES.has(origin)) {
            throw new Error(`respec checkout has unexpected origin '${origin}': ${checkout}`);
        }

        const status = captureCommand("git", ["-C", checkout, "status", "--porcelain=v1"], { home });
        process.stdout.write(`use respec checkout: ${checkout}\n`);
        if (status === "") {
            process.stdout.write(`update respec checkout: ${checkout}\n`);
            if (!dryRun) {
                runCommand("git", ["-C", checkout, "pull", "--ff-only"], { home });
            }
        }
        else {
            process.stdout.write(`respec checkout has local changes; skip update: ${checkout}\n`);
        }
    }
    else {
        process.stdout.write(`clone respec: ${RESPEC_REMOTE} -> ${checkout}\n`);
        if (!dryRun) {
            await mkdir(dirname(checkout), { recursive: true });
            runCommand("git", ["clone", RESPEC_REMOTE, checkout], { home });
        }
    }

    process.stdout.write(`install respec tools: ${checkout}\n`);
    if (!dryRun) {
        runCommand("mise", ["install"], { cwd: checkout, home });
    }

    process.stdout.write(`install respec: ${checkout}\n`);
    if (!dryRun) {
        runCommand("mise", ["exec", "--", "just", "install"], { cwd: checkout, home });
    }
}

/** @param {string} path */
function realpathOrNull(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}

/**
 * Links each enabled bin into ~/.local/bin and removes links to bins that are
 * not enabled. Paths that are not symlinks are never touched.
 * @param {string} home @param {Set<string>} enabled @param {boolean} dryRun
 */
export function syncBins(home, enabled, dryRun = false) {
    const binDir = join(home, ".local/bin");
    for (const [name, target] of Object.entries(BINS)) {
        const link = join(binDir, name);
        let current = null;
        try {
            current = readlinkSync(link);
        }
        catch (error) {
            const code = /** @type {NodeJS.ErrnoException} */ (error).code;
            if (code === "EINVAL") {
                if (enabled.has(name)) {
                    throw new Error(`${link} is not a symlink; left unchanged`);
                }
                continue;
            }
            if (code !== "ENOENT") {
                throw error;
            }
        }
        if (enabled.has(name)) {
            if (current === target) {
                continue;
            }
            process.stdout.write(`link ${name}: ${link} -> ${target}\n`);
            if (!dryRun) {
                mkdirSync(binDir, { recursive: true });
                if (current !== null) {
                    unlinkSync(link);
                }
                symlinkSync(target, link);
            }
        }
        else if (current !== null && realpathOrNull(link) === realpathOrNull(target)) {
            process.stdout.write(`unlink ${name}: ${link}\n`);
            if (!dryRun) {
                unlinkSync(link);
            }
        }
    }
}

/**
 * Splits the sync-only --bin NAME[,NAME] options from the shared ones.
 * @param {string[]} argv
 */
function parseBins(argv) {
    /** @type {string[]} */
    const rest = [];
    /** @type {Set<string>} */
    const bins = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const argument = /** @type {string} */ (argv[index]);
        if (argument !== "--bin") {
            rest.push(argument);
            continue;
        }
        const value = argv[index + 1];
        if (!value) {
            throw new Error("--bin requires a value.");
        }
        index += 1;
        for (const name of value.split(",").map((part) => part.trim())) {
            if (!Object.hasOwn(BINS, name)) {
                throw new Error(`Unknown bin "${name}"; expected one of: ${Object.keys(BINS).join(", ")}.`);
            }
            bins.add(name);
        }
    }
    return { bins, rest };
}

/** @param {string[]} argv */
export async function main(argv) {
    let bins;
    try {
        ({ bins, rest: argv } = parseBins(argv));
    }
    catch (error) {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
    }
    const result = await run(["sync", ...argv]);
    if (result !== 0) {
        return result;
    }
    const options = parseOptions(["sync", ...argv]);
    try {
        syncBins(options.home, bins, options.dryRun);
        await syncRespec(options.home, options.dryRun);
        return 0;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`error: ${message}\n`);
        return 2;
    }
}

if (import.meta.main) {
    process.exitCode = await main(process.argv.slice(2));
}
