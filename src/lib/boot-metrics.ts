/**
 * Boot-phase instrumentation via the browser Performance Timeline.
 *
 * Why this exists: before this, the only readiness signal the app exposed was
 * `data-testid="app-ready"`, which `useBootSequence` sets on a **hardcoded
 * 3,500 ms timer** (`DELAY.done`) after the globe reports its tiles. That is a
 * staggered entrance animation, not a measure of work completing — so both the
 * E2E suite's readiness wait and the `platform-boot` analytics event carry 3.5 s
 * of pure animation inside them and cannot answer "how long did plugins take?".
 *
 * These marks measure actual work. They land on the Performance Timeline, so
 * they are readable three ways with no extra plumbing: by
 * `tests/perf/globe-load.perf.spec.ts`, by devtools, and by any RUM agent in
 * production.
 *
 * Contract: never throws, never returns a value, no-ops outside the browser.
 * Instrumentation that can break the thing it measures is worse than none.
 */

const PREFIX = "wwv";

function unavailable(): boolean {
    return typeof performance === "undefined" || typeof performance.mark !== "function";
}

const seen = new Set<string>();

/**
 * Records a single timestamp the FIRST time a name is seen, ignoring repeats.
 *
 * Plugins poll on an interval, so `dataUpdated` fires repeatedly for the same
 * plugin forever. What matters for startup is when each feed goes live *once*;
 * the mark's `startTime` (ms from navigation start) is that answer. Later
 * emissions are steady-state traffic, not boot.
 */
export function bootMarkOnce(name: string): void {
    if (unavailable() || seen.has(name)) return;
    seen.add(name);
    try {
        performance.mark(`${PREFIX}:${name}`);
    } catch {
        // Never let instrumentation break a data path.
    }
}

/** Opens a measurement window. Safe to call for a name that is never closed. */
export function bootMarkStart(name: string): void {
    if (unavailable()) return;
    try {
        performance.mark(`${PREFIX}:${name}:start`);
    } catch {
        // A full buffer or a duplicate name must not take the boot path down.
    }
}

/**
 * Closes the window opened by `bootMarkStart(name)` and emits a `measure`
 * entry named `wwv:<name>` whose `duration` is the elapsed time.
 */
export function bootMarkEnd(name: string): void {
    if (unavailable()) return;
    try {
        performance.mark(`${PREFIX}:${name}:end`);
        performance.measure(`${PREFIX}:${name}`, `${PREFIX}:${name}:start`, `${PREFIX}:${name}:end`);
    } catch {
        // measure() throws if the start mark is missing — e.g. an error path that
        // reached the end without the start. Losing one sample is acceptable;
        // propagating is not.
    }
}
