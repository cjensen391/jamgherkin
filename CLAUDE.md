# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JamGherkin is an AI-powered test generation tool that transforms Jam.dev screen recordings into automated E2E test suites. It generates Playwright, Cypress, and Gherkin tests with built-in self-healing capabilities powered by Claude AI.

## Essential Commands

### Development
```bash
# Generate tests from a Jam URL
npm run runQA -- <jam-url>

# Interactive mode (select from recent Jams)
npm run runQA

# List recent Jam recordings
npm run runQA -- --list-jams

# Build TypeScript to dist/
npm run build

# Run generated tests (auto-runs after generation unless --no-run)
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
--limit <number>         # Cap network requests (default: 20)

# Other
--no-run                 # Skip running generated test
--mcp-fetch              # Force MCP mode (auto-enabled if JAM_TOKEN exists)
```

## Architecture

### Core Pipeline Flow
1. **Context Extraction** (`index.ts`)
   - **MCP Mode** (preferred): Uses `JamMcpClient` to fetch technical context via Model Context Protocol
   - **Scraper Mode** (fallback): Uses Playwright to scrape Jam.dev UI
   - Auto-enables MCP if `JAM_TOKEN` is present and URL contains "jam.dev"
   - Auto-isolates network traffic to recording domain via `getJamDomain()`

2. **Data Sanitization** (`index.ts`)
   - Redacts passwords, Bearer tokens, API keys, secrets before sending to AI
   - Filters console noise, CDN URLs, timestamps, browser metadata
   - Preserves "Typed" actions for accurate input replay

3. **Test Generation** (`claude-service.ts` / `gemini-service.ts`)
   - Sends sanitized context to Claude or Gemini
   - Generates Playwright (`.spec.ts`), Cypress (`.cy.ts`), and Gherkin (`.feature`) tests
   - Injects `TEST_EMAIL` / `TEST_PASSWORD` env vars for auth flows
   - Includes `--test-utils` helpers if provided

4. **Self-Healing Runtime** (`self-heal.ts`)
   - Wraps Playwright actions: `aiClick`, `aiFill`, `aiPress`, `aiWaitFor`, `aiWaitForURL`
   - Multi-phase healing: cache → transient retry → heuristics → Claude-powered recovery
   - **Selector validation**: Validates proposed selectors against quality hierarchy before trying
   - Persists healed selectors to `test-results/heal-cache.json`
   - Auto-updates test source files with healed selectors
   - Tracks selector quality scores (0-100) and tier (1-6) for better debugging

### Key Modules

**`index.ts`**: Main entry point. Parses CLI args, orchestrates context extraction (MCP or scraper), calls AI service, writes tests, runs Playwright.

**`mcp-client.ts`**: Jam MCP client for fetching technical context. Uses JSON-RPC over HTTP with session management. Provides:
- `listJams()`: Fetch recent recordings
- `searchJams()`: Search by URL or title
- `getJamContext()`: Fetch network, console, user events
- `getJamDomain()`: Auto-detect recording domain from `getUserEvents`

**`claude-service.ts`**: Claude AI service (default). Uses `claude-haiku-4-5-20251001` for cost efficiency. Handles test generation and selector healing.

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

**`fetch-context.ts`**: Legacy context extraction utilities (if MCP client is unavailable).

**`discover.ts`**: Standalone utility to explore Jam recordings without generating tests.

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
- `ANTHROPIC_API_KEY`: Claude API key (for test generation and self-healing)
- `GEMINI_API_KEY`: Google Gemini API key (alternative AI provider)
- `JAM_TOKEN`: Jam.dev API token (for MCP mode, found in Jam dashboard)
- `TEST_EMAIL`: Test account email (injected into auth flows)
- `TEST_PASSWORD`: Test account password (injected into auth flows)

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
2. Update `index.ts` to instantiate the new service
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

## Testing

Playwright config: `playwright.config.ts`
- Test directory: `./tests`
- Timeout: 120s (allows time for self-healing)
- Action timeout: 10s

Self-healing cache stored at: `test-results/heal-cache.json`

## Recent Improvements

### Selector Validation (Phase 3 Enhancement)
- **Validation before trying**: Claude-proposed selectors are validated against quality rules before attempting to use them
- **Auto-rejection of bad patterns**: Tailwind classes and truncated selectors are rejected immediately, saving time
- **Quality feedback loop**: Validation scores and issues are passed back to Claude on retry for better proposals
- **Best selector tracking**: System tracks highest-quality selector attempt even if none work perfectly

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
