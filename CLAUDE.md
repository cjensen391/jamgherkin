# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JamGherkin is an AI-powered test generation tool that transforms Jam.dev screen recordings into automated E2E test suites. It generates Playwright, Cypress, and Gherkin tests with built-in self-healing capabilities powered by Claude AI.

## Essential Commands

### Development
```bash
# Generate tests only (no test run) — preferred for CI / cross-repo use
npm run generate -- <jam-url>

# Generate tests AND immediately run them
npm run runQA -- <jam-url>

# Interactive mode (select from recent Jams)
npm run generate

# List recent Jam recordings
npm run generate -- --list-jams

# Run as a background daemon (polls Jam MCP every 15 min for new recordings)
npm run daemon
npm run daemon -- --backfill        # also process all existing Jams on first run
npm run daemon -- --interval 5      # poll every 5 minutes instead of 15

# Standalone MCP exploration (lists tools/resources from the Jam MCP server)
npm run discover

# Unit tests (Node's built-in node:test runner — no extra deps)
npm run test:unit

# Build TypeScript to dist/
npm run build

# Run generated tests manually
npx playwright test tests/<test-name>.spec.ts --headed
```

### Common CLI Options
```bash
# Cross-repo test generation
--out-playwright <dir>   # Custom output directory for Playwright tests
--out-cypress <dir>      # Custom output directory for Cypress tests
--out-features <dir>     # Custom output directory for Gherkin features
--test-utils "<import-path>:<export1>,<export2>"  # Inject helper functions from target repo

# Network filtering (MCP mode)
--status-code <pattern>  # Filter by status code (e.g., "5xx", "404")
--content-type <type>    # Filter by content type (e.g., "application/json")
--host <domain>          # Override auto-detected domain isolation
--also-host <domain>     # Include traffic from an additional host (repeatable)
                         # e.g. --also-host api.stripe.com --also-host api.hellosign.com
--limit <number>         # Cap network requests (default: 20)

# Other
--skip-run               # Skip running generated test (or: SKIP_RUN=1 env var)
--mcp-fetch              # Force MCP mode (auto-enabled if JAM_TOKEN exists)
# Tip: use `npm run generate` instead of `npm run runQA` to always skip running
```

## Architecture

### Core Pipeline Flow
The pipeline is implemented as a single shared function `processJam()` in `src/process-jam.ts`. Both `src/index.ts` (CLI) and `src/daemon.ts` (background watcher) call into it.

1. **Context Extraction** (`process-jam.ts`)
   - **MCP Mode** (preferred): Uses `JamMcpClient` to fetch technical context via Model Context Protocol
   - **Scraper Mode** (fallback): Uses Playwright to scrape Jam.dev UI
   - Auto-enables MCP if `JAM_TOKEN` is present and URL contains "jam.dev"
   - Auto-isolates network traffic to recording domain via `getJamDomain()`

2. **Data Sanitization** (`process-jam.ts`, scraper path only — MCP context comes pre-cleaned)
   - Redacts passwords, Bearer tokens, API keys, secrets before sending to AI
   - Filters console noise, CDN URLs, timestamps, browser metadata
   - Preserves "Typed" actions for accurate input replay

3. **Summarization** (`claude-service.ts`)
   - If extracted context exceeds 15,000 chars, `summarizeContext()` compresses it via Claude Haiku before generation

4. **Test Generation** (`claude-service.ts` / `gemini-service.ts`)
   - Sends sanitized context to Claude or Gemini
   - Generates Playwright (`.spec.ts`), Cypress (`.cy.ts`), and Gherkin (`.feature`) tests
   - Injects `TEST_EMAIL` / `TEST_PASSWORD` env vars for auth flows
   - Includes `--test-utils` helpers if provided

5. **Self-Healing Runtime** (`self-heal.ts`)
   - Wraps Playwright actions: `aiClick`, `aiFill`, `aiPress`, `aiWaitFor`, `aiWaitForURL`
   - Multi-phase healing: cache → transient retry → heuristics → Claude-powered recovery
   - **Selector validation**: Validates proposed selectors against quality hierarchy before trying
   - Persists healed selectors to `test-results/heal-cache.json`
   - Auto-updates test source files with healed selectors
   - Tracks selector quality scores (0-100) and tier (1-6) for better debugging

### Key Modules

**`index.ts`**: CLI entry point. Parses CLI args, handles the interactive Jam picker, and delegates work to `processJam()`. No pipeline logic lives here — keep it that way.

**`process-jam.ts`**: Shared pipeline. Exports `processJam(jamUrl, opts)` and the `ProcessJamOptions` interface. Owns context extraction (MCP or scraper), sanitization, summarization, and writing the three test files. Both `index.ts` and `daemon.ts` call into this.

**`daemon.ts`**: Background watcher. Polls Jam MCP on an interval, queues new recordings, and processes them via `processJam()`. Core functions (`loadState`, `saveState`, `parseArgs`, `pollForNewJams`, `processQueue`, `tick`) are exported with injectable dependencies for unit testing. `main()` is guarded by an `import.meta.url` check so importing the module in tests does not auto-execute.

**`mcp-client.ts`**: Jam MCP client for fetching technical context. Uses JSON-RPC over HTTP with session management. Provides:
- `listJams()`: Fetch recent recordings
- `searchJams()`: Search by URL or title
- `getJamContext()`: Fetch network, console, user events, video analysis, transcript. Supports `alsoHosts` for parallel integration traffic fetching (Stripe, HelloSign, etc.)
- `getJamDomain()`: Auto-detect recording domain from `getUserEvents`

**`claude-service.ts`**: Claude AI service (default). Uses `claude-haiku-4-5-20251001` for cost efficiency. Handles test generation, context summarization, and selector healing.

**`gemini-service.ts`**: Gemini AI service alternative (identical capabilities to Claude for test generation, no self-healing support).

**`self-heal.ts`**: Playwright self-healing wrappers. Healing phases:
1. **Phase 0 (Cache)**: Check `heal-cache.json` for previously healed selector
2. **Phase 1 (Transient Retry)**: 3 quick retries with 1s delay
3. **Phase 2 (Heuristics)**: 30+ selector candidates derived from description (data-testid, role, aria, text)
4. **Phase 3 (Claude Recovery)**: Pass compact DOM snapshot + Jam recording context to Claude (max 5 attempts)
   - **Selector Validation**: Each Claude-proposed selector is validated against quality rules before trying
   - **Auto-rejection**: Selectors with Tailwind classes or truncation are rejected immediately
   - **Quality Scoring**: Tracks scores (0-100) and tier (1-6) for each attempt
5. **Phase 4 (Navigation Audit)**: For `aiWaitForURL` failures, Claude audits current state vs. expected to decide if test can continue

**`fetch-context.ts`**: Legacy/standalone helper that calls the Jam MCP `get_jam` tool directly. Not used by the main pipeline — kept as a reference for raw MCP shape.

**`discover.ts`**: Standalone utility to list MCP tools and resources from the Jam server. Useful when adding new MCP calls.

**`generate-final.ts`**: Standalone smoke test that generates Playwright + Cypress tests from a hard-coded context using `GeminiService`. Not part of the main pipeline — handy for quickly validating Gemini output without a real Jam fetch.

### Daemon State

- `daemon-state.json` (in repo root, gitignored via `.gitignore` patterns) stores `processedIds`, `failedIds`, `queue`, and `lastPollAt`.
- Failed Jams are moved to `failedIds` and are **not** retried — there is no infinite retry loop.
- New Jams are queued **oldest-first** (the MCP API returns newest-first; `tick()` reverses it).
- State is saved after every queue item completes, so a crash mid-batch loses at most one in-flight item.
- On first run with no `lastPollAt`, the daemon marks existing Jams as seen and waits for new ones — pass `--backfill` to also process the existing backlog.

### Important Patterns

**Recording Context Injection**: Generated Playwright tests include:
```typescript
import { setRecordingContext } from '../src/self-heal.js';
setRecordingContext(`<jam-context>`);
```
This provides ground truth for healing.

**Test Independence**: Generated tests MUST be independent. Each `test()` block starts with its own `page.goto()`.

**Selector Quality Hierarchy** (enforced by AI prompt and validation):
1. **Tier 1** (score: 100): `data-testid`, `data-cy`, `data-test`
2. **Tier 2** (score: 95): `role="button"[name="..."]`, `role="link"[name="..."]`
3. **Tier 3** (score: 85): `aria-label="..."`
4. **Tier 4** (score: 75): `button:has-text("...")`, `a:has-text("...")`, `text="..."`
5. **Tier 5** (score: 70): `input[type="..."]`, `input[placeholder="..."]`
6. **Tier 6** (score: 60): Structural selectors (no classes)

**Selector Validation** (`validateSelector()` in `self-heal.ts`):
- Scores selectors 0-100 based on tier and penalties
- **Auto-rejects** (score < 40 with critical issues):
  - Tailwind/utility classes: `bg-*`, `text-*`, `flex-*`, `p-*`, `m-*`, `cursor-*`, `group`, `relative`, etc.
  - Truncated selectors (incomplete attribute names)
  - More than 2 CSS classes
- **Penalties**: CSS classes (-20 to -50), class attribute selectors (-25), bare tags (-40)
- Validation runs before trying Claude-proposed selectors

**NO CSS classes allowed** in generated tests or healing to prevent fragility.

## Environment Variables

Required in `.env` (see `.env.example`):
- `ANTHROPIC_API_KEY`: Claude API key (required for test generation and self-healing). Note: this is NOT in `.env.example` today — add it manually.
- `GEMINI_API_KEY`: Google Gemini API key (alternative AI provider)
- `JAM_TOKEN`: Jam.dev API token (for MCP mode, found in Jam dashboard)
- `TEST_EMAIL`: Test account email (injected into auth flows)
- `TEST_PASSWORD`: Test account password (injected into auth flows)
- `SKIP_RUN`: Set to `1` or `true` to always skip the post-generation Playwright run (equivalent to `--skip-run`)

## Cross-Repo Integration

JamGherkin can write tests directly into another codebase and inject existing test utilities:

```bash
npm run runQA -- https://jam.dev/c/abc123 \
  --out-playwright /path/to/other-repo/tests \
  --out-cypress /path/to/other-repo/cypress/e2e \
  --out-features /path/to/other-repo/features \
  --test-utils "../test-utils/auth:loginAs,logoutAs" \
  --test-utils "../test-utils/db:seedUser,clearDatabase" \
  --no-run
```

The AI will import and use the specified helpers instead of reimplementing them.

## Self-Healing as a Library

Other projects can use JamGherkin's self-healing wrappers:

```bash
# Option A: npm link (local dev)
cd jamgherkin && npm run build && npm link
cd ../other-repo && npm link jamgherkin

# Option B: git dependency
# Add to package.json: "jamgherkin": "github:your-org/jamgherkin"
```

Then in tests:
```typescript
import { aiClick, aiFill, aiPress } from 'jamgherkin/self-heal';
```

## Common Development Tasks

### Adding New AI Providers
1. Create `src/<provider>-service.ts` implementing `generateTest()` and `summarizeContext()`
2. Update `process-jam.ts` to instantiate the new service (not `index.ts` — that only does CLI parsing)
3. Add API key to `.env.example` and `CLAUDE.md`

### Modifying Healing Logic
- **Cache logic**: `loadCache()` / `saveToCache()` in `self-heal.ts`
- **Heuristic phase**: `generateCandidateSelectors()` in `self-heal.ts`
- **Selector validation**: `validateSelector()` in `self-heal.ts` - validates quality and returns score/tier/issues
- **Claude phase**: `aiHealAction()` in `self-heal.ts` with validation integration
- **Source updates**: `updateTestSourceFile()` in `self-heal.ts`

### Changing Test Generation Prompts
Edit the prompt strings in `claude-service.ts` or `gemini-service.ts` `generateTest()` method. Key sections:
- Selector quality rules
- Framework-specific guidance (Playwright vs Cypress vs Gherkin)
- Test structure requirements (independence, test.step usage)

### Adjusting Network Filtering
MCP filtering happens in `mcp-client.ts` `getJamContext()`. Filters applied:
- Domain isolation (via `--host` or auto-detected)
- Status code pattern matching (`--status-code`)
- Content type filtering (`--content-type`)
- Request limit (`--limit`)

### Modifying the Daemon
- All daemon helpers (`loadState`, `saveState`, `parseArgs`, `pollForNewJams`, `processQueue`, `tick`) are exported with **injectable dependencies** (state file path, MCP client, process function). When changing behavior, write the test against the exported function with mocks rather than spawning a real daemon.
- `main()` is intentionally not exported and is guarded by `import.meta.url === fileURLToPath(process.argv[1])` so importing the module from tests does not start a polling loop.
- State file path defaults to `DEFAULT_STATE_FILE` (`<cwd>/daemon-state.json`); pass an alternate path in tests to keep them isolated.

## Testing

### Unit tests (`npm run test:unit`)
- Runner: Node's built-in `node:test` (`node --import tsx/esm --test 'unit-tests/**/*.test.ts'`) — no additional test framework dependency.
- Location: `unit-tests/*.test.ts` (separate from generated Playwright tests in `./tests`).
- Current coverage: `unit-tests/daemon.test.ts` exercises all daemon helpers across 6 suites using temp state files for isolation.
- Pattern when adding new tests: import from the `.js` extension (e.g. `from "../src/daemon.js"`) — required by the project's `nodenext` module resolution even though source is `.ts`.

### Playwright (generated tests)
- Config: `playwright.config.ts`
- Test directory: `./tests`
- Timeout: 120s (allows time for self-healing)
- Action timeout: 10s
- Self-healing cache stored at: `test-results/heal-cache.json`

## Supplemental Docs

- `README.md` — user-facing quick start and CLI reference (mirror this when changing CLI flags)
- `FEATURES.md` — capability matrix and TODO checklist (update when shipping new features)
- `CHANGELOG.md` — dated release notes (append a new dated section when making notable changes)

When adding a feature, update **all three** alongside this file — they're independently consumed and drift quickly.

## Recent Improvements

### Daemon Mode (latest)
- New `npm run daemon` command — polls Jam MCP every 15 minutes (configurable via `--interval`) and processes new recordings sequentially
- `--backfill` flag: process all existing Jams on first run (default: mark them as seen)
- State persisted to `daemon-state.json` so the queue survives restarts
- Failed Jams move to `failedIds` and are skipped on subsequent ticks (no infinite retry loops)
- Graceful SIGINT/SIGTERM shutdown saves state before exit
- Pipeline extracted to `src/process-jam.ts` and shared between `index.ts` and `daemon.ts`
- Daemon helpers exported with injectable dependencies; `main()` guarded by `import.meta.url` so tests can import safely

### Unit Test Suite
- New `npm run test:unit` script using Node's built-in `node:test` runner (no new dependencies)
- `unit-tests/daemon.test.ts` — 30 tests across 6 suites (`loadState`, `saveState`, `parseArgs`, `pollForNewJams`, `processQueue`, `tick`)
- Tests use temp state files for isolation

### Video Analysis Integration
- `getJamContext()` now calls `analyzeVideo` and `getVideoTranscript` in parallel (best-effort, errors silently ignored)
- Visual observations and speech transcripts appended to recording brief under `--- VIDEO ANALYSIS ---` / `--- VIDEO TRANSCRIPT ---`
- `summarizeContext()` prompt updated to extract ground-truth UI labels from the VIDEO ANALYSIS section

### Volatile Selector Detection
- `isVolatileSelector()` detects React auto-IDs (`_r_b9_`), long hex hashes, and pure-numeric IDs
- `saveToCache()` and `updateTestSourceFile()` both skip volatile selectors with a warning

### Heuristic Selector Improvements
- **Stop words**: `wait`, `type`, `fill`, `press`, `become`, `visible`, `appear`, `show`, `when`, `then`, etc. excluded from text= candidates
- **Data-value exclusion**: words inside original selector's `has-text("…")` are treated as data values, not UI labels, and excluded from candidates

### Selector Validation (Phase 3 Enhancement)
- **Validation before trying**: Claude-proposed selectors are validated against quality rules before attempting to use them
- **Auto-rejection of bad patterns**: Tailwind classes and truncated selectors are rejected immediately, saving time
- **Quality feedback loop**: Validation scores and issues are passed back to Claude on retry for better proposals
- **Best selector tracking**: System tracks highest-quality selector attempt even if none work perfectly

### Prompt Quality Hardening
- Banned `locator.nth/first/last/tripleClick`, raw `page.locator()` variable pattern, `locator.isVisible/count`
- Banned meaningless assertions (`toBeTruthy` on page/locator), negative URL lookaheads
- Removed redundant `expect.soft(page).toHaveURL()` after `aiWaitForURL` for same URL
- Gherkin prompt mandates valid `.feature` output even on 404 / empty context
- `healSelector` response parsing: strips markdown fences + prose-extraction fallback for multi-line responses

### Optimized Healing Prompts
- **50% token reduction**: Healing prompts compressed from ~450 to ~200 words while maintaining clarity
- **Faster responses**: More concise prompts = lower latency and cost
- **Stricter constraints**: BANNED section clearly lists auto-reject patterns up front
- **Better structured**: Priority list uses numbered format for faster parsing

## Key Design Decisions

1. **MCP over Scraping**: Direct API access via MCP provides higher-fidelity data and is faster than UI scraping.

2. **Multi-Phase Healing**: Heuristics (free, fast) before AI (expensive, slower) minimizes costs. Cache avoids redundant healing.

3. **Ground Truth Context**: Embedding original Jam context in tests enables Claude to "remember" what the test intended to do, improving healing accuracy.

4. **Test Independence**: Each test is self-contained to prevent cascading failures and enable parallel execution.

5. **Selector Quality Enforcement**: Strict selector hierarchy prevents fragile CSS-class-based selectors from being generated.

6. **Automatic Source Updates**: When healing occurs, the test source file is automatically updated to prevent repeated healing on subsequent runs.
