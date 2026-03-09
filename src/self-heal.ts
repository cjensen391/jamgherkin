import type { Page, Locator } from 'playwright';
import { ClaudeService } from './claude-service.js';
import * as fs from 'fs';
import * as path from 'path';

const claude = new ClaudeService();

const MAX_HEAL_ATTEMPTS = 5;
const ACTION_RETRY_COUNT = 3;
const ACTION_RETRY_DELAY = 1000;
const CACHE_PATH = path.join('test-results', 'heal-cache.json');

/**
 * Loads the persistent selector cache from disk.
 */
function loadCache(): Record<string, string> {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            const data = fs.readFileSync(CACHE_PATH, 'utf-8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.warn(`⚠️ Failed to load heal cache: ${e}`);
    }
    return {};
}

/**
 * Saves a healed selector to the persistent cache.
 */
function saveToCache(originalSelector: string, healedSelector: string) {
    try {
        const cache = loadCache();
        cache[originalSelector] = healedSelector;
        const dir = path.dirname(CACHE_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (e) {
        console.warn(`⚠️ Failed to save to heal cache: ${e}`);
    }
}

/**
 * Attempts to automatically update the test source file with the new selector.
 */
function updateTestSourceFile(originalSelector: string, healedSelector: string) {
    try {
        const stack = new Error().stack;
        if (!stack) return;

        let callerFile = '';
        let callerLineNum = -1;

        const lines = stack.split('\n');
        for (const line of lines) {
            if (line.includes('self-heal.') || line.includes('self-heal:')) continue;

            let fileVal = '';
            let lineVal = '';

            const parenMatch = line.match(/\(([^)]+):(\d+):(\d+)\)/);
            if (parenMatch) {
                fileVal = parenMatch[1] || '';
                lineVal = parenMatch[2] || '';
            } else {
                const atMatch = line.match(/at (.*):(\d+):(\d+)/);
                if (atMatch) {
                    fileVal = atMatch[1] || '';
                    lineVal = atMatch[2] || '';
                }
            }

            if (fileVal) {
                if (fileVal.startsWith('file://')) fileVal = fileVal.substring(7);
                callerFile = fileVal.trim();

                if (callerFile.startsWith('node:') || callerFile.includes('node_modules')) continue;
                if (callerFile.endsWith('.ts') || callerFile.endsWith('.js')) {
                    callerLineNum = parseInt(lineVal, 10);
                    break;
                }
            }
        }

        if (!callerFile || !fs.existsSync(callerFile)) return;

        const content = fs.readFileSync(callerFile, 'utf-8');
        const fileLines = content.split('\n');
        const lineIdx = callerLineNum - 1;

        let updated = false;

        // Try exact line update
        if (lineIdx >= 0 && lineIdx < fileLines.length) {
            const originalLine = fileLines[lineIdx];
            if (originalLine && originalLine.includes(originalSelector)) {
                fileLines[lineIdx] = originalLine.replace(originalSelector, healedSelector);
                if (fileLines[lineIdx] !== originalLine) {
                    fs.writeFileSync(callerFile, fileLines.join('\n'), 'utf-8');
                    updated = true;
                }
            }
        }

        // Fallback global update
        if (!updated && content.includes(originalSelector)) {
            const newContent = content.split(originalSelector).join(healedSelector);
            if (newContent !== content) {
                fs.writeFileSync(callerFile, newContent, 'utf-8');
                updated = true;
            }
        }

        if (updated) {
            console.log(`\n📝 [Self-Heal] Auto-updated source file: ${callerFile}:${callerLineNum > 0 ? callerLineNum : ''}`);
        }
    } catch (e) {
        console.warn(`⚠️ Failed to auto-update source file: ${e}`);
    }
}

/**
 * Generates a ranked list of heuristic selector candidates from the original
 * selector string and the human description. These are tried cheaply (no AI)
 * before falling back to Claude, saving tokens and time.
 */
function generateCandidateSelectors(originalSelector: string, description: string): string[] {
    const candidates: string[] = [];

    // ── Helpers ──────────────────────────────────────────────────────────────

    // Slug-ify a phrase for use in data-* attributes (e.g. "Submit Form" → "submit-form")
    const toSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    // Strip parenthetical qualifiers before processing — e.g. "Click navigation element (attempt 1)" → "Click navigation element"
    const cleanedDesc = description.replace(/\s*\([^)]*\)/g, '').trim();

    // Key words from the description (stop-words + generic UI words removed), used to build guesses
    const STOP = new Set([
        'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'it', 'with', 'at', 'by',
        // Generic UI words that match too broadly as text= candidates
        'element', 'button', 'link', 'navigation', 'menu', 'item', 'icon', 'field', 'input', 'area',
        // Ordinal/positional words — these describe which element, not what it says
        'first', 'second', 'third', 'last', 'next', 'previous', 'prev',
        // App/route terms that appear often in button text but are too broad to target a specific element
        'feed', 'sort', 'filter', 'tab', 'view', 'click', 'open', 'close', 'toggle',
        // Action/assertion words from test descriptions — not visible element labels
        'search', 'submit', 'select', 'navigate', 'load', 'verify', 'check', 'confirm',
        'initial', 'current', 'main', 'primary', 'secondary', 'additional', 'another',
    ]);
    const descWords = cleanedDesc
        .split(/\s+/)
        .map(w => w.replace(/[^\w]/g, ''))
        .filter(w => w.length > 1 && !STOP.has(w.toLowerCase()));

    // Descriptions are often imperative instructions ("Click submit button to apply filters").
    // Strip the leading action verb to get a better element-label for text= and role= matching.
    const ACTION_VERB_RE = /^(click(s)?|tap(s)?|press(es)?|fill(s)?|type(s)?|enter(s)?|select(s)?|choose(s)?|submit(s)?|check(s)?|toggle(s)?|open(s)?|close(s)?|navigate(s)?|scroll(s)?|hover(s)?|focus(es)?|clear(s)?|hit(s)?|pick(s)?)\s+/i;
    const elementLabel = cleanedDesc.replace(ACTION_VERB_RE, '').trim();
    const labelWords = elementLabel
        .split(/\s+/)
        .map(w => w.replace(/[^\w]/g, ''))
        .filter(w => w.length > 1 && !STOP.has(w.toLowerCase()));

    const descSlug = toSlug(cleanedDesc);
    const descTitle = cleanedDesc;

    // ── 1. data-testid / data-cy / data-test variants ────────────────────────
    // Try the full description as a slug
    if (descSlug) {
        candidates.push(`[data-testid="${descSlug}"]`);
        candidates.push(`[data-cy="${descSlug}"]`);
        candidates.push(`[data-test="${descSlug}"]`);
        candidates.push(`[data-test-id="${descSlug}"]`);
    }
    // Try key words from the description individually
    for (const word of descWords.slice(0, 3)) {
        const slug = toSlug(word);
        if (slug !== descSlug) {
            candidates.push(`[data-testid="${slug}"]`);
            candidates.push(`[data-cy="${slug}"]`);
        }
    }

    // ── 2. Derive from the original selector ─────────────────────────────────
    // Extract #id from CSS selectors (e.g. "button#submit-btn" → "#submit-btn")
    const idMatch = originalSelector.match(/#([\w-]+)/);
    if (idMatch) {
        const id = idMatch[1];
        candidates.push(`#${id}`);                          // bare ID
        candidates.push(`[id="${id}"]`);                    // attribute form
        candidates.push(`input#${id}`);
        candidates.push(`button#${id}`);
    }

    // Extract [name="..."] from the original selector
    const nameMatch = originalSelector.match(/\[name=["']?([\w-]+)["']?\]/);
    if (nameMatch) {
        candidates.push(`[name="${nameMatch[1]}"]`);
        candidates.push(`input[name="${nameMatch[1]}"]`);
    }

    // Extract [type="..."] hints
    const typeMatch = originalSelector.match(/\[type=["']?([\w-]+)["']?\]/) ||
        originalSelector.match(/input\.([\w-]*(?:text|email|password|search|submit|button)[\w-]*)/i);
    if (typeMatch) {
        candidates.push(`input[type="${typeMatch[1]}"]`);
    }

    // If the original selector referenced a tag, try it with aria hints
    const tagMatch = originalSelector.match(/^([a-zA-Z]+)/);
    if (tagMatch && tagMatch[1]) {
        const tag = tagMatch[1].toLowerCase();
        for (const word of descWords.slice(0, 2)) {
            candidates.push(`${tag}[aria-label="${word}"]`);
            candidates.push(`${tag}[title="${word}"]`);
        }
    }

    // ── 3. Playwright role-based selectors ───────────────────────────────────
    // Use the stripped element label (not the full imperative description) for name= matching
    const roleNames = [elementLabel, descTitle].filter((v, i, a) => a.indexOf(v) === i); // dedupe
    for (const label of roleNames) {
        candidates.push(`role=button[name="${label}"]`);
        candidates.push(`role=link[name="${label}"]`);
        candidates.push(`role=tab[name="${label}"]`);
        candidates.push(`role=menuitem[name="${label}"]`);
    }
    candidates.push(`role=textbox[name="${elementLabel}"]`);
    candidates.push(`role=checkbox[name="${elementLabel}"]`);
    candidates.push(`role=combobox[name="${elementLabel}"]`);

    // ── 4. aria-label ─────────────────────────────────────────────────────────
    candidates.push(`[aria-label="${elementLabel}"]`);
    if (elementLabel !== descTitle) candidates.push(`[aria-label="${descTitle}"]`);
    for (const word of labelWords.slice(0, 3)) {
        candidates.push(`[aria-label="${word}"]`);
    }

    // ── 5. Visible text selectors — use stripped label, not the full instruction ──
    candidates.push(`text="${elementLabel}"`);
    if (elementLabel !== descTitle) candidates.push(`text="${descTitle}"`);
    for (const word of labelWords.slice(0, 3)) {
        candidates.push(`text="${word}"`);
        candidates.push(`button:has-text("${word}")`);
        candidates.push(`a:has-text("${word}")`);
    }

    // ── 6. Common submit / action button patterns ─────────────────────────────
    if (/submit|save|confirm|ok|yes|continue|next|send|apply/i.test(description)) {
        candidates.push('button[type="submit"]');
        candidates.push('input[type="submit"]');
        candidates.push('[role="button"][type="submit"]');
    }
    if (/cancel|close|dismiss|no|back/i.test(description)) {
        candidates.push('button[type="button"]');
        candidates.push('[aria-label="Close"]');
        candidates.push('[aria-label="Cancel"]');
    }
    if (/search/i.test(description)) {
        candidates.push('input[type="search"]');
        candidates.push('[role="searchbox"]');
        candidates.push('input[placeholder*="search" i]');
    }
    if (/email/i.test(description)) {
        candidates.push('input[type="email"]');
        candidates.push('input[name="email"]');
        candidates.push('input[autocomplete="email"]');
    }
    if (/password/i.test(description)) {
        candidates.push('input[type="password"]');
        candidates.push('input[name="password"]');
    }
    if (/username|user.?name/i.test(description)) {
        candidates.push('input[name="username"]');
        candidates.push('input[autocomplete="username"]');
        candidates.push('input[type="text"][name*="user"]');
    }

    // Deduplicate while preserving order, and exclude the original
    const seen = new Set<string>();
    return candidates.filter(s => {
        if (seen.has(s) || s === originalSelector) return false;
        seen.add(s);
        return true;
    });
}

/** Try a single selector quickly; returns true if it matched and the action succeeded. */
async function trySelector(
    page: Page,
    selector: string,
    action: (locator: Locator) => Promise<void>,
    timeout: number = 300,
): Promise<boolean> {
    try {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'attached', timeout });
        await action(loc);
        return true;
    } catch {
        return false;
    }
}

let activeRecordingContext: string | undefined = undefined;

/**
 * Injects the Jam recording's technical brief to be used as ground truth for healing.
 */
export function setRecordingContext(brief: string) {
    activeRecordingContext = brief;
}

export async function aiHealAction(
    page: Page,
    originalSelector: string | Locator,
    description: string,
    action: (locator: Locator) => Promise<void>,
    options?: { expectedUrlHint?: string; optional?: boolean },
) {
    const { expectedUrlHint, optional } = options || {};
    const selectorStr = typeof originalSelector === 'string' ? originalSelector : originalSelector.toString();

    // ── Phase 0: Cache Check ─────────────────────────────────────────────────
    const cache = loadCache();
    if (cache[selectorStr]) {
        const cachedSelector = cache[selectorStr];
        console.log(`⚡ Cache hit! Trying previously healed selector for '${selectorStr}': '${cachedSelector}'`);
        const matched = await trySelector(page, cachedSelector, action, 2000);
        if (matched) {
            console.log(`✅ Success using cached healed selector.`);
            return;
        }
        console.warn(`⚠️ Cached selector '${cachedSelector}' no longer works. Proceeding with regular healing.`);
        delete cache[selectorStr]; // Remove stale cache entry
    }

    // ── Phase 1: Try the action with simple retries to handle transient flakiness
    let lastError: any;
    for (let i = 0; i < ACTION_RETRY_COUNT; i++) {
        try {
            const locator = typeof originalSelector === 'string' ? page.locator(originalSelector).first() : originalSelector;
            // We wait for a very short time because if it's there we execute, if not we retry/heal.
            await locator.waitFor({ state: 'attached', timeout: 3000 });
            await action(locator);
            return; // Success!
        } catch (e: any) {
            lastError = e;
            // Short wait if this isn't the last attempt
            if (i < ACTION_RETRY_COUNT - 1) {
                await page.waitForTimeout(ACTION_RETRY_DELAY);
            }
        }
    }

    console.warn(`⚠️ aiHealAction: Element '${selectorStr}' (${description}) failed after ${ACTION_RETRY_COUNT} attempts. Initiating self-healing...`);

    // ── Phase 2: Try heuristic candidates (no Claude, no tokens) ──────────
    const candidates = generateCandidateSelectors(selectorStr, description);
    console.log(`🔎 Trying ${candidates.length} heuristic selector candidates before calling Claude...`);

    const triedWithErrors: { selector: string; error?: string }[] = [{ selector: selectorStr, error: lastError?.message }];
    for (const candidate of candidates) {
        const matched = await trySelector(page, candidate, action);
        if (matched) {
            console.log(`✅ Healed with heuristic selector: '${candidate}'`);
            console.warn(`💡 TIP: Update your test suite to use '${candidate}' instead of '${selectorStr}'`);
            saveToCache(selectorStr, candidate);
            updateTestSourceFile(selectorStr, candidate);
            return;
        }
        triedWithErrors.push({ selector: candidate });
    }

    console.log(`🤖 No heuristic matched. Falling back to Claude...`);

    // ── Phase 3: Extract compact DOM snapshot ──────────────────────────────
    const { domSnippets, visibleLabels, currentUrl } = await page.evaluate(() => {
        const ELEMENT_CAP = 150;
        const SNIPPET_CAP = 300;

        const selectors = [
            'button', 'a', 'input', 'select', 'textarea',
            '[role]', '[aria-label]', '[data-testid]', '[name]', '[id]',
        ];
        const seen = new Set<string>();
        const snippets: string[] = [];
        const labels: string[] = [];

        for (const sel of selectors) {
            if (snippets.length >= ELEMENT_CAP) break;
            document.querySelectorAll<HTMLElement>(sel).forEach(el => {
                if (snippets.length >= ELEMENT_CAP) return;
                const key = el.tagName + (el.id || '') + (el.getAttribute('data-testid') || '') + el.textContent?.trim().slice(0, 40);
                if (seen.has(key)) return;
                seen.add(key);

                const shallow = el.cloneNode(false) as HTMLElement;
                if (el.children.length === 0) shallow.textContent = el.textContent?.trim().slice(0, 80) ?? '';
                else shallow.textContent = el.textContent?.trim().slice(0, 60) ?? '';
                shallow.removeAttribute('style');
                snippets.push(shallow.outerHTML.slice(0, SNIPPET_CAP));

                const tag = el.tagName.toLowerCase();
                const text = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '';
                const ariaLabel = el.getAttribute('aria-label') ?? '';
                const label = ariaLabel || text;
                if (label) labels.push(`${tag}: "${label}"`);
            });
        }

        return {
            domSnippets: snippets.join('\n'),
            visibleLabels: labels.join('\n'),
            currentUrl: location.href,
        };
    });

    const domContext = `Current URL: ${currentUrl}\n\nVisible element labels (tag: "label"):\n${visibleLabels || '(none detected)'}\n\nHTML snippets:\n${domSnippets}`;

    if (activeRecordingContext) {
        console.log(`🔎 [Self-Heal] Using Recording Ground Truth (length: ${activeRecordingContext.length})`);
    }

    // ── Phase 4: Claude retry loop ─────────────────────────────────────────
    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
        console.log(`🔍 Claude attempt ${attempt}/${MAX_HEAL_ATTEMPTS} (DOM length: ${domContext.length})`);
        try {
            const proposedSelector = await claude.healSelector(
                selectorStr,
                description,
                domContext,
                triedWithErrors,
                expectedUrlHint,
                activeRecordingContext,
            );

            console.log(`🤖 Claude proposed: '${proposedSelector}'`);

            if (triedWithErrors.some(t => t.selector === proposedSelector)) {
                console.warn(`⚠️  Claude returned a selector already tried ('${proposedSelector}'). Skipping.`);
                triedWithErrors.push({ selector: proposedSelector, error: 'Already tried' });
                continue;
            }

            const matched = await trySelector(page, proposedSelector, action, 5000);
            if (matched) {
                console.log(`✅ Healed on Claude attempt ${attempt}. Selector: '${proposedSelector}'`);
                console.warn(`💡 TIP: Update your test suite to use '${proposedSelector}' instead of '${selectorStr}'`);
                saveToCache(selectorStr, proposedSelector);
                updateTestSourceFile(selectorStr, proposedSelector);
                return;
            } else {
                triedWithErrors.push({ selector: proposedSelector, error: 'Timeout or interaction failure' });
                console.log(`❌ Claude attempt ${attempt} failed. Retrying...`);
            }
        } catch (err: any) {
            lastError = err;
            triedWithErrors.push({ selector: `Claude proposed (attempt ${attempt})`, error: err?.message || 'Unknown error' });
            console.warn(`❌ Claude attempt ${attempt} failed. Retrying... Error: ${err}`);
        }
    }

    if (optional) {
        console.log(`ℹ️ Optional action for '${selectorStr}' (${description}) skipped after healing failed.`);
        return;
    }

    console.warn(
        `⚠️ Self-healing exhausted all heuristics + ${MAX_HEAL_ATTEMPTS} Claude attempt(s) for '${selectorStr}' (${description}). Skipping action and continuing test.\n` +
        `Tried: ${triedWithErrors.map(t => t.selector).join(', ')}\n` +
        `Last error: ${lastError}`
    );
}

// Helper specific to clicking
export async function aiClick(
    page: Page,
    selector: string | Locator,
    description: string,
    options?: { expectedUrlHint?: string; optional?: boolean },
) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.click();
    }, options);
}

// Helper specific to filling text
export async function aiFill(page: Page, selector: string | Locator, text: string, description: string, options?: { optional?: boolean }) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.fill(text);
    }, options);
}

// Helper specific to pressing keys (e.g. 'Enter')
export async function aiPress(page: Page, selector: string | Locator, key: string, description: string, options?: { optional?: boolean }) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.press(key);
    }, options);
}

// self-healing wait
export async function aiWaitFor(page: Page, selector: string | Locator, description: string, options?: { state?: 'visible' | 'hidden' | 'attached' | 'detached', timeout?: number; optional?: boolean }) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.waitFor({ state: options?.state ?? 'visible', timeout: options?.timeout ?? 5000 });
    }, options);
}



/**
 * Self-healing wait for URL. 
 * If the URL doesn't match within the timeout, Claude audits the situation.
 */
export async function aiWaitForURL(
    page: Page,
    pattern: string | RegExp,
    options?: { timeout?: number },
): Promise<boolean> {
    const timeout = options?.timeout ?? 10000;
    try {
        await page.waitForURL(pattern, { timeout });
        return true;
    } catch {
        console.warn(`⚠️ aiWaitForURL: URL did not match expected pattern within ${timeout}ms. Triggering Situation Audit...`);

        // ── Situation Audit ──────────────────────────────────────────────────────
        const currentUrl = page.url();
        const { domSnippets, visibleLabels } = await page.evaluate(() => {
            const ELEMENT_CAP = 150;
            const interactiveElements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role], [aria-label], [data-testid], [id], [name]'))
                .slice(0, ELEMENT_CAP);

            const domSnippets = interactiveElements.map(el => {
                const clone = el.cloneNode(false) as HTMLElement;
                return clone.outerHTML.substring(0, 300);
            }).join('\n');

            const visibleLabels = interactiveElements.map(el => {
                const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent || '').trim();
                const role = el.getAttribute('role') || el.tagName.toLowerCase();
                return label ? `${role}: "${label.substring(0, 50)}"` : '';
            }).filter(Boolean).join('\n');

            return { domSnippets, visibleLabels };
        });

        const domContext = `Current URL: ${currentUrl}\n\nVisible element labels:\n${visibleLabels}\n\nHTML snippets:\n${domSnippets}`;

        const audit = await claude.auditNavigation(pattern, currentUrl, domContext, activeRecordingContext);

        if (audit.action === 'continue') {
            console.log(`✅ [Self-Heal] Situation Audit: Claude says continue ("${audit.message}")`);
            return true;
        }

        if (audit.action === 'retry' && audit.recoverySelector && audit.recoveryAction) {
            console.log(`🔄 [Self-Heal] Situation Audit: Claude found a missed step: ${audit.recoveryAction} on "${audit.recoverySelector}" ("${audit.message}")`);

            // Attempt recovery
            try {
                const loc = page.locator(audit.recoverySelector).first();
                if (audit.recoveryAction === 'click') await loc.click();
                else if (audit.recoveryAction === 'press') await loc.press('Enter');

                // Wait again
                await page.waitForURL(pattern, { timeout: 5000 });
                console.log(`✅ [Self-Heal] Recovery successful!`);
                return true;
            } catch (e) {
                console.error(`❌ [Self-Heal] Recovery attempt failed: ${e}`);
            }
        }

        console.error(`❌ [Self-Heal] Situation Audit failed: ${audit.message}`);
        return false;
    }
}
