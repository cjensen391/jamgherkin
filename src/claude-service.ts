import Anthropic from "@anthropic-ai/sdk";

export interface TestUtil {
    /** Import path relative to the generated test file, e.g. "../test-utils/helpers" */
    importPath: string;
    /** Named exports available from that module, e.g. ["loginAs", "setupTestDb"] */
    exports: string[];
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
        framework: "playwright" | "cypress" | "gherkin",
        testUtils: TestUtil[] = [],
    ): Promise<string> {
        // Build an optional block telling Claude what helper functions exist in the target repo
        const testUtilsNote = testUtils.length > 0
            ? `\n      Available test utilities in the target codebase (use these instead of reimplementing):\n${testUtils.map(u =>
                `      - import { ${u.exports.length > 0 ? u.exports.join(', ') : '*'} } from "${u.importPath}";`
            ).join('\n')}\n      Prefer these helpers where relevant (e.g. for login flows, DB setup, common assertions).\n`
            : '';

        const prompt = framework === "gherkin" ? `
      You are a senior QA engineer writing BDD feature files for a product team.
      I will provide you with raw technical data scraped from a Jam.dev recording (console logs, network requests, DOM events, user actions).
      Your job is to write a clean, business-readable Gherkin feature file.

      CRITICAL RULES — failure to follow these makes the output useless:
      - IGNORE browser console noise unless it is the bug.
      - IGNORE raw URLs and implementation details.
      - DO NOT use technical selectors in step descriptions.
      - Write in plain business language using "I" as the actor.
      - Focus on user goals.

      Jam Context:
      ${context}

      Instructions:
      1. Identify the core user flow or bug.
      2. Write a complete Gherkin Feature.
      3. Write one or more Scenarios using Given/When/Then.
      4. Output ONLY the raw text for the .feature file.
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
         4. \`button:has-text("Exact Text")\`, \`a:has-text("Exact Text")\`
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
         import { aiClick, aiFill, aiPress, softWaitForURL } from '../src/self-heal.js';
         - **CRITICAL**: EVERY interaction after \`page.goto\` MUST use \`aiClick\`, \`aiFill\`, or \`aiPress\`. 
         - NEVER use \`page.click()\`, \`page.fill()\`, \`locator.click()\`, \`locator.fill()\`, or \`locator.press()\`.
         - **USAGE SIGNATURES (MANDATORY):**
           * \`await aiClick(page, "selector", "Action Description", { expectedUrlHint: "pattern" });\`
           * \`await aiFill(page, "selector", "Text to fill", "Action Description");\`
           * \`await aiPress(page, "selector", "Enter", "Action Description");\`
         - **WAITING RULES:**
           * NEVER use \`page.waitForLoadState('networkidle')\`. It is unreliable and causes hangs.
           * ALWAYS use \`page.waitForLoadState('domcontentloaded')\` or \`page.waitForSelector("selector", { state: 'visible' })\`.
         - URL Assertions: Use \`await softWaitForURL(page, /regex/);\` instead of standard \`page.waitForURL\`.
         - Failures: Use \`expect.soft(page).toHaveURL(/regex/)\` for non-blocking assertions.
         - PREFER \`page.goto('URL', { waitUntil: 'domcontentloaded' })\` for initial navigation.
      8. **Final Instruction:** Output ONLY raw TypeScript code for Playwright. No markdown backticks. No intro text.`
            : `7. **CYPRESS STEPS:** Identify key network requests and use cy.intercept/cy.wait.
         - DO NOT import describe/it/expect — they are globals.
         - DO NOT use Playwright syntax. ONLY use Cypress syntax.
      8. **Final Instruction:** Output ONLY raw TypeScript code for Cypress. No markdown backticks. No intro text.`}
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

    async healSelector(
        failedSelector: string,
        description: string,
        domContext: string,
        previouslyTried: string[] = [],
        expectedUrlHint?: string,
    ): Promise<string> {
        const alreadyTriedNote = previouslyTried.length > 1
            ? `\nDo NOT use any of these selectors — they have already been tried and failed:\n${previouslyTried.map(s => `  - ${s}`).join('\n')}\n`
            : '';

        const urlHintNote = expectedUrlHint
            ? `\nNAVIGATION HINT: Clicking this element should cause the URL to change to match: ${expectedUrlHint}\nUse this to identify the correct button/link from the visible labels list — look for one whose text relates to this destination.\n`
            : '';

        const prompt = `Playwright selector "${failedSelector}" (for: "${description}") no longer matches. Find a replacement in this DOM.
${alreadyTriedNote}${urlHintNote}
IMPORTANT: The description above is an imperative test instruction, NOT the element's visible label. For example, "Click submit button to apply filters" means the element is probably labelled "Apply Filters" or "Submit" — do NOT use the full description phrase as text= content.

The DOM context below includes:
- "Current URL" — where the page is right now
- "Visible element labels" — the actual text/aria-label of each element as seen by users (USE THIS to find the right element by its label)
- "HTML snippets" — the raw HTML for fallback reference

Prefer selectors in this order (most to least resilient):
1. [data-testid="..."] or [data-cy="..."] or [data-test="..."]
2. role= with name= — use the SHORT visible label from the labels list, e.g., role=button[name="All Digg"]
3. [aria-label="..."] — use the actual label from the labels list
4. Unique visible text from the labels list: button:has-text("All Digg") or text="Trending"
5. Structural: parent > child with type (e.g., form > button[type=submit])
6. [id="..."] or [name="..."] or [type="..."] attributes

STRICT RULES — violating these will produce a broken selector:
- NEVER use utility/design-token class names. These look like: group, relative, isolate, cursor-pointer, whitespace-nowrap, inline-flex, bg-*, text-*, border-*, ring-*, focus-visible:*, disabled:*, p-*, m-*, flex-*, rounded-*, gap-*, z-*, w-*, h-* — if it looks like a Tailwind or CSS-Modules class, DO NOT USE IT.
- NEVER use a selector that contains more than 2 class names.
- NEVER use a selector truncated mid-word (ending in "-te" or similar artifacts) — that means the class string was clipped.
- If no stable attribute exists, use text content from the visible labels list, NOT classes.

DOM (interactive elements only):
${domContext}

Reply with ONLY the raw selector string, no quotes, no explanation.`;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 100,
                messages: [{ role: "user", content: prompt }]
            });

            const block = response.content.find(block => block.type === 'text');
            if (block && block.type === 'text') {
                return block.text.trim();
            }
            throw new Error("Could not extract new selector from Claude response.");
        } catch (e) {
            console.error("Failed to heal selector with Claude", e);
            throw e;
        }
    }

    async summarizeContext(rawContext: string): Promise<string> {
        const prompt = `
      You are a technical analyst. I will provide you with raw technical logs (events, console, network) from a Jam.dev recording.
      Your goal is to summarize this data into a concise technical brief for a test engineer.
      
      RULES:
      - Focus ONLY on actions that changed the UI state (clicks, typing, navigation).
      - Include ONLY critical network failures (4xx, 5xx) or important API responses.
      - Include ONLY error/warning console logs that are not background noise.
      - Keep the summary under 1000 tokens.
      - Maintain the "Typed [value] [key]" patterns as they are crucial for testing.

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
