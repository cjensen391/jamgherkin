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

async function main() {
    const jamUrl = process.argv[2];
    if (!jamUrl) {
        console.error("Please provide a Jam URL");
        process.exit(1);
    }

    // Extract the video ID from the URL (e.g. 74d92fb2-cb25-4d46-ae14-ce4cf3c5b39d)
    const jamIdRaw = jamUrl.split('/').pop() || "unknown-video";
    const jamId = jamIdRaw.split('?')[0]; // Remove query params if any

    const claude = new ClaudeService();

    try {
        console.log(`\n1. Launching Playwright to scrape: ${jamUrl}...`);
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();

        // Navigate and wait for the page to load
        await page.goto(jamUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

        // We'll extract all textual data from the page after giving the React components a second to mount
        await page.waitForTimeout(3000);

        console.log("2. Extracting technical context from Jam UI...");
        let extractedContext = "";

        // Attempt to click tabs to reveal content (Console, Network, Actions)
        const tabs = ['Console', 'Network', 'Actions', 'Info'];

        for (const tabName of tabs) {
            try {
                const tabLocator = page.locator(`text=${tabName}`).first();
                if (await tabLocator.isVisible()) {
                    await tabLocator.click();
                    await page.waitForTimeout(1000); // Wait for tab content to render

                    // Grab the text of the body while THIS tab is active, appending it to the context
                    const tabContent = await page.innerText('body');
                    extractedContext += `\n--- TAB: ${tabName} ---\n${tabContent}\n`;
                }
            } catch (e) {
                // Ignore if tab isn't found or clickable
            }
        }

        // Step 1: Redact credentials before sending to Claude
        let filtered = extractedContext
            .replace(/(['"]?password['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3')
            .replace(/(bearer\s+)([A-Za-z0-9_=\-.]+)/gi, '$1***REDACTED***')
            .replace(/(['"]?api_?key['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3')
            .replace(/(['"]?secret['"]?\s*[:=]\s*['"]?)([^'"\s,}]+)(['"]?)/gi, '$1***REDACTED***$3');

        // Step 2: Strip technical noise so it doesn't contaminate Gherkin/test output.
        // Keep lines describing user actions and visible content; drop console errors, CDN noise, metadata.
        filtered = filtered
            .split('\n')
            .filter(line => {
                const l = line.trim();
                if (!l) return false;
                // Drop console error / warning / exception lines
                if (/^(error|warn(ing)?|uncaught|typeerror|resizeobserver|logrocket|sentry)/i.test(l)) return false;
                // Drop raw CDN / media / analytics URLs (not user-facing navigation)
                if (/https?:\/\/[^\s]*(\.mp3|\.mp4|\.woff2?|\.png|\.jpg|\.gif|cloudfront\.net|cdn\.|analytics|segment\.io|sentry\.io|logrocket\.com)/i.test(l)) return false;
                // Drop lines that are only a net:: error or bare HTTP status
                if (/net::err_|http\/[12]\.[01]\s+\d{3}/i.test(l)) return false;
                // Drop lines that are only a video timestamp (e.g. "0:48" or "00:03.4")
                if (/^\d{1,2}:\d{2}(\.\d+)?$/.test(l)) return false;
                // Drop browser / OS metadata lines
                if (/chrome\/\d+|mozilla\/5\.0|window size|resolution:/i.test(l)) return false;
                return true;
            })
            .join('\n');

        extractedContext = `Url: ${jamUrl}\n\nVisible Page Data (contains user actions, navigation, and visible text):\n${filtered}`;

        // Wait for the video title to load (it's often in the <title> tag)
        const rawTitle = await page.title();
        // Fallback to jamId if title is empty or generic, otherwise sanitize the title
        let safeTitle = jamId;
        if (rawTitle && rawTitle !== "Jam") {
            // Remove " - Jam" if present, then sanitize for file system
            safeTitle = rawTitle.replace(/\s*-\s*Jam\s*$/i, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/(^-|-$)/g, '');
        }

        // Ensure we don't end up with an empty string
        if (!safeTitle) safeTitle = jamId;

        await browser.close();
        console.log("✅ Scrape complete. Length of context extracted:", extractedContext.length, "characters.");
        console.log(`🎬 Video Title Extracted: "${rawTitle}" -> Using filename: "${safeTitle}"`);

        console.log("\n3. Generating Playwright test with Claude...");
        const playwrightTest = await claude.generateTest(extractedContext, "playwright");
        console.log("\n--- Playwright Test ---");
        console.log(playwrightTest);

        const playwrightPath = path.join(process.cwd(), "tests", `${safeTitle}.spec.ts`);
        fs.mkdirSync(path.dirname(playwrightPath), { recursive: true });
        fs.writeFileSync(playwrightPath, playwrightTest);
        console.log(`\n💾 Saved Playwright test to: ${playwrightPath}`);

        console.log("\n4. Generating Cypress test with Claude...");
        const cypressTest = await claude.generateTest(extractedContext, "cypress");
        console.log("\n--- Cypress Test ---");
        console.log(cypressTest);

        const cypressPath = path.join(process.cwd(), "cypress", "e2e", `${safeTitle}.cy.ts`);
        fs.mkdirSync(path.dirname(cypressPath), { recursive: true });
        fs.writeFileSync(cypressPath, cypressTest);
        console.log(`\n💾 Saved Cypress test to: ${cypressPath}`);

        console.log("\n5. Generating Gherkin feature file with Claude...");
        const gherkinTest = await claude.generateTest(extractedContext, "gherkin");
        console.log("\n--- Gherkin Feature ---");
        console.log(gherkinTest);

        const gherkinPath = path.join(process.cwd(), "features", `${safeTitle}.feature`);
        fs.mkdirSync(path.dirname(gherkinPath), { recursive: true });
        fs.writeFileSync(gherkinPath, gherkinTest);
        console.log(`\n💾 Saved Gherkin feature to: ${gherkinPath}`);

        console.log("\n✅ Generation complete!");

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

    } catch (error) {
        console.error("Error:", error);
    }
}

main();
