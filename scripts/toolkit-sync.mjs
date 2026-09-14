#!/usr/bin/env node
// @ts-check
import { lstatSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

import { parseOptions, run } from "./agent-toolkit.mjs";

const RESPEC_REMOTE = "https://github.com/hurricanehrndz/respec";
const RESPEC_CHECKOUT_PATH = "src/me/respec";

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
            if (statSync(checkout).isDirectory()) {
                process.stdout.write(`use respec checkout: ${checkout}\n`);
            }
            else {
                throw new Error();
            }
        }
        catch {
            throw new Error(`respec checkout path is not a directory: ${checkout}`);
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
