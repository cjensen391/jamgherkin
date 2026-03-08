import type { Page, Locator } from 'playwright';
import { ClaudeService } from './claude-service.js';

const claude = new ClaudeService();

export async function aiHealAction(
    page: Page,
    originalSelector: string,
    description: string,
    action: (locator: Locator) => Promise<void>
) {
    let locator = page.locator(originalSelector);

    try {
        // We wait for a very short time because if it's there we execute, if not we heal immediately.
        // For standard implicit waits, playwright normally waits 30s. We'll give it 5s max before healing.
        await locator.waitFor({ state: 'attached', timeout: 5000 });
        await action(locator);
    } catch (e) {
        console.warn(`⚠️ aiHealAction: Element '${originalSelector}' (${description}) failed. Initiating self-healing...`);

        // Grab current DOM body roughly, removing massive script tags or purely stylistic things to save tokens
        const rawBody = await page.evaluate(() => {
            const clone = document.body.cloneNode(true) as HTMLElement;
            // Remove scripts and styles
            const scripts = clone.getElementsByTagName('script');
            let i = scripts.length;
            while (i--) {
                const s = scripts[i];
                if (s && s.parentNode) s.parentNode.removeChild(s);
            }
            const styles = clone.getElementsByTagName('style');
            i = styles.length;
            while (i--) {
                const s = styles[i];
                if (s && s.parentNode) s.parentNode.removeChild(s);
            }
            const svg = clone.getElementsByTagName('svg');
            i = svg.length;
            while (i--) {
                const s = svg[i];
                if (s && s.parentNode) s.parentNode.removeChild(s);
            }

            return clone.innerHTML;
        });

        // Limit the DOM payload to around 50k chars just in case (roughly 12k tokens)
        const truncatedDom = rawBody.substring(0, 50000);

        console.log("Asking Claude for a new selector...");
        // Call Claude
        const newSelector = await claude.healSelector(originalSelector, description, truncatedDom);

        console.log(`✅ Healing complete. New selector proposed by Claude: '${newSelector}'`);
        const newLocator = page.locator(newSelector);

        // Try the action again with the new locator
        await newLocator.waitFor({ state: 'attached', timeout: 5000 });
        await action(newLocator);

        console.warn(`💡 TIP: Update your test suite to use '${newSelector}' instead of '${originalSelector}'`);
    }
}

// Helper specific to clicking
export async function aiClick(page: Page, selector: string, description: string) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.click();
    });
}

// Helper specific to filling text
export async function aiFill(page: Page, selector: string, text: string, description: string) {
    return aiHealAction(page, selector, description, async (loc) => {
        await loc.fill(text);
    });
}
