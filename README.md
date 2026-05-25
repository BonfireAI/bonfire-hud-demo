# bonfire-hud-demo

A single Node script that ingests a point cloud, builds a Potree octree, and plays a brand-shell theater while the build happens. Then it hands you a HUD shaped like the work.

## What it does

Drop a point cloud in `./input/`. Run one command. The script opens a browser to the **theater** — Cotton Candy Parlor chrome, our house brand showing the factory at work — and streams every step of the build in real time. When the conversion finishes, the surface fades and you land in the **HUD shell**, ready to be re-skinned for whatever engagement you're walking into.

The theater is the factory. The HUD is the candy. We build software that builds software, and this is the smallest possible demonstration of that loop: one script, one scan, one re-skinnable surface at the end.

## Install

```
git clone https://github.com/BonfireAI/bonfire-hud-demo.git
cd bonfire-hud-demo
npm install
```

Node 20+. First run pulls the Potree converter (~10 MB) and the Potree viewer (~95 MB) into `~/.cache/candyfactory/` — every subsequent run is cache-hot. Set aside ~110 MB of disk for the cache.

## Run

```
node hud-demo.mjs
```

You'll see:

1. A terminal log of cache prep, converter download, and conversion.
2. A browser tab on `http://localhost:3000/theater.html` — Chunk the mascot working at the line, a live terminal mirror, a candy-coloured progress bar.
3. When the convert finishes, the theater fades white and lands you on `/hud.html` — your HUD shell, with the point cloud rendered inside via Potree.

If port 3000 is busy, the script walks up to 3019 looking for a free one. NVIDIA GPUs are detected and logged (PotreeConverter 2.x is CPU-only upstream; CPU is the operative path today).

Flags:

- `--no-open` — don't auto-open the browser. Useful for CI or remote SSH.
- `--exit-after-done` — exit cleanly once the conversion is finished and the theater floor has held. Useful for smoke tests.

## Inhale your own scan

Drop a file in `./input/` and run the script. Supported formats:

- `.e57` — ASTM E57 (Leica, Faro, Matterport exports)
- `.las` — ASPRS LAS
- `.laz` — LASzip (compressed LAS), including `.copc.laz`
- `.ply` — Stanford PLY

Multi-file inputs pick the first alphabetical and warn in the theater log. Empty input folder falls back to the bundled Lion Takanawa sample (2.6 MB, public domain, ships inside the Potree viewer zip we already pull) so the demo always runs.

Each input gets its own octree cache keyed by SHA-256 prefix at `~/.cache/candyfactory/hud-demo-output/<sha>/`. Switching inputs doesn't trash the previous build.

> Caveat from the field: every E57 we tried from public test corpora (Stanford bunny, libE57Format ColouredCubes) crashes PotreeConverter 2.1.1's indexer on a null-bbox metadata edge. LAS / LAZ / COPC convert cleanly. Drop your scan in either of those formats and you're good.

## What's in the box

```
hud-demo.mjs          # CLI orchestrator — the whole pipeline
package.json
LICENSE               # Apache-2.0
assets/
  theater/            # Cotton Candy Parlor — the factory-at-work surface
    theater.html
    theater.css
    theater.js        # SSE consumer; reconnect-on-disconnect; standalone-preview safe
    chunk.svg         # the mascot, 4 moods × 4 palettes
  hud/                # the HUD shell — re-skinnable per engagement
    hud.html          # YOUR|HUD wordmark slot, Potree mount point
    hud.css           # white + electric-blue tokens; retune in :root
    hud.js            # mounts Potree.Viewer at /octree/metadata.json
  fonts/              # Google-Fonts @import slot; self-host instructions inside
  vendor/             # Potree viewer libs (auto-downloaded; gitignored)
input/                # CWD-relative; auto-created with a README on first run
```

The theater is locked CandyFactory house brand — it's the factory showing its work. The HUD is the candy: it ships as a clean generic shell so you can re-skin it for whichever engagement you're shipping.

## Re-purpose it

This repo is the first instance of a re-purposable template. Fork it, retune the HUD tokens in `assets/hud/hud.css`, swap the wordmark in `assets/hud/hud.html`, drop your engagement's overlays into the `.main` section — and you've got a branded demo that runs locally, off a single scan, with no cloud dependency.

The factory stays the same. The candy changes per client. That's the whole point.

## License

Apache-2.0. Fork it, modify it, re-skin it, ship it. The watermark stays on shipped engagements — it's the maker's mark.

---

Built by CandyFactory · powered by Bonfire · the line.
