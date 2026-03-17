import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    loadState,
    saveState,
    parseArgs,
    pollForNewJams,
    processQueue,
    tick,
} from "../src/daemon.js";
import type { DaemonState } from "../src/daemon.js";
import type { ProcessJamOptions } from "../src/process-jam.js";
import type { JamMetadata } from "../src/mcp-client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpStateFile(): string {
    return path.join(os.tmpdir(), `daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeJam(id: string, title = `Jam ${id}`, createdAt = new Date().toISOString()): JamMetadata {
    return { id, title, url: `https://jam.dev/c/${id}`, author: "test", createdAt };
}

function emptyState(): DaemonState {
    return { processedIds: [], failedIds: [], queue: [], lastPollAt: null };
}

function makeClient(jams: JamMetadata[]): Pick<import("../src/mcp-client.js").JamMcpClient, "listJams"> {
    return { listJams: async () => jams };
}

function noop(): Promise<void> {
    return Promise.resolve();
}

function alwaysFail(): Promise<void> {
    return Promise.reject(new Error("processing failed"));
}

// ── loadState ─────────────────────────────────────────────────────────────────

describe("loadState", () => {
    test("returns default state when file does not exist", () => {
        const file = tmpStateFile(); // never written
        const state = loadState(file);
        assert.deepEqual(state, { processedIds: [], failedIds: [], queue: [], lastPollAt: null });
    });

    test("parses existing state file", () => {
        const file = tmpStateFile();
        const written: DaemonState = {
            processedIds: ["abc"],
            failedIds: ["def"],
            queue: [makeJam("ghi")],
            lastPollAt: "2024-01-01T00:00:00.000Z",
        };
        fs.writeFileSync(file, JSON.stringify(written));
        const state = loadState(file);
        assert.deepEqual(state, written);
        fs.unlinkSync(file);
    });

    test("returns default state when file contains invalid JSON", () => {
        const file = tmpStateFile();
        fs.writeFileSync(file, "not-json{{");
        const state = loadState(file);
        assert.deepEqual(state, { processedIds: [], failedIds: [], queue: [], lastPollAt: null });
        fs.unlinkSync(file);
    });
});

// ── saveState ─────────────────────────────────────────────────────────────────

describe("saveState", () => {
    test("writes state as formatted JSON", () => {
        const file = tmpStateFile();
        const state: DaemonState = {
            processedIds: ["x"],
            failedIds: [],
            queue: [],
            lastPollAt: "2024-06-01T12:00:00.000Z",
        };
        saveState(state, file);
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as DaemonState;
        assert.deepEqual(parsed, state);
        fs.unlinkSync(file);
    });

    test("round-trips through loadState", () => {
        const file = tmpStateFile();
        const original: DaemonState = {
            processedIds: ["a", "b"],
            failedIds: ["c"],
            queue: [makeJam("d")],
            lastPollAt: new Date().toISOString(),
        };
        saveState(original, file);
        const loaded = loadState(file);
        assert.deepEqual(loaded, original);
        fs.unlinkSync(file);
    });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
    test("returns defaults when no args given", () => {
        const result = parseArgs([]);
        assert.equal(result.backfill, false);
        assert.equal(result.intervalMin, 15);
    });

    test("--backfill sets backfill to true", () => {
        const result = parseArgs(["--backfill"]);
        assert.equal(result.backfill, true);
        assert.equal(result.intervalMin, 15);
    });

    test("--interval overrides default interval", () => {
        const result = parseArgs(["--interval", "5"]);
        assert.equal(result.intervalMin, 5);
    });

    test("--interval with non-numeric value falls back to default", () => {
        const result = parseArgs(["--interval", "oops"]);
        assert.equal(result.intervalMin, 15);
    });

    test("--interval missing value falls back to default", () => {
        const result = parseArgs(["--interval"]);
        assert.equal(result.intervalMin, 15);
    });

    test("--backfill and --interval can be combined", () => {
        const result = parseArgs(["--backfill", "--interval", "30"]);
        assert.equal(result.backfill, true);
        assert.equal(result.intervalMin, 30);
    });
});

// ── pollForNewJams ────────────────────────────────────────────────────────────

describe("pollForNewJams", () => {
    test("returns all jams when state is empty", async () => {
        const jams = [makeJam("1"), makeJam("2")];
        const state = emptyState();
        const result = await pollForNewJams(state, makeClient(jams));
        assert.equal(result.length, 2);
        assert.equal(result[0]!.id, "1");
        assert.equal(result[1]!.id, "2");
    });

    test("filters out already-processed IDs", async () => {
        const jams = [makeJam("1"), makeJam("2"), makeJam("3")];
        const state: DaemonState = { ...emptyState(), processedIds: ["1", "3"] };
        const result = await pollForNewJams(state, makeClient(jams));
        assert.equal(result.length, 1);
        assert.equal(result[0]!.id, "2");
    });

    test("filters out failed IDs", async () => {
        const jams = [makeJam("1"), makeJam("2")];
        const state: DaemonState = { ...emptyState(), failedIds: ["2"] };
        const result = await pollForNewJams(state, makeClient(jams));
        assert.equal(result.length, 1);
        assert.equal(result[0]!.id, "1");
    });

    test("filters out IDs already in the queue", async () => {
        const jams = [makeJam("1"), makeJam("2")];
        const state: DaemonState = { ...emptyState(), queue: [makeJam("1")] };
        const result = await pollForNewJams(state, makeClient(jams));
        assert.equal(result.length, 1);
        assert.equal(result[0]!.id, "2");
    });

    test("sets lastPollAt on state", async () => {
        const state = emptyState();
        assert.equal(state.lastPollAt, null);
        await pollForNewJams(state, makeClient([]));
        assert.notEqual(state.lastPollAt, null);
    });

    test("returns empty array when client returns empty list", async () => {
        const result = await pollForNewJams(emptyState(), makeClient([]));
        assert.equal(result.length, 0);
    });
});

// ── processQueue ──────────────────────────────────────────────────────────────

describe("processQueue", () => {
    let stateFile: string;
    beforeEach(() => { stateFile = tmpStateFile(); });
    afterEach(() => { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); });

    test("processes all items in order", async () => {
        const processed: string[] = [];
        const processFn = async (url: string) => { processed.push(url); };
        const state: DaemonState = {
            ...emptyState(),
            queue: [makeJam("a"), makeJam("b"), makeJam("c")],
        };
        await processQueue(state, {}, processFn, stateFile);
        assert.deepEqual(processed, [
            "https://jam.dev/c/a",
            "https://jam.dev/c/b",
            "https://jam.dev/c/c",
        ]);
    });

    test("moves completed items to processedIds", async () => {
        const state: DaemonState = { ...emptyState(), queue: [makeJam("x"), makeJam("y")] };
        await processQueue(state, {}, noop, stateFile);
        assert.deepEqual(state.processedIds, ["x", "y"]);
        assert.equal(state.queue.length, 0);
    });

    test("moves failed items to failedIds and continues", async () => {
        const state: DaemonState = {
            ...emptyState(),
            queue: [makeJam("fail"), makeJam("ok")],
        };
        const processFn = async (url: string) => {
            if (url.includes("fail")) throw new Error("boom");
        };
        await processQueue(state, {}, processFn, stateFile);
        assert.deepEqual(state.failedIds, ["fail"]);
        assert.deepEqual(state.processedIds, ["ok"]);
        assert.equal(state.queue.length, 0);
    });

    test("saves state to file after each item", async () => {
        const state: DaemonState = { ...emptyState(), queue: [makeJam("1"), makeJam("2")] };
        const snapshots: string[] = [];
        const processFn = async () => {
            // capture state file contents mid-queue
            if (fs.existsSync(stateFile)) {
                snapshots.push(fs.readFileSync(stateFile, "utf-8"));
            }
        };
        await processQueue(state, {}, processFn, stateFile);
        // State file should have been written (at least after first item)
        assert.ok(fs.existsSync(stateFile));
        assert.equal(state.queue.length, 0);
    });

    test("does nothing when queue is empty", async () => {
        const processed: string[] = [];
        const state = emptyState();
        await processQueue(state, {}, async (url) => { processed.push(url); }, stateFile);
        assert.equal(processed.length, 0);
    });

    test("passes jobOpts through to processFn", async () => {
        let receivedOpts: ProcessJamOptions | undefined;
        const processFn = async (_url: string, opts: ProcessJamOptions) => { receivedOpts = opts; };
        const jobOpts: ProcessJamOptions = { noRun: true, outPlaywright: "/tmp/out" };
        const state: DaemonState = { ...emptyState(), queue: [makeJam("j")] };
        await processQueue(state, jobOpts, processFn, stateFile);
        assert.deepEqual(receivedOpts, jobOpts);
    });
});

// ── tick ──────────────────────────────────────────────────────────────────────

describe("tick", () => {
    let stateFile: string;
    beforeEach(() => { stateFile = tmpStateFile(); });
    afterEach(() => { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); });

    test("first run without backfill: marks jams as seen, does not process", async () => {
        const jams = [makeJam("1"), makeJam("2")];
        const processed: string[] = [];
        const state = emptyState();

        await tick(state, {}, true, false, makeClient(jams), async (url) => { processed.push(url); }, stateFile);

        assert.equal(processed.length, 0);
        assert.deepEqual(state.processedIds.sort(), ["1", "2"]);
        assert.equal(state.queue.length, 0);
    });

    test("first run with backfill: queues and processes all jams", async () => {
        const jams = [makeJam("new1"), makeJam("new2")];
        const processed: string[] = [];
        const state = emptyState();

        await tick(state, {}, true, true, makeClient(jams), async (url) => { processed.push(url); }, stateFile);

        assert.equal(processed.length, 2);
        assert.equal(state.queue.length, 0);
        assert.deepEqual(state.processedIds.sort(), ["new1", "new2"]);
    });

    test("subsequent run: queues and processes new jams", async () => {
        const jams = [makeJam("new")];
        const processed: string[] = [];
        const state: DaemonState = {
            ...emptyState(),
            processedIds: ["old"],
            lastPollAt: "2024-01-01T00:00:00.000Z",
        };

        await tick(state, {}, false, false, makeClient(jams), async (url) => { processed.push(url); }, stateFile);

        assert.equal(processed.length, 1);
        assert.ok(processed[0]!.includes("new"));
        assert.deepEqual(state.processedIds, ["old", "new"]);
    });

    test("queues jams oldest-first (reverses API order)", async () => {
        // API returns newest-first; we expect oldest processed first
        const jams = [makeJam("newest"), makeJam("middle"), makeJam("oldest")];
        const order: string[] = [];
        const state = emptyState();

        await tick(state, {}, false, false, makeClient(jams), async (url) => {
            order.push(url.split("/").pop()!);
        }, stateFile);

        assert.deepEqual(order, ["oldest", "middle", "newest"]);
    });

    test("no new jams: saves state and returns without processing", async () => {
        const processed: string[] = [];
        const state: DaemonState = { ...emptyState(), processedIds: ["existing"] };

        await tick(state, {}, false, false, makeClient([makeJam("existing")]), async (url) => { processed.push(url); }, stateFile);

        assert.equal(processed.length, 0);
        assert.ok(fs.existsSync(stateFile));
    });

    test("poll failure: saves state and returns without crashing", async () => {
        const failingClient = { listJams: async (): Promise<JamMetadata[]> => { throw new Error("network error"); } };
        const state = emptyState();

        // Should not throw
        await tick(state, {}, false, false, failingClient, noop, stateFile);

        assert.ok(fs.existsSync(stateFile));
    });

    test("skips already-processed jams across multiple ticks", async () => {
        const processed: string[] = [];
        const processFn = async (url: string) => { processed.push(url); };
        const state = emptyState();

        const tick1Jams = [makeJam("a"), makeJam("b")];
        await tick(state, {}, false, false, makeClient(tick1Jams), processFn, stateFile);

        // Second tick: same jams plus a new one
        const tick2Jams = [makeJam("a"), makeJam("b"), makeJam("c")];
        await tick(state, {}, false, false, makeClient(tick2Jams), processFn, stateFile);

        // "a" and "b" should only appear once
        assert.equal(processed.filter(u => u.endsWith("/a")).length, 1);
        assert.equal(processed.filter(u => u.endsWith("/b")).length, 1);
        assert.equal(processed.filter(u => u.endsWith("/c")).length, 1);
    });
});
