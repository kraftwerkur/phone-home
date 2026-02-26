// Phone Home — Hub Server v0.1
// Express + WebSocket hub that manages iPhone sensor nodes

import express from 'express';
import { createServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { execFile, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------- Telegram ----------
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_ENABLED = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
if (!TELEGRAM_ENABLED) {
  console.log('⚠️  Telegram alerting disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable)');
}

async function sendTelegramAlert(alert) {
  const caption = `🚨 *Person detected* on *${alert.nodeName}*\n` +
    `${alert.description || 'No description'}\n` +
    `👥 ${alert.personCount} person(s) | ${alert.pctChanged}% motion\n` +
    `🕐 ${new Date(alert.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })}`;

  // Send thumbnail with caption
  if (alert.thumbnail && fs.existsSync(alert.thumbnail)) {
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    form.append('photo', new Blob([fs.readFileSync(alert.thumbnail)]), 'alert.jpg');
    
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Telegram API: ${res.status} ${err}`);
    }
    console.log(`[📱] Telegram alert sent for ${alert.nodeName}`);
  } else {
    // Text-only fallback
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: caption, parse_mode: 'Markdown' }),
    });
    console.log(`[📱] Telegram text alert sent for ${alert.nodeName}`);
  }
}

// ---------- Auth ----------
const PHONE_HOME_TOKEN = process.env.PHONE_HOME_TOKEN || '';
const PHONE_HOME_ADMIN_PIN = process.env.PHONE_HOME_ADMIN_PIN || '';

if (!PHONE_HOME_TOKEN) console.log('⚠️  No PHONE_HOME_TOKEN set — API/WS auth disabled (open access)');
if (!PHONE_HOME_ADMIN_PIN) console.log('⚠️  No PHONE_HOME_ADMIN_PIN set — admin PIN disabled');

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

const ADMIN_COOKIE_HASH = PHONE_HOME_ADMIN_PIN ? hashPin(PHONE_HOME_ADMIN_PIN) : '';

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function checkToken(req) {
  if (!PHONE_HOME_TOKEN) return true;
  const q = new URL(req.url, 'http://localhost').searchParams.get('token');
  if (q === PHONE_HOME_TOKEN) return true;
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${PHONE_HOME_TOKEN}`) return true;
  return false;
}

function checkAdminCookie(req) {
  if (!PHONE_HOME_ADMIN_PIN) return true;
  const cookies = parseCookies(req.headers.cookie);
  return cookies.ph_admin === ADMIN_COOKIE_HASH;
}

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || '3900', 10);
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'data', 'snapshots');
const AUDIO_DIR = path.join(PROJECT_ROOT, 'data', 'audio');
const MOTION_THRESHOLD = 5;        // percent of pixels changed to trigger motion
const MOTION_PIXEL_DIFF = 30;      // per-channel difference to count as "changed"
const CLIP_DURATION_MS = 5000;     // record 5 seconds of video on motion
const CLIP_DIR = path.join(PROJECT_ROOT, 'data', 'clips');
const TIMELAPSE_DIR = path.join(PROJECT_ROOT, 'data', 'timelapse');

// Bandwidth history: per-node samples every 10s for last 30min (180 samples)
const bwHistory = new Map(); // nodeId → [{ ts, bytesIn, bytesOut }]
const BW_SAMPLE_INTERVAL = 10000;
const BW_MAX_SAMPLES = 180;

setInterval(() => {
  for (const [id, node] of nodes) {
    if (!bwHistory.has(id)) bwHistory.set(id, []);
    const history = bwHistory.get(id);
    history.push({ ts: Date.now(), bytesIn: node.bytesIn, bytesOut: node.bytesOut });
    if (history.length > BW_MAX_SAMPLES) history.shift();
  }
}, BW_SAMPLE_INTERVAL);

// Ensure data dirs exist
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(CLIP_DIR, { recursive: true });
fs.mkdirSync(TIMELAPSE_DIR, { recursive: true });

// ---------- Disk Cleanup (every 6 hours, delete files older than 7 days) ----------
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CLEANUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cleanupOldFiles() {
  const dirs = [CLIP_DIR, SNAPSHOT_DIR, AUDIO_DIR];
  const cutoff = Date.now() - CLEANUP_MAX_AGE_MS;
  let totalDeleted = 0;

  function walkAndClean(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndClean(full);
        // Remove empty dirs
        try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch (_) {}
      } else {
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(full);
            totalDeleted++;
          }
        } catch (_) {}
      }
    }
  }

  for (const d of dirs) walkAndClean(d);
  if (totalDeleted > 0) {
    console.log(`[🧹] Disk cleanup: deleted ${totalDeleted} file(s) older than 7 days`);
  }
}

// Run on startup + every 6 hours
cleanupOldFiles();
setInterval(cleanupOldFiles, CLEANUP_INTERVAL_MS);

// ---------- Timelapse ----------
const timelapseIntervals = new Map(); // nodeId → intervalId

function getNodeTimelapseConfig(node) {
  return node.timelapse || {
    intervalMinutes: 15,
    activeHoursStart: 6,
    activeHoursEnd: 19,
    timezone: 'America/New_York',
  };
}

function isWithinActiveHours(config) {
  const tz = config.timezone || 'America/New_York';
  const now = new Date();
  // Get current hour in the configured timezone
  const hourStr = now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false });
  const hour = parseInt(hourStr, 10);
  return hour >= config.activeHoursStart && hour < config.activeHoursEnd;
}

function startTimelapseInterval(nodeId) {
  stopTimelapseInterval(nodeId);
  const node = nodes.get(nodeId);
  if (!node || node.mode !== 'timelapse') return;

  const config = getNodeTimelapseConfig(node);
  const intervalMs = (config.intervalMinutes || 15) * 60 * 1000;

  console.log(`[⏱] Timelapse started for ${node.name || nodeId}: every ${config.intervalMinutes}min, ${config.activeHoursStart}:00-${config.activeHoursEnd}:00 ${config.timezone}`);

  const doSnap = () => {
    const n = nodes.get(nodeId);
    if (!n || n.mode !== 'timelapse') { stopTimelapseInterval(nodeId); return; }
    const cfg = getNodeTimelapseConfig(n);
    if (!isWithinActiveHours(cfg)) {
      console.log(`[⏱] Timelapse skip for ${n.name || nodeId}: outside active hours`);
      return;
    }
    // Tag this snap as timelapse so the binary handler saves it correctly
    n._pendingTimelapseSnap = true;
    sendCommand(n, 'snap', {});
    console.log(`[⏱] Timelapse snap requested for ${n.name || nodeId}`);
  };

  // Take first snap immediately if within active hours
  doSnap();
  const id = setInterval(doSnap, intervalMs);
  timelapseIntervals.set(nodeId, id);
}

function stopTimelapseInterval(nodeId) {
  if (timelapseIntervals.has(nodeId)) {
    clearInterval(timelapseIntervals.get(nodeId));
    timelapseIntervals.delete(nodeId);
    console.log(`[⏱] Timelapse stopped for ${nodeId}`);
  }
}

async function saveTimelapseFrame(nodeId, buffer) {
  const nodeDir = path.join(TIMELAPSE_DIR, nodeId);
  fs.mkdirSync(nodeDir, { recursive: true });

  const node = nodes.get(nodeId);
  const tz = node?.timelapse?.timezone || 'America/New_York';
  const now = new Date();
  // Format: YYYY-MM-DD-HHmm.jpg
  const parts = now.toLocaleString('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(/\//g, '-').replace(/,\s*/, '-').replace(':', '');
  // Parse to get clean format
  const y = now.toLocaleString('en-US', { timeZone: tz, year: 'numeric' });
  const m = now.toLocaleString('en-US', { timeZone: tz, month: '2-digit' });
  const d = now.toLocaleString('en-US', { timeZone: tz, day: '2-digit' });
  const h = now.toLocaleString('en-US', { timeZone: tz, hour: '2-digit', hour12: false });
  const min = now.toLocaleString('en-US', { timeZone: tz, minute: '2-digit' });
  const filename = `${y}-${m}-${d}-${h.padStart(2,'0')}${min.padStart(2,'0')}.jpg`;

  const filepath = path.join(nodeDir, filename);
  await fs.promises.writeFile(filepath, buffer);
  console.log(`[⏱] Timelapse frame saved: ${filepath} (${buffer.length} bytes)`);
}

function getTimelapseStats(nodeId) {
  const nodeDir = path.join(TIMELAPSE_DIR, nodeId);
  if (!fs.existsSync(nodeDir)) return { frames: 0, storageBytes: 0, firstFrame: null, lastFrame: null, videoExists: false, videoSize: 0 };

  const files = fs.readdirSync(nodeDir).filter(f => f.endsWith('.jpg')).sort();
  let storageBytes = 0;
  for (const f of files) {
    try { storageBytes += fs.statSync(path.join(nodeDir, f)).size; } catch {}
  }

  const videoPath = path.join(nodeDir, 'timelapse.mp4');
  const videoExists = fs.existsSync(videoPath);
  let videoSize = 0;
  if (videoExists) try { videoSize = fs.statSync(videoPath).size; } catch {}

  return {
    frames: files.length,
    storageBytes,
    firstFrame: files.length > 0 ? files[0].replace('.jpg', '') : null,
    lastFrame: files.length > 0 ? files[files.length - 1].replace('.jpg', '') : null,
    videoExists,
    videoSize,
  };
}

// ---------- YOLO Server Process ----------
const yoloScript = path.join(PROJECT_ROOT, 'detect_person.py');
const pythonBin = process.env.PYTHON_BIN || path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
let yoloProc = null;
let yoloReady = false;
let yoloPendingQueue = []; // [{resolve, reject}]
let yoloBuffer = '';

function startYoloServer() {
  yoloProc = spawn(pythonBin, [yoloScript, '--server'], { stdio: ['pipe', 'pipe', 'pipe'] });
  yoloProc.stdout.on('data', (chunk) => {
    yoloBuffer += chunk.toString();
    let lines = yoloBuffer.split('\n');
    yoloBuffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim() === 'READY') { yoloReady = true; console.log('[🔍] YOLO server ready'); continue; }
      if (!line.trim()) continue;
      const cb = yoloPendingQueue.shift();
      if (cb) {
        try { cb.resolve(JSON.parse(line)); } catch (e) { cb.resolve({ persons: [], count: 0 }); }
      }
    }
  });
  yoloProc.stderr.on('data', (d) => { /* suppress ultralytics warnings */ });
  yoloProc.on('exit', (code) => {
    console.log(`[⚠️] YOLO server exited (code ${code}), restarting...`);
    yoloReady = false;
    // Reject pending
    for (const cb of yoloPendingQueue) cb.reject(new Error('YOLO process exited'));
    yoloPendingQueue = [];
    setTimeout(startYoloServer, 2000);
  });
}

function yoloDetect(imagePath) {
  return new Promise((resolve, reject) => {
    if (!yoloReady || !yoloProc) {
      // Fallback to one-shot
      execFile(pythonBin, [yoloScript, imagePath], { timeout: 30000 }, (err, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch (_) { resolve({ persons: [], count: 0 }); }
      });
      return;
    }
    yoloPendingQueue.push({ resolve, reject });
    yoloProc.stdin.write(imagePath + '\n');
  });
}

startYoloServer();

// ---------- State ----------

// Connected nodes: Map<wsId, { ws, id, name, connectedAt, lastHeartbeat, battery, motionEnabled }>
const nodes = new Map();

// Pending requests: Map<requestId, { resolve, reject, timer }>
const pending = new Map();

// Previous frame per node for motion detection (raw pixel buffer)
const prevFrames = new Map();

// Admin WebSocket clients
const adminClients = new Set();

function broadcastToAdmins(msg) {
  const data = JSON.stringify(msg);
  for (const ws of adminClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ---------- Express ----------
const app = express();
app.use(express.json());

// Serve web client
app.use(express.static(path.join(PROJECT_ROOT, 'client')));

// Serve admin dashboard
app.use('/admin', express.static(path.join(PROJECT_ROOT, 'admin')));

// ---------- Auth routes & middleware ----------

// Admin PIN login
app.post('/api/admin/login', express.json(), (req, res) => {
  if (!PHONE_HOME_ADMIN_PIN) return res.json({ ok: true }); // no PIN configured
  if (req.body.pin === PHONE_HOME_ADMIN_PIN) {
    res.cookie('ph_admin', ADMIN_COOKIE_HASH, {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'strict',
      secure: req.secure,
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong PIN' });
});

// Token auth for all /api/* routes (except admin/login)
app.use('/api', (req, res, next) => {
  if (req.path === '/admin/login') return next();
  if (!checkToken(req)) return res.status(401).json({ error: 'Invalid or missing token' });
  next();
});

// Admin-only routes (require admin cookie)
const ADMIN_ROUTES = [
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/snap$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/listen$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/motion$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/quality$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/threshold$/ },
  { method: 'DELETE', pattern: /^\/api\/alerts$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/mode$/ },
  { method: 'POST', pattern: /^\/api\/nodes\/[^/]+\/timelapse\/generate$/ },
];

app.use('/api', (req, res, next) => {
  const needsAdmin = ADMIN_ROUTES.some(r => r.method === req.method && r.pattern.test(req.originalUrl));
  if (needsAdmin && !checkAdminCookie(req)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
});

// Serve CA cert for easy install on iPhones
app.get('/cert', (_req, res) => {
  const certPath = path.join(__dirname, 'certs', 'cert.der');
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'inline; filename="phonehome.cer"');
  res.sendFile(certPath);
});

// --- Polling fallback for old iOS that can't do wss:// with self-signed certs ---
// Register a polling node
app.post('/api/poll/register', (req, res) => {
  const { name, deviceInfo } = req.body;
  const id = uuidv4();
  const node = {
    ws: null,
    id,
    name: name || 'unnamed',
    connectedAt: new Date().toISOString(),
    lastHeartbeat: Date.now(),
    battery: null,
    orientation: 0,
    location: null,
    motionEnabled: false,
    bytesIn: 0,
    bytesOut: 0,
    userAgent: req.headers['user-agent'] || 'unknown',
    deviceInfo: deviceInfo || null,
    quality: 'medium',
    polling: true,
    pendingCommands: [],
  };
  nodes.set(id, node);
  if (deviceInfo) {
    console.log(`[+] Poll node registered: ${id} as "${name}" — ${deviceInfo.platform || ''} ${deviceInfo.screenW}x${deviceInfo.screenH} iOS${deviceInfo.iosVersion || '?'}`);
  } else {
    console.log(`[+] Poll node registered: ${id} as "${name}"`);
  }
  broadcastToAdmins({ type: 'node-connected', id, connectedAt: node.connectedAt });
  res.json({ id });
});

// Poll for commands
app.post('/api/poll/:id/poll', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Unknown node' });
  node.lastHeartbeat = Date.now();
  if (req.body.battery != null) node.battery = req.body.battery;
  if (req.body.location) node.location = req.body.location;
  const cmds = node.pendingCommands || [];
  node.pendingCommands = [];
  res.json({ commands: cmds });
});

// Receive a snap via POST (polling nodes)
app.post('/api/poll/:id/snap', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Unknown node' });
  // Expect raw JPEG body
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    const buf = Buffer.concat(chunks);
    node.bytesIn += buf.length;
    const nodeDir = path.join(SNAPSHOT_DIR, req.params.id);
    fs.mkdirSync(nodeDir, { recursive: true });
    const snapPath = path.join(nodeDir, 'latest.jpg');
    await fs.promises.writeFile(snapPath, buf);
    // Also handle motion detection if streaming
    if (node.motionEnabled) {
      handleBinaryMessage(req.params.id, buf);
    }
    res.json({ ok: true });
  });
});

// --- REST API for Reef ---

// List connected nodes
app.get('/api/nodes', (_req, res) => {
  const list = [];
  for (const [id, node] of nodes) {
    list.push({
      id,
      name: node.name,
      connectedAt: node.connectedAt,
      lastHeartbeat: node.lastHeartbeat,
      battery: node.battery,
      location: node.location,
      motionEnabled: node.motionEnabled,
      bytesIn: node.bytesIn,
      bytesOut: node.bytesOut,
      motionThreshold: node.motionThreshold || MOTION_THRESHOLD,
      quality: node.quality || 'medium',
      userAgent: node.userAgent,
      deviceInfo: node.deviceInfo,
      mode: node.mode || 'motion',
      timelapse: node.timelapse || null,
    });
  }
  res.json(list);
});

// Request a snapshot from a node
app.post('/api/nodes/:id/snap', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const requestId = uuidv4();
  sendCommand(node, 'snap', { requestId });

  waitForResponse(requestId, 15000)
    .then((result) => res.json(result))
    .catch((err) => res.status(504).json({ error: err.message }));
});

// Request audio from a node
app.post('/api/nodes/:id/listen', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const duration = req.body.duration || 5;
  const requestId = uuidv4();
  sendCommand(node, 'listen', { requestId, duration });

  // Audio takes longer — timeout = duration + 10s buffer
  waitForResponse(requestId, (duration + 10) * 1000)
    .then((result) => res.json(result))
    .catch((err) => res.status(504).json({ error: err.message }));
});

// Get latest snapshot for a node
app.get('/api/snapshots/:id/latest', (req, res) => {
  const nodeDir = path.join(SNAPSHOT_DIR, req.params.id);
  if (!fs.existsSync(nodeDir)) return res.status(404).json({ error: 'No snapshots' });

  const files = fs.readdirSync(nodeDir).filter(f => f.endsWith('.jpg')).sort();
  if (files.length === 0) return res.status(404).json({ error: 'No snapshots' });

  const latest = path.join(nodeDir, files[files.length - 1]);
  res.sendFile(latest);
});

// Get recent motion alerts
app.get('/api/alerts', (_req, res) => {
  const alertDir = path.join(PROJECT_ROOT, 'data', 'alerts');
  if (!fs.existsSync(alertDir)) return res.json([]);
  const files = fs.readdirSync(alertDir).filter(f => f.endsWith('.json')).sort().slice(-20);
  const alerts = files.map(f => JSON.parse(fs.readFileSync(path.join(alertDir, f), 'utf-8')));
  res.json(alerts);
});

// Clear alerts (after reading)
app.delete('/api/alerts', (_req, res) => {
  const alertDir = path.join(PROJECT_ROOT, 'data', 'alerts');
  if (fs.existsSync(alertDir)) {
    fs.readdirSync(alertDir).forEach(f => fs.unlinkSync(path.join(alertDir, f)));
  }
  res.json({ cleared: true });
});

// --- Cached stats (updated every 60s) ---
let cachedDiskUsage = 0;
let cachedAlertCountToday = 0;

function computeDirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) size += computeDirSize(p);
    else try { size += fs.statSync(p).size; } catch {}
  }
  return size;
}

function refreshCachedStats() {
  const dataDir = path.join(PROJECT_ROOT, 'data');
  cachedDiskUsage = computeDirSize(dataDir);

  const alertDir = path.join(PROJECT_ROOT, 'data', 'alerts');
  if (fs.existsSync(alertDir)) {
    const today = new Date().toISOString().slice(0, 10);
    // Count by filename prefix (timestamps) to avoid parsing every JSON
    cachedAlertCountToday = fs.readdirSync(alertDir).filter(f => {
      // Filenames are like `1740000000000.json` or `tamper-1740000000000.json`
      const match = f.match(/(\d{13})/);
      if (match) {
        return new Date(parseInt(match[1])).toISOString().startsWith(today);
      }
      return false;
    }).length;
  } else {
    cachedAlertCountToday = 0;
  }
}

refreshCachedStats();
const statsInterval = setInterval(refreshCachedStats, 60000);

// Get system stats
app.get('/api/stats', (_req, res) => {
  res.json({
    nodeCount: nodes.size,
    alertCount: cachedAlertCountToday,
    diskUsage: cachedDiskUsage,
    uptime: process.uptime(),
  });
});

// Update motion threshold per node
app.post('/api/nodes/:id/threshold', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const threshold = parseFloat(req.body.threshold);
  if (isNaN(threshold) || threshold < 0 || threshold > 100) {
    return res.status(400).json({ error: 'Invalid threshold (0-100)' });
  }
  node.motionThreshold = threshold;
  res.json({ id: req.params.id, motionThreshold: threshold });
});

// Serve clip video files
app.get('/api/clips/:nodeId/:filename', (req, res) => {
  const clipPath = path.resolve(CLIP_DIR, req.params.nodeId, req.params.filename);
  if (!clipPath.startsWith(path.resolve(CLIP_DIR))) return res.status(403).end();
  if (!fs.existsSync(clipPath)) return res.status(404).json({ error: 'Clip not found' });
  res.sendFile(clipPath);
});

// Serve alert thumbnails
app.get('/api/thumbs/:nodeId/:filename', (req, res) => {
  const thumbPath = path.resolve(CLIP_DIR, req.params.nodeId, req.params.filename);
  if (!thumbPath.startsWith(path.resolve(CLIP_DIR))) return res.status(403).end();
  if (!fs.existsSync(thumbPath)) return res.status(404).json({ error: 'Thumbnail not found' });
  res.sendFile(thumbPath);
});

// Bandwidth history for a node (last 30 min)
app.get('/api/nodes/:id/bandwidth', (req, res) => {
  const history = bwHistory.get(req.params.id) || [];
  // Convert cumulative bytes to per-interval rates
  const rates = [];
  for (let i = 1; i < history.length; i++) {
    const dt = (history[i].ts - history[i-1].ts) / 1000; // seconds
    rates.push({
      ts: history[i].ts,
      inRate: Math.round((history[i].bytesIn - history[i-1].bytesIn) / dt),   // bytes/sec
      outRate: Math.round((history[i].bytesOut - history[i-1].bytesOut) / dt),
    });
  }
  res.json(rates);
});

// Set video quality for a node
app.post('/api/nodes/:id/quality', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const quality = req.body.quality || 'medium';
  if (!['low', 'medium', 'high'].includes(quality)) return res.status(400).json({ error: 'Invalid quality: low, medium, high' });
  sendCommand(node, 'set-quality', { quality });
  node.quality = quality;
  res.json({ quality });
});

// Configure motion detection for a node
app.post('/api/nodes/:id/motion', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  node.motionEnabled = !!req.body.enabled;
  if (node.motionEnabled) {
    sendCommand(node, 'start-stream', {});
  } else {
    sendCommand(node, 'stop-stream', {});
    prevFrames.delete(req.params.id);
  }
  res.json({ motionEnabled: node.motionEnabled });
});

// --- Timelapse API ---

// Set node mode (motion/timelapse) and timelapse config
app.post('/api/nodes/:id/mode', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const mode = req.body.mode;
  if (!['motion', 'timelapse'].includes(mode)) return res.status(400).json({ error: 'Invalid mode: motion or timelapse' });

  const prevMode = node.mode || 'motion';
  node.mode = mode;

  if (mode === 'timelapse') {
    // Update timelapse config if provided
    node.timelapse = {
      intervalMinutes: req.body.intervalMinutes || node.timelapse?.intervalMinutes || 15,
      activeHoursStart: req.body.activeHoursStart ?? node.timelapse?.activeHoursStart ?? 6,
      activeHoursEnd: req.body.activeHoursEnd ?? node.timelapse?.activeHoursEnd ?? 19,
      timezone: req.body.timezone || node.timelapse?.timezone || 'America/New_York',
    };
    // Stop motion streaming if it was on
    if (node.motionEnabled) {
      node.motionEnabled = false;
      sendCommand(node, 'stop-stream', {});
      prevFrames.delete(req.params.id);
    }
    startTimelapseInterval(req.params.id);
  } else {
    // Switching back to motion
    stopTimelapseInterval(req.params.id);
  }

  console.log(`[⚙️] Node ${node.name || req.params.id} mode: ${prevMode} → ${mode}`);
  res.json({ mode: node.mode, timelapse: node.timelapse || null });
});

// Get timelapse stats
app.get('/api/nodes/:id/timelapse/stats', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });
  const stats = getTimelapseStats(req.params.id);
  res.json(stats);
});

// Generate timelapse video
app.post('/api/nodes/:id/timelapse/generate', (req, res) => {
  const node = nodes.get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Node not found' });

  const nodeDir = path.join(TIMELAPSE_DIR, req.params.id);
  if (!fs.existsSync(nodeDir)) return res.status(404).json({ error: 'No timelapse frames' });

  const files = fs.readdirSync(nodeDir).filter(f => f.endsWith('.jpg')).sort();
  if (files.length === 0) return res.status(404).json({ error: 'No timelapse frames' });

  const outputPath = path.join(nodeDir, 'timelapse.mp4');
  const framerate = req.body.framerate || 30;

  console.log(`[🎬] Generating timelapse video for ${node.name || req.params.id}: ${files.length} frames @ ${framerate}fps`);

  // Run ffmpeg in background
  const ffmpeg = execFile('ffmpeg', [
    '-y', '-framerate', String(framerate),
    '-pattern_type', 'glob', '-i', path.join(nodeDir, '*.jpg'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-preset', 'medium', '-crf', '23',
    outputPath,
  ], { timeout: 300000 }, (err) => {
    if (err) {
      console.log(`[⚠️] Timelapse ffmpeg failed: ${err.message}`);
    } else {
      console.log(`[🎬] Timelapse video generated: ${outputPath}`);
      broadcastToAdmins({ type: 'timelapse-ready', nodeId: req.params.id });
    }
  });

  res.json({ status: 'generating', frames: files.length, framerate });
});

// Serve timelapse video
app.get('/api/nodes/:id/timelapse/video', (req, res) => {
  const videoPath = path.join(TIMELAPSE_DIR, req.params.id, 'timelapse.mp4');
  if (!fs.existsSync(videoPath)) return res.status(404).json({ error: 'No timelapse video generated yet' });
  res.sendFile(path.resolve(videoPath));
});

// ---------- HTTP + WS Server ----------
const server = createServer(app);
const wss = new WebSocketServer({ server });

function handleWSConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost');

  // WebSocket auth: require token in query param
  if (PHONE_HOME_TOKEN && url.searchParams.get('token') !== PHONE_HOME_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  // Check if this is an admin client
  if (url.searchParams.get('role') === 'admin') {
    adminClients.add(ws);
    ws.send(JSON.stringify({ type: 'admin-welcome' }));
    console.log(`[+] Admin client connected (${adminClients.size} total)`);
    ws.on('close', () => {
      adminClients.delete(ws);
      console.log(`[-] Admin client disconnected (${adminClients.size} total)`);
    });
    return;
  }

  const id = uuidv4();
  const userAgent = req.headers['user-agent'] || 'unknown';
  const node = {
    ws,
    id,
    name: null,
    connectedAt: new Date().toISOString(),
    lastHeartbeat: Date.now(),
    battery: null,
    orientation: 0,
    location: null,
    motionEnabled: false,
    bytesIn: 0,
    bytesOut: 0,
    userAgent,
    deviceInfo: null,
  };
  nodes.set(id, node);

  // Tell the client its assigned ID
  ws.send(JSON.stringify({ type: 'welcome', id }));
  console.log(`[+] Node connected: ${id} — ${userAgent}`);
  broadcastToAdmins({ type: 'node-connected', id, connectedAt: node.connectedAt });

  ws.on('message', (data, isBinary) => {
    const node = nodes.get(id);
    if (node) node.bytesIn += isBinary ? data.length : Buffer.byteLength(data.toString());
    if (isBinary) {
      handleBinaryMessage(id, data);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      handleJsonMessage(id, msg);
    } catch (e) {
      console.error(`[!] Bad JSON from ${id}:`, e.message);
    }
  });

  ws.on('close', () => {
    console.log(`[-] Node disconnected: ${id} (${node.name || 'unnamed'})`);
    broadcastToAdmins({ type: 'node-disconnected', id, name: node.name });
    nodes.delete(id);
    prevFrames.delete(id);
    bwHistory.delete(id);
    clipState.delete(id);
    stopTimelapseInterval(id);
  });

  ws.on('error', (err) => {
    console.error(`[!] WS error from ${id}:`, err.message);
  });
}

wss.on('connection', handleWSConnection);

// ---------- Message Handlers ----------

function handleJsonMessage(nodeId, msg) {
  const node = nodes.get(nodeId);
  if (!node) return;

  switch (msg.type) {
    case 'register':
      node.name = msg.name || 'unnamed';
      if (msg.deviceInfo) {
        node.deviceInfo = msg.deviceInfo;
        console.log(`[i] Node ${nodeId} registered as "${node.name}" — ${msg.deviceInfo.platform || ''} ${msg.deviceInfo.screenW}x${msg.deviceInfo.screenH} iOS${msg.deviceInfo.iosVersion || '?'}`);
      } else {
        console.log(`[i] Node ${nodeId} registered as "${node.name}"`);
      }
      break;

    case 'heartbeat':
      node.lastHeartbeat = Date.now();
      node.battery = msg.battery != null ? msg.battery : null;
      break;

    case 'orientation':
      node.orientation = msg.angle || 0;
      console.log(`[📐] Node ${node.name || nodeId} orientation: ${node.orientation}°`);
      break;

    case 'location':
      node.location = msg.location || null;
      if (node.location) {
        console.log(`[📍] Node ${node.name || nodeId} location: ${node.location.lat}, ${node.location.lng} (±${node.location.accuracy}m)`);
      }
      break;

    case 'tamper': {
      const nodeName = node.name || nodeId;
      const now = Date.now();
      console.log(`[🚨] TAMPER on ${nodeName}: ${msg.delta} m/s²`);

      const alertDir = path.join(PROJECT_ROOT, 'data', 'alerts');
      fs.mkdirSync(alertDir, { recursive: true });
      const alert = {
        type: 'tamper',
        nodeId,
        nodeName,
        delta: msg.delta,
        location: node.location || null,
        timestamp: new Date().toISOString(),
      };
      fs.promises.writeFile(path.join(alertDir, `tamper-${now}.json`), JSON.stringify(alert)).catch(() => {});
      broadcastToAdmins({ type: 'alert', alert });
      break;
    }

    case 'snap-result': {
      // The actual image data comes as the next binary message tagged with requestId
      // Store requestId so binary handler knows what it's for
      node._pendingSnapRequestId = msg.requestId;
      break;
    }

    case 'listen-result': {
      node._pendingAudioRequestId = msg.requestId;
      break;
    }

    case 'error':
      console.error(`[!] Error from ${node.name || nodeId}: ${msg.message}`);
      if (msg.requestId && pending.has(msg.requestId)) {
        resolvePending(msg.requestId, null, new Error(msg.message));
      }
      break;

    default:
      console.log(`[?] Unknown message type from ${nodeId}: ${msg.type}`);
  }
}

async function handleBinaryMessage(nodeId, data) {
  const node = nodes.get(nodeId);
  if (!node) return;

  const buffer = Buffer.from(data);

  // Check if this is a timelapse snap
  if (node._pendingTimelapseSnap) {
    node._pendingTimelapseSnap = false;
    await saveTimelapseFrame(nodeId, buffer);
    // Also save as latest snapshot for preview
    const nodeDir = path.join(SNAPSHOT_DIR, nodeId);
    fs.mkdirSync(nodeDir, { recursive: true });
    await fs.promises.writeFile(path.join(nodeDir, 'latest.jpg'), buffer);
    return;
  }

  // Check if this is a snap response
  if (node._pendingSnapRequestId) {
    const requestId = node._pendingSnapRequestId;
    node._pendingSnapRequestId = null;
    await saveSnapshot(nodeId, buffer, requestId);
    return;
  }

  // Check if this is an audio response
  if (node._pendingAudioRequestId) {
    const requestId = node._pendingAudioRequestId;
    node._pendingAudioRequestId = null;
    await saveAudio(nodeId, buffer, requestId);
    return;
  }

  // Otherwise it's a streaming frame (for motion detection)
  if (node.motionEnabled) {
    await checkMotion(nodeId, buffer);
  }
}

// ---------- Snapshot / Audio Storage ----------

async function saveSnapshot(nodeId, buffer, requestId) {
  const nodeDir = path.join(SNAPSHOT_DIR, nodeId);
  fs.mkdirSync(nodeDir, { recursive: true });

  const filename = `${Date.now()}.jpg`;
  const filepath = path.join(nodeDir, filename);
  await fs.promises.writeFile(filepath, buffer);

  console.log(`[📸] Snapshot saved: ${filepath} (${buffer.length} bytes)`);
  resolvePending(requestId, {
    nodeId,
    filename,
    size: buffer.length,
    timestamp: new Date().toISOString(),
  });
}

async function saveAudio(nodeId, buffer, requestId) {
  const nodeDir = path.join(AUDIO_DIR, nodeId);
  fs.mkdirSync(nodeDir, { recursive: true });

  const filename = `${Date.now()}.webm`;
  const filepath = path.join(nodeDir, filename);
  await fs.promises.writeFile(filepath, buffer);

  console.log(`[🎤] Audio saved: ${filepath} (${buffer.length} bytes)`);
  resolvePending(requestId, {
    nodeId,
    filename,
    size: buffer.length,
    timestamp: new Date().toISOString(),
  });
}

// ---------- Motion Detection + Clip Recording ----------

// Per-node clip recording state
// { recording: bool, frames: [{buffer, ts}], startTs, bestFrame: {buffer, sharpness} }
const clipState = new Map();

async function checkMotion(nodeId, jpegBuffer) {
  try {
    const node = nodes.get(nodeId);
    if (!node) return;

    // Skip motion detection for timelapse nodes
    if (node.mode === 'timelapse') return;

    // If currently recording a clip, just collect frames
    const clip = clipState.get(nodeId);
    if (clip && clip.recording) {
      if (clip.frames.length < 20) clip.frames.push({ buffer: jpegBuffer, ts: Date.now() });
      // Track sharpest frame (Laplacian variance approximation via sharp)
      try {
        const stats = await sharp(jpegBuffer).resize(160, 120).greyscale().stats();
        const sharpness = stats.channels[0].stdev; // higher stdev = sharper
        if (!clip.bestFrame || sharpness > clip.bestFrame.sharpness) {
          clip.bestFrame = { buffer: jpegBuffer, sharpness };
        }
      } catch (_) {}

      // Check if clip duration elapsed
      if (Date.now() - clip.startTs >= CLIP_DURATION_MS) {
        clip.recording = false;
        finalizeClip(nodeId);
      }
      return;
    }

    // Normal motion detection (compare frames)
    const { data: pixels, info } = await sharp(jpegBuffer)
      .resize(160, 120, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const prev = prevFrames.get(nodeId);
    prevFrames.set(nodeId, pixels);

    if (!prev || prev.length !== pixels.length) return;

    const totalPixels = info.width * info.height;
    let changedPixels = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      const dr = Math.abs(pixels[i] - prev[i]);
      const dg = Math.abs(pixels[i + 1] - prev[i + 1]);
      const db = Math.abs(pixels[i + 2] - prev[i + 2]);
      if (dr > MOTION_PIXEL_DIFF || dg > MOTION_PIXEL_DIFF || db > MOTION_PIXEL_DIFF) {
        changedPixels++;
      }
    }

    const pctChanged = (changedPixels / totalPixels) * 100;
    const threshold = node.motionThreshold || MOTION_THRESHOLD;
    if (pctChanged > threshold) {
      const nodeName = node?.name || nodeId;
      const now = Date.now();

      // Cooldown: don't start a new clip within 30s of the last one finishing
      if (node._lastMotionAlert && (now - node._lastMotionAlert) < 30000) return;

      console.log(`[⚠️] Motion detected on ${nodeName}: ${pctChanged.toFixed(1)}% — recording ${CLIP_DURATION_MS / 1000}s clip...`);

      // Start recording clip
      clipState.set(nodeId, {
        recording: true,
        frames: [{ buffer: jpegBuffer, ts: now }],
        startTs: now,
        pctChanged,
        bestFrame: { buffer: jpegBuffer, sharpness: 0 },
      });
    }
  } catch (e) {
    console.error(`[!] Motion detection error for ${nodeId}:`, e.message);
  }
}

async function finalizeClip(nodeId) {
  const node = nodes.get(nodeId);
  const clip = clipState.get(nodeId);
  if (!clip || !node) return;

  const nodeName = node?.name || nodeId;
  const now = Date.now();
  node._lastMotionAlert = now;

  const nodeClipDir = path.join(CLIP_DIR, nodeId);
  fs.mkdirSync(nodeClipDir, { recursive: true });

  const frameCount = clip.frames.length;
  console.log(`[🎬] Finalizing clip for ${nodeName}: ${frameCount} frames`);

  // Save frames as temp files for ffmpeg
  const tmpDir = path.join(nodeClipDir, `tmp-${now}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  for (let i = 0; i < clip.frames.length; i++) {
    const padded = String(i).padStart(5, '0');
    await fs.promises.writeFile(path.join(tmpDir, `frame-${padded}.jpg`), clip.frames[i].buffer);
  }

  // Calculate fps from actual frame timing
  const duration = (clip.frames[clip.frames.length - 1].ts - clip.frames[0].ts) / 1000;
  const fps = Math.max(1, Math.round(frameCount / Math.max(0.1, duration)));

  const clipFilename = `motion-${now}.mp4`;
  const clipPath = path.join(nodeClipDir, clipFilename);

  // Save best frame as thumbnail
  const thumbPath = path.join(nodeClipDir, `motion-${now}-thumb.jpg`);
  if (clip.bestFrame?.buffer) {
    await fs.promises.writeFile(thumbPath, clip.bestFrame.buffer);
  }

  // Stitch frames into MP4 with ffmpeg
  try {
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y', '-framerate', String(fps),
        '-i', path.join(tmpDir, 'frame-%05d.jpg'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-preset', 'ultrafast', '-crf', '28',
        clipPath,
      ], { timeout: 15000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    console.log(`[🎬] Clip saved: ${clipPath}`);
  } catch (e) {
    console.log(`[⚠️] ffmpeg clip failed: ${e.message}`);
  }

  // Clean up temp frames
  try {
    fs.readdirSync(tmpDir).forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
    fs.rmdirSync(tmpDir);
  } catch (_) {}

  // --- Phase 2: YOLOv8 Nano person detection (pre-filter before LLaVA) ---
  let personDetected = false;
  let yoloResult = null;
  if (clip.bestFrame?.buffer) {
    try {
      yoloResult = await yoloDetect(thumbPath);
      personDetected = yoloResult.count > 0;
      console.log(`[🔍] YOLO: ${personDetected ? `${yoloResult.count} person(s) detected` : 'no person — skipping LLaVA'}`);
    } catch (e) {
      console.log(`[⚠️] YOLO detection failed: ${e.message} — falling back to LLaVA`);
      personDetected = true; // fail-open: if YOLO fails, still run LLaVA
    }
  }

  // Vision analysis on best frame (only if person detected by YOLO)
  let description = null;
  if (personDetected && clip.bestFrame?.buffer) {
    try {
      const imgBase64 = clip.bestFrame.buffer.toString('base64');
      const abortCtl = new AbortController();
      const llavaTimeout = setTimeout(() => abortCtl.abort(), 120000);
      const ollamaRes = await fetch('http://localhost:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llava:7b',
          prompt: 'What is happening in this image? Reply in 5-10 words max. Focus on people and activity only. Example: "Person walking through kitchen" or "Empty room, TV on"',
          images: [imgBase64],
          stream: false,
        }),
        signal: abortCtl.signal,
      });
      clearTimeout(llavaTimeout);
      if (ollamaRes.ok) {
        const ollamaData = await ollamaRes.json();
        description = ollamaData.response?.trim() || null;
        console.log(`[🧠] Vision: ${description}`);
      }
    } catch (e) {
      console.log(`[⚠️] Vision analysis failed: ${e.message}`);
    }
  }

  // Write alert (always log, but mark whether person was detected)
  const alertDir = path.join(PROJECT_ROOT, 'data', 'alerts');
  fs.mkdirSync(alertDir, { recursive: true });
  const alert = {
    type: 'motion',
    nodeId,
    nodeName,
    pctChanged: parseFloat(clip.pctChanged.toFixed(1)),
    frameCount,
    durationSec: parseFloat(duration.toFixed(1)),
    clip: clipPath,
    thumbnail: thumbPath,
    description,
    personDetected,
    personCount: yoloResult?.count || 0,
    location: node?.location || null,
    timestamp: new Date().toISOString(),
  };
  await fs.promises.writeFile(path.join(alertDir, `${now}.json`), JSON.stringify(alert));
  broadcastToAdmins({ type: 'alert', alert });

  // --- Telegram alert (only when person detected) ---
  if (personDetected && TELEGRAM_ENABLED) {
    sendTelegramAlert(alert).catch(e => console.log(`[⚠️] Telegram alert failed: ${e.message}`));
  }

  // Clear clip state
  clipState.delete(nodeId);
}

// ---------- Helpers ----------

function sendCommand(node, type, payload) {
  if (node.ws && node.ws.readyState === 1) {
    const msg = JSON.stringify({ type, ...payload });
    node.bytesOut += Buffer.byteLength(msg);
    node.ws.send(msg);
  } else if (node.polling) {
    if (!node.pendingCommands) node.pendingCommands = [];
    node.pendingCommands.push({ type, ...payload });
  }
}

function waitForResponse(requestId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Request timed out'));
    }, timeoutMs);

    pending.set(requestId, { resolve, reject, timer });
  });
}

function resolvePending(requestId, result, error) {
  const p = pending.get(requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(requestId);
  if (error) p.reject(error);
  else p.resolve(result);
}

// ---------- Start ----------
// HTTPS on main port (camera/mic require secure context)
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3902', 10); // internal HTTP for API calls
let httpsServer = null;
let wssSecure = null;
try {
  const sslOpts = {
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  };
  httpsServer = createHttpsServer(sslOpts, app);
  wssSecure = new WebSocketServer({ server: httpsServer });
  wssSecure.on('connection', handleWSConnection);
  httpsServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🔒 Phone Home hub (HTTPS) listening on port ${PORT}`);
    console.log(`   Web client: https://<your-ip>:${PORT}/`);
  });
} catch (e) {
  console.log(`⚠️  HTTPS disabled (no certs): ${e.message}`);
}

// HTTP for local API access (Reef)
server.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`📡 Phone Home hub (HTTP) listening on port ${HTTP_PORT}`);
  console.log(`   API:        http://localhost:${HTTP_PORT}/api/nodes`);
});

// ---------- Graceful Shutdown ----------
function shutdown(signal) {
  console.log(`\n[🛑] ${signal} received — shutting down...`);

  // Close all WebSocket connections
  for (const ws of adminClients) ws.close(1001, 'Server shutting down');
  for (const [, node] of nodes) {
    if (node.ws) node.ws.close(1001, 'Server shutting down');
  }

  // Close WS servers
  wss.close();
  if (wssSecure) wssSecure.close();

  // Kill YOLO process
  if (yoloProc) { yoloProc.kill(); yoloProc = null; }

  // Clear intervals
  clearInterval(statsInterval);

  // Close HTTP servers
  server.close();
  if (httpsServer) httpsServer.close();

  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
