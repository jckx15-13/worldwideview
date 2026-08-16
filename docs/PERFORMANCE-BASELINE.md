# Performance Baseline

> [!CAUTION]
> **The 8,339 MB peak-RSS figure below is WRONG. The measurement method was broken.**
> The original script summed RSS across *every* `node|next-` process on the host, not
> just the build's. A corrected run recorded **7,479 MB of pre-existing node processes**
> (33 PIDs — Claude Code itself, claude-desktop, a stray `next-server`) that were being
> counted as build memory.
>
> **The build's true peak is 3,575 MB** — comfortably under the 6,144 MB heap cap, not
> straining against it. Every conclusion drawn from "the build needs 8.3 GB" was wrong,
> including the inference that the `cpus: 2` pin was load-bearing OOM mitigation.
>
> Re-measured post-merge on 2026-08-15 at `4998e400` (Next 16.3.0). See
> **Post-merge results** below for current numbers; the tables further down are the
> superseded pre-merge run, kept for the record.

**Measured:** 2026-08-15, ~00:50 SGT
**Commit:** `115e94ce` on `fork/optimization-baseline`
**Host:** 12 cores · 15 GiB RAM · **0 B swap** · quiet machine (~8 GiB free at start)

Phase 39's exit artifact. Every number here was **measured**, not estimated.
Anything not measured is marked **UNMEASURED** rather than guessed. Phase 41
optimization claims must be validated against this file.

Reproduce with `scratchpad/measure-build.sh` (samples peak RSS across the
process tree; `/usr/bin/time` is **not installed** on this host).

---

## Post-merge results (current)

Measured at `4998e400`, Next **16.3.0**, after merging 9 upstream commits.
Method corrected to exclude pre-existing node PIDs.

| Metric | Pre-merge (16.2.11) | Post-merge (16.3.0) | Δ |
|---|---:|---:|---|
| Exit code | 0 | **0** | build succeeds |
| Wall clock | 371 s | **418 s** | +47 s (+12.7%) |
| Peak build RSS | ~~8,339 MB~~ *(bad method)* | **3,575 MB** | method fixed |
| Peak system used | 11,328 MB | 12,294 MB | +966 MB |
| Available RAM at start | ~8,000 MB | **4,616 MB** | harsher run |
| Client JS total | 8.1 MB | **8.1 MB** | unchanged |
| Chunk count | 103 | **102** | −1 |
| Largest chunk (Cesium+Draco) | 3,944.3 KB | **3,944.0 KB** | −0.3 KB |

**The Cesium prediction held exactly.** `cesium ^1.143.0`, `zustand ^5.0.14` and webpack
were untouched by the merge, so the dominant chunk was predicted to survive intact — it
moved by 0.3 KB. Next 16.3.0, react 19.2.8, resium 1.24.0 and lucide-react's five-minor
jump did **not** measurably move the bundle.

**The +47 s is not cleanly attributable.** The post-merge run had 4,616 MB available
versus ~8,000 MB for the baseline, so machine load is confounded with the Next upgrade.
Isolating it needs both runs on an equally quiet host.

**Still UNMEASURED: per-route First Load JS — and the stated remedy was wrong.**
Next 16.3.0 emits `Route (app) | Revalidate | Expire`. Earlier revisions of this
file blamed non-TTY output and prescribed "re-run in a TTY". **Tested 2026-08-16
and refuted:** a build under `script -qec` (real pseudo-TTY, exit 0, 118 s) still
emits **0** size columns. Next 16 removed the Size / First Load JS columns from
build output entirely; it is not a TTY-detection artifact. `@next/bundle-analyzer`
is not installed and `.next/app-build-manifest.json` is not emitted, so no
per-route attribution is currently obtainable without adding tooling.

---

## Phase 41 findings (measured 2026-08-16)

### The Cesium chunk is deferred, not on-demand — and its fetch is serialized

Resolves the question this file previously marked UNMEASURED. Three facts:

1. It **is** code-split: `7991.4dbf29c7192974e3.js` (3,944.0 KB, `Cesium` ×87,
   `draco` ×87) is one of the 6 files behind the `GlobeView` split point in
   `.next/react-loadable-manifest.json`, via
   `dynamic(() => import("@/core/globe/GlobeView"), { ssr: false })` at
   [AppShell.tsx:47](../src/components/layout/AppShell.tsx).
2. But `<GlobeView />` renders **unconditionally** at
   [AppShell.tsx:181](../src/components/layout/AppShell.tsx) — no conditional,
   no tab, no interaction gate. Every visitor downloads it.
3. The prerendered `/` HTML contains **0 references** to that chunk, and only 2
   `rel="preload"` hints, neither of them Cesium.

**Consequence:** the fetch is serialized — main bundle → hydrate → *then*
discover and fetch 3.9 MB. For time-to-interactive this is arguably worse than
shipping it in the initial bundle, where it would at least download in parallel.

**The obvious fix is the wrong one.** Gating the globe behind a click is not
viable: the globe *is* the product. The actionable target is the **waterfall,
not the render** — make the chunk discoverable earlier (preload / modulepreload)
so it downloads alongside hydration rather than after it. *(inferred: the saving
is unmeasured, and per-route First Load JS remains UNMEASURED.)*

### `.next` growth is dev artifacts, not production output

| Subdir | Size | Ships |
|---|---:|---|
| `.next/dev` | **2.9 GB** | no |
| `.next/cache` | 1.7 GB | no |
| `.next/standalone` | 143 MB | yes |
| `.next/server` | 34 MB | yes |
| `.next/static` | 8.2 MB | yes |

62% of the 4.7 GB is `.next/dev`. Production output is ~185 MB. The roadmap
framed this as build bloat; it is local disk hygiene — safely deleted, and
regenerated by `pnpm dev`.

### The Dockerfile constrains the `experimental.cpus` experiment

- `Dockerfile:81` builds with `--max_old_space_size=3072` — **half** the local
  6144, against a measured 3,575 MB peak build RSS.
- `Dockerfile:96` sets runtime `--max-old-space-size=768`.
- `Dockerfile:10` installs `pnpm@9.15.0`; `packageManager` declares 9.15.4.

Raising `cpus` above 2 is low-risk locally and **not** obviously safe in Docker.
Any such change must be validated by a Docker build, not only a local one.

### Type-checked build (Phase 40 exit)

| Metric | Value |
|---|---|
| Command | `pnpm build` with `ignoreBuildErrors` **deleted** |
| Exit code | **0** |
| Wall clock | **115 s** (warm `.next`) |
| Test suite | **1,212 / 1,212** green, 121 files |

`tsc --noEmit` returning 0 errors did **not** predict this. The one blocking
error lived in *generated* route types (`.next/types/app/locked/page.ts`,
TS2344) which `next build` checks and a bare `tsc` over source never sees.
`ignoreBuildErrors` was hiding a real defect, not nothing.

---

## Build (pre-merge, superseded)

| Metric | Value |
|---|---|
| Command | `pnpm build` (`next build --webpack`) |
| `NODE_OPTIONS` | `--max-old-space-size=6144` |
| **Exit code** | **0 — success** |
| **Wall clock** | **371 s** (6 m 11 s) |
| **Peak Node RSS** | **8,339 MB** |
| **Peak system used** | **11,328 MB** |
| `.next` before | 3.2 GB |
| `.next` after | 3.8 GB |

### The OOM did not reproduce

`PHASE3_SUMMARY.md` recorded: "Next.js full build (webpack) not tested — Build
process triggered OOM on this machine." **It completed successfully here.**

Peak Node RSS (8,339 MB) exceeds the 6,144 MB heap cap because the cap bounds
V8 old-space only — native memory, buffers and multiple worker processes sum
above it. Peak system usage of 11.3 GB against 15 GiB total with **0 B swap**
leaves ~3.7 GiB headroom, so the earlier OOM is entirely plausible under heavier
concurrent load. *(inferred: not reproduced, so the original report is neither
confirmed nor refuted — only shown to be non-deterministic.)*

**Implication for `next.config.ts`:** `experimental.cpus: 2` on a 12-core host,
alongside `memoryBasedWorkersCount: true` (both confirmed active in build
output), is a plausible OOM mitigation. Raising it is a **memory/time trade-off
to be measured against this file**, not a free win.

### Caveat that materially affects comparisons

`typescript.ignoreBuildErrors: true` means **this build skipped type-checking**.
371 s is *not* comparable to a type-checked build. Phase 40 removes that flag
and must re-baseline.

---

## Client bundle

| Metric | Value |
|---|---|
| Total client JS (`.next/static/chunks`) | **8.1 MB** across **103 files** |
| Cesium public assets (`public/cesium`) | **7.8 MB** |

### Largest chunks

| Size | Chunk |
|---:|---|
| **3,944.3 KB** | `6360.5719be70b00caaf1.js` |
| 848.5 KB | `7429-129f1f71ed556e5b.js` |
| 499.9 KB | `e217e3ef.5a2d8a58f84d70cb.js` |
| 366.8 KB | `6784.747543a4737bea61.js` |
| 235.9 KB | `597f971b.ae6b557e841f6996.js` |
| 217.7 KB | `8562-5527eecb01242f2e.js` |
| 195.2 KB | `a3376982-664228901b562df5.js` |
| 185.2 KB | `framework-9be85304083d3450.js` |
| 180.1 KB | `app/page-2c48a2b380d89ac3.js` |
| 134.8 KB | `main-0ea4dda63b4acab6.js` |
| 110.0 KB | `polyfills-42372ed130431b0a.js` |
| 97.3 KB | `3df8d95d-89604513e4ef3207.js` |

**One chunk is 48% of all client JS.** Content markers in
`6360.5719be70b00caaf1.js`: `Cesium` ×87, `draco` ×87, `Ion` ×8,
`CesiumWidget` ×1 — CesiumJS plus the Draco decoder.

That chunk is referenced from `app/page-*.js`. **UNMEASURED:** whether it loads
eagerly on first paint or is an async/dynamic chunk. A grep cannot distinguish
those, and the distinction decides whether this is the top Phase 41 target or a
non-issue. **Establish this before acting on it.**

---

## Tests

| Metric | Value |
|---|---|
| Suite (pre-merge) | 1,207 tests · 121 files |
| Suite (post-merge) | **1,212 tests · 121 files** (+5 from upstream) |
| Wall clock (quiet machine) | ~18–20 s warm, ~39 s cold |
| Wall clock (loaded machine) | **81 s — and 2 tests fail** |

### Flakiness root cause — RESOLVED

Phase 39 left this **OPEN**: 7 green runs on a quiet machine, 2 failures under load,
error text never captured. Parallelism was tested and **refuted**.

Reproduced on 2026-08-15 immediately after a `pnpm install` + `tsc` run, i.e. on a
loaded machine, with the error text finally captured:

```
FAIL  src/lib/better-auth.test.ts > Better Auth instance > exports an auth instance
Error: Hook timed out in 10000ms.
 ❯ src/lib/better-auth.test.ts:79:1   (beforeEach)
```

**Cause: a fixed 10,000 ms `hookTimeout` (vitest's default), not a logic defect.**
The `beforeEach` at [better-auth.test.ts:79](../src/lib/better-auth.test.ts) took
40,362 ms under load. `src/app/api/mcp/transport-spike.test.ts` fails the same way.
Note `environment 336.66 s` in that run versus a 71 s total — environment setup, not
test logic, is what dilates. This confirms the Phase 39 load-dependent timing
hypothesis and supplies the mechanism it lacked.

**Fix:** raise `hookTimeout` in `vitest.config.ts`, or make that `beforeEach` cheaper.
Until then **any CI gate on this suite will flake on a busy runner** — and the two
affected files are precisely the auth-adjacent ones Phase 39 fingered.

---

## UNMEASURED — gaps in this baseline

Recorded so nobody mistakes absence for zero:

1. **Per-route First Load JS.** Next.js 16 emits no size table at all — the
   columns are `Route (app) | Revalidate | Expire`. The chunk sizes above are the
   emitted-artifact substitute, not Next's per-route attribution.
   **The TTY theory is refuted** (see above): a real pseudo-TTY build still gives
   `grep -c 'kB|MB'` = 0. Closing this gap requires *adding* tooling —
   `@next/bundle-analyzer` (not currently a dependency) — not re-running the build
   differently. That is a Phase 41 task, not a measurement retry.
2. **Whether the 3.9 MB Cesium chunk is eager or lazy.** Decides its priority.
3. **Runtime performance.** No frame timings, no live-data profiling, no
   DataBus → Zustand → render measurements. Every Phase 41 runtime hypothesis is
   currently *inferred from reading code*.
4. **Cold-cache build.** 371 s was measured with a warm 3.2 GB `.next`.
5. **Dev-server boot time.**
6. **Type-checked build time** (blocked on Phase 40).
