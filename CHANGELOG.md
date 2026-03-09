# JamGherkin Changelog

All notable changes to this project are documented here.

---

## [Current] — 2026-03-09

### ✨ New Features

#### Persistent Selector Caching
- Added `test-results/heal-cache.json` — healed selectors are now saved and shared across all tests in the same video run (and future runs).
- **Phase 0 Cache Check**: Every interaction now checks the cache first, skipping AI calls and heuristics for previously fixed selectors.

#### Hardened "Try" Loop (Self-Healing)
- Increased `MAX_HEAL_ATTEMPTS` from 3 → 5 for Claude-powered healing.
- Wrapped Claude generation and execution in a `try/catch` block to ensure a single API failure doesn't terminate the healing process.
- Added **Transient Action Retries**: Performs a 3-attempt "quick retry" (with 1s delay) for individual actions to handle temporary UI states before triggering full self-healing.

#### Reliable Submissions with `aiPress`
- Restored the `aiPress` helper function to `src/self-heal.ts`.
- Updated Claude and Gemini prompts to use `aiPress` for all keyboard interactions (e.g., 'Enter' for search).
- Keyboard submissions are now fully covered by the self-healing and caching pipeline.

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
