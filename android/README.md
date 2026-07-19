# gians — Android app

A thin native shell around the existing web app, built for exactly one thing the
web platform cannot do: **show a full-screen ringing call screen when the app is
completely closed.**

Everything else — signing in, contacts, the actual WebRTC call, the map — stays
in the web app and is untouched. This shell is roughly 500 lines of Kotlin.

## Why this exists

A PWA's service worker is the only thing that runs when the app is closed, and
its entire output surface is `showNotification()`. There is no web API that draws
over the lock screen; Chrome deliberately withholds one. Android exposes that
capability only to native apps, through a **full-screen intent**, which is what
`CallNotifier` uses.

## How it fits together

```
server (callNotifier)
   ├── Web Push  ──────────→ browsers          → notification only
   └── FCM (data-only) ────→ CallMessagingService
                                  ↓
                             CallNotifier          CallStyle notification
                                  ↓                 + full-screen intent
                             IncomingCallActivity   ← the ringing call screen
                                  ↓
                    Answer → GiansLauncherActivity → TWA opens
                             /?callId=…&action=accept
                    Decline → POST /api/push/call-action
```

Two details worth knowing before changing anything:

- **The FCM payload is data-only, deliberately.** Adding a `notification` block
  would make Firebase render it itself whenever the app is backgrounded, and
  `onMessageReceived` would never run — killing the exact case this exists for.
- **The shell never authenticates.** It appends its FCM token to the launch URL;
  the web page, already signed in, registers it. No password, access token, or
  refresh token ever touches native code.

## Build

### 1. Install a supported JDK

**Your JDK 26 will not work** — Android Gradle Plugin 9.3 requires JDK 17 or 21.
Installing Android Studio gives you a bundled JDK 17, which is the simplest fix.

### 2. Install Android Studio

Needed for the SDK, and it generates the Gradle wrapper this directory does not
ship (`gradlew` / `gradle-wrapper.jar`). Open the `android/` folder and let it
sync once.

**Verified toolchain.** This project has been built successfully with:

| | |
|---|---|
| Gradle | 9.5.0 |
| Android Gradle Plugin | 9.3.0 |
| JDK | Temurin 17.0.19 |
| compileSdk / targetSdk | 36 / 36 |
| Build tools | 36.0.0 |

Two things that are easy to get wrong and cost a build each:

- **Do not add the `org.jetbrains.kotlin.android` plugin.** Kotlin support is
  built into AGP from 9.0, and applying the standalone plugin alongside it is a
  hard error, not a warning.
- **`androidx.core` is pinned to 1.18.0 on purpose.** 1.19.0 requires
  compileSdk 37, which is not in the stable SDK channel yet. Raise both together
  or neither.

### 3. Create the Firebase project

1. <https://console.firebase.google.com> → **Add project**
2. **Add app → Android**, package name `com.gians.app`
3. Download **`google-services.json`** → place it at `android/app/google-services.json`
4. **Project settings → Service accounts → Generate new private key**

From that downloaded service-account JSON, fill in the server's `.env`:

```
FCM_PROJECT_ID=<project_id>
FCM_CLIENT_EMAIL=<client_email>
FCM_PRIVATE_KEY=<private_key, one line, \n escapes kept as-is>
```

### 4. Point the app at your server

Only if your URL differs from the default — edit `android/gradle.properties`:

```properties
GIANS_HOST_URL=https://gians.onrender.com
GIANS_APPLICATION_ID=com.gians.app
```

### 5. Build, then register the signing fingerprint

```bash
./gradlew assembleDebug     # android/app/build/outputs/apk/debug/app-debug.apk
```

Get the fingerprint of the key it signed with:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey \
        -storepass android -keypass android | grep SHA256
```

Put it in the server's `.env` and redeploy:

```
ANDROID_PACKAGE_NAME=com.gians.app
ANDROID_CERT_FINGERPRINTS=<SHA256 fingerprint>
```

Verify it went live: `curl https://your-host/.well-known/assetlinks.json`

If this does not match, the app still works — it just shows a URL bar, which
gives away that it is a web page.

### 6. Install

```bash
adb install app-debug.apk
```

Open it once and sign in. That first launch is what registers the device for
calls; until it happens the server has no token to send to.

---

## Making it actually ring — read this

The code is only half the problem. **Android will silently discard calls unless
the phone is configured to allow them**, and the defaults are against you.

### Every device

- Allow notifications when prompted on first launch (Android 13+).
- Exempt gians from battery optimisation:
  Settings → Apps → gians → Battery → **Unrestricted**.

### Xiaomi / Redmi / POCO, Oppo, realme, vivo, OnePlus

These ROMs treat *swipe-away from Recents* as a force-stop. A force-stopped app
receives **nothing** from FCM until it is manually reopened — no notification, no
call screen, no way for the server to reach it at all. This is the single most
common reason a build that works perfectly on a Pixel appears completely broken.

You must enable, per device:

1. **Autostart / Auto-launch** — Settings → Apps → gians → Autostart. Off by
   default, and there is no API that can turn it on.
2. **Lock the app in Recents** — open the task switcher, drag gians down or tap
   the padlock, so clearing recents does not kill it.
3. **Battery saver → No restrictions** for gians.
4. **Xiaomi only: "Display pop-up windows while running in background."**
   Settings → Apps → gians → Other permissions. Off by default, and it blocks
   the full-screen call screen *independently* of everything above. If calls
   arrive as a banner but never full-screen on a Xiaomi, this is why.

None of these are settable programmatically. Every calling app on Android ships
an onboarding screen that walks users through them; there is no alternative.

### Install method matters

Android 14+ restricts `USE_FULL_SCREEN_INTENT` to calling and alarm apps — but
that restriction is enforced by **the Play Store installer revoking it after
install**, not by the OS. A sideloaded APK never passes through that revocation
and keeps the permission.

If you later publish to Play, declare the calling-app use in the Play Console or
the permission gets revoked and every call quietly degrades to a banner.
`GiansLauncherActivity.openFullScreenIntentSettingsIfNeeded()` detects that state
and can send the user to the right settings page.

## Troubleshooting

| Symptom | Cause |
|---|---|
| URL bar visible in the app | `assetlinks.json` missing, or fingerprint mismatch |
| Nothing arrives when app is closed | OEM autostart / force-stop — see above |
| Banner appears, no full-screen | `USE_FULL_SCREEN_INTENT` revoked, or Xiaomi pop-up permission |
| Rings only while app is open | Device never registered; open the app once and sign in |
| Silent call screen | Phone in silent mode, or the ringtone channel was muted in Settings |
| `onMessageReceived` never fires | Payload gained a `notification` block — it must stay data-only |
