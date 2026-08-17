// @vitest-environment node
//
// The suite default is jsdom, which defines `window` — that steers
// reportToDiagnosticEngine down the navigator.sendBeacon branch. The server
// path (process.env.DIAGNOSTIC_ENGINE_URL -> fetch) is the only one currently
// reachable in production, since nothing ever assigns window.ENV, so this file
// pins that path and needs `window` genuinely absent.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { redactMetadata, reportToDiagnosticEngine, __resetBackoffForTests } from "./index";

// Every secret-looking value below is synthetic.

describe("redactMetadata", () => {
    it("redacts by substring, not exact key match", () => {
        // The regression this pins: an exact-match key set let every one of
        // these through while the payload still claimed `sanitized: true`.
        const out = redactMetadata({
            apiKey: "sk-test-fake",
            accessToken: "at-fake",
            authorization: "Bearer fake",
            cookie: "sid=fake",
            privateKey: "-----BEGIN FAKE-----",
            jwt: "a.b.c",
        });
        for (const v of Object.values(out)) expect(v).toBe("[REDACTED]");
    });

    it("leaves innocuous keys intact", () => {
        expect(redactMetadata({ userId: 42, route: "/globe" }))
            .toEqual({ userId: 42, route: "/globe" });
    });

    it("recurses into nested objects and arrays", () => {
        const out = redactMetadata({
            outer: { inner: { password: "hunter2" } },
            list: [{ secret: "s3cr3t" }],
        });
        const outer = out.outer as Record<string, Record<string, string>>;
        const list = out.list as Array<Record<string, string>>;
        expect(outer.inner.password).toBe("[REDACTED]");
        expect(list[0].secret).toBe("[REDACTED]");
    });

    it("redacts bearer tokens inside string values", () => {
        const out = redactMetadata({ note: "called with Bearer abc123def" });
        expect(out.note).toBe("called with Bearer [REDACTED]");
    });

    it("bounds recursion depth instead of hanging on cycles", () => {
        const cyclic: Record<string, unknown> = { name: "root" };
        cyclic.self = cyclic;
        expect(() => redactMetadata(cyclic)).not.toThrow();
    });

    it("returns an empty object for non-object input", () => {
        expect(redactMetadata(null as unknown as Record<string, unknown>)).toEqual({});
    });
});

describe("reportToDiagnosticEngine", () => {
    const ORIGINAL = process.env.DIAGNOSTIC_ENGINE_URL;

    beforeEach(() => {
        __resetBackoffForTests();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        if (ORIGINAL === undefined) delete process.env.DIAGNOSTIC_ENGINE_URL;
        else process.env.DIAGNOSTIC_ENGINE_URL = ORIGINAL;
    });

    it("no-ops when the engine URL is unset", () => {
        delete process.env.DIAGNOSTIC_ENGINE_URL;
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        reportToDiagnosticEngine({ message: "boom" }, "test");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects a non-http scheme rather than posting to it", () => {
        // Guards the exfiltration path: the destination is attacker-controllable
        // if `window.ENV` is ever wired up, so the scheme must be checked.
        process.env.DIAGNOSTIC_ENGINE_URL = "javascript:alert(1)";
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        reportToDiagnosticEngine({ message: "boom" }, "test");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects a malformed URL", () => {
        process.env.DIAGNOSTIC_ENGINE_URL = "not-a-url";
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        reportToDiagnosticEngine({ message: "boom" }, "test");
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("posts a redacted payload to the ingest endpoint", () => {
        process.env.DIAGNOSTIC_ENGINE_URL = "https://diagnostics.example.test";
        const fetchSpy = vi.spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(null, { status: 202 }));

        reportToDiagnosticEngine(
            { message: "failed with Bearer abc123", metadata: { apiKey: "sk-test-fake" } },
            "unit-test",
        );

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(String(url)).toBe("https://diagnostics.example.test/api/diagnostics/ingest");

        const body = JSON.parse(String((init as RequestInit).body));
        expect(body.message).toBe("failed with Bearer [REDACTED]");
        expect(body.metadata.apiKey).toBe("[REDACTED]");
        expect(body.sanitized).toBe(true);
        expect(body.source).toBe("unit-test");
        expect(typeof body.timestamp).toBe("number");
        expect(body.id).toMatch(/^wwv-\d+-[a-z0-9]+$/);
    });

    it("engages backoff on a non-ok response, suppressing the next report", async () => {
        // The original bug: fetch resolves on 4xx/5xx, so a dead engine was
        // hammered forever because the backoff never armed.
        process.env.DIAGNOSTIC_ENGINE_URL = "https://diagnostics.example.test";
        const fetchSpy = vi.spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response(null, { status: 500 }));

        reportToDiagnosticEngine({ message: "first" }, "test");
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

        reportToDiagnosticEngine({ message: "second" }, "test");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
