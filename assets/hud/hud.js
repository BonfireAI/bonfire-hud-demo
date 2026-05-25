/*
 * hud.js — NAPS Vault HUD shell · Saint-Sulpice interior · component-tour mode.
 *
 * What this does:
 *   - Mount Potree.Viewer into <div id="potree_render_area">
 *   - Load /octree/metadata.json and fit camera
 *   - Load /assets/hud/components.json (15+ industrial components scattered through
 *     the cloud's bbox) and render HTML markers + a clickable nodes-index list
 *   - Drive the guided tour controller (prev / play / next) and sync the asset
 *     card + telemetry gauges to the active component
 *   - Animate temperature + pressure gauges with sin(t) wobble around the
 *     component's nominal value (varies per component type)
 *   - Tick the header clock and the live header pill
 *
 * ─────────────────────────────────────────────────────────────────────
 * CUSTOMIZATION MAP (edit these and the HUD updates — no rebuild):
 *   • components.json — N components (10–20+ typical). Each entry needs:
 *       id, name, type, location, manufacturer, tag_color (red|amber|green),
 *       pos_norm {x,y,z} in 0–1 (mapped to bbox at runtime),
 *       metrics { temp_nominal, pressure_nominal, vibration_mmps,
 *                 run_hours, commissioned, last_inspection }
 *   • Gauge ranges — hud.html .gauge data-min/data-max/data-amber/data-red
 *   • Tour interval — TOUR_INTERVAL_MS just below
 *   • Marker visuals — .station-marker + .station-marker.tag-{red|amber|green} in hud.css
 *   • Header pill text — updateHeaderPill() below
 *   • Asset card fields — applyComponentContext() below + hud.html asset-grid block
 * ─────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // CUSTOMIZE: how long each tour stop lingers before auto-advancing
  var TOUR_INTERVAL_MS = 8000;

  // ─── helpers ────────────────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  function warn(msg, extra) { console.warn('[hud.js] ' + msg, extra || ''); }
  function info(msg, extra) { console.log('[hud.js] ' + msg, extra || ''); }
  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function $(sel, root) { return (root || document).querySelector(sel); }

  // ─── header clock ───────────────────────────────────────────────────
  function startClock() {
    var el = $('#clock'); if (!el) return;
    function tick() {
      var d = new Date();
      el.textContent =
        String(d.getHours()).padStart(2,'0') + ':' +
        String(d.getMinutes()).padStart(2,'0') + ':' +
        String(d.getSeconds()).padStart(2,'0');
    }
    tick(); setInterval(tick, 1000);
  }

  // ─── gauges — needle sweep + live wobble ─────────────────────────────
  // Half-circle gauge sweeps from -90° (min) to +90° (max). The needle SVG is
  // drawn pointing UP, so we rotate (-90 + pct·180) to land on the value.
  function setGaugeValue(rootSel, value) {
    var root = $(rootSel); if (!root) return;
    var min = parseFloat(root.dataset.min);
    var max = parseFloat(root.dataset.max);
    var pct = clamp((value - min) / (max - min), 0, 1);
    var needle = root.querySelector('[data-needle]');
    if (needle) needle.style.transform = 'rotate(' + (-90 + pct * 180).toFixed(2) + 'deg)';
    var readout = root.querySelector('[data-readout]');
    if (readout) readout.textContent = Math.round(value);
  }

  var gaugeState = { tempBase: 73, pressBase: 165 };
  function tickGauges(t) {
    var tempWobble  = Math.sin(t / 1100) * 2.4 + Math.sin(t / 430) * 0.9;
    var pressWobble = Math.sin(t / 950)  * 4.2 + Math.sin(t / 380) * 1.5;
    setGaugeValue('#gauge-temp',     gaugeState.tempBase  + tempWobble);
    setGaugeValue('#gauge-pressure', gaugeState.pressBase + pressWobble);
  }

  // ─── components — fetch + resolve world positions ───────────────────
  function loadComponents() {
    return fetch('/assets/hud/components.json', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (json) { return (json && json.components) || []; });
  }

  // Map pos_norm {x,y,z in 0..1} → world coords using the pointcloud's bbox.
  // This is what makes components.json bbox-independent: same JSON works on any cloud.
  function resolveComponentPositions(components, viewer) {
    var bbox = null;
    try {
      var pc = viewer && viewer.scene && viewer.scene.pointclouds && viewer.scene.pointclouds[0];
      if (pc) bbox = pc.boundingBox;
    } catch (e) { /* noop */ }
    if (!bbox) {
      warn('no bbox available — components using raw normalized coords');
      return components.map(function (c) {
        var p = c.pos_norm || { x:0.5, y:0.5, z:0.5 };
        return Object.assign({}, c, { pos: { x: p.x, y: p.y, z: p.z } });
      });
    }
    var sx = bbox.max.x - bbox.min.x;
    var sy = bbox.max.y - bbox.min.y;
    var sz = bbox.max.z - bbox.min.z;
    return components.map(function (c) {
      var p = c.pos_norm || { x:0.5, y:0.5, z:0.5 };
      return Object.assign({}, c, {
        pos: {
          x: bbox.min.x + p.x * sx,
          y: bbox.min.y + p.y * sy,
          z: bbox.min.z + p.z * sz,
        }
      });
    });
  }

  // ─── markers — HTML elements projected onto the 3D scene each frame ──
  function createMarker(c, onClick, onHover, onLeave) {
    var el = document.createElement('div');
    el.className = 'station-marker tag-' + (c.tag_color || 'green');
    el.dataset.index = c.index;
    el.textContent = String(c.index + 1);
    el.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(c); });
    el.addEventListener('mouseenter', function () { onHover(c, el); });
    el.addEventListener('mouseleave', function () { onLeave(); });
    return el;
  }

  function projectWorldToScreen(viewer, x, y, z) {
    try {
      var renderer = viewer.renderer;
      var camera = viewer.scene.getActiveCamera();
      if (!renderer || !camera || typeof THREE === 'undefined') return null;
      var size = renderer.getSize
        ? renderer.getSize(new THREE.Vector2())
        : { x: renderer.domElement.clientWidth, y: renderer.domElement.clientHeight };
      var v = new THREE.Vector3(x, y, z);
      v.project(camera);
      return {
        x: (v.x * 0.5 + 0.5) * size.x,
        y: (-v.y * 0.5 + 0.5) * size.y,
        visible: v.z >= -1 && v.z <= 1,
      };
    } catch (err) { return null; }
  }

  // ─── nodes index list (in the right rack) ───────────────────────────
  // Click any row to jump the tour to that component.
  function renderNodesIndex(components, onJump) {
    var list = $('#nodes-index-list'); if (!list) return null;
    list.innerHTML = '';
    var rows = components.map(function (c, i) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'node-row tag-' + (c.tag_color || 'green');
      row.dataset.index = i;
      row.innerHTML =
        '<span class="node-dot"></span>' +
        '<span class="node-idx mono">' + String(i + 1).padStart(2,'0') + '</span>' +
        '<span class="node-name">' + c.name + '</span>' +
        '<span class="node-loc mono">' + (c.location || '') + '</span>';
      row.addEventListener('click', function () { onJump(i); });
      list.appendChild(row);
      return row;
    });
    function setActive(idx) {
      rows.forEach(function (r, i) { r.classList.toggle('is-active', i === idx); });
      if (rows[idx] && rows[idx].scrollIntoView) {
        rows[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    return { setActive: setActive };
  }

  // ─── tour controller ────────────────────────────────────────────────
  function createTour(viewer, components, applyComponent) {
    var idx = 0, playing = false, timer = null;
    var prevBtn = $('#tour-prev'), nextBtn = $('#tour-next'), playBtn = $('#tour-play');
    var stopEl  = $('#tour-stop'),  nameEl  = $('#tour-name'),  ptsEl  = $('#tour-pts');
    var bar     = $('#tour-bar');

    function render() {
      var c = components[idx]; if (!c) return;
      if (stopEl) stopEl.textContent = (idx + 1) + ' / ' + components.length;
      if (nameEl) nameEl.textContent = c.name;
      if (ptsEl)  ptsEl.textContent  = c.location || c.type;
      applyComponent(c, idx);
    }
    function goto(i) { idx = (i + components.length) % components.length; render(); }
    function next() { goto(idx + 1); }
    function prev() { goto(idx - 1); }
    function setPlaying(p) {
      playing = p;
      if (playBtn) {
        playBtn.innerHTML = playing ? '&#9208;' : '&#9654;';
        playBtn.setAttribute('aria-label', playing ? 'Pause tour' : 'Play tour');
      }
      if (timer) { clearInterval(timer); timer = null; }
      if (playing) timer = setInterval(next, TOUR_INTERVAL_MS);
    }
    if (prevBtn) prevBtn.addEventListener('click', prev);
    if (nextBtn) nextBtn.addEventListener('click', next);
    if (playBtn) playBtn.addEventListener('click', function () { setPlaying(!playing); });
    if (bar) {
      var wasPlaying = false;
      bar.addEventListener('mouseenter', function () { if (playing) { wasPlaying = true; setPlaying(false); } });
      bar.addEventListener('mouseleave', function () { if (wasPlaying) { wasPlaying = false; setPlaying(true); } });
    }
    render();
    return { goto: goto, next: next, prev: prev };
  }

  // ─── camera fly ─────────────────────────────────────────────────────
  function flyToComponent(viewer, c) {
    try {
      var pos = c.pos;
      var bbox = (viewer.scene.pointclouds[0] || {}).boundingBox;
      var span = 10;
      if (bbox) {
        var sx = bbox.max.x - bbox.min.x;
        var sy = bbox.max.y - bbox.min.y;
        var sz = bbox.max.z - bbox.min.z;
        // CUSTOMIZE: 0.18 = tight orbit · 0.35 = wider hover · higher = further out
        span = Math.max(sx, sy, sz) * 0.18;
      }
      var camPos = new THREE.Vector3(pos.x + span * 0.7, pos.y - span, pos.z + span * 0.6);
      var target = new THREE.Vector3(pos.x, pos.y, pos.z);
      viewer.scene.view.setView(camPos, target, 1200);
    } catch (err) { warn('flyToComponent failed', err); }
  }

  // ─── apply component to chrome ──────────────────────────────────────
  // CUSTOMIZE: change which fields the asset card shows by editing this fn
  // and the matching <div class="asset-grid"> in hud.html.
  function applyComponentContext(c, idx, total, markers, nodesIndex, viewer) {
    var $tag   = $('#asset-station-tag');
    var $title = $('#asset-title');
    var $id    = $('#asset-id');
    var $com   = $('#asset-commissioned');
    var $run   = $('#asset-runhrs');
    var $mfr   = $('#asset-mfr');
    var $loc   = $('#asset-location');

    if ($tag)   $tag.textContent   = 'NODE ' + (idx + 1) + ' / ' + total;
    if ($title) $title.textContent = c.name;
    if ($id)    $id.textContent    = 'NV-' + c.id;
    if ($com)   $com.textContent   = (c.metrics && c.metrics.commissioned) || '—';
    if ($run)   $run.textContent   = fmt((c.metrics && c.metrics.run_hours) || 0) + ' h';
    if ($mfr)   $mfr.textContent   = c.manufacturer || '—';
    if ($loc)   $loc.textContent   = c.location || '—';

    // Equipment imagery — deterministic picsum placeholder per component id.
    // CUSTOMIZE: replace with '/assets/hud/panoramas/' + c.id + '.jpg' once you
    // have real scanner panoramas captured per equipment node.
    var $img   = $('#imagery-img');
    var $cap   = $('#imagery-caption');
    var $stamp = $('#imagery-stamp');
    if ($img)   $img.src         = 'https://picsum.photos/seed/' + encodeURIComponent(c.id) + '/640/360?grayscale&blur=1';
    if ($cap)   $cap.textContent = c.name + ' · ' + (c.location || '');
    if ($stamp) $stamp.textContent = 'CAPTURED ' + ((c.metrics && c.metrics.commissioned) || '—');

    // Gauges follow this component's nominal values
    if (c.metrics) {
      gaugeState.tempBase  = c.metrics.temp_nominal;
      gaugeState.pressBase = c.metrics.pressure_nominal;
    }

    markers.forEach(function (entry, i) { entry.el.classList.toggle('is-active', i === idx); });
    if (nodesIndex) nodesIndex.setActive(idx);
    flyToComponent(viewer, c);
  }

  // ─── tooltip ────────────────────────────────────────────────────────
  function showTooltip(c, srcEl) {
    var tip = $('#station-tooltip'); if (!tip) return;
    tip.hidden = false;
    tip.innerHTML =
      '<span class="name">' + c.name + '</span>' +
      '<span class="pts">' + (c.type || '') + ' · ' + (c.location || '') + '</span>';
    var rect = srcEl.getBoundingClientRect();
    tip.style.left = (rect.right + 6) + 'px';
    tip.style.top  = (rect.top + rect.height / 2) + 'px';
  }
  function hideTooltip() { var tip = $('#station-tooltip'); if (tip) tip.hidden = true; }

  // ─── header pill — N COMPONENTS · X.XM PTS ──────────────────────────
  function updateHeaderPill(components, totalPoints) {
    var pill = $('#header-pill'); if (!pill) return;
    var pts = totalPoints
      ? (' · ' + (totalPoints / 1e6).toFixed(2) + 'M PTS')
      : '';
    pill.innerHTML = '<span class="dot"></span>' + components.length + ' COMPONENTS' + pts;
  }

  // ─── boot ───────────────────────────────────────────────────────────
  ready(function () {
    startClock();

    (function animateGauges() {
      tickGauges(performance.now());
      requestAnimationFrame(animateGauges);
    })();

    var mount = document.getElementById('potree_render_area');
    if (!mount) { warn('mount point #potree_render_area not found'); return; }
    if (typeof window.Potree === 'undefined') {
      warn('window.Potree is undefined — vendor libs not loaded');
      mount.innerHTML =
        '<div style="position:absolute;inset:0;display:flex;align-items:center;' +
        'justify-content:center;color:#003d80;font:14px/1.5 ui-monospace,monospace;' +
        'text-align:center;padding:24px;"><div><strong>Potree viewer not loaded.</strong><br>' +
        'Vendor libs expected at <code>/assets/vendor/potree/</code>.</div></div>';
      return;
    }

    var viewer;
    try { viewer = new window.Potree.Viewer(mount); }
    catch (err) { warn('Potree.Viewer construction failed', err); return; }

    try {
      viewer.setEDLEnabled(false);
      viewer.setFOV(60);
      viewer.setPointBudget(500000);
      viewer.setBackground('white');
    } catch (err) { warn('viewer config raised (continuing)', err); }

    info('mounted Potree.Viewer; loading /octree/metadata.json');

    window.Potree.loadPointCloud('/octree/metadata.json', 'hud-demo-scan', function (e) {
      if (!e || !e.pointcloud) { warn('loadPointCloud returned no pointcloud'); return; }
      var pointcloud, totalPts = 0;
      try {
        pointcloud = e.pointcloud;
        var material = pointcloud.material;
        material.size = 1;
        material.pointSizeType = window.Potree.PointSizeType.ADAPTIVE;
        material.shape = window.Potree.PointShape.SQUARE;
        viewer.scene.addPointCloud(pointcloud);
        viewer.fitToScreen();
        totalPts = (pointcloud.pcoGeometry && pointcloud.pcoGeometry.numPoints) || 0;
        info('point cloud loaded · ' + fmt(totalPts) + ' pts');
      } catch (err) { warn('post-load wiring failed', err); return; }

      loadComponents().then(function (components) {
        components = resolveComponentPositions(components, viewer);
        updateHeaderPill(components, totalPts);

        var overlay = $('#station-overlay');
        var markers = [];
        var tour = null;
        var nodesIndex = null;

        components.forEach(function (c) {
          var el = createMarker(
            c,
            function onClick(comp) { if (tour) tour.goto(comp.index); },
            function onHover(comp, srcEl) { showTooltip(comp, srcEl); },
            hideTooltip
          );
          overlay.appendChild(el);
          markers.push({ el: el, component: c });
        });

        function updateMarkers() {
          markers.forEach(function (entry) {
            var p = entry.component.pos;
            var s = projectWorldToScreen(viewer, p.x, p.y, p.z);
            if (!s) { entry.el.style.display = 'none'; return; }
            entry.el.style.display = s.visible ? 'flex' : 'none';
            entry.el.style.left = s.x + 'px';
            entry.el.style.top  = s.y + 'px';
          });
        }

        try {
          if (viewer.addEventListener) viewer.addEventListener('update', updateMarkers);
          else (function loop() { updateMarkers(); requestAnimationFrame(loop); })();
        } catch (err) {
          (function loop() { updateMarkers(); requestAnimationFrame(loop); })();
        }

        nodesIndex = renderNodesIndex(components, function (i) { if (tour) tour.goto(i); });

        tour = createTour(viewer, components, function (c, i) {
          applyComponentContext(c, i, components.length, markers, nodesIndex, viewer);
        });

        window.__hudTour = tour;
        window.__hudComponents = components;
      }).catch(function (err) { warn('component overlay setup failed', err); });
    });

    window.__hudViewer = viewer;
  });
})();
