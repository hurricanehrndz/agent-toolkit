#!/usr/bin/env node
// @ts-check
import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Skill helpers also run directly from a shell: ~/.local/bin name -> checkout path.
/** @type {[string, string][]} */
const BIN_LINKS = [["rig", "skills/windows-test-rig/scripts/rig"]];

/** @param {string} home @param {boolean} dryRun */
export async function syncBinLinks(home = homedir(), dryRun = false) {
    for (const [name, source] of BIN_LINKS) {
        const link = join(home, ".local/bin", name);
        const target = join(REPO_ROOT, source);
        if (!existsSync(target)) {
            throw new Error(`bin link source is missing: ${target}`);
        }
        let current;
        try {
            current = readlinkSync(link);
        }
        catch (error) {
            const code = /** @type {NodeJS.ErrnoException} */ (error).code;
            if (code === "EINVAL") {
                throw new Error(`bin path is not a symlink: ${link}`);
            }
            if (code !== "ENOENT") {
                throw error;
            }
            process.stdout.write(`link ${link} -> ${target}\n`);
            if (!dryRun) {
                await mkdir(dirname(link), { recursive: true });
                await symlink(target, link);
            }
            continue;
        }
        if (current !== target) {
            throw new Error(`bin link points elsewhere: ${link} -> ${current}`);
        }
    }
}

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

/** @param {string[]} argv */
export async function main(argv) {
    const result = await run(["sync", ...argv]);
    if (result !== 0) {
        return result;
    }
    const options = parseOptions(["sync", ...argv]);
    try {
        await syncBinLinks(options.home, options.dryRun);
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
