import { GoogleGenerativeAI } from "@google/generative-ai";
import type { TestUtil } from "./claude-service.js";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY || "";
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  }

  async generateTest(
    context: string,
    framework: "playwright" | "cypress" | "gherkin",
    testUtils: TestUtil[] = [],
  ): Promise<string> {
    // Build an optional block telling Gemini what helper functions exist in the target repo
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
      3. Write multiple granular Scenarios using Given/When/Then. Each scenario should cover a distinct part of the flow (e.g. "Searching for a topic", "Navigating filters").
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
         - **MANDATORY INDEPENDENCE**: Each test block MUST be self-contained and independent. **EVERY \`test()\` block MUST start with its own \`page.goto()\`** (or \`cy.visit()\`) and perform all necessary setup. Do NOT assume state from previous tests.
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
      const result = await this.model.generateContent(prompt);
      let text = result.response.text().trim();
      text = text.replace(/^```[a-zA-Z0-9-]*\n/i, "");
      text = text.replace(/\n```$/i, "");
      return text.trim();
    } catch (e) {
      console.error("Failed to generate with Gemini", e);
      throw e;
    }
  }
}
