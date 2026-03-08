import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.ts',
    // Self-healing needs time: heuristic sweep + up to 3 Claude API calls can take 60-90s on a miss.
    timeout: 120_000,
    use: {
        trace: 'on-first-retry',
        actionTimeout: 10_000,
    },
});
