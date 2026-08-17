// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import { globePreloadHrefs, __resetGlobePreloadCache } from "./globe-preload";

const GLOBE_KEY = "components/layout/AppShell.tsx -> @/core/globe/GlobeView";

function mockManifest(manifest: unknown) {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(manifest));
}

describe("globePreloadHrefs", () => {
    beforeEach(() => {
        __resetGlobePreloadCache();
        vi.restoreAllMocks();
    });

    it("maps manifest chunk paths to /_next/ URLs", () => {
        mockManifest({
            [GLOBE_KEY]: ["static/chunks/7991.abc.js", "static/chunks/8917.def.js"],
        });
        expect(globePreloadHrefs()).toEqual([
            "/_next/static/chunks/7991.abc.js",
            "/_next/static/chunks/8917.def.js",
        ]);
    });

    it("accepts the object form of a manifest entry", () => {
        mockManifest({ [GLOBE_KEY]: { files: ["static/chunks/7991.abc.js"] } });
        expect(globePreloadHrefs()).toEqual(["/_next/static/chunks/7991.abc.js"]);
    });

    it("drops non-JS assets", () => {
        // Next already emits stylesheet links for dynamic imports; duplicating them
        // as script preloads would make the browser fetch CSS with the wrong `as`.
        mockManifest({
            [GLOBE_KEY]: ["static/chunks/7991.abc.js", "static/css/globe.abc.css"],
        });
        expect(globePreloadHrefs()).toEqual(["/_next/static/chunks/7991.abc.js"]);
    });

    it("returns empty when the manifest has no GlobeView entry", () => {
        mockManifest({ "components/video/HlsPlayer.tsx -> hls.js": ["static/chunks/x.js"] });
        expect(globePreloadHrefs()).toEqual([]);
    });

    it("returns empty rather than throwing when the manifest is unreadable", () => {
        // The degradation path that matters: a missing manifest must cost a preload,
        // never the root route. Before `pnpm build` this file does not exist.
        vi.spyOn(fs, "readFileSync").mockImplementation(() => {
            throw new Error("ENOENT");
        });
        expect(() => globePreloadHrefs()).not.toThrow();
        expect(globePreloadHrefs()).toEqual([]);
    });

    it("returns empty rather than throwing on malformed JSON", () => {
        vi.spyOn(fs, "readFileSync").mockReturnValue("{ not json");
        expect(globePreloadHrefs()).toEqual([]);
    });

    it("reads the manifest once and caches the result", () => {
        const spy = vi.spyOn(fs, "readFileSync").mockReturnValue(
            JSON.stringify({ [GLOBE_KEY]: ["static/chunks/7991.abc.js"] }),
        );
        globePreloadHrefs();
        globePreloadHrefs();
        globePreloadHrefs();
        // Called per render otherwise — this runs on every request to `/`.
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("caches the empty result too, so a missing manifest is not re-read per request", () => {
        const spy = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
            throw new Error("ENOENT");
        });
        globePreloadHrefs();
        globePreloadHrefs();
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
