# StandBy Now-Playing — Plan 2: iOS App

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the iOS app that signs the user in with Apple, connects Spotify via OAuth PKCE, starts and registers a Live Activity that renders now-playing in StandBy, caches album art on silent wake pushes, and exposes transport controls via App Intents.

**Architecture:** A SwiftUI app target + a Widget Extension target sharing an App Group and an `ActivityAttributes` model. The app owns auth, the OAuth/PKCE flow, token registration, the background-wake art fetch, and starting the Live Activity. The widget renders the Live Activity (Lock Screen / StandBy + Dynamic Island) and hosts `Button(intent:)` controls. A thin `BackendClient` talks to Plan 1's API with a session JWT in the Keychain.

**Tech Stack:** Swift 5.9+, SwiftUI, ActivityKit, WidgetKit, App Intents, AuthenticationServices (Sign in with Apple + ASWebAuthenticationSession), CryptoKit (PKCE), iOS 17.0+ (17.2+ for push-to-start).

**Spec:** `docs/superpowers/specs/2026-06-29-standby-spotify-nowplaying-design.md`

**Depends on:** Plan 1 backend deployed (`/auth/apple`, `/spotify/connect`, `/device/register`, `/activity/register`, `/activity/heartbeat`, `/activity/end`, `/control`). Plan 0 spike verdicts gate which features ship (StandBy controls, per-track art).

**Backend base URL:** configured via `BACKEND_URL` in build settings (e.g. `https://standby-nowplaying.fly.dev`).

---

## File Structure

```
StandByNP/
  StandByNP/                         # app target
    StandByNPApp.swift               # @main, AppDelegate adaptor
    AppDelegate.swift                # remote-notif registration + silent wake handler
    Models/
      NowPlayingAttributes.swift     # ActivityAttributes + ContentState (shared: app + widget)
    AppState.swift                   # central app-side coordinator (Task 6.5)
    Auth/
      AppleSignIn.swift              # Sign in with Apple → session token
      SpotifyOAuth.swift             # PKCE flow via ASWebAuthenticationSession
      PKCE.swift                     # code_verifier/challenge (CryptoKit)
    Net/
      BackendClient.swift            # typed API client (session JWT)  [membership: app + widget]
      Keychain.swift                 # session token storage (shared access group)  [membership: app + widget]
    Activity/
      ActivityController.swift       # start/observe-token/end + register with backend  [app only]
      ArtCache.swift                 # App Group art download + path resolution  [membership: app + widget]
    UI/
      RootView.swift                 # sign-in + connect-spotify + start-standby
  StandByNPWidget/                   # widget extension target
    NowPlayingLiveActivity.swift     # Lock Screen / StandBy view + Dynamic Island
    ProviderBadge.swift              # provider icon mapping (asset catalog)
    ControlIntents.swift             # Next/PlayPause/Prev AppIntents (shared)
  StandByNPTests/                    # XCTest (logic-only)
```

---

## Task 1: Project + shared attributes model

**Files:**
- Create: Xcode project `StandByNP` + Widget Extension `StandByNPWidget`
- Create: `StandByNP/Models/NowPlayingAttributes.swift`  (holds both `NowPlayingAttributes` and its `ContentState` — no separate model file)

- [ ] **Step 1: Create the project + widget target**

Xcode → iOS App `StandByNP`, SwiftUI, min iOS 17.0. Add Widget Extension target `StandByNPWidget` with "Include Live Activity".

Capabilities:
- **Both** targets: App Groups (`group.com.you.standby`), Keychain Sharing (shared access group, so the session token written by the app is readable from the control-intent path).
- **App** target: Sign in with Apple, Push Notifications, Background Modes → Remote notifications.

App Info.plist keys (REQUIRED — the "Include Live Activity" template adds neither reliably):
- `NSSupportsLiveActivities = YES` — without it `Activity.request` does not work at all.
- `NSSupportsLiveActivitiesFrequentUpdates = YES` — per spec, eases the update budget.
- URL Types → add scheme `standbynp` (for the Spotify OAuth redirect).
- `BACKEND_URL` (String, e.g. `$(BACKEND_URL)` from a build setting) — read by `AppState.init`.
- `SPOTIFY_CLIENT_ID` (String) — read by `AppState.init` for the OAuth authorize URL.

Shared config: store the backend base URL and the session token where BOTH the app and the widget-originated control intent can read them — use the App Group's shared `UserDefaults(suiteName: "group.com.you.standby")` for the base URL and a Keychain shared access group for the session token.

**Target membership (compile gate):** `Net/BackendClient.swift`, `Net/Keychain.swift`, and `Activity/ArtCache.swift` must be added to BOTH the app and widget targets — the widget's `Controls.send` uses `BackendClient`+`Keychain`, and the Live Activity view uses `ArtCache`. They are Foundation/Security/UIKit-only (no app-only deps), so this is safe. `ActivityController.swift` and `AppState.swift` are app-target ONLY.

Build settings → Info.plist (bridged via `$(VAR)`): add **`BACKEND_URL`** (e.g. `https://standby-nowplaying.fly.dev`) and **`SPOTIFY_CLIENT_ID`** to the app target's Info.plist — `AppState.init` reads both via `forInfoDictionaryKey`. Without them the app crashes on first launch.

- [ ] **Step 2: Define the shared attributes (Target Membership: app + widget)**

```swift
// Models/NowPlayingAttributes.swift
import ActivityKit

struct NowPlayingAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var trackId: String
        var title: String
        var artist: String
        var album: String
        var artUrl: String?
        var durationMs: Int
        var progressMs: Int
        var isPlaying: Bool
        var startedAt: Double    // epoch ms; used for local progress
        var dominantColor: String?   // hex from backend
    }
    var provider: String         // "spotify" — static for the activity's life
}
```

- [ ] **Step 3: Commit**

```bash
git add StandByNP* && git commit -m "feat(ios): project + shared activity attributes"
```

---

## Task 2: PKCE helper (unit-testable)

**Files:**
- Create: `StandByNP/Auth/PKCE.swift`
- Test: `StandByNPTests/PKCETests.swift`

- [ ] **Step 1: Failing test**

```swift
// StandByNPTests/PKCETests.swift
import XCTest
@testable import StandByNP
final class PKCETests: XCTestCase {
    func testChallengeIsBase64URLSha256OfVerifier() {
        let pair = PKCE.generate()
        XCTAssertGreaterThanOrEqual(pair.verifier.count, 43)
        XCTAssertFalse(pair.challenge.contains("="))   // base64url, no padding
        XCTAssertFalse(pair.challenge.contains("+"))
        XCTAssertEqual(pair.challenge, PKCE.challenge(for: pair.verifier))
    }
}
```

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement**

```swift
// Auth/PKCE.swift
import Foundation
import CryptoKit

enum PKCE {
    struct Pair { let verifier: String; let challenge: String }
    static func generate() -> Pair {
        var bytes = [UInt8](repeating: 0, count: 64)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let verifier = Data(bytes).base64URLEncoded()
        return Pair(verifier: verifier, challenge: challenge(for: verifier))
    }
    static func challenge(for verifier: String) -> String {
        let hash = SHA256.hash(data: Data(verifier.utf8))
        return Data(hash).base64URLEncoded()
    }
}
extension Data {
    func base64URLEncoded() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
```

- [ ] **Step 4: Run (PASS).** — [ ] **Step 5: Commit** `git commit -am "feat(ios): PKCE helper"`.

---

## Task 3: BackendClient + Keychain

**Files:**
- Create: `StandByNP/Net/Keychain.swift`, `StandByNP/Net/BackendClient.swift`
- Test: `StandByNPTests/BackendClientTests.swift` (URLProtocol stub)

- [ ] **Step 1: Failing test (stub URLProtocol, assert auth header + decoding)**

```swift
// StandByNPTests/BackendClientTests.swift
func testAuthApplePostsIdTokenAndDecodesSession() async throws {
    URLProtocolStub.stub(path: "/auth/apple", json: #"{"sessionToken":"s","refreshToken":"r"}"#)
    let client = BackendClient(baseURL: URL(string: "https://api.test")!, session: .stubbed)
    let out = try await client.authApple(idToken: "idtok")
    XCTAssertEqual(out.sessionToken, "s")
}
```

> Provide the test helper: `URLProtocolStub` (a `URLProtocol` subclass returning canned responses per path) and a `URLSession.stubbed` configured with `protocolClasses = [URLProtocolStub.self]`. Implement it in `StandByNPTests/Helpers/URLProtocolStub.swift`.

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Implement Keychain (shared access group) + BackendClient**

```swift
// Net/BackendClient.swift
import Foundation

struct SessionTokens: Codable { let sessionToken: String; let refreshToken: String }

final class BackendClient {
    let baseURL: URL; let session: URLSession
    var sessionToken: String? { Keychain.read("sessionToken") }
    init(baseURL: URL, session: URLSession = .shared) { self.baseURL = baseURL; self.session = session }

    func authApple(idToken: String) async throws -> SessionTokens {
        try await post("/auth/apple", body: ["idToken": idToken], authed: false)
    }
    func connectSpotify(code: String, codeVerifier: String) async throws {
        let _: EmptyOK = try await post("/spotify/connect",
            body: ["code": code, "codeVerifier": codeVerifier], authed: true)
    }
    func registerDevice(deviceToken: String) async throws -> DeviceOut {
        try await post("/device/register", body: ["deviceToken": deviceToken], authed: true)
    }
    func registerActivity(deviceId: String, activityToken: String, pushToStart: String?) async throws {
        // NOTE: never put a bare Optional into the JSON dict — Optional.none boxed as Any
        // crashes JSONSerialization. Use NSNull(), or omit the key.
        var body: [String: Any] = ["deviceId": deviceId, "activityToken": activityToken]
        body["pushToStartToken"] = pushToStart ?? NSNull()
        let _: EmptyOK = try await post("/activity/register", body: body, authed: true)
    }
    func heartbeat(deviceId: String) async throws { let _: EmptyOK = try await post("/activity/heartbeat", body: ["deviceId": deviceId], authed: true) }
    func endActivity(deviceId: String) async throws { let _: EmptyOK = try await post("/activity/end", body: ["deviceId": deviceId], authed: true) }
    func control(_ action: String) async throws { let _: EmptyOK = try await post("/control", body: ["action": action], authed: true) }
    func currentNowPlaying() async throws -> NowPlayingAttributes.ContentState? {
        try await get("/nowplaying/current", authed: true)   // returns null body → nil
    }

    private func get<T: Decodable>(_ path: String, authed: Bool) async throws -> T? {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        if authed, let tok = sessionToken { req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await session.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        // Backend returns 200 + literal `null` when nothing is playing — treat as nil,
        // else decoding "null" into a non-optional struct throws.
        if code == 204 || data.isEmpty || String(decoding: data, as: UTF8.self) == "null" { return nil }
        guard code == 200 else { throw BackendError.status }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any], authed: Bool) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if authed, let tok = sessionToken { req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await session.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw BackendError.status }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
struct EmptyOK: Decodable { let ok: Bool? }
struct DeviceOut: Decodable { let id: String }
enum BackendError: Error { case status }
```

- [ ] **Step 4: Run (PASS).** — [ ] **Step 5: Commit** `git commit -am "feat(ios): backend client + keychain"`.

---

## Task 4: Sign in with Apple

**Files:**
- Create: `StandByNP/Auth/AppleSignIn.swift`
- Modify: `StandByNP/UI/RootView.swift`

- [ ] **Step 1: Implement Apple sign-in → backend session**

```swift
// Auth/AppleSignIn.swift
import AuthenticationServices

@MainActor
final class AppleSignIn: NSObject, ObservableObject,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private let backend: BackendClient
    private let onSignedIn: () -> Void
    init(backend: BackendClient, onSignedIn: @escaping () -> Void) {
        self.backend = backend; self.onSignedIn = onSignedIn
    }
    func start() {
        let req = ASAuthorizationAppleIDProvider().createRequest()
        req.requestedScopes = [.fullName, .email]
        let c = ASAuthorizationController(authorizationRequests: [req])
        c.delegate = self
        c.presentationContextProvider = self
        c.performRequests()
    }
    func authorizationController(controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
              let idTokenData = cred.identityToken,
              let idToken = String(data: idTokenData, encoding: .utf8) else { return }
        Task {
            do {
                let tokens = try await backend.authApple(idToken: idToken)
                Keychain.write(tokens.sessionToken, for: "sessionToken")
                Keychain.write(tokens.refreshToken, for: "refreshToken")
                onSignedIn()        // flips AppState.signedIn so RootView advances
            } catch { print("APPLE_SIGNIN_BACKEND_FAILED: \(error)") }
        }
    }
    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        print("APPLE_SIGNIN_FAILED: \(error)")
    }
    func presentationAnchor(for _: ASAuthorizationController) -> ASPresentationAnchor { activeWindow() }
}
```

> `Keychain.write/read` must use a **shared access group** (Keychain Sharing capability) so the control intent's `BackendClient` can read `sessionToken`. Implement `Keychain.swift` with `kSecAttrAccessGroup` set to the shared group.

- [ ] **Step 2: Manual run — tap Sign in with Apple on device, confirm `sessionToken` lands in Keychain (log it).**
- [ ] **Step 3: Commit** `git commit -am "feat(ios): sign in with apple"`.

---

## Task 5: Spotify OAuth PKCE flow

**Files:**
- Create: `StandByNP/Auth/SpotifyOAuth.swift`

- [ ] **Step 1: Implement the PKCE authorize → code → backend exchange**

```swift
// Auth/SpotifyOAuth.swift
import AuthenticationServices

@MainActor
final class SpotifyOAuth: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let backend: BackendClient
    private let clientId: String
    private let redirectScheme = "standbynp"
    private let redirectURI = "standbynp://spotify-callback"
    init(backend: BackendClient, clientId: String) { self.backend = backend; self.clientId = clientId }

    func connect() async throws {
        let pkce = PKCE.generate()
        var comps = URLComponents(string: "https://accounts.spotify.com/authorize")!
        comps.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "response_type", value: "code"),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "code_challenge_method", value: "S256"),
            .init(name: "code_challenge", value: pkce.challenge),
            .init(name: "scope", value: "user-read-playback-state user-read-currently-playing user-modify-playback-state"),
        ]
        let callback = try await authenticate(url: comps.url!)
        let code = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "code" })?.value ?? ""
        try await backend.connectSpotify(code: code, codeVerifier: pkce.verifier)
    }

    private var authSession: ASWebAuthenticationSession?   // strong ref: else torn down mid-flow

    private func authenticate(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { cont in
            let s = ASWebAuthenticationSession(url: url, callbackURLScheme: redirectScheme) { cb, err in
                if let cb { cont.resume(returning: cb) } else { cont.resume(throwing: err ?? BackendError.status) }
            }
            s.presentationContextProvider = self
            s.prefersEphemeralWebBrowserSession = false
            self.authSession = s        // hold for the flow's duration
            s.start()
        }
    }
    func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor { activeWindow() }
}
```

Register the URL scheme `standbynp` in the app target's Info (URL Types).

Shared helper for both auth flows — return the active scene's key window, not a detached `ASPresentationAnchor()` (a detached window can fail to present the sheet):

```swift
@MainActor func activeWindow() -> ASPresentationAnchor {
    (UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        .flatMap { $0.windows }.first { $0.isKeyWindow }) ?? ASPresentationAnchor()
}
```

- [ ] **Step 2: Manual run — tap Connect Spotify, log in, confirm backend stores the token (`/health` or a debug endpoint shows a token row).**
- [ ] **Step 3: Commit** `git commit -am "feat(ios): spotify oauth pkce"`.

---

## Task 6: ActivityController (start, observe token, register, end)

**Files:**
- Create: `StandByNP/Activity/ActivityController.swift`

- [ ] **Step 1: Implement**

```swift
// Activity/ActivityController.swift
import ActivityKit

@MainActor
final class ActivityController: ObservableObject {
    private let backend: BackendClient
    private var activity: Activity<NowPlayingAttributes>?
    private var deviceId: String?
    init(backend: BackendClient) { self.backend = backend }

    private var latestActivityToken: String?   // last seen; flushed once deviceId is known

    func registerDeviceToken(_ token: String) async throws {
        let out = try await backend.registerDevice(deviceToken: token)
        deviceId = out.id
        if let t = latestActivityToken { try? await backend.registerActivity(deviceId: out.id, activityToken: t, pushToStart: nil) }
    }

    func start(initial: NowPlayingAttributes.ContentState, provider: String) throws {
        let attr = NowPlayingAttributes(provider: provider)
        activity = try Activity.request(attributes: attr,
            content: .init(state: initial, staleDate: nil), pushType: .token)
        observeTokens()
    }

    private func observeTokens() {
        guard let activity else { return }
        Task {
            for await tokenData in activity.pushTokenUpdates {
                let hex = tokenData.map { String(format: "%02x", $0) }.joined()
                latestActivityToken = hex
                if let deviceId { try? await backend.registerActivity(deviceId: deviceId, activityToken: hex, pushToStart: nil) }
                // if deviceId not yet known, registerDeviceToken() flushes latestActivityToken when it lands
            }
        }
        // push-to-start token (iOS 17.2+) — observe Activity.pushToStartTokenUpdates similarly.
    }

    func heartbeatIfActive() async throws {
        guard let deviceId, activity != nil else { return }
        try await backend.heartbeat(deviceId: deviceId)
    }

    func end() async {
        await activity?.end(nil, dismissalPolicy: .immediate)
        if let deviceId { try? await backend.endActivity(deviceId: deviceId) }
        activity = nil
    }
}
```

> **Token-ordering note:** `deviceId` is set asynchronously by the APNs device-token callback (Task 7), while the activity push token can arrive first. Guard against the lost-registration race: `observeTokens()` should retry `registerActivity` once `deviceId` becomes available (e.g., store the latest activity token and (re)send it when either the device token or activity token lands).

- [ ] **Step 2: Manual run — Start StandBy from the app; confirm `/activity/register` is hit (backend log shows activity token).**
- [ ] **Step 3: Commit** `git commit -am "feat(ios): activity controller"`.

---

## Task 6.5: AppState coordinator (central, referenced by Tasks 7/9/10)

**Files:**
- Create: `StandByNP/AppState.swift`

`AppState` is the single app-side coordinator that owns the collaborators and the UI flags. It is app-target only (NOT widget — see Task 9). It must exist before Task 7 wires the AppDelegate.

- [ ] **Step 1: Implement**

```swift
// AppState.swift  (app target only)
import SwiftUI
import ActivityKit

@MainActor
final class AppState: ObservableObject {
    static let shared = AppState()
    let backend: BackendClient
    let apple: AppleSignIn
    let spotify: SpotifyOAuth
    let activity: ActivityController

    @Published var signedIn = false
    @Published var spotifyConnected = false

    private init() {
        let base = URL(string: Bundle.main.object(forInfoDictionaryKey: "BACKEND_URL") as! String)!
        // publish base URL into the App Group so the widget control intent can read it
        UserDefaults(suiteName: "group.com.you.standby")?.set(base, forKey: "backendURL")
        backend = BackendClient(baseURL: base)
        apple = AppleSignIn(backend: backend) { [weak self] in self?.signedIn = true }
        spotify = SpotifyOAuth(backend: backend,
            clientId: Bundle.main.object(forInfoDictionaryKey: "SPOTIFY_CLIENT_ID") as! String)
        activity = ActivityController(backend: backend)
        signedIn = Keychain.read("sessionToken") != nil
    }

    func startStandby() async throws {
        // Seed from the backend's current now-playing so session start shows real data + art.
        let cur = try await backend.currentNowPlaying()       // GET /nowplaying/current (Plan 1)
        if let cur, let art = cur.artUrl { await ArtCache.download(trackId: cur.trackId, from: art) }
        try activity.start(initial: cur ?? .placeholder, provider: "spotify")
        spotifyConnected = true
    }

    func heartbeatIfActive() async throws { try await activity.heartbeatIfActive() }

    func refreshArtForCurrentActivity() async {
        guard let act = Activity<NowPlayingAttributes>.activities.first else { return }
        let s = act.content.state
        if let art = s.artUrl { await ArtCache.download(trackId: s.trackId, from: art) }
        // Re-render: push the SAME state so the widget re-reads the now-cached file.
        await act.update(.init(state: s, staleDate: nil))
    }
}

extension NowPlayingAttributes.ContentState {
    static var placeholder: Self {
        .init(trackId: "—", title: "Waiting…", artist: "", album: "",
              artUrl: nil, durationMs: 0, progressMs: 0, isPlaying: false,
              startedAt: 0, dominantColor: "#222222")
    }
}
```

> Resolves the "art at session start" guarantee: `startStandby()` seeds via the backend `GET /nowplaying/current` (added in Plan 1) and pre-downloads that track's art while the app is still foreground. Mid-session tracks rely on the silent-wake path (Task 7).

- [ ] **Step 2: Commit** `git commit -am "feat(ios): AppState coordinator + seed-from-backend"`.

---

## Task 7: Remote-notif registration + silent wake art fetch

**Files:**
- Create: `StandByNP/AppDelegate.swift`, `StandByNP/Activity/ArtCache.swift`
- Modify: `StandByNP/StandByNPApp.swift`

- [ ] **Step 1: ArtCache (download to App Group, resolve path)**

```swift
// Activity/ArtCache.swift
import UIKit

enum ArtCache {
    static let group = "group.com.you.standby"
    static func fileURL(for trackId: String) -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?
            .appendingPathComponent("art-\(trackId).jpg")
    }
    static func download(trackId: String, from urlString: String) async {
        guard let dest = fileURL(for: trackId), let url = URL(string: urlString) else { return }
        if FileManager.default.fileExists(atPath: dest.path) { return }
        if let (data, _) = try? await URLSession.shared.data(from: url) { try? data.write(to: dest) }
    }
}
```

- [ ] **Step 2: AppDelegate — register + handle silent wake**

```swift
// AppDelegate.swift
import UIKit
import ActivityKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ app: UIApplication,
        didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        app.registerForRemoteNotifications(); return true
    }
    func application(_ app: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken t: Data) {
        let hex = t.map { String(format: "%02x", $0) }.joined()
        Task { try? await AppState.shared.activity.registerDeviceToken(hex) }
    }
    // Silent wake: download art for the current track, then nudge the activity to re-render.
    func application(_ app: UIApplication, didReceiveRemoteNotification info: [AnyHashable: Any],
        fetchCompletionHandler done: @escaping (UIBackgroundFetchResult) -> Void) {
        Task {
            await AppState.shared.refreshArtForCurrentActivity()
            done(.newData)
        }
    }
}
```

> `refreshArtForCurrentActivity()` reads the live activity's current ContentState (`Activity.activities.first`), downloads `artUrl` via `ArtCache`, then calls `activity.update(...)` with the **same** ContentState to force a re-render now that the local file exists. (A file appearing in the container does NOT itself re-render the widget.)

- [ ] **Step 3: Wire `@UIApplicationDelegateAdaptor(AppDelegate.self)` in `StandByNPApp`.**
- [ ] **Step 4: Manual run — push a silent wake from backend/spike; confirm art file written + StandBy view updates art.**
- [ ] **Step 5: Commit** `git commit -am "feat(ios): silent wake art fetch"`.

---

## Task 8: Live Activity view (StandBy) + provider badge + local progress

**Files:**
- Create: `StandByNPWidget/NowPlayingLiveActivity.swift`, `StandByNPWidget/ProviderBadge.swift`

- [ ] **Step 1: Provider badge mapping (icons in widget asset catalog)**

```swift
// ProviderBadge.swift
import SwiftUI
struct ProviderBadge: View {
    let provider: String
    var body: some View {
        Image("badge-\(provider)")   // asset: badge-spotify, badge-applemusic, ...
            .resizable().frame(width: 18, height: 18)
            .accessibilityLabel(provider)
    }
}
```

- [ ] **Step 2: Implement the Live Activity view**

```swift
// NowPlayingLiveActivity.swift
import WidgetKit
import SwiftUI
import ActivityKit

struct NowPlayingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NowPlayingAttributes.self) { ctx in
            standby(ctx).activityBackgroundTint(color(ctx.state.dominantColor))
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { Text(ctx.state.title).lineLimit(1) }
            } compactLeading: { Image(systemName: "music.note") }
              compactTrailing: { Text(ctx.state.title).lineLimit(1) }
              minimal: { Image(systemName: "music.note") }
        }
    }

    @ViewBuilder private func standby(_ ctx: ActivityViewContext<NowPlayingAttributes>) -> some View {
        HStack(spacing: 12) {
            artwork(ctx.state.trackId)
            VStack(alignment: .leading, spacing: 4) {
                HStack { Text(ctx.state.title).font(.headline).lineLimit(1); Spacer(); ProviderBadge(provider: ctx.attributes.provider) }
                Text("\(ctx.state.artist) — \(ctx.state.album)").font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                ProgressView(timerInterval: range(ctx.state), countsDown: false)
                    .labelsHidden()
                ControlsRow()   // defined in Task 9; for Task 8's standalone build, stub it as
                                // `struct ControlsRow: View { var body: some View { EmptyView() } }`
                                // and replace with the real implementation in Task 9.
            }
        }.padding()
    }

    private func artwork(_ trackId: String) -> some View {
        Group {
            if let url = ArtCache.fileURL(for: trackId), let img = UIImage(contentsOfFile: url.path) {
                Image(uiImage: img).resizable()
            } else { Color.secondary.opacity(0.3) }
        }.frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func range(_ s: NowPlayingAttributes.ContentState) -> ClosedRange<Date> {
        let start = Date(timeIntervalSince1970: s.startedAt / 1000)
        return start...start.addingTimeInterval(Double(s.durationMs) / 1000)
    }
    private func color(_ hex: String?) -> Color { Color(hex: hex ?? "#222222") }
}
```

Add a `Color(hex:)` helper (widget target):

```swift
extension Color {
    init(hex: String) {
        let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        let v = UInt64(h, radix: 16) ?? 0x222222
        self.init(.sRGB, red: Double((v >> 16) & 0xff) / 255,
                  green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}
```

- [ ] **Step 3: Manual run on device — push a ContentState via backend; verify StandBy shows title/artist/badge/progress and art when cached, color background when not.**
- [ ] **Step 4: Commit** `git commit -am "feat(ios): live activity standby view"`.

---

## Task 9: Transport controls (App Intents) — gated by Spike C

**Files:**
- Create: `StandByNPWidget/ControlIntents.swift`
- Modify: `StandByNPWidget/NowPlayingLiveActivity.swift` (ControlsRow)

> **Gate:** implement per Plan 0 Spike C verdict — (a) full StandBy controls, (b) tap-to-wake-then-act (still ship the buttons), or (c) move controls to Lock Screen / Dynamic Island only. The intents below are identical regardless; only placement changes.

- [ ] **Step 1: Implement the control intents**

```swift
// ControlIntents.swift  (Target Membership: app + widget)
import AppIntents

// MUST be LiveActivityIntent (not plain AppIntent) so a Button(intent:) inside the
// Live Activity runs ON-DEVICE in the background (locked / StandBy) instead of
// foregrounding the app. This is exactly the path Spike C validates.
struct NextIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Next"
    func perform() async throws -> some IntentResult { try await Controls.send("next"); return .result() }
}
struct PrevIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Previous"
    func perform() async throws -> some IntentResult { try await Controls.send("prev"); return .result() }
}
struct PlayPauseIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Play/Pause"
    func perform() async throws -> some IntentResult { try await Controls.send("playpause"); return .result() }
}

// Controls must NOT reference AppState — this file compiles into the widget target,
// where the app-side AppState (Apple sign-in, OAuth, ActivityKit) does not exist.
// Build a minimal client from App-Group config + the shared-Keychain session token.
enum Controls {
    static func send(_ action: String) async throws {
        let base = UserDefaults(suiteName: "group.com.you.standby")?.url(forKey: "backendURL")
        guard let base else { return }
        try await BackendClient(baseURL: base).control(action)   // reads session token from shared Keychain
    }
}
```

- [ ] **Step 2: Add the ControlsRow to the view**

```swift
// in NowPlayingLiveActivity.swift
struct ControlsRow: View {
    var body: some View {
        HStack(spacing: 24) {
            Button(intent: PrevIntent()) { Image(systemName: "backward.fill") }
            Button(intent: PlayPauseIntent()) { Image(systemName: "playpause.fill") }
            Button(intent: NextIntent()) { Image(systemName: "forward.fill") }
        }.buttonStyle(.plain)
    }
}
```

- [ ] **Step 3: Manual run on device IN StandBy — tap each control; confirm Spotify responds and the StandBy view reflects the change within ~10s. Record behavior against Spike C verdict.**
- [ ] **Step 4: Commit** `git commit -am "feat(ios): transport controls via app intents"`.

---

## Task 10: Root UI + lifecycle heartbeat

**Files:**
- Modify: `StandByNP/UI/RootView.swift`, `StandByNP/StandByNPApp.swift`

- [ ] **Step 1: RootView wiring**

```swift
// UI/RootView.swift
import SwiftUI
struct RootView: View {
    @ObservedObject var state = AppState.shared
    var body: some View {
        VStack(spacing: 20) {
            if !state.signedIn { Button("Sign in with Apple") { state.apple.start() } }
            else if !state.spotifyConnected { Button("Connect Spotify") { Task { try? await state.spotify.connect() } } }
            else { Button("Start StandBy Display") { Task { try? await state.startStandby() } } }
        }.padding()
    }
}
```

- [ ] **Step 2: Lifecycle-only heartbeat (NOT a timer)**

```swift
// StandByNPApp.swift
@main
struct StandByNPApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.scenePhase) private var scenePhase   // REQUIRED for onChange below
    var body: some Scene {
        WindowGroup { RootView() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background || phase == .active {
                    Task { try? await AppState.shared.heartbeatIfActive() }
                }
            }
    }
}
```

> Per spec, the heartbeat fires only on lifecycle transitions (coarse backstop, hours TTL). It does NOT run on a timer and is not the primary liveness signal (APNs 410 is).

- [ ] **Step 3: Commit** `git commit -am "feat(ios): root ui + lifecycle heartbeat"`.

---

## Task 11: End-to-end validation on device

- [ ] **Step 1: Full smoke test**

On a physical iPhone (AOD device for the freshness claim): Sign in → Connect Spotify → Start StandBy → put phone on charger, landscape, locked. Play music in Spotify. Verify:
  - Track appears in StandBy within ~10s of a change.
  - Album art appears (cached via silent wake) or color fallback shows.
  - Progress bar animates locally.
  - Provider badge correct.
  - Controls work in StandBy (per Spike C verdict).

- [ ] **Step 2: Record results + reconcile with spikes**

Note any deviations vs. Plan 0 verdicts; file follow-ups for push-to-start (hands-free resume) and Apple Music provider as future work.

- [ ] **Step 3: Commit** `git commit -am "test(ios): e2e standby validation notes"`.

---

## Done When

- Logic-only XCTests (PKCE, BackendClient) pass.
- On a real AOD device: now-playing reflects within ~10s, art + color render, badge correct, and transport controls behave per the Spike C verdict.
- All seven backend endpoints are exercised by the app at least once in the e2e run.
