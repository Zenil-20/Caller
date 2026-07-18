# Running gians permanently, for free — no credit card

The goal: a stable HTTPS address your family installs once and uses forever,
with **no card, no payment, and your PC switched off**.

## First, an honest limitation

**Every free host requires an account** — an email address or a GitHub/Google
login. There is no hosting that needs zero signup. What you can avoid entirely
is handing over a **credit card**, and everything below does that.

If even an email is too much, skip to
[Option C — host it at home](#option-c--host-it-at-home-zero-signup), which
needs no third-party account at all beyond a free hostname.

---

## What each piece costs

| Piece | Free option | Card? |
|---|---|---|
| Server | **Render** free web service | ❌ none |
| Database | **MongoDB Atlas M0** (you already have this) | ❌ none |
| HTTPS + domain | `yourapp.onrender.com`, included | ❌ none |
| TURN relay | **Metered** or **ExpressTurn** free tier | ❌ none, email signup |
| Keep-awake | **UptimeRobot** free | ❌ none |

Total: **₹0**, permanently, no card anywhere.

> Oracle Cloud and Google Cloud are *not* usable here — both demand a card to
> verify identity even for their always-free tiers. I listed them earlier
> before you told me that was a constraint; ignore that advice.

---

## Option A — Render (recommended)

### 1. Push the repo to GitHub

Already done — `github.com/Zenil-20/Caller`.

### 2. Generate your push keys locally

On your PC, in the project folder:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Keep the two values handy.

### 3. Create the service

1. Sign up at <https://render.com> with your **GitHub account** (no card asked)
2. **New → Blueprint** → select the `Caller` repo
3. Render reads `render.yaml` and configures nearly everything itself
4. When prompted, fill in:
   - `MONGODB_URI` — your Atlas connection string
   - `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — from step 2
   - `VAPID_SUBJECT` — `mailto:your@email.com`
5. Deploy

### 4. Fix the origin

After the first deploy you get a URL like `https://gians.onrender.com`. Go to
**Environment** and set:

```
CLIENT_ORIGIN = https://gians.onrender.com
```

Save — Render redeploys. This step is not optional: Socket.IO checks the
Origin header and will refuse every connection if it does not match, so calls
would never connect.

### 5. Allow Atlas to reach it

Atlas → **Network Access** → **Add IP Address** → `0.0.0.0/0`.

Render's free tier has no fixed outbound IP, so there is nothing narrower to
allow. Your database is still protected by its username and password — which
is exactly why you should **rotate that password now** if you have not already.

### 6. Keep it awake ⚠️

**This is the one thing that decides whether the app is usable.**

Render's free tier sleeps a service after 15 minutes of inactivity. A sleeping
server cannot ring anyone — the caller waits ~50 seconds for a cold start
before the call even begins.

Fix it for free:

1. Sign up at <https://uptimerobot.com> (free, no card)
2. **Add New Monitor** → HTTP(s)
3. URL: `https://gians.onrender.com/api/health`
4. Interval: **5 minutes**

That keeps the service warm around the clock. Render's free tier includes 750
instance-hours per month and a month is ~730 hours, so one always-on service
fits within the allowance.

As a bonus, UptimeRobot emails you if the app goes down — `/api/health` returns
503 when the database is unreachable, so you find out before your family does.

### 7. Install on the phones

**Android:** open the URL → sign in → **Settings → Install app** → then
**Enable call ringing**.

**iPhone:** open in **Safari** → **Share** → **Add to Home Screen** → launch it
from the home-screen icon → **Enable call ringing**.

> On iPhone, launching from the home screen is mandatory. iOS only delivers
> push to an installed PWA, so a call can never ring a phone where gians is
> just a Safari tab.

### Render's honest downsides

- **Cold starts** if the keep-awake monitor ever lapses (~50 s)
- **No coturn** — the free tier gives one HTTP port and no UDP range, so TURN
  must come from Open Relay (already configured in `render.yaml`)
- **Shared CPU** — fine for signalling, which is all this server does; the
  audio itself never touches it

---

## Option B — Other card-free hosts

If Render does not suit you:

| Host | Free tier | Notes |
|---|---|---|
| **Back4App Containers** | Yes, no card | Runs the Dockerfile in this repo |
| **Zeabur / Sevalla** | Small free tier | Newer; verify WebSocket support first |
| **Fly.io / Railway / Koyeb** | ❌ | All now require a card |
| **Vercel / Netlify** | ❌ | Serverless only — **cannot** run Socket.IO |

Vercel and Netlify are worth calling out because people often suggest them:
they cannot hold an open WebSocket, so the signalling this app depends on
simply will not work there.

---

## Option C — Host it at home (zero signup)

Genuinely free, no cloud account at all. The trade-off is that a device at home
must stay powered on.

**What you need:** any always-on device — an old laptop, a Raspberry Pi, or
even an **old Android phone running Termux**.

```bash
# On the device
git clone https://github.com/Zenil-20/Caller.git && cd Caller
npm ci --omit=dev
cp .env.example .env    # fill in the secrets
npm start
```

Then expose it with a permanent free URL:

| Tool | Permanent URL? | Card? | Signup |
|---|---|---|---|
| **ngrok** free | ✅ 1 static domain | ❌ | email |
| **Cloudflare Tunnel** | ✅ | ❌ | needs a domain on Cloudflare |
| **DuckDNS + port forward** | ✅ | ❌ | Google/GitHub login |

The simplest is ngrok's free static domain:

```bash
ngrok http 4000 --domain=your-name.ngrok-free.app
```

Set `CLIENT_ORIGIN` in `.env` to that exact HTTPS URL.

Your ISP may block inbound ports or change your IP, which is why a tunnel is
easier than port forwarding. And with the device at home you *can* run coturn
locally, which gives better call quality than the shared public relay.

---

## TURN — the part that decides whether calls actually work

Without a TURN relay, calls between two phones **on mobile data** will ring,
show "Connected", and carry no audio. Home wifi usually works without it, which
is why this problem tends to surface only after you have shown the app to
someone.

> ⚠️ **The widely-copied free `openrelay.metered.ca` endpoint is dead.** I
> tested it while writing this: TCP connections to it fail outright, and it
> produces no relay candidate, while a STUN control test on the same machine
> worked fine. Any tutorial telling you to paste `openrelayproject` /
> `openrelayproject` is out of date. Do not rely on it.

### Free options that do work

| Provider | Free allowance | Card? | How |
|---|---|---|---|
| **Metered** | 50 GB/month | ❌ | Sign up at metered.ca, copy credentials |
| **ExpressTurn** | Free tier | ❌ | Sign up at expressturn.com |
| **Self-hosted coturn** | Unlimited | ❌ | Only if you use Option C below |

Both give you three values. Put them in Render → **Environment**:

```
TURN_URLS        turn:standard.relay.metered.ca:80,turns:standard.relay.metered.ca:443
TURN_USERNAME    <from your dashboard>
TURN_CREDENTIAL  <from your dashboard>
```

### Verify it, do not assume

1. Open the [Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
2. Enter your TURN URL, username and credential
3. Press **Gather candidates**
4. You must see at least one row of type **relay**

If no relay row appears, the credentials or the service are wrong — fix it
before assuming the app is broken.

Finally, make one real call between two phones **with wifi off on both**. That
is the only test that proves it.

---

## My recommendation

Start with **Option A (Render + UptimeRobot)**. It is free, needs no card, your
PC can be off, and it takes about fifteen minutes.

If the free tier ever becomes limiting, Option C on an old phone at home costs
nothing and gives you better TURN — but only while that device stays on.
