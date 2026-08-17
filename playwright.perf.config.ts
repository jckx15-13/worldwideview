import { defineConfig, devices } from '@playwright/test';

/**
 * Production-mode performance harness — deliberately separate from
 * `playwright.config.ts`.
 *
 * The main config runs `pnpm dev`, so every measurement taken through it is a
 * dev-server measurement: unminified, unsplit, compiled on demand. That is
 * useless for bundle work. This config runs `next start` against a real
 * `next build` output instead.
 *
 * It also skips `tests/global.setup.ts`. That setup provisions a Postgres user
 * and writes a storageState, which the perf spec does not need: `src/proxy.ts`
 * gates `/` on session-cookie PRESENCE only (see `hasBetterAuthCookie` in
 * src/lib/proxy-auth.ts — documented as not verifying validity), and
 * `src/app/page.tsx` performs no auth of its own. A synthetic cookie therefore
 * reaches the identical client bundle, with no database in the loop.
 *
 * Usage: `pnpm perf` (builds first). Port 3005 avoids the 3001/3002 pair the
 * functional E2E configs use, so both can run without colliding.
 */
export default defineConfig({
    testDir: './tests/perf',
    // Real auth. A synthetic cookie clears src/proxy.ts (presence-only) but every
    // /api/* route does genuine auth, so an unauthenticated run 401s the
    // marketplace sync and NO plugins ever register — `plugin-register-all` then
    // reads 0 ms, which looks like "instant" and actually means "empty". Reuses
    // the E2E setup: creates a test user, captures storageState, purges on exit.
    // Set PERF_NO_AUTH=1 to skip it and measure the anonymous shell only.
    ...(process.env.PERF_NO_AUTH === '1' ? {} : {
        globalSetup: './tests/global.setup.ts',
        globalTeardown: './tests/global.teardown.ts',
    }),
    // Cold production loads plus a 3.9 MB chunk; the 60s default is too tight.
    timeout: 180_000,
    // Sequential by design: concurrent page loads contend for CPU and network
    // and would make every number noise.
    fullyParallel: false,
    workers: 1,
    // Never retry. A retry silently reports a warm-cache run as a cold one.
    retries: 0,
    forbidOnly: !!process.env.CI,
    // Inside playwright/output/, which .gitignore already covers.
    outputDir: 'playwright/output/perf-artifacts',
    reporter: [['list']],
    use: {
        baseURL: 'http://localhost:3005',
        trace: 'off',
        video: 'off',
        screenshot: 'off',
        // Written by tests/global.setup.ts. Absent under PERF_NO_AUTH=1, in which
        // case the spec falls back to its synthetic cookie.
        ...(process.env.PERF_NO_AUTH === '1'
            ? {}
            : { storageState: 'playwright/.auth/user.json' }),
    },
    projects: [
        {
            name: 'perf-chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        // Cesium needs WebGL to finish booting. Headless Chrome has no
                        // GPU here, so fall back to the software rasteriser rather than
                        // letting the boot sequence stall and strand `app-ready`.
                        '--use-gl=swiftshader',
                        '--enable-unsafe-swiftshader',
                        '--disable-dev-shm-usage',
                    ],
                },
            },
        },
    ],
    webServer: {
        // `next start`, not `next dev`. Requires a prior `pnpm build`; the `pnpm perf`
        // script chains them. Reusing an existing server is allowed locally so an
        // iteration loop does not pay for a fresh boot each time.
        //
        // Next prints `"next start" does not work with "output: standalone"` here.
        // Ignore it: the suggested `node .next/standalone/server.js` serves no static
        // assets unless `.next/static` and `public/` are copied in by hand, which
        // would make every chunk 404 and the measurement meaningless. `next start`
        // serves the same built bundles this harness exists to measure.
        command: 'pnpm start',
        env: {
            PORT: '3005',
            // `local` edition: skips the cloud tenant/workspace lookups in proxy.ts,
            // which would otherwise add unrelated server latency to every measurement.
            NEXT_PUBLIC_WWV_EDITION: 'local',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3005',
            NEXT_PUBLIC_HUB_REDIRECT_URL: '',
        },
        url: 'http://localhost:3005',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
