# StandBy Now-Playing — Plan 0: Validation Spikes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the four riskiest device-level assumptions in the spec before building the real backend or app, so the architecture is validated (or corrected) cheaply.

**Architecture:** A throwaway Xcode project (`SpikeApp`) plus a tiny Node script (`spike-pusher`) that signs an APNs JWT and sends pushes. No DB, no Spotify, no real auth. Everything here is disposable — it exists only to answer the open questions in the spec's "Early Spikes" section.

**Tech Stack:** Swift / SwiftUI / ActivityKit / WidgetKit / App Intents (iOS 17+), Node 20 + TypeScript, APNs HTTP/2 (`node-apn` or raw `http2` + `jsonwebtoken`).

**Spec:** `docs/superpowers/specs/2026-06-29-standby-spotify-nowplaying-design.md`

**Device requirement:** A physical iPhone iOS 17+ is mandatory. At least one spike result (passive ~10s freshness) is only valid on an always-on-display device (14 Pro / 15 Pro / 16 Pro class). Record which device model each spike ran on.

---

## What each spike answers

| Spike | Spec question | If it FAILS, the design changes to… |
|-------|---------------|--------------------------------------|
| A | Does a Live Activity render in StandBy and update via local `Activity.update`? | Re-evaluate StandBy as the surface; fall back to a foreground "kiosk" view. |
| B | APNs `liveactivity` push → visible update latency on AOD device; frequent-update budget OK? | Increase poll interval / batch pushes; revisit ~10s goal. |
| C | Does an interactive `Button(intent:)` activate in StandBy (vs only waking display)? | Move controls to Lock Screen / Dynamic Island only; drop StandBy controls. |
| D | Does a silent `content-available` push reliably wake the app to cache art mid-session? | Scope album art to session-start only + color background; drop per-track art. |

Each spike ends in a **recorded verdict** (PASS / PARTIAL / FAIL + notes) written into this file. Spikes do not use TDD — they are manual on-device experiments with explicit success criteria.

**Run order: A → C → B → D.** Task 1 (A) builds the rendering activity + widget that everything else needs. Then run **Spike C (Task 3) immediately**, before B/D — interactive buttons in StandBy is the spec's highest-risk assumption, so surface its "design changes to…" branch earliest. B and D follow. (Document task numbering is by build dependency; execution order is A, C, B, D.)

**Prerequisite capabilities (add in Task 1, before any push spike):**
- **Push Notifications** capability on the app target (`aps-environment` entitlement). Required for `Activity.request(pushType:.token)` to yield a usable token AND for APNs to accept any push — without it Spike B has no valid token.
- **Background Modes → Remote notifications** (needed by Spike D).
- App Info.plist: `NSSupportsLiveActivitiesFrequentUpdates = YES` (the "Include Live Activity" template adds `NSSupportsLiveActivities` but NOT this one). Without it, Spike B's burst is throttled under the default conservative budget and gives a misleading verdict on the exact question it exists to answer.
- Confirm Live Activities are enabled for SpikeApp in Settings (`ActivityAuthorizationInfo().areActivitiesEnabled == true`).

---

## File Structure

```
spike/
  SpikeApp/                      # disposable Xcode project
    SpikeApp/
      SpikeAppApp.swift          # @main, starts a Live Activity on launch
      ContentView.swift          # buttons: start/stop activity, log view
      Attributes.swift           # shared ActivityAttributes (app + widget)
      ControlIntent.swift        # AppIntent that logs when invoked (Spike C)
      AppDelegate.swift          # remote-notification registration (Spike D)
    SpikeWidget/                 # widget extension target
      SpikeLiveActivity.swift    # Lock Screen / StandBy view + buttons
  spike-pusher/                  # disposable Node push sender
    src/sendLiveActivity.ts      # signs JWT, sends liveactivity update
    src/sendSilent.ts            # sends content-available background push
    src/apnsClient.ts            # shared APNs HTTP/2 client
    .env.example                 # KEY_ID, TEAM_ID, BUNDLE_ID, P8 path
    package.json
  SPIKE-RESULTS.md               # verdicts recorded here
```

---

## Task 1: Throwaway Xcode project with a Live Activity (Spike A)

**Files:**
- Create: `spike/SpikeApp/SpikeApp/Attributes.swift`
- Create: `spike/SpikeApp/SpikeApp/SpikeAppApp.swift`
- Create: `spike/SpikeApp/SpikeApp/ContentView.swift`
- Create: `spike/SpikeApp/SpikeWidget/SpikeLiveActivity.swift`

- [ ] **Step 1: Create the Xcode project**

In Xcode: File → New → Project → iOS App, name `SpikeApp`, SwiftUI, min deploy iOS 17.0. Then File → New → Target → Widget Extension, name `SpikeWidget`, check "Include Live Activity". Set both targets' team to your paid dev account.

- [ ] **Step 2: Define shared attributes**

```swift
// Attributes.swift  (add to BOTH app + widget targets via Target Membership)
import ActivityKit

struct SpikeAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var title: String
        var subtitle: String
    }
    var label: String   // static
}
```

- [ ] **Step 3: Start the activity on launch and expose start/stop buttons**

```swift
// SpikeAppApp.swift
import SwiftUI
import ActivityKit

@main
struct SpikeAppApp: App {
    var body: some Scene { WindowGroup { ContentView() } }
}
```

```swift
// ContentView.swift
import SwiftUI
import ActivityKit

struct ContentView: View {
    @State private var activity: Activity<SpikeAttributes>?
    @State private var n = 0
    var body: some View {
        VStack(spacing: 16) {
            Button("Start Activity") { start() }
            Button("Local Update (+1)") { Task { await update() } }
            Button("Stop") { Task { await activity?.end(nil, dismissalPolicy: .immediate) } }
            if let id = activity?.id { Text("activityID: \(id)").font(.caption) }
        }.padding()
    }
    func start() {
        // Confirm Live Activities are enabled, else a nil activity reads as a false Spike-A FAIL.
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            print("LIVE_ACTIVITIES_DISABLED — enable for SpikeApp in Settings"); return
        }
        let attr = SpikeAttributes(label: "spike")
        let state = SpikeAttributes.ContentState(title: "Track 0", subtitle: "Artist")
        do {
            activity = try Activity.request(
                attributes: attr,
                content: .init(state: state, staleDate: nil),
                pushType: .token)   // .token so Spike B can push
            observeToken()          // start token observer on the non-nil activity
        } catch {
            print("ACTIVITY_REQUEST_FAILED: \(error)")   // don't swallow with try?
        }
    }

    // Spike B uses this; defined here so it captures the just-created activity.
    func observeToken() {
        guard let activity else { return }
        Task {
            for await tokenData in activity.pushTokenUpdates {
                print("ACTIVITY_PUSH_TOKEN=\(tokenData.map { String(format: "%02x", $0) }.joined())")
            }
        }
    }
    func update() async {
        n += 1
        let state = SpikeAttributes.ContentState(title: "Track \(n)", subtitle: "Local update")
        await activity?.update(.init(state: state, staleDate: nil))
    }
}
```

- [ ] **Step 4: Implement the Live Activity view**

```swift
// SpikeLiveActivity.swift
import WidgetKit
import SwiftUI
import ActivityKit

struct SpikeLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SpikeAttributes.self) { ctx in
            VStack(alignment: .leading) {
                Text(ctx.state.title).font(.headline)
                Text(ctx.state.subtitle).font(.subheadline)
            }.padding()
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { Text(ctx.state.title) }
            } compactLeading: { Text("♪") } compactTrailing: { Text(ctx.state.title) } minimal: { Text("♪") }
        }
    }
}
```

- [ ] **Step 5: Run on the physical device and validate StandBy**

Run `SpikeApp` on the iPhone. Tap **Start Activity**, lock the phone, put it on a charger in **landscape**. Confirm the Live Activity appears in StandBy. Tap **Local Update** from the app (unlock briefly) and confirm the StandBy view changes.

Success: Activity visible in StandBy AND local updates reflect.

- [ ] **Step 6: Record verdict**

Append to `spike/SPIKE-RESULTS.md`: device model, iOS version, PASS/PARTIAL/FAIL, notes (especially whether non-AOD screen sleeps and how it re-renders).

- [ ] **Step 7: Commit**

```bash
git add spike/
git commit -m "spike(A): live activity renders + updates in StandBy"
```

---

## Task 2: APNs push round-trip + latency (Spike B)

**Files:**
- Create: `spike/spike-pusher/package.json`
- Create: `spike/spike-pusher/src/apnsClient.ts`
- Create: `spike/spike-pusher/src/sendLiveActivity.ts`
- Create: `spike/spike-pusher/.env.example`
- Modify: `spike/SpikeApp/SpikeApp/ContentView.swift` (print the activity push token)

- [ ] **Step 1: Get the activity push token**

The `observeToken()` added to `start()` in Task 1 already prints `ACTIVITY_PUSH_TOKEN=...`. Run, tap Start Activity, copy the token from the Xcode console. (Requires the Push Notifications capability from the Task 1 prerequisites — without it no token is issued.)

- [ ] **Step 2: Create the APNs client (HTTP/2 + JWT)**

```ts
// spike/spike-pusher/src/apnsClient.ts
import http2 from "node:http2";
import fs from "node:fs";
import jwt from "jsonwebtoken";

const { KEY_ID, TEAM_ID, P8_PATH } = process.env;

export function makeJWT(): string {
  const key = fs.readFileSync(P8_PATH!, "utf8");
  return jwt.sign({ iss: TEAM_ID, iat: Math.floor(Date.now() / 1000) }, key, {
    algorithm: "ES256",
    header: { alg: "ES256", kid: KEY_ID! },
  });
}

// Cache the provider JWT across the run — APNs expects token reuse (new at most
// ~once/20min). A fresh JWT per request in a burst risks 403 TooManyProviderTokenUpdates,
// which would be misread as Live Activity budget throttling in Spike B.
let cachedJWT: string | null = null;
function providerJWT() { return (cachedJWT ??= makeJWT()); }

// topic must be passed explicitly: liveactivity → `${bundle}.push-type.liveactivity`,
// background/content-available → plain bundle id.
export function send(token: string, pushType: string, topic: string, payload: object, priority = "10") {
  // Use api.sandbox.push.apple.com for development builds.
  const client = http2.connect("https://api.sandbox.push.apple.com:443");
  const headers = {
    ":method": "POST",
    ":path": `/3/device/${token}`,
    authorization: `bearer ${providerJWT()}`,
    "apns-topic": topic,
    "apns-push-type": pushType,
    "apns-priority": priority,
  };
  const req = client.request(headers);
  req.setEncoding("utf8");
  let body = "";
  req.on("response", (h) => console.log("status", h[":status"]));
  req.on("data", (c) => (body += c));
  req.on("end", () => { console.log("body", body || "(empty=ok)"); client.close(); });
  req.write(JSON.stringify(payload));
  req.end();
}
```

> Note: the `apns-topic` for Live Activity pushes is `<bundleId>.push-type.liveactivity`. Verify this exact suffix during the spike.

- [ ] **Step 3: Send a liveactivity update**

```ts
// spike/spike-pusher/src/sendLiveActivity.ts
import "dotenv/config";                   // load .env (KEY_ID/TEAM_ID/P8_PATH/BUNDLE_ID)
import { send } from "./apnsClient.js";

const token = process.argv[2];           // activity push token
const count = Number(process.argv[3] ?? "1");   // burst count — loop IN ONE process so the
                                                // cached JWT is reused (avoids 403 TooManyProviderTokenUpdates)
const topic = `${process.env.BUNDLE_ID}.push-type.liveactivity`;
for (let n = 1; n <= count; n++) {
  await send(token, "liveactivity", topic, {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event: "update",
      "content-state": { title: `Pushed Track ${n}`, subtitle: "via APNs" },
    },
  }, "10");
}
```

- [ ] **Step 4: Run and measure latency on the AOD device**

```bash
cd spike/spike-pusher
npm i jsonwebtoken dotenv && npm i -D tsx @types/jsonwebtoken
cp .env.example .env   # fill KEY_ID, TEAM_ID, BUNDLE_ID, P8_PATH
npx tsx src/sendLiveActivity.ts <TOKEN> 1
```

With the phone in StandBy, time from running the command to the StandBy view changing. Then run a burst in ONE process (`npx tsx src/sendLiveActivity.ts <TOKEN> 10`) to probe the frequent-update budget — single process reuses the cached JWT, so a `403 TooManyProviderTokenUpdates` (provider-token throttle) is distinguishable from real budget throttling (200 + no render).

Success: updates land within a few seconds on the AOD device; budget does not throttle on-change-rate pushes.

- [ ] **Step 5: Record verdict + commit**

Record latency numbers and any throttling in `SPIKE-RESULTS.md`.

```bash
git add spike/ && git commit -m "spike(B): APNs liveactivity push round-trip + latency"
```

---

## Task 3: Interactive button in StandBy (Spike C — highest risk)

**Files:**
- Create: `spike/SpikeApp/SpikeApp/ControlIntent.swift`
- Modify: `spike/SpikeApp/SpikeWidget/SpikeLiveActivity.swift` (add a button)

- [ ] **Step 1: Create an App Intent that logs when invoked**

```swift
// ControlIntent.swift  (add to BOTH targets)
import AppIntents

struct LogTapIntent: AppIntent {
    static var title: LocalizedStringResource = "Log Tap"
    func perform() async throws -> some IntentResult {
        let stamp = ISO8601DateFormatter().string(from: Date())
        // Write to App Group so we can confirm it ran even from the widget process.
        UserDefaults(suiteName: "group.spike")?.set(stamp, forKey: "lastTap")
        print("INTENT_FIRED \(stamp)")
        return .result()
    }
}
```

Add an App Group `group.spike` to both targets' entitlements.

- [ ] **Step 2: Add the button to the Live Activity view**

```swift
// in SpikeLiveActivity.swift, inside the lock-screen VStack:
Button(intent: LogTapIntent()) { Text("TAP ME") }
    .buttonStyle(.borderedProminent)
```

- [ ] **Step 3: Run and test the tap IN StandBy**

Put the phone in StandBy (locked, charging, landscape). Tap the button directly **without** unlocking. Observe whether:
(a) the first tap activates the intent (`INTENT_FIRED` in Console / `lastTap` updated), or
(b) the first tap only wakes/brightens the display and a second tap is needed, or
(c) it never fires in StandBy.

- [ ] **Step 4: Record verdict (decision-critical)**

Record exactly which of (a)/(b)/(c) happened in `SPIKE-RESULTS.md`. This determines whether the real app keeps transport controls in StandBy (a), degrades to tap-to-wake-then-act (b), or moves controls off StandBy entirely (c).

- [ ] **Step 5: Commit**

```bash
git add spike/ && git commit -m "spike(C): interactive button behavior in StandBy"
```

---

## Task 4: Silent wake push to cache art mid-session (Spike D)

**Files:**
- Create: `spike/SpikeApp/SpikeApp/AppDelegate.swift`
- Create: `spike/spike-pusher/src/sendSilent.ts`
- Modify: `spike/SpikeApp/SpikeApp/SpikeAppApp.swift` (wire the delegate)

- [ ] **Step 1: Register for remote notifications + handle silent push**

```swift
// AppDelegate.swift
import UIKit

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ app: UIApplication,
        didFinishLaunchingWithOptions o: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        app.registerForRemoteNotifications()
        return true
    }
    func application(_ app: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        print("DEVICE_TOKEN=\(deviceToken.map { String(format: "%02x", $0) }.joined())")
    }
    func application(_ app: UIApplication,
        didReceiveRemoteNotification info: [AnyHashable: Any],
        fetchCompletionHandler done: @escaping (UIBackgroundFetchResult) -> Void) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        print("SILENT_WAKE \(stamp)")
        UserDefaults(suiteName: "group.spike")?.set(stamp, forKey: "lastWake")
        done(.newData)
    }
}
```

Wire it: add `@UIApplicationDelegateAdaptor(AppDelegate.self) var delegate` to `SpikeAppApp`. Enable Background Modes → Remote notifications, and Push Notifications capability.

- [ ] **Step 2: Create the silent push sender**

```ts
// spike/spike-pusher/src/sendSilent.ts
import "dotenv/config";
import { send } from "./apnsClient.js";
const deviceToken = process.argv[2];   // STANDARD device token, not activity token
const topic = process.env.BUNDLE_ID!;  // plain bundle id for background/content-available
send(deviceToken, "background", topic, { aps: { "content-available": 1 } }, "5");
```

> Note: silent pushes use `apns-push-type: background`, priority 5, and the topic is the **plain bundle id** (no `.push-type.liveactivity` suffix). Adjust `apnsClient` topic for this call.

- [ ] **Step 3: Run and probe wake reliability**

With the phone locked/in StandBy, send silent pushes spaced like real track changes (every ~30-60s for several minutes):

```bash
npx tsx src/sendSilent.ts <DEVICE_TOKEN>
```

Count how many produce a `SILENT_WAKE` log vs. are dropped by iOS throttling.

- [ ] **Step 4: Record verdict**

Record the wake hit-rate in `SPIKE-RESULTS.md`. This decides whether per-track art is "reliable" or "best-effort + color fallback" in Plan 2.

- [ ] **Step 5: Commit**

```bash
git add spike/ && git commit -m "spike(D): silent wake push reliability"
```

---

## Task 5: Consolidate findings

- [ ] **Step 1: Write the spike summary**

In `spike/SPIKE-RESULTS.md`, summarize all four verdicts and list any spec changes required (update the spec's "Early Spikes" + affected sections if a spike failed).

- [ ] **Step 2: Decide go/no-go per feature**

For each of: StandBy as surface (A), ~10s freshness (B), StandBy controls (C), per-track art (D) — record GO / DEGRADE / DROP. These feed directly into Plans 1 and 2.

- [ ] **Step 3: Commit**

```bash
git add spike/ && git commit -m "spike: consolidate verdicts + go/no-go decisions"
```

---

## Done When

- All four spikes have a recorded PASS/PARTIAL/FAIL verdict on a real device.
- Go/no-go decisions are recorded for StandBy surface, freshness, controls, and per-track art.
- Any spec sections invalidated by a spike are updated before Plan 1 starts.
