import Anthropic from "@anthropic-ai/sdk";

export class ClaudeService {
    private anthropic: Anthropic;
    private model: string;

    constructor() {
        const apiKey = process.env.ANTHROPIC_API_KEY || "";
        this.anthropic = new Anthropic({ apiKey });
        this.model = "claude-haiku-4-5-20251001"; // Anthropic's lowest cost model available in 2026 for this key
    }

    async generateTest(context: string, framework: "playwright" | "cypress"): Promise<string> {
        const prompt = `
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
      5. IMPORTANT: Identify any significant network requests (API calls) that occur immediately after a user click or interaction. Add code to intercept/alias these network calls and wait for them to complete before proceeding to the next step (e.g., page.waitForResponse or cy.intercept/cy.wait).
      6. Output ONLY the code block for the test file.
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
}
