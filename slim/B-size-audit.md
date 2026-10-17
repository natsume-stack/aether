# BOX3 Local Engine — Bloat Audit (Lane B: QUANTIFIED SIZE)

Scope: hard numbers on where the ~2.6 GB of shipped image content and the ~400 MB of `/app`
JS actually go, and which bytes are load-bearing vs. waste. All figures come from commands I ran
against a throwaway copy of `/app` extracted from the **v0.3.0-linux-amd64** image set
(WSL2 distro `Ubuntu-24.04`). Read-only against the live stack; extraction into `/tmp/re-size`
only. Tags: `INFERRED` = reasoned from measured artifacts, `UNVERIFIED` = could not measure.

Extraction method (verified, ~29 s / image):
```
docker create --name re-size-creator box-local-engine-creator:v0.3.0-linux-amd64 true
docker cp re-size-creator:/app /tmp/re-size/creator-app
docker rm re-size-creator
```
`du -sh` of extracted trees:
`creator-app 398M · play-app 359M · ps-app 246M · voxa-app 196M · auth-app 280K`
(No running `box-local-engine-*-1` container was touched.)

---

## 0. Headline numbers

| Metric | Value | How measured |
|---|---|---|
| Extracted `/app` bytes, creator | **398 MB** | `du -sh /tmp/re-size/creator-app` |
| Cross-image byte-identical content shipped in >1 of the 4 JS images | **613 MB** | `Σper-image-unique (1032.6 MB) − global-dedup (419.6 MB)` |
| Global deduped unique `/app` content across 4 JS images | **419.6 MB** / **9 935** distinct files | `cat c.ms p.ms v.ms s.ms \| sort -u \| cut -d'\|' -f1 \| paste -sd+ \| bc` |
| Build-/dev-only JS+native weight in ONE image (creator) | **≈154 MB (~39% of /app)** | per-package sums, §4 |
| Sourcemaps total per image | **0.385 MB** (11 files) | `find . -name '*.map' -printf '%s\n' \| paste -sd+ \| bc` |
| Largest single app layer | **257 MB** Next.js `.next` COPY | `docker history` |
| Largest single file | **48 MB** `@swc/core-linux-x64-gnu.node` | `find -printf '%s' \| sort -rn` |
| Shipped transport tarball (v0.2.0, 6 images) | **707.8 MB gz** | `ls -la …/box3-engine-play-server-images-v0.2.0-linux-amd64.tar.gz` = 707 806 289 B |
| Theoretical boot floor, creator process (node-boot only) | **≈116 MB** loaded vs 398 MB shipped | §7 |

Bottom line: the design is not bloat because "JS is fat". It is bloat because the **same
multi-hundred-MB artifacts (Next standalone `node_modules` + game-server `pnpm` store) are packed
byte-identically into several images, the standalone build re-bundles the entire dependency tree
twice, and ~39% of one image is build-time tooling that a running server never loads.**

---

## 1. Layer breakdown per image — base vs application

`docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' <image> | grep -E '^[0-9]+(\.[0-9]+)?[MG]'`

The **base layers are byte-identical across all five JS images** (same layer IDs → stored once on
the host, but counted once per image in the 8.26 GB "with duplicates" figure):

| Base layer (node:22.17.0-bookworm-slim lineage) | Size | CreatedBy (truncated) |
|---|---|---|
| debian rootfs | 85.2 MB | `# debian.sh --arch 'amd64' out/ 'bookworm'` |
| node + npm + corepack install | 152 MB | `RUN ARCH= … OPENSSL_ARCH= … dpkgArch` |
| `ca-certificates` + node root-cert write | 21.3 MB | `RUN node -e "…rootCertificates…" /etc/ssl/certs` |
| apt curl/wget/gnupg/dirmngr | 7.32 MB | `RUN … apt-get install -y ca-certificates curl wget gnupg dirmngr` |
| node user + entrypoint | ~0.09 MB | `useradd node` / `COPY docker-entrypoint.sh` |
| **base subtotal** | **≈266 MB uncompressed / image** | |

Application COPY layers, per image (uncompressed, from `docker history`):

| Image | Biggest app layers |
|---|---|
| creator | **257 MB** `.next` + **134 MB** `game-server` + 24.1 MB runtime-data + 24.1 MB `cp -al` blobs + 2.15 MB apis-runtime + ~35 small per-file `src/*.js` COPYs (each 24–111 kB) |
| play | **220 MB** `.next` + **130 MB** `game-server` + 24.1 MB + 2.15 MB |
| player-service | **178 MB** `.next` + **76.3 MB** `.next` + 2.73 MB `game/public` (no backend layer) |
| voxa | **190 MB** `voxa/.next` + 15.3 MB `voxa/.next` |
| server-manager | debian 85.3 MB + **40.4 MB docker CLI** + **73.6 MB docker cli-plugins** + **3.99 MB** Rust `/app/server-manager` (NO node base) |
| player-auth-portal | base + app COPYs totalling **280 KB** (its whole `/app`) |

Reading of the 2.6 GB:
- **Node base ≈ 266 MB × 5 JS images.** `player-auth-portal` is the proof: `/app` is **280 KB**, yet
  the image content is 230 MB — i.e. ~99.9% of that image is base runtime, zero app bloat.
- **Application bytes ≈ 1.2 GB** (398+359+246+196+0.3+~4 for the six `/app` trees), of which large
  parts are the same files repeated (§2). `server-manager` carries **114 MB of Docker CLI + compose
  plugin** for its map-hosting role (the non-JS payload).
- On a single host the base is content-addressed and de-duplicated (that is why `content` 2.6 GB <
  the 8.26 GB "with duplicates"); in the per-image/tar accounting it is multiplied 5×.

---

## 2. Cross-image duplication (checksum-verified)

Method: for each image, `md5sum` every file, join with per-file byte size, then de-duplicate.
`.ms` files hold `size|md5` unique per image.
```
find . -type f -exec md5sum {} +  | sed -E 's/^([a-f0-9]+)  (.*)$/\2|\1/' | sort -t'|' -k1,1 > c.md5
find . -type f -printf '%p|%s\n' | sort -t'|' -k1,1 > c.sz
join -t'|' c.sz c.md5 | cut -d'|' -f2,3 | sort -u > c.ms
```

| Image | unique `/app` content | files |
|---|---|---|
| creator | 334.4 MB | 9 673 |
| play | 296.0 MB | 8 738 |
| ps | 212.9 MB | 5 150 |
| voxa | 189.3 MB | 3 785 |
| **Σ (sum of the four)** | **1 032.6 MB** | |
| **global union (dedup)** | **419.6 MB** | **9 935** |
| **Σ − union = cross-image duplicate bytes** | **≈ 613 MB** | |

Pairwise content-identical shares (`join c.sw p.sw | cut -f3 | paste -sd+ | bc`):

| Pair | shared bytes | files |
|---|---|---|
| creator ∩ play | **288.9 MB** | 8 668 |
| creator ∩ player-service | 203.2 MB | — |
| play ∩ player-service | 169.3 MB | — |
| creator ∩ voxa | 120.9 MB | — |
| play ∩ voxa | 120.9 MB | — |
| creator ∩ play ∩ ps | 169.2 MB | 4 503 |

What is duplicated (creator∩play, files collapsed to depth-3):
```
4608  ./services/game-server/node_modules   (the pnpm store shipped byte-identical)
4581  ./apps/game/.next                      (the Next standalone build shipped byte-identical)
 343  ./apps/local-engine/data
 212  ./services/game-server/dist
```
So creator and play are near-twins (backend + web re-shipped whole); player-service re-ships the
**same** game web-standalone `node_modules`/fonts; voxa re-ships the same common deps + fonts.
Within-image duplication is also real: creator `du` 398 MB vs 334 MB unique content → ~60 MB of the
same bytes appear twice inside one image (e.g. `ChillRoundGothic-Bold.ttf` 12 MB appears in BOTH
`.next/static/media/` and `.next/server/chunks/static/media/`; fonts total 58.6 MB §4).

---

## 3. Inside `/app` — tree + top files + extension histogram

`du -h --max-depth` per directory, creator `/app` (398 MB):
```
apps 269M   -> apps/game/.next 246M   (standalone: common/temp/node_modules 143M
                                        + apps/game/.next nested 102M -> server 29M + static 73M)
             apps/local-engine 24M    -> data 23M (IPFS-style blobs), src 228K, dist 4K
services 128M -> game-server/node_modules 125M (.pnpm, 345 pkgs) + dist 2.5M
node_modules 2.1M   internals 48K   distribution 16K
```
The `.next/standalone` is a **fully self-contained deployable Next app sitting inside the build
output** (143 MB its own `node_modules` + 102 MB nested `.next` server) — i.e. the dependency tree
is materialised twice per web image.

Top files (`find . -type f -printf '%s\t%p\n' | sort -rn`):
```
48M  …/@swc/core-linux-x64-gnu/swc.linux-x64-gnu.node   (standalone node_modules)
18M  …/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so  (game-server)
12M  ChillRoundGothic-Bold.096e89c0.ttf   (x2 copies: static/media + server/chunks)
11M  …/@esbuild/linux-x64/bin/esbuild
11M  sql.js/dist/worker.sql-asm-debug.js   (DEBUG build)
11M  sql.js/dist/sql-asm-debug.js          (DEBUG build)
8.6M typescript/lib/typescript.js          (x2: game-server + standalone)
7.6M ChillRoundGothic-Bold…woff (x2) … 5.2M MiSans woff (x2)
5.8M typescript/lib/tsc.js
4.6M …/.next/static/vs/language/typescript/tsWorker.js  (Monaco editor)
4.5M ffmpeg-audio/ffmpeg.js
4.3M …/next/dist/server/capsize-font-metrics.json
4.3M sass/sass.dart.js
4.0M next/dist/compiled/amphtml-validator/validator_wasm.js
3.8M babel-plugin-react-compiler/dist/index.js
3.5M …/.next/static/vs/editor/editor.main.js  (Monaco editor)
```

Extension histogram — by BYTES (creator, `find -name '*.<ext>' -printf '%s\n' | paste -sd+ | bc`):
| ext | bytes |
|---|---|
| `.js` | 173.4 MB (8 086 files) |
| `.node` native | 53.1 MB |
| fonts (ttf/woff/woff2/otf) | 58.6 MB |
| data blobs | ~23 MB |
| `.wasm` | 2.39 MB (2 files) |
| `.ts` | 1.26 MB (11 files) |
| `.map` | **0.385 MB (11 files)** |
| `.png` | 1.12 MB |

Extension histogram — by COUNT (top): 8083 `js`, 963 `json`, 254 `cjs`, 109 `cts`, 62 `h`, 57
`npmignore`, 54 `yml`, 51 `mjs`, 37 `cc`, 26 `txt`, 25 `jst`, 21 `eslintrc`, 15 `mts`, 14 `node`,
13 `nycrc`. The `.h`/`.cc` (node-gyp native-build sources), `eslintrc`, `nycrc`, `npmignore` are
package-tree cruft, individually tiny.

---

## 4. Source maps & dead weight

- **Source maps: NOT a bloat source.** 384 878 B in creator and the identical 384 878 B in play
  (from the shared game-server `dist`); **0** in voxa and ps. Maps were largely stripped.
- **Tests/docs/licences**: `find` counts in creator → README 2, `*.md` 5, LICENSE 301 (one per
  bundled package, ~11 kB each ≈ 3 MB, duplicated across images), CHANGELOG 2, `test/__tests__`
  dirs 3, `.eslintrc*` 31, `.nycrc*` 13. Small individually, but they ride in every image.
- **`.ts` sources**: only 11 files / 1.26 MB — the shipped JS is compiled output, not TS source.
- **Dev/build-only JS+native actually shipped into the production image (creator), measured:**
  | package | bytes | role at runtime |
  |---|---|---|
  | `@swc/core-linux-x64-gnu` (.node) | 48.0 MB | build transpiler — **referenced 0× in game-server/dist** (`grep -rl '@swc/core' …/dist` = 0); used by Next only at build time |
  | `typescript` | 33.3 MB | dev dep — never `require`d at runtime |
  | `babel` (plugin-react-compiler + next/dist/compiled/babel*) | 30.9 MB | build-time |
  | `sql.js` `*-debug.js` variants | 22.7 MB (of 39.1 MB total sql.js) | **debug** asm builds; only ONE variant is loaded |
  | `esbuild` binary | 11.5 MB | build bundler binary |
  | `sass.dart.js` | 4.3 MB | build CSS compiler |
  | `amphtml-validator/validator_wasm.js` | 4.0 MB | AMP validator — irrelevant to a voxel game |
  | **subtotal** | **≈154 MB (~39% of /app)** | |
- **Monaco editor** (`.next/static/vs/`) = 12.6 MB — the in-browser code editor; load-bearing for
  **creator/edit only**, yet present in play/ps web trees too.
- **No 3D lib in node, no ML, no embedded browser**: `three`=0, `babylon`=0, `pixi`=0, `onnx`=0,
  `playwright`=0, `puppeteer`=0, `electron`=5 (stray matches, no runtime), `.wasm`=2 files. The
  voxel renderer is not a vendored three/babylon/pixi dependency — rules out the usual "3D lib
  bloat" hypothesis. `INFERRED`: rendering lives in the client `.next` chunks + `@box/*` engine code.
- **Readability for the RE lane:** the shipped JS is **plain, re-readable source**.
  `apps/local-engine/src/launcher.js` starts `"use strict";const fs=require("fs");…` with full
  identifiers (`resolveMapRuntimeNamespace`, `startScheduledContainer`, `terminateRuntimeChild`)
  and is a single minified-onto-one-line but un-obfuscated bundle. `game-server/dist/src/launch.js`
  is tsc/swc CJS with comments (`game launcher commands: --hash=HASH …`) and per-module
  `require("./utils/logger")`. So the server logic is trivially readable — **no minification or
  mangling was applied to the server-side code.** (`INFERRED`: Next *client* chunks under
  `.next/static/chunks` ARE webpack-minified, e.g. first line length 1, but are un-mapped.)

---

## 5. Why `node_modules` is only 2.1 MB — bundler & native deps

`/app/node_modules` = 2.1 MB because the real dependencies live in **two pnpm stores**, not the
root:
- `services/game-server/node_modules/.pnpm` = **125 MB**, 345 packages — **game-server is
  UNBUNDLED**: its `dist` is tsc/swc-transpiled CJS that `require()`s modules at runtime, so the
  full runtime dependency tree must ship. Confirmed from `grep -rhoE 'require\("[^"]+"\)'`:
  `@box/apis`, `@box/build-system`, `@box/content-server`, `@box/env`, `@box/mudb`,
  `@box/schema`, plus `sql.js`, `isolated-vm`, `@ai-sdk/*`, `zod`, `axios`, `better-sse` etc.
- `apps/game/.next/standalone/common/temp/node_modules/.pnpm` = **143 MB**, 256 packages — the
  Next `output: standalone` copy re-materialises the web app's whole dep tree inside the build.

pnpm is confirmed by the `.pnpm/` store layout + symlinked top-level (`ai -> .pnpm/ai@5.0.92_…`),
and the workspace scheme `@box+schema@file+..+..+internals+schema`. **Monorepo tooling = Rush**
(`rushx build:creator` referenced verbatim in launcher.js) over pnpm workspaces.
**Web bundler = Next.js 15.5.24** (webpack + `swcMinify`; `@swc/core` 1.4.13, `@esbuild/linux-x64`
0.28.2 present as transitive build deps). **Server bundler = TypeScript/swc** (`@swc-node/register`
in the dev launch path, compiled CJS in `--production`).

Runtime **native `.node` deps** (`find . -name '*.node'`): 53.1 MB total —
`@swc/core-linux-x64-gnu.node` (48 MB), `isolated-vm@5.0.4` (V8 sandbox for the map scripting VM,
`VM:ivmp` in launcher), plus small ones. Heavyweights present and their verdict:
`sharp`+`libvips` (18 MB, image pipeline — used by backend), `better-sse` (backend, resolved
explicitly in the Dockerfile), `sql.js` (38 MB — WASM SQLite; the DB layer via `@box/mudb`),
`@swc/core` (48 MB — **build only**), `typescript`/`sass`/`esbuild`/`babel` (build only).
No `better-sqlite3`, no `pg`, no `canvas`, no `playwright`.

---

## 6. Per-file attribution — top 20 JS chunks (creator)

`find . -name '*.js' -printf '%s\t%p\n' | sort -rn | head -20` → these 20 = **88.4 MB** of the 173
MB of JS.
| # | bytes | file | identity / verdict |
|---|---|---|---|
|1|11.07M|sql.js/dist/worker.sql-asm-debug.js|**WASTE** — debug asm build|
|2|11.07M|sql.js/dist/sql-asm-debug.js|**WASTE** — debug asm build|
|3|8.93M|typescript/lib/typescript.js (game-server)|**WASTE** — dev dep|
|4|8.93M|typescript/lib/typescript.js (standalone)|**WASTE** — same file dup|
|5|6.08M|typescript/lib/tsc.js|**WASTE** — compiler CLI|
|6|4.60M|.next/static/vs/…/tsWorker.js|Monaco TS worker — client, editor-only|
|7|4.51M|ffmpeg-audio/ffmpeg.js|ffmpeg.js — backend audio (load-bearing)|
|8|4.26M|sass/sass.dart.js|**WASTE** — build CSS compiler|
|9|4.01M|next/…/amphtml-validator/validator_wasm.js|**WASTE** — AMP validator|
|10|3.83M|babel-plugin-react-compiler/dist/index.js|**WASTE** — build plugin|
|11|3.52M|.next/static/vs/editor/editor.main.js|Monaco editor core — editor-only|
|12|2.82M|.next/static/chunks/393…js|Next webpack client chunk (`INFERRED` React+vendor)|
|13|2.48M|sql.js/dist/sql-asm-memory-growth.js|**WASTE** — redundant variant|
|14|2.48M|sql.js/dist/worker.sql-asm.js|**WASTE** — redundant variant|
|15|2.47M|sql.js/dist/sql-asm.js|sql.js asm build (one is load-bearing)|
|16|1.75M|.next/static/chunks/3494…js|Next client chunk|
|17|1.54M|next/compiled/babel-packages/packages-bundle.js|**WASTE** — build|
|18|1.38M|.next/server/chunks/4992.js|Next SSR server chunk (load-bearing)|
|19|1.36M|next/compiled/babel/bundle.js|**WASTE** — build|
|20|1.29M|.next/static/chunks/8438…js|Next client chunk|

≈ **60 MB of the top 20 alone** are build-time/debug artifacts.

---

## 7. Theoretical floor — what one process actually loads

Entrypoint: `tini -- node apps/local-engine/src/launcher.js --production --creator`. `launcher.js`
`require`s sibling modules in `apps/local-engine/src/` and then `spawn`s two processes:
- game-server: `node services/game-server/dist/src/launch.js --useProdBundle` (unbundled CJS →
  loads `@box/*` + runtime `node_modules`: one sql.js build, isolated-vm, ai-sdk, zod, axios…);
- web: `node server.js` in `.next/standalone/apps/game` (Next SSR → `server/` 29 MB + its runtime
  node_modules; the `static/` 73 MB is served to the browser, not loaded by node).

Boot-critical estimate for ONE creator process (assumptions labelled):
| component | MB | basis |
|---|---|---|
| launcher + local-engine/src | 0.23 | measured (`du src`) |
| game-server/dist | 2.5 | measured |
| game-server **runtime** node_modules (strip ts/sass/babel/esbuild/amp/swc + sql.js debug) | ~45 | measured 125 MB − ~80 MB build/dev = INFERRED |
| next standalone `server/` + runtime deps (react/next/styled-jsx) | ~60 | measured server 29M + subset of 143M, INFERRED |
| **node-boot working set** | **≈116 MB** | vs 398 MB shipped |
| + client `static/` served once (for functional web) | +73 | measured |
| + world demo blobs | +23 | measured (`du data`) |
| **functional single-service floor** | **≈189 MB app + 266 MB base ≈ 455 MB/image** | |

So **~210 MB of each fat image is not loaded at all.** Across the six images, if you (a) de-dup
the 613 MB of cross-image shared content into one volume, (b) strip the ~154 MB/image of build-only
tooling, and (c) keep one base layer, the whole product's application footprint drops from ~1.2 GB
of `/app` to roughly **the 420 MB deduped set minus build-only ≈ ~270 MB of unique app**, on a
single shared base. (Whole-set figure is a sum of measured parts, not a re-extraction; INFERRED.)

---

## 8. Compression transport

`~/box3/BOX3-Engine-Server-0.2.0-linux-amd64/box3-engine-play-server-images-v0.2.0-linux-amd64.tar.gz`
= **707 806,289 B (707.8 MB gz)**, carrying the v0.2.0 image set for all six services (the running
host is on v0.3.0). The dir totals 884 MB (rest = per-project `.snapshots` at ~10–20 MB each).
Splitting the gz internally is `UNVERIFIED` (would require `tar -tv` streaming), but composition
follows from §1–§2:
- `INFERRED` — the **6 node/JS bases** dominate: even though `docker save` stores shared base layers
  once, the standalone `node_modules` (143 MB) + game-server `pnpm` (125 MB) are NOT shared layers
  across the web vs backend images, so they compress into the tar multiple times → they and the fonts
  are the bulk of the 707 MB.
- `INFERRED` — app *source* (readable JS) is a small fraction: creator `/app` `.js` = 173 MB but gz
  compresses text ~5×, so the JS payload is minor; the tar is **native binaries + WASM + fonts +
  duplicated node_modules**, exactly the categories §4–§6 flag as waste.

---

## 9. Judgement — top bloat causes ranked by MB (cheapest no-rewrite fix)

MB shown are the removable bytes; cross-image items note the per-image × multiplier.

| # | Bloat cause | Removable MB | Cheapest fix (no rewrite) |
|---|---|---|---|
| 1 | Cross-image re-shipment of `.next/standalone` + `game-server` `node_modules` | **613 MB** (4 imgs) | Publish ONE shared `node_modules`/volume layer or base app image that creator/play/ps/voxa extend; or OCI digest layer-sharing. No code change. |
| 2 | `.next/standalone` bundles the full dep tree **twice** (143M node_modules + nested 102M `.next`) | ~140 MB/img | Set `output:'standalone'` ONCE and COPY the static dir separately; do not nest the standalone copy inside the served `.next`. |
| 3 | Build-only deps shipped (`@swc` 48, `typescript` 33, `babel` 31, `esbuild` 11, `sass` 4, `amphtml` 4) | ~130 MB/img | Two-stage build: COPY only `pnpm --prod` / `next` runtime subset; drop `node_modules/.pnpm/{typescript,esbuild,sass,babel*,@swc,amphtml}*`. |
| 4 | `sql.js` debug + redundant asm variants (only 1 of 4 loads) | ~22.7 MB/img | Ship the single needed build (or replace sql.js WASM with `better-sqlite3`); `pnpm deploy` prunes. |
| 5 | Node base runtime ×5 images (auth-portal = 230 MB for 280 KB of app) | ~266 MB × shared | `node:22-alpine` or distroless-node cuts debian 85M+apt 7M+certs 21M; already deduped on host, still shrinks the tar & cold-pull. |
| 6 | Fonts duplicated in-image & cross-image (`ChillRoundGothic` 12 MB ×2, MiSans ×2; 58.6 MB/img) | ~30–58 MB/img | One copy under `static/media` (drop `server/chunks` copy); subset/`woff2` only. |
| 7 | Monaco editor (12.6 MB) shipped in play/ps/voxa which have no editor | ~12 MB/img | Route `.next/static/vs` into creator only. |
| 8 | Per-file COPY layers (~35 tiny layers in creator) + LICENSE/`.npmignore`/`.eslintrc` cruft | MBs + build latency | Bundle server `src` into one `COPY apps/local-engine` layer; `pnpm deploy --omit=…` strips package cruft. |

### STRUCTURAL bloat (fixable only by a redesign, not by trimming)
- **`output: standalone` re-embedding `node_modules` is inherent to Next.js.** You can trim it but
  the "self-contained duplicate tree" pattern is a Next design choice; a non-Next SSR or a real
  single-bundle server build removes the 143 MB second copy outright.
- **Unbundled `tsc/swc → CJS` server** forces the whole `@box/*` + runtime dep tree to ship (game-
  server `dist` `require()`s at runtime). A true bundle (esbuild `--bundle` for the server, or
  a Go/Rust/compiled core like the existing `server-manager`) collapses 125 MB → tens of MB.
- **Rush + pnpm multi-image distribution**: without a shared content layer / registry, N images each
  re-carry the base + the standalone tree. This is a Docker+monorepo distribution property — only
  fixable by changing how artifacts are packaged (single image with subcommands, or a shared volume),
  i.e. an architectural change, not a lint rule.
- **Node/V8 + WASM footprint** (isolated-vm sandbox for the map scripting VM is genuinely load-
  bearing and cannot be "trimmed") — the runtime's memory model requires a real Node process per
  map; a lighter engine would replace this entirely.

Everything above is measured from `/tmp/re-size` extractions of `box-local-engine-*:v0.3.0-linux-amd64`;
the live stack, `~/box3`, and the running containers were not modified.
