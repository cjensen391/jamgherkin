import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

export class GeminiService {
    private genAI: GoogleGenerativeAI;
    private model: any;

    constructor() {
        const apiKey = process.env.GEMINI_API_KEY || "";
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    }

    async generateTest(context: string, framework: "playwright" | "cypress"): Promise<string> {
        const prompt = `
      You are an expert QA engineer. Based on the following technical context from a Jam recording (console logs, network requests, user events), 
      generate a clean, maintainable ${framework} test.
      
      Technical Context:
      ${context}
      
      Instructions:
      1. Identify the core user flow or bug being demonstrated.
      2. Write a complete ${framework} test file.
      3. Use best practices (descriptive test names, proper selectors).
      4. Include comments explaining key steps.
      5. IMPORTANT: Identify any significant network requests (API calls) that occur immediately after a user click or interaction. Add code to intercept/alias these network calls and wait for them to complete before proceeding to the next step (e.g., page.waitForResponse or cy.intercept/cy.wait).
      6. Output ONLY the code block for the test file.
    `;

        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    }
}
