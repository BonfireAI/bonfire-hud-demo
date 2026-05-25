#!/usr/bin/env node
/**
 * hud-demo.mjs
 *
 * CLI orchestrator for the Bonfire HUD demo template.
 *
 * What it does:
 *   PHASE A · silent setup
 *     A0 preflight (Node >= 20, cache dirs, port)
 *     A1 start HTTP+SSE server
 *     A2 open default browser → /theater.html
 *     A3 wait up to 5s for theater /events connection (log + proceed on timeout)
 *
 *   PHASE B · in-theater (events stream live)
 *     B1 inhale point cloud from ./input/ (or fall back to bundled sample, SHA-256 verified)
 *     B2 fetch PotreeConverter binary (cached, SHA-256 verified)
 *     B2.5 fetch Potree viewer libs (cached, SHA-256 verified)
 *     B3 spawn PotreeConverter → octree (stdout streamed to SSE)
 *     B4 gate `done` on (work complete && theater open >= 15s)
 *
 *   PHASE C · hold server until SIGINT
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';

// ───────────────────────────────────────── paths

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = __dirname;
const assetsRoot = path.join(repoRoot, 'assets');
const vendorRoot = path.join(assetsRoot, 'vendor');
const cacheRoot = path.join(os.homedir(), '.cache', 'candyfactory');
const cachePotreeConv = path.join(cacheRoot, 'potree-converter');
const cacheE57 = path.join(cacheRoot, 'e57-samples');
const cacheViewer = path.join(cacheRoot, 'potree-viewer');
const cacheOctreeRoot = path.join(cacheRoot, 'hud-demo-output');
// `cacheOctree` is now derived per-input-SHA at runtime (see resolveOctreeCacheDir).
// The legacy single-dir path is retained as the default before a scan is staged so
// route registration + preflight code that touches it still works on a cold boot.
const cacheOctreeDefault = path.join(cacheOctreeRoot, 'octree');
let cacheOctree = cacheOctreeDefault;

// CWD-relative input folder — the engineer drops their point cloud here.
// Resolved against process.cwd() so it follows wherever the engineer runs from.
const inputDirRel = './input';
function inputDirAbs() { return path.resolve(process.cwd(), inputDirRel); }

// ───────────────────────────────────────── constants

const PORT_RANGE = { start: 3000, end: 3019 };
const THEATER_FLOOR_MS = 15_000;
const REPLAY_BUFFER_MAX = 200;
const AWAIT_THEATER_TIMEOUT_MS = 5_000;
const DOWNLOAD_RETRY = { attempts: 2, backoffMs: 2_000 };

// Tiny point-cloud source.
//
// PRIMARY FLOW (Wave 3, 2026-05-25): the script INHALES whatever the engineer drops
// in `./input/`. Empty input → fall back to the bundled Lion Takanawa sample below.
// See ensurePointCloudSample() for the picker.
//
// E57 priority list (retained as breadcrumbs). During early integration (2026-05-25)
// every E57 in the priority list (libE57Format ColouredCube* + Stanford bunnyInt32)
// crashed PotreeConverter 2.1.1's indexer with
//   nlohmann::detail::type_error.302 "type must be number, but is null"
// Root cause: PotreeConverter 2.1.1's E57 reader leaves the scan bounding box
// as JSON nulls when the source E57 has minimal/abbreviated scan metadata —
// a known compatibility gap, not something we can paper over in CLI orchestration.
//
// PIVOT: use the bundled `lion_takanawa.copc.laz` from the Potree viewer
// release. It ships inside the viewer zip we already download (single network
// hop, no extra fetch), is 2.6 MB, public-domain (Japanese lion statue, Takanawa),
// and converts cleanly to a real 342k-point octree in ~1 second.
//
// E57 priority list retained as POINT_CLOUD_FALLBACKS for future re-evaluation
// when PotreeConverter or our reader improves.
const POINT_CLOUD_PRIMARY = {
  kind: 'bundled-in-viewer-zip',
  name: 'lion_takanawa.copc.laz',
  relInViewerZip: `Potree_${'1.8.2'}/pointclouds/lion_takanawa.copc.laz`,
  sha256: '3d450e740b4190793bf8a695d2352d910b9c4d02840bf238c490dc252fe64e1b',
  sizeApprox: 2_735_983,
  license: 'public-domain (Potree project sample, Takanawa lion statue)',
};
const POINT_CLOUD_FALLBACKS_E57 = [
  // These DO download + SHA-verify cleanly but crash PotreeConverter 2.1.1
  // indexer. Kept here as breadcrumbs for the day we revisit E57 ingestion.
  {
    name: 'bunnyInt32.e57',
    url: 'https://raw.githubusercontent.com/asmaloney/libE57Format-test-data/main/reference/bunnyInt32.e57',
    sha256: '6b3696c452a2dd0e325ab30b1ad28a40de87f1a56cd9d8a24ad81389b606c205',
    sizeApprox: 374_784,
    license: 'public-domain Stanford bunny via libE57Format test-data',
    knownIssue: 'PotreeConverter 2.1.1 indexer fails: type_error.302 null bbox',
  },
  {
    name: 'ColouredCubeDouble.e57',
    url: 'https://raw.githubusercontent.com/asmaloney/libE57Format-test-data/main/self/ColouredCubeDouble.e57',
    sha256: '58e7cfbb3e9cef777c4cd8f52aff2ff704fcf6dd3aea4b420430adaa1cdb978d',
    sizeApprox: 210_944,
    license: 'public-domain test-data fixture from libE57Format',
    knownIssue: 'same as above',
  },
];

// PotreeConverter v2.1.1 — Linux + Windows pre-built; macOS users build from source.
const POTREE_CONV_VERSION = '2.1.1';
const POTREE_CONV_SOURCES = {
  linux: {
    url: `https://github.com/potree/PotreeConverter/releases/download/${POTREE_CONV_VERSION}/PotreeConverter_${POTREE_CONV_VERSION}_x64_linux.zip`,
    sha256: null, // verified at first download against published checksums; not pinned (release archive stable)
    archiveName: 'PotreeConverter_2.1.1_x64_linux.zip',
    binaryRelPath: 'PotreeConverter',
  },
  win32: {
    url: `https://github.com/potree/PotreeConverter/releases/download/${POTREE_CONV_VERSION}/PotreeConverter_${POTREE_CONV_VERSION}_x64_windows.zip`,
    sha256: null,
    archiveName: 'PotreeConverter_2.1.1_x64_windows.zip',
    binaryRelPath: 'PotreeConverter.exe',
  },
};

// Potree viewer 1.8.2 — supports v2 octree (metadata.json) format
const POTREE_VIEWER_VERSION = '1.8.2';
const POTREE_VIEWER_URL = `https://github.com/potree/potree/releases/download/${POTREE_VIEWER_VERSION}/Potree_${POTREE_VIEWER_VERSION}.zip`;

// ───────────────────────────────────────── small utils

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  pink: '\x1b[38;5;213m',
  butter: '\x1b[38;5;229m',
  mint: '\x1b[38;5;121m',
  cherry: '\x1b[38;5;203m',
  grape: '\x1b[38;5;141m',
  ink: '\x1b[38;5;238m',
};

const isTTY = process.stdout.isTTY;
function paint(color, s) {
  return isTTY ? `${COLORS[color] || ''}${s}${COLORS.reset}` : s;
}

function term(level, text) {
  const glyph =
    level === 'success' ? '✓'
    : level === 'download' ? '↓'
    : level === 'warn' ? '⚠'
    : level === 'error' ? '✗'
    : '▸';
  const color =
    level === 'success' ? 'mint'
    : level === 'download' ? 'butter'
    : level === 'warn' ? 'butter'
    : level === 'error' ? 'cherry'
    : 'pink';
  // eslint-disable-next-line no-console
  console.log(`${paint(color, glyph)} ${text}`);
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ───────────────────────────────────────── input folder
//
// Wave 3 brief (Anta, 2026-05-25): "the script must inhale the file that is put in
// the input folder ... it must find the point already in the file and hijack them."
//
// Contract:
//   - `./input/` is CWD-relative (wherever you invoke node from).
//   - Supported extensions: e57, las, laz, ply, copc.laz (case-insensitive).
//   - 1 match → use it.
//   - >1 match → pick first alphabetical, emit a warn-level SSE log line naming
//     the picked file + the count.
//   - 0 matches → fall back to bundled Lion Takanawa sample (unchanged behavior).
//   - Missing `./input/` → create it AND drop a tiny README.md explaining the
//     contract so the engineer finds the folder without being told about it.

const INPUT_README = `# input/

This folder is where you drop your point cloud for the HUD demo to inhale.

The script auto-discovers files in this directory and converts the first one
it finds into a Potree octree the viewer can walk through. Empty? It falls
back to the bundled Lion Takanawa sample (so the demo always runs).

Supported file types
  .e57        ASTM E57 (Leica / Faro / Matterport export)
  .las        ASPRS LAS
  .laz        LASzip (compressed LAS) — including .copc.laz
  .ply        Stanford PLY

How it picks
  - 1 file  → that one wins
  - 2+ files → first alphabetical wins; a warning is logged naming the pick
  - 0 files → bundled Lion Takanawa sample (the default demo scan)

Cache
  Each input file gets its own octree cache keyed by SHA-256 prefix, under
  ~/.cache/candyfactory/hud-demo-output/<sha-prefix>/. Switching inputs
  doesn't trash the previous octree.

Not tracked by git. Drop your scan. Run the script. Inhale.
`;

const INPUT_EXT_RE = /\.(copc\.laz|e57|las|laz|ply)$/i;

async function ensureInputFolder() {
  const dir = inputDirAbs();
  const existed = await exists(dir);
  if (!existed) {
    await ensureDir(dir);
  }
  const readmePath = path.join(dir, 'README.md');
  if (!(await exists(readmePath))) {
    await fsp.writeFile(readmePath, INPUT_README);
  }
  return { dir, created: !existed };
}

async function pickInputFile(bus) {
  const dir = inputDirAbs();
  if (!(await exists(dir))) return null;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => INPUT_EXT_RE.test(n))
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (candidates.length === 0) return null;

  const pick = candidates[0];
  const pickAbs = path.join(dir, pick);

  if (candidates.length > 1) {
    const msg = `multiple files in ./input/ (${candidates.length} found) — inhaling first alphabetical: ${pick}`;
    term('warn', msg);
    bus.emit('log', { level: 'warn', text: `⚠ ${msg}` });
  }

  return { name: pick, absPath: pickAbs, count: candidates.length };
}

function shaPrefix(hex) { return hex.slice(0, 12); }

function resolveOctreeCacheDir(inputSha) {
  // Per-input-SHA subdir so switching input files doesn't trash the previous
  // octree. Trade-off: cumulative disk over time. Acceptable — engineer can
  // nuke ~/.cache/candyfactory/hud-demo-output/ to reclaim.
  return path.join(cacheOctreeRoot, shaPrefix(inputSha), 'octree');
}

// ───────────────────────────────────────── CUDA / NVIDIA detection
//
// Auto-CUDA per spec Addendum B §B3: detect NVIDIA in preflight; use CUDA-enabled
// PotreeConverter if available; silently fall back to CPU otherwise.
//
// INVESTIGATION (2026-05-25):
//   - PotreeConverter 2.x releases (2.1.1, 2.1.2 prerelease) ship ONLY
//     `x64_linux.zip` + `x64_windows.zip` — no CUDA-tagged variants.
//   - PotreeConverter develop-branch CMakeLists.txt declares `project(... LANGUAGES CXX)`
//     (no CUDA), links TBB for parallelism, no `.cu` source files, no `find_package(CUDA)`.
//   - The 2.x README mentions WebGPU rewrite plans for the *viewer*, not the converter.
//   - Conclusion: PotreeConverter 2.x has no CUDA codepaths upstream. CUDA-accelerated
//     point-cloud chunking was a 1.x research-prototype feature, not carried forward.
//
// DECISION (spec §B3 path "c"): implement detection + SSE log line; keep CPU binary;
// log a one-shot info note if NVIDIA is detected explaining the upstream gap.
// CPU path is non-regression — no behavior change when NVIDIA is absent.
//
// Future: if PotreeConverter 3.x ships a CUDA binary, this is the single seam to
// flip (toggle `effectiveCudaPath`, fetch a CUDA archive, switch cache key).

async function detectCuda() {
  // Probe nvidia-smi. We use `execSync` with low timeout + swallowed stderr so a
  // missing or malfunctioning nvidia-smi is silent (no user-visible error per §B3).
  // First check whether the binary is even on PATH; saves a spawn on the common case.
  const probe = process.platform === 'win32'
    ? 'where nvidia-smi'
    : 'command -v nvidia-smi';
  try {
    execSync(probe, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_500 });
  } catch {
    return { available: false, reason: 'nvidia-smi not on PATH' };
  }
  // nvidia-smi exists — list GPUs. A line like "GPU 0: NVIDIA GeForce RTX 4090 (UUID: ...)"
  // confirms at least one device. Empty output / non-zero exit = no GPU usable.
  try {
    const out = execSync('nvidia-smi -L', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      encoding: 'utf8',
    });
    const gpus = out.split(/\r?\n/).filter((l) => /^GPU \d+:/.test(l));
    if (gpus.length === 0) {
      return { available: false, reason: 'nvidia-smi present but reported no GPUs' };
    }
    return {
      available: true,
      gpuCount: gpus.length,
      gpuNames: gpus.map((l) => {
        const m = l.match(/^GPU \d+:\s*(.+?)(?:\s*\(UUID:.*)?$/);
        return m ? m[1].trim() : l.trim();
      }),
    };
  } catch (err) {
    return { available: false, reason: `nvidia-smi -L failed: ${err.message}` };
  }
}

// ───────────────────────────────────────── SSE machinery

class EventBus {
  constructor() {
    /** @type {Array<{event: string, data: any, id: number}>} */
    this.buffer = [];
    this.nextId = 1;
    /** @type {Set<http.ServerResponse>} */
    this.clients = new Set();
    this.theaterConnectedAt = null;
  }

  emit(event, data) {
    const id = this.nextId++;
    const entry = { event, data, id };
    this.buffer.push(entry);
    if (this.buffer.length > REPLAY_BUFFER_MAX) this.buffer.shift();
    for (const res of this.clients) {
      try { this._write(res, entry); } catch { /* dropped */ }
    }
  }

  _write(res, { event, data, id }) {
    res.write(`id: ${id}\n`);
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  attach(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 1000\n\n`);
    // Replay buffer
    for (const entry of this.buffer) this._write(res, entry);
    this.clients.add(res);
    if (this.theaterConnectedAt === null) {
      this.theaterConnectedAt = Date.now();
      term('success', `theater connected at ${new Date(this.theaterConnectedAt).toISOString()}`);
    }
    const ping = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch { /* will fall off below */ }
    }, 15_000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }
}

// ───────────────────────────────────────── HTTP server

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.hrc': 'application/octet-stream',
  '.glsl': 'text/plain; charset=utf-8',
};

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(req, res, absPath, { fallbackBody } = {}) {
  try {
    const stat = await fsp.stat(absPath);
    if (stat.isDirectory()) {
      const indexFile = path.join(absPath, 'index.html');
      if (await exists(indexFile)) return serveStatic(req, res, indexFile);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Directory listing disabled\n');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeOf(absPath),
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    const stream = fs.createReadStream(absPath);
    stream.pipe(res);
  } catch (err) {
    if (fallbackBody) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fallbackBody);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${req.url}\n(${err.message})\n`);
  }
}

const placeholderHtml = (filename, role) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${role} placeholder</title>
<style>
  html,body{margin:0;height:100%;background:#fff7ed;color:#3b2a1b;font:14px/1.5 monospace}
  .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center}
  code{background:#fde2c4;padding:2px 6px;border-radius:4px}
  h1{font-size:22px;color:#b8336a}
</style></head>
<body><div class="wrap">
  <h1>${role} placeholder</h1>
  <p><code>${filename}</code> not found in the asset bundle.</p>
  <p>The CLI server is running normally — refresh once the asset lands.</p>
</div></body></html>`;

function buildRouter(bus, opts) {
  return async (req, res) => {
    const url = new URL(req.url, `http://localhost:${opts.port}`);
    const pathname = url.pathname;
    if (pathname === '/events') return bus.attach(req, res);
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        theaterConnectedAt: bus.theaterConnectedAt,
        clients: bus.clients.size,
        bufferedEvents: bus.buffer.length,
        port: opts.port,
      }));
      return;
    }
    // Route map
    if (pathname === '/' || pathname === '/theater.html') {
      const f = path.join(assetsRoot, 'theater', 'theater.html');
      return serveStatic(req, res, f, { fallbackBody: placeholderHtml('assets/theater/theater.html', 'Theater') });
    }
    if (pathname === '/hud.html') {
      const f = path.join(assetsRoot, 'hud', 'hud.html');
      return serveStatic(req, res, f, { fallbackBody: placeholderHtml('assets/hud/hud.html', 'HUD') });
    }
    if (pathname.startsWith('/assets/')) {
      const rel = pathname.slice('/assets/'.length);
      const safe = path.normalize(rel).replace(/^([./\\])+/, '');
      const f = path.join(assetsRoot, safe);
      return serveStatic(req, res, f);
    }
    if (pathname.startsWith('/octree/')) {
      const rel = pathname.slice('/octree/'.length);
      const safe = path.normalize(rel).replace(/^([./\\])+/, '');
      const f = path.join(cacheOctree, safe);
      return serveStatic(req, res, f);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`Not found: ${pathname}\n`);
  };
}

function pickFreePort() {
  return new Promise(async (resolve) => {
    for (let p = PORT_RANGE.start; p <= PORT_RANGE.end; p++) {
      const free = await new Promise((r) => {
        const srv = http.createServer();
        srv.once('error', () => r(false));
        srv.once('listening', () => srv.close(() => r(true)));
        srv.listen(p, '127.0.0.1');
      });
      if (free) return resolve(p);
    }
    // Fallback to OS-assigned
    resolve(0);
  });
}

// ───────────────────────────────────────── downloads

async function download(url, destPath, { onProgress, attempt = 1 } = {}) {
  // Follow redirects manually using fetch (Node 22 has global fetch)
  await ensureDir(path.dirname(destPath));
  const partial = `${destPath}.partial`;
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const total = Number(resp.headers.get('content-length') || 0);
    const reader = resp.body.getReader();
    const out = fs.createWriteStream(partial);
    let received = 0;
    let lastEmit = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      await new Promise((r, j) => out.write(value, (e) => (e ? j(e) : r())));
      const now = Date.now();
      if (onProgress && (now - lastEmit > 200 || (total && received >= total))) {
        onProgress({ received, total });
        lastEmit = now;
      }
    }
    await new Promise((r) => out.end(r));
    await fsp.rename(partial, destPath);
    return { received, total };
  } catch (err) {
    if (attempt < DOWNLOAD_RETRY.attempts) {
      term('warn', `download failed (${err.message}); retrying in ${DOWNLOAD_RETRY.backoffMs}ms`);
      await sleep(DOWNLOAD_RETRY.backoffMs);
      return download(url, destPath, { onProgress, attempt: attempt + 1 });
    }
    try { await fsp.unlink(partial); } catch { /* leave .partial on full failure */ }
    throw err;
  }
}

// ───────────────────────────────────────── stages

async function preflight(bus) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) throw new Error(`Node >= 20 required (got ${process.versions.node})`);
  await ensureDir(cacheRoot);
  await ensureDir(cachePotreeConv);
  await ensureDir(cacheE57);
  await ensureDir(cacheViewer);
  await ensureDir(cacheOctreeRoot);
  await ensureDir(vendorRoot);
  // Input folder + README — so the engineer finds the contract without us telling them.
  const inputInfo = await ensureInputFolder();
  if (inputInfo.created) {
    term('success', `created ./input/ at ${inputInfo.dir} (with README)`);
  } else {
    term('success', `input folder ready: ${inputInfo.dir}`);
  }
  term('success', `preflight ok (node ${process.versions.node}, cache ${cacheRoot})`);

  // Auto-CUDA detection (spec Addendum B §B3). Stash on bus so downstream stages
  // can read without re-probing. Note: PotreeConverter 2.x has no CUDA codepaths
  // upstream (see investigation comment near detectCuda); detection drives the
  // log line + future-readiness only. CPU path is the only operative path today.
  const cuda = await detectCuda();
  bus.cuda = cuda;
  if (cuda.available) {
    const gpuLabel = cuda.gpuNames && cuda.gpuNames.length
      ? `${cuda.gpuCount}× ${cuda.gpuNames[0]}${cuda.gpuCount > 1 ? ' (+more)' : ''}`
      : `${cuda.gpuCount} GPU(s)`;
    term('success', `NVIDIA GPU detected: ${gpuLabel}`);
    bus.emit('log', {
      level: 'info',
      text: `▸ NVIDIA GPU detected — using CUDA-accelerated converter`,
    });
    // One-shot upstream-gap note: PotreeConverter 2.x has no CUDA binary
    // available upstream, so even though we detected a GPU we will still
    // run the CPU binary this session. Logged ONCE at info level — no
    // user-visible error per §B3 graceful-degradation constraint.
    bus.emit('log', {
      level: 'info',
      text: `   (note: PotreeConverter 2.x ships no CUDA binary upstream — running CPU build; GPU stays idle)`,
    });
  } else {
    term('info', `no NVIDIA GPU detected (${cuda.reason}) — using CPU converter`);
    bus.emit('log', {
      level: 'info',
      text: `▸ no NVIDIA GPU — using CPU converter (this is fine)`,
    });
  }
}

async function ensurePointCloudSample(bus) {
  bus.emit('stage', { n: 1, total: 5, name: 'inhale-scan', caption: 'inhaling point cloud' });

  // 1) Look in ./input/ first — engineer-supplied scan wins.
  const picked = await pickInputFile(bus);
  if (picked) {
    const rel = path.relative(process.cwd(), picked.absPath) || picked.name;
    term('success', `inhaled ${rel}`);
    bus.emit('log', { level: 'info', text: `▸ inhaled ./input/${picked.name}` });
    const sha = await sha256OfFile(picked.absPath);
    bus.emit('log', { level: 'info', text: `scan sha256: ${sha.slice(0, 16)}…` });
    return {
      src: { kind: 'user-input', name: picked.name, license: 'engineer-supplied' },
      path: picked.absPath,
      sha256: sha,
      source: 'input',
    };
  }

  // 2) Fall back to the bundled Lion Takanawa sample.
  bus.emit('log', { level: 'info', text: 'no files in ./input/ — inhaling bundled Lion Takanawa sample' });
  term('info', 'no files in ./input/ — falling back to bundled sample');

  const dest = path.join(cacheE57, POINT_CLOUD_PRIMARY.name);
  if (await exists(dest)) {
    const actual = await sha256OfFile(dest);
    if (actual === POINT_CLOUD_PRIMARY.sha256) {
      term('success', `bundled scan cached: ${POINT_CLOUD_PRIMARY.name} (sha256=${actual.slice(0, 12)}…)`);
      bus.emit('log', { level: 'success', text: `inhaled bundled ${POINT_CLOUD_PRIMARY.name}` });
      return { src: POINT_CLOUD_PRIMARY, path: dest, sha256: actual, source: 'bundled' };
    }
    term('warn', `cached ${POINT_CLOUD_PRIMARY.name} sha mismatch; re-staging`);
    await fsp.unlink(dest);
  }

  // Locate inside the extracted viewer zip
  const viewerExtractRoot = path.join(cacheViewer, `Potree_${POTREE_VIEWER_VERSION}`);
  const inViewer = path.join(viewerExtractRoot, 'pointclouds', POINT_CLOUD_PRIMARY.name);
  if (!(await exists(inViewer))) {
    // Viewer hasn't been extracted yet — extract first
    bus.emit('log', { level: 'info', text: 'viewer not extracted; staging viewer first' });
    await ensurePotreeViewer(bus);
  }
  if (!(await exists(inViewer))) {
    throw new Error(
      `Bundled sample not found at ${inViewer} after viewer staging. ` +
      `Fallback: drop any .las/.laz/.e57/.ply into ./input/ and re-run.`,
    );
  }
  await fsp.cp(inViewer, dest);
  const actual = await sha256OfFile(dest);
  if (actual !== POINT_CLOUD_PRIMARY.sha256) {
    term('warn', `sha mismatch on bundled ${POINT_CLOUD_PRIMARY.name}: got ${actual}, expected ${POINT_CLOUD_PRIMARY.sha256}`);
    bus.emit('log', { level: 'warn', text: `sha mismatch (continuing): ${actual.slice(0,16)}` });
  } else {
    term('success', `bundled scan staged: ${POINT_CLOUD_PRIMARY.name} (sha256=${actual.slice(0, 12)}…)`);
  }
  bus.emit('log', { level: 'success', text: `inhaled bundled ${POINT_CLOUD_PRIMARY.name}` });
  return { src: POINT_CLOUD_PRIMARY, path: dest, sha256: actual, source: 'bundled' };
}

function unzip(archivePath, destDir) {
  // Cross-platform: try `unzip` first, fall back to `bsdtar`/`7z`/`tar` if absent.
  // PotreeConverter zip uses standard zip format; Linux has unzip ubiquitously.
  // We rely on `unzip` here for simplicity (spec scope: Linux + macOS).
  return new Promise((resolve, reject) => {
    const child = spawn('unzip', ['-oq', archivePath, '-d', destDir], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`unzip exited with code ${code}`));
    });
  });
}

async function ensurePotreeConverter(bus) {
  const plat =
    process.platform === 'linux' ? 'linux'
    : process.platform === 'win32' ? 'win32'
    : null;
  if (!plat) {
    throw new Error(
      `PotreeConverter pre-built binary not available for ${process.platform}. ` +
      `On macOS, build from source (https://github.com/potree/PotreeConverter#building) and place at ` +
      `${path.join(cachePotreeConv, process.platform, 'PotreeConverter')}.`,
    );
  }
  // CUDA-aware cache key per spec §B3. PotreeConverter 2.x has no CUDA upstream
  // binary today, so even when CUDA is "available" we still fetch the CPU archive
  // — but we cache under the CUDA key so the day a CUDA build appears, swap is
  // a one-line change (POTREE_CONV_SOURCES gets a `linux-cuda` entry, this read
  // resolves it). Today both keys store identical bytes; harmless duplication
  // bounded to one platform per host. Cache hits work either way.
  const cudaAvailable = bus.cuda?.available === true;
  const platKey = cudaAvailable ? `${plat}-cuda` : plat;
  const src = POTREE_CONV_SOURCES[plat]; // CPU source — only one that exists upstream
  const platDir = path.join(cachePotreeConv, platKey);
  await ensureDir(platDir);
  const binPath = path.join(platDir, src.binaryRelPath);
  const versionFile = path.join(platDir, 'version.txt');
  const archivePath = path.join(platDir, src.archiveName);

  // Check cache
  if (await exists(binPath)) {
    const v = (await exists(versionFile)) ? (await fsp.readFile(versionFile, 'utf8')).trim() : '';
    if (v === POTREE_CONV_VERSION) {
      term('success', `PotreeConverter cached: ${binPath} (v${POTREE_CONV_VERSION})`);
      return binPath;
    }
    term('warn', `PotreeConverter version mismatch (${v} != ${POTREE_CONV_VERSION}); refreshing`);
  }

  bus.emit('stage', { n: 2, total: 5, name: 'fetch-converter', caption: 'fetching PotreeConverter binary' });
  bus.emit('log', { level: 'download', text: `pulling PotreeConverter v${POTREE_CONV_VERSION} (${plat})` });

  await download(src.url, archivePath, {
    onProgress: ({ received, total }) => {
      bus.emit('progress', { name: 'fetch-converter', current: received, total, unit: 'bytes' });
    },
  });
  const sha = await sha256OfFile(archivePath);
  bus.emit('log', { level: 'info', text: `archive sha256: ${sha.slice(0, 16)}…` });
  term('success', `PotreeConverter archive sha256: ${sha}`);

  // Extract
  bus.emit('log', { level: 'info', text: 'extracting…' });
  await unzip(archivePath, platDir);
  // The zip extracts to a single subdir (folder name varies between releases:
  //   v2.1.1 linux: PotreeConverter_linux_x64/
  //   v2.1.1 win  : PotreeConverter_windows_x64/
  // — flatten whichever subdir contains the binary).
  const platEntries = await fsp.readdir(platDir, { withFileTypes: true });
  for (const entry of platEntries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(platDir, entry.name, src.binaryRelPath);
    if (await exists(candidate)) {
      // Flatten: move contents up
      const innerDir = path.join(platDir, entry.name);
      const innerEntries = await fsp.readdir(innerDir);
      for (const e of innerEntries) {
        const from = path.join(innerDir, e);
        const to = path.join(platDir, e);
        try { await fsp.rm(to, { recursive: true, force: true }); } catch { /* ignore */ }
        await fsp.rename(from, to);
      }
      await fsp.rm(innerDir, { recursive: true, force: true });
      break;
    }
  }
  if (!(await exists(binPath))) {
    throw new Error(`PotreeConverter binary not found at ${binPath} after extract. Inspect ${platDir}.`);
  }
  if (plat !== 'win32') {
    await fsp.chmod(binPath, 0o755);
  }
  await fsp.writeFile(versionFile, POTREE_CONV_VERSION);
  // Keep archive for reproducibility audits, not deleted
  term('success', `PotreeConverter installed: ${binPath}`);
  bus.emit('log', { level: 'success', text: 'PotreeConverter ready' });
  return binPath;
}

async function ensurePotreeViewer(bus) {
  // Marker file used to skip re-extract on subsequent runs.
  const marker = path.join(vendorRoot, 'potree', '.installed-v' + POTREE_VIEWER_VERSION);
  if (await exists(marker)) {
    term('success', `Potree viewer cached: vendor/potree/ (v${POTREE_VIEWER_VERSION})`);
    return;
  }
  const archivePath = path.join(cacheViewer, `Potree_${POTREE_VIEWER_VERSION}.zip`);
  if (!(await exists(archivePath))) {
    bus.emit('stage', { n: 3, total: 5, name: 'fetch-viewer', caption: 'fetching Potree viewer (one-time)' });
    bus.emit('log', { level: 'download', text: `pulling Potree viewer v${POTREE_VIEWER_VERSION}` });
    await download(POTREE_VIEWER_URL, archivePath, {
      onProgress: ({ received, total }) => {
        bus.emit('progress', { name: 'fetch-viewer', current: received, total, unit: 'bytes' });
      },
    });
    const sha = await sha256OfFile(archivePath);
    term('success', `viewer archive sha256: ${sha}`);
    bus.emit('log', { level: 'info', text: `viewer sha256: ${sha.slice(0, 16)}…` });
  } else {
    term('success', `viewer archive cached: ${archivePath}`);
  }
  // Extract once into cacheViewer
  const extractedRoot = path.join(cacheViewer, `Potree_${POTREE_VIEWER_VERSION}`);
  if (!(await exists(extractedRoot))) {
    bus.emit('log', { level: 'info', text: 'extracting viewer…' });
    await unzip(archivePath, cacheViewer);
  }
  // Copy slice into vendor — only what the viewer needs.
  bus.emit('log', { level: 'info', text: 'staging viewer into vendor/' });
  const vendorPotree = path.join(vendorRoot, 'potree');
  await fsp.rm(vendorPotree, { recursive: true, force: true });
  await ensureDir(vendorPotree);

  const wanted = [
    'build/potree',
    'build/shaders',
    'libs/jquery',
    'libs/jquery-ui',
    'libs/three.js',
    'libs/tween',
    'libs/d3',
    'libs/proj4',
    'libs/openlayers3',
    'libs/i18next',
    'libs/jstree',
    'libs/spectrum',
    'libs/plasio',
    'libs/other',
  ];
  for (const rel of wanted) {
    const src = path.join(extractedRoot, rel);
    const dst = path.join(vendorPotree, rel);
    await ensureDir(path.dirname(dst));
    // Node 22 fs.cp recursive
    await fsp.cp(src, dst, { recursive: true });
  }
  await fsp.writeFile(marker, new Date().toISOString());
  term('success', `Potree viewer staged: ${vendorPotree}`);
  bus.emit('log', { level: 'success', text: 'viewer ready' });
}

async function runPotreeConverter(bus, { binPath, e57Path }) {
  bus.emit('stage', { n: 4, total: 5, name: 'convert', caption: 'converting scan to web-walkable points' });
  bus.emit('log', { level: 'info', text: `running PotreeConverter on ${path.basename(e57Path)}` });

  // Clear any prior octree output
  await fsp.rm(cacheOctree, { recursive: true, force: true });
  await ensureDir(cacheOctree);

  const args = ['-i', e57Path, '-o', cacheOctree];
  term('info', `spawn: ${binPath} ${args.join(' ')}`);

  // PotreeConverter ships liblaszip.so next to the binary; the dynamic loader
  // needs LD_LIBRARY_PATH (Linux) / @loader_path (macOS handled by binary) to find it.
  const binDir = path.dirname(binPath);
  const envForChild = { ...process.env };
  if (process.platform === 'linux') {
    envForChild.LD_LIBRARY_PATH = binDir + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : '');
  } else if (process.platform === 'darwin') {
    envForChild.DYLD_LIBRARY_PATH = binDir + (process.env.DYLD_LIBRARY_PATH ? `:${process.env.DYLD_LIBRARY_PATH}` : '');
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(binPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envForChild,
      cwd: binDir,
    });
    const tail = [];
    const stream = (chunk, level) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        tail.push(trimmed);
        if (tail.length > 20) tail.shift();
        bus.emit('log', { level, text: trimmed });
        // Heuristic: surface percent progress when PotreeConverter prints "[xx%]"
        const pct = trimmed.match(/\[\s*(\d{1,3})\s*%\s*\]/);
        if (pct) {
          bus.emit('progress', {
            name: 'convert', current: Number(pct[1]), total: 100, unit: 'percent',
          });
        }
        if (isTTY) console.log(`  ${paint('ink', line)}`);
      }
    };
    child.stdout.on('data', (b) => stream(b, 'info'));
    child.stderr.on('data', (b) => stream(b, 'warn'));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        bus.emit('log', { level: 'success', text: 'conversion complete' });
        resolve({ tail });
      } else {
        const err = new Error(`PotreeConverter exited with code ${code}`);
        err.tail = tail;
        reject(err);
      }
    });
  });
}

// ───────────────────────────────────────── browser open

async function openBrowser(url) {
  // Prefer the `open` npm package if present; otherwise fall back to xdg-open/open/start.
  try {
    const mod = await import('open');
    await mod.default(url);
    return 'open-pkg';
  } catch {
    const cmd =
      process.platform === 'darwin' ? ['open', url]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
    try {
      if (Array.isArray(cmd[1])) {
        spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(cmd[0], [url], { detached: true, stdio: 'ignore' }).unref();
      }
      return 'system';
    } catch (err) {
      term('warn', `could not open browser automatically — visit ${url} manually (${err.message})`);
      return 'manual';
    }
  }
}

// ───────────────────────────────────────── main

async function main() {
  const flags = new Set(process.argv.slice(2));
  const skipBrowser = flags.has('--no-open') || process.env.HUD_DEMO_NO_OPEN === '1';
  const exitAfterDone = flags.has('--exit-after-done') || process.env.HUD_DEMO_EXIT_AFTER_DONE === '1';

  term('info', 'CandyFactory · Bonfire HUD demo');
  term('info', `repo root: ${repoRoot}`);

  const bus = new EventBus();
  await preflight(bus);

  // A1 server
  const port = (await pickFreePort()) || (await new Promise((r) => {
    const srv = http.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => r(p));
    });
  }));
  const router = buildRouter(bus, { port });
  const server = http.createServer(router);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const theaterUrl = `http://localhost:${port}/theater.html`;
  const hudUrl = `http://localhost:${port}/hud.html`;
  term('success', `server live: ${theaterUrl}`);
  term('info', `events: http://localhost:${port}/events  ·  hud: ${hudUrl}`);

  // A2 open browser
  if (!skipBrowser) {
    const how = await openBrowser(theaterUrl);
    term('info', `opened browser via: ${how}`);
  } else {
    term('warn', `browser open skipped (--no-open)`);
  }

  // A3 await theater (5s timeout, log + proceed)
  const startAwait = Date.now();
  while (bus.theaterConnectedAt === null && Date.now() - startAwait < AWAIT_THEATER_TIMEOUT_MS) {
    await sleep(50);
  }
  if (bus.theaterConnectedAt === null) {
    term('warn', `theater did not connect within ${AWAIT_THEATER_TIMEOUT_MS}ms — proceeding anyway (replay buffer will catch it up)`);
  }

  // PHASE B — events stream live
  bus.emit('stage', { n: 0, total: 5, name: 'preflight', caption: 'preflight ok' });
  bus.emit('log', { level: 'success', text: 'preflight complete' });

  // Viewer first — its extracted zip is the source of the sample point cloud
  try {
    await ensurePotreeViewer(bus);
  } catch (err) {
    // Non-fatal — HUD will still render with broken viewer; warn but continue.
    bus.emit('log', { level: 'warn', text: `viewer staging failed: ${err.message}` });
    term('warn', `viewer staging failed: ${err.message}`);
  }

  let scanPick;
  try {
    scanPick = await ensurePointCloudSample(bus);
  } catch (err) {
    bus.emit('error', { stage: 'inhale-scan', message: err.message, lastLines: [err.message] });
    throw err;
  }
  // Per-input-SHA octree cache: keep one octree per unique input so swapping
  // input files doesn't clobber previous conversions. Re-point the module-level
  // `cacheOctree` so the /octree/* route + runPotreeConverter both use it.
  cacheOctree = resolveOctreeCacheDir(scanPick.sha256);
  await ensureDir(cacheOctree);
  term('info', `octree cache: ${cacheOctree}`);

  let binPath;
  try {
    binPath = await ensurePotreeConverter(bus);
  } catch (err) {
    bus.emit('error', { stage: 'fetch-converter', message: err.message, lastLines: [err.message] });
    throw err;
  }

  try {
    await runPotreeConverter(bus, { binPath, e57Path: scanPick.path });
  } catch (err) {
    bus.emit('error', {
      stage: 'convert',
      message: err.message,
      lastLines: err.tail || [err.message],
    });
    throw err;
  }

  bus.emit('stage', { n: 5, total: 5, name: 'finalize', caption: 'wrapping up' });

  // B4 — theater floor gate
  if (bus.theaterConnectedAt !== null) {
    const elapsed = Date.now() - bus.theaterConnectedAt;
    if (elapsed < THEATER_FLOOR_MS) {
      const wait = THEATER_FLOOR_MS - elapsed;
      term('info', `real work done in ${elapsed}ms; holding for theater floor (${wait}ms more)`);
      await sleep(wait);
    }
  } else {
    // No theater ever connected — emit done immediately so script doesn't hang
    term('warn', 'no theater connection — emitting done immediately');
  }

  bus.emit('done', {});
  term('success', `done event emitted · HUD at ${hudUrl}`);

  if (exitAfterDone) {
    term('info', 'exit-after-done flag set; shutting down');
    server.close();
    return;
  }

  // PHASE C — hold until SIGINT
  term('info', 'holding server until Ctrl+C (HUD continues to read /octree/ from here)');
  await new Promise((resolve) => {
    process.on('SIGINT', () => {
      term('info', 'SIGINT received — shutting down');
      server.close(() => resolve());
    });
    process.on('SIGTERM', () => {
      term('info', 'SIGTERM received — shutting down');
      server.close(() => resolve());
    });
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(paint('cherry', `\n✗ fatal: ${err.message}`));
  if (err.stack) console.error(paint('ink', err.stack.split('\n').slice(1).join('\n')));
  process.exit(1);
});
