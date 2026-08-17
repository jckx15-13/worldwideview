# Changelog

All notable changes to WorldWideView are documented here. This project follows
Conventional Commits and bumps semver in `package.json` per change.

## v2.66.0 - Measured, Then Fixed (2026-08-17)

Closes Phase 41. The phase had been blocked for a reason worth stating plainly:
the project could not observe its own runtime, so every performance claim in it
was inference. This release adds the observation, then acts on what it showed.

### Added

- `@next/bundle-analyzer`, wired behind `ANALYZE=1` — `pnpm analyze`. Next 16
  removed the per-route First Load JS columns from build output, leaving no way
  to attribute bundle weight to a module. This restores it.
- A production-mode performance harness — `pnpm perf`
  (`playwright.perf.config.ts` + `tests/perf/globe-load.perf.spec.ts`). Every
  other Playwright config runs `pnpm dev`, so every number they could produce is
  a dev-server number: unminified, unsplit, compiled on demand. This one runs
  `next start` against a real build and records the load waterfall to
  `playwright/output/perf/globe-load.json`.
  It needs no database — `src/proxy.ts` gates `/` on session-cookie *presence*
  only, so a synthetic cookie reaches the identical client bundle.

### Performance

- **The globe's 1.34 MB of compressed JS now starts downloading 308 ms earlier.**
  `GlobeView` is a `next/dynamic(..., { ssr: false })` import rendered
  unconditionally, so its chunks were absent from the prerendered HTML and
  invisible to the browser's preload scanner. Measured: first JS request at
  19 ms, globe chunks not requested until 327 ms — 308 ms of idle network on the
  critical path of the component that *is* the product.

  `src/app/page.tsx` now calls React 19's `preload()` with hrefs resolved from
  `.next/react-loadable-manifest.json` (`src/lib/globe-preload.ts`).

  | | Before | After |
  |---|---:|---:|
  | Globe chunks discovered | 327 ms | **19 ms** |
  | Globe fully downloaded | 754 ms | **185 ms** |
  | Globe chunks in HTML | 0 of 6 | **6 of 6** |
  | Bytes shipped | 1,342,901 | **1,342,901** |

  Scoped to `/`, not `layout.tsx` — `/login`, `/setup` and `/locked` share that
  layout and must not pull Cesium. Two failure modes were checked rather than
  assumed: chunk request count stayed at 6 (the preload is reused, not
  double-fetched), and a clean build with `.next` deleted still bakes all 6
  chunks into the prerendered HTML, which is what makes this work in Docker.

### Decided

- `experimental.cpus` stays at **2**. The original OOM justification was refuted
  earlier in this fork work, but `Dockerfile:81` caps the build heap at 3072 MB
  against a measured 3,575 MB peak RSS. More workers would trade a container OOM
  for build time that developers pay and users never see.

### Known limits of these numbers

- Measured over localhost. The 308 ms gap is hydration-bound and survives any
  connection; the 569 ms download saving is a floor that grows on slower links.
- `appReadyMs` is still unmeasured — the harness starts no Redis, Postgres or
  data engine, so plugin boot never completes. Time-to-interactive remains the
  obvious next increment.
- Whether the chunk's `draco` references are the decoder or loader plumbing is
  **unverified**; `pnpm analyze` can now settle it. Splitting it on a guess is
  how this roadmap accumulated its earlier wrong numbers.

## v2.65.22 - The Untagged Window (2026-06-12 - 2026-08-17)

Release traceability lapsed after `v1.6`. **342 commits** shipped untagged over
two months. This entry closes that gap; it is a summary, not a per-commit log -
use `git log v1.6..v2.65.22` for the full record.

| Type | Count |
|---|---:|
| `fix` | 157 |
| `feat` | 60 |
| `chore` | 27 |
| `build` | 21 |
| `docs` | 12 |
| `test` | 8 |
| `refactor` / `ci` | 5 each |
| `revert` | 4 |
| `perf` | 2 |

The `fix`-to-`feat` ratio of roughly 2.6:1 is the notable signal in this window.

### Fork optimization work (Phases 39-43, 2026-08-14 - 2026-08-17)

**Build and type safety**

- Deleted `typescript.ignoreBuildErrors`. The build type-checks and exits 0.
  The flag was hiding a real defect: `searchParams` in `src/app/locked/page.tsx`
  was typed as a plain object, but Next 15+ makes it a `Promise`. The error
  surfaced only in *generated* route types, which `tsc --noEmit` over source
  never sees - so "tsc is clean" had been false assurance.

**CI gates that could not fail**

- `ci.yml` ran `vitest run --coverage || true`. The unit-test gate could never
  fail, which is why the suite stayed flaky for months. Removed.
- Coverage thresholds of 80/70 had never been met (actual: functions 35.6%,
  branches 34.55%). Ratcheted to 34/33 - just under measured actuals, so the
  gate blocks regression instead of failing on day one.
- `pnpm audit --audit-level high || true` likewise never failed. Now enforced.

**Security**

- Resolved all 8 high-severity advisories: `brace-expansion`, `fast-uri` (the
  existing override was stale) and `nanoid` via `pnpm.overrides`; `extract-zip`
  had no patched version and was dropped with `@size-limit/preset-app`, whose
  Chrome-based `time` plugin was never used.
- `wwv-diagnostics-client` stamped every payload `sanitized: true` while
  redacting only 6 exact keys without recursion - `apiKey`, `accessToken`,
  `authorization`, `cookie`, `privateKey` and `jwt` all shipped in clear. Now
  substring-matched and recursive, with scheme validation on the destination
  URL, working backoff on HTTP errors, and request timeouts.

**Test suite**

- Flakiness root-caused to two separate timeout budgets, not one: `hookTimeout`
  (a `beforeEach` measured at 40,362 ms under load against a 10 s default) and
  `testTimeout` (a dynamic SDK import against a 5 s default).
- Suite is green at 1,223 tests across 122 files.

**Measurement**

- Corrected a peak-RSS figure that was wrong by 4.8 GB - the measuring script
  had summed unrelated host processes. True peak is 3,575 MB, well under the
  6,144 MB cap, which retired the theory that `experimental.cpus: 2` was OOM
  mitigation.
- `size-limit` now runs: **1.76 MB brotlied** against a 2 MB budget - the first
  real compressed bundle figure this project has had.
- Per-route First Load JS remains **unmeasured**. Next 16 removed the size
  columns from build output entirely; the previously documented "re-run in a
  TTY" remedy was tested and refuted.

**Known open items**

- The 3.9 MB Cesium chunk (48% of client JS) is code-split but rendered
  unconditionally and absent from the prerendered HTML, so its fetch is
  serialized after hydration. Optimizing this is blocked on runtime measurement
  that does not yet exist.
- 4 advisories remain (1 low, 3 moderate) below the `high` gate threshold.

## v1.3.0 - Location Intelligence (2026-05-31)

AI agents can now find places on Earth, fly the globe camera, bookmark entities,
and filter the live globe over MCP. The MCP server reports version `1.3.0`
(`MCP_SERVER_VERSION` bumped 1.2.0 -> 1.3.0).

### New MCP tools (8)

Geocoding and camera (`src/app/api/mcp/geocodingTools.ts`):

- `geocode_location` - resolve a place name or address to coordinates and a bounding
  box via OpenStreetMap Nominatim (per-user rate limit + 24h Redis cache).
- `fly_to` - fly the live globe camera to a coordinate or bounding box over the SSE bridge.

Favorites (`src/app/api/mcp/favoritesTools.ts`):

- `save_favorite` - bookmark an entity (upsert by entityId).
- `list_favorites` - list the user's bookmarks, each with a live/stale liveness status.
- `remove_favorite` - delete a bookmarked entity.

Live filtering (`src/app/api/mcp/filterTools.ts`):

- `set_filter` - apply filters to a plugin's layer on the live globe (no page reload).
- `clear_filter` - clear one plugin's filters, or all filters in one command.
- `get_plugin_filters` - read a plugin's declared filterable fields.

### Enhancements

- `search_entities` gained an optional `filters` param (`src/lib/mcp/tools.ts`),
  keyed by entity property key, to return only matching entities independent of any
  `set_filter` state.

### Documentation

- New `docs/plugin-filter-guide.md` explaining how plugin authors declare
  `filterDefinitions` via `getFilterDefinitions()`, with a worked flights example.
- All v1.3 MCP tool descriptions enriched with inputs, output shapes, and usage examples.
- `ConnectAgentHelper` agent prompt now lists every callable MCP tool.

### Versioning

- `MCP_SERVER_VERSION` bumped to `1.3.0`; `serverInfo.version` reflects it on every
  MCP initialize handshake.
