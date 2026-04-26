import { chromium } from "playwright";
import { ClaudeService } from "./claude-service.js";
import { scanCodebase } from "./scan-codebase.js";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

export interface ProcessJamOptions {
    outPlaywright?: string;
    outCypress?: string;
    outFeatures?: string;
    outApi?: string;
    testUtils?: Array<{ importPath: string; exports: string[] }>;
    noRun?: boolean;
    mcpFetch?: boolean;
    statusCode?: string;
    contentType?: string;
    host?: string;
    alsoHosts?: string[];
    limit?: number;
    scanDirs?: string[];
}

export async function processJam(jamUrl: string, opts: ProcessJamOptions = {}): Promise<void> {
    const {
        outPlaywright = path.join(process.cwd(), 'tests'),
        outCypress = path.join(process.cwd(), 'cypress', 'e2e'),
        outFeatures = path.join(process.cwd(), 'features'),
        outApi = path.join(process.cwd(), 'tests-api'),
        testUtils = [],
        noRun = false,
        statusCode,
        contentType,
        host,
        alsoHosts = [],
        limit,
        scanDirs = [],
    } = opts;

    const jamToken = process.env.JAM_TOKEN || "";
    let mcpFetch = opts.mcpFetch ?? false;
    if (jamUrl.includes("jam.dev") && jamToken && !mcpFetch) {
        console.log("💡 Jam URL detected and JAM_TOKEN found. Automatically enabling --mcp-fetch...");
        mcpFetch = true;
    }

    const jamIdRaw = jamUrl.split('/').pop() || "unknown-video";
    const jamId = jamIdRaw.split('?')[0];

    const claude = new ClaudeService();
    let extractedContext = "";
    let safeTitle = jamId;
    let rawTitle = "Jam";

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

                let hostFilter = host;
                if (!hostFilter) {
                    const originDomain = await client.getJamDomain(jam.id);
                    if (originDomain) {
                        hostFilter = originDomain;
                        console.log(`   💡 Auto-isolating network to recording domain: ${hostFilter}`);
                    } else if (jam.title) {
                        const match = jam.title.match(/([a-z0-9-]+\.[a-z]{2,})/i);
                        if (match) {
                            hostFilter = match[1];
                            console.log(`   💡 Auto-isolating network to base domain (from title): ${hostFilter}`);
                        }
                    }
                }

                if (alsoHosts.length > 0) {
                    console.log(`   💡 Also fetching integration traffic for: ${alsoHosts.join(', ')}`);
                }
                const mcpContext = await client.getJamContext(jam.id, {
                    statusCode,
                    contentType,
                    host: hostFilter,
                    alsoHosts,
                    limit
                });
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

        await page.goto(jamUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(3000);

        console.log("2. Extracting technical context from Jam UI...");
        let rawContext = "";

        const tabs = ['Console', 'Network', 'Actions', 'Info'];
        for (const tabName of tabs) {
            try {
                const tabLocator = page.locator(`button[role="tab"] >> text=${tabName}`).first();
                if (await tabLocator.isVisible()) {
                    await tabLocator.click();
                    await page.waitForTimeout(1000);
                    const tabContent = await page.innerText('body');
                    rawContext += `\n--- TAB: ${tabName} ---\n${tabContent}\n`;
                }
            } catch (e) {
                // Ignore if tab isn't found or clickable
            }
        }

        let filtered = rawContext
            .replace(/(['"]?password['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3')
            .replace(/(bearer\s+)([A-Za-z0-9_=\-.]+)/gi, '$1***REDACTED***')
            .replace(/(['"]?api_?key['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3')
            .replace(/(['"]?secret['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3');

        filtered = filtered
            .split('\n')
            .filter(line => {
                const l = line.trim();
                if (!l) return false;
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

    if (extractedContext.length > 15000) {
        console.log(`\n⚠️ Context is large (${extractedContext.length} chars). Summarizing with Claude Haiku to save tokens...`);
        extractedContext = await claude.summarizeContext(extractedContext);
        console.log(`✅ Summarization complete. New context length: ${extractedContext.length} chars.`);
    }

    if (scanDirs.length > 0) {
        console.log(`\n2.5. Scanning codebase for selectors in: ${scanDirs.join(', ')}...`);
        const codebaseContext = scanCodebase(scanDirs);
        if (codebaseContext) {
            extractedContext += `\n\n--- CODEBASE SELECTORS ---\n${codebaseContext}`;
            console.log(`✅ Codebase scan added ${codebaseContext.length} chars of selector context.`);
        } else {
            console.log("   No selectors / page objects found in scanned directories.");
        }
    }

    console.log("\n3. Generating Playwright test with Claude...");
    let playwrightTest = await claude.generateTest(extractedContext, "playwright", testUtils);

    const summaryBrief = extractedContext.replace(/`/g, '\\`');
    playwrightTest = `import { setRecordingContext } from '../src/self-heal.js';\n\nsetRecordingContext(\`${summaryBrief}\`);\n\n${playwrightTest}`;

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

    console.log("\n6. Generating API integration test with Claude...");
    const apiTest = await claude.generateTest(extractedContext, "api", testUtils);
    console.log("\n--- API Test ---");
    console.log(apiTest);

    const apiPath = path.join(outApi, `${safeTitle}.api.spec.ts`);
    fs.mkdirSync(path.dirname(apiPath), { recursive: true });
    fs.writeFileSync(apiPath, apiTest);
    console.log(`\n💾 Saved API test to: ${apiPath}`);

    console.log("\n✅ Generation complete!");

    if (!noRun) {
        console.log("\n7. Running generated Playwright test (headed)...");
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
        console.log("\n⏭️  Skipping test run (--skip-run).");
    }
}
