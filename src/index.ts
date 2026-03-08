import { chromium } from "playwright";
import { ClaudeService } from "./claude-service.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
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
                }
            } catch (e) {
                // Ignore if tab isn't found or clickable
            }
        }

        // Finally, extract the entire innerText of the app to grab all revealed logs and events
        const bodyContent = await page.innerText('body');
        extractedContext = `Url: ${jamUrl}\n\nVisible Page Data (contains logs, networks, and actions):\n${bodyContent}`;

        await browser.close();
        console.log("✅ Scrape complete. Length of context extracted:", extractedContext.length, "characters.");

        console.log("\n3. Generating Playwright test with Claude...");
        const playwrightTest = await claude.generateTest(extractedContext, "playwright");
        console.log("\n--- Playwright Test ---");
        console.log(playwrightTest);

        const playwrightPath = path.join(process.cwd(), "tests", `${jamId}.spec.ts`);
        fs.mkdirSync(path.dirname(playwrightPath), { recursive: true });
        fs.writeFileSync(playwrightPath, playwrightTest);
        console.log(`\n💾 Saved Playwright test to: ${playwrightPath}`);

        console.log("\n4. Generating Cypress test with Claude...");
        const cypressTest = await claude.generateTest(extractedContext, "cypress");
        console.log("\n--- Cypress Test ---");
        console.log(cypressTest);

        const cypressPath = path.join(process.cwd(), "cypress", "e2e", `${jamId}.cy.js`);
        fs.mkdirSync(path.dirname(cypressPath), { recursive: true });
        fs.writeFileSync(cypressPath, cypressTest);
        console.log(`\n💾 Saved Cypress test to: ${cypressPath}`);

        console.log("\n✅ Generation complete!");

    } catch (error) {
        console.error("Error:", error);
    }
}

main();
