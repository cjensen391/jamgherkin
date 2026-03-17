/**
 * JamGherkin Daemon
 *
 * Polls the Jam MCP server every 15 minutes for new recordings and processes
 * them sequentially, generating Playwright, Cypress, and Gherkin tests.
 *
 * Usage:
 *   npm run daemon                  # start daemon (skip already-existing jams)
 *   npm run daemon -- --backfill    # also process all jams found on first poll
 *   npm run daemon -- --interval 5  # poll every 5 minutes instead of 15
 *
 * State is persisted to daemon-state.json so the queue survives restarts.
 */

import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JamMcpClient } from "./mcp-client.js";
import type { JamMetadata } from "./mcp-client.js";
import { processJam } from "./process-jam.js";
import type { ProcessJamOptions } from "./process-jam.js";
dotenv.config();

export const DEFAULT_STATE_FILE = path.join(process.cwd(), "daemon-state.json");
const DEFAULT_POLL_INTERVAL_MIN = 15;

export interface DaemonState {
    processedIds: string[];
    failedIds: string[];
    queue: JamMetadata[];
    lastPollAt: string | null;
}

export function loadState(stateFile: string = DEFAULT_STATE_FILE): DaemonState {
    if (fs.existsSync(stateFile)) {
        try {
            return JSON.parse(fs.readFileSync(stateFile, "utf-8")) as DaemonState;
        } catch (e) {
            console.warn("[Daemon] Could not parse state file, starting fresh.");
        }
    }
    return { processedIds: [], failedIds: [], queue: [], lastPollAt: null };
}

export function saveState(state: DaemonState, stateFile: string = DEFAULT_STATE_FILE): void {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

export function parseArgs(argv: string[] = process.argv.slice(2)): { backfill: boolean; intervalMin: number } {
    const backfill = argv.includes("--backfill");
    const intervalIdx = argv.indexOf("--interval");
    const intervalMin = intervalIdx !== -1 ? parseInt(argv[intervalIdx + 1] ?? "", 10) : DEFAULT_POLL_INTERVAL_MIN;
    return { backfill, intervalMin: isNaN(intervalMin) ? DEFAULT_POLL_INTERVAL_MIN : intervalMin };
}

export async function pollForNewJams(
    state: DaemonState,
    client: Pick<JamMcpClient, "listJams">
): Promise<JamMetadata[]> {
    const jams = await client.listJams(50);
    state.lastPollAt = new Date().toISOString();

    const knownIds = new Set([
        ...state.processedIds,
        ...state.failedIds,
        ...state.queue.map(j => j.id),
    ]);

    return jams.filter(j => !knownIds.has(j.id));
}

export async function processQueue(
    state: DaemonState,
    jobOpts: ProcessJamOptions,
    processFn: (url: string, opts: ProcessJamOptions) => Promise<void>,
    stateFile: string = DEFAULT_STATE_FILE
): Promise<void> {
    while (state.queue.length > 0) {
        const jam = state.queue[0]!;
        const jamUrl = `https://jam.dev/c/${jam.id}`;
        console.log(`\n[Daemon] Processing: "${jam.title}" (${jam.id})`);
        console.log(`[Daemon] Queue remaining: ${state.queue.length}`);

        try {
            await processFn(jamUrl, jobOpts);
            console.log(`[Daemon] ✅ Completed: "${jam.title}"`);
            state.processedIds.push(jam.id);
        } catch (err) {
            console.error(`[Daemon] ❌ Failed: "${jam.title}"`, err);
            state.failedIds.push(jam.id);
        }

        state.queue.shift();
        saveState(state, stateFile);
    }
}

export async function tick(
    state: DaemonState,
    jobOpts: ProcessJamOptions,
    isFirstRun: boolean,
    backfill: boolean,
    client: Pick<JamMcpClient, "listJams">,
    processFn: (url: string, opts: ProcessJamOptions) => Promise<void>,
    stateFile: string = DEFAULT_STATE_FILE
): Promise<void> {
    console.log(`\n[Daemon] Polling at ${new Date().toISOString()}...`);

    let newJams: JamMetadata[] = [];
    try {
        newJams = await pollForNewJams(state, client);
    } catch (err) {
        console.error("[Daemon] Poll failed:", err);
        saveState(state, stateFile);
        return;
    }

    if (newJams.length === 0) {
        console.log("[Daemon] No new Jams found.");
        saveState(state, stateFile);
        return;
    }

    if (isFirstRun && !backfill) {
        console.log(`[Daemon] First run: marking ${newJams.length} existing Jam(s) as seen (use --backfill to process them).`);
        state.processedIds.push(...newJams.map(j => j.id));
        saveState(state, stateFile);
        return;
    }

    // Newest-first from API; reverse to process oldest first (FIFO)
    const toQueue = [...newJams].reverse();
    console.log(`[Daemon] Found ${toQueue.length} new Jam(s), adding to queue:`);
    for (const jam of toQueue) {
        console.log(`  + [${new Date(jam.createdAt).toLocaleString()}] ${jam.title}`);
        state.queue.push(jam);
    }
    saveState(state, stateFile);

    await processQueue(state, jobOpts, processFn, stateFile);
}

async function main(): Promise<void> {
    const { backfill, intervalMin } = parseArgs();
    const pollIntervalMs = intervalMin * 60 * 1000;

    console.log("[Daemon] JamGherkin Daemon starting...");
    console.log(`[Daemon] Poll interval: ${intervalMin} minute(s)`);
    if (backfill) console.log("[Daemon] --backfill enabled: will process all existing Jams on first run");
    console.log(`[Daemon] State file: ${DEFAULT_STATE_FILE}`);

    const state = loadState();

    if (state.queue.length > 0) {
        console.log(`[Daemon] Resuming with ${state.queue.length} item(s) already in queue from previous run.`);
    }

    const jobOpts: ProcessJamOptions = {
        noRun: true,
    };

    let isFirstRun = state.lastPollAt === null;

    const client = new JamMcpClient();

    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("\n[Daemon] Shutting down gracefully. Saving state...");
        saveState(state);
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    if (state.queue.length > 0) {
        await processQueue(state, jobOpts, processJam);
    }

    await tick(state, jobOpts, isFirstRun, backfill, client, processJam);
    isFirstRun = false;

    const timer = setInterval(async () => {
        if (shuttingDown) return;
        await tick(state, jobOpts, false, backfill, client, processJam);
    }, pollIntervalMs);

    timer.ref();

    console.log(`\n[Daemon] Watching for new Jams. Next poll in ${intervalMin} minute(s). Press Ctrl+C to stop.`);
}

// Only run when executed directly, not when imported by tests
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch(err => {
        console.error("[Daemon] Fatal error:", err);
        process.exit(1);
    });
}
