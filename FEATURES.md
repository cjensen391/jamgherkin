# JamGherkin Capabilities & Use Cases

This project integrates [Jam.dev](https://jam.dev/) video summaries with Claude AI to automatically generate, refine, and maintain End-to-End (E2E) automated tests.

## 🚀 Core Features & Use Cases

### 1. Automated Test Generation
By simply passing a URL of a recorded Jam.dev bug or feature walkthrough, the system automatically writes test suites.
- **Playwright Test Generation (`*.spec.ts`)**: Generates complete, functional Playwright tests based on the extracted DOM interactions, network requests, and visible console logs.
- **Cypress Test Generation (`*.cy.js`)**: Generates Cypress-equivalent UI tests.
- **Gherkin Feature Generation (`*.feature`)**: Writes BDD-style Given/When/Then scenarios describing the flow.

*(Use Case: A manual QA engineer or product manager records a bug in Jam. The system instantly generates automated regressions for Playwright and Cypress, closing the gap between manual reporting and automation.)*

### 2. AI-Powered Self-Healing Tests (Playwright)
UI locators often break when structure or classes change. This project mitigates flaky tests by bringing the LLM into the runtime.
- **`aiClick` & `aiFill` Wrappers**: Custom Playwright commands that wrap standard locator interactions.
- **Dynamic Fallback / Healing**: If an element times out after 5 seconds, the wrapper captures the current page DOM structure and prompts Claude to dynamically analyze the HTML and find the *new* valid selector.
- **Immediate Retries**: The newly generated selector is immediately applied to the test runtime to salvage the execution, and a tip is logged so the developer can update the original script.

*(Use Case: A developer refactors the login page, changing a button from `<button id="submit">` to `<button class="btn-primary">`. The existing `aiClick` test catches the failure, self-heals by analyzing the new DOM structure, passing the test runtime, and outputs the necessary code fix.)*

### 3. Environment Variable Injection for Authentication
When tests involve logging in, hardcoded credentials are a security risk and limit portability.
- **Dynamic Environment Variables**: Claude is prompted to automatically use `process.env.TEST_EMAIL` and `Cypress.env('TEST_PASSWORD')` for any login actions detected in the Jam recording.
- **Seamless Local Testing**: By populating `.env`, developers can instantly run the generated tests against their local environment without manually fixing the generated credentials.

*(Use Case: Creating an automated test for a checkout flow that requires an initial login step. The generated code cleanly utilizes environment properties for the auth layer.)*

### 4. Automated Sensitive Data Redaction
Data security is automatically managed when scraping Jam.dev data and passing the context context to the Claude API.
- **Pre-Prompt Sanitization**: A middleware step regex-searches the scraped HTML and logs before sending it to the LLM.
- **Targeted Obfuscation**: Passwords, API Keys, Bearer tokens, and System Secrets are rewritten as `***REDACTED***`.

*(Use Case: An engineer accidentally leaves a real API key visible in the network tab inside the Jam video. The scraper extracts it, but the redaction filter successfully blocks it from ever being dispatched to Anthropic's endpoints.)*
