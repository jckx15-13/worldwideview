import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        clearMocks: true,
        // Vitest's 10s default is not enough on a loaded machine: the beforeEach in
        // src/lib/better-auth.test.ts was measured at 40,362 ms under concurrent load,
        // which is the root cause of the suite's intermittent failures (see
        // docs/PERFORMANCE-BASELINE.md). Environment setup dilates, not test logic.
        hookTimeout: 60000,
        // Same class of problem, different knob: transport-spike.test.ts dynamically
        // imports the MCP SDK inside the test body and exceeded the 5s default under
        // the same load. Measured 2026-08-16.
        testTimeout: 30000,
        setupFiles: ['./src/test/setup.ts'],
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
        include: [
            'src/lib/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'src/core/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'src/hooks/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'src/plugins/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'src/components/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'src/app/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'packages/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'tests/pact/**/*.{test,spec}.{js,ts,jsx,tsx}',
            'tests/ci/**/*.{test,spec}.{js,ts,jsx,tsx}',
        ],
        exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/.next/**',
            '**/.git/**',
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'json-summary', 'html'],
            // Ratchet, not aspiration. 80/70 were never met and never enforced —
            // ci.yml swallowed the failure with `|| true`, so nobody ever saw it.
            // Measured 2026-08-16 over two runs: functions 35.60/35.55%,
            // branches 34.55/34.46%. Coverage drifts ~0.1pp run-to-run, so these
            // sit ~1.5pp below actual — enough margin that a loaded CI runner
            // cannot flap the gate, while still blocking real REGRESSION.
            // A gate that flaps is worse than no gate.
            // Raise these as coverage improves; never lower them.
            thresholds: {
                functions: 34,
                branches: 33,
            },
        }
    },
});
