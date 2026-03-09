# JamGherkin Capabilities & Use Cases

This project integrates [Jam.dev](https://jam.dev/) video summaries with Claude AI to automatically generate, refine, and maintain End-to-End (E2E) automated tests.

## 🚀 Core Features & Use Cases

### 1. Automated Test Generation
Pass a Jam.dev recording URL and the system writes test suites across all three formats.
- **Playwright (`*.spec.ts`)**: Complete functional tests using `aiClick`/`aiFill`/`aiPress`/`aiWaitFor`/`aiWaitForURL` self-healing wrappers.
- **Cypress (`*.cy.ts`)**: Cypress-equivalent UI tests with network intercepts and keystroke-accurate typing.
- **Gherkin (`*.feature`)**: BDD-style Given/When/Then scenarios in plain business language.

*(Use Case: A QA engineer or PM records a bug in Jam. The system instantly generates automated regressions for Playwright and Cypress, closing the gap between manual reporting and automation.)*

### 8. Jam MCP Integration (Model Context Protocol)
- **Zero-Config Context**: No more scraping video pages. JamGherkin connects directly to the [Jam MCP Server](https://mcp.jam.dev/mcp) to fetch high-fidelity technical events.
- **Automatic Domain Isolation**: By default, the tool extracts the target domain (e.g., `digg.com`) and silences common noisy hosts (like `jam.dev` analytics).
- **Surgical Network Filtering**: Use CLI flags like `--status-code 5xx` or `--content-type application/json` to prune the technical "firehose" before it reaches the AI.
- **Search & List**: Use `--list-jams` or search by title to find recordings without leaving the terminal.
- **Auto-enable**: System automatically detects Jam URLs and enables context fetching if `JAM_TOKEN` is found.

### 9. Navigation & Assertion Healing (aiWaitForURL)
- **Active Navigation Auditing**: Traditional `waitForURL` simply timeouts if a match isn't found. `aiWaitForURL` triggers a **Situation Audit** upon failure.
- **Claude "Truth" Comparison**: Claude compares the current live URL and DOM against the original recording's technical brief.
- **Intelligent Recovery**:
  - **Minor Variation**: If the URL only differs by a non-critical slug or parameter, Claude marking the step as "Success" allows the test to proceed.
  - **Missed Step**: If a navigation step was missed (e.g. a click didn't fire), Claude identifies the missing action and the system can backtrack to recover.
  - **Terminal Failure**: Only fails if there is no path forward, preventing fragile timing-related crashes.

---

## 🛠 Self-Healing Phases & Caching
UI locators break when structure or class names change. JamGherkin mitigates flaky tests by bringing an LLM into the test runtime — as a last resort, not a first call.

**Healing runs in five phases:**


**Phase 0 — Cache Hit:**
Checks `test-results/heal-cache.json` for a previously successful fix for this selector. If found, it's tried immediately, skipping all AI calls and heuristics.

**Phase 1 — Transient Retries:**
Performs 3 quick attempts with a 1s delay. This handles "blink and you miss it" UI states (loading spinners, finishing animations) where the element is technically present but not yet interactive.

**Phase 2 — Heuristic (no AI, no tokens):**
Derives 30+ selector candidates from the original selector string and the element description. Each is tried with a 300ms probe.

**Phase 3 — Ground Truth Healing (Claude-powered):**
If no heuristic works, Claude receives a compact DOM snapshot, the **Live Playwright Error**, and the original **"Ground Truth" brief** from the Jam recording.
- **Context-Aware Recovery**: Claude uses the original technical context (what the user was doing, what network calls were made) to identify the intended element in the current, potentially broken DOM.
- **Error-Awareness**: Passes specific errors (e.g., `Element is not visible`, `is not an input`) to Claude so it can avoid suggesting elements that would cause the same failure.
- **Fail-Fast Loops**: Tracks already-tried selectors to prevent AI "dead-ends."
- **Attempt Limit**: Uses up to 5 attempts to find the most resilient fix.

*(Use Case: A developer renames a CSS class or moves an element. The first test to hit it calls Claude. Every subsequent test in the same video run uses the cached fix instantly — no extra AI cost or delay.)*
- To prefer stable attributes (`data-testid`, role, aria) and never use Tailwind/CSS-Modules class names

*(Use Case: A developer renames a CSS class from `.btn-primary` to a Tailwind utility chain. The `aiClick` wrapper finds the button via `role=button[name="Sign In"]` in the heuristic phase — no API call needed.)*

### 3. Token-Efficient DOM Context
The DOM sent to Claude is aggressively trimmed:
- Only interactive elements are included: `button`, `a`, `input`, `select`, `textarea`, `[role]`, `[aria-label]`, `[data-testid]`, `[name]`, `[id]`
- Each element is a shallow snippet (no nested children markup, capped at 300 chars)
- Inline `style` attributes are stripped
- Max 150 elements — enough to find any element in practice

Typical payload: **~5k chars vs ~50k** for the full body strip approach.

### 4. Clean Gherkin Generation
Raw Jam data is full of technical noise. Before sending to Claude, the pipeline:
- **Filters out**: console errors, network CDN URLs, `net::ERR_*` failures, bare timestamps, browser/OS metadata, LogRocket/Sentry pings
- **Keeps**: visible page text, user actions, navigation events

The Gherkin prompt instructs Claude to write in business language (no tag names, no URLs, no timestamps as steps), use "I" as the actor, and write scenarios around user goals.

*(Use Case: A Jam recording of a search flow used to produce Gherkin with steps like "When the user clicks a span element at 0:04". Now it produces "When I search for 'donald trump'")*

### 5. Environment Variable Injection for Authentication
- **Dynamic Credentials**: Claude injects `process.env.TEST_EMAIL` / `Cypress.env('TEST_PASSWORD')` for any auth flows detected in the recording.
- **No Hardcoded Secrets**: Populate `.env` to run tests against any environment.

### 6. Automated Sensitive Data Redaction
- Passwords, API keys, Bearer tokens, and secrets are replaced with `***REDACTED***` before the payload reaches Claude.

### 7. Cross-Repo Integration
JamGherkin can write tests directly into another codebase and inject that repo's own test utilities into generated code — no copy-paste required.

**Configurable output directories** via CLI flags:
- `--out-playwright <dir>` — write Playwright tests to any path
- `--out-cypress <dir>` — write Cypress tests to any path
- `--out-features <dir>` — write Gherkin features to any path
- `--no-run` — skip automatically running the test after generation

**Test utility injection** via `--test-utils "<import-path>:<Export1>,<Export2>"`:
Tell Claude what helper functions already exist in the target repo. Claude will import and use them in generated tests instead of reimplementing login flows, DB setup, etc. inline.

```bash
npm run runQA -- https://jam.dev/c/abc123 \
  --out-playwright /path/to/other-repo/tests \
  --test-utils "../test-utils/auth:loginAs,logoutAs" \
  --test-utils "../test-utils/db:seedUser,clearDatabase" \
  --no-run
```

**Importable self-heal module** via npm link or git URL:
```ts
import { aiClick, aiFill } from 'jamgherkin/self-heal';
```
Install via `npm link` for local dev or `"jamgherkin": "github:your-org/jamgherkin"` as a git dependency.

*(Use Case: A team maintains `other-repo` with a shared `loginAs()` helper. Running `runQA` with `--test-utils "../helpers:loginAs"` means every generated test automatically calls `loginAs()` at the top instead of duplicating the login steps.)*

### 8. Dual AI Provider Support
Both **Claude** (`claude-service.ts`) and **Gemini** (`gemini-service.ts`) are fully supported with identical capabilities:

| Feature | Claude | Gemini |
|---|---|---|
| Playwright test generation | ✅ | ✅ |
| Cypress test generation | ✅ | ✅ |
| Gherkin BDD generation | ✅ | ✅ |
| `aiClick`/`aiFill` wrapper instructions | ✅ | ✅ |
| Auth env var injection | ✅ | ✅ |
| `--test-utils` helper injection | ✅ | ✅ |
| `domcontentloaded` guidance | ✅ | ✅ |
| Self-healing (Claude-powered) | ✅ | — |

Switch providers by changing the service instantiated in `index.ts`. Requires the corresponding API key (`ANTHROPIC_API_KEY` or `GEMINI_API_KEY`) in `.env`.

---

## 📋 Planned / TODO

### Self-Healing Improvements
- [ ] Auto-update test source files in-place when a selector is healed (persists the fix for next run)
- [x] Write healed selectors to a persistent `heal-cache.json` for reuse across runs
- [x] Harden "Try" loop to ensure AI attempts continue through intermittent API failures
- [x] Add transient retry loop for initial actions (handles loading/animations)
- [ ] Validate Claude's proposed selector against the selector priority rules before trying it

### Test Generation Improvements
- [ ] Cypress self-healing wrappers (`cyClick`, `cyFill`) analogous to Playwright ones
- [x] `--no-run` flag to skip running the generated test
- [x] `--out-playwright` / `--out-cypress` / `--out-features` flags for custom output dirs
- [x] `--test-utils` flag to inject helper imports into generated code
- [ ] `--gherkin-only` flag to skip Playwright/Cypress generation
- [ ] Batch mode: accept multiple Jam URLs in one run
- [ ] Optional step to scan existing test files and de-duplicate against newly generated ones

### Infrastructure
- [ ] GitHub Actions workflow example for running generated tests in CI
- [ ] Web dashboard to view generated tests, healing history, and selector suggestions
- [ ] Support configurable Claude model per task (e.g. Sonnet for generation, Haiku for healing)
