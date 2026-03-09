import type { Page, Locator } from 'playwright';
import { ClaudeService } from './claude-service.js';

const claude = new ClaudeService();

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
): Promise<boolean> {
    try {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'attached', timeout: 300 });
        await action(loc);
        return true;
    } catch {
        return false;
    }
}

export async function aiHealAction(
    page: Page,
    originalSelector: string,
    description: string,
    action: (locator: Locator) => Promise<void>,
    options?: { expectedUrlHint?: string },
) {
    let locator = page.locator(originalSelector);

    try {
        // We wait for a very short time because if it's there we execute, if not we heal immediately.
        // For standard implicit waits, playwright normally waits 30s. We'll give it 5s max before healing.
        await locator.waitFor({ state: 'attached', timeout: 5000 });
        await action(locator);
    } catch (e) {
        console.warn(`⚠️ aiHealAction: Element '${originalSelector}' (${description}) failed. Initiating self-healing...`);

        // ── Phase 1: Try heuristic candidates (no Claude, no tokens) ──────────
        const candidates = generateCandidateSelectors(originalSelector, description);
        console.log(`🔎 Trying ${candidates.length} heuristic selector candidates before calling Claude...`);

        const triedSelectors: string[] = [originalSelector];
        for (const candidate of candidates) {
            const matched = await trySelector(page, candidate, action);
            triedSelectors.push(candidate);
            if (matched) {
                console.log(`✅ Healed with heuristic selector: '${candidate}'`);
                console.warn(`💡 TIP: Update your test suite to use '${candidate}' instead of '${originalSelector}'`);
                return;
            }
        }
        console.log(`🤖 No heuristic matched. Falling back to Claude...`);

        // ── Phase 2: Extract compact DOM snapshot ──────────────────────────────
        // Extract both the HTML snippets AND a plain visible-text summary so Claude
        // can identify elements by their label even if they have no stable attributes.
        const { domSnippets, visibleLabels, currentUrl } = await page.evaluate(() => {
            const ELEMENT_CAP = 150;
            const SNIPPET_CAP = 300;

            const selectors = [
                'button', 'a', 'input', 'select', 'textarea',
                '[role]', '[aria-label]', '[data-testid]', '[name]', '[id]',
            ];
            const seen = new Set<string>();
            const snippets: string[] = [];
            const labels: string[] = [];   // human-readable: "button: All Digg", "a: Home"

            for (const sel of selectors) {
                if (snippets.length >= ELEMENT_CAP) break;
                document.querySelectorAll<HTMLElement>(sel).forEach(el => {
                    if (snippets.length >= ELEMENT_CAP) return;
                    const key = el.tagName + (el.id || '') + (el.getAttribute('data-testid') || '') + el.textContent?.trim().slice(0, 40);
                    if (seen.has(key)) return;
                    seen.add(key);

                    // HTML snippet (existing approach)
                    const shallow = el.cloneNode(false) as HTMLElement;
                    if (el.children.length === 0) shallow.textContent = el.textContent?.trim().slice(0, 80) ?? '';
                    else shallow.textContent = el.textContent?.trim().slice(0, 60) ?? '';
                    shallow.removeAttribute('style');
                    snippets.push(shallow.outerHTML.slice(0, SNIPPET_CAP));

                    // Visible text summary (new)
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

        const truncatedDom = `Current URL: ${currentUrl}

Visible element labels (tag: "label"):
${visibleLabels || '(none detected)'}

HTML snippets:
${domSnippets}`;

        // ── Phase 3: Claude retry loop ─────────────────────────────────────────
        const MAX_HEAL_ATTEMPTS = 3;
        let lastError: unknown = e;

        for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
            console.log(`🔍 Claude attempt ${attempt}/${MAX_HEAL_ATTEMPTS} (DOM length: ${truncatedDom.length})`);

            const newSelector = await claude.healSelector(
                originalSelector,
                description,
                truncatedDom,
                triedSelectors,
                options?.expectedUrlHint,
            );


            console.log(`🤖 Claude proposed: '${newSelector}'`);

            if (triedSelectors.includes(newSelector)) {
                console.warn(`⚠️  Claude returned a selector already tried ('${newSelector}'). Skipping.`);
                continue;
            }

            triedSelectors.push(newSelector);

            try {
                const newLocator = page.locator(newSelector).first();
                await newLocator.waitFor({ state: 'attached', timeout: 5000 });
                await action(newLocator);
                console.log(`✅ Healed on Claude attempt ${attempt}. Selector: '${newSelector}'`);
                console.warn(`💡 TIP: Update your test suite to use '${newSelector}' instead of '${originalSelector}'`);
                return; // success — exit the catch block
            } catch (err) {
                lastError = err;
                console.warn(`❌ Claude attempt ${attempt} failed with selector '${newSelector}'. Retrying...`);
            }
        }

        console.warn(
            `⚠️ Self-healing exhausted all heuristics + ${MAX_HEAL_ATTEMPTS} Claude attempt(s) for '${originalSelector}' (${description}). Skipping action and continuing test.\n` +
            `Tried: ${triedSelectors.join(', ')}\n` +
            `Last error: ${lastError}`
        );
        // Don't throw — allow the test to continue to the next step.
    }
}

// Helper specific to clicking
export async function aiClick(
    page: Page,
    selector: string,
    description: string,
    options?: { expectedUrlHint?: string },
) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.click();
    }, options);
}


// Helper specific to filling text
export async function aiFill(page: Page, selector: string, text: string, description: string) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.fill(text);
    });
}

/**
 * Soft version of page.waitForURL — if the URL doesn't match within the timeout,
 * logs a warning and continues instead of throwing. Use this after aiClick calls
 * that may have been self-healed, since the healed element might navigate somewhere
 * slightly different than expected.
 */
export async function softWaitForURL(
    page: Page,
    pattern: string | RegExp,
    options?: { timeout?: number },
): Promise<boolean> {
    try {
        await page.waitForURL(pattern, { timeout: options?.timeout ?? 15000 });
        return true;
    } catch {
        const patternStr = pattern instanceof RegExp ? pattern.toString() : pattern;
        console.warn(`⚠️ softWaitForURL: URL did not match ${patternStr} within timeout. Continuing to next step...`);
        return false;
    }
}
