import Anthropic from "@anthropic-ai/sdk";

export interface TestUtil {
    /** Import path relative to the generated test file, e.g. "../test-utils/helpers" */
    importPath: string;
    /** Named exports available from that module, e.g. ["loginAs", "setupTestDb"] */
    exports: string[];
}

export interface CypressFixture {
    /** kebab-case identifier (becomes the JSON filename) */
    name: string;
    method: string;
    urlPattern: string;
    statusCode: number;
    body: unknown;
}

export class ClaudeService {
    private anthropic: Anthropic;
    private model: string;

    constructor() {
        const apiKey = process.env.ANTHROPIC_API_KEY || "";
        this.anthropic = new Anthropic({ apiKey });
        this.model = "claude-haiku-4-5-20251001"; // Anthropic's lowest cost model available in 2026
    }

    async generateTest(
        context: string,
        framework: "playwright" | "cypress" | "gherkin" | "api",
        testUtils: TestUtil[] = [],
        cypressFixtures: Array<{ filename: string; method: string; urlPattern: string; statusCode: number }> = [],
    ): Promise<string> {
        // Build an optional block telling Claude what helper functions exist in the target repo
        const testUtilsNote = testUtils.length > 0
            ? `\n      Available test utilities in the target codebase (use these instead of reimplementing):\n${testUtils.map(u =>
                `      - import { ${u.exports.length > 0 ? u.exports.join(', ') : '*'} } from "${u.importPath}";`
            ).join('\n')}\n      Prefer these helpers where relevant (e.g. for login flows, DB setup, common assertions).\n`
            : '';

        const apiPrompt = `
      You are an API test engineer. From the Jam recording's network traffic, generate focused HTTP integration tests using Playwright's \`request\` fixture (no browser needed — fast contract tests).

      Jam Context:
      ${context}
      ${testUtilsNote}
      CRITICAL RULES:
      1. INCLUDE only meaningful mutations: POST / PUT / PATCH / DELETE to the application's own API + calls to integration services (Stripe, HelloSign, Checkbook, PayScore, etc.). Also include any 4xx/5xx response that represents the bug under test.
      2. IGNORE: GETs for assets/fonts/images/analytics, auth token refreshes, websocket heartbeats, third-party trackers (Sentry, LogRocket, Segment).
      3. Generate **one \`test()\` block per meaningful endpoint call** and group related calls in \`test.describe('Resource', ...)\`.
      4. Each test:
         - Uses Playwright's request fixture: \`test('POST /endpoint description', async ({ request }) => { ... })\`
         - Sends the recorded HTTP method, URL path, and a faithful body (preserve field names + types from the recording).
         - Asserts \`expect(response.status()).toBe(<recorded-status>)\`.
         - Asserts on 1-3 key response fields (id, status, message, etc.) from the recorded response — use \`expect(body).toMatchObject({...})\` or \`expect(body.field).toBe(value)\`.
      5. **TEST INDEPENDENCE**: Each \`test()\` block is self-contained. If auth is required, perform it inside the test (or via a \`test.beforeEach\` inside the describe).
      6. **AUTH**: NEVER hardcode credentials or tokens.
         - Bearer tokens: \`process.env.TEST_AUTH_TOKEN\` in \`headers: { Authorization: \\\`Bearer \\\${process.env.TEST_AUTH_TOKEN}\\\` }\`
         - Login flow: POST to the auth endpoint with \`process.env.TEST_EMAIL\` / \`process.env.TEST_PASSWORD\` and reuse the returned token.
      7. **REDACT** sensitive payload values: replace passwords, SSNs, credit card numbers, and API keys with env vars or the literal placeholder string \`"<redacted>"\`.
      8. **BASE URL**: extract the host from recorded URLs and define it once: \`const BASE_URL = process.env.API_BASE_URL ?? 'https://...';\`. All requests use \`\\\`\\\${BASE_URL}/path\\\`\`.
      9. If the recording contains NO meaningful mutations, output a single placeholder test with a clear comment explaining why (e.g. \`// Recording was read-only — no API mutations to assert.\`).
      10. **Final Instruction**: Output ONLY raw TypeScript. Start with \`import { test, expect } from '@playwright/test';\`. No markdown fences, no intro text.
    `;

        const prompt = framework === "api" ? apiPrompt : framework === "gherkin" ? `
      You are a senior QA engineer writing BDD feature files for a product team.
      I will provide you with raw technical data scraped from a Jam.dev recording (console logs, network requests, DOM events, user actions).
      Your job is to write a clean, business-readable Gherkin feature file.

      CRITICAL RULES — failure to follow these makes the output useless:
      - IGNORE browser console noise unless it is the bug.
      - IGNORE raw GET requests for assets, fonts, CDN, analytics, LogRocket, Sentry.
      - DO NOT use raw URLs, selector names, or HTTP methods in step descriptions.
      - Write in plain business language using "I" as the actor.
      - Focus on user goals AND the meaningful API interactions that result from them.
      - **OUTPUT FORMAT IS MANDATORY**: Your ENTIRE response must be valid Gherkin syntax starting with "Feature:". No markdown, no bullet points, no explanations. Even if context is missing or errored, output a placeholder Feature block with a comment — NEVER write prose.

      NETWORK CALLS — what to include vs. ignore:
      INCLUDE as "Then"/"And" steps (translate to business language):
        - POST / PUT / PATCH / DELETE to your application's own API endpoints (form submissions, saves, creates, updates, deletes)
        - Calls to payment processors (Stripe, Checkbook, PayScore) — e.g. "Then a payment of $X is submitted for processing"
        - Calls to e-signature services (HelloSign, DocuSign) — e.g. "Then the lease agreement is sent for e-signature"
        - Calls to background-check / screening services — e.g. "Then a background check is initiated for the applicant"
        - Any 4xx or 5xx responses that represent the bug under test
      IGNORE:
        - GET requests for page assets, fonts, images, analytics, third-party tracking
        - Successful auth token refreshes / session pings
        - Websocket heartbeat / polling requests

      Jam Context:
      ${context}

      INPUT FIELDS & KEYSTROKES — MANDATORY:
      The context may contain lines like "Typed donald trump ↵" or "Typed john@example.com ↵".
      These represent real user input and MUST be captured as individual "When" steps, e.g.:
        - Typed donald trump ↵  →  When I type "donald trump" into the search field and press Enter
        - Typed john@example.com ↵  →  When I enter "john@example.com" in the email field
        - Typed password123 ↵  →  When I enter my password  (redact actual password values)
        - Typed 123 Main St ↵  →  When I enter "123 Main St" in the address field
      Rules for typed values:
        - ALWAYS include the actual value in quotes for non-sensitive fields (search terms, names, addresses, amounts).
        - REDACT passwords, SSNs, credit card numbers — write "my password" / "my SSN" instead.
        - If ↵ ends the input, include "and press Enter" or "and submit" depending on context.
        - Use the surrounding events (which field was focused, what page was open) to name the field naturally.

      Instructions:
      1. If context contains errors, 404s, or "Not Found" — still output a valid placeholder .feature file with a comment like "# Recording data unavailable" inside the Feature description.
      2. Otherwise, identify the core user flow or bug.
      3. Write a complete Gherkin Feature with one or more Scenarios using Given/When/Then.
         - "Given" steps set up preconditions (logged in, on a specific page, data already exists).
         - "When" steps describe the user's actions (clicking buttons, AND typing into fields — include the actual values).
         - "Then" steps describe the observable outcome — including any meaningful API calls translated to business language (submission confirmed, payment processed, document sent, error shown).
         - Use "And" to chain multiple steps of the same type.
      4. If the recording includes calls to integrations (Stripe, HelloSign, Checkbook, PayScore, etc.), add a "Then" step for each in plain language — e.g.:
         - "Then the application fee payment is processed successfully"
         - "Then the lease document is sent for electronic signature"
         - "Then the tenant screening report is requested"
      5. Output ONLY the raw .feature file text. No markdown fences. No intro. No explanations. Start with "Feature:".
    ` : `
      You are an expert QA engineer.
      I will provide you with the technical context extracted from a Jam.dev video recording (console logs, network requests, DOM events).
      Based on this context, your task is to write an end-to-end automated test using the ${framework} framework.

      Jam Context:
      ${context}
      ${testUtilsNote}
      Instructions:
      1. Identify the core user flow or bug being demonstrated. 
         - NOTE: Look for "Typed [value] [key]" patterns (e.g. "Typed donald trump ↵") in the context to identify exact keyboard inputs.
         - **STRICT RULE: GENERATE MULTIPLE TESTS.** Do not write one large test. Split the recording into 3-5 focused \`test()\` blocks (e.g. "Initial Navigation", "Search Flow", "Category Filtering").
         - **MANDATORY INDEPENDENCE**: Each test block MUST be self-contained and independent. **EVERY \`test()\` block MUST start with its own \`page.goto()\`** and perform all necessary setup. Do NOT assume state from previous tests.
      2. Write a complete ${framework} test file using TypeScript.
      3. **CRITICAL: SELECTOR QUALITY AUDIT** — Every selector you write MUST pass this audit.
         **STRICTLY FORBIDDEN:**
         - NO CSS class names (e.g., \`.className\`, \`button.primary\`)
         - NO class-based attributes (e.g., \`[class*="..."]\`, \`[class~="..."]\`, \`[class="..."]\`)
         - NO bare tag-only selectors: \`span\`, \`div\`, \`a\`, \`button\`, \`input\`, \`i\`, \`svg\` alone are BANNED.
         - NO truncated placeholders (e.g. \`[data-testid*="..."]\` with a partial word).
         
         **MANDATORY HIERARCHY (in order of preference):**
         1. \`[data-testid="..."]\`, \`[data-cy="..."]\`, \`[data-test="..."]\`
         2. \`role="button"[name="Visible Text"]\`, \`role="link"[name="..."]\`, \`role="textbox"[name="..."]\`
         3. \`[aria-label="Action Description"]\`
         4. \`button:has-text("Exact Text")\`, \`a:has-text("Exact Text")\` — **only for stable UI labels** (e.g. "Save", "Cancel", "All Digg"). **NEVER use dynamic data values** (unit names, tenant names, property addresses, IDs, user-generated content) as has-text selectors — use data-testid or role instead.
         5. \`input[type="search"]\`, \`input[placeholder="Search stories..."]\`
         6. \`form > button[type="submit"]\` (structural only, NO CLASSES)
      4. **DEBUGGABILITY & RELIABILITY RULES:**
         - ${framework === 'playwright' ? `MANDATORY: Group every interaction inside \`await test.step('Action description', async () => { ... });\`.` : `Comment each logical step clearly.`}
         - ALWAYS target valid input elements (\`input\`, \`textarea\`, \`[contenteditable]\`) for text entry. NEVER target a \`button\` or \`div\`.
         - If an input is revealed by a click (e.g. search toggle), you MUST wait for it:
           ${framework === 'playwright' ? `  \`await page.waitForSelector("selector", { state: 'visible' });\`` : `  \`cy.get("selector").should("be.visible");\``}
         - After entering text, you MUST wait 300ms before submitting:
           ${framework === 'playwright' ? `  \`await page.waitForTimeout(300);\`` : `  \`cy.wait(300);\``}
         - **MANDATORY SUBMISSION:** You MUST submit by pressing the \`Enter\` key on the input locator.
           ${framework === 'playwright' ? `  Usage: \`await inputLocator.press('Enter');\` (NEVER use \`page.keyboard.press\`)` : `  Usage: \`cy.get("selector").type("{enter}");\``}
         - For search flows, strictly follow this sequence:
           a. \`aiClick\` the toggle.
           b. Wait for input visibility.
           c. \`aiFill\` the input.
           d. Wait 300ms.
           e. \`aiPress\` 'Enter' on the input element.
      5. Include comments explaining key steps.
      6. If the flow involves authentication, use environment variables:
         - Playwright: \`process.env.TEST_EMAIL\` / \`process.env.TEST_PASSWORD\`
         - Cypress: \`Cypress.env('TEST_EMAIL')\` / \`Cypress.env('TEST_PASSWORD')\`
         ${testUtils.length > 0 ? '- Use the provided login utility above if applicable.' : ''}
      ${framework === 'playwright' ? `7. **MANDATORY SELF-HEALING:** You MUST use:
         import { aiClick, aiFill, aiPress, aiWaitFor, aiWaitForURL } from '../src/self-heal.js';
         - **CRITICAL**: EVERY interaction after \`page.goto\` MUST use \`aiClick\`, \`aiFill\`, \`aiPress\`, \`aiWaitFor\`, or \`aiWaitForURL\`. 
         - **STRICTLY FORBIDDEN**: NEVER use \`page.click()\`, \`page.fill()\`, \`locator.click()\`, \`locator.fill()\`, \`locator.press()\`, \`locator.tripleClick()\`, \`locator.nth()\`, \`locator.first()\`, \`locator.last()\`, \`page.waitForSelector()\`, \`page.waitForURL()\`, \`locator.isVisible()\`, or \`locator.count()\`. These bypass healing and create fragile checks!
         - **SELECTOR RULE**: ALWAYS pass a **string literal selector** directly to the \`ai*\` functions. NEVER assign \`page.locator()\` to a variable and then use it — if you find yourself writing \`const x = page.locator(...)\`, you are doing it wrong.
           * GOOD: \`await aiClick(page, "button#submit", "Submit form");\`
           * BAD: \`const btn = page.locator("button#submit"); await aiClick(page, btn, ...);\`
           * BAD: \`const btn = page.locator("button#submit"); await btn.click();\`
         - **USAGE SIGNATURES (MANDATORY):**
           * \`await aiClick(page, "selector", "Action Description", { expectedUrlHint: "pattern", optional: true/false });\`
           * \`await aiFill(page, "selector", "Text to fill", "Action Description", { optional: true/false });\`
           * \`await aiPress(page, "selector", "Enter", "Action Description", { optional: true/false });\`
           * \`await aiWaitFor(page, "selector", "Waiting for XYZ", { state: 'visible', optional: true/false });\`
           * \`await aiWaitForURL(page, /regex/);\`
         - **OPTIONAL FLAG**: Use \`optional: true\` for elements that might not always appear (e.g. cookie banners, newsletter popups, conditional modals). This allows the test to continue if the element is missing even after healing.
         - **NO BRANCHING LOGIC**: Do NOT use \`if (await locator.isVisible())\`, \`if (await locator.count())\`, or any conditional DOM checks. Instead, use the \`optional\` flag inside the \`ai*\` call (e.g. \`aiClick(..., { optional: true })\`).
         - **NO MANUAL VERIFICATION STEPS**: Do NOT write "verify element is dismissed/gone" steps using raw locators. Trust the \`optional\` flag — if the action succeeded with \`optional: true\`, the element was there; if not, it wasn't.
         - **URL ASSERTIONS**: ALWAYS use \`await aiWaitForURL(page, /regex/);\` for navigation checks. It will automatically trigger a "Situation Audit" if the URL doesn't match.
         - **NEVER** add \`expect.soft(page).toHaveURL()\` for the same pattern immediately after \`aiWaitForURL\` — it is redundant and will fail if the audit accepted a different URL format. \`aiWaitForURL\` is the authoritative navigation check.
         - **NEVER use negative URL patterns** like \`/(?!some-path)/\` in \`aiWaitForURL\` — these match immediately and create false positives. To assert you are NOT on a page, skip the assertion entirely or use a positive pattern for where you SHOULD be.
         - **NEVER write meaningless assertions**: \`expect.soft(page).toBeTruthy()\` and \`expect.soft(locator).toBeTruthy()\` always pass — they prove nothing. Only assert something specific (e.g. \`toHaveURL\`, \`toHaveText\`). If you have nothing to assert, omit the step entirely.
         - PREFER \`page.goto('URL', { waitUntil: 'domcontentloaded' })\` for initial navigation.
      8. **Final Instruction:** Output ONLY raw TypeScript code for Playwright. No markdown backticks. No intro text.`
            : `7. **CYPRESS STEPS:** Identify key network requests and use cy.intercept/cy.wait.
         - DO NOT import describe/it/expect — they are globals.
         - DO NOT use Playwright syntax. ONLY use Cypress syntax.
${cypressFixtures.length > 0 ? `         - **PRE-GENERATED FIXTURES AVAILABLE** — these JSON files exist on disk. USE them via \`cy.intercept\` instead of inlining response bodies:
${cypressFixtures.map(f => `           * cy.intercept('${f.method}', '${f.urlPattern}', { fixture: '${f.filename}', statusCode: ${f.statusCode} }).as('${f.filename.replace(/[^a-zA-Z0-9]+/g, '_')}');`).join('\n')}
         - Wire each intercept BEFORE the action that triggers it (typically inside \`beforeEach\` or at the top of the test).
         - After the action, \`cy.wait('@<alias>')\` to assert the request fired.
         - **DO NOT** inline the response body in the test file when a fixture is listed above — always reference the fixture path.\n` : ''}      8. **Final Instruction:** Output ONLY raw TypeScript code for Cypress. No markdown backticks. No intro text.`}
    `;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 4000,
                messages: [{ role: "user", content: prompt }]
            });

            const block = response.content.find(block => block.type === 'text');
            if (block && block.type === 'text') {
                let text = block.text.trim();
                text = text.replace(/^```[a-zA-Z0-9-]*\n/i, "");
                text = text.replace(/\n```$/i, "");
                return text.trim();
            }
            return "Error: Could not extract text from Claude response.";
        } catch (e) {
            console.error("Failed to generate with Claude", e);
            throw e;
        }
    }

    async extractFixtures(context: string): Promise<CypressFixture[]> {
        const prompt = `From the Jam recording's network traffic below, extract API responses that should be mocked in a Cypress test.

INCLUDE:
- POST / PUT / PATCH / DELETE responses to the application's own API
- Any 4xx/5xx response that represents the bug under test
- Calls to integration services (Stripe, HelloSign, Checkbook, PayScore, etc.)
- Key GET responses that drive UI rendering (e.g. list endpoints whose data the page renders)

EXCLUDE: assets, fonts, images, analytics, websocket heartbeats, auth token refreshes, third-party trackers (Sentry, LogRocket, Segment).

For each mockable response, output a JSON object with:
  - "name": kebab-case identifier (e.g. "create-tenant", "list-properties"). MUST be unique within the array.
  - "method": HTTP method ("GET", "POST", etc.)
  - "urlPattern": Cypress glob URL pattern. Prefer "**/api/<path>" so it matches any base URL. For dynamic IDs use "*" (e.g. "**/api/tenants/*").
  - "statusCode": numeric HTTP status from the recording (default 200 if unclear)
  - "body": the response body. If the recording shows JSON, parse it and embed the object/array directly. If the body is a string, use the string. If no body or only an empty body is visible, use null.

If no mockable responses are found, output an empty array [].

Recording context:
${context}

Output ONLY a valid JSON array. No markdown fences. No prose. Start with [.`;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 6000,
                messages: [{ role: "user", content: prompt }],
            });
            const block = response.content.find(b => b.type === "text");
            if (!block || block.type !== "text") return [];
            let text = block.text.trim();
            text = text.replace(/^```[a-zA-Z0-9-]*\n/, "").replace(/\n```$/, "").trim();
            const start = text.indexOf("[");
            const end = text.lastIndexOf("]");
            if (start === -1 || end === -1 || end < start) return [];
            const arr = JSON.parse(text.slice(start, end + 1));
            if (!Array.isArray(arr)) return [];
            return arr.filter((f: unknown): f is CypressFixture =>
                typeof f === "object" && f !== null
                && typeof (f as CypressFixture).name === "string"
                && typeof (f as CypressFixture).method === "string"
                && typeof (f as CypressFixture).urlPattern === "string"
                && typeof (f as CypressFixture).statusCode === "number"
            );
        } catch (e) {
            console.warn("[Fixtures] Extraction failed, falling back to inline mocks:", e);
            return [];
        }
    }

    async healSelector(
        failedSelector: string,
        description: string,
        domContext: string,
        previouslyTried: { selector: string; error?: string }[] = [],
        expectedUrlHint?: string,
        recordingContext?: string,
    ): Promise<string> {
        const alreadyTriedNote = previouslyTried.length > 0
            ? `\nEXCLUDED SELECTORS & ERRORS (CRITICAL): Do NOT use any of these. They have already been tried and yielded these errors. Your proposal MUST be different and avoid causing the same error:\n${previouslyTried.map(s => `  - Selector: "${s.selector}" -> Error: ${s.error || 'Unknown'}`).join('\n')}\n`
            : '';

        const urlHintNote = expectedUrlHint
            ? `\nNAVIGATION HINT: Clicking this element should cause the URL to change to match: ${expectedUrlHint}\nUse this to identify the correct button/link from the visible labels list — look for one whose text relates to this destination.\n`
            : '';

        const recordingNote = recordingContext
            ? `\nRECORDING GROUND TRUTH: The recording showed this successful context brief during creation:\n${recordingContext}\nUse this to confirm the user's intended action and find the matching element in the current DOM.\n`
            : '';

        const prompt = `Selector "${failedSelector}" for "${description}" failed. Find replacement.
${alreadyTriedNote}${urlHintNote}${recordingNote}
KEY INSIGHT: "${description}" is a test instruction, NOT the element's label. Extract the actual UI element name from it.
Example: "Click submit button to apply filters" → element is labeled "Apply Filters" or "Submit"

DOM CONTEXT:
${domContext}

SELECTOR PRIORITY (use first available):
1. [data-testid="..."] / [data-cy="..."] / [data-test="..."]
2. role=button[name="Label"] (use SHORT label from "Visible element labels")
3. [aria-label="Label"]
4. button:has-text("Label") or text="Label"
5. input[type="..."] / input[placeholder="..."]
6. Structural: form > button[type=submit]
7. #id or [name="..."]

BANNED (auto-reject):
- CSS utility classes: bg-*, text-*, flex-*, p-*, m-*, w-*, h-*, rounded-*, gap-*, cursor-*, group, relative, inline-*, hidden
- More than 2 class names
- Truncated mid-word (e.g., "data-testid*=")
- Bare tags: div, span, button, a, input (must have attribute/text)
- Any class attribute selector: [class*=...]
- Auto-generated/volatile IDs: React IDs like _r_0_, _r_4k_, _r_b9_; numeric IDs like #123; long hex hashes. These change between renders and will immediately break. Use placeholder, aria-label, role, or data attributes instead.

⚠️ OUTPUT RULES — MANDATORY:
- Respond with ONLY the raw selector string. Nothing else.
- NO explanation, reasoning, or prose before or after.
- NO markdown code fences (\`\`\`).
- NO quotes around the selector.
- If you write anything other than the selector, the system will break.
CORRECT: button[aria-label="Search"]
WRONG: \`\`\`button[aria-label="Search"]\`\`\`
WRONG: "Looking at the DOM, I can see that..."
WRONG: "The selector is: button[aria-label="Search"]"`;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 100,
                messages: [{ role: "user", content: prompt }]
            });

            const block = response.content.find(block => block.type === 'text');
            if (block && block.type === 'text') {
                let text = block.text.trim();
                // Strip markdown fences if Claude ignored the output rules
                text = text.replace(/^```[a-zA-Z0-9-]*\n?/i, "");
                text = text.replace(/\n?```$/i, "");
                // If Claude wrote prose, extract the first line that looks like a selector
                const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                // Find the first line that looks like a CSS/Playwright selector (not prose)
                const selectorLine = lines.find(l =>
                    /^([\[#\.]|role=|button|input|a\[|form|div\[|\*|svg)/.test(l) && !l.endsWith('.')
                );
                return (selectorLine || lines[0] || text).trim();
            }
            throw new Error("Could not extract new selector from Claude response.");
        } catch (e) {
            console.error("Failed to heal selector with Claude", e);
            throw e;
        }
    }

    async auditNavigation(
        expectedUrl: string | RegExp,
        currentUrl: string,
        domContext: string,
        recordingContext?: string,
    ): Promise<{ action: 'continue' | 'retry' | 'fail'; message?: string; recoverySelector?: string; recoveryAction?: string }> {
        const expectedStr = expectedUrl instanceof RegExp ? expectedUrl.toString() : expectedUrl;
        const recordingNote = recordingContext
            ? `\nRECORDING GROUND TRUTH: The user intended to reach a URL matching "${expectedStr}". The recording says:\n${recordingContext}\n`
            : '';

        const prompt = `URL MISMATCH AUDIT:
Expected: "${expectedStr}"
Current: "${currentUrl}"
${recordingNote}
TASK: Analyze DOM and decide action.

OPTIONS:
1. "continue" - URL differs but page is correct (extra params/hash/slug OK)
2. "retry" - Wrong page, navigation failed. Propose recovery (missed click/enter)
3. "fail" - Wrong page, no recovery possible

DOM:
${domContext}

OUTPUT (JSON only, no markdown):
{"action": "continue|retry|fail", "message": "reason", "recoverySelector": "if retry", "recoveryAction": "click|press"}`;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 300,
                messages: [{ role: "user", content: prompt }]
            });

            const block = response.content.find(block => block.type === 'text');
            if (block && block.type === 'text') {
                let text = block.text.trim();
                text = text.replace(/^```[a-zA-Z0-9-]*\n/i, "");
                text = text.replace(/\n```$/i, "");
                return JSON.parse(text.trim());
            }
            return { action: 'fail', message: 'Could not parse Claude response.' };
        } catch (e) {
            console.error("Failed to audit navigation", e);
            return { action: 'fail', message: `Claude API error: ${e}` };
        }
    }

    async summarizeContext(rawContext: string): Promise<string> {
        const prompt = `
      You are a technical analyst. I will provide you with raw technical logs (events, console, network, and optionally a video analysis and transcript) from a Jam.dev recording.
      Your goal is to summarize this data into a concise technical brief for a test engineer.

      RULES:
      - Focus ONLY on actions that changed the UI state (clicks, typing, navigation).
      - Include ONLY critical network failures (4xx, 5xx) or important API responses.
      - ALWAYS preserve POST / PUT / PATCH / DELETE requests to application endpoints — these represent form submissions and data mutations that must appear in Gherkin steps.
      - ALWAYS preserve calls to third-party integrations: payment processors (Stripe, Checkbook, PayScore), e-signature services (HelloSign, DocuSign), screening/background-check services. Note the endpoint, HTTP status, and any key response fields.
      - IGNORE GET requests for assets, fonts, images, analytics, tracking, session pings.
      - Include ONLY error/warning console logs that are not background noise.
      - Keep the summary under 1000 tokens.
      - Maintain the "Typed [value] [key]" patterns as they are crucial for testing.
      - If a VIDEO ANALYSIS section is present, extract the exact visible button labels, field names, and UI element text seen in the recording — these are the ground-truth labels to use in selectors. List them explicitly.
      - If a VIDEO TRANSCRIPT section is present, include any spoken descriptions of what the user is doing or what bugs they observed.

      Raw Context:
      ${rawContext}

      Output ONLY the summarized technical brief.
    `;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 1500,
                messages: [{ role: "user", content: prompt }]
            });

            const block = response.content.find(block => block.type === 'text');
            if (block && block.type === 'text') {
                return block.text.trim();
            }
            return rawContext;
        } catch (e) {
            console.error("Failed to summarize context with Claude", e);
            return rawContext;
        }
    }
}
