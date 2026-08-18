import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Measures the client-side load waterfall for the globe in PRODUCTION mode.
 *
 * Why this exists: Next 16 removed the per-route "First Load JS" columns from
 * build output, and the only other Playwright configs run `pnpm dev`. Between
 * those two facts the project had no way to observe what a real user downloads,
 * so every bundle claim in docs/FORK-OPTIMIZATION-REPORT.md was inference. This
 * turns the central open question — when does the 3.9 MB Cesium chunk actually
 * start downloading? — into a number.
 *
 * The metric that matters is `globeDiscoveryMs`: milliseconds from navigation
 * start until the browser first requests a GlobeView chunk. `GlobeView` is a
 * `next/dynamic(..., { ssr: false })` import rendered unconditionally by
 * AppShell, so it is absent from the prerendered HTML and cannot be discovered
 * by the preload scanner. Whatever that number is, it is time the network spent
 * idle.
 */

// Under playwright/output/, which .gitignore already covers — this is a
// regenerated measurement, not a tracked artifact.
const OUT_DIR = path.resolve(process.cwd(), 'playwright/output/perf');
const OUT_FILE = path.join(OUT_DIR, 'globe-load.json');
const LOADABLE_MANIFEST = path.resolve(process.cwd(), '.next/react-loadable-manifest.json');

/**
 * Resolve the GlobeView chunk filenames from the build itself rather than
 * hardcoding hashes, which change on every build.
 */
function globeChunkFiles(): string[] {
    if (!fs.existsSync(LOADABLE_MANIFEST)) {
        throw new Error(
            `Missing ${LOADABLE_MANIFEST}. Run \`pnpm build\` before \`pnpm perf\` — ` +
            'this harness measures production output, not a dev server.',
        );
    }
    const manifest = JSON.parse(fs.readFileSync(LOADABLE_MANIFEST, 'utf8')) as Record<
        string,
        { files?: string[] } | string[]
    >;
    const key = Object.keys(manifest).find((k) => k.includes('GlobeView'));
    if (!key) {
        throw new Error(
            'No GlobeView entry in react-loadable-manifest.json. If the dynamic import in ' +
            'src/components/layout/AppShell.tsx was removed or renamed, update this spec — ' +
            'do not delete the assertion.',
        );
    }
    const entry = manifest[key];
    const files = Array.isArray(entry) ? entry : (entry.files ?? []);
    return files.map((f) => f.split('/').pop()!).filter(Boolean);
}

interface ResourceSample {
    name: string;
    startTime: number;
    responseEnd: number;
    encodedBodySize: number;
}

test('globe load waterfall (production)', async ({ page, context }) => {
    const chunkFiles = globeChunkFiles();

    // Plugin bundles are imported with `webpackIgnore: true`, so they never appear
    // in a chunk and a failed load is silent from the network's point of view.
    // Capturing errors is the only way to tell "fast" apart from "gave up".
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e)));
    page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(m.text());
    });

    // With storageState loaded there is already a real session cookie; adding the
    // synthetic one would OVERWRITE it by name and silently drop us back to the
    // 401-everywhere path where no plugin ever loads. Only fall back when
    // genuinely unauthenticated (PERF_NO_AUTH=1), where proxy.ts's presence-only
    // check is enough to reach the shell.
    const authenticated = (await context.cookies()).some((c) => c.name.includes('session_token'));
    if (!authenticated) {
        await context.addCookies([
            {
                name: 'better-auth.session_token',
                value: 'perf-harness-not-a-real-session',
                domain: 'localhost',
                path: '/',
            },
        ]);
    }

    // Stamp the moment `app-ready` lands. Polling with waitForSelector would fold
    // the poll interval into the number; a MutationObserver does not.
    await page.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__appReadyAt = null;
        const stamp = () => {
            const w = window as unknown as Record<string, unknown>;
            if (w.__appReadyAt === null && document.querySelector('[data-testid="app-ready"]')) {
                w.__appReadyAt = performance.now();
            }
        };
        // Observe `document`, not `document.documentElement`. An init script runs
        // before the document element exists, so the latter is null here and
        // observe() throws "parameter 1 is not of type 'Node'" — which is why this
        // silently reported appReadyMs: null on every earlier run.
        new MutationObserver(stamp).observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
        });
        stamp();
    });

    await page.goto('/', { waitUntil: 'load' });

    // Soft: if WebGL is unavailable the boot sequence never completes. That does
    // not invalidate the waterfall numbers, which are what this spec is for.
    let appReadyMs: number | null = null;
    try {
        await page.waitForFunction(
            () => (window as unknown as Record<string, unknown>).__appReadyAt !== null,
            undefined,
            { timeout: 60_000 },
        );
        appReadyMs = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__appReadyAt as number,
        );
    } catch {
        appReadyMs = null;
    }

    // Wait for feeds to stop arriving, not for the network to go quiet. Plugins
    // poll on intervals, so `networkidle` either never settles or settles during a
    // gap between polls — either way it is uncorrelated with "all layers live".
    // Instead: sample the plugin-data mark count until it stops growing.
    let prevCount = -1;
    let stableTicks = 0;
    for (let i = 0; i < 60 && stableTicks < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        // Count BOTH bundle loads and live feeds. Watching only feeds was a bug:
        // when no plugin ever enables, that count is pinned at 0, `n === prevCount`
        // is true on the first tick, and sampling fired ~1.5 s in — truncating the
        // plugin set from 35 to ~21 and reporting it as fact.
        const n = await page.evaluate(() => {
            const marks = performance.getEntriesByType('mark')
                .filter((e) => e.name.startsWith('wwv:plugin-data:')).length;
            const loads = performance.getEntriesByType('measure')
                .filter((e) => e.name.startsWith('wwv:plugin-load:')).length;
            return marks + loads;
        });
        if (n === prevCount) stableTicks += 1;
        else { stableTicks = 0; prevCount = n; }
        // eslint-disable-next-line no-await-in-loop
        await page.waitForTimeout(500);
    }

    // Boot-phase work, emitted by src/lib/boot-metrics.ts. These measure real
    // work; `appReadyMs` does not — useBootSequence sets that on a fixed 3,500 ms
    // animation timer, so it is an animation length, not a readiness time.
    // startTime as well as duration: plugin loads overlap, so summing durations
    // would wildly overstate the wall clock. The envelope (earliest start to
    // latest end) is what a user actually waits.
    const bootMeasures: Record<string, { start: number; ms: number }> = await page.evaluate(() => {
        const out: Record<string, { start: number; ms: number }> = {};
        for (const e of performance.getEntriesByType('measure')) {
            if (e.name.startsWith('wwv:')) {
                out[e.name.slice(4)] = { start: Math.round(e.startTime), ms: Math.round(e.duration) };
            }
        }
        return out;
    });

    // Single-timestamp marks (bootMarkOnce), as opposed to the start/end measures
    // above. `startTime` is ms from navigation start.
    const bootMarks: Record<string, number> = await page.evaluate(() => {
        const out: Record<string, number> = {};
        for (const e of performance.getEntriesByType('mark')) {
            if (e.name.startsWith('wwv:') && !e.name.endsWith(':start') && !e.name.endsWith(':end')) {
                out[e.name.slice(4)] = Math.round(e.startTime);
            }
        }
        return out;
    });

    const stageTimes = (prefix: string) =>
        Object.entries(bootMarks)
            .filter(([k]) => k.startsWith(prefix))
            .map(([, v]) => v);

    const enabledAt = stageTimes('plugin-enabled:');
    const dataAt = stageTimes('plugin-data:');

    /**
     * "Full run" as defined by the operator: every feature actually working and
     * available, not merely downloaded. The last plugin to deliver a non-empty
     * payload is the closest honest proxy — after that point every enabled layer
     * has real data on the bus and the globe renders it on the next frame.
     */
    const fullRun = {
        pluginsLoaded: Object.keys(bootMeasures).filter((k) => k.startsWith('plugin-load:')).length,
        pluginsEnabled: enabledAt.length,
        pluginsWithData: dataAt.length,
        lastEnabledMs: enabledAt.length ? Math.max(...enabledAt) : null,
        // The headline figure.
        lastDataMs: dataAt.length ? Math.max(...dataAt) : null,
        firstDataMs: dataAt.length ? Math.min(...dataAt) : null,
    };

    const pluginEntries = Object.entries(bootMeasures).filter(([k]) => k.startsWith('plugin-load:'));
    const pluginWallClock = pluginEntries.length
        ? Math.round(
            Math.max(...pluginEntries.map(([, v]) => v.start + v.ms))
            - Math.min(...pluginEntries.map(([, v]) => v.start)),
        )
        : null;
    const pluginDurations = pluginEntries.map(([, v]) => v.ms).sort((a, b) => a - b);
    const pluginStats = pluginDurations.length
        ? {
            count: pluginDurations.length,
            wallClockMs: pluginWallClock,
            firstStartMs: Math.round(Math.min(...pluginEntries.map(([, v]) => v.start))),
            lastEndMs: Math.round(Math.max(...pluginEntries.map(([, v]) => v.start + v.ms))),
            minMs: pluginDurations[0],
            medianMs: pluginDurations[Math.floor(pluginDurations.length / 2)],
            maxMs: pluginDurations[pluginDurations.length - 1],
            sumMs: pluginDurations.reduce((a, b) => a + b, 0),
            slowest: pluginEntries
                .sort((a, b) => b[1].ms - a[1].ms)
                .slice(0, 5)
                .map(([k, v]) => `${k.replace('plugin-load:', '')}=${v.ms}ms`),
        }
        : null;

    const resources: ResourceSample[] = await page.evaluate(() =>
        (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((e) => ({
            name: e.name,
            startTime: e.startTime,
            responseEnd: e.responseEnd,
            encodedBodySize: e.encodedBodySize,
        })),
    );

    const isGlobeChunk = (url: string) => chunkFiles.some((f) => url.includes(f));
    const globeResources = resources.filter((r) => isGlobeChunk(r.name));
    const jsResources = resources.filter((r) => /\.js(\?|$)/.test(r.name));

    // Was the chunk discoverable from the HTML, or only after hydration?
    const html = await (await context.request.get('/')).text();
    const preloadCount = (html.match(/rel="preload"/g) ?? []).length;
    const inHtml = chunkFiles.filter((f) => html.includes(f));

    const firstJsMs = jsResources.length ? Math.min(...jsResources.map((r) => r.startTime)) : null;
    const globeDiscoveryMs = globeResources.length
        ? Math.min(...globeResources.map((r) => r.startTime))
        : null;
    const globeCompleteMs = globeResources.length
        ? Math.max(...globeResources.map((r) => r.responseEnd))
        : null;

    const report = {
        measuredAt: new Date().toISOString(),
        mode: 'production (next start)',
        chunkFiles,
        metrics: {
            firstJsRequestMs: round(firstJsMs),
            globeDiscoveryMs: round(globeDiscoveryMs),
            globeCompleteMs: round(globeCompleteMs),
            // The headline: network time spent idle on the globe's critical path.
            discoveryGapMs: round(
                globeDiscoveryMs !== null && firstJsMs !== null ? globeDiscoveryMs - firstJsMs : null,
            ),
            appReadyMs: round(appReadyMs),
            jsRequestCount: jsResources.length,
            jsEncodedBytes: jsResources.reduce((n, r) => n + r.encodedBodySize, 0),
            globeChunkCount: globeResources.length,
            globeEncodedBytes: globeResources.reduce((n, r) => n + r.encodedBodySize, 0),
        },
        html: {
            preloadLinkCount: preloadCount,
            globeChunksReferencedInHtml: inHtml,
        },
        // Durations in ms of real boot work. `plugin-load:*` is the network fetch
        // and instantiation of a plugin bundle; `plugin-enable:*` is its first
        // activation. Empty means the boot path never reached them — check
        // pageErrors before reading that as "fast".
        fullRun,
        plugins: pluginStats,
        boot: bootMeasures,
        marks: bootMarks,
        authenticated,
        pageErrors: pageErrors.slice(0, 25),
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log('\n=== globe load waterfall (production) ===');
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nwritten to ${OUT_FILE}\n`);

    // Structural assertions only. Timing budgets here would flap on a loaded
    // machine and a gate that flaps is worse than no gate — the same reasoning
    // that set the coverage thresholds in vitest.config.ts.
    expect(chunkFiles.length, 'GlobeView must still be code-split').toBeGreaterThan(0);
    expect(globeResources.length, 'the globe chunks must actually be fetched').toBeGreaterThan(0);
    expect(globeDiscoveryMs, 'discovery time must be measurable').not.toBeNull();
});

function round(n: number | null): number | null {
    return n === null ? null : Math.round(n);
}
