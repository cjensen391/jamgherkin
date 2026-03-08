# JamGherkin

Transform your [Jam.dev](https://jam.dev/) screen recordings into fully automated, self-healing test suites with the power of Claude AI!

JamGherkin acts as a bridge between your bug reports and your CI pipeline. Provide a Jam recording URL, and the system instantly analyzes the video's technical context (DOM interactions, network calls, console logs) to generate End-to-End (E2E) tests in **Playwright**, **Cypress**, and **Gherkin**.

## Features
- 🤖 **Multi-Framework Output**: Automatically generates tests for Playwright (`.spec.ts`), Cypress (`.cy.ts`), and Gherkin (`.feature`).
- 🛠️ **AI Self-Healing (Playwright)**: Emits custom `aiClick` and `aiFill` wrappers instead of standard locators. If the DOM structure changes and breaks the test, the system:
  1. Tries **30+ heuristic selector candidates** (data-testid, role, aria-label, text, type patterns) with no AI cost.
  2. Falls back to **Claude** (up to 3 attempts) if heuristics fail, passing previously-tried selectors so it never repeats a guess.
- 🔎 **Token-Efficient DOM Extraction**: Sends only interactive elements (buttons, inputs, links, roles, aria- and data- attributes) to Claude — typically 5k chars vs 50k for the full body.
- 🔐 **Intelligent Security**: Automatically redacts passwords, JWTs, and API keys from scraped Jam data before it reaches Claude. Auth flows inject `TEST_EMAIL` and `TEST_PASSWORD` from your `.env`.
- 📄 **Clean Gherkin**: Noise-filters console errors, CDN URLs, timestamps, and browser metadata before generation so Gherkin reads as business language, not a debug log.

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
- `ANTHROPIC_API_KEY`: Your Claude / Anthropic API Key.
- `TEST_EMAIL` / `TEST_PASSWORD`: Test credentials injected into generated auth flows.

## Usage
Run the QA generation script against any Jam URL:
```bash
npm run runQA <jam-url>
```
*Example:*
```bash
npm run runQA https://jam.dev/c/28a8d5f3-11b2-1...
```

### What Happens?
1. A headless browser visits the Jam recording and extracts DOM interactions, network requests, and logs.
2. Sensitive data is scrubbed locally. Noise (console errors, CDN URLs, timestamps) is filtered out.
3. The sanitized payload is sent to Claude to generate tests.
4. Playwright tests → `tests/`
5. Cypress tests → `cypress/e2e/`
6. Gherkin specs → `features/`
7. The generated Playwright test runs automatically (headed).

## The Self-Healing Runtime
When running Playwright tests, if a selector breaks:

1. **Heuristic phase (free, fast):** 30+ candidates are derived from the element description — slugged `data-testid`, role selectors, aria-labels, visible text, and common semantic patterns (`input[type=email]`, `button[type=submit]`, etc.). Each is tried with a 300ms probe timeout.
2. **Claude phase (3 attempts):** Claude reads a compact DOM snapshot (interactive elements only) and proposes a replacement, being told which selectors already failed so it doesn't repeat them.
3. If healed, the new selector is logged with a `💡 TIP` to update the test suite.

## Planned / TODO
- [ ] Auto-update test source files in-place when a healed selector is found
- [ ] Record healed selectors to a `heal-log.json` for audit and review
- [ ] Support passing multiple Jam URLs in one run to batch-generate tests
- [ ] Add a `--gherkin-only` flag to skip test generation
- [ ] Cypress self-healing wrappers (`cyClick`, `cyFill`) analogous to the Playwright ones
- [ ] Cache DOM snapshots between heal attempts to avoid re-evaluating on the same page state
- [ ] GitHub Actions workflow example for running generated tests in CI
- [ ] Web UI / dashboard to view generated tests and healing history
