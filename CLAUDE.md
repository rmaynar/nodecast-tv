# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies
- `npm run dev` — run the server with `node --watch` (auto-restart on file changes), listening on `PORT` (default 3000)
- `npm start` — run the server without watch mode
- `docker-compose up -d` — build and run via Docker (mounts `./data` for the SQLite DB)

There is no test runner, linter, or build step configured. The frontend is served as static vanilla JS/CSS straight out of `public/` — no bundler.

## Architecture

NodeCast TV is a self-hosted IPTV web player. Single Node.js/Express process serves both the JSON API under `/api/*` and the static SPA in `public/`. SQLite (via `better-sqlite3`, WAL mode) at `data/content.db` holds all playlist content; `data/db.json` holds small config (sources, settings, users).

### Server entry — `server/index.js`

Boot order matters:
1. Loads `server/db` (initializes SQLite schema).
2. Configures Express, sessions, Passport (local + JWT + OIDC strategies).
3. Resolves `ffmpeg` and `ffprobe` paths (prefers system binaries, falls back to npm `ffmpeg-static` / `@ffprobe-installer/ffprobe`) and stashes them on `app.locals`. Transcoding is gracefully disabled if neither is found.
4. Dynamically requires every file in `server/services/` into a frozen `services` object.
5. Mounts route modules from `server/routes/` under `/api/*`.
6. SPA fallback: any non-API GET serves `public/index.html`.
7. After `app.listen`, asynchronously: loads plugins → kicks off `syncService.syncAll()` (after a 5s delay) → starts the periodic sync timer → runs `hwDetect.detect()`.

### Layers

- **`server/routes/`** — Express routers, one per resource (`auth`, `sources`, `channels`, `proxy`, `transcode`, `remux`, `probe`, `subtitle`, `settings`, `history`, `favorites`). Mounted in `server/index.js`. `proxy.js` and `transcode.js` are the heavy ones (stream piping, FFmpeg orchestration, range requests).
- **`server/services/`** — stateful logic shared across routes. Notably:
  - `syncService.js` — orchestrates pulling Xtream/M3U sources into SQLite + EPG XMLTV ingest. Runs on boot and on a timer.
  - `transcodeSession.js` — manages live FFmpeg child processes per session (HLS output, cleanup, codec decisions).
  - `m3uParser.js`, `epgParser.js`, `xtreamApi.js`, `m3uXtreamAdapter.js` — source ingest pipeline. The adapter normalizes M3U-derived data into the same shape Xtream produces so downstream code is source-agnostic.
  - `hwDetect.js` — probes for NVENC / QSV / VAAPI / AMF and caches the result for the transcoder to consume.
  - `cache.js` — in-memory caches.
- **`server/db/sqlite.js`** — `better-sqlite3` connection, WAL pragmas, and `CREATE TABLE IF NOT EXISTS` schema for `categories`, `playlist_items`, EPG, etc. IDs are composite (`sourceId:itemId`) so multiple sources coexist in one row set.
- **`server/db/index.js`** — legacy JSON-file wrapper (`data/db.json`) for sources/settings/users. New code uses SQLite; this file is retained for those small mutable structures.
- **`server/auth.js`** — Passport strategy wiring (local password, JWT bearer, OIDC). OIDC users default to the `viewer` role.

### Plugins — `server/plugins/`

Auto-loaded at startup, alphabetically. Each `.js` file may export either a `(app, services) => void | Promise<void>` function or `{ init, shutdown }` object. The `services` argument is `Object.freeze`d, so plugins can read services but not swap them. `shutdown` hooks run on `SIGTERM`. See `server/plugins/PLUGINS.md` for the full contract.

### Frontend — `public/`

Vanilla ES modules. No framework, no build. `public/js/app.js` is the SPA controller; `public/js/api.js` is the fetch wrapper that talks to `/api/*`. UI is split into `public/js/components/` (reusable widgets like channel list, EPG grid) and `public/js/pages/` (route-level controllers for Live TV, Movies, Series, etc.). Auth flow lives in `login.html` + `public/js/auth.js`.

### Streaming pipeline

A typical playback request flows: client → `/api/proxy` or `/api/transcode` → `transcodeSession` decides remux vs transcode based on `ffprobe` output and user settings → spawns FFmpeg with hardware encoder (selected via `hwDetect`) → pipes HLS or MP4 back to the browser. The `Force Backend Proxy`, `Auto Transcode`, `Force Audio/Video Transcode`, and `Force Remux` settings all feed into this decision tree (see README "Stream Processing" table).

### Reverse-proxy assumptions

`app.set('trust proxy', true)` is on. URL/scheme generation relies on `X-Forwarded-Proto` and `X-Forwarded-For` being set correctly upstream — relevant when debugging mixed-content or HTTPS issues.
