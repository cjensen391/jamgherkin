import dotenv from "dotenv";
import * as readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { processJam } from "./process-jam.js";
dotenv.config();

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// ── CLI Argument Parsing ──────────────────────────────────────────────────────
//
// Usage:
//   npm run runQA -- <jam-url> [options]
//
// Options:
//   --out-playwright <dir>   Output directory for Playwright tests  (default: ./tests)
//   --out-cypress    <dir>   Output directory for Cypress tests     (default: ./cypress/e2e)
//   --out-features   <dir>   Output directory for Gherkin features  (default: ./features)
//   --test-utils     <spec>  Test utilities available in the target codebase.
//                            Format: "<import-path>:<export1>,<export2>,..."
//                            Example: "../test-utils/helpers:loginAs,setupTestDb"
//                            Can be repeated for multiple utility files.
//   --skip-run               Skip running the generated Playwright test after generation.
//   --list-jams              List recent Jam recordings from the MCP server.
//   --mcp-fetch              Fetch technical context via MCP instead of scraping (requires JAM_TOKEN).

import path from "path";

interface ParsedArgs {
    jamUrl: string;
    outPlaywright: string;
    outCypress: string;
    outFeatures: string;
    testUtils: Array<{ importPath: string; exports: string[] }>;
    mcpFetch: boolean;
    jamToken?: string;
    noRun: boolean;
    listJams: boolean;
    statusCode?: string | undefined;
    contentType?: string | undefined;
    host?: string | undefined;
    alsoHosts: string[];
    limit?: number | undefined;
    scanDirs: string[];
}

function parseArgs(): ParsedArgs {
    const argv = process.argv.slice(2);
    const jamUrl = argv.find(a => !a.startsWith('--')) ?? '';
    const listJams = argv.includes('--list-jams');
    const mcpFetch = argv.includes('--mcp-fetch');

    if (!jamUrl && !listJams && argv.includes('--help')) {
        console.error([
            'Usage:',
            '  npm run generate -- [jam-url] [options]   # generate only (recommended)',
            '  npm run runQA    -- [jam-url] [options]   # generate + auto-run test',
            '',
            'If no URL is provided, an interactive menu will appear.',
            '',
            'Options:',
            '  --list-jams              List recent Jam recordings and exit',
            '  --mcp-fetch              Fetch context via MCP (fast, no scraper)',
            '  --out-playwright <dir>   Playwright output dir   (default: ./tests)',
            '  --out-cypress    <dir>   Cypress output dir      (default: ./cypress/e2e)',
            '  --out-features   <dir>   Gherkin output dir      (default: ./features)',
            '  --test-utils     <spec>  Utility to inject, e.g. "../helpers:loginAs,setupTestDb"',
            '                           Repeat for multiple utility files.',
            '  --skip-run               Skip running the generated test',
            '  --status-code <val>      Filter network by status code (e.g. 500, 5xx)',
            '  --content-type <val>     Filter network by content type (e.g. application/json)',
            '  --host <val>             Filter network by host (e.g. api.example.com)',
            '  --also-host <val>        Include traffic from an additional host (e.g. api.stripe.com).',
            '                           Repeat for multiple integrations: --also-host api.stripe.com --also-host api.hellosign.com',
            '  --limit <num>            Limit network requests (default: 20)',
            '  --scan <dir>             Scan a target-repo directory for existing data-testid / aria-label / page objects',
            '                           and feed them to the generator + self-healer. Repeat for multiple roots.',
        ].join('\n'));
        process.exit(0);
    }

    const get = (flag: string): string | undefined => {
        const idx = argv.indexOf(flag);
        return idx !== -1 ? argv[idx + 1] : undefined;
    };

    const getAll = (flag: string): string[] => {
        const results: string[] = [];
        for (let i = 0; i < argv.length; i++) {
            const val = argv[i + 1];
            if (argv[i] === flag && val) results.push(val);
        }
        return results;
    };

    const testUtils = getAll('--test-utils').map(spec => {
        const colonIdx = spec.lastIndexOf(':');
        if (colonIdx === -1) return { importPath: spec, exports: [] };
        return {
            importPath: spec.slice(0, colonIdx),
            exports: spec.slice(colonIdx + 1).split(',').map(e => e.trim()).filter(Boolean),
        };
    });

    return {
        jamUrl,
        outPlaywright: get('--out-playwright') ?? path.join(process.cwd(), 'tests'),
        outCypress: get('--out-cypress') ?? path.join(process.cwd(), 'cypress', 'e2e'),
        outFeatures: get('--out-features') ?? path.join(process.cwd(), 'features'),
        testUtils,
        noRun: argv.includes('--skip-run') || process.env.SKIP_RUN === '1' || process.env.SKIP_RUN === 'true',
        listJams,
        mcpFetch,
        statusCode: get('--status-code'),
        contentType: get('--content-type'),
        host: get('--host'),
        alsoHosts: getAll('--also-host'),
        limit: get('--limit') ? parseInt(get('--limit')!, 10) : undefined,
        scanDirs: getAll('--scan'),
    };
}

async function main() {
    const args = parseArgs();
    const { outPlaywright, outCypress, outFeatures, testUtils, noRun, listJams } = args;
    let { jamUrl, mcpFetch } = args;

    const jamToken = process.env.JAM_TOKEN || "";
    if (jamUrl.includes("jam.dev") && jamToken && !mcpFetch) {
        console.log("💡 Jam URL detected and JAM_TOKEN found. Automatically enabling --mcp-fetch...");
        mcpFetch = true;
    }

    if (listJams) {
        const { JamMcpClient } = await import("./mcp-client.js");
        const client = new JamMcpClient();
        console.log("Fetching recent Jams from MCP...");
        try {
            const result = await client.listJams(10);
            const jams = (result as any).jams || [];
            console.log("\nRecent Jam recordings:");
            jams.forEach((j: any) => {
                const title = j.title.substring(0, 50) + (j.title.length > 50 ? "..." : "");
                console.log(`- [${new Date(j.createdAt).toLocaleString()}] ${title}`);
                console.log(`  URL: https://jam.dev/c/${j.id}`);
            });
            process.exit(0);
        } catch (err) {
            console.error("Failed to list Jams:", err);
            process.exit(1);
        }
    }

    if (!jamUrl) {
        const { JamMcpClient } = await import("./mcp-client.js");
        const client = new JamMcpClient();
        console.log("Fetching recent Jams from MCP...");
        try {
            const result = await client.listJams(10);
            const jams = (result as any).jams || [];

            console.log("\nSelect a recent Jam recording to generate tests for:");
            jams.forEach((j: any, i: number) => {
                const title = j.title.substring(0, 50) + (j.title.length > 50 ? "..." : "");
                console.log(`  ${i + 1}. [${new Date(j.createdAt).toLocaleString()}] ${title}`);
            });
            console.log(`  0. Or enter a Jam URL manually`);

            const rl = readline.createInterface({ input, output });
            let selection = await rl.question("\nEnter selection (1-10, 0, or paste URL): ");
            selection = selection.trim();

            if (selection === "0") {
                selection = await rl.question("Enter Jam URL: ");
                jamUrl = selection.trim();
            } else if (/^\d+$/.test(selection)) {
                const idx = parseInt(selection, 10) - 1;
                if (idx >= 0 && idx < jams.length) {
                    jamUrl = `https://jam.dev/c/${jams[idx].id}`;
                }
            } else if (selection.startsWith("http")) {
                jamUrl = selection;
            }

            rl.close();

            if (!jamUrl) {
                console.error("No valid Jam selected. Exiting.");
                process.exit(1);
            }

            if (!mcpFetch && jamToken) {
                console.log("💡 Automatically enabling MCP fetch for selected Jam...");
                mcpFetch = true;
            }
        } catch (err) {
            console.error("Failed to list Jams:", err);
            console.log("\nPlease provide a Jam URL via command line argument:");
            console.log("npm run runQA -- <jam-url>");
            process.exit(1);
        }
    }

    if (testUtils.length > 0) {
        console.log('🔧 Test utilities to inject:');
        for (const u of testUtils) {
            console.log(`   ${u.importPath} → { ${u.exports.join(', ')} }`);
        }
    }

    try {
        await processJam(jamUrl, {
            outPlaywright,
            outCypress,
            outFeatures,
            testUtils,
            noRun,
            mcpFetch,
            alsoHosts: args.alsoHosts,
            scanDirs: args.scanDirs,
            ...(args.statusCode !== undefined && { statusCode: args.statusCode }),
            ...(args.contentType !== undefined && { contentType: args.contentType }),
            ...(args.host !== undefined && { host: args.host }),
            ...(args.limit !== undefined && { limit: args.limit }),
        });
    } catch (error) {
        console.error("Error:", error);
    }
}

main();
