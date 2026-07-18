# Getting gians onto phones

## First, the format question

**`.exe` does not run on any phone.** It is a Windows-only executable format.
Phones need:

| Platform | Format | How you get one |
|---|---|---|
| Android | `.apk` / `.aab` | Build a TWA wrapper (free, below), or install the PWA |
| iPhone / iPad | `.ipa` | Apple Developer Program, $99/year, Mac + Xcode required |
| Windows desktop | `.exe` / MSIX | Install the PWA from Edge — it creates a real desktop app |

There is no build setting, packager, or trick that turns an `.exe` into
something a phone can install. Below are the three paths that actually work,
in the order I would recommend for a family.

---

## Path 1 — Install the PWA (recommended to start)

**Cost: nothing. Setup: none. Works today.**

Once the app is hosted on HTTPS, every family member opens the URL once and
installs it. They get a real home-screen icon, a full-screen app with no
browser bars, and it stays installed.

### Android (Chrome / Edge / Samsung Internet)
1. Open the site.
2. Either tap **Install app** in gians Settings, or use the browser menu →
   *Install app* / *Add to Home screen*.
3. Done — it appears in the app drawer like any other app.

### iPhone / iPad (Safari only)
1. Open the site **in Safari** — Chrome on iOS cannot install PWAs.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. **Launch it from the home screen icon from now on, not from Safari.**

> ⚠️ On iPhone this step is **mandatory**, not cosmetic. iOS only delivers Web
> Push to an installed PWA — a call cannot ring a phone where gians is just a
> Safari tab. The app detects this and tells the user.

### What you get either way
- Home-screen icon, splash screen, full-screen app
- Calls that ring when the app is closed or the screen is locked
- Offline shell, so it opens instantly

---

## Path 2 — A real Android `.apk` (TWA)

**Cost: nothing to build. $25 one-time only if you want it on the Play Store.**

A Trusted Web Activity wraps your PWA in a genuine Android app. The result is a
real `.apk` file you can send to family over WhatsApp and they install directly.
It is the same web app inside, so there is no second codebase to maintain.

### Build it

```bash
npm install -g @bubblewrap/cli

bubblewrap init --manifest https://calls.example.com/manifest.json
# Answer the prompts; accept the defaults except:
#   Application ID:  com.yourname.gians
#   Display mode:    standalone

bubblewrap build
# Produces app-release-signed.apk and app-release-bundle.aab
```

Bubblewrap will offer to download a JDK and the Android SDK on first run.

### Link the app to your domain (required)

Without this, the app shows a browser address bar at the top. Bubblewrap prints
an `assetlinks.json` — publish it at:

```
https://calls.example.com/.well-known/assetlinks.json
```

The server already serves `public/` statically, so create
`public/.well-known/assetlinks.json` and it will be served automatically.
Verify with:

```bash
curl https://calls.example.com/.well-known/assetlinks.json
```

### Distribute
- **Sideload** — send the `.apk` directly. Recipients must allow
  *Install unknown apps* once. Fine for family.
- **Play Store** — upload the `.aab`, $25 one-time developer fee. Needed only
  if you want automatic updates and a public listing.

> A TWA still runs the web app inside, so it inherits the same limits: no
> background location, and notification-style ringing rather than a full-screen
> incoming-call UI.

---

## Path 3 — Native app (only if you need background tracking)

Build this only if you genuinely need:

- Continuous **background** location with the app closed
- A **full-screen incoming call UI** over the lock screen, like WhatsApp
- Entries in the phone's own call log

Those require platform APIs that browsers do not expose:

| Need | Android | iOS |
|---|---|---|
| Background location | Foreground Service + `ACCESS_BACKGROUND_LOCATION` | Core Location background mode |
| Native call UI | `ConnectionService` / `CallStyle` notification | CallKit + PushKit |

That means Kotlin and/or Swift, a separate codebase, and for iOS a paid
developer account. The existing Node + MongoDB backend and all its APIs stay
exactly as they are — only the client changes.

**My honest recommendation:** run Paths 1–2 first. Live with it for a few
weeks. Most families find notification ringing and open-app location perfectly
adequate, and you will have spent nothing.

---

## Windows desktop

If you also want gians on a laptop:

1. Open the site in **Edge** or **Chrome**.
2. Menu → **Install gians**.

You get a real installed app with a Start-menu entry and its own window — no
Electron, no packaging step. If you specifically need a distributable installer,
Edge can export the installed PWA as an MSIX package.

To run the **server** as a Windows executable (so nobody needs Node installed):

```bash
node --experimental-sea-config sea-config.json
```

See Node's Single Executable Applications documentation. Note this packages the
*server*, not the phone client.

---

## Which to choose

| Situation | Do this |
|---|---|
| Just getting family onto it | **Path 1** — PWA install |
| Want a file to send on WhatsApp | **Path 2** — Bubblewrap APK |
| Want it on the Play Store | **Path 2** + $25 developer account |
| Need background location or a real call UI | **Path 3** — native |
| iPhone users | **Path 1 via Safari**, and stress Add to Home Screen |
