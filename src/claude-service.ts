import Anthropic from "@anthropic-ai/sdk";

export class ClaudeService {
    private anthropic: Anthropic;
    private model: string;

    constructor() {
        const apiKey = process.env.ANTHROPIC_API_KEY || "";
        this.anthropic = new Anthropic({ apiKey });
        this.model = "claude-haiku-4-5-20251001"; // Anthropic's lowest cost model available in 2026 for this key
    }

    async generateTest(context: string, framework: "playwright" | "cypress" | "gherkin"): Promise<string> {
        const prompt = framework === "gherkin" ? `
      You are an expert QA engineer and product manager.
      I will provide you with the technical context extracted from a Jam.dev video recording (console logs, network requests, DOM events).
      Based on this context, your task is to write a Gherkin feature file that describes the behavior or bug being demonstrated.

      Jam Context:
      ${context}

      Instructions:
      1. Identify the core user flow or bug being demonstrated.
      2. Write a complete Gherkin Feature and Scenario(s).
      3. Use descriptive Given/When/Then steps.
      4. Output ONLY the raw text for the .feature file.
    ` : `
      You are an expert QA engineer. 
      I will provide you with the technical context extracted from a Jam.dev video recording (console logs, network requests, DOM events).
      Based on this context, your task is to write an end-to-end automated test using the ${framework} framework.

      Jam Context:
      ${context}

      Instructions:
      1. Identify the core user flow or bug being demonstrated.
      2. Write a complete ${framework} test file.
      3. Use best practices (descriptive test names, proper selectors).
      4. Include comments explaining key steps.
      5. If the flow involves logging in or authentication, use environment variables for credentials:
         - Playwright: Use \`process.env.TEST_EMAIL\` and \`process.env.TEST_PASSWORD\`
         - Cypress: Use \`Cypress.env('TEST_EMAIL')\` and \`Cypress.env('TEST_PASSWORD')\`
         - Gherkin: Use literal placeholders like \`<TEST_EMAIL>\` or write steps like "Given I am logged in as a test user".
      ${framework === 'playwright' ? `6. VERY IMPORTANT: Instead of standard await page.locator(...).click() or fill(), you MUST use the self-healing wrappers aiClick and aiFill. 
         - Import them: import { aiClick, aiFill } from "../src/self-heal.js";
         - Use them: await aiClick(page, "button.submit", "Submit the login form");
                                await aiFill(page, "input#email", process.env.TEST_EMAIL ?? "", "Fill the email field");` : `6. IMPORTANT: Identify any significant network requests (API calls) that occur immediately after a user click or interaction. Add code to intercept/alias these network calls and wait for them to complete before proceeding to the next step (e.g., page.waitForResponse or cy.intercept/cy.wait).`}
      7. Output ONLY the code block for the test file.
    `;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model,
                max_tokens: 4000,
                messages: [{ role: "user", content: prompt }]
            });

            // Anthropic specifically returns text in the block content
            const block = response.content.find(block => block.type === 'text');
            if (block && block.type === 'text') {
                let text = block.text;
                if (text.startsWith("\`\`\`")) {
                    const firstNewline = text.indexOf("\\n");
                    if (firstNewline !== -1) text = text.substring(firstNewline + 1);
                }
                if (text.endsWith("\`\`\`")) text = text.substring(0, text.length - 3);

                return text.trim();
            }
            return "Error: Could not extract text from Claude response.";
        } catch (e) {
            console.error("Failed to generate with Claude", e);
            throw e;
        }
    }

    async healSelector(failedSelector: string, description: string, domContext: string): Promise<string> {
        const prompt = `
      You are an expert QA engineer and Playwright specialist.
      A Playwright test failed to find an element using the selector: "${failedSelector}".
      The target element is described as: "${description}".

      Here is the current HTML DOM context from the page where the failure occurred:
      ${domContext}

      Your task is to analyze the DOM and provide a new, highly resilient and accurate Playwright locator string (e.g., text="Submit" or div.login-wrapper > button.primary) that successfully identifies the target element.
      
      Output ONLY the raw selector string. Do not include quotes around it unless they are part of the selector syntax itself. Do not include any formatting or explanation.
    `;

        try {
            const response = await this.anthropic.messages.create({
                model: this.model, // We still use the lowest cost model here for speed
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
