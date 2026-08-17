import fs from "fs";
import path from "path";

/**
 * Resolves the built chunk URLs for the `GlobeView` dynamic import so the globe
 * route can advertise them to the browser's preload scanner.
 *
 * The problem this solves, measured 2026-08-17 by tests/perf/globe-load.perf.spec.ts:
 * `GlobeView` is loaded via `next/dynamic(..., { ssr: false })` in
 * src/components/layout/AppShell.tsx. `ssr: false` means the component never
 * renders on the server, so Next emits no `<link rel="preload">` for its chunks
 * and the prerendered HTML contains no reference to them. The browser therefore
 * cannot discover 1.34 MB of compressed JS until React has hydrated and rendered
 * `<GlobeView />` — first JS request landed at 19 ms, the globe chunks at 327 ms.
 * That 308 ms gap is idle network on the critical path of the one component that
 * *is* the product.
 *
 * Hashed filenames rule out hardcoding, so the mapping is read from
 * `.next/react-loadable-manifest.json`, the same artifact Next's own runtime uses.
 *
 * Failure is silent and total by design: any problem yields `[]`, which restores
 * exactly the pre-existing behaviour. A missing preload is a slower page; a
 * throwing root route is an outage.
 */

let cached: string[] | null = null;

export function globePreloadHrefs(): string[] {
    if (cached !== null) return cached;

    try {
        const manifestPath = path.join(process.cwd(), ".next", "react-loadable-manifest.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<
            string,
            { files?: string[] } | string[]
        >;

        // Key looks like "components/layout/AppShell.tsx -> @/core/globe/GlobeView".
        // Matching on the module name survives the AppShell path changing.
        const key = Object.keys(manifest).find((k) => k.includes("GlobeView"));
        if (!key) {
            cached = [];
            return cached;
        }

        const entry = manifest[key];
        const files = Array.isArray(entry) ? entry : (entry.files ?? []);
        // CSS is already handled by Next; only the JS chunks are undiscoverable.
        cached = files.filter((f) => f.endsWith(".js")).map((f) => `/_next/${f}`);
    } catch {
        cached = [];
    }

    return cached;
}

/** Test-only: clears the module-level cache between cases. */
export function __resetGlobePreloadCache(): void {
    cached = null;
}
