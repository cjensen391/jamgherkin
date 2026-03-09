# JamGherkin

Transform your [Jam.dev](https://jam.dev/) screen recordings into fully automated, self-healing test suites with the power of Claude AI!

JamGherkin acts as a bridge between your bug reports and your CI pipeline. Provide a Jam recording URL, and the system instantly analyzes the video's technical context (DOM interactions, network calls, console logs) to generate End-to-End (E2E) tests in **Playwright**, **Cypress**, and **Gherkin**.

Powered by **Claude** (default) or **Gemini** — both providers are fully supported with identical capabilities.

## Features
- 🤖 **Multi-Framework Output**: Automatically generates tests for Playwright (`.spec.ts`), Cypress (`.cy.ts`), and Gherkin (`.feature`).
- 🧠 **Dual AI Providers**: Powered by **Claude** (default) or **Gemini** — both support Gherkin, self-healing wrappers, test-utils injection, auth env vars, and clean Gherkin prompts.
- 📁 **Zero-Config Context (Jam MCP)**: Leverages the [Model Context Protocol](https://modelcontextprotocol.io/) to fetch full technical context (network, logs, events) directly from the Jam API.
- 🎯 **Automatic Domain Isolation**: Automatically detects the domain under test and filters out noisy 3rd-party traffic (`jam.dev`, analytics, etc.) by default.
- 🌡️ **Advanced Network Filtering**: Surgical control over context via CLI flags: `--status-code`, `--content-type`, `--host`, and `--limit`.
- 🛠️ **AI Self-Healing (Playwright)**: Emits custom `aiClick`, `aiFill`, `aiPress`, and `aiWaitFor` wrappers. If the DOM breaks, the system:
  1. **Ground Truth Healing**: Uses the original Jam technical brief as a reference for perfect selector recovery.
  2. **Fail-Fast Loops**: Tracks and excludes failing selectors to prevent AI "dead-ends".
  3. **Heuristic phase**: Tries 30+ candidates (data-testid, roles, etc.) before calling AI.
- 🔎 **Token-Efficient DOM Extraction**: Sends only interactive elements (buttons, inputs, links, roles, aria- and data- attributes) to Claude — typically 5k chars vs 50k for the full body.
- 🔐 **Intelligent Security**: Automatically redacts passwords, JWTs, and API keys from scraped Jam data before it reaches Claude. Auth flows inject `TEST_EMAIL` and `TEST_PASSWORD` from your `.env`.
- 📄 **Clean Gherkin**: Noise-filters console errors, CDN URLs, timestamps, and browser metadata before generation so Gherkin reads as business language, not a debug log.
- 🔗 **Cross-Repo Integration**: Generate tests directly into another codebase via `--out-*` flags. Inject that repo's test utilities (login helpers, DB seeders) into generated code via `--test-utils`. Use `jamgherkin/self-heal` as an npm dependency for self-healing in any Playwright project.


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

### 1. (Optional) List or Search Jams
JamGherkin connects to the Jam MCP server to browse your team's recordings.
```bash
# List 10 most recent jams
npm run runQA -- --list-jams

# Search for a specific Jam by title
# npm run runQA -- --search "Login Flow"
```

### 2. Generate tests from a Jam video
Copy a Jam URL and run the following:
```bash
npm run runQA -- <jam-url>
```

### All options
```
npm run runQA -- <jam-url> [options]

  - `--list-jams`: List 10 most recent Jam recordings.
  - `--status-code <pattern>`: Filter network traffic (e.g., `5xx`, `404`).
  - `--content-type <type>`: Filter by mime-type (e.g., `application/json`).
  - `--host <domain>`: Override auto-domain isolation (default: auto-detected from Jam).
  - `--limit <number>`: Cap the number of network requests fetched (default: 20).
  - `--out-playwright <dir>`: Custom directory for Playwright tests.
  --out-cypress    <dir>   Cypress output dir      (default: ./cypress/e2e)
  --out-features   <dir>   Gherkin output dir      (default: ./features)
  --test-utils     <spec>  Inject a helper module from the target codebase.
                           Format: "<import-path>:<Export1>,<Export2>"
                           Example: "../test-utils/auth:loginAs,logoutAs"
                           Repeat for multiple utility files.
  --no-run                 Skip running the generated Playwright test.
```

### Writing tests into another codebase
Point the output dirs at your other repo and tell Claude what helpers exist there:
```bash
npm run runQA -- https://jam.dev/c/abc123 \
  --out-playwright /path/to/other-repo/tests \
  --out-cypress    /path/to/other-repo/cypress/e2e \
  --out-features   /path/to/other-repo/features \
  --test-utils     "../test-utils/auth:loginAs,logoutAs" \
  --test-utils     "../test-utils/db:seedUser,clearDatabase" \
  --no-run
```
Claude will import and use those helpers instead of reimplementing them.

### Using `aiClick` / `aiFill` from another project
**Option A — `npm link` (local dev):**
```bash
cd jamgherkin && npm run build && npm link
cd ../other-repo && npm link jamgherkin
```
**Option B — git dependency:**
```json
"dependencies": { "jamgherkin": "github:your-username/jamgherkin" }
```
Then in tests:
```ts
import { aiClick, aiFill, aiPress } from 'jamgherkin/self-heal';
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

1. **Transient retry phase:** Performs 3 quick attempts with a 1s delay to handle temporary loading states or animations.
2. **Heuristic phase (free, fast):** 30+ candidates are derived from the element description — slugged `data-testid`, role selectors, aria-labels, visible text, and common semantic patterns (`input[type=email]`, `button[type=submit]`, etc.).
3. **Claude phase (5 attempts):** Claude reads a compact DOM snapshot and proposes a replacement. Results are cached in `test-results/heal-cache.json` and shared across all tests in the run to avoid redundant AI calls.
3. If healed, the new selector is logged with a `💡 TIP` to update the test suite.

## Planned / TODO
- [ ] Auto-update test source files in-place when a healed selector is found
- [x] Record healed selectors to a persistent `heal-cache.json` for reuse across runs
- [x] Record user keyboard interactions (keystrokes) directly from Jam recording data
- [ ] Support passing multiple Jam URLs in one run to batch-generate tests
- [ ] Add a `--gherkin-only` flag to skip test generation
- [ ] Cypress self-healing wrappers (`cyClick`, `cyFill`) analogous to the Playwright ones
- [ ] GitHub Actions workflow example for running generated tests in CI
- [ ] Web UI / dashboard to view generated tests and healing history
