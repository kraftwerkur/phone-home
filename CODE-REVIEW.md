# Code Review: Phone Home
**Date:** 2026-02-25
**Reviewer:** Reef (Autonomous)
**Commit:** 0eb5d1c

## Executive Summary

This is a clean, well-architected single-purpose project that follows the Karpathy philosophy almost perfectly: one server file, one client file, one admin file, one Python script. The whole system is readable top-to-bottom in under an hour. The main issues are: **zero tests, zero authentication on the API, and several resource leak risks in a long-running server**. The #1 thing to fix is adding auth to the HTTP API — right now anyone on the LAN can control your cameras.

## Project Overview
- **Stack:** Node.js/Express, WebSocket (ws), sharp, Python/ultralytics (YOLOv8), Ollama/LLaVA, vanilla JS client
- **Size:** 6 files of substance, ~2,800 LOC total, 0 test files, 0 tests
- **Test Results:** No test suite exists

## 1. Architecture

🟢 **Single-file server is the right call.** 886 lines for the entire hub is perfectly manageable. No routers, no controllers, no middleware abstraction layers. Good.

🟢 **Pipeline design is smart.** Motion → clip → YOLO pre-filter → LLaVA only if person detected. The YOLO gate saves significant GPU/CPU time by filtering out pet/shadow triggers before the expensive vision model runs.

🟢 **Polling fallback is well-conceived.** Auto-detecting WS failure and falling back to HTTP polling for old iOS is pragmatic engineering. Same client page handles both modes transparently.

🟢 **Two-port design (HTTPS 3900 + HTTP 3902) is correct.** Camera/mic need secure context; local API calls don't need TLS overhead.

🟡 **YOLO model loads fresh on every detection call.** `detect_person.py` is invoked as a subprocess each time, which means `YOLO("yolov8n.pt")` loads the model from scratch for every motion event. This adds 2-5 seconds of latency per detection. For a v0.1 this is fine, but a persistent Python process with a simple stdin/stdout or HTTP interface would cut detection latency dramatically.

🟡 **No graceful shutdown.** No `SIGTERM`/`SIGINT` handler. WebSocket connections, intervals, and pending promises will leak on restart. For a long-running home server, this matters.

🟡 **`_origSendCommand` is defined but never used.** Lines 119-128 define a function assigned to a `const` that shadows the real `sendCommand` (defined later at line 479). Dead code.

## 2. Code Quality

**Grade: B+**

This is clean, readable code. The Karpathy-style single-file approach works well here. A few issues:

🟢 **Naming is excellent.** `checkMotion`, `finalizeClip`, `sendTelegramAlert`, `handleBinaryMessage` — all self-documenting. No cute names, no abbreviations that require lookup.

🟢 **No over-engineering.** No dependency injection, no abstract base classes, no config framework. Environment variables read directly. `Map` for state. Simple.

🟢 **Client iOS compat is thoughtful.** `var` throughout, `getUserMedia` polyfill, `toBlob` fallback with `toDataURL`+manual base64 decode. Shows real-world testing against old devices.

🟡 **Duplicate `formatBytes` in admin/index.html.** Lines ~304 and ~328 define `formatBytes` twice with slightly different formatting (one has spaces before units, one doesn't). The second definition silently overwrites the first. Only one is needed.

```javascript
// First definition (line ~304):
function formatBytes(b) {
  if (b < 1024) return b + ' B';
  // ...
}

// Second definition (line ~328) — overwrites first:
function formatBytes(b) {
  if (b < 1024) return b + 'B';
  // ...
}
```

🟡 **`guessModel()` in admin is defined but never called.** Dead code — 17 lines of iPhone model detection that nothing references.

🟡 **Synchronous file I/O in hot paths.** `fs.writeFileSync` is used in `saveSnapshot`, `saveAudio`, motion frame saving, and alert writing. In a server handling multiple streaming nodes, these block the event loop. Should be `fs.promises.writeFile` or `fs.writeFile` with callbacks. The `checkMotion` and `finalizeClip` functions are async but still use sync writes internally.

Specific locations:
- `server.js:299` — `fs.writeFileSync(filepath, buffer)` in `saveSnapshot`
- `server.js:311` — `fs.writeFileSync(filepath, buffer)` in `saveAudio`
- `server.js:350` — frame writes in `finalizeClip` loop
- `server.js:130` — `fs.writeFileSync(snapPath, buf)` in poll snap handler

🟡 **`clipState` frames accumulate in memory.** During a 5-second clip at ~2fps, this is fine (~10 JPEG frames). But if frame rate increases or clip duration extends, raw JPEG buffers pile up in memory with no cap. Consider a max frame count.

🔵 **Minor: `node?.name` optional chaining used inconsistently.** Sometimes `node.name || nodeId`, sometimes `node?.name || nodeId`. The node is already null-checked at the top of these functions, so `?.` is unnecessary noise.

## 3. Tests

🔴 **No tests exist.** Zero. None.

This is the biggest gap. For a security system, the most critical things to test:

1. **Motion detection logic** — the pixel diffing in `checkMotion`. Can be unit tested with synthetic buffers.
2. **Clip finalization pipeline** — mock ffmpeg, verify alert JSON structure.
3. **Polling fallback** — register → poll → receive commands → upload snap.
4. **Cooldown logic** — verify 30-second cooldown between clips works.
5. **Threshold per-node** — verify custom thresholds override defaults.

The motion detection algorithm is pure logic operating on pixel buffers — extremely testable. This should be the first test written.

**Verdict:** Inadequate. The detection pipeline is the core value of the project and has zero test coverage.

## 4. Performance

🟢 **Frame downscaling before comparison.** Resizing to 160×120 before pixel diffing is smart — fast comparison while still catching meaningful motion.

🟢 **Sharpest-frame selection for YOLO.** Using stdev of greyscale as a sharpness proxy to pick the best frame from a clip is clever and cheap.

🟡 **`dirSize()` in `/api/stats` is recursive and synchronous.** Walks the entire `data/` directory tree on every stats API call. As snapshots accumulate (hundreds of node-specific directories with thousands of JPEGs), this will block the event loop for seconds. Cache the value or compute it on an interval.

```javascript
// server.js line ~186 — called on every GET /api/stats
function dirSize(dir) {
  // Synchronous recursive walk of potentially huge data dir
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    // ...
  }
}
```

🟡 **Alert count in `/api/stats` reads and parses every alert JSON file.** Same problem — reads every file in `data/alerts/` to check if its timestamp matches today. Should be an in-memory counter.

🟡 **Bandwidth history interval runs forever for disconnected nodes.** The `setInterval` at line 68 iterates all entries in `nodes`, but `bwHistory` entries are never cleaned up when nodes disconnect. The `nodes.delete(id)` in the WS close handler removes the node but `bwHistory` retains the entry forever.

🟡 **YOLO subprocess per detection** (mentioned above). Model load time dominates detection latency.

## 5. Security

🔴 **No authentication on the HTTP API.** Anyone on the LAN can:
- List all camera nodes (`GET /api/nodes`)
- Take snapshots from any camera (`POST /api/nodes/:id/snap`)
- Record audio from any camera (`POST /api/nodes/:id/listen`)
- Enable/disable motion detection
- View and delete all alerts
- Access all clips and thumbnails

For a security camera system, this is ironic. At minimum, add a bearer token check (read from `.env`) on all `/api/*` routes.

🔴 **No authentication on WebSocket connections.** Any device on the network can connect as a camera node or as an admin client. An attacker could:
- Connect as admin and receive all alerts in real-time
- Connect as a node and inject fake frames/alerts
- Register polling nodes to flood the server

🟡 **Path traversal in clip/thumbnail endpoints.** `req.params.filename` is passed directly to `path.join` and then `res.sendFile`:

```javascript
// server.js line ~219
app.get('/api/clips/:nodeId/:filename', (req, res) => {
  const clipPath = path.join(CLIP_DIR, req.params.nodeId, req.params.filename);
  // ...
  res.sendFile(clipPath);
});
```

If `filename` contains `../`, an attacker could read arbitrary files. Validate that the resolved path is still within `CLIP_DIR`:

```javascript
const clipPath = path.resolve(CLIP_DIR, req.params.nodeId, req.params.filename);
if (!clipPath.startsWith(path.resolve(CLIP_DIR))) return res.status(403).end();
```

Same issue with `/api/thumbs/:nodeId/:filename`.

🟡 **Self-signed certs served for download without any protection.** `GET /cert` serves the CA certificate. This is by design for easy iPhone setup, but anyone on the network can download it. Document that this is LAN-only and should not be exposed to the internet.

🟡 **Telegram bot token in .env.** Fine for self-hosted, but `.env` should have `600` permissions. `setup.sh` doesn't set this.

🟢 **`.gitignore` correctly excludes `.env`, `data/`, `certs/`, `venv/`.** No secrets in the repo.

🟢 **HTTP API bound to `127.0.0.1` only.** Good — the unauthenticated API isn't exposed to the network. Only HTTPS is on `0.0.0.0`.

Wait — but the HTTPS server serves the same Express `app`, which means all `/api/*` routes are also available on the HTTPS port (3900) to the entire network. The `127.0.0.1` binding on HTTP is a false sense of security.

🔴 **All API endpoints are accessible on the HTTPS port (0.0.0.0:3900).** The same `app` instance is used for both HTTP and HTTPS servers. This means every `/api/*` endpoint (snap, listen, alerts, motion control) is accessible to anyone on the network via `https://<ip>:3900/api/nodes`. The HTTP-only binding is effectively meaningless for security.

## Top Issues (Priority Order)

| # | Severity | Category | Issue | Recommendation |
|---|----------|----------|-------|----------------|
| 1 | 🔴 | Security | No auth on API — all camera controls exposed on network HTTPS port | Add bearer token middleware on `/api/*` routes, read token from `.env` |
| 2 | 🔴 | Security | No auth on WebSocket — anyone can connect as admin or fake node | Require token as query param or first message |
| 3 | 🔴 | Security | Path traversal in `/api/clips` and `/api/thumbs` | Validate resolved path stays within target directory |
| 4 | 🔴 | Tests | Zero test coverage | Add tests for motion detection, clip pipeline, polling flow |
| 5 | 🟡 | Performance | Sync file I/O in async hot paths blocks event loop | Switch to `fs.promises` / `fs.writeFile` |
| 6 | 🟡 | Performance | `dirSize()` recursive sync walk on every `/api/stats` call | Cache disk usage, update on interval |
| 7 | 🟡 | Performance | YOLO model reloads on every detection | Consider persistent Python process |
| 8 | 🟡 | Reliability | No graceful shutdown handler | Add SIGTERM/SIGINT handler to close WS, clear intervals |
| 9 | 🟡 | Reliability | `bwHistory` never cleaned up for disconnected nodes | Delete entry in WS close handler |
| 10 | 🔵 | Code Quality | Dead code: `_origSendCommand`, duplicate `formatBytes`, unused `guessModel` | Remove |

## Strengths

- **Karpathy-perfect structure.** 4 files do everything. No framework bloat, no router files, no middleware chains, no config loaders. You can read the entire system in 30 minutes.
- **Brilliant iOS compat engineering.** The polling fallback, `var`-only client, `getUserMedia` polyfill, `toBlob`/`toDataURL` fallback — this is battle-tested against real old hardware.
- **Smart detection pipeline.** YOLO as a pre-filter for LLaVA is the right architecture. Cheap filter → expensive analysis only when needed.
- **Admin dashboard is impressive.** Real-time bandwidth charts, live feed, map with Leaflet, clip playback — all in a single HTML file with no build system.
- **PWA support.** Service worker, manifest, apple-mobile-web-app meta tags. The phones can run this as a homescreen app.
- **README is excellent.** Architecture diagram, API reference, clear setup instructions, honest about requirements.

## Recommended Next Steps

1. **Add API authentication** — bearer token from `.env`, middleware on all `/api/*` routes. Split routes so HTTPS only serves client static files + WebSocket, not API endpoints. Or gate API routes behind auth. **[S — 30 min]**
2. **Fix path traversal** — 4 lines of validation on the two file-serving endpoints. **[S — 10 min]**
3. **Add basic tests** — motion detection pixel diffing is pure functions, very testable. Add vitest or node:test, write 5-10 tests for the core pipeline. **[M — 2-3 hours]**
4. **Switch to async file I/O** — find/replace `writeFileSync` → `await fs.promises.writeFile` in the async functions. **[S — 20 min]**
5. **Cache disk usage** — compute on a 60-second interval instead of per-request. **[S — 15 min]**
6. **Clean up dead code** — remove `_origSendCommand`, duplicate `formatBytes`, unused `guessModel`. **[S — 5 min]**
7. **Add graceful shutdown** — `process.on('SIGTERM', ...)` to close servers, clear intervals, close WS connections. **[S — 15 min]**
8. **Clean up `bwHistory` on disconnect** — one line in the WS close handler. **[S — 2 min]**
9. **Persistent YOLO process** — long-term improvement, convert `detect_person.py` to a simple HTTP server or stdin/stdout daemon. **[M — 1-2 hours]**

## Design Philosophy Assessment

This codebase is **exactly right** for what it is. Single-file server, single-file client, single-file admin, single-file detector. No abstraction layers, no unnecessary indirection, no build steps. The only structural concern is that the server file could eventually grow past comfortable single-file territory if many more features are added — but at 886 lines, it's well within the "one person can hold it all in their head" threshold. Don't split it up.
