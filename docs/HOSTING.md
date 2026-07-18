# Hosting gians

Everything here assumes one hard requirement: **HTTPS**. Microphones, service
workers and push all refuse to work on plain HTTP. Without TLS, gians is a
static page that cannot make calls.

---

## Sizing: how much do you actually need?

Media is peer-to-peer, so the server only carries signalling. That is very
little work.

| Family / users | Server | Monthly |
|---|---|---|
| 5–20 | 1 vCPU, 1 GB RAM | $5–6 |
| 100–500 | 2 vCPU, 2 GB RAM | $12–20 |
| 1,000+ | 2 instances + Redis + managed Mongo | $50+ |

A $6 VPS genuinely covers a family with room to spare. The cost that scales is
**TURN bandwidth**, not CPU — see below.

---

## Recommended: one small VPS

Hetzner CX22, DigitalOcean, Vultr, Linode, or an Oracle Cloud always-free ARM
instance all work. You need a provider that gives you a **public IPv4 address**
and lets you open UDP ports — some PaaS platforms do not, which rules out
running TURN there.

### 1. Point a domain at it

```
A    calls.example.com   ->  203.0.113.10
A    turn.example.com    ->  203.0.113.10
```

### 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 3. Deploy

```bash
git clone https://github.com/Zenil-20/Caller.git gians && cd gians
cp .env.example .env
nano .env      # secrets — see below
```

Generate real secrets:

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('hex'))"
node -e "const w=require('web-push').generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY='+w.publicKey+'\nVAPID_PRIVATE_KEY='+w.privateKey)"
openssl rand -hex 32   # use for TURN_STATIC_SECRET
```

Edit `deploy/turnserver.conf` — replace `EXTERNAL_IP`, `REALM` and
`STATIC_SECRET` (the last must match `TURN_STATIC_SECRET` in `.env`).

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:4000/api/health
```

### 4. TLS via Caddy (simplest)

Caddy obtains and renews certificates automatically.

`/etc/caddy/Caddyfile`:

```
calls.example.com {
    reverse_proxy 127.0.0.1:4000
}
```

```bash
sudo apt install -y caddy && sudo systemctl restart caddy
```

That is the whole TLS setup — Caddy handles the WebSocket upgrade and long-lived
connections correctly by default, which is a common way nginx configs go wrong.

If you prefer nginx, use the config in `DEPLOYMENT.md` §4 and **do not omit
`proxy_read_timeout`** — the 60-second default drops calls mid-conversation.

### 5. Open the firewall

```bash
sudo ufw allow 80,443/tcp
sudo ufw allow 3478,5349/tcp
sudo ufw allow 3478,5349/udp
sudo ufw allow 49152:65535/udp     # TURN relay range
sudo ufw enable
```

Cloud providers usually have a **separate** security group — the UDP range must
be opened there too, or TURN allocates ports nothing can reach.

---

## TURN is the part that decides whether calls work

STUN alone fails whenever both people are behind symmetric NAT — which is
normal on mobile data. The call will ring, both sides will show "Connected",
and **no audio will flow**. That is the single most common failure in a
deployment like this.

Budget roughly:

- 10–20% of calls need a relay
- ~40 kbps each way per relayed call
- ≈18 MB per hour of relayed conversation

For a family that is a rounding error. Verify TURN works with the
[Trickle ICE tester](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
using credentials from `GET /api/calls/ice-servers` — you must see at least one
candidate of type **relay**.

---

## Managed alternatives

If you would rather not run a server:

| Piece | Option | Notes |
|---|---|---|
| App | Render, Railway, Fly.io | Fine — but confirm WebSocket support |
| Database | MongoDB Atlas free M0 | Already what this project uses |
| TURN | Open Relay / Metered free tier | Needed because PaaS rarely allows UDP |

**The catch:** most PaaS platforms do not let you open the UDP range TURN
needs, so you will still need TURN elsewhere. That is usually the reason to
just take the $6 VPS.

---

## Scaling past one instance

The app is deliberately **single-process**. Presence and busy state live in
memory (`server/services/presenceService.js`), so two instances would each see
only their own connections — users would appear offline to half the traffic.

For a family, one process handles thousands of connections. **Do not scale
prematurely.** When you genuinely need to:

1. **Redis adapter**, so `io.to('user:<id>')` crosses instances:
   ```bash
   npm install @socket.io/redis-adapter redis
   ```
   ```js
   const { createAdapter } = require('@socket.io/redis-adapter');
   const pub = createClient({ url: process.env.REDIS_URL });
   const sub = pub.duplicate();
   await Promise.all([pub.connect(), sub.connect()]);
   io.adapter(createAdapter(pub, sub));
   ```
2. **Move presence into Redis** — replace the `sockets` and `activeCall` maps
   so every instance reads the same state.
3. **Sticky sessions** at the load balancer, or force
   `transports: ['websocket']` on the client and skip stickiness.
4. **Gate `resetPersistedPresence()`** at boot — it clears `isOnline` for all
   users, which is correct for one process and wrong for many.

Scale TURN separately from the app; it is bandwidth-bound, not CPU-bound.

---

## Backups

```bash
docker compose exec -T mongo mongodump --archive --gzip > backups/$(date +%F).gz
```

Add to crontab:

```
0 3 * * * cd /opt/gians && docker compose exec -T mongo mongodump --archive --gzip > backups/$(date +\%F).gz
```

Restore:

```bash
docker compose exec -T mongo mongorestore --archive --gzip < backups/2026-07-18.gz
```

---

## Operating it

- `GET /api/health` returns 503 when Mongo is unreachable — point uptime
  monitoring at it.
- `docker compose logs -f app` for live logs; set `LOG_LEVEL=warn` in
  production to reduce noise.
- Watch the share of calls with `connectionType: "relay"` — a sudden rise means
  more TURN bandwidth.
- Watch for calls ending as `failed` or `unavailable`; a spike usually means
  TURN or push has broken.

---

## Go-live checklist

- [ ] Domain resolves to the server
- [ ] HTTPS works and auto-renews
- [ ] `JWT_*` secrets are real random values, not placeholders
- [ ] `CLIENT_ORIGIN` is the exact HTTPS origin, not `*`
- [ ] VAPID keys set — otherwise calls never ring closed phones
- [ ] TURN reachable, and Trickle ICE shows a **relay** candidate
- [ ] MongoDB has authentication enabled and is not exposed publicly
- [ ] Backups scheduled and a restore tested at least once
- [ ] Each family member has **installed** the PWA (iPhone: via Safari)
- [ ] Placed a real call between two phones on **mobile data**, not just wifi
