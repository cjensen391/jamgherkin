# JamGherkin Capabilities & Use Cases

This project integrates [Jam.dev](https://jam.dev/) video summaries with Claude AI to automatically generate, refine, and maintain End-to-End (E2E) automated tests.

## 🚀 Core Features & Use Cases

### 1. Automated Test Generation
Pass a Jam.dev recording URL and the system writes test suites across all three formats.
- **Playwright (`*.spec.ts`)**: Complete functional tests using `aiClick`/`aiFill` self-healing wrappers.
- **Cypress (`*.cy.ts`)**: Cypress-equivalent UI tests with network intercepts for async flows.
- **Gherkin (`*.feature`)**: BDD-style Given/When/Then scenarios in plain business language.

*(Use Case: A QA engineer or PM records a bug in Jam. The system instantly generates automated regressions for Playwright and Cypress, closing the gap between manual reporting and automation.)*

### 2. AI-Powered Self-Healing Tests (Playwright)
UI locators break when structure or class names change. JamGherkin mitigates flaky tests by bringing an LLM into the test runtime — as a last resort, not a first call.

**Healing runs in two phases:**

**Phase 1 — Heuristic (no AI, no tokens):**
Derives 30+ selector candidates from the original selector string and the element description:
- `data-testid`, `data-cy`, `data-test` slug variations
- Playwright `role=` selectors with `name=` (using the element's inferred label, not the full instruction)
- `aria-label`, `aria-labelledby`
- Visible text (`text=`, `:has-text()`) — stripped of leading action verbs so "Click submit button" → tries `button:has-text("submit")`
- Semantic shortcuts: `input[type=email]`, `input[type=password]`, `button[type=submit]`, `[role=searchbox]`, etc.
- ID, name, and type attributes extracted from the original selector

Each candidate is tried with a 300ms probe — fast enough never to blow the test timeout.

**Phase 2 — Claude (up to 3 attempts):**
If no heuristic works, Claude receives a compact DOM snapshot (interactive elements only, ~5k chars) and is told:
- Which selectors already failed (so it doesn't repeat them)
- That descriptions are imperative instructions, not element labels
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

---

## 📋 Planned / TODO

### Self-Healing Improvements
- [ ] Auto-update test source files in-place when a selector is healed (persists the fix for next run)
- [ ] Write healed selectors to a `heal-log.json` for team review and audit
- [ ] Cache DOM snapshots between heal attempts (avoid re-evaluating on the same page state)
- [ ] Increase selector diversity by querying visible text from page at heal time
- [ ] Validate Claude's proposed selector against the selector priority rules before trying it

### Test Generation Improvements
- [ ] Cypress self-healing wrappers (`cyClick`, `cyFill`) analogous to Playwright ones
- [ ] Support `--gherkin-only` flag to skip Playwright/Cypress generation
- [ ] Batch mode: accept multiple Jam URLs in one run
- [ ] Optional step to scan existing test files and de-duplicate against newly generated ones

### Infrastructure
- [ ] GitHub Actions workflow example for running generated tests in CI
- [ ] Web dashboard to view generated tests, healing history, and selector suggestions
- [ ] Support configurable Claude model per task (e.g. Sonnet for generation, Haiku for healing)
