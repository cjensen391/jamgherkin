# JamGherkin

Transform your [Jam.dev](https://jam.dev/) screen recordings into fully automated, self-healing test suites with the power of Claude AI!

JamGherkin acts as a bridge between your bug reports and your CI pipeline. Provide a Jam recording URL, and the system instantly analyzes the video's technical context (DOM interactions, network calls, console logs) to generate End-to-End (E2E) tests in **Playwright**, **Cypress**, and **Gherkin**.

## Features
- 🤖 **Multi-Framework Output**: Automatically generates tests for Playwright (`.spec.ts`), Cypress (`.cy.js`), and Gherkin (`.feature`).
- 🛠️ **AI Self-Healing (Playwright)**: Emits custom `aiClick` and `aiFill` wrappers instead of standard locators. If the DOM structure ever changes and breaks the test, Claude steps in at runtime to read the new DOM, find the correct selector, retry the action, and print out the new valid code.
- 🔐 **Intelligent Security**: Automatically redacts passwords, JWTs, and API keys from the scraped Jam contextual data before analyzing it with Claude. Test authentications dynamically inject `TEST_EMAIL` and `TEST_PASSWORD` from your `.env`.

## Setup
### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables
Copy the `.env.example` file to `.env`:
```bash
cp .env.example .env
```
Fill out `.env` with your API keys:
- `JAM_TOKEN`: Your Jam.dev API token.
- `GEMINI_API_KEY`: API Key from google (if using gemini proxy/tool).
- `ANTHROPIC_API_KEY`: Your Claude / Anthropic API Key.
- `TEST_EMAIL` / `TEST_PASSWORD`: The test credentials you want Claude to dynamically inject for auth flows.

## Usage
Simply run the QA generation script against any Jam URL:
```bash
npm run runQA <jam-url>
```
*Example:*
```bash
npm run runQA https://jam.dev/c/28a8d5f3-11b2-1...
```

### What Happens?
1. The tool spins up a headless browser to "watch" the Jam recording and extract all logs, UI structures, and network requests.
2. Sensitive data is scrubbed locally.
3. The sanitized payload is dispatched to Claude.
4. Playwright tests are saved to the `tests/` directory.
5. Cypress tests are saved to `cypress/e2e/`.
6. Gherkin behavioral specs are saved to `features/`.
7. The generated Playwright test is automatically executed in **headed mode** so you can immediately see it running in a browser window.

## The Self-Healing Runtime
When running your newly generated Playwright tests, you don't have to fear minor UI tweaks breaking your test suite.

If a test fails (for example, waiting for `button#login` fails because the selector changed to `.btn-primary`):
1. The script automatically catches the timeout.
2. It parses the current HTML output.
3. Claude proposes `button.btn-primary`.
4. The test uses the new selector seamlessly and continues testing so your pipelines stay green!
