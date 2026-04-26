import fs from "fs";
import path from "path";

const SKIP_DIRS = new Set([
    "node_modules", "dist", "build", "out", "coverage",
    "test-results", ".git", ".next", ".turbo", ".cache", ".vercel",
]);
const SCAN_EXTS = new Set([".tsx", ".ts", ".jsx", ".js", ".html", ".vue", ".svelte"]);
const PAGE_OBJECT_FILE = /\.(page|po)\.(ts|tsx|js|jsx)$/i;
const TEST_FILE = /\.(test|spec|cy)\.(ts|tsx|js|jsx)$/i;

const MAX_TESTIDS = 400;
const MAX_ARIA = 200;
const MAX_PAGE_OBJECTS = 50;
const MAX_OUTPUT_CHARS = 8000;

interface ScanResult {
    testIds: Set<string>;
    ariaLabels: Set<string>;
    pageObjects: Map<string, string[]>;
}

export function scanCodebase(dirs: string[]): string {
    const result: ScanResult = {
        testIds: new Set(),
        ariaLabels: new Set(),
        pageObjects: new Map(),
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

    if (PAGE_OBJECT_FILE.test(path.basename(filePath))) {
        const exports = extractExports(content);
        if (exports.length > 0) {
            result.pageObjects.set(filePath, exports);
        }
    }
}

function extractExports(content: string): string[] {
    const names = new Set<string>();
    const patterns = [
        /export\s+(?:default\s+)?class\s+(\w+)/g,
        /export\s+(?:async\s+)?function\s+(\w+)/g,
        /export\s+const\s+(\w+)/g,
    ];
    for (const re of patterns) {
        for (const m of content.matchAll(re)) {
            if (m[1]) names.add(m[1]);
        }
    }
    return [...names];
}

function format(result: ScanResult): string {
    const totalTestIds = result.testIds.size;
    const totalAria = result.ariaLabels.size;
    const totalPOs = result.pageObjects.size;

    if (totalTestIds === 0 && totalAria === 0 && totalPOs === 0) return "";

    const sections: string[] = [];
    sections.push(
        "These selectors and helpers exist in the target codebase. PREFER them when generating tests — match the recorded user actions to the closest existing test ID, aria label, or page object method.",
    );

    if (totalTestIds > 0) {
        const list = [...result.testIds].sort().slice(0, MAX_TESTIDS);
        sections.push(
            `\nExisting data-testid / data-cy / data-test values (${list.length}${totalTestIds > list.length ? ` of ${totalTestIds}` : ""}):`,
            list.map(t => `  - ${t}`).join("\n"),
        );
    }

    if (totalAria > 0) {
        const list = [...result.ariaLabels].sort().slice(0, MAX_ARIA);
        sections.push(
            `\nExisting aria-label values (${list.length}${totalAria > list.length ? ` of ${totalAria}` : ""}):`,
            list.map(a => `  - ${a}`).join("\n"),
        );
    }

    if (totalPOs > 0) {
        const entries = [...result.pageObjects.entries()].slice(0, MAX_PAGE_OBJECTS);
        sections.push(
            `\nPage objects (${entries.length}${totalPOs > entries.length ? ` of ${totalPOs}` : ""}):`,
            entries.map(([file, exps]) => `  - ${path.relative(process.cwd(), file)}: ${exps.join(", ")}`).join("\n"),
        );
    }

    let out = sections.join("\n");
    if (out.length > MAX_OUTPUT_CHARS) {
        out = out.slice(0, MAX_OUTPUT_CHARS) + "\n... (truncated to fit prompt budget)";
    }
    return out;
}
