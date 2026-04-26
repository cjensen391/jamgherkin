import fs from "fs";
import path from "path";

const SKIP_DIRS = new Set([
    "node_modules", "dist", "build", "out", "coverage",
    "test-results", ".git", ".next", ".turbo", ".cache", ".vercel",
]);
const SCAN_EXTS = new Set([".tsx", ".ts", ".jsx", ".js", ".html", ".vue", ".svelte"]);
const PAGE_OBJECT_FILE = /\.(page|po)\.(ts|tsx|js|jsx)$/i;
const TEST_FILE = /\.(test|spec|cy)\.(ts|tsx|js|jsx)$/i;

const PLAYWRIGHT_HELPER_FILE = /\.(fixture|fixtures)\.(ts|tsx|js|jsx)$/i;
const CYPRESS_COMMAND_FILE = /\.(commands?|support)\.(ts|tsx|js|jsx)$/i;
const HELPER_FILE = /\.(helpers?|utils?)\.(ts|tsx|js|jsx)$/i;
const HELPER_DIR_HINT = /(^|[\/\\])(test-utils?|helpers|fixtures|support)([\/\\]|$)/i;
const CYPRESS_DIR_HINT = /(^|[\/\\])cypress([\/\\]support|[\/\\]commands?)?([\/\\]|$)/i;

const MAX_TESTIDS = 400;
const MAX_ARIA = 200;
const MAX_PAGE_OBJECTS = 50;
const MAX_HELPERS = 50;
const MAX_OUTPUT_CHARS = 8000;

interface HelperFile {
    file: string;
    exports: string[];
    notes?: string;
}

interface ScanResult {
    testIds: Set<string>;
    ariaLabels: Set<string>;
    pageObjects: Map<string, string[]>;
    playwrightHelpers: Map<string, HelperFile>;
    cypressCommands: Map<string, HelperFile>;
    genericHelpers: Map<string, HelperFile>;
}

export function scanCodebase(dirs: string[]): string {
    const result: ScanResult = {
        testIds: new Set(),
        ariaLabels: new Set(),
        pageObjects: new Map(),
        playwrightHelpers: new Map(),
        cypressCommands: new Map(),
        genericHelpers: new Map(),
    };

    for (const dir of dirs) {
        const abs = path.resolve(dir);
        if (!fs.existsSync(abs)) {
            console.warn(`[Scan] Directory not found: ${dir}`);
            continue;
        }
        walk(abs, result);
    }

    return format(result);
}

function walk(dir: string, result: ScanResult): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            walk(full, result);
        } else if (entry.isFile()) {
            if (!SCAN_EXTS.has(path.extname(entry.name))) continue;
            if (TEST_FILE.test(entry.name)) continue;
            scanFile(full, result);
        }
    }
}

function scanFile(filePath: string, result: ScanResult): void {
    let content: string;
    try {
        content = fs.readFileSync(filePath, "utf-8");
    } catch {
        return;
    }
    if (content.length > 500_000) return;

    for (const m of content.matchAll(/data-(?:testid|cy|test)=["']([^"']{1,80})["']/g)) {
        if (m[1] && !m[1].includes("${")) result.testIds.add(m[1]);
    }

    for (const m of content.matchAll(/aria-label=["']([^"']{1,80})["']/g)) {
        if (m[1] && !m[1].includes("${")) result.ariaLabels.add(m[1]);
    }

    const baseName = path.basename(filePath);
    const isPageObject = PAGE_OBJECT_FILE.test(baseName);
    if (isPageObject) {
        const exports = extractExports(content);
        if (exports.length > 0) result.pageObjects.set(filePath, exports);
    }

    const cypressCmds = extractCypressCommands(content);
    if (cypressCmds.length > 0) {
        result.cypressCommands.set(filePath, {
            file: filePath,
            exports: cypressCmds,
            notes: "registered via Cypress.Commands.add — call as cy.<name>(...)",
        });
    }

    const hasPlaywrightFixture = /\btest\s*\.\s*extend\s*\(/.test(content);
    if (hasPlaywrightFixture || PLAYWRIGHT_HELPER_FILE.test(baseName)) {
        const exports = extractExports(content);
        if (exports.length > 0) {
            result.playwrightHelpers.set(filePath, {
                file: filePath,
                exports,
                ...(hasPlaywrightFixture ? { notes: "extends Playwright `test` with fixtures — import `test` from this file instead of @playwright/test" } : {}),
            });
        }
    }

    const inHelperDir = HELPER_DIR_HINT.test(filePath);
    const inCypressDir = CYPRESS_DIR_HINT.test(filePath);
    const looksLikeHelper = HELPER_FILE.test(baseName);
    const alreadyClassified = isPageObject
        || result.cypressCommands.has(filePath)
        || result.playwrightHelpers.has(filePath);

    if (!alreadyClassified && (inHelperDir || looksLikeHelper)) {
        const exports = extractExports(content);
        if (exports.length > 0) {
            const target = inCypressDir ? result.cypressCommands : result.genericHelpers;
            target.set(filePath, { file: filePath, exports });
        }
    }
}

function extractExports(content: string): string[] {
    const names = new Set<string>();
    const patterns = [
        /export\s+(?:default\s+)?class\s+(\w+)/g,
        /export\s+(?:async\s+)?function\s+(\w+)/g,
        /export\s+const\s+(\w+)/g,
        /export\s+let\s+(\w+)/g,
        /export\s+\{\s*([^}]+)\s*\}/g,
    ];
    for (const re of patterns) {
        for (const m of content.matchAll(re)) {
            if (!m[1]) continue;
            if (re.source.startsWith("export\\s+\\{")) {
                for (const raw of m[1].split(",")) {
                    const name = raw.trim().split(/\s+as\s+/i).pop()?.trim();
                    if (name && /^\w+$/.test(name)) names.add(name);
                }
            } else {
                names.add(m[1]);
            }
        }
    }
    return [...names];
}

function extractCypressCommands(content: string): string[] {
    const names = new Set<string>();
    const re = /Cypress\.Commands\.(?:add|overwrite)\s*(?:<[^>]+>\s*)?\(\s*['"]([\w$]+)['"]/g;
    for (const m of content.matchAll(re)) {
        if (m[1]) names.add(m[1]);
    }
    return [...names];
}

function relPath(p: string): string {
    return path.relative(process.cwd(), p);
}

function formatHelperBlock(label: string, entries: Map<string, HelperFile>, max: number): string | null {
    if (entries.size === 0) return null;
    const total = entries.size;
    const list = [...entries.values()].slice(0, max);
    const lines = list.map(h => {
        const note = h.notes ? `  [${h.notes}]` : "";
        return `  - ${relPath(h.file)}: ${h.exports.join(", ")}${note}`;
    });
    const heading = `\n${label} (${list.length}${total > list.length ? ` of ${total}` : ""}):`;
    return `${heading}\n${lines.join("\n")}`;
}

function format(result: ScanResult): string {
    const empty =
        result.testIds.size === 0 &&
        result.ariaLabels.size === 0 &&
        result.pageObjects.size === 0 &&
        result.playwrightHelpers.size === 0 &&
        result.cypressCommands.size === 0 &&
        result.genericHelpers.size === 0;
    if (empty) return "";

    const sections: string[] = [];
    sections.push(
        "These selectors and helpers exist in the target codebase. PREFER them when generating tests — match the recorded user actions to the closest existing test ID, aria label, command, fixture, or page object. If a Playwright helper or Cypress command exists for a flow (e.g. login, db seed), call it instead of reimplementing the steps inline.",
    );

    if (result.testIds.size > 0) {
        const list = [...result.testIds].sort().slice(0, MAX_TESTIDS);
        sections.push(
            `\nExisting data-testid / data-cy / data-test values (${list.length}${result.testIds.size > list.length ? ` of ${result.testIds.size}` : ""}):`,
            list.map(t => `  - ${t}`).join("\n"),
        );
    }

    if (result.ariaLabels.size > 0) {
        const list = [...result.ariaLabels].sort().slice(0, MAX_ARIA);
        sections.push(
            `\nExisting aria-label values (${list.length}${result.ariaLabels.size > list.length ? ` of ${result.ariaLabels.size}` : ""}):`,
            list.map(a => `  - ${a}`).join("\n"),
        );
    }

    const playwright = formatHelperBlock(
        "Playwright helpers — use these in Playwright tests (import from these files instead of reimplementing flows)",
        result.playwrightHelpers,
        MAX_HELPERS,
    );
    if (playwright) sections.push(playwright);

    const cypress = formatHelperBlock(
        "Cypress helpers — use these in Cypress tests (Cypress.Commands.add registers cy.<name>())",
        result.cypressCommands,
        MAX_HELPERS,
    );
    if (cypress) sections.push(cypress);

    const generic = formatHelperBlock(
        "Generic test helpers — usable from either framework if signatures match",
        result.genericHelpers,
        MAX_HELPERS,
    );
    if (generic) sections.push(generic);

    if (result.pageObjects.size > 0) {
        const entries = [...result.pageObjects.entries()].slice(0, MAX_PAGE_OBJECTS);
        sections.push(
            `\nPage objects (${entries.length}${result.pageObjects.size > entries.length ? ` of ${result.pageObjects.size}` : ""}):`,
            entries.map(([file, exps]) => `  - ${relPath(file)}: ${exps.join(", ")}`).join("\n"),
        );
    }

    let out = sections.join("\n");
    if (out.length > MAX_OUTPUT_CHARS) {
        out = out.slice(0, MAX_OUTPUT_CHARS) + "\n... (truncated to fit prompt budget)";
    }
    return out;
}
