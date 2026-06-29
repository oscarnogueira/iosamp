# StandBy Now-Playing — Design Spec

**Date:** 2026-06-29
**Status:** Approved for planning
**Author:** brainstorming session

## Summary

An iOS app + backend that displays the user's currently-playing music in iOS
**StandBy mode** (iPhone charging + landscape + idle), using a **Live Activity**
that updates in near-real-time (track changes reflected within ~10s). Includes
simple transport controls (previous / play-pause / next) and a provider badge
showing the music source. Designed multi-user for App Store distribution, with
a music-source abstraction so additional providers (Apple Music, etc.) can be
added later.

## Goals

- Show now-playing (title, artist, album, art, progress) in **native StandBy**.
- Near-real-time: track changes appear within ~10s.
- Transport controls in the Live Activity: previous, play/pause, next.
- Provider badge (Spotify icon, later Apple Music, etc.).
- Multi-user, App Store–ready: per-user accounts, secure token storage.
- Extensible to other music services via a provider interface.

## Non-Goals

- True sub-second sync (10s poll interval accepted).
- Continuous progress-bar pushes (rendered locally on device instead).
- Apple Music server-side polling (impossible — handled device-side later).
- Social / playlist / library features. Now-playing display only.

## Key Constraints (why the architecture is shaped this way)

1. **StandBy backgrounds the app.** StandBy = locked + idle, so the app is
   suspended. It cannot run a polling loop. Only an **APNs push** can update a
   Live Activity in near-real-time → a backend is required to send pushes.
2. **Spotify has no push.** A server must poll Spotify Web API
   `/me/player/currently-playing` and push on change.
3. **Apple Music has no server-side now-playing.** Playback state lives only on
   the device (MusicKit / `MPNowPlayingInfoCenter`). Apple Music therefore
   needs a **device-push** path (app reports state to backend), not poller.
4. **Spotify rate limit is per-app** (one `client_id` across all users). Poll
   interval and active-user gating must respect this.
5. **Live Activity album art must be local** — widget extensions cannot fetch
   remote images at render time.
6. **Live Activity lifetime ~8h** (extendable). Re-start via push-to-start
   (iOS 17.2+) or reopening the app.

## Architecture

```
┌─────────────┐   poll /currently-playing (~10s)    ┌──────────┐
│   Spotify   │ ◄─────────────────────────────────  │ Backend  │
│   Web API   │                                      │ Node/TS  │
└─────────────┘                                      │ (Fly.io) │
                                                      └────┬─────┘
                                  APNs liveactivity push   │ (on change)
                                                           ▼
                                              ┌──────────────────────┐
                                              │  iPhone               │
                                              │  App (SwiftUI)        │  Sign in w/ Apple,
                                              │   - OAuth PKCE login  │  OAuth, start Activity,
                                              │   - App Intents       │  register push tokens
                                              │  Live Activity        │  renders in StandBy
                                              │   (ActivityKit)       │
                                              └──────────────────────┘
```

Three components:

1. **iOS app (SwiftUI)** — Sign in with Apple, Spotify OAuth (PKCE), starts the
   Live Activity, registers push tokens with the backend, hosts App Intents for
   transport controls, pre-downloads album art to the App Group container.
2. **Backend (Node/TS on Fly.io)** — holds app-level secrets, stores per-user
   encrypted refresh tokens, polls Spotify for active users, sends APNs Live
   Activity pushes on change, relays control actions to Spotify.
3. **Live Activity (ActivityKit + WidgetKit)** — renders now-playing in StandBy;
   updated via push; progress bar animates locally; interactive control buttons.

## Data Flow & Tokens

### Identity (Sign in with Apple)
Sign in with Apple yields a stable `apple_sub` → maps to an internal `userId`.
All per-user data (tokens, devices) is keyed by `userId`.

### Two classes of secret
- **App-level keys** (Spotify `client_secret`, APNs `.p8`, master encryption
  key): live **only** in Fly Secrets, never in the app binary or git. PKCE is
  used precisely so the device never needs `client_secret`.
- **Per-user tokens** (each user's Spotify `refresh_token`): created at the
  backend during OAuth, stored **encrypted at-rest** in Postgres, keyed by
  `userId`. The device does not retain the long-lived refresh token.

### Initial setup (once per user)
```
App: Sign in with Apple → userId
App: "Connect Spotify" → OAuth PKCE (browser) → user logs in at Spotify
  scopes: user-read-playback-state, user-read-currently-playing,
          user-modify-playback-state
  → authorization code → backend
  → backend exchanges for refresh_token
  → backend encrypts (TokenVault) and stores provider_tokens[userId][spotify]
```

### Device registration (per StandBy session)
```
App starts Live Activity → ActivityKit yields activity push token
  → app POSTs token to backend → stored in devices[userId]
Optional (iOS 17.2+): push-to-start token → backend can re-start Activity
  remotely so StandBy resumes without reopening the app.
```

### Runtime loop (backend, per active user)
```
every ~10s (active users only):
  cur = spotify.getCurrentlyPlaying(userId)   // handles 204, 401, 429
  if changed(prev, cur):
      APNs push (apns-push-type: liveactivity) → activity push token
      payload (ContentState): { trackId, title, artist, album, artUrl,
                                durationMs, progressMs, isPlaying, startedAt,
                                dominantColor }
  prev = cur

changed() = trackId differs | isPlaying differs | |progress - expected| > ~3s
```

### Anti-budget trick
APNs cannot carry per-second progress. Backend sends `startedAt + durationMs +
isPlaying` only on change; the Live Activity renders the progress bar locally
with `ProgressView(timerInterval:)` / `Text(timerInterval:)`. Pushes happen only
on track change, play/pause, or seek.

## Multi-Provider Abstraction

```ts
type ProviderKind = "server-poll" | "device-push"

interface MusicProvider {
  id: string                                  // "spotify" | "applemusic" | ...
  kind: ProviderKind
  getNowPlaying?(userId: string): Promise<NowPlaying | null>  // server-poll only
  control?(userId: string, action: ControlAction): Promise<void>
}

type NowPlaying = {
  trackId: string; title: string; artist: string; album: string
  artUrl?: string; durationMs: number; progressMs: number
  isPlaying: boolean; startedAt: number; dominantColor?: string
}

type ControlAction = "next" | "prev" | "playpause"
```

- The poller iterates **server-poll** providers only (Spotify today).
- **device-push** providers (Apple Music) report state via
  `POST /nowplaying` from the app; same `NowPlaying` payload → same APNs push
  path → same Live Activity UI.
- Controls are routed per provider: Spotify via backend Web API calls; Apple
  Music via `MPRemoteCommandCenter` / MusicKit on-device.

## Backend (Node/TS on Fly.io)

### Modules
```
backend/
  src/
    auth/
      apple.ts        # verify Sign in with Apple identity token → userId
    providers/
      provider.ts     # MusicProvider interface, registry
      spotify.ts      # OAuth exchange/refresh, getNowPlaying, control
    vault/
      vault.ts        # TokenVault interface
      libsodium.ts    # LibsodiumVault (key from ENCRYPTION_KEY env)
    apns.ts           # JWT (.p8) signing, liveactivity push, push-to-start
    poller.ts         # 10s loop over active users/server-poll providers
    db.ts             # Postgres access (users, provider_tokens, devices)
    routes.ts         # HTTP endpoints
    config.ts         # loads secrets from env (Fly Secrets)
    index.ts          # boot: HTTP server + poller
```

### HTTP endpoints (app → backend, all authenticated via Apple identity)
| Route | Purpose |
|-------|---------|
| `POST /auth/apple`        | exchange Apple identity token → session, userId |
| `POST /spotify/connect`   | submit OAuth code → store encrypted refresh token |
| `POST /activity/register` | submit activity push token (+ push-to-start token) |
| `POST /activity/end`      | activity ended → poller pauses for this user |
| `POST /nowplaying`        | device-push providers report state (Apple Music) |
| `POST /control`           | `{ action }` → routed to provider |
| `GET  /health`            | poller/status (debug) |

### Token vault (Fly.io recommendation)
- **LibsodiumVault**: encrypts per-user tokens with `secretbox`; master
  `ENCRYPTION_KEY` (32 bytes) stored in **Fly Secrets**, never in DB/git.
  Postgres stores only ciphertext + nonce. DB leak ≠ token leak.
- `TokenVault` interface allows swapping to cloud KMS (envelope encryption)
  later without touching call sites.

### Persistence (Postgres — managed, e.g. Supabase/Neon)
```
users(id, apple_sub UNIQUE, created_at)
provider_tokens(user_id, provider, ciphertext, nonce, updated_at)
devices(user_id, push_token, activity_token, push_to_start_token, updated_at)
```

### Resilience
- Spotify `401` → refresh access token, retry.
- Spotify `429` → respect `Retry-After`, backoff.
- Spotify `204` → push "stopped" state / end activity.
- Spotify `5xx`/timeout → backoff, keep last state.
- APNs `410` → clear dead activity token, await re-registration.
- Refresh token revoked → mark `needsReauth`, stop pushing, surface "Reconnect".

### Scaling / rate-limit strategy
- Poll **active users only** (Activity alive or recently active).
- Adaptive interval; pause idle users.
- Respect Spotify per-app rate limit; central backoff on `429`.
- Spotify production quota extension required for >25 users (dev-mode limit).

## Live Activity / Widget (StandBy)

### Layers
```
ActivityAttributes: NowPlayingAttributes
  static:  { provider }                 // fixed for the activity's life
  ContentState: NowPlaying              // updated via push
Views:
  - Lock Screen / StandBy view          // primary
  - Dynamic Island (compact/expanded)   // bonus, reuses view
```

### Layout (StandBy, landscape)
```
┌──────────────────────────────────────┐
│ [art]   Track Title              ◉    │  ◉ = provider badge (top-right)
│ [art]   Artist — Album                │
│ [art]   ▣▁▁▁▁▁▁  1:23 / 3:45          │  local progress (timerInterval)
│         ⏮     ⏯     ⏭                 │  App Intent buttons
└──────────────────────────────────────┘
```

### Provider badge
- `provider` lives in `ActivityAttributes` (static) → icon fixed for the
  activity, chosen at start.
- Icons stored **locally** in the widget extension asset catalog
  (`provider.id → image`); no download. Simple monochrome glyphs, brand tint.
- Brand-logo usage rules apply for public release; fine for personal/sideload.

### Album art (local-image constraint)
- Push includes `artUrl` + `dominantColor`.
- App pre-downloads art to the **App Group container** while active; the Live
  Activity reads it via `UIImage(contentsOfFile:)`.
- Fallback when art not cached: `dominantColor` background / placeholder — never
  blocks the rest of the UI.

### Transport controls
- Three interactive buttons via **App Intents** (iOS 17+); tappable in StandBy.
- Flow: tap → AppIntent (app process, background) → `POST /control {action}` →
  backend → Spotify Web API (`pause`/`play`/`next`/`previous`) → poller (≤10s)
  pushes new state. App Intent may also trigger an immediate backend push.
- **Optimistic UI**: play/pause toggles icon immediately; reverts on failure.
- Routed per provider (`ControlAction`): Spotify via backend; Apple Music via
  `MPRemoteCommandCenter` on-device.

### Lifetime
- `Info.plist`: `NSSupportsLiveActivitiesFrequentUpdates = YES`.
- On ~8h expiry: push-to-start re-starts the activity (iOS 17.2+) or user
  reopens the app.

## Error Handling (end-to-end)

| Layer | Error | Handling | User sees |
|-------|-------|----------|-----------|
| Spotify auth | refresh revoked | mark needsReauth, stop push | "Reconnect Spotify" |
| Spotify API | 401 | refresh token, retry | nothing |
| Spotify API | 429 | respect Retry-After, backoff | last state held |
| Spotify API | 204 | push "stopped" | "Nothing playing" |
| Spotify API | 5xx/timeout | backoff, keep last state | nothing |
| APNs | 410 | clear token, await re-register | activity frozen until reopen |
| APNs | budget exceeded | log + throttle | updates delayed |
| Activity | 8h expiry | push-to-start or reopen | reappears |
| Control | intent network fail | revert optimistic UI | icon reverts |
| Art | download fail | dominantColor/placeholder | no art, rest works |
| Auth | Apple token invalid | reject, re-auth | sign-in prompt |
| Vault | decrypt fail | mark needsReauth | "Reconnect Spotify" |

## Testing Strategy

### Backend (Vitest + nock/msw)
- `spotify.ts`: 401 refresh, 429 backoff, 204 parse, normal track parse,
  control calls.
- `poller.ts`: `changed()` cases (same track, track change, play↔pause,
  seek > 3s, normal progress does not fire); active-user gating.
- `apns.ts`: JWT signing, correct payload, 410 handling.
- `vault/libsodium.ts`: seal/open round-trip, wrong-key failure.
- `auth/apple.ts`: identity-token verification (valid/invalid/expired).
- `routes.ts`: auth required, valid/invalid payloads.
- provider registry: poller iterates server-poll only, ignores device-push.

### iOS (XCTest + SwiftUI Previews)
- OAuth PKCE: one manual real run.
- App Intents: unit on `ControlAction` routing; real tap on device.
- Live Activity render: previews for track / stopped / no-art / long-name
  truncation / each provider badge.
- **StandBy on physical iPhone**: charging + landscape + locked. Manual
  checklist — track change reflects ≤10s, buttons work, badge correct, progress
  animates, art appears, expiry/restart works.

### End-to-end smoke
- Play in Spotify → appears in Activity ≤10s.
- next/prev/playpause from Activity → changes in Spotify.
- Restart poller → reconciles state.

## Compliance / Ops Notes

- **Privacy policy** required (App Store + storing user tokens).
- **Data deletion**: account + token deletion path (LGPD/GDPR).
- **Spotify production approval** + quota extension for >25 users.
- **Apple Music** (future): MusicKit entitlement + Apple Developer agreement.
- Secrets only in **Fly Secrets**; rotation plan for `ENCRYPTION_KEY` /
  `APNS_KEY`.

## Open Items / Future

- Push-to-start (iOS 17.2+) for hands-free StandBy resume.
- Apple Music device-push provider implementation.
- Album art pre-fetch for upcoming queue tracks.
- Migrate `TokenVault` to cloud KMS at scale.
