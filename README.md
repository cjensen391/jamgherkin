# JamGherkin

Turn [Jam.dev](https://jam.dev/) screen recordings into automated E2E test suites — instantly.

JamGherkin reads a Jam recording's technical context (network calls, DOM events, console logs, video analysis) and generates **Playwright**, **Cypress**, and **Gherkin** tests powered by Claude AI. Tests include self-healing wrappers that automatically fix broken selectors at runtime.

---

## Quick Start

### 1. Install
```bash
npm install
```

### 2. Configure
```bash
cp .env.example .env
```

Add your keys to `.env`:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (required) |
| `JAM_TOKEN` | Jam.dev API token (enables MCP mode) |
| `TEST_EMAIL` / `TEST_PASSWORD` | Injected into generated auth flows |

### 3. Generate tests
```bash
# From a URL
npm run generate -- https://jam.dev/c/abc123

# Interactive menu (pick from recent recordings)
npm run generate
```

Generated files land in:
- `tests/<title>.spec.ts` — Playwright (browser E2E with self-healing)
- `cypress/e2e/<title>.cy.ts` — Cypress (browser E2E)
- `features/<title>.feature` — Gherkin (BDD spec)
- `tests-api/<title>.api.spec.ts` — API integration test (no browser, Playwright's `request` fixture)
- `cypress/fixtures/<title>/*.json` — Cypress fixture JSON files (one per mockable API response, referenced by the generated Cypress test via `cy.intercept(..., { fixture })`)

---

## All Commands

```bash
npm run generate -- [jam-url] [options]   # generate tests (no test run)
npm run runQA    -- [jam-url] [options]   # generate + run Playwright test
npm run daemon   -- [options]             # watch for new Jams every 15 min
npm run daemon   -- --backfill            # also process all existing Jams
npm run daemon   -- --interval 5          # poll every 5 min instead of 15
npm run test:unit                         # run unit tests
```

### Options

| Flag | Description |
|---|---|
| `--list-jams` | List 10 most recent recordings and exit |
| `--out-playwright <dir>` | Playwright output dir (default: `./tests`) |
| `--out-cypress <dir>` | Cypress output dir (default: `./cypress/e2e`) |
| `--out-features <dir>` | Gherkin output dir (default: `./features`) |
| `--out-api <dir>` | API integration test output dir (default: `./tests-api`) |
| `--out-fixtures <dir>` | Cypress fixture output dir (default: `./cypress/fixtures`) |
| `--test-utils <spec>` | Inject helpers from target repo (repeatable) |
| `--skip-run` | Skip running the generated test |
| `--host <domain>` | Override auto-detected domain isolation |
| `--also-host <domain>` | Include traffic from an additional host (repeatable) |
| `--status-code <pattern>` | Filter network by status code (e.g. `5xx`, `404`) |
| `--content-type <type>` | Filter network by content type |
| `--limit <n>` | Cap network requests fetched (default: 20) |
| `--scan <dir>` | Scan target-repo directory for existing `data-testid` / `aria-label` / page objects and feed them to the generator + self-healer (repeatable) |

---

## Features

### Test Generation
Generates three test files from a single recording:

- **Playwright** (`.spec.ts`) — Uses `aiClick`, `aiFill`, `aiPress`, `aiWaitFor`, `aiWaitForURL` self-healing wrappers. Strict selector rules enforced.
- **Cypress** (`.cy.ts`) — Network intercepts, keystroke-accurate typing, auth env vars.
- **Gherkin** (`.feature`) — Plain-language BDD scenarios. Typed values become `When I type "value"` steps. API calls become `Then` steps. Always outputs valid `.feature` syntax.

### Jam MCP Integration
When `JAM_TOKEN` is set, JamGherkin connects directly to the Jam API (no browser scraping):
- Fetches network requests, console logs, user events, video analysis, and transcript
- Auto-detects the recording's domain and filters out 3rd-party noise
- Interactive CLI menu to browse recent recordings

### Self-Healing Runtime
When a Playwright test fails to find an element, the healing pipeline kicks in:

1. **Cache** — Check `test-results/heal-cache.json` for a previously healed selector
2. **Retry** — 3 quick retries with 1s delay (handles loading states / animations)
3. **Heuristics** — 30+ selector candidates tried without any AI call (data-testid, role, aria, text)
4. **Claude** — Compact DOM snapshot + original Jam context sent to Claude (up to 5 attempts). Proposed selectors are validated before trying — Tailwind classes and truncated selectors are auto-rejected.
5. **Navigation audit** — For `aiWaitForURL` failures, Claude compares live state against the recording to decide whether to continue or fail

Healed selectors are written back to the test source file automatically.

### Daemon Mode
Run JamGherkin as a background service that watches for new recordings:

```bash
npm run daemon
```

- Polls Jam every 15 minutes for new recordings
- Queues new Jams and processes them one at a time
- Persists state to `daemon-state.json` (survives restarts)
- First run marks existing Jams as seen without processing (use `--backfill` to process them too)

---

## Cross-Repo Usage

Write tests directly into another codebase and inject that repo's existing helpers:

```bash
npm run generate -- https://jam.dev/c/abc123 \
  --out-playwright /path/to/other-repo/tests \
  --out-cypress    /path/to/other-repo/cypress/e2e \
  --out-features   /path/to/other-repo/features \
  --test-utils     "../test-utils/auth:loginAs,logoutAs" \
  --test-utils     "../test-utils/db:seedUser,clearDatabase"
```

Claude will import and use the specified helpers instead of reimplementing login flows inline.

### Use self-healing in any Playwright project

**Option A — npm link (local dev):**
```bash
cd jamgherkin && npm run build && npm link
cd ../other-repo && npm link jamgherkin
```

**Option B — git dependency:**
```json
"dependencies": { "jamgherkin": "github:your-org/jamgherkin" }
```

```ts
import { aiClick, aiFill, aiPress } from 'jamgherkin/self-heal';
```

---

## Integration Traffic

Include traffic from third-party services alongside the primary domain:

```bash
npm run generate -- https://jam.dev/c/abc123 \
  --also-host api.stripe.com \
  --also-host api.hellosign.com
```

Integration calls appear as business-language `Then` steps in Gherkin output.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GEMINI_API_KEY` | No | Gemini alternative |
| `JAM_TOKEN` | Recommended | Enables MCP mode (faster, higher fidelity) |
| `TEST_EMAIL` | No | Injected into auth flows |
| `TEST_PASSWORD` | No | Injected into auth flows |
| `SKIP_RUN` | No | Set to `1` to always skip test execution |
