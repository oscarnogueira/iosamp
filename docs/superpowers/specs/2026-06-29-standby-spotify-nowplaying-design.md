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
7. **StandBy passive freshness is hardware-gated.** Only always-on-display
   devices (iPhone 14 Pro / 15 Pro / 16 Pro class) keep StandBy rendering
   continuously, so pushed updates appear passively within ~10s. On non-AOD
   iPhones StandBy sleeps the screen after ~20s and re-renders only on
   tap/motion — the update is delivered but not seen until the user glances.
   The ~10s goal therefore applies to AOD devices; non-AOD is "fresh on glance."
8. **Interactive buttons in StandBy are unverified.** `Button(intent:)` works on
   the Lock Screen, but StandBy (dimmed/Night Mode) may treat the first touch as
   "wake display" rather than activating the control. This is the spec's
   riskiest assumption and MUST be proven on a physical device in an early spike
   before the control feature is built out.

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

### OAuth flow decision (resolves PKCE vs client_secret)
We use **Authorization Code + PKCE as a public client** — **no `client_secret`
anywhere**. The device generates `code_verifier`/`code_challenge`, opens the
Spotify authorize URL, receives the `code` via redirect, then sends
`{ code, code_verifier }` to the backend, which performs the token exchange
(PKCE, no secret) and stores the resulting `refresh_token`. Rationale: the
backend is the token vault, but PKCE removes the need to ship or hold a
confidential secret for this flow.
- **Redirect URI:** custom scheme registered to the app (e.g.
  `standbynp://spotify-callback`); the app captures the code and forwards it.

### Two classes of secret
- **App-level keys** (APNs `.p8`, master encryption key, Spotify `client_id`):
  live **only** in Fly Secrets, never in the app binary or git. No Spotify
  `client_secret` exists (PKCE public client).
- **Per-user tokens** (each user's Spotify `refresh_token`): created at the
  backend during OAuth, stored **encrypted at-rest** in Postgres, keyed by
  `userId`. The device does not retain the long-lived refresh token.

### Initial setup (once per user)
```
App: Sign in with Apple → backend verifies identity token → issues SESSION JWT
App: "Connect Spotify" → generate code_verifier/code_challenge (PKCE)
  → open Spotify authorize URL (browser) → user logs in at Spotify
  scopes: user-read-playback-state, user-read-currently-playing,
          user-modify-playback-state
  → redirect (standbynp://) returns authorization code to app
  → app POSTs { code, code_verifier } to backend (with session JWT)
  → backend exchanges (PKCE) for refresh_token
  → backend encrypts (TokenVault) and stores provider_tokens[userId][spotify]
```

### App ↔ backend session model
Sign in with Apple's identity token is verified **once** at `/auth/apple`; the
backend then issues its own **session JWT** (short-lived access + longer-lived
refresh) used as the bearer for all subsequent endpoints. Endpoints are NOT
authenticated with the raw Apple token per request.

### Device registration (per StandBy session)
```
App registerForRemoteNotifications → yields standard APNs device token
  → app POSTs it to backend → stored in devices[deviceId].device_token
  (REQUIRED: the silent content-available wake push for art can ONLY target the
   standard device token, not the activity/push-to-start tokens.)
App starts Live Activity → ActivityKit yields activity push token
  → app POSTs token to backend → stored in devices[deviceId].activity_token
App OBSERVES activity.pushTokenUpdates stream → on rotation, re-POSTs new token
  (ActivityKit can rotate the per-activity token mid-session; pushing to a
   stale token silently fails).
Optional (iOS 17.2+): push-to-start token → backend can re-start Activity
  remotely so StandBy resumes without reopening the app.
```
APNs Live Activity update pushes use `apns-push-type: liveactivity` with
**priority 10** for prompt delivery (priority 5 reserved if batching to conserve
the frequent-updates budget; v1 uses on-change pushes so 10 is fine).

### Runtime loop (backend, per active user)
```
every ~10s (active users only):
  cur = spotify.getCurrentlyPlaying(userId)   // handles 204, 401, 429
  if changed(prev, cur):
      APNs push (apns-push-type: liveactivity) → activity push token
      payload (ContentState): { trackId, title, artist, album, artUrl,
                                durationMs, progressMs, isPlaying, startedAt,
                                dominantColor }
      on track change also send a silent content-available push to wake the app
      to cache art (see Album art).
      backend computes dominantColor from the fetched art (small image pipeline).
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
  isPlaying: boolean; startedAt: number
  dominantColor?: string  // hex, computed on the BACKEND from fetched art
}

type ControlAction = "next" | "prev" | "playpause"
```

**v1 scope:** only the **thin interface + Spotify server-poll impl** are built.
The `device-push` kind is reserved in the type but the `/nowplaying` ingestion
endpoint and on-device control routing are **deferred** until the Apple Music
provider is actually implemented (YAGNI — Apple Music is a non-goal for v1). The
interface shape keeps that future cheap without building dead machinery now.

Future (when Apple Music is added):
- **device-push** providers report state via `POST /nowplaying` from the app;
  same `NowPlaying` payload → same APNs push path → same Live Activity UI.
- Controls routed per provider: Spotify via backend Web API; Apple Music via
  `MPRemoteCommandCenter` / MusicKit on-device.

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
    apns.ts           # JWT (.p8) signing, liveactivity + silent content-available push, push-to-start
    artwork.ts        # fetch art, extract dominantColor (small image pipeline)
    poller.ts         # 10s loop over active users/server-poll providers
    db.ts             # Postgres access (users, provider_tokens, devices)
    routes.ts         # HTTP endpoints
    config.ts         # loads secrets from env (Fly Secrets)
    server.ts         # boot: HTTP server (API process)
    poller-main.ts    # boot: poller loop (SEPARATE process — see below)
```

### Process topology (single-poller guarantee)
The **API server** and the **poller** run as **separate Fly processes**
(`[processes]` in `fly.toml`), with the poller pinned to **exactly one
instance**. This prevents duplicated Spotify polling under rolling deploys or
horizontal scaling of the API — which would otherwise multiply per-app
rate-limit usage. If the poller process is ever scaled >1, a Postgres advisory
lock (leader election) gates the loop so only one instance polls.

### HTTP endpoints (app → backend, all authenticated via the backend session JWT)
| Route | Purpose |
|-------|---------|
| `POST /auth/apple`        | verify Apple identity token → issue session JWT |
| `POST /auth/refresh`      | exchange session refresh token → new access token |
| `POST /spotify/connect`   | submit `{ code, code_verifier }` → store enc. token |
| `POST /device/register`   | submit standard APNs device token (for wake push) |
| `POST /activity/register` | submit activity push token (+ push-to-start token); re-called on token rotation |
| `POST /activity/heartbeat`| app pings on lifecycle transitions only (coarse backstop, hours TTL) |
| `POST /activity/end`      | activity ended → poller pauses for this user |
| `POST /control`           | `{ action }` → routed to provider |
| `GET  /health`            | poller/status (debug) |
| `POST /nowplaying`        | **deferred** — device-push providers (Apple Music) |

### Token vault (Fly.io recommendation)
- **LibsodiumVault**: encrypts per-user tokens with `secretbox`; master
  `ENCRYPTION_KEY` (32 bytes) stored in **Fly Secrets**, never in DB/git.
  Postgres stores only ciphertext + nonce. DB leak ≠ token leak.
- `TokenVault` interface allows swapping to cloud KMS (envelope encryption)
  later without touching call sites.

### Persistence (Postgres — managed, e.g. Supabase/Neon)
```
users(id, apple_sub UNIQUE, created_at)
provider_tokens(user_id, provider, ciphertext, nonce, updated_at,
                needs_reauth BOOL)
devices(id, user_id, device_token, activity_token, push_to_start_token,
        last_heartbeat_at, last_push_ok_at, active BOOL, updated_at)
                                                          -- N devices per user
```
- `devices` is keyed by its own `id` (one row per device/install), so multiple
  devices and reinstalls coexist instead of overwriting.
- Three token columns, each for a distinct APNs path:
  - `device_token` (standard) → **silent `content-available` wake push** (art).
  - `activity_token` (per-activity) → **`liveactivity` update push** (text/state).
  - `push_to_start_token` → remote restart of an Activity (iOS 17.2+).

### Resilience
- Spotify `401` → refresh access token, retry.
- Spotify `429` → respect `Retry-After`, backoff.
- Spotify `204` → push "stopped" state / end activity.
- Spotify `5xx`/timeout → backoff, keep last state.
- APNs `410` → clear dead activity token, await re-registration.
- Refresh token revoked → mark `needsReauth`, stop pushing, surface "Reconnect".

### Active-user / liveness model (reconciled with Constraint #1)
A StandBy app is **suspended**, so it CANNOT emit a periodic heartbeat. Liveness
is therefore derived from signals that do not require the app to run:
- **Primary — APNs feedback:** when the poller pushes a Live Activity update and
  APNs returns **410** (token no longer valid), the Activity is gone (ended,
  expired, or app force-quit, which dismisses its Live Activities) → mark the
  device inactive and drop it from the poll set. This is the real
  force-quit/crash detector; no app heartbeat needed.
- **Secondary — Spotify state:** `204` (nothing playing) pauses polling for that
  user until activity resumes (cheap re-check at a slow cadence).
- **Coarse backstop — lifecycle heartbeat:** the app pings `/activity/heartbeat`
  only on **foreground/background lifecycle transitions** (not on a timer), with
  a TTL measured in **hours**. This only catches stale state between sessions;
  it is NOT the primary liveness signal and never gates the ~10s loop.
- **Zombie eviction:** because update pushes are on-change only, a force-quit
  *while paused* yields no change → no push → no 410, leaving a stale row in the
  poll set. Guard with a **max-age-without-successful-push** eviction
  (`last_push_ok_at`): if a device has been polled but received no successful
  push for N minutes, drop it. Degrades to bounded wasted polls, not breakage.

### Scaling / rate-limit strategy
- Poll **active users only**, gated by the liveness model above
  (`devices.active`, cleared on APNs 410).
- **Fixed 10s interval for v1** (adaptive interval deferred — YAGNI until a
  measured need).
- Respect Spotify per-app rate limit; central backoff on `429`.
- **Spotify production quota is a real external risk, not a checkbox.** Dev mode
  caps at 25 users; extended-quota approval for an independent app that
  continuously polls player state is hard to obtain under current Spotify
  developer policy, and some player endpoints have been deprecated. Treat App
  Store distribution beyond 25 users as gated on Spotify approval, and keep poll
  frequency no higher than necessary to stay within Developer Terms.

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

### Album art (local-image constraint + app suspension)
Two facts collide: the widget extension cannot fetch remote images (Constraint
#5), and the app is suspended during a StandBy session (Constraint #1) so it
cannot download art for tracks that change mid-session. Resolution:

- **`dominantColor` → computed on the BACKEND.** The backend fetches the art
  once per track, extracts the dominant color, and includes the **hex string**
  in the Live Activity push payload (tiny, fits APNs 4KB). This works regardless
  of app state and always gives a correct accent/background color immediately on
  track change. (This intentionally reverses the earlier on-device plan, which
  was unimplementable while suspended.)
- **Album art image → best-effort via a silent wake push.** On track change the
  backend sends, alongside the `liveactivity` update, a **silent
  `content-available` background push to the standard `device_token`** (this is
  the only token that accepts background pushes). iOS wakes the app briefly in
  the background; the app downloads the new art into the App Group container,
  then calls **`activity.update(...)`** to force the Live Activity to re-render
  with the now-cached image (a file appearing in the container does not by
  itself trigger a re-render). iOS throttles background pushes, so this is
  **best-effort** — for a typical ~3-min track it comfortably fits the budget,
  but rapid skipping may miss some.
- **Guaranteed fallback:** whenever the art file is not yet cached, the Live
  Activity renders the **backend `dominantColor` background** + text + badge.
  Art never blocks rendering; it fills in when the wake push lands.
- The art for the track playing **when StandBy starts** is downloaded while the
  app is still foreground, so session start always has art.

### Transport controls
- Three interactive buttons via **App Intents** (iOS 17+). Tappability in
  StandBy is **unverified** (see Constraint #8 / Spike #1) — confirmed on Lock
  Screen; must be proven in StandBy before this path is relied upon.
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
- `apns.ts`: JWT signing, correct payload, 410 handling → marks device inactive.
- `artwork.ts`: fetch + dominantColor extraction (known image → expected hex);
  fetch failure → omit color gracefully.
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
- Secrets only in **Fly Secrets**; rotation plan for `ENCRYPTION_KEY`
  (re-encrypt pass, see Open Items) and `APNS_KEY`.

## Early Spikes (validate before full build)

1. **Interactive `Button(intent:)` in StandBy on a physical device** — confirm a
   tap activates the control vs. only waking the display. If it only wakes, the
   control feature degrades to "tap to wake, then tap to act" or moves to the
   Dynamic Island / Lock Screen only. Highest-risk assumption; prove first.
2. **APNs Live Activity update round-trip** — push → visible update latency on
   an AOD device; confirm frequent-updates budget holds with on-change pushes.
3. **Silent `content-available` wake reliability** — how often iOS actually
   wakes the suspended app to download art mid-session, and whether it keeps up
   with normal track changes. Determines whether per-track art is "reliable" or
   "best-effort with color fallback" (see Album art).

## Open Items / Future

- Push-to-start (iOS 17.2+) for hands-free StandBy resume.
- Apple Music device-push provider (`/nowplaying` + on-device control routing).
- Album art pre-fetch for upcoming queue tracks.
- Migrate `TokenVault` to cloud KMS at scale.
- **`ENCRYPTION_KEY` rotation procedure:** rotating the master key invalidates
  all stored ciphertext, so rotation must re-encrypt — support a second
  (`ENCRYPTION_KEY_PREV`) key for decrypt-old / encrypt-new, run a one-time
  re-encrypt pass, then retire the old key. Document before first key rotation.
