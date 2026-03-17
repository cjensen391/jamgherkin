# JamGherkin — Features & Capabilities

---

## Test Generation

JamGherkin generates three test files from a single Jam recording:

### Playwright (`*.spec.ts`)
- Uses `aiClick`, `aiFill`, `aiPress`, `aiWaitFor`, `aiWaitForURL` self-healing wrappers
- Strict selector rules: no raw `page.locator()` variables, no `nth/first/last`, no meaningless assertions
- Injects `TEST_EMAIL` / `TEST_PASSWORD` for auth flows
- Each `test()` block is self-contained with its own `page.goto()`

### Cypress (`*.cy.ts`)
- Network intercepts, keystroke-accurate typing, auth env var injection
- Equivalent coverage to Playwright output

### Gherkin (`*.feature`)
- Plain-language BDD Given/When/Then scenarios
- `Typed [value] ↵` events → `When I type "value" into <field>` steps
- POST/PUT/DELETE API calls → `Then the <resource> is saved` steps
- Integration calls (Stripe, HelloSign, etc.) → business-language `Then` steps
- Always outputs valid `.feature` syntax even on 404 or empty context

---

## Jam MCP Integration

When `JAM_TOKEN` is set, JamGherkin connects directly to the [Jam MCP Server](https://mcp.jam.dev/mcp) instead of browser scraping:

- **Zero-config context**: Fetches network requests, console logs, user events, video analysis, and transcript via structured API
- **Auto domain isolation**: Queries `getUserEvents` to find the true recording origin, silencing 3rd-party traffic automatically
- **Surgical filtering**: `--status-code`, `--content-type`, `--host`, `--limit` flags for precise context control
- **Integration traffic**: `--also-host` fetches traffic from additional domains (Stripe, HelloSign, etc.) in parallel
- **Video analysis**: `analyzeVideo` + `getVideoTranscript` fetched in parallel — visual observations and speech improve healing accuracy
- **Interactive CLI**: `npm run generate` with no arguments shows a menu to browse and select recent recordings
- **Auto-enable**: Automatically detects Jam URLs + `JAM_TOKEN` and switches to MCP mode

---

## Self-Healing Runtime

When a Playwright selector fails, healing runs through five phases before the test fails:

### Phase 0 — Cache
Checks `test-results/heal-cache.json` for a previously healed selector. If found, uses it immediately — no AI calls. Volatile selectors (React auto-IDs like `_r_b9_`, hex hashes, numeric IDs) are never cached.

### Phase 1 — Transient Retry
3 quick retries with 1s delay. Handles loading spinners and animations where the element exists but isn't yet interactive.

### Phase 2 — Heuristics (no AI)
30+ selector candidates derived from the element description:
- `data-testid`, `data-cy`, `data-test` slugs
- `role=button[name="..."]`, `role=link[name="..."]`
- `aria-label`, visible text, semantic type patterns
- **Stop-word filtering**: verbs and filler words (`wait`, `fill`, `press`, `visible`, etc.) excluded from text= candidates
- **Data-value exclusion**: words inside `has-text("...")` of the original selector treated as data, not UI labels

### Phase 3 — Claude Recovery (up to 5 attempts)
Claude receives a compact DOM snapshot + the original Jam recording context:
- **Selector validation**: each proposed selector validated before trying — Tailwind/utility classes and truncated selectors are auto-rejected
- **Quality feedback**: validation score and issues passed back to Claude on each retry
- **Error-aware**: live Playwright error message included so Claude avoids repeating bad guesses
- **Fail-fast**: already-tried selectors excluded from subsequent attempts

### Phase 4 — Navigation Audit (`aiWaitForURL`)
When a URL assertion fails, Claude compares the live URL + DOM against the Jam recording to decide:
- **Minor variation**: URL differs only by non-critical param → continue
- **Missed step**: a navigation was skipped → attempt recovery
- **Terminal failure**: no recovery path → fail with context

Healed selectors are written back to the test source file automatically so the next run is fast.

---

## Daemon Mode

Run JamGherkin as a background service:

```bash
npm run daemon                  # watch for new Jams every 15 min
npm run daemon -- --backfill    # also process all existing Jams on first run
npm run daemon -- --interval 5  # custom poll interval in minutes
```

- Polls Jam MCP every 15 minutes (configurable)
- New Jams queued and processed sequentially, oldest-first
- State persisted to `daemon-state.json` — queue and processed history survive restarts
- Failed Jams logged to `failedIds` and skipped (no infinite retry loops)
- Graceful shutdown on SIGINT/SIGTERM

---

## Cross-Repo Integration

Write tests directly into another codebase:

```bash
npm run generate -- https://jam.dev/c/abc123 \
  --out-playwright /path/to/other-repo/tests \
  --out-cypress    /path/to/other-repo/cypress/e2e \
  --out-features   /path/to/other-repo/features \
  --test-utils     "../test-utils/auth:loginAs,logoutAs" \
  --test-utils     "../test-utils/db:seedUser,clearDatabase"
```

Claude imports and uses the specified helpers instead of reimplementing them inline.

### Self-heal as a library
```bash
# npm link (local dev)
cd jamgherkin && npm run build && npm link
cd ../other-repo && npm link jamgherkin

# or git dependency
"jamgherkin": "github:your-org/jamgherkin"
```

```ts
import { aiClick, aiFill, aiPress } from 'jamgherkin/self-heal';
```

---

## Security

- Passwords, Bearer tokens, API keys, and secrets are redacted (`***REDACTED***`) before reaching Claude
- Auth flows inject `TEST_EMAIL` / `TEST_PASSWORD` from `.env` — no hardcoded credentials in generated tests

---

## Dual AI Provider Support

| Feature | Claude | Gemini |
|---|---|---|
| Playwright test generation | ✅ | ✅ |
| Cypress test generation | ✅ | ✅ |
| Gherkin BDD generation | ✅ | ✅ |
| Auth env var injection | ✅ | ✅ |
| `--test-utils` injection | ✅ | ✅ |
| Self-healing runtime | ✅ | — |

---

## TODO

### Self-Healing
- [x] Persistent `heal-cache.json` — reuse healed selectors across runs
- [x] Transient retry loop
- [x] `aiWaitForURL` navigation audit
- [x] Error-aware healing (pass Playwright errors to Claude)
- [x] Auto-update test source files when a selector is healed
- [x] Selector validation before attempting Claude proposals
- [x] Volatile selector detection — never cache React auto-IDs or hex hashes
- [x] Stop-word filtering in heuristic phase
- [x] Data-value exclusion from heuristic candidates
- [ ] Cypress self-healing wrappers (`cyClick`, `cyFill`)

### Test Generation
- [x] `--skip-run` / `SKIP_RUN` flag
- [x] `--out-*` flags for custom output directories
- [x] `--test-utils` flag for helper injection
- [x] Interactive CLI menu
- [x] Video analysis + transcript in context
- [ ] `--gherkin-only` flag
- [ ] Batch mode (multiple URLs in one run)
- [ ] De-duplicate against existing test files

### Infrastructure
- [x] Daemon mode with queue and persistent state
- [x] Unit test suite (`npm run test:unit`)
- [ ] GitHub Actions workflow example
- [ ] Web dashboard for test history and healing logs
