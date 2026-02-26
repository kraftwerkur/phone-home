# Phone Home — Code Review Stage 4: Performance

**Reviewer:** Reef  
**Date:** 2026-02-26  
**Scope:** `hub/server.js` (main server, ~490 lines), `detect_person.py` (YOLO inference)

---

## 1. WebSocket Efficiency 🟢 Good

**Connections are managed properly.** Each connection gets a UUID, is tracked in the `nodes` Map, and cleaned up on `close` (lines 237–241). The `prevFrames` entry is also deleted on disconnect, preventing stale references.

**No leaks detected.** Admin clients are tracked in a `Set` and removed on close (lines 218–222). The `pending` map entries have timeouts that auto-clean (line 415).

**Minor concern — no ping/pong keepalive:**  
There's no WebSocket heartbeat at the protocol level. If a client silently drops (e.g., phone goes to sleep without closing cleanly), the `nodes` Map entry will persist indefinitely. The application-level `heartbeat` message (line 260) updates `lastHeartbeat` but nothing *reaps* stale nodes.

**Fix:**
```js
// Add after line 70 (after bwHistory interval)
setInterval(() => {
  const now = Date.now();
  for (const [id, node] of nodes) {
    if (now - node.lastHeartbeat > 120000) { // 2 min stale
      console.log(`[💀] Reaping stale node: ${id} (${node.name || 'unnamed'})`);
      if (node.ws) node.ws.terminate();
      nodes.delete(id);
      prevFrames.delete(id);
      clipState.delete(id);
      bwHistory.delete(id);
      broadcastToAdmins({ type: 'node-disconnected', id, name: node.name });
    }
  }
}, 60000);
```

---

## 2. Video Pipeline Throughput 🟡 Needs Attention

**Pipeline:** Motion detect → 5s clip capture → YOLO → LLaVA → Telegram

**Bottleneck analysis:**

| Stage | Estimated Time | Notes |
|-------|---------------|-------|
| Motion detection (`sharp` resize + pixel diff) | ~5–15ms | Fine |
| Clip capture | 5s (fixed) | By design |
| ffmpeg stitching | ~1–3s | `ultrafast` preset, good |
| YOLO inference | ~0.5–2s | See §5 |
| LLaVA inference | ~5–30s | **Dominant bottleneck** |
| Telegram API | ~0.5–1s | Async, fire-and-forget — good |

**Total pipeline latency: ~12–40s from motion trigger to alert.**

The pipeline is sequential within `finalizeClip()` (lines 327–430). This is fine for single-node operation but becomes a problem with concurrent nodes — see §7.

**The `sharp` resize in motion detection (line 294) runs on every frame.** For a 10fps stream, that's 10 sharp operations/sec/node. Sharp uses libvips (thread pool), so it's efficient, but at 3+ nodes this becomes non-trivial.

---

## 3. Memory Usage 🔴 Critical

**Clip frame accumulation (lines 283–290, 301–309):**  
During a 5-second clip recording, every JPEG frame is held in memory in `clip.frames[]`. At 10fps with ~50KB/frame (medium quality 160x120... but wait — the *original* JPEG is stored, not the resized one):

```js
clip.frames.push({ buffer: jpegBuffer, ts: Date.now() }); // line 288 — ORIGINAL size
```

If the camera sends 640x480 JPEGs (~30–80KB each), 50 frames × 80KB = **4MB per clip per node.** That's manageable, but at higher resolutions or more nodes it adds up. And frames are only freed after `finalizeClip()` completes (including the slow LLaVA call).

**Fix — write frames to disk during capture instead of holding in RAM:**
```js
// In checkMotion, instead of clip.frames.push({buffer, ts}):
const padded = String(clip.frameIndex++).padStart(5, '0');
const framePath = path.join(clip.tmpDir, `frame-${padded}.jpg`);
fs.writeFileSync(framePath, jpegBuffer);
clip.frameCount++;
```

**`prevFrames` stores raw pixel buffers (line 297):**  
160×120×3 = 57,600 bytes per node. Negligible.

**`bwHistory` (lines 62–69):**  
180 samples × ~50 bytes × N nodes. Negligible.

**Synchronous `fs.readFileSync` in `sendTelegramAlert` (line 36):**  
Reads entire thumbnail into memory synchronously. Not a leak, but blocks the event loop. Use `fs.createReadStream` instead.

**`Buffer.from(data)` on line 251 creates an unnecessary copy:**  
WebSocket `data` is already a Buffer. This doubles memory briefly for every binary message.

```js
// Line 251: remove unnecessary copy
// Before:
const buffer = Buffer.from(data);
// After:
const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
```

---

## 4. HTTP Polling Fallback 🟡 Needs Attention

**No defined polling interval on the server side.** The server just responds to whatever rate the client polls at. This is fine architecturally (client controls rate), but:

1. **No rate limiting on `/api/poll/:id/poll` (line 125).** A misbehaving client could hammer this endpoint.
2. **`/api/poll/:id/snap` (line 135) accumulates the entire body with `req.on('data')` chunks** — no size limit. A malicious or buggy client could send gigabytes.

**Fix — add body size limit:**
```js
app.post('/api/poll/:id/snap', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Unknown node' });
  const MAX_SNAP_SIZE = 2 * 1024 * 1024; // 2MB
  const chunks = [];
  let totalSize = 0;
  req.on('data', chunk => {
    totalSize += chunk.length;
    if (totalSize > MAX_SNAP_SIZE) {
      res.status(413).json({ error: 'Snap too large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  // ...rest unchanged
});
```

3. **Stale polling nodes are never reaped** (same issue as §1). A polling node that stops polling stays in the `nodes` Map forever.

---

## 5. YOLO Inference 🟡 Needs Attention

**Cold start is the real problem.** `detect_person.py` (line 12) loads the YOLO model from scratch every invocation:

```python
model = YOLO("yolov8n.pt")  # Loads ~6MB model every time
```

For YOLOv8 Nano, model loading takes **1–3 seconds**, while actual inference takes **~100–300ms**. This means 80%+ of the time is wasted on loading.

**Fix — persistent YOLO worker:**
```python
#!/usr/bin/env python3
"""Persistent YOLO worker. Reads image paths from stdin, writes JSON to stdout."""
import sys, json
from ultralytics import YOLO

model = YOLO("yolov8n.pt")

for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    try:
        results = model(path, verbose=False, conf=0.35)
        persons = []
        for r in results:
            for box in r.boxes:
                if int(box.cls[0]) == 0:
                    persons.append({
                        "confidence": round(float(box.conf[0]), 3),
                        "bbox": [round(x, 1) for x in box.xyxy[0].tolist()]
                    })
        print(json.dumps({"persons": persons, "count": len(persons)}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e), "persons": [], "count": 0}), flush=True)
```

Then in `server.js`, spawn this once at startup and communicate via stdin/stdout. This eliminates model reload overhead entirely.

**Batching:** Not useful here — alerts are sparse events, not a stream. The bottleneck is per-invocation overhead, not inference throughput.

---

## 6. LLaVA Vision 🔴 Critical

**No timeout on the Ollama fetch (lines 380–395).** If Ollama hangs or the 7B model takes too long, `finalizeClip()` blocks indefinitely. Node's `fetch` has no built-in timeout.

```js
// Line 382 — no timeout, no AbortController
const ollamaRes = await fetch('http://localhost:11434/api/generate', { ... });
```

**Fix:**
```js
const controller = new AbortController();
const ollamaTimeout = setTimeout(() => controller.abort(), 30000); // 30s max
try {
  const ollamaRes = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ /* ...same... */ }),
  });
  clearTimeout(ollamaTimeout);
  // ...process response
} catch (e) {
  clearTimeout(ollamaTimeout);
  console.log(`[⚠️] Vision analysis failed/timed out: ${e.message}`);
}
```

**LLaVA 7B on an RTX 5070 (12GB VRAM):** Inference should be ~3–10 seconds per image. Acceptable for alert enrichment. But if Ollama isn't running or the model isn't loaded, the first call triggers a model load (~30–60s), which could cause cascading delays.

**Recommendation:** Add a health check for Ollama at server startup. If Ollama is unreachable, disable vision analysis rather than failing silently on every alert.

---

## 7. Concurrent Node Handling 🟡 Needs Attention

**Thread safety is a non-issue** — Node.js is single-threaded. No race conditions on shared state.

**However, `finalizeClip()` is async and not queued.** If two nodes trigger motion simultaneously, both will run `finalizeClip()` concurrently. Both will:
- Call ffmpeg (2 concurrent processes — fine)
- Call YOLO (2 concurrent Python processes loading the model — **doubles RAM usage to ~1.5GB**)
- Call LLaVA (2 concurrent Ollama requests — **model contention, doubled inference time**)

**Fix — use a processing queue:**
```js
const clipQueue = [];
let clipProcessing = false;

async function enqueueClip(nodeId) {
  clipQueue.push(nodeId);
  if (!clipProcessing) processNextClip();
}

async function processNextClip() {
  if (clipQueue.length === 0) { clipProcessing = false; return; }
  clipProcessing = true;
  const nodeId = clipQueue.shift();
  await finalizeClip(nodeId);
  processNextClip(); // process next in queue
}
```

This serializes the heavy processing while keeping clip *capture* concurrent.

---

## 8. Disk I/O 🔴 Critical

**There is NO cleanup strategy.** Clips, snapshots, audio, and alerts accumulate forever:

- `data/clips/` — MP4 files + thumbnails, never deleted
- `data/snapshots/` — JPEG snapshots, never deleted  
- `data/alerts/` — JSON alert files, only deleted via manual `DELETE /api/alerts`
- `data/audio/` — WebM audio recordings, never deleted

On a 24/7 system with active motion detection, this **will fill the disk**. At ~1MB per clip + thumbnail, 50 alerts/day = 50MB/day = **~1.5GB/month**.

**Fix — add a cleanup interval:**
```js
const MAX_DATA_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

setInterval(() => {
  const cutoff = Date.now() - MAX_DATA_AGE_MS;
  for (const dir of [CLIP_DIR, SNAPSHOT_DIR, AUDIO_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      const subPath = path.join(dir, sub.name);
      if (sub.isDirectory()) {
        for (const f of fs.readdirSync(subPath)) {
          const fp = path.join(subPath, f);
          try {
            if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
          } catch {}
        }
      }
    }
  }
  console.log('[🧹] Old data cleanup complete');
}, 6 * 60 * 60 * 1000); // every 6 hours
```

**Synchronous I/O throughout:** `fs.writeFileSync`, `fs.readFileSync`, `fs.readdirSync` are used everywhere. These block the event loop during I/O. For the frame-writing in `finalizeClip()` (lines 341–344), writing 50 frames synchronously takes ~50–200ms of blocked event loop.

**Recommendation:** Convert hot paths to async `fs.promises.*`. Priority targets:
- Frame writing in `finalizeClip()` (line 343)
- Alert JSON writing (line 413)
- Snapshot/audio saving (lines 268, 281)

---

## Summary

| Area | Rating | Key Issue |
|------|--------|-----------|
| WebSocket efficiency | 🟢 Good | Add stale node reaping |
| Video pipeline throughput | 🟡 Needs Attention | Sequential pipeline OK for now, LLaVA dominates |
| Memory usage | 🔴 Critical | Clip frames held in RAM during LLaVA; unnecessary Buffer copies |
| HTTP polling fallback | 🟡 Needs Attention | No body size limit, no rate limiting |
| YOLO inference | 🟡 Needs Attention | Model reloaded every invocation (~2s wasted) |
| LLaVA vision | 🔴 Critical | No timeout on fetch — can hang forever |
| Concurrent node handling | 🟡 Needs Attention | Concurrent finalizeClip can overload GPU/RAM |
| Disk I/O | 🔴 Critical | No cleanup — disk fills indefinitely; sync I/O blocks event loop |

### Top 3 Fixes (by impact):

1. **Add AbortController timeout to LLaVA fetch** — prevents server hang (5 min fix)
2. **Add data cleanup interval** — prevents disk exhaustion (15 min fix)
3. **Persistent YOLO worker process** — eliminates ~2s model reload per alert (30 min fix)
