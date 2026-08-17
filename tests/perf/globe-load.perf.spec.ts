import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Measures the client-side load waterfall for the globe in PRODUCTION mode.
 *
 * Why this exists: Next 16 removed the per-route "First Load JS" columns from
 * build output, and the only other Playwright configs run `pnpm dev`. Between
 * those two facts the project had no way to observe what a real user downloads,
 * so every bundle claim in docs/PERFORMANCE-BASELINE.md was inference. This
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

    // proxy.ts gates `/` on cookie PRESENCE only. No DB, no real session needed.
    await context.addCookies([
        {
            name: 'better-auth.session_token',
            value: 'perf-harness-not-a-real-session',
            domain: 'localhost',
            path: '/',
        },
    ]);

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
        new MutationObserver(stamp).observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
        });
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

    // Let any post-hydration chunk fetches settle before sampling.
    await page.waitForLoadState('networkidle').catch(() => { });

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
