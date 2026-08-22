# World Wide View Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut transfer bytes, main-thread stalls, memory ceilings and on-disk footprint for World Wide View without removing a single user-facing capability.

**Architecture:** Every task follows measure → change → re-measure → commit. The project's own `docs/FORK-OPTIMIZATION-REPORT.md` §7 lists eight claims that were recorded as fact and turned out wrong; this plan treats an unmeasured optimization as an unstarted one. Work is ordered by measured value per unit of risk: disk hygiene (zero risk) → network caching and compression (no code-path change) → payload shape → main-thread scheduling → memory ceilings → build tooling.

**Tech Stack:** Next.js 16.3 (App Router, `output: "standalone"`, webpack), React 19.2, CesiumJS 1.143 via resium, zustand, Playwright (perf harness), Vitest, pnpm 9.15.4 workspaces, Docker.

---

## The invariant

**Nothing in this plan may change what a user can see or do.** Every task that touches rendering, data or routing carries an explicit parity check. If a parity check cannot be made to pass, the task is reverted, not weakened.

Four things this plan deliberately does **not** do:

- Touch `local-seeders/`. It is an independent git clone with its own remote, gitignored at `.gitignore:146`. A commit there goes to a different upstream, and its 356 MB is not this project's to reclaim. (`CLAUDE.md` §3 groups `local-plugins/` with it, but that directory is currently an empty placeholder — 2 tracked files, no `.git`, not ignored. Neither is touched here.)

- Delete `public/military_bases.geojson` or `public/cameras_geojson.json` despite a repo-wide grep finding no importer. Absence of a static reference is not absence of a consumer — plugin manifests build paths as strings at runtime. Task 8 investigates; it does not delete.
- Split the Cesium chunk on a guess. §10 of the report leaves the `draco ×87` question open. Task 9 answers it before anything acts on it.
- Lower visual fidelity to win bytes. Task 10's quantization is bounded at a precision below one screen pixel at maximum zoom.

---

## Measured starting state

All figures below were measured on 2026-08-17 in this working tree. They are the baseline every task compares against.

### Disk

| Path | Size | Category |
|---|---:|---|
| `worldwideview/node_modules` | 3.2 GB | regenerable — `pnpm install` |
| `worldwideview/.next` | 2.1 GB | regenerable — `pnpm build` |
| `worldwideview/local-seeders` | 356 MB | **not this repo** — see below |
| `worldwideview/.git` | 37 MB | tracked |
| `worldwideview/public` | 23 MB | tracked |
| `worldwideview/src` | 14 MB | tracked |
| `worldwideview/coverage` | 7.3 MB | regenerable — `vitest --coverage` |
| `worldwideview/graphify-out` | 6.8 MB | regenerable |
| **`worldwideview/` total** | **5.7 GB** | |
| `world-wide-view/` tree total | 7.1 GB | |

Across all five workspaces in `world-wide-view/`, `node_modules` accounts for ~4.5 GB.

**`local-seeders/` is not this project's weight.** Per `CLAUDE.md` §3 it is an
independent git repo cloned inside this one with its own remote, and
`git check-ignore -v` confirms it is ignored here at `.gitignore:146`. Its
356 MB cannot be reduced by any change in this repository, and no task in this
plan touches it.

`CLAUDE.md` §3 groups `local-plugins/` with it, but that is not the current
state: `local-plugins/` has no `.git` directory, holds two tracked files
(`.gitkeep`, `README.md`), and is **not** gitignored. It is the mount point a
developer clones into, not a clone. It contributes 128 KB and is irrelevant to
size work either way.

**Breakdown of the 5.7 GB:** ~5.3 GB regenerable, 356 MB belonging to a separate
repository, and **~76 MB that is actually this project** (`.git`, `public`,
`src`, `docs`, `packages`, `tests`, `scripts`).

The headline "7.1 GB" is therefore ~99% artifacts and foreign repos. This matters
for expectation-setting: Phase 1 reclaims real disk, but there is no version of
this project that is small on disk while `node_modules` exists.

### Static data payload

| File | raw | gzip -6 | brotli -11 |
|---|---:|---:|---:|
| `public/borders.geojson` | 4,045,883 | 1,080,324 | 828,655 |
| `public/military_bases.geojson` | 6,656,037 | 645,540 | 417,212 |
| `public/cameras_geojson.json` | 1,935,913 | 199,670 | 145,464 |
| `public/public-cameras.json` | 1,818,577 | 153,049 | 102,540 |
| **Total** | **14,456,410** | **2,078,583** | **1,493,871** |

`public/cesium/` is a further 7.8 MB.

### Runtime and bundle (from `docs/FORK-OPTIMIZATION-REPORT.md`, verified at `ea081704`)

| Metric | Value |
|---|---:|
| Globe chunk discovery | 19 ms |
| Preload gap | 0 ms |
| Globe chunk requests | 6 |
| Globe bytes (encoded) | 1,342,901 |
| Total JS requests | 50 |
| Total JS bytes | 2,073,831 |
| Largest chunk (Cesium+Draco) | 3,944.0 KB |
| `size-limit` | 1.76 MB / 2 MB brotlied |
| Peak build RSS | 3,575 MB |

### Known gaps in `next.config.ts`

- `headers()` (lines 24–85) sets seven security headers and **zero** `Cache-Control` headers. Every static asset therefore inherits Next's default for `public/`, which is `public, max-age=0`.
- `env.CESIUM_BASE_URL` is the unversioned literal `"/cesium"` (line 93), so Cesium asset URLs do not change when the Cesium version does.

### Memory ceilings

- `docker/Dockerfile:81` — build runs under `--max_old_space_size=3072`, against a measured peak build RSS of 3,575 MB.
- `docker/Dockerfile:96` — runtime runs under `--max-old-space-size=768`.

---

## File Structure

**Created:**

- `tests/perf/static-assets.perf.spec.ts` — measures transfer size, `content-encoding` and `cache-control` for every asset over 100 KB. Owns the network-layer baseline.
- `tests/perf/heap.perf.spec.ts` — measures JS heap after globe idle. Owns the memory baseline.
- `scripts/quantize-geojson.mjs` — build-time coordinate precision reduction. Pure function over a GeoJSON file; no app imports.
- `scripts/quantize-geojson.test.mjs` — unit tests for the above.
- `docs/OPTIMIZATION-LEDGER.md` — one row per task: metric, before, after, commit. The artifact that stops this plan repeating §7.

**Modified:**

- `next.config.ts` — `headers()` gains cache rules; `env.CESIUM_BASE_URL` becomes version-derived.
- `scripts/copy-cesium.mjs` — emits into a version-scoped directory.
- `src/core/globe/useBorders.ts:80` — loads a quantized asset; `console.time` calls guarded.
- `docker/Dockerfile:81`, `docker/Dockerfile:96` — heap caps set from measurements.
- `package.json` — new `clean:all`, `perf:assets`, `data:quantize` scripts; `prebuild` gains quantization; **semver bump on every commit** (see below).
- `.gitignore` — one line for the quantized asset. `/public/cesium/` is already covered at `.gitignore:130`.

---

## Commit protocol

`CLAUDE.md` §5 requires a semver bump in `package.json` before **every** commit,
and `CLAUDE.md` §12 requires Conventional Commits. Every commit step in this plan
is therefore two actions, not one:

1. Bump `version` in `package.json` — `feat:` → minor, `fix:`/`refactor:`/`perf:`/`chore:`/`docs:`/`test:` → patch. The version read `2.66.1` when this plan was written and `2.67.0` a few hours later with `package.json` clean in git, so **read the current value before bumping** rather than trusting this line.
2. `git add` the listed files **plus `package.json`**, then commit with the given message.

Every `git add` line in this plan omits `package.json` for readability. **Add it
every time.** For example, Task 1's commit becomes:

```bash
git add tests/perf/static-assets.perf.spec.ts package.json docs/OPTIMIZATION-LEDGER.md
git commit -m "test(perf): measure transfer size and cache headers for large assets"
```

where `package.json` now carries both the new script and version `2.66.2`.

> **Known gap:** `CLAUDE.md` §10 names `/commit` at
> `.agents/skills/commit/SKILL.md` as required before every commit, but that file
> does not exist in this tree (`.agents/skills/` contains nine skills, none named
> `commit`). `/remember` and `/pr-review` are likewise listed and likewise
> absent. The rule above is this plan's inline substitute. Raise the missing
> skill with the repo owner rather than assuming the requirement is void —
> `CLAUDE.md` §5 states the semver requirement independently of the skill.

Additionally, per `CLAUDE.md` §12, `pnpm test` and `pnpm build` must pass before
any merge. The Final Gate section enforces this.

---

## Phase 0 — Measurement

Nothing after this phase is allowed to claim an improvement it cannot show.

### Task 1: Static-asset network baseline

Answers the question the whole network phase depends on: **does the server already compress `public/` responses, and what does it say about caching?** Next's `compress` option defaults to `true`, so gzip may already be applied — in which case Task 7's win is 585 KB, not 12.4 MB. Do not guess this.

**Files:**
- Create: `tests/perf/static-assets.perf.spec.ts`
- Modify: `package.json` (scripts)
- Create: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Write the failing test**

Create `tests/perf/static-assets.perf.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Records transfer size, content-encoding and cache-control for every response
 * over 100 KB on a cold load of `/`.
 *
 * Why this exists: next.config.ts sets no Cache-Control headers, so `public/`
 * assets inherit `public, max-age=0`. Whether that means a second visit
 * re-downloads 22 MB or merely revalidates it depends on ETag behaviour we have
 * never observed. This turns that into a number before anything is changed.
 */

const OUT_DIR = path.resolve(process.cwd(), 'playwright/output/perf');
const OUT_FILE = path.join(OUT_DIR, 'static-assets.json');
const MIN_BYTES = 100 * 1024;

interface AssetRow {
    url: string;
    status: number;
    transferBytes: number;
    contentEncoding: string | null;
    cacheControl: string | null;
}

test('records transfer size and cache headers for large assets', async ({ page }) => {
    const rows: AssetRow[] = [];

    page.on('response', async (res) => {
        const headers = await res.allHeaders();
        const len = Number(headers['content-length'] ?? 0);
        if (len < MIN_BYTES) return;
        rows.push({
            url: new URL(res.url()).pathname,
            status: res.status(),
            transferBytes: len,
            contentEncoding: headers['content-encoding'] ?? null,
            cacheControl: headers['cache-control'] ?? null,
        });
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const total = rows.reduce((n, r) => n + r.transferBytes, 0);
    fs.writeFileSync(OUT_FILE, JSON.stringify({ totalBytes: total, assets: rows }, null, 2));

    // Baseline assertion: we must observe at least one large asset, otherwise the
    // harness silently measured nothing and every later comparison is vacuous.
    expect(rows.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Add the script**

In `package.json`, add to `scripts` immediately after the existing `"perf:only"` entry:

```json
"perf:assets": "playwright test tests/perf/static-assets.perf.spec.ts --config=playwright.perf.config.ts",
```

- [ ] **Step 3: Run it and capture the baseline**

```bash
pnpm build && pnpm perf:assets
```

Expected: PASS, and `playwright/output/perf/static-assets.json` written.

- [ ] **Step 4: Create the ledger and record the answer**

Create `docs/OPTIMIZATION-LEDGER.md`:

```markdown
# Optimization Ledger

One section per task. `after` is filled in only when re-measured. A blank
`after` means the task's claim is unverified — say so rather than leaving it
blank.

## Task 1 — network baseline

| Asset | transferBytes | contentEncoding | cacheControl |
|---|---:|---|---|
| `/borders.geojson` | | | |
| `/cesium/...` | | | |

Total bytes over 100 KB on a cold load of `/`:
```

Fill the table from `playwright/output/perf/static-assets.json`. The `contentEncoding` and `cacheControl` values decide the size of the Task 6 and Task 7 wins.

- [ ] **Step 5: Commit**

```bash
git add tests/perf/static-assets.perf.spec.ts package.json docs/OPTIMIZATION-LEDGER.md
git commit -m "test(perf): measure transfer size and cache headers for large assets"
```

---

### Task 2: Heap baseline

`docker/Dockerfile:96` caps runtime heap at 768 MB. Cesium plus a parsed 4 MB GeoJSON is a plausible way to exceed that, and an exceeded cap is a hard crash. Measure before touching the number.

**Files:**
- Create: `tests/perf/heap.perf.spec.ts`
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Write the failing test**

Create `tests/perf/heap.perf.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Measures JS heap after the globe has settled.
 *
 * Why this exists: docker/Dockerfile:96 runs the server under
 * --max-old-space-size=768. That ceiling has never been compared against actual
 * usage, so it is unknown whether it is generous or one border layer away from
 * an OOM kill. "Crashes less often" cannot be worked on until this is a number.
 */

const OUT_DIR = path.resolve(process.cwd(), 'playwright/output/perf');
const OUT_FILE = path.join(OUT_DIR, 'heap.json');

test('records heap after globe idle', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // Let Cesium finish its first render passes before sampling.
    await page.waitForTimeout(5000);

    const heap = await page.evaluate(() => {
        const m = (performance as unknown as {
            memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
        }).memory;
        return m
            ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit }
            : null;
    });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({ heap }, null, 2));

    // performance.memory is Chromium-only. The perf config runs Chromium, so a
    // null here means the API moved, not that the browser lacks it.
    expect(heap).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it passes and writes output**

```bash
pnpm exec playwright test tests/perf/heap.perf.spec.ts --config=playwright.perf.config.ts
```

Expected: PASS, `playwright/output/perf/heap.json` written with a non-null `heap`.

- [ ] **Step 3: Record the baseline**

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 2 — client heap baseline

| Metric | Before | After |
|---|---:|---:|
| `heap.used` (bytes) | | |
| `heap.limit` (bytes) | | |

This is the **client** heap. The 768 MB cap in `docker/Dockerfile:96` is on the
**server** — a different process. Server heap is measured in Task 12.
```

Fill in `heap.used` and `heap.limit` from `playwright/output/perf/heap.json`.

- [ ] **Step 4: Commit**

```bash
git add tests/perf/heap.perf.spec.ts docs/OPTIMIZATION-LEDGER.md
git commit -m "test(perf): measure client JS heap after globe idle"
```

---

## Phase 1 — Disk footprint

Zero risk, immediate, and it addresses the "project doesn't take such a big size" ask directly. **~2.1 GB is reclaimable in one command.**

### Task 3: `clean:all` script

The existing `clean` script only removes `.next`. Coverage, graphify output and Playwright artifacts accumulate unbounded.

**Files:**
- Modify: `package.json`
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Measure current reclaimable size**

```bash
du -sh .next coverage graphify-out playwright/output 2>/dev/null
```

Append the total to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 3 — reclaimable artifacts

| Metric | Before | After |
|---|---:|---:|
| `.next` + `coverage` + `graphify-out` + `playwright/output` | | |
```

- [ ] **Step 2: Replace the `clean` script**

In `package.json`, replace the existing `"clean"` line with these two:

```json
"clean": "node -e \"const fs=require('fs');fs.rmSync('.next',{recursive:true,force:true})\"",
"clean:all": "node -e \"const fs=require('fs');for(const d of ['.next','coverage','graphify-out','playwright/output','.stryker-tmp'])fs.rmSync(d,{recursive:true,force:true})\"",
```

- [ ] **Step 3: Verify it reclaims what was measured**

```bash
pnpm clean:all && du -sh --exclude=node_modules .
```

Expected: the directories listed in Step 1 no longer exist; the total shrinks by the Step 1 figure. Record it as `after`.

- [ ] **Step 4: Verify nothing was lost**

```bash
pnpm build
```

Expected: exit 0. Everything removed was regenerable; a clean build proves it.

- [ ] **Step 5: Commit**

```bash
git add package.json docs/OPTIMIZATION-LEDGER.md
git commit -m "chore: add clean:all to reclaim all regenerable artifacts"
```

---

### Task 4: Establish the true multi-workspace footprint

~4.5 GB of `node_modules` sits across five sibling workspaces. pnpm's content-addressable store makes most of that hard links rather than copies — but `du` counts a hard link once per path it encounters, so the 4.5 GB figure may be substantially double-counted. Verify before claiming a saving.

**Files:**
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Check whether the workspaces share one store**

```bash
cd /home/admin/Documents/silver-wolf-vi/world-wide-view && for d in worldwideview worldwideview-web worldwideview-plugins worldwideview-marketplace wwv-data-engine; do echo -n "$d: "; (cd "$d" && pnpm store path 2>/dev/null || echo "no pnpm"); done
```

- [ ] **Step 2: Measure with hard links counted once**

```bash
cd /home/admin/Documents/silver-wolf-vi/world-wide-view && du -sh . && du -shl . 2>/dev/null | sed 's/^/with-links-followed: /'
```

- [ ] **Step 3: Prune packages no workspace references**

```bash
cd /home/admin/Documents/silver-wolf-vi/world-wide-view/worldwideview && pnpm store prune
```

This is safe: anything pruned is re-fetched on the next install.

- [ ] **Step 4: Re-measure and record**

```bash
cd /home/admin/Documents/silver-wolf-vi/world-wide-view && du -sh .
```

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 4 — multi-workspace footprint

| Metric | Before | After |
|---|---:|---:|
| `world-wide-view/` total (`du -sh`) | 7.1 GB | |
| Store shared across all 5 workspaces? | | |

If all five workspaces print the same `pnpm store path`, the ~4.5 GB of
`node_modules` is largely hard-linked and the headline figure overstates real
disk use. Record which it is — an overstated baseline invites a fake win.
```

- [ ] **Step 5: Commit**

```bash
git add docs/OPTIMIZATION-LEDGER.md
git commit -m "docs: record pnpm store topology and true on-disk footprint"
```

---

## Phase 2 — Network

The largest measured user-facing win available, and it changes no code path.

### Task 5: Version-scope the Cesium asset directory

`public/cesium/` is 7.8 MB served from a path that never changes across Cesium upgrades. Immutable caching is only safe once the URL carries the version — otherwise an upgrade ships stale workers to every returning user. This task makes Task 6's `immutable` rule correct rather than dangerous.

**Files:**
- Modify: `scripts/copy-cesium.mjs`
- Modify: `next.config.ts` (imports, `env` block at line 92–94, `DefinePlugin` at lines 105–109)
- Modify: `.gitignore`

- [ ] **Step 1: Read the current copy script**

```bash
cat scripts/copy-cesium.mjs
```

Note the destination path constant it writes to — the next step changes only that.

- [ ] **Step 2: Make the destination version-scoped**

In `scripts/copy-cesium.mjs`, add below the existing imports (after line 3):

```javascript
import { createRequire } from 'node:module';
```

Then replace line 8:

```javascript
const targetBase = path.join(root, 'public/cesium');
```

with:

```javascript
const cesiumVersion = createRequire(import.meta.url)('cesium/package.json').version;
const targetBase = path.join(root, 'public/cesium', cesiumVersion);
```

Nothing else in the file changes — `copyDir` and the `folders` loop are unaffected.

- [ ] **Step 3: Point the app at the versioned path**

In `next.config.ts`, add this import below the existing imports at the top of the file:

```typescript
import { createRequire } from "node:module";
```

Then, above the `const nextConfig: NextConfig = {` line, add:

```typescript
const cesiumVersion = createRequire(import.meta.url)("cesium/package.json").version;
const CESIUM_BASE_PATH = `/cesium/${cesiumVersion}`;
```

Replace the `env` block:

```typescript
  env: {
    CESIUM_BASE_URL: "/cesium",
  },
```

with:

```typescript
  env: {
    CESIUM_BASE_URL: CESIUM_BASE_PATH,
  },
```

And replace the `DefinePlugin` call so the compile-time literal matches:

```typescript
      config.plugins?.push(
        new webpack.DefinePlugin({
          CESIUM_BASE_URL: JSON.stringify(CESIUM_BASE_PATH),
        })
      );
```

- [ ] **Step 4: Confirm the generated directory is already ignored**

```bash
git check-ignore -v public/cesium/
```

Expected: `.gitignore:130:/public/cesium/	public/cesium/`

The rule already covers the versioned subdirectory, because the pattern matches
the parent. **No `.gitignore` change is needed.** Delete any stale
`public/cesium/*` content left from the unversioned layout:

```bash
rm -rf public/cesium && pnpm copy-cesium && ls public/cesium/
```

Expected: a single version-named directory (e.g. `1.143.0/`).

- [ ] **Step 5: Rebuild and verify the globe still renders**

```bash
pnpm copy-cesium && pnpm build && pnpm perf
```

Expected: exit 0, and `pnpm perf` still reports 6 globe chunk requests.

**Parity check:** open `/` and confirm the globe renders with terrain and imagery, and that the browser console is free of 404s. A wrong `CESIUM_BASE_URL` produces a black sphere with 404s for workers and assets — that is the failure mode to watch for.

- [ ] **Step 6: Commit**

```bash
git add scripts/copy-cesium.mjs next.config.ts .gitignore
git commit -m "build: version-scope Cesium asset path to enable immutable caching"
```

---

### Task 6: Cache-Control headers

**Files:**
- Modify: `next.config.ts` (`headers()`, lines 24–85)
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Add the cache rules**

In `next.config.ts`, inside the array returned by `headers()`, add these two entries **before** the existing `source: "/(.*)"` entry, so the more specific rules are declared first:

```typescript
      {
        // Version-scoped by scripts/copy-cesium.mjs, so the URL changes on every
        // Cesium upgrade. That is what makes `immutable` safe here — without the
        // version segment this rule would pin stale workers in every returning
        // user's cache until they hard-refreshed.
        source: "/cesium/:version/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        // Static datasets are not content-hashed, so they cannot be immutable.
        // A day of freshness with a week of stale-while-revalidate means a
        // returning user renders from cache instantly and picks up new data in
        // the background.
        source: "/:file*.(geojson|json)",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
```

- [ ] **Step 2: Rebuild and re-measure**

```bash
pnpm build && pnpm perf:assets
```

- [ ] **Step 3: Verify the headers actually applied**

Open `playwright/output/perf/static-assets.json`. The `cacheControl` field for `/borders.geojson` must now read `public, max-age=86400, stale-while-revalidate=604800`, and any `/cesium/...` entry must read `public, max-age=31536000, immutable`.

If either still reads `public, max-age=0`, the `source` pattern did not match. Fix the pattern; do not proceed on an unverified header.

- [ ] **Step 4: Parity check**

```bash
pnpm test:e2e
```

Expected: exit 0. Cache headers change nothing about response bodies, so any E2E failure here is a real regression in the header config.

- [ ] **Step 5: Record and commit**

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 6 — cache headers

| Asset | cacheControl before | cacheControl after |
|---|---|---|
| `/borders.geojson` | | |
| `/cesium/...` | | |
```

```bash
git add next.config.ts docs/OPTIMIZATION-LEDGER.md
git commit -m "perf: add Cache-Control for Cesium assets and static datasets"
```

---

### Task 7: Settle the compression question

Task 1 measured what `content-encoding` the server returns today. Act on that measurement, not on the assumption.

**Files:**
- Modify: `next.config.ts` (only on the null branch)
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Read the Task 1 answer**

Open `docs/OPTIMIZATION-LEDGER.md` § Task 1 and find the `contentEncoding` recorded for `/borders.geojson`.

- [ ] **Step 2: Branch on it**

**If `contentEncoding` is `gzip`:** compression is already on. The remaining win is gzip → brotli, measured at 2,078,583 → 1,493,871 bytes across the four static datasets, i.e. **585 KB**. Brotli for `public/` is not something `next start` can do; it needs a CDN or reverse proxy. Record in the ledger:

> gzip active. Brotli upgrade is a deployment-layer change (CDN or reverse proxy), not an application change. Measured headroom: 585 KB across four files. Deferred to infrastructure.

Then skip to Step 4.

**If `contentEncoding` is `null` or absent:** responses ship uncompressed and the win is **12.4 MB**. Continue to Step 3.

- [ ] **Step 3: Enable compression (only on the null branch)**

In `next.config.ts`, add to `nextConfig` immediately after the `output: "standalone"` line:

```typescript
  compress: true,
```

Then rebuild and confirm:

```bash
pnpm build && pnpm perf:assets
```

`contentEncoding` for `/borders.geojson` must now read `gzip`.

- [ ] **Step 4: Record and commit**

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 7 — compression

| Metric | Before | After |
|---|---:|---:|
| `/borders.geojson` contentEncoding | | |
| Total bytes over 100 KB on cold load | | |
```

```bash
git add next.config.ts docs/OPTIMIZATION-LEDGER.md
git commit -m "perf: confirm and record static asset compression state"
```

---

## Phase 3 — Payload shape

### Task 8: Establish whether the orphan datasets are actually served

`public/military_bases.geojson` (6.66 MB) and `public/cameras_geojson.json` (1.94 MB) have **no static importer** in `src/`. Together they are 8.6 MB — 59% of the static data payload. But plugin manifests construct paths as runtime strings, so a grep proves nothing. **This task investigates and records. It does not delete.**

**Files:**
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Search every runtime string source in this workspace**

```bash
grep -rn "military_bases\|cameras_geojson" --include=*.ts --include=*.tsx --include=*.json --include=*.mjs --include=*.md . 2>/dev/null | grep -v node_modules | grep -v "^./public/"
```

- [ ] **Step 2: Search the plugin workspaces**

```bash
cd /home/admin/Documents/silver-wolf-vi/world-wide-view && grep -rn "military_bases\|cameras_geojson" worldwideview-plugins/packages worldwideview/local-plugins 2>/dev/null | grep -v node_modules
```

- [ ] **Step 3: Observe a real load**

Open `playwright/output/perf/static-assets.json` from Task 6 and check whether `/military_bases.geojson` or `/cameras_geojson.json` appear in the `assets` array on a cold load of `/`.

- [ ] **Step 4: Record the verdict**

Append to `docs/OPTIMIZATION-LEDGER.md` under `## Task 8 — orphan dataset audit` exactly one of:

> Referenced at `<file:line>` — live asset. Keep, and include in Task 10 quantization.

or

> No reference in any workspace, and not requested on a cold load of `/`. Candidate for removal, but removal is a product decision outside this plan's scope. Flagged for the owner.

The second verdict is **not** permission to delete. The stated constraint is that nothing leaves the experience; an asset nobody can prove is unused stays.

- [ ] **Step 5: Commit**

```bash
git add docs/OPTIMIZATION-LEDGER.md
git commit -m "docs: audit static dataset reachability"
```

---

### Task 9: Attribute the Cesium chunk

Report §10 leaves open whether the dominant chunk's 87 `draco` references are the decoder itself or loader plumbing — and Cesium separately loads Draco as a worker from `public/cesium/`. If the decoder is duplicated into the main chunk, that is dead weight in the critical path. **Splitting on a guess is how the §7 ledger got eight entries. Measure first.**

**Files:**
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Run the analyzer**

```bash
pnpm analyze
```

- [ ] **Step 2: Open the report**

```bash
ls .next/analyze/
```

Open `client.html` in a browser.

- [ ] **Step 3: Answer the question**

In the treemap, locate the largest chunk (~3,944 KB). Determine whether `draco_decoder.wasm` / `draco_decoder.js` bytes are **inside** it, or whether the `draco` references are import statements pointing at `public/cesium/ThirdParty/`.

- [ ] **Step 4: Record the finding**

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 9 — Cesium chunk attribution

Largest chunk: 3,944.0 KB. Draco decoder bytes inside it? **yes / no**

Module breakdown from the treemap (name, bytes):

Verdict:
```

If the decoder **is** bundled: record the byte count and open a follow-up task. Do **not** split in this task — a Cesium chunk split needs its own parity plan covering terrain, imagery, 3D tiles and model loading.

If it is **not** bundled: record that the chunk is irreducible without dropping Cesium features, which the invariant forbids. That closes §10's open question and stops it being re-litigated.

- [ ] **Step 5: Commit**

```bash
git add docs/OPTIMIZATION-LEDGER.md
git commit -m "docs: attribute the dominant Cesium chunk via bundle analyzer"
```

---

### Task 10: Quantize GeoJSON coordinates

`borders.geojson` stores coordinates at full float precision. At the equator, 5 decimal places is ~1.1 m — far below one screen pixel at any zoom the globe supports. Trimming to 5 places shrinks the file and compresses better, with **no visible change**.

**Files:**
- Create: `scripts/quantize-geojson.mjs`
- Create: `scripts/quantize-geojson.test.mjs`
- Modify: `package.json` (scripts)
- Modify: `.gitignore`
- Modify: `src/core/globe/useBorders.ts:80`
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Capture a before screenshot for the parity check**

```bash
pnpm build && pnpm start
```

Open `/`, enable the borders layer, and save a screenshot to
`local-scripts/borders-before.png`. Note the camera position — the after shot
must match it. Stop the server when done.

**Not** `playwright/output/` — Task 3's `clean:all` deletes that directory, which
would silently destroy this parity baseline. `local-scripts/` is the scratch
location sanctioned by `CLAUDE.md` §4 and is excluded from `clean:all`.

- [ ] **Step 2: Write the failing test**

Create `scripts/quantize-geojson.test.mjs`:

```javascript
import { describe, it, expect } from 'vitest';
import { quantize } from './quantize-geojson.mjs';

describe('quantize', () => {
    it('rounds coordinates to the given precision', () => {
        const input = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [1.123456789, 2.987654321] },
            properties: { name: 'x' },
        };
        expect(quantize(input, 5)).toEqual({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [1.12346, 2.98765] },
            properties: { name: 'x' },
        });
    });

    it('recurses into nested coordinate arrays', () => {
        const input = {
            type: 'Polygon',
            coordinates: [[[1.111111, 2.222222], [3.333333, 4.444444]]],
        };
        expect(quantize(input, 3)).toEqual({
            type: 'Polygon',
            coordinates: [[[1.111, 2.222], [3.333, 4.444]]],
        });
    });

    it('leaves non-coordinate numeric properties untouched', () => {
        const input = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [0, 0] },
            properties: { population: 1234567.891, name: 'Somewhere' },
        };
        const out = quantize(input, 5);
        expect(out.properties.population).toBe(1234567.891);
        expect(out.properties.name).toBe('Somewhere');
    });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
pnpm exec vitest run scripts/quantize-geojson.test.mjs
```

Expected: FAIL — `Failed to resolve import "./quantize-geojson.mjs"`.

- [ ] **Step 4: Write the implementation**

Create `scripts/quantize-geojson.mjs`:

```javascript
import fs from 'node:fs';

/**
 * Rounds every coordinate in a GeoJSON object to `precision` decimal places.
 *
 * Only walks `coordinates` arrays, so numeric feature properties keep full
 * precision — quantizing a population count would be a data bug, not a saving.
 */
export function quantize(node, precision) {
    const f = 10 ** precision;
    const round = (n) => Math.round(n * f) / f;

    const walkCoords = (c) =>
        typeof c[0] === 'number' ? c.map(round) : c.map(walkCoords);

    if (Array.isArray(node)) return node.map((n) => quantize(n, precision));
    if (node === null || typeof node !== 'object') return node;

    const out = {};
    for (const [k, v] of Object.entries(node)) {
        out[k] = k === 'coordinates' && Array.isArray(v) ? walkCoords(v) : quantize(v, precision);
    }
    return out;
}

const [, , inPath, outPath, precisionArg] = process.argv;
if (inPath) {
    const precision = Number(precisionArg ?? 5);
    const src = JSON.parse(fs.readFileSync(inPath, 'utf8'));
    fs.writeFileSync(outPath, JSON.stringify(quantize(src, precision)));
    const before = fs.statSync(inPath).size;
    const after = fs.statSync(outPath).size;
    console.log(
        `${inPath} -> ${outPath}: ${before} -> ${after} bytes ` +
        `(-${(100 - (after / before) * 100).toFixed(1)}%)`,
    );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run scripts/quantize-geojson.test.mjs
```

Expected: PASS, 3 tests.

- [ ] **Step 6: Generate the quantized asset and measure**

```bash
node scripts/quantize-geojson.mjs public/borders.geojson public/borders.q5.geojson 5 && brotli -q 11 -c public/borders.q5.geojson | wc -c
```

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 10 — coordinate quantization

| Metric | Before | After |
|---|---:|---:|
| `borders.geojson` raw bytes | 4,045,883 | |
| `borders.geojson` brotli -11 bytes | 828,655 | |
```

- [ ] **Step 7: Wire it into the build**

In `package.json`, add to `scripts`:

```json
"data:quantize": "node scripts/quantize-geojson.mjs public/borders.geojson public/borders.q5.geojson 5",
```

and change the existing `prebuild` line to:

```json
"prebuild": "node scripts/check-build-env.mjs && pnpm data:quantize",
```

Append to `.gitignore`:

```
/public/*.q5.geojson
```

- [ ] **Step 8: Point the loader at the quantized asset**

In `src/core/globe/useBorders.ts`, change line 80 from:

```typescript
                await dataSource.load("/borders.geojson");
```

to:

```typescript
                await dataSource.load("/borders.q5.geojson");
```

- [ ] **Step 9: Parity check — this is the gate**

```bash
pnpm build && pnpm test:e2e
```

Then `pnpm start`, open `/`, enable the borders layer at the same camera position as Step 1, and compare against `local-scripts/borders-before.png`.

**Borders must be visually identical.** 5 decimal places is ~1.1 m at the equator. If any difference is visible, the precision is wrong for this data — raise it to 6, re-run from Step 6, and re-measure. Do not ship a visible regression to save bytes.

- [ ] **Step 10: Commit**

```bash
git add scripts/quantize-geojson.mjs scripts/quantize-geojson.test.mjs package.json .gitignore src/core/globe/useBorders.ts docs/OPTIMIZATION-LEDGER.md
git commit -m "perf: quantize border coordinates to 5dp at build time"
```

---

## Phase 4 — Main thread

### Task 11: Strip production console timing from the borders path

`src/core/globe/useBorders.ts` calls `console.time` / `console.timeEnd` around the parse and geometry build. In production these are pure overhead on the hottest path in the app, and they run on every layer toggle.

**Files:**
- Modify: `src/core/globe/useBorders.ts`

- [ ] **Step 1: Find every timing call**

```bash
grep -n "console.time\|console.timeEnd" src/core/globe/useBorders.ts
```

- [ ] **Step 2: Guard each one behind the production check**

For each call found, wrap it. For example, replace:

```typescript
                console.time("[useBorders] 1. GeoJSON parse");
```

with:

```typescript
                if (process.env.NODE_ENV !== "production") console.time("[useBorders] 1. GeoJSON parse");
```

and replace:

```typescript
                console.timeEnd("[useBorders] 1. GeoJSON parse");
```

with:

```typescript
                if (process.env.NODE_ENV !== "production") console.timeEnd("[useBorders] 1. GeoJSON parse");
```

Apply the same transformation to every call from Step 1, preserving each original label string exactly. Webpack's `DefinePlugin` substitutes `process.env.NODE_ENV` at build time, so these branches are eliminated from the production bundle rather than merely skipped at runtime.

- [ ] **Step 3: Verify they are gone from the production bundle**

```bash
pnpm build && grep -rl "useBorders] 1. GeoJSON parse" .next/static/chunks/ | head
```

Expected: no output — the label string appears in zero production chunks.

- [ ] **Step 4: Verify dev logging still works**

```bash
pnpm dev
```

Open `/`, enable the borders layer, and confirm the timing lines still appear in the browser console. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/core/globe/useBorders.ts
git commit -m "perf: strip borders timing instrumentation from production builds"
```

---

## Phase 5 — Memory ceilings

### Task 12: Right-size the runtime heap cap

`docker/Dockerfile:96` sets `--max-old-space-size=768`. That number has never been compared against actual server usage. Too low is an OOM kill under load — the literal "crashes" in the request.

**Files:**
- Modify: `docker/Dockerfile:96` (only if Step 2 says raise)
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Measure actual server RSS under load**

```bash
pnpm build && (pnpm start & echo $! > /tmp/wwv.pid) && sleep 15 && pnpm perf:assets; ps -o rss= -p "$(cat /tmp/wwv.pid)"; kill "$(cat /tmp/wwv.pid)"
```

The `ps` output is in KB. Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 12 — server heap

| Metric | Value |
|---|---:|
| Measured peak server RSS (MB) | |
| Current cap (`docker/Dockerfile:96`) | 768 MB |
| Verdict | |
```

- [ ] **Step 2: Decide from the measurement**

- Measured peak **above ~600 MB** — under 25% headroom, a live crash risk. Raise the cap; continue to Step 3.
- Measured peak **below ~400 MB** — the cap is generous. **Change nothing.** Record in the ledger that the crash hypothesis was refuted. A refuted hypothesis is a result; this project's §7 ledger exists precisely because refutations were not previously written down.

- [ ] **Step 3: Apply the change (only if Step 2 says raise)**

In `docker/Dockerfile`, replace line 96:

```dockerfile
ENV NODE_OPTIONS=--max-old-space-size=768
```

with a value giving at least 100% headroom over the measured peak, rounded to a power of two, and a comment recording the justification:

```dockerfile
# Measured peak server RSS was <N> MB under the perf suite
# (docs/OPTIMIZATION-LEDGER.md § Task 12). This cap gives ~2x headroom.
# Re-measure before lowering it.
ENV NODE_OPTIONS=--max-old-space-size=1536
```

- [ ] **Step 4: Verify the container still builds and serves**

```bash
docker build -f docker/Dockerfile -t wwv-heap-test . && docker run --rm -d --name wwv-heap-test -p 3001:3000 wwv-heap-test && sleep 20 && curl -sf -o /dev/null -w "%{http_code}\n" http://localhost:3001/ ; docker stop wwv-heap-test
```

Expected: `200`.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile docs/OPTIMIZATION-LEDGER.md
git commit -m "fix: right-size runtime heap cap against measured server RSS"
```

---

### Task 13: Close the build-heap gap

`docker/Dockerfile:81` builds under `--max_old_space_size=3072` against a measured peak build RSS of **3,575 MB**. RSS is not the same quantity as V8 old-space, so this is not proof of a problem — but a ceiling 500 MB below measured process RSS is close enough to warrant a direct check.

**Files:**
- Modify: `docker/Dockerfile:81` (only if Step 2 says raise)
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Measure V8 heap directly, not RSS**

```bash
pnpm clean && NODE_OPTIONS="--max_old_space_size=3072 --trace-gc" pnpm build 2>&1 | grep -oE "[0-9]+\.[0-9]+ \([0-9]+\.[0-9]+\) MB" | tail -20
```

The parenthesised figure is total heap. Take the maximum across the run.

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 13 — build heap

| Metric | Value |
|---|---:|
| Measured peak V8 total heap (MB) | |
| Measured peak build RSS (MB) | 3,575 |
| Current cap (`docker/Dockerfile:81`) | 3,072 MB |
| Verdict | |
```

- [ ] **Step 2: Decide**

- Peak heap **above 2,700 MB** — under 12% headroom against the 3072 cap. Docker builds are one dependency upgrade from failing. Raise it; continue to Step 3.
- Peak heap **below 2,200 MB** — the cap is fine, and the 3,575 MB RSS figure is dominated by non-heap memory (webpack worker processes, mapped files). Record that and change nothing.

- [ ] **Step 3: Apply (only if Step 2 says raise)**

In `docker/Dockerfile`, change line 81's `--max_old_space_size=3072` to `4096`, with a comment naming the measurement that justifies it.

Note the coupling recorded in report §5.5: `experimental.cpus: 2` in `next.config.ts` exists to bound concurrent webpack worker heap against this ceiling. If the ceiling rises, `cpus` may become raisable — but that is a separate change needing its own Docker validation. **Do not change both in one commit.**

- [ ] **Step 4: Verify the container build**

```bash
docker build -f docker/Dockerfile -t wwv-build-test .
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile docs/OPTIMIZATION-LEDGER.md
git commit -m "build: verify build heap headroom against measured V8 usage"
```

---

## Phase 6 — Build tooling

### Task 14: Evaluate Turbopack

`package.json` pins `"build": "next build --webpack"`. Next 16 defaults to Turbopack; the `--webpack` flag is an explicit opt-out. Builds currently take 418 s. **This is developer time, not user time** — it is last in the plan for that reason, and it must not be allowed to regress output.

**Files:**
- Modify: `package.json` (only if Step 4 passes)
- Modify: `docs/OPTIMIZATION-LEDGER.md`

- [ ] **Step 1: Baseline the webpack build**

```bash
pnpm clean && time pnpm build && du -sb .next/static
```

Record wall clock and `.next/static` bytes.

- [ ] **Step 2: Try Turbopack**

```bash
pnpm clean && time pnpm exec next build && du -sb .next/static
```

- [ ] **Step 3: Record both**

Append to `docs/OPTIMIZATION-LEDGER.md`:

```markdown
## Task 14 — Turbopack evaluation

| Metric | webpack | Turbopack |
|---|---:|---:|
| Build wall clock (s) | | |
| `.next/static` bytes | | |
| Globe renders? | yes | |
| Verdict | | |
```

- [ ] **Step 4: Gate on output parity**

The custom webpack config in `next.config.ts` lines 95–123 does three things Turbopack must replicate: the `DefinePlugin` for `CESIUM_BASE_URL`, the Node core-module fallbacks (`fs`, `http`, `https`, `zlib`, `url` → `false`), and the OpenTelemetry/Sentry warning suppressions.

Verify with:

```bash
pnpm perf
```

Expected: 6 globe chunk requests, and a clean console on `/`.

If the Turbopack build fails, or the globe does not render, **stop. Record that Turbopack is blocked on the Cesium webpack config and keep `--webpack`.** A faster build that ships a broken globe is not an optimization.

- [ ] **Step 5: Switch only if Step 4 passed cleanly**

In `package.json`, change:

```json
"build": "next build --webpack",
```

to:

```json
"build": "next build",
```

and make the same `--webpack` removal in the `analyze` and `perf` scripts.

- [ ] **Step 6: Commit**

```bash
git add package.json docs/OPTIMIZATION-LEDGER.md
git commit -m "build: evaluate Turbopack against webpack output parity"
```

---

## Final gate

Run the project's full gate set from report §9 plus the two new harnesses. All must pass before this plan is complete.

- [ ] **Step 1: Run every gate**

```bash
pnpm build && pnpm exec vitest run --coverage && pnpm audit --audit-level high && pnpm exec size-limit && pnpm perf && pnpm perf:assets
```

- [ ] **Step 2: Confirm no regression against baseline**

| Gate | Must be |
|---|---|
| `pnpm build` | exit 0 |
| `vitest run --coverage` | exit 0, functions ≥ 36%, branches ≥ 34.87% |
| `pnpm audit --audit-level high` | exit 0 |
| `size-limit` | ≤ 1.76 MB — must not grow |
| `pnpm perf` | discovery ≤ 19 ms, gap 0 ms, 6 globe chunks |
| `pnpm perf:assets` | total bytes below the Task 1 baseline |

- [ ] **Step 3: Complete the ledger**

Fill in every `after` column in `docs/OPTIMIZATION-LEDGER.md`. Any row where `after` is unknown means that task's claim is unverified — mark it so explicitly rather than leaving it blank. That habit is the whole point of the ledger.

- [ ] **Step 4: Commit**

```bash
git add docs/OPTIMIZATION-LEDGER.md
git commit -m "docs: close the optimization ledger with measured outcomes"
```

---

## Phase 7 — Plugin and layer runtime

**Status of the evidence.** A 5-dimension audit raised 36 findings, but its
verification stage died on an API session limit: 38 of 41 agents never ran.
Three tasks below (15–17) rest on a root cause **I verified by reading the code
directly** — those citations are sound. Everything in §7.4 is an **unverified
lead**. Do not act on §7.4 without verifying it first; that is precisely the
failure mode §7 of the optimization report documents.

### The verified root cause

A single mechanism explains most of the reported cost, and three independent
finders reached it from different directions:

1. `src/core/state/layersSlice.ts:59` (`setEntityCount`) and `:65`
   (`setLayerLoading`) each spread a **brand-new `layers` object on every call**,
   with **no equality guard**. Setting `loading: false` when it is already
   `false` still changes the object's identity.
2. **Eight components subscribe to the whole map** via `useStore((s) => s.layers)`:
   `GlobeView.tsx:63`, `BottomPanelManager.tsx:14`, `FavoritesTab.tsx:21`,
   `LayerPanel.tsx:42`, `FilterPanel.tsx:24`, `panels/config/OverlayTab.tsx:11`,
   `panels/DataConfig/OverlayTab.tsx:25`, `panels/tabs/OverlayConfigTab.tsx:60`.
3. **`React.memo` appears nowhere in `src/components`** (verified: `grep -rc` over
   the tree returns no matching file).

So **every data tick of every plugin re-renders all eight components** — including
the Cesium host — regardless of which layer's data actually changed. Cost scales
as O(plugins ticking) × 8, and GlobeView's re-render cascades into per-entity work
across *all* enabled layers.

This directly violates `.agents/rules/state-management.md`, which warns: *"Do not
destructure wide objects in selectors... rerenders the component any time
anything in the slice changes."*

Tasks 15–17 attack this in ascending order of blast radius. **Task 15 alone may
resolve most of it** — measure after each before starting the next.

---

### Task 15: Equality guards in the layers slice

The smallest possible change at the root. If a write does not alter the value,
it must not alter the object identity.

**Files:**
- Modify: `src/core/state/layersSlice.ts:59-70`
- Test: `src/core/state/layersSlice.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/core/state/layersSlice.test.ts`:

```typescript
describe("layers identity stability", () => {
    it("preserves the layers object identity when setLayerLoading is a no-op", () => {
        const store = createTestStore();
        store.getState().initLayer("p1", true);
        store.getState().setLayerLoading("p1", false);
        const before = store.getState().layers;
        store.getState().setLayerLoading("p1", false);
        expect(store.getState().layers).toBe(before);
    });

    it("preserves the layers object identity when setEntityCount is a no-op", () => {
        const store = createTestStore();
        store.getState().initLayer("p1", true);
        store.getState().setEntityCount("p1", 42);
        const before = store.getState().layers;
        store.getState().setEntityCount("p1", 42);
        expect(store.getState().layers).toBe(before);
    });

    it("still changes identity when the value genuinely changes", () => {
        const store = createTestStore();
        store.getState().initLayer("p1", true);
        store.getState().setEntityCount("p1", 1);
        const before = store.getState().layers;
        store.getState().setEntityCount("p1", 2);
        expect(store.getState().layers).not.toBe(before);
        expect(store.getState().layers.p1.entityCount).toBe(2);
    });
});
```

If `createTestStore` does not already exist in this spec, use whatever store
construction the surrounding tests use — do not invent a new helper.

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm exec vitest run src/core/state/layersSlice.test.ts
```

Expected: the first two tests FAIL — the objects differ. The third passes already.

- [ ] **Step 3: Add the guards**

In `src/core/state/layersSlice.ts`, replace `setEntityCount` (lines 59-64) and
`setLayerLoading` (lines 65-70) with:

```typescript
    setEntityCount: (pluginId, count) => set((state) => {
        const existing = state.layers[pluginId];
        // Identity is load-bearing: eight components subscribe to the whole
        // `layers` map, so churning it on a no-op write re-renders the Cesium
        // host. See docs/superpowers/plans/2026-08-17-worldwideview-optimization.md
        if (existing && existing.entityCount === count) return {};
        return {
            layers: {
                ...state.layers,
                [pluginId]: { ...existing, entityCount: count },
            },
        };
    }),
    setLayerLoading: (pluginId, loading) => set((state) => {
        const existing = state.layers[pluginId];
        if (existing && existing.loading === loading) return {};
        return {
            layers: {
                ...state.layers,
                [pluginId]: { ...existing, loading },
            },
        };
    }),
```

Returning `{}` from a zustand `set` updater is a no-op merge — it does not
notify subscribers.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm exec vitest run src/core/state/layersSlice.test.ts
```

Expected: PASS, all three.

- [ ] **Step 5: Parity check**

```bash
pnpm build && pnpm test
```

Then run the app with at least two plugins enabled and confirm entity counts and
loading spinners in the layer panel **still update correctly**. The guard must
suppress only redundant writes. If a spinner stops appearing, the guard is wrong.

- [ ] **Step 6: Commit** (bump semver to patch first — see Commit protocol)

```bash
git add src/core/state/layersSlice.ts src/core/state/layersSlice.test.ts package.json
git commit -m "perf: guard no-op layer writes against needless identity churn"
```

---

### Task 16: Narrow the whole-map subscriptions

Task 15 stops *redundant* notifications. This stops *irrelevant* ones: a genuine
change to plugin A still re-renders every component watching the whole map.

**Files:**
- Modify: the eight files listed in "The verified root cause" above

- [ ] **Step 1: Measure the current re-render count**

Add a temporary counter to `src/components/panels/LayerPanel.tsx`:

```typescript
    const renderCount = React.useRef(0);
    renderCount.current += 1;
    console.log("[LayerPanel] render", renderCount.current);
```

Run with two or more plugins polling, wait 60 s, record the count. **Remove this
counter before committing** — a stray `console.log` is a GC Tier-A finding per
`.agents/rules/garbage-collection.md`.

- [ ] **Step 2: Replace whole-map reads with narrow selectors**

For each of the eight sites, subscribe to the smallest thing the component
actually uses. Where a component needs a derived list, use zustand's
`useShallow` so a structurally-equal result does not re-render:

```typescript
import { useShallow } from "zustand/react/shallow";

// Was: const layers = useStore((s) => s.layers);
const layerIds = useStore(useShallow((s) => Object.keys(s.layers)));
```

Where a component needs one layer's state, select exactly that:

```typescript
const layer = useStore((s) => s.layers[pluginId]);
```

Do this one file at a time, verifying the component still works before moving to
the next. Do not batch all eight into one commit.

- [ ] **Step 3: Re-measure**

Repeat Step 1's measurement. Record before/after in `docs/OPTIMIZATION-LEDGER.md`
under `## Task 16 — layer subscription narrowing`.

- [ ] **Step 4: Parity check**

```bash
pnpm build && pnpm test && pnpm test:e2e
```

Then confirm by hand: toggling a layer still updates the globe, the layer panel,
the filter panel and the overlay tabs. A too-narrow selector shows up as a
stale UI, not a crash — check each of the eight surfaces.

- [ ] **Step 5: Commit**

```bash
git add src/core/globe/GlobeView.tsx src/components package.json docs/OPTIMIZATION-LEDGER.md
git commit -m "perf: narrow whole-layers-map subscriptions to used fields"
```

---

### Task 17: Memoize layer rows

With zero `React.memo` in `src/components`, one row's change reconciles every row.

**Files:**
- Modify: `src/components/panels/LayerItem.tsx`
- Modify: `src/components/panels/LayerPanel.tsx`

- [ ] **Step 1: Wrap the row component**

At the bottom of `src/components/panels/LayerItem.tsx`, change the default export
to a memoized one:

```typescript
export default React.memo(LayerItem);
```

Add `import React from "react";` if the file does not already import it.

- [ ] **Step 2: Stabilize the callbacks passed to it**

`React.memo` is defeated by a fresh closure per render. In
`src/components/panels/LayerPanel.tsx`, wrap every handler passed to `LayerItem`
in `useCallback` with a correct dependency array. Prefer passing `pluginId` back
up over closing over it:

```typescript
const handleToggle = React.useCallback((pluginId: string) => {
    useStore.getState().toggleLayer(pluginId);
}, []);
```

Using `useStore.getState()` inside the callback keeps the dependency array empty,
per `CLAUDE.md` §3 ("access via `useStore` in React, `useStore.getState()`
elsewhere").

- [ ] **Step 3: Verify memoization actually engages**

Re-run the Step 1 counter from Task 16, this time inside `LayerItem`. Toggling
one layer should re-render **one** row, not all of them. Remove the counter after.

- [ ] **Step 4: Parity check**

```bash
pnpm build && pnpm test
```

Confirm every row still updates its own entity count and spinner independently.

- [ ] **Step 5: Commit**

```bash
git add src/components/panels/LayerItem.tsx src/components/panels/LayerPanel.tsx package.json
git commit -m "perf: memoize layer rows and stabilize their callbacks"
```

---

### §7.4 Unverified leads

**These did not survive verification — they never reached it.** Each needs the
adversarial check the aborted run never performed. Listed by reported severity so
the re-run can prioritize. Re-run the audit workflow when API capacity allows.

| Area | Reported issue | File:line |
|---|---|---|
| Render cascade | `visibleEntities` rebuilt for all plugins on any single plugin's tick | `src/core/globe/GlobeView.tsx:91` |
| Render cascade | `useEntityRendering` effect depends on `visibleEntities`, tearing down the animation loop per tick | `src/core/globe/hooks/useEntityRendering.ts:162` |
| Render cascade | `PluginGlobeComponents` rebuilt on every tick of any plugin | `src/core/globe/GlobeView.tsx:264` |
| Dead write | `setEntityCount` writes a value no client code reads | `src/components/layout/DataBusSubscriber.tsx:54` |
| Double commit | Loading flag and data are separate commits — two render passes per poll | `src/components/layout/DataBusSubscriber.tsx:79`, `src/core/plugins/PluginManager.ts:458` |
| Chunking | `ChunkedProcessor` hard-capped at 500 entities/frame; idle-deadline branch reportedly dead | `src/core/globe/ChunkedProcessor.ts:50` |
| Chunking | Cancelled chunked render skips cleanup and stack rebuild | `src/core/globe/EntityRenderer.ts:188` |
| Clustering | `rebuildStacks` called with `force=true`, bypassing its own 300 ms cooldown | `src/core/globe/EntityRenderer.ts:203` |
| Clustering | Full clustering computed twice per zoom step | `src/core/globe/StackManager.ts:43` |
| Caching | `renderOptionsCache` never cleared; evicts 25 000 keys synchronously mid-render | `src/core/globe/renderOptionsCache.ts:45` |
| Caching | `renderCaches` "stable array" cache never prevents an allocation | `src/core/globe/renderCaches.ts:51` |
| Caching | `matchMedia` called per point entity per render pass | `src/core/globe/EntityRenderer.ts:140` |
| Per-frame | Animation loop does 2-3 hash lookups per entity per frame | `src/core/globe/AnimationLoop.ts:255` |
| Per-frame | `useTrailRendering` scans all animatables 4×/s even with no trail layers | `src/core/globe/hooks/useTrailRendering.ts:32` |
| Per-frame | `useModelRendering` scans all animatables ~6×/s even with no model layers | `src/core/globe/hooks/useModelRendering.ts:77` |
| Layer toggle | Disabling a layer destroys primitives instead of flipping visibility | `src/core/plugins/layerActivation.ts:18` |
| Load serialization | Marketplace bundles imported strictly one at a time | `src/core/hooks/useMarketplaceSync.ts:133` |
| Load serialization | Manifest fetch gated behind the Cesium/Resium module load | `src/components/layout/AppShell.tsx:97` |
| Load serialization | `syncPlugins` does 3 serial round trips, 2 to the same endpoint | `src/core/hooks/useMarketplaceSync.ts:179` |
| **Correctness** | `fetchLocalEngineManifest` marks itself done before its fetch resolves — concurrent callers get `null` and silently route to the cloud engine | `src/core/data/engineManifest.ts:33` |
| **Correctness** | Bundle-probing fallback constructs every named export, firing arbitrary side effects | `src/core/plugins/loadPluginFromManifest.ts:67` |
| Dead code | `InstalledPluginsLoader` — named in CLAUDE.md as the marketplace boot path — is reportedly never invoked | `src/core/plugins/InstalledPluginsLoader.ts:22` |
| Network | `useGlobeStateSync` subscribes to the entire store; ungated `setFps` turns a 10 s heartbeat into ~1 Hz POSTs | `src/core/globe/hooks/useGlobeStateSync.ts:48` |

The two rows marked **Correctness** are potential bugs, not just slowness. If
either holds, it deserves its own fix independent of any optimization work.
