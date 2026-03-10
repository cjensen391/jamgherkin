# JamGherkin Changelog

All notable changes to this project are documented here.

---

## [Current] — 2026-03-10

### 🎥 Video Analysis Integration
- **`analyzeVideo` + `getVideoTranscript`**: `getJamContext()` now calls these Jam MCP tools in parallel alongside events/logs/network (best-effort; silently skipped if unavailable).
- **UI label extraction**: `summarizeContext()` prompt updated to extract ground-truth UI labels from the `VIDEO ANALYSIS` section — improves healing accuracy when text selectors are needed.
- Video context appended to the recording brief with labelled sections (`--- VIDEO ANALYSIS ---`, `--- VIDEO TRANSCRIPT ---`) and size reported in console logs.

### 🛡️ Self-Healing Hardening

#### Volatile Selector Detection
- Added `isVolatileSelector()` guard: React auto-generated IDs (`_r_b9_`), long hex hashes (`#abc12345`), and pure-numeric IDs are now detected as volatile.
- `saveToCache()` skips volatile selectors with a warning — prevents broken cache entries across React re-renders.
- `updateTestSourceFile()` skips volatile selectors with a warning — prevents updating source with selectors that will break on next render.

#### Heuristic Selector Improvements
- **Data-value word filtering**: Words inside `has-text("Value")` of the original selector are treated as data values, not UI labels. They are excluded from `text=` / `has-text()` healing candidates to prevent selectors like `a:has-text("1 Infinite")` (a property name, not a nav label).
- **Expanded stop words**: Added `wait`, `waiting`, `type`, `typing`, `press`, `pressing`, `fill`, `filling`, `become`, `visible`, `appear`, `appears`, `loaded`, `show`, `shows`, `reveal`, `if`, `when`, `then`, `that`, `which`, `where`, `how`, `any` — prevents nonsense candidates like `a:has-text("Wait")` from "Wait for search input" descriptions.

#### Selector Validation (Phase 3 Enhancement)
- Claude-proposed selectors are now validated against quality rules **before** being attempted.
- **Auto-rejection**: Tailwind/utility classes and truncated selectors are rejected immediately, saving network round-trips.
- **Quality feedback loop**: Validation score and issues are passed back to Claude on retry so proposals improve each round.
- **Best selector tracking**: Highest-scoring attempt is tracked even if none succeed, for debugging.

### 🧪 Prompt Quality Improvements

#### False Positive Elimination
- Banned `locator.nth()`, `locator.first()`, `locator.last()`, `locator.tripleClick()` from generated tests — these raw Playwright APIs bypass healing wrappers.
- Banned `const x = page.locator(...)` variable pattern — selectors must be inline string literals for healing to work.
- Banned `locator.isVisible()`, `locator.count()` — raw Playwright queries that bypass self-healing.
- Banned meaningless assertions: `expect.soft(page).toBeTruthy()`, `expect.soft(locator).toBeTruthy()`.
- Banned negative URL lookahead regex in `aiWaitForURL` (e.g., `/(?!rental-applications\/new)/`).
- Removed redundant `expect.soft(page).toHaveURL()` guidance when `aiWaitForURL` is already called for the same URL.

#### Gherkin Reliability
- Gherkin prompt now mandates valid `.feature` output regardless of context quality — prevents markdown prose or error messages being written to `.feature` files when recordings return 404 or empty data.
- Added placeholder `Feature`/`Scenario` fallback instruction for edge cases.

#### healSelector Prompt Hardening
- Added explicit `CORRECT` / `WRONG` example pairs to eliminate prose-style responses.
- Added markdown fence stripping (`\`\`\`...`) to `healSelector()` response parsing.
- Added prose-extraction fallback: if response is multi-line, finds the first line that looks like a selector (starts with `[`, `#`, `role=`, `button`, `input`, `a[`, etc.).
- Added volatile IDs (React `_r_*`, long hex hashes) to BANNED list in healing prompt.

---

## [Previous] — 2026-03-09

#### Jam MCP Integration (Model Context Protocol) 📁
- Replaced custom scraping with a direct connection to the [Jam MCP Server](https://mcp.jam.dev/mcp).
- **Interactive CLI Menu**: `npm run runQA` with no arguments now launches an interactive terminal prompt to fetch and select recent Jams.
- **Zero-Config Context**: High-fidelity events (network, logs, user actions) now fetched via structured API instead of DOM scraping.
- **Accurate Domain Isolation**: Added logic to explicitly fetch `getUserEvents` via MCP to find the true origin URL, correctly isolating the network to the recorded domain.
- **Advanced Network Filtering**: New CLI flags (`--status-code`, `--content-type`, `--host`, `--limit`) for surgical context pruning.
- Added `--list-jams` to browse recent team recordings from the terminal.

#### Universal Healing & Ground Truth 🛠️
- **aiWaitForURL & Situation Audit**: Replaced passive waiting with an active audit. If a URL doesn't match, Claude analyzes the live DOM vs. the recording to decide whether to continue, retry a missed step, or fail.
  - *Fix*: Added automatic markdown stripping during Situation Audits to prevent `Unexpected token` JSON parse errors when Claude wraps responses in code blocks.
- **Error-Aware Healing**: Playwright error messages (e.g., "Element is not an input") are now passed to Claude during healing to prevent repetitive invalid suggestions.
- **aiWaitFor**: Introduced self-healing wait steps for elements to prevent test crashes on simple timeouts.
- **Optional Actions**: Added an `optional` flag to `aiClick`, `aiFill`, etc., allowing tests to bypass non-essential UI (like cookie banners) gracefully.
- **Locator Support**: All `ai*` actions now support passing both string selectors and Playwright `Locator` objects.
- **Ground Truth Reference**: Self-healing now uses the original Jam technical brief as a reference for 100% accurate selector recovery.
- **Fail-Fast Loops**: tracks and excludes already-tried selectors to prevent AI "dead-ends" during recovery.
- **Generation Hardening**: Updated AI prompts with a strict **Selector Rule**: forcing string literals and forbidding `page.locator()` variables to ensure 100% healing coverage.

### ✨ Previous Changes — 2026-03-08

#### Cross-Repo Integration
- Added `--out-playwright`, `--out-cypress`, `--out-features` CLI flags to write generated tests directly into another codebase
- Added `--test-utils "<import-path>:<Export1>,<Export2>"` flag (repeatable) — Claude and Gemini inject the target repo's helper functions as imports in generated tests
- Added `--no-run` flag to skip auto-running the Playwright test after generation
- Added `exports` field to `package.json` and `npm run build` script so `jamgherkin/self-heal` can be consumed as an npm dependency via `npm link` or git URL

#### AI Self-Healing — Phase 1: Heuristic Selector Pass
- Introduced `generateCandidateSelectors()` — derives 30+ selector candidates from the original selector and element description before calling any AI
- Candidate strategies: `data-testid`/`data-cy`/`data-test` slugs, Playwright `role=` + `name=`, `aria-label`, visible text, semantic type patterns (`input[type=email]`, `button[type=submit]`, etc.)
- Action verb stripping: descriptions like "Click submit button" → tries `button:has-text("submit")` not `text="Click submit button"`
- Each heuristic probed with a 300ms timeout — fast enough to sweep all candidates within a few seconds

#### AI Self-Healing — Phase 2: Claude Retry Loop
- Healing now retries Claude up to 3 times (configurable via `MAX_HEAL_ATTEMPTS`)
- Previously-tried selectors passed back to Claude on each retry so it never repeats a guess
- Claude prompt hardened with strict rules: no Tailwind/CSS-Modules class names, no selectors with >2 classes, no truncated class strings

#### Gemini Service Parity
- `GeminiService.generateTest()` now matches `ClaudeService` feature-for-feature:
  - Gherkin generation with noise-filtering rules
  - `aiClick`/`aiFill` wrapper instructions for Playwright
  - Auth env var injection (`TEST_EMAIL`, `TEST_PASSWORD`)
  - `--test-utils` injection support
  - `domcontentloaded` over `networkidle` guidance

### 🔧 Improvements

#### Smarter DOM Extraction for Healing
- Replaced full-body DOM clone with a focused extraction of only interactive/semantic elements (`button`, `a`, `input`, `select`, `textarea`, `[role]`, `[aria-label]`, `[data-testid]`, `[id]`, `[name]`)
- Each element capped at 300 chars, max 150 elements — reduces payload from ~50k to ~5k chars

#### Cleaner Gherkin Prompts
- Pre-filters scraped context before sending to Claude: removes console errors, CDN URLs, `net::ERR_*` failures, bare timestamps, browser/OS metadata, LogRocket/Sentry pings
- Prompt instructs Claude to write in business language (no tag names, no URLs as steps, "I" as actor)

#### Better Claude Selector Prompts
- Descriptions are now flagged as imperative instructions ("Click submit button") not element labels — Claude uses inferred short visible label for `role=` and `text=` selectors
- Explicit Tailwind class name ban with named examples (`bg-*`, `text-*`, `ring-*`, `focus-visible:*`, `disabled:*`, etc.)

#### Playwright Test Timeout
- Increased from 30s → 120s in `playwright.config.ts` to give the self-healing pipeline (heuristic sweep + Claude calls) enough budget to run

### 🐛 Bug Fixes
- Fixed double-escape bug in tab content concatenation (`\\n` → `\n` in template literal)
- Fixed `Target page, context or browser has been closed` error caused by heuristic probe timeout (1500ms → 300ms) exhausting test budget before DOM evaluation could run
- Fixed Claude returning Tailwind class-soup selectors by adding explicit class-name ban to prompt
- Fixed Claude using full description phrases as `text=` content (e.g. `text="Click submit button to apply filters"`) by stripping leading action verbs before generating candidates

### 📄 Documentation
- Updated `README.md`: new CLI flags, cross-repo usage guide, npm link / git URL pattern
- Updated `FEATURES.md`: full feature descriptions for all 7 capabilities, Planned/TODO checklist (3 items marked done)
- Created `CHANGELOG.md` (this file)
