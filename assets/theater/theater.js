/* ============================================================================
   theater.js — CandyFactory home shell runtime.

   Responsibilities:
   1. Subscribe to /events (SSE) per spec §5; reconnect on disconnect with 1s backoff.
   2. Handle event types: stage, log, progress, done, error.
   3. Animate Chunk: working baseline (60%) + baking (25%) drifts + cheer pulse
      on stage transitions + oops on error. Palette rotates pink→butter→mint→grape
      per stage.
   4. Terminal: append fading lines with stage/log/error styling, cap at 50,
      auto-scroll bottom.
   5. Progress bar smooth fill + stage caption update.
   6. Done sequence: print stepping-in line, swap Chunk to cheer, fade surface
      to white 600ms, navigate to /hud.html.
   7. Standalone-open guard: when opened directly via file:// or python -m
      http.server (no SSE backend), don't 404-spam — give up after a few
      retries and idle gracefully.

   Anti-coupling note: this script ONLY consumes the SSE contract. It never
   imports or awaits the CLI pipeline directly. The contract IS the boundary.
   ============================================================================ */

(() => {
  'use strict';

  // ── DOM handles ──
  const $ = (id) => document.getElementById(id);
  const stage       = $('stage');
  const chunkAnchor = $('chunk-anchor');
  const chunkUse    = $('chunk-use');
  const chunkLabel  = $('chunk-mood-label');
  const termBody    = $('term-body');
  const bar         = $('bar');
  const barFill     = $('bar-fill');
  const barPct      = $('bar-pct');
  const stageN      = $('stage-n');
  const stageTotal  = $('stage-total');
  const stageText   = $('stage-text');
  const errorCard   = $('error-card');
  const errorMsg    = $('error-msg');
  const fadeCover   = $('fade-cover');

  // ── State ──
  const PALETTES = ['pink', 'butter', 'mint', 'grape'];
  let paletteIx = 0;          // current chunk palette index
  let currentMood = 'working';
  let currentPalette = 'pink';
  let stageIx = 0;
  let stageTotalKnown = 6;
  let totalLinesPrinted = 0;
  const MAX_LINES = 50;

  // Baseline mood-drift loop:
  //   60% working · 25% baking · 15% working (we model this as 4s cycles)
  let moodDriftTimer = null;
  let cheerLockUntil = 0;
  let oopsLocked = false;

  // ── Chunk control ──
  function setChunk(mood, palette) {
    if (oopsLocked && mood !== 'oops') return;          // error wins until reload
    currentMood = mood;
    currentPalette = palette || currentPalette;
    chunkUse.setAttribute(
      'href',
      `/assets/theater/chunk.svg#chunk-${currentMood}-${currentPalette}`
    );
    chunkLabel.textContent = currentMood;
  }

  function pulseCheer() {
    if (oopsLocked) return;
    chunkAnchor.classList.remove('cheer');
    // force reflow so the animation re-fires
    void chunkAnchor.offsetWidth;
    chunkAnchor.classList.add('cheer');
    setChunk('cheer', currentPalette);
    cheerLockUntil = Date.now() + 1000;
    setTimeout(() => {
      if (Date.now() >= cheerLockUntil && !oopsLocked) {
        setChunk('working', currentPalette);
        chunkAnchor.classList.remove('cheer');
      }
    }, 1000);
  }

  function setOops() {
    oopsLocked = true;
    chunkAnchor.classList.remove('cheer');
    chunkAnchor.classList.add('oops');
    setChunk('oops', currentPalette);
  }

  function startMoodDrift() {
    if (moodDriftTimer) return;
    // Every 4s: pick working or baking with ~71/29 weighting (60% / 25% over
    // the long run, since cheer + oops occupy the remainder).
    moodDriftTimer = setInterval(() => {
      if (oopsLocked) return;
      if (Date.now() < cheerLockUntil) return;
      const r = Math.random();
      setChunk(r < 0.71 ? 'working' : 'baking', currentPalette);
    }, 4000);
  }

  // ── Palette rotation on stage transition ──
  function rotatePalette() {
    paletteIx = (paletteIx + 1) % PALETTES.length;
    currentPalette = PALETTES[paletteIx];
    setChunk(currentMood, currentPalette);
    // Match the progress-bar candy to the same hue so the surface feels coherent.
    barFill.classList.remove('pink', 'butter', 'mint', 'grape');
    barFill.classList.add(currentPalette);
  }

  // ── Terminal ──
  const GLYPHS = {
    stage:    '▸',
    info:     '·',
    success:  '✓',
    download: '↓',
    progress: '⎯',
    warn:     '⚠',
    error:    '✗',
  };

  function nowStamp() {
    const d = new Date();
    const p = (n) => n.toString().padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function termAppend(kind, text) {
    const line = document.createElement('div');
    line.className = `term-line ${kind}`;
    const glyph = GLYPHS[kind] || GLYPHS.info;

    const tsSpan = document.createElement('span');
    tsSpan.className = 'ts';
    tsSpan.textContent = nowStamp();
    const gSpan = document.createElement('span');
    gSpan.className = 'glyph';
    gSpan.textContent = glyph;
    const textNode = document.createTextNode(text);

    line.appendChild(tsSpan);
    line.appendChild(gSpan);
    line.appendChild(textNode);
    termBody.appendChild(line);
    totalLinesPrinted++;

    // Cap visible lines — keep DOM light.
    while (termBody.children.length > MAX_LINES) {
      termBody.removeChild(termBody.firstChild);
    }
    termBody.scrollTop = termBody.scrollHeight;
  }

  // ── Progress bar ──
  function setProgressPercent(pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    barFill.style.width = clamped + '%';
    barPct.textContent = Math.round(clamped) + '%';
    bar.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }

  // ── Event handlers ──
  function onStage(data) {
    stageIx = data.n || stageIx + 1;
    stageTotalKnown = data.total || stageTotalKnown;
    stageN.textContent = String(stageIx);
    stageTotal.textContent = String(stageTotalKnown);
    if (data.caption) stageText.textContent = data.caption;
    // progress = % of stages completed (current stage in progress = its start)
    setProgressPercent((stageIx - 1) / stageTotalKnown * 100);
    rotatePalette();
    pulseCheer();
    termAppend('stage', `${data.name || 'stage'} · ${data.caption || ''}`.trim().replace(/ ·\s*$/, ''));
  }

  function onLog(data) {
    const level = data.level || 'info';
    termAppend(level, data.text || '');
  }

  function onProgress(data) {
    // Update the inline progress within the bar. The bar tracks stage-completion
    // PLUS the within-stage fraction so it animates smoothly during a long step.
    if (data.current != null && data.total) {
      const within = data.current / data.total;
      const stageStart = (stageIx - 1) / stageTotalKnown;
      const stageSpan = 1 / stageTotalKnown;
      setProgressPercent((stageStart + within * stageSpan) * 100);
      // Emit an inline progress line every ~10% within stage — but only if the
      // server didn't already send a log; to keep the terminal readable we
      // suppress noisy per-byte spam and show stage-relative percentages on
      // the last visible line if it's also a progress line. Simplest: just
      // append a compact progress line per event.
      if (data.unit && data.current != null && data.total != null) {
        const fmt = (n) => data.unit === 'bytes' ? fmtBytes(n) : String(n);
        termAppend('progress', `${data.name || 'progress'} ${fmt(data.current)} / ${fmt(data.total)} (${Math.round(within * 100)}%)`);
      }
    }
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function onError(data) {
    setOops();
    setProgressPercent(0);
    barFill.style.background = 'repeating-linear-gradient(45deg, #ff3b6b 0 14px, #1a1626 14px 28px)';
    errorMsg.textContent = data.message || `${data.stage || 'unknown stage'} failed`;
    errorCard.classList.add('show');
    termAppend('error', `${data.stage || 'stage'}: ${data.message || 'failed'}`);
    if (Array.isArray(data.lastLines)) {
      data.lastLines.forEach((ln) => termAppend('error', '  ' + ln));
    }
  }

  function onDone() {
    setProgressPercent(100);
    stageText.textContent = 'all stages done · stepping into the HUD';
    stageN.textContent = String(stageTotalKnown);
    pulseCheer();
    termAppend('stage', 'HUD ready · stepping in...');
    // Fade the whole surface to white, then navigate.
    setTimeout(() => {
      fadeCover.classList.add('on');
      stage.classList.add('fade-out');
      setTimeout(() => {
        window.location.assign('/hud.html');
      }, 650);
    }, 600);
  }

  // ── SSE connection w/ reconnect backoff ──
  let es = null;
  let standaloneStrikes = 0;
  const STANDALONE_MAX = 3;

  function connect() {
    try {
      es = new EventSource('/events');
    } catch (e) {
      handleStandaloneOpen();
      return;
    }

    es.addEventListener('open', () => {
      standaloneStrikes = 0;
      // server-side log lines will fill in; don't duplicate here.
    });

    es.addEventListener('stage',    (e) => safeJson(e, onStage));
    es.addEventListener('log',      (e) => safeJson(e, onLog));
    es.addEventListener('progress', (e) => safeJson(e, onProgress));
    es.addEventListener('error',    (e) => {
      // EventSource fires `error` on transport-level disconnects without data.
      if (e && e.data) {
        safeJson(e, onError);
      } else {
        // Disconnect — reconnect after 1s. If we never opened in the first
        // place (file:// or no server), give up after a few strikes.
        if (es.readyState === EventSource.CLOSED) {
          es = null;
          standaloneStrikes++;
          if (standaloneStrikes >= STANDALONE_MAX) {
            handleStandaloneOpen();
            return;
          }
          setTimeout(connect, 1000);
        }
      }
    });

    es.addEventListener('done', (e) => safeJson(e, onDone));
  }

  function safeJson(e, fn) {
    try {
      const data = e.data ? JSON.parse(e.data) : {};
      fn(data);
    } catch (err) {
      console.warn('[theater] bad event payload:', err);
    }
  }

  function handleStandaloneOpen() {
    // Visual check mode: opened directly without the orchestrator. Render
    // a friendly placeholder so the surface still looks alive for QA.
    termAppend('warn', 'standalone preview · no /events backend reachable');
    termAppend('info', 'this is a visual check of the theater shell.');
    termAppend('info', 'when the CLI orchestrator boots, real stages stream here.');
    stageText.textContent = 'preview mode · backend not connected';
    stageN.textContent = '—';
  }

  // ── Boot ──
  function boot() {
    setChunk('working', currentPalette);
    startMoodDrift();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
