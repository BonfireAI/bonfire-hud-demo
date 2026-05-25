/*
 * hud.js — Potree viewer wiring for the HUD shell.
 *
 * Responsibilities:
 *   - Mount Potree.Viewer into <div id="potree_render_area"> (declared in hud.html)
 *   - Load the converted v2 octree from /octree/metadata.json
 *   - Basic camera orbit + zoom (Potree defaults are fine)
 *   - Nothing else — engagement-specific overlays go in the re-skin pass
 *
 * Loading order assumed (matches Potree 1.8.2 viewer.html template, sourced from vendor/):
 *   /assets/vendor/potree/libs/jquery/jquery-3.1.1.min.js
 *   /assets/vendor/potree/libs/spectrum/spectrum.js
 *   /assets/vendor/potree/libs/jquery-ui/jquery-ui.min.js
 *   /assets/vendor/potree/libs/other/BinaryHeap.js
 *   /assets/vendor/potree/libs/tween/tween.min.js
 *   /assets/vendor/potree/libs/d3/d3.js
 *   /assets/vendor/potree/libs/proj4/proj4.js
 *   /assets/vendor/potree/libs/openlayers3/ol.js
 *   /assets/vendor/potree/libs/i18next/i18next.js
 *   /assets/vendor/potree/libs/jstree/jstree.js
 *   /assets/vendor/potree/build/potree/potree.js
 *   /assets/vendor/potree/libs/plasio/js/laslaz.js
 *   /assets/hud/hud.js  ← this file
 *
 * The script does NOT inject those tags itself — hud.html does.
 * If Potree is not on `window` when this loads, we log and bail so the HUD chrome
 * still renders without crashing.
 */

(function () {
  'use strict';

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function warn(msg, extra) {
    // eslint-disable-next-line no-console
    console.warn('[hud.js] ' + msg, extra || '');
  }

  function info(msg, extra) {
    // eslint-disable-next-line no-console
    console.log('[hud.js] ' + msg, extra || '');
  }

  ready(function () {
    var mountId = 'potree_render_area';
    var mount = document.getElementById(mountId);
    if (!mount) {
      warn('mount point #' + mountId + ' not found — HUD shell renders without viewer (hud.html missing the render-area div?)');
      return;
    }
    if (typeof window.Potree === 'undefined') {
      warn('window.Potree is undefined — vendor libs were not loaded. Check that hud.html includes the vendor scripts in order.');
      mount.innerHTML =
        '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#003d80;font:14px/1.5 ui-monospace,monospace;text-align:center;padding:24px;">' +
        '<div><strong>Potree viewer not loaded.</strong><br>' +
        'Vendor libs are expected at <code>/assets/vendor/potree/</code>.<br>' +
        'Confirm hud.html sources them before hud.js.</div></div>';
      return;
    }

    var viewer;
    try {
      viewer = new window.Potree.Viewer(mount);
    } catch (err) {
      warn('Potree.Viewer construction failed', err);
      return;
    }

    // Conservative defaults — no sidebar, no skybox, no fancy shading
    try {
      viewer.setEDLEnabled(false);
      viewer.setFOV(60);
      viewer.setPointBudget(500_000);
      viewer.setBackground('white');
      // Don't loadGUI() — we have our own HUD chrome and don't want the sidebar
    } catch (err) {
      warn('viewer config raised (continuing)', err);
    }

    info('mounted Potree.Viewer; loading /octree/metadata.json');

    window.Potree.loadPointCloud('/octree/metadata.json', 'hud-demo-scan', function (e) {
      if (!e || !e.pointcloud) {
        warn('loadPointCloud returned no pointcloud', e);
        return;
      }
      try {
        var scene = viewer.scene;
        var pointcloud = e.pointcloud;
        var material = pointcloud.material;
        material.size = 1;
        material.pointSizeType = window.Potree.PointSizeType.ADAPTIVE;
        material.shape = window.Potree.PointShape.SQUARE;
        scene.addPointCloud(pointcloud);
        viewer.fitToScreen();
        info('point cloud added to scene · camera fit');
      } catch (err) {
        warn('post-load wiring failed', err);
      }
    });

    // Tiny status hook for the smoke test + manual QA
    window.__hudViewer = viewer;
  });
})();
