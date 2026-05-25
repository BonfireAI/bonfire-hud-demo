# fonts/

This directory is intentionally empty. Fonts are loaded from Google Fonts via
`@import url(...)` inside `assets/theater/theater.css` and `assets/hud/hud.css`:

- **Fredoka** (400/500/600/700) — Cotton Candy Parlor display, used on theater
- **Inter** (400/500/600/700) — body text, both surfaces
- **IBM Plex Mono** (400/500/600) — terminal, spec stamps, eyebrows
- **Big Shoulders Display** (100/400/700/900) — HUD wordmark and headings

If you need to self-host (offline / no-CDN engagements), drop the WOFF2
files here and swap the `@import` for local `@font-face` blocks. The token
names stay the same.
