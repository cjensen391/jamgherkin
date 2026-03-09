import { chromium } from "playwright";
import { ClaudeService } from "./claude-service.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
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
//   --no-run                 Skip running the generated Playwright test after generation.
//   --list-jams              List recent Jam recordings from the MCP server.
//   --mcp-fetch              Fetch technical context via MCP instead of scraping (requires JAM_TOKEN).

interface ParsedArgs {
    jamUrl: string;
    outPlaywright: string;
    outCypress: string;
    outFeatures: string;
    testUtils: Array<{ importPath: string; exports: string[] }>;
    noRun: boolean;
    listJams: boolean;
    mcpFetch: boolean;
}

function parseArgs(): ParsedArgs {
    const argv = process.argv.slice(2);
    const jamUrl = argv.find(a => !a.startsWith('--')) ?? '';
    const listJams = argv.includes('--list-jams');
    const mcpFetch = argv.includes('--mcp-fetch');

    if (!jamUrl && !listJams) {
        console.error([
            'Usage: npm run runQA -- <jam-url> [options]',
            '',
            'Options:',
            '  --list-jams              List recent Jam recordings',
            '  --mcp-fetch              Fetch context via MCP (fast, no scraper)',
            '  --out-playwright <dir>   Playwright output dir   (default: ./tests)',
            '  --out-cypress    <dir>   Cypress output dir      (default: ./cypress/e2e)',
            '  --out-features   <dir>   Gherkin output dir      (default: ./features)',
            '  --test-utils     <spec>  Utility to inject, e.g. "../helpers:loginAs,setupTestDb"',
            '                           Repeat for multiple utility files.',
            '  --no-run                 Skip running the generated test',
        ].join('\n'));
        process.exit(1);
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
        noRun: argv.includes('--no-run'),
        listJams,
        mcpFetch,
    };
}

async function main() {
    const args = parseArgs();
    const { jamUrl, outPlaywright, outCypress, outFeatures, testUtils, noRun, listJams, mcpFetch } = args;

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
                console.log(`- [${j.createdAt}] ${title}`);
                console.log(`  URL: https://jam.dev/c/${j.id}`);
            });
            process.exit(0);
        } catch (err) {
            console.error("Failed to list Jams:", err);
            process.exit(1);
        }
    }

    if (testUtils.length > 0) {
        console.log('🔧 Test utilities to inject:');
        for (const u of testUtils) {
            console.log(`   ${u.importPath} → { ${u.exports.join(', ')} }`);
        }
    }

    const jamIdRaw = jamUrl.split('/').pop() || "unknown-video";
    const jamId = jamIdRaw.split('?')[0]; // Remove query params if any

    const claude = new ClaudeService();
    let extractedContext = "";
    let safeTitle = jamId;
    let rawTitle = "Jam";

    try {
        if (mcpFetch) {
            console.log(`\n1. Attempting to fetch context via MCP for: ${jamUrl}...`);
            const { JamMcpClient } = await import("./mcp-client.js");
            const client = new JamMcpClient();
            try {
                const searchResults = await client.searchJams(jamUrl);
                const jam = (searchResults as any).jams?.[0] || searchResults[0];

                if (jam) {
                    console.log(`   Found Jam: "${jam.title}"`);
                    rawTitle = jam.title;
                    safeTitle = rawTitle.toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/(^-|-$)/g, '') || jamId;

                    const mcpContext = await client.getJamContext(jam.id);
                    extractedContext = `Url: ${jamUrl}\n\nTechnical context from Jam API:\n${mcpContext}`;
                    console.log("✅ MCP Fetch complete.");
                } else {
                    console.warn("⚠️  Jam not found via MCP search. Falling back to scraper...");
                }
            } catch (err) {
                console.error("❌ MCP Fetch failed:", err);
                console.log("Falling back to scraper...");
            }
        }

        if (!extractedContext) {
            console.log(`\n1. Launching Playwright to scrape: ${jamUrl}...`);
            const browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();

            // Navigate and wait for the page to load
            await page.goto(jamUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

            // We'll extract all textual data from the page after giving React components a second to mount
            await page.waitForTimeout(3000);

            console.log("2. Extracting technical context from Jam UI...");
            let rawContext = "";

            // Attempt to click tabs to reveal content (Console, Network, Actions)
            const tabs = ['Console', 'Network', 'Actions', 'Info'];

            for (const tabName of tabs) {
                try {
                    const tabLocator = page.locator(`button[role="tab"] >> text=${tabName}`).first();
                    if (await tabLocator.isVisible()) {
                        await tabLocator.click();
                        await page.waitForTimeout(1000); // Wait for tab content to render

                        // Special handling for Actions tab to ensure we get individual event lines
                        const tabContent = await page.innerText('body');
                        rawContext += `\n--- TAB: ${tabName} ---\n${tabContent}\n`;
                    }
                } catch (e) {
                    // Ignore if tab isn't found or clickable
                }
            }

            // Step 1: Redact credentials before sending to Claude
            let filtered = rawContext
                .replace(/(['"]?password['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3')
                .replace(/(bearer\s+)([A-Za-z0-9_=\-.]+)/gi, '$1***REDACTED***')
                .replace(/(['"]?api_?key['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3')
                .replace(/(['"]?secret['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3');

            // Step 2: Strip technical noise so it doesn't contaminate Gherkin/test output.
            filtered = filtered
                .split('\n')
                .filter(line => {
                    const l = line.trim();
                    if (!l) return false;
                    // Preserve Typed actions regardless of other filters
                    if (/Typed.*↵|Typed\s/i.test(l)) return true;

                    if (/^(error|warn(ing)?|uncaught|typeerror|resizeobserver|logrocket|sentry)/i.test(l)) return false;
                    if (/https?:\/\/[^\s]*(\.mp3|\.mp4|\.woff2?|\.png|\.jpg|\.gif|cloudfront\.net|cdn\.|analytics|segment\.io|sentry\.io|logrocket\.com)/i.test(l)) return false;
                    if (/net::err_|http\/[12]\.[01]\s+\d{3}/i.test(l)) return false;
                    if (/^\d{1,2}:\d{2}(\.\d+)?$/.test(l)) return false;
                    if (/chrome\/\d+|mozilla\/5\.0|window size|resolution:/i.test(l)) return false;
                    return true;
                })
                .join('\n');

            extractedContext = `Url: ${jamUrl}\n\nVisible Page Data (contains user actions, navigation, and visible text):\n${filtered}`;

            // Wait for the video title to load
            rawTitle = await page.title();
            if (rawTitle && rawTitle !== "Jam") {
                safeTitle = rawTitle.replace(/\s*-\s*Jam\s*$/i, '')
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/(^-|-$)/g, '');
            }
            if (!safeTitle) safeTitle = jamId;

            await browser.close();
            console.log("✅ Scrape complete. Length of context extracted:", extractedContext.length, "characters.");
            console.log(`🎬 Video Title Extracted: "${rawTitle}" -> Using filename: "${safeTitle}"`);
        }

        // Token saving: Summarize if context is too large (approx > 4k tokens)
        if (extractedContext.length > 15000) {
            console.log(`\n⚠️ Context is large (${extractedContext.length} chars). Summarizing with Claude Haiku to save tokens...`);
            extractedContext = await claude.summarizeContext(extractedContext);
            console.log(`✅ Summarization complete. New context length: ${extractedContext.length} chars.`);
        }

        console.log("\n3. Generating Playwright test with Claude...");
        const playwrightTest = await claude.generateTest(extractedContext, "playwright", testUtils);
        console.log("\n--- Playwright Test ---");
        console.log(playwrightTest);

        const playwrightPath = path.join(outPlaywright, `${safeTitle}.spec.ts`);
        fs.mkdirSync(path.dirname(playwrightPath), { recursive: true });
        fs.writeFileSync(playwrightPath, playwrightTest);
        console.log(`\n💾 Saved Playwright test to: ${playwrightPath}`);

        console.log("\n4. Generating Cypress test with Claude...");
        const cypressTest = await claude.generateTest(extractedContext, "cypress", testUtils);
        console.log("\n--- Cypress Test ---");
        console.log(cypressTest);

        const cypressPath = path.join(outCypress, `${safeTitle}.cy.ts`);
        fs.mkdirSync(path.dirname(cypressPath), { recursive: true });
        fs.writeFileSync(cypressPath, cypressTest);
        console.log(`\n💾 Saved Cypress test to: ${cypressPath}`);

        console.log("\n5. Generating Gherkin feature file with Claude...");
        const gherkinTest = await claude.generateTest(extractedContext, "gherkin", testUtils);
        console.log("\n--- Gherkin Feature ---");
        console.log(gherkinTest);

        const gherkinPath = path.join(outFeatures, `${safeTitle}.feature`);
        fs.mkdirSync(path.dirname(gherkinPath), { recursive: true });
        fs.writeFileSync(gherkinPath, gherkinTest);
        console.log(`\n💾 Saved Gherkin feature to: ${gherkinPath}`);

        console.log("\n✅ Generation complete!");

        if (!noRun) {
            console.log("\n6. Running generated Playwright test (headed)...");
            const result = spawnSync(
                "npx",
                ["playwright", "test", playwrightPath, "--headed"],
                { stdio: "inherit", cwd: process.cwd() }
            );
            if (result.status !== 0) {
                console.error(`\n⚠️  Playwright test failed or encountered an error (exit code ${result.status}).`);
            } else {
                console.log("\n✅ Playwright test run complete.");
            }
        } else {
            console.log("\n⏭️  Skipping test run (--no-run).");
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

main();
