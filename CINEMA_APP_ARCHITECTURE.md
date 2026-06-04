# Family Cinema App — Architecture & Build Plan

A home cinema experience app for the family. Inspired by the Stremio + Torrentio + Debrid setup, but with a curated weekly playlist, theatrical sequencing, and branded cinema experience.

---

## Concept

Each week the admin curates a cinema night:
- A lobby loop plays while the family settles in
- A "coming up tonight" poster overlay teases the feature film
- The show starts with a branded opening ident
- Trailers play (auto-fetched or manually added YouTube videos)
- A short film
- A "And Now Our Feature Presentation" bumper
- The main feature film, with subtitles

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| App shell | Electron | No CORS, filesystem access, single codebase |
| Frontend | React + Vite | Component model, fast dev cycle |
| Styling | Tailwind CSS | Utility-first, scalable to 10-foot TV UI |
| Player | Shaka Player | HLS/DASH, native subtitle track injection |
| TV packaging | Capacitor | Wraps React app into Android APK for sideloading |
| D-pad navigation | norigin-spatial-navigation | Declarative focus management for TV remote |
| Local storage | electron-store (Phase 1–4) | JSON file on disk, no database needed early on |
| Cloud sync | Supabase (Phase 5) | Postgres + realtime + auth (magic link / QR) |

---

## Stream Resolution Pipeline

```
Search / Select title
  → Torrentio API          (torrent results by IMDB ID)
  → Real-Debrid / AllDebrid (resolve torrent to HTTP stream URL)
  → Shaka Player           (plays HLS/DASH stream)
```

Both Real-Debrid and AllDebrid are supported with a toggle in Settings. Resolution happens in the Electron main process (Node.js), away from the renderer, avoiding CORS entirely.

---

## Electron Main Process — IPC Endpoints

```
/resolve       Torrentio → active Debrid service → returns stream URL
/subtitles     OpenSubtitles API → SRT → converted to VTT inline
/yt-dlp        yt-dlp wrapper → direct stream URL (trailers + manual YouTube)
/metadata      TMDB API → posters, descriptions, IMDB IDs, trailer keys
/storage       electron-store → playlists, watchlist, history, settings, API keys
```

### yt-dlp unified resolver
One function handles both TMDB-sourced trailer keys and manually added YouTube URLs:

```js
async function resolveYouTube(ytIdOrUrl) {
  const url = ytIdOrUrl.startsWith('http')
    ? ytIdOrUrl
    : `https://youtube.com/watch?v=${ytIdOrUrl}`

  return ytDlp.exec(url, {
    format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]',
    getUrl: true  // returns stream URL, no download
  })
}
```

yt-dlp is bundled as a platform binary inside the app (Windows/macOS/Linux for Electron, ARM64 Linux for Android TV APK). Auto-updates via `yt-dlp --update`.

---

## Storage Abstraction Layer

**Design from Phase 1.** All read/write goes through a storage interface, not directly to electron-store or Supabase. This allows the backend to be swapped in Phase 5 without touching consumer code.

```js
// storage.js — same interface throughout all phases
await store.get('watchlist')
await store.set('watchlist', [...])
await store.subscribe('watchlist', onChange)

// Phase 1–4: electron-store underneath
// Phase 5: Supabase + local cache underneath
```

---

## Data Models

### Weekly Playlist
```json
{
  "weekOf": "2026-06-07",
  "lobbyVideo": "local://assets/lobby-loop.mp4",
  "openingIdent": "local://assets/ident.mp4",
  "trailers": [
    { "type": "youtube", "ytId": "dQw4w9WgXcQ", "title": "..." },
    { "type": "youtube", "ytId": "abc123", "title": "..." }
  ],
  "short": {
    "type": "torrent", "imdbId": "tt1234567", "title": "...", "tmdbId": "..."
  },
  "featureBumper": "local://assets/feature-presentation.mp4",
  "feature": {
    "type": "torrent", "imdbId": "tt7654321", "title": "...", "tmdbId": "..."
  },
  "completedAt": "ISO date or null",
  "history": { ... }   // written on completion, see Playlist History below
}
```

### Watchlist Item
```json
{
  "id": "uuid",
  "type": "feature | short | youtube",
  "imdbId": "tt...",
  "tmdbId": "...",
  "ytId": "...",
  "title": "...",
  "poster": "https://...",
  "addedAt": "ISO date",
  "streamVerified": true
}
```

### Playlist History Record
Written automatically on playlist completion. Exists from Phase 1.
```json
{
  "weekOf": "2026-06-07",
  "completedAt": "ISO date",
  "feature": { "title": "...", "imdbId": "tt...", "tmdbId": "..." },
  "short": { "title": "...", "imdbId": "tt..." },
  "trailers": [ ... ],
  "debridService": "real-debrid | alldebrid"
}
```

---

## Playback Sequencer — State Machine

```
LOBBY
  └─ Lobby loop video plays, loops
  └─ Feature film poster + title overlaid on top (ambient teaser)
  └─ User/remote presses Start
      ↓
COMING_UP
  └─ Full-screen poster reveal with sound sting (~10–20s)
  └─ Auto-advances
      ↓
IDENT
  └─ Branded cinema opening (~30s)
  └─ Auto-advances
      ↓
TRAILERS
  └─ Plays trailers 1..N sequentially
  └─ Auto-advances
      ↓
SHORT
  └─ Short film
  └─ Auto-advances
      ↓
BUMPER
  └─ "And Now Our Feature Presentation" clip
  └─ Auto-advances
      ↓
FEATURE
  └─ Full film
  └─ Full playback controls active
  └─ Subtitles on by default
  └─ On completion → write history record
      ↓
CREDITS (optional)
  └─ End card or loop back to LOBBY
```

Each state resolves its source type (`local`, `youtube`, `torrent`) via the appropriate IPC call. The Shaka player instance is shared throughout — only the stream URL and subtitle tracks change between states.

---

## Pre-buffering (Phase 3)

### Goal
Eliminate the spinner between states. Cloud sources (YouTube via yt-dlp, torrents via Torrentio → Debrid) have non-trivial resolution latency. Local sources (lobby loop, ident, bumper) are free to play and provide natural windows to resolve and buffer the next cloud source in the background.

### Generic rule
> **Whenever the sequencer enters a local state, scan forward in the remaining queue for the next cloud state and begin resolving it immediately. If that cloud state is only one step away, also start Shaka preloading once the URL is ready.**

No hardcoded state names — the logic operates on source types.

```
onStateEnter(state, remainingQueue):
  if state.sourceType === 'local':
    nextCloud = remainingQueue.find(s => s.sourceType !== 'local')
    if nextCloud:
      prebuffer.resolve(nextCloud)           // fire IPC (yt-dlp or Torrentio→Debrid)
      if remainingQueue[0] === nextCloud:    // immediately next
        prebuffer.resolve(nextCloud).then(url => shaka.preload(url))
```

`prebuffer` is a simple promise cache keyed by state ID — if resolution is already in flight or complete, subsequent lookups return the same promise rather than firing a second IPC call.

### How this plays out in a typical cinema night

| Playing (local) | Next cloud state | Action |
|---|---|---|
| LOBBY | Trailer 1 (youtube) | yt-dlp resolve starts in background |
| COMING_UP | Trailer 1 (youtube) | same promise, no-op if already in flight |
| IDENT | Trailer 1 (youtube) | URL likely ready → Shaka preload starts |
| Trailer N (youtube) | Trailer N+1 (youtube) | resolve N+1 URL while N plays |
| BUMPER | FEATURE (torrent) | URL resolved during SHORT → Shaka preload starts immediately |

The BUMPER is the highest-value window: it's a ~30s local clip immediately before the feature film. If FEATURE resolution started during SHORT, Shaka begins pulling segments the moment BUMPER starts — the feature is ready with no visible load time.

### Shaka preload API
Shaka 4+ supports `player.preload(url)` which fetches the manifest and initial segments without starting playback. At state transition, `player.load()` resumes from the preloaded state and is near-instant.

### Subtitle pre-fetch
Subtitle resolution (OpenSubtitles IPC call) for the next torrent source is fired alongside stream URL resolution — both are cheap network calls and can be in flight simultaneously.

---

## Subtitles

- **Primary source:** OpenSubtitles API (queried by IMDB ID + preferred language)
- **Format:** SRT fetched, converted to WebVTT inline (~10 lines, no library needed)
- **Fallback:** Manual SRT/VTT file drop in the admin UI
- **Default language:** Configurable in Settings

---

## Admin UI (Inside the Electron App)

Accessible via PIN or gesture. Three screens:

### Weekly Planner
- Drag items from watchlist into slots: lobby video, ident, trailers (ordered list), short, feature bumper, feature
- Each slot has a **Preview** button — resolves the stream and plays it in a small modal to verify it works before cinema night
- Save/publish the week's playlist

### Watchlist
- Search TMDB by title → add as feature or short
- Paste YouTube URL → add as trailer or manual YouTube video
- Items stay in watchlist until manually dragged into a weekly slot
- `streamVerified` flag set when admin previews successfully

### History
- List of all completed weekly playlists
- Shows feature title, short, trailers, date watched

### Settings
- Real-Debrid API token
- AllDebrid API token
- Active debrid service toggle
- OpenSubtitles API key
- TMDB API key
- Default subtitle language
- yt-dlp binary path (bundled by default)

---

## PC vs Android TV

Everything above is shared code. The only divergence:

| | PC (Electron) | Android TV (Capacitor APK) |
|---|---|---|
| Navigation | Mouse + keyboard | D-pad via norigin-spatial-navigation |
| UI scale | Standard | `TV_MODE` flag → 1.5–2x font/target sizes |
| yt-dlp binary | Windows / macOS / Linux x64 | ARM64 Linux, bundled in APK assets |
| Distribution | Electron auto-updater | ADB sideload (no store required) |
| Build command | `electron-builder` | `npx cap build android` |

A `PLATFORM` env flag (`electron` / `capacitor`) switches navigation mode and UI scaling at startup. D-pad navigation should be wired from Phase 1 — easier to build in than retrofit.

---

## Phase 5 — Supabase Multi-Device Sync

### Supabase schema
```
watchlist       id, type, imdbId, tmdbId, ytId, title, poster, addedAt, streamVerified
playlists       weekOf, completedAt, payload (jsonb), createdBy
users           id, role (admin | viewer)
```

### Sync behaviour
- Local device always caches everything — app works fully offline
- Supabase syncs on connection via realtime subscriptions
- Shared entities: watchlist, current week playlist, playlist history
- Local-only: API keys, settings, yt-dlp path

### QR Login
```
Admin device generates QR
  → encodes a short-lived Supabase magic link token as a QR image
Second device (or Android TV) scans with phone camera
  → opens app → auto-authenticates → no password typing on TV remote
```
Standard pattern (same as YouTube TV, Netflix TV sign-in). Supabase magic links are natively supported.

### Roles
- **Admin:** full access — planner, watchlist, settings, history
- **Viewer (family):** read-only cinema UI — sees current week playlist, can browse history

---

## Build Phases

### Phase 1 — Core (working cinema night)
- Electron shell + React + Vite + Tailwind
- Storage abstraction layer (electron-store underneath)
- TMDB metadata + search
- Torrentio → Debrid stream resolution (both Real-Debrid and AllDebrid)
- Shaka Player with OpenSubtitles subtitle injection
- Playback sequencer state machine (all states)
- Playlist history record written on completion
- Hardcoded test playlist, end-to-end playback

### Phase 2 — Admin UI (self-service curation)
- Watchlist UI — TMDB search + YouTube URL paste
- Weekly planner — drag from watchlist into slots
- Stream preview/verify in admin modal
- Settings screen (API keys, debrid toggle, subtitle language)
- Playlist history view

### Phase 3 — Cinema Experience (the magic)
- Lobby loop video with feature poster + title overlay (ambient)
- `COMING_UP` state — full-screen poster reveal on Start, before ident
- Branded assets integration (lobby loop, ident, bumper — supplied as local files)
- Sequencer transitions and crossfades
- Full cinema-mode UI (full bleed, no chrome, dark)
- Pre-buffering: generic look-ahead resolver — on every local state, scan forward for next cloud state and begin IPC resolution + Shaka preload (see Pre-buffering section)
- Pre-buffering pipeline (see Pre-Buffering section below)

### Phase 4 — Android TV
- D-pad navigation wired throughout (norigin-spatial-navigation)
- `TV_MODE` UI scaling
- ARM64 yt-dlp binary bundled
- Capacitor build + APK sideload test
- QR login UI on TV (display QR, await auth)

### Phase 5 — Multi-Device Sync
- Supabase project setup (watchlist, playlists, users tables)
- Storage abstraction backend swapped to Supabase + local cache
- Realtime sync via Supabase subscriptions
- QR code login (magic link → QR image)
- Admin vs viewer role enforcement
- Offline-first behaviour (local cache always primary)

---

## Assets Required (supplied by you)
- `lobby-loop.mp4` — looping video for the foyer/waiting state
- `ident.mp4` — branded cinema opening (~30s)
- `feature-presentation.mp4` — "And Now Our Feature Presentation" bumper
- (Optional) Sound sting for the `COMING_UP` poster reveal

---

## External API Keys Required
- TMDB API key (free) — https://www.themoviedb.org/settings/api
- OpenSubtitles API key (free tier) — https://www.opensubtitles.com/en/consumers
- Real-Debrid API token — https://real-debrid.com/apitoken
- AllDebrid API key — https://alldebrid.com/apikeys
- Supabase project URL + anon key (Phase 5) — https://supabase.com
