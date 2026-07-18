# gians — Real-time VoIP Calling

One-to-one internet voice calling in the browser, in the spirit of WhatsApp Call
or Telegram Voice. Peer-to-peer Opus audio over WebRTC, with Socket.IO handling
signalling and presence.

Built with **only** Node.js, Express, Socket.IO, WebRTC, MongoDB, HTML, CSS and
vanilla JavaScript. No frontend framework, no build step, no paid SDK.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [How a call works](#how-a-call-works)
- [Audio pipeline](#audio-pipeline)
- [Data model](#data-model)
- [Documentation](#documentation)
- [Browser support](#browser-support)
- [Troubleshooting](#troubleshooting)

---

## Features

**Accounts & identity**
- Register with a username, optionally with a mobile number (E.164)
- Sign in with either identifier
- JWT access tokens (15 min) with rotating refresh tokens (30 days)
- Refresh-token reuse detection — a replayed token signs out every session
- Passwords hashed with bcrypt (cost 12); login timing is constant whether or
  not the account exists

**Contacts & presence**
- Search users by username, display name or phone
- Add and remove contacts
- Live online / offline / busy status pushed over Socket.IO
- Presence survives a server restart (stale flags are reset at boot)

**Calling**
- Direct one-to-one voice calls
- Dedicated incoming, outgoing and active call screens
- Accept, reject, cancel and end
- Busy signalling — a second caller is refused, not queued
- Missed-call detection with a 45-second no-answer timeout
- Call history, recent calls grouped per contact, and talk-time statistics
- Mute microphone (peer is notified)
- Speaker toggle where the browser exposes output routing
- Live call duration timer

**Ringing a closed or locked device**
- Web Push (VAPID) wakes the device when the browser is closed or the screen is
  locked — no native app, no Firebase account, no paid service
- Full-screen-style notification with **Answer** / **Decline** actions
- Decline works straight from the lock screen, without unlocking
- Ringing notification is dismissed automatically when the caller hangs up,
  the call is answered elsewhere, or it times out
- Offline users are still callable when they have a registered device
- Missed-call notification left behind afterwards
- See [the honest limits](#ringing-a-closed-device-what-works-and-what-cannot)

**Network resilience**
- Socket.IO auto-reconnect with exponential backoff and token refresh
- 20-second grace window: a dropped socket does not immediately kill the call
- ICE connection-state monitoring with automatic ICE restart (up to 3 attempts)
- Network quality rating from RTT, jitter and packet loss
- Live stats panel (codec, RTT, jitter, loss, candidate type)

**Audio**
- Opus @ 48 kHz mono, 20 ms frames
- Echo cancellation, noise suppression, automatic gain control
- In-band FEC (packet-loss concealment) and DTX (silence suppression)
- Voice activity detection with on-screen level meters for both sides
- STUN and TURN, with automatic ICE negotiation

---

## Architecture

```
┌──────────────┐   REST (auth, users, calls)   ┌────────────────────┐
│              │ ─────────────────────────────►│                    │
│   Browser    │                                │  Express + Socket. │
│   (vanilla   │   Socket.IO (signalling,       │  IO server         │
│    JS SPA)   │ ◄────────────────────────────► │                    │
│              │    presence, SDP, ICE)         └─────────┬──────────┘
└──────┬───────┘                                          │
       │                                                  │
       │        ┌────────────────┐                  ┌─────▼──────┐
       └───────►│  STUN / TURN   │                  │  MongoDB   │
                └────────────────┘                  └────────────┘
       │
       │   ══════ Opus audio, peer-to-peer (never touches the server) ══════
       ▼
┌──────────────┐
│  Peer browser│
└──────────────┘
```

The server never sees or relays audio. It exchanges SDP offers/answers and ICE
candidates, then gets out of the way. Media flows directly between the two
browsers (or via TURN when a NAT blocks a direct path).

---

## Quick start

### Prerequisites

- Node.js 18 or newer
- MongoDB 5+ (local, or a MongoDB Atlas cluster)

### Install

```bash
git clone <your-repo-url> gians
cd gians
npm install
cp .env.example .env
```

### Configure

Edit `.env`. At minimum set `MONGODB_URI` and generate two secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Run

```bash
npm start          # production-style
npm run dev        # with --watch auto-restart
npm run seed       # optional: create 4 demo accounts
```

Open <http://localhost:4000>.

### Testing a call locally

A call needs two accounts in two independent browser sessions. Either:

- open a normal window and a private/incognito window, or
- use two different browsers, or
- use two devices on the same network (see the HTTPS note below).

Register both, search for the other user, tap **＋** to add them, then tap the
green call button.

> **Microphone access requires a secure context.** `http://localhost` counts as
> secure, so local testing works. Any other host needs HTTPS — see
> [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | Enables production hardening and static caching |
| `PORT` | `4000` | HTTP port |
| `CLIENT_ORIGIN` | `http://localhost:4000` | Comma-separated CORS allowlist |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017/gians_voip` | Connection string |
| `JWT_ACCESS_SECRET` | — | **Required in production.** Access token key |
| `JWT_REFRESH_SECRET` | — | **Required in production.** Refresh token key |
| `JWT_ACCESS_TTL` | `15m` | Access token lifetime |
| `JWT_REFRESH_TTL` | `30d` | Refresh token lifetime |
| `STUN_URLS` | Google public STUN | Comma-separated STUN URLs |
| `TURN_URLS` | *(empty)* | Comma-separated TURN URLs |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | *(empty)* | Static TURN credentials |
| `TURN_STATIC_SECRET` | *(empty)* | coturn `use-auth-secret` shared secret |
| `TURN_CREDENTIAL_TTL` | `86400` | Lifetime of generated TURN credentials |
| `VAPID_PUBLIC_KEY` | *(empty)* | Web Push public key — required to ring closed devices |
| `VAPID_PRIVATE_KEY` | *(empty)* | Web Push private key |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact URI required by the push spec |
| `RING_TIMEOUT_MS` | `45000` | No-answer timeout before a call is missed |

In production the server refuses to boot if either JWT secret is missing or
still holds a placeholder value.

### About TURN

STUN alone is enough when at least one peer can accept an inbound connection.
It is **not** enough behind symmetric NAT — common on mobile carrier networks
and corporate wifi. Without TURN those calls will ring, connect signalling, and
then fail to carry audio.

Run your own [coturn](https://github.com/coturn/coturn); setup is in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The server logs a warning at startup
when TURN is not configured.

---

## Project structure

```
gians/
├── server/
│   ├── index.js              # entry point, graceful shutdown
│   ├── app.js                # Express app, helmet/CSP, static hosting
│   ├── config/
│   │   ├── env.js            # validated environment config
│   │   └── db.js             # Mongo connection lifecycle
│   ├── models/
│   │   ├── User.js           # accounts, contacts, settings, presence mirror
│   │   ├── Call.js           # call records and status enum
│   │   ├── PushSubscription.js # one row per device that can be rung
│   │   └── RefreshToken.js   # session store with TTL index
│   ├── routes/               # REST route definitions + validation
│   ├── controllers/          # thin HTTP adapters
│   ├── services/
│   │   ├── authService.js    # register/login/refresh rotation
│   │   ├── userService.js    # search, contacts, profile
│   │   ├── callService.js    # call state machine, history aggregation
│   │   ├── presenceService.js# in-memory presence + busy registry
│   │   ├── pushService.js    # Web Push fan-out, dead-endpoint pruning
│   │   └── iceService.js     # STUN/TURN credential issuing
│   ├── socket/
│   │   ├── index.js          # Socket.IO server, connect/disconnect, grace
│   │   ├── auth.js           # handshake JWT verification
│   │   └── callHandlers.js   # call + SDP/ICE event handlers
│   ├── middleware/           # auth guard, validation, rate limits, errors
│   ├── utils/                # jwt, logger, errors, asyncHandler
│   └── scripts/seed.js       # demo accounts
├── public/
│   ├── index.html            # all screens in one document
│   ├── sw.js                 # service worker: rings a closed browser
│   ├── manifest.json         # PWA install metadata
│   ├── css/styles.css
│   └── js/
│       ├── api.js            # REST client + transparent token refresh
│       ├── push.js           # service worker + push subscription
│       ├── store.js          # observable app state
│       ├── audio.js          # synthesised ringtones + voice detection
│       ├── webrtc.js         # peer connection, Opus tuning, stats, recovery
│       ├── socket.js         # Socket.IO wrapper with promise-style emits
│       ├── ui.js             # DOM rendering
│       └── app.js            # controller, call state machine
└── docs/
    ├── API.md
    └── DEPLOYMENT.md
```

---

## How a call works

```
Caller                        Server                        Callee
  │                             │                             │
  │──── call:initiate ─────────►│                             │
  │                             │ reserve both as busy         │
  │◄─── ack {callId, ice} ──────│──── call:incoming ─────────►│
  │                             │                             │ (ringtone)
  │──── webrtc:offer ──────────►│──── webrtc:offer ──────────►│ (queued
  │                             │                             │  until answer)
  │                             │◄─── call:accept ────────────│
  │◄─── call:accepted ──────────│                             │
  │                             │◄─── webrtc:answer ──────────│
  │◄─── webrtc:answer ──────────│                             │
  │◄══ ICE candidates (both directions, relayed) ═════════════►│
  │                                                            │
  │◄════════════ Opus audio, direct peer-to-peer ═════════════►│
  │                             │                             │
  │──── call:end ──────────────►│──── call:ended ────────────►│
  │                             │ persist duration, release    │
```

**Call statuses:** `ringing` → `active` → `ended`, or one of the terminal
outcomes `missed`, `rejected`, `busy`, `cancelled`, `unavailable`, `failed`.

A hang-up before answer resolves asymmetrically: `cancelled` for the caller,
`missed` for the callee — the same record, labelled per viewer.

### Negotiation details

The client implements the **perfect-negotiation** collision rule. The caller is
the impolite peer (ignores a colliding offer); the callee is polite (rolls back
its own). ICE candidates arriving before the remote description are queued and
drained once it is applied.

---

## Audio pipeline

Capture constraints (`webrtc.js`):

```js
{
  echoCancellation: true,   // user-configurable in Settings
  noiseSuppression: true,
  autoGainControl:  true,
  sampleRate: 48000,        // matches Opus natively — no resample
  channelCount: 1,
  latency: 0.01
}
```

Opus is tuned by rewriting the SDP `fmtp` line:

| Parameter | Value | Why |
|---|---|---|
| `maxaveragebitrate` | 32000 | Transparent for speech, mobile-friendly |
| `useinbandfec` | 1 | Reconstructs lost packets instead of dropping audio |
| `usedtx` | 1 | Stops transmitting during silence |
| `ptime` | 20 | 20 ms frames — the latency/overhead sweet spot |
| `stereo` | 0 | Voice is mono; halves the payload |

Quality is sampled every 2 seconds via `getStats()` and rated:

| Rating | RTT | Jitter | Loss |
|---|---|---|---|
| excellent | ≤150 ms | ≤15 ms | ≤1% |
| good | ≤300 ms | ≤30 ms | ≤3% |
| fair | ≤500 ms | ≤60 ms | ≤8% |
| poor | above | above | above |

Packet loss is computed as a **rate over the last interval**, not cumulatively
since the call began — otherwise a brief early glitch would drag the rating
down for the rest of the call.

---

## Ringing a closed device: what works, and what cannot

This is the part people are most often misled about, so it is worth being
precise.

### What this app does

A browser **service worker** stays registered after the tab is closed. When
someone calls you, the server sends a **Web Push** message; the browser vendor's
push service (FCM for Chrome, Mozilla autopush, Apple for Safari) wakes that
worker even with the browser shut and the phone locked. The worker then shows a
ringing notification with **Answer** and **Decline** buttons.

- ✅ Rings with the browser fully closed
- ✅ Rings with the screen locked
- ✅ Vibrates and plays the system notification sound
- ✅ Decline works from the lock screen without unlocking
- ✅ Tapping **Answer** opens the app straight into the call
- ✅ Works after a reboot, once the browser has been opened at least once
- ✅ No native app, no app store, no Firebase project, no paid SDK

### What it cannot do

A web app **cannot** fully replicate a native phone call, no matter how it is
written. These are OS-level restrictions, not gaps in this implementation:

| Native call behaviour | Possible on the web? | Why |
|---|---|---|
| Full-screen call UI over the lock screen | ❌ | Needs Android `ConnectionService` or iOS CallKit — native code only |
| Continuous ringtone until answered | ⚠️ Partial | You get the system notification sound, not a 45-second ring |
| Ring when the device is powered **off** | ❌ | Nothing can reach a powered-off device; the push is queued and delivered when it comes back, and the call is logged as missed |
| Bypass Do Not Disturb / silent mode | ❌ | Only OS-registered calling apps may do this |
| Ring with **no** network | ❌ | Push needs connectivity, same as any VoIP call |

If you need a genuine native calling experience — full-screen incoming call
over the lock screen, ringtone through the earpiece, entry in the phone's call
log — that requires a native Android (Kotlin/Java + ConnectionService) or iOS
(Swift + CallKit/PushKit) client. Those were explicitly out of scope here, and
no amount of JavaScript closes that specific gap. Web Push is the closest a
pure-web app can legitimately get, and it is what this project implements.

### Platform support

| Platform | Rings when closed | Requirement |
|---|---|---|
| Android Chrome / Edge | ✅ | Just grant notification permission |
| Android Firefox | ✅ | Just grant notification permission |
| Desktop Chrome / Edge / Firefox | ✅ | Browser must be running or set to run in background |
| **iOS Safari 16.4+** | ✅ | **Must be installed via Share → Add to Home Screen.** iOS does not deliver Web Push to a normal Safari tab |
| iOS Safari (plain tab) | ❌ | Apple restriction; the app detects this and tells the user |

### Setup

1. Generate a VAPID keypair:

   ```bash
   node -e "console.log(require('web-push').generateVAPIDKeys())"
   ```

2. Put them in `.env`:

   ```env
   VAPID_PUBLIC_KEY=BIYY...
   VAPID_PRIVATE_KEY=uc4s...
   VAPID_SUBJECT=mailto:you@example.com
   ```

3. Serve over **HTTPS** (service workers and push require a secure context;
   `localhost` is exempt for development).

4. In the app: **Settings → Ring this device → Enable call ringing**, then
   accept the browser prompt.

The Settings screen shows the live state and explains exactly why ringing is
unavailable when it is — unsupported browser, permission blocked, server keys
missing, or iOS-needs-install.

### Reliability notes

- Android battery optimisation can delay push delivery. For consistent
  ringing, exclude the browser from battery optimisation.
- Installing as a PWA (Add to Home Screen) materially improves delivery on
  both Android and iOS.
- Push messages are sent with `urgency: high` and a 45-second TTL, so a late
  delivery is discarded rather than ringing you about a call that is long over.

---

## Data model

### `users`

| Field | Type | Notes |
|---|---|---|
| `username` | String | unique, lowercase, `^[a-z0-9_.]+$`, 3–30 |
| `phone` | String | unique **sparse**, E.164, optional |
| `displayName` | String | ≤60 chars |
| `passwordHash` | String | bcrypt, `select: false` |
| `avatarColor` | String | assigned at creation |
| `about` | String | ≤140 chars |
| `isOnline` | Boolean | mirror of in-memory presence |
| `lastSeen` | Date | |
| `contacts` | [ObjectId] | refs `User` |
| `settings` | Object | ringtone, vibration, EC/NS/AGC toggles |

Indexes: `username` (unique), `phone` (unique sparse), `isOnline`,
text index on `username` + `displayName`.

### `calls`

| Field | Type | Notes |
|---|---|---|
| `callId` | String | UUID v4, unique |
| `caller` / `callee` | ObjectId | refs `User` |
| `status` | Enum | see call statuses above |
| `startedAt` / `answeredAt` / `endedAt` | Date | |
| `duration` | Number | whole seconds of talk time; 0 if unanswered |
| `endedBy` | ObjectId | who hung up |
| `endReason` | String | `hangup`, `timeout`, `peer-disconnected`, … |
| `quality.caller` / `quality.callee` | Object | last sampled rating, RTT, jitter, loss |
| `connectionType` | String | `host`, `srflx` or `relay` |

Indexes: `callId` (unique), `{caller, createdAt}`, `{callee, createdAt}`, `status`.

### `refreshtokens`

Stores SHA-256 digests (never the raw token) with a `jti`, plus user agent and
IP. A TTL index on `expiresAt` lets MongoDB expire dead sessions on its own.

---

## Documentation

- **[docs/API.md](docs/API.md)** — every REST endpoint and Socket.IO event,
  with request/response shapes and error codes.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — HTTPS, coturn, nginx, systemd,
  Docker, Atlas, scaling past one process.

---

## Browser support

| Browser | Calling | Speaker toggle |
|---|---|---|
| Chrome / Edge 90+ | ✅ | ✅ (`setSinkId`) |
| Firefox 90+ | ✅ | ⚠️ OS-controlled |
| Safari 15+ (macOS/iOS) | ✅ | ⚠️ OS-controlled |
| Android Chrome | ✅ | ✅ |

`setSinkId` is Chromium-only. Elsewhere the toggle adjusts volume and the OS
decides routing — the UI says so rather than pretending it worked.

---

## Troubleshooting

**"Microphone permission was denied"**
Grant mic access in site settings. Remember the page must be on `localhost` or
HTTPS.

**Call rings, both sides say "Connected", but there is no audio**
Almost always missing TURN. Open the in-call **Stats** panel: if `path` never
becomes `relay` and packets stay at zero, one peer is behind symmetric NAT.
Configure `TURN_URLS`.

**Calls do not ring when the app is closed**
Check Settings → *Ring this device*; it states the exact reason. Most common:
VAPID keys not set on the server, the site is not on HTTPS, notification
permission was denied, or (on iPhone) the app was not added to the home screen.

**Ringing works on Android but not iPhone**
iOS delivers Web Push only to a PWA installed via *Share → Add to Home Screen*,
on iOS 16.4 or newer. A normal Safari tab cannot ring.

**"They are offline right now" for a user who is clearly online**
Presence is per-process. If you run more than one Node instance you must add
the Redis adapter — see the scaling section in `docs/DEPLOYMENT.md`.

**Server exits at boot with a JWT secret error**
Expected in production when secrets are unset or still placeholders. Generate
real ones.

**`querySrv ECONNREFUSED` with a `mongodb+srv://` Atlas URI**
Node cannot reach a DNS server for the SRV lookup. Use the equivalent direct
seed-list URI (`mongodb://host1,host2,host3/db?ssl=true&replicaSet=...`), which
skips SRV resolution entirely.

---

## License

MIT
