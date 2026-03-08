import { GeminiService } from "./gemini-service.js";
import dotenv from "dotenv";

dotenv.config();

const extractedContext = `
### Recording: Tenants List - Ensure Ability to Send Rent Reminder
- **URL:** https://qatestjensen.beta.doorloop.com/home
- **System:** macOS (arm) 26.3.1, Chrome 145.0.7632.117

### Events & Logs:
1. Navigation to Tenants List with filters: ?filter_status=CURRENT&period=all-time.
2. Console logs show History API navigations.
3. User Click: data-cy="DLUI-ListItem-Se..."
4. Navigation: Switched to Gmail (mail.google.com).
5. User Click in Gmail: span#:3nq.y2
6. Interaction with Intercom conversational UI.
7. Moment.js warning: Deprecation warning for date format.
`;

async function generate() {
    const gemini = new GeminiService();

    console.log("Generating Playwright test...");
    const playwright = await gemini.generateTest(extractedContext, "playwright");
    console.log("\n--- Playwright Test ---\n", playwright);

    console.log("\nGenerating Cypress test...");
    const cypress = await gemini.generateTest(extractedContext, "cypress");
    console.log("\n--- Cypress Test ---\n", cypress);
}

generate();
