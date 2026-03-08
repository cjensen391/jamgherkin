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
        this.model = "claude-haiku-4-5-20251001"; // Anthropic's lowest cost model available in 2026 for this key
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
      - IGNORE all browser console errors, warnings, and stack traces (e.g. ResizeObserver, TypeError, 404s, network failures) UNLESS they are the specific bug being reported.
      - IGNORE raw network URLs, CDN paths, query parameters, and HTTP status codes. These are implementation details, not user behaviour.
      - IGNORE timestamps (e.g. "at 0:03"), browser/OS version strings, and window dimensions.
      - IGNORE third-party monitoring noise (LogRocket, Sentry, analytics pings, ad requests).
      - DO NOT use technical selectors, tag names, or DOM element types as step descriptions (not "clicks a span", say "clicks the All Feed tab").
      - Steps must be written in plain business language that a non-technical stakeholder can read and understand.
      - Use "I" as the actor, not "the user" or "the system".
      - Only include a Background section if there is a meaningful shared precondition across scenarios.
      - Write scenarios around user goals, not sequences of low-level clicks.

      Jam Context:
      ${context}

      Instructions:
      1. Identify the core user flow OR bug being demonstrated (ignore noise from the list above).
      2. Write a complete Gherkin Feature with a clear, goal-oriented title.
      3. Write one or more Scenarios using Given/When/Then. Each step must describe what/why, not how.
      4. If a bug is present, write a dedicated Scenario named "Bug: <short description>" that describes the expected vs actual behaviour.
      5. Output ONLY the raw text for the .feature file. No markdown. No backticks.
    ` : `
      You are an expert QA engineer.
      I will provide you with the technical context extracted from a Jam.dev video recording (console logs, network requests, DOM events).
      Based on this context, your task is to write an end-to-end automated test using the ${framework} framework.

      Jam Context:
      ${context}
      ${testUtilsNote}
      Instructions:
      1. Identify the core user flow or bug being demonstrated.
      2. Write a complete ${framework} test file using TypeScript.
      3. Use best practices (descriptive test names, proper selectors).
      4. Include comments explaining key steps.
      5. If the flow involves logging in or authentication, use environment variables for credentials:
         - Playwright: Use \`process.env.TEST_EMAIL\` and \`process.env.TEST_PASSWORD\`
         - Cypress: Use \`Cypress.env('TEST_EMAIL')\` and \`Cypress.env('TEST_PASSWORD')\`
         ${testUtils.length > 0 ? '- If a login utility is available above, use it instead of implementing the login steps manually.' : ''}
      ${framework === 'playwright' ? `6. VERY IMPORTANT: Instead of standard await page.locator(...).click() or fill(), you MUST use the self-healing wrappers aiClick and aiFill.
         - Import them: import { aiClick, aiFill } from "../src/self-heal.js";
         - Use them: await aiClick(page, "button.submit", "Submit the login form");
                     await aiFill(page, "input#email", process.env.TEST_EMAIL ?? "", "Fill the email field");
         - NEVER use \`networkidle\` for Playwright's \`waitForLoadState\` or \`waitForNavigation\`. Use \`domcontentloaded\` instead.`
            : `6. IMPORTANT: Identify significant network requests after user interactions. Add code to intercept/alias these calls and wait for them (e.g. page.waitForResponse or cy.intercept/cy.wait).`}
      7. Output ONLY the raw TypeScript code, DO NOT INCLUDE markdown formatting backticks (\`\`\`) at the beginning or end of the output.
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
    ): Promise<string> {
        const alreadyTriedNote = previouslyTried.length > 1
            ? `\nDo NOT use any of these selectors — they have already been tried and failed:\n${previouslyTried.map(s => `  - ${s}`).join('\n')}\n`
            : '';

        const prompt = `Playwright selector "${failedSelector}" (for: "${description}") no longer matches. Find a replacement in this DOM.
${alreadyTriedNote}
IMPORTANT: The description above is an imperative test instruction, NOT the element's visible label. For example, "Click submit button to apply filters" means the element is probably labelled "Apply Filters" or "Submit" — do NOT use the full description phrase as text= content.

Prefer selectors in this order (most to least resilient):
1. [data-testid="..."] or [data-cy="..."] or [data-test="..."]
2. role= with name= — use the SHORT visible label, e.g., role=button[name="Apply Filters"]
3. [aria-label="..."] — use the actual label, not the description sentence
4. Unique visible text: text="Apply Filters" or button:has-text("Submit")
5. Structural: parent > child with type (e.g., form > button[type=submit])
6. [id="..."] or [name="..."] or [type="..."] attributes

STRICT RULES — violating these will produce a broken selector:
- NEVER use utility/design-token class names. These look like: group, relative, isolate, cursor-pointer, whitespace-nowrap, inline-flex, bg-*, text-*, border-*, ring-*, focus-visible:*, disabled:*, p-*, m-*, flex-*, rounded-*, gap-*, z-*, w-*, h-* — if it looks like a Tailwind or CSS-Modules class, DO NOT USE IT.
- NEVER use a selector that contains more than 2 class names.
- NEVER use a selector truncated mid-word (ending in "-te" or similar artifacts) — that means the class string was clipped.
- If no stable attribute exists, use text content or structural CSS (tag + type attribute), NOT classes.

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
}
