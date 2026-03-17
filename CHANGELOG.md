# JamGherkin Changelog

---

## [Current] — 2026-03-11

### Daemon Mode
- New `npm run daemon` command — polls Jam MCP every 15 minutes for new recordings and processes them sequentially
- `--backfill` flag: process all existing Jams on first run (default: mark as seen, only process new ones going forward)
- `--interval <minutes>` flag: override the 15-minute poll interval
- State persisted to `daemon-state.json` — queue and processed/failed history survive restarts
- Failed Jams moved to `failedIds` and skipped (no infinite retry loops)
- Graceful shutdown on SIGINT/SIGTERM: saves state before exiting
- New Jams queued oldest-first (FIFO) and processed one at a time

### Code Architecture
- Extracted `src/process-jam.ts`: shared `processJam()` function used by both `index.ts` and `daemon.ts`
- `src/index.ts` refactored to call `processJam()` — no behavior change
- `src/daemon.ts` core functions exported with injectable dependencies for testability
- `main()` in `daemon.ts` guarded with `import.meta.url` check — importing the module in tests does not auto-execute

### Unit Tests
- New `unit-tests/daemon.test.ts` — 30 tests across 6 suites using Node's built-in `node:test` runner (no new dependencies)
- Covers: `loadState`, `saveState`, `parseArgs`, `pollForNewJams`, `processQueue`, `tick`
- Tests use temp files for state isolation; all pass
- New `npm run test:unit` script

---

## [Previous] — 2026-03-10

### Video Analysis Integration
- `getJamContext()` now calls `analyzeVideo` and `getVideoTranscript` in parallel (best-effort; silently skipped if unavailable)
- Visual observations and speech transcripts appended to recording brief under `--- VIDEO ANALYSIS ---` / `--- VIDEO TRANSCRIPT ---` sections
- `summarizeContext()` prompt updated to extract ground-truth UI labels from video analysis — improves healing accuracy

### Self-Healing Hardening

#### Volatile Selector Detection
- `isVolatileSelector()`: React auto-generated IDs (`_r_b9_`), long hex hashes, and numeric IDs detected as volatile
- `saveToCache()` and `updateTestSourceFile()` both skip volatile selectors with a warning

#### Heuristic Selector Improvements
- **Data-value word filtering**: words inside `has-text("Value")` treated as data values and excluded from text= candidates
- **Expanded stop words**: `wait`, `type`, `fill`, `press`, `become`, `visible`, `appear`, `show`, `when`, `then`, etc. excluded from text= candidates

#### Selector Validation (Phase 3 Enhancement)
- Claude-proposed selectors validated against quality rules before being attempted
- Auto-rejects Tailwind/utility classes and truncated selectors immediately
- Validation score and issues passed back to Claude on retry (quality feedback loop)
- Highest-scoring attempt tracked even if none succeed

### Prompt Quality Improvements
- Banned: `locator.nth()`, `locator.first()`, `locator.last()`, `locator.tripleClick()`
- Banned: `const x = page.locator(...)` variable pattern
- Banned: `locator.isVisible()`, `locator.count()`
- Banned: meaningless assertions (`toBeTruthy` on page/locator)
- Banned: negative URL lookahead regex in `aiWaitForURL`
- Removed: redundant `expect.soft(page).toHaveURL()` when `aiWaitForURL` already covers the same URL
- Gherkin: always outputs valid `.feature` syntax, even on 404 or empty context
- `healSelector` response parsing: strips markdown fences + prose-extraction fallback for multi-line responses

---

## [Previous] — 2026-03-09

### Jam MCP Integration
- Replaced custom scraping with direct connection to [Jam MCP Server](https://mcp.jam.dev/mcp)
- **Interactive CLI Menu**: `npm run generate` with no arguments shows a menu to browse and select recent Jams
- **Zero-Config Context**: network, logs, and user events fetched via structured API
- **Accurate Domain Isolation**: `getUserEvents` queried first to detect the true recording origin
- **Advanced Network Filtering**: `--status-code`, `--content-type`, `--host`, `--limit` CLI flags
- `--list-jams` flag to browse recent recordings from the terminal

### Navigation Healing (`aiWaitForURL`)
- Active situation audit on URL mismatch — Claude compares live URL + DOM against recording
- Minor URL variation → continue; missed step → recover; no path forward → fail
- Markdown stripping added to audit response parsing to prevent JSON parse errors

### Self-Healing Improvements
- **Error-aware healing**: live Playwright error messages passed to Claude during recovery
- **`aiWaitFor`**: self-healing wait steps for elements
- **`optional` flag**: allows `aiClick`, `aiFill`, etc. to skip non-essential UI gracefully
- **Locator support**: all `ai*` actions accept both string selectors and Playwright `Locator` objects
- **Ground truth reference**: original Jam technical brief embedded in tests for accurate selector recovery
- **Fail-fast loops**: already-tried selectors excluded from subsequent Claude attempts

---

## [Previous] — 2026-03-08

### Cross-Repo Integration
- `--out-playwright`, `--out-cypress`, `--out-features` CLI flags for writing tests into another repo
- `--test-utils "<path>:<Export1>,<Export2>"` flag (repeatable) — Claude injects target repo helpers as imports
- `--skip-run` flag (also `SKIP_RUN=1` env var) to skip auto-running the Playwright test
- `exports` field in `package.json` + `npm run build` so `jamgherkin/self-heal` works as an npm dependency

### Self-Healing — Heuristic Phase
- `generateCandidateSelectors()`: 30+ candidates from the original selector and element description
- Strategies: `data-testid`/`data-cy` slugs, `role=` + `name=`, `aria-label`, visible text, semantic type patterns
- Action verb stripping from descriptions before generating text= candidates
- Each candidate probed with 300ms timeout

### Self-Healing — Claude Retry Loop
- Claude retried up to 3 attempts (configurable)
- Previously-tried selectors passed back each retry — no repeated guesses
- Explicit Tailwind/CSS class ban in healing prompt

### Gemini Service Parity
- `GeminiService.generateTest()` matches Claude feature-for-feature: Gherkin, `aiClick`/`aiFill` instructions, auth env vars, `--test-utils` injection

### DOM Extraction
- Replaced full-body clone with focused extraction of interactive/semantic elements only
- Each element capped at 300 chars, max 150 elements — reduces payload from ~50k to ~5k chars

### Bug Fixes
- Fixed double-escape in tab content concatenation
- Fixed `Target page, context or browser has been closed` from heuristic probe timeout exhausting test budget
- Fixed Claude returning Tailwind class-soup selectors
- Fixed Claude using full description phrases as `text=` content
