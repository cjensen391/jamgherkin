import { defineConfig } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
    testDir: './tests',
    testMatch: '**/*.spec.ts',
    use: {
        trace: 'on-first-retry',
    },
});
